/**
 * 扩展端口契约。
 *
 * WHY：Spec 4.2 要求核心只依赖端口，具体适配器由唯一组装根注入，
 * 这样替换日志后端、交互入口或存储时不必复制诊断流程。
 * 本文件只定义接口与只读数据类型，因此不得导入 Pi、Node 文件/网络 API
 * 或任何具体适配器；依赖方向由 architecture 测试强制。
 *
 * 端口只降低替换成本，不授予额外权限：任何实现仍须经过统一的
 * 权限、脱敏与预算链路。
 */

/** 证据来源类型；与 PRD 的三种输入及知识复用保持一致。 */
export type SourceKind = 'paste' | 'local-file' | 'remote' | 'source' | 'knowledge';

/** 证据的只读视图；行号等定位信息均为可选，不假设所有来源都有文件行号。 */
export interface EvidenceRef {
  readonly id: string;
  readonly sourceKind: SourceKind;
  /** 脱敏后的来源标识；不保存原始路径或 traceId。 */
  readonly sourceLabel: string;
  readonly collectedAt: string;
  readonly truncated: 'none' | 'head' | 'tail' | 'middle-dropped' | 'partial-scan' | 'record';
  readonly omittedLines?: number;
  readonly omittedBytes?: number;
}

/** 工具执行结果的状态；与 Spec 6.1 的 ToolOutcome 对齐。 */
export type ToolStatus =
  | 'ok'
  | 'partial'
  | 'not_found'
  | 'denied'
  | 'error'
  | 'cancelled'
  | 'termination_unknown';

export interface ToolOutcome<T> {
  readonly status: ToolStatus;
  readonly data?: T;
  readonly evidence?: readonly EvidenceRef[];
  readonly message?: string;
}

/** 交互端口：CLI 是 V1 唯一实现，未来可替换为其他前端。 */
export interface InteractionPort {
  /** 展示已脱敏的业务事件。 */
  render(event: SafeAppEvent): void;
  /** 请求人工审批；返回值必须来自可信交互，不能由模型或日志内容伪造。 */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ApprovalRequest {
  readonly targetLabel: string;
  readonly logRoot: string;
  readonly timeWindow: string;
  readonly maxQueries: number;
  readonly maxFiles: number;
  readonly maxResultLines: number;
}

export type ApprovalDecision = 'approve' | 'reject' | 'timeout';

/** 业务事件：已脱敏，供任何前端渲染。 */
export interface SafeAppEvent {
  readonly type:
    | 'diagnosis.started'
    | 'plan.requested'
    | 'plan.resolved'
    | 'evidence.collected'
    | 'budget.updated'
    | 'tool.finished'
    | 'diagnosis.completed'
    | 'diagnosis.failed'
    | 'knowledge.proposed';
  readonly at: string;
  readonly summary: string;
}

/** 日志来源端口：本地附件与远程共用同一查询语义。 */
export interface LogSearchRequest {
  readonly queryRefs: readonly string[];
  readonly before: number;
  readonly after: number;
}

export interface LogSourcePort {
  /** 能力描述；无法支持的操作必须明确声明，不能伪装成功。 */
  describe(): Promise<LogSourceCapabilities>;
  search(request: LogSearchRequest): Promise<ToolOutcome<readonly EvidenceRef[]>>;
}

export interface LogSourceCapabilities {
  readonly kind: SourceKind;
  readonly supportsCompressed: boolean;
  readonly supportsTimeFilter: boolean;
}

/** 代码仓库端口：只读检索与片段读取。 */
export interface RepositoryPort {
  search(terms: readonly string[], subPath?: string): Promise<ToolOutcome<readonly EvidenceRef[]>>;
  read(relativePath: string, startLine: number, endLine: number): Promise<ToolOutcome<EvidenceRef>>;
}

/** Agent 运行时端口：会话创建、单轮对话与取消。 */
export interface AgentRuntimePort {
  start(): Promise<void>;
  prompt(text: string): AsyncIterable<SafeAppEvent>;
  abort(): Promise<void>;
}

/** 会话存储端口：只保存脱敏内容。 */
export interface SessionStorePort {
  append(event: SafeAppEvent): Promise<void>;
  snapshot(): Promise<{ readonly sessionId: string; readonly events: readonly SafeAppEvent[] }>;
}

/** 知识存储端口：草稿、确认、修订与范围检索。 */
export interface KnowledgeStorePort {
  search(scopeId: string, terms: readonly string[]): Promise<readonly EvidenceRef[]>;
}

/** 报告渲染端口：CLI 文本、未来 Markdown 或 JSON。 */
export interface ReportRendererPort {
  renderDiagnosis(diagnosis: unknown): string;
}
