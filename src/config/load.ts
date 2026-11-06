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
import { validateTargetHost } from './target.js';

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
  readonly issues: readonly ConfigIssue[];
  readonly pathChecks: readonly PathCheck[];
  /** 组内无问题时视为该能力可用。 */
  readonly available: Readonly<Record<ConfigGroup, boolean>>;
}

/** 各能力依赖的必填键。 */
const REQUIRED_KEYS: Readonly<Record<ConfigGroup, readonly string[]>> = {
  base: [],
  local: ['MODEL_PROVIDER', 'MODEL_ID'],
  remote: [
    'EXPECT_PATH',
    'LOGIN_SCRIPT',
    'OATH_TOOL',
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

/**
 * 校验目标机：显式目标与默认目标共用同一规则。
 * 非法目标只影响远程能力，不影响本地诊断。
 */
function collectTargetIssues(values: ReadonlyMap<string, string>): ConfigIssue[] {
  const target = values.get('TARGET_HOST');
  if (target === undefined || target.trim() === '') {
    return [];
  }
  const result = validateTargetHost(target);
  if (result.ok) {
    return [];
  }
  return [{ group: 'remote', key: 'TARGET_HOST', reason: result.reason ?? '目标不合法' }];
}

/**
 * 从磁盘加载配置。
 *
 * 文件不存在不算错误：`init` 尚未执行时应给出可操作提示，
 * 而不是让用户面对一个异常堆栈。
 */
export async function loadConfig(paths: AppPaths): Promise<LoadedConfig> {
  const pathChecks = [
    inspectPath(paths.configDir, 'directory'),
    inspectPath(paths.envFile, 'file'),
  ];

  const issues: ConfigIssue[] = [];
  for (const check of pathChecks) {
    if (check.exists && check.unsafe) {
      issues.push({ group: 'base', key: check.path, reason: check.reason ?? '路径不安全' });
    }
  }
  if (!pathChecks[0]?.exists) {
    issues.push({ group: 'base', key: paths.configDir, reason: '配置目录不存在' });
  }

  let values = new Map<string, string>();
  const envCheck = pathChecks[1];
  if (envCheck?.exists && !envCheck.unsafe) {
    const text = await readFile(paths.envFile, 'utf8');
    const parsed = parseDotenv(text);
    values = new Map(parsed.values);
    issues.push(...collectDotenvIssues(parsed.errors));
  } else if (envCheck?.exists && envCheck.unsafe) {
    issues.push({ group: 'base', key: paths.envFile, reason: '拒绝读取不安全的配置文件' });
  }

  // 诊断范围不再从 .env 读取；显式遗留值也不会被采用，避免两处来源不一致。
  const scope = await deriveScope(process.cwd());
  values.set('REPO_ROOT', scope.repoRoot);
  values.set('SERVICE_ID', scope.serviceId);

  const { limits, issues: limitIssues } = parseLimits(values);
  issues.push(...collectLimitIssues(limitIssues));

  for (const group of ['local', 'remote'] as const) {
    issues.push(...collectMissingKeys(group, values));
  }
  issues.push(...collectTargetIssues(values));

  const available: Record<ConfigGroup, boolean> = {
    base: !issues.some((issue) => issue.group === 'base'),
    local: !issues.some((issue) => issue.group === 'local') && !issues.some((issue) => issue.group === 'base'),
    remote: !issues.some((issue) => issue.group === 'remote') && !issues.some((issue) => issue.group === 'base'),
  };

  return { values, limits, issues, pathChecks, available };
}
