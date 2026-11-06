/**
 * 目标服务器校验。
 *
 * WHY：堡垒机资产菜单支持模糊匹配，输错会被带到同网段的其他机器。
 * 因此先把输入限制在两个允许的资产网段内，并严格按数值解析四段，
 * 避免 `22.50.1.1.evil` 这类伪前缀通过字符串比较。
 */

/** 允许的目标网段，与 PRD 一致。 */
const ALLOWED_PREFIXES: ReadonlyArray<readonly [number, number]> = [
  [22, 50],
  [10, 80],
];

/** 严格 IPv4 字面量：四段十进制，前导零仅允许单字符 0。 */
const IPV4_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

export interface TargetValidation {
  readonly ok: boolean;
  /** 失败原因；仅描述规则，不回显调用方传入的完整值。 */
  readonly reason?: string;
}

/**
 * 校验目标是否为允许网段内的 IPv4 字面量。
 *
 * 不做 DNS 解析、不接受主机名、端口、路径或任何非标准写法；
 * 拒绝后由调用方决定提示还是回退默认目标，本函数不提供回退。
 */
export function validateTargetHost(value: string): TargetValidation {
  if (value !== value.trim()) {
    return { ok: false, reason: '目标前后不得包含空白' };
  }

  const match = IPV4_PATTERN.exec(value);
  if (match === null) {
    return { ok: false, reason: '目标必须是标准 IPv4 字面量，不接受主机名、端口或路径' };
  }

  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return { ok: false, reason: 'IPv4 每段必须在 0 到 255 之间' };
  }

  const [first, second] = octets as [number, number, number, number];
  const allowed = ALLOWED_PREFIXES.some(([a, b]) => first === a && second === b);
  if (!allowed) {
    return { ok: false, reason: '目标必须属于 22.50.0.0/16 或 10.80.0.0/16' };
  }

  return { ok: true };
}
