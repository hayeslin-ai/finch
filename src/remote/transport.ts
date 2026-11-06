/**
 * 桥接进程的传输抽象。
 *
 * WHY：会话状态机需要可离线验证，而真实子进程测试既慢又容易残留。
 * 把“写一行、读一行、关闭”抽出来之后：
 * - 生产用 spawn 实现；
 * - 测试用内存假实现，完全不启动任何进程。
 *
 * 这也让“远程 shell 谨慎测试”落到实处：单元测试里不存在真实登录。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface RemoteTransport {
  /** 写入一行；实现方负责追加换行。 */
  write(line: string): void;
  /** 注册行回调。非协议输出由上层决定如何处置。 */
  onLine(handler: (line: string) => void): void;
  /** 进程退出回调。 */
  onExit(handler: () => void): void;
  /** 关闭传输并释放资源。 */
  close(): void;
}

export interface SpawnTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** 只传登录所需环境，不继承宿主凭证与模型密钥。 */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * 基于子进程的传输实现。
 *
 * 安全约束：
 * - `shell: false`，参数作为 argv 传入，不经过 shell 解析。
 * - stderr 只排空不采集：认证输出可能含敏感信息，不能进入会话上下文。
 * - 关闭时先 SIGTERM，超时后 SIGKILL，避免进程残留拖住调用方。
 */
export function createSpawnTransport(
  options: SpawnTransportOptions,
): RemoteTransport {
  const child = spawn(options.command, [...options.args], {
    env: { ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let lineHandler: ((line: string) => void) | undefined;
  let exitHandler: (() => void) | undefined;
  let closed = false;

  reader.on('line', (line) => lineHandler?.(line));
  child.stderr.resume();
  child.on('exit', () => {
    closed = true;
    exitHandler?.();
  });

  return {
    write(line: string): void {
      if (closed || child.stdin.destroyed) {
        return;
      }
      child.stdin.write(`${line}\n`);
    },
    onLine(handler: (line: string) => void): void {
      lineHandler = handler;
    },
    onExit(handler: () => void): void {
      exitHandler = handler;
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      reader.close();
      try {
        child.stdin.end();
      } catch {
        // stdin 可能已关闭。
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 500);
        timer.unref();
      }
    },
  };
}

/** 传输工厂；会话只依赖它，不直接接触子进程。 */
export interface RemoteTransportFactory {
  create(): RemoteTransport;
}
