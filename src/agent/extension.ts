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
import type { RemoteAccess } from '../remote/access.js';
import { connectRemote, defaultConnectDeps, readRemoteTools } from '../remote/connector.js';
import { ensureLoginScript } from '../remote/login-script.js';
import { RemoteSession } from '../remote/session.js';
import { resolveTarget } from '../remote/target-resolver.js';
import type { Redactor } from '../security/redactor.js';
import type { SessionRecorder } from '../storage/recorder.js';
import type { AppPaths } from '../config/paths.js';

/**
 * 远程登录设置。
 *
 * 值只来自已校验的 `.env`；凭证仅进入子进程环境，不落盘、不进会话记录。
 * 配置缺失或非法时 available=false，/trace 明确失败，不尝试连接。
 */
export interface RemoteBridgeSettings {
  readonly available: boolean;
  readonly issues: readonly { readonly key: string; readonly reason: string }[];
  readonly values: Readonly<Record<string, string>>;
  readonly connectTimeoutMs: number;
  readonly queryTimeoutMs: number;
  /** 计划展示用的配额摘要；与工具层使用同一组限额。 */
  readonly limits?: {
    readonly maxQueries: number;
    readonly maxFiles: number;
    readonly maxResultLines: number;
    readonly maxResultBytes: number;
  };
  /** 登录后账户，仅用于计划展示。 */
  readonly appUser?: string;
}

/** 扩展依赖；由组装根注入，避免扩展直接读配置。 */
export interface DiagnosisExtensionDeps {
  readonly paths: AppPaths;
  /** 远程登录参数；省略时 /trace 只做目标解析，不建立连接。 */
  readonly remote?: RemoteBridgeSettings;
  /** 远程授权生命周期；/trace 成功后由这里建立，工具通过同一实例查询。 */
  readonly remoteAccess?: RemoteAccess;
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
  remote_log_list: 'LIST',
  remote_log_search: 'SEARCH',
  remote_log_read: 'READ',
};

/** 审计目标：本地操作记 `repo` 或附件编号，远程操作记目标机，绝不记绝对路径。 */
function auditTargetOf(
  toolName: string,
  args: Record<string, unknown>,
  remoteTarget: string,
): string {
  if (toolName.startsWith('source_')) {
    return 'repo';
  }
  if (toolName.startsWith('remote_')) {
    return remoteTarget === '' ? 'remote' : remoteTarget;
  }
  const attachmentId = args['attachmentId'];
  return typeof attachmentId === 'string' ? attachmentId : 'local';
}

/** 参数摘要：只保留关键词个数、行号区间这类非敏感信息。 */
function auditParamsOf(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'source_read' || toolName === 'local_log_read' || toolName === 'remote_log_read') {
    const start = args['startLine'];
    const end = args['endLine'];
    const range = `行 ${String(start)}-${String(end)}`;
    if (toolName === 'source_read') {
      return `${String(args['relativePath'])} ${range}`;
    }
    if (toolName === 'remote_log_read') {
      return `${String(args['fileRef'])} ${range}`;
    }
    return range;
  }
  if (toolName === 'remote_log_list') {
    const depth = args['maxDepth'] ?? 2;
    const subDir = args['subDir'];
    return typeof subDir === 'string' && subDir !== ''
      ? `枚举 ${subDir}，深度 ${String(depth)}`
      : `枚举根目录，深度 ${String(depth)}`;
  }

  const terms = args['terms'];
  const count = Array.isArray(terms) ? terms.length : 0;
  if (toolName === 'remote_log_search') {
    const refs = Array.isArray(args['fileRefs']) ? args['fileRefs'].length : 0;
    return `${count} 个关键词 @${refs === 0 ? '全部已枚举文件' : `${String(refs)} 个文件`}`;
  }
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

/**
 * 授权成功后驱动模型排查的第一条消息。
 *
 * WHY 单独抽成纯函数：这段文本是产品的行为契约（先用什么工具、按什么顺序、
 * 结论必须引用证据），必须能在不启动模型的前提下逐条断言。
 */
export function buildTraceKickoff(input: { readonly target: string; readonly traceId: string }): string {
  return [
    `已授权 ${input.target} 的只读日志查询，traceId = ${input.traceId}。`,
    '',
    '请按以下顺序排查，不要跳过中间步骤：',
    '1. 调用 remote_log_list 枚举日志文件（目录深度默认 2）。',
    `2. 用 remote_log_search 搜索 traceId「${input.traceId}」；若未命中，先如实说明已搜索的文件数与范围。`,
    '3. 对每个命中行，用 remote_log_read 读取命中处所属的完整记录：异常栈续行没有时间戳，属于上一条记录，只读命中行会漏掉异常链。',
    '4. 若同一 trace 跨多个文件，按时间排序后再定位最后一个 ERROR / FATAL 作为终止锚点。',
    '',
    '输出要求：先给一句话结论，再给时间线、触发机制、根因候选与验证方法；每条关键结论引用证据编号（EV-xxx），并写明实际查询覆盖的文件与行范围。未命中或结果被截断时如实说明，不要把“没查到”写成“不存在”。',
    '',
    '完成后提醒用户：可用 /trace close 结束授权并断开连接。',
  ].join('\n');
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
      // 附件与远程授权注记都由宿主生成；合在一起注入，
      // 模型因此能看到可用文件编号与剩余配额，无需猜测。
      const notes = [deps.attachments.renderNote(), deps.remoteAccess?.renderNote() ?? '']
        .filter((note) => note !== '')
        .join('\n\n');
      return { action: 'transform', text: notes === '' ? instruction : `${instruction}\n\n${notes}` };
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
        target: auditTargetOf(event.toolName, args, deps.remoteAccess?.currentGrant?.target ?? ''),
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
    /** 授权编号；每次成功授权递增，写进审计的 grant 字段。 */
    let grantCounter = 0;

    pi.registerCommand('trace', {
      description: '登录目标机，核对身份并授权本次只读日志查询',
      handler: async (args: string, ctx: ExtensionContext) => {
        const tokens = args.trim().split(/\s+/).filter((token) => token !== '');

        // /trace close：结束当前授权。没有授权时明确说明，不假装成功。
        if (tokens[0] === 'close') {
          const grant = deps.remoteAccess?.currentGrant;
          if (grant === undefined) {
            ctx.ui.notify('当前没有生效的远程授权。', 'info');
            return;
          }
          await deps.remoteAccess?.end();
          ctx.ui.notify(`已关闭 ${grant.target} 的远程授权与连接。`, 'info');
          return;
        }

        const traceId = tokens[0];
        if (traceId === undefined) {
          ctx.ui.notify('用法：/trace <traceId> [--host <目标>]；/trace close 结束授权', 'warning');
          return;
        }
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(traceId)) {
          ctx.ui.notify('traceId 只能包含字母、数字、下划线与连字符', 'warning');
          return;
        }

        // 同一诊断只允许一个远程目标：旧授权先失效，
        // 避免 fileRef 与配额跨目标复用，也避免“看着 A 的日志查 B”。
        const previous = deps.remoteAccess?.currentGrant;
        if (previous !== undefined) {
          await deps.remoteAccess?.end();
          ctx.ui.notify(`已关闭上一授权：${previous.target}。`, 'info');
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

        // 登录脚本由程序生成到固定位置；用户不需要设置 LOGIN_SCRIPT。
        const script = await ensureLoginScript(deps.paths);
        if (!script.ok) {
          ctx.ui.notify(`登录脚本不可用：${script.reason ?? '无法生成'}`, 'error');
          return;
        }

        const tools = readRemoteTools(process.env, script.path);
        if (!tools.ok) {
          const problems = [tools.expect, tools.oathtool]
            .filter((tool) => tool.path === undefined)
            .map((tool) => tool.error ?? `未找到 ${tool.name}：${tool.installHint}`);
          ctx.ui.notify(`远程工具未就绪：\n${problems.map((item) => `  ${item}`).join('\n')}`, 'error');
          return;
        }

        const remote = deps.remote;
        if (remote === undefined || !remote.available) {
          const reasons =
            remote === undefined
              ? ['远程配置未加载']
              : remote.issues.map((item) => `${item.key}：${item.reason}`);
          ctx.ui.notify(`远程配置不完整：\n${reasons.map((item) => `  ${item}`).join('\n')}`, 'error');
          return;
        }

        // tools.ok 时两个路径必然存在；取本地常量既完成类型收窄，
        // 也让“用什么程序建立连接”只有这一处来源。
        const expectPath = tools.expect.path;
        const oathTool = tools.oathtool.path;
        if (expectPath === undefined || oathTool === undefined) {
          ctx.ui.notify('远程工具解析结果不完整，已中止。', 'error');
          return;
        }

        const started = Date.now();
        const result = await connectRemote(
          resolution.host,
          { expectPath, loginScript: script.path, oathTool },
          defaultConnectDeps(
            deps.paths,
            {
              target: resolution.host,
              expectPath,
              loginScript: script.path,
              oathTool,
              remoteValues: remote.values,
            },
            () =>
              new RemoteSession({
                connectTimeoutMs: remote.connectTimeoutMs,
                queryTimeoutMs: remote.queryTimeoutMs,
              }),
          ),
        );

        deps.audit.record({
          at: new Date().toISOString(),
          operation: 'CONNECT',
          target: resolution.host,
          params: 'login-only',
          result: result.ok ? 'ok' : 'failed',
          grant: '-',
          durationMs: Date.now() - started,
        });

        if (!result.ok || result.session === undefined) {
          ctx.ui.notify(`连接失败：${result.message}`, 'error');
          return;
        }

        // READY 只证明脚本完成了登录与目录核对；IP 与 hostname 的映射
        // 无法在不做 DNS 的前提下自证，因此必须由用户确认身份。
        const confirmedIdentity = await ctx.ui.confirm(
          `身份核对：${resolution.host}`,
          `${result.identity}\n\n该身份是否对应本次目标？`,
        );

        if (!confirmedIdentity) {
          await result.session.close();
          deps.audit.record({
            at: new Date().toISOString(),
            operation: 'CLOSE',
            target: resolution.host,
            params: 'identity-rejected',
            result: 'closed',
            grant: '-',
          });
          ctx.ui.notify('身份未确认，连接已关闭，未执行任何查询。', 'warning');
          return;
        }

        const access = deps.remoteAccess;
        const limits = remote.limits;
        if (access === undefined || limits === undefined) {
          await result.session.close();
          ctx.ui.notify('远程授权组件未加载，连接已关闭。', 'error');
          return;
        }

        // 一次计划确认覆盖本次连接内的全部查询（已与用户确认的授权节奏）。
        const plan =
          `目标 ${resolution.host} · 账户 ${remote.appUser ?? '未知'}\n` +
          `${result.identity}\n` +
          `配额：查询 ${String(limits.maxQueries)} 次 · 文件 ${String(limits.maxFiles)} 个 · ` +
          `单次 ${String(limits.maxResultLines)} 行 / ${String(Math.round(limits.maxResultBytes / 1024))} KiB · 无时间窗\n` +
          `查询方式：枚举 → 关键词搜索 → 按行读取，全部只读。`;

        const approved = await ctx.ui.confirm('远程查询计划', `${plan}\n\n确认授权本次只读查询？`);
        if (!approved) {
          await result.session.close();
          ctx.ui.notify('未授权，连接已关闭。', 'info');
          return;
        }

        grantCounter += 1;
        access.begin(result.session, {
          id: `grant-${String(grantCounter)}`,
          target: resolution.host,
          traceId,
          logDir: result.identity ?? '',
          maxQueries: limits.maxQueries,
          maxFiles: limits.maxFiles,
        });

        ctx.ui.notify(
          `已授权 ${resolution.host} 的只读日志查询。可用 remote_log_list 枚举、remote_log_search 搜索、` +
            `remote_log_read 读取；/trace close 结束。`,
          'info',
        );

        // WHY 主动发起一轮：斜杠命令在宿主本地执行，模型看不到这条命令，
        // 也不会有任何后续动作。不主动触发，用户只会看到授权提示，
        // 误以为“什么都没查到”。这里把 traceId 与查询要求明确交给模型。
        pi.sendUserMessage(buildTraceKickoff({ target: resolution.host, traceId }));
      },
    });
  };
}
