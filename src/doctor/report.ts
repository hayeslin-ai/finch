/**
 * doctor 报告渲染与退出码。
 *
 * WHY：用户需要快速判断“能不能用、缺什么、怎么修”。
 * 因此报告按能力分组、标注状态与修复命令，并且只输出非敏感信息。
 * 分组顺序固定，避免同一分组被拆成多段造成阅读困难。
 */
import type { CheckGroup, CheckResult, CheckStatus } from './checks.js';

/** 固定分组顺序；渲染时按此顺序聚合，而非按输入顺序。 */
const GROUP_ORDER: readonly CheckGroup[] = ['base', 'local', 'remote', 'optional'];

const GROUP_LABELS: Readonly<Record<CheckGroup, string>> = {
  base: '基础',
  local: '本地诊断',
  remote: '远程功能',
  optional: '可选',
};

const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: '通过',
  missing: '缺失',
  'version-mismatch': '版本不符',
  'config-error': '配置错误',
  skipped: '跳过',
};

/** 退出码：全部通过 0；仅可选缺失 0；基础或本地不可用 3。 */
export function computeExitCode(results: readonly CheckResult[]): number {
  const blocking = results.some(
    (result) =>
      (result.group === 'base' || result.group === 'local') &&
      result.status !== 'pass' &&
      result.status !== 'skipped',
  );
  return blocking ? 3 : 0;
}

/**
 * 渲染为纯文本。
 *
 * 未通过的分组逐项列出；全部通过时折叠为一行，避免刷屏。
 */
export function renderReport(results: readonly CheckResult[]): string {
  const lines: string[] = [];

  for (const group of GROUP_ORDER) {
    const groupResults = results.filter((result) => result.group === group);
    if (groupResults.length === 0) {
      continue;
    }

    lines.push(GROUP_LABELS[group]);
    for (const result of groupResults) {
      const detail = [result.actual, result.expected].filter(Boolean).join(' / ');
      const suffix = detail === '' ? '' : `  ${detail}`;
      lines.push(`  [${STATUS_LABELS[result.status]}] ${result.name}${suffix}`);
      if (result.hint !== undefined && result.status !== 'pass') {
        lines.push(`      → ${result.hint}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
