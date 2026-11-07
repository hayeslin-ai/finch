/**
 * 单仓库检索测试。
 *
 * 覆盖：跳过依赖与二进制、拒绝路径逃逸、符号链接不跟随、
 * 上限触发时如实标记，以及区间读取的边界检查。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { openRepository, readSourceRange, searchRepository } from '../../src/repository/read.js';

const LIMITS = {
  maxFiles: 50,
  maxScanBytes: 1024 * 1024,
  maxFileBytes: 100 * 1024,
  maxHits: 20,
};

/** 构造一个含多模块、依赖目录与敏感文件的临时仓库。 */
async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'finch-repo-'));
  await mkdir(path.join(root, 'src', 'main', 'java', 'com', 'demo'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await mkdir(path.join(root, 'target'), { recursive: true });

  await writeFile(
    path.join(root, 'src', 'main', 'java', 'com', 'demo', 'Service.java'),
    ['package com.demo;', 'class Service {', '  void run() { throw new IllegalStateException("boom"); }', '}'].join('\n'),
  );
  await writeFile(
    path.join(root, 'src', 'main', 'java', 'com', 'demo', 'Caller.java'),
    ['package com.demo;', 'class Caller {', '  void call() { new Service().run(); }', '}'].join('\n'),
  );
  await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1; // IllegalStateException\n');
  await writeFile(path.join(root, 'target', 'classes.txt'), 'IllegalStateException\n');
  await writeFile(path.join(root, '.env'), 'SECRET_TOKEN=IllegalStateException\n');
  await writeFile(path.join(root, 'app.jar'), 'IllegalStateException\n');
  return root;
}

test('检索命中源码，跳过依赖、构建产物、凭证与二进制', async () => {
  const root = await createRepository();
  try {
    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['IllegalStateException'], { limits: LIMITS });
    assert.equal(result.ok, true);

    const paths = result.hits.map((hit) => hit.relativePath);
    assert.deepEqual(paths, [path.join('src', 'main', 'java', 'com', 'demo', 'Service.java')]);
    assert.ok(!paths.some((item) => item.includes('node_modules')));
    assert.ok(!paths.some((item) => item.startsWith('target')));
    assert.ok(!paths.includes('.env'));
    assert.ok(!paths.includes('app.jar'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('多个关键词分别命中同一文件', async () => {
  const root = await createRepository();
  try {
    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['new Service()', 'throw new'], { limits: LIMITS });
    assert.equal(result.hits.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝逃出仓库根的子路径', async () => {
  const root = await createRepository();
  try {
    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['IllegalStateException'], {
      subPath: '../../etc',
      limits: LIMITS,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /超出仓库范围/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('符号链接目录不被跟随，避免越出仓库', async () => {
  const root = await createRepository();
  const outside = await mkdtemp(path.join(tmpdir(), 'finch-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.java'), 'class Secret { IllegalStateException x; }\n');
    await symlink(outside, path.join(root, 'linked'));

    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['IllegalStateException'], { limits: LIMITS });
    assert.ok(!result.hits.some((hit) => hit.relativePath.includes('linked')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('候选文件数达到上限时标记未覆盖，不谎报完整扫描', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'finch-repo-limit-'));
  try {
    // 命中内容只放在第 5 个文件里，且 maxFiles 只允许收集 2 个。
    for (let index = 0; index < 5; index += 1) {
      const body = index === 4 ? 'class F4 { // IllegalStateException\n' : `class F${index} { }\n`;
      await writeFile(path.join(root, `F${index}.java`), body);
    }

    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['IllegalStateException'], {
      limits: { ...LIMITS, maxFiles: 2 },
    });

    assert.equal(result.filesScanned, 2);
    assert.equal(result.truncated, true, '候选文件没收集完必须标记未覆盖');
    assert.equal(result.hits.length, 0, '命中文件未被扫描到，结果就应该是空');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('命中上限中断扫描时，已收集但未查看的文件计入跳过数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'finch-repo-hits-'));
  try {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(path.join(root, `F${index}.java`), 'class F { // IllegalStateException\n');
    }

    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['IllegalStateException'], {
      limits: { ...LIMITS, maxHits: 1 },
    });

    assert.equal(result.hits.length, 1);
    assert.equal(result.truncated, true);
    assert.equal(result.skippedFiles, 4, '未被查看的候选文件必须计入跳过数，否则规模被严重低估');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('命中数达到上限时标记未覆盖', async () => {
  const root = await createRepository();
  try {
    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const result = await searchRepository(handle, ['class'], {
      limits: { ...LIMITS, maxHits: 1 },
    });
    assert.equal(result.hits.length, 1);
    assert.equal(result.truncated, true, '必须显式标记未返回全部命中');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('区间读取按行号返回并拒绝越界路径', async () => {
  const root = await createRepository();
  try {
    const handle = await openRepository(root);
    assert.ok(!('error' in handle));

    const file = path.join('src', 'main', 'java', 'com', 'demo', 'Service.java');
    const range = await readSourceRange(handle, file, 3, 3);
    assert.equal(range.ok, true);
    assert.match(range.lines[0] ?? '', /IllegalStateException/);

    const escaped = await readSourceRange(handle, '../../etc/passwd', 1, 2);
    assert.equal(escaped.ok, false);

    const sensitive = await readSourceRange(handle, '.env', 1, 1);
    assert.equal(sensitive.ok, false);

    const invalid = await readSourceRange(handle, file, 0, 5);
    assert.equal(invalid.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('仓库根为符号链接时拒绝', async () => {
  const root = await createRepository();
  const link = `${root}-link`;
  try {
    await symlink(root, link);
    const handle = await openRepository(link);
    assert.ok('error' in handle);
    assert.match(handle.error, /符号链接/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(link, { force: true });
  }
});
