/**
 * 诊断编排与审计测试（离线）。
 *
 * 重点验证：预算在等待与执行之间的切换、模型输出脱敏、
 * 伪造证据编号检测，以及审计只记录非敏感摘要。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditLedger } from '../../src/core/audit.js';
import { BudgetController } from '../../src/core/budget.js';
import { Diagnosis, type TurnRunner } from '../../src/core/diagnosis.js';
import { EvidenceStore } from '../../src/core/evidence.js';
import { Redactor } from '../../src/security/redactor.js';

/** 假轮次执行器：按预设输出并触发工具回调。 */
function fakeRunner(output: string): TurnRunner & { aborted: boolean } {
  const runner = {
    aborted: false,
    async run(
      _text: string,
      hooks: {
        onToolStart: (name: string) => void;
        onToolEnd: (name: string, durationMs: number | undefined, failed: boolean) => void;
        onTextDelta: (text: string) => void;
      },
    ) {
      hooks.onToolStart('source_search');
      hooks.onToolEnd('source_search', 12, false);
      hooks.onTextDelta(output);
      return { text: output, aborted: false };
    },
    async abort() {
      runner.aborted = true;
    },
  };
  return runner;
}

function createDiagnosis(redactor: Redactor) {
  const clock = { value: 0 };
  const budget = new BudgetController({ totalMs: 300_000, now: () => clock.value });
  const diagnosis = new Diagnosis({
    evidence: new EvidenceStore(),
    audit: new AuditLedger(),
    budget,
    sanitize: (text) => redactor.redact(text),
    now: () => 1_700_000_000_000 + clock.value,
  });
  return { diagnosis, budget, clock };
}

test('模型输出经过脱敏后才交给渲染层', async () => {
  const redactor = new Redactor();
  const { diagnosis } = createDiagnosis(redactor);
  diagnosis.budget.start();

  const chunks: string[] = [];
  await diagnosis.runTurn(fakeRunner('连接密码是 password=hunter2'), '请分析', (text: string) => chunks.push(text));

  assert.ok(!chunks.join('').includes('hunter2'), '流式输出必须脱敏');
});

test('工具执行写入审计账本，且不含敏感参数', async () => {
  const { diagnosis } = createDiagnosis(new Redactor());
  diagnosis.budget.start();

  await diagnosis.runTurn(fakeRunner('ok'), '请分析', () => undefined);

  const entries = diagnosis.audit.recent(10);
  assert.ok(entries.length >= 2, '开始与结束都应记录');
  assert.ok(entries.every((entry) => entry.target === 'repo'));
  const rendered = diagnosis.audit.render(10);
  assert.match(rendered, /SEARCH/);
  assert.ok(!rendered.includes('hunter2'));
});

test('能发现模型编造的证据编号', async () => {
  const { diagnosis } = createDiagnosis(new Redactor());
  diagnosis.evidence.add({ sourceKind: 'paste', sourceLabel: '粘贴', text: '真实证据' });

  assert.deepEqual(diagnosis.verifyCitations('结论见 EV-001'), []);
  assert.deepEqual(diagnosis.verifyCitations('结论见 EV-001 与 EV-077'), ['EV-077']);
});

test('轮次结束后预算回到暂停，等待时间不计入', async () => {
  const { diagnosis } = createDiagnosis(new Redactor());
  diagnosis.budget.start();
  diagnosis.budget.pause();

  const before = diagnosis.budget.remainingMs();
  await diagnosis.runTurn(fakeRunner('ok'), '请分析', () => undefined);

  const after = diagnosis.budget.remainingMs();
  assert.ok(after <= before, '执行期间应消耗预算');
  assert.equal(diagnosis.budget.snapshot().phase, 'paused', '结束后必须回到暂停态');
});

test('审计账本最多保留最近记录且渲染为空时友好提示', () => {
  const ledger = new AuditLedger();
  assert.match(ledger.render(10), /暂无操作记录/);

  for (let index = 0; index < 12; index += 1) {
    ledger.record({
      at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      operation: 'SEARCH',
      target: 'repo',
      params: `q${index}`,
      result: 'ok',
      grant: '-',
    });
  }

  const recent = ledger.recent(10);
  assert.equal(recent.length, 10);
  assert.equal(recent.at(-1)?.params, 'q11', '应保留最新记录');
  assert.equal(ledger.size, 12);
});
