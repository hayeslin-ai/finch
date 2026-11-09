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
import { validateBastionHost, validateTargetHost } from '../config/target.js';
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
    io.out('凭证不需要写入 .env：可在 models.json 中直接填写字面量，');
    io.out('或把该变量放进启动进程的环境变量。');
    io.out('');
    io.out('注意：只有一个模型时会自动使用；有多个模型时需用 --model 指定，');
    io.out('或启动后用 /model 切换。');

    const approved = await io.approve('确认写入 models.json？');
    if (!approved) {
      return { ok: false, message: '已取消，配置未修改' };
    }

    const document = upsertProvider(parseModelsContent(modelsFile?.content ?? ''), draft);
    await atomicWriteFile(paths.modelsFile, serializeModels(document), modelsFile?.fingerprint ?? '');

    return {
      ok: true,
      message: '已写入 models.json。运行 doctor 检查配置完整性。',
    };
  } catch (error) {
    return { ok: false, message: describeWizardError(error) };
  }
}

/**
 * `jumpserver` 向导。
 *
 * **不写任何文件**：只收集信息并输出可复制的 `.env` 片段。
 * 堡垒机地址与端口属于使用者所在环境的事实，仓库与安装包公开，
 * 因此不在代码中内置，也不随包分发，由用户填写。
 */
export async function runJumpServerWizard(io: WizardIo): Promise<WizardResult> {
  try {
    io.out('生成堡垒机连接片段。程序不会修改 .env，请自行复制。');
    io.out('堡垒机地址与端口请按所在环境填写；工具路径来自环境变量。');
    io.out('');

    const jumpHost = (await io.text('堡垒机地址（IPv4）')).trim();
    const jumpPortRaw = (await io.text('堡垒机 SSH 端口（默认 22）')).trim();
    const jumpPort = jumpPortRaw === '' ? '22' : jumpPortRaw;
    const hostCheck = validateBastionHost(jumpHost);
    if (!hostCheck.ok) {
      return { ok: false, message: `堡垒机地址不合法：${hostCheck.reason ?? '必须是 IPv4 字面量'}` };
    }
    if (!/^[1-9]\d{0,4}$/.test(jumpPort) || Number(jumpPort) > 65535) {
      return { ok: false, message: '堡垒机端口必须是 1 到 65535 的十进制整数' };
    }

    const jumpUser = (await io.text('堡垒机账号')).trim();
    const appGroup = (await io.text('登录后初始账户组（默认 appgroup）')).trim() || 'appgroup';
    const appUser = (await io.text('目标业务账户（默认 app）')).trim() || 'app';
    const logDir = (await io.text('远程日志根目录（默认 ~/sxpservice/logs/）')).trim() || '~/sxpservice/logs/';

    if (jumpUser === '') {
      return { ok: false, message: '堡垒机账号不能为空' };
    }

    const lines: string[] = [
      `JUMP_HOST=${jumpHost}`,
      `JUMP_PORT=${jumpPort}`,
      `JUMP_USER=${jumpUser}`,
      'JUMP_PASSWORD=<在此填入你的密码>',
      'MFA_SECRET=<在此填入你的 MFA 秘钥>',
      '',
      `APP_GROUP=${appGroup}`,
      `APP_USER=${appUser}`,
      `LOG_DIR=${logDir}`,
    ];

    io.out('');
    io.out('请将以下内容手动加入 .env（已存在的键请自行判断是否覆盖）：');
    io.out('');
    for (const line of lines) {
      io.out(`  ${line}`);
    }
    io.out('');
    io.out('外部程序默认从 PATH 查找；如需覆盖，可在 shell 中设置：');
    io.out('  EXPECT_PATH / OATH_TOOL');
    io.out('登录脚本由 finch 自动生成，无需指定 LOGIN_SCRIPT。');
    io.out('完成后运行 doctor --remote 检查。');

    return {
      ok: true,
      message: '已生成连接片段；本命令未修改任何文件。',
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
