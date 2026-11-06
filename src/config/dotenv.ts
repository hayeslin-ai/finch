/**
 * `.env` 字面量解析。
 *
 * WHY：认证材料与连接参数都放在用户目录的 `.env`。若使用 `source`、变量展开
 * 或命令替换，一个恶意或含特殊字符的密码就可能在本地被执行。
 * 因此这里只做字面量读取：支持 KEY=VALUE 与整值引号，其余一律不解释。
 */

/** 解析结果；错误只带行号与类别，绝不回显值。 */
export interface DotenvResult {
  readonly values: ReadonlyMap<string, string>;
  /** 格式错误；输出时只允许展示行号与原因。 */
  readonly errors: readonly DotenvError[];
}

export interface DotenvError {
  readonly line: number;
  readonly reason: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 `.env` 文本。
 *
 * 规则：
 * - 忽略空行与 `#` 开头的注释行。
 * - 允许 `export KEY=VALUE` 前缀，便于兼容常见写法。
 * - 值可用单引号或双引号包裹，引号内不做任何转义或展开。
 * - 重复键后者覆盖前者，但记录为错误，避免静默歧义。
 */
export function parseDotenv(text: string): DotenvResult {
  const values = new Map<string, string>();
  const errors: DotenvError[] = [];

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }

    if (line.startsWith('export ')) {
      line = line.slice('export '.length).trimStart();
    }

    const equals = line.indexOf('=');
    if (equals <= 0) {
      errors.push({ line: lineNumber, reason: '缺少 KEY=VALUE 结构' });
      return;
    }

    const key = line.slice(0, equals).trim();
    if (!KEY_PATTERN.test(key)) {
      errors.push({ line: lineNumber, reason: '键名不合法' });
      return;
    }

    let value = line.slice(equals + 1).trim();
    const quote = value.at(0);
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value.at(-1) !== quote) {
        errors.push({ line: lineNumber, reason: '引号未闭合' });
        return;
      }
      value = value.slice(1, -1);
    }

    if (values.has(key)) {
      errors.push({ line: lineNumber, reason: `重复的键：${key}` });
    }
    values.set(key, value);
  });

  return { values, errors };
}
