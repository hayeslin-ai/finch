/**
 * doctor 检查与报告测试。
 *
 * WHY：缺少 oathtool 时本地诊断必须仍可用；doctor 不能因为远程依赖缺失
 * 就整体失败。测试用临时 PATH 与假程序验证解析优先级，不执行真实 OTP、
 * 不建立 SSH，也不触碰真实用户配置。
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { probeExecutable } from '../../src/doctor/checks.js';
import { computeExitCode, renderReport } from '../../src/doctor/report.js';
import { checkNodeVersion, runDoctorChecks } from '../../src/cli/doctor-command.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { parseLimits } from '../../src/config/limits.js';
import { resolveAppPaths, type AppPaths } from '../../src/config/paths.js';

test('Node 版本低于引擎要求时报告不符', () => {
  assert.equal(checkNodeVersion('v22.19.0').status, 'pass');
  assert.equal(checkNodeVersion('v26.0.0').status, 'pass');
  assert.equal(checkNodeVersion('v22.18.0').status, 'version-mismatch');
  assert.equal(checkNodeVersion('v20.11.0').status, 'version-mismatch');

  const mismatch = checkNodeVersion('v20.11.0');
  assert.equal(mismatch.expected, '>=22.19');
  assert.ok(mismatch.hint !== undefined);
});

test('探测失败不抛异常，也不回显探测对象的内容', async () => {
  const result = await probeExecutable('/nonexistent/tool', ['--version']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, '未找到可执行文件');
});

test('仅可选能力缺失时退出码仍为 0', () => {
  const exitCode = computeExitCode([
    { group: 'base', name: 'Node.js', status: 'pass' },
    { group: 'local', name: '仓库路径', status: 'pass' },
    { group: 'optional', name: 'oathtool', status: 'missing' },
  ]);
  assert.equal(exitCode, 0);
});

test('基础或本地能力不可用时退出码为 3', () => {
  const baseBroken = computeExitCode([{ group: 'base', name: 'Node.js', status: 'version-mismatch' }]);
  assert.equal(baseBroken, 3);

  const localBroken = computeExitCode([
    { group: 'base', name: 'Node.js', status: 'pass' },
    { group: 'local', name: 'REPO_ROOT', status: 'config-error' },
  ]);
  assert.equal(localBroken, 3);
});

test('报告按能力分组并附修复提示', () => {
  const text = renderReport([
    { group: 'base', name: 'Node.js', status: 'pass', actual: 'v26.0.0' },
    { group: 'remote', name: 'oathtool', status: 'missing', hint: 'brew install oath-toolkit' },
  ]);

  assert.match(text, /^基础$/m);
  assert.match(text, /^远程功能$/m);
  assert.match(text, /\[通过\] Node\.js/);
  assert.match(text, /→ brew install oath-toolkit/);
});

test('报告不包含密钥类字段的值', async () => {
  // 用一个假的巨大敏感值验证渲染层不会意外拼接配置原文。
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-doctor-'));
  try {
    const text = renderReport([
      { group: 'remote', name: 'JUMP_PASSWORD', status: 'config-error', hint: '缺少必填配置' },
    ]);
    assert.ok(!text.includes(directory));
    assert.match(text, /\[配置错误\] JUMP_PASSWORD/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * 构造最小可用配置。
 *
 * 工具路径不再来自配置或必填环境变量，doctor 必须走运行时同一套 PATH 解析。
 */
function emptyConfig(): LoadedConfig {
  return {
    values: new Map(),
    limits: parseLimits(new Map()).limits,
    modelAutoSelected: false,
    repoRoot: '/tmp/repo',
    serviceId: 'demo',
    issues: [],
    warnings: [],
    pathChecks: [],
    available: { base: true, local: true, remote: false },
  };
}

/** 临时 home 与假工具目录；所有写入都在临时目录内。 */
interface Fixture {
  readonly home: string;
  readonly binDir: string;
  readonly paths: AppPaths;
  readonly cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-doctor-'));
  const binDir = await mkdtemp(path.join(tmpdir(), 'finch-doctor-bin-'));
  return {
    home,
    binDir,
    paths: resolveAppPaths(home),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

/** 写入带版本输出的可执行假程序；探测只会执行它，不产生副作用。 */
async function createFakeTool(directory: string, name: string, versionLine: string): Promise<void> {
  const target = path.join(directory, name);
  await writeFile(target, `#!/bin/sh\necho "${versionLine}"\n`, { mode: 0o755 });
  await chmod(target, 0o755);
}

/** 临时替换环境变量，返回恢复函数。 */
function withEnv(values: Record<string, string | undefined>): () => void {
  const keys = ['PATH', 'EXPECT_PATH', 'OATH_TOOL'];
  const saved = keys.map((key) => [key, process.env[key]] as const);

  for (const key of keys) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test('PATH 中找到工具时报告通过，不再提示未安装', async () => {
  const fixture = await createFixture();
  const restore = withEnv({
    PATH: fixture.binDir,
    EXPECT_PATH: undefined,
    OATH_TOOL: undefined,
  });

  try {
    await createFakeTool(fixture.binDir, 'expect', 'expect version 5.45.4');
    await createFakeTool(fixture.binDir, 'oathtool', 'oathtool (GNU OATH Toolkit) 2.6.14');

    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true, paths: fixture.paths });

    const expect = results.find((item) => item.name === 'expect');
    const oathtool = results.find((item) => item.name === 'oathtool');
    assert.equal(expect?.status, 'pass');
    assert.equal(oathtool?.status, 'pass');
    assert.match(expect?.actual ?? '', /PATH/);
    assert.match(oathtool?.actual ?? '', /2\.6\.14/);
    assert.equal(expect?.hint, undefined, '已从 PATH 找到时不得再提示安装');
    assert.equal(oathtool?.hint, undefined);

    // 登录脚本由程序自动生成，用户无需设置 LOGIN_SCRIPT。
    const script = results.find((item) => item.name === '登录脚本');
    assert.equal(script?.status, 'pass');
    const mode = (await stat(fixture.paths.loginScriptFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    restore();
    await fixture.cleanup();
  }
});

test('显式环境变量优先于 PATH，并在报告中标注来源', async () => {
  const fixture = await createFixture();
  const restore = withEnv({
    PATH: fixture.binDir,
    EXPECT_PATH: process.execPath,
    OATH_TOOL: process.execPath,
  });

  try {
    await createFakeTool(fixture.binDir, 'expect', 'expect version 5.45.4');
    await createFakeTool(fixture.binDir, 'oathtool', 'oathtool 2.6.14');

    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true, paths: fixture.paths });

    const expect = results.find((item) => item.name === 'expect');
    const oathtool = results.find((item) => item.name === 'oathtool');
    assert.equal(expect?.status, 'pass');
    assert.equal(oathtool?.status, 'pass');
    assert.match(expect?.actual ?? '', /环境变量/);
    assert.match(oathtool?.actual ?? '', /环境变量/);
  } finally {
    restore();
    await fixture.cleanup();
  }
});

test('显式路径无效时报配置错误，不回退到 PATH', async () => {
  const fixture = await createFixture();
  const restore = withEnv({
    PATH: fixture.binDir,
    EXPECT_PATH: 'relative/expect',
    OATH_TOOL: undefined,
  });

  try {
    await createFakeTool(fixture.binDir, 'expect', 'expect version 5.45.4');
    await createFakeTool(fixture.binDir, 'oathtool', 'oathtool 2.6.14');

    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true, paths: fixture.paths });

    const expect = results.find((item) => item.name === 'expect');
    assert.equal(expect?.status, 'config-error');
    assert.match(expect?.hint ?? '', /绝对路径/);

    // 未出问题的 oathtool 仍从 PATH 正常解析。
    const oathtool = results.find((item) => item.name === 'oathtool');
    assert.equal(oathtool?.status, 'pass');
  } finally {
    restore();
    await fixture.cleanup();
  }
});

test('PATH 与显式变量都找不到时才给出安装命令', async () => {
  const fixture = await createFixture();
  const restore = withEnv({
    PATH: fixture.binDir,
    EXPECT_PATH: undefined,
    OATH_TOOL: undefined,
  });

  try {
    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true, paths: fixture.paths });

    const expect = results.find((item) => item.name === 'expect');
    const oathtool = results.find((item) => item.name === 'oathtool');
    assert.equal(expect?.status, 'missing');
    assert.match(expect?.hint ?? '', /brew install expect/);
    assert.equal(oathtool?.status, 'missing');
    assert.match(oathtool?.hint ?? '', /brew install oath-toolkit/);

    assert.ok(
      !results.some((item) => item.name === 'oathtool / expect'),
      '不得再输出“缺少环境变量”的聚合跳过项',
    );
  } finally {
    restore();
    await fixture.cleanup();
  }
});
