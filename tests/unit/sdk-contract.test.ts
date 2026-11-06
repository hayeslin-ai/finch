/**
 * Pi SDK 1.5.0 最小契约测试。
 *
 * WHY：Spec 依赖若干 SDK 行为——内存会话、内存设置、显式模型运行时、
 * 可关闭的自动压缩/重试/缓存预热。这些行为在 SDK 升级时可能悄然改变，
 * 因此用离线契约测试把它们固定下来。
 *
 * 本测试全程离线：不读取 ~/.pi 凭证，不访问网络，不调用模型。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CreateModelRuntimeOptions,
} from '@earendil-works/pi-coding-agent';

/**
 * CredentialStore 未从包根导出（发行版未公开该名称），
 * 因此从公开的 CreateModelRuntimeOptions 推导类型，避免依赖内部路径。
 */
type CredentialStore = NonNullable<CreateModelRuntimeOptions['credentials']>;

/**
 * 空凭证存储：只提供内存视图，不读取磁盘、不执行命令、不访问环境变量。
 * WHY：SDK 的凭证解析会回退到宿主环境，这里显式切断该路径，
 * 由上层白名单环境变量注入，而不是让 SDK 自由读取。
 */
class EmptyCredentialStore implements CredentialStore {
  async read(): Promise<undefined> {
    return undefined;
  }

  async list(): Promise<readonly never[]> {
    return [];
  }

  async modify(): Promise<undefined> {
    return undefined;
  }

  async delete(): Promise<void> {
    // 无持久化，无需清理。
  }
}

/** 创建临时模型配置，指向本地不可达端口；契约测试不会真正发起请求。 */
async function createTemporaryModelsFile(directory: string): Promise<string> {
  const file = path.join(directory, 'models.json');
  await writeFile(
    file,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-responses',
          apiKey: 'fixture',
          models: [{ id: 'fixture-model', name: 'fixture-model', maxTokens: 1024 }],
        },
      },
    }),
    'utf8',
  );
  return file;
}

test('SDK 导出的关键 API 与 Spec 假设一致', () => {
  assert.equal(typeof createAgentSession, 'function');
  assert.equal(typeof ModelRuntime.create, 'function');
  assert.equal(typeof SessionManager.inMemory, 'function');
  assert.equal(typeof SettingsManager.inMemory, 'function');
});

test('内存设置可关闭压缩、重试与缓存预热', () => {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    cacheWarming: 'off',
  });
  const effective = settings.getSettings() as {
    compaction?: { enabled?: boolean };
    retry?: { enabled?: boolean; provider?: { maxRetries?: number } };
    cacheWarming?: string;
  };

  assert.equal(effective.compaction?.enabled, false);
  assert.equal(effective.retry?.enabled, false);
  assert.equal(effective.retry?.provider?.maxRetries, 0);
  assert.equal(effective.cacheWarming, 'off');
});

test('内存会话不写入 Pi 默认会话目录', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-sdk-'));
  try {
    const session = SessionManager.inMemory(directory);
    // 内存会话没有可持久化的会话文件路径；对外只暴露内存中的条目。
    assert.equal(session.getSessionFile(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('模型运行时可在禁用网络与禁用凭证读取的情况下创建', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'finch-sdk-'));
  try {
    const modelsPath = await createTemporaryModelsFile(directory);
    const runtime = await ModelRuntime.create({
      modelsPath,
      credentials: new EmptyCredentialStore(),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });

    // 内置 provider 目录会随 SDK 一起加载，本产品从不使用它们。
    // 隔离来自显式模型选择、受限凭证存储与关闭网络刷新，而不是靠目录为空；
    // 因此这里只断言“配置的模型可被精确解析、不存在的模型不回退”。
    const model = runtime.getModel('fixture', 'fixture-model');
    assert.ok(model, '必须能按 provider + 模型 ID 取到唯一模型');
    assert.equal(model.id, 'fixture-model');
    assert.equal(runtime.getModels('fixture').length, 1, '该 provider 只应含配置中的一个模型');

    assert.equal(runtime.getModel('fixture', 'not-exist'), undefined, '不存在的模型不得回退到其他模型');
    assert.equal(runtime.getModel('not-exist', 'fixture-model'), undefined, '未知 provider 不得被解析');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
