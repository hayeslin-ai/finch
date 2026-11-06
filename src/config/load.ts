/**
 * 配置加载与能力分级。
 *
 * WHY：本地诊断与远程功能依赖不同字段。若一个缺失的 oathtool 或空的目标机
 * 就阻止整个 CLI，团队成员连粘贴日志都用不了。
 * 因此这里按能力校验：基础、本地诊断、远程功能分开判断，
 * 并明确哪些问题必须拒绝启动、哪些只需提示。
 */
import { readFile } from 'node:fs/promises';

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
  local: ['REPO_ROOT', 'SERVICE_ID', 'MODEL_PROVIDER', 'MODEL_ID'],
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
