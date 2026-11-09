/**
 * 登录脚本自动生成测试。
 *
 * WHY：脚本是程序资产而非用户配置。必须固定生成到配置目录、
 * 保持 0600、升级后自动同步，并且拒绝符号链接目标。
 */
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveAppPaths } from '../../src/config/paths.js';
import { ensureLoginScript } from '../../src/remote/login-script.js';

async function createHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'finch-login-script-'));
}

test('首次使用时自动创建 0600 登录脚本', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    const result = await ensureLoginScript(paths);

    assert.equal(result.ok, true);
    assert.equal(result.status, 'created');
    assert.equal(result.path, paths.loginScriptFile);
    assert.equal((await stat(paths.loginScriptFile)).mode & 0o777, 0o600);

    const content = await readFile(paths.loginScriptFile, 'utf8');
    assert.match(content, /^#!\/usr\/bin\/expect -f/);
    assert.match(content, /自动生成/, '文件必须标记为程序管理');
    assert.match(content, /--agent/, '生成内容必须来自打包资产');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('内容一致时不重复写盘', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    await ensureLoginScript(paths);
    const first = await stat(paths.loginScriptFile);

    const second = await ensureLoginScript(paths);
    assert.equal(second.status, 'kept');
    assert.equal((await stat(paths.loginScriptFile)).ino, first.ino, '未变化时不应替换文件');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('内容被改动时自动恢复为打包版本', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    await ensureLoginScript(paths);
    await writeFile(paths.loginScriptFile, '#!/usr/bin/expect -f\n# 用户改动\n', 'utf8');

    const result = await ensureLoginScript(paths);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'updated');

    const content = await readFile(paths.loginScriptFile, 'utf8');
    assert.ok(!content.includes('用户改动'));
    assert.match(content, /--agent/);
    assert.equal((await stat(paths.loginScriptFile)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('目标为符号链接时拒绝写入', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    const outside = path.join(home, 'outside.exp');
    await writeFile(outside, '#!/bin/true\n', { mode: 0o600 });
    await symlink(outside, paths.loginScriptFile);

    const result = await ensureLoginScript(paths);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unsafe');
    assert.match(result.reason ?? '', /符号链接/);

    assert.equal((await lstat(paths.loginScriptFile)).isSymbolicLink(), true, '不得替换用户链接');
    assert.equal(await readFile(outside, 'utf8'), '#!/bin/true\n', '链接目标内容不得被改写');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('权限被放宽时收紧为 0600', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    await ensureLoginScript(paths);
    await chmod(paths.loginScriptFile, 0o644);

    const result = await ensureLoginScript(paths);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'updated');
    assert.match(result.reason ?? '', /权限/);
    assert.equal((await stat(paths.loginScriptFile)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
