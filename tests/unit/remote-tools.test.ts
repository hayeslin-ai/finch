/**
 * 远程工具测试（内存传输，不启动任何进程）。
 *
 * 覆盖模型可见的三条路径：枚举 → 搜索 → 读取，以及未授权、未知编号、
 * 无命中、截断、脱敏与证据登记。断言以“模型实际看到的文本”为准，
 * 因为泄露与误报最终都体现在这里。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRemoteTools } from '../../src/agent/remote-tools.js';
import { parseLimits } from '../../src/config/limits.js';
import { AuditLedger } from '../../src/core/audit.js';
import { EvidenceStore } from '../../src/core/evidence.js';
import { RemoteAccess } from '../../src/remote/access.js';
import { decodeFrame } from '../../src/remote/protocol.js';
import { RemoteSession } from '../../src/remote/session.js';
import type { RemoteTransport } from '../../src/remote/transport.js';
import { Redactor } from '../../src/security/redactor.js';

class MemoryTransport implements RemoteTransport {
  readonly written: string[] = [];
  closed = false;
  private lineHandler: ((line: string) => void) | undefined;

  write(line: string): void {
    this.written.push(line);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(): void {
    // 本测试不模拟退出。
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

function frame(
  request: { id: number; nonce: string; seq: number },
  op: 'DATA' | 'DONE' | 'ERROR',
  payload: string,
): string {
  return JSON.stringify({
    v: 1,
    op,
    id: request.id,
    nonce: request.nonce,
    seq: request.seq,
    payload,
  });
}

function donePayload(
  body: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    status: 'ok',
    exit: 0,
    matched: body !== '',
    truncated: false,
    bytes: body.length,
    lines: body === '' ? 0 : body.split('\n').length,
    ...overrides,
  });
}

type CallableTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
};

async function callTool(tool: unknown, params: unknown) {
  const callable = tool as CallableTool;
  return callable.execute('test-call', params, undefined, undefined, undefined);
}

const LIMITS = parseLimits(new Map()).limits;

async function setup(options: { authorized?: boolean } = {}) {
  const transport = new MemoryTransport();
  const session = new RemoteSession({ connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 });
  const attaching = session.attach(transport);
  transport.emit(READY);
  await attaching;

  const audit = new AuditLedger();
  const evidence = new EvidenceStore();
  const redactor = new Redactor();
  const access = new RemoteAccess({ audit, canWork: () => true, limits: LIMITS, queryTimeoutMs: 1_000 });

  if (options.authorized !== false) {
    access.begin(session, {
      id: 'grant-1',
      target: '22.50.0.1',
      intent: '定位订单创建失败原因',
      logDir: '/home/app/logs',
      maxQueries: LIMITS.MAX_QUERY_COUNT,
      maxFiles: LIMITS.MAX_FILES,
    });
  }

  const tools = createRemoteTools({
    access,
    evidence,
    redactor,
    limits: LIMITS,
    target: () => access.currentGrant?.target ?? '',
  });
  const byName = new Map(tools.map((tool) => [(tool as CallableTool).name, tool]));

  return { transport, session, access, evidence, audit, byName };
}

/** 完成一次 LIST，登记两个文件。 */
async function primeListing(transport: MemoryTransport, tool: unknown) {
  const pending = callTool(tool, {});
  const request = transport.lastRequest();
  transport.emit(
    frame(
      request,
      'DATA',
      '1762600000.0\t2048\t/home/app/logs/server.log\n1762500000.0\t1024\t/home/app/logs/server.log.1.gz',
    ),
  );
  transport.emit(frame(request, 'DONE', donePayload('two files')));
  const result = await pending;
  assert.equal(result.details['files'], 2, result.content[0]?.text ?? '');
  return result;
}

test('未授权时三个工具都返回可操作的拒绝原因', async () => {
  const { byName, transport } = await setup({ authorized: false });
  const before = transport.written.length;

  for (const name of ['remote_log_list', 'remote_log_search', 'remote_log_read']) {
    const tool = byName.get(name);
    assert.ok(tool !== undefined);
    const result = await callTool(tool, { terms: ['NPE'], fileRef: 'f-1', startLine: 1, endLine: 10 });
    assert.match(result.content[0]?.text ?? '', /未授权/);
  }
  assert.equal(transport.written.length, before, '未授权不得发送任何字节');
});

test('LIST 返回编号、时间与大小，且不暴露绝对路径', async () => {
  const { transport, byName } = await setup();
  const result = await primeListing(transport, byName.get('remote_log_list'));

  const text = result.content[0]?.text ?? '';
  assert.match(text, /f-1/);
  assert.match(text, /server\.log/);
  assert.ok(!text.includes('/home/app/logs'), '模型可见文本不得包含远端绝对路径');
});

test('SEARCH 命中后登记证据并映射为 fileRef', async () => {
  const { transport, byName, evidence } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const searching = callTool(byName.get('remote_log_search'), { terms: ['NullPointerException'] });
  const request = transport.lastRequest();
  assert.equal(request.op, 'SEARCH');
  transport.emit(
    frame(request, 'DATA', '/home/app/logs/server.log:42:java.lang.NullPointerException: boom'),
  );
  transport.emit(frame(request, 'DONE', donePayload('one hit')));

  const result = await searching;
  const text = result.content[0]?.text ?? '';
  assert.match(text, /EV-\d{3}/);
  assert.match(text, /f-1:42:java\.lang\.NullPointerException/, '命中行应使用 fileRef 而不是绝对路径');
  assert.equal(evidence.all().length, 1);
  assert.equal(evidence.all()[0]?.sourceKind, 'remote');
  assert.equal(evidence.all()[0]?.sourceLabel, '22.50.0.1');
});

test('SEARCH 无命中时明确说明，不登记空证据', async () => {
  const { transport, byName, evidence } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const searching = callTool(byName.get('remote_log_search'), { terms: ['NoSuchThing'] });
  const request = transport.lastRequest();
  transport.emit(frame(request, 'DONE', donePayload('', { status: 'nomatch', exit: 1, matched: false })));

  const result = await searching;
  assert.match(result.content[0]?.text ?? '', /未命中/);
  assert.equal(evidence.all().length, 0);
});

test('SEARCH 远端命令失败时如实报告，不伪装成未命中', async () => {
  const { transport, byName } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const searching = callTool(byName.get('remote_log_search'), { terms: ['NPE'] });
  const request = transport.lastRequest();
  transport.emit(frame(request, 'DONE', donePayload('', { status: 'error', exit: 2 })));

  const result = await searching;
  const text = result.content[0]?.text ?? '';
  assert.match(text, /退出码 2/);
  assert.ok(!text.includes('未命中'), '命令失败不得呈现为未命中');
});

test('SEARCH 结果在进入模型与证据之前脱敏', async () => {
  const { transport, byName, evidence } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const searching = callTool(byName.get('remote_log_search'), { terms: ['password'] });
  const request = transport.lastRequest();
  transport.emit(
    frame(request, 'DATA', '/home/app/logs/server.log:7:config password=hunter2 loaded'),
  );
  transport.emit(frame(request, 'DONE', donePayload('one hit')));

  const result = await searching;
  const text = result.content[0]?.text ?? '';
  assert.ok(!text.includes('hunter2'), '模型文本不得包含明文密码');
  assert.ok(!(evidence.all()[0]?.text ?? '').includes('hunter2'), '证据必须已脱敏');
});

test('READ 读取区间并补行号、登记证据', async () => {
  const { transport, byName, evidence } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const reading = callTool(byName.get('remote_log_read'), {
    fileRef: 'f-1',
    startLine: 10,
    endLine: 12,
  });
  const request = transport.lastRequest();
  assert.equal(request.op, 'READ');
  transport.emit(frame(request, 'DATA', 'line ten\nline eleven\nline twelve'));
  transport.emit(frame(request, 'DONE', donePayload('three lines', { lines: 3 })));

  const result = await reading;
  const text = result.content[0]?.text ?? '';
  assert.match(text, /10: line ten/);
  assert.match(text, /12: line twelve/);
  assert.equal(evidence.all()[0]?.location?.startLine, 10);
  assert.equal(evidence.all()[0]?.location?.endLine, 12);
});

test('READ 未知 fileRef 在本地拒绝，不发送任何帧', async () => {
  const { transport, byName } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));
  const before = transport.written.length;

  const result = await callTool(byName.get('remote_log_read'), {
    fileRef: 'f-99',
    startLine: 1,
    endLine: 5,
  });

  assert.match(result.content[0]?.text ?? '', /未知文件编号/);
  assert.equal(transport.written.length, before, '本地拒绝不得发送请求');
});

test('READ 行数超限在本地拒绝', async () => {
  const { transport, byName } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));
  const before = transport.written.length;

  const result = await callTool(byName.get('remote_log_read'), {
    fileRef: 'f-1',
    startLine: 1,
    endLine: 5000,
  });

  assert.match(result.content[0]?.text ?? '', /不得超过/);
  assert.equal(transport.written.length, before);
});

test('输出被截断时证据与消息都如实标记', async () => {
  const { transport, byName, evidence } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const reading = callTool(byName.get('remote_log_read'), {
    fileRef: 'f-1',
    startLine: 1,
    endLine: 2,
  });
  const request = transport.lastRequest();
  transport.emit(frame(request, 'DATA', 'one\ntwo'));
  transport.emit(frame(request, 'DONE', donePayload('one\ntwo', { truncated: true })));

  const result = await reading;
  assert.match(result.content[0]?.text ?? '', /截断/);
  assert.equal(evidence.all()[0]?.truncated, 'tail');
});

test('审计记录远程操作与 grant 编号，不含路径', async () => {
  const { transport, byName, audit } = await setup();
  await primeListing(transport, byName.get('remote_log_list'));

  const reading = callTool(byName.get('remote_log_read'), {
    fileRef: 'f-1',
    startLine: 1,
    endLine: 2,
  });
  const request = transport.lastRequest();
  transport.emit(frame(request, 'DATA', 'one\ntwo'));
  transport.emit(frame(request, 'DONE', donePayload('one\ntwo')));
  await reading;

  const rendered = audit.render(10);
  assert.match(rendered, /LIST/);
  assert.match(rendered, /READ/);
  assert.match(rendered, /grant-1/);
  assert.ok(!rendered.includes('/home/app/logs'), '审计摘要不得包含远端绝对路径');
});
