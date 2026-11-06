/**
 * `.env` 的增量更新。
 *
 * WHY：向导只改用户选定的键，其余键、注释与顺序必须保留。
 * 若整文件重写，用户手工添加的说明、其他 provider 配置或尚未迁移的字段
 * 会静默消失——这在实际排障时是不可接受的。
 *
 * 因此这里做“按行替换 + 追加缺失键”，并统一加引号，保证特殊字符可安全回读。
 */

/** 定位并替换单个键；不改动其他行。 */
function replaceLine(lines: string[], key: string, value: string): boolean {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && pattern.test(line)) {
      lines[index] = `${key}=${quoteValue(value)}`;
      return true;
    }
  }
  return false;
}

/**
 * 值统一用双引号包裹，并拒绝无法安全表示的内容。
 * 双引号不会引起 .env 解析器的变量展开，因为本项目解析器按字面量处理。
 */
function quoteValue(value: string): string {
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error('配置值不能包含换行或控制字符');
  }
  if (value.includes('"')) {
    throw new Error('配置值不能包含双引号');
  }
  return `"${value}"`;
}

/**
 * 更新或追加若干键。
 *
 * updates 的插入顺序决定追加顺序，便于生成可读的配置文件。
 */
export function updateEnvContent(original: string, updates: ReadonlyMap<string, string>): string {
  const hadTrailingNewline = original.endsWith('\n');
  const lines = original === '' ? [] : original.split(/\r?\n/);
  if (hadTrailingNewline) {
    lines.pop();
  }

  const missing: string[] = [];
  for (const [key, value] of updates) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`键名不合法：${key}`);
    }
    if (!replaceLine(lines, key, value)) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    if (lines.length > 0 && lines.at(-1) !== '') {
      lines.push('');
    }
    for (const key of missing) {
      lines.push(`${key}=${quoteValue(updates.get(key) ?? '')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** 从现有内容里取出某个键的原始值，用于展示“已设置”而不展示内容。 */
export function hasKeyWithValue(original: string, key: string): boolean {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+)$`, 'm');
  const match = pattern.exec(original);
  if (match === null) {
    return false;
  }
  const raw = (match[1] ?? '').trim();
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2');
  return unquoted !== '';
}
