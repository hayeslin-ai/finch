/**
 * 数值限制与预算解析。
 *
 * WHY：预算、查询次数等既可由 `.env` 调整，又是安全边界的一部分。
 * 若允许任意数值，配置就能悄悄扩大授权范围。
 * 因此每个字段都定义上下界，越界直接判为配置错误，
 * 而不是夹取成合法值后继续运行。
 */

/** 单个数值限制的定义。 */
export interface LimitSpec {
  readonly key: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  readonly unit: string;
}

/** 与 PRD 第 7 节、Spec 3.2 一致。 */
export const LIMIT_SPECS = {
  DIAGNOSIS_TIMEOUT_MS: { key: 'DIAGNOSIS_TIMEOUT_MS', min: 60_000, max: 1_800_000, defaultValue: 300_000, unit: 'ms' },
  QUERY_TIMEOUT_MS: { key: 'QUERY_TIMEOUT_MS', min: 1_000, max: 60_000, defaultValue: 15_000, unit: 'ms' },
  CONNECT_TIMEOUT_MS: { key: 'CONNECT_TIMEOUT_MS', min: 10_000, max: 180_000, defaultValue: 60_000, unit: 'ms' },
  MAX_QUERY_COUNT: { key: 'MAX_QUERY_COUNT', min: 1, max: 100, defaultValue: 20, unit: '次' },
  MAX_FILES: { key: 'MAX_FILES', min: 1, max: 100, defaultValue: 10, unit: '个' },
  MAX_RESULT_LINES: { key: 'MAX_RESULT_LINES', min: 10, max: 5_000, defaultValue: 2_000, unit: '行' },
  MAX_RESULT_BYTES: { key: 'MAX_RESULT_BYTES', min: 4_096, max: 1_048_576, defaultValue: 524_288, unit: '字节' },
} as const satisfies Record<string, LimitSpec>;

export type LimitKey = keyof typeof LIMIT_SPECS;
export type Limits = Record<LimitKey, number>;

export interface LimitIssue {
  readonly key: string;
  readonly reason: string;
}

export interface LimitsResult {
  readonly limits: Limits;
  readonly issues: readonly LimitIssue[];
}

const INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * 从原始键值解析限制。
 *
 * 缺失时使用默认值；存在但非法时记录问题，并仍保留默认值，
 * 由调用方决定是拒绝启动还是提示修复。这样 doctor 能一次报告全部问题。
 */
export function parseLimits(raw: ReadonlyMap<string, string>): LimitsResult {
  const limits = {} as Limits;
  const issues: LimitIssue[] = [];

  for (const spec of Object.values(LIMIT_SPECS)) {
    const rawValue = raw.get(spec.key);
    if (rawValue === undefined || rawValue === '') {
      limits[spec.key] = spec.defaultValue;
      continue;
    }

    if (!INTEGER_PATTERN.test(rawValue)) {
      limits[spec.key] = spec.defaultValue;
      issues.push({ key: spec.key, reason: '必须是十进制整数' });
      continue;
    }

    const value = Number(rawValue);
    if (value < spec.min || value > spec.max) {
      limits[spec.key] = spec.defaultValue;
      issues.push({
        key: spec.key,
        reason: `必须在 ${spec.min} 到 ${spec.max} ${spec.unit}之间`,
      });
      continue;
    }

    limits[spec.key] = value;
  }

  // 单条查询不能超过总预算，否则超时策略自相矛盾。
  if (limits.QUERY_TIMEOUT_MS > limits.DIAGNOSIS_TIMEOUT_MS) {
    issues.push({
      key: 'QUERY_TIMEOUT_MS',
      reason: '单条查询时限不得超过总探查预算',
    });
  }

  return { limits, issues };
}
