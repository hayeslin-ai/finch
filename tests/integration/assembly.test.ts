/**
 * 组装根集成测试（离线）。
 *
 * WHY：本项目最近一轮审查暴露的问题全部是同一类——
 * 模块写完了但没有接线，代码看着齐全，功能却不可达。
 * 静态检查与单元测试都发现不了这种问题，因为它们不经过真实的组装根。
 *
 * 因此这里跑完整的 `compose()`：真实创建模型运行时、真实走
 * createAgentSessionServices + createAgentSessionFromServices、
 * 真实绑定扩展钩子，然后断言：
 * - 工具白名单恰好是八个只读/计划工具（多一个都是越权，少一个都是不可达）；
 * - 扩展能被加载且没有诊断错误；
 * - session_start 钩子真的被 SDK 触发并写入会话记录。
 *
 * 全程不发起任何模型请求：模型运行时禁用了网络刷新，
 * 且本测试从不调用 prompt。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { compose } from '../../src/app/composition.js';
import type { AppPaths } from '../../src/config/paths.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { parseLimits } from '../../src/config/limits.js';
import { loadSession } from '../../src/storage/session.js';

/**
 * 本项目唯一允许模型调用的工具。
 *
 * 远程三个查询工具常驻注册，但未授权时只返回拒绝原因；
 * remote_query_plan 是唯一能建立远程授权状态的入口。
 * 注册面固定，运行时能力由授权状态与计划门禁共同决定。
 */
const EXPECTED_TOOLS = [
  'source_search',
  'source_read',
  'local_log_search',
  'local_log_read',
  'remote_log_list',
  'remote_log_search',
  'remote_log_read',
  'remote_query_plan',
];

/** 造一个最小可用的用户目录与仓库，全部位于临时目录内。 */
async function createFixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-assembly-'));
  const configDir = path.join(home, 'config');
  const repoRoot = path.join(home, 'repo');
  await mkdir(configDir, { recursive: true });
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(path.join(repoRoot, 'src', 'Service.java'), 'class Service { void run() {} }\n');

  const paths: AppPaths = {
    configDir,
    envFile: path.join(configDir, '.env'),
    modelsFile: path.join(configDir, 'models.json'),
    redactionRulesFile: path.join(configDir, 'redaction.json'),
    loginScriptFile: path.join(configDir, 'login_agent.exp'),
    stateDir: path.join(home, 'state'),
    dataDir: path.join(home, 'data'),
  };

  // 凭证用字面量，避免测试依赖 .env 的存在。
  await writeFile(
    paths.modelsFile,
    JSON.stringify({
      providers: {
        local: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-responses',
          apiKey: 'test-key-not-used',
          models: [{ id: 'test-model', name: 'test-model', contextWindow: 128_000, maxTokens: 8_192 }],
        },
      },
    }),
  );

  const config: LoadedConfig = {
    values: new Map(),
    limits: parseLimits(new Map()).limits,
    model: { provider: 'local', modelId: 'test-model' },
    modelAutoSelected: false,
    repoRoot,
    serviceId: 'assembly-test',
    issues: [],
    warnings: [],
    pathChecks: [],
    available: { base: true, local: true, remote: false },
  };

  return { home, paths, config, cleanup: async () => rm(home, { recursive: true, force: true }) };
}

test('组装根产出的工具白名单恰好是八个工具', async () => {
  const fixture = await createFixture();
  try {
    const composition = await compose({
      config: fixture.config,
      paths: fixture.paths,
      knowledge: { dataDir: fixture.paths.dataDir, scopeId: 'assembly-test' },
    });

    try {
      const session = composition.runtime.session;
      const callable = session.getCallableToolNames();

      for (const name of EXPECTED_TOOLS) {
        assert.ok(callable.includes(name), `工具不可达：${name}`);
      }
      assert.deepEqual(
        [...callable].sort(),
        [...EXPECTED_TOOLS].sort(),
        '多出任何工具都意味着模型拿到了未审核的能力',
      );
      assert.equal(session.sessionFile, undefined, '会话必须留在内存，不写 Pi 默认 JSONL');
    } finally {
      await composition.dispose();
    }
  } finally {
    await fixture.cleanup();
  }
});

test('扩展能被真实加载，且 session_start 钩子写入会话记录', async () => {
  const fixture = await createFixture();
  try {
    const composition = await compose({
      config: fixture.config,
      paths: fixture.paths,
      knowledge: { dataDir: fixture.paths.dataDir, scopeId: 'assembly-test' },
    });

    try {
      assert.deepEqual(
        [...composition.runtime.diagnostics],
        [],
        '扩展加载诊断必须为空，否则说明钩子注册失败',
      );

      // InteractiveMode 启动时做的就是这一步：绑定扩展并触发 session_start。
      await composition.runtime.session.bindExtensions({});
    } finally {
      await composition.dispose();
    }

    const snapshot = await loadSession(fixture.paths.stateDir, composition.sessionId);
    assert.ok(!('error' in snapshot), '会话事件必须已落盘');
    const types = snapshot.events.map((event) => event.type);
    assert.ok(
      types.includes('session.start'),
      'session_start 钩子没被触发，说明扩展没接上真实运行时的生命周期',
    );
    assert.ok(types.includes('session.close'), 'dispose 必须写完最后一条记录');
  } finally {
    await fixture.cleanup();
  }
});

test('恢复会话时沿用原会话标识，事件追加到同一目录', async () => {
  const fixture = await createFixture();
  try {
    const first = await compose({
      config: fixture.config,
      paths: fixture.paths,
      knowledge: { dataDir: fixture.paths.dataDir, scopeId: 'assembly-test' },
    });
    const sessionId = first.sessionId;
    await first.dispose();

    const resumed = await compose({
      config: fixture.config,
      paths: fixture.paths,
      knowledge: { dataDir: fixture.paths.dataDir, scopeId: 'assembly-test' },
      sessionId,
    });
    await resumed.dispose();

    assert.equal(resumed.sessionId, sessionId, '恢复必须沿用原标识，否则摘要永远是空的');

    const snapshot = await loadSession(fixture.paths.stateDir, sessionId);
    assert.ok(!('error' in snapshot));
    // 两次 compose 各写一条 close；若各写各的目录，这里只会有 1 条。
    assert.equal(
      snapshot.events.filter((event) => event.type === 'session.close').length,
      2,
      '两次会话必须追加到同一个 events.jsonl',
    );
  } finally {
    await fixture.cleanup();
  }
});
