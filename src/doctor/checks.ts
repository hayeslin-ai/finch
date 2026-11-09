/**
 * 环境检查项。
 *
 * WHY：Expect 与 oathtool 是系统级程序，npm 不会安装（见 Spec 4.1）。
 * 若把“缺 oathtool”当成整体失败，用户连本地粘贴日志都用不了。
 * 因此检查按能力分组，缺失只降级对应能力，并给出可复制的安装命令。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 检查分组，与 Spec 的 doctor 分层一致。 */
export type CheckGroup = 'base' | 'local' | 'remote' | 'optional';

export type CheckStatus =
  | 'pass'
  | 'missing'
  | 'version-mismatch'
  | 'config-error'
  | 'warning'
  | 'skipped';

export interface CheckResult {
  readonly group: CheckGroup;
  readonly name: string;
  readonly status: CheckStatus;
  /** 实际值；仅限版本号、路径类别等非敏感信息。 */
  readonly actual?: string;
  readonly expected?: string;
  /** 可复制的修复建议，不含密钥。 */
  readonly hint?: string;
}

/** 探测可执行文件是否可运行，并返回版本行；失败不抛异常。 */
export async function probeExecutable(
  command: string,
  versionArgs: readonly string[],
): Promise<{ ok: boolean; version?: string; reason?: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...versionArgs], { timeout: 5_000 });
    // 不同工具的版本信息可能输出到 stderr（如 expect -v），两者都要看。
    const text = `${stdout}${stderr}`.split('\n').find((line) => line.trim() !== '') ?? '';
    const version = /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1];
    return version === undefined ? { ok: true } : { ok: true, version };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    return { ok: false, reason: failure.code === 'ENOENT' ? '未找到可执行文件' : '执行失败' };
  }
}
