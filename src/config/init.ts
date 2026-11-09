/**
 * 初始化配置。
 *
 * 全部配置位于用户目录，跨项目共享：
 * - `.env`：堡垒机连接与认证；
 * - `models.json`：模型定义；只有一个候选时自动采用。
 *
 * 核心原则：只创建缺失项，绝不覆盖已有配置——覆盖就意味着凭证丢失。
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
/**
 * `.env` 模板。
 *
 * 只保留必须由用户填写的连接信息：
 * - 账号与认证；
 * - 登录后的账户与日志目录，已给出该环境的常用默认值。
 *
 * 不再包含：模型配置（在 models.json）、工具路径（在环境变量）、
 * 目标机（由 /trace 决定）。
 */
const ENV_TEMPLATE = `# Finch 连接配置（用户级，跨项目共享）。
# 该文件不得提交到仓库，且只能由你手动编辑。
# 解析为字面量 KEY=VALUE，不执行 source、变量展开或命令替换。

JUMP_USER=
JUMP_PASSWORD=
MFA_SECRET=

# 以下为固定环境默认值，按需修改。
APP_GROUP=appgroup
APP_USER=app
LOG_DIR=~/sxpservice/logs/

# 外部程序默认从 PATH 查找；如需覆盖，可在 shell 中设置：
#   EXPECT_PATH / OATH_TOOL
# 登录脚本由 finch 自动生成，无需指定 LOGIN_SCRIPT。
`;

const MODELS_TEMPLATE = `{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {}
}
`;

/**
 * 创建缺失的目录与模板。
 *
 * 已存在的文件不会被改写；权限不正确时只报告，不自动放宽或收紧，
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

  return { actions, ok };
}
