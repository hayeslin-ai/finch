/**
 * 远程会话状态机。
 *
 * 通过注入的传输层与桥接脚本交互；本模块不启动任何进程，
 * 因此可以在完全不接触真实服务器的前提下验证状态转换。
 * 真实子进程由 createSpawnTransport 提供，测试使用内存假实现。
 *
 * 关键不变量（Spec 8.1–8.5）：
 * - 只有收到 READY 帧才进入就绪；提示符与静默都不算证据。
 * - 非就绪状态拒绝发送查询，未通过本地校验的参数也不会被送出。
 * - 超时或协议错乱进入 TERMINATION_UNKNOWN，随后弃用连接，不重放命令。
 * - 关闭时不再发送任何业务命令。
 */
import {
  ProtocolError,
  createNonce,
  decodeFrame,
  encodeFrame,
  matchesRequest,
  type Frame,
  type Opcode,
} from './protocol.js';
import { QueryValidationError, toWirePayload, type RemoteQuery } from './queries.js';
import type { RemoteTransport } from './transport.js';

/** 会话状态；与 Spec 8.3 对齐。 */
export type SessionState =
  | 'DISCONNECTED'
  | 'VERIFYING'
  | 'READY'
  | 'RUNNING'
  | 'TERMINATION_UNKNOWN'
  | 'FAILED'
  | 'CLOSED';

export interface RemoteSessionOptions {
  /** 建立连接的总时限，包含认证、目标选择与目录核对。 */
  readonly connectTimeoutMs: number;
  /** 单条查询时限。 */
  readonly queryTimeoutMs: number;
}

export interface RemoteResult {
  readonly state: SessionState;
  readonly ok: boolean;
  readonly frames: readonly Frame[];
  readonly message?: string;
}

interface PendingRequest {
  readonly op: Opcode;
  readonly id: number;
  readonly nonce: string;
  readonly seq: number;
  readonly frames: Frame[];
  readonly resolve: (result: { ok: boolean; frames: Frame[]; message?: string }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** 远程会话；同一实例只维护一条连接。 */
export class RemoteSession {
  private transport: RemoteTransport | undefined;
  private state: SessionState = 'DISCONNECTED';
  private requestId = 0;
  private seq = 0;
  private pending: PendingRequest | undefined;
  /** READY 帧回传的身份摘要，供界面核对；不含凭证。 */
  private readyInfo = '';

  constructor(private readonly options: RemoteSessionOptions) {}

  get currentState(): SessionState {
    return this.state;
  }

  /** READY 阶段核对到的身份摘要；未连接时为空串。 */
  get identity(): string {
    return this.readyInfo;
  }

  /**
   * 接入一个已建立的传输并等待 READY。
   *
   * 传输由调用方创建，本方法只负责协议与状态，
   * 这样“是否真的登录了服务器”与“状态机是否正确”可以分别验证。
   */
  async attach(transport: RemoteTransport): Promise<RemoteResult> {
    if (this.state === 'READY' || this.state === 'RUNNING' || this.state === 'VERIFYING') {
      return { state: this.state, ok: false, frames: [], message: '会话已存在' };
    }

    this.transport = transport;
    this.state = 'VERIFYING';

    transport.onLine((line) => this.handleLine(line));
    transport.onExit(() => {
      if (this.state === 'READY' || this.state === 'RUNNING') {
        // 进程异常退出：远端执行状态未知，必须如实标记。
        this.state = 'TERMINATION_UNKNOWN';
      } else if (this.state !== 'CLOSED' && this.state !== 'FAILED') {
        this.state = 'CLOSED';
      }
      this.failPending(new Error('桥接进程已退出'));
    });

    const ready = await this.waitForReady(this.options.connectTimeoutMs);
    if (!ready.ok) {
      this.disposeTransport();
      this.state = 'FAILED';
      return ready;
    }

    this.state = 'READY';
    return ready;
  }

  /** 等待 READY 帧；超时即失败，不猜测已就绪。 */
  private waitForReady(timeoutMs: number): Promise<RemoteResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        resolve({
          state: this.state,
          ok: false,
          frames: [],
          message: '登录或目标核对超时，未确认已就绪',
        });
      }, timeoutMs);

      this.pending = {
        op: 'READY',
        id: -1,
        nonce: 'ready',
        seq: 0,
        frames: [],
        timer,
        resolve: (result) => resolve({ state: this.state, ...result }),
      };
    });
  }

  /**
   * 执行一条查询。
   *
   * 非就绪状态直接拒绝；非法参数在本地拦下，不会送到远端。
   */
  async query(query: RemoteQuery, timeoutMs = this.options.queryTimeoutMs): Promise<RemoteResult> {
    if (this.state !== 'READY') {
      return { state: this.state, ok: false, frames: [], message: '连接未就绪，拒绝查询' };
    }
    if (this.transport === undefined) {
      return { state: this.state, ok: false, frames: [], message: '连接不可用' };
    }

    let payload: string;
    try {
      payload = toWirePayload(query);
    } catch (error) {
      // 参数不合法统一转成用户可读结果，不中断会话；
      // 只有 QueryValidationError 属于「用户输入问题」，
      // 其余异常一律上抛，避免把程序缺陷伪装成参数问题。
      if (error instanceof QueryValidationError) {
        return { state: this.state, ok: false, frames: [], message: error.message };
      }
      throw error;
    }

    this.requestId += 1;
    this.seq += 1;
    const request = { op: query.kind, id: this.requestId, nonce: createNonce(), seq: this.seq };

    this.state = 'RUNNING';
    const outcome = await this.send(request, payload, timeoutMs);
    // send 内部可能因超时或协议错乱把状态改成未知终止；
    // 通过 getter 读取以免 TypeScript 对 this.state 做控制流收窄。
    if (this.currentState !== 'TERMINATION_UNKNOWN') {
      this.state = 'READY';
    }

    return {
      state: this.state,
      ok: outcome.ok,
      frames: outcome.frames,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    };
  }

  /** 发送一帧并等待终态响应。 */
  private send(
    request: { op: Opcode; id: number; nonce: string; seq: number },
    payload: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; frames: Frame[]; message?: string }> {
    return new Promise((resolve) => {
      if (this.transport === undefined) {
        resolve({ ok: false, frames: [], message: '连接不可用' });
        return;
      }

      const timer = setTimeout(() => {
        // 超时不代表远端停止：标记未知终止，由调用方弃用连接。
        this.state = 'TERMINATION_UNKNOWN';
        this.pending = undefined;
        resolve({ ok: false, frames: [], message: '查询超时，远端执行状态未知' });
      }, timeoutMs);

      this.pending = { ...request, frames: [], timer, resolve };

      try {
        this.transport.write(
          encodeFrame({
            v: 1,
            op: request.op,
            id: request.id,
            nonce: request.nonce,
            seq: request.seq,
            payload,
          }).trimEnd(),
        );
      } catch {
        clearTimeout(timer);
        this.pending = undefined;
        resolve({ ok: false, frames: [], message: '写入失败' });
      }
    });
  }

  /** 处理桥接输出的一行。非协议内容不作为证据，也不会改变状态。 */
  private handleLine(line: string): void {
    let frame: Frame;
    try {
      frame = decodeFrame(line);
    } catch (error) {
      if (error instanceof ProtocolError && this.state === 'RUNNING') {
        // 运行期出现非协议输出：无法确认远端状态，失败关闭。
        this.state = 'TERMINATION_UNKNOWN';
        this.failPending(new Error('查询期间出现非协议输出'));
      }
      return;
    }

    const pending = this.pending;
    if (pending === undefined) {
      return;
    }

    if (pending.op === 'READY' && frame.op === 'READY') {
      this.readyInfo = frame.payload ?? '';
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ ok: true, frames: [frame] });
      return;
    }

    // ERROR 是通用故障帧，其 op 固定为 ERROR 而非请求类型，
    // 因此只校验 id / nonce / seq 三项，仍能防止串流与伪造。
    if (frame.op === 'ERROR') {
      const sameRequest =
        frame.id === pending.id && frame.nonce === pending.nonce && frame.seq === pending.seq;
      if (!sameRequest) {
        this.state = 'TERMINATION_UNKNOWN';
        this.failPending(new Error('错误帧与请求不匹配'));
        return;
      }
      this.failPending(new Error(frame.payload ?? '远端返回错误'));
      return;
    }

    // DATA 是传输中的片段帧，op 固定为 DATA；
    // 仍须校验 id / nonce / seq，确保属于当前请求。
    if (frame.op === 'DATA') {
      const sameRequest =
        frame.id === pending.id && frame.nonce === pending.nonce && frame.seq === pending.seq;
      if (!sameRequest) {
        this.state = 'TERMINATION_UNKNOWN';
        this.failPending(new Error('数据帧与请求不匹配'));
        return;
      }
      pending.frames.push(frame);
      return;
    }

    // 终态帧必须四项同时匹配，否则视为串流或伪造，失败关闭。
    if (!matchesRequest(frame, pending)) {
      this.state = 'TERMINATION_UNKNOWN';
      this.failPending(new Error('响应与请求不匹配'));
      return;
    }

    if (frame.op === 'LIST' || frame.op === 'SEARCH' || frame.op === 'READ') {
      pending.frames.push(frame);
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ ok: true, frames: pending.frames });
    }
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    pending.resolve({ ok: false, frames: pending.frames, message: error.message });
  }

  /**
   * 关闭连接。
   *
   * 未知终止状态下不再发送任何命令，直接弃用连接。
   */
  async close(): Promise<void> {
    if (this.transport !== undefined && this.state === 'READY') {
      this.requestId += 1;
      this.seq += 1;
      try {
        this.transport.write(
          encodeFrame({
            v: 1,
            op: 'CLOSE',
            id: this.requestId,
            nonce: createNonce(),
            seq: this.seq,
          }).trimEnd(),
        );
      } catch {
        // 关闭指令失败不阻断销毁。
      }
    }
    this.disposeTransport();
  }

  private disposeTransport(): void {
    const transport = this.transport;
    this.transport = undefined;
    if (this.state !== 'TERMINATION_UNKNOWN') {
      this.state = 'CLOSED';
    }
    transport?.close();
  }
}
