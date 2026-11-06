/**
 * 配置向导测试。
 *
 * 核心约束（已确认）：**程序绝不写入或修改 `.env`**。
 * 因此这里最重要的断言不是“写了什么”，而是“.env 是否逐字节未变”。
 * 全部使用假 IO 与临时目录，不触真实终端、不读取用户配置。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runJumpServerWizard, runProviderWizard, type WizardIo } from '../../src/cli/wizard.js';
import { resolveAppPaths } from '../../src/config/paths.js';
import {
  parseModelsContent,
  upsertProvider,
  validateProviderDraft,
} from '../../src/config/models-update.js';
import { atomicWriteFile, ConcurrentModificationError, fingerprint } from '../../src/config/atomic-write.js';

/** 按顺序返回预置答案的假终端；所有输出被收集供断言。 */
function fakeIo(answers: {
  text?: string[];
  secret?: string[];
  approve?: boolean;
}): WizardIo & { output: string[] } {
  const texts = [...(answers.text ?? [])];
  const secrets = [...(answers.secret ?? [])];
  const output: string[] = [];
  return {
    output,
    out: (line) => output.push(line),
    text: async () => texts.shift() ?? '',
    secret: async () => secrets.shift() ?? '',
    approve: async () => answers.approve ?? false,
  };
}

/** 准备临时 home 与临时项目目录，模拟真实布局。 */
async function prepareEnv() {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-wizard-home-'));
  const project = await mkdtemp(path.join(tmpdir(), 'finch-wizard-proj-'));
  const paths = resolveAppPaths(home);
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700);
  await writeFile(paths.modelsFile, '{\n  "providers": {}\n}\n', { mode: 0o600 });

  // 项目 .env 预先存在，用于验证程序不会改动它。
  const originalEnv = ['# 用户手动维护', 'JUMP_USER=existing-user', ''].join('\n');
  await writeFile(paths.envFile, originalEnv, { mode: 0o600 });

  return {
    home,
    project,
    paths,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    },
  };
}

test('provider 只写 models.json，绝不修改 .env', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const before = await readFile(paths.envFile, 'utf8');
    const io = fakeIo({
      text: ['myprovider', 'http://127.0.0.1:3425/v1', 'openai-responses', 'group/model', 'Model', 'MODEL_API_KEY', '', ''],
      secret: ['sk-secret-value'],
      approve: true,
    });

    const result = await runProviderWizard(paths, io);
    assert.equal(result.ok, true, result.message);

    const models = JSON.parse(await readFile(paths.modelsFile, 'utf8')) as {
      providers: Record<string, { apiKey: string; models: Array<{ id: string }> }>;
    };
    assert.equal(models.providers['myprovider']?.apiKey, '$MODEL_API_KEY', '只能保存变量引用');
    assert.equal(models.providers['myprovider']?.models[0]?.id, 'group/model');
    assert.equal((await stat(paths.modelsFile)).mode & 0o777, 0o600);

    const after = await readFile(paths.envFile, 'utf8');
    assert.equal(after, before, '.env 必须保持逐字节不变');
  } finally {
    await cleanup();
  }
});

test('provider 写入模型选择到 settings.json，且不回显密钥', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const io = fakeIo({
      text: ['p', 'https://gw.example/v1', 'openai-responses', 'm', '', 'MODEL_API_KEY', '', ''],
      secret: ['super-secret-abc'],
      approve: true,
    });

    const result = await runProviderWizard(paths, io);
    assert.equal(result.ok, true, result.message);

    const joined = io.output.join('\n');
    assert.ok(!joined.includes('super-secret-abc'), '输出不得包含密钥原文');

    // 当前选择与模型定义分离，切换模型不重写 models.json。
    const settings = JSON.parse(await readFile(paths.settingsFile, 'utf8')) as {
      modelProvider: string;
      modelId: string;
    };
    assert.equal(settings.modelProvider, 'p');
    assert.equal(settings.modelId, 'm');
  } finally {
    await cleanup();
  }
});

test('provider 未确认时两个文件都不改', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const beforeEnv = await readFile(paths.envFile, 'utf8');
    const beforeModels = await readFile(paths.modelsFile, 'utf8');
    const io = fakeIo({
      text: ['p', 'https://gw.example/v1', 'openai-responses', 'm', '', 'MODEL_API_KEY', '', ''],
      secret: ['value'],
      approve: false,
    });

    const result = await runProviderWizard(paths, io);
    assert.equal(result.ok, false);
    assert.match(result.message, /已取消/);
    assert.equal(await readFile(paths.envFile, 'utf8'), beforeEnv);
    assert.equal(await readFile(paths.modelsFile, 'utf8'), beforeModels);
  } finally {
    await cleanup();
  }
});

test('jumpserver 只生成片段，不写任何文件，并预置默认值', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const before = await readFile(paths.envFile, 'utf8');
    // 只输入账号；其余留空以验证默认值。
    const io = fakeIo({ text: ['operator', '', '', ''] });

    const result = await runJumpServerWizard(io);
    assert.equal(result.ok, true, result.message);

    assert.equal(await readFile(paths.envFile, 'utf8'), before, '.env 必须保持不变');

    const lines = result.manualEnvLines ?? [];
    assert.ok(lines.includes('JUMP_USER=operator'));
    assert.ok(lines.includes('JUMP_PASSWORD=<在此填入你的密码>'), '密钥只能是占位符');
    assert.ok(lines.includes('MFA_SECRET=<在此填入你的 MFA 秘钥>'));
    assert.ok(lines.includes('APP_GROUP=appgroup'), '应预置默认账户组');
    assert.ok(lines.includes('APP_USER=app'));
    assert.ok(lines.includes('LOG_DIR=~/sxpservice/logs/'));

    // 已移出配置的项不得出现在片段中。
    for (const key of ['TARGET_HOST', 'JUMP_HOST', 'JUMP_PORT', 'EXPECT_PATH', 'LOGIN_SCRIPT', 'OATH_TOOL']) {
      assert.ok(!lines.some((line) => line.startsWith(`${key}=`)), `片段不得包含 ${key}`);
    }
  } finally {
    await cleanup();
  }
});

test('jumpserver 拒绝空账号', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const before = await readFile(paths.envFile, 'utf8');
    const io = fakeIo({ text: ['', '', '', ''] });

    const result = await runJumpServerWizard(io);
    assert.equal(result.ok, false);
    assert.match(result.message, /账号不能为空/);
    assert.equal(await readFile(paths.envFile, 'utf8'), before);
  } finally {
    await cleanup();
  }
});

test('jumpserver 接受自定义账户与日志目录', async () => {
  const { paths, cleanup } = await prepareEnv();
  try {
    const io = fakeIo({ text: ['operator', 'opsgroup', 'opsuser', '/var/log/app/'] });

    const result = await runJumpServerWizard(io);
    assert.equal(result.ok, true, result.message);

    const lines = result.manualEnvLines ?? [];
    assert.ok(lines.includes('APP_GROUP=opsgroup'));
    assert.ok(lines.includes('APP_USER=opsuser'));
    assert.ok(lines.includes('LOG_DIR=/var/log/app/'));
    assert.equal(await readFile(paths.envFile, 'utf8'), '# 用户手动维护\nJUMP_USER=existing-user\n');
  } finally {
    await cleanup();
  }
});

test('模型合并保留其他 provider 与用户自定义字段', () => {
  const document = parseModelsContent(
    JSON.stringify({
      providers: {
        other: { baseUrl: 'https://x/v1', api: 'openai-responses', custom: 1 },
        mine: {
          baseUrl: 'https://old/v1',
          api: 'openai-responses',
          models: [{ id: 'm', name: 'm', extra: true }],
        },
      },
      topLevelUserField: 'keep',
    }),
  );

  const merged = upsertProvider(document, {
    providerId: 'mine',
    baseUrl: 'https://new/v1',
    api: 'openai-responses',
    modelId: 'm',
    modelName: 'm',
    credentialVar: 'MODEL_API_KEY',
  });

  const providers = merged.providers as Record<string, Record<string, unknown>>;
  assert.equal(providers['other']?.['custom'], 1, '其他 provider 不得被改动');
  assert.equal(merged['topLevelUserField'], 'keep', '顶层未知字段必须保留');
  assert.equal(providers['mine']?.['baseUrl'], 'https://new/v1');
  assert.equal((providers['mine']?.['models'] as Array<Record<string, unknown>>)[0]?.['extra'], true);
});

test('provider 定义校验拒绝非法输入', () => {
  const problems = validateProviderDraft({
    providerId: 'bad id',
    baseUrl: 'ftp://x',
    api: '',
    modelId: '',
    modelName: '',
    credentialVar: '1bad',
    contextWindow: -1,
  });
  assert.ok(problems.length >= 5, `应报告多个问题，实际 ${problems.length}`);
});

test('并发修改时拒绝覆盖 models.json', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-atomic-'));
  try {
    const target = path.join(home, 'file.txt');
    await writeFile(target, 'original\n', { mode: 0o600 });
    const stale = fingerprint('original\n');

    await writeFile(target, 'changed by someone else\n', { mode: 0o600 });

    await assert.rejects(() => atomicWriteFile(target, 'mine\n', stale), ConcurrentModificationError);
    assert.equal(await readFile(target, 'utf8'), 'changed by someone else\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
