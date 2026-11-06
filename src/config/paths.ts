/**
 * 应用目录定位与权限边界。
 *
 * 路径分工（已确认，最终版）：
 * - 全部配置集中在用户目录，跨项目共享，不随项目变化：
 *   `.env`（连接与认证）、`models.json`（模型定义）、`settings.json`（当前选择）、
 *   以及可选的脱敏规则；
 * - 会话与知识同样按用户隔离。
 *
 * 之所以不放在项目目录：连接信息与模型属于个人环境，放进业务仓库
 * 既容易被提交，也会导致同一份凭证在多个仓库重复维护。
 */
import { lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 应用目录的三种角色，分别对应配置、可变状态与长期数据。 */
export interface AppPaths {
  /** 配置根目录，期望 0700。 */
  readonly configDir: string;
  /** 连接与认证配置。 */
  readonly envFile: string;
  /** Pi 原生模型定义；凭证只以变量引用或字面量形式出现在这里。 */
  readonly modelsFile: string;
  /** 运行期选择：当前 provider/模型与最近使用的目标机。 */
  readonly settingsFile: string;
  /** 可选团队脱敏规则文件。 */
  readonly redactionRulesFile: string;
  /** 会话与快照根目录，期望 0700。 */
  readonly stateDir: string;
  /** 知识库根目录，期望 0700。 */
  readonly dataDir: string;
}

/** 目录与文件的期望权限；只做检查，不自动修改善权限。 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 单个路径的检查结果；不抛异常，便于 doctor 汇总全部问题。 */
export interface PathCheck {
  readonly path: string;
  readonly exists: boolean;
  readonly kind: 'missing' | 'directory' | 'file' | 'symlink' | 'other';
  readonly mode?: number;
  /** 权限过宽、属主不符或为符号链接时为 true。 */
  readonly unsafe: boolean;
  readonly reason?: string;
}

/**
 * 解析应用路径。
 *
 * homeOverride 仅供测试注入临时目录；生产调用不传，使用真实 home，
 * 因此测试永远不触碰真实用户配置。
 */
export function resolveAppPaths(homeOverride?: string): AppPaths {
  const home = homeOverride ?? homedir();
  const configDir = path.join(home, '.config', 'finch');
  const stateDir = path.join(home, '.local', 'state', 'finch');
  const dataDir = path.join(home, '.local', 'share', 'finch');

  return {
    configDir,
    envFile: path.join(configDir, '.env'),
    modelsFile: path.join(configDir, 'models.json'),
    settingsFile: path.join(configDir, 'settings.json'),
    redactionRulesFile: path.join(configDir, 'redaction.rules.json'),
    stateDir,
    dataDir,
  };
}

/** 判断权限位是否比期望更宽松；只检查组与其他用户的位。 */
function isTooPermissive(mode: number, expected: number): boolean {
  return (mode & 0o077) !== (expected & 0o077);
}

/**
 * 检查单个路径是否符合角色要求。
 *
 * WHY：符号链接可能把配置指向仓库或共享目录，从而绕过“固定目录”的假设；
 * 因此符号链接一律视为不安全，由调用方决定拒绝还是提示修复。
 */
export function inspectPath(target: string, expected: 'directory' | 'file'): PathCheck {
  let linkStat;
  try {
    linkStat = lstatSync(target);
  } catch {
    return { path: target, exists: false, kind: 'missing', unsafe: false };
  }

  if (linkStat.isSymbolicLink()) {
    return {
      path: target,
      exists: true,
      kind: 'symlink',
      mode: linkStat.mode & 0o777,
      unsafe: true,
      reason: '路径是符号链接，可能指向配置目录之外',
    };
  }

  const stats = statSync(target);
  const mode = stats.mode & 0o777;
  const expectedMode = expected === 'directory' ? DIR_MODE : FILE_MODE;
  const actualKind: PathCheck['kind'] = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : 'other';

  if (actualKind !== expected) {
    return {
      path: target,
      exists: true,
      kind: actualKind,
      mode,
      unsafe: true,
      reason: `期望${expected === 'directory' ? '目录' : '普通文件'}，实际为 ${actualKind}`,
    };
  }

  // 属主必须是当前用户；其他人的配置文件不应被信任。
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    return {
      path: target,
      exists: true,
      kind: actualKind,
      mode,
      unsafe: true,
      reason: '文件属主不是当前用户',
    };
  }

  if (isTooPermissive(mode, expectedMode)) {
    return {
      path: target,
      exists: true,
      kind: actualKind,
      mode,
      unsafe: true,
      reason: `权限 ${mode.toString(8)} 比期望 ${expectedMode.toString(8)} 宽松`,
    };
  }

  return { path: target, exists: true, kind: actualKind, mode, unsafe: false };
}
