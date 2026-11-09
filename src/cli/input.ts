/**
 * 用户输入解析。
 *
 * 两个入口必须以“来源独立”的形式进入诊断流程（PRD FR-01）：
 * - 粘贴的日志正文
 * - 显式 `@文件` 引用
 *
 * 远程入口 `/remote` 由命令处理器解析，不走这里：
 * 它是斜杠命令，且在模型轮次开始前就已完成目标校验与登记。
 *
 * 安全要点：
 * - 只有用户指令区里的 `@` 才算附件授权；日志正文里的 `@` 是数据。
 * - 代码块（三反引号围栏）内的 `@` 不解析，避免粘贴日志被误读成文件授权。
 */
import path from 'node:path';

/** 一次用户输入的解析结果。 */
export interface ParsedInput {
  /** 去掉附件标记后的指令文本。 */
  readonly instruction: string;
  /** 用户显式授权的本地文件（展开 ~ 后的绝对路径）。 */
  readonly attachments: readonly string[];
}

/** 附件引用：`@路径`，路径可带引号以支持空格。 */
const ATTACHMENT_PATTERN = /(^|\s)@(?:"([^"]+)"|(\S+))/g;

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
 * 解析普通输入。
 *
 * 附件引用从指令文本中移除，只剩真正的自然语言说明；
 * 这样模型不会看到本地路径，也避免把路径当成指令的一部分。
 */
export function parseUserInput(text: string, home: string): ParsedInput {
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
