/**
 * 单仓库只读检索。
 *
 * 安全与性能边界（PRD FR-02、Spec 5.3）：
 * - 只读；不执行构建、测试或仓库脚本。
 * - 不跟随符号链接越出仓库根；拒绝仓库外路径。
 * - 默认跳过依赖、构建产物、VCS 与二进制文件。
 * - 字面量匹配，不接受模型提供的任意正则，避免回溯爆炸。
 * - 文件数、扫描量、行数、字节数均有上限，超出即标记未覆盖。
 */
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** 默认跳过的目录：依赖、构建产物、VCS 与工具缓存。 */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.mvn',
  'coverage',
  '.cache',
]);

/** 常见二进制与归档扩展名；不做内容嗅探，避免额外 IO。 */
const BINARY_EXTENSIONS = new Set([
  '.jar', '.war', '.ear', '.class', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.dat',
]);

/** 凭证类文件不参与检索，避免把密钥带进上下文。 */
const SENSITIVE_NAMES = new Set(['.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'credentials']);

/**
 * 区间读取的单次扫描字节上限。
 *
 * WHY：请求的行号可能远在文件尾部，此时仍要顺序读完前面的内容。
 * 源码文件达到这个体量已属异常，继续扫下去只是白烧 CPU。
 */
const MAX_SOURCE_SCAN_BYTES = 64 * 1024 * 1024;

export interface RepositoryLimits {
  readonly maxFiles: number;
  readonly maxScanBytes: number;
  readonly maxFileBytes: number;
  readonly maxHits: number;
}

export interface SearchHit {
  readonly relativePath: string;
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly ok: boolean;
  readonly hits: readonly SearchHit[];
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly skippedFiles: number;
  readonly truncated: boolean;
  readonly reason?: string;
}

export interface RepositoryHandle {
  readonly root: string;
}

/**
 * 校验仓库根目录。
 *
 * 必须是存在的目录且不是符号链接——软链根会让“仓库内”的判断失去意义。
 */
export async function openRepository(root: string): Promise<RepositoryHandle | { error: string }> {
  try {
    const linkStat = await lstat(root);
    if (linkStat.isSymbolicLink()) {
      return { error: '仓库根目录不能是符号链接' };
    }
    if (!linkStat.isDirectory()) {
      return { error: '仓库根目录不是目录' };
    }
    return { root: path.resolve(root) };
  } catch {
    return { error: '仓库根目录不存在或不可读' };
  }
}

/** 判断相对路径是否位于仓库内，且未被排除规则跳过。 */
function isEligible(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
    return false;
  }
  const base = segments.at(-1) ?? '';
  if (SENSITIVE_NAMES.has(base)) {
    return false;
  }
  return !BINARY_EXTENSIONS.has(path.extname(base).toLowerCase());
}

/**
 * 递归收集候选文件。
 *
 * 使用 lstat 而非 stat：符号链接目录不应被跟随，否则可能越出仓库根。
 */
async function collectFiles(
  root: string,
  directory: string,
  output: string[],
  limit: number,
): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (output.length >= limit) {
      // WHY：达到上限意味着后面还有文件没看。返回 false 让 searchRepository
      // 把 truncated 置为 true；返回 true 会让模型以为「已扫描全部、没有更多命中」。
      return false;
    }
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute);

    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const complete = await collectFiles(root, absolute, output, limit);
      if (!complete) {
        // 达到上限即停止，由调用方标记未覆盖。
        return false;
      }
      continue;
    }
    if (entry.isFile() && isEligible(relative)) {
      output.push(relative);
    }
  }
  return true;
}

/**
 * 字面量搜索。
 *
 * 逐文件读取并逐行匹配；读取前按大小过滤，避免把大文件整体载入。
 * 所有上限触发都体现在 truncated 与 skippedFiles 上，调用方必须如实展示。
 */
export async function searchRepository(
  handle: RepositoryHandle,
  terms: readonly string[],
  options: { readonly subPath?: string; readonly limits: RepositoryLimits },
): Promise<SearchResult> {
  const cleanTerms = terms.map((term) => term.trim()).filter((term) => term !== '');
  if (cleanTerms.length === 0) {
    return {
      ok: false,
      hits: [],
      filesScanned: 0,
      bytesScanned: 0,
      skippedFiles: 0,
      truncated: false,
      reason: '搜索词不能为空',
    };
  }

  // 子路径必须仍在仓库内；`..` 逃逸在这里被拒绝。
  let searchRoot = handle.root;
  if (options.subPath !== undefined) {
    const resolved = path.resolve(handle.root, options.subPath);
    const relative = path.relative(handle.root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return {
        ok: false,
        hits: [],
        filesScanned: 0,
        bytesScanned: 0,
        skippedFiles: 0,
        truncated: false,
        reason: '子路径超出仓库范围',
      };
    }
    searchRoot = resolved;
  }

  const files: string[] = [];
  const complete = await collectFiles(handle.root, searchRoot, files, options.limits.maxFiles);

  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let bytesScanned = 0;
  let skippedFiles = 0;
  let attempted = 0;
  // collectFiles 返回 false 表示候选文件本身就没收集完，剩余数量未知，
  // 只能由 truncated 表达，无法折成 skippedFiles 的具体数字。
  let truncated = !complete;

  for (const relative of files) {
    if (hits.length >= options.limits.maxHits || bytesScanned >= options.limits.maxScanBytes) {
      truncated = true;
      break;
    }

    attempted += 1;
    const absolute = path.join(handle.root, relative);
    try {
      const stats = await stat(absolute);
      if (stats.size > options.limits.maxFileBytes) {
        skippedFiles += 1;
        truncated = true;
        continue;
      }

      const content = await readFile(absolute, 'utf8');
      filesScanned += 1;
      bytesScanned += Buffer.byteLength(content, 'utf8');

      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (cleanTerms.some((term) => line.includes(term))) {
          hits.push({ relativePath: relative, line: index + 1, text: line.trim() });
          if (hits.length >= options.limits.maxHits) {
            truncated = true;
            break;
          }
        }
      }
    } catch {
      // 单个文件不可读不应中断整体搜索；计入跳过并在结果中体现。
      skippedFiles += 1;
      truncated = true;
    }
  }

  // 已收集但因命中/字节上限而从未查看的文件同样属于「未覆盖」，
  // 不计入 skippedFiles 会让「跳过了多少」严重低估。
  if (attempted < files.length) {
    skippedFiles += files.length - attempted;
  }

  return { ok: true, hits, filesScanned, bytesScanned, skippedFiles, truncated };
}

/**
 * 读取指定文件的区间片段。
 *
 * 逐行流式截取：只把目标区间留在内存里，不整文件载入。
 * 仓库里可能出现被检入的大文件（SQL dump、超长日志），
 * 整读会让一次工具调用吃掉几十 MB 内存。
 *
 * 行号在文件变化后可能失效；调用方必须自行核对版本再引用。
 */
export async function readSourceRange(
  handle: RepositoryHandle,
  relativePath: string,
  startLine: number,
  endLine: number,
): Promise<{ ok: boolean; lines: readonly string[]; reason?: string }> {
  const resolved = path.resolve(handle.root, relativePath);
  const relative = path.relative(handle.root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, lines: [], reason: '路径超出仓库范围' };
  }
  if (!isEligible(relative)) {
    return { ok: false, lines: [], reason: '该文件类型默认不读取' };
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { ok: false, lines: [], reason: '行号区间不合法' };
  }

  const reader = createInterface({ input: createReadStream(resolved), crlfDelay: Infinity });
  const lines: string[] = [];
  let index = 0;
  let scannedBytes = 0;
  let stoppedEarly = false;

  try {
    for await (const line of reader) {
      index += 1;
      if (index > endLine) {
        break;
      }
      scannedBytes += Buffer.byteLength(line, 'utf8') + 1;
      if (scannedBytes > MAX_SOURCE_SCAN_BYTES) {
        // 流式读取不会撑爆内存，但行号很靠后时仍会白读整个文件。
        // 这里如实拒绝，而不是返回一段看起来完整的片段。
        stoppedEarly = true;
        break;
      }
      if (index < startLine) {
        continue;
      }
      lines.push(line);
    }
  } catch {
    return { ok: false, lines: [], reason: '文件不存在或不可读' };
  } finally {
    reader.close();
  }

  if (stoppedEarly) {
    return { ok: false, lines: [], reason: '文件过大，未在扫描上限内定位到该行区间' };
  }
  return { ok: true, lines };
}
