/**
 * 登录编排测试（纯内存，不启动 Expect、不接触服务器）。
 *
 * 验证顺序契约：预检失败不连接；连接成功但身份被拒绝时关闭连接且不建立授权；
 * 只有身份确认后才调用 access.begin，并把用户确认的目的写入 grant。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AppPaths } from '../../src/config/paths.js';
import { parseLimits } from '../../src/config/limits.js';
import { AuditLedger } from '../../src/core/audit.js';
import { RemoteAccess } from '../../src/remote/access.js';
import type { ConnectResult, RemoteToolsResult } from '../../src/remote/connector.js';
import {
  loginRemote,
  preflightRemote,
  type RemoteBridgeSettings,
  type RemoteLoginDeps,
} from '../../src/remote/login-flow.js';
import type { LoginScriptResult } from '../../src/remote/login-script.js';
import { RemoteSession } from '../../src/remote/session.js';
import type { RemoteTransport } from '../../src/remote/transport.js';

const LIMITS = parseLimits(new Map()).limits;

const PATHS: AppPaths = {
  configDir: '/home/tester/.config/finch',
  envFile: '/home/tester/.config/finch/.env',
  modelsFile: '/home/tester/.config/finch/models.json',
  redactionRulesFile: '/home/tester/.config/finch/redaction.json',
  loginScriptFile: '/home/tester/.config/finch/login_agent.exp',
  stateDir: '/home/tester/state',
  dataDir: '/home/tester/data',
};

const SETTINGS: RemoteBridgeSettings = {
  available: true,
  issues: [],
  values: {},
  connectTimeoutMs: 1_000,
  queryTimeoutMs: 1_000,
  limits: {
    maxQueries: LIMITS.MAX_QUERY_COUNT,
    maxFiles: LIMITS.MAX_FILES,
    maxResultLines: LIMITS.MAX_RESULT_LINES,
    maxResultBytes: LIMITS.MAX_RESULT_BYTES,
  },
};

const READY = JSON.stringify({
  v: 1,
  op: 'READY',
  id: 0,
  nonce: 'ready',
  seq: 0,
  payload: 'host=h1;user=app;dir=/home/app/logs;caps=grep=1',
});

class SilentTransport implements RemoteTransport {
  closed = false;
  private lineHandler: ((line: string) => void) | undefined;

  write(): void {
    // 登录流程不发送业务查询，这里无需记录。
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandler = handler;
  }

  onExit(): void {
    // 不模拟退出。
  }

  close(): void {
    this.closed = true;
  }

  emit(line: string): void {
    this.lineHandler?.(line);
  }
}

/** 建立一条 READY 的会话；仅用于让 close()/身份核对路径可执行。 */
async function readySession(): Promise<{ session: RemoteSession; transport: SilentTransport }> {
  const transport = new SilentTransport();
  const session = new RemoteSession({ connectTimeoutMs: 1_000, queryTimeoutMs: 1_000 });
  const attaching = session.attach(transport);
  transport.emit(READY);
  const attached = await attaching;
  assert.equal(attached.ok, true, attached.message ?? '');
  return { session, transport };
}

const SCRIPT_OK: LoginScriptResult = {
  ok: true,
  path: '/home/tester/.config/finch/login_agent.exp',
  status: 'kept',
};

function toolsOk(): RemoteToolsResult {
  return {
    ok: true,
    loginScript: SCRIPT_OK.path,
    expect: {
      name: 'expect',
      envKey: 'EXPECT_PATH',
      path: '/usr/bin/expect',
      source: 'path',
      installHint: 'brew install expect',
    },
    oathtool: {
      name: 'oathtool',
      envKey: 'OATH_TOOL',
      path: '/opt/homebrew/bin/oathtool',
      source: 'path',
      installHint: 'brew install oath-toolkit',
    },
  };
}

function baseDeps(overrides: Partial<RemoteLoginDeps> = {}): RemoteLoginDeps {
  const audit = overrides.audit ?? new AuditLedger();
  const access =
    overrides.access ??
    new RemoteAccess({ audit, canWork: () => true, limits: LIMITS, queryTimeoutMs: 1_000 });
  return {
    paths: PATHS,
    settings: SETTINGS,
    access,
    audit,
    ensureScript: async () => SCRIPT_OK,
    readTools: () => toolsOk(),
    ...overrides,
  };
}

function successConnect(session: RemoteSession): () => Promise<ConnectResult> {
  return async () => ({
    ok: true,
    session,
    identity: 'host=h1;user=app;dir=/home/app/logs',
    message: '已连接',
  });
}

test('预检：配置缺失、脚本失败、工具缺失都直接失败且不连接', async () => {
  const missing = await preflightRemote({ paths: PATHS, settings: undefined });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /远程配置未加载/);

  const unavailable = await preflightRemote({
    paths: PATHS,
    settings: { ...SETTINGS, available: false, issues: [{ key: 'JUMP_HOST', reason: '缺失' }] },
  });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /JUMP_HOST/);

  const scriptFailed = await preflightRemote({
    paths: PATHS,
    settings: SETTINGS,
    ensureScript: async () => ({ ok: false, path: SCRIPT_OK.path, status: 'unsafe', reason: '符号链接' }),
    readTools: () => toolsOk(),
  });
  assert.equal(scriptFailed.ok, false);
  assert.match(scriptFailed.message, /登录脚本不可用.*符号链接/);

  const toolMissing = await preflightRemote({
    paths: PATHS,
    settings: SETTINGS,
    ensureScript: async () => SCRIPT_OK,
    readTools: () => ({
      ...toolsOk(),
      ok: false,
      expect: {
        name: 'expect',
        envKey: 'EXPECT_PATH',
        installHint: 'brew install expect',
      },
    }),
  });
  assert.equal(toolMissing.ok, false);
  assert.match(toolMissing.message, /远程工具未就绪/);
});

test('身份确认后才建立授权，grant 写入用户确认的目的', async () => {
  const { session, transport } = await readySession();
  const audit = new AuditLedger();
  const deps = baseDeps({ audit });
  let confirmCalls = 0;

  const result = await loginRemote(
    {
      target: '22.50.0.1',
      intent: '定位订单创建失败原因',
      grantId: 'grant-1',
      confirmIdentity: async (identity) => {
        confirmCalls += 1;
        assert.match(identity, /host=h1/);
        return true;
      },
    },
    { ...deps, connect: successConnect(session) },
  );

  assert.equal(result.ok, true, result.message);
  assert.equal(confirmCalls, 1, '必须先核对身份');
  assert.equal(deps.access.active, true);
  assert.equal(deps.access.currentGrant?.intent, '定位订单创建失败原因');
  assert.equal(deps.access.currentGrant?.id, 'grant-1');

  const operations = audit.recent(10).map((entry) => `${entry.operation}:${entry.params}`);
  assert.ok(operations.includes('CONNECT:plan-confirmed'), 'CONNECT 应记录计划已确认，而不是 traceId');
  assert.ok(!operations.some((item) => item.includes('定位订单')), '目的原文不得进入审计');
  assert.equal(transport.closed, false, '授权成功不得关闭连接');

  await deps.access.end();
});

test('身份被拒绝时关闭连接，不建立授权', async () => {
  const { session, transport } = await readySession();
  const audit = new AuditLedger();
  const deps = baseDeps({ audit });

  const result = await loginRemote(
    {
      target: '22.50.0.1',
      intent: '定位订单创建失败原因',
      grantId: 'grant-1',
      confirmIdentity: async () => false,
    },
    { ...deps, connect: successConnect(session) },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /身份未确认/);
  assert.equal(transport.closed, true, '拒绝身份必须释放连接');
  assert.equal(deps.access.active, false);
  assert.equal(audit.recent(10).at(-1)?.params, 'identity-rejected');
});

test('连接失败时如实报告，不建立授权', async () => {
  const audit = new AuditLedger();
  const deps = baseDeps({ audit });

  const result = await loginRemote(
    {
      target: '22.50.0.1',
      intent: '定位订单创建失败原因',
      grantId: 'grant-1',
      confirmIdentity: async () => true,
    },
    {
      ...deps,
      connect: async () => ({ ok: false, message: '认证失败：OTP 或密码可能不正确' }),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /连接失败：认证失败/);
  assert.equal(deps.access.active, false);
  const connectEntry = audit.recent(10).find((entry) => entry.operation === 'CONNECT');
  assert.equal(connectEntry?.result, 'failed');
});

test('配额缺失时关闭连接，不建立授权', async () => {
  const { session, transport } = await readySession();
  const audit = new AuditLedger();
  const deps = baseDeps({ audit });
  const { limits: _limits, ...settingsWithoutLimits } = SETTINGS;

  const result = await loginRemote(
    {
      target: '22.50.0.1',
      intent: '定位订单创建失败原因',
      grantId: 'grant-1',
      confirmIdentity: async () => true,
    },
    {
      ...deps,
      settings: settingsWithoutLimits,
      connect: successConnect(session),
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /授权组件未加载/);
  assert.equal(transport.closed, true);
  assert.equal(deps.access.active, false);
});
