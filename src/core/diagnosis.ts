/**
 * 单次诊断的编排。
 *
 * 负责把输入、证据、预算、审计、脱敏与模型会话串起来，
 * 但不直接依赖具体 CLI 或 SDK 细节——那些由调用方注入，
 * 便于测试与未来替换交互形态。
 *
 * 关键约束：
 * - 预算在等待用户输入时暂停，在模型与工具执行时计时。
 * - 模型输出经脱敏后才展示；引用不存在的证据编号会被提示。
 * - 证据与审计只保存脱敏内容。
 */
import { AuditLedger, type AuditEntry, type AuditOperation } from './audit.js';
import { BudgetController } from './budget.js';
import { EvidenceStore } from './evidence.js';

/** 模型事件的最小抽象；实现方负责把 SDK 事件映射到这里。 */
export interface DiagnosisTurnResult {
  readonly text: string;
  readonly aborted: boolean;
}

/** 会话驱动接口：由 Agent 适配层实现。 */
export interface TurnRunner {
  run(userText: string, hooks: TurnHooks): Promise<DiagnosisTurnResult>;
  abort(): Promise<void>;
}

/** 工具执行回调；用于把 SDK 事件转成审计与状态更新。 */
export interface TurnHooks {
  readonly onToolStart: (toolName: string) => void;
  readonly onToolEnd: (toolName: string, durationMs: number | undefined, failed: boolean) => void;
  readonly onTextDelta: (text: string) => void;
}

export interface DiagnosisOptions {
  readonly evidence: EvidenceStore;
  readonly audit: AuditLedger;
  readonly budget: BudgetController;
  /** 脱敏函数；所有展示文本都必须经过它。 */
  readonly sanitize: (text: string) => string;
  readonly now?: () => number;
}

/** 一次诊断的可变状态。 */
export class Diagnosis {
  readonly evidence: EvidenceStore;
  readonly audit: AuditLedger;
  readonly budget: BudgetController;
  private readonly sanitize: (text: string) => string;
  private readonly now: () => number;

  constructor(options: DiagnosisOptions) {
    this.evidence = options.evidence;
    this.audit = options.audit;
    this.budget = options.budget;
    this.sanitize = options.sanitize;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 执行一轮对话。
   *
   * 预算处理：调用前若处于暂停态则恢复计时，结束后重新暂停，
   * 这样用户阅读与思考的时间不会消耗探查额度。
   */
  async runTurn(runner: TurnRunner, userText: string, onDelta: (text: string) => void): Promise<DiagnosisTurnResult> {
    this.budget.resume();

    const hooks: TurnHooks = {
      onToolStart: (toolName) => {
        this.recordTool('SEARCH', toolName, 'started');
      },
      onToolEnd: (toolName, durationMs, failed) => {
        this.recordTool(failed ? 'DENY' : 'SEARCH', toolName, failed ? 'failed' : 'ok', durationMs);
      },
      onTextDelta: (text) => {
        const safe = this.sanitize(text);
        if (safe !== '') {
          onDelta(safe);
        }
      },
    };

    try {
      const result = await runner.run(userText, hooks);

      if (!this.budget.canStartWork() && !result.aborted) {
        // 预算到期不隐藏结果，但要在界面明确说明后续取证已停止。
        this.audit.record(this.entry('CLOSE', 'budget', 'expired', 'no further work', '-'));
      }

      return result;
    } finally {
      this.budget.pause();
    }
  }

  /** 校验模型输出引用的证据编号是否真实存在。 */
  verifyCitations(text: string): readonly string[] {
    return this.evidence.findUnknownIds(text);
  }

  /** 记录一次本地工具操作；供工具适配层调用。 */
  recordTool(operation: AuditOperation, toolName: string, result: string, durationMs?: number): void {
    const target = toolName.startsWith('local_') ? 'local' : toolName.startsWith('source_') ? 'repo' : 'remote';
    const params = toolName.replace(/^(local_log_|source_)/, '');
    this.audit.record({
      at: new Date(this.now()).toISOString(),
      operation,
      target,
      params,
      result,
      grant: '-',
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }

  private entry(operation: AuditOperation, target: string, params: string, result: string, grant: string): AuditEntry {
    return { at: new Date(this.now()).toISOString(), operation, target, params, result, grant };
  }
}
