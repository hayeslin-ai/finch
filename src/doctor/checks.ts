/**
 * 环境检查项。
 *
 * WHY：Expect 与 oathtool 是系统级程序，npm 不会安装（见 Spec 4.1）。
 * 若把“缺 oathtool”当成整体失败，用户连本地粘贴日志都用不了。
 * 因此检查按能力分组，缺失只降级对应能力，并给出可复制的安装命令。
 */
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
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

/** 检查路径是否存在且可执行，不执行它。 */
export async function inspectExecutable(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查 oathtool 与 Expect。
 *
 * 版本探测只执行 `--version` / `-v` 这类无副作用命令：
 * 不生成 OTP、不建立 SSH，也不读取任何密钥。
 */
export async function checkRemoteTools(input: {
  readonly oathTool: string;
  readonly expectPath: string;
  readonly enabled: boolean;
}): Promise<readonly CheckResult[]> {
  if (!input.enabled) {
    return [
      { group: 'remote', name: 'oathtool', status: 'skipped', hint: '远程功能未配置' },
      { group: 'remote', name: 'expect', status: 'skipped', hint: '远程功能未配置' },
    ];
  }

  const oathtool = await probeExecutable(input.oathTool, ['--version']);
  const expect = await probeExecutable(input.expectPath, ['-v']);

  return [
    oathtool.ok
      ? { group: 'optional', name: 'oathtool', status: 'pass', actual: oathtool.version ?? '已安装' }
      : {
          group: 'remote',
          name: 'oathtool',
          status: 'missing',
          hint: 'brew install oath-toolkit，然后设置 OATH_TOOL 为实际路径',
        },
    expect.ok
      ? { group: 'optional', name: 'expect', status: 'pass', actual: expect.version ?? '已安装' }
      : {
          group: 'remote',
          name: 'expect',
          status: 'missing',
          hint: 'macOS 通常自带 /usr/bin/expect；否则执行 brew install expect',
        },
  ];
}
