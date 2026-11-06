#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * P0 阶段只提供版本与帮助两个无副作用命令；
 * 诊断、配置向导、doctor 等功能在后续阶段按 Spec 逐项实现。
 * 未实现的命令必须明确失败，不能静默当作成功。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BUILD_COMMIT, PACKAGE_NAME, VERSION } from '../version.js';

/** 退出码约定（与 Spec 6.5 一致）。 */
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_UNIMPLEMENTED = 3;

const HELP_TEXT = `Finch ${VERSION} — 只读故障诊断 CLI

用法：
  finch                 进入交互式诊断
  finch -c              恢复最近活跃会话
  finch -r <sessionId>  恢复指定会话
  finch --sessions      列出历史会话
  finch doctor          检查本地配置与依赖
  finch --version       显示版本
  finch --help          显示帮助

说明：
  本工具只读。不会修改业务仓库，也不会在服务器上执行写操作。
  远程查询需要显式批准，且不会自动恢复上一次的授权。
`;

/** 输出常规信息到 stdout；错误信息一律走 stderr，保持管道语义。 */
function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 解析并执行命令。
 * P0 只实现无副作用的元命令；其余入口保留为明确失败，
 * 避免用户误以为功能已可用。
 */
export function run(argv: readonly string[]): number {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v') {
    write(`${PACKAGE_NAME} ${VERSION} (node ${process.version}, commit ${BUILD_COMMIT})`);
    return EXIT_OK;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP_TEXT);
    return EXIT_OK;
  }

  if (command === undefined) {
    process.stderr.write('交互式诊断尚未在 P0 阶段实现。请使用 --help 查看当前可用命令。\n');
    return EXIT_UNIMPLEMENTED;
  }

  process.stderr.write(`未知命令或功能尚未实现：${command}\n`);
  if (rest.length > 0) {
    process.stderr.write('其余参数未被处理。\n');
  }
  return EXIT_USAGE;
}

/**
 * 判断是否作为可执行入口运行。
 *
 * WHY：npm 的 bin 是软链接，`process.argv[1]` 是链接路径，而 `import.meta.url`
 * 是解析后的真实路径；直接比较会永远不相等，导致命令静默退出且退出码为 0。
 * 因此两侧都解析为真实路径再比较。
 */
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
  process.exitCode = run(process.argv.slice(2));
}
