/**
 * 运行期设置。
 *
 * WHY 独立于 `models.json`：模型定义描述“有哪些 provider 和模型”，
 * 而“当前用哪一个”“最近连过哪些机器”属于运行选择。
 * 混在一起会让模型文件在每次切换时被改写，也更容易误把密钥写进去。
 *
 * 本文件不含任何凭证。
 */
import { readFile } from 'node:fs/promises';

import { atomicWriteFile, readWithFingerprint } from './atomic-write.js';
import type { AppPaths } from './paths.js';

/** 记住的最近目标机数量上限；仅用于提示，不是授权。 */
export const MAX_RECENT_TARGETS = 5;

export interface AppSettings {
  /** 当前使用的 provider 名；必须存在于 models.json。 */
  modelProvider?: string;
  /** 当前模型 ID；必须存在于该 provider 下。 */
  modelId?: string;
  /** 最近成功连接过的目标机，最新的在前。 */
  recentTargets?: readonly string[];
  /** 设置文件版本；主版本变化时拒绝读取。 */
  schemaVersion?: number;
}

export const SETTINGS_SCHEMA_VERSION = 1;

/** 读取设置；文件不存在时返回空设置，不报错。 */
export async function loadSettings(paths: AppPaths): Promise<AppSettings> {
  try {
    const raw = await readFile(paths.settingsFile, 'utf8');
    const parsed = JSON.parse(raw) as AppSettings;
    if (typeof parsed !== 'object' || parsed === null) {
      return {};
    }
    if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      // 主版本不兼容时按空设置处理，并由调用方提示用户重新选择模型。
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * 记录一次成功连接的目标机。
 *
 * 只保留最近若干个，最新的排在最前；重复项会被前移而不是重复出现。
 * 这不是授权缓存——连接时仍需用户确认。
 */
export async function rememberTarget(paths: AppPaths, target: string): Promise<void> {
  const current = await loadSettings(paths);
  const existing = current.recentTargets ?? [];
  const recentTargets = [target, ...existing.filter((item) => item !== target)].slice(
    0,
    MAX_RECENT_TARGETS,
  );

  const file = await readWithFingerprint(paths.settingsFile);
  const next: AppSettings = {
    ...current,
    recentTargets,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await atomicWriteFile(
    paths.settingsFile,
    `${JSON.stringify(next, null, 2)}\n`,
    file?.fingerprint ?? '',
  );
}

/** 更新当前模型选择；provider 与模型必须同时给出。 */
export async function setCurrentModel(
  paths: AppPaths,
  modelProvider: string,
  modelId: string,
): Promise<void> {
  const current = await loadSettings(paths);
  const file = await readWithFingerprint(paths.settingsFile);
  const next: AppSettings = {
    ...current,
    modelProvider,
    modelId,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  await atomicWriteFile(
    paths.settingsFile,
    `${JSON.stringify(next, null, 2)}\n`,
    file?.fingerprint ?? '',
  );
}
