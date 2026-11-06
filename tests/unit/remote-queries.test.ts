/**
 * 远程查询参数校验测试。
 *
 * 关键不变量：任何可能被解释成命令、选项或路径逃逸的输入都必须被拒绝，
 * 而不是尝试转义。转义规则一旦出错，注入就会静默生效。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  QueryValidationError,
  toWirePayload,
  validateContext,
  validateDepth,
  validateFileRef,
  validateLineRange,
  validateSubDir,
  validateTerms,
} from '../../src/remote/queries.js';

test('合法搜索词被接受', () => {
  const terms = ['NullPointerException', 'com.demo.OrderService', 'Qwmw4nqk87eq', 'com/x/Y:39'];
  assert.deepEqual(validateTerms(terms), terms);
});

test('注入类搜索词被拒绝', () => {
  const evil = [
    'a b',
    'a;b',
    'a|b',
    'a&b',
    'a>b',
    'a=1',
    'a$(id)',
    'a`id`',
    'a"b',
    "a'b",
    'a\\b',
    '',
    'x'.repeat(201),
  ];
  for (const term of evil) {
    assert.throws(() => validateTerms([term]), QueryValidationError, `应拒绝：${term.slice(0, 20)}`);
  }
});

test('搜索词数量受限', () => {
  assert.throws(() => validateTerms([]), QueryValidationError);
  assert.throws(
    () => validateTerms(['a', 'b', 'c', 'd', 'e']),
    QueryValidationError,
  );
});

test('子目录不允许绝对路径与上跳', () => {
  assert.equal(validateSubDir(''), '');
  assert.equal(validateSubDir('20261106'), '20261106');
  assert.equal(validateSubDir('logs/20261106'), 'logs/20261106');

  for (const bad of ['/etc', '../etc', 'a/../../b', 'a/b/c', 'a b', 'a;b', '']) {
    if (bad === '') {
      continue;
    }
    assert.throws(() => validateSubDir(bad), QueryValidationError, `应拒绝：${bad}`);
  }
});

test('枚举深度限制在 1 到 3', () => {
  assert.equal(validateDepth(2), 2);
  for (const bad of [0, 4, -1, 1.5]) {
    assert.throws(() => validateDepth(bad), QueryValidationError);
  }
});

test('上下文行数限制在 0 到 200', () => {
  assert.deepEqual(validateContext(80, 80), { before: 80, after: 80 });
  assert.throws(() => validateContext(-1, 10), QueryValidationError);
  assert.throws(() => validateContext(10, 201), QueryValidationError);
});

test('fileRef 只接受枚举格式，拒绝路径', () => {
  assert.equal(validateFileRef('f-1'), 'f-1');
  assert.equal(validateFileRef('f-123456'), 'f-123456');

  for (const bad of ['../../etc/passwd', '/etc/passwd', 'f-a', 'server.log', '']) {
    assert.throws(() => validateFileRef(bad), QueryValidationError, `应拒绝：${bad}`);
  }
});

test('行号区间合法性与跨度上限', () => {
  assert.deepEqual(validateLineRange(10, 20), { startLine: 10, endLine: 20 });
  assert.throws(() => validateLineRange(0, 10), QueryValidationError);
  assert.throws(() => validateLineRange(20, 10), QueryValidationError);
  assert.throws(() => validateLineRange(1, 3000), QueryValidationError, '跨度不得超过 2000 行');
});

test('线上负载只含数据字段，不生成任何命令文本', () => {
  const list = JSON.parse(toWirePayload({ kind: 'LIST', subDir: '20261106', maxDepth: 2 })) as Record<string, unknown>;
  assert.deepEqual(list, { subDir: '20261106', maxDepth: 2 });

  const search = JSON.parse(
    toWirePayload({ kind: 'SEARCH', terms: ['NPE'], before: 80, after: 80 }),
  ) as Record<string, unknown>;
  assert.deepEqual(search, { terms: ['NPE'], before: 80, after: 80 });

  const read = JSON.parse(
    toWirePayload({ kind: 'READ', fileRef: 'f-3', startLine: 1, endLine: 100 }),
  ) as Record<string, unknown>;
  assert.deepEqual(read, { fileRef: 'f-3', startLine: 1, endLine: 100 });

  const joined = [list, search, read].map((item) => JSON.stringify(item)).join(' ');
  for (const forbidden of ['grep', 'sed', 'find', '|', ';', '$(']) {
    assert.ok(!joined.includes(forbidden), `负载不得包含命令片段：${forbidden}`);
  }
});
