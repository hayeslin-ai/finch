/**
 * 日志记录格式解析。
 *
 * 依据真实样本：
 * 2026-11-06 15:33:00.007|//|Qwmw4nqk87eq|22.50.14.22|cogo-user-management|xxl-job, JobThread-399-...|INFO |com.cogo...QywxMsgJob:39|消息
 *
 * 两个容易做错的地方，本模块专门处理：
 * 1. 级别字段含尾随空格（`INFO `），必须 trim，否则级别判定全部失效。
 * 2. 消息本身可能包含 `|`，必须限制分段数，其余全部归入消息，否则字段错位。
 *
 * 另一个关键事实：Java 异常栈的续行（\tat、Caused by:、... N more）
 * 没有时间戳和 traceId。因此证据单位必须是“整条记录”，
 * 从记录头读到下一个记录头之前；只取含 traceId 的行会丢掉整条异常链。
 */

/** 一条完整日志记录；续行已归入 body。 */
export interface LogRecord {
  /** 记录头起始行号（1 起）。 */
  readonly startLine: number;
  /** 记录结束行号（含），即下一个记录头之前一行。 */
  readonly endLine: number;
  readonly timestamp: string;
  readonly epochMs: number;
  /** 样本中的 `//` 字段，语义未确认，原样保留不解释。 */
  readonly unknownField: string;
  readonly traceId: string;
  readonly host: string;
  readonly app: string;
  readonly thread: string;
  readonly level: string;
  readonly logger: string;
  readonly sourceLine: number | undefined;
  /** 记录头消息与全部续行。 */
  readonly body: string;
}

/** 记录头：23 位时间戳 + 竖线。用于判定新记录开始。 */
const HEADER_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\|/;

/** 读取记录头字段；限制为 8 段，其余归入消息。 */
const FIELD_PATTERN =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([\s\S]*)$/;

/** 判断某行是否开始一条新记录。 */
export function isRecordStart(line: string): boolean {
  return HEADER_PATTERN.test(line);
}

/**
 * 解析记录头。
 * 失败时返回 undefined，由调用方把该行当作上一条记录的续行，
 * 而不是丢弃——丢弃堆栈会让根因永远定位不到。
 */
export function parseRecordHeader(line: string): Omit<LogRecord, 'endLine' | 'body'> | undefined {
  const match = FIELD_PATTERN.exec(line);
  if (match === null) {
    return undefined;
  }

  const [, timestamp, unknownField, traceId, host, app, thread, rawLevel, loggerRef, message] = match;
  if (
    timestamp === undefined ||
    unknownField === undefined ||
    traceId === undefined ||
    host === undefined ||
    app === undefined ||
    thread === undefined ||
    rawLevel === undefined ||
    loggerRef === undefined ||
    message === undefined
  ) {
    return undefined;
  }

  // logger:行号 用最后一个冒号分割；行号必须是纯数字，否则视为无行号。
  const lastColon = loggerRef.lastIndexOf(':');
  const logger = lastColon > 0 ? loggerRef.slice(0, lastColon) : loggerRef;
  const lineText = lastColon > 0 ? loggerRef.slice(lastColon + 1) : '';
  const sourceLine = /^\d+$/.test(lineText) ? Number(lineText) : undefined;

  const epochMs = Date.parse(timestamp.replace(' ', 'T'));

  return {
    startLine: 0,
    timestamp,
    epochMs: Number.isNaN(epochMs) ? Number.NaN : epochMs,
    unknownField,
    traceId,
    host,
    app,
    // 级别可能带尾随空格，必须 trim；大小写保留原样但比较时统一大写。
    thread,
    level: rawLevel.trim().toUpperCase(),
    logger,
    sourceLine,
  };
}

/**
 * 把一段文本解析为记录数组。
 *
 * 无法解析记录头的行归入前一条记录的 body；文件开头若就有孤立续行，
 * 单独成组并标记 traceId 为空，提示调用方这是缺失上下文。
 */
export function parseRecords(text: string): LogRecord[] {
  const lines = text.split(/\r?\n/);
  const records: LogRecord[] = [];

  let current: {
    header: Omit<LogRecord, 'endLine' | 'body'>;
    body: string[];
  } | undefined;

  const flush = (endLine: number): void => {
    if (current === undefined) {
      return;
    }
    records.push({
      ...current.header,
      startLine: current.header.startLine,
      endLine,
      body: current.body.join('\n'),
    });
    current = undefined;
  };

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (isRecordStart(line)) {
      flush(lineNumber - 1);
      const parsed = parseRecordHeader(line);
      if (parsed !== undefined) {
        current = { header: { ...parsed, startLine: lineNumber }, body: [line] };
        return;
      }
    }

    if (current === undefined) {
      // 文件开头的孤立续行：保留为无头记录，不静默丢弃。
      current = {
        header: {
          startLine: lineNumber,
          timestamp: '',
          epochMs: Number.NaN,
          unknownField: '',
          traceId: '',
          host: '',
          app: '',
          thread: '',
          level: '',
          logger: '',
          sourceLine: undefined,
        },
        body: [line],
      };
      return;
    }
    current.body.push(line);
  });

  flush(lines.length);
  return records;
}

/** 按时间戳升序排序；时间未知的记录排在最后，保持相对顺序。 */
export function sortTimeline(records: readonly LogRecord[]): LogRecord[] {
  return [...records].sort((a, b) => {
    const aKnown = !Number.isNaN(a.epochMs);
    const bKnown = !Number.isNaN(b.epochMs);
    if (aKnown && bKnown) {
      return a.epochMs - b.epochMs;
    }
    if (aKnown) {
      return -1;
    }
    if (bKnown) {
      return 1;
    }
    return 0;
  });
}
