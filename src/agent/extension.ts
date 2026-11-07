/**
 * 内置扩展：绑定 Pi 交互界面与本产品的安全约束和命令。
 *
 * 六件事：
 * 1. **拦截 `!` / `!!` 本地 Shell**：Pi 的交互界面自带 bash 模式，
 *    而本产品的硬约束是「模型与用户都不能通过本工具执行任意 Shell」。
 *    这里用扩展钩子把请求挡在执行之前，并说明原因。
 * 2. **驱动探查预算**：预算是安全边界，必须与诊断会话同生命周期。
 *    等待用户输入的时间不计入额度（否则用户思考几分钟就耗尽预算），
 *    因此按 Agent 循环的起止切换计时。
 * 3. **解析 `@文件`**：把附件授权登记为编号，并把编号告知模型。
 *    没有这一步，local_log_search / local_log_read 在生产中不可达。
 * 4. **入口脱敏**：用户输入在进入模型之前先过会话脱敏器。
 *    整个会话共用同一个 Redactor，占位符在输入与工具结果之间保持一致。
 * 5. **记录会话事件**：让 `-c` / `-r` / `--sessions` 真实可用。
 * 6. 注册 `/knowledge` 与 `/trace`。
 *
 * 本模块只使用 Pi 公开的扩展接口，不修改其内部行为。
 */
import { homedir } from 'node:os';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  deriveEntryId,
  invalidateEntry,
  listEntries,
  renderEntryList,
  saveDraft,
  searchAndRender,
  type KnowledgeContext,
  type KnowledgeIo,
} from '../cli/knowledge-commands.js';
import { parseUserInput } from '../cli/input.js';
import type { BudgetController } from '../core/budget.js';
import type { AuditEntry, AuditLedger, AuditOperation } from '../core/audit.js';
import type { EvidenceStore } from '../core/evidence.js';
import type { AttachmentRegistry } from '../logs/attachments.js';
import { readRemoteTools } from '../remote/connector.js';
import { resolveTarget } from '../remote/target-resolver.js';
import type { Redactor } from '../security/redactor.js';
import type { SessionRecorder } from '../storage/recorder.js';
import type { AppPaths } from '../config/paths.js';

/** 扩展依赖；由组装根注入，避免扩展直接读配置。 */
export interface DiagnosisExtensionDeps {
  readonly paths: AppPaths;
  readonly knowledge: KnowledgeContext;
  readonly budget: BudgetController;
  readonly evidence: EvidenceStore;
  readonly redactor: Redactor;
  readonly attachments: AttachmentRegistry;
  readonly recorder: SessionRecorder;
  /** 会话元信息；只写入本地会话记录，供恢复时展示。 */
  readonly serviceId: string;
  readonly modelLabel: string;
  readonly audit: AuditLedger;
}

/** 工具名 → 审计操作类型；未知工具一律记为 DENY，避免漏审。 */
const AUDIT_OPERATIONS: Readonly<Record<string, AuditOperation>> = {
  source_search: 'SOURCE_SEARCH',
  source_read: 'SOURCE_READ',
  local_log_search: 'LOCAL_SEARCH',
  local_log_read: 'LOCAL_READ',
};

/** 审计目标：本地操作记 `repo` 或附件编号，绝不记绝对路径。 */
function auditTargetOf(toolName: string, args: Record<string, unknown>): string {
  if (toolName.startsWith('source_')) {
    return 'repo';
  }
  const attachmentId = args['attachmentId'];
  return typeof attachmentId === 'string' ? attachmentId : 'local';
}

/** 参数摘要：只保留关键词个数、行号区间这类非敏感信息。 */
function auditParamsOf(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'source_read' || toolName === 'local_log_read') {
    const start = args['startLine'];
    const end = args['endLine'];
    const range = `行 ${String(start)}-${String(end)}`;
    return toolName === 'source_read' ? `${String(args['relativePath'])} ${range}` : range;
  }
  const terms = args['terms'];
  const count = Array.isArray(terms) ? terms.length : 0;
  const subPath = args['subPath'];
  return typeof subPath === 'string' ? `${count} 个关键词 @${subPath}` : `${count} 个关键词`;
}

/**
 * 模型输出的出口脱敏。
 *
 * Spec 7.5 要求模型输出在展示前再检查一次。
 * 只在确有变化时返回新值：没有变化就返回 undefined，
 * 让调用方保持原对象，避免无谓地重建消息。
 */
function redactMessageContent(content: unknown, redactor: Redactor): unknown | undefined {
  if (typeof content === 'string') {
    const redacted = redactor.redact(content);
    return redacted === content ? undefined : redacted;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  let changed = false;
  const next = content.map((block) => {
    if (typeof block !== 'object' || block === null) {
      return block;
    }
    const item = block as { type?: string; text?: unknown; thinking?: unknown };
    // 思考块与正文块都要过：两者都会进入会话历史并被再次发给模型。
    const field = item.type === 'thinking' ? 'thinking' : 'text';
    const value = item[field];
    if (typeof value !== 'string') {
      return block;
    }
    const redacted = redactor.redact(value);
    if (redacted === value) {
      return block;
    }
    changed = true;
    return { ...item, [field]: redacted };
  });

  return changed ? next : undefined;
}

/** 结果摘要：只记编号、规模与是否截断，不记内容。 */
function auditResultOf(result: unknown, isError: boolean): string {
  if (isError) {
    return '执行失败';
  }
  const details = (result as { details?: Record<string, unknown> } | undefined)?.details;
  if (details === undefined) {
    return '完成';
  }
  if (typeof details['error'] === 'string') {
    return '拒绝';
  }
  const parts: string[] = [];
  if (typeof details['filesScanned'] === 'number') {
    parts.push(`扫描 ${details['filesScanned']} 个文件`);
  }
  const evidenceId = details['evidenceId'];
  if (typeof evidenceId === 'string') {
    parts.push(evidenceId);
  }
  // truncated 既可能是布尔（多数工具），也可能是 'none'/'tail'/'scan-limit'；
  // 'none' 表示完整返回，不能算作截断。
  const truncated = details['truncated'];
  if (truncated === true || (typeof truncated === 'string' && truncated !== 'none')) {
    parts.push('已截断');
  }
  return parts.length === 0 ? '完成' : parts.join('，');
}

/**
 * 从会话记录中取最近一条助手回复的纯文本。
 *
 * WHY：`/knowledge save` 需要把诊断结论存为经验。
 * 直接复用会话里已经展示给用户的内容，不额外调用模型，也不读取原始数据。
 */
function lastAssistantText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry?.type !== 'message' || entry.message?.role !== 'assistant') {
      continue;
    }
    const content = entry.message.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          const item = block as { type?: string; text?: string };
          return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
        })
        .filter((text) => text !== '')
        .join('\n');
    }
  }
  return '';
}

/** 构造扩展工厂；Pi 在加载时执行它。 */
export function createDiagnosisExtension(deps: DiagnosisExtensionDeps) {
  return (pi: ExtensionAPI): void => {
    // —— 1. 永久禁止本地 Shell ——
    // 即使扩展将来被移除，工具集本身也没有 bash；这是第二道防线。
    pi.on('user_bash', () => ({
      result: {
        output:
          '本工具禁止执行本地 Shell。\n' +
          '若需排查日志，请直接粘贴内容或使用 @文件；远程取证请使用 /trace。',
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    }));

    // —— 2. 预算与 Agent 循环同生命周期 ——
    // 只在循环执行期间计时：agent_settled 表示本轮已完全落定、正在等用户输入。
    // 若在这里漏掉 pause，用户思考的时间会持续吃掉探查额度；
    // 若漏掉 start，预算永不计时，四个工具的 canWork 守卫会全部失效。
    /** 已写入会话记录的证据条数；避免每轮重复记录同一批证据。 */
    let recordedEvidence = 0;

    pi.on('session_start', () => {
      deps.recorder.record('session.start', {
        service: deps.serviceId,
        model: deps.modelLabel,
      });
    });

    pi.on('agent_start', () => {
      deps.budget.start();
    });

    pi.on('agent_settled', (event, ctx) => {
      deps.budget.pause();

      // 系统提示词要求「每条关键结论都必须引用证据编号」。
      // 这里做一次落地校验：引用了不存在的编号要当场提示，
      // 否则编造的编号会以和真实证据一样的格式混过去。
      const unknown = deps.evidence.findUnknownIds(lastAssistantText(ctx));
      if (unknown.length > 0) {
        ctx.ui.notify(
          `本轮结论引用了不存在的证据编号：${unknown.join('、')}。这些引用不可信，请要求模型重新给出。`,
          'warning',
        );
      }

      // 会话记录只写编号与来源类别，不写证据正文：
      // 会话目录是长期留存的本地文件，落盘面越小越好。
      const all = deps.evidence.all();
      for (const item of all.slice(recordedEvidence)) {
        deps.recorder.record('evidence.collected', { id: item.id, source: item.sourceKind });
      }
      recordedEvidence = all.length;

      if (event.aborted) {
        deps.recorder.record('diagnosis.failed', { reason: 'aborted', evidence: all.length });
        return;
      }
      deps.recorder.record('diagnosis.completed', { evidence: all.length });
    });

    // —— 3 & 4. 输入侧：附件授权 + 入口脱敏 ——    // 这里是用户文本进入模型前的唯一收口点，因此两件事必须一起做：
    // 漏掉附件解析，@文件 就只是个普通字符串，本地日志工具不可达；
    // 漏掉脱敏，粘贴的日志会带着明文凭证进入模型上下文。
    pi.on('input', async (event, ctx) => {
      // 斜杠命令由命令处理器负责，不当作诊断输入处理。
      if (event.text.trimStart().startsWith('/')) {
        return;
      }

      let parsed;
      try {
        parsed = parseUserInput(event.text, homedir());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : '输入解析失败', 'warning');
        return;
      }

      for (const target of parsed.attachments) {
        const result = await deps.attachments.register(target);
        if (!result.ok) {
          // 单个附件失败只跳过它，其余附件与本地诊断不受影响。
          ctx.ui.notify(`附件未授权：${target}（${result.error ?? '未知原因'}）`, 'warning');
        }
      }

      deps.recorder.record('input.received', {
        attachments: deps.attachments.size,
        chars: parsed.instruction.length,
      });

      const instruction = deps.redactor.redact(parsed.instruction);
      const note = deps.attachments.renderNote();
      return { action: 'transform', text: note === '' ? instruction : `${instruction}\n\n${note}` };
    });

    // —— 出口复核：模型输出在进入会话历史前再脱敏一次 ——
    // Spec 7.5 要求模型输出在展示前再检查。入口已经脱敏，这一层是纵深防御：
    // 万一将来有新路径把未脱敏内容送进模型，模型复述出来时仍会被挡在
    // 会话历史与后续渲染之外。流式过程中的字符先于本钩子渲染，
    // 因此这是补充而不是唯一防线。
    pi.on('message_end', (event) => {
      const message = event.message as { role?: string; content?: unknown };
      if (message.role !== 'assistant') {
        return;
      }
      const content = redactMessageContent(message.content, deps.redactor);
      if (content === undefined) {
        return;
      }
      return { message: { ...(event.message as object), content } as typeof event.message };
    });

    // —— 5. 审计账本与 /audit ——
    // AC-39 要求用户能回答「Agent 到底做了什么」，且账本里不得出现
    // 原始 traceId、密钥、完整命令或绝对路径，因此这里只记摘要。
    // 参数与目标只在 start 事件里可见（end 事件不带 args），因此先存后取。
    const auditPending = new Map<string, { target: string; params: string }>();

    pi.on('tool_execution_start', (event) => {
      const args = (event.args ?? {}) as Record<string, unknown>;
      auditPending.set(event.toolCallId, {
        target: auditTargetOf(event.toolName, args),
        params: auditParamsOf(event.toolName, args),
      });
    });

    pi.on('tool_execution_end', (event) => {
      const pending = auditPending.get(event.toolCallId);
      auditPending.delete(event.toolCallId);

      const entry: AuditEntry = {
        at: new Date().toISOString(),
        // 未登记的工具名一律记为 DENY：宁可多一条可疑记录，也不要漏审。
        operation: AUDIT_OPERATIONS[event.toolName] ?? 'DENY',
        target: pending?.target ?? 'unknown',
        params: pending?.params ?? '-',
        result: auditResultOf(event.result, event.isError),
        grant: '-',
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
      };
      deps.audit.record(entry);
    });

    pi.registerCommand('audit', {
      description: '查看最近的工具操作摘要',
      handler: async (args: string, ctx: ExtensionContext) => {
        const requested = Number.parseInt(args.trim(), 10);
        // 默认 10 条；上限 50，避免一次刷屏，也不提供导出。
        const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : 10;
        ctx.ui.notify(deps.audit.render(limit).trimEnd(), 'info');
      },
    });

    // —— 6. /knowledge ——
    pi.registerCommand('knowledge', {
      description: '查看、检索或保存故障经验',
      handler: async (args: string, ctx: ExtensionContext) => {
        const io: KnowledgeIo = {
          out: (line) => ctx.ui.notify(line, 'info'),
          text: async (question) => (await ctx.ui.input(question)) ?? '',
          approve: async (question) => ctx.ui.confirm(question, '确认后才会写入；其他选择视为取消。'),
        };

        const [subcommand, ...rest] = args.trim().split(/\s+/);

        if (subcommand === undefined || subcommand === '') {
          const metas = await listEntries(deps.knowledge);
          ctx.ui.notify(renderEntryList(metas).trimEnd(), 'info');
          return;
        }

        if (subcommand === 'search') {
          if (rest.length === 0) {
            ctx.ui.notify('用法：/knowledge search <关键词…>', 'warning');
            return;
          }
          const rendered = await searchAndRender(deps.knowledge, rest);
          ctx.ui.notify(rendered.trimEnd(), 'info');
          return;
        }

        if (subcommand === 'save') {
          const diagnosis = lastAssistantText(ctx).trim();
          if (diagnosis === '') {
            ctx.ui.notify('当前还没有诊断结论可保存。请先完成一轮诊断。', 'warning');
            return;
          }

          const title = (await ctx.ui.input('条目标题', '例如：订单计算空指针')) ?? '';
          if (title.trim() === '') {
            ctx.ui.notify('标题不能为空，已取消。', 'warning');
            return;
          }
          const signature =
            (await ctx.ui.input('错误特征', '例如：NullPointerException OrderService.calc')) ?? '';
          const version = (await ctx.ui.input('适用版本（可留空）')) ?? '';
          const rootCauseConfirmed = await ctx.ui.confirm(
            '根因是否已确认？',
            '未确认时只能保存为草稿，且不会进入默认检索。',
          );

          const result = await saveDraft(
            deps.knowledge,
            {
              title: title.trim(),
              errorSignature: signature.trim() === '' ? title.trim() : signature.trim(),
              body: diagnosis,
              rootCauseConfirmed,
              applicableVersion: version.trim() === '' ? 'unknown' : version.trim(),
            },
            io,
          );
          ctx.ui.notify(result.message, result.ok ? 'info' : 'warning');
          return;
        }

        if (subcommand === 'invalidate') {
          const entryId = rest[0];
          if (entryId === undefined) {
            ctx.ui.notify('用法：/knowledge invalidate <条目ID>', 'warning');
            return;
          }
          const result = await invalidateEntry(deps.knowledge, deriveEntryId(entryId), io);
          ctx.ui.notify(result.message, result.ok ? 'info' : 'warning');
          return;
        }

        ctx.ui.notify('未知子命令。可用：search / save / invalidate', 'warning');
      },
    });

    // —— 7. /trace ——
    pi.registerCommand('trace', {
      description: '解析目标机并确认（暂不建立连接）',
      handler: async (args: string, ctx: ExtensionContext) => {
        const tokens = args.trim().split(/\s+/).filter((token) => token !== '');
        const traceId = tokens[0];
        if (traceId === undefined) {
          ctx.ui.notify('用法：/trace <traceId> [--host <目标>]', 'warning');
          return;
        }
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(traceId)) {
          ctx.ui.notify('traceId 只能包含字母、数字、下划线与连字符', 'warning');
          return;
        }

        let requested: string | undefined;
        for (let index = 1; index < tokens.length; index += 1) {
          const token = tokens[index];
          if (token !== '--host') {
            ctx.ui.notify(`未知参数：${token}`, 'warning');
            return;
          }
          const value = tokens[index + 1];
          if (value === undefined) {
            ctx.ui.notify('--host 缺少取值', 'warning');
            return;
          }
          requested = value;
          index += 1;
        }

        // 目标来源优先级：显式指定 > 最近使用。
        // 日志提取需要用户本轮提供的原始日志文本；这里不读取会话内容充当日志，
        // 避免把模型输出误当成日志记录头去解析。
        const resolution = await resolveTarget({
          paths: deps.paths,
          ...(requested === undefined ? {} : { requested }),
        });

        if (resolution.host === undefined) {
          ctx.ui.notify(resolution.reason, 'warning');
          if (resolution.candidates.length > 0) {
            ctx.ui.notify(`候选目标：${resolution.candidates.join('、')}`, 'info');
          }
          return;
        }

        const confirmed = await ctx.ui.confirm(
          `目标：${resolution.host}`,
          `${resolution.reason}\n确认使用该目标？`,
        );
        if (!confirmed) {
          ctx.ui.notify('已取消，未建立连接。', 'info');
          return;
        }

        const tools = readRemoteTools(process.env);
        if (!tools.ok) {
          ctx.ui.notify(`远程工具未配置：缺少环境变量 ${tools.missing.join(', ')}`, 'error');
          return;
        }

        // 明确告知尚未连接：协议与状态机已就绪，但脚本待真实环境验证。
        ctx.ui.notify(
          '目标已确认，但远程查询尚未启用：\n' +
            '  桥接脚本还未在真实环境验证目标身份、终端回显与取消语义。\n' +
            '  在验证完成前不会建立连接，避免在错误机器上取证。',
          'warning',
        );
      },
    });
  };
}
