/**
 * 远程文件枚举表。
 *
 * WHY：模型只能提交 fileRef，不能提交路径。fileRef 必须来自本会话的
 * LIST 结果，否则“读取任意远端文件”只需把路径塞进参数就能实现。
 * 因此枚举结果在这里登记，READ/SEARCH 只接受表内编号。
 *
 * 边界：
 * - 只保存路径、mtime、大小与是否压缩，不保存文件内容；
 * - 超出 MAX_FILES 的候选被丢弃并标记截断，不静默扩大授权；
 * - 重新枚举会清空旧表，避免旧编号指向已不属于本次范围的文件。
 */

/** 一个已登记的远程日志文件。 */
export interface RemoteFile {
  /** 模型可见的编号，形如 f-1。 */
  readonly ref: string;
  /** 远端绝对路径；只在宿主内部使用，不直接展示给模型。 */
  readonly path: string;
  /** 文件修改时间（毫秒）；无法取得时为 0。 */
  readonly mtimeMs: number;
  readonly size: number;
  /** `.gz` 结尾的轮转日志。 */
  readonly compressed: boolean;
  /** 展示用的文件名（不含目录）。 */
  readonly name: string;
}

/** LIST 输出的一行：`mtime<TAB>size<TAB>path`；回退模式下只有 path。 */
export interface ListedFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * 解析 LIST 的 stdout。
 *
 * 无法解析的行直接丢弃：枚举结果多一行或少一行都不影响安全，
 * 但把畸形行当成路径送进后续命令会破坏命令边界。
 */
export function parseListOutput(text: string): ListedFile[] {
  const files: ListedFile[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }

    const columns = line.split('\t');
    if (columns.length >= 3) {
      const mtime = Number(columns[0]);
      const size = Number(columns[1]);
      const path = columns[2] ?? '';
      if (Number.isFinite(mtime) && Number.isFinite(size) && path.startsWith('/')) {
        files.push({ path, mtimeMs: Math.round(mtime * 1000), size });
        continue;
      }
    } else if (columns.length === 1 && line.startsWith('/')) {
      // 回退模式：只有路径，没有 mtime/size，按“最旧”排序。
      files.push({ path: line, mtimeMs: 0, size: 0 });
    }
  }
  return files;
}

/** 取文件名部分；路径已在查询层校验过字符集。 */
function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

export interface RegisterResult {
  readonly files: readonly RemoteFile[];
  /** 候选总数超过上限时为 true。 */
  readonly truncated: boolean;
  /** 候选总数（截断前）。 */
  readonly total: number;
}

export class FileRegistry {
  private entries: readonly RemoteFile[] = [];

  /** 用一次 LIST 的结果整体替换枚举表。 */
  register(listed: readonly ListedFile[], maxFiles: number): RegisterResult {
    // 最新的文件优先：排障几乎总是从最近的日志开始。
    const sorted = [...listed].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const kept = sorted.slice(0, maxFiles);
    this.entries = kept.map((file, index) => ({
      ref: `f-${String(index + 1)}`,
      path: file.path,
      mtimeMs: file.mtimeMs,
      size: file.size,
      compressed: file.path.endsWith('.gz'),
      name: baseName(file.path),
    }));
    return {
      files: this.entries,
      truncated: sorted.length > kept.length,
      total: sorted.length,
    };
  }

  /** 全部已登记文件；模型默认搜索这些。 */
  all(): readonly RemoteFile[] {
    return this.entries;
  }

  /** 按编号查找；不存在返回 undefined，由调用方转成用户可读拒绝。 */
  resolve(ref: string): RemoteFile | undefined {
    return this.entries.find((file) => file.ref === ref);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
