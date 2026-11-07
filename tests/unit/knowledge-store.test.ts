/**
 * 知识库测试。
 *
 * 重点：修订不覆盖旧版、草稿与失效条目不进入默认检索、
 * 作用域隔离、路径逃逸拒绝、检索结果有界。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  listRevisions,
  parseEntry,
  readRevision,
  readRevisionHead,
  renderEntry,
  saveRevision,
  searchKnowledge,
} from '../../src/knowledge/store.js';

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-knowledge-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function baseMeta(overrides: Partial<Parameters<typeof saveRevision>[1]['meta']> = {}) {
  return {
    entryId: 'order-npe',
    scopeId: 'demo-svc',
    status: 'confirmed' as const,
    title: '订单计算空指针',
    errorSignature: 'NullPointerException OrderService.calc',
    rootCauseConfirmed: true,
    fixVerified: false,
    applicableVersion: 'a1b2c3d',
    createdAt: '2026-11-06T09:00:00.000Z',
    ...overrides,
  };
}

test('保存修订后版本递增且不覆盖旧版', async () => {
  await withTempDir(async (directory) => {
    const first = await saveRevision(directory, { meta: baseMeta(), body: '第一版内容' });
    const second = await saveRevision(directory, { meta: baseMeta(), body: '第二版补充' });

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.equal(second.previousRevision, 1);

    const revisions = await listRevisions(directory, 'demo-svc', 'order-npe');
    assert.deepEqual(revisions, [1, 2]);

    const old = await readRevision(directory, 'demo-svc', 'order-npe', 1);
    assert.match(old?.body ?? '', /第一版内容/, '旧版本必须保留');
  });
});

test('Markdown 渲染与解析可往返', () => {
  const text = renderEntry({
    meta: {
      entryId: 'e1',
      revision: 3,
      scopeId: 'svc',
      status: 'confirmed',
      title: '标题',
      errorSignature: 'sig',
      rootCauseConfirmed: true,
      fixVerified: true,
      applicableVersion: 'abc',
      createdAt: '2026-11-06T09:00:00.000Z',
    },
    body: '正文内容\n\n## 小节',
  });

  const parsed = parseEntry(text);
  assert.equal(parsed?.meta.entryId, 'e1');
  assert.equal(parsed?.meta.revision, 3);
  assert.match(parsed?.body ?? '', /正文内容/);
});

test('缺少元数据块的 Markdown 被判为无效', () => {
  assert.equal(parseEntry('# 只有标题\n没有元数据'), undefined);
});

test('只有已确认条目参与检索', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'confirmed', status: 'confirmed' }),
      body: 'NullPointerException 修复方式',
    });
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'draft', status: 'draft' }),
      body: 'NullPointerException 草稿',
    });
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'invalid', status: 'invalidated' }),
      body: 'NullPointerException 已失效',
    });

    const hits = await searchKnowledge(directory, 'demo-svc', ['NullPointerException']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.meta.entryId, 'confirmed');
  });
});

test('检索按作用域隔离，不跨服务命中', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, { meta: baseMeta({ scopeId: 'svc-a' }), body: 'NPE 处理' });
    await saveRevision(directory, {
      meta: baseMeta({ scopeId: 'svc-b', entryId: 'other' }),
      body: 'NPE 处理',
    });

    const hits = await searchKnowledge(directory, 'svc-a', ['NPE']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.meta.scopeId, 'svc-a');
  });
});

test('错误签名权重高于正文匹配', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'by-signature' }),
      body: '无关内容',
    });
    await saveRevision(directory, {
      meta: baseMeta({
        entryId: 'by-body',
        errorSignature: 'TimeoutException',
        title: '超时',
      }),
      body: '正文里提到 NullPointerException 一次',
    });

    const hits = await searchKnowledge(directory, 'demo-svc', ['NullPointerException']);
    assert.equal(hits[0]?.meta.entryId, 'by-signature', '签名命中应排在正文命中之前');
  });
});

test('检索结果数量有上限', async () => {
  await withTempDir(async (directory) => {
    for (let index = 0; index < 5; index += 1) {
      await saveRevision(directory, {
        meta: baseMeta({ entryId: `entry-${index}` }),
        body: 'NullPointerException',
      });
    }

    const hits = await searchKnowledge(directory, 'demo-svc', ['NullPointerException'], { limit: 2 });
    assert.equal(hits.length, 2);
  });
});

test('非法作用域标识被拒绝，防止路径逃逸', async () => {
  await withTempDir(async (directory) => {
    await assert.rejects(
      () => saveRevision(directory, { meta: baseMeta({ scopeId: '../etc' }), body: 'x' }),
      /标识不合法/,
    );

    await assert.rejects(
      () => searchKnowledge(directory, '..', ['x']),
      /标识不合法/,
    );
  });
});

test('空检索词返回空结果，不加载整库', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, { meta: baseMeta(), body: '内容' });
    assert.deepEqual(await searchKnowledge(directory, 'demo-svc', []), []);
    assert.deepEqual(await searchKnowledge(directory, 'demo-svc', ['  ']), []);
  });
});

test('条目目录按作用域与条目隔离', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, { meta: baseMeta(), body: 'a' });
    const scopes = await readdir(path.join(directory, 'knowledge'));
    assert.deepEqual(scopes, ['demo-svc']);

    const entries = await readdir(path.join(directory, 'knowledge', 'demo-svc'));
    assert.deepEqual(entries, ['order-npe']);
  });
});

test('仅正文命中的条目仍能被检索到', async () => {
  await withTempDir(async (directory) => {
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'body-only' }),
      // 关键词只出现在正文里，标题与错误签名都不含它。
      body: '根因是连接池未释放，表现为 HikariPool-1 timeout。',
    });

    const hits = await searchKnowledge(directory, 'demo-svc', ['hikaripool']);
    assert.equal(hits.length, 1, '头部预读过滤不得丢失仅正文命中的条目');
    assert.equal(hits[0]?.relevance, 1, '正文命中权重为 1');
  });
});

test('正文长于头部预读窗口时仍按全文加权', async () => {
  await withTempDir(async (directory) => {
    // 正文超过 4 KiB 的头部窗口，关键词放在窗口之外。
    const padding = 'y'.repeat(8_192);
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'long-body' }),
      body: `${padding}\n末尾出现 PoolExhausted 关键字。`,
    });

    const hits = await searchKnowledge(directory, 'demo-svc', ['poolexhausted']);
    assert.equal(hits.length, 1, '正文未读全时必须补读，不能只按头部匹配');
  });
});

test('头部预读与整读解析出相同的元数据', async () => {
  await withTempDir(async (directory) => {
    const longBody = 'z'.repeat(8_192);
    await saveRevision(directory, {
      meta: baseMeta({ entryId: 'meta-same' }),
      body: longBody,
    });

    const head = await readRevisionHead(directory, 'demo-svc', 'meta-same', 1);
    const full = await readRevision(directory, 'demo-svc', 'meta-same', 1);

    assert.ok(head !== undefined && full !== undefined);
    assert.deepEqual(head.entry.meta, full.meta, '元数据必须完全一致');
    assert.equal(head.bodyComplete, false, '正文超出窗口时必须标记未读全');
  });
});
