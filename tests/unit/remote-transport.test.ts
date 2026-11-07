/**
 * 桥接进程传输测试。
 *
 * WHY：spawn 失败（EXPECT_PATH 指向不存在的路径）以异步 error 事件到达，
 * 而 Node 对没有监听的 error 事件会抛顶层异常。
 * 缺少外部程序只应影响远程功能，不能让整个 CLI 崩掉——
 * 这条约束在类型检查里看不出来，必须真的启动一个坏命令来验证。
 *
 * 只启动必然失败的命令，不登录任何服务器。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createSpawnTransport } from '../../src/remote/transport.js';

/** 等待若干毫秒；仅用于让异步 error/exit 事件到达。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('可执行文件不存在时以退出回调落地，不崩溃进程', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-transport-'));
  try {
    let exited = false;
    // 未监听 error 时，下面这行之后的异步 ENOENT 会成为未处理异常，测试进程直接倒下。
    const transport = createSpawnTransport({
      command: path.join(directory, 'not-a-real-binary'),
      args: [],
      env: {},
    });
    transport.onExit(() => {
      exited = true;
    });

    await delay(500);
    assert.equal(exited, true, 'spawn 失败必须触发退出回调，否则会话会一直等下去');

    // 错误路径已把传输置为关闭态，close/write 都必须能安全重复调用。
    transport.close();
    transport.write('LIST {}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('进程退出后的写入与关闭是安全的', async () => {
  let exited = false;
  const transport = createSpawnTransport({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: {},
  });
  transport.onExit(() => {
    exited = true;
  });

  await delay(500);
  assert.equal(exited, true, '正常退出同样要触发回调');

  // 对端已关闭后写入会触发 EPIPE：传输层必须自己吞掉，交给会话侧兜底。
  assert.doesNotThrow(() => {
    transport.write('LIST {}');
  });
  transport.close();
});
