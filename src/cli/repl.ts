/**
 * 交互式诊断主循环。
 *
 * 形态按 PRD 5.1.1 定稿：行式 CLI + 一行状态行，不做全屏 TUI。
 *
 * 关键行为：
 * - 状态行常驻显示远程能力、预算、查询与文件计数，不含 traceId、密钥与日志内容。
 * - 预算在等待用户输入时暂停，只有模型与工具执行计时。
 * - 模型输出在展示前脱敏；引用不存在的证据编号会被指出。
 * - `/audit` 展示最近 10 条操作摘要，不导出。
 */
import { createInterface } from 'node:readline';

import type { Composition } from '../app/composition.js';
import { listModelCandidates, parseModelFlag } from '../config/model-selection.js';
import { resolveAppPaths } from '../config/paths.js';
import { readRemoteTools } from '../remote/connector.js';
import { resolveTarget } from '../remote/target-resolver.js';
import type { AppPaths } from '../config/paths.js';
import {
  deriveEntryId,
  invalidateEntry,
  listEntries,
  renderEntryList,
  saveDraft,
  searchAndRender,
  type KnowledgeContext,
  type KnowledgeIo,
} from './knowledge-commands.js';
import { appendEvent, createSessionId } from '../storage/session.js';
import { parseUserInput } from './input.js';
import { ChatUI, type CommandHint } from './ui.js';
import { readRepositoryVersion } from '../app/composition.js';

/** 主循环依赖的外部能力；注入后便于测试。 */
export interface ReplOptions {
  readonly composition: Composition;
  /** 应用状态目录；用于写入脱敏会话事件。 */
  readonly stateDir?: string;
  /** 恢复的会话标识；存在时继续写入同一会话，而不是新建。 */
  readonly resumeSessionId?: string;
  /** 知识库上下文；缺失时 /knowledge 提示不可用。 */
  readonly knowledge?: KnowledgeContext;
  /** 配置路径；/trace 需要用它解析目标与最近使用记录。 */
  readonly paths?: AppPaths;
  /** 远程能力状态；P3 阶段只有本地诊断，固定为不可用。 */
  readonly remoteStatus: string;
  /** 输出函数；测试可捕获。 */
  readonly write: (line: string) => void;
  readonly writeError: (line: string) => void;
}

/** 斜杠命令清单；用于输入 / 时的下拉提示与 Tab 补全。 */
const COMMANDS: readonly CommandHint[] = [
  { command: '/model', description: '查看或切换模型' },
  { command: '/effort', description: '查看或切换思考等级' },
  { command: '/trace', description: '排查指定 traceId' },
  { command: '/knowledge', description: '查看故障经验' },
  { command: '/audit', description: '查看最近 10 条操作' },
  { command: '/status', description: '查看预算与证据数量' },
  { command: '/new', description: '开始新的诊断' },
  { command: '/paste', description: '多行粘贴日志' },
  { command: '/help', description: '显示帮助' },
  { command: '/exit', description: '退出' },
];

const HELP = `可用命令：
  /paste … /end    多行粘贴日志
  @路径            显式授权本地日志文件
  /model [<provider>/<model>]  查看或切换模型（仅本次会话）
  /effort [<等级>]             查看或切换思考等级（仅本次会话）
  /trace <id> [--host <目标>]  排查指定 traceId
  /audit           查看最近 10 条操作
  /knowledge       查看故障经验列表
  /knowledge search <词…>  按字面量检索已确认经验
  /knowledge save  把当前诊断结论存为经验（需确认）
  /knowledge invalidate <条目>  标记失效（需确认）
  /status          查看当前预算与证据数量
  /new             开始新的诊断（清空证据）
  /help            显示本帮助
  /exit            退出`;

/**
 * 渲染状态行。
 *
 * 只放非敏感摘要；预算按分:秒显示，便于快速判断还剩多少时间。
 */
export function renderStatusLine(input: {
  readonly remoteStatus: string;
  readonly remainingMs: number;
  readonly totalMs: number;
  readonly evidenceCount: number;
  readonly model?: string;
  readonly effort?: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly sessionId?: string;
  /** 可用宽度；缺省时不压缩。 */
  readonly width?: number;
}): string {
  const seconds = Math.max(0, Math.floor(input.remainingMs / 1000));
  const total = Math.max(0, Math.floor(input.totalMs / 1000));
  const budget = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}/${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  const remoteFull = `REMOTE ${input.remoteStatus} │ budget ${budget} │ evidence ${input.evidenceCount}`;
  // 窄终端下压缩预算行，避免关键信息被截断。
  const remoteShort = `REMOTE ${input.remoteStatus.startsWith('ready') ? 'ready' : 'off'} │ ${budget} │ ev ${input.evidenceCount}`;
  const remoteWidth = input.width ?? Number.POSITIVE_INFINITY;
  const remote = remoteFull.length <= remoteWidth ? remoteFull : remoteShort;

  // 第一行按用户指定格式：模型·思考级别 | 工作目录 | 分支 | 会话
  if (input.model === undefined) {
    return remote;
  }
  // 按优先级逐步压缩，确保四项都能看见：
  // 模型全名 → 模型短名 → 目录短名 → 会话短号 → 预算行压缩。
  const fullModel = `${input.model}·${input.effort ?? 'off'}`;
  const shortModel = `${input.model.split('/').at(-1) ?? input.model}·${input.effort ?? 'off'}`;
  const fullCwd = input.cwd ?? '';
  const shortCwd = fullCwd.split('/').filter((part) => part !== '').at(-1) ?? fullCwd;
  const branch = input.branch ?? 'unknown';
  const session = input.sessionId ?? '';
  const width = input.width ?? Number.POSITIVE_INFINITY;

  const candidates: Array<[string, string, string, string]> = [
    [fullModel, fullCwd, branch, session],
    [shortModel, fullCwd, branch, session],
    [shortModel, shortCwd, branch, session],
    [shortModel, shortCwd, branch, session.slice(-6)],
  ];

  for (const [model, cwd, br, sess] of candidates) {
    const line = `[${[model, cwd, br, sess].filter((part) => part !== '').join(' │ ')}]`;
    if (line.length <= width) {
      return `${line}\n${remote}`;
    }
  }

  const fallback = `[${[shortModel, shortCwd, branch, session.slice(-6)].filter(Boolean).join(' │ ')}]`;
  return `${clipLine(fallback, width)}\n${clipLine(remote, width)}`;
}

/**
 * 处理 /knowledge 子命令。
 *
 * 所有写操作都要求显式 approve；检索只读，不影响当前诊断结论。
 */
async function handleKnowledge(
  input: string,
  options: ReplOptions,
  write: (line: string) => void,
  writeError: (line: string) => void,
  lastDiagnosis: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  if (options.knowledge === undefined) {
    writeError('知识库不可用：缺少数据目录。');
    return;
  }
  const context = options.knowledge;
  // 复用主循环的 readline：不引入第二套输入通道，
  // 也保证确认动作确实来自用户，而不是被硬编码的结果。
  const io: KnowledgeIo = {
    out: write,
    text: (question) => ask(question),
    approve: async (question) => {
      const answer = await ask(`${question}\n输入 approve 确认，其他任何输入视为取消：`);
      return answer.trim() === 'approve';
    },
  };

  const [, subcommand, ...rest] = input.split(/\s+/);

  if (subcommand === undefined) {
    const metas = await listEntries(context);
    process.stdout.write(renderEntryList(metas));
    return;
  }

  if (subcommand === 'search') {
    if (rest.length === 0) {
      writeError('用法：/knowledge search <关键词…>');
      return;
    }
    process.stdout.write(await searchAndRender(context, rest));
    return;
  }

  if (subcommand === 'save') {
    // 多步命令必须一次性读完所需输入，或在开始前就拒绝。
    // 否则一旦中途返回，用户接下来输入的内容会被主循环当作诊断输入消费，
    // 造成命令与数据错位（真实测试中已复现）。
    if (lastDiagnosis.trim() === '') {
      writeError('当前还没有诊断结论可保存。请先完成一轮诊断。');
      return;
    }

    // 只保存用户能看到、已经脱敏的输出；不额外读取任何原始数据。
    const title = (await ask('条目标题（例如：订单计算空指针）')).trim();
    if (title === '') {
      writeError('标题不能为空，已取消。');
      return;
    }
    const errorSignature = (await ask('错误特征（例如：NullPointerException OrderService.calc）')).trim();
    const versionAnswer = (await ask('适用版本（可留空）')).trim();

    const result = await saveDraft(
      context,
      {
        title,
        errorSignature: errorSignature === '' ? title : errorSignature,
        body: lastDiagnosis,
        // 由用户明确确认根因是否已确认；否则只能存为草稿。
        rootCauseConfirmed: (await ask('根因是否已确认？输入 yes 确认，其他视为未确认')).trim() === 'yes',
        applicableVersion: versionAnswer === '' ? 'unknown' : versionAnswer,
      },
      io,
    );
    (result.ok ? write : writeError)(result.message);
    return;
  }

  if (subcommand === 'invalidate') {
    const entryId = rest[0];
    if (entryId === undefined) {
      writeError('用法：/knowledge invalidate <条目ID>');
      return;
    }
    const result = await invalidateEntry(context, deriveEntryId(entryId), io);
    (result.ok ? write : writeError)(result.message);
    return;
  }

  writeError('未知子命令。可用：search / invalidate');
}

/**
 * 处理 /model。
 *
 * 只影响本次会话：不写任何配置文件。
 * 这样用户不必为了试一次别的模型而修改 models.json。
 */
async function handleModel(
  input: string,
  options: ReplOptions,
  write: (line: string) => void,
  writeError: (line: string) => void,
): Promise<void> {
  const { composition } = options;
  const argument = input.slice('/model'.length).trim();
  const current = composition.currentModel;

  if (argument === '') {
    // 列出候选并标记当前项；不加载模型、不产生费用。
    const candidates = await listModelCandidates(options.paths ?? resolveFallbackPaths());
    if (candidates.length === 0) {
      writeError('models.json 中没有可用模型。');
      return;
    }
    write('可用模型：');
    for (const item of candidates) {
      const marker =
        item.provider === current.provider && item.modelId === current.modelId ? '*' : ' ';
      write(`  ${marker} ${item.provider}/${item.modelId}`);
    }
    write('使用 /model <provider>/<modelId> 切换；仅影响本次会话。');
    return;
  }

  const parsed = parseModelFlag(argument);
  if ('error' in parsed) {
    writeError(parsed.error);
    return;
  }

  try {
    await composition.switchModel(parsed.provider, parsed.modelId);
    write(`已切换到 ${parsed.provider}/${parsed.modelId}（仅本次会话）。`);
  } catch (error) {
    writeError(error instanceof Error ? error.message : '切换失败');
  }
}

/** 未注入 paths 时的兜底；正常路径不会走到这里。 */
function resolveFallbackPaths(): ReturnType<typeof resolveAppPaths> {
  return resolveAppPaths();
}

/** 处理 /effort；等级由当前模型能力决定。 */
function handleEffort(
  input: string,
  options: ReplOptions,
  write: (line: string) => void,
  writeError: (line: string) => void,
): void {
  const { composition } = options;
  const argument = input.slice('/effort'.length).trim();
  const available = composition.availableEfforts();

  if (argument === '') {
    write(`当前思考等级：${composition.currentEffort()}`);
    write(`可选：${available.join(', ')}`);
    write('使用 /effort <等级> 切换；仅影响本次会话。');
    return;
  }

  try {
    composition.setEffort(argument);
    write(`已切换到 ${argument}（仅本次会话）。`);
  } catch (error) {
    writeError(error instanceof Error ? error.message : '切换失败');
  }
}

/**
 * 处理 /trace。
 *
 * 当前只做“目标解析 + 确认 + 能力检查”，**不建立真实连接**：
 * 桥接脚本尚未在真实环境验证，擅自连接可能在错误机器上取证。
 * 解析与确认逻辑已完整实现并有测试覆盖；启用只需替换最后的连接调用。
 */
async function handleTrace(
  input: string,
  options: ReplOptions,
  write: (line: string) => void,
  writeError: (line: string) => void,
  logText: string,
  ask: (question: string) => Promise<string>,
): Promise<void> {
  const parsed = parseTraceInput(input);
  if (!parsed.ok) {
    writeError(parsed.error);
    return;
  }

  if (options.paths === undefined) {
    writeError('无法解析目标：缺少配置路径。');
    return;
  }

  const resolution = await resolveTarget({
    paths: options.paths,
    ...(parsed.targetHost === undefined ? {} : { requested: parsed.targetHost }),
    ...(logText === '' ? {} : { logText }),
  });

  if (resolution.host === undefined) {
    writeError(resolution.reason);
    if (resolution.candidates.length > 0) {
      write(`候选目标：${resolution.candidates.join('、')}`);
      write('使用 /trace <traceId> --host <目标> 指定其中一个。');
    }
    return;
  }

  write(`目标：${resolution.host}（${resolution.reason}）`);
  const confirmed = (await ask('确认使用该目标？输入 approve 确认')).trim() === 'approve';
  if (!confirmed) {
    write('已取消，未建立连接。');
    return;
  }

  const tools = readRemoteTools(process.env);
  if (!tools.ok) {
    writeError(`远程工具未配置：缺少环境变量 ${tools.missing.join(', ')}`);
    write('设置这些环境变量后重试；它们不会写入任何配置文件。');
    return;
  }

  write('');
  write('目标已确认，但远程查询尚未启用：');
  write('  桥接脚本还未在真实环境验证目标身份、终端回显与取消语义。');
  write('  在验证完成前不会建立连接，避免在错误机器上取证。');
  write(`  traceId 已接收（长度 ${parsed.traceId.length}），仅在本地保存，不发送给模型。`);
}

/** 解析 /trace 的参数；只接受 --host。 */
function parseTraceInput(
  input: string,
): { ok: true; traceId: string; targetHost?: string } | { ok: false; error: string } {
  const tokens = input.split(/\s+/).slice(1);
  const traceId = tokens[0];
  if (traceId === undefined || traceId === '') {
    return { ok: false, error: '用法：/trace <traceId> [--host <目标>]' };
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(traceId)) {
    return { ok: false, error: 'traceId 只能包含字母、数字、下划线与连字符' };
  }

  let targetHost: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== '--host') {
      return { ok: false, error: `未知参数：${token}` };
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      return { ok: false, error: '--host 缺少取值' };
    }
    targetHost = value;
    index += 1;
  }

  return { ok: true, traceId, ...(targetHost === undefined ? {} : { targetHost }) };
}


/** 按宽度截断，避免状态行换行破坏输入框布局。 */
function clipLine(text: string, width: number): string {
  if (!Number.isFinite(width) || text.length <= width) {
    return text;
  }
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * 压缩工作目录显示。
 *
 * 完整路径通常过长，会把分支与会话挤出状态行。
 * 规则：home 替换为 ~；仍超过 32 字符时只保留最后两段。
 */
function shortenPath(target: string): string {
  const home = process.env['HOME'];
  let display = home !== undefined && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
  if (display.length <= 32) {
    return display;
  }
  const parts = display.split('/').filter((part) => part !== '');
  display = `…/${parts.slice(-2).join('/')}`;
  return display;
}

/** 读取当前 Git 分支名；失败时回退到短提交号，仍不可用则 unknown。 */
async function readGitBranch(cwd: string): Promise<string> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 3_000,
    });
    const name = stdout.trim();
    return name === '' ? 'unknown' : name;
  } catch {
    return 'unknown';
  }
}

/** 运行交互循环，直到用户退出或输入结束。 */
export async function runRepl(options: ReplOptions): Promise<number> {
  const { composition } = options;
  // UI 激活时先擦除输入块再输出，避免文字插进边框中间。
  const write = (line: string): void => {
    if (ui !== undefined) {
      ui.print(line);
      return;
    }
    options.write(line);
  };
  // 错误同样先擦除输入块再输出，否则会插进红框中间。
  const writeError = (line: string): void => {
    if (ui !== undefined) {
      ui.print(`\x1b[31m${line}\x1b[0m`);
      return;
    }
    options.writeError(line);
  };
  const { diagnosis, runner } = composition;

  // 交互终端使用自定义聊天界面；非 TTY 回退到普通 readline，
  // 保证管道、脚本与测试仍可工作。
  const ui = ChatUI.isSupported(process.stdin, process.stdout)
    ? new ChatUI(process.stdout, process.stdin, COMMANDS)
    : undefined;
  const rl = ui === undefined
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
    : undefined;
  let closing = false;

  // 会话级 raw 模式：避免模型执行期间按键被缓冲成字面量。
  if (ui !== undefined) {
    ui.begin();
    // 模型执行中按 Ctrl+C 中止当前轮次，而不是退出程序。
    ui.onInterrupt(() => {
      void composition.runner.abort();
    });
  }

  // 状态行所需的稳定信息；模型与思考等级会随命令变化，单独求值。
  const cwd = process.cwd();
  const version = options.paths === undefined
    ? { commit: 'unknown', dirty: false }
    : await readRepositoryVersion(cwd).catch(() => ({ commit: 'unknown', dirty: false }));
  // 状态行显示分支名而不是提交号：分支对"当前在哪条线上排障"更有意义。
  const branch = await readGitBranch(cwd);

  // 会话事件只写脱敏摘要；stateDir 缺失时静默跳过，不影响诊断。
  const sessionId = options.resumeSessionId ?? createSessionId();
  // 最近一次诊断的脱敏输出；/knowledge save 用它作为候选正文，
  // 不重新调用模型，也不读取未经脱敏的原始内容。
  let lastDiagnosis = '';
  let eventSeq = 0;
  const record = async (
    type: Parameters<typeof appendEvent>[2]['type'],
    payload: Record<string, string | number>,
  ): Promise<void> => {
    if (options.stateDir === undefined) {
      return;
    }
    eventSeq += 1;
    await appendEvent(options.stateDir, sessionId, {
      seq: eventSeq,
      at: new Date().toISOString(),
      type,
      payload,
    }).catch(() => undefined);
  };
  await record('session.start', { remote: options.remoteStatus });

  const status = (width?: number): string =>
    renderStatusLine({
      remoteStatus: options.remoteStatus,
      remainingMs: diagnosis.budget.remainingMs(),
      totalMs: diagnosis.budget.snapshot().totalMs,
      evidenceCount: diagnosis.evidence.all().length,
      model: `${composition.currentModel.provider}/${composition.currentModel.modelId}`,
      effort: composition.currentEffort(),
      cwd: shortenPath(cwd),
      branch: version.dirty ? `${branch}*` : branch,
      sessionId: sessionId.slice(-8),
      ...(width === undefined ? {} : { width }),
    });

  // 状态行由输入框下方常驻显示，这里不再重复打印。
  write('输入 / 查看命令，或直接粘贴日志开始诊断。');

  diagnosis.budget.start();
  diagnosis.budget.pause();

  /**
   * 多步命令的追加输入。
   *
   * 复用同一条 readline：既避免第二套输入通道，也保证确认确实来自用户。
   */
  const ask = async (question: string): Promise<string> => {
    if (ui !== undefined) {
      const result = await ui.readLine({ question, status });
      return result.kind === 'line' ? result.text : '';
    }
    return new Promise<string>((resolve) => {
      rl?.question(`${question}\n> `, (answer) => resolve(answer));
    });
  };

  for (;;) {
    let line: string | undefined;
    if (ui !== undefined) {
      const result = await ui.readLine({ status });
      // Ctrl+C / Ctrl+D 取消当前输入；连续取消由用户显式 /exit 处理。
      if (result.kind === 'cancel') {
        continue;
      }
      line = result.text;
    } else {
      line = await new Promise<string | undefined>((resolve) => {
        rl?.question('> ', (answer) => resolve(answer));
        rl?.once('close', () => resolve(undefined));
      });
    }

    if (line === undefined) {
      break;
    }

    const input = line.trim();
    if (input === '') {
      continue;
    }
    if (input === '/exit' || input === '/quit') {
      break;
    }
    if (input === '/help') {
      write(HELP);
      continue;
    }
    if (input === '/status') {
      write(status());
      continue;
    }
    if (input === '/audit') {
      process.stdout.write(diagnosis.audit.render(10));
      continue;
    }
    if (input === '/new') {
      diagnosis.evidence.clear();
      write('已清空证据。注意：这是新的诊断，历史上下文不会被复用。');
      continue;
    }
    if (input.startsWith('/model')) {
      await handleModel(input, options, write, writeError);
      continue;
    }
    if (input.startsWith('/effort')) {
      handleEffort(input, options, write, writeError);
      continue;
    }
    if (input.startsWith('/knowledge')) {
      // 关键：多步问答必须复用主循环的 rl，并同步完成全部读取。
      // 若另开读取通道，后续输入会被主循环当成诊断内容消费掉。
      await handleKnowledge(input, options, write, writeError, lastDiagnosis, ask);
      continue;
    }
    if (input.startsWith('/trace')) {
      // 远程取证涉及真实服务器：连接前必须确认目标，且脚本尚未真实验证。
      // 因此这里只做“解析 + 确认 + 说明”，不擅自发起连接。
      await handleTrace(input, options, write, writeError, lastDiagnosis, ask);
      continue;
    }

    let parsed;
    try {
      parsed = parseUserInput(input, process.env['HOME'] ?? '');
    } catch (error) {
      writeError(error instanceof Error ? error.message : '输入解析失败');
      continue;
    }

    if (parsed.attachments.length > 0) {
      write(
        `已识别 ${parsed.attachments.length} 个附件引用，但当前阶段尚未接入附件读取。` +
          '请改用粘贴方式提供日志。',
      );
      continue;
    }

    if (!diagnosis.budget.canStartWork()) {
      writeError('探查预算已用尽。请使用 /new 开始新诊断，或重启 CLI 获得新预算。');
      continue;
    }

    write('');
    closing = false;
    await record('input.received', {
      attachments: parsed.attachments.length,
      hasTrace: parsed.traceId === undefined ? 0 : 1,
    });
    try {
      lastDiagnosis = '';
      const result = await diagnosis.runTurn(runner, parsed.instruction, (text) => {
        lastDiagnosis += text;
      });
      // 流式输出会撕裂固定布局，因此整轮结束后一次性打印。
      if (lastDiagnosis !== '') {
        write(lastDiagnosis);
      }
      await record('diagnosis.completed', {
        evidenceCount: diagnosis.evidence.all().length,
        aborted: result.aborted ? 1 : 0,
      });

      const unknown = diagnosis.verifyCitations(result.text);
      if (unknown.length > 0) {
        writeError(`注意：回答引用了不存在的证据编号：${unknown.join(', ')}。请谨慎对待相关结论。`);
      }
      if (result.aborted) {
        writeError('本轮已中止。');
      }
    } catch (error) {
      writeError(`本轮失败：${error instanceof Error ? error.message : '未知错误'}`);
      await record('diagnosis.failed', { reason: 'turn error' });
    }

    write('');
    write(status());
  }

  await record('session.close', { events: eventSeq });
  ui?.erase();
  ui?.end();
  if (!closing) {
    rl?.close();
  }
  return 0;
}
