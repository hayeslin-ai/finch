/**
 * 组装根。
 *
 * WHY：Spec 4.2 要求具体适配器只在这里接线，核心与 CLI 不直接依赖 SDK。
 * 本文件是唯一允许同时引用 Pi 与各适配器的位置。
 *
 * 组装方式（使用 Pi 官方接口，不自造 UI）：
 *   createAgentSessionServices  → 构造 cwd 绑定的服务（含资源加载与扩展）
 *   createAgentSessionFromServices → 用我们的只读工具创建会话
 *   createAgentSessionRuntime   → 包装出可被 InteractiveMode 使用的运行时
 *
 * 安全约束在这里收口：
 * - 资源加载只启用我们自己的扩展，关闭技能、提示模板、主题与项目上下文文件；
 * - 系统提示词固定为本产品版本，不读取仓库中的 AGENTS/SYSTEM 文件；
 * - 工具集只注册只读工具，不继承任何内置工具；
 * - 本地 Shell 由扩展钩子额外拦截（见 agent/extension.ts）。
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  AgentSessionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type CreateModelRuntimeOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import { createDiagnosisExtension } from '../agent/extension.js';
import { SYSTEM_PROMPT } from '../agent/system-prompt.js';
import { createReadOnlyTools } from '../agent/tools.js';
import type { LoadedConfig } from '../config/load.js';
import type { ModelCandidate } from '../config/model-selection.js';
import type { AppPaths } from '../config/paths.js';
import { AuditLedger } from '../core/audit.js';
import { BudgetController } from '../core/budget.js';
import { EvidenceStore } from '../core/evidence.js';
import { AttachmentRegistry } from '../logs/attachments.js';
import { openRepository, type RepositoryHandle } from '../repository/read.js';
import { Redactor } from '../security/redactor.js';
import { createSessionId } from '../storage/session.js';
import { SessionRecorder } from '../storage/recorder.js';
import type { KnowledgeContext } from '../cli/knowledge-commands.js';

const execFileAsync = promisify(execFile);

/** 组装结果。 */
export interface Composition {
  readonly runtime: AgentSessionRuntime;
  readonly evidence: EvidenceStore;
  readonly audit: AuditLedger;
  readonly budget: BudgetController;
  readonly redactor: Redactor;
  readonly currentModel: ModelCandidate;
  readonly serviceId: string;
  /** 本次会话标识；恢复时为原会话，新建时为本次生成。 */
  readonly sessionId: string;
  /** 取消预算、清空脱敏映射并等待会话事件落盘。 */
  dispose(): Promise<void>;
}

export interface ComposeOptions {
  readonly config: LoadedConfig;
  readonly paths: AppPaths;
  /** 已授权的本地附件路径；由输入解析产生。 */
  readonly attachmentPaths?: readonly string[];
  /** 知识库上下文。 */
  readonly knowledge: KnowledgeContext;
  /** 恢复的会话标识；省略时新建。 */
  readonly sessionId?: string;
}

/** 只使用当前 provider 的内存凭证存储；不读磁盘、不读环境。 */
function createCredentialStore(providerId: string, apiKey: string) {
  return {
    async read(target: string) {
      return target === providerId ? { type: 'api_key' as const, key: apiKey } : undefined;
    },
    async list() {
      return [{ providerId, type: 'api_key' as const }];
    },
    async modify() {
      // 运行期不修改凭证：写入由用户手工编辑 models.json 完成。
      return undefined;
    },
    async delete(): Promise<void> {
      // 同上。
    },
  };
}

/** 从 `.env` 读取凭证变量值；只在内存中使用。 */
async function resolveApiKey(paths: AppPaths, variable: string): Promise<string> {
  const text = await readFile(paths.envFile, 'utf8');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`, 'm');
  const match = pattern.exec(text);
  if (match === null) {
    return '';
  }
  return (match[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** 解析模型凭证：只有 `$VAR` 形式才去 .env 查找，其余按字面量处理。 */
async function resolveCredentials(
  paths: AppPaths,
  providerId: string,
  modelId: string,
): Promise<{ apiKey: string }> {
  const raw = await readFile(paths.modelsFile, 'utf8');
  const document = JSON.parse(raw) as {
    providers?: Record<string, { apiKey?: string; models?: Array<{ id?: string }> }>;
  };
  const provider = document.providers?.[providerId];
  if (provider === undefined) {
    throw new Error(`模型中不存在 provider：${providerId}`);
  }
  if (!provider.models?.some((model) => model.id === modelId)) {
    throw new Error(`provider ${providerId} 中不存在模型：${modelId}`);
  }

  const apiKey = provider.apiKey ?? '';
  const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey);
  return { apiKey: reference === null ? apiKey : await resolveApiKey(paths, reference[1] ?? '') };
}

/** 读取仓库版本信息；不可用时返回 unknown，不阻断诊断。 */
export async function readRepositoryVersion(repoRoot: string): Promise<{
  commit: string;
  dirty: boolean;
}> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], {
      timeout: 5_000,
    });
    const { stdout: statusOut } = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain'], {
      timeout: 5_000,
    });
    return { commit: stdout.trim(), dirty: statusOut.trim() !== '' };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
}

/** 检查路径是否为目录。 */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 组装一次会话。
 *
 * 失败时抛错并附明确原因，由调用方转成用户可读提示；
 * 不静默降级到其他模型、其他仓库或默认配置。
 */
export async function compose(options: ComposeOptions): Promise<Composition> {
  const { config, paths } = options;

  const selected = config.model;
  if (selected === undefined) {
    throw new Error('尚未确定模型：models.json 中有多个候选时请用 --model 指定');
  }

  const repository = await openRepository(config.repoRoot);
  if ('error' in repository) {
    throw new Error(`仓库不可用：${repository.error}`);
  }

  const { apiKey } = await resolveCredentials(paths, selected.provider, selected.modelId);
  if (apiKey === '') {
    throw new Error('缺少模型凭证：请检查 models.json 中的 apiKey');
  }

  // 附件授权在组装阶段完成；单个附件失败只跳过该附件，不阻断整体。
  // 会话中的 @文件 由扩展在输入钩子里继续登记到同一个登记表。
  const attachments = new AttachmentRegistry();
  for (const target of options.attachmentPaths ?? []) {
    await attachments.register(target);
  }

  const redactor = new Redactor();
  const evidence = new EvidenceStore();
  const audit = new AuditLedger();
  const budget = new BudgetController({ totalMs: config.limits.DIAGNOSIS_TIMEOUT_MS });
  // 恢复会话时沿用原会话标识，事件才会追加到同一目录；
  // 否则 -c 恢复出来的摘要永远是空的。
  const recorder = new SessionRecorder(paths.stateDir, options.sessionId ?? createSessionId());

  const runtimeOptions: CreateModelRuntimeOptions = {
    modelsPath: paths.modelsFile,
    credentials: createCredentialStore(selected.provider, apiKey),
    refreshOnCreate: false,
    allowModelNetwork: false,
  };
  const modelRuntime = await ModelRuntime.create(runtimeOptions);
  const model = modelRuntime.getModel(selected.provider, selected.modelId);
  if (model === undefined) {
    throw new Error(`模型不存在：${selected.provider}/${selected.modelId}`);
  }

  // 关闭自动压缩、SDK 重试与缓存预热：重试与预算由宿主控制。
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
  });

  const extension = createDiagnosisExtension({
    paths,
    knowledge: options.knowledge,
    budget,
    evidence,
    redactor,
    attachments,
    recorder,
    serviceId: config.serviceId,
    modelLabel: `${selected.provider}/${selected.modelId}`,
    audit,
  });

  /** 构造服务与会话；/new、/resume 时会再次调用。 */
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      // resourceLoaderOptions 不接受 cwd/agentDir/settingsManager：
      // 那三项由 services 统一注入，避免两处来源不一致。
      resourceLoaderOptions: {
        // 只加载我们的扩展；不发现项目或用户目录中的任何扩展。
        extensionFactories: [{ name: 'finch', factory: extension, hidden: true }],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: SYSTEM_PROMPT,
        // 内置 MCP / codemode / 工具检索属于旁路执行能力，一律不加载。
        disabledBuiltinExtensions: ['mcp', 'codemode', 'tool-search'],
      },
    });

    const tools: ToolDefinition[] = createReadOnlyTools({
      repository: repository as RepositoryHandle,
      evidence,
      redactor,
      // 返回的是实时视图：会话中新授权的 @文件 必须对工具立即可见。
      attachments: attachments.toolView,
      limits: config.limits,
      canWork: () => budget.canStartWork(),
    });

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      // 白名单只列我们的工具：SDK 的 tools 是启用白名单，
      // 传空数组会把自定义工具一并禁用。
      tools: tools.map((tool) => tool.name),
      customTools: tools,
    });

    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: config.repoRoot,
    agentDir: paths.configDir,
    sessionManager: SessionManager.inMemory(config.repoRoot),
  });

  return {
    runtime,
    evidence,
    audit,
    budget,
    redactor,
    currentModel: selected,
    serviceId: config.serviceId,
    sessionId: recorder.sessionId,
    dispose: async () => {
      // 取消预算：会话结束后不再发放任何执行许可。
      // 计时本身由扩展在 agent_start / agent_settled 上驱动（见 agent/extension.ts）。
      budget.cancel();
      // 先落盘再清空：会话记录要在退出前写完，脱敏映射则不应留在内存里。
      recorder.record('session.close', { evidence: evidence.summary().count });
      await recorder.flush();
      redactor.clear();
      evidence.clear();
      attachments.clear();
    },
  };
}
