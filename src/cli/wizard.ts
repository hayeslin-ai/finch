/**
 * 配置向导：`provider` 与 `jumpserver`。
 *
 * 关键约束（已确认）：
 * **`.env` 只能由用户人工编辑，程序绝不写入或修改。**
 * 因此两个向导都不会触碰 `.env`：
 * - `provider` 只写 `models.json`（模型定义，可跨项目复用），
 *   并把需要手动加入 `.env` 的行打印出来；
 * - `jumpserver` 不写任何文件，只输出一段可复制的配置片段。
 *
 * 这样凭证的落盘时机完全由用户掌控，也避免程序在用户不知情时
 * 改写连接信息或覆盖已有条目。
 */
import { atomicWriteFile, readWithFingerprint } from '../config/atomic-write.js';
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
 * TTY 校验放在这里而不是向导内部：向导是纯逻辑，而“能否安全关闭回显”
 * 属于终端能力问题。
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
  /** 需要用户手动写入 `.env` 的内容；不含真实密钥。 */
  readonly manualEnvLines?: readonly string[];
}

/** 未配置时提示保留原值；空输入表示“不修改”。 */
const KEEP_HINT = '（留空表示不修改）';

/**
 * `provider` 向导。
 *
 * 只写 `models.json`；`.env` 需要的凭证由用户手动添加。
 */
export async function runProviderWizard(paths: AppPaths, io: WizardIo): Promise<WizardResult> {
  try {
    const modelsFile = await readWithFingerprint(paths.modelsFile);
    if (modelsFile !== undefined && modelsFile.mode !== 0o600) {
      return { ok: false, message: 'models.json 权限不是 0600，请先修复后再运行向导' };
    }

    io.out('配置模型 provider。只写入 models.json；.env 需要你手动编辑。');
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

    // 只提示是否已设置，不读取、不回显、不写入密钥本身。
    const secretPrompt = `输入 ${credentialVar} 的值（仅用于确认你已知晓，不会写入任何文件）`;
    const credential = await io.secret(secretPrompt);
    if (credential.trim() === '') {
      return { ok: false, message: '未输入凭证，已取消，配置未修改' };
    }

    const manualEnvLines = [
      `${credentialVar}=<在此填入你的值>`,
      `MODEL_PROVIDER=${providerId}`,
      `MODEL_ID=${modelId}`,
    ];

    io.out('');
    io.out('将写入 models.json：');
    io.out(`  provider=${providerId}  api=${api}  model=${modelId}`);
    io.out(`  apiKey=$${credentialVar}（仅保存变量引用）`);
    io.out('');
    io.out('请随后手动编辑项目 .env，加入以下三行（程序不会代写）：');
    for (const line of manualEnvLines) {
      io.out(`  ${line}`);
    }

    const approved = await io.approve('确认写入 models.json？');
    if (!approved) {
      return { ok: false, message: '已取消，配置未修改' };
    }

    const document = upsertProvider(parseModelsContent(modelsFile?.content ?? ''), draft);
    await atomicWriteFile(paths.modelsFile, serializeModels(document), modelsFile?.fingerprint ?? '');

    return {
      ok: true,
      message: '已写入 models.json。请按上面的提示手动补全 .env 后运行 doctor。',
      manualEnvLines,
    };
  } catch (error) {
    return { ok: false, message: describeWizardError(error) };
  }
}

/**
 * `jumpserver` 向导。
 *
 * **不写任何文件**：只收集信息并输出可复制的 `.env` 片段。
 * 堡垒机地址与端口由程序内置，不在此录入、也不出现在片段里。
 */
export async function runJumpServerWizard(io: WizardIo): Promise<WizardResult> {
  try {
    io.out('生成堡垒机配置片段。程序不会修改 .env，请自行复制到项目 .env。');
    io.out('堡垒机地址与端口由程序内置，无需填写。');
    io.out('');

    const expectPath = (await io.text('Expect 可执行文件路径')).trim();
    const loginScript = (await io.text('登录脚本绝对路径')).trim();
    const oathTool = (await io.text('oathtool 可执行文件路径')).trim();
    const jumpUser = (await io.text('堡垒机账号')).trim();
    const appGroup = (await io.text('登录后初始账户组')).trim();
    const appUser = (await io.text('目标业务账户')).trim();
    const logDir = (await io.text('远程日志根目录')).trim();
    const targetHost = (await io.text('默认目标机（22.50.x.x 或 10.80.x.x）')).trim();

    const problems: string[] = [];
    if (targetHost !== '') {
      const check = validateTargetHost(targetHost);
      if (!check.ok) {
        problems.push(`目标机不合法：${check.reason ?? ''}`);
      }
    }
    for (const [label, value] of [
      ['登录脚本', loginScript],
      ['Expect 路径', expectPath],
      ['oathtool 路径', oathTool],
    ] as const) {
      if (value !== '' && !value.startsWith('/')) {
        problems.push(`${label}必须是绝对路径`);
      }
    }
    if (problems.length > 0) {
      return { ok: false, message: problems.join('；') };
    }

    const lines: string[] = [];
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['EXPECT_PATH', expectPath],
      ['LOGIN_SCRIPT', loginScript],
      ['OATH_TOOL', oathTool],
      ['JUMP_USER', jumpUser],
      ['APP_GROUP', appGroup],
      ['APP_USER', appUser],
      ['LOG_DIR', logDir],
      ['TARGET_HOST', targetHost],
    ];
    for (const [key, value] of pairs) {
      if (value !== '') {
        lines.push(`${key}=${value}`);
      }
    }
    // 密钥只给占位符：用户自己填写真实值，程序不接触也不记录。
    lines.push('JUMP_PASSWORD=<在此填入你的密码>');
    lines.push('MFA_SECRET=<在此填入你的 MFA 秘钥>');

    io.out('');
    io.out('请将以下内容手动加入项目 .env（已存在的键请自行判断是否覆盖）：');
    io.out('');
    for (const line of lines) {
      io.out(`  ${line}`);
    }
    io.out('');
    io.out('完成后运行 doctor --remote 检查。');

    return {
      ok: true,
      message: '已生成配置片段；本命令未修改任何文件。',
      manualEnvLines: lines,
    };
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
    return `失败：${error.message}`;
  }
  return '失败：未知错误';
}
