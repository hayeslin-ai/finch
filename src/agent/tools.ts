/**
 * 模型可见工具。
 *
 * WHY：模型只能提出“查什么”，不能提出“怎么查”。
 * 因此每个工具都只用受限参数，并在宿主侧完成路径校验、范围限制与预算扣减。
 * 工具返回内容先脱敏、再登记为证据，最后才交给模型。
 *
 * 这里不导入任何未审核的 SDK 内置工具；`tools` 白名单在会话创建时显式给出。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { EvidenceStore } from '../core/evidence.js';
import { readSourceRange, searchRepository, type RepositoryHandle } from '../repository/read.js';
import { searchLocalLog, type AttachmentHandle, readLocalRange } from '../logs/local.js';
import type { Redactor } from '../security/redactor.js';

/** 工具执行上下文；所有能力都由宿主注入，模型无法自行构造。 */
export interface ToolContext {
  readonly repository: RepositoryHandle;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  /** 附件句柄表；模型只能引用编号，不能提交路径。 */
  readonly attachments: ReadonlyMap<string, AttachmentHandle>;
  /** 剩余预算检查；为 false 时工具直接拒绝执行。 */
  readonly canWork: () => boolean;
}

/** 统一的工具结果：文本内容 + 可选详情。内容已脱敏。 */
interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

/**
 * 创建只读工具集。
 *
 * 返回的数组直接交给 createAgentSession 的 customTools；
 * 名称与 SDK 内置工具不冲突，且不会注册任何写操作。
 */
export function createReadOnlyTools(context: ToolContext) {
  const sourceSearch = defineTool({
    name: 'source_search',
    label: '搜索源码',
    description: '在当前本地仓库中按字面量搜索代码，返回文件路径与行号。用于定位异常类、方法或日志文案对应的源码位置。',
    parameters: Type.Object({
      terms: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4 }),
      subPath: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      if (!context.canWork()) {
        return failure('探查预算已用尽，无法继续检索');
      }

      const result = await searchRepository(context.repository, params.terms, {
        ...(params.subPath === undefined ? {} : { subPath: params.subPath }),
        limits: { maxFiles: 2_000, maxScanBytes: 64 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxHits: 50 },
      });

      if (!result.ok) {
        return failure(result.reason ?? '搜索失败');
      }
      if (result.hits.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到匹配；已扫描 ${result.filesScanned} 个文件${result.truncated ? '（扫描被上限截断）' : ''}。` }],
          details: { filesScanned: result.filesScanned, truncated: result.truncated },
        };
      }

      const lines = result.hits.map((hit) => `${hit.relativePath}:${hit.line}: ${hit.text}`);
      const text = context.redactor.redact(lines.join('\n'));
      const evidence = context.evidence.add({
        sourceKind: 'source',
        sourceLabel: '仓库检索',
        text,
        truncated: result.truncated ? 'partial-scan' : 'none',
      });

      return {
        content: [
          {
            type: 'text',
            text: `命中 ${result.hits.length} 条（扫描 ${result.filesScanned} 个文件${result.truncated ? '，结果被上限截断' : ''}）。证据编号 ${evidence.id}：\n${text}`,
          },
        ],
        details: { evidenceId: evidence.id, truncated: result.truncated },
      };
    },
  });

  const sourceRead = defineTool({
    name: 'source_read',
    label: '读取源码片段',
    description: '读取当前仓库中指定文件的指定行范围。路径必须来自 source_search 的结果。',
    parameters: Type.Object({
      relativePath: Type.String({ minLength: 1, maxLength: 1_000 }),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 1 }),
    }),
    async execute(_id, params): Promise<ToolResult> {
      if (!context.canWork()) {
        return failure('探查预算已用尽，无法继续读取');
      }

      // 单次读取上限 400 行，避免一次拉入过多上下文。
      if (params.endLine - params.startLine > 400) {
        return failure('单次读取不得超过 400 行，请缩小范围');
      }

      const result = await readSourceRange(context.repository, params.relativePath, params.startLine, params.endLine);
      if (!result.ok) {
        return failure(result.reason ?? '读取失败');
      }

      const numbered = result.lines.map((line, index) => `${params.startLine + index}: ${line}`);
      const text = context.redactor.redact(numbered.join('\n'));
      const evidence = context.evidence.add({
        sourceKind: 'source',
        sourceLabel: params.relativePath,
        text,
        location: { file: params.relativePath, startLine: params.startLine, endLine: params.endLine },
      });

      return {
        content: [{ type: 'text', text: `证据编号 ${evidence.id}（${params.relativePath}:${params.startLine}-${params.endLine}）：\n${text}` }],
        details: { evidenceId: evidence.id },
      };
    },
  });

  const localSearch = defineTool({
    name: 'local_log_search',
    label: '搜索本地日志',
    description: '在用户显式提供的本地日志附件中按字面量搜索，返回行号。只能使用已授权的附件编号。',
    parameters: Type.Object({
      attachmentId: Type.String({ minLength: 1, maxLength: 64 }),
      terms: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4 }),
    }),
    async execute(_id, params): Promise<ToolResult> {
      if (!context.canWork()) {
        return failure('探查预算已用尽，无法继续检索');
      }

      const handle = context.attachments.get(params.attachmentId);
      if (handle === undefined) {
        return failure('未知的附件编号；只能使用已授权的附件');
      }

      const result = await searchLocalLog(handle, params.terms, { maxHits: 200, maxScanBytes: 256 * 1024 * 1024 });
      if (!result.ok) {
        return failure('搜索失败，可能是文件不可读或压缩格式无效');
      }
      if (result.hits.length === 0) {
        return {
          content: [{ type: 'text', text: `未命中${result.truncated ? '（扫描被上限截断）' : ''}。` }],
          details: { truncated: result.truncated },
        };
      }

      const text = context.redactor.redact(result.hits.map((hit) => `第 ${hit.line} 行：命中 ${hit.term}`).join('\n'));
      const evidence = context.evidence.add({
        sourceKind: 'local-file',
        sourceLabel: handle.path,
        text,
        truncated: result.truncated ? 'partial-scan' : 'none',
      });

      return {
        content: [{ type: 'text', text: `命中 ${result.hits.length} 处${result.truncated ? '（结果被上限截断）' : ''}。证据编号 ${evidence.id}：\n${text}` }],
        details: { evidenceId: evidence.id, truncated: result.truncated },
      };
    },
  });

  const localRead = defineTool({
    name: 'local_log_read',
    label: '读取本地日志片段',
    description: '读取已授权本地日志附件的指定行范围，用于查看上下文与异常栈。',
    parameters: Type.Object({
      attachmentId: Type.String({ minLength: 1, maxLength: 64 }),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 1 }),
    }),
    async execute(_id, params): Promise<ToolResult> {
      if (!context.canWork()) {
        return failure('探查预算已用尽，无法继续读取');
      }

      const handle = context.attachments.get(params.attachmentId);
      if (handle === undefined) {
        return failure('未知的附件编号；只能使用已授权的附件');
      }
      if (params.endLine - params.startLine > 400) {
        return failure('单次读取不得超过 400 行，请缩小范围');
      }

      const result = await readLocalRange(handle, params.startLine, params.endLine, {
        maxLines: 400,
        maxBytes: 512 * 1024,
        maxScanBytes: 256 * 1024 * 1024,
      });
      if (!result.ok) {
        return failure(result.reason ?? '读取失败');
      }

      const numbered = result.lines.map((line, index) => `${params.startLine + index}: ${line}`);
      const text = context.redactor.redact(numbered.join('\n'));
      const evidence = context.evidence.add({
        sourceKind: 'local-file',
        sourceLabel: handle.path,
        text,
        location: { file: handle.path, startLine: params.startLine, endLine: params.endLine },
        truncated: result.truncated === 'none' ? 'none' : 'tail',
      });

      return {
        content: [{ type: 'text', text: `证据编号 ${evidence.id}：\n${text}` }],
        details: { evidenceId: evidence.id, truncated: result.truncated },
      };
    },
  });

  return [sourceSearch, sourceRead, localSearch, localRead];
}

/** 失败结果统一以文本返回，让模型能读到原因，而不是抛异常中断会话。 */
function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: `拒绝或失败：${message}` }], details: { error: message } };
}
