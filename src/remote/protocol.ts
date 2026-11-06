/**
 * 远程桥接协议。
 *
 * WHY：Expect 与 Node 之间必须有一条可校验、不可伪造的通道。
 * 若直接用“输出文本 + 正则匹配”，日志里出现的任意字样都可能被当成控制指令。
 * 因此协议要求：
 * - 每个请求带独立随机 nonce 与递增 ID；
 * - 帧有明确边界与长度上限；
 * - 未知、过期、重复、错序的帧一律拒绝。
 *
 * 重要边界：nonce 只防日志文本偶然碰撞与串流，不是密码学远端认证。
 */

/** 允许的操作；不接受任意指令字符串。 */
export const OPCODES = ['LIST', 'SEARCH', 'READ', 'CANCEL', 'CLOSE', 'READY', 'DATA', 'ERROR'] as const;
export type Opcode = (typeof OPCODES)[number];

export interface Frame {
  readonly v: 1;
  readonly op: Opcode;
  readonly id: number;
  /** 每次请求独立的随机串；响应必须原样回传。 */
  readonly nonce: string;
  /** 序号，从 1 递增；用于检测丢失与乱序。 */
  readonly seq: number;
  readonly payload?: string;
}

/** 单帧最大负载；超限直接判定协议错误，避免被超大输出拖垮。 */
const MAX_PAYLOAD_BYTES = 512 * 1024;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** 生成请求 nonce：128 位随机，十六进制表示。 */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** 编码为单行文本帧；payload 用 JSON 字符串转义，避免替换符与控制字符穿透。 */
export function encodeFrame(frame: Frame): string {
  const payload = frame.payload === undefined ? '' : frame.payload;
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError('负载超过单帧上限');
  }
  // 使用 JSON 编码整帧，保证换行与特殊字符不会破坏帧边界。
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 解析一行文本为帧。
 *
 * 任何不确定的情况都抛错，由调用方转换为协议失败，
 * 不做“尽量解析”——猜测会掩盖真正的协议问题。
 */
export function decodeFrame(line: string): Frame {
  const trimmed = line.trim();
  if (trimmed === '') {
    throw new ProtocolError('空帧');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProtocolError('帧不是合法 JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('帧必须是对象');
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate['v'] !== 1) {
    throw new ProtocolError('协议版本不支持');
  }
  const op = candidate['op'];
  if (typeof op !== 'string' || !(OPCODES as readonly string[]).includes(op)) {
    throw new ProtocolError('未知操作');
  }
  if (typeof candidate['id'] !== 'number' || !Number.isInteger(candidate['id']) || candidate['id'] < 0) {
    throw new ProtocolError('请求 ID 不合法');
  }
  // READY 是连接建立前的固定帧，没有可回传的请求 nonce；
  // 其余操作必须使用 16–64 位十六进制随机串。
  const nonceValue = candidate['nonce'];
  if (typeof nonceValue !== 'string') {
    throw new ProtocolError('nonce 不合法');
  }
  if (op === 'READY') {
    if (nonceValue !== 'ready') {
      throw new ProtocolError('READY 帧的 nonce 必须是固定标记');
    }
  } else if (!/^[0-9a-f]{16,64}$/.test(nonceValue)) {
    throw new ProtocolError('nonce 不合法');
  }
  // READY 不属于任何请求序列，使用 0；其余帧序号从 1 开始。
  const seqValue = candidate['seq'];
  const minSeq = op === 'READY' ? 0 : 1;
  if (typeof seqValue !== 'number' || !Number.isInteger(seqValue) || seqValue < minSeq) {
    throw new ProtocolError('序号不合法');
  }
  const payload = candidate['payload'];
  if (payload !== undefined && typeof payload !== 'string') {
    throw new ProtocolError('负载必须是字符串');
  }
  if (typeof payload === 'string' && Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ProtocolError('负载超过单帧上限');
  }

  return {
    v: 1,
    op: op as Opcode,
    id: candidate['id'],
    nonce: nonceValue,
    seq: seqValue,
    ...(payload === undefined ? {} : { payload }),
  };
}

/**
 * 校验响应是否属于某个请求。
 *
 * 四项必须同时匹配：请求 ID、nonce、操作类型与序号。
 * 不匹配即视为串流或伪造，直接失败关闭。
 */
export function matchesRequest(
  response: Frame,
  request: { readonly id: number; readonly nonce: string; readonly op: Opcode; readonly seq: number },
): boolean {
  return (
    response.id === request.id &&
    response.nonce === request.nonce &&
    response.op === request.op &&
    response.seq === request.seq
  );
}
