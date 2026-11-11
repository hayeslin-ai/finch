/**
 * 升级提示与 `finch update` 的测试。
 *
 * WHY 重点测"键盘守卫"与"确认拒绝"：
 * 裸键监听最容易出的错是吃掉用户正文里的 `u`，
 * 而确认被拒绝后如果还去装包，就等于绕过了用户意志。
 * 两条都不会在手工测试里稳定复现，只能靠假 UI 精确验证。
 *
 * 全程零网络、零真实安装：npm 调用一律由假执行器替代。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { cacheFilePath } from '../../src/update/check.js';
import {
  installCommand,
  installedManifestPath,
  readInstalledVersion,
  runUpdate,
  type CommandResult,
  type RunCommand,
} from '../../src/update/command.js';
import {
  NOTICE_KEY,
  NOTICE_STATUS_KEY,
  noticeText,
  startUpdateNotice,
} from '../../src/update/notice.js';

const roots: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 读取缓存原文，用于断言"跳过版本已落盘"。 */
async function readCacheText(stateDir: string): Promise<string> {
  return readFile(cacheFilePath(stateDir), 'utf8');
}

/** 收集输出，并记录确认被调用次数。 */
function makeIo(answer: boolean) {
  const lines: string[] = [];
  const state = { confirms: 0 };
  return {
    lines,
    state,
    io: {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
      confirm: async () => {
        state.confirms += 1;
        return answer;
      },
    },
  };
}

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
}

/** 假执行器：按命令返回预定结果，并记录调用。 */
function makeRunner(options: {
  prefix?: string | null;
  installOk?: boolean;
  calls: RecordedCall[];
}): RunCommand {
  return async (file, args): Promise<CommandResult> => {
    options.calls.push({ file, args });
    if (args[0] === 'prefix') {
      return options.prefix === null || options.prefix === undefined
        ? { ok: false, stdout: '', stderr: 'no npm', code: 1 }
        : { ok: true, stdout: `${options.prefix}\n`, stderr: '', code: 0 };
    }
    return options.installOk === false
      ? { ok: false, stdout: '', stderr: 'EACCES: permission denied', code: 243 }
      : { ok: true, stdout: 'added 1 package', stderr: '', code: 0 };
  };
}

/** 构造一个"已安装某版本"的假 prefix。 */
async function fakePrefix(version: string): Promise<string> {
  const prefix = await makeTemp('finch-prefix-');
  const target = installedManifestPath(prefix, process.platform);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({ name: 'finch', version }), 'utf8');
  return prefix;
}

// —— 提示文案 ——

test('提示文案包含版本、按键与自动消失说明', () => {
  const text = noticeText('0.4.0', '0.3.0', 15);
  assert.match(text, /0\.4\.0/);
  assert.match(text, /0\.3\.0/);
  assert.match(text, /按 u 更新/);
  assert.match(text, /15 秒后消失/);
});

// —— runUpdate ——

test('确认被拒绝时不执行安装，并记录跳过版本', async () => {
  const stateDir = await makeTemp('finch-state-');
  const prefix = await fakePrefix('0.3.0');
  const calls: RecordedCall[] = [];
  const { lines, state, io } = makeIo(false);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    run: makeRunner({ prefix, calls }),
  });

  assert.equal(result.installed, false);
  assert.equal(result.code, 0);
  assert.equal(state.confirms, 1, '必须真的问过一次');
  assert.ok(
    !calls.some((call) => call.args[0] === 'install'),
    '用户拒绝后不得调用 npm install',
  );
  assert.match(lines.join('\n'), /已跳过 0\.4\.0/);
  assert.match(await readCacheText(stateDir), /"skipped": "0\.4\.0"/);
});

test('确认通过后安装，并以回读版本为准', async () => {
  const stateDir = await makeTemp('finch-state-');
  const prefix = await fakePrefix('0.4.0');
  const calls: RecordedCall[] = [];
  const { lines, io } = makeIo(true);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    echo: true,
    run: makeRunner({ prefix, calls }),
  });

  assert.equal(result.installed, true);
  assert.equal(result.code, 0);
  assert.ok(calls.some((call) => call.args[0] === 'install'));
  const text = lines.join('\n');
  assert.match(text, /已更新到 0\.4\.0/);
  assert.match(text, /请退出后重新启动/);
});

test('安装后版本不符时报错并给出手工命令', async () => {
  const stateDir = await makeTemp('finch-state-');
  // 装完仍是旧版：模拟"装到了别的 prefix"或旧版本没被覆盖。
  const prefix = await fakePrefix('0.3.0');
  const calls: RecordedCall[] = [];
  const { lines, io } = makeIo(true);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    run: makeRunner({ prefix, calls }),
  });

  assert.equal(result.installed, false);
  assert.equal(result.code, 3, '版本不符必须是非零退出码');
  const text = lines.join('\n');
  assert.match(text, /版本与预期不符/);
  assert.ok(text.includes(installCommand()), '必须给出手工可执行的同一条命令');
});

test('npm 安装失败时回显原因与手工命令', async () => {
  const stateDir = await makeTemp('finch-state-');
  const prefix = await fakePrefix('0.3.0');
  const calls: RecordedCall[] = [];
  const { lines, io } = makeIo(true);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    run: makeRunner({ prefix, calls, installOk: false }),
  });

  assert.equal(result.code, 3);
  const text = lines.join('\n');
  assert.match(text, /安装失败/);
  assert.match(text, /EACCES/);
  assert.ok(text.includes(installCommand()));
});

test('取不到全局前缀时直接失败，不尝试安装', async () => {
  const stateDir = await makeTemp('finch-state-');
  const calls: RecordedCall[] = [];
  const { lines, io } = makeIo(true);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    run: makeRunner({ prefix: null, calls }),
  });

  assert.equal(result.code, 3);
  assert.ok(!calls.some((call) => call.args[0] === 'install'));
  assert.match(lines.join('\n'), /无法确定 npm 全局安装目录/);
});

test('assumeYes 跳过确认，非交互场景也能安装', async () => {
  const stateDir = await makeTemp('finch-state-');
  const prefix = await fakePrefix('0.4.0');
  const calls: RecordedCall[] = [];
  const { state, io } = makeIo(false);

  const result = await runUpdate({
    currentVersion: '0.3.0',
    stateDir,
    io,
    latest: '0.4.0',
    assumeYes: true,
    run: makeRunner({ prefix, calls }),
  });

  assert.equal(state.confirms, 0, 'assumeYes 下不得弹确认');
  assert.equal(result.installed, true);
});

test('readInstalledVersion 区分平台布局', async () => {
  const prefix = await fakePrefix('1.2.3');
  assert.equal(await readInstalledVersion(prefix, 'linux'), '1.2.3');
  // Windows 布局不同，同一目录下读不到 POSIX 路径。
  assert.equal(await readInstalledVersion(prefix, 'win32'), null);
});

// —— startUpdateNotice ——

/** 手动控制的定时器：把回调收进数组，由测试决定何时"到点"。 */
function makeManualTimer() {
  const callbacks: (() => void)[] = [];
  let cancelled = 0;
  return {
    callbacks,
    get cancelled() {
      return cancelled;
    },
    timer: {
      schedule: (callback: () => void) => {
        callbacks.push(callback);
        return callbacks.length - 1;
      },
      cancel: () => {
        cancelled += 1;
      },
    },
  };
}

/** 假 UI：记录 setStatus 与注册的按键处理器。 */
function makeUi(options: { editorEmpty?: boolean; idle?: boolean; confirmAnswer?: boolean } = {}) {
  const statuses: { key: string; text: string | undefined }[] = [];
  const notifications: string[] = [];
  const handlers: ((data: string) => { consume?: boolean } | undefined)[] = [];
  let unsubscribed = 0;

  return {
    statuses,
    notifications,
    handlers,
    get unsubscribed() {
      return unsubscribed;
    },
    get lastStatus() {
      return statuses[statuses.length - 1];
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
        handlers.push(handler);
        return () => {
          unsubscribed += 1;
        };
      },
      isEditorEmpty: () => options.editorEmpty ?? true,
      isIdle: () => options.idle ?? true,
      confirm: async () => options.confirmAnswer ?? false,
      notify: (message: string) => notifications.push(message),
    },
  };
}

/** 等待微任务队列，让后台 promise 走完。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 轮询等待某个条件成立。
 *
 * WHY 不用固定次数的 flush：performUpdate 里夹着真实的 fs.access，
 * 它在不同机器上的完成时机不同，写死次数会在快机上过、慢机上挂。
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await flush();
  }
  assert.fail(`等待超时：${label}`);
}

test('有新版本时写入 footer 状态，到点后清除并解绑', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi();
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => ({ kind: 'available', latest: '0.4.0' }),
    durationMs: 15_000,
    timer: manual.timer,
  });
  await flush();

  assert.equal(harness.statuses[0]?.key, NOTICE_STATUS_KEY);
  assert.match(harness.statuses[0]?.text ?? '', /0\.4\.0/);
  assert.equal(harness.handlers.length, 1, '提示期间必须注册按键监听');

  // 到点：清除 footer 并解绑裸键，避免长期占用。
  for (const callback of manual.callbacks) {
    callback();
  }
  assert.equal(harness.lastStatus?.key, NOTICE_STATUS_KEY);
  assert.equal(harness.lastStatus?.text, undefined, '到点必须清除 footer 状态');
  assert.equal(harness.unsubscribed, 1);
});

test('没有新版本时不写任何 footer 状态', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi();
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.4.0',
    stateDir,
    check: async () => ({ kind: 'none', reason: 'up-to-date' }),
    timer: manual.timer,
  });
  await flush();

  assert.equal(harness.statuses.length, 0);
  assert.equal(harness.handlers.length, 0, '无提示时不得注册按键监听');
});

test('检查抛错时静默忽略，不影响会话', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi();
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => {
      throw new Error('boom');
    },
    timer: manual.timer,
  });
  await flush();

  assert.equal(harness.statuses.length, 0);
  assert.equal(harness.handlers.length, 0);
});

test('输入框非空时不消费 u 键', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi({ editorEmpty: false });
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => ({ kind: 'available', latest: '0.4.0' }),
    timer: manual.timer,
  });
  await flush();

  const handler = harness.handlers[0];
  assert.ok(handler !== undefined);
  assert.equal(handler(NOTICE_KEY), undefined, '正文里的 u 必须放行');
});

test('模型输出中不消费 u 键', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi({ idle: false });
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => ({ kind: 'available', latest: '0.4.0' }),
    timer: manual.timer,
  });
  await flush();

  const handler = harness.handlers[0];
  assert.ok(handler !== undefined);
  assert.equal(handler(NOTICE_KEY), undefined);
});

test('其它按键一律放行', async () => {
  const stateDir = await makeTemp('finch-state-');
  const harness = makeUi();
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => ({ kind: 'available', latest: '0.4.0' }),
    timer: manual.timer,
  });
  await flush();

  const handler = harness.handlers[0];
  assert.ok(handler !== undefined);
  for (const key of ['a', 'U', 'enter', '\r', 'x']) {
    assert.equal(handler(key), undefined, `按键 ${JSON.stringify(key)} 必须放行`);
  }
});

test('空输入框按 u 会被消费，并触发确认', async () => {
  const stateDir = await makeTemp('finch-state-');
  const prefix = await fakePrefix('0.3.0');
  const calls: RecordedCall[] = [];
  const harness = makeUi({ confirmAnswer: false });
  const manual = makeManualTimer();

  startUpdateNotice({
    ui: harness.ui,
    currentVersion: '0.3.0',
    stateDir,
    check: async () => ({ kind: 'available', latest: '0.4.0' }),
    run: makeRunner({ prefix, calls }),
    timer: manual.timer,
  });
  await flush();

  const handler = harness.handlers[0];
  assert.ok(handler !== undefined);
  const outcome = handler(NOTICE_KEY);
  assert.deepEqual(outcome, { consume: true }, '空输入框下按 u 必须被消费');
  assert.equal(harness.lastStatus?.text, undefined, '按键后立即清除提示');
  assert.equal(harness.unsubscribed, 1, '按键后立即解绑，避免持续占用裸键');

  // 确认返回 false：不得安装，并提示已跳过。
  await waitFor(
    () => harness.notifications.join('\n').includes('已跳过'),
    '跳过提示应出现在通知中',
  );
  assert.ok(!calls.some((call) => call.args[0] === 'install'));
  assert.match(harness.notifications.join('\n'), /已跳过/);
});
