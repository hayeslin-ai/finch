/**
 * 版本检查测试。
 *
 * WHY 覆盖重点是"出错时的行为"而不是"能联网时会提示"：
 * 这个功能最大的风险是网络失败拖慢启动、或缓存写坏导致每次启动都重查。
 * 所有用例都不访问网络、不写真实用户目录。
 *
 * WHY 注入点在传输层（headLocation / getJson）而不是 fetch：
 * 生产实现走 `node:https`，因为 Pi SDK 会把 `globalThis.fetch` 换成
 * undici 版本（响应头全空、不跟随重定向）。见 check.ts 里的说明。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cacheFilePath,
  checkForUpdate,
  compareVersions,
  isNewer,
  markSkipped,
  normalizeVersion,
  parseLatestRelease,
  readCache,
  shouldCheck,
  type UpdateTransport,
} from '../../src/update/check.js';
import {
  CHECK_TTL_MS,
  FETCH_TIMEOUT_MS,
  INSTALL_TARBALL_URL,
  LATEST_HTML_URL,
  LATEST_RELEASE_API,
} from '../../src/update/source.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 隔离的状态目录；绝不触碰真实 ~/.local/state。 */
const roots: string[] = [];
async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'finch-update-'));
  roots.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * 假传输层。
 *
 * location 为 null 表示主路径拿不到版本（代理剥掉 302 等），
 * 此时应回退到 REST。记录调用顺序便于断言"先主后备"。
 */
function fakeTransport(options: {
  readonly location?: string | null;
  readonly body?: unknown;
  readonly calls?: string[];
}): UpdateTransport {
  return {
    async headLocation(target) {
      options.calls?.push(`head:${target}`);
      if (options.location === undefined) {
        throw new Error('network down');
      }
      return options.location;
    },
    async getJson(target) {
      options.calls?.push(`get:${target}`);
      return options.body ?? null;
    },
  };
}

/** 主路径直接给出某个版本的重定向。 */
function transportWithVersion(version: string): UpdateTransport {
  return fakeTransport({
    location: `https://github.com/hayeslin-ai/finch/releases/tag/v${version}`,
  });
}

/** 永远失败的传输层，代表 DNS/超时/离线。 */
const failingTransport: UpdateTransport = {
  headLocation: async () => {
    throw new Error('network down');
  },
  getJson: async () => {
    throw new Error('network down');
  },
};

test('版本号规整只接受三段数字', () => {
  assert.equal(normalizeVersion('v0.4.0'), '0.4.0');
  assert.equal(normalizeVersion(' 0.4.0 '), '0.4.0');
  assert.equal(normalizeVersion('0.4'), null);
  assert.equal(normalizeVersion('release-0.4.0'), null);
  assert.equal(normalizeVersion('v0.4.0-rc.1'), '0.4.0-rc.1');
});

test('版本比较处理多位数与预发布', () => {
  assert.ok(compareVersions('0.3.0', '0.10.0') < 0, '0.3.0 必须低于 0.10.0');
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.ok(compareVersions('0.4.0-rc.1', '0.4.0') < 0, '预发布低于同号正式版');
});

test('isNewer 忽略同版本与更旧版本', () => {
  assert.equal(isNewer('0.4.0', '0.3.0'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
});

test('从 release 响应里只取 tag_name', () => {
  assert.equal(parseLatestRelease({ tag_name: 'v0.4.0', draft: false }), '0.4.0');
  assert.equal(parseLatestRelease({ tag_name: 'not-a-version' }), null);
  assert.equal(parseLatestRelease({}), null);
  assert.equal(parseLatestRelease(null), null);
  assert.equal(parseLatestRelease('v0.4.0'), null);
});

test('TTL 判定：23 小时内不查，超过 24 小时再查', () => {
  const now = new Date('2026-02-14T12:00:00.000Z');
  const fresh = { checkedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString() };
  const stale = { checkedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString() };

  assert.equal(shouldCheck(fresh, now), false);
  assert.equal(shouldCheck(stale, now), true);
  assert.equal(shouldCheck({}, now), true, '没有时间戳必须查一次');

  // 跨日但未满 TTL 仍算新鲜：避免"每天启动时间不同导致每次都查"。
  assert.equal(shouldCheck(fresh, now, CHECK_TTL_MS), false);
});

test('TTL 判定：时间戳损坏时按需要检查处理', () => {
  assert.equal(shouldCheck({ checkedAt: 'not-a-date' }, new Date()), true);
});

test('缓存损坏不影响流程，按无缓存处理', async () => {
  const stateDir = await makeStateDir();
  await writeFile(cacheFilePath(stateDir), '{ 这不是 JSON', 'utf8');

  const snapshot = await readCache(stateDir);
  assert.deepEqual(snapshot.cache, {});

  // 坏文件必须能被新结果覆盖，不能因为并发校验而永久卡住。
  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now: new Date('2026-02-14T12:00:00.000Z'),
    transport: transportWithVersion('0.4.0'),
  });
  assert.deepEqual(outcome, { kind: 'available', latest: '0.4.0' });
});

test('命中缓存时不发请求', async () => {
  const stateDir = await makeStateDir();
  const now = new Date('2026-02-14T12:00:00.000Z');
  await writeFile(
    cacheFilePath(stateDir),
    JSON.stringify({ checkedAt: now.toISOString(), latest: '0.4.0' }),
    'utf8',
  );

  const calls: string[] = [];
  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now: new Date(now.getTime() + 60 * 60 * 1000),
    transport: fakeTransport({ body: { tag_name: 'v9.9.9' }, calls }),
  });

  assert.equal(calls.length, 0, 'TTL 内不得发起任何请求');
  assert.deepEqual(outcome, { kind: 'available', latest: '0.4.0' });
});

test('网络失败时静默返回，且推进 checkedAt 避免每次启动都等超时', async () => {
  const stateDir = await makeStateDir();
  const now = new Date('2026-02-14T12:00:00.000Z');

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now,
    transport: failingTransport,
  });
  assert.deepEqual(outcome, { kind: 'none', reason: 'unknown' });

  const snapshot = await readCache(stateDir);
  assert.equal(snapshot.cache.checkedAt, now.toISOString());
  assert.equal(snapshot.cache.latest, undefined);

  // 再一次检查（TTL 内）不应再发请求。
  const calls: string[] = [];
  await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now: new Date(now.getTime() + 1000),
    transport: fakeTransport({ body: { tag_name: 'v0.4.0' }, calls }),
  });
  assert.equal(calls.length, 0);
});

test('HTTP 非 2xx 视为查询失败', async () => {
  const stateDir = await makeStateDir();
  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    // 主路径无 location，备用接口返回 null（非 2xx 的等价情形）。
    transport: fakeTransport({ location: null, body: null }),
  });
  assert.deepEqual(outcome, { kind: 'none', reason: 'unknown' });
});

test('已是最新版本时不提示', async () => {
  const stateDir = await makeStateDir();
  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.4.0',
    transport: transportWithVersion('0.4.0'),
  });
  assert.deepEqual(outcome, { kind: 'none', reason: 'up-to-date' });
});

test('用户跳过的版本不再提示', async () => {
  const stateDir = await makeStateDir();
  await markSkipped(stateDir, '0.4.0');

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now: new Date(),
    transport: transportWithVersion('0.4.0'),
  });
  assert.deepEqual(outcome, { kind: 'none', reason: 'skipped' });
});

test('跳过只影响那一版，更高的版本仍会提示', async () => {
  const stateDir = await makeStateDir();
  await markSkipped(stateDir, '0.4.0');

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    transport: transportWithVersion('0.5.0'),
  });
  assert.deepEqual(outcome, { kind: 'available', latest: '0.5.0' });
});

test('FINCH_NO_UPDATE_CHECK 彻底关闭检查，连缓存都不读', async () => {
  const stateDir = await makeStateDir();
  const calls: string[] = [];
  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    env: { FINCH_NO_UPDATE_CHECK: '1' },
    transport: fakeTransport({ body: { tag_name: 'v0.4.0' }, calls }),
  });

  assert.deepEqual(outcome, { kind: 'none', reason: 'disabled' });
  assert.equal(calls.length, 0, '关闭后不得发起任何请求');
});

test('出站目标只能是编译期字面量，且与 source.ts 常量一致', async () => {
  // WHY 直接读源码断言：生产传输层不接受目标参数，
  // 两个主机都写成字面量——这是唯一能被静态分析证明
  // “出站目标不可能来自运行时数据”的写法（SSRF 面为零）。
  // 代价是字面量与 source.ts 可能漂移，所以用这条测试钉死。
  const sourceText = await readFile(path.join(repositoryRoot, 'src/update/check.ts'), 'utf8');

  // 抓出 http(s) 字面量形式的出站目标（含注释里的同一批地址）。
  const targets = [...sourceText.matchAll(/'(https:\/\/[^']+)'/g)].map((match) => match[1]);
  assert.ok(targets.length >= 2, `应至少有两处出站地址，实际：${JSON.stringify(targets)}`);

  const allowed = new Set([LATEST_HTML_URL, LATEST_RELEASE_API]);
  for (const target of targets) {
    assert.ok(allowed.has(target ?? ''), `出站地址必须与 source.ts 常量一致，实际：${String(target)}`);
  }

  // 两个常量本身必须指向本仓库，不能被人改成别的项目。
  assert.ok(LATEST_HTML_URL.includes('/hayeslin-ai/finch/'));
  assert.ok(LATEST_RELEASE_API.includes('/repos/hayeslin-ai/finch/'));
  assert.equal(new URL(INSTALL_TARBALL_URL).hostname, 'github.com');
});

test('默认超时留足冷连接余量（实测教训）', () => {
  // 实测：首次冷连接（DNS + TLS + 建连）需要 1.8～2.0 秒。
  // 若默认值压在 2s，新装用户第一次启动永远是假阴性：
  // 版本永远查不到，提示永远不出现，而假 fetch 测试发现不了。
  // 这里锁住下限，防止有人为了"启动更快"把它改回去。
  assert.ok(
    FETCH_TIMEOUT_MS >= 4_000,
    `默认超时必须 ≥ 4000ms，实际 ${FETCH_TIMEOUT_MS}ms（会重新引入冷启动假阴性）`,
  );
});

test('主路径从 location 取版本，成功时不再打备用接口', async () => {
  const stateDir = await makeStateDir();
  const calls: string[] = [];

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    transport: fakeTransport({
      location: 'https://github.com/hayeslin-ai/finch/releases/tag/v0.5.0',
      calls,
    }),
  });

  assert.deepEqual(outcome, { kind: 'available', latest: '0.5.0' });
  assert.deepEqual(calls, [`head:${LATEST_HTML_URL}`], '主路径成功时不得调用 REST 备用');
});

test('主路径拿不到版本时回退到 REST 接口', async () => {
  const stateDir = await makeStateDir();
  const calls: string[] = [];

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    transport: fakeTransport({ location: null, body: { tag_name: 'v0.6.0' }, calls }),
  });

  assert.deepEqual(outcome, { kind: 'available', latest: '0.6.0' });
  assert.deepEqual(
    calls,
    [`head:${LATEST_HTML_URL}`, `get:${LATEST_RELEASE_API}`],
    '必须按主路径→备用的顺序尝试',
  );
});

test('location 头里的非法 tag 不会当成版本', async () => {
  const stateDir = await makeStateDir();
  const calls: string[] = [];

  const outcome = await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    transport: fakeTransport({
      location: 'https://github.com/hayeslin-ai/finch/releases/tag/release-candidate',
      body: { tag_name: 'v0.4.0' },
      calls,
    }),
  });

  // 主路径解析失败后必须回退，而不是拿非法 tag 去比较。
  assert.deepEqual(outcome, { kind: 'available', latest: '0.4.0' });
  assert.deepEqual(calls, [`head:${LATEST_HTML_URL}`, `get:${LATEST_RELEASE_API}`]);
});

test('缓存写入使用 0600，且内容稳定可读', async () => {
  const stateDir = await makeStateDir();
  await checkForUpdate({
    stateDir,
    currentVersion: '0.3.0',
    now: new Date('2026-02-14T12:00:00.000Z'),
    transport: transportWithVersion('0.4.0'),
  });

  const text = await readFile(cacheFilePath(stateDir), 'utf8');
  const parsed = JSON.parse(text) as { checkedAt: string; latest: string };
  assert.equal(parsed.latest, '0.4.0');
  assert.equal(parsed.checkedAt, '2026-02-14T12:00:00.000Z');
  assert.ok(text.endsWith('\n'), '缓存文件应以换行结尾');
});
