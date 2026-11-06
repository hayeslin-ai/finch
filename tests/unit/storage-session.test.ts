/**
 * 会话存储与恢复测试。
 *
 * 重点：追加写不破坏已有记录、损坏行如实计数、主版本不兼容拒绝、
 * 并发锁互斥、恢复摘要只含非敏感信息。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  SESSION_SCHEMA_VERSION,
  acquireSessionLock,
  appendEvent,
  createSessionId,
  listSessions,
  loadSession,
  sessionDirectory,
  summarize,
} from '../../src/storage/session.js';

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-session-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('会话标识包含时间前缀且互不重复', () => {
  const ids = new Set(Array.from({ length: 50 }, () => createSessionId()));
  assert.equal(ids.size, 50);
  for (const id of ids) {
    assert.match(id, /^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
  }
});

test('追加事件后可完整读回', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090000Z-abc12345';
    await appendEvent(directory, sessionId, {
      seq: 1,
      at: '2026-11-06T09:00:00.000Z',
      type: 'session.start',
      payload: { repo: 'demo' },
    });
    await appendEvent(directory, sessionId, {
      seq: 2,
      at: '2026-11-06T09:00:05.000Z',
      type: 'evidence.collected',
      payload: { sourceKind: 'paste' },
    });

    const snapshot = await loadSession(directory, sessionId);
    assert.ok(!('error' in snapshot));
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.damagedLines, 0);
    assert.equal(snapshot.truncatedTail, false);
  });
});

test('损坏行被计数而非静默跳过', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090001Z-def67890';
    await appendEvent(directory, sessionId, {
      seq: 1,
      at: '2026-11-06T09:00:00.000Z',
      type: 'session.start',
      payload: {},
    });

    const file = path.join(sessionDirectory(directory, sessionId), 'events.jsonl');
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}not-json\n`, 'utf8');

    const snapshot = await loadSession(directory, sessionId);
    assert.ok(!('error' in snapshot));
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.damagedLines, 1, '必须如实报告损坏');
  });
});

test('末尾未写完的行被标记为截断', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090002Z-11112222';
    await appendEvent(directory, sessionId, {
      seq: 1,
      at: '2026-11-06T09:00:00.000Z',
      type: 'session.start',
      payload: {},
    });

    const file = path.join(sessionDirectory(directory, sessionId), 'events.jsonl');
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}{"seq":2,"type":"dia`, 'utf8');

    const snapshot = await loadSession(directory, sessionId);
    assert.ok(!('error' in snapshot));
    assert.equal(snapshot.truncatedTail, true);
    assert.equal(snapshot.damagedLines, 1);
  });
});

test('主版本不兼容时整体拒绝恢复', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090003Z-33334444';
    const file = path.join(directory, 'sessions', sessionId, 'events.jsonl');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION + 1, seq: 1, at: '', type: 'session.start', payload: {} })}\n`,
    );

    const snapshot = await loadSession(directory, sessionId);
    assert.ok('error' in snapshot);
    assert.match(snapshot.error, /版本不兼容/);
  });
});

test('摘要只含非敏感计数信息', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090004Z-55556666';
    await appendEvent(directory, sessionId, {
      seq: 1,
      at: '2026-11-06T09:00:00.000Z',
      type: 'session.start',
      payload: {},
    });
    await appendEvent(directory, sessionId, {
      seq: 2,
      at: '2026-11-06T09:00:10.000Z',
      type: 'evidence.collected',
      payload: {},
    });
    await appendEvent(directory, sessionId, {
      seq: 3,
      at: '2026-11-06T09:00:20.000Z',
      type: 'diagnosis.completed',
      payload: {},
    });

    const snapshot = await loadSession(directory, sessionId);
    assert.ok(!('error' in snapshot));
    const summary = summarize(snapshot);

    assert.equal(summary.started, true);
    assert.equal(summary.completed, true);
    assert.equal(summary.evidenceCount, 1);
    assert.ok(!JSON.stringify(summary).includes('traceId'));
  });
});

test('同一会话的锁互斥，释放后可再次获取', async () => {
  await withTempDir(async (directory) => {
    const sessionId = '20261106T090005Z-77778888';

    const first = await acquireSessionLock(directory, sessionId);
    assert.equal(first.ok, true);

    const second = await acquireSessionLock(directory, sessionId);
    assert.equal(second.ok, false, '第二个实例必须被拒绝');
    if (!second.ok) {
      assert.match(second.holder, /pid/);
    }

    if (first.ok) {
      await first.release();
    }
    const third = await acquireSessionLock(directory, sessionId);
    assert.equal(third.ok, true, '释放后应可再次获取');
    if (third.ok) {
      await third.release();
    }
  });
});

test('会话列表按时间倒序，最近优先', async () => {
  await withTempDir(async (directory) => {
    for (const id of ['20261106T090000Z-aaaa0001', '20261107T090000Z-aaaa0002']) {
      await appendEvent(directory, id, {
        seq: 1,
        at: '2026-11-06T09:00:00.000Z',
        type: 'session.start',
        payload: {},
      });
    }

    const sessions = await listSessions(directory);
    assert.deepEqual(sessions, ['20261107T090000Z-aaaa0002', '20261106T090000Z-aaaa0001']);
  });
});
