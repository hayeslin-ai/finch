/**
 * 证据存储。
 *
 * WHY：模型的每条结论都必须能引用到编号证据，用户也必须能核对。
 * 因此证据一旦登记就不可修改，只能追加；重新读取同一位置会产生新编号，
 * 并携带内容摘要，用于判断“是否还是同一段内容”。
 *
 * 证据只保存脱敏后的文本；原始日志与路径不得进入这里。
 */
import { createHash } from 'node:crypto';

import type { SourceKind } from '../ports/index.js';

/** 一条证据。 */
export interface Evidence {
  readonly id: string;
  readonly sourceKind: SourceKind;
  /** 脱敏后的来源描述，例如文件名或目标标识。 */
  readonly sourceLabel: string;
  /** 脱敏后的内容。 */
  readonly text: string;
  readonly collectedAt: string;
  /** 可选定位信息；不同来源能提供的信息不同。 */
  readonly location?: {
    readonly file?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly host?: string;
  };
  readonly truncated: 'none' | 'head' | 'tail' | 'middle-dropped' | 'partial-scan' | 'record';
  /** 内容摘要，用于判断同一位置的内容是否变化。 */
  readonly digest: string;
}

export interface EvidenceDraft {
  readonly sourceKind: SourceKind;
  readonly sourceLabel: string;
  readonly text: string;
  readonly location?: Evidence['location'];
  readonly truncated?: Evidence['truncated'];
  /** 注入时钟便于测试；生产使用当前时间。 */
  readonly collectedAt?: string;
}

/** 查询与结果，便于后续按编号引用。 */
export class EvidenceStore {
  private readonly items: Evidence[] = [];
  private readonly drafts: EvidenceDraft[] = [];

  /** 登记一条证据并返回编号。 */
  add(draft: EvidenceDraft): Evidence {
    const index = this.items.length + 1;
    const evidence: Evidence = {
      id: `EV-${String(index).padStart(3, '0')}`,
      sourceKind: draft.sourceKind,
      sourceLabel: draft.sourceLabel,
      text: draft.text,
      collectedAt: draft.collectedAt ?? new Date().toISOString(),
      ...(draft.location === undefined ? {} : { location: draft.location }),
      truncated: draft.truncated ?? 'none',
      digest: createHash('sha256').update(draft.text, 'utf8').digest('hex').slice(0, 16),
    };
    this.items.push(evidence);
    this.drafts.push(draft);
    return evidence;
  }

  /** 按编号查找；编号不存在时返回 undefined，由调用方决定如何处理。 */
  get(id: string): Evidence | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** 全部证据；调用方不得修改返回数组。 */
  all(): readonly Evidence[] {
    return this.items;
  }

  /** 摘要统计，用于诊断边界说明。 */
  summary(): { readonly count: number; readonly bySource: Readonly<Record<string, number>> } {
    const bySource: Record<string, number> = {};
    for (const item of this.items) {
      bySource[item.sourceKind] = (bySource[item.sourceKind] ?? 0) + 1;
    }
    return { count: this.items.length, bySource };
  }

  /**
   * 校验一段引用是否来自本次登记的证据。
   *
   * WHY：模型可能编造 `EV-999`；结论里出现不存在的编号必须被发现，
   * 而不是展示给用户当成真凭据。
   */
  findUnknownIds(text: string): string[] {
    const referenced = new Set(text.match(/EV-\d{3,}/g) ?? []);
    return [...referenced].filter((id) => this.get(id) === undefined);
  }

  /** 清空；退出或新诊断时调用，避免跨会话复用编号。 */
  clear(): void {
    this.items.length = 0;
    this.drafts.length = 0;
  }
}
