/**
 * 配置加载与能力分级。
 *
 * WHY：本地诊断与远程功能依赖不同字段。若一个缺失的 oathtool 或空的目标机
 * 就阻止整个 CLI，团队成员连粘贴日志都用不了。
 * 因此这里按能力校验：基础、本地诊断、远程功能分开判断，
 * 并明确哪些问题必须拒绝启动、哪些只需提示。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { inspectPath, type AppPaths, type PathCheck } from './paths.js';
import { parseDotenv, type DotenvError } from './dotenv.js';
import { parseLimits, type LimitIssue, type Limits } from './limits.js';
import { resolveModelSelection, type ModelCandidate } from './model-selection.js';
import { validateBastionHost } from './target.js';

/** 配置分组；缺失只影响对应能力。 */
export type ConfigGroup = 'base' | 'local' | 'remote';

export interface ConfigIssue {
  readonly group: ConfigGroup;
  /** 只写键名，不写值；凭证类问题尤其如此。 */
  readonly key: string;
  readonly reason: string;
}

export interface LoadedConfig {
  readonly values: ReadonlyMap<string, string>;
  readonly limits: Limits;
  /** 当前模型；由 models.json 唯一候选或 --model 决定。 */
  readonly model?: ModelCandidate;
  /** 是否由唯一候选自动采用；用于在界面如实标注。 */
  readonly modelAutoSelected: boolean;
  /** 诊断范围；由启动目录推导，不来自配置。 */
  readonly repoRoot: string;
  readonly serviceId: string;
  readonly issues: readonly ConfigIssue[];
  /** 非阻断提醒：不影响能力可用性，但用户应当知道。 */
  readonly warnings: readonly ConfigIssue[];
  readonly pathChecks: readonly PathCheck[];
  /** 组内无问题时视为该能力可用。 */
  readonly available: Readonly<Record<ConfigGroup, boolean>>;
}

/**
 * 各能力依赖的必填键（仅指 `.env` 中的键）。
 *
 * 变动说明：
 * - 模型相关（MODEL_*）已全部移出 .env：模型定义在 models.json，
 *   当前模型由唯一候选自动采用，或由 --model / 会话内 /model 指定。
 * - EXPECT_PATH / OATH_TOOL 仅作为 PATH 查找的显式覆盖，不再是必填项；
 *   LOGIN_SCRIPT 已移除，登录脚本由程序自动生成到固定位置。
 * - TARGET_HOST 已移除：目标机由 /trace 按“日志提取 → 历史 → 手输”确定。
 * - JUMP_HOST / JUMP_PORT 是堡垒机 SSH 入口，属于环境事实而非机密；
 *   仓库与 Release 公开，因此只由使用者写入本地 .env，不随包分发。
 */
const REQUIRED_KEYS: Readonly<Record<ConfigGroup, readonly string[]>> = {
  base: [],
  local: [],
  remote: [
    'JUMP_HOST',
    'JUMP_PORT',
    'JUMP_USER',
    'JUMP_PASSWORD',
    'MFA_SECRET',
    'APP_GROUP',
    'APP_USER',
    'LOG_DIR',
  ],
};

function collectDotenvIssues(errors: readonly DotenvError[]): ConfigIssue[] {
  return errors.map((error) => ({
    group: 'base' as const,
    key: `line:${error.line}`,
    reason: error.reason,
  }));
}

function collectLimitIssues(issues: readonly LimitIssue[]): ConfigIssue[] {
  return issues.map((issue) => ({
    group: 'base' as const,
    key: issue.key,
    reason: issue.reason,
  }));
}

function collectMissingKeys(group: ConfigGroup, values: ReadonlyMap<string, string>): ConfigIssue[] {
  return REQUIRED_KEYS[group]
    .filter((key) => {
      const value = values.get(key);
      return value === undefined || value.trim() === '';
    })
    .map((key) => ({ group, key, reason: '缺少必填配置' }));
}

/**
 * 推导当前诊断范围。
 *
 * WHY 不再放进 .env：绝大多数排障就是在业务仓库里启动 CLI，
 * 让用户把绝对路径抄进配置既容易写错，也会让同一份配置换台机器就失效。
 *
 * 规则：
 * - 在 Git 仓库内运行时，仓库根取 `git rev-parse --show-toplevel`，
 *   这样在子目录启动也能指向整个项目；
 * - 非 Git 目录回退到当前工作目录；
 * - 服务标识取仓库目录名，用于证据与知识库的作用域。
 */
export async function deriveScope(cwd: string): Promise<{ repoRoot: string; serviceId: string }> {
  let repoRoot = path.resolve(cwd);
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 5_000,
    });
    const detected = stdout.trim();
    if (detected !== '') {
      repoRoot = detected;
    }
  } catch {
    // 非 Git 目录或 git 不可用：回退当前目录，不报错。
  }

  return { repoRoot, serviceId: path.basename(repoRoot) || 'unknown-service' };
}

/** 账户名白名单：进入 ssh/sudo 的字符串不允许空白与 Shell 组合字符。 */
const ACCOUNT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** 日志目录白名单：脚本按单个词发送，空白与注入字符会破坏命令边界。 */
const LOG_DIR_PATTERN = /^[A-Za-z0-9_./~-]+$/;

/**
 * 校验堡垒机连接字段。
 *
 * 只影响远程能力，不影响本地诊断；缺失由 REQUIRED_KEYS 统一报告，
 * 这里只检查已填写但格式非法的值，避免同一问题报两遍。
 */
function collectBastionIssues(values: ReadonlyMap<string, string>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const host = values.get('JUMP_HOST')?.trim() ?? '';
  if (host !== '') {
    const result = validateBastionHost(host);
    if (!result.ok) {
      issues.push({ group: 'remote', key: 'JUMP_HOST', reason: result.reason ?? '地址不合法' });
    }
  }

  const port = values.get('JUMP_PORT')?.trim() ?? '';
  if (port !== '') {
    const value = Number(port);
    if (!/^[1-9]\d{0,4}$/.test(port) || value > 65535) {
      issues.push({ group: 'remote', key: 'JUMP_PORT', reason: '必须是 1 到 65535 的十进制整数' });
    }
  }

  for (const key of ['JUMP_USER', 'APP_USER', 'APP_GROUP'] as const) {
    const value = values.get(key)?.trim() ?? '';
    if (value !== '' && !ACCOUNT_PATTERN.test(value)) {
      issues.push({
        group: 'remote',
        key,
        reason: '只能包含字母、数字与 _ . -，且不能以符号开头',
      });
    }
  }

  const logDir = values.get('LOG_DIR')?.trim() ?? '';
  if (logDir !== '' && !LOG_DIR_PATTERN.test(logDir)) {
    issues.push({ group: 'remote', key: 'LOG_DIR', reason: '只能是普通路径，不能含空白或 Shell 字符' });
  }

  return issues;
}

/** 从磁盘加载配置。
 *
 * 文件不存在不算错误：`init` 尚未执行时应给出可操作提示，
 * 而不是让用户面对一个异常堆栈。
 */
export async function loadConfig(
  paths: AppPaths,
  options?: { readonly model?: string },
): Promise<LoadedConfig> {
  const pathChecks = [
    inspectPath(paths.configDir, 'directory'),
    inspectPath(paths.envFile, 'file'),
    inspectPath(paths.modelsFile, 'file'),
  ];

  const issues: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  // .env 与 models.json 可能含凭证，权限不安全时阻断。
  const [configDirCheck, envCheck, modelsCheck] = pathChecks;
  for (const check of [configDirCheck, envCheck, modelsCheck]) {
    if (check !== undefined && check.exists && check.unsafe) {
      issues.push({ group: 'base', key: check.path, reason: check.reason ?? '路径不安全' });
    }
  }
  if (!pathChecks[0]?.exists) {
    issues.push({ group: 'base', key: paths.configDir, reason: '配置目录不存在' });
  }

  let values = new Map<string, string>();
  if (envCheck?.exists && !envCheck.unsafe) {
    const text = await readFile(paths.envFile, 'utf8');
    const parsed = parseDotenv(text);
    values = new Map(parsed.values);
    issues.push(...collectDotenvIssues(parsed.errors));
  } else if (envCheck?.exists && envCheck.unsafe) {
    issues.push({ group: 'base', key: paths.envFile, reason: '拒绝读取不安全的配置文件' });
  }

  // 诊断范围由启动目录推导；显式遗留值也不会被采用，避免两处来源不一致。
  const scope = await deriveScope(process.cwd());
  values.set('REPO_ROOT', scope.repoRoot);
  values.set('SERVICE_ID', scope.serviceId);

  const { limits, issues: limitIssues } = parseLimits(values);
  issues.push(...collectLimitIssues(limitIssues));

  for (const group of ['local', 'remote'] as const) {
    issues.push(...collectMissingKeys(group, values));
  }
  issues.push(...collectBastionIssues(values));

  // 当前模型：唯一候选自动采用，多候选必须显式 --model。
  const modelSelection = await resolveModelSelection(paths, options?.model);
  if (!modelSelection.ok) {
    issues.push({ group: 'local', key: 'model', reason: modelSelection.reason });
  }

  // 外部程序默认从 PATH 查找，环境变量只是可选覆盖；
  // 因此工具缺失不属于“配置缺失”，由 doctor --remote 与 /trace 在需要时报告。

  // TARGET_HOST 已移除；若配置中仍有旧值，仅作提示，不再参与任何逻辑。
  if (values.has('TARGET_HOST')) {
    issues.push({
      group: 'remote',
      key: 'TARGET_HOST',
      reason: '已废弃：目标机由 /trace 指定，该配置不再生效',
    });
  }

  const available: Record<ConfigGroup, boolean> = {
    base: !issues.some((issue) => issue.group === 'base'),
    local: !issues.some((issue) => issue.group === 'local') && !issues.some((issue) => issue.group === 'base'),
    remote: !issues.some((issue) => issue.group === 'remote') && !issues.some((issue) => issue.group === 'base'),
  };

  return {
    values,
    limits,
    ...(modelSelection.ok ? { model: modelSelection.selected } : {}),
    modelAutoSelected: modelSelection.ok ? modelSelection.autoSelected : false,
    repoRoot: scope.repoRoot,
    serviceId: scope.serviceId,
    issues,
    warnings,
    pathChecks,
    available,
  };
}
