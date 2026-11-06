/**
 * `models.json` 的增量更新。
 *
 * WHY：模型文件可能有多个 provider 与用户自定义字段。
 * 向导只应修改目标 provider 与当前选择，其余内容必须原样保留。
 * 因此这里按对象合并，而不是整文件替换；未知字段不删除。
 *
 * 凭证不进本文件：API Key 只写 `.env`，此处只保存 `$变量引用`。
 */

/** 单个 provider 的非敏感字段。 */
export interface ProviderDraft {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly api: string;
  readonly modelId: string;
  readonly modelName: string;
  /** 凭证变量名，例如 MODEL_API_KEY；写入为 `$NAME`。 */
  readonly credentialVar: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface ModelsDocument {
  providers: Record<string, unknown>;
  [key: string]: unknown;
}

/** 解析现有模型文件；空内容视为新文档。 */
export function parseModelsContent(content: string): ModelsDocument {
  if (content.trim() === '') {
    return { providers: {} };
  }
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('models.json 顶层必须是对象');
  }
  const document = parsed as ModelsDocument;
  if (typeof document.providers !== 'object' || document.providers === null) {
    document.providers = {};
  }
  return document;
}

/**
 * 合并 provider 配置。
 *
 * 只覆盖本向导负责的字段；同 provider 下用户自定义的其他字段与
 * 其他模型条目保持不动。
 */
export function upsertProvider(document: ModelsDocument, draft: ProviderDraft): ModelsDocument {
  const existing = document.providers[draft.providerId];
  const provider =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  const models = Array.isArray(provider['models']) ? [...(provider['models'] as unknown[])] : [];
  const modelEntry: Record<string, unknown> = {
    id: draft.modelId,
    name: draft.modelName,
  };
  if (draft.contextWindow !== undefined) {
    modelEntry['contextWindow'] = draft.contextWindow;
  }
  if (draft.maxTokens !== undefined) {
    modelEntry['maxTokens'] = draft.maxTokens;
  }

  const modelIndex = models.findIndex(
    (item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === draft.modelId,
  );
  if (modelIndex >= 0) {
    // 已存在同一模型：合并字段，保留用户额外配置。
    const current = models[modelIndex] as Record<string, unknown>;
    models[modelIndex] = { ...current, ...modelEntry };
  } else {
    models.push(modelEntry);
  }

  const nextProvider: Record<string, unknown> = {
    ...provider,
    baseUrl: draft.baseUrl,
    api: draft.api,
    // 只存变量引用，绝不写真实密钥。
    apiKey: `$${draft.credentialVar}`,
    models,
  };

  return {
    ...document,
    providers: { ...document.providers, [draft.providerId]: nextProvider },
  };
}

/** 序列化为带缩进的稳定文本；末尾保留换行便于版本控制。 */
export function serializeModels(document: ModelsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** 校验 provider 与模型标识等基本格式，避免写入明显错误的结构。 */
export function validateProviderDraft(draft: ProviderDraft): readonly string[] {
  const problems: string[] = [];
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(draft.providerId)) {
    problems.push('provider 名称只能包含字母、数字、点、下划线与连字符');
  }
  if (!/^https?:\/\/\S+$/.test(draft.baseUrl)) {
    problems.push('baseUrl 必须是 http(s) 地址');
  }
  if (draft.api.trim() === '') {
    problems.push('api 协议不能为空');
  }
  if (draft.modelId.trim() === '') {
    problems.push('模型 ID 不能为空');
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.credentialVar)) {
    problems.push('凭证变量名必须以字母或下划线开头');
  }
  for (const [label, value] of [
    ['contextWindow', draft.contextWindow],
    ['maxTokens', draft.maxTokens],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      problems.push(`${label} 必须是正整数`);
    }
  }
  return problems;
}
