/**
 * 知识库交互命令。
 *
 * 设计原则（PRD FR-11）：
 * - 模型只能“提议”，不能自行确认；入库、修订、失效都必须由人工决定。
 * - 草稿与失效条目不进入默认检索，避免过期经验影响诊断。
 * - 每次修订新增版本，绝不覆盖历史。
 *
 * 本模块只做编排：读取证据、组装候选、调用存储；
 * 交互输入由调用方注入，便于离线测试。
 */
import { createHash } from 'node:crypto';

import {
  listRevisions,
  readRevision,
  saveRevision,
  searchKnowledge,
  type KnowledgeMeta,
  type KnowledgeStatus,
} from '../knowledge/store.js';

/** 交互输入/输出；与配置向导共用同一套注入方式。 */
export interface KnowledgeIo {
  readonly out: (line: string) => void;
  readonly text: (question: string) => Promise<string>;
  readonly approve: (question: string) => Promise<boolean>;
}

export interface KnowledgeContext {
  readonly dataDir: string;
  /** 当前诊断的作用域，通常是推导出的服务标识。 */
  readonly scopeId: string;
}

/** 候选条目；来自当前诊断，尚未入库。 */
export interface KnowledgeDraft {
  readonly title: string;
  readonly errorSignature: string;
  /** 已脱敏正文，通常是模型给出的结论与证据摘要。 */
  readonly body: string;
  readonly rootCauseConfirmed: boolean;
  readonly applicableVersion: string;
}

/**
 * 列出当前作用域下的条目概览。
 *
 * 只显示最新修订的元数据，不打印正文——避免一屏塞满历史内容。
 */
export async function listEntries(context: KnowledgeContext): Promise<readonly KnowledgeMeta[]> {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');

  const root = path.join(context.dataDir, 'knowledge', context.scopeId);
  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const metas: KnowledgeMeta[] = [];
  for (const entryId of directories) {
    const revisions = await listRevisions(context.dataDir, context.scopeId, entryId);
    const latest = revisions.at(-1);
    if (latest === undefined) {
      continue;
    }
    const entry = await readRevision(context.dataDir, context.scopeId, entryId, latest);
    if (entry !== undefined) {
      metas.push(entry.meta);
    }
  }

  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 渲染条目列表；状态用中文，避免用户误读英文缩写。 */
export function renderEntryList(metas: readonly KnowledgeMeta[]): string {
  if (metas.length === 0) {
    return '当前服务下暂无故障经验。\n';
  }

  const statusLabel: Record<KnowledgeStatus, string> = {
    draft: '草稿',
    confirmed: '已确认',
    invalidated: '已失效',
  };

  const lines = metas.map((meta) => {
    const fix = meta.fixVerified ? '已验证' : '未验证';
    return `  [${statusLabel[meta.status]}] ${meta.entryId}  r${meta.revision}  ${meta.title}  (修复${fix})`;
  });
  return `${lines.join('\n')}\n`;
}

/**
 * 保存候选条目。
 *
 * 必须显式确认才写入；未确认时返回取消，不产生任何文件。
 * 根因未确认的候选只能以草稿状态保存，避免被默认检索命中。
 */
export async function saveDraft(
  context: KnowledgeContext,
  draft: KnowledgeDraft,
  io: KnowledgeIo,
): Promise<{ ok: boolean; message: string; meta?: KnowledgeMeta }> {
  const status: KnowledgeStatus = draft.rootCauseConfirmed ? 'confirmed' : 'draft';

  io.out('');
  io.out('准备保存的条目：');
  io.out(`  标题：${draft.title}`);
  io.out(`  错误特征：${draft.errorSignature}`);
  io.out(`  状态：${status === 'confirmed' ? '已确认' : '草稿（不会进入默认检索）'}`);
  io.out(`  适用版本：${draft.applicableVersion}`);
  io.out(`  作用域：${context.scopeId}`);

  const approved = await io.approve('确认保存这条故障经验？');
  if (!approved) {
    return { ok: false, message: '已取消，未写入任何内容' };
  }

  // entryId 由标题派生，保证同一类问题可以递增修订而不是每次新建。
  const entryId = deriveEntryId(draft.title);
  const meta = await saveRevision(context.dataDir, {
    meta: {
      entryId,
      scopeId: context.scopeId,
      status,
      title: draft.title,
      errorSignature: draft.errorSignature,
      rootCauseConfirmed: draft.rootCauseConfirmed,
      fixVerified: false,
      applicableVersion: draft.applicableVersion,
      createdAt: new Date().toISOString(),
    },
    body: draft.body,
  });

  return {
    ok: true,
    message: `已保存为 ${entryId} 的第 ${meta.revision} 版。`,
    meta,
  };
}

/**
 * 将条目标记为失效。
 *
 * 不删除旧版本，而是追加一个新的失效修订；
 * 这样历史仍可追溯，检索也会自动排除它。
 */
export async function invalidateEntry(
  context: KnowledgeContext,
  entryId: string,
  io: KnowledgeIo,
): Promise<{ ok: boolean; message: string }> {
  const revisions = await listRevisions(context.dataDir, context.scopeId, entryId);
  const latest = revisions.at(-1);
  if (latest === undefined) {
    return { ok: false, message: `条目不存在：${entryId}` };
  }

  const entry = await readRevision(context.dataDir, context.scopeId, entryId, latest);
  if (entry === undefined) {
    return { ok: false, message: `条目无法读取：${entryId}` };
  }
  if (entry.meta.status === 'invalidated') {
    return { ok: false, message: '该条目已经是失效状态。' };
  }

  io.out(`将把 ${entryId}（${entry.meta.title}）标记为失效。`);
  const approved = await io.approve('确认标记为失效？');
  if (!approved) {
    return { ok: false, message: '已取消，未修改任何内容' };
  }

  const meta = await saveRevision(context.dataDir, {
    meta: {
      entryId,
      scopeId: context.scopeId,
      status: 'invalidated',
      title: entry.meta.title,
      errorSignature: entry.meta.errorSignature,
      rootCauseConfirmed: entry.meta.rootCauseConfirmed,
      fixVerified: entry.meta.fixVerified,
      applicableVersion: entry.meta.applicableVersion,
      createdAt: new Date().toISOString(),
    },
    body: entry.body,
  });

  return { ok: true, message: `已标记为失效（第 ${meta.revision} 版）；旧版本保留。` };
}

/**
 * 检索并展示结果。
 *
 * 检索结果只作为排查线索展示，不改变当前诊断的任何结论。
 */
export async function searchAndRender(
  context: KnowledgeContext,
  terms: readonly string[],
): Promise<string> {
  const hits = await searchKnowledge(context.dataDir, context.scopeId, terms, { limit: 3 });
  if (hits.length === 0) {
    return '未找到已确认的故障经验。\n';
  }

  const lines = hits.map((hit, index) => {
    return [
      `${index + 1}. ${hit.meta.title}（${hit.meta.entryId} r${hit.meta.revision}）`,
      `   错误特征：${hit.meta.errorSignature}`,
      `   适用版本：${hit.meta.applicableVersion}`,
      `   更新于：${hit.meta.createdAt}`,
      '   提示：这只是历史线索，需用当前日志与源码核实。',
    ].join('\n');
  });

  return `${lines.join('\n\n')}\n`;
}

/**
 * 从标题派生稳定的条目标识。
 *
 * WHY 只保留 ASCII：存储层用该标识作为目录名，仅接受
 * `[A-Za-z0-9_.-]`；中文标题若直接当目录名会被拒绝。
 *
 * 中文标题没有可读的 ASCII 形式时，用内容哈希兜底：
 * 同一标题始终得到同一标识，因而能正确递增修订，而不是每次新建条目。
 */
export function deriveEntryId(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  if (normalized !== '') {
    return normalized;
  }

  // 无 ASCII 可用时用标题哈希：稳定、可复现，且不会产生空标识。
  const digest = createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 12);
  return `entry-${digest}`;
}
