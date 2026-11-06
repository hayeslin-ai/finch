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
    readonly status: () => string;
  }): Promise<ReadResult> {
    return new Promise<ReadResult>((resolve) => {
      let buffer = '';
      let selected = 0;
      let hints: readonly CommandHint[] = [];
      let hintsVisible = false;
      let done = false;

      // columns 在某些 pty 下返回 0 而非 undefined，
      // 因此必须显式判断 > 0，再依次回退到环境变量与 80。
      const detected = this.output.columns;
      const fallback = Number(process.env['COLUMNS'] ?? 0);
      const width = Math.max(40, detected > 0 ? detected : fallback > 0 ? fallback : 80);

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
          status: options.status(),
        };
        this.draw(state, width);
      };

      const finish = (result: ReadResult): void => {
        if (done) {
          return;
        }
        done = true;
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

    // 输入内容：多行粘贴时只显示摘要，保持布局稳定。
    const display = summarizeBuffer(state.buffer, width - 4);
    lines.push(`  ${display.text}`);

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
    this.cursorRow = lines.length - 1 - inputIndex;
    this.cursorCol = 2 + display.cursor;

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

/**
 * 生成输入行的显示文本与光标位置。
 *
 * 多行内容（粘贴日志）只显示行数与末尾片段，
 * 否则固定布局会被撑破，红色边框也会错位。
 */
function summarizeBuffer(buffer: string, maxWidth: number): { text: string; cursor: number } {
  const singleLine = buffer.replace(/\n/g, '⏎');
  const lines = buffer.split('\n').length;

  if (lines > 1) {
    const preview = `[已粘贴 ${lines} 行，${buffer.length} 字符]`;
    return { text: preview, cursor: preview.length };
  }

  if (singleLine.length <= maxWidth) {
    return { text: singleLine, cursor: singleLine.length };
  }

  // 超长时保留末尾，光标始终在最后。
  const tail = singleLine.slice(-maxWidth);
  return { text: `…${tail.slice(1)}`, cursor: Math.min(maxWidth, tail.length) };
}
