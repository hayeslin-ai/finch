/**
 * doctor 检查与报告测试。
 *
 * WHY：缺少 oathtool 时本地诊断必须仍可用；doctor 不能因为远程依赖缺失
 * 就整体失败。测试用不存在与可疑的假路径验证这些分支，不执行真实 OTP。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkRemoteTools, probeExecutable } from '../../src/doctor/checks.js';
import { computeExitCode, renderReport } from '../../src/doctor/report.js';
import { checkNodeVersion, runDoctorChecks } from '../../src/cli/doctor-command.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { parseLimits } from '../../src/config/limits.js';

test('Node 版本低于引擎要求时报告不符', () => {
  assert.equal(checkNodeVersion('v22.19.0').status, 'pass');
  assert.equal(checkNodeVersion('v26.0.0').status, 'pass');
  assert.equal(checkNodeVersion('v22.18.0').status, 'version-mismatch');
  assert.equal(checkNodeVersion('v20.11.0').status, 'version-mismatch');

  const mismatch = checkNodeVersion('v20.11.0');
  assert.equal(mismatch.expected, '>=22.19');
  assert.ok(mismatch.hint !== undefined);
});

test('未配置远程功能时跳过工具检查，不执行任何探测', async () => {
  const results = await checkRemoteTools({
    oathTool: '/definitely/not/executed',
    expectPath: '/definitely/not/executed',
    enabled: false,
  });

  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'skipped'));
});

test('缺少 oathtool 时给出可复制安装命令，而非笼统失败', async () => {
  const results = await checkRemoteTools({
    oathTool: '/nonexistent/oathtool',
    expectPath: '/nonexistent/expect',
    enabled: true,
  });

  const oathtool = results.find((result) => result.name === 'oathtool');
  assert.ok(oathtool !== undefined);
  assert.equal(oathtool.status, 'missing');
  assert.match(oathtool.hint ?? '', /brew install oath-toolkit/);

  const expect = results.find((result) => result.name === 'expect');
  assert.equal(expect?.status, 'missing');
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
 * 构造最小可用的配置夹具。
 *
 * WHY：doctor 的远程探测不能依赖 .env 解析结果——
 * EXPECT_PATH / LOGIN_SCRIPT / OATH_TOOL 只从进程环境变量读取。
 * 这里刻意让 values 为空，正是为了暴露「读错来源就永远 skipped」这个缺陷。
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

/** 临时替换三个工具环境变量，返回恢复函数。 */
function withRemoteEnv(values: Record<string, string | undefined>): () => void {
  const keys = ['EXPECT_PATH', 'LOGIN_SCRIPT', 'OATH_TOOL'];
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

test('doctor --remote 从进程环境变量读取工具路径，而不是配置文件', async () => {
  // 用 node 自己冒充两个外部程序：探测只执行 --version，无副作用。
  const restore = withRemoteEnv({
    EXPECT_PATH: process.execPath,
    LOGIN_SCRIPT: process.execPath,
    OATH_TOOL: process.execPath,
  });

  try {
    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true });
    const tools = results.filter((item) => item.name === 'oathtool' || item.name === 'expect');

    assert.equal(tools.length, 2, '配齐环境变量后必须真正探测，而不是整组跳过');
    assert.ok(
      !tools.some((item) => item.status === 'skipped'),
      '配置齐备时不得报告 skipped——那会把「已配好」说成「未配置」',
    );
  } finally {
    restore();
  }
});

test('doctor --remote 缺少环境变量时明确列出缺了哪几个', async () => {
  const restore = withRemoteEnv({
    EXPECT_PATH: undefined,
    LOGIN_SCRIPT: undefined,
    OATH_TOOL: undefined,
  });

  try {
    const results = await runDoctorChecks(emptyConfig(), { checkRemote: true });
    const skipped = results.find((item) => item.name === 'oathtool / expect');

    assert.equal(skipped?.status, 'skipped');
    assert.match(skipped?.hint ?? '', /EXPECT_PATH/);
    assert.match(skipped?.hint ?? '', /OATH_TOOL/);
  } finally {
    restore();
  }
});
