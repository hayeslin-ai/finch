/**
 * 会话事件存储与恢复。
 *
 * WHY：排障经常中断后继续，但恢复必须是“安全的继续”，不是原样重放。
 * 因此这里只保存脱敏后的领域事件，并且：
 * - 不保存原始 traceId、密钥、占位符映射；
 * - 不保存 SDK 原始会话树与工具调用历史；
 * - 恢复后不自动沿用任何远程授权。
 *
 * 事件采用 JSONL 追加写：单行损坏只影响该行，便于定位与部分恢复。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 当前事件格式版本；主版本变化时拒绝恢复，不按新语义猜测旧数据。 */
export const SESSION_SCHEMA_VERSION = 1;

/** 会话事件：只含脱敏内容与非敏感元数据。 */
export interface SessionEvent {
  readonly schemaVersion: number;
  readonly seq: number;
  readonly at: string;
  readonly type:
    | 'session.start'
    | 'input.received'
    | 'evidence.collected'
    | 'diagnosis.completed'
    | 'diagnosis.failed'
    | 'session.close';
  readonly payload: Record<string, string | number>;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
  /** 损坏或无法解析的行数；恢复时如实报告，不静默跳过。 */
  readonly damagedLines: number;
  /** 末尾是否存在未写完的行。 */
  readonly truncatedTail: boolean;
}

/** 生成会话标识：时间前缀便于排序，随机后缀避免碰撞。 */
export function createSessionId(now = new Date()): string {
  // 保留 Z 表示 UTC：去掉毫秒时不能把时区标记一起删掉，
  // 否则同一时刻在不同时区生成的 ID 排序会失真。
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const random = createHash('sha256')
    .update(`${now.getTime()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 8);
  return `${stamp}-${random}`;
}

/** 会话目录：位于应用状态目录下，与会话 ID 一一对应。 */
export function sessionDirectory(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'sessions', sessionId);
}

/**
 * 追加一条事件。
 *
 * 使用追加写而非整体重写：中断时最多丢失最后一行，
 * 不会破坏已有记录。
 */
export async function appendEvent(
  stateDir: string,
  sessionId: string,
  event: Omit<SessionEvent, 'schemaVersion'>,
): Promise<void> {
  const directory = sessionDirectory(stateDir, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'events.jsonl');
  await appendFile(file, `${JSON.stringify({ ...event, schemaVersion: SESSION_SCHEMA_VERSION })}\n`, {
    mode: 0o600,
  });
}

/**
 * 读取会话。
 *
 * 损坏行的处理：跳过并计数；主版本不兼容时整体拒绝，
 * 因为不同主版本的事件语义可能完全不同。
 */
export async function loadSession(stateDir: string, sessionId: string): Promise<SessionSnapshot | { error: string }> {
  const directory = sessionDirectory(stateDir, sessionId);
  const file = path.join(directory, 'events.jsonl');

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { error: '会话不存在或不可读' };
  }

  const events: SessionEvent[] = [];
  let damagedLines = 0;
  let truncatedTail = false;

  const lines = raw.split('\n');
  // 最后一段为空表示文件以换行结尾，属正常情况。
  if (lines.at(-1) === '') {
    lines.pop();
  } else if (lines.length > 0) {
    truncatedTail = true;
  }

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<SessionEvent>;
      if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) {
        return {
          error: `会话格式版本不兼容（期望 ${SESSION_SCHEMA_VERSION}，实际 ${String(parsed.schemaVersion)}）`,
        };
      }
      if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') {
        damagedLines += 1;
        continue;
      }
      events.push(parsed as SessionEvent);
    } catch {
      damagedLines += 1;
    }
  }

  return { sessionId, events, damagedLines, truncatedTail };
}

/** 会话摘要，供恢复前的展示使用；只含非敏感信息。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly lastAt: string;
  readonly eventCount: number;
  readonly started: boolean;
  readonly completed: boolean;
  readonly evidenceCount: number;
}

/** 从事件推导摘要；不读取任何业务内容。 */
export function summarize(snapshot: SessionSnapshot): SessionSummary {
  const first = snapshot.events[0];
  const last = snapshot.events.at(-1);
  return {
    sessionId: snapshot.sessionId,
    startedAt: first?.at ?? '',
    lastAt: last?.at ?? '',
    eventCount: snapshot.events.length,
    started: snapshot.events.some((event) => event.type === 'session.start'),
    completed: snapshot.events.some((event) => event.type === 'diagnosis.completed'),
    evidenceCount: snapshot.events.filter((event) => event.type === 'evidence.collected').length,
  };
}

/** 列出全部会话目录；按名称倒序即最近优先。 */
export async function listSessions(stateDir: string): Promise<readonly string[]> {
  const directory = path.join(stateDir, 'sessions');
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 会话锁。
 *
 * WHY：两个终端同时恢复同一会话会互相覆盖。
 * 这里用独占创建锁文件实现互斥；进程崩溃留下的锁由调用方决定是否接管，
 * 不在库内自动清理，避免误删活锁。
 */
export async function acquireSessionLock(
  stateDir: string,
  sessionId: string,
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; holder: string }> {
  const directory = sessionDirectory(stateDir, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = path.join(directory, 'lock');

  try {
    const handle = await open(lockFile, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.close();
    return {
      ok: true,
      release: async () => {
        const { unlink } = await import('node:fs/promises');
        await unlink(lockFile).catch(() => undefined);
      },
    };
  } catch {
    let holder = '未知进程';
    try {
      holder = (await readFile(lockFile, 'utf8')).trim();
    } catch {
      // 锁文件刚被释放。
    }
    return { ok: false, holder };
  }
}

/** 原子写入快照，供导出或备份；失败不覆盖旧文件。 */
export async function writeSnapshot(
  stateDir: string,
  sessionId: string,
  snapshot: SessionSnapshot,
): Promise<void> {
  const directory = sessionDirectory(stateDir, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, 'snapshot.json');
  const temporary = path.join(directory, `.snapshot.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(temporary, target);
}

/** 检查路径是否为普通文件；用于恢复前的快速校验。 */
export async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
