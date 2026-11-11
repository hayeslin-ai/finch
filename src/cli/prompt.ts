/**
 * 交互式输入。
 *
 * WHY：配置向导要输入密码、MFA 秘钥与 API Key。
 * 三个错误做法都会泄漏凭证：
 * 1. 把值放进命令行参数——会出现在进程列表与 shell 历史里。
 * 2. 把值写进 readline 历史——后续上下键就能翻出来。
 * 3. 回显到终端——会被录屏、截图、终端日志带走。
 * 因此敏感输入必须走关闭回显的专用通道，且不进入任何历史。
 */
import { stdin, stdout } from 'node:process';

/** 输入被取消（Ctrl+C 或流结束）。 */
export class PromptCancelledError extends Error {
  constructor() {
    super('输入已取消');
    this.name = 'PromptCancelledError';
  }
}

/**
 * 要求当前进程处于交互式终端。
 *
 * WHY：非 TTY 下无法安全地关闭回显，也无法保证输入来自人类。
 * 若允许管道输入，脚本就能在用户不知情时写入凭证。
 */
export function assertInteractiveTty(): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('配置向导只能在交互式终端中运行；不支持管道或重定向输入');
  }
}

/** 读取单行普通文本；空输入返回空串，由调用方决定是否必填。 */
export async function askText(question: string): Promise<string> {
  return readLine(`${question}：`, { hidden: false });
}

/**
 * 读取敏感值，不回显、不进入历史。
 *
 * WHY：直接操作 raw 模式而不是引入第三方提示库，
 * 保持零新增依赖，也能精确控制回显与换行行为。
 */
export async function askSecret(question: string): Promise<string> {
  return readLine(`${question}（输入不显示）：`, { hidden: true });
}

/** 读取确认，只有明确输入 approve 才算通过；其余一律视为拒绝。 */
export async function askApproval(question: string): Promise<boolean> {
  const answer = await readLine(`${question}\n输入 approve 确认：`, { hidden: false });
  return answer.trim() === 'approve';
}

/**
 * 读取 y/N 确认。
 *
 * WHY 不用 askApproval：升级可回滚且需要重跑一次命令，
 * 强制输入 approve 会把人逼成背参数，反而降低注意力。
 * 仍然要求显式 y：空输入、直接回车与其它字符一律视为拒绝。
 */
export async function askYesNo(question: string): Promise<boolean> {
  const answer = await readLine(`${question} [y/N]：`, { hidden: false });
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * 关闭回显地读取一行。
 *
 * 只处理回车、退格与 Ctrl+C，不实现方向键与编辑历史：
 * 敏感输入本来就不应该有可翻阅的历史。
 */
function readLine(promptText: string, options: { readonly hidden: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(promptText);

    const wasRaw = stdin.isRaw;
    if (options.hidden) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    let value = '';

    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.pause();
      if (options.hidden) {
        stdin.setRawMode(wasRaw);
        stdout.write('\n');
      }
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');

      // Ctrl+C 统一视为取消，不把半截输入交给调用方。
      if (text.includes('\u0003')) {
        cleanup();
        reject(new PromptCancelledError());
        return;
      }

      for (const char of text) {
        if (char === '\r' || char === '\n') {
          cleanup();
          if (!options.hidden) {
            stdout.write('\n');
          }
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          // 退格：仅在非回显模式下需要手动擦除；隐藏模式本就不显示内容。
          value = value.slice(0, -1);
          continue;
        }
        // 丢弃其他控制字符，避免把终端的控制序列写进配置。
        if (char >= ' ' || char === '\t') {
          value += char;
        }
      }
    };

    stdin.on('data', onData);
  });
}
