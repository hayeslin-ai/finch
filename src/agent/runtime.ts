/**
 * 诊断会话运行时。
 *
 * 负责按 Spec 7.1 固定 SDK 边界：
 * - 显式模型与模型运行时，禁用网络刷新与隐式凭证读取。
 * - 完整自定义空 ResourceLoader：不发现扩展、技能、提示模板、主题与项目指令。
 * - 内存设置与内存会话：不写 Pi 默认 JSONL，不自动压缩、不自动重试。
 * - 工具白名单：只注册本项目的只读工具。
 *
 * 明确边界：这是 SDK 集成层，不是操作系统沙箱。
 */
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type AgentSession,
  type CreateModelRuntimeOptions,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

import type { Redactor } from '../security/redactor.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

/** 凭证存储：只服务当前配置，决不读取磁盘或宿主环境。 */
class ScopedCredentialStore {
  constructor(
    private readonly providerId: string,
    private readonly apiKey: string,
  ) {}

  async read(providerId: string) {
    return providerId === this.providerId ? { type: 'api_key' as const, key: this.apiKey } : undefined;
  }

  async list() {
    return [{ providerId: this.providerId, type: 'api_key' as const }];
  }

  async modify() {
    // 本项目不允许在运行期修改凭证；向导负责写入，运行时只读。
    return undefined;
  }

  async delete(): Promise<void> {
    // 同上：运行时不删除凭证。
  }
}

/** 空资源加载器：所有发现能力返回空，系统提示词固定。 */
function createFixedResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export interface CreateRuntimeOptions {
  /** 应用配置目录；用于隔离 SDK 的 agentDir。 */
  readonly agentDir: string;
  /** 工作目录；仅影响 SDK 内部相对路径，本项目自行校验仓库路径。 */
  readonly cwd: string;
  readonly modelsPath: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly tools: readonly ToolDefinition[];
  readonly redactor: Redactor;
}

export interface DiagnosisRuntime {
  readonly session: AgentSession;
  dispose(): void;
}

/**
 * 创建诊断会话。
 *
 * 任何一步失败都抛错并附明确原因，由调用方转换为用户可读提示；
 * 不静默回退到其他模型或默认配置。
 */
export async function createDiagnosisRuntime(options: CreateRuntimeOptions): Promise<DiagnosisRuntime> {
  const runtimeOptions: CreateModelRuntimeOptions = {
    modelsPath: options.modelsPath,
    credentials: new ScopedCredentialStore(options.providerId, options.apiKey),
    refreshOnCreate: false,
    allowModelNetwork: false,
  };

  const modelRuntime = await ModelRuntime.create(runtimeOptions);
  const model = modelRuntime.getModel(options.providerId, options.modelId);
  if (model === undefined) {
    throw new Error(`模型不存在：${options.providerId} / ${options.modelId}`);
  }

  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
  });

  const result = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model,
    // 白名单只包含本项目注册的工具名：
    // SDK 的 tools 是启用白名单，传空数组会连自定义工具一并禁用；
    // 列出名称既启用只读工具，也排除全部内置工具。
    tools: options.tools.map((tool) => tool.name),
    excludeTools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'powershell'],
    customTools: [...options.tools],
    resourceLoader: createFixedResourceLoader(SYSTEM_PROMPT),
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager: settings,
  });

  return {
    session: result.session,
    dispose: () => result.session.dispose(),
  };
}

/**
 * 订阅流式文本增量。
 *
 * 所有增量都经过脱敏后再交给渲染层：
 * 模型的输出同样可能复述敏感内容，出口必须与入口同等严格。
 */
export function subscribeText(
  session: AgentSession,
  onText: (text: string) => void,
): () => void {
  return session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      onText(event.assistantMessageEvent.delta);
    }
  });
}
