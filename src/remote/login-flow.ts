/**
 * `/remote` 的登录编排：预检 → 连接 → 身份核对 → 建立授权。
 *
 * WHY 从扩展里抽出来单独成模块：
 * - 预检要在 `/remote` 命令里先跑一次（失败就不调用模型，避免白跑一轮）；
 * - 真正的登录发生在 `remote_query_plan` 工具里（用户确认计划之后），
 *   两处必须共用同一段逻辑与同一套错误文案，否则会出现“预检通过、登录失败”的口径分裂；
 * - 连接实现可注入，测试可以在不启动 Expect、不接触服务器的情况下断言
 *   连接失败、身份拒绝与授权建立的全部路径。
 *
 * 顺序契约（已与用户确认）：先语义分析并确认计划，再登录；
 * 因此计划被拒绝时根本不存在连接，只需清空待确认状态即可。
 */
import type { AppPaths } from '../config/paths.js';
import type { AuditLedger } from '../core/audit.js';
import type { RemoteAccess } from './access.js';
import {
  connectRemote,
  defaultConnectDeps,
  readRemoteTools,
  type BridgeSpawnConfig,
  type ConnectDeps,
  type ConnectResult,
  type RemoteConnectionConfig,
  type RemoteToolsResult,
} from './connector.js';
import { ensureLoginScript, type LoginScriptResult } from './login-script.js';
import { RemoteSession } from './session.js';

/**
 * 远程登录设置。
 *
 * 值只来自已校验的 `.env`；凭证仅进入子进程环境，不落盘、不进会话记录。
 * 配置缺失或非法时 available=false，/remote 明确失败，不尝试连接。
 */
export interface RemoteBridgeSettings {
  readonly available: boolean;
  readonly issues: readonly { readonly key: string; readonly reason: string }[];
  readonly values: Readonly<Record<string, string>>;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  /** 计划展示用的配额摘要；与工具层使用同一组限额。 */
  readonly limits?: {
    readonly maxQueries: number;
    readonly maxFiles: number;
    readonly maxResultLines: number;
    readonly maxResultBytes: number;
  };
  /** 登录后账户，仅用于计划展示。 */
  readonly appUser?: string;
}

/** 预检依赖；允许注入脚本生成与工具解析，便于离线测试。 */
export interface RemotePreflightDeps {
  readonly paths: AppPaths;
  readonly settings: RemoteBridgeSettings | undefined;
  /** 解析 expect / oathtool 的环境；省略时使用 process.env。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly ensureScript?: (paths: AppPaths) => Promise<LoginScriptResult>;
  readonly readTools?: (env: NodeJS.ProcessEnv, loginScript: string) => RemoteToolsResult;
}

/** 预检结果；成功时带上登录所需的三个路径，避免调用方各自重查。 */
export type RemotePreflightResult =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true;
      readonly message: string;
      /** 已确认可用的设置，调用方无需再次判空。 */
      readonly settings: RemoteBridgeSettings;
      readonly loginScript: string;
      readonly expectPath: string;
      readonly oathTool: string;
    };

/** 单个工具不可用的说明行；未找到与显式路径无效分别报告。 */
function describeToolProblem(tool: RemoteToolsResult['expect'] | RemoteToolsResult['oathtool']): string {
  return tool.error ?? `未找到 ${tool.name}：${tool.installHint}`;
}

/**
 * 登录前置检查：配置 → 登录脚本 → 可执行工具。
 *
 * 任何一项不成立都不建立连接；返回原因直接展示给用户，
 * 不尝试降级或改用其他路径。
 */
export async function preflightRemote(deps: RemotePreflightDeps): Promise<RemotePreflightResult> {
  const settings = deps.settings;
  if (settings === undefined || !settings.available) {
    const reasons =
      settings === undefined
        ? ['远程配置未加载']
        : settings.issues.map((item) => `${item.key}：${item.reason}`);
    return { ok: false, message: `远程配置不完整：\n${reasons.map((line) => `  ${line}`).join('\n')}` };
  }

  // 登录脚本由程序生成到固定位置；用户不需要设置 LOGIN_SCRIPT。
  const script = await (deps.ensureScript ?? ensureLoginScript)(deps.paths);
  if (!script.ok) {
    return { ok: false, message: `登录脚本不可用：${script.reason ?? '无法生成'}` };
  }

  const tools = (deps.readTools ?? readRemoteTools)(deps.env ?? process.env, script.path);
  if (!tools.ok) {
    const problems = [tools.expect, tools.oathtool]
      .filter((tool) => tool.path === undefined)
      .map(describeToolProblem);
    return { ok: false, message: `远程工具未就绪：\n${problems.map((line) => `  ${line}`).join('\n')}` };
  }

  // tools.ok 时两个路径必然存在；这里再收窄一次类型，避免把 undefined 带进 spawn 参数。
  const expectPath = tools.expect.path;
  const oathTool = tools.oathtool.path;
  if (expectPath === undefined || oathTool === undefined) {
    return { ok: false, message: '远程工具解析结果不完整，已中止。' };
  }

  return {
    ok: true,
    message: '预检通过',
    settings,
    loginScript: script.path,
    expectPath,
    oathTool,
  };
}

/** 一次登录所需的用户侧输入；目标与诉求由 `/remote` 登记的待确认请求提供。 */
export interface RemoteLoginRequest {
  readonly target: string;
  /** 用户确认后的查询目的；写入 grant 注记，用于审计与恢复展示。 */
  readonly intent: string;
  readonly grantId: string;
  /** 身份核对；由工具层桥接 `ctx.ui.confirm`。 */
  readonly confirmIdentity: (identity: string) => Promise<boolean>;
}

/** 登录依赖；`connect` 与 `createSession` 供测试替换为内存实现。 */
export interface RemoteLoginDeps extends RemotePreflightDeps {
  readonly access: RemoteAccess;
  readonly audit: AuditLedger;
  readonly connect?: (
    target: string,
    config: RemoteConnectionConfig,
    deps: ConnectDeps,
  ) => Promise<ConnectResult>;
  readonly createSession?: (settings: RemoteBridgeSettings) => RemoteSession;
}

export interface RemoteLoginResult {
  readonly ok: boolean;
  readonly message: string;
  /** 就绪时脚本回传的身份摘要；仅用于提示，不是凭证。 */
  readonly identity?: string;
}

/** 记录一条 CLOSE 审计；身份拒绝与连接失败都必须留痕。 */
function recordClose(audit: AuditLedger, target: string, reason: string): void {
  audit.record({
    at: new Date().toISOString(),
    operation: 'CLOSE',
    target,
    params: reason,
    result: 'closed',
    grant: '-',
  });
}

/**
 * 建立登录并进入授权状态。
 *
 * 前置：计划已获用户确认（由调用方保证）；这里只按固定顺序
 * 连接 → 审计 → 身份核对 → 建立 grant，任一步失败即关闭连接。
 */
export async function loginRemote(
  request: RemoteLoginRequest,
  deps: RemoteLoginDeps,
): Promise<RemoteLoginResult> {
  const preflight = await preflightRemote(deps);
  if (!preflight.ok) {
    return { ok: false, message: preflight.message };
  }

  const settings = preflight.settings;
  const config: RemoteConnectionConfig = {
    expectPath: preflight.expectPath,
    loginScript: preflight.loginScript,
    oathTool: preflight.oathTool,
  };
  // 子进程启动参数包含目标与白名单环境；凭证只从这里进入登录进程。
  const spawnConfig: BridgeSpawnConfig = {
    target: request.target,
    expectPath: preflight.expectPath,
    loginScript: preflight.loginScript,
    oathTool: preflight.oathTool,
    remoteValues: settings.values,
  };

  const createSession =
    deps.createSession ??
    ((value: RemoteBridgeSettings) =>
      new RemoteSession({
        connectTimeoutMs: value.connectTimeoutMs,
        queryTimeoutMs: value.queryTimeoutMs,
      }));

  const started = Date.now();
  const result = await (deps.connect ?? connectRemote)(
    request.target,
    config,
    defaultConnectDeps(spawnConfig, () => createSession(settings)),
  );

  deps.audit.record({
    at: new Date().toISOString(),
    operation: 'CONNECT',
    target: request.target,
    // 只记录“计划已确认”，purpose 与关键词原文不进入账本。
    params: 'plan-confirmed',
    result: result.ok ? 'ok' : 'failed',
    grant: '-',
    durationMs: Date.now() - started,
  });

  if (!result.ok || result.session === undefined) {
    return { ok: false, message: `连接失败：${result.message}` };
  }

  // READY 只证明脚本完成了登录与目录核对；IP 与 hostname 的映射
  // 无法在不做 DNS 的前提下自证，因此必须由用户确认身份。
  const confirmed = await request.confirmIdentity(result.identity ?? '');
  if (!confirmed) {
    await result.session.close();
    recordClose(deps.audit, request.target, 'identity-rejected');
    return { ok: false, message: '身份未确认，连接已关闭，未执行任何查询。' };
  }

  const limits = settings.limits;
  if (limits === undefined) {
    await result.session.close();
    deps.audit.record({
      at: new Date().toISOString(),
      operation: 'CLOSE',
      target: request.target,
      params: 'limits-missing',
      result: 'closed',
      grant: '-',
    });
    return { ok: false, message: '远程授权组件未加载，连接已关闭。' };
  }

  deps.access.begin(result.session, {
    id: request.grantId,
    target: request.target,
    intent: request.intent,
    logDir: result.identity ?? '',
    maxQueries: limits.maxQueries,
    maxFiles: limits.maxFiles,
  });

  return {
    ok: true,
    identity: result.identity ?? '',
    message:
      `已授权 ${request.target} 的只读日志查询。可用 remote_log_list 枚举、` +
      'remote_log_search 搜索、remote_log_read 读取；/remote-close 结束。',
  };
}
