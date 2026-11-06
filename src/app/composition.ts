/**
 * 组装根。
 *
 * WHY：Spec 4.2 要求具体适配器只在这里接线，核心与 CLI 不直接依赖 SDK 或文件系统实现。
 * 这样替换运行时或新增适配器时，改动集中在一处。
 *
 * 本文件是唯一允许同时引用 Pi 与各适配器的位置。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createDiagnosisRuntime, type DiagnosisRuntime } from '../agent/runtime.js';
import { createReadOnlyTools } from '../agent/tools.js';
import { SessionTurnRunner } from '../agent/turn-runner.js';
import type { LoadedConfig } from '../config/load.js';
import type { ModelCandidate } from '../config/model-selection.js';
import type { AppPaths } from '../config/paths.js';
import { BudgetController } from '../core/budget.js';
import { Diagnosis } from '../core/diagnosis.js';
import { AuditLedger } from '../core/audit.js';
import { EvidenceStore } from '../core/evidence.js';
import { authorizeAttachment, type AttachmentHandle } from '../logs/local.js';
import { openRepository } from '../repository/read.js';
import { Redactor } from '../security/redactor.js';

/** 组装结果；调用方负责在结束时 dispose。 */
export interface Composition {
  readonly diagnosis: Diagnosis;
  readonly runner: SessionTurnRunner;
  readonly redactor: Redactor;
  readonly attachments: ReadonlyMap<string, AttachmentHandle>;
  /** 当前模型；会话内可切换。 */
  readonly currentModel: ModelCandidate;
  /** 切换模型；模型必须存在于 models.json。 */
  switchModel(provider: string, modelId: string): Promise<void>;
  /** 当前思考等级。 */
  currentEffort(): string;
  /** 可用思考等级，由当前模型能力决定。 */
  availableEfforts(): readonly string[];
  /** 设置思考等级；不支持时抛错而不是静默忽略。 */
  setEffort(level: string): void;
  dispose(): void;
}

export interface ComposeOptions {
  readonly config: LoadedConfig;
  readonly paths: AppPaths;
  /** 已授权的本地附件路径；由输入解析产生。 */
  readonly attachmentPaths?: readonly string[];
}

/** 从 `.env` 读取模型凭证；只在内存中使用。 */
async function resolveApiKey(paths: AppPaths, variable: string): Promise<string> {
  const text = await readFile(paths.envFile, 'utf8');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=\\s*(.*)$`, 'm');
  const match = pattern.exec(text);
  if (match === null) {
    return '';
  }
  return (match[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** 从原生模型文件确认 provider 与模型存在，并区分凭证引用与内联字面量。 */
async function resolveModelCredentials(
  paths: AppPaths,
  providerId: string,
  modelId: string,
): Promise<{ kind: 'reference'; variable: string } | { kind: 'literal'; value: string }> {
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
  // 只有显式写 `$VAR` 或 `${VAR}` 才是引用；其余一律视为字面量。
  // WHY：字面量本身可能就是纯字母数字（例如测试网关的固定 key），
  // 若按“像变量名”就去找 .env，会错误地报告缺少凭证。
  const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey);
  if (reference === null) {
    return { kind: 'literal', value: apiKey };
  }
  return { kind: 'reference', variable: reference[1] ?? '' };
}

/**
 * 组装一次诊断。
 *
 * 任一步失败都抛错并带明确原因，由 CLI 转成用户可读提示；
 * 不静默降级到其他模型、其他仓库或默认配置。
 */
export async function compose(options: ComposeOptions): Promise<Composition> {
  const { config, paths } = options;

  // 仓库根由启动目录推导，不来自 .env。
  const repoRoot = config.repoRoot;
  // 当前模型由 models.json 的唯一候选或 --model 决定。
  const selected = config.model;
  if (selected === undefined) {
    throw new Error('尚未确定模型：models.json 中有多个候选时请用 --model 指定');
  }
  const providerId = selected.provider;
  const modelId = selected.modelId;

  const repository = await openRepository(repoRoot);
  if ('error' in repository) {
    throw new Error(`仓库不可用：${repository.error}`);
  }

  const credentials = await resolveModelCredentials(paths, providerId, modelId);
  const apiKey =
    credentials.kind === 'reference'
      ? await resolveApiKey(paths, credentials.variable)
      : credentials.value;
  if (apiKey === '') {
    throw new Error('缺少模型凭证：请检查 .env 中的凭证变量');
  }

  // 附件授权在组装阶段完成；失败只影响该附件，不阻断整体。
  const attachments = new Map<string, AttachmentHandle>();
  let attachmentIndex = 1;
  for (const target of options.attachmentPaths ?? []) {
    const handle = await authorizeAttachment(path.resolve(target));
    if ('error' in handle) {
      continue;
    }
    attachments.set(`att-${attachmentIndex}`, handle);
    attachmentIndex += 1;
  }

  const redactor = new Redactor();
  const evidence = new EvidenceStore();
  const audit = new AuditLedger();
  const budget = new BudgetController({ totalMs: config.limits.DIAGNOSIS_TIMEOUT_MS });

  const tools = createReadOnlyTools({
    repository,
    evidence,
    redactor,
    attachments,
    canWork: () => budget.canStartWork(),
  });

  const runtime: DiagnosisRuntime = await createDiagnosisRuntime({
    agentDir: paths.configDir,
    cwd: repoRoot,
    modelsPath: paths.modelsFile,
    providerId,
    modelId,
    apiKey,
    tools,
    redactor,
  });

  const runner = new SessionTurnRunner({ session: runtime.session, sanitize: (text) => redactor.redact(text) });

  const diagnosis = new Diagnosis({
    evidence,
    audit,
    budget,
    sanitize: (text) => redactor.redact(text),
  });

  return {
    diagnosis,
    runner,
    redactor,
    attachments,
    currentModel: { provider: providerId, modelId },
    async switchModel(nextProvider: string, nextModelId: string): Promise<void> {
      const next = runtime.modelRuntime.getModel(nextProvider, nextModelId);
      if (next === undefined) {
        throw new Error(`模型不存在：${nextProvider}/${nextModelId}`);
      }
      // 由 SDK 负责校验该模型是否已配置凭证；失败会抛出，调用方转成提示。
      await runtime.session.setModel(next);
    },
    currentEffort: () => runtime.session.thinkingLevel,
    availableEfforts: () => runtime.session.getAvailableThinkingLevels(),
    setEffort: (level: string) => {
      // 非法等级由 SDK 的类型约束兜底；这里先做显式检查，避免静默降级。
      const allowed = runtime.session.getAvailableThinkingLevels();
      if (!allowed.includes(level as never)) {
        throw new Error(`当前模型不支持该思考等级：${level}；可选：${allowed.join(', ')}`);
      }
      runtime.session.setThinkingLevel(level as never);
    },
    dispose: () => {
      runner.dispose();
      runtime.dispose();
      redactor.clear();
      evidence.clear();
    },
  };
}

/** 读取仓库版本信息；不可用时返回 unknown，不阻断诊断。 */
export async function readRepositoryVersion(repoRoot: string): Promise<{
  commit: string;
  dirty: boolean;
}> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
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

/** 检查路径是否存在且为目录，用于启动前的快速校验。 */
export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
