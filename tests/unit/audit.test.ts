/**
 * 审计账本测试。
 *
 * WHY：`/audit` 是用户回答「Agent 到底做了什么」的唯一入口（AC-39），
 * 因此容量上限、渲染格式与空态提示都必须固定下来，
 * 且账本里只能出现非敏感摘要。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AuditLedger } from '../../src/core/audit.js';

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

test('超过容量上限时丢弃最旧记录，不无限增长', () => {
  const ledger = new AuditLedger();
  for (let index = 0; index < 520; index += 1) {
    ledger.record({
      at: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      operation: 'READ',
      target: 'att-1',
      params: `行 ${index}`,
      result: '完成',
      grant: '-',
    });
  }

  assert.equal(ledger.size, 500, '长时间会话不得让账本无限增长');
  assert.equal(ledger.recent(1)[0]?.params, '行 519', '保留的必须是最新记录');
});

test('渲染为固定列宽表格，且只含摘要字段', () => {
  const ledger = new AuditLedger();
  ledger.record({
    at: '2026-11-07T10:20:30.000Z',
    operation: 'LOCAL_SEARCH',
    target: 'att-1',
    params: '2 个关键词',
    result: 'EV-003',
    grant: '-',
  });

  const rendered = ledger.render(10);
  assert.match(rendered, /^TIME\s+OP\s+TARGET\s+PARAMS\s+RESULT\s+GRANT/m);
  assert.match(rendered, /10:20:30/);
  assert.match(rendered, /LOCAL_SEARCH/);
  assert.match(rendered, /EV-003/);
});
