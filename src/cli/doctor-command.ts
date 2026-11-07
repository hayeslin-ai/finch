/**
 * `doctor` 子命令。
 *
 * WHY：把检查逻辑放在 doctor 模块、只在这里做编排，
 * 避免 CLI 入口逐渐堆入业务判断，也让 doctor 能被测试直接调用。
 *
 * 重要：doctor 只读。不生成 OTP、不建立 SSH、不请求模型、不写入配置。
 */
import type { LoadedConfig } from '../config/load.js';
import { checkRemoteTools, type CheckResult } from '../doctor/checks.js';
import { computeExitCode, renderReport } from '../doctor/report.js';
import { readRemoteTools } from '../remote/connector.js';

/** Node 最低版本，与 package.json 的 engines 保持一致。 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 19;

/** 比较 Node 版本；只比较主次版本，足够表达引擎要求。 */
export function checkNodeVersion(version: string): CheckResult {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return { group: 'base', name: 'Node.js', status: 'config-error', actual: version };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    group: 'base',
    name: 'Node.js',
    status: ok ? 'pass' : 'version-mismatch',
    actual: version,
    expected: `>=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`,
    ...(ok ? {} : { hint: '升级 Node.js 后重试' }),
  };
}

/**
 * 汇总检查结果。
 *
 * 配置缺失按分组聚合为一条，而不是逐键刷屏：
 * 用户真正需要的是“哪一组不可用、如何补齐”，不是十行重复提示。
 */
export async function runDoctorChecks(
  config: LoadedConfig,
  options: { readonly checkRemote: boolean },
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [checkNodeVersion(process.version)];

  // 基础问题（目录缺失、权限、格式）逐条列出，因为它们需要分别修复。
  for (const issue of config.issues.filter((item) => item.group === 'base')) {
    results.push({ group: 'base', name: issue.key, status: 'config-error', hint: issue.reason });
  }

  // 非阻断提醒单独标记：用户应当知道，但不影响能力可用性。
  for (const warning of config.warnings) {
    results.push({
      group: warning.group,
      name: warning.key,
      status: 'warning',
      hint: warning.reason,
    });
  }

  if (config.available.base) {
    results.push({ group: 'base', name: '配置目录与权限', status: 'pass' });
  }

  // 本地与远程的缺失键聚合为一条，并列出键名（键名不是敏感值）。
  for (const group of ['local', 'remote'] as const) {
    const missing = config.issues.filter((issue) => issue.group === group);
    if (missing.length === 0 && config.available.base) {
      results.push({ group, name: group === 'local' ? '本地诊断配置' : '远程配置', status: 'pass' });
      continue;
    }
    if (missing.length > 0) {
      results.push({
        group,
        name: group === 'local' ? '本地诊断配置' : '远程配置',
        status: 'config-error',
        hint: `缺少或无效：${missing.map((issue) => issue.key).join(', ')}`,
      });
    }
  }

  if (options.checkRemote) {
    // EXPECT_PATH / LOGIN_SCRIPT / OATH_TOOL 只从进程环境变量读取，绝不写入配置文件。
    // 因此这里必须用运行时同一套读取方式：若改回 config.values，取值恒为 undefined，
    // 用户明明配好了也会永远看到「远程功能未配置」。
    const tools = readRemoteTools(process.env);
    if (!tools.ok) {
      results.push({
        group: 'remote',
        name: 'oathtool / expect',
        status: 'skipped',
        hint: `缺少环境变量：${tools.missing.join(', ')}`,
      });
    } else {
      results.push(
        ...(await checkRemoteTools({
          oathTool: tools.config.oathTool,
          expectPath: tools.config.expectPath,
          enabled: true,
        })),
      );
    }
  }

  return results;
}

/** 渲染并返回退出码，供 CLI 直接使用。 */
export function formatDoctorReport(results: readonly CheckResult[]): { text: string; exitCode: number } {
  return { text: renderReport(results), exitCode: computeExitCode(results) };
}
