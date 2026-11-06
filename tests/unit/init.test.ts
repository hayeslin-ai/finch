/**
 * 初始化测试。
 *
 * WHY：init 若意外覆盖已有配置，用户会丢失凭证；若创建了宽权限文件，
 * 凭证会暴露给本机其他用户。两项都必须用测试固定。
 */
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { initAppDirectories } from '../../src/config/init.js';
import { resolveAppPaths } from '../../src/config/paths.js';

test('首次运行创建 0700 目录与 0600 模板', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-init-'));
  const project = await mkdtemp(path.join(tmpdir(), 'finch-init-proj-'));
  try {
    const paths = resolveAppPaths(home);
    const result = await initAppDirectories(paths);

    assert.equal(result.ok, true);
    assert.equal((await stat(paths.configDir)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.envFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.modelsFile)).mode & 0o777, 0o600);

    // 模板不含真实值，但必须出现需要用户填写的字段名。
    const env = await readFile(paths.envFile, 'utf8');
    for (const key of ['JUMP_USER', 'JUMP_PASSWORD', 'MFA_SECRET']) {
      assert.match(env, new RegExp(`^${key}=`, 'm'));
    }
    // 固定的环境默认值应预置，减少每次手填。
    assert.match(env, /^APP_GROUP=appgroup$/m);
    assert.match(env, /^APP_USER=app$/m);
    assert.match(env, /^LOG_DIR=~\/sxpservice\/logs\/$/m);
    // 已移出 .env 的项：诊断范围、模型、工具路径与目标机。
    for (const key of [
      'REPO_ROOT',
      'SERVICE_ID',
      'MODEL_PROVIDER',
      'MODEL_ID',
      'MODEL_API_KEY',
      'EXPECT_PATH',
      'LOGIN_SCRIPT',
      'OATH_TOOL',
      'TARGET_HOST',
    ]) {
      assert.ok(!env.includes(`${key}=`), `模板不得包含 ${key}`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('重复运行不覆盖已有配置', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-init-'));
  const project = await mkdtemp(path.join(tmpdir(), 'finch-init-proj-'));
  try {
    const paths = resolveAppPaths(home);
    await initAppDirectories(paths);

    // 模拟用户已填入真实配置。
    const filled = 'REPO_ROOT=/my/repo\nSERVICE_ID=svc\n';
    await writeFile(paths.envFile, filled, 'utf8');

    const second = await initAppDirectories(paths);
    assert.equal(second.ok, true);
    assert.equal(await readFile(paths.envFile, 'utf8'), filled, '已有配置不得被覆盖');
    assert.ok(second.actions.every((action) => action.action === 'kept'));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('目录为符号链接时拒绝并保持原样', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-init-'));
  try {
    const realDir = path.join(home, 'elsewhere');
    await mkdir(realDir, { mode: 0o700 });
    await mkdir(path.join(home, '.config'), { recursive: true });
    await symlink(realDir, path.join(home, '.config', 'finch'));

    const project = await mkdtemp(path.join(tmpdir(), 'finch-init-proj-'));
    const paths = resolveAppPaths(home);
    const result = await initAppDirectories(paths);
    await rm(project, { recursive: true, force: true });

    assert.equal(result.ok, false, '符号链接必须被视为不安全');
    const linkStat = await lstat(paths.configDir);
    assert.equal(linkStat.isSymbolicLink(), true, '不得替换用户已有链接');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
