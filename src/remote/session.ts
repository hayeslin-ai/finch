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
  decodeDonePayload,
  decodeFrame,
  encodeFrame,
  matchesRequest,
  type DonePayload,
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
  /**
   * 单条查询累积的 DATA 上限。
   *
   * WHY 在会话侧再限一次：远端输出规模不受模型控制，
   * 只靠脚本截断的话，一个被改坏的脚本就能把宿主内存和模型上下文一起拖垮。
   */
  readonly maxResultBytes?: number;
  readonly maxResultLines?: number;
}

/** 单条查询的默认累积上限（与 limits 默认值一致）。 */
const DEFAULT_MAX_RESULT_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULT_LINES = 2_000;

export interface RemoteResult {
  readonly state: SessionState;
  readonly ok: boolean;
  readonly frames: readonly Frame[];
  readonly message?: string;
  /** DONE 帧回传的结构化结果；缺失说明远端没有给出可靠终态。 */
  readonly done?: DonePayload;
  /** DATA 累积是否因上限被截断。 */
  readonly truncated?: boolean;
}

interface PendingRequest {
  readonly op: Opcode;
  readonly id: number;
  readonly nonce: string;
  readonly seq: number;
  readonly frames: Frame[];
  /** 已累积的 DATA 字节与行数；用于执行上限。 */
  bytes: number;
  lines: number;
  truncated: boolean;
  readonly resolve: (result: {
    ok: boolean;
    frames: Frame[];
    message?: string;
    done?: DonePayload;
    truncated?: boolean;
  }) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 从 READY 摘要里解析能力字段：`host=...;user=...;dir=...;caps=grep=1,zgrep=0`。
 *
 * 解析保持保守：格式不符的能力一律视为不支持，
 * 后续要用到该能力的操作会明确失败，而不是冒险执行。
 */
export function parseCapabilities(payload: string): Readonly<Record<string, boolean>> {
  const index = payload.indexOf('caps=');
  if (index === -1) {
    return {};
  }
  const segment = payload.slice(index + 'caps='.length).split(';')[0] ?? '';
  const caps: Record<string, boolean> = {};
  for (const item of segment.split(',')) {
    const [name, value] = item.split('=');
    if (name !== undefined && value !== undefined && /^[a-z]+$/.test(name)) {
      caps[name] = value === '1';
    }
  }
  return caps;
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
  /** READY 阶段探测到的远端工具能力；决定能否使用压缩日志模板。 */
  private caps: Readonly<Record<string, boolean>> = {};

  constructor(private readonly options: RemoteSessionOptions) {}

  get currentState(): SessionState {
    return this.state;
  }

  /** READY 阶段核对到的身份摘要；未连接时为空串。 */
  get identity(): string {
    return this.readyInfo;
  }

  /** 远端工具能力；未探测到的一律视为不支持。 */
  get capabilities(): Readonly<Record<string, boolean>> {
    return this.caps;
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
        bytes: 0,
        lines: 0,
        truncated: false,
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
      // 把输出上限随请求下发：脚本据此截断，宿主再按同一口径兜底。
      payload = toWirePayload(query, this.options.maxResultLines);
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
      ...(outcome.done === undefined ? {} : { done: outcome.done }),
      ...(outcome.truncated === undefined ? {} : { truncated: outcome.truncated }),
    };
  }

  /** 发送一帧并等待终态响应。 */
  private send(
    request: { op: Opcode; id: number; nonce: string; seq: number },
    payload: string,
    timeoutMs: number,
  ): Promise<{
    ok: boolean;
    frames: Frame[];
    message?: string;
    done?: DonePayload;
    truncated?: boolean;
  }> {
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

      this.pending = { ...request, frames: [], bytes: 0, lines: 0, truncated: false, timer, resolve };

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
      const payload = frame.payload ?? '';
      this.readyInfo = payload;
      this.caps = parseCapabilities(payload);
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ ok: true, frames: [frame] });
      return;
    }

    // READY 阶段还没有业务请求，脚本用 ERROR 帧报告失败（固定 id/nonce/seq）。
    // 此时没有请求可匹配，必须直接翻译成用户可读原因；
    // 否则会被当成串流并误报“错误帧与请求不匹配”，真正的失败原因被吞掉。
    if (pending.op === 'READY' && frame.op === 'ERROR') {
      this.failPending(new Error(frame.payload ?? '登录桥接失败'));
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
      this.appendData(pending, frame);
      return;
    }

    // DONE 是业务终态：op 固定为 DONE，只校验 id / nonce / seq。
    // 负载解析失败按协议错乱处理，不能当成“查询成功但没有数据”。
    if (frame.op === 'DONE') {
      const sameRequest =
        frame.id === pending.id && frame.nonce === pending.nonce && frame.seq === pending.seq;
      if (!sameRequest) {
        this.state = 'TERMINATION_UNKNOWN';
        this.failPending(new Error('终态帧与请求不匹配'));
        return;
      }
      let done: DonePayload;
      try {
        done = decodeDonePayload(frame.payload ?? '');
      } catch (error) {
        this.state = 'TERMINATION_UNKNOWN';
        this.failPending(error instanceof Error ? error : new Error('终态负载不合法'));
        return;
      }
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({
        ok: done.status === 'ok' || done.status === 'nomatch' || done.status === 'truncated',
        frames: pending.frames,
        done,
        ...(pending.truncated || done.truncated ? { truncated: true } : { truncated: false }),
        ...(done.status === 'error'
          ? { message: `远端命令失败（退出码 ${String(done.exit)}）` }
          : {}),
      });
      return;
    }

    // 兼容旧脚本：终态帧 op 等于请求类型。四项必须同时匹配。
    if (!matchesRequest(frame, pending)) {
      this.state = 'TERMINATION_UNKNOWN';
      this.failPending(new Error('响应与请求不匹配'));
      return;
    }

    if (frame.op === 'LIST' || frame.op === 'SEARCH' || frame.op === 'READ') {
      pending.frames.push(frame);
      clearTimeout(pending.timer);
      this.pending = undefined;
      // 没有 DONE 帧说明远端没给出可靠退出状态；按 Spec 8.3 不应当作成功。
      pending.resolve({
        ok: false,
        frames: pending.frames,
        message: '远端未提供查询终态，无法确认执行结果',
      });
    }
  }

  /**
   * 累积 DATA 帧并执行上限。
   *
   * 超限后仍继续接收（否则终态会被漏掉 → 误判未知终止），
   * 但不再保留更多帧，并由 truncated 如实告知调用方。
   */
  private appendData(pending: PendingRequest, frame: Frame): void {
    const maxBytes = this.options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    const maxLines = this.options.maxResultLines ?? DEFAULT_MAX_RESULT_LINES;
    const payload = frame.payload ?? '';
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const payloadLines = payload === '' ? 0 : payload.split('\n').length;

    if (pending.truncated || pending.bytes + payloadBytes > maxBytes || pending.lines + payloadLines > maxLines) {
      pending.truncated = true;
      return;
    }
    pending.bytes += payloadBytes;
    pending.lines += payloadLines;
    pending.frames.push(frame);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    pending.resolve({
      ok: false,
      frames: pending.frames,
      message: error.message,
      ...(pending.truncated ? { truncated: true } : {}),
    });
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
