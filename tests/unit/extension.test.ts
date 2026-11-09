/**
 * 扩展钩子测试（离线）。
 *
 * WHY：预算、附件授权、入口脱敏与会话记录都由扩展钩子驱动，
 * 而这些钩子一旦漏接，在类型检查与界面表现上都看不出来：
 * - 漏掉预算钩子 → 预算永不计时，四个工具的 canWork 守卫全部失效；
 * - 漏掉输入钩子 → @文件 只是普通字符串，本地日志工具不可达；
 * - 漏掉脱敏 → 粘贴的日志带着明文凭证进入模型上下文；
 * - 漏掉记录钩子 → -c / -r / --sessions 永远是空的。
 *
 * 这里用假的 ExtensionAPI 捕获注册的处理器，不启动任何 SDK 运行时；
 * 只对会话记录真的落盘（写临时目录），因为「文件里到底有没有事件」正是要验证的点。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildTraceKickoff, createDiagnosisExtension } from '../../src/agent/extension.js';
import type { AppPaths } from '../../src/config/paths.js';
import { AuditLedger } from '../../src/core/audit.js';
import { BudgetController } from '../../src/core/budget.js';
import { EvidenceStore } from '../../src/core/evidence.js';
import { AttachmentRegistry } from '../../src/logs/attachments.js';
import { Redactor } from '../../src/security/redactor.js';
import { loadSession } from '../../src/storage/session.js';
import { SessionRecorder } from '../../src/storage/recorder.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 捕获式假扩展 API：只记录注册内容，不执行。 */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  /** 由 pi.sendUserMessage 发出的消息；/trace 授权后应主动驱动一轮。 */
  const sentMessages: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  /** 会话记录内容；由用例按需替换，模拟模型回复。 */
  let entries: unknown[] = [];
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(content: string) {
      sentMessages.push(content);
    },
  };
  return {
    api,
    notifications,
    sentMessages,
    commands,
    setAssistantReply(text: string) {
      entries = [{ type: 'message', message: { role: 'assistant', content: text } }];
    },
    /** 触发某个事件的全部处理器，返回最后一个非空结果。 */
    async emit(event: string, payload: unknown = {}): Promise<unknown> {
      let result: unknown;
      const ctx = {
        ui: {
          notify: (line: string) => notifications.push(line),
          input: async () => undefined,
          confirm: async () => false,
        },
        // 只需要 getEntries：引用校验与 /knowledge save 都从会话记录取最近回复。
        sessionManager: { getEntries: () => entries },
      };
      for (const handler of handlers.get(event) ?? []) {
        const value = await handler(payload, ctx);
        if (value !== undefined) {
          result = value;
        }
      }
      return result;
    },
    has: (event: string) => handlers.has(event),
  };
}

/** 构造扩展 + 可控时钟 + 临时目录。 */
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-extension-'));
  const paths: AppPaths = {
    configDir: path.join(home, 'config'),
    envFile: path.join(home, 'config', '.env'),
    modelsFile: path.join(home, 'config', 'models.json'),
    redactionRulesFile: path.join(home, 'config', 'redaction.json'),
    loginScriptFile: path.join(home, 'config', 'login_agent.exp'),
    stateDir: path.join(home, 'state'),
    dataDir: path.join(home, 'data'),
  };

  let current = 0;
  const clock = {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };

  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });
  const evidence = new EvidenceStore();
  const redactor = new Redactor();
  const attachments = new AttachmentRegistry();
  const recorder = new SessionRecorder(paths.stateDir, 'test-session-0001');
  const audit = new AuditLedger();
  const pi = fakePi();

  const extension = createDiagnosisExtension({
    paths,
    knowledge: { dataDir: paths.dataDir, scopeId: 'demo' },
    budget,
    evidence,
    redactor,
    attachments,
    recorder,
    serviceId: 'demo',
    modelLabel: 'gateway/demo-model',
    audit,
  });
  extension(pi.api as never);

  return {
    budget,
    clock,
    pi,
    paths,
    redactor,
    attachments,
    recorder,
    evidence,
    audit,
    // 先等排队事件落盘再删目录：否则 appendFile 与 rm -rf 并发，
    // 会随机出现 ENOTEMPTY，把无关用例变成偶发失败。
    cleanup: async () => {
      await recorder.flush();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('/trace 注册为命令，授权后的驱动消息包含排查步骤与证据要求', async () => {
  const { pi, cleanup } = await setup();
  try {
    // 命令必须注册：否则用户输入 /trace 只会被当成普通文本发给模型。
    assert.ok(pi.commands.has('trace'), '/trace 必须注册为命令');

    const kickoff = buildTraceKickoff({ target: '22.50.14.22', traceId: 'abc123def456' });
    assert.match(kickoff, /22\.50\.14\.22/);
    assert.match(kickoff, /abc123def456/);
    assert.match(kickoff, /remote_log_list/);
    assert.match(kickoff, /remote_log_search/);
    assert.match(kickoff, /remote_log_read/);
    assert.match(kickoff, /完整记录/, '必须要求读整条记录，不能只看命中行');
    assert.match(kickoff, /EV-/, '必须要求引用证据编号');
    assert.match(kickoff, /截断/, '必须要求如实说明截断');
    assert.match(kickoff, /\/trace close/);
    // 工具出现顺序即是排查顺序，顺序错了会让模型先读后搜。
    assert.ok(
      kickoff.indexOf('remote_log_list') < kickoff.indexOf('remote_log_search') &&
        kickoff.indexOf('remote_log_search') < kickoff.indexOf('remote_log_read'),
      'kickoff 必须按 枚举 → 搜索 → 读取 排序',
    );
  } finally {
    await cleanup();
  }
});

test('Agent 循环起止驱动预算计时，等待用户的时间不计入', async () => {
  const { budget, clock, pi, cleanup } = await setup();
  try {
    assert.ok(pi.has('agent_start'), '必须注册 agent_start：否则预算永不计时');
    assert.ok(pi.has('agent_settled'), '必须注册 agent_settled：否则等待时间会吃掉额度');

    await pi.emit('agent_start');
    clock.advance(30_000);
    await pi.emit('agent_settled');
    assert.equal(budget.snapshot().phase, 'paused');
    assert.equal(budget.snapshot().remainingMs, 270_000, '执行期间必须消耗额度');

    // 用户思考十分钟后再提交：不得继续扣减。
    clock.advance(600_000);
    assert.equal(budget.snapshot().remainingMs, 270_000, '等待用户输入不得消耗额度');

    await pi.emit('agent_start');
    clock.advance(10_000);
    await pi.emit('agent_settled');
    assert.equal(budget.snapshot().remainingMs, 260_000);
  } finally {
    await cleanup();
  }
});

test('预算到期后四个工具的守卫会真正拒绝开工', async () => {
  const { budget, clock, pi, cleanup } = await setup();
  try {
    await pi.emit('agent_start');
    clock.advance(300_000);

    assert.equal(budget.canStartWork(), false, '到期必须拒绝新探查');
    await pi.emit('agent_settled');
    assert.equal(budget.canStartWork(), false, '暂停态到期同样拒绝');
  } finally {
    await cleanup();
  }
});

test('用户中止后钩子不得复活预算', async () => {
  const { budget, clock, pi, cleanup } = await setup();
  try {
    await pi.emit('agent_start');
    clock.advance(120_000);
    budget.cancel();

    await pi.emit('agent_settled');
    await pi.emit('agent_start');

    assert.equal(budget.canStartWork(), false, '取消是终态，不得被后续钩子复活');
    assert.equal(budget.snapshot().phase, 'cancelled');
  } finally {
    await cleanup();
  }
});

test('本地 Shell 拦截钩子始终注册', async () => {
  const { pi, cleanup } = await setup();
  try {
    assert.ok(pi.has('user_bash'), '! / !! 必须被扩展挡住');
  } finally {
    await cleanup();
  }
});

test('@文件 被登记为附件编号，路径不进入模型文本', async () => {
  const { pi, attachments, cleanup } = await setup();
  try {
    const home = await mkdtemp(path.join(tmpdir(), 'finch-attach-'));
    const logFile = path.join(home, 'server.log');
    await writeFile(logFile, 'ERROR boom\n');

    try {
      const result = (await pi.emit('input', { text: `帮我看看 @${logFile} 里的报错` })) as {
        action: string;
        text: string;
      };

      assert.equal(result.action, 'transform', '必须改写过模型看到的文本');
      assert.equal(attachments.size, 1, '@文件 必须被登记，否则本地日志工具不可达');
      assert.ok(!result.text.includes(logFile), '本地路径不得进入模型上下文');
      assert.match(result.text, /att-1/, '必须把附件编号告知模型');
      assert.match(result.text, /server\.log/, '至少要给出文件名，模型才能选对附件');
      assert.ok(result.text.includes('帮我看看'), '自然语言指令必须保留');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } finally {
    await cleanup();
  }
});

test('输入在进入模型前被脱敏，且与会话脱敏器共用占位符', async () => {
  const { pi, cleanup } = await setup();
  try {
    const result = (await pi.emit('input', {
      text: '连接日志：password=hunter2 然后 Authorization: Bearer abcdefghijklmnop',
    })) as { action: string; text: string };

    assert.equal(result.action, 'transform');
    assert.ok(!result.text.includes('hunter2'), '明文凭证不得进入模型上下文');
    assert.ok(!result.text.includes('abcdefghijklmnop'), '令牌同样必须脱敏');
  } finally {
    await cleanup();
  }
});

test('斜杠命令不参与附件解析与脱敏', async () => {
  const { pi, cleanup } = await setup();
  try {
    const result = await pi.emit('input', { text: '/knowledge search 空指针' });
    assert.equal(result, undefined, '命令文本应原样交给命令处理器');
  } finally {
    await cleanup();
  }
});

test('附件不可读时提示但不阻断本轮输入', async () => {
  const { pi, attachments, cleanup } = await setup();
  try {
    const result = (await pi.emit('input', { text: '看看 @/definitely/not/here.log' })) as {
      action: string;
      text: string;
    };

    assert.equal(result.action, 'transform', '单个附件失败不得丢弃整轮输入');
    assert.equal(attachments.size, 0);
    assert.ok(
      pi.notifications.some((line) => line.includes('附件未授权')),
      '必须明确告知哪个附件没被授权',
    );
  } finally {
    await cleanup();
  }
});

test('会话事件真的落盘，-c / --sessions 才有内容可读', async () => {
  const { pi, paths, recorder, evidence, cleanup } = await setup();
  try {
    await pi.emit('session_start');
    await pi.emit('input', { text: '日志：ERROR boom' });
    evidence.add({ sourceKind: 'paste', sourceLabel: '粘贴', text: 'ERROR boom' });
    await pi.emit('agent_start');
    await pi.emit('agent_settled', { aborted: false });
    await recorder.flush();

    const snapshot = await loadSession(paths.stateDir, recorder.sessionId);
    assert.ok(!('error' in snapshot), '会话必须可读回');

    const types = snapshot.events.map((event) => event.type);
    assert.ok(types.includes('input.received'), '输入事件必须记录');
    assert.ok(types.includes('session.start'), '会话开始事件必须记录');
    assert.ok(types.includes('evidence.collected'), '证据事件必须记录，摘要里的条数才准确');
    assert.ok(types.includes('diagnosis.completed'), '轮次完成事件必须记录');

    // 会话记录里不得出现证据正文。
    const rendered = JSON.stringify(snapshot.events);
    assert.ok(!rendered.includes('ERROR boom'), '会话记录只记编号与类别，不记正文');
  } finally {
    await cleanup();
  }
});

test('用户中止的轮次记录为失败，不伪装成完成', async () => {
  const { pi, paths, recorder, cleanup } = await setup();
  try {
    await pi.emit('agent_start');
    await pi.emit('agent_settled', { aborted: true });
    await recorder.flush();

    const snapshot = await loadSession(paths.stateDir, recorder.sessionId);
    assert.ok(!('error' in snapshot));
    const types = snapshot.events.map((event) => event.type);
    assert.ok(types.includes('diagnosis.failed'), '中止必须如实记录为失败');
    assert.ok(!types.includes('diagnosis.completed'), '中止不得被记录为完成');
  } finally {
    await cleanup();
  }
});

test('工具操作写入审计账本，且不含路径与正文', async () => {
  const { pi, audit, cleanup } = await setup();
  try {
    await pi.emit('tool_execution_start', {
      toolCallId: 'call-1',
      toolName: 'source_search',
      args: { terms: ['IllegalStateException', 'OrderService'] },
    });
    await pi.emit('tool_execution_end', {
      toolCallId: 'call-1',
      toolName: 'source_search',
      result: { details: { evidenceId: 'EV-001', filesScanned: 42, truncated: true } },
      isError: false,
      durationMs: 12,
    });

    assert.equal(audit.size, 1, '每次工具操作都必须留痕');
    const rendered = audit.render(10);
    assert.match(rendered, /SOURCE_SEARCH/);
    assert.match(rendered, /2 个关键词/, '参数只记摘要，不记关键词原文');
    assert.match(rendered, /EV-001/);
    assert.match(rendered, /已截断/);
    assert.ok(!rendered.includes('IllegalStateException'), '关键词原文不得进入账本');
  } finally {
    await cleanup();
  }
});

test('未登记的工具名记为 DENY，不漏审', async () => {
  const { pi, audit, cleanup } = await setup();
  try {
    await pi.emit('tool_execution_start', { toolCallId: 'call-2', toolName: 'bash', args: {} });
    await pi.emit('tool_execution_end', {
      toolCallId: 'call-2',
      toolName: 'bash',
      result: undefined,
      isError: true,
    });

    assert.match(audit.render(10), /DENY/);
  } finally {
    await cleanup();
  }
});

test('本地读取的审计目标记附件编号，不记绝对路径', async () => {
  const { pi, audit, cleanup } = await setup();
  try {
    await pi.emit('tool_execution_start', {
      toolCallId: 'call-3',
      toolName: 'local_log_read',
      args: { attachmentId: 'att-1', startLine: 10, endLine: 20 },
    });
    await pi.emit('tool_execution_end', {
      toolCallId: 'call-3',
      toolName: 'local_log_read',
      result: { details: { truncated: 'none' } },
      isError: false,
    });

    const rendered = audit.render(10);
    assert.match(rendered, /att-1/);
    assert.match(rendered, /行 10-20/);
    assert.ok(!rendered.includes('已截断'), 'truncated=none 不是截断，不得误报');
  } finally {
    await cleanup();
  }
});

test('模型引用不存在的证据编号时当场提示', async () => {
  const { pi, evidence, cleanup } = await setup();
  try {
    evidence.add({ sourceKind: 'paste', sourceLabel: '粘贴', text: '真实证据' });
    pi.setAssistantReply('结论见 EV-001 与 EV-077');

    await pi.emit('agent_settled', { aborted: false });

    assert.ok(
      pi.notifications.some((line) => line.includes('EV-077')),
      '编造的编号必须被指出，否则会以和真实证据一样的格式混过去',
    );
  } finally {
    await cleanup();
  }
});

test('全部引用都真实时不打扰用户', async () => {
  const { pi, evidence, cleanup } = await setup();
  try {
    evidence.add({ sourceKind: 'paste', sourceLabel: '粘贴', text: '真实证据' });
    pi.setAssistantReply('结论见 EV-001');

    await pi.emit('agent_settled', { aborted: false });

    assert.ok(!pi.notifications.some((line) => line.includes('不存在的证据编号')));
  } finally {
    await cleanup();
  }
});

test('模型输出的最终消息会再过一次脱敏（出口复核）', async () => {
  const { pi, cleanup } = await setup();
  try {
    const result = (await pi.emit('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '连接串里的密码是 password=hunter2' }],
      },
    })) as { message: { content: Array<{ text?: string }> } } | undefined;

    assert.ok(result !== undefined, '含明文的输出必须被替换');
    assert.ok(!(result.message.content[0]?.text ?? '').includes('hunter2'));
  } finally {
    await cleanup();
  }
});

test('内容无变化时不重建消息', async () => {
  const { pi, cleanup } = await setup();
  try {
    const result = await pi.emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: '结论：OrderService.calc 空指针' }] },
    });

    assert.equal(result, undefined, '没有敏感内容就不应改动消息对象');
  } finally {
    await cleanup();
  }
});

test('用户消息不参与出口复核', async () => {
  const { pi, cleanup } = await setup();
  try {
    const result = await pi.emit('message_end', {
      message: { role: 'user', content: [{ type: 'text', text: 'password=hunter2' }] },
    });

    assert.equal(result, undefined, '入口已经脱敏过，用户消息不在这里重复处理');
  } finally {
    await cleanup();
  }
});
