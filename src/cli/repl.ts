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
import {
  deriveEntryId,
  invalidateEntry,
  listEntries,
  renderEntryList,
  saveDraft,
  searchAndRender,
  type KnowledgeContext,
  type KnowledgeIo,
} from './knowledge-commands.js';
import { appendEvent, createSessionId } from '../storage/session.js';
import { parseUserInput } from './input.js';

/** 主循环依赖的外部能力；注入后便于测试。 */
export interface ReplOptions {
  readonly composition: Composition;
  /** 应用状态目录；用于写入脱敏会话事件。 */
  readonly stateDir?: string;
  /** 恢复的会话标识；存在时继续写入同一会话，而不是新建。 */
  readonly resumeSessionId?: string;
  /** 知识库上下文；缺失时 /knowledge 提示不可用。 */
  readonly knowledge?: KnowledgeContext;
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
  /knowledge       查看故障经验列表
  /knowledge search <词…>  按字面量检索已确认经验
  /knowledge save  把当前诊断结论存为经验（需确认）
  /knowledge invalidate <条目>  标记失效（需确认）
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

/**
 * 处理 /knowledge 子命令。
 *
 * 所有写操作都要求显式 approve；检索只读，不影响当前诊断结论。
 */
async function handleKnowledge(
  input: string,
  options: ReplOptions,
  write: (line: string) => void,
  writeError: (line: string) => void,
  lastDiagnosis: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  if (options.knowledge === undefined) {
    writeError('知识库不可用：缺少数据目录。');
    return;
  }
  const context = options.knowledge;
  // 复用主循环的 readline：不引入第二套输入通道，
  // 也保证确认动作确实来自用户，而不是被硬编码的结果。
  const io: KnowledgeIo = {
    out: write,
    text: (question) => ask(question),
    approve: async (question) => {
      const answer = await ask(`${question}\n输入 approve 确认，其他任何输入视为取消：`);
      return answer.trim() === 'approve';
    },
  };

  const [, subcommand, ...rest] = input.split(/\s+/);

  if (subcommand === undefined) {
    const metas = await listEntries(context);
    process.stdout.write(renderEntryList(metas));
    return;
  }

  if (subcommand === 'search') {
    if (rest.length === 0) {
      writeError('用法：/knowledge search <关键词…>');
      return;
    }
    process.stdout.write(await searchAndRender(context, rest));
    return;
  }

  if (subcommand === 'save') {
    // 多步命令必须一次性读完所需输入，或在开始前就拒绝。
    // 否则一旦中途返回，用户接下来输入的内容会被主循环当作诊断输入消费，
    // 造成命令与数据错位（真实测试中已复现）。
    if (lastDiagnosis.trim() === '') {
      writeError('当前还没有诊断结论可保存。请先完成一轮诊断。');
      return;
    }

    // 只保存用户能看到、已经脱敏的输出；不额外读取任何原始数据。
    const title = (await ask('条目标题（例如：订单计算空指针）')).trim();
    if (title === '') {
      writeError('标题不能为空，已取消。');
      return;
    }
    const errorSignature = (await ask('错误特征（例如：NullPointerException OrderService.calc）')).trim();
    const versionAnswer = (await ask('适用版本（可留空）')).trim();

    const result = await saveDraft(
      context,
      {
        title,
        errorSignature: errorSignature === '' ? title : errorSignature,
        body: lastDiagnosis,
        // 由用户明确确认根因是否已确认；否则只能存为草稿。
        rootCauseConfirmed: (await ask('根因是否已确认？输入 yes 确认，其他视为未确认')).trim() === 'yes',
        applicableVersion: versionAnswer === '' ? 'unknown' : versionAnswer,
      },
      io,
    );
    (result.ok ? write : writeError)(result.message);
    return;
  }

  if (subcommand === 'invalidate') {
    const entryId = rest[0];
    if (entryId === undefined) {
      writeError('用法：/knowledge invalidate <条目ID>');
      return;
    }
    const result = await invalidateEntry(context, deriveEntryId(entryId), io);
    (result.ok ? write : writeError)(result.message);
    return;
  }

  writeError('未知子命令。可用：search / invalidate');
}

/** 运行交互循环，直到用户退出或输入结束。 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const { composition, write, writeError } = options;
  const { diagnosis, runner } = composition;

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let closing = false;

  // 会话事件只写脱敏摘要；stateDir 缺失时静默跳过，不影响诊断。
  const sessionId = options.resumeSessionId ?? createSessionId();
  // 最近一次诊断的脱敏输出；/knowledge save 用它作为候选正文，
  // 不重新调用模型，也不读取未经脱敏的原始内容。
  let lastDiagnosis = '';
  let eventSeq = 0;
  const record = async (
    type: Parameters<typeof appendEvent>[2]['type'],
    payload: Record<string, string | number>,
  ): Promise<void> => {
    if (options.stateDir === undefined) {
      return;
    }
    eventSeq += 1;
    await appendEvent(options.stateDir, sessionId, {
      seq: eventSeq,
      at: new Date().toISOString(),
      type,
      payload,
    }).catch(() => undefined);
  };
  await record('session.start', { remote: options.remoteStatus });

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
    if (input.startsWith('/knowledge')) {
      // 关键：知识库的多步问答必须复用主循环的 rl，
      // 并在这里同步完成全部读取。若在外部另开读取通道，
      // 后续输入会被主循环当成诊断内容消费掉。
      const ask = (question: string): Promise<string> =>
        new Promise<string>((resolve) => {
          rl.question(`${question}\n> `, (answer) => resolve(answer));
        });
      await handleKnowledge(input, options, write, writeError, lastDiagnosis, ask);
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
    await record('input.received', {
      attachments: parsed.attachments.length,
      hasTrace: parsed.traceId === undefined ? 0 : 1,
    });
    try {
      lastDiagnosis = '';
      const result = await diagnosis.runTurn(runner, parsed.instruction, (text) => {
        lastDiagnosis += text;
        process.stdout.write(text);
      });
      process.stdout.write('\n');
      await record('diagnosis.completed', {
        evidenceCount: diagnosis.evidence.all().length,
        aborted: result.aborted ? 1 : 0,
      });

      const unknown = diagnosis.verifyCitations(result.text);
      if (unknown.length > 0) {
        writeError(`注意：回答引用了不存在的证据编号：${unknown.join(', ')}。请谨慎对待相关结论。`);
      }
      if (result.aborted) {
        writeError('本轮已中止。');
      }
    } catch (error) {
      writeError(`本轮失败：${error instanceof Error ? error.message : '未知错误'}`);
      await record('diagnosis.failed', { reason: 'turn error' });
    }

    write('');
    write(status());
  }

  await record('session.close', { events: eventSeq });
  if (!closing) {
    rl.close();
  }
  return 0;
}
