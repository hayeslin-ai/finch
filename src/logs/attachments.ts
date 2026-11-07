/**
 * 本地附件登记表。
 *
 * WHY 需要单独一层：
 * - 模型只能引用编号，不能提交路径，因此编号到句柄的映射必须由宿主持有；
 * - 授权绑定到用户显式指定的具体文件，一次会话内编号稳定，新增附件不重排旧编号；
 * - 交互输入是异步到达的，而工具在会话创建时就取走了句柄视图，
 *   所以这里必须返回同一个 Map 实例，否则后授权的附件对工具永远不可见。
 */
import path from 'node:path';

import { authorizeAttachment, type AttachmentHandle } from './local.js';

export interface RegisterResult {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
}

export class AttachmentRegistry {
  /** 编号 → 句柄；同一个实例贯穿整个会话。 */
  private readonly handles = new Map<string, AttachmentHandle>();
  /** 编号 → 展示名；只保留文件名，避免把本地目录结构带进模型上下文。 */
  private readonly labels = new Map<string, string>();
  private nextIndex = 1;

  /** 工具侧的只读视图；返回的是实时 Map，后续授权立即可见。 */
  get toolView(): ReadonlyMap<string, AttachmentHandle> {
    return this.handles;
  }

  get size(): number {
    return this.handles.size;
  }

  /**
   * 授权并登记一个附件。
   *
   * 失败只影响这一个附件：其余附件与本地诊断不受影响，
   * 因此返回错误而不是抛异常，由调用方决定如何提示。
   */
  async register(target: string): Promise<RegisterResult> {
    const handle = await authorizeAttachment(path.resolve(target));
    if ('error' in handle) {
      return { ok: false, error: handle.error };
    }

    const id = `att-${this.nextIndex}`;
    this.nextIndex += 1;
    this.handles.set(id, handle);
    this.labels.set(id, path.basename(handle.path));
    return { ok: true, id };
  }

  /**
   * 渲染给模型的附件清单。
   *
   * 只给编号与文件名：模型需要知道有哪些附件可供检索，
   * 但没有必要拿到本地目录结构。
   */
  renderNote(): string {
    if (this.handles.size === 0) {
      return '';
    }
    const lines = [...this.labels].map(([id, label]) => `  ${id}  ${label}`);
    return [
      '<attachments>',
      '本轮已授权的本地日志附件（只能按编号调用 local_log_search / local_log_read）：',
      ...lines,
      '</attachments>',
    ].join('\n');
  }

  clear(): void {
    this.handles.clear();
    this.labels.clear();
  }
}
