/**
 * 当前模型选择。
 *
 * 设计（已确认，不再使用 settings.json）：
 * - `models.json` 是唯一来源；
 * - 只有一个候选时直接采用，并在状态中显示，不需要额外配置；
 * - 有多个候选时必须显式指定 `--model <provider>/<model>`，
 *   **绝不静默挑第一个**：选错模型会改变上下文长度与推理能力，
 *   而这种错误很难被用户察觉。
 */
import { readFile } from 'node:fs/promises';

import type { AppPaths } from './paths.js';

export interface ModelCandidate {
  readonly provider: string;
  readonly modelId: string;
}

export type ModelSelection =
  | { readonly ok: true; readonly selected: ModelCandidate; readonly autoSelected: boolean }
  | { readonly ok: false; readonly reason: string; readonly candidates: readonly ModelCandidate[] };

/** 读取 models.json 中的全部候选；文件缺失或格式错误时返回空列表。 */
export async function listModelCandidates(paths: AppPaths): Promise<readonly ModelCandidate[]> {
  try {
    const raw = await readFile(paths.modelsFile, 'utf8');
    const document = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: unknown }> }>;
    };

    const candidates: ModelCandidate[] = [];
    for (const [provider, config] of Object.entries(document.providers ?? {})) {
      for (const model of config.models ?? []) {
        if (typeof model.id === 'string' && model.id !== '') {
          candidates.push({ provider, modelId: model.id });
        }
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * 解析 `--model` 参数。
 *
 * 格式为 `<provider>/<modelId>`；由于模型 ID 本身可能含斜杠
 * （例如 `group/md-default`），只按**第一个**斜杠切分。
 */
export function parseModelFlag(value: string): ModelCandidate | { error: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return { error: '模型格式应为 <provider>/<modelId>，例如 Magpie/group/md-default' };
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

/**
 * 解析当前模型。
 *
 * 优先级：显式参数 > 唯一候选。
 * 显式参数不存在于 models.json 时报错，而不是回退到唯一候选——
 * 用户明确写下的选择被替换，会让人以为用的是自己指定的模型。
 */
export async function resolveModelSelection(
  paths: AppPaths,
  requested?: string,
): Promise<ModelSelection> {
  const candidates = await listModelCandidates(paths);

  if (requested !== undefined && requested.trim() !== '') {
    const parsed = parseModelFlag(requested.trim());
    if ('error' in parsed) {
      return { ok: false, reason: parsed.error, candidates };
    }
    const exists = candidates.some(
      (item) => item.provider === parsed.provider && item.modelId === parsed.modelId,
    );
    if (!exists) {
      return {
        ok: false,
        reason: `models.json 中不存在该模型：${parsed.provider}/${parsed.modelId}`,
        candidates,
      };
    }
    return { ok: true, selected: parsed, autoSelected: false };
  }

  if (candidates.length === 1) {
    return { ok: true, selected: candidates[0] as ModelCandidate, autoSelected: true };
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'models.json 中没有可用模型；请先运行 finch provider 配置',
      candidates,
    };
  }

  return {
    ok: false,
    reason: `models.json 中有 ${candidates.length} 个模型，请用 --model 指定其中一个`,
    candidates,
  };
}
