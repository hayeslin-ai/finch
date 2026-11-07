/**
 * 内置扩展：绑定 Pi 交互界面与本产品的安全约束和命令。
 *
 * 四件事：
 * 1. **拦截 `!` / `!!` 本地 Shell**：Pi 的交互界面自带 bash 模式，
 *    而本产品的硬约束是「模型与用户都不能通过本工具执行任意 Shell」。
 *    这里用扩展钩子把请求挡在执行之前，并说明原因。
 * 2. **驱动探查预算**：预算是安全边界，必须与诊断会话同生命周期。
 *    等待用户输入的时间不计入额度（否则用户思考几分钟就耗尽预算），
 *    因此按 Agent 循环的起止切换计时。
 * 3. 注册 `/knowledge`：查看、检索、保存与失效故障经验。
 * 4. 注册 `/trace`：解析目标机并确认；桥接脚本未经真实验证前不建立连接。
 *
 * 本模块只使用 Pi 公开的扩展接口，不修改其内部行为。
 */
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
import type { BudgetController } from '../core/budget.js';
import { readRemoteTools } from '../remote/connector.js';
import { resolveTarget } from '../remote/target-resolver.js';
import type { AppPaths } from '../config/paths.js';

/** 扩展依赖；由组装根注入，避免扩展直接读配置。 */
export interface DiagnosisExtensionDeps {
  readonly paths: AppPaths;
  readonly knowledge: KnowledgeContext;
  readonly budget: BudgetController;
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
    pi.on('agent_start', () => {
      deps.budget.start();
    });
    pi.on('agent_settled', () => {
      deps.budget.pause();
    });

    // —— 3. /knowledge ——
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

    // —— 4. /trace ——
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
