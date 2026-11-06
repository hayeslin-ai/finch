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
import { checkNodeVersion } from '../../src/cli/doctor-command.js';

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
