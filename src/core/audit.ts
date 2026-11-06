/**
 * 审计账本。
 *
 * WHY：用户需要知道“Agent 到底做了什么”，验收也需要证据证明没有越界。
 * 因此每次工具操作都记一条，且只记录非敏感摘要：
 * 不记录原始 traceId、密钥、完整命令原文与未脱敏日志。
 *
 * `/audit` 默认只展示最近 10 条，避免刷屏；不提供导出。
 */

export type AuditOperation =
  | 'CONNECT'
  | 'LIST'
  | 'SEARCH'
  | 'READ'
  | 'CLOSE'
  | 'LOCAL_READ'
  | 'LOCAL_SEARCH'
  | 'SOURCE_SEARCH'
  | 'SOURCE_READ'
  | 'DENY';

export interface AuditEntry {
  readonly at: string;
  readonly operation: AuditOperation;
  /** 目标标识；本地操作记 `local`，不记录绝对路径。 */
  readonly target: string;
  /** 参数摘要，例如命中数、行数范围、关键词数量。 */
  readonly params: string;
  readonly result: string;
  /** 授权编号；未涉及远程授权时为 `-`。 */
  readonly grant: string;
  readonly durationMs?: number;
}

/** 账本容量上限；防止长时间会话无限增长。 */
const MAX_ENTRIES = 500;

export class AuditLedger {
  private readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      // 只丢弃最旧的记录；摘要统计不依赖完整历史。
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  /** 最近 N 条，按时间正序返回，便于阅读。 */
  recent(count = 10): readonly AuditEntry[] {
    return this.entries.slice(-count);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 渲染为固定列宽的文本表格。
   * 只含非敏感摘要，可直接展示在终端。
   */
  render(count = 10): string {
    const rows = this.recent(count);
    if (rows.length === 0) {
      return '暂无操作记录。\n';
    }

    const header = ['TIME', 'OP', 'TARGET', 'PARAMS', 'RESULT', 'GRANT'];
    const body = rows.map((entry) => [
      entry.at.slice(11, 19),
      entry.operation,
      entry.target,
      entry.params,
      entry.result,
      entry.grant,
    ]);

    const widths = header.map((title, index) =>
      Math.max(title.length, ...body.map((row) => (row[index] ?? '').length)),
    );

    const format = (row: readonly string[]): string =>
      row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();

    return `${[format(header), ...body.map(format)].join('\n')}\n`;
  }
}
