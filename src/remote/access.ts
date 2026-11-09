/**
 * 远程查询授权与配额。
 *
 * WHY 单独一层：会话、配额、枚举表与审计必须绑定在同一个授权生命周期里。
 * 把这几件事分散到工具与 /trace 命令中，就会出现“连接还在但配额已重置”
 * 或“换了目标却沿用旧 fileRef”这类无法审计的状态。
 *
 * 授权节奏（已与用户确认）：/trace 登录并核对身份后确认一次计划，
 * 同一连接内后续查询只受预算与次数约束，不再逐次确认。
 *
 * 边界：
 * - 未授权时任何查询都不发送字节；
 * - 每次尝试都计数（失败与重试同样消耗配额）；
 * - 目标、目录、配额或连接状态变化后旧授权立即失效，必须重新 /trace。
 */
import type { Limits } from '../config/limits.js';
import type { AuditLedger, AuditOperation } from '../core/audit.js';
import { runQuery } from './connector.js';
import { FileRegistry, parseListOutput, type RegisterResult, type RemoteFile } from './file-registry.js';
import type { ListQuery, RemoteQuery, RemoteFileSpec, SearchQuery } from './queries.js';
import type { RemoteSession } from './session.js';

/** 一次授权；等价于 Spec 的 ApprovalGrant，但只覆盖只读日志查询。 */
export interface RemoteGrant {
  readonly id: string;
  readonly target: string;
  readonly traceId: string;
  readonly logDir: string;
  readonly maxQueries: number;
  readonly maxFiles: number;
}

export interface RemoteAccessOptions {
  readonly audit: AuditLedger;
  /** 剩余诊断预算；为 false 时拒绝新查询。 */
  readonly canWork: () => boolean;
  readonly limits: Limits;
  readonly queryTimeoutMs: number;
}

export interface AccessResult {
  readonly ok: boolean;
  readonly text?: string;
  /** 远端或宿主侧触发了输出上限。 */
  readonly truncated?: boolean;
  readonly message?: string;
  /** LIST 专用：本次枚举的登记结果。 */
  readonly registered?: RegisterResult;
}

/** 已有授权时拒绝再次 begin：切换目标必须显式关闭旧授权。 */
export class RemoteAccess {
  private session: RemoteSession | undefined;
  private grant: RemoteGrant | undefined;
  private used = 0;
  private generation = 0;
  private readonly registry = new FileRegistry();

  constructor(private readonly options: RemoteAccessOptions) {}

  get active(): boolean {
    return this.session !== undefined && this.grant !== undefined;
  }

  get currentGrant(): RemoteGrant | undefined {
    return this.grant;
  }

  get files(): readonly RemoteFile[] {
    return this.registry.all();
  }

  get queriesUsed(): number {
    return this.used;
  }

  /** 建立授权；调用方必须已经完成登录与身份核对。 */
  begin(session: RemoteSession, grant: RemoteGrant): void {
    this.generation += 1;
    this.session = session;
    this.grant = grant;
    this.used = 0;
    this.registry.clear();
  }

  /** 结束授权并释放连接；重复调用是安全的。 */
  async end(): Promise<void> {
    const session = this.session;
    if (session === undefined) {
      return;
    }
    this.session = undefined;
    this.grant = undefined;
    this.generation += 1;
    this.registry.clear();
    await session.close();
  }

  /** 枚举日志文件并整体替换 fileRef 表。 */
  async list(query: ListQuery): Promise<AccessResult> {
    const outcome = await this.run('LIST', query, '枚举');
    if (!outcome.ok || outcome.text === undefined) {
      return outcome;
    }

    const grant = this.grant;
    if (grant === undefined) {
      // run 期间授权被 end()：generation 已变化，结果一律作废。
      return { ok: false, message: '授权已结束，本次枚举结果被丢弃' };
    }

    const listed = parseListOutput(outcome.text);
    const registered = this.registry.register(listed, grant.maxFiles);
    return {
      ok: true,
      truncated: outcome.truncated === true || registered.truncated,
      text: outcome.text,
      registered,
    };
  }

  /** 对已登记文件执行字面量搜索；未提供文件时搜全部已登记文件。 */
  async search(query: SearchQuery): Promise<AccessResult> {
    return this.run('SEARCH', query, '搜索');
  }

  async read(query: Extract<RemoteQuery, { kind: 'READ' }>): Promise<AccessResult> {
    return this.run('READ', query, '读取');
  }

  /**
   * 把 fileRef 解析成可发送的文件描述。
   *
   * 未知编号直接拒绝：这是“模型不能自造路径”的实际执行点。
   */
  resolveFiles(refs: readonly string[]): { ok: true; files: readonly RemoteFileSpec[] } | { ok: false; message: string } {
    const selected = refs.length === 0 ? this.registry.all() : refs.map((ref) => this.registry.resolve(ref));
    if (selected.length === 0) {
      return { ok: false, message: '尚未枚举任何日志文件，请先调用 remote_log_list' };
    }
    const files: RemoteFileSpec[] = [];
    for (const [index, file] of selected.entries()) {
      if (file === undefined) {
        const ref = refs[index] ?? '';
        return { ok: false, message: `未知文件编号：${ref}。只能使用 remote_log_list 返回的编号` };
      }
      files.push({ path: file.path, gz: file.compressed });
    }
    return { ok: true, files };
  }

  /** 给模型的授权注记；未授权时为空串，不产生任何提示。 */
  renderNote(): string {
    const grant = this.grant;
    if (grant === undefined) {
      return '';
    }
    const files =
      this.registry.size === 0
        ? '（尚未枚举）'
        : this.registry
            .all()
            .map((file) => `${file.ref} ${file.name}`)
            .join('、');
    return (
      `<remote-grant target="${grant.target}" trace="${grant.traceId}" ` +
      `queries="${String(this.used)}/${String(grant.maxQueries)}" files="${String(this.registry.size)}/${String(grant.maxFiles)}">\n` +
      `已枚举文件：${files}\n` +
      `</remote-grant>`
    );
  }

  /** 退出时释放连接；未知终止状态直接弃用，不尝试补救。 */
  async dispose(): Promise<void> {
    await this.end();
  }

  /**
   * 统一的查询入口：配额 → 预算 → 执行 → 审计。
   *
   * 先扣配额再执行：失败与重试同样计数，避免“错误重试”绕过次数上限。
   */
  private async run(
    operation: Extract<AuditOperation, 'LIST' | 'SEARCH' | 'READ'>,
    query: RemoteQuery,
    label: string,
  ): Promise<AccessResult> {
    const session = this.session;
    const grant = this.grant;
    if (session === undefined || grant === undefined) {
      return { ok: false, message: '远程未授权：请先使用 /trace 登录并确认查询计划' };
    }
    if (!this.options.canWork()) {
      return { ok: false, message: '探查预算已用尽，拒绝新的远程查询' };
    }
    if (this.used >= grant.maxQueries) {
      return {
        ok: false,
        message: `本次授权的查询次数已用尽（${String(grant.maxQueries)} 次）；如需继续请重新 /trace`,
      };
    }

    this.used += 1;
    const started = Date.now();
    const generation = this.generation;
    const result = await runQuery(session, query, this.options.queryTimeoutMs);
    const stale = generation !== this.generation;

    const text = stale ? undefined : result.text;
    const summary = result.ok
      ? text === undefined || text === ''
        ? '无输出'
        : `${String(countLines(text))} 行`
      : (result.message ?? '失败');

    this.options.audit.record({
      at: new Date().toISOString(),
      operation,
      target: grant.target,
      params: describeQuery(query, label),
      result: `${result.ok ? 'ok' : 'failed'}:${summary}`,
      grant: grant.id,
      durationMs: Date.now() - started,
    });

    if (stale) {
      return { ok: false, message: '授权已结束，本次查询结果被丢弃' };
    }
    if (!result.ok) {
      return { ok: false, message: result.message ?? '远程查询失败' };
    }
    return {
      ok: true,
      text: text ?? '',
      truncated: result.truncated === true || result.done?.truncated === true,
    };
  }
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

/** 审计参数摘要：只保留非敏感规模信息，不记录路径与关键词原文。 */
function describeQuery(query: RemoteQuery, label: string): string {
  switch (query.kind) {
    case 'LIST':
      return `${label} 深度 ${String(query.maxDepth)}`;
    case 'SEARCH':
      return `${label} ${String(query.terms.length)} 个关键词 @ ${String(query.files.length)} 个文件`;
    case 'READ':
      return `${label} 行 ${String(query.startLine)}-${String(query.endLine)}`;
  }
}
