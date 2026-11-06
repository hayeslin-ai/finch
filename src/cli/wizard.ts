/**
 * 配置向导：`/provider` 与 `/jumpServer`。
 *
 * 设计要点（与 PRD FR-10、Spec 5.1 一致）：
 * - 只在本机交互式终端运行，模型无法调用，也不经过模型。
 * - 敏感输入无回显；密钥只写 `.env`，`models.json` 仅保存 `$变量引用`。
 * - 写入前展示变更摘要，并要求输入 approve 确认。
 * - 保留文件中其他键与注释，原子替换，检测并发修改。
 * - 不生成明文备份，不把值放进命令行参数或历史。
 */
import path from 'node:path';

import { atomicWriteFile, readWithFingerprint } from '../config/atomic-write.js';
import { hasKeyWithValue, updateEnvContent } from '../config/env-update.js';
import {
  parseModelsContent,
  serializeModels,
  upsertProvider,
  validateProviderDraft,
  type ProviderDraft,
} from '../config/models-update.js';
import type { AppPaths } from '../config/paths.js';
import { validateTargetHost } from '../config/target.js';
import { askApproval, askSecret, askText, assertInteractiveTty, PromptCancelledError } from './prompt.js';

/** 向导依赖的输入输出，注入后可在测试中替换，不触碰真实终端。 */
export interface WizardIo {
  readonly out: (line: string) => void;
  readonly text: (question: string) => Promise<string>;
  readonly secret: (question: string) => Promise<string>;
  readonly approve: (question: string) => Promise<boolean>;
}

/**
 * 生产环境使用真实终端；测试注入假实现。
 *
 * WHY：TTY 校验放在这里而不是向导内部。
 * 向导是纯逻辑，测试需要注入假输入；而“能否安全关闭回显”
 * 是终端能力问题，属于生产 IO 的职责。
 */
export function createTerminalIo(): WizardIo {
  assertInteractiveTty();
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    text: askText,
    secret: askSecret,
    approve: askApproval,
  };
}

/** 向导结果；调用方据此决定退出码与提示。 */
export interface WizardResult {
  readonly ok: boolean;
  readonly message: string;
}

/** 未配置时提示保留原值；空输入表示“不修改”。 */
const KEEP_HINT = '（留空表示不修改）';

/**
 * `/provider` 向导。
 *
 * 只改三处：`.env` 的凭证变量、`models.json` 的 provider 与模型、运行选择。
 * 当前 provider 与模型选择写入 `.env` 的 MODEL_PROVIDER / MODEL_ID，
 * 因为本项目启动即读取该配置；思考等级不在本次范围。
 */
export async function runProviderWizard(paths: AppPaths, io: WizardIo): Promise<WizardResult> {
  try {
    const modelsFile = await readWithFingerprint(paths.modelsFile);
    if (modelsFile !== undefined && modelsFile.mode !== 0o600) {
      return { ok: false, message: 'models.json 权限不是 0600，请先修复后再运行向导' };
    }
    const envFile = await readWithFingerprint(paths.envFile);
    if (envFile !== undefined && envFile.mode !== 0o600) {
      return { ok: false, message: '.env 权限不是 0600，请先修复后再运行向导' };
    }

    io.out('配置模型 provider。所有输入只在本机处理，不发送给模型。');
    const providerId = (await io.text('provider 名称')).trim();
    const baseUrl = (await io.text('baseUrl')).trim();
    const api = (await io.text('api 协议，例如 openai-responses')).trim();
    const modelId = (await io.text('模型 ID')).trim();
    const modelName = (await io.text('模型显示名')).trim() || modelId;
    const credentialVar = (await io.text('凭证变量名，默认 MODEL_API_KEY')).trim() || 'MODEL_API_KEY';

    const contextRaw = (await io.text('上下文窗口 token 数（可选）')).trim();
    const maxTokensRaw = (await io.text('单次输出上限 token 数（可选）')).trim();

    const draft: ProviderDraft = {
      providerId,
      baseUrl,
      api,
      modelId,
      modelName,
      credentialVar,
      ...(contextRaw === '' ? {} : { contextWindow: Number(contextRaw) }),
      ...(maxTokensRaw === '' ? {} : { maxTokens: Number(maxTokensRaw) }),
    };

    const problems = validateProviderDraft(draft);
    if (problems.length > 0) {
      return { ok: false, message: `配置有误：${problems.join('；')}` };
    }

    const existingEnv = envFile?.content ?? '';
    const secretPrompt = hasKeyWithValue(existingEnv, credentialVar)
      ? `${credentialVar} 已设置，输入新值以替换`
      : `输入 ${credentialVar} 的值`;
    const credential = await io.secret(secretPrompt);
    if (credential.trim() === '') {
      return { ok: false, message: '未输入凭证，已取消，配置未修改' };
    }

    io.out('');
    io.out('将执行以下变更：');
    io.out(`  models.json  provider=${providerId}  api=${api}  model=${modelId}`);
    io.out(`               apiKey=$${credentialVar}（仅保存变量引用）`);
    io.out(`  .env         ${credentialVar}=（已输入，不回显）`);
    io.out(`               MODEL_PROVIDER=${providerId}`);
    io.out(`               MODEL_ID=${modelId}`);

    const approved = await io.approve('确认写入？');
    if (!approved) {
      return { ok: false, message: '已取消，配置未修改' };
    }

    const document = upsertProvider(
      parseModelsContent(modelsFile?.content ?? ''),
      draft,
    );
    const nextEnv = updateEnvContent(
      existingEnv,
      new Map([
        [credentialVar, credential],
        ['MODEL_PROVIDER', providerId],
        ['MODEL_ID', modelId],
      ]),
    );

    // 先写模型文件，再写含密钥的 .env：即使中途失败，也不会出现
    // “密钥已写入但没有对应模型配置”的半完成状态。
    await atomicWriteFile(paths.modelsFile, serializeModels(document), modelsFile?.fingerprint ?? '');
    await atomicWriteFile(paths.envFile, nextEnv, envFile?.fingerprint ?? '');

    return { ok: true, message: '已写入配置。运行 doctor 检查。' };
  } catch (error) {
    return { ok: false, message: describeWizardError(error) };
  }
}

/**
 * `/jumpServer` 向导。
 *
 * 堡垒机地址与端口由程序内置，不在此录入、也不写入 `.env`；
 * 向导只配置账号、认证、目标机、登录后范围与工具路径。
 */
export async function runJumpServerWizard(paths: AppPaths, io: WizardIo): Promise<WizardResult> {
  try {
    const envFile = await readWithFingerprint(paths.envFile);
    if (envFile !== undefined && envFile.mode !== 0o600) {
      return { ok: false, message: '.env 权限不是 0600，请先修复后再运行向导' };
    }
    const existing = envFile?.content ?? '';

    io.out('配置堡垒机连接与认证。地址与端口由程序内置，无需填写。');

    const expectPath = (await io.text(`Expect 可执行文件路径${KEEP_HINT}`)).trim();
    const loginScript = (await io.text(`登录脚本绝对路径${KEEP_HINT}`)).trim();
    const oathTool = (await io.text(`oathtool 可执行文件路径${KEEP_HINT}`)).trim();
    const jumpUser = (await io.text(`堡垒机账号${KEEP_HINT}`)).trim();
    const appGroup = (await io.text(`登录后初始账户组${KEEP_HINT}`)).trim();
    const appUser = (await io.text(`目标业务账户${KEEP_HINT}`)).trim();
    const logDir = (await io.text(`远程日志根目录${KEEP_HINT}`)).trim();
    const targetHost = (await io.text(`默认目标机（22.50.x.x 或 10.80.x.x）${KEEP_HINT}`)).trim();

    if (targetHost !== '') {
      const check = validateTargetHost(targetHost);
      if (!check.ok) {
        return { ok: false, message: `目标机不合法：${check.reason ?? ''}` };
      }
    }
    for (const [label, value] of [
      ['登录脚本', loginScript],
      ['Expect 路径', expectPath],
      ['oathtool 路径', oathTool],
    ] as const) {
      if (value !== '' && !path.isAbsolute(value)) {
        return { ok: false, message: `${label}必须是绝对路径` };
      }
    }

    const updates = new Map<string, string>();
    for (const [key, value] of [
      ['EXPECT_PATH', expectPath],
      ['LOGIN_SCRIPT', loginScript],
      ['OATH_TOOL', oathTool],
      ['JUMP_USER', jumpUser],
      ['APP_GROUP', appGroup],
      ['APP_USER', appUser],
      ['LOG_DIR', logDir],
      ['TARGET_HOST', targetHost],
    ] as const) {
      if (value !== '') {
        updates.set(key, value);
      }
    }

    const password = await io.secret(
      hasKeyWithValue(existing, 'JUMP_PASSWORD')
        ? '堡垒机密码已设置，输入新值以替换'
        : '输入堡垒机密码',
    );
    const mfa = await io.secret(
      hasKeyWithValue(existing, 'MFA_SECRET')
        ? 'MFA 秘钥已设置，输入新值以替换'
        : '输入 MFA 秘钥',
    );
    if (password.trim() === '' || mfa.trim() === '') {
      return { ok: false, message: '密码与 MFA 秘钥均为必填；已取消，配置未修改' };
    }
    updates.set('JUMP_PASSWORD', password);
    updates.set('MFA_SECRET', mfa);

    io.out('');
    io.out('将执行以下变更：');
    for (const key of updates.keys()) {
      // 密钥只显示“已设置”，不显示长度、片段或哈希。
      const display = key === 'JUMP_PASSWORD' || key === 'MFA_SECRET' ? '（已设置，不回显）' : updates.get(key);
      io.out(`  .env  ${key}=${display}`);
    }
    io.out('  .env  JUMP_HOST / JUMP_PORT 保持程序内置值，不写入配置');

    const approved = await io.approve('确认写入？');
    if (!approved) {
      return { ok: false, message: '已取消，配置未修改' };
    }

    await atomicWriteFile(paths.envFile, updateEnvContent(existing, updates), envFile?.fingerprint ?? '');
    return { ok: true, message: '已写入配置。运行 doctor --remote 检查工具与目标。' };
  } catch (error) {
    return { ok: false, message: describeWizardError(error) };
  }
}

/** 统一错误文案；不回显任何输入值。 */
function describeWizardError(error: unknown): string {
  if (error instanceof PromptCancelledError) {
    return '已取消，配置未修改';
  }
  if (error instanceof Error) {
    return `写入失败：${error.message}`;
  }
  return '写入失败：未知错误';
}
