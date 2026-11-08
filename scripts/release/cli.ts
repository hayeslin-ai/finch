#!/usr/bin/env node
/**
 * 发布流程命令行入口（Spec 4.1.1）。
 *
 * 只供 CI 使用：随 `tsconfig.json` 编译到 `dist/scripts/`，
 * 不进入 npm 包（`package.json` 的 `files` 白名单不含该目录）。
 *
 * 两种模式：
 *   plan  —— 读 PR 标题与当前版本，输出是否发版与目标版本（追加到 `$GITHUB_OUTPUT`）
 *   apply —— 把目标版本写回 package.json、npm-shrinkwrap.json、src/version.ts
 *
 * WHY 不直接调用 `npm version`：它同时改锁文件、触发 git 钩子，且行为随 npm 版本漂移；
 * 这里显式改三个文件，改动范围可枚举、可单测、失败可解释。
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideRelease,
  parseLevelInput,
  parseVersion,
  bumpVersion,
  type ReleaseDecision,
} from './semver.js';

/** 退出码：0 正常、2 用法错误、3 状态错误（版本非法或文件不符合预期）。 */
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_STATE = 3;

/** 用法错误：参数缺失或模式不认识，调用方需要修 workflow。 */
class UsageError extends Error {}

/** 状态错误：仓库文件与预期不符，需要人工处理而不是重试。 */
class StateError extends Error {}

interface PlanOptions {
  readonly mode: 'plan';
  readonly root: string;
  readonly title: string;
  readonly level: string;
  readonly outputFile: string;
}

interface ApplyOptions {
  readonly mode: 'apply';
  readonly root: string;
  readonly version: string;
}

type Options = PlanOptions | ApplyOptions;

/**
 * 解析参数。手写解析而不是引入命令行框架：
 * 这是单入口的 CI 脚本，参数形态固定（Spec 4.1 已明确不为单入口引入框架）。
 */
function parseOptions(argv: readonly string[]): Options {
  const [mode, ...rest] = argv;
  if (mode !== 'plan' && mode !== 'apply') {
    throw new UsageError(`第一个参数必须是 plan 或 apply：${JSON.stringify(mode ?? '')}`);
  }

  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === undefined || !flag.startsWith('--')) {
      throw new UsageError(`无法识别的参数：${JSON.stringify(flag ?? '')}`);
    }
    const value = rest[index + 1];
    if (value === undefined) {
      throw new UsageError(`参数 ${flag} 缺少取值`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }

  const root = path.resolve(values.get('root') ?? process.cwd());

  for (const flag of values.keys()) {
    if (!['root', 'title', 'level', 'output', 'version'].includes(flag)) {
      throw new UsageError(`不支持的参数：--${flag}`);
    }
  }

  if (mode === 'apply') {
    const version = values.get('version');
    if (version === undefined) {
      throw new UsageError('apply 模式必须提供 --version');
    }
    return { mode: 'apply', root, version };
  }

  return {
    mode: 'plan',
    root,
    title: values.get('title') ?? '',
    level: values.get('level') ?? '',
    outputFile: values.get('output') ?? process.env['GITHUB_OUTPUT'] ?? '',
  };
}

/** 解析 JSON 对象；格式错误转成可解释的状态错误，不向上抛 SyntaxError。 */
function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StateError(`${source} 不是合法 JSON：${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StateError(`${source} 顶层必须是 JSON 对象`);
  }
  return parsed as Record<string, unknown>;
}

/** 读取当前版本；缺字段或非法值即报状态错误，不用默认值兜底。 */
async function readPackageVersion(root: string): Promise<string> {
  const manifestPath = path.join(root, 'package.json');
  const parsed = parseJsonObject(await readFile(manifestPath, 'utf8'), manifestPath);
  const version = parsed['version'];
  if (typeof version !== 'string') {
    throw new StateError(`${manifestPath} 缺少字符串形式的 version 字段`);
  }
  try {
    parseVersion(version);
  } catch (error) {
    throw new StateError(`${manifestPath} 的 version 非法：${(error as Error).message}`);
  }
  return version;
}

/**
 * 输出键值对；有 GITHUB_OUTPUT 时追加写入，否则打到 stdout 便于本地调试。
 * 返回是否写到了 stdout，调用方据此避免重复打印同一行。
 */
async function emitOutputs(
  target: string,
  entries: Readonly<Record<string, string>>,
): Promise<boolean> {
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value.replace(/[\r\n]+/g, ' ')}\n`);
  if (target.length === 0) {
    for (const line of lines) {
      process.stdout.write(line);
    }
    return true;
  }
  await appendFile(target, lines.join(''), 'utf8');
  return false;
}

/** 按 PR 标题或手动级别决定目标版本；不发版时也输出结果，避免上层再猜一次。 */
function planVersion(current: string, options: PlanOptions): ReleaseDecision {
  if (options.level.length > 0) {
    const level = parseLevelInput(options.level);
    if (level === 'none') {
      return {
        release: true,
        level: 'none',
        current,
        version: current,
        reason: '手动触发：按当前版本原样发版',
      };
    }
    return {
      release: true,
      level,
      current,
      version: bumpVersion(current, level),
      reason: `手动触发：${level}`,
    };
  }

  if (options.title.trim().length === 0) {
    throw new UsageError('plan 模式需要 --title（或 --level）之一，当前两者都为空');
  }
  return decideRelease(current, options.title);
}

/**
 * 把版本写回三处：manifest、shrinkwrap、源码常量。
 * WHY 三处必须同一提交：`tests/unit/version.test.ts` 强制它们一致，
 * 分开提交会让中间态 CI 变红，也会让 `finch --version` 与实际 tag 不符。
 */
async function applyVersion(root: string, version: string): Promise<readonly string[]> {
  try {
    parseVersion(version);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  const manifestPath = path.join(root, 'package.json');
  const shrinkwrapPath = path.join(root, 'npm-shrinkwrap.json');
  const versionPath = path.join(root, 'src/version.ts');

  // 先读齐并校验三份文件，再统一落盘。
  // WHY：任一处不符合预期时（例如源码常量被改名）必须一个字节都不写，
  // 否则本地执行 apply 会留下「package.json 已改、版本常量没改」的半改状态。
  const manifest = parseJsonObject(await readFile(manifestPath, 'utf8'), manifestPath);
  manifest['version'] = version;

  const shrinkwrap = parseJsonObject(await readFile(shrinkwrapPath, 'utf8'), shrinkwrapPath);
  shrinkwrap['version'] = version;
  const packages = shrinkwrap['packages'];
  if (typeof packages === 'object' && packages !== null) {
    const rootPackage = (packages as Record<string, unknown>)[''];
    if (typeof rootPackage === 'object' && rootPackage !== null) {
      (rootPackage as Record<string, unknown>)['version'] = version;
    }
  }

  const source = await readFile(versionPath, 'utf8');
  const pattern = /^export const VERSION = '[^']*';$/m;
  if (!pattern.test(source)) {
    throw new StateError(`${versionPath} 中找不到 export const VERSION = '…'; 这一行，拒绝盲写`);
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`, 'utf8');
  await writeFile(versionPath, source.replace(pattern, `export const VERSION = '${version}';`), 'utf8');

  return [manifestPath, shrinkwrapPath, versionPath];
}

/** 供测试直接调用的入口；返回退出码而不是调用 process.exit。 */
export async function runReleaseCli(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  try {
    if (options.mode === 'apply') {
      const touched = await applyVersion(options.root, options.version);
      process.stdout.write(`已将版本写为 ${options.version}：\n`);
      for (const file of touched) {
        process.stdout.write(`  ${file}\n`);
      }
      return EXIT_OK;
    }

    const current = await readPackageVersion(options.root);
    const decision = planVersion(current, options);
    const toStdout = await emitOutputs(options.outputFile, {
      release: String(decision.release),
      level: decision.release ? decision.level : 'none',
      version: decision.version,
      current: decision.current,
      reason: decision.reason,
    });
    // 写进 GITHUB_OUTPUT 时另打一行人类可读摘要；直接输出键值对时不重复。
    if (!toStdout) {
      process.stdout.write(`${decision.reason}\n`);
      if (decision.release) {
        process.stdout.write(`${decision.current} → ${decision.version}\n`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof StateError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_STATE;
    }
    throw error;
  }
}

// 直接执行时进入命令行模式；被测试 import 时不做任何事。
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runReleaseCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // 未预期的异常只报告类别：日志里可能含用户配置路径，不打印堆栈。
      process.stderr.write('发布脚本执行失败：发生未预期错误。\n');
      process.exitCode = EXIT_STATE;
    });
}
