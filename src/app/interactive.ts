/**
 * 交互入口：直接使用 Pi 的交互界面。
 *
 * WHY 不自造 UI：输入编辑、历史、补全、滚动、主题、快捷键
 * 都由 Pi 的 InteractiveMode 承担，产品只需负责安全约束与业务命令。
 *
 * 本模块只做三件事：检查运行环境、启动界面、如实报告失败原因。
 *
 * 位于 app 层而不是 cli 层：它直接引用 SDK，
 * 按依赖方向约束只有 agent 与 app 可以导入 Pi。
 */
import { InteractiveMode } from '@earendil-works/pi-coding-agent';

import { compose, type ComposeOptions } from './composition.js';

export interface RunInteractiveOptions extends ComposeOptions {
  /** 终端能力检查结果；非 TTY 时由调用方提前拒绝。 */
  readonly isTty: boolean;
}

/**
 * 启动交互式诊断。
 *
 * @returns 进程退出码；0 表示正常结束。
 */
export async function runInteractive(options: RunInteractiveOptions): Promise<number> {
  if (!options.isTty) {
    process.stderr.write('交互式诊断需要 TTY；非交互模式请使用具体子命令。\n');
    return 3;
  }

  let composition;
  try {
    composition = await compose(options);
  } catch (error) {
    // 启动失败的原因必须可操作：缺模型、缺凭证、仓库不可用都要说清楚。
    process.stderr.write(`${error instanceof Error ? error.message : '启动失败'}\n`);
    return 3;
  }

  try {
    const mode = new InteractiveMode(composition.runtime, { tuiMode: 'regular' });
    await mode.run();
    return 0;
  } finally {
    composition.dispose();
  }
}
