/**
 * 远程会话状态机测试（纯内存，不启动任何进程）。
 *
 * WHY：远程 shell 不能在单元测试里真实连接——既慢、可能残留进程，
 * 也可能对生产资产造成意外操作。这里用内存传输精确控制每一行输入输出，
 * 覆盖就绪判定、请求匹配、超时与失败关闭等关键分支。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeFrame } from '../../src/remote/protocol.js';
import { RemoteSession } from '../../src/remote/session.js';
import type { RemoteTransport } from '../../src/remote/transport.js';

/** 内存传输：记录写入行，允许测试注入输出行。 */
class MemoryTransport implements RemoteTransport {
  readonly written: string[] = [];
  private lineHandler: ((line: string) => void) | undefined;
  private exitHandler: (() => void) | undefined;
  closed = false;

  write(line: string): void {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(handler: () => void): void {
    this.exitHandler = handler;
  }

  close(): void {
    this.closed = true;
  }

  emit(line: string): void {
    this.lineHandler?.(line);
  }

  exit(): void {
    this.exitHandler?.();
  }

  lastRequest(): { op: string; id: number; nonce: string; seq: number } {
    const last = this.written.at(-1);
    assert.ok(last !== undefined, '应已写入请求');
    return decodeFrame(last);
  }
}

function readyFrame(payload = 'host=h1;user=app;dir=logs'): string {
  return JSON.stringify({ v: 1, op: 'READY', id: 0, nonce: 'ready', seq: 0, payload });
}

function responseFor(
  request: { op: string; id: number; nonce: string; seq: number },
  op: string,
  payload?: string,
): string {
  return JSON.stringify({
    v: 1,
    op,
    id: request.id,
    nonce: request.nonce,
    seq: request.seq,
    ...(payload === undefined ? {} : { payload }),
  });
}

/** 建立已就绪的会话，返回会话与传输。 */
async function connectedSession(connectTimeoutMs = 1_000) {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs, queryTimeoutMs: 1_000 });
  const attaching = session.attach(transport);
  transport.emit(readyFrame());
  const result = await attaching;
  return { session, transport, result };
}

test('收到 READY 后进入就绪，并保留身份摘要', async () => {
  const { session, result } = await connectedSession();
  assert.equal(result.ok, true, result.message ?? '');
  assert.equal(session.currentState, 'READY');
  assert.match(session.identity, /host=h1/);
});

test('未收到 READY 时连接超时并失败关闭', async () => {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs: 50, queryTimeoutMs: 50 });

  const result = await session.attach(transport);
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /超时/);
  assert.equal(session.currentState, 'FAILED');
  assert.equal(transport.closed, true, '失败后必须释放传输');
});

test('就绪后可执行查询，并正确匹配响应', async () => {
  const { session, transport } = await connectedSession();

  const querying = session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  assert.equal(request.op, 'LIST');

  transport.emit(responseFor(request, 'DATA', 'server.log'));
  transport.emit(responseFor(request, 'LIST', 'listed'));

  const result = await querying;
  assert.equal(result.ok, true, result.message ?? '');
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0]?.payload, 'server.log');
  assert.equal(session.currentState, 'READY');
});

test('未就绪时拒绝查询，且不写入任何字节', async () => {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 });

  const result = await session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /未就绪/);
  assert.equal(transport.written.length, 0);
});

test('非法子目录在本地被拒，不会发送到远端', async () => {
  const { session, transport } = await connectedSession();
  const before = transport.written.length;

  const result = await session.query({ kind: 'LIST', subDir: '../etc', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /子目录/);
  assert.equal(transport.written.length, before, '拒绝时不得写入');
  assert.equal(session.currentState, 'READY', '本地拒绝不应破坏连接');
});

test('nonce 不匹配的响应导致失败关闭', async () => {
  const { session, transport } = await connectedSession();

  const querying = session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  transport.emit(
    JSON.stringify({ v: 1, op: 'LIST', id: request.id, nonce: 'ffffffffffffffff', seq: request.seq }),
  );

  const result = await querying;
  assert.equal(result.ok, false);
  assert.equal(session.currentState, 'TERMINATION_UNKNOWN');
});

test('查询超时进入未知终止，不谎报成功', async () => {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs: 1_000, queryTimeoutMs: 50 });
  const attaching = session.attach(transport);
  transport.emit(readyFrame());
  await attaching;

  const result = await session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /超时/);
  assert.equal(session.currentState, 'TERMINATION_UNKNOWN');
});

test('运行期非协议输出导致失败关闭', async () => {
  const { session, transport } = await connectedSession();

  const querying = session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  transport.emit('bash-3.2$ 提示符回显');
  transport.emit(responseFor(request, 'LIST', 'listed'));

  const result = await querying;
  assert.equal(result.ok, false);
  assert.equal(session.currentState, 'TERMINATION_UNKNOWN');
});

test('远端返回 ERROR 时如实传递，不伪造成功', async () => {
  const { session, transport } = await connectedSession();

  const querying = session.query({ kind: 'SEARCH', terms: ['NPE'], before: 80, after: 80 });
  const request = transport.lastRequest();
  transport.emit(responseFor(request, 'ERROR', '远端检索失败'));

  const result = await querying;
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /远端检索失败/);
  assert.equal(session.currentState, 'READY', '远端业务错误不算协议错乱');
});

test('桥接进程意外退出时标记未知终止', async () => {
  const { session, transport } = await connectedSession();

  const querying = session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  transport.exit();

  const result = await querying;
  assert.equal(result.ok, false);
  assert.equal(session.currentState, 'TERMINATION_UNKNOWN');
});

test('就绪时关闭会发送 CLOSE；未知终止时不再发送任何命令', async () => {
  const ready = await connectedSession();
  await ready.session.close();
  assert.equal(ready.transport.lastRequest().op, 'CLOSE');
  assert.equal(ready.transport.closed, true);

  const broken = await connectedSession();
  const querying = broken.session.query({ kind: 'LIST', subDir: '', maxDepth: 2 });
  broken.transport.emit('non-protocol line');
  await querying;

  const countBefore = broken.transport.written.length;
  await broken.session.close();
  assert.equal(
    broken.transport.written.length,
    countBefore,
    '未知终止状态下不得再发送任何命令',
  );
});
