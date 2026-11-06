/**
 * 把 SDK 会话适配成诊断轮次。
 *
 * WHY：核心诊断逻辑不应直接依赖 SDK 事件结构。
 * 这里集中处理事件映射、取消与错误转换，避免 SDK 细节泄漏到上层。
 */
import type { AgentSession } from '@earendil-works/pi-coding-agent';

import type { DiagnosisTurnResult, TurnHooks, TurnRunner } from '../core/diagnosis.js';

/** SDK 事件中本项目关心的最小字段。 */
interface ToolEndEvent {
  readonly type: 'tool_execution_end';
  readonly toolName: string;
  readonly isError: boolean;
  readonly durationMs?: number;
}

export interface SessionTurnRunnerOptions {
  readonly session: AgentSession;
  /** 脱敏函数；模型输出在进入上层前必须处理。 */
  readonly sanitize: (text: string) => string;
}

/** 基于 SDK 会话的轮次执行器。 */
export class SessionTurnRunner implements TurnRunner {
  private readonly session: AgentSession;
  private readonly sanitize: (text: string) => string;
  private unsubscribe: (() => void) | undefined;

  constructor(options: SessionTurnRunnerOptions) {
    this.session = options.session;
    this.sanitize = options.sanitize;
  }

  async run(userText: string, hooks: TurnHooks): Promise<DiagnosisTurnResult> {
    let text = '';
    let aborted = false;

    this.unsubscribe?.();
    this.unsubscribe = this.session.subscribe((event) => {
      switch (event.type) {
        case 'message_update': {
          const assistant = event.assistantMessageEvent;
          if (assistant.type === 'text_delta') {
            text += assistant.delta;
            hooks.onTextDelta(assistant.delta);
          }
          break;
        }
        case 'tool_execution_start':
          hooks.onToolStart(event.toolName);
          break;
        case 'tool_execution_end': {
          const toolEvent = event as unknown as ToolEndEvent;
          hooks.onToolEnd(toolEvent.toolName, toolEvent.durationMs, toolEvent.isError);
          break;
        }
        case 'agent_settled':
          aborted = event.aborted;
          break;
        default:
          break;
      }
    });

    try {
      await this.session.prompt(userText);
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }

    // 输出统一在边界脱敏一次，避免上层多处遗漏。
    return { text: this.sanitize(text), aborted };
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
