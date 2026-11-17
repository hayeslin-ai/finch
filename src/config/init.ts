/**
 * 初始化配置。
 *
 * 全部配置位于用户目录，跨项目共享：
 * - `.env`：堡垒机连接与认证；
 * - `models.json`：模型定义；只有一个候选时自动采用。
 *
 * 核心原则：
 * - 只创建缺失项，绝不覆盖已有配置——覆盖就意味着凭证丢失；
 * - 模板内容以包内 `templates/` 为唯一事实来源，运行时直接读取复制。
 *
 * WHY 读取文件而不是内联字符串：内联副本曾与 `templates/` 漂移
 * （`.env` 缺 `JUMP_HOST`/`JUMP_PORT`、`models.json` 少了示例 provider），
 * 用户看到的两份“模板”互相矛盾。复制同一份文件可以从根本上消除分叉。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';

import { fileURLToPath } from 'node:url';

import { inspectPath, type AppPaths } from './paths.js';

/** 打包模板位置：dist/src/config → 包根目录的 templates/。 */
const ENV_TEMPLATE_URL = new URL('../../../templates/env.example', import.meta.url);
const MODELS_TEMPLATE_URL = new URL('../../../templates/models.example.json', import.meta.url);

export interface InitAction {
  readonly target: string;
  readonly action: 'created' | 'kept';
  readonly reason?: string;
}

export interface InitResult {
  readonly actions: readonly InitAction[];
  readonly ok: boolean;
}

/**
 * 读取模板内容；失败返回错误说明而不是抛出。
 *
 * 模板随 npm 包分发；缺失说明发布产物不完整，必须明确报错而不是
 * 静默生成空文件——空配置会让用户以为 init 成功，却在 doctor 阶段才暴露。
 */
async function readTemplate(url: URL): Promise<{ content: string } | { error: string }> {
  try {
    return { content: await readFile(url, 'utf8') };
  } catch {
    return { error: `模板文件缺失：${fileURLToPath(url)}` };
  }
}

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

  const files: ReadonlyArray<readonly [string, URL]> = [
    [paths.modelsFile, MODELS_TEMPLATE_URL],
    [paths.envFile, ENV_TEMPLATE_URL],
  ];

  for (const [target, templateUrl] of files) {
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

    // 只在真正要落盘时才读模板，用户已配置的环境不产生多余 IO。
    const template = await readTemplate(templateUrl);
    if ('error' in template) {
      ok = false;
      actions.push({ target, action: 'kept', reason: template.error });
      continue;
    }

    // 先以 0600 创建，再写入内容，避免短暂的宽权限窗口。
    await writeFile(target, template.content, { mode: 0o600, flag: 'wx' });
    await chmod(target, 0o600);
    actions.push({ target, action: 'created' });
  }

  return { actions, ok };
}
