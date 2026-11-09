/**
 * 远程文件枚举表测试。
 *
 * 关键不变量：fileRef 只能来自 LIST 结果，未知编号必须被拒绝；
 * 超出文件上限时截断并如实报告，而不是静默扩大授权。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FileRegistry, parseListOutput } from '../../src/remote/file-registry.js';

test('解析 find -printf 输出并按 mtime 降序分配编号', () => {
  const text = [
    '1762500000.0000000000\t1024\t/home/app/logs/server.log',
    '1762600000.0000000000\t2048\t/home/app/logs/server.log.2026-11-08',
    '',
    'garbage line',
  ].join('\n');

  const listed = parseListOutput(text);
  assert.equal(listed.length, 2, '无法解析的行必须丢弃');

  const registry = new FileRegistry();
  const result = registry.register(listed, 10);

  assert.deepEqual(
    result.files.map((file) => [file.ref, file.name]),
    [
      ['f-1', 'server.log.2026-11-08'],
      ['f-2', 'server.log'],
    ],
    '最新的文件应获得 f-1',
  );
  assert.equal(result.truncated, false);
  assert.equal(result.total, 2);
});

test('超出文件上限时截断并如实标记', () => {
  const listed = Array.from({ length: 5 }, (_, index) => ({
    path: `/home/app/logs/server-${String(index)}.log`,
    mtimeMs: (index + 1) * 1000,
    size: 100,
  }));

  const registry = new FileRegistry();
  const result = registry.register(listed, 3);

  assert.equal(result.files.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 5);
  assert.deepEqual(
    result.files.map((file) => file.ref),
    ['f-1', 'f-2', 'f-3'],
  );
  assert.equal(registry.size, 3);
});

test('回退模式只有路径时按最旧排序，仍生成编号', () => {
  const listed = parseListOutput('/home/app/logs/a.log\n/home/app/logs/b.log\n');
  assert.equal(listed.length, 2);
  assert.ok(listed.every((file) => file.mtimeMs === 0));

  const registry = new FileRegistry();
  const result = registry.register(listed, 10);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[0]?.ref, 'f-1');
});

test('未知 fileRef 解析为 undefined，重新枚举清空旧编号', () => {
  const registry = new FileRegistry();
  registry.register(
    [{ path: '/home/app/logs/a.log', mtimeMs: 1, size: 1 }],
    10,
  );

  assert.equal(registry.resolve('f-1')?.name, 'a.log');
  assert.equal(registry.resolve('f-9'), undefined, '不存在的编号必须拒绝');

  registry.register([{ path: '/home/app/logs/b.log', mtimeMs: 2, size: 2 }], 10);
  assert.equal(registry.resolve('f-1')?.name, 'b.log', '旧编号不得指向旧文件');
});

test('压缩文件按后缀标记', () => {
  const registry = new FileRegistry();
  const result = registry.register(
    [
      { path: '/home/app/logs/server.log.1.gz', mtimeMs: 2, size: 1 },
      { path: '/home/app/logs/server.log', mtimeMs: 1, size: 1 },
    ],
    10,
  );

  assert.equal(result.files[0]?.compressed, true);
  assert.equal(result.files[1]?.compressed, false);
});
