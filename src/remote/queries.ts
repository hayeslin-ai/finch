/**
 * 远程查询模板与参数校验。
 *
 * WHY：模型只能表达“查什么”，不能表达“怎么查”。
 * 因此这里把查询意图编译成固定模板，并对参数逐项校验。
 * 任何无法安全表示的内容一律拒绝，不做转义尝试——
 * 转义规则一旦出错，注入就会静默生效。
 */

/** 允许的查询类型；与协议 opcode 对应。 */
export type QueryKind = 'LIST' | 'SEARCH' | 'READ';

export interface ListQuery {
  readonly kind: 'LIST';
  /** 日志根目录下的相对子目录；空表示根目录。 */
  readonly subDir: string;
  /** 枚举深度，固定 1–3。 */
  readonly maxDepth: number;
}

export interface SearchQuery {
  readonly kind: 'SEARCH';
  readonly terms: readonly string[];
  readonly before: number;
  readonly after: number;
}

export interface ReadQuery {
  readonly kind: 'READ';
  readonly fileRef: string;
  readonly startLine: number;
  readonly endLine: number;
}

export type RemoteQuery = ListQuery | SearchQuery | ReadQuery;

/**
 * 关键词与 traceId 的允许字符集。
 *
 * 采用白名单而非黑名单：日志关键词通常是字母、数字、点、下划线、连字符，
 * 偶尔包含冒号与斜杠（类名、路径片段）。
 * 明确不接受空白、引号、分号、管道、重定向、`$`、反引号与反斜杠。
 */
const TERM_PATTERN = /^[A-Za-z0-9_.:/@+-]{1,200}$/;

/**
 * 子目录只允许单层或两层普通目录名。
 *
 * WHY：字符类里包含 `.` 时，`../etc` 也能通过白名单。
 * 因此每个路径段单独限制：不能以 `.` 开头，杜绝 `.`、`..` 与隐藏目录。
 * 隐藏目录不在日志目录常规范围内，拒绝比放行更安全。
 */
const SEGMENT = '(?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63})';
const SUBDIR_PATTERN = new RegExp(`^${SEGMENT}(?:/${SEGMENT})?$`);

/** fileRef 由枚举结果生成，格式固定，模型不能自造路径。 */
const FILE_REF_PATTERN = /^f-\d{1,6}$/;

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryValidationError';
  }
}

/** 校验关键词列表：非空、数量与长度受限、字符白名单。 */
export function validateTerms(terms: readonly string[]): readonly string[] {
  if (terms.length === 0) {
    throw new QueryValidationError('至少需要一个搜索词');
  }
  if (terms.length > 4) {
    throw new QueryValidationError('一次最多四个搜索词');
  }
  for (const term of terms) {
    if (!TERM_PATTERN.test(term)) {
      throw new QueryValidationError(
        '搜索词只能包含字母、数字与 _ . : / @ + -，长度不超过 200',
      );
    }
  }
  return terms;
}

/** 校验子目录：不接受绝对路径、上跳与空段。 */
export function validateSubDir(subDir: string): string {
  if (subDir === '') {
    return '';
  }
  if (!SUBDIR_PATTERN.test(subDir)) {
    throw new QueryValidationError('子目录只能是 1–2 层普通目录名，且不含上跳');
  }
  return subDir;
}

/** 校验深度：固定范围，避免枚举整个目录树。 */
export function validateDepth(maxDepth: number): number {
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 3) {
    throw new QueryValidationError('枚举深度只能是 1 到 3');
  }
  return maxDepth;
}

/** 校验上下文行数：与 PRD 的 80 行初始上下文一致，可小幅调整。 */
export function validateContext(before: number, after: number): { before: number; after: number } {
  for (const [name, value] of [
    ['前置行数', before],
    ['后置行数', after],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 200) {
      throw new QueryValidationError(`${name}必须是 0 到 200 的整数`);
    }
  }
  return { before, after };
}

/** 校验 fileRef 格式；真实存在性由会话侧维护的枚举表确认。 */
export function validateFileRef(fileRef: string): string {
  if (!FILE_REF_PATTERN.test(fileRef)) {
    throw new QueryValidationError('文件编号格式不合法，只能使用枚举返回的编号');
  }
  return fileRef;
}

/** 校验行号区间：跨度上限与单次读取预算一致。 */
export function validateLineRange(startLine: number, endLine: number): { startLine: number; endLine: number } {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1) {
    throw new QueryValidationError('行号必须是正整数');
  }
  if (endLine < startLine) {
    throw new QueryValidationError('结束行不得早于起始行');
  }
  if (endLine - startLine + 1 > 2_000) {
    throw new QueryValidationError('单次读取不得超过 2000 行');
  }
  return { startLine, endLine };
}

/**
 * 渲染为要发送给远端的最小参数集合。
 *
 * 这里不生成 shell 文本：命令模板由 Expect 侧固定持有，
 * 本函数只输出经过校验的数据字段。
 */
export function toWirePayload(query: RemoteQuery): string {
  // 每个分支都先校验再序列化：校验必须与生成绑定，
  // 否则调用方一旦忘记单独校验，非法参数就会直接下发到远端。
  switch (query.kind) {
    case 'LIST': {
      const subDir = validateSubDir(query.subDir);
      const maxDepth = validateDepth(query.maxDepth);
      return JSON.stringify({ subDir, maxDepth });
    }
    case 'SEARCH': {
      const terms = validateTerms(query.terms);
      const { before, after } = validateContext(query.before, query.after);
      return JSON.stringify({ terms, before, after });
    }
    case 'READ': {
      const fileRef = validateFileRef(query.fileRef);
      const { startLine, endLine } = validateLineRange(query.startLine, query.endLine);
      return JSON.stringify({ fileRef, startLine, endLine });
    }
  }
}
