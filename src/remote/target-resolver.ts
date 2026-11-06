/**
 * 目标机解析。
 *
 * 已确认的三级来源，按可靠性排序：
 * 1. **日志提取**：日志记录头第 4 段就是主机 IP，属于证据而非记忆；
 * 2. **最近使用**：本地记住最近成功连接过的目标；
 * 3. **手工输入**：全新环境兜底。
 *
 * 无论来自哪一级，都必须通过网段校验，并且**连接前展示给用户确认**。
 * 提取出的主机只是建议——用户可能在看另一台机器上的日志。
 */
import { validateTargetHost } from '../config/target.js';
import type { AppPaths } from '../config/paths.js';
import { parseRecords } from '../logs/format.js';
import { loadRecentTargets } from '../state/recent-targets.js';

export type TargetSource = 'provided' | 'log' | 'history' | 'none';

export interface TargetResolution {
  /** 建议的目标；`none` 时为空。 */
  readonly host?: string;
  readonly source: TargetSource;
  /** 候选列表，供交互选择；仅包含通过校验的地址。 */
  readonly candidates: readonly string[];
  /** 说明为什么建议这个目标，展示给用户。 */
  readonly reason: string;
}

/**
 * 从日志文本中提取出现次数最多的合法主机。
 *
 * 只看记录头第 4 段，不解析消息正文——正文里的 IP 可能是对端地址或配置示例。
 */
export function extractHostFromLogs(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const record of parseRecords(text)) {
    const host = record.host.trim();
    if (host === '' || !validateTargetHost(host).ok) {
      continue;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  let best: string | undefined;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 解析目标机。
 *
 * 优先级：显式指定 > 日志提取 > 最近使用。
 * 显式值非法时直接报错，而不是悄悄回退——用户明确写下的地址被替换
 * 会让人以为连的是自己指定的机器。
 */
export async function resolveTarget(input: {
  readonly paths: AppPaths;
  /** 用户在 /trace 中显式给出的目标。 */
  readonly requested?: string;
  /** 本次对话中已提供的日志文本，用于提取主机。 */
  readonly logText?: string;
  /** 允许注入最近目标列表，便于测试。 */
  readonly recentTargets?: readonly string[];
}): Promise<TargetResolution> {
  const recent = input.recentTargets ?? (await loadRecentTargets(input.paths.stateDir));
  const history = recent.filter((host) => validateTargetHost(host).ok);

  if (input.requested !== undefined && input.requested.trim() !== '') {
    const check = validateTargetHost(input.requested);
    if (!check.ok) {
      return {
        source: 'none',
        candidates: history,
        reason: `指定的目标不合法：${check.reason ?? ''}`,
      };
    }
    return {
      host: input.requested,
      source: 'provided',
      candidates: history,
      reason: '使用命令行指定的目标',
    };
  }

  const fromLog = input.logText === undefined ? undefined : extractHostFromLogs(input.logText);
  if (fromLog !== undefined) {
    return {
      host: fromLog,
      source: 'log',
      candidates: history,
      reason: '从日志记录头提取的目标，请确认它对应本次排查的机器',
    };
  }

  if (history.length === 1) {
    const host = history[0] as string;
    return {
      host,
      source: 'history',
      candidates: history,
      reason: '最近一次成功连接的目标',
    };
  }

  if (history.length > 1) {
    return {
      source: 'history',
      candidates: history,
      reason: '有多个历史目标，请选择或使用 --host 指定',
    };
  }

  return {
    source: 'none',
    candidates: [],
    reason: '没有可用的目标：请提供日志、使用 --host，或先成功连接一次',
  };
}
