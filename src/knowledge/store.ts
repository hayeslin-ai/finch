/**
 * 故障知识库（本地 Markdown）。
 *
 * WHY：重复故障不该每次从零排查，但历史结论绝不能替代本次证据。
 * 因此这里的设计原则是：
 * - 一条经验一个文件，每次修订新增版本，不覆盖旧版；
 * - 只有人工确认的条目才进入默认检索；
 * - 检索结果是“线索”，不是“结论”。
 *
 * 不引入数据库、向量服务或知识图谱：文件即可，且便于人工审阅与版本控制。
 */
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 条目状态：只有 confirmed 参与默认检索。 */
export type KnowledgeStatus = 'draft' | 'confirmed' | 'invalidated';

/** 条目元数据；与 Markdown 正文分离，避免依赖可执行 YAML。 */
export interface KnowledgeMeta {
  readonly entryId: string;
  readonly revision: number;
  readonly scopeId: string;
  readonly status: KnowledgeStatus;
  readonly title: string;
  readonly errorSignature: string;
  readonly rootCauseConfirmed: boolean;
  readonly fixVerified: boolean;
  readonly applicableVersion: string;
  readonly createdAt: string;
  readonly previousRevision?: number;
}

export interface KnowledgeEntry {
  readonly meta: KnowledgeMeta;
  readonly body: string;
}

/** 条目目录：按作用域隔离，避免不同服务的经验互相污染。 */
function entryDirectory(dataDir: string, scopeId: string, entryId: string): string {
  return path.join(dataDir, 'knowledge', sanitize(scopeId), sanitize(entryId));
}

/**
 * 只允许安全字符作为路径段。
 *
 * WHY：scopeId 与 entryId 来自配置或生成逻辑，
 * 但仍要防止 `..` 或路径分隔符造成越界写入。
 */
function sanitize(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`标识不合法：${value}`);
  }
  return value;
}

/** Markdown 结构：元数据块 + 正文。解析时只认固定标记，不引入 YAML 依赖。 */
const META_START = '<!-- finch:meta';
const META_END = '-->';

/** 渲染条目为 Markdown 文本。 */
export function renderEntry(entry: KnowledgeEntry): string {
  const metaLines = [
    META_START,
    JSON.stringify(entry.meta, null, 2),
    META_END,
    '',
    `# ${entry.meta.title}`,
    '',
    entry.body.trim(),
    '',
  ];
  return metaLines.join('\n');
}

/** 解析 Markdown 条目；无法识别时返回 undefined，由调用方报告损坏。 */
export function parseEntry(text: string): KnowledgeEntry | undefined {
  const start = text.indexOf(META_START);
  const end = text.indexOf(META_END, start);
  if (start < 0 || end < 0) {
    return undefined;
  }

  const rawMeta = text.slice(start + META_START.length, end).trim();
  let meta: KnowledgeMeta;
  try {
    meta = JSON.parse(rawMeta) as KnowledgeMeta;
  } catch {
    return undefined;
  }

  if (typeof meta.entryId !== 'string' || typeof meta.revision !== 'number') {
    return undefined;
  }

  const body = text.slice(end + META_END.length).replace(/^\s*#[^\n]*\n/, '').trim();
  return { meta, body };
}

/** 保存为新修订；已存在则递增版本，绝不覆盖旧文件。 */
export async function saveRevision(
  dataDir: string,
  entry: Omit<KnowledgeEntry, 'meta'> & { meta: Omit<KnowledgeMeta, 'revision'> },
): Promise<KnowledgeMeta> {
  const directory = entryDirectory(dataDir, entry.meta.scopeId, entry.meta.entryId);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const existing = await listRevisions(dataDir, entry.meta.scopeId, entry.meta.entryId);
  const nextRevision = existing.length === 0 ? 1 : Math.max(...existing) + 1;

  const meta: KnowledgeMeta = {
    ...entry.meta,
    revision: nextRevision,
    ...(nextRevision > 1 ? { previousRevision: nextRevision - 1 } : {}),
  };

  const target = path.join(directory, `r${String(nextRevision).padStart(3, '0')}.md`);
  await writeFile(target, renderEntry({ meta, body: entry.body }), { mode: 0o600, flag: 'wx' });
  return meta;
}

/** 列出某条目的所有修订版本号。 */
export async function listRevisions(
  dataDir: string,
  scopeId: string,
  entryId: string,
): Promise<readonly number[]> {
  try {
    const directory = entryDirectory(dataDir, scopeId, entryId);
    const files = await readdir(directory);
    return files
      .map((name) => /^r(\d{3})\.md$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** 读取指定修订；不存在时返回 undefined。 */
export async function readRevision(
  dataDir: string,
  scopeId: string,
  entryId: string,
  revision: number,
): Promise<KnowledgeEntry | undefined> {
  const file = path.join(
    entryDirectory(dataDir, scopeId, entryId),
    `r${String(revision).padStart(3, '0')}.md`,
  );
  try {
    return parseEntry(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 元数据块所在的文件头长度。
 *
 * WHY：meta 是固定的小结构，而正文可能很长。
 * 读取 4 KiB 就能拿到 status/title/errorSignature，不必为了看一眼状态载入全文。
 */
const META_HEAD_BYTES = 4096;

/** 拼接某条目某修订的文件路径。 */
function revisionFile(dataDir: string, scopeId: string, entryId: string, revision: number): string {
  return path.join(entryDirectory(dataDir, scopeId, entryId), `r${String(revision).padStart(3, '0')}.md`);
}

/**
 * 只读文件头解析条目。
 *
 * 返回值中的 `bodyComplete` 表示正文是否已完整读到；
 * 为 false 时调用方若要按正文加权，必须再补一次整读。
 * 头部没覆盖完整元数据（异常但可能发生）时退回整读，
 * 避免把有效条目误判成损坏。
 */
export async function readRevisionHead(
  dataDir: string,
  scopeId: string,
  entryId: string,
  revision: number,
): Promise<{ entry: KnowledgeEntry; bodyComplete: boolean } | undefined> {
  let handle;
  try {
    handle = await open(revisionFile(dataDir, scopeId, entryId, revision), 'r');
    const buffer = Buffer.alloc(META_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, META_HEAD_BYTES, 0);
    const size = (await handle.stat()).size;

    const entry = parseEntry(buffer.subarray(0, bytesRead).toString('utf8'));
    if (entry !== undefined) {
      return { entry, bodyComplete: size <= bytesRead };
    }
    if (size <= bytesRead) {
      // 文件本来就这么大，确实损坏。
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }

  const full = await readRevision(dataDir, scopeId, entryId, revision);
  return full === undefined ? undefined : { entry: full, bodyComplete: true };
}

/**
 * 检索已确认条目。
 *
 * 只按作用域与字面量匹配，按错误签名与标题加权；
 * 不加载全文，避免把整库塞进模型上下文。
 *
 * 性能上分两步：先用文件头完成 status 过滤——草稿与失效条目到此为止，
 * 一次 4 KiB 读取即可排除；只有已确认条目才补读全文参与正文加权。
 * 条目积累到几百条后，这一步决定了 /knowledge search 是几百次全文 IO
 * 还是几百次小块读取。
 */
export async function searchKnowledge(
  dataDir: string,
  scopeId: string,
  terms: readonly string[],
  options: { readonly limit?: number } = {},
): Promise<readonly { readonly meta: KnowledgeMeta; readonly relevance: number }[]> {
  const limit = options.limit ?? 3;
  const clean = terms.map((term) => term.toLowerCase().trim()).filter((term) => term !== '');
  if (clean.length === 0) {
    return [];
  }

  const root = path.join(dataDir, 'knowledge', sanitize(scopeId));
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const hits: Array<{ meta: KnowledgeMeta; relevance: number }> = [];

  for (const entryId of entries) {
    const revisions = await listRevisions(dataDir, scopeId, entryId);
    const latest = revisions.at(-1);
    if (latest === undefined) {
      continue;
    }

    const head = await readRevisionHead(dataDir, scopeId, entryId, latest);
    // 草稿与失效条目不参与默认检索，这是防止污染诊断的关键。
    if (head === undefined || head.entry.meta.status !== 'confirmed') {
      continue;
    }

    const entry = head.bodyComplete
      ? head.entry
      : await readRevision(dataDir, scopeId, entryId, latest);
    if (entry === undefined) {
      continue;
    }

    const signature = entry.meta.errorSignature.toLowerCase();
    const title = entry.meta.title.toLowerCase();
    let relevance = 0;
    for (const term of clean) {
      if (signature.includes(term)) {
        relevance += 3;
      }
      if (title.includes(term)) {
        relevance += 2;
      }
      if (entry.body.toLowerCase().includes(term)) {
        relevance += 1;
      }
    }

    if (relevance > 0) {
      hits.push({ meta: entry.meta, relevance });
    }
  }

  return hits
    .sort((a, b) => b.relevance - a.relevance || a.meta.entryId.localeCompare(b.meta.entryId))
    .slice(0, limit);
}
