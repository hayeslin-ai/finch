/**
 * 脱敏。
 *
 * 设计原则（与 PRD 第 6 节一致）：
 * - 在同一运行会话内，相同敏感值映射为相同占位符，保留关联分析能力。
 * - 不同值必须可区分，不能全替换成同一个 `***`。
 * - 映射只在内存中；退出或新会话即丢弃，不写入任何持久化对象。
 * - 流式输入必须能跨 chunk 处理，否则被切开的密钥会漏出。
 *
 * 明确不承诺：规则匹配不可能识别所有敏感数据。
 * 调用方不得把“已脱敏”宣传为“绝无敏感内容”。
 */

export interface RedactionRule {
  readonly id: string;
  /** 正则必须带全局标志，否则只会替换第一处。 */
  readonly pattern: RegExp;
  /** 占位符前缀，例如 SECRET、EMAIL。 */
  readonly label: string;
}

/** 内置规则：覆盖凭证与常见个人标识。 */
export const DEFAULT_RULES: readonly RedactionRule[] = [
  // 连接串中的密码：scheme://user:password@host
  { id: 'url-credentials', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, label: 'URL_CREDENTIAL' },
  { id: 'authorization', pattern: /(\bAuthorization\s*[:=]\s*)(Bearer\s+)?[A-Za-z0-9._~+/-]{8,}=*/gi, label: 'AUTH' },
  { id: 'api-key', pattern: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/gi, label: 'API_KEY' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'JWT' },
  { id: 'password-field', pattern: /(\b(?:password|passwd|pwd|secret|token|apiKey|api_key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, label: 'SECRET' },
  { id: 'id-card', pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, label: 'ID_CARD' },
  { id: 'phone', pattern: /\b1[3-9]\d{9}\b/g, label: 'PHONE' },
  { id: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'EMAIL' },
];

/**
 * 脱敏器。
 *
 * 同一实例内相同原值复用同一编号；编号按出现顺序分配，
 * 因此 `SECRET_1` 在同一会话中始终指同一个值。
 */
export class Redactor {
  private readonly rules: readonly RedactionRule[];
  private readonly counter = new Map<string, number>();
  private readonly forward = new Map<string, string>();

  constructor(rules: readonly RedactionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  /** 对单段文本脱敏。 */
  redact(text: string): string {
    let result = text;
    for (const rule of this.rules) {
      // 每次使用前重置 lastIndex，避免全局正则的状态在多次调用间泄漏。
      rule.pattern.lastIndex = 0;
      result = result.replace(rule.pattern, (...args: unknown[]) => {
        const match = String(args[0]);
        // 带捕获组的规则（如连接串、password 字段）保留组 1 与组 2，
        // 仅替换真正的敏感部分，避免破坏可读性。
        if (typeof args[1] === 'string' && typeof args[2] === 'string' && args.length > 4) {
          const prefix = args[1];
          const suffix = args[2];
          const secret = match.slice(prefix.length, match.length - suffix.length);
          return `${prefix}${this.placeholderFor(rule.label, secret)}${suffix}`;
        }
        return this.placeholderFor(rule.label, match);
      });
    }
    return result;
  }

  /** 已建立的占位符数量，用于测试与诊断摘要（不含原值）。 */
  get placeholderCount(): number {
    return this.forward.size;
  }

  /** 丢弃映射引用；GC 时机由运行时决定，这里不宣称强制擦除内存。 */
  clear(): void {
    this.counter.clear();
    this.forward.clear();
  }

  private placeholderFor(label: string, value: string): string {
    const existing = this.forward.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const next = (this.counter.get(label) ?? 0) + 1;
    this.counter.set(label, next);
    const placeholder = `<${label}_${next}>`;
    this.forward.set(value, placeholder);
    return placeholder;
  }
}

/**
 * 跨 chunk 脱敏流。
 *
 * WHY：网络与文件流会在任意位置切开文本。若对每个 chunk 单独替换，
 * 被切开的密钥两半都不匹配规则，就会原样漏出。
 * 因此这里保留一个“未决尾部”，只在确认安全边界后才输出。
 */
export class StreamingRedactor {
  private buffer = '';

  constructor(private readonly redactor: Redactor) {}

  /**
   * 处理一段输入，返回可安全输出的前缀。
   * 保守策略：只输出到最后一个换行之后，其余留待下次判断。
   * 这是为了不让被切开的凭证前缀提前输出。
   */
  push(chunk: string): string {
    this.buffer += chunk;
    const lastNewline = this.buffer.lastIndexOf('\n');
    if (lastNewline < 0) {
      // 尚无完整行：暂不输出。长行由调用方的输出上限兜底。
      return '';
    }
    const complete = this.buffer.slice(0, lastNewline + 1);
    this.buffer = this.buffer.slice(lastNewline + 1);
    return this.redactor.redact(complete);
  }

  /** 流结束时输出剩余内容；此时已确认没有更多拼接可能。 */
  flush(): string {
    const remainder = this.buffer;
    this.buffer = '';
    return this.redactor.redact(remainder);
  }
}
