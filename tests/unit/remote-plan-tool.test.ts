/**
 * `remote_query_plan` 宿主门禁测试（纯内存）。
 *
 * 关键不变量：
 * - 没有待确认的 /remote 请求时调用必然失败，模型不能自行发起授权；
 * - 用户拒绝即终止本次 /remote，不登录、不建立授权、不发送任何查询；
 * - 只有计划确认后才会调用登录；身份核对同样经过用户确认；
 * - 一次请求只能提交一次计划，拒绝后重复弹窗无效。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemotePlanTool, renderRemotePlanSummary } from '../../src/agent/remote-plan-tool.js';
import { parseLimits } from '../../src/config/limits.js';
import { AuditLedger } from '../../src/core/audit.js';
import { RemoteAccess } from '../../src/remote/access.js';
import type { RemoteLoginRequest, RemoteLoginResult } from '../../src/remote/login-flow.js';
import { RemotePlanGate } from '../../src/remote/plan-gate.js';

const LIMITS = parseLimits(new Map()).limits;

const PLAN_LIMITS = {
  maxQueries: LIMITS.MAX_QUERY_COUNT,
  maxFiles: LIMITS.MAX_FILES,
  maxResultLines: LIMITS.MAX_RESULT_LINES,
  maxResultBytes: LIMITS.MAX_RESULT_BYTES,
};

type PlanTool = {
  readonly name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
};

interface ConfirmCall {
  readonly title: string;
  readonly message: string;
}

/** 造一个可控的确认对话框；answers 按调用顺序消费，默认拒绝。 */
function fakeCtx(answers: readonly boolean[], hasUI = true) {
  const calls: ConfirmCall[] = [];
  let index = 0;
  const ctx = {
    hasUI,
    ui: {
      confirm: async (title: string, message: string) => {
        calls.push({ title, message });
        const answer = answers[index] ?? false;
        index += 1;
        return answer;
      },
    },
  };
  return { ctx, calls };
}

function setup(options: { hasUI?: boolean } = {}) {
  const gate = new RemotePlanGate();
  const audit = new AuditLedger();
  const access = new RemoteAccess({
    audit,
    canWork: () => true,
    limits: LIMITS,
    queryTimeoutMs: 1_000,
  });

  const loginCalls: RemoteLoginRequest[] = [];
  let identityConfirmed: boolean | undefined;
  const login = async (request: RemoteLoginRequest): Promise<RemoteLoginResult> => {
    loginCalls.push(request);
    identityConfirmed = await request.confirmIdentity('host=h1;user=app;dir=/home/app/logs');
    return identityConfirmed
      ? { ok: true, message: `已授权 ${request.target} 的只读日志查询。` }
      : { ok: false, message: '身份未确认，连接已关闭，未执行任何查询。' };
  };

  let grantCounter = 0;
  const tool = createRemotePlanTool({
    gate,
    access,
    limits: PLAN_LIMITS,
    login,
    nextGrantId: () => {
      grantCounter += 1;
      return `grant-${String(grantCounter)}`;
    },
  }) as unknown as PlanTool;

  return { gate, audit, access, tool, loginCalls, getIdentityConfirmed: () => identityConfirmed };
}

async function call(tool: PlanTool, params: Record<string, unknown>, ctx: unknown) {
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

test('没有待确认请求时拒绝，不能自行发起授权', async () => {
  const { tool } = setup();
  const { ctx, calls } = fakeCtx([true]);

  const result = await call(tool, { purpose: '查订单失败' }, ctx);

  assert.match(result.content[0]?.text ?? '', /没有待确认的 \/remote 请求/);
  assert.equal(calls.length, 0, '不得弹出任何确认框');
});

test('用户拒绝计划后终止本次 /remote，不登录、不建立授权', async () => {
  const { gate, access, tool, loginCalls } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx, calls } = fakeCtx([false]);

  const result = await call(tool, { purpose: '定位订单创建失败' }, ctx);

  assert.match(result.content[0]?.text ?? '', /用户拒绝了查询计划/);
  assert.match(result.content[0]?.text ?? '', /未建立连接/);
  assert.equal(calls.length, 1, '只应展示计划，不应进入身份核对');
  assert.match(calls[0]?.message ?? '', /22\.50\.0\.1/);
  assert.match(calls[0]?.message ?? '', /原始诉求：查订单创建失败原因/, '确认框必须展示原始诉求');
  assert.equal(loginCalls.length, 0, '拒绝后不得登录');
  assert.equal(access.active, false, '拒绝后不得存在授权');
  assert.equal(gate.active, false, '请求必须被消费，不能再次弹窗');

  const query = await access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(query.ok, false);
  assert.match(query.message ?? '', /\/remote/);
});

test('确认计划后才登录并返回计划摘要，grant 使用确认的目的', async () => {
  const { gate, access, tool, loginCalls, getIdentityConfirmed } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx, calls } = fakeCtx([true, true]);

  const result = await call(
    tool,
    {
      purpose: '定位订单创建失败原因',
      keywords: ['NullPointerException', 'OrderService'],
      subDir: 'order',
      maxDepth: 2,
      focus: '关注 Caused by 链',
    },
    ctx,
  );

  assert.match(result.content[0]?.text ?? '', /已授权 22\.50\.0\.1/);
  assert.match(result.content[0]?.text ?? '', /配额：查询 \d+ 次/, '计划摘要必须包含宿主配额');
  assert.match(result.content[0]?.text ?? '', /定位订单创建失败原因/);
  assert.equal(calls.length, 2, '先确认计划，再核对身份');
  assert.match(calls[0]?.title ?? '', /远程查询计划/);
  assert.match(calls[1]?.title ?? '', /身份核对：22\.50\.0\.1/);

  assert.equal(loginCalls.length, 1);
  const request = loginCalls[0];
  assert.equal(request?.target, '22.50.0.1');
  assert.equal(request?.intent, '定位订单创建失败原因');
  assert.equal(request?.grantId, 'grant-1');
  assert.equal(getIdentityConfirmed(), true);
  assert.equal(access.active, false, '本测试的登录替身不建授权；真实实现由 loginRemote 建立');
  assert.equal(gate.active, false);
});

test('一次 /remote 只能提交一次计划', async () => {
  const { gate, tool } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx } = fakeCtx([true, true]);

  const first = await call(tool, { purpose: '定位订单创建失败' }, ctx);
  assert.match(first.content[0]?.text ?? '', /已授权/);

  const second = await call(tool, { purpose: '再查一次' }, ctx);
  assert.match(second.content[0]?.text ?? '', /没有待确认的 \/remote 请求/);
});

test('目的与关注点拒绝引号、尖括号与 &，且保留请求允许重试', async () => {
  const { gate, tool } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx, calls } = fakeCtx([true]);

  for (const purpose of ['定位 "订单" 失败', '定位 <订单> 失败', '订单 & 支付失败']) {
    const result = await call(tool, { purpose }, ctx);
    assert.match(result.content[0]?.text ?? '', /不得包含尖括号、引号、& 或控制字符/);
  }
  assert.equal(calls.length, 0, '非法字段不得进入确认对话框');
  assert.equal(gate.active, true, '校验失败应保留请求，允许模型修正后重试');
});

test('中文关键词被拒绝，必须转换为可搜索的 ASCII 线索', async () => {
  const { gate, tool } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx, calls } = fakeCtx([true]);

  const result = await call(tool, { purpose: '定位订单创建失败', keywords: ['订单创建失败'] }, ctx);

  assert.match(result.content[0]?.text ?? '', /搜索词只能包含/);
  assert.equal(calls.length, 0);
  assert.equal(gate.active, true);
});

test('无对话框环境失败关闭：清空请求且不登录', async () => {
  const { gate, tool, loginCalls } = setup();
  gate.set('22.50.0.1', '查订单创建失败原因');
  const { ctx, calls } = fakeCtx([true], false);

  const result = await call(tool, { purpose: '定位订单创建失败' }, ctx);

  assert.match(result.content[0]?.text ?? '', /没有可用的确认对话框/);
  assert.equal(calls.length, 0);
  assert.equal(loginCalls.length, 0);
  assert.equal(gate.active, false, '无 UI 时必须清空，避免下次调用捡起旧请求');
});

test('计划摘要由宿主拼装，包含目标、原始诉求、配额与时间窗限制', () => {
  const summary = renderRemotePlanSummary({
    target: '22.50.0.1',
    request: '查一下订单创建为什么失败',
    purpose: '定位订单创建失败原因',
    keywords: ['NullPointerException'],
    subDir: '',
    maxDepth: 2,
    focus: undefined,
    limits: PLAN_LIMITS,
  });

  assert.match(summary, /目标：22\.50\.0\.1/);
  assert.match(summary, /原始诉求：查一下订单创建为什么失败/);
  assert.match(summary, /关键词：NullPointerException/);
  assert.match(summary, /枚举范围：日志根目录，深度 2/);
  assert.match(summary, /配额：查询 \d+ 次 · 文件 \d+ 个/);
  assert.match(summary, /时间窗：未实现/, '必须如实声明时间窗限制');
  assert.match(summary, /全部只读/);
});
