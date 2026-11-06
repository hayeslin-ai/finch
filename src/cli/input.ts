/**
 * 用户输入解析。
 *
 * 三个入口必须以“来源独立”的形式进入诊断流程（PRD FR-01）：
 * - 粘贴的日志正文
 * - 显式 `@文件` 引用
 * - `/trace` 的 traceId 与目标机
 *
 * 安全要点：
 * - 只有用户指令区里的 `@` 才算附件授权；日志正文里的 `@` 是数据。
 * - 代码块（三反引号围栏）内的 `@` 不解析，避免粘贴日志被误读成文件授权。
 * - traceId 原文只放进本地句柄，不进入模型上下文。
 */
import path from 'node:path';

/** 一次用户输入的解析结果。 */
export interface ParsedInput {
  /** 去掉附件标记后的指令文本。 */
  readonly instruction: string;
  /** 用户显式授权的本地文件（展开 ~ 后的绝对路径）。 */
  readonly attachments: readonly string[];
  /** 显式输入的 traceId；仅本地使用。 */
  readonly traceId?: string;
  /** 可选发生时间，原样保留由调用方解析。 */
  readonly since?: string;
  /** 可选目标机，需另行校验网段。 */
  readonly targetHost?: string;
}

/** 附件引用：`@路径`，路径可带引号以支持空格。 */
const ATTACHMENT_PATTERN = /(^|\s)@(?:"([^"]+)"|(\S+))/g;

/** `/trace <id>` 前缀；兼容 `/trace <id> --host ...` 这类带参数的写法。 */
const TRACE_HEAD = /^\/trace(?:\s+(\S+))?/;

/** 展开 `~` 为当前用户 home；不展开环境变量，避免隐式读取。 */
function expandHome(target: string, home: string): string {
  if (target === '~') {
    return home;
  }
  if (target.startsWith('~/')) {
    return path.join(home, target.slice(2));
  }
  return target;
}

/** 把代码块内容替换为等长占位，保持索引不变，避免在围栏内误解析附件。 */
function maskCodeBlocks(text: string): string {
  const lines = text.split('\n');
  let inside = false;
  const masked = lines.map((line) => {
    if (line.trimStart().startsWith('```')) {
      inside = !inside;
      return ' '.repeat(line.length);
    }
    return inside ? ' '.repeat(line.length) : line;
  });
  return masked.join('\n');
}

/**
 * 解析 `/trace` 指令。
 * 参数只接受 `--host` 与 `--since`；未知参数直接拒绝，
 * 避免用户以为某个未实现的选项生效了。
 */
/**
 * 解析 `/trace` 指令。
 *
 * 逐 token 解析而不是一条大正则：`--since` 的值可能含空格（带引号的时间），
 * 用正则分组很容易把后续选项吞进上一个值里。
 * 未知参数直接拒绝，避免用户以为未实现的选项生效了。
 */
export function parseTraceCommand(text: string): ParsedInput | { error: string } {
  const trimmed = text.trim();
  const head = TRACE_HEAD.exec(trimmed);
  if (head === null || head[1] === undefined) {
    return { error: '用法：/trace <traceId> [--host <target>] [--since <time>]' };
  }

  const traceId = head[1];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(traceId)) {
    return { error: 'traceId 只能包含字母、数字、下划线与连字符' };
  }

  // 取 `/trace <id>` 之后的剩余文本，按空白切分。
  const rest = trimmed.slice(head[0].length).trim();
  const options: Record<string, string> = {};
  if (rest !== '') {
    const tokens = rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      if (token !== '--host' && token !== '--since') {
        return { error: `未知参数：${token}` };
      }
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${token} 缺少取值` };
      }
      options[token.slice(2)] = value;
      index += 1;
    }
  }

  return {
    instruction: '/trace',
    attachments: [],
    traceId,
    ...(options['since'] === undefined ? {} : { since: options['since'] }),
    ...(options['host'] === undefined ? {} : { targetHost: options['host'] }),
  };
}

/**
 * 解析普通输入。
 *
 * 附件引用从指令文本中移除，只剩真正的自然语言说明；
 * 这样模型不会看到本地路径，也避免把路径当成指令的一部分。
 */
export function parseUserInput(text: string, home: string): ParsedInput {
  const trimmed = text.trim();
  if (trimmed.startsWith('/trace')) {
    const parsed = parseTraceCommand(trimmed);
    if ('error' in parsed) {
      throw new Error(parsed.error);
    }
    return parsed;
  }

  const masked = maskCodeBlocks(text);
  const attachments: string[] = [];
  const ranges: Array<{ start: number; end: number }> = [];

  for (const match of masked.matchAll(ATTACHMENT_PATTERN)) {
    const quoted = match[2];
    const bare = match[3];
    const value = quoted ?? bare ?? '';
    if (value === '') {
      continue;
    }
    attachments.push(expandHome(value, home));

    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    ranges.push({ start, end: start + 1 + (quoted === undefined ? value.length : value.length + 2) });
  }

  // 从后往前删除，避免前面的删除影响后面的索引。
  let instruction = text;
  for (const range of ranges.sort((a, b) => b.start - a.start)) {
    instruction = instruction.slice(0, range.start) + instruction.slice(range.end);
  }

  return {
    instruction: instruction.replace(/[ \t]{2,}/g, ' ').trim(),
    attachments: [...new Set(attachments)],
  };
}
