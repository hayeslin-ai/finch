/**
 * 远程查询计划工具：`/remote` 的宿主硬门禁。
 *
 * WHY 做成工具而不是让模型在对话里“问一句”：
 * 模型自行询问是否继续时，它可以不询问就继续调用查询工具；
 * 只有把确认放进工具执行路径，并把“登录/授权”也绑定在同一次确认之后，
 * 才能保证未确认的远程请求连一个字节都发不出去。
 *
 * 顺序契约（已与用户确认）：
 * 1. `/remote` 只登记待确认请求并驱动模型做语义分析；
 * 2. 模型调用本工具提交结构化计划；
 * 3. 宿主拼装展示文案，经 `ctx.ui.confirm` 取得确认；
 * 4. 确认后才登录、核对身份并建立 grant；
 * 5. 拒绝则终止本次 /remote，不建立任何连接。
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { RemoteAccess } from '../remote/access.js';
import type { RemoteLoginRequest, RemoteLoginResult } from '../remote/login-flow.js';
import type { RemotePlanGate } from '../remote/plan-gate.js';
import { QueryValidationError, validateDepth, validateSubDir, validateTerms } from '../remote/queries.js';
import { failure, type ToolResult } from './tools.js';

/** 计划展示所需的配额摘要；与登录流程使用同一组配置值。 */
export interface RemotePlanLimits {
  readonly maxQueries: number;
  readonly maxFiles: number;
  readonly maxResultLines: number;
  readonly maxResultBytes: number;
}

/** 计划工具依赖；由组装根注入。 */
export interface RemotePlanToolContext {
  readonly gate: RemotePlanGate;
  readonly access: RemoteAccess;
  readonly limits: RemotePlanLimits;
  /** 用户确认后执行登录；实现见 login-flow.ts。 */
  readonly login: (request: RemoteLoginRequest) => Promise<RemoteLoginResult>;
  /** 授权编号；与审计账本的 grant 字段对应。 */
  readonly nextGrantId: () => string;
}

/**
 * 文本字段允许的字符集。
 *
 * 中英文均可，但明确排除 `<>"'&` 与控制字符：
 * 这些字段会进入 `ctx.ui.confirm` 的展示文本与 `<remote-grant>` 注记，
 * 保留尖括号或引号会让“宿主生成的注记”与“日志内容”在形态上无法区分。
 */
const TEXT_FIELD_PATTERN = /^[^<>&"'\u0000-\u001f\u007f]+$/u;

/** 校验展示型文本字段；返回错误说明而不是抛异常，便于工具统一格式化。 */
function validateTextField(value: string, label: string, maxLength: number): string | undefined {
  if (value.length > maxLength) {
    return `${label}不得超过 ${String(maxLength)} 个字符`;
  }
  if (!TEXT_FIELD_PATTERN.test(value)) {
    return `${label}不得包含尖括号、引号、& 或控制字符`;
  }
  return undefined;
}

/** 把字节数渲染成计划里的可读上限。 */
function formatKiB(bytes: number): string {
  return `${String(Math.round(bytes / 1024))} KiB`;
}

/** 确认框中展示的原始诉求上限；再长也会被截断，避免刷屏。 */
const REQUEST_EXCERPT_LIMIT = 200;

/**
 * 宿主拼装计划摘要；模型提交的字段只作为数据填入，配额与目标来自宿主。
 *
 * 同时展示（已脱敏的）原始诉求，让用户能对照“我要求的”和“模型计划的”，
 * 而不是只能判断模型自己的复述是否合理。
 */
export function renderRemotePlanSummary(input: {
  readonly target: string;
  readonly request: string;
  readonly purpose: string;
  readonly keywords: readonly string[];
  readonly subDir: string;
  readonly maxDepth: number;
  readonly focus: string | undefined;
  readonly limits: RemotePlanLimits;
}): string {
  const scope = input.subDir === '' ? '日志根目录' : input.subDir;
  const keywords = input.keywords.length === 0 ? '未指定（先枚举再决定）' : input.keywords.join('、');
  const request =
    input.request.length > REQUEST_EXCERPT_LIMIT
      ? `${input.request.slice(0, REQUEST_EXCERPT_LIMIT)}…`
      : input.request;
  return [
    `目标：${input.target}`,
    `原始诉求：${request}`,
    `目的：${input.purpose}`,
    `关键词：${keywords}`,
    `枚举范围：${scope}，深度 ${String(input.maxDepth)}`,
    `关注点：${input.focus ?? '按默认排查顺序'}`,
    `配额：查询 ${String(input.limits.maxQueries)} 次 · 文件 ${String(input.limits.maxFiles)} 个 · ` +
      `单次 ${String(input.limits.maxResultLines)} 行 / ${formatKiB(input.limits.maxResultBytes)}`,
    '时间窗：未实现（只能按文件修改时间与读取范围近似）',
    '查询方式：枚举 → 关键词搜索 → 按行读取，全部只读。',
  ].join('\n');
}

/**
 * 创建 `remote_query_plan` 工具。
 *
 * 该工具是 `/remote` 唯一能建立授权状态的入口；
 * 未登记请求、用户拒绝、无对话框环境或登录失败时，grant 都不会被创建。
 */
export function createRemotePlanTool(context: RemotePlanToolContext) {
  return defineTool({
    name: 'remote_query_plan',
    label: '提交远程查询计划',
    description:
      '向用户提交本次远程日志查询计划并请求确认。必须在调用任何 remote_log_* 工具之前使用；' +
      '用户确认后宿主才会登录目标机并建立只读授权。没有待确认的 /remote 请求时调用会失败。',
    parameters: Type.Object({
      purpose: Type.String({ minLength: 1, maxLength: 200 }),
      keywords: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 4 }),
      ),
      subDir: Type.Optional(Type.String({ maxLength: 128 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      focus: Type.Optional(Type.String({ maxLength: 500 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
      const pending = context.gate.current();
      if (pending === undefined) {
        return failure(
          '没有待确认的 /remote 请求。请先让用户执行 /remote <目标> <诉求>，不要自行猜测目标。',
        );
      }

      // 校验全部在弹窗之前完成：一旦展示就不能中途改口，
      // 否则用户确认的是一份计划、执行的是另一份。
      const purpose = params.purpose.trim();
      if (purpose === '') {
        return failure('查询目的不能为空');
      }
      const purposeError = validateTextField(purpose, '查询目的', 200);
      if (purposeError !== undefined) {
        return failure(purposeError);
      }

      // 空关键词是合法输入（先枚举再决定），只有格式错误才拒绝。
      const requestedKeywords = params.keywords ?? [];
      let keywords: readonly string[] = [];
      if (requestedKeywords.length > 0) {
        try {
          keywords = validateTerms(requestedKeywords);
        } catch (error) {
          if (error instanceof QueryValidationError) {
            return failure(error.message);
          }
          throw error;
        }
      }

      let subDir: string;
      let maxDepth: number;
      try {
        subDir = validateSubDir(params.subDir ?? '');
        maxDepth = validateDepth(params.maxDepth ?? 2);
      } catch (error) {
        if (error instanceof QueryValidationError) {
          return failure(error.message);
        }
        throw error;
      }

      const focus = params.focus?.trim();
      if (focus !== undefined && focus !== '') {
        const focusError = validateTextField(focus, '关注点', 500);
        if (focusError !== undefined) {
          return failure(focusError);
        }
      }

      // 无对话框环境无法完成人工确认，必须失败关闭而不是自动放行。
      if (!ctx.hasUI) {
        context.gate.clear();
        return failure('当前环境没有可用的确认对话框，无法授权远程查询。');
      }

      const summary = renderRemotePlanSummary({
        target: pending.target,
        request: pending.instruction,
        purpose,
        keywords,
        subDir,
        maxDepth,
        focus: focus === undefined || focus === '' ? undefined : focus,
        limits: context.limits,
      });

      const approved = await ctx.ui.confirm('远程查询计划', `${summary}\n\n确认授权本次只读查询？`);
      // 无论确认还是拒绝都消费掉请求：一次 /remote 只能提交一次计划，
      // 避免模型在拒绝后换个说法反复弹窗。
      context.gate.clear();

      if (!approved) {
        return failure(
          '用户拒绝了查询计划；本次 /remote 已终止，未建立连接。请停止远程查询并说明未授权。',
        );
      }

      const result = await context.login({
        target: pending.target,
        intent: purpose,
        grantId: context.nextGrantId(),
        confirmIdentity: async (identity) =>
          ctx.ui.confirm(
            `身份核对：${pending.target}`,
            `${identity}\n\n该身份是否对应本次目标？`,
          ),
      });

      if (!result.ok) {
        context.gate.clear();
        return failure(result.message);
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `${result.message}\n\n已确认的计划：\n${summary}\n\n` +
              '请按计划执行：先 remote_log_list 枚举，再 remote_log_search 搜索，命中后用 remote_log_read 读取完整记录；' +
              '结论必须引用证据编号并写明实际覆盖范围。',
          },
        ],
        details: {
          target: pending.target,
          keywords: keywords.length,
          approved: true,
          grant: context.access.currentGrant?.id ?? '-',
        },
      };
    },
  });
}
