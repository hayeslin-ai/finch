/**
 * 远程连接编排测试（纯内存）。
 *
 * 验证：身份缺失时拒绝就绪、失败时释放传输、成功才记录最近目标、
 * 工具默认从 PATH 解析、显式环境变量优先且无效时不回退。
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { connectRemote, readRemoteTools } from '../../src/remote/connector.js';
import { RemoteSession } from '../../src/remote/session.js';
import type { RemoteTransport } from '../../src/remote/transport.js';

/** 内存传输；可选地不发 READY，模拟登录失败。 */
class FakeTransport implements RemoteTransport {
  readonly written: string[] = [];
  closed = false;
  private lineHandler: ((line: string) => void) | undefined;

  constructor(private readonly readyPayload: string | undefined) {}

  write(line: string): void {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
    if (this.readyPayload !== undefined) {
      // READY 必须异步送达，否则 attach 尚未注册回调就会丢失。
      queueMicrotask(() =>
        handler(
          JSON.stringify({
            v: 1,
            op: 'READY',
            id: 0,
            nonce: 'ready',
            seq: 0,
            payload: this.readyPayload,
          }),
        ),
      );
    }
  }

  onExit(): void {
    // 本测试不模拟退出。
  }

  close(): void {
    this.closed = true;
  }
}

function sessionFactory(timeoutMs = 500): () => RemoteSession {
  return () => new RemoteSession({ connectTimeoutMs: timeoutMs, queryTimeoutMs: timeoutMs });
}

test('就绪且提供身份时连接成功，并记录最近目标', async () => {
  const remembered: string[] = [];
  const transport = new FakeTransport('host=h1;user=app;dir=logs');

  const result = await connectRemote(
    '22.50.14.22',
    { expectPath: '/usr/bin/expect', loginScript: '/x.exp', oathTool: '/y' },
    {
      createTransport: () => transport,
      createSession: sessionFactory(),
      remember: async (target) => {
        remembered.push(target);
      },
    },
  );

  assert.equal(result.ok, true, result.message);
  assert.match(result.identity ?? '', /host=h1/);
  assert.deepEqual(remembered, ['22.50.14.22'], '只有成功连接才记录');
});

test('未提供身份时拒绝就绪并关闭连接', async () => {
  const transport = new FakeTransport('');

  const result = await connectRemote(
    '22.50.14.22',
    { expectPath: '/usr/bin/expect', loginScript: '/x.exp', oathTool: '/y' },
    { createTransport: () => transport, createSession: sessionFactory() },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /身份核对/);
  assert.equal(transport.closed, true, '身份缺失必须释放连接');
});

test('未收到 READY 时失败，且不记录目标', async () => {
  const transport = new FakeTransport(undefined);
  const remembered: string[] = [];

  const result = await connectRemote(
    '22.50.14.22',
    { expectPath: '/usr/bin/expect', loginScript: '/x.exp', oathTool: '/y' },
    {
      createTransport: () => transport,
      createSession: sessionFactory(100),
      remember: async (target) => {
        remembered.push(target);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.deepEqual(remembered, [], '失败不得记录为最近使用');
});

/** 在临时目录创建可执行的假程序；不执行任何真实工具。 */
async function createFakeTool(directory: string, name: string): Promise<void> {
  const target = path.join(directory, name);
  await writeFile(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(target, 0o755);
}

test('未设置环境变量时从 PATH 查找工具', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-tools-'));
  try {
    await createFakeTool(directory, 'expect');
    await createFakeTool(directory, 'oathtool');

    const result = readRemoteTools({ PATH: directory }, '/config/login_agent.exp');

    assert.equal(result.ok, true);
    assert.equal(result.expect.path, path.join(directory, 'expect'));
    assert.equal(result.expect.source, 'path');
    assert.equal(result.oathtool.path, path.join(directory, 'oathtool'));
    assert.equal(result.oathtool.source, 'path');
    assert.equal(result.loginScript, '/config/login_agent.exp');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('显式环境变量优先于 PATH', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-tools-'));
  try {
    await createFakeTool(directory, 'expect');
    await createFakeTool(directory, 'oathtool');

    const result = readRemoteTools(
      {
        PATH: directory,
        EXPECT_PATH: process.execPath,
        OATH_TOOL: process.execPath,
      },
      '/config/login_agent.exp',
    );

    assert.equal(result.ok, true);
    assert.equal(result.expect.path, process.execPath);
    assert.equal(result.expect.source, 'env');
    assert.equal(result.oathtool.source, 'env');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('显式路径无效时报配置错误，不回退到 PATH', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-tools-'));
  try {
    await createFakeTool(directory, 'expect');
    await createFakeTool(directory, 'oathtool');

    const relative = readRemoteTools(
      { PATH: directory, EXPECT_PATH: 'relative/expect' },
      '/config/login_agent.exp',
    );
    assert.equal(relative.ok, false);
    assert.equal(relative.expect.path, undefined, '无效显式路径不得回退到 PATH');
    assert.match(relative.expect.error ?? '', /绝对路径/);

    // PATH 中仍有 oathtool，说明只有出问题的那个工具被拒绝。
    assert.equal(relative.oathtool.path, path.join(directory, 'oathtool'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('PATH 与显式变量都找不到时给出安装命令', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-tools-'));
  try {
    const result = readRemoteTools({ PATH: directory }, '/config/login_agent.exp');

    assert.equal(result.ok, false);
    assert.equal(result.expect.path, undefined);
    assert.match(result.expect.installHint, /brew install expect/);
    assert.equal(result.oathtool.path, undefined);
    assert.match(result.oathtool.installHint, /brew install oath-toolkit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
