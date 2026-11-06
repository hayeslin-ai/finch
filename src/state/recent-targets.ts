/**
 * 最近使用的目标机。
 *
 * WHY 放在状态目录而不是配置目录：它记录的是“用过什么”，
 * 不是“配置成什么”。混进配置会让用户误以为它是默认值或授权。
 *
 * 安全边界：
 * - 只记录成功连接过的目标；
 * - 只用于提示与候选，**不构成任何授权**；
 * - 连接前仍必须由用户确认目标。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 最多记住的数量；再多也只是一屏候选，没有意义。 */
export const MAX_RECENT_TARGETS = 5;

/** 状态文件名。 */
const FILE_NAME = 'recent-targets.json';

/** 状态文件结构；版本用于未来兼容。 */
interface RecentTargetsFile {
  readonly schemaVersion: 1;
  readonly targets: readonly string[];
}

function filePath(stateDir: string): string {
  return path.join(stateDir, FILE_NAME);
}

/** 读取最近目标；文件不存在或损坏时返回空列表，不报错。 */
export async function loadRecentTargets(stateDir: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(filePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<RecentTargetsFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.targets)) {
      return [];
    }
    return parsed.targets.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/**
 * 记录一次成功连接。
 *
 * 最新的排在最前，重复项前移而不是重复出现。
 * 写入使用临时文件 + rename，避免中途失败留下半截 JSON。
 */
export async function rememberTarget(stateDir: string, target: string): Promise<void> {
  const existing = await loadRecentTargets(stateDir);
  const targets = [target, ...existing.filter((item) => item !== target)].slice(
    0,
    MAX_RECENT_TARGETS,
  );

  const payload: RecentTargetsFile = { schemaVersion: 1, targets };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const target_file = filePath(stateDir);
  const temporary = path.join(stateDir, `.${FILE_NAME}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target_file);
}
