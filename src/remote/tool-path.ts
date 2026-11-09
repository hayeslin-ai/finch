/**
 * 外部可执行文件解析。
 *
 * WHY：Expect 与 oathtool 由系统环境提供，用户不需要为了“能用”去手写绝对路径。
 * 默认从 PATH 查找；显式环境变量只作为覆盖手段。
 *
 * 安全约束：
 * - 显式路径必须是绝对路径且可执行，校验失败直接报错，绝不静默回退到 PATH
 *   换一个程序执行——那会让“我指定了 A，实际跑了 B”变成不可审计的行为。
 * - PATH 中的相对目录（含空项）跳过：空项等价于当前目录，可能被业务仓库内的
 *   同名文件劫持。
 * - stat 跟随符号链接：Homebrew 的 bin 条目本身就是符号链接，拒绝链接会让
 *   官方安装方式无法使用。
 */
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/** 可执行文件的来源；用于 doctor 如实标注“从哪找到的”。 */
export type ToolSource = 'env' | 'path';

export interface ExecutableResolution {
  readonly path?: string;
  readonly source?: ToolSource;
  /** 显式环境变量无效时的原因；未设置或解析成功时为空。 */
  readonly error?: string;
}

/** 判断目标是否为当前用户可执行普通文件；任何异常都视为不可用。 */
function isExecutableFile(target: string): boolean {
  try {
    if (!statSync(target).isFile()) {
      return false;
    }
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一个外部程序。
 *
 * 顺序：显式环境变量 > PATH。返回结构而不是抛异常，便于 doctor 汇总全部问题。
 */
export function resolveExecutable(
  command: string,
  envKey: string,
  env: Readonly<Record<string, string | undefined>>,
): ExecutableResolution {
  const explicit = (env[envKey] ?? '').trim();
  if (explicit !== '') {
    if (!path.isAbsolute(explicit)) {
      return { error: `${envKey} 必须是绝对路径` };
    }
    if (!isExecutableFile(explicit)) {
      return { error: `${envKey} 指向的文件不存在或不可执行` };
    }
    return { path: explicit, source: 'env' };
  }

  const searchPath = env['PATH'] ?? '';
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory === '' || !path.isAbsolute(directory)) {
      continue;
    }
    const candidate = path.join(directory, command);
    if (isExecutableFile(candidate)) {
      return { path: candidate, source: 'path' };
    }
  }

  return {};
}
