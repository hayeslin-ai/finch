/**
 * 远程连接编排测试（纯内存）。
 *
 * 验证：身份缺失时拒绝就绪、失败时释放传输、成功才记录最近目标、
 * 环境变量缺失时明确列出缺项而不猜默认路径。
 */
import assert from 'node:assert/strict';
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

test('环境变量缺失时列出全部缺项，不猜默认路径', () => {
  const missingAll = readRemoteTools({});
  assert.equal(missingAll.ok, false);
  if (!missingAll.ok) {
    assert.deepEqual(missingAll.missing, ['EXPECT_PATH', 'LOGIN_SCRIPT', 'OATH_TOOL']);
  }

  const partial = readRemoteTools({ EXPECT_PATH: '/usr/bin/expect', OATH_TOOL: '  ' });
  assert.equal(partial.ok, false);
  if (!partial.ok) {
    assert.deepEqual(partial.missing, ['LOGIN_SCRIPT', 'OATH_TOOL'], '空白值也视为缺失');
  }
});

test('环境变量齐全时可读取配置', () => {
  const result = readRemoteTools({
    EXPECT_PATH: '/usr/bin/expect',
    LOGIN_SCRIPT: '/opt/login.exp',
    OATH_TOOL: '/opt/homebrew/bin/oathtool',
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.config.loginScript, '/opt/login.exp');
  }
});
