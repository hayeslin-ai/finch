/**
 * 配置向导测试。
 *
 * WHY：向导直接改写含凭证的文件，任何“覆盖其他键”“回显密钥”
 * “并发覆盖”的缺陷都会造成真实损失。这里用假 IO 与临时目录验证这些不变量，
 * 不触真实终端、不读取用户配置。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runJumpServerWizard, runProviderWizard, type WizardIo } from '../../src/cli/wizard.js';
import { resolveAppPaths } from '../../src/config/paths.js';
import { updateEnvContent, hasKeyWithValue } from '../../src/config/env-update.js';
import { upsertProvider, parseModelsContent, validateProviderDraft } from '../../src/config/models-update.js';
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

/** 准备一个已完成 init 的临时配置目录。 */
async function prepareHome(): Promise<{ home: string; paths: ReturnType<typeof resolveAppPaths> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-wizard-'));
  const paths = resolveAppPaths(home);
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await chmod(paths.configDir, 0o700);
  await writeFile(
    paths.envFile,
    ['# 用户注释', 'REPO_ROOT=/repo', 'SERVICE_ID=svc', ''].join('\n'),
    { mode: 0o600 },
  );
  await writeFile(paths.modelsFile, '{\n  "providers": {}\n}\n', { mode: 0o600 });
  return { home, paths };
}

test('/provider 写入模型文件与凭证变量，且保留其他键与注释', async () => {
  const { home, paths } = await prepareHome();
  try {
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

    const env = await readFile(paths.envFile, 'utf8');
    assert.match(env, /^REPO_ROOT=\/repo$/m, '必须原样保留未被修改的键');
    assert.match(env, /^# 用户注释$/m, '必须保留注释');
    assert.match(env, /^SERVICE_ID=svc$/m);
    assert.ok(env.includes('MODEL_API_KEY="sk-secret-value"'));
    assert.match(env, /^MODEL_PROVIDER="myprovider"$/m);
    assert.match(env, /^MODEL_ID="group\/model"$/m);

    assert.equal((await stat(paths.envFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.modelsFile)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('/provider 未显示密钥，也不写入模型文件', async () => {
  const { home, paths } = await prepareHome();
  try {
    const io = fakeIo({
      text: ['p', 'https://gw.example/v1', 'openai-responses', 'm', '', 'MODEL_API_KEY', '', ''],
      secret: ['super-secret-abc'],
      approve: true,
    });

    const result = await runProviderWizard(paths, io);
    assert.equal(result.ok, true, result.message);

    const combined = io.output.join('\n');
    assert.ok(!combined.includes('super-secret-abc'), '输出不得包含密钥原文');

    const modelsText = await readFile(paths.modelsFile, 'utf8');
    assert.ok(!modelsText.includes('super-secret-abc'), '模型文件不得包含密钥原文');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('/provider 未确认时不写入任何文件', async () => {
  const { home, paths } = await prepareHome();
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
    await rm(home, { recursive: true, force: true });
  }
});

test('/jumpServer 校验目标网段并只写非敏感字段的明文', async () => {
  const { home, paths } = await prepareHome();
  try {
    const io = fakeIo({
      text: [
        '/usr/bin/expect',
        '/opt/scripts/login.exp',
        '/opt/homebrew/bin/oathtool',
        'operator',
        'appgroup',
        'app',
        '~/logs/',
        '22.50.14.22',
      ],
      secret: ['pw-value', 'mfa-value'],
      approve: true,
    });

    const result = await runJumpServerWizard(paths, io);
    assert.equal(result.ok, true, result.message);

    const env = await readFile(paths.envFile, 'utf8');
    assert.match(env, /^TARGET_HOST="22\.50\.14\.22"$/m);
    assert.match(env, /^JUMP_PASSWORD="pw-value"$/m);
    assert.match(env, /^MFA_SECRET="mfa-value"$/m);
    assert.ok(!/JUMP_HOST/.test(env), '堡垒机地址不得写入 .env');
    assert.ok(!/JUMP_PORT/.test(env), '堡垒机端口不得写入 .env');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('/jumpServer 拒绝不在允许网段的目标', async () => {
  const { home, paths } = await prepareHome();
  try {
    const io = fakeIo({
      text: ['', '', '', 'operator', '', 'app', '', '192.168.1.10'],
      secret: ['pw', 'mfa'],
      approve: true,
    });

    const result = await runJumpServerWizard(paths, io);
    assert.equal(result.ok, false);
    assert.match(result.message, /目标机不合法/);
    assert.match(await readFile(paths.envFile, 'utf8'), /^REPO_ROOT=\/repo$/m, '失败时不得改动配置');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('env 更新工具保留未知键并支持追加', () => {
  const updated = updateEnvContent('A=1\nCUSTOM=keep-me\n', new Map([['B', '2'], ['C', '3']]));
  assert.match(updated, /^A=1$/m, '未更新的键必须保持原样，不得被重写');
  assert.match(updated, /^CUSTOM=keep-me$/m, '未更新的键必须原样保留');
  assert.match(updated, /^B="2"$/m);
  assert.match(updated, /^C="3"$/m);
});

test('env 更新拒绝换行与控制字符，避免注入新键', () => {
  assert.throws(() => updateEnvContent('', new Map([['A', 'x\nB=evil']])), /换行或控制字符/);
  assert.throws(() => updateEnvContent('', new Map([['A', 'has"quote']])), /双引号/);
});

test('检测已设置的值但不暴露内容', () => {
  assert.equal(hasKeyWithValue('A="secret"\n', 'A'), true);
  assert.equal(hasKeyWithValue('A=""\n', 'A'), false);
  assert.equal(hasKeyWithValue('', 'A'), false);
});

test('模型合并保留其他 provider 与用户自定义字段', () => {
  const document = parseModelsContent(
    JSON.stringify({
      providers: {
        other: { baseUrl: 'https://x/v1', api: 'openai-responses', custom: 1 },
        mine: { baseUrl: 'https://old/v1', api: 'openai-responses', models: [{ id: 'm', name: 'm', extra: true }] },
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

test('并发修改时拒绝覆盖', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-atomic-'));
  try {
    const target = path.join(home, 'file.txt');
    await writeFile(target, 'original\n', { mode: 0o600 });
    const stale = fingerprint('original\n');

    // 模拟另一个进程在读取后改动文件。
    await writeFile(target, 'changed by someone else\n', { mode: 0o600 });

    await assert.rejects(() => atomicWriteFile(target, 'mine\n', stale), ConcurrentModificationError);
    assert.equal(await readFile(target, 'utf8'), 'changed by someone else\n');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
