/**
 * 扩展钩子测试（离线）。
 *
 * WHY：预算是安全边界，但它由扩展在 Agent 循环的起止钩子上驱动。
 * 钩子一旦漏接，预算就退化成「永不计时」，四个工具的 canWork 守卫全部失效——
 * 而这在类型检查与界面表现上都看不出来，只能靠断言钩子副作用来兜住。
 *
 * 这里用假的 ExtensionAPI 捕获注册的处理器，不启动任何 SDK 运行时。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDiagnosisExtension } from '../../src/agent/extension.js';
import type { AppPaths } from '../../src/config/paths.js';
import { BudgetController } from '../../src/core/budget.js';

type Handler = (event: unknown, ctx: unknown) => unknown;

/** 捕获式假扩展 API：只记录注册内容，不执行。 */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    registerCommand: () => undefined,
  };
  return {
    api,
    /** 触发某个事件的全部处理器，返回第一个非空结果。 */
    async emit(event: string, payload: unknown = {}): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const value = await handler(payload, {});
        if (value !== undefined) {
          result = value;
        }
      }
      return result;
    },
    has: (event: string) => handlers.has(event),
  };
}

const PATHS: AppPaths = {
  configDir: '/tmp/finch/config',
  envFile: '/tmp/finch/config/.env',
  modelsFile: '/tmp/finch/config/models.json',
  redactionRulesFile: '/tmp/finch/config/redaction.json',
  stateDir: '/tmp/finch/state',
  dataDir: '/tmp/finch/data',
};

/** 构造扩展 + 可控时钟。 */
function setup() {
  let current = 0;
  const clock = {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });
  const pi = fakePi();

  createDiagnosisExtension({
    paths: PATHS,
    knowledge: { dataDir: PATHS.dataDir, scopeId: 'demo' },
    budget,
  })(pi.api as never);

  return { budget, clock, pi };
}

test('Agent 循环起止驱动预算计时，等待用户的时间不计入', async () => {
  const { budget, clock, pi } = setup();

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
});

test('预算到期后四个工具的守卫会真正拒绝开工', async () => {
  const { budget, clock, pi } = setup();

  await pi.emit('agent_start');
  clock.advance(300_000);

  assert.equal(budget.canStartWork(), false, '到期必须拒绝新探查');
  await pi.emit('agent_settled');
  assert.equal(budget.canStartWork(), false, '暂停态到期同样拒绝');
});

test('用户中止后钩子不得复活预算', async () => {
  const { budget, clock, pi } = setup();

  await pi.emit('agent_start');
  clock.advance(120_000);
  budget.cancel();

  await pi.emit('agent_settled');
  await pi.emit('agent_start');

  assert.equal(budget.canStartWork(), false, '取消是终态，不得被后续钩子复活');
  assert.equal(budget.snapshot().phase, 'cancelled');
});

test('本地 Shell 拦截钩子始终注册', () => {
  const { pi } = setup();
  assert.ok(pi.has('user_bash'), '! / !! 必须被扩展挡住');
});
