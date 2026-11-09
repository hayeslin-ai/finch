/**
 * 诊断运行时与工具测试（完全离线）。
 *
 * WHY：这是首次把 P2 能力接入 SDK 的地方，最容易出现三类问题：
 * 1. 默认工具或资源被发现并启用。
 * 2. 工具绕过路径与预算校验。
 * 3. 工具输出未经脱敏就进入模型上下文。
 *
 * 这里直接调用工具定义与运行时构造，不发起任何模型请求、不访问网络。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createDiagnosisRuntime } from '../../src/agent/runtime.js';
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION, renderUserTurn } from '../../src/agent/system-prompt.js';
import { createReadOnlyTools, type ToolContext } from '../../src/agent/tools.js';
import { EvidenceStore } from '../../src/core/evidence.js';
import { parseLimits } from '../../src/config/limits.js';
import { authorizeAttachment } from '../../src/logs/local.js';
import { openRepository } from '../../src/repository/read.js';
import { Redactor } from '../../src/security/redactor.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 准备最小仓库、日志与工具上下文。 */
async function prepareContext(): Promise<{
  home: string;
  context: ToolContext;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-agent-'));
  const repoRoot = path.join(home, 'repo');
  await mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await writeFile(
    path.join(repoRoot, 'src', 'Service.java'),
    ['class Service {', '  void run() { throw new IllegalStateException("boom"); }', '}'].join('\n'),
  );
  await writeFile(path.join(repoRoot, '.env'), 'TOKEN=IllegalStateException\n');

  const logFile = path.join(home, 'app.log');
  await writeFile(
    logFile,
    [
      '2026-11-06 15:33:00.007|//|T1|22.50.0.1|app|main|INFO |com.x.Y:1|开始',
      '2026-11-06 15:33:01.007|//|T1|22.50.0.1|app|main|ERROR |com.x.Y:2|失败 password=secret123',
    ].join('\n'),
  );

  const repository = await openRepository(repoRoot);
  assert.ok(!('error' in repository));

  const attachment = await authorizeAttachment(logFile);
  assert.ok(!('error' in attachment));

  return {
    home,
    context: {
      repository,
      evidence: new EvidenceStore(),
      redactor: new Redactor(),
      attachments: new Map([['att-1', attachment]]),
      limits: parseLimits(new Map()).limits,
      canWork: () => true,
    },
    cleanup: async () => rm(home, { recursive: true, force: true }),
  };
}

/**
 * 直接调用工具定义，不经过模型。
 * 使用宽松的函数签名：测试只关心返回的文本内容，
 * 不需要复刻 SDK 的完整泛型约束。
 */
type CallableTool = {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

async function callTool(
  tool: unknown,
  params: unknown,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const callable = tool as CallableTool;
  return callable.execute('test-call', params, undefined, undefined, undefined);
}

test('系统提示词包含只读边界、证据规则与注入防护', () => {
  assert.equal(typeof SYSTEM_PROMPT_VERSION, 'string');
  for (const keyword of ['绝对边界', '证据规则', '分析顺序', '输出格式', '注入防护']) {
    assert.ok(SYSTEM_PROMPT.includes(keyword), `系统提示词缺少 ${keyword}`);
  }
  assert.ok(SYSTEM_PROMPT.includes('最后一个 ERROR'), '必须体现末尾错误锚点规则');
  assert.ok(!SYSTEM_PROMPT.includes('{{'), '系统提示词不得含未替换的模板占位');
});

test('用户轮次把日志放进 evidence，而不是并入 request', () => {
  const turn = renderUserTurn({
    instruction: '分析这段报错',
    scope: ['repo=demo-service', 'target=22.50.0.1'],
    evidence: [
      { id: 'EV-001', sourceKind: 'paste', sourceLabel: '粘贴', text: 'java.lang.IllegalStateException' },
    ],
  });

  assert.match(turn, /<request>[\s\S]*分析这段报错[\s\S]*<\/request>/);
  assert.match(turn, /<evidence id="EV-001" source="paste"/);
  assert.ok(
    turn.indexOf('<evidence') > turn.indexOf('</request>'),
    '日志必须位于 request 之后，不能混入指令',
  );
});

test('source_search 命中源码并生成证据', async () => {
  const { context, cleanup } = await prepareContext();
  try {
    const [search] = createReadOnlyTools(context);
    assert.ok(search !== undefined);

    const result = await callTool(search, { terms: ['IllegalStateException'] });
    const text = result.content[0]?.text ?? '';

    assert.match(text, /EV-\d{3}/);
    assert.match(text, /Service\.java/);
    assert.equal(context.evidence.all().length, 1);
    assert.ok(!text.includes('.env'), '凭证文件不得出现在检索结果中');
  } finally {
    await cleanup();
  }
});

test('工具输出经过脱敏后才成为证据', async () => {
  const { context, cleanup } = await prepareContext();
  try {
    const tools = createReadOnlyTools(context);
    const localSearch = tools[2];
    assert.ok(localSearch !== undefined);

    const result = await callTool(localSearch, { attachmentId: 'att-1', terms: ['失败'] });
    const text = result.content[0]?.text ?? '';
    const evidenceText = context.evidence.all()[0]?.text ?? '';

    assert.ok(!text.includes('secret123'), '工具输出不得包含原始密码');
    assert.ok(!evidenceText.includes('secret123'), '证据不得包含原始密码');
  } finally {
    await cleanup();
  }
});

test('未知附件编号被拒绝，不读取任何文件', async () => {
  const { context, cleanup } = await prepareContext();
  try {
    const localSearch = createReadOnlyTools(context)[2];
    assert.ok(localSearch !== undefined);

    const result = await callTool(localSearch, { attachmentId: 'att-999', terms: ['失败'] });
    assert.match(result.content[0]?.text ?? '', /未知的附件编号/);
    assert.equal(context.evidence.all().length, 0);
  } finally {
    await cleanup();
  }
});

test('预算用尽后工具拒绝执行', async () => {
  const { context, cleanup } = await prepareContext();
  try {
    const exhausted: ToolContext = { ...context, canWork: () => false };
    const search = createReadOnlyTools(exhausted)[0];
    assert.ok(search !== undefined);

    const result = await callTool(search, { terms: ['IllegalStateException'] });
    assert.match(result.content[0]?.text ?? '', /预算已用尽/);
    assert.equal(exhausted.evidence.all().length, 0, '拒绝时不得产生证据');
  } finally {
    await cleanup();
  }
});

test('单次源码读取超过 400 行被拒绝', async () => {
  const { context, cleanup } = await prepareContext();
  try {
    const read = createReadOnlyTools(context)[1];
    assert.ok(read !== undefined);

    const result = await callTool(read, { relativePath: 'src/Service.java', startLine: 1, endLine: 500 });
    assert.match(result.content[0]?.text ?? '', /400 行/);
  } finally {
    await cleanup();
  }
});

test('工具白名单不能为空数组，否则自定义工具也会被禁用', async () => {
  // 真实联调中发现的陷阱：SDK 的 tools 是启用白名单，
  // 传 [] 会把 customTools 一并禁用，模型会报告“没有可用工具”。
  // 这里用静态检查固定约束，避免回归。
  const source = await readFile(
    path.join(repositoryRoot, 'src', 'agent', 'runtime.ts'),
    'utf8',
  );
  assert.ok(
    source.includes('tools: options.tools.map((tool) => tool.name)'),
    '运行时必须显式列出自定义工具名作为启用白名单',
  );
  assert.ok(
    source.includes("excludeTools: ['read', 'write', 'edit', 'bash'"),
    '必须显式排除 SDK 内置工具',
  );
});

test('运行时拒绝不存在的模型，不静默回退', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-runtime-'));
  try {
    const modelsPath = path.join(home, 'models.json');
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          p: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-responses', apiKey: 'k', models: [{ id: 'm', name: 'm' }] },
        },
      }),
    );

    await assert.rejects(
      () =>
        createDiagnosisRuntime({
          agentDir: home,
          cwd: home,
          modelsPath,
          providerId: 'p',
          modelId: 'does-not-exist',
          apiKey: 'k',
          tools: [],
          redactor: new Redactor(),
        }),
      /模型不存在/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
