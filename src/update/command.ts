/**
 * `finch update` 的实现，以及 TUI 内"按 u 更新"复用的同一套流程。
 *
 * WHY 两处共用：CLI 子命令与交互界面里的快捷键如果各写一份安装逻辑，
 * 迟早出现"命令能装、快捷键装不上"的漂移。这里把
 * 「查版本 → 检查可写 → 确认 → 安装 → 回读校验」收成一条链路，
 * 差异只在输出通道（stdout 继承 vs TUI 捕获）。
 *
 * 安全边界：本命令是目前唯一会写全局目录的动作，
 * 因此必须先打印将要执行的完整命令，并默认要求确认。
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  fetchLatestVersion,
  markSkipped,
  readCache,
  writeCache,
  type UpdateTransport,
} from './check.js';
import { INSTALL_TARBALL_URL } from './source.js';

/** 退出码约定与 CLI 入口保持一致。 */
export const UPDATE_EXIT_OK = 0;
export const UPDATE_EXIT_USAGE = 2;
export const UPDATE_EXIT_UNAVAILABLE = 3;

/** npm 安装的超时；离线或代理卡死时不必无限等待。 */
const INSTALL_TIMEOUT_MS = 180_000;

/** 输出与确认的注入点；CLI 用 stdout/readline，TUI 用 ctx.ui。 */
export interface UpdateIo {
  readonly out: (line: string) => void;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  /** 错误信息通道；默认与 out 相同。 */
  readonly err?: (line: string) => void;
}

/** 子进程执行结果；失败时也带输出，便于原样回显原因。 */
export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<CommandResult>;

/** 平台上的 npm 可执行名。 */
function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * 捕获式执行：stdout/stderr 全部拿到手里。
 *
 * WHY 不用 promisify(execFile)：它的类型声明不接受 stdio 选项，
 * 而我们需要显式限定为管道（不能让子进程直写终端）。因此直接包回调。
 */
function execCapture(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr, code: 0 });
          return;
        }
        const failure = error as { code?: number | string };
        resolve({
          ok: false,
          stdout,
          stderr,
          // 超时等信号终止时 code 可能是字符串，统一归为 1。
          code: typeof failure.code === 'number' ? failure.code : 1,
        });
      },
    );
  });
}

/**
 * 默认执行器。
 *
 * WHY 子进程永远捕获输出、不直写终端：TUI 下直写会与 Pi 的全屏渲染抢终端。
 * CLI 下由调用方按需回显末尾几行，两种模式共用同一条链路。
 */
const defaultRunCommand: RunCommand = async (file, args, options) =>
  execCapture(file, args, options.timeoutMs);

/** 取全局安装前缀；`npm prefix -g` 失败时返回 null。 */
export async function resolveGlobalPrefix(run: RunCommand = defaultRunCommand): Promise<string | null> {
  const result = await runResultOf(run, npmExecutable(), ['prefix', '-g']);
  if (!result.ok) {
    return null;
  }
  const prefix = result.stdout.trim();
  return prefix === '' ? null : prefix;
}

/** 本包在 node_modules 下的目录名。 */
const PACKAGE_DIR_NAME = 'finch';

/**
 * 全局 node_modules 下本包的 package.json。
 *
 * npm 的目录布局随平台不同：POSIX 是 `<prefix>/lib/node_modules`，
 * Windows 是 `<prefix>/node_modules`。猜错会导致“装成功但校验失败”。
 */
export function installedManifestPath(prefix: string, platform: string): string {
  const segments =
    platform === 'win32'
      ? [prefix, 'node_modules', PACKAGE_DIR_NAME, 'package.json']
      : [prefix, 'lib', 'node_modules', PACKAGE_DIR_NAME, 'package.json'];
  return path.join(...segments);
}

/** 读取已安装版本；读不到返回 null。 */
export async function readInstalledVersion(
  prefix: string,
  platform: string = process.platform,
): Promise<string | null> {
  try {
    const raw = await readFile(installedManifestPath(prefix, platform), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** 目录是否可写；不可写意味着需要 sudo，绝不能悄悄失败。 */
async function isWritable(directory: string): Promise<boolean> {
  try {
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 执行命令并把异常转成结果，避免调用方到处 try。 */
async function runResultOf(
  run: RunCommand,
  file: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    return await run(file, args, { timeoutMs: 15_000 });
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    };
  }
}

/**
 * 将执行的完整命令。
 *
 * 成功路径的回显与失败路径的手工建议必须是同一条命令，
 * 否则会出现「界面说 A、失败了让你跑 B」的分裂。
 */
export function installCommand(): string {
  return `npm install --global --ignore-scripts ${INSTALL_TARBALL_URL}`;
}

/** 执行 npm 全局安装。 */
async function installPackage(run: RunCommand): Promise<CommandResult> {
  try {
    return await run(npmExecutable(), ['install', '--global', '--ignore-scripts', INSTALL_TARBALL_URL], {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      code: 1,
    };
  }
}

/** 压缩 npm 的输出：只保留末尾若干非空行，避免 TUI 里刷屏。 */
function tail(text: string, lines = 6): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .slice(-lines);
}

export interface RunUpdateOptions {
  readonly currentVersion: string;
  readonly stateDir: string;
  readonly io: UpdateIo;
  /** 跳过确认；非 TTY 场景必须显式开启。 */
  readonly assumeYes?: boolean;
  /** 是否回显 npm 的输出末尾；TUI 内保持 false，避免刷屏。 */
  readonly echo?: boolean;
  /** 已查到的最新版本；省略时由调用方先查。 */
  readonly latest: string;
  readonly run?: RunCommand;
  readonly now?: Date;
  readonly platform?: string;
}

export interface UpdateResult {
  readonly code: number;
  /** 是否真的完成了安装。 */
  readonly installed: boolean;
}

/**
 * 执行一次升级。
 *
 * 顺序刻意如此：先查可写性，再确认，最后才动 npm。
 * 让"没有权限"在用户点确认之前暴露，比装到一半失败体感好得多。
 */
export async function runUpdate(options: RunUpdateOptions): Promise<UpdateResult> {
  const { io, latest } = options;
  const run = options.run ?? defaultRunCommand;
  const fail = io.err ?? io.out;

  io.out(`当前版本：${options.currentVersion}`);
  io.out(`最新版本：${latest}`);

  const prefix = await resolveGlobalPrefix(run);
  if (prefix === null) {
    fail('无法确定 npm 全局安装目录（`npm prefix -g` 执行失败）。');
    fail(`可手工执行：${installCommand()}`);
    return { code: UPDATE_EXIT_UNAVAILABLE, installed: false };
  }

  if (!(await isWritable(prefix))) {
    fail(`npm 全局目录不可写：${prefix}`);
    fail('这不是 finch 的权限问题。请改用可写的 prefix，或以具备写权限的账户执行：');
    fail('可手工执行：');
    fail(installCommand());
    return { code: UPDATE_EXIT_UNAVAILABLE, installed: false };
  }

  io.out(`将执行：${installCommand()}`);

  if (options.assumeYes !== true) {
    const approved = await io.confirm(
      `更新到 ${latest}？`,
      '这会写 npm 全局目录，并在安装后校验版本。',
    );
    if (!approved) {
      // 明确拒绝等于"跳过此版本"：下次启动不再为同一个版本打扰。
      await markSkipped(options.stateDir, latest);
      io.out(`已跳过 ${latest}。之后随时可以执行 finch update。`);
      return { code: UPDATE_EXIT_OK, installed: false };
    }
  }

  io.out('正在安装…');
  const install = await installPackage(run);
  if (!install.ok) {
    fail(`安装失败（退出码 ${install.code}）。`);
    for (const line of [...tail(install.stderr), ...tail(install.stdout)]) {
      fail(`  ${line}`);
    }
    fail(`可手工重试：${installCommand()}`);
    return { code: UPDATE_EXIT_UNAVAILABLE, installed: false };
  }

  if (options.echo === true) {
    for (const line of tail(install.stdout, 3)) {
      io.out(`  ${line}`);
    }
  }

  // 校验靠回读 package.json，而不是信任 npm 的退出码：
  // 装到别的 prefix、或旧版本没被覆盖，都会在这里暴露。
  const installedVersion = await readInstalledVersion(prefix, options.platform ?? process.platform);
  if (installedVersion !== latest) {
    fail(
      `安装后的版本与预期不符：期望 ${latest}，实际 ${installedVersion ?? '无法读取'}。`,
    );
    fail(`已安装目录：${installedManifestPath(prefix, options.platform ?? process.platform)}`);
    fail(`可手工执行：${installCommand()}`);
    return { code: UPDATE_EXIT_UNAVAILABLE, installed: false };
  }

  // 更新缓存：避免刚升级完的下一次启动还拿着旧结论提示。
  const snapshot = await readCache(options.stateDir);
  await writeCache(options.stateDir, snapshot.fingerprint, {
    checkedAt: (options.now ?? new Date()).toISOString(),
    latest,
  });

  io.out(`已更新到 ${latest}。`);
  io.out('当前进程仍在旧版本上运行，请退出后重新启动 finch。');
  return { code: UPDATE_EXIT_OK, installed: true };
}

/** 查询最新版本的统一入口，供 CLI 与 TUI 共用。 */
export async function resolveLatest(options: {
  readonly transport?: UpdateTransport;
} = {}): Promise<string | null> {
  return fetchLatestVersion(options.transport === undefined ? {} : { transport: options.transport });
}
