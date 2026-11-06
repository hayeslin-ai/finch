/**
 * 初始化配置。
 *
 * 路径分工：
 * - 项目根目录的 `.env`：连接与认证信息，按项目独立；
 * - 用户配置目录的 `models.json`：模型定义，可跨项目复用。
 *
 * 核心原则不变：只创建缺失项，绝不覆盖已有配置——覆盖就意味着凭证丢失。
 *
 * 额外安全义务：`.env` 现在位于业务仓库内，必须提醒用户确认它已被
 * 版本控制忽略，否则凭证会被提交。这里只提示，不擅自修改项目的 .gitignore。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { inspectPath, type AppPaths } from './paths.js';

export interface InitAction {
  readonly target: string;
  readonly action: 'created' | 'kept';
  readonly reason?: string;
}

export interface InitResult {
  readonly actions: readonly InitAction[];
  readonly ok: boolean;
  /** 需要用户处理的提醒；不阻断初始化。 */
  readonly warnings: readonly string[];
}

/** 模板只含字段名与说明，不含任何真实值。 */
const ENV_TEMPLATE = `# Finch 项目配置。该文件不得提交到仓库。
# 解析为字面量 KEY=VALUE，不执行 source、变量展开或命令替换。
# 诊断范围（仓库根与服务标识）由启动目录自动推导，无需在此配置。

EXPECT_PATH=
LOGIN_SCRIPT=
OATH_TOOL=

JUMP_USER=
JUMP_PASSWORD=
MFA_SECRET=
APP_GROUP=
APP_USER=
LOG_DIR=
TARGET_HOST=

MODEL_PROVIDER=
MODEL_ID=
MODEL_API_KEY=
`;

const MODELS_TEMPLATE = `{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {}
}
`;

/**
 * 检查 `.env` 是否被项目的 .gitignore 覆盖。
 *
 * WHY：`.env` 现在放在业务仓库里，一旦被提交，凭证会进入历史且难以彻底清除。
 * 这里只做只读判断并提示，不修改用户的 .gitignore——擅自改别人的版本控制配置
 * 比提示更危险。
 */
async function checkGitIgnored(projectEnv: string): Promise<string | undefined> {
  const directory = path.dirname(projectEnv);
  let ignoreText: string;
  try {
    ignoreText = await readFile(path.join(directory, '.gitignore'), 'utf8');
  } catch {
    // 没有 .gitignore 时同样需要提醒。
    return '项目未发现 .gitignore；请确认 .env 不会进入版本控制';
  }

  const patterns = ignoreText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  const covered = patterns.some((pattern) => {
    const normalized = pattern.replace(/^\//, '').replace(/\/$/, '');
    return normalized === '.env' || normalized === '*' || normalized === '.env*' || normalized === '.*';
  });

  return covered ? undefined : '项目的 .gitignore 未忽略 .env；请自行添加，避免凭证被提交';
}

/**
 * 创建缺失的目录与模板。
 *
 * 已存在的文件不会被改写；权限不正确时只报告，不自动放宽或收紧，
 * 因为静默改权限可能破坏用户既有的备份或同步策略。
 */
export async function initAppDirectories(paths: AppPaths): Promise<InitResult> {
  const actions: InitAction[] = [];
  const warnings: string[] = [];
  let ok = true;

  const dirCheck = inspectPath(paths.configDir, 'directory');
  if (!dirCheck.exists) {
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await chmod(paths.configDir, 0o700);
    actions.push({ target: paths.configDir, action: 'created' });
  } else if (dirCheck.unsafe) {
    ok = false;
    actions.push({ target: paths.configDir, action: 'kept', reason: dirCheck.reason ?? '目录不安全' });
  } else {
    actions.push({ target: paths.configDir, action: 'kept', reason: '已存在' });
  }

  const files: ReadonlyArray<readonly [string, string]> = [
    [paths.modelsFile, MODELS_TEMPLATE],
    [paths.envFile, ENV_TEMPLATE],
  ];

  for (const [target, content] of files) {
    const check = inspectPath(target, 'file');
    if (check.exists) {
      actions.push({
        target,
        action: 'kept',
        reason: check.unsafe ? (check.reason ?? '文件不安全') : '已存在，未覆盖',
      });
      if (check.unsafe) {
        ok = false;
      }
      continue;
    }

    // 先以 0600 创建，再写入内容，避免短暂的宽权限窗口。
    await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    await chmod(target, 0o600);
    actions.push({ target, action: 'created' });
  }

  const ignoreWarning = await checkGitIgnored(paths.envFile);
  if (ignoreWarning !== undefined) {
    warnings.push(ignoreWarning);
  }

  return { actions, ok, warnings };
}
