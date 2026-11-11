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
 * 6. 注册 `/knowledge`、`/remote` 与 `/remote-close`。
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
import { validateTargetHost } from '../config/target.js';
import type { BudgetController } from '../core/budget.js';
import type { AuditEntry, AuditLedger, AuditOperation } from '../core/audit.js';
import type { EvidenceStore } from '../core/evidence.js';
import type { AttachmentRegistry } from '../logs/attachments.js';
import type { RemoteAccess } from '../remote/access.js';
import { preflightRemote, type RemoteBridgeSettings } from '../remote/login-flow.js';
import type { RemotePlanGate } from '../remote/plan-gate.js';
import type { Redactor } from '../security/redactor.js';
import type { SessionRecorder } from '../storage/recorder.js';
import type { AppPaths } from '../config/paths.js';
import { startUpdateNotice, type TimerApi } from '../update/notice.js';
import type { UpdateOutcome } from '../update/check.js';
import { VERSION } from '../version.js';

/** 扩展依赖；由组装根注入，避免扩展直接读配置。 */
export interface DiagnosisExtensionDeps {
  readonly paths: AppPaths;
  /** 远程登录参数；省略时 /remote 预检失败，不建立连接。 */
  readonly remote?: RemoteBridgeSettings;
  /** 远程授权生命周期；计划确认并由工具层登录后由这里建立。 */
  readonly remoteAccess?: RemoteAccess;
  /** 待确认的远程请求；/remote 登记，remote_query_plan 消费。 */
  readonly remoteGate?: RemotePlanGate;
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
  /**
   * 启动时的升级检查。
   *
   * WHY 做成可注入：默认实现会读状态目录并访问网络，
   * 测试必须能把它换成纯内存函数，否则每个用例都会真的发一次请求。
   * 省略时不展示任何升级提示。
   */
  readonly updateCheck?: () => Promise<UpdateOutcome>;
  /** 提示停留时长；测试用来缩短等待。 */
  readonly updateNoticeMs?: number;
  /** 定时器注入点；省略时用全局定时器。 */
  readonly updateTimer?: TimerApi;
}

/** 工具名 → 审计操作类型；未知工具一律记为 DENY，避免漏审。 */
const AUDIT_OPERATIONS: Readonly<Record<string, AuditOperation>> = {
  source_search: 'SOURCE_SEARCH',
  source_read: 'SOURCE_READ',
  local_log_search: 'LOCAL_SEARCH',
  local_log_read: 'LOCAL_READ',
  remote_query_plan: 'PLAN',
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
  if (toolName === 'remote_query_plan') {
    // 目的与关键词原文不进账本，只记规模。
    const planKeywords = Array.isArray(args['keywords']) ? args['keywords'].length : 0;
    const depth = args['maxDepth'] ?? 2;
    const subDir = args['subDir'];
    const scope = typeof subDir === 'string' && subDir !== '' ? subDir : '根目录';
    return `${String(planKeywords)} 个关键词 @${scope}，深度 ${String(depth)}`;
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
 * `/remote` 登记请求后驱动模型做语义分析的第一条消息。
 *
 * WHY 单独抽成纯函数：这段文本是产品的行为契约（先分析并提交计划、确认后才查询、
 * 结论必须引用证据），必须能在不启动模型的前提下逐条断言。
 *
 * 用户诉求放在定界标签内：它是待分析的数据，不是给模型的系统指令。
 */
export function buildRemoteKickoff(input: {
  readonly target: string;
  readonly instruction: string;
}): string {
  return [
    `用户请求对 ${input.target} 发起远程只读日志查询，诉求如下：`,
    '<remote-request>',
    input.instruction,
    '</remote-request>',
    '',
    '请严格按以下顺序执行，不要跳过：',
    '1. 先做语义分析：本次要定位什么问题、最可能出现在日志里的线索（异常类名、错误码、接口名、业务标识、traceId）、候选文件与时间范围。',
    '2. 调用 remote_query_plan 提交查询计划（purpose、keywords、subDir、maxDepth、focus）。目标由宿主绑定，你不能修改。',
    '3. 用户确认计划之前，不得调用 remote_log_list / remote_log_search / remote_log_read；此时没有任何授权，调用只会被拒绝。',
    '4. 计划被拒绝后立即停止，向用户说明未建立连接；不要重复提交相同计划，也不要反复弹窗。',
    '',
    '能力边界：搜索是 grep 字面量匹配，关键词只能是字母、数字与 _ . : / @ + -，一次最多 4 个；中文诉求必须转成异常类名、错误码、接口名等可搜索的 ASCII 线索。时间窗过滤未实现，只能按文件修改时间与读取范围近似，计划中要如实说明。',
    '',
    '授权后按 枚举 → 搜索 → 读取 执行：remote_log_list 枚举文件；remote_log_search 搜索关键词；对每个命中行用 remote_log_read 读取命中处所属的完整记录——异常栈续行没有时间戳，属于上一条记录，只读命中行会漏掉异常链。若同一请求跨多个文件，按时间排序后定位最后一个 ERROR / FATAL 作为终止锚点。',
    '',
    '输出沿用系统提示词：先给一句话结论，再给时间线、触发机制、根因候选与验证方法；每条关键结论引用证据编号（EV-xxx），并写明实际查询覆盖的文件与行范围。未命中或结果被截断时如实说明，不要把“没查到”写成“不存在”。',
    '',
    '完成后提醒用户：可用 /remote-close 结束授权并断开连接。',
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
          '若需排查日志，请直接粘贴内容或使用 @文件；远程取证请使用 /remote。',
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

    /**
     * 升级提示是否已经启动过。
     *
     * WHY 需要这个标记：session_start 在 /new、/reload、fork 时也会触发，
     * 而需求是「每次启动」——一个进程只提示一次。
     * 否则用户 /new 一下就会又弹 15 秒，变成骚扰。
     */
    let updateNoticeStarted = false;

    pi.on('session_start', (_event, ctx) => {
      deps.recorder.record('session.start', {
        service: deps.serviceId,
        model: deps.modelLabel,
      });

      // 升级提示：后台跑，不 await。
      // WHY 不能 await：这里在启动路径上，等一次 DNS/超时会把“进入诊断”
      // 拖慢两秒；提示本身只是锦上添花，不应该拿用户的时间换。
      if (deps.updateCheck !== undefined && !updateNoticeStarted) {
        updateNoticeStarted = true;
        startUpdateNotice({
          ui: {
            setStatus: (key, text) => ctx.ui.setStatus(key, text),
            onTerminalInput: (handler) => ctx.ui.onTerminalInput(handler),
            // 三道守卫依赖的两个即时状态：输入框为空时才吃 `u`。
            isEditorEmpty: () => ctx.ui.getEditorText().trim() === '',
            isIdle: () => ctx.isIdle(),
            // WHY 不用 ctx.ui.confirm（实测教训）：它固定弹 ["Yes","No"]
            // 且默认聚焦第一项，于是“按 u 再回车”就直接写全局目录。
            // 对安装这类不可逆写操作，默认选项必须是安全那个，
            // 因此改用 select 并把“取消”放在首位。
            confirm: async (title, message) => {
              const choice = await ctx.ui.select(`${title}\n${message}`, ['取消', '更新']);
              return choice === '更新';
            },
            notify: (message, level) => ctx.ui.notify(message, level),
          },
          currentVersion: VERSION,
          stateDir: deps.paths.stateDir,
          check: deps.updateCheck,
          ...(deps.updateNoticeMs === undefined ? {} : { durationMs: deps.updateNoticeMs }),
          ...(deps.updateTimer === undefined ? {} : { timer: deps.updateTimer }),
        });
      }
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

      // 扩展自己发起的消息（如 /remote 的 kickoff）内嵌用户原文：
      // 只脱敏，不解析 @、不注入附件与授权注记。
      // 否则诉求里出现一个 @ 就会变成文件授权，等于让用户输入扩大权限。
      if (event.source === 'extension') {
        return { action: 'transform', text: deps.redactor.redact(event.text) };
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

    // —— 7. /remote 与 /remote-close ——
    // `/remote` 只登记待确认请求并驱动模型做语义分析；真正的登录发生在
    // `remote_query_plan` 工具里（用户确认计划之后），见 remote-plan-tool.ts。
    pi.registerCommand('remote', {
      description: '指定目标机并以自然语言发起远程只读查询（先确认计划，再登录）',
      handler: async (args: string, ctx: ExtensionContext) => {
        const trimmed = args.trim();
        const target = trimmed.split(/\s+/)[0] ?? '';
        const instruction = trimmed.slice(target.length).trim();

        if (target === '') {
          ctx.ui.notify('用法：/remote <目标IP> <自然语言诉求>', 'warning');
          return;
        }
        // `/remote close` 是常见误写；直接引导到正确命令，而不是报“目标不合法”。
        if (target === 'close') {
          ctx.ui.notify('请使用 /remote-close 结束远程授权。', 'info');
          return;
        }

        const check = validateTargetHost(target);
        if (!check.ok) {
          ctx.ui.notify(`指定的目标不合法：${check.reason ?? ''}\n用法：/remote <目标IP> <自然语言诉求>`, 'warning');
          return;
        }

        if (instruction === '') {
          ctx.ui.notify('缺少排查诉求。用法：/remote <目标IP> <自然语言诉求>', 'warning');
          return;
        }
        if (instruction.length > 2_000) {
          ctx.ui.notify('排查诉求过长（上限 2000 字符），请精简后重试。', 'warning');
          return;
        }

        const access = deps.remoteAccess;
        const gate = deps.remoteGate;
        if (access === undefined || gate === undefined) {
          ctx.ui.notify('远程授权组件未加载，无法发起远程查询。', 'error');
          return;
        }

        // 预检在驱动模型之前完成：工具缺失或配置不全时立即失败，
        // 不让用户白等一轮模型调用。
        const preflight = await preflightRemote({ paths: deps.paths, settings: deps.remote });
        if (!preflight.ok) {
          ctx.ui.notify(preflight.message, 'error');
          return;
        }

        // 同一诊断只允许一个远程目标：旧授权先失效，
        // 避免 fileRef 与配额跨目标复用，也避免“看着 A 的日志查 B”。
        const previous = access.currentGrant;
        if (previous !== undefined) {
          await access.end();
          deps.audit.record({
            at: new Date().toISOString(),
            operation: 'CLOSE',
            target: previous.target,
            params: 'replaced',
            result: 'closed',
            grant: previous.id,
          });
          ctx.ui.notify(`已关闭上一授权：${previous.target}。`, 'info');
        }

        // 诉求原文只进入待确认状态与 kickoff；先脱敏再登记，
        // 避免用户粘进 /remote 的凭证在确认框中回显。
        gate.set(target, deps.redactor.redact(instruction));
        ctx.ui.notify(
          `已登记远程请求（目标 ${target}）。模型将先做语义分析并提交查询计划，` +
            '确认计划后才会登录；取消或拒绝则不会建立连接。',
          'info',
        );

        // WHY 主动发起一轮：斜杠命令在宿主本地执行，模型看不到这条命令，
        // 也不会有任何后续动作。不主动触发，用户只会看到登记提示，
        // 误以为“已经开始查了”。kickoff 会经过 input 钩子并只做脱敏。
        void Promise.resolve(pi.sendUserMessage(buildRemoteKickoff({ target, instruction }))).catch(
          (error: unknown) => {
            ctx.ui.notify(
              `无法启动模型轮次：${error instanceof Error ? error.message : '未知原因'}`,
              'error',
            );
          },
        );
      },
    });

    pi.registerCommand('remote-close', {
      description: '结束远程授权并断开连接',
      handler: async (_args: string, ctx: ExtensionContext) => {
        // 待确认请求也一并清空，避免关闭后遗留一个还能被工具捡起的请求。
        deps.remoteGate?.clear();

        const grant = deps.remoteAccess?.currentGrant;
        if (grant === undefined) {
          ctx.ui.notify('当前没有生效的远程授权。', 'info');
          return;
        }

        await deps.remoteAccess?.end();
        deps.audit.record({
          at: new Date().toISOString(),
          operation: 'CLOSE',
          target: grant.target,
          params: 'close-command',
          result: 'closed',
          grant: grant.id,
        });
        ctx.ui.notify(`已关闭 ${grant.target} 的远程授权与连接。`, 'info');
      },
    });
  };
}
