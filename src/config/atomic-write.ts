/**
 * 配置文件的原子写入。
 *
 * WHY：向导要修改用户已有的 `.env` 与 `models.json`。
 * 直接覆盖有两个风险：写入中途失败会留下半截文件；
 * 并发修改会静默丢失他人的编辑。
 * 因此：先读旧内容并记录指纹 → 生成新内容 → 临时文件 0600 → 复核指纹 → 原子替换。
 */
import { createHash } from 'node:crypto';
import { chmod, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 并发修改错误：文件在读取后被改动过。 */
export class ConcurrentModificationError extends Error {
  constructor() {
    super('配置文件在编辑期间被其他程序修改，已放弃写入');
    this.name = 'ConcurrentModificationError';
  }
}

/** 读取内容的指纹；用于检测并发修改。 */
export function fingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 原子替换文件内容。
 *
 * expectedFingerprint 为读取时的指纹；不匹配说明有人改过，拒绝覆盖。
 * 临时文件与目标同目录，保证 rename 是同一文件系统内的原子操作。
 */
export async function atomicWriteFile(
  target: string,
  content: string,
  expectedFingerprint: string,
): Promise<void> {
  let currentFingerprint: string | undefined;
  try {
    const { readFile } = await import('node:fs/promises');
    currentFingerprint = fingerprint(await readFile(target, 'utf8'));
  } catch {
    // 文件不存在：视为首次写入，无需并发校验。
    currentFingerprint = undefined;
  }

  if (currentFingerprint !== undefined && currentFingerprint !== expectedFingerprint) {
    throw new ConcurrentModificationError();
  }

  const directory = path.dirname(target);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    // 先以 0600 创建，保证内容从一开始就不是他人可读。
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    // 失败时清理临时文件，避免残留含密钥的半成品。
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** 读取文件与指纹；不存在时返回 undefined，便于区分“新建”与“编辑”。 */
export async function readWithFingerprint(
  target: string,
): Promise<{ content: string; fingerprint: string; mode: number } | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(target, 'utf8');
    const stats = await stat(target);
    return { content, fingerprint: fingerprint(content), mode: stats.mode & 0o777 };
  } catch {
    return undefined;
  }
}
