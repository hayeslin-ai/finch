/**
 * 登录桥接脚本的自动生成。
 *
 * WHY：脚本是随 npm 包分发的程序资产，不是用户配置。
 * 让用户手工放置并设置 LOGIN_SCRIPT，既容易写错路径，也会让脚本版本与协议版本脱节。
 * 因此固定生成到配置目录，内容以打包资产为准；包升级后再次运行时自动同步。
 *
 * 安全约束：
 * - 目标为符号链接或非普通文件时拒绝写入，避免把可执行脚本写到配置目录之外；
 * - 文件以 0600 创建并原子替换，不允许其他用户读取或中途看到半成品；
 * - 不把任何凭证写进脚本：认证材料始终由运行时环境注入。
 */
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises';

import { atomicWriteFile, readWithFingerprint } from '../config/atomic-write.js';
import { inspectPath, type AppPaths } from '../config/paths.js';

/** 打包资产位置：dist/src/remote → 包根目录的 assets/。 */
const ASSET_URL = new URL('../../../assets/login_agent.exp', import.meta.url);

/** 自动生成标记，提醒用户该文件由程序管理。 */
const MANAGED_HEADER = '# 本文件由 finch 自动生成并随版本同步；请勿手工修改。';

export type LoginScriptStatus = 'created' | 'updated' | 'kept' | 'unsafe' | 'error';

export interface LoginScriptResult {
  readonly ok: boolean;
  /** 目标路径；失败时也返回，便于报告具体位置。 */
  readonly path: string;
  readonly status: LoginScriptStatus;
  readonly reason?: string;
}

/** 在 shebang 之后插入管理标记；expect 以 # 识别注释。 */
function withManagedHeader(content: string): string {
  const lines = content.split('\n');
  if (lines[0]?.startsWith('#!')) {
    return [lines[0], MANAGED_HEADER, ...lines.slice(1)].join('\n');
  }
  return `${MANAGED_HEADER}\n${content}`;
}

/** 目标必须是普通文件；不存在、符号链接或其他类型分别处理。 */
async function inspectTarget(target: string): Promise<'missing' | 'file' | 'unsafe'> {
  try {
    const entry = await lstat(target);
    return entry.isFile() ? 'file' : 'unsafe';
  } catch {
    return 'missing';
  }
}

/**
 * 确保登录脚本存在且与当前版本一致。
 *
 * 只写程序管理的脚本文件，不触碰 `.env`、`models.json` 等用户配置。
 */
export async function ensureLoginScript(paths: AppPaths): Promise<LoginScriptResult> {
  const target = paths.loginScriptFile;

  const dirCheck = inspectPath(paths.configDir, 'directory');
  if (!dirCheck.exists) {
    // 首次使用且未运行 init 时，doctor --remote 也应能自愈；
    // 目录权限从一开始就收紧，避免凭证文件出现宽权限窗口。
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  } else if (dirCheck.unsafe) {
    return {
      ok: false,
      path: target,
      status: 'unsafe',
      reason: dirCheck.reason ?? '配置目录不安全',
    };
  }

  const kind = await inspectTarget(target);
  if (kind === 'unsafe') {
    return {
      ok: false,
      path: target,
      status: 'unsafe',
      reason: '登录脚本路径不是普通文件（可能是符号链接或目录），拒绝写入',
    };
  }

  let content: string;
  try {
    content = withManagedHeader(await readFile(ASSET_URL, 'utf8'));
  } catch {
    // 安装包缺少资产说明发布产物不完整，必须明确报错而不是静默跳过。
    return {
      ok: false,
      path: target,
      status: 'error',
      reason: '安装包缺少登录脚本资产，请重新安装',
    };
  }

  const existing = kind === 'file' ? await readWithFingerprint(target) : undefined;
  const contentSame = existing?.content === content;

  // 内容已一致且权限正确时不写盘，避免每次 doctor 都产生无谓修改。
  if (contentSame && existing.mode === 0o600) {
    return { ok: true, path: target, status: 'kept' };
  }

  try {
    await atomicWriteFile(target, content, existing?.fingerprint ?? '');
    await chmod(target, 0o600);
  } catch {
    return {
      ok: false,
      path: target,
      status: 'error',
      reason: '写入登录脚本失败，请检查配置目录权限',
    };
  }

  return {
    ok: true,
    path: target,
    status: existing === undefined ? 'created' : 'updated',
    ...(contentSame && existing !== undefined ? { reason: '已收紧文件权限' } : {}),
  };
}
