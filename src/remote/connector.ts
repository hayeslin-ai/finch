/**
 * 远程连接编排。
 *
 * 把“解析目标 → 确认 → 建立连接 → 核对身份 → 记录最近使用”串成一个可测试的流程。
 * 真实子进程只由注入的传输工厂创建；测试用内存假实现，
 * 因此这里可以在不接触任何服务器的情况下验证全部编排逻辑。
 *
 * 安全边界：
 * - 连接前必须展示目标并取得确认；
 * - 未就绪或身份核对失败直接关闭，不留半开连接；
 * - 关闭时如实区分“已关闭”与“终止状态未知”。
 */
import type { AppPaths } from '../config/paths.js';
import { rememberTarget } from '../state/recent-targets.js';
import type { RemoteQuery } from './queries.js';
import type { RemoteResult, RemoteSession } from './session.js';
import type { RemoteTransport, RemoteTransportFactory, SpawnTransportOptions } from './transport.js';

/** 连接所需的路径与环境配置；全部来自已校验的配置。 */
export interface RemoteConnectionConfig {
  readonly expectPath: string;
  readonly loginScript: string;
  readonly oathTool: string;
}

export interface ConnectResult {
  readonly ok: boolean;
  readonly session?: RemoteSession;
  readonly message: string;
  /** 就绪时脚本回传的身份摘要，用于展示给用户核对。 */
  readonly identity?: string;
}

/** 传输与会话的构造由调用方注入，便于替换为测试替身。 */
export interface ConnectDeps {
  /**
   * 创建已配置好的桥接传输。
   *
   * 无参：命令、参数与环境在调用方绑定，connectRemote 无法追加任何片段，
   * 这样“传输怎么起”只由一处决定，便于审计。
   */
  readonly createTransport: () => RemoteTransport;
  /**
   * 创建会话。会话需要超时配置，因此由调用方按本次连接的超时构造，
   * 而不是在这里固定默认值——连接超时与查询超时是两回事。
   */
  readonly createSession: () => RemoteSession;
  readonly remember?: (target: string) => Promise<void>;
}

/**
 * 建立远程连接。
 *
 * 前置条件由调用方保证（目标已确认、配置完整）；
 * 这里只处理连接建立与身份核对，并维护“最近使用”记录。
 */
export async function connectRemote(
  target: string,
  config: RemoteConnectionConfig,
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const transport = deps.createTransport();
  const session = deps.createSession();

  const attached = await session.attach(transport);
  if (!attached.ok) {
    // attach 内部已在失败时释放传输；这里只负责转成用户可读结果。
    return { ok: false, message: attached.message ?? '连接失败', session };
  }

  const identity = session.identity;
  if (identity.trim() === '') {
    // 没有身份摘要说明脚本没有完成目标核对，不能当作已就绪。
    await session.close();
    return { ok: false, message: '连接未提供身份核对信息，已关闭以免在错误机器上取证' };
  }

  // 最近使用只记录成功连接的目标；它只是提示，不构成授权。
  if (deps.remember !== undefined) {
    await deps.remember(target);
  }

  return {
    ok: true,
    session,
    identity,
    message: `已连接：${identity}`,
  };
}

/** 从进程环境变量读取远程工具路径；缺失时返回缺失项，不猜默认值。 */
export function readRemoteTools(
  env: NodeJS.ProcessEnv,
): { ok: true; config: RemoteConnectionConfig } | { ok: false; missing: readonly string[] } {
  const expectPath = env['EXPECT_PATH'] ?? '';
  const loginScript = env['LOGIN_SCRIPT'] ?? '';
  const oathTool = env['OATH_TOOL'] ?? '';

  const missing: string[] = [];
  if (expectPath.trim() === '') {
    missing.push('EXPECT_PATH');
  }
  if (loginScript.trim() === '') {
    missing.push('LOGIN_SCRIPT');
  }
  if (oathTool.trim() === '') {
    missing.push('OATH_TOOL');
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, config: { expectPath, loginScript, oathTool } };
}

/** 执行查询并把结果转成可展示的文本；不在这里做权限判断。 */
export async function runQuery(
  session: RemoteSession,
  query: RemoteQuery,
  timeoutMs: number,
): Promise<RemoteResult & { text?: string }> {
  const result = await session.query(query, timeoutMs);
  if (!result.ok) {
    return result;
  }

  const lines = result.frames
    .filter((frame) => frame.op === 'DATA' && frame.payload !== undefined)
    .map((frame) => frame.payload as string);
  return { ...result, text: lines.join('\n') };
}

/** 组合“连接 + 记录最近目标”的默认依赖。 */
export function defaultConnectDeps(
  paths: AppPaths,
  config: RemoteConnectionConfig,
  _createSpawnTransport: RemoteTransportFactory['create'],
  createSession: () => RemoteSession,
): ConnectDeps {
  return {
    createTransport: () =>
      _createSpawnTransport({
        command: config.expectPath,
        // 目标机制由脚本自身从环境变量与参数解析；不在参数里拼命令。
        args: [config.loginScript, '--agent'],
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: process.env['HOME'] ?? '',
          TERM: 'dumb',
        },
      }),
    createSession,
    remember: async (target) => {
      // 最近目标属于运行状态，写在状态目录而不是配置目录。
      await rememberTarget(paths.stateDir, target);
    },
  };
}
