/**
 * 会话恢复命令的编排。
 *
 * 按已确认的语义实现：
 * - `-c` 恢复最近活跃会话，展示摘要后直接进入，不再追加一次确认；
 * - `-r <id>` 恢复指定会话；
 * - `--sessions` 列出历史会话；
 * - 无会话、最近会话损坏时给出可操作提示，不报错退出。
 *
 * 恢复只还原脱敏证据与结论；远程授权、附件授权、原始 traceId 与预算一律不恢复。
 */
import {
  acquireSessionLock,
  listSessions,
  loadSession,
  summarize,
  type SessionSnapshot,
  type SessionSummary,
} from '../storage/session.js';

export interface ResumeSelection {
  readonly ok: boolean;
  readonly snapshot?: SessionSnapshot;
  readonly summary?: SessionSummary;
  /** 面向用户的说明；失败时说明原因，成功时为空。 */
  readonly message?: string;
  /** 其他候选会话，便于用户在损坏时改选。 */
  readonly alternatives?: readonly string[];
  readonly release?: () => Promise<void>;
}

/**
 * 选择并加载会话。
 *
 * WHY 需要区分“没有会话”与“会话损坏”：
 * 前者是正常首次使用，应直接进入新会话；
 * 后者是数据问题，必须报告并保留原文件。
 */
export async function selectSession(
  stateDir: string,
  requested: string | undefined,
): Promise<ResumeSelection> {
  const sessions = await listSessions(stateDir);

  if (sessions.length === 0) {
    return { ok: false, message: '没有历史会话，已进入新诊断。' };
  }

  const sessionId = requested ?? sessions[0];
  if (sessionId === undefined) {
    return { ok: false, message: '无法确定会话。' };
  }

  if (requested !== undefined && !sessions.includes(requested)) {
    return {
      ok: false,
      message: `会话不存在：${requested}`,
      alternatives: sessions.slice(0, 5),
    };
  }

  // 并发保护：同一会话只允许一个实例写入。
  const lock = await acquireSessionLock(stateDir, sessionId);
  if (!lock.ok) {
    return {
      ok: false,
      message: `该会话正在被另一个终端使用：${lock.holder}。可改用 --sessions 选择其他会话。`,
      alternatives: sessions.filter((item) => item !== sessionId).slice(0, 5),
    };
  }

  const snapshot = await loadSession(stateDir, sessionId);
  if ('error' in snapshot) {
    // 加载失败要释放锁，否则用户无法重试。
    await lock.release();
    return {
      ok: false,
      message: `${snapshot.error}`,
      alternatives: sessions.filter((item) => item !== sessionId).slice(0, 5),
    };
  }

  const summary = summarize(snapshot);
  const parts: string[] = [];
  if (snapshot.damagedLines > 0) {
    parts.push(`有 ${snapshot.damagedLines} 行损坏已跳过`);
  }
  if (snapshot.truncatedTail) {
    parts.push('末尾存在未写完的记录');
  }

  return {
    ok: true,
    snapshot,
    summary,
    ...(parts.length === 0 ? {} : { message: parts.join('；') }),
    release: lock.release,
  };
}

/** 渲染恢复摘要；不含原始 traceId、密钥、日志内容或绝对路径。 */
export function renderSummary(summary: SessionSummary): string {
  const lines = [
    `Session  ${summary.sessionId}`,
    `Started  ${summary.startedAt}`,
    `Last     ${summary.lastAt}`,
    `Status   ${summary.completed ? '已完成' : '未完成'}`,
    `Evidence ${summary.evidenceCount} 条`,
    'Notice   远程授权未恢复；本地附件需重新指定',
  ];
  return lines.join('\n');
}

/** 渲染会话列表；最近优先，最多显示 10 条。 */
export function renderSessionList(sessions: readonly string[]): string {
  if (sessions.length === 0) {
    return '暂无历史会话。\n';
  }
  return `${sessions.slice(0, 10).map((id) => `  ${id}`).join('\n')}\n`;
}
