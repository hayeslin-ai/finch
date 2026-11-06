#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 已实现：--version、--help、doctor。
 * 诊断、配置向导与会话恢复在后续阶段实现；
 * 未实现的命令明确失败，不静默当作成功。
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compose } from '../app/composition.js';
import { initAppDirectories } from '../config/init.js';
import { loadConfig } from '../config/load.js';
import { resolveAppPaths } from '../config/paths.js';
import { formatDoctorReport, runDoctorChecks } from './doctor-command.js';
import { runRepl } from './repl.js';
import { renderSessionList, renderSummary, selectSession } from './session-commands.js';
import { listSessions } from '../storage/session.js';
import { createTerminalIo, runJumpServerWizard, runProviderWizard } from './wizard.js';
import { BUILD_COMMIT, PACKAGE_NAME, VERSION } from '../version.js';

/** 退出码约定（与 Spec 6.5 一致）。 */
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_UNAVAILABLE = 3;

const HELP_TEXT = `Finch ${VERSION} — 只读故障诊断 CLI

用法：
  finch                 进入交互式诊断
  finch -c              恢复最近活跃会话
  finch -r <sessionId>  恢复指定会话
  finch --sessions      列出历史会话
  finch init            创建用户配置目录与脱敏模板
  finch doctor [--remote]  检查本地配置与依赖
  finch --sessions      列出历史会话
  finch provider        配置模型 provider（交互式）
  finch jumpserver      配置堡垒机账号与认证（交互式）
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
 * 返回退出码而不是直接调用 process.exit，便于测试与后续复用。
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v') {
    write(`${PACKAGE_NAME} ${VERSION} (node ${process.version}, commit ${BUILD_COMMIT})`);
    return EXIT_OK;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP_TEXT);
    return EXIT_OK;
  }

  if (command === 'init') {
    const result = await initAppDirectories(resolveAppPaths());
    for (const action of result.actions) {
      const label = action.action === 'created' ? '已创建' : '保持不变';
      const reason = action.reason === undefined ? '' : `（${action.reason}）`;
      write(`${label}：${action.target}${reason}`);
    }
    if (!result.ok) {
      process.stderr.write('部分路径不安全，未做修改。请先修复权限或移除符号链接。\n');
      return EXIT_UNAVAILABLE;
    }
    write('配置模板已就绪。编辑 .env 与 models.json 后运行 doctor 检查。');
    return EXIT_OK;
  }

  if (command === 'provider' || command === 'jumpserver') {
    // 配置向导必须运行在交互式终端：非 TTY 无法安全关闭回显，
    // 也无法保证输入来自人类而不是脚本。这里给出明确原因，而不是通用异常。
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('配置向导只能在交互式终端中运行；不支持管道或重定向输入。\n');
      return EXIT_USAGE;
    }

    const io = createTerminalIo();
    const result =
      command === 'provider'
        ? await runProviderWizard(resolveAppPaths(), io)
        : await runJumpServerWizard(resolveAppPaths(), io);

    if (result.ok) {
      write(result.message);
      return EXIT_OK;
    }
    process.stderr.write(`${result.message}\n`);
    return EXIT_USAGE;
  }

  if (command === 'doctor') {
    // doctor 默认不探测远程工具，避免在未配置远程时执行系统命令；
    // 用户显式加 --remote 才检查 Expect 与 oathtool。
    const checkRemote = rest.includes('--remote');
    const unknown = rest.filter((arg) => arg !== '--remote');
    if (unknown.length > 0) {
      process.stderr.write(`doctor 不接受参数：${unknown.join(' ')}\n`);
      return EXIT_USAGE;
    }

    const config = await loadConfig(resolveAppPaths());
    const results = await runDoctorChecks(config, { checkRemote });
    const report = formatDoctorReport(results);
    process.stdout.write(report.text);
    return report.exitCode;
  }

  if (command === '--sessions') {
    const paths = resolveAppPaths();
    const sessions = await listSessions(paths.stateDir);
    process.stdout.write(renderSessionList(sessions));
    return EXIT_OK;
  }

  if (command === '-c' || command === '-r') {
    const paths = resolveAppPaths();
    const requested = command === '-r' ? rest[0] : undefined;
    if (command === '-r' && (requested === undefined || requested.trim() === '')) {
      process.stderr.write('用法：finch -r <sessionId>\n');
      return EXIT_USAGE;
    }

    const selection = await selectSession(paths.stateDir, requested);
    if (!selection.ok) {
      // 没有历史会话属正常首次使用；其余情况要报告原因但不强行阻塞。
      process.stderr.write(`${selection.message ?? '无法恢复会话'}\n`);
      if (selection.alternatives !== undefined && selection.alternatives.length > 0) {
        process.stderr.write(`可用会话：\n${renderSessionList(selection.alternatives)}`);
      }
      return selection.alternatives === undefined ? EXIT_UNAVAILABLE : EXIT_USAGE;
    }

    if (selection.summary !== undefined) {
      write(renderSummary(selection.summary));
      write('');
    }
    if (selection.message !== undefined) {
      process.stderr.write(`注意：${selection.message}\n`);
    }

    // 恢复后立即进入交互；远程授权与附件授权均不恢复。
    try {
      return await startRepl(paths, selection.snapshot?.sessionId);
    } finally {
      await selection.release?.();
    }
  }

  if (command === undefined) {
    // 无参数：进入交互式诊断。
    return startRepl(resolveAppPaths());
  }

  process.stderr.write(`未知命令或功能尚未实现：${command}\n`);
  return EXIT_USAGE;
}

/**
 * 启动交互式诊断。
 *
 * 新会话与会话恢复共用同一入口：
 * 恢复语义由 selectSession 处理，这里只负责配置检查与运行时组装。
 * 远程能力状态在启动时即计算并常驻显示，避免用户输入查询后才发现不可用。
 */
async function startRepl(
  paths: ReturnType<typeof resolveAppPaths>,
  resumeSessionId?: string,
): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write('交互式诊断需要 TTY；非交互模式请使用具体子命令。\n');
    return EXIT_UNAVAILABLE;
  }

  const config = await loadConfig(paths);
  if (!config.available.local) {
    process.stderr.write('本地诊断配置不完整。运行 doctor 查看缺少项，或使用 init 生成模板后填写。\n');
    for (const issue of config.issues.filter((item) => item.group === 'local')) {
      process.stderr.write(`  缺少或无效：${issue.key}\n`);
    }
    return EXIT_UNAVAILABLE;
  }

  let composition;
  try {
    composition = await compose({ config, paths });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`);
    return EXIT_UNAVAILABLE;
  }

  try {
    return await runRepl({
      composition,
      stateDir: paths.stateDir,
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      remoteStatus: config.available.remote ? 'ready' : 'unavailable (local-only)',
      write: (line) => process.stdout.write(`${line}\n`),
      writeError: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    composition.dispose();
  }
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
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // 未预期的异常只报告类别，不打印可能含敏感值的堆栈。
      process.stderr.write('执行失败：发生未预期错误。\n');
      process.exitCode = EXIT_UNAVAILABLE;
    });
}
