/**
 * `/remote` 查询计划的待确认状态（纯内存）。
 *
 * WHY 单独一层：`/remote` 命令与 `remote_query_plan` 工具在宿主里是两处注册点，
 * 若各存一份状态，就会出现“命令登记了待确认请求、工具却读不到”的静默失联，
 * 也无法保证“一次 /remote 只能提交一次计划”。
 *
 * 边界：
 * - 只保存目标与用户原始诉求，不落盘、不进入会话记录；
 * - 提交计划时先取走再处理：确认与拒绝都会清空，重复提交直接失败；
 * - `/remote-close`、连接失败与授权成功同样清空，避免旧请求被下次工具调用捡起。
 */

/** 一次待确认的远程请求。 */
export interface PendingRemoteRequest {
  readonly target: string;
  /** 用户原始诉求；进入模型前已由输入钩子脱敏。 */
  readonly instruction: string;
}

export class RemotePlanGate {
  private pending: PendingRemoteRequest | undefined;

  /** 登记新请求；同一会话只保留最近一次 `/remote`。 */
  set(target: string, instruction: string): void {
    this.pending = { target, instruction };
  }

  /** 读取当前请求；不消费，供工具在确认前展示目标与诉求。 */
  current(): PendingRemoteRequest | undefined {
    return this.pending;
  }

  /** 清空待确认请求；重复清空是安全的。 */
  clear(): void {
    this.pending = undefined;
  }

  get active(): boolean {
    return this.pending !== undefined;
  }
}
