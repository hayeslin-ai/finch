/**
 * 探查预算控制。
 *
 * WHY：预算是安全边界的一部分——没有它，Agent 可能无限翻日志。
 * 三个细节容易做错，这里显式处理：
 * 1. 使用单调时钟，系统时间被调整时不产生负数或突然到期。
 * 2. 等待用户审批时暂停计时，否则用户思考时间会占用探查额度。
 * 3. 到期后只允许汇总，不再发放新的执行许可。
 */

/** 预算所处的阶段。 */
export type BudgetPhase = 'idle' | 'running' | 'paused' | 'expired' | 'cancelled';

export interface BudgetSnapshot {
  readonly phase: BudgetPhase;
  readonly totalMs: number;
  readonly consumedMs: number;
  readonly remainingMs: number;
  /** 剩余比例，用于状态行展示。 */
  readonly remainingRatio: number;
}

export interface BudgetOptions {
  readonly totalMs: number;
  /** 注入时钟便于测试；生产使用 performance.now()。 */
  readonly now?: () => number;
}

export class BudgetController {
  private readonly totalMs: number;
  private readonly now: () => number;
  private consumedMs = 0;
  private startedAt: number | undefined;
  private phase: BudgetPhase = 'idle';

  constructor(options: BudgetOptions) {
    if (!Number.isFinite(options.totalMs) || options.totalMs <= 0) {
      // 非法预算直接拒绝构造，避免出现“永不到期”的隐性后门。
      throw new Error('预算必须是正有限数');
    }
    this.totalMs = options.totalMs;
    this.now = options.now ?? (() => performance.now());
  }

  /** 开始计时；重复调用不重置已消耗时间。 */
  start(): void {
    if (this.phase === 'running') {
      return;
    }
    this.startedAt = this.now();
    this.phase = 'running';
  }

  /** 暂停计时，把已运行时间记入消耗。审批等待期间调用。 */
  pause(): void {
    if (this.phase !== 'running') {
      return;
    }
    this.accrue();
    this.startedAt = undefined;
    this.phase = 'paused';
  }

  /** 从暂停恢复。 */
  resume(): void {
    if (this.phase !== 'paused') {
      return;
    }
    this.startedAt = this.now();
    this.phase = 'running';
  }

  /** 用户中止。中止后不再有任何剩余预算。 */
  cancel(): void {
    this.accrue();
    this.startedAt = undefined;
    this.phase = 'cancelled';
  }

  /**
   * 是否还能发起新的探查。
   *
   * 暂停态也允许——暂停表示“等待用户输入”，用户提交后由 runTurn 恢复计时；
   * 若要求必须处于 running，空闲等待后再开工会被误判为预算用尽。
   * 只有到期（剩余为 0）或取消才真正拒绝。
   */
  canStartWork(): boolean {
    if (this.phase === 'cancelled') {
      return false;
    }
    return this.remainingMs() > 0;
  }

  remainingMs(): number {
    const consumed = this.phase === 'running' ? this.currentConsumed() : this.consumedMs;
    const remaining = Math.max(0, this.totalMs - consumed);
    if (remaining === 0 && (this.phase === 'running' || this.phase === 'paused')) {
      // 到期是状态转换而非副作用；这里只读取快照，不改 phase，
      // 由调用方在看到 canStartWork() 为 false 时停止新操作。
      return 0;
    }
    return remaining;
  }

  snapshot(): BudgetSnapshot {
    const consumed = this.phase === 'running' ? this.currentConsumed() : this.consumedMs;
    const remainingMs = Math.max(0, this.totalMs - consumed);
    const exhausted = remainingMs === 0 && (this.phase === 'running' || this.phase === 'paused');
    const phase: BudgetPhase = exhausted ? 'expired' : this.phase;

    return {
      phase,
      totalMs: this.totalMs,
      consumedMs: Math.min(consumed, this.totalMs),
      remainingMs,
      remainingRatio: remainingMs / this.totalMs,
    };
  }

  /** 计算当前累计消耗；供 remainingMs 与 snapshot 共用。 */
  private currentConsumed(): number {
    if (this.startedAt === undefined) {
      return this.consumedMs;
    }
    return this.consumedMs + (this.now() - this.startedAt);
  }

  /** 把正在运行的时间段结算进 consumedMs。 */
  private accrue(): void {
    if (this.startedAt === undefined) {
      return;
    }
    this.consumedMs = this.currentConsumed();
    this.startedAt = undefined;
  }
}
