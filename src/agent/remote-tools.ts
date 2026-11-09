/**
 * 远程日志工具。
 *
 * WHY 单独成文件：本地只读工具不依赖任何远程会话，把两者混在一起会让
 * “有没有授权”变成隐含条件。这里三个工具统一走 RemoteAccess：
 * 未授权 → 本地拒绝；配额耗尽 → 本地拒绝；任何查询都不会绕过审计。
 *
 * 结果处理与本地工具一致：先脱敏，再登记证据，最后交给模型。
 * 远程路径不进入模型可见文本，只展示 fileRef 与文件名。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { Limits } from '../config/limits.js';
import type { EvidenceStore } from '../core/evidence.js';
import type { RemoteAccess } from '../remote/access.js';
import type { RemoteFile } from '../remote/file-registry.js';
import type { Redactor } from '../security/redactor.js';
import { failure, type ToolResult } from './tools.js';

/** 未授权时的统一提示；三个工具共用同一措辞，避免模型猜测不同含义。 */
const UNAUTHORIZED = '远程未授权：请先使用 /trace 登录并确认查询计划';

/** 远程工具执行上下文。 */
export interface RemoteToolContext {
  readonly access: RemoteAccess;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly limits: Limits;
  /** 当前授权目标，用于证据来源标注；未授权时为空串。 */
  readonly target: () => string;
}

/** 把毫秒时间格式化为 `MM-DD HH:mm`；0 表示远端没给出 mtime。 */
function formatMtime(mtimeMs: number): string {
  if (mtimeMs <= 0) {
    return '未知时间';
  }
  const date = new Date(mtimeMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把字节数渲染成便于阅读的规模。 */
function formatSize(bytes: number): string {
  if (bytes <= 0) {
    return '未知大小';
  }
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 把 grep 输出的绝对路径换成 fileRef。
 *
 * 远端返回 `path:line:text`；路径可能含冒号（白名单允许），
 * 因此按已知路径前缀匹配，而不是简单 split(':', 2)。
 */
function replacePathWithRef(line: string, files: readonly RemoteFile[]): string {
  for (const file of files) {
    if (line.startsWith(`${file.path}:`)) {
      return `${file.ref}${line.slice(file.path.length)}`;
    }
  }
  return line;
}

/** 创建远程日志工具集；未授权时三个工具都只返回可操作的拒绝原因。 */
export function createRemoteTools(context: RemoteToolContext) {
  const list = defineTool({
    name: 'remote_log_list',
    label: '枚举远程日志',
    description:
      '枚举目标机日志目录下的候选日志文件，返回文件编号（f-N）、修改时间与大小。后续搜索与读取只能使用这里返回的编号。',
    parameters: Type.Object({
      subDir: Type.Optional(Type.String({ maxLength: 128 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const query = {
        kind: 'LIST' as const,
        subDir: params.subDir ?? '',
        maxDepth: params.maxDepth ?? 2,
      };
      const outcome = await context.access.list(query);
      if (!outcome.ok) {
        return failure(outcome.message ?? '远程枚举失败');
      }

      const registered = outcome.registered;
      if (registered === undefined || registered.files.length === 0) {
        return {
          content: [{ type: 'text', text: '未枚举到候选日志文件。可尝试修改 subDir 或确认日志目录是否正确。' }],
          details: { files: 0, truncated: outcome.truncated === true },
        };
      }

      const lines = registered.files.map(
        (file) => `${file.ref}  ${formatMtime(file.mtimeMs)}  ${formatSize(file.size)}  ${file.name}`,
      );
      const truncatedNote =
        outcome.truncated === true
          ? `\n注意：候选共 ${String(registered.total)} 个，超出本次授权上限，仅保留最近 ${String(registered.files.length)} 个。`
          : '';
      return {
        content: [
          {
            type: 'text',
            text: `枚举到 ${String(registered.files.length)} 个日志文件（编号可用于搜索与读取）：\n${lines.join('\n')}${truncatedNote}`,
          },
        ],
        details: {
          files: registered.files.length,
          total: registered.total,
          truncated: outcome.truncated === true,
        },
      };
    },
  });

  const search = defineTool({
    name: 'remote_log_search',
    label: '搜索远程日志',
    description:
      '在已枚举的远程日志文件里按字面量搜索关键词，返回文件编号与行号。搜索结果是行级线索；给出结论前应使用 remote_log_read 读取命中处的完整记录。',
    parameters: Type.Object({
      terms: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4 }),
      fileRefs: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { minItems: 1, maxItems: 10 })),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      // 先判授权再解析编号：否则未授权时会被误报成“未知文件编号”，
      // 把用户引向错误的排查方向。
      if (!context.access.active) {
        return failure(UNAUTHORIZED);
      }
      const resolved = context.access.resolveFiles(params.fileRefs ?? []);
      if (!resolved.ok) {
        return failure(resolved.message);
      }

      const outcome = await context.access.search({
        kind: 'SEARCH',
        terms: params.terms,
        files: resolved.files,
        before: params.before ?? 0,
        after: params.after ?? 0,
      });
      if (!outcome.ok) {
        return failure(outcome.message ?? '远程搜索失败');
      }

      const text = (outcome.text ?? '').trim();
      if (text === '') {
        return {
          content: [{ type: 'text', text: '未命中：远端搜索已完成，没有任何匹配行。' }],
          details: { matched: false, truncated: outcome.truncated === true },
        };
      }

      const mapped = text
        .split('\n')
        .map((line) => replacePathWithRef(line, context.access.files))
        .join('\n');
      const redacted = context.redactor.redact(mapped);
      const evidence = context.evidence.add({
        sourceKind: 'remote',
        sourceLabel: context.target() === '' ? '远程日志' : context.target(),
        text: redacted,
        truncated: outcome.truncated === true ? 'partial-scan' : 'none',
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `远程搜索命中结果（证据编号 ${evidence.id}）` +
              `${outcome.truncated === true ? '；输出达到上限，结果被截断' : ''}：\n${redacted}`,
          },
        ],
        details: { evidenceId: evidence.id, matched: true, truncated: outcome.truncated === true },
      };
    },
  });

  const read = defineTool({
    name: 'remote_log_read',
    label: '读取远程日志片段',
    description:
      '按行号区间读取已枚举的远程日志文件，返回带行号的原文。日志记录可能跨多行（异常栈），应读到下一条记录头之后再下结论。',
    parameters: Type.Object({
      fileRef: Type.String({ minLength: 1, maxLength: 16 }),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Integer({ minimum: 1 }),
    }),
    async execute(_id, params): Promise<ToolResult> {
      if (!context.access.active) {
        return failure(UNAUTHORIZED);
      }
      const file = context.access.files.find((item) => item.ref === params.fileRef);
      if (file === undefined) {
        return failure(`未知文件编号：${params.fileRef}。只能使用 remote_log_list 返回的编号`);
      }
      if (params.endLine < params.startLine) {
        return failure('结束行不得早于起始行');
      }
      if (params.endLine - params.startLine + 1 > context.limits.MAX_RESULT_LINES) {
        return failure(`单次读取不得超过 ${String(context.limits.MAX_RESULT_LINES)} 行`);
      }

      const outcome = await context.access.read({
        kind: 'READ',
        file: { path: file.path, gz: file.compressed },
        startLine: params.startLine,
        endLine: params.endLine,
      });
      if (!outcome.ok) {
        return failure(outcome.message ?? '远程读取失败');
      }

      const body = (outcome.text ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
      if (body === '') {
        return {
          content: [{ type: 'text', text: `第 ${String(params.startLine)}-${String(params.endLine)} 行没有内容（可能超出文件末尾）。` }],
          details: { lines: 0, truncated: outcome.truncated === true },
        };
      }

      const numbered = body
        .split('\n')
        .map((line, index) => `${String(params.startLine + index)}: ${line}`)
        .join('\n');
      const redacted = context.redactor.redact(numbered);
      const evidence = context.evidence.add({
        sourceKind: 'remote',
        sourceLabel: context.target() === '' ? '远程日志' : context.target(),
        text: redacted,
        location: {
          file: file.name,
          startLine: params.startLine,
          endLine: params.startLine + body.split('\n').length - 1,
        },
        truncated: outcome.truncated === true ? 'tail' : 'none',
      });

      return {
        content: [
          {
            type: 'text',
            text:
              `${file.ref}（${file.name}）第 ${String(params.startLine)}-${String(params.startLine + body.split('\n').length - 1)} 行，证据编号 ${evidence.id}` +
              `${outcome.truncated === true ? '；输出达到上限，已截断' : ''}：\n${redacted}`,
          },
        ],
        details: {
          evidenceId: evidence.id,
          fileRef: file.ref,
          lines: body.split('\n').length,
          truncated: outcome.truncated === true,
        },
      };
    },
  });

  return [list, search, read];
}
