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
import type { RemoteQuery } from './queries.js';
import type { RemoteResult, RemoteSession } from './session.js';
import { resolveExecutable } from './tool-path.js';
import { createSpawnTransport, type RemoteTransport, type SpawnTransportOptions } from './transport.js';

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
}

/**
 * 建立远程连接。
 *
 * 前置条件由调用方保证（计划已确认、配置完整）；
 * 这里只处理连接建立与身份核对，不记录任何“最近使用”状态。
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

  return {
    ok: true,
    session,
    identity,
    message: `已连接：${identity}`,
  };
}

/** 单个远程工具的状态；doctor 与 /remote 用它区分“未安装”和“显式路径无效”。 */
export interface RemoteToolStatus {
  readonly name: 'expect' | 'oathtool';
  readonly envKey: 'EXPECT_PATH' | 'OATH_TOOL';
  /** 解析成功时的可执行文件路径。 */
  readonly path?: string;
  /** 路径来源；doctor 用它如实标注 PATH 还是显式覆盖。 */
  readonly source?: 'env' | 'path';
  /** 显式环境变量无效时的原因；未设置或成功时为空。 */
  readonly error?: string;
  /** 未找到时可复制的安装命令。 */
  readonly installHint: string;
}

export interface RemoteToolsResult {
  readonly ok: boolean;
  /** 自动生成的登录脚本路径；由调用方通过 ensureLoginScript 提供。 */
  readonly loginScript: string;
  readonly expect: RemoteToolStatus;
  readonly oathtool: RemoteToolStatus;
}

/** 构造单个工具的解析结果；避免两个工具的查找逻辑分叉。 */
function describeTool(
  name: RemoteToolStatus['name'],
  envKey: RemoteToolStatus['envKey'],
  installHint: string,
  env: NodeJS.ProcessEnv,
): RemoteToolStatus {
  const resolution = resolveExecutable(name, envKey, env);
  return {
    name,
    envKey,
    installHint,
    ...(resolution.path === undefined ? {} : { path: resolution.path }),
    ...(resolution.source === undefined ? {} : { source: resolution.source }),
    ...(resolution.error === undefined ? {} : { error: resolution.error }),
  };
}

/**
 * 解析远程工具。
 *
 * 登录脚本由程序自动生成，不再从环境变量读取；
 * Expect 与 oathtool 默认从 PATH 查找，环境变量只作为显式覆盖。
 */
export function readRemoteTools(env: NodeJS.ProcessEnv, loginScript: string): RemoteToolsResult {
  const expect = describeTool(
    'expect',
    'EXPECT_PATH',
    'macOS 通常自带 /usr/bin/expect；否则执行 brew install expect',
    env,
  );
  const oathtool = describeTool('oathtool', 'OATH_TOOL', 'brew install oath-toolkit', env);

  return {
    ok: expect.path !== undefined && oathtool.path !== undefined,
    loginScript,
    expect,
    oathtool,
  };
}

/**
 * 执行查询并把结果拼成文本；不在这里做权限判断。
 *
 * 只有带 DONE 的成功结果才有 text：没有终态说明远端没给出可靠退出状态，
 * 此时把 DATA 交给模型会把“不知道是否完成”伪装成“查过了”。
 */
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

/**
 * 允许注入登录子进程的配置键。
 *
 * WHY 用白名单而不是把整个 .env 传下去：`models.json` 的凭证变量、
 * 未来的第三方密钥都不应出现在登录进程的环境里。
 */
export const REMOTE_ENV_KEYS = [
  'JUMP_HOST',
  'JUMP_PORT',
  'JUMP_USER',
  'JUMP_PASSWORD',
  'MFA_SECRET',
  'APP_GROUP',
  'APP_USER',
  'LOG_DIR',
] as const;

/** 从配置值中提取登录所需字段；只保留白名单键。 */
export function remoteBridgeEnv(values: ReadonlyMap<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of REMOTE_ENV_KEYS) {
    const value = values.get(key);
    if (value !== undefined && value.trim() !== '') {
      env[key] = value;
    }
  }
  return env;
}

/** 一次登录验证所需的全部输入；目标由 /remote 的用户输入决定。 */
export interface BridgeSpawnConfig {
  readonly target: string;
  readonly expectPath: string;
  readonly loginScript: string;
  readonly oathTool: string;
  readonly remoteValues: Readonly<Record<string, string>>;
}

/**
 * 构造桥接子进程的启动参数。
 *
 * 拆成纯函数：环境集合与参数顺序可以在不启动任何进程的前提下测试，
 * 也保证“传了哪些凭证”只有这一处定义。
 */
export function buildBridgeSpawnOptions(config: BridgeSpawnConfig): SpawnTransportOptions {
  return {
    command: config.expectPath,
    // 目标作为独立 argv 传入，脚本自身校验网段；不拼接任何命令文本。
    args: [config.loginScript, '--agent', config.target],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '',
      TERM: 'dumb',
      // 脚本通过 require_env OATH_TOOL 调用 oathtool；
      // 必须把 Node 侧解析出的路径显式传入，避免两边各查一次、结果不一致。
      OATH_TOOL: config.oathTool,
      ...config.remoteValues,
    },
  };
}

/** 组合真实子进程传输与会话的默认依赖。 */
export function defaultConnectDeps(
  config: BridgeSpawnConfig,
  createSession: () => RemoteSession,
): ConnectDeps {
  return {
    createTransport: () => createSpawnTransport(buildBridgeSpawnOptions(config)),
    createSession,
  };
}
