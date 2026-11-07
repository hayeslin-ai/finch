/**
 * 发布级别判定与版本号计算（Spec 4.1.1）。
 *
 * WHY：版本号由 PR 标题决定，判定逻辑必须能离线单测、可在本地复现；
 * 若只写在 workflow 的 shell 片段里，既不可测也无法回归。
 * 本模块是纯函数：不读文件、不读环境变量、不写 stdout。
 */

/** 发布级别，破坏性从高到低。V1 只支持这三档。 */
export type ReleaseLevel = 'major' | 'minor' | 'patch';

/** 语义化版本的三段数字。V1 不支持预发布与构建元数据。 */
export interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** 判定结果。跳过发版时 version 保持当前值，便于调用方统一输出。 */
export type ReleaseDecision =
  | {
      readonly release: true;
      /** `none` 只出现在手动触发「按当前版本原样发版」时，不是判定产物。 */
      readonly level: ReleaseLevel | 'none';
      readonly current: string;
      readonly version: string;
      readonly reason: string;
    }
  | {
      readonly release: false;
      readonly current: string;
      readonly version: string;
      readonly reason: string;
    };

/** 严格三段数字：拒绝 `v1.0.0`、`1.0`、`01.0.0`、`1.0.0-beta`。 */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * 类型后带 `!` 的破坏性标记，任意类型都算（`feat!:`、`docs!:`、`fix(scope)!:`）。
 * WHY：conventional commits 用 `!` 表示破坏性变更，与类型无关，
 * 只认 `feat!`/`fix!` 会漏掉 `refactor!:` 这类真实的主版本变更。
 */
const BANG_PATTERN = /^[a-z][a-z0-9-]*(?:\([^)]*\))?!:/;
const FEAT_PATTERN = /^feat(?:\([^)]*\))?:/;
const FIX_OR_PERF_PATTERN = /^(?:fix|perf)(?:\([^)]*\))?:/;

/**
 * 破坏性变更的字面量标记。
 * WHY：标题只有一行，规范里的 footer 写法只能以字面量形式出现在标题中；
 * 匹配时不要求结尾冒号，避免 `BREAKING CHANGE 移除旧参数` 这类漏判（漏判比误升更危险）。
 * 大小写不敏感：宁可多升一档主版本，也不要静默漏掉破坏性变更。
 */
const BREAKING_PATTERN = /BREAKING[ -]CHANGE/i;

/** 解析版本号；非法输入直接抛错，不猜测意图。 */
export function parseVersion(text: string): VersionParts {
  const trimmed = text.trim();
  const matched = VERSION_PATTERN.exec(trimmed);
  if (matched === null) {
    throw new Error(`版本号必须形如 1.2.3（不允许前缀、空格或预发布标记）：${JSON.stringify(text)}`);
  }
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
  };
}

/** 拼接为规范化版本号。 */
export function formatVersion(parts: VersionParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

/** 从标题判定级别；不匹配返回 undefined，由调用方决定是跳过还是报错。 */
export function detectLevel(title: string): ReleaseLevel | undefined {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (BREAKING_PATTERN.test(trimmed)) {
    return 'major';
  }
  if (BANG_PATTERN.test(trimmed)) {
    return 'major';
  }
  if (FEAT_PATTERN.test(trimmed)) {
    return 'minor';
  }
  if (FIX_OR_PERF_PATTERN.test(trimmed)) {
    return 'patch';
  }
  return undefined;
}

/** 按级别升版本；升级次版本与主版本时低位段归零。 */
export function bumpVersion(current: string, level: ReleaseLevel): string {
  const { major, minor, patch } = parseVersion(current);
  if (level === 'major') {
    return formatVersion({ major: major + 1, minor: 0, patch: 0 });
  }
  if (level === 'minor') {
    return formatVersion({ major, minor: minor + 1, patch: 0 });
  }
  return formatVersion({ major, minor, patch: patch + 1 });
}

/** 截断标题用于日志输出，避免一行几百字符污染步骤摘要。 */
function preview(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return '(空标题)';
  }
  return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 80)}…`;
}

/** 综合判定：给当前版本与 PR 标题，得到是否发版及目标版本。 */
export function decideRelease(current: string, title: string): ReleaseDecision {
  // 先校验当前版本，避免带着坏版本号进入后续写文件与打 tag 步骤。
  parseVersion(current);
  const level = detectLevel(title);
  if (level === undefined) {
    return {
      release: false,
      current,
      version: current,
      reason: `标题未匹配 fix/perf/feat/BREAKING CHANGE，跳过发版：${preview(title)}`,
    };
  }
  return {
    release: true,
    level,
    current,
    version: bumpVersion(current, level),
    reason: `${level} ← ${preview(title)}`,
  };
}

/** 手动触发的级别入参；`none` 表示按当前版本原样发版（首发与补发）。 */
export type LevelInput = ReleaseLevel | 'none';

/** 解析手动触发入参；未知值直接抛错，避免把拼错的级别当成跳过。 */
export function parseLevelInput(text: string): LevelInput {
  const trimmed = text.trim();
  if (trimmed === 'none' || trimmed === 'major' || trimmed === 'minor' || trimmed === 'patch') {
    return trimmed;
  }
  throw new Error(`level 只能是 none、major、minor、patch：${JSON.stringify(text)}`);
}
