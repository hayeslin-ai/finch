/**
 * 本地日志读取测试。
 *
 * 覆盖：普通日志、`.gz`、行数与字节上限、符号链接拒绝、区间读取。
 * 全部使用临时文件，不触碰真实日志。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';

import {
  authorizeAttachment,
  readLocalLog,
  readLocalRange,
  searchLocalLog,
} from '../../src/logs/local.js';

const LIMITS = { maxLines: 10, maxBytes: 4_096, maxScanBytes: 64 * 1024 };

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-log-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('读取普通日志并保留行内容', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'app.log');
    await writeFile(file, '第一行\n第二行\n第三行\n');

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle), '普通文件应被接受');

    const result = await readLocalLog(handle, LIMITS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.lines, ['第一行', '第二行', '第三行']);
    assert.equal(result.truncated, 'none');
  });
});

test('超过行数上限时标记截断，不静默丢弃', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'big.log');
    await writeFile(file, Array.from({ length: 25 }, (_, index) => `line-${index}`).join('\n'));

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const result = await readLocalLog(handle, LIMITS);
    assert.equal(result.lines.length, 10);
    assert.equal(result.truncated, 'tail');
    assert.equal(result.totalLines, 25);
  });
});

test('读取压缩日志，不生成解压副本', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'app.log.gz');
    await writeFile(file, gzipSync('压缩内容一\n压缩内容二\n'));

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));
    assert.equal(handle.compressed, true);

    const result = await readLocalLog(handle, LIMITS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.lines, ['压缩内容一', '压缩内容二']);

    // 目录中只应有原始 .gz，没有解压产物。
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(directory), ['app.log.gz']);
  });
});

test('拒绝符号链接与目录', async () => {
  await withTempDir(async (directory) => {
    const real = path.join(directory, 'real.log');
    await writeFile(real, 'content\n');
    const link = path.join(directory, 'link.log');
    await symlink(real, link);

    const linkResult = await authorizeAttachment(link);
    assert.ok('error' in linkResult);
    assert.match(linkResult.error, /符号链接/);

    const subdirectory = path.join(directory, 'sub');
    await mkdir(subdirectory);
    const dirResult = await authorizeAttachment(subdirectory);
    assert.ok('error' in dirResult);
    assert.match(dirResult.error, /普通文件/);
  });
});

test('按行区间读取并受上限约束', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'app.log');
    await writeFile(file, Array.from({ length: 30 }, (_, index) => `L${index + 1}`).join('\n'));

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const range = await readLocalRange(handle, 5, 8, LIMITS);
    assert.deepEqual(range.lines, ['L5', 'L6', 'L7', 'L8']);

    const capped = await readLocalRange(handle, 1, 100, LIMITS);
    assert.equal(capped.lines.length, LIMITS.maxLines, '区间读取同样受限');
  });
});

test('字面量搜索返回行号并标注截断', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'app.log');
    await writeFile(
      file,
      ['start', 'trace=T1 hit', 'middle', 'trace=T1 again', 'end'].join('\n'),
    );

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const found = await searchLocalLog(handle, ['trace=T1'], { maxHits: 10, maxScanBytes: 1024 });
    assert.equal(found.ok, true);
    assert.deepEqual(
      found.hits.map((hit) => hit.line),
      [2, 4],
    );
    assert.equal(found.truncated, false);

    const capped = await searchLocalLog(handle, ['trace=T1'], { maxHits: 1, maxScanBytes: 1024 });
    assert.equal(capped.hits.length, 1);
    assert.equal(capped.truncated, true);
  });
});

test('空搜索词被拒绝，避免匹配全部行', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'app.log');
    await writeFile(file, 'content\n');
    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const result = await searchLocalLog(handle, ['  '], { maxHits: 10, maxScanBytes: 1024 });
    assert.equal(result.ok, false);
  });
});

test('区间读取的前置行计入扫描上限，超限标记 scan-limit', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'rotated.log');
    // 每行约 1 KiB，前置 200 行远超 64 KiB 的扫描上限。
    const filler = 'x'.repeat(1023);
    const lines = Array.from({ length: 200 }, (_, index) => `${index}-${filler}`);
    await writeFile(file, `${[...lines, 'TARGET'].join('\n')}\n`);

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const result = await readLocalRange(handle, 201, 201, LIMITS);
    assert.equal(result.truncated, 'scan-limit', '前置行必须计入扫描上限，否则可以无视预算吃满 CPU');
    assert.equal(result.lines.length, 0, '超限后不得假装读到了区间内容');
  });
});

test('区间位于扫描上限内时正常返回，不误报截断', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'normal.log');
    await writeFile(file, Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n'));

    const handle = await authorizeAttachment(file);
    assert.ok(!('error' in handle));

    const result = await readLocalRange(handle, 5, 8, LIMITS);
    assert.equal(result.truncated, 'none');
    assert.deepEqual(result.lines, ['line-4', 'line-5', 'line-6', 'line-7']);
  });
});
