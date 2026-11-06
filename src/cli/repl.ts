/**
 * 交互式诊断主循环。
 *
 * 形态按 PRD 5.1.1 定稿：行式 CLI + 一行状态行，不做全屏 TUI。
 *
 * 关键行为：
 * - 状态行常驻显示远程能力、预算、查询与文件计数，不含 traceId、密钥与日志内容。
 * - 预算在等待用户输入时暂停，只有模型与工具执行计时。
 * - 模型输出在展示前脱敏；引用不存在的证据编号会被指出。
 * - `/audit` 展示最近 10 条操作摘要，不导出。
 */
import { createInterface } from 'node:readline';

import type { Composition } from '../app/composition.js';
import { parseUserInput } from './input.js';

/** 主循环依赖的外部能力；注入后便于测试。 */
export interface ReplOptions {
  readonly composition: Composition;
  /** 远程能力状态；P3 阶段只有本地诊断，固定为不可用。 */
  readonly remoteStatus: string;
  /** 输出函数；测试可捕获。 */
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

const HELP = `可用命令：
  /paste … /end    多行粘贴日志
  @路径            显式授权本地日志文件
  /audit           查看最近 10 条操作
  /status          查看当前预算与证据数量
  /new             开始新的诊断（清空证据）
  /help            显示本帮助
  /exit            退出`;

/**
 * 渲染状态行。
 *
 * 只放非敏感摘要；预算按分:秒显示，便于快速判断还剩多少时间。
 */
export function renderStatusLine(input: {
  readonly remoteStatus: string;
  readonly remainingMs: number;
  readonly totalMs: number;
  readonly evidenceCount: number;
}): string {
  const seconds = Math.max(0, Math.floor(input.remainingMs / 1000));
  const total = Math.max(0, Math.floor(input.totalMs / 1000));
  const budget = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}/${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  return `REMOTE ${input.remoteStatus} │ budget ${budget} │ evidence ${input.evidenceCount}`;
}

/** 运行交互循环，直到用户退出或输入结束。 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const { composition, write, writeError } = options;
  const { diagnosis, runner } = composition;

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let closing = false;

  const status = (): string =>
    renderStatusLine({
      remoteStatus: options.remoteStatus,
      remainingMs: diagnosis.budget.remainingMs(),
      totalMs: diagnosis.budget.snapshot().totalMs,
      evidenceCount: diagnosis.evidence.all().length,
    });

  write(status());
  write('输入 /help 查看命令。粘贴日志后回车即可开始诊断。');

  diagnosis.budget.start();
  diagnosis.budget.pause();

  for (;;) {
    const line = await new Promise<string | undefined>((resolve) => {
      rl.question('> ', (answer) => resolve(answer));
      rl.once('close', () => resolve(undefined));
    });

    if (line === undefined) {
      break;
    }

    const input = line.trim();
    if (input === '') {
      continue;
    }
    if (input === '/exit' || input === '/quit') {
      break;
    }
    if (input === '/help') {
      write(HELP);
      continue;
    }
    if (input === '/status') {
      write(status());
      continue;
    }
    if (input === '/audit') {
      process.stdout.write(diagnosis.audit.render(10));
      continue;
    }
    if (input === '/new') {
      diagnosis.evidence.clear();
      write('已清空证据。注意：这是新的诊断，历史上下文不会被复用。');
      continue;
    }
    if (input.startsWith('/trace')) {
      // P3 阶段未接入远程查询，明确告知而不是假装执行。
      writeError('远程 traceId 查询尚未实现。当前可用：粘贴日志与 @本地文件。');
      continue;
    }

    let parsed;
    try {
      parsed = parseUserInput(input, process.env['HOME'] ?? '');
    } catch (error) {
      writeError(error instanceof Error ? error.message : '输入解析失败');
      continue;
    }

    if (parsed.attachments.length > 0) {
      write(
        `已识别 ${parsed.attachments.length} 个附件引用，但当前阶段尚未接入附件读取。` +
          '请改用粘贴方式提供日志。',
      );
      continue;
    }

    if (!diagnosis.budget.canStartWork()) {
      writeError('探查预算已用尽。请使用 /new 开始新诊断，或重启 CLI 获得新预算。');
      continue;
    }

    write('');
    closing = false;
    try {
      const result = await diagnosis.runTurn(runner, parsed.instruction, (text) => {
        process.stdout.write(text);
      });
      process.stdout.write('\n');

      const unknown = diagnosis.verifyCitations(result.text);
      if (unknown.length > 0) {
        writeError(`注意：回答引用了不存在的证据编号：${unknown.join(', ')}。请谨慎对待相关结论。`);
      }
      if (result.aborted) {
        writeError('本轮已中止。');
      }
    } catch (error) {
      writeError(`本轮失败：${error instanceof Error ? error.message : '未知错误'}`);
    }

    write('');
    write(status());
  }

  if (!closing) {
    rl.close();
  }
  return 0;
}
