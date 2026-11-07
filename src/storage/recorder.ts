/**
 * 会话事件记录器。
 *
 * WHY：`-c` / `-r` / `--sessions` 依赖会话目录下的 events.jsonl，
 * 但事件是排障过程的副产品，不该拖慢主流程，更不该因为写盘失败中断诊断。
 * 因此这里做三件事：
 * - 序号在内存中递增，保证同一会话内 seq 单调；
 * - 写入串行排队，避免并发 appendFile 交错；
 * - 失败只吞掉，不影响诊断本身（会话记录不是安全边界）。
 */
import { appendEvent, type SessionEvent } from './session.js';

export class SessionRecorder {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly stateDir: string,
    readonly sessionId: string,
  ) {}

  /** 记录一条事件；不等待落盘。 */
  record(type: SessionEvent['type'], payload: Record<string, string | number> = {}): void {
    this.seq += 1;
    const event = { seq: this.seq, at: new Date().toISOString(), type, payload };
    this.tail = this.tail
      .then(() => appendEvent(this.stateDir, this.sessionId, event))
      .catch(() => undefined);
  }

  /** 等待已排队事件落盘；退出前调用，避免最后几条丢失。 */
  async flush(): Promise<void> {
    await this.tail;
  }
}
