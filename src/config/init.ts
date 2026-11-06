/**
 * 初始化用户配置目录。
 *
 * WHY：用户第一次使用时需要一个 0700 目录与 0600 模板，
 * 但绝不能被已有配置覆盖——覆盖就意味着凭证丢失。
 * 因此这里只创建缺失项，已存在的一律保持原样并明确报告。
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';

import { inspectPath, type AppPaths } from './paths.js';

export interface InitAction {
  readonly target: string;
  readonly action: 'created' | 'kept';
  readonly reason?: string;
}

export interface InitResult {
  readonly actions: readonly InitAction[];
  readonly ok: boolean;
}

/** 模板只含字段名与说明，不含任何真实值。 */
const ENV_TEMPLATE = `# Finch 本地配置。该文件不得提交到仓库。
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
 * 创建缺失的目录与模板。
 *
 * 已存在的目录或文件不会被改写；权限不正确时只报告，不自动放宽或收紧，
 * 因为静默改权限可能破坏用户既有的备份或同步策略。
 */
export async function initAppDirectories(paths: AppPaths): Promise<InitResult> {
  const actions: InitAction[] = [];
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
    [paths.envFile, ENV_TEMPLATE],
    [paths.modelsFile, MODELS_TEMPLATE],
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
    // mkdir 已确保父目录存在；这里显式指定 mode。
    await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    await chmod(target, 0o600);
    actions.push({ target, action: 'created' });
  }

  return { actions, ok };
}
