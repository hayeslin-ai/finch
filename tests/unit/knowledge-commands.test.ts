/**
 * 知识库命令测试。
 *
 * 重点不变量：
 * - 未经确认不写入任何文件；
 * - 根因未确认只能存草稿，且草稿不进入默认检索；
 * - 失效是追加新版本，不删除历史。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  deriveEntryId,
  invalidateEntry,
  listEntries,
  renderEntryList,
  saveDraft,
  searchAndRender,
  type KnowledgeContext,
  type KnowledgeIo,
} from '../../src/cli/knowledge-commands.js';
import { listRevisions } from '../../src/knowledge/store.js';

/** 按预设答案返回的假输入；记录所有输出。 */
function fakeIo(answers: { approve?: boolean }): KnowledgeIo & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    out: (line) => output.push(line),
    text: async () => '',
    approve: async () => answers.approve ?? false,
  };
}

async function withContext(run: (context: KnowledgeContext) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'finch-kcmd-'));
  try {
    await run({ dataDir, scopeId: 'demo-svc' });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const draft = {
  title: '订单计算空指针',
  errorSignature: 'NullPointerException OrderService.calc',
  body: '结论：入参为 null 未判空。证据 EV-001。',
  rootCauseConfirmed: true,
  applicableVersion: 'a1b2c3d',
};

test('未确认时不写入任何内容', async () => {
  await withContext(async (context) => {
    const io = fakeIo({ approve: false });
    const result = await saveDraft(context, draft, io);

    assert.equal(result.ok, false);
    assert.match(result.message, /已取消/);
    assert.deepEqual(await listEntries(context), [], '取消后不得产生条目');
  });
});

test('确认后写入，状态为已确认', async () => {
  await withContext(async (context) => {
    const io = fakeIo({ approve: true });
    const result = await saveDraft(context, draft, io);

    assert.equal(result.ok, true, result.message);
    assert.equal(result.meta?.status, 'confirmed');
    assert.equal(result.meta?.revision, 1);

    const entries = await listEntries(context);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.title, draft.title);
  });
});

test('根因未确认时只能保存为草稿', async () => {
  await withContext(async (context) => {
    const io = fakeIo({ approve: true });
    const result = await saveDraft(context, { ...draft, rootCauseConfirmed: false }, io);

    assert.equal(result.meta?.status, 'draft');
    assert.match(io.output.join('\n'), /草稿.*不会进入默认检索/);

    // 草稿不参与检索。
    const rendered = await searchAndRender(context, ['NullPointerException']);
    assert.match(rendered, /未找到/);
  });
});

test('已确认条目可被检索到，并带来源与版本提示', async () => {
  await withContext(async (context) => {
    await saveDraft(context, draft, fakeIo({ approve: true }));
    const rendered = await searchAndRender(context, ['NullPointerException']);

    assert.match(rendered, /订单计算空指针/);
    assert.match(rendered, /a1b2c3d/);
    assert.match(rendered, /历史线索/);
  });
});

test('同一标题再次保存递增版本，不覆盖旧版', async () => {
  await withContext(async (context) => {
    const first = await saveDraft(context, draft, fakeIo({ approve: true }));
    const second = await saveDraft(
      context,
      { ...draft, body: '第二版：补充了修复建议' },
      fakeIo({ approve: true }),
    );

    assert.equal(first.meta?.revision, 1);
    assert.equal(second.meta?.revision, 2);

    const revisions = await listRevisions(context.dataDir, context.scopeId, deriveEntryId(draft.title));
    assert.deepEqual(revisions, [1, 2]);
  });
});

test('失效标记追加新版本且不删除历史', async () => {
  await withContext(async (context) => {
    const saved = await saveDraft(context, draft, fakeIo({ approve: true }));
    const entryId = saved.meta?.entryId ?? '';

    const result = await invalidateEntry(context, entryId, fakeIo({ approve: true }));
    assert.equal(result.ok, true, result.message);

    const revisions = await listRevisions(context.dataDir, context.scopeId, entryId);
    assert.deepEqual(revisions, [1, 2], '旧版本必须保留');

    const entries = await listEntries(context);
    assert.equal(entries[0]?.status, 'invalidated');
  });
});

test('失效未确认时不产生新版本', async () => {
  await withContext(async (context) => {
    const saved = await saveDraft(context, draft, fakeIo({ approve: true }));
    const entryId = saved.meta?.entryId ?? '';

    const result = await invalidateEntry(context, entryId, fakeIo({ approve: false }));
    assert.equal(result.ok, false);

    const revisions = await listRevisions(context.dataDir, context.scopeId, entryId);
    assert.deepEqual(revisions, [1]);
  });
});

test('失效条目不再进入检索', async () => {
  await withContext(async (context) => {
    const saved = await saveDraft(context, draft, fakeIo({ approve: true }));
    await invalidateEntry(context, saved.meta?.entryId ?? '', fakeIo({ approve: true }));

    const rendered = await searchAndRender(context, ['NullPointerException']);
    assert.match(rendered, /未找到/);
  });
});

test('条目列表渲染包含状态与修复验证情况', async () => {
  await withContext(async (context) => {
    await saveDraft(context, draft, fakeIo({ approve: true }));
    const entries = await listEntries(context);
    const rendered = renderEntryList(entries);

    assert.match(rendered, /\[已确认\]/);
    assert.match(rendered, /修复未验证/);
  });
});

test('空库时给出友好提示', async () => {
  await withContext(async (context) => {
    assert.match(renderEntryList(await listEntries(context)), /暂无故障经验/);
    assert.match(await searchAndRender(context, ['x']), /未找到/);
  });
});

test('entryId 只产出 ASCII 安全标识，中文标题用哈希兜底', () => {
  assert.equal(deriveEntryId('Null Pointer / Exception'), 'null-pointer-exception');

  const chinese = deriveEntryId('订单计算空指针');
  assert.match(chinese, /^entry-[0-9a-f]{12}$/, '中文标题应使用稳定哈希');
  assert.equal(chinese, deriveEntryId('订单计算空指针'), '同一标题必须得到同一标识');
  assert.notEqual(chinese, deriveEntryId('另一条经验'));

  assert.match(deriveEntryId('///'), /^entry-[0-9a-f]{12}$/);
  assert.ok(!deriveEntryId('///').includes('/'), '不得产生路径分隔符');
});

test('写入的文件位于作用域目录下', async () => {
  await withContext(async (context) => {
    await saveDraft(context, draft, fakeIo({ approve: true }));
    const scopes = await readdir(path.join(context.dataDir, 'knowledge'));
    assert.deepEqual(scopes, ['demo-svc']);

    const entryId = deriveEntryId(draft.title);
    const body = await readFile(
      path.join(context.dataDir, 'knowledge', 'demo-svc', entryId, 'r001.md'),
      'utf8',
    );
    assert.match(body, /订单计算空指针/);
    assert.match(body, /finch:meta/);
  });
});
