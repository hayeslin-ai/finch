/**
 * 远程授权与配额测试（纯内存）。
 *
 * 关键不变量：
 * - 未授权时任何查询都不发送字节；
 * - 每次尝试都计数，重试不能绕过上限；
 * - 授权结束后迟到结果一律丢弃；
 * - 审计记录始终带 grant 编号。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseLimits } from '../../src/config/limits.js';
import { AuditLedger } from '../../src/core/audit.js';
import { RemoteAccess } from '../../src/remote/access.js';
import { decodeFrame } from '../../src/remote/protocol.js';
import { RemoteSession } from '../../src/remote/session.js';
import type { RemoteTransport } from '../../src/remote/transport.js';

class MemoryTransport implements RemoteTransport {
  readonly written: string[] = [];
  closed = false;
  private lineHandler: ((line: string) => void) | undefined;
  private exitHandler: (() => void) | undefined;

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

  lastRequest(): { op: string; id: number; nonce: string; seq: number } {
    const last = this.written.at(-1);
    assert.ok(last !== undefined, '应已写入请求');
    return decodeFrame(last);
  }
}

const READY = JSON.stringify({
  v: 1,
  op: 'READY',
  id: 0,
  nonce: 'ready',
  seq: 0,
  payload: 'host=target-a;user=app;dir=/home/app/logs;caps=grep=1,zgrep=1,gzip=1,sed=1,find=1,findprintf=1,pipefail=1',
});

function done(
  request: { id: number; nonce: string; seq: number },
  body: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    v: 1,
    op: 'DONE',
    id: request.id,
    nonce: request.nonce,
    seq: request.seq,
    payload: JSON.stringify({
      status: 'ok',
      exit: 0,
      matched: body !== '',
      truncated: false,
      bytes: body.length,
      lines: body === '' ? 0 : body.split('\n').length,
      ...overrides,
    }),
  });
}

function data(
  request: { id: number; nonce: string; seq: number },
  payload: string,
): string {
  return JSON.stringify({
    v: 1,
    op: 'DATA',
    id: request.id,
    nonce: request.nonce,
    seq: request.seq,
    payload,
  });
}

const LIMITS = parseLimits(new Map()).limits;

async function setup(options: { maxQueries?: number; canWork?: () => boolean } = {}) {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 });
  const attaching = session.attach(transport);
  transport.emit(READY);
  const attached = await attaching;
  assert.equal(attached.ok, true, attached.message ?? '');

  const audit = new AuditLedger();
  const access = new RemoteAccess({
    audit,
    canWork: options.canWork ?? (() => true),
    limits: LIMITS,
    queryTimeoutMs: 1_000,
  });
  access.begin(session, {
    id: 'grant-1',
    target: '22.50.14.22',
    traceId: 'trace-abc',
    logDir: '/home/app/logs',
    maxQueries: options.maxQueries ?? 20,
    maxFiles: 10,
  });

  return { transport, session, access, audit };
}

/** 让一次 LIST 成功并登记文件。 */
async function listOnce(transport: MemoryTransport, access: RemoteAccess) {
  const pending = access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  transport.emit(
    data(
      request,
      '1762600000.0\t2048\t/home/app/logs/server.log\n1762500000.0\t1024\t/home/app/logs/server.log.1.gz',
    ),
  );
  transport.emit(done(request, 'two files'));
  return pending;
}

test('未授权时拒绝查询，且不发送任何字节', async () => {
  const transport = new MemoryTransport();
  const audit = new AuditLedger();
  const access = new RemoteAccess({ audit, canWork: () => true, limits: LIMITS, queryTimeoutMs: 1_000 });

  const result = await access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /未授权/);
  assert.equal(transport.written.length, 0);
  assert.equal(audit.size, 0, '未授权尝试不应留下远程审计记录');
});

test('LIST 成功后登记 fileRef，最新文件为 f-1', async () => {
  const { transport, access, audit } = await setup();
  const result = await listOnce(transport, access);

  assert.equal(result.ok, true, result.message ?? '');
  assert.deepEqual(
    access.files.map((file) => [file.ref, file.name, file.compressed]),
    [
      ['f-1', 'server.log', false],
      ['f-2', 'server.log.1.gz', true],
    ],
  );
  assert.equal(audit.recent(1)[0]?.operation, 'LIST');
  assert.equal(audit.recent(1)[0]?.grant, 'grant-1');
});

test('未知 fileRef 被拒绝，不会把路径送到远端', async () => {
  const { transport, access } = await setup();
  await listOnce(transport, access);

  const resolved = access.resolveFiles(['f-9']);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? '' : resolved.message, /未知文件编号/);

  const before = transport.written.length;
  assert.equal(before, transport.written.length, '拒绝不产生新写入');
});

test('未枚举时搜索被拒绝', async () => {
  const { transport, access } = await setup();
  const resolved = access.resolveFiles([]);
  assert.equal(resolved.ok, false);
  assert.match(resolved.ok ? '' : resolved.message, /尚未枚举/);
  assert.equal(transport.written.length, 0, '被拒绝时不得写任何查询帧');
});

test('查询次数耗尽后拒绝新查询，并说明原因', async () => {
  const { transport, access } = await setup({ maxQueries: 2 });

  await listOnce(transport, access);
  await listOnce(transport, access);
  assert.equal(access.queriesUsed, 2);

  const third = await access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(third.ok, false);
  assert.match(third.message ?? '', /查询次数已用尽/);
});

test('预算耗尽时拒绝新查询', async () => {
  const { transport, access } = await setup({ canWork: () => false });
  const result = await access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /预算/);
});

test('失败也计数，重试不能绕过上限', async () => {
  const { transport, access } = await setup({ maxQueries: 2 });
  await listOnce(transport, access);

  const pending = access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  transport.emit(
    JSON.stringify({
      v: 1,
      op: 'ERROR',
      id: request.id,
      nonce: request.nonce,
      seq: request.seq,
      payload: '远端枚举失败',
    }),
  );
  const failed = await pending;
  assert.equal(failed.ok, false);
  assert.equal(access.queriesUsed, 2, '失败同样消耗配额');

  const blocked = await access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message ?? '', /查询次数已用尽/);
});

test('授权结束后迟到结果被丢弃', async () => {
  const { transport, access } = await setup();

  const pending = access.list({ kind: 'LIST', subDir: '', maxDepth: 2 });
  const request = transport.lastRequest();
  await access.end();

  transport.emit(data(request, '1762600000.0\t1\t/home/app/logs/server.log'));
  transport.emit(done(request, 'stale'));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /授权已结束/);
  assert.equal(access.files.length, 0, '过期结果不得写入枚举表');
});

test('授权注记只含目标、traceId 与配额，不含路径', async () => {
  const { transport, access } = await setup();
  await listOnce(transport, access);

  const note = access.renderNote();
  assert.match(note, /target="22\.50\.14\.22"/);
  assert.match(note, /trace="trace-abc"/);
  assert.match(note, /queries="1\/20"/);
  assert.match(note, /files="2\/10"/);
  assert.ok(!note.includes('/home/app/logs'), '注记不得暴露远端绝对路径');
});
