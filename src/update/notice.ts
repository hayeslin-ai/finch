/**
 * 启动时的升级提示：footer 停留 15 秒 + 按 `u` 立即更新。
 *
 * WHY 用 footer 而不是 chat：
 * `ctx.ui.notify(msg,'info')` 的实现是把一行文本**追加进聊天区**
 * （Pi 的 showStatus → chatContainer.addChild），只会被下一条状态覆盖，
 * 不会超时消失，还会永久留在会话滚动历史里。
 * 真正能自动消失的只有 footer 的 setStatus(key, text) + setStatus(key, undefined)。
 * 需求要求「自己消失」，所以只能选后者。
 *
 * WHY 用裸键监听而不是注册斜杠命令：
 * 目标是"错过提示也能自己敲 finch update"，提示窗口期内多给一条捷径，
 * 因此监听只在提示存续的 15 秒内存在，窗口一关立即解绑。
 */
import type { UpdateOutcome } from './check.js';
import { runUpdate, type RunCommand, type UpdateIo } from './command.js';
import { NOTICE_DURATION_MS } from './source.js';

/** footer 状态键；固定值保证同一时刻只有一条升级提示。 */
export const NOTICE_STATUS_KEY = 'finch-update';

/** 触发更新的按键。 */
export const NOTICE_KEY = 'u';

/** 定时器注入点；测试用它跳过真实等待。 */
export interface TimerApi {
  readonly schedule: (callback: () => void, ms: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

const defaultTimer: TimerApi = {
  schedule: (callback, ms) => setTimeout(callback, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 提示层需要的最小 UI 能力。
 *
 * 刻意不直接依赖 Pi 的 ExtensionContext：加一层窄接口后，
 * 提示逻辑可以用一个假 UI 完整测试，不必启动终端界面。
 */
export interface NoticeUi {
  setStatus(key: string, text: string | undefined): void;
  /** 返回解绑函数。 */
  onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void;
  /** 输入框是否为空：正文里的 `u` 绝不能被吃掉。 */
  isEditorEmpty(): boolean;
  /** 是否空闲：模型正在输出时不吃按键。 */
  isIdle(): boolean;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: 'info' | 'warning' | 'error'): void;
}

export interface StartUpdateNoticeOptions {
  readonly ui: NoticeUi;
  readonly currentVersion: string;
  readonly stateDir: string;
  /** 后台检查；由组装根注入，绝不阻塞启动。 */
  readonly check: () => Promise<UpdateOutcome>;
  readonly run?: RunCommand;
  readonly durationMs?: number;
  readonly timer?: TimerApi;
}

/**
 * 提示文案。
 *
 * 明确写出「15 秒后消失」而不是「请立刻选择」：
 * 自动消失的提示如果没有提前告知，用户会觉得提示自己跑掉了。
 */
export function noticeText(latest: string, current: string, seconds: number): string {
  return `⬆ finch ${latest} 可用（当前 ${current}）· 按 ${NOTICE_KEY} 更新 · ${String(seconds)} 秒后消失`;
}

/**
 * 启动一次后台检查并在命中时展示提示。
 *
 * 同步返回：检查在后台跑，调用方（session_start 钩子）不等网络。
 * 任何异常都在内部吞掉——升级提示只允许"没出现"，不允许影响诊断。
 */
export function startUpdateNotice(options: StartUpdateNoticeOptions): void {
  const timer = options.timer ?? defaultTimer;
  const durationMs = options.durationMs ?? NOTICE_DURATION_MS;

  void (async () => {
    let outcome: UpdateOutcome;
    try {
      outcome = await options.check();
    } catch {
      return;
    }
    if (outcome.kind !== 'available') {
      return;
    }
    showNotice(options, outcome.latest, durationMs, timer);
  })();
}

/** 展示提示并挂上快捷键；窗口结束或触发后立即解绑。 */
function showNotice(
  options: StartUpdateNoticeOptions,
  latest: string,
  durationMs: number,
  timer: TimerApi,
): void {
  const { ui } = options;
  const seconds = Math.max(1, Math.round(durationMs / 1000));

  let unsubscribe: (() => void) | undefined;
  let handle: unknown;

  const cleanup = (): void => {
    ui.setStatus(NOTICE_STATUS_KEY, undefined);
    unsubscribe?.();
    unsubscribe = undefined;
    timer.cancel(handle);
    handle = undefined;
  };

  ui.setStatus(NOTICE_STATUS_KEY, noticeText(latest, options.currentVersion, seconds));

  unsubscribe = ui.onTerminalInput((data: string) => {
    // 三道守卫缺一不可：非 u 键放行、用户正在打字放行、模型正在输出放行。
    // 少任何一条都会出现「正文里的 u 被吞掉」这类难复现的输入故障。
    if (data !== NOTICE_KEY || !ui.isEditorEmpty() || !ui.isIdle()) {
      return undefined;
    }
    cleanup();
    void performUpdate(options, latest);
    return { consume: true };
  });

  handle = timer.schedule(cleanup, durationMs);
}

/**
 * 执行更新。
 *
 * 与 CLI 的 `finch update` 走同一条链路（runUpdate），
 * 区别只在输出通道：这里全部走 ctx.ui，避免子进程与全屏渲染抢终端。
 */
async function performUpdate(options: StartUpdateNoticeOptions, latest: string): Promise<void> {
  const { ui } = options;
  const io: UpdateIo = {
    out: (line) => ui.notify(line, 'info'),
    err: (line) => ui.notify(line, 'warning'),
    confirm: (title, message) => ui.confirm(title, message),
  };

  try {
    await runUpdate({
      currentVersion: options.currentVersion,
      stateDir: options.stateDir,
      io,
      latest,
      // 全部输出已捕获：npm 直写终端会打乱 Pi 的界面。
      echo: false,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  } catch (error) {
    ui.notify(`更新失败：${error instanceof Error ? error.message : '未知原因'}`, 'error');
  }
}
