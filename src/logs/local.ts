/**
 * 本地日志读取。
 *
 * 安全要点（PRD FR-12、SEC-04）：
 * - 授权绑定到用户显式指定的具体文件，不扩展为父目录扫描或相邻文件。
 * - 拒绝目录、符号链接、设备、管道等非普通文件。
 * - 有界读取：行数与字节数双上限，超出即标记截断，不静默丢弃。
 * - `.gz` 流式解压，不生成解压副本；压缩与解压字节分别计量。
 */
import { createReadStream } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

export interface LocalLogLimits {
  readonly maxLines: number;
  readonly maxBytes: number;
  /** 单次扫描的解压/读取上限，防止大文件读满 CPU。 */
  readonly maxScanBytes: number;
}

export interface LocalLogResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly truncated: 'none' | 'tail' | 'scan-limit';
  readonly reason?: string;
}

export interface AttachmentHandle {
  readonly path: string;
  readonly realPath: string;
  readonly size: number;
  readonly compressed: boolean;
}

/**
 * 校验并打开一个显式指定的附件。
 *
 * 只做一次身份确认：拒绝符号链接与特殊文件，返回真实路径供后续读取复用。
 * 明确不承诺消除所有父目录竞态——这是 Node 文件 API 的能力边界。
 */
export async function authorizeAttachment(target: string): Promise<AttachmentHandle | { error: string }> {
  try {
    const linkStat = await lstat(target);
    if (linkStat.isSymbolicLink()) {
      return { error: '拒绝读取符号链接' };
    }
    if (!linkStat.isFile()) {
      return { error: '只允许读取普通文件' };
    }

    const stats = await stat(target);
    if (stats.dev !== linkStat.dev || stats.ino !== linkStat.ino) {
      return { error: '文件在检查期间发生变化，请重试' };
    }

    return {
      path: target,
      realPath: path.resolve(target),
      size: stats.size,
      compressed: path.extname(target).toLowerCase() === '.gz',
    };
  } catch {
    return { error: '文件不存在或不可读' };
  }
}

/**
 * 有界读取。
 *
 * 使用 readline 逐行消费，先判断行数与字节上限再累积，
 * 因此不会把整个大文件读进内存。
 */
export async function readLocalLog(
  handle: AttachmentHandle,
  limits: LocalLogLimits,
): Promise<LocalLogResult> {
  const raw = createReadStream(handle.realPath);
  const source = handle.compressed ? raw.pipe(createGunzip()) : raw;

  const lines: string[] = [];
  let totalBytes = 0;
  let totalLines = 0;
  let truncated: LocalLogResult['truncated'] = 'none';

  const reader = createInterface({ input: source, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      totalLines += 1;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      totalBytes += lineBytes;

      // 扫描上限优先：达到后立即停止，返回 partial 而不是继续吃 CPU。
      if (totalBytes > limits.maxScanBytes) {
        truncated = 'scan-limit';
        break;
      }

      if (lines.length >= limits.maxLines || totalBytes - lineBytes >= limits.maxBytes) {
        truncated = 'tail';
        continue;
      }

      lines.push(line);
    }
  } catch {
    reader.close();
    return {
      ok: false,
      lines,
      totalLines,
      totalBytes,
      truncated,
      reason: handle.compressed ? '解压失败，可能不是有效的 gzip 文件' : '读取失败',
    };
  }

  return { ok: true, lines, totalLines, totalBytes, truncated };
}

/**
 * 按区间读取指定行。
 *
 * 仅用于已经通过搜索定位到行号后的上下文补取；
 * 同样受行数与字节上限约束。
 */
export async function readLocalRange(
  handle: AttachmentHandle,
  startLine: number,
  endLine: number,
  limits: LocalLogLimits,
): Promise<LocalLogResult> {
  const boundedEnd = Math.min(endLine, startLine + limits.maxLines - 1);
  const raw = createReadStream(handle.realPath);
  const source = handle.compressed ? raw.pipe(createGunzip()) : raw;
  const reader = createInterface({ input: source, crlfDelay: Infinity });

  const lines: string[] = [];
  let index = 0;
  let totalBytes = 0;
  let truncated: LocalLogResult['truncated'] = 'none';

  try {
    for await (const line of reader) {
      index += 1;
      if (index < startLine) {
        continue;
      }
      if (index > boundedEnd) {
        truncated = 'tail';
        break;
      }
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (totalBytes + lineBytes > limits.maxBytes) {
        truncated = 'tail';
        break;
      }
      totalBytes += lineBytes;
      lines.push(line);
    }
  } finally {
    reader.close();
  }

  return { ok: true, lines, totalLines: lines.length, totalBytes, truncated };
}

/**
 * 在附件中按字面量搜索。
 *
 * 返回行号而非内容，避免把整段日志一次性塞进内存或模型。
 * 多次命中只保留前 maxHits 条，并明确说明是否被截断。
 */
export async function searchLocalLog(
  handle: AttachmentHandle,
  terms: readonly string[],
  options: { readonly maxHits: number; readonly maxScanBytes: number },
): Promise<{ ok: boolean; hits: ReadonlyArray<{ line: number; term: string }>; truncated: boolean }> {
  if (terms.length === 0 || terms.some((term) => term.trim() === '')) {
    return { ok: false, hits: [], truncated: false };
  }

  const raw = createReadStream(handle.realPath);
  const source = handle.compressed ? raw.pipe(createGunzip()) : raw;
  const reader = createInterface({ input: source, crlfDelay: Infinity });

  const hits: Array<{ line: number; term: string }> = [];
  let index = 0;
  let scannedBytes = 0;
  let truncated = false;

  try {
    for await (const line of reader) {
      index += 1;
      scannedBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (scannedBytes > options.maxScanBytes) {
        truncated = true;
        break;
      }
      for (const term of terms) {
        if (line.includes(term)) {
          hits.push({ line: index, term });
          if (hits.length >= options.maxHits) {
            truncated = true;
            break;
          }
        }
      }
      if (truncated) {
        break;
      }
    }
  } finally {
    reader.close();
  }

  return { ok: true, hits, truncated };
}

/** 打开只读描述符确认可读，用于极早期失败提示；不读取内容。 */
export async function canRead(target: string): Promise<boolean> {
  try {
    const handle = await open(target, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}
