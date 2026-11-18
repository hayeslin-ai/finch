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

test('登录脚本按安装布局读取同目录 .env，并在 dumb 终端下补默认 TERM', async () => {
  const home = await createHome();
  try {
    const paths = resolveAppPaths(home);
    await ensureLoginScript(paths);
    const content = await readFile(paths.loginScriptFile, 'utf8');
    // 安装后脚本位于 ~/.config/finch/，配置就在同目录；
    // 只找 ../.env 会让手工联调一直报缺少 JUMP_HOST。
    assert.match(content, /file join \$script_dir \.env/, '必须优先读取脚本同目录的 .env');
    // finch 以 TERM=dumb 启动登录子进程，堡垒机 TUI 需要可用终端类型。
    assert.match(content, /::env\(TERM\)/, '必须在 dumb 终端下补默认 TERM');
    // .env 里还有模型凭证；登录脚本只能加载登录键，不能让它们进入 ssh 子进程。
    const whitelist = /set ::LOGIN_ENV_KEYS \{([\s\S]*?)\}/.exec(content)?.[1] ?? '';
    assert.notEqual(whitelist, '', '必须用登录键白名单过滤 .env');
    assert.ok(!whitelist.includes('MODEL_API_KEY'), '白名单不得包含模型凭证键');
    // 认证提示必须按“行尾提示符”匹配：成功横幅和输入回显也含 OTP/Password 字样，
    // 裸 glob 会把认证成功误判成“重新要求认证”（真机已验证）。
    assert.match(content, /password_prompt_re/, '密码提示必须用提示符形态匹配');
    assert.match(content, /otp_prompt_re/, 'MFA 提示必须用提示符形态匹配');
    assert.ok(
      !/"\*OTP\*"/.test(content) && !/"\*assword\*"/.test(content),
      '不得用裸 glob 匹配认证提示',
    );
    // 真机上一条 printf 同时取主机名与账户时整行丢失，只能报笼统的“身份核对失败”；
    // 两个值必须分行、分标记回传，失败时才能指出缺的是哪一个。
    assert.match(content, /__HOST__/, '主机名核对必须使用独立标记');
    assert.match(content, /__USER__/, '账户核对必须使用独立标记');
    assert.ok(!/'__ID__%s\|%s/.test(content), '不得用单条 printf 同时取主机名与账户');
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
