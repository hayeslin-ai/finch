/**
 * 证据存储测试。
 *
 * 关键不变量：证据只追加、编号稳定、能发现模型引用了不存在的编号。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EvidenceStore } from '../../src/core/evidence.js';

test('证据按顺序编号且可检索', () => {
  const store = new EvidenceStore();
  const first = store.add({ sourceKind: 'paste', sourceLabel: '粘贴内容', text: '第一段' });
  const second = store.add({ sourceKind: 'local-file', sourceLabel: 'app.log', text: '第二段' });

  assert.equal(first.id, 'EV-001');
  assert.equal(second.id, 'EV-002');
  assert.equal(store.get('EV-002')?.text, '第二段');
  assert.equal(store.get('EV-999'), undefined);
});

test('相同内容重复登记仍是两条证据，但摘要相同', () => {
  const store = new EvidenceStore();
  const a = store.add({ sourceKind: 'remote', sourceLabel: 'host', text: 'same' });
  const b = store.add({ sourceKind: 'remote', sourceLabel: 'host', text: 'same' });

  assert.notEqual(a.id, b.id, '编号不可复用');
  assert.equal(a.digest, b.digest, '同一内容摘要一致，便于判断是否变化');
});

test('内容不同则摘要不同', () => {
  const store = new EvidenceStore();
  const a = store.add({ sourceKind: 'paste', sourceLabel: 'x', text: 'one' });
  const b = store.add({ sourceKind: 'paste', sourceLabel: 'x', text: 'two' });
  assert.notEqual(a.digest, b.digest);
});

test('能发现模型引用了不存在的证据编号', () => {
  const store = new EvidenceStore();
  store.add({ sourceKind: 'paste', sourceLabel: 'x', text: 'content' });

  assert.deepEqual(store.findUnknownIds('结论基于 EV-001。'), []);
  assert.deepEqual(store.findUnknownIds('结论基于 EV-001 与 EV-042。'), ['EV-042']);
});

test('摘要统计按来源分组', () => {
  const store = new EvidenceStore();
  store.add({ sourceKind: 'paste', sourceLabel: 'a', text: '1' });
  store.add({ sourceKind: 'paste', sourceLabel: 'b', text: '2' });
  store.add({ sourceKind: 'remote', sourceLabel: 'h', text: '3' });

  assert.deepEqual(store.summary(), { count: 3, bySource: { paste: 2, remote: 1 } });
});

test('清空后重新从 EV-001 开始', () => {
  const store = new EvidenceStore();
  store.add({ sourceKind: 'paste', sourceLabel: 'a', text: '1' });
  store.clear();
  assert.equal(store.add({ sourceKind: 'paste', sourceLabel: 'b', text: '2' }).id, 'EV-001');
});
