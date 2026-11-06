/**
 * 终端聊天界面。
 *
 * 形态（按用户要求）：
 *   ──────────────────────────────   ← 红色上边框
 *     （输入内容，无提示符）
 *   ──────────────────────────────   ← 红色下边框
 *     /model   查看或切换模型          ← 输入 / 时的命令提示
 *   [模型·思考级别 | 工作目录 | 分支 | 会话]
 *
 * 实现说明：
 * - 使用 raw 模式自行处理按键，才能做到"无提示符 + 下边框 + 状态行"。
 * - 只在 TTY 下启用；非 TTY 回退到普通 readline，保证管道与脚本可用。
 * - 输入过长时截断显示，避免换行破坏固定布局；实际内容完整保留。
 * - 粘贴的多行内容整体进入缓冲区，不会逐行触发提交。
 */

import { emitKeypressEvents } from 'node:readline';

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CLEAR_LINE = '\x1b[2K';

/** 斜杠命令提示项。 */
export interface CommandHint {
  readonly command: string;
  readonly description: string;
}

/** 一次渲染所需的全部信息。 */
export interface RenderState {
  /** 输入缓冲区（可含换行，来自粘贴）。 */
  readonly buffer: string;
  /** 上方提问行；普通输入时为空。 */
  readonly question?: string;
  /** 命令提示；为空时不显示。 */
  readonly hints: readonly CommandHint[];
  /** 当前选中的提示序号。 */
  readonly selected: number;
  /** 底部状态行。 */
  readonly status: string;
}

/** 读取结果：提交的文本，或用户取消。 */
export type ReadResult = { readonly kind: 'line'; readonly text: string } | { readonly kind: 'cancel' };

/**
 * 按显示宽度截断。
 *
 * WHY 必须截断：状态行含工作目录与分支，很容易超过终端宽度；
 * 一旦换行，光标位置计算就会错位，红框也会被撑破。
 */
function clip(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** 命令提示的最大条数，避免占满屏幕。 */
const MAX_HINTS = 8;

/**
 * 聊天界面。
 *
 * 负责渲染与按键处理；不持有业务状态，
 * 命令列表与状态行由调用方在每次读取时提供。
 */
export class ChatUI {
  private renderedLines = 0;
  private cursorRow = 0;
  private cursorCol = 0;

  constructor(
    private readonly output: NodeJS.WriteStream,
    private readonly input: NodeJS.ReadStream,
    private readonly commands: readonly CommandHint[],
  ) {}

  /** 是否为可交互终端；否时应回退到普通输入。 */
  static isSupported(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean {
    return input.isTTY === true && output.isTTY === true;
  }

  /**
   * 读取一行输入。
   *
   * question 用于多步命令（如保存经验时的追问），会显示在红色上边框之上。
   * status 在每次按键后重新求值，便于反映模型/思考等级的变化。
   */
  async readLine(options: {
    readonly question?: string;
    /** 传入当前终端宽度，便于状态行按可用空间自适应。 */
    readonly status: (width: number) => string;
  }): Promise<ReadResult> {
    return new Promise<ReadResult>((resolve) => {
      let buffer = '';
      let selected = 0;
      let hints: readonly CommandHint[] = [];
      let hintsVisible = false;
      let done = false;
      // bracketed paste 可能被拆成多个 keypress 事件，需要跨事件累积。
      let pasting = false;
      let pasteBuffer = '';

      // 宽度随终端自适应；resize 时重新求值并重绘。
      let width = measureWidth(this.output);
      const onResize = (): void => {
        width = measureWidth(this.output);
        render();
      };
      this.output.on('resize', onResize);

      const computeHints = (): readonly CommandHint[] => {
        if (!buffer.startsWith('/') || buffer.includes('\n')) {
          return [];
        }
        const typed = buffer.slice(1).split(/\s+/)[0] ?? '';
        return this.commands
          .filter((item) => item.command.slice(1).startsWith(typed))
          .slice(0, MAX_HINTS);
      };

      const render = (): void => {
        this.erase();
        const state: RenderState = {
          buffer,
          ...(options.question === undefined ? {} : { question: options.question }),
          hints: hintsVisible ? hints : [],
          selected,
          status: options.status(width),
        };
        this.draw(state, width);
      };

      const finish = (result: ReadResult): void => {
        if (done) {
          return;
        }
        done = true;
        this.output.write('\x1b[?2004l');
        this.output.off('resize', onResize);
        this.input.off('keypress', onKey);
        this.input.setRawMode(false);
        this.input.pause();
        this.erase();
        // 提交后把内容留在滚动历史里，便于回看。
        if (result.kind === 'line' && result.text !== '') {
          this.output.write(`${DIM}${result.text}${RESET}\n`);
        }
        resolve(result);
      };

      const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
        if (done) {
          return;
        }

        // 粘贴模式：整段累积，直到结束标记；不触发提交与命令提示。
        const sequence = key.sequence ?? text ?? '';
        if (pasting || sequence.includes('\x1b[200~')) {
          if (!pasting) {
            pasting = true;
            pasteBuffer = '';
          }
          const withoutStart = sequence.replace('\x1b[200~', '');
          const endIndex = withoutStart.indexOf('\x1b[201~');
          if (endIndex >= 0) {
            pasteBuffer += withoutStart.slice(0, endIndex);
            pasting = false;
            buffer += pasteBuffer.replace(/\r\n?/g, '\n');
            pasteBuffer = '';
            hintsVisible = false;
            hints = [];
            render();
            return;
          }
          pasteBuffer += withoutStart;
          return;
        }

        // Ctrl+C：取消当前输入；空缓冲时由调用方决定是否退出。
        if (key.ctrl === true && key.name === 'c') {
          finish({ kind: 'cancel' });
          return;
        }
        // Ctrl+D：空缓冲时视为结束输入。
        if (key.ctrl === true && key.name === 'd' && buffer === '') {
          finish({ kind: 'cancel' });
          return;
        }

        if (key.name === 'return' || key.name === 'enter') {
          finish({ kind: 'line', text: buffer });
          return;
        }

        if (key.name === 'backspace') {
          buffer = buffer.slice(0, -1);
          hints = computeHints();
          selected = 0;
          render();
          return;
        }

        if (key.name === 'escape') {
          hintsVisible = false;
          render();
          return;
        }

        if (key.name === 'up' || key.name === 'down') {
          if (hints.length > 0) {
            const delta = key.name === 'up' ? -1 : 1;
            selected = (selected + delta + hints.length) % hints.length;
            render();
          }
          return;
        }

        if (key.name === 'tab') {
          if (hints.length > 0) {
            const chosen = hints[selected] ?? hints[0];
            if (chosen !== undefined) {
              buffer = `${chosen.command} `;
              hints = computeHints();
              selected = 0;
              render();
            }
          }
          return;
        }

        if (text === undefined || text === '') {
          return;
        }

        // 粘贴的多行内容整体写入，避免把换行当成提交。
        if (text.includes('\n') || text.includes('\r')) {
          buffer += text.replace(/\r\n?/g, '\n');
          hintsVisible = false;
          hints = [];
          render();
          return;
        }

        // 过滤控制字符，避免终端转义序列进入输入。
        if (text >= ' ' || text === '\t') {
          buffer += text;
          hints = computeHints();
          hintsVisible = buffer.startsWith('/');
          selected = 0;
          render();
        }
      };

      // 必须先启用 keypress 事件：Node 默认不解析按键，
      // 只监听 'keypress' 而没调用此函数时，输入不会有任何反应。
      emitKeypressEvents(this.input);
      this.input.setRawMode(true);
      // 开启 bracketed paste：否则多行粘贴会被拆成多次回车，
      // 每一行都被当成一次提交，日志根本粘不进去。
      this.output.write('\x1b[?2004h');
      this.input.resume();
      this.input.on('keypress', onKey);
      hints = computeHints();
      render();
    });
  }

  /** 打印普通文本；用于诊断输出与提示。 */
  print(text: string): void {
    // 先清掉界面，避免输出插入到输入框中间。
    this.erase();
    this.output.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** 清除当前渲染块，恢复到干净行首。 */
  erase(): void {
    if (this.renderedLines === 0) {
      return;
    }
    // 回到块首
    if (this.cursorRow > 0) {
      this.output.write(`\x1b[${this.cursorRow}A`);
    }
    this.output.write('\r');
    for (let index = 0; index < this.renderedLines; index += 1) {
      this.output.write(`${CLEAR_LINE}\n`);
    }
    this.output.write(`\x1b[${this.renderedLines}A`);
    this.output.write('\r');
    this.renderedLines = 0;
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  /** 绘制一个完整块，并把光标放回输入行。 */
  private draw(state: RenderState, width: number): void {
    const line = `${RED}${'─'.repeat(width)}${RESET}`;
    const lines: string[] = [];

    if (state.question !== undefined) {
      lines.push(`${DIM}${state.question}${RESET}`);
    }

    const inputIndex = lines.length + 1;
    lines.push(line);

    // 输入区最多 3 行；超出时纵向滚动并显示滚动条。
    // 粘贴内容（含换行）只显示摘要，避免撑破布局。
    const input = layoutInput(state.buffer, width);
    const inputRows: number[] = [];
    for (let index = 0; index < input.rows.length; index += 1) {
      inputRows.push(lines.length);
      lines.push(renderInputRow(input, index, width));
    }

    lines.push(line);

    for (let index = 0; index < state.hints.length; index += 1) {
      const hint = state.hints[index];
      if (hint === undefined) {
        continue;
      }
      const marker = index === state.selected ? `${RED}›${RESET}` : ' ';
      const padded = hint.command.padEnd(12);
      const style = index === state.selected ? '' : DIM;
      const text = clip(`${padded}${hint.description}`, width - 4);
      lines.push(`  ${marker} ${style}${text}${RESET}`);
    }

    // 状态行可能有两行（信息行 + 预算行），逐行截断后保留。
    for (const statusLine of state.status.split('\n')) {
      lines.push(`${DIM}${clip(statusLine, width)}${RESET}`);
    }

    this.output.write(lines.join('\n'));
    this.renderedLines = lines.length;
    // 光标定位到输入区的最后一行（编辑点始终在末尾）。
    const cursorLine = inputRows[input.cursorRow] ?? inputIndex;
    this.cursorRow = lines.length - 1 - cursorLine;
    this.cursorCol = 2 + input.cursorCol;

    // 光标移到输入行对应位置
    if (this.cursorRow > 0) {
      this.output.write(`\x1b[${this.cursorRow}A`);
    }
    this.output.write('\r');
    if (this.cursorCol > 0) {
      this.output.write(`\x1b[${this.cursorCol}C`);
    }
  }
}

/** 输入区最多显示的行数。 */
const VISIBLE_INPUT_ROWS = 3;

/** 测量终端宽度：columns 在部分 pty 下返回 0，需依次回退。 */
function measureWidth(output: NodeJS.WriteStream): number {
  const detected = output.columns;
  const fallback = Number(process.env['COLUMNS'] ?? 0);
  return Math.max(40, detected > 0 ? detected : fallback > 0 ? fallback : 80);
}

/** 单个字符的终端显示宽度；CJK 与全角符号占两列。 */
function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f)
  ) {
    return 2;
  }
  return 1;
}

/** 字符串的终端显示宽度。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

/**
 * 按显示宽度换行。
 *
 * WHY 不横向滚动：横向滚动会隐藏开头内容，而日志片段的开头往往是
 * 时间戳与 traceId，恰恰是最需要看到的部分。
 */
function wrapByWidth(text: string, width: number): string[] {
  if (text === '') {
    return [''];
  }
  const rows: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const char of text) {
    const size = charWidth(char);
    if (currentWidth + size > width) {
      rows.push(current);
      current = char;
      currentWidth = size;
      continue;
    }
    current += char;
    currentWidth += size;
  }
  rows.push(current);
  return rows;
}

interface InputLayout {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorCol: number;
  /** 超出可视行数时的滚动信息。 */
  readonly scroll?: { readonly total: number; readonly start: number };
}

/**
 * 计算输入区的显示行与光标位置。
 *
 * 规则：
 * - 含换行的内容（粘贴）显示为摘要，不展开；
 * - 单行内容按宽度自动换行，最多显示 3 行；
 * - 超出 3 行时显示最后 3 行，并在右侧画滚动条。
 */
function layoutInput(buffer: string, width: number): InputLayout {
  if (buffer.includes('\n')) {
    const lines = buffer.split('\n').length;
    const summary = `[已粘贴 ${lines} 行，${buffer.length} 字符]`;
    const text = clip(summary, width - 2);
    return { rows: [text], cursorRow: 0, cursorCol: displayWidth(text) };
  }

  // 预留 1 列给滚动条，避免内容与滚动条重叠。
  const contentWidth = Math.max(10, width - 3);
  const wrapped = wrapByWidth(buffer, contentWidth);

  if (wrapped.length <= VISIBLE_INPUT_ROWS) {
    const last = wrapped[wrapped.length - 1] ?? '';
    return {
      rows: wrapped,
      cursorRow: wrapped.length - 1,
      cursorCol: displayWidth(last),
    };
  }

  const start = wrapped.length - VISIBLE_INPUT_ROWS;
  const rows = wrapped.slice(start);
  const last = rows[rows.length - 1] ?? '';
  return {
    rows,
    cursorRow: rows.length - 1,
    cursorCol: displayWidth(last),
    scroll: { total: wrapped.length, start },
  };
}

/** 渲染单行输入，必要时在右侧追加滚动条。 */
function renderInputRow(input: InputLayout, index: number, width: number): string {
  const content = input.rows[index] ?? '';
  if (input.scroll === undefined) {
    return `  ${content}`;
  }

  const padWidth = Math.max(0, width - 2 - displayWidth(content));
  const track = `${DIM}│${RESET}`;
  const thumb = `${RED}█${RESET}`;

  // 拇指位置按滚动比例映射到 3 行内。
  const maxStart = Math.max(1, input.scroll.total - input.rows.length);
  const thumbRow = Math.min(
    input.rows.length - 1,
    Math.round((input.scroll.start / maxStart) * (input.rows.length - 1)),
  );

  return `  ${content}${' '.repeat(padWidth)}${index === thumbRow ? thumb : track}`;
}
