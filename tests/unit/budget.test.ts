/**
 * 预算控制测试。
 *
 * WHY：预算错误会直接导致“无限取证”或“用户思考时间被计入额度”，
 * 因此用可注入时钟精确验证计时、暂停与到期语义。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BudgetController } from '../../src/core/budget.js';

/** 可控时钟；每次 advance 推进虚拟时间。 */
function createClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test('运行中按实际耗时递减', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });

  budget.start();
  clock.advance(60_000);

  const snapshot = budget.snapshot();
  assert.equal(snapshot.phase, 'running');
  assert.equal(snapshot.remainingMs, 240_000);
  assert.ok(Math.abs(snapshot.remainingRatio - 0.8) < 1e-9);
});

test('审批等待期间不计入预算', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });

  budget.start();
  clock.advance(30_000);
  budget.pause();

  // 用户思考十分钟，不应消耗额度。
  clock.advance(600_000);
  assert.equal(budget.snapshot().remainingMs, 270_000);

  budget.resume();
  clock.advance(20_000);
  assert.equal(budget.snapshot().remainingMs, 250_000);
});

test('到期后不再允许发起新探查', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 10_000, now: clock.now });

  budget.start();
  clock.advance(10_000);

  assert.equal(budget.canStartWork(), false);
  assert.equal(budget.snapshot().phase, 'expired');
  assert.equal(budget.snapshot().remainingMs, 0);
});

test('暂停等待后仍可开工，不因空闲被误判为预算用尽', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });

  budget.start();
  budget.pause();
  // 用户阅读帮助、思考很久后才提交第一条消息。
  clock.advance(1_000_000);

  assert.equal(budget.canStartWork(), true, '暂停不是用尽，必须允许开工');
  assert.equal(budget.snapshot().remainingMs, 300_000, '等待期间不得消耗额度');

  budget.resume();
  clock.advance(10_000);
  assert.equal(budget.snapshot().remainingMs, 290_000);
});

test('中途取消后不得继续工作', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });

  budget.start();
  clock.advance(5_000);
  budget.cancel();

  assert.equal(budget.canStartWork(), false);
  assert.equal(budget.snapshot().phase, 'cancelled');
  assert.equal(budget.snapshot().remainingMs, 295_000, '取消只冻结剩余额度，不谎报为已耗费');
});

test('重复 start 不会重置已消耗时间', () => {
  const clock = createClock();
  const budget = new BudgetController({ totalMs: 300_000, now: clock.now });

  budget.start();
  clock.advance(100_000);
  budget.start();
  clock.advance(50_000);

  assert.equal(budget.snapshot().remainingMs, 150_000);
});

test('非法预算直接拒绝构造，避免永不到期', () => {
  assert.throws(() => new BudgetController({ totalMs: 0 }), /正有限数/);
  assert.throws(() => new BudgetController({ totalMs: Number.POSITIVE_INFINITY }), /正有限数/);
  assert.throws(() => new BudgetController({ totalMs: -1 }), /正有限数/);
});
