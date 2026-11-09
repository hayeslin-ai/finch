/**
 * `doctor` 子命令。
 *
 * WHY：把检查逻辑放在 doctor 模块、只在这里做编排，
 * 避免 CLI 入口逐渐堆入业务判断，也让 doctor 能被测试直接调用。
 *
 * 重要：doctor 不生成 OTP、不建立 SSH、不请求模型、不写用户配置。
 * 唯一会落盘的是程序自带的登录脚本：它随包分发、由程序维护，
 * 用户不需要指定路径；`--remote` 时确保其存在并与当前版本一致。
 */
import type { AppPaths } from '../config/paths.js';
import type { LoadedConfig } from '../config/load.js';
import { probeExecutable, type CheckResult } from '../doctor/checks.js';
import { computeExitCode, renderReport } from '../doctor/report.js';
import { readRemoteTools, type RemoteToolStatus } from '../remote/connector.js';
import { ensureLoginScript } from '../remote/login-script.js';

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
  options: { readonly checkRemote: boolean; readonly paths: AppPaths },
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
    // 登录脚本随包分发，固定生成到配置目录；用户不再需要 LOGIN_SCRIPT。
    // 这里只确保程序管理的文件就位，不修改 .env、models.json 等用户配置。
    const script = await ensureLoginScript(options.paths);
    results.push(
      script.ok
        ? { group: 'remote', name: '登录脚本', status: 'pass', actual: script.path }
        : {
            group: 'remote',
            name: '登录脚本',
            status: 'config-error',
            hint: script.reason ?? '无法生成登录脚本',
          },
    );

    // Expect 与 oathtool 默认从 PATH 查找（环境变量可覆盖）。
    // 找到即通过并标注来源，不再提示“未安装”或“缺少环境变量”。
    const tools = readRemoteTools(process.env, script.path);
    results.push(await checkTool(tools.expect), await checkTool(tools.oathtool));
  }

  return results;
}

/**
 * 把工具解析结果转换成 doctor 检查项。
 *
 * 找到：探测版本并标注来源（PATH / 环境变量）。
 * 显式路径无效：报配置错误，不回退到 PATH。
 * 完全找不到：才给出安装命令。
 */
async function checkTool(tool: RemoteToolStatus): Promise<CheckResult> {
  if (tool.path === undefined) {
    if (tool.error !== undefined) {
      return { group: 'remote', name: tool.name, status: 'config-error', hint: tool.error };
    }
    return {
      group: 'remote',
      name: tool.name,
      status: 'missing',
      hint: `${tool.installHint}；或设置 ${tool.envKey} 指向可执行文件`,
    };
  }

  const probe = await probeExecutable(tool.path, tool.name === 'expect' ? ['-v'] : ['--version']);
  if (!probe.ok) {
    return {
      group: 'remote',
      name: tool.name,
      status: 'config-error',
      actual: tool.path,
      hint: `${tool.envKey} 指向的程序无法执行；${tool.installHint}`,
    };
  }

  const source = tool.source === 'env' ? '环境变量' : 'PATH';
  const version = probe.version === undefined ? '' : ` v${probe.version}`;
  return {
    group: 'optional',
    name: tool.name,
    status: 'pass',
    actual: `${tool.path}（${source}${version}）`,
  };
}

/** 渲染并返回退出码，供 CLI 直接使用。 */
export function formatDoctorReport(results: readonly CheckResult[]): { text: string; exitCode: number } {
  return { text: renderReport(results), exitCode: computeExitCode(results) };
}
