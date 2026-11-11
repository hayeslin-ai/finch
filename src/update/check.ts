/**
 * 版本检查的核心逻辑：版本比较、缓存读写、远端查询。
 *
 * WHY 全部做成可注入的纯函数：本功能的价值全在"网络不可用时不添乱"。
 * 只有把 fetch、时钟、状态目录都变成参数，测试才能覆盖
 * 超时、500、畸形 JSON、缓存损坏、跨日 TTL 这些真实故障路径，
 * 而不是只验证"能联网时会提示"。
 */
import { mkdir, readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';

import { atomicWriteFile, fingerprint } from '../config/atomic-write.js';
import { CACHE_FILE_NAME, CHECK_TTL_MS, DISABLE_ENV, FETCH_TIMEOUT_MS } from './source.js';

/**
 * User-Agent。
 *
 * WHY 只写产品名：不写版本、主机名、用户名或任何可识别信息。
 * GitHub 要求带 UA，但不需要全局唯一的标识。
 */
const USER_AGENT = 'finch';

/**
 * 响应体上限。
 *
 * WHY 限长：即使出站目标被 DNS 投毒或代理插页，
 * 也不能让对方把内存吐满。release 响应正常只有几 KB。
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** 缓存文件内容；字段全部可选，缺失按"没有信息"处理而不是报错。 */
export interface UpdateCache {
  /** 上次实际发起请求的时间（ISO 8601）。 */
  readonly checkedAt?: string;
  /** 上次查到的远端版本。 */
  readonly latest?: string;
  /** 用户明确拒绝过的版本；同一版本不再打扰。 */
  readonly skipped?: string;
}

/** 读缓存结果；fingerprint 用于原子写入时的并发校验。 */
export interface CacheSnapshot {
  readonly cache: UpdateCache;
  readonly fingerprint: string;
}

/** 检查结论。 */
export type UpdateOutcome =
  | { readonly kind: 'available'; readonly latest: string }
  | {
      readonly kind: 'none';
      readonly reason: 'up-to-date' | 'skipped' | 'disabled' | 'unknown';
    };

/**
 * 版本查询所需的传输能力。
 *
 * WHY 注入在传输层而不是 fetch 层：真实 CLI 进程里 `globalThis.fetch`
 * 已被 Pi SDK 的 `undici.install()` 接管（响应头全空、不跟随重定向），
 * 所以生产实现必须走 `node:https`。测试需要注入的也是
 * “能拿到 location / 能拿到 JSON”这两件事，而不是某个 fetch 形状。
 */
export interface UpdateTransport {
  /** 发 HEAD 请求，只返回 `location` 头。 */
  headLocation(target: string, timeoutMs: number): Promise<string | null>;
  /** GET 并解析 JSON 正文；非 2xx 返回 null。 */
  getJson(target: string, timeoutMs: number): Promise<unknown>;
}

/**
 * 版本号规整：允许 `v0.4.0` 与 `0.4.0`，其余一律视为非法。
 *
 * WHY 严格到"只认三段数字"：远端 tag 可能被人手滑写成 `v0.4` 或
 * `release-0.4.0`，宽松解析会拿一个错误的版本号去比较，
 * 宁可判定为"没有可用的最新版本"。
 */
export function normalizeVersion(raw: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const [, major, minor, patch, prerelease] = match;
  return prerelease === undefined
    ? `${major ?? '0'}.${minor ?? '0'}.${patch ?? '0'}`
    : `${major ?? '0'}.${minor ?? '0'}.${patch ?? '0'}-${prerelease}`;
}

/**
 * 语义化版本比较。
 *
 * 返回负数表示 a 更旧。预发布版本低于同号正式版（0.4.0-rc.1 < 0.4.0），
 * 这是 semver 的约定，也避免把预发布当成可升级目标。
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a);
  const right = splitVersion(b);
  if (left === null || right === null) {
    // 无法比较时退化为字符串比较，至少保证结果是确定的。
    return a.localeCompare(b);
  }

  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) {
      return diff;
    }
  }

  // 正式版高于预发布版；都有预发布标签时按字典序（semver 的简化实现）。
  if (left.prerelease === undefined && right.prerelease === undefined) {
    return 0;
  }
  if (left.prerelease === undefined) {
    return 1;
  }
  if (right.prerelease === undefined) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease);
}

/** 拆出三段数字与预发布标签；非法返回 null。 */
function splitVersion(
  value: string,
): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const normalized = normalizeVersion(value);
  if (normalized === null) {
    return null;
  }
  const [core, prerelease] = normalized.split('-', 2);
  const parts = (core ?? '').split('.').map((item) => Number.parseInt(item, 10));
  const [major, minor, patch] = parts;
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return prerelease === undefined
    ? { major, minor, patch }
    : { major, minor, patch, prerelease };
}

/** candidate 是否比 current 新。 */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * 从 GitHub 响应体里取最新版本号。
 *
 * 只认 `tag_name`；不出栈其它字段，避免把 draft/prerelease 等
 * 与版本无关的信息带进逻辑。
 */
export function parseLatestRelease(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const tag = (body as { tag_name?: unknown }).tag_name;
  return typeof tag === 'string' ? normalizeVersion(tag) : null;
}

/**
 * 是否需要真正发起请求。
 *
 * checkedAt 缺失、无法解析或已超过 TTL 时返回 true。
 */
export function shouldCheck(
  cache: UpdateCache,
  now: Date,
  ttlMs: number = CHECK_TTL_MS,
): boolean {
  if (cache.checkedAt === undefined) {
    return true;
  }
  const checked = Date.parse(cache.checkedAt);
  if (Number.isNaN(checked)) {
    return true;
  }
  return now.getTime() - checked >= ttlMs;
}

/** 缓存文件路径。 */
export function cacheFilePath(stateDir: string): string {
  return path.join(stateDir, CACHE_FILE_NAME);
}

/**
 * 读取缓存。
 *
 * 不存在、内容损坏、结构不对都返回空缓存——缓存是加速手段，
 * 不是事实来源，读坏了大不了重新查一次，绝不能让启动失败。
 */
export async function readCache(stateDir: string): Promise<CacheSnapshot> {
  const target = cacheFilePath(stateDir);
  let raw: string;
  try {
    raw = await readFile(target, 'utf8');
  } catch {
    return { cache: {}, fingerprint: fingerprint('') };
  }

  const snapshotFingerprint = fingerprint(raw);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { cache: {}, fingerprint: snapshotFingerprint };
    }
    const record = parsed as Record<string, unknown>;
    const cache: UpdateCache = {
      ...(typeof record['checkedAt'] === 'string' ? { checkedAt: record['checkedAt'] } : {}),
      ...(typeof record['latest'] === 'string' ? { latest: record['latest'] } : {}),
      ...(typeof record['skipped'] === 'string' ? { skipped: record['skipped'] } : {}),
    };
    return { cache, fingerprint: snapshotFingerprint };
  } catch {
    return { cache: {}, fingerprint: snapshotFingerprint };
  }
}

/**
 * 写入缓存（合并式）。
 *
 * 并发校验失败直接忽略：另一个进程刚写过一次检查结果，
 * 它的时间戳比我们的新，覆盖没有意义，也不算错误。
 */
export async function writeCache(
  stateDir: string,
  expectedFingerprint: string,
  patch: UpdateCache,
): Promise<void> {
  const current = await readCache(stateDir);
  const merged: UpdateCache = { ...current.cache, ...patch };
  const content = `${JSON.stringify(merged, null, 2)}\n`;
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(cacheFilePath(stateDir), content, expectedFingerprint);
  } catch {
    // 缓存写失败不影响任何用户可见行为，静默放弃。
  }
}

/**
 * 记录"用户跳过此版本"。
 *
 * 失败的写入同样静默：最坏结果是下次启动再提示一次。
 */
export async function markSkipped(stateDir: string, version: string): Promise<void> {
  const { fingerprint: current } = await readCache(stateDir);
  await writeCache(stateDir, current, { skipped: version });
}

/**
 * 查询最新版本。
 *
 * 任何异常（超时、DNS、403、限流、畸形 JSON）都返回 null。
 * 这里不做重试：TTL 已经把重试摊到下一次启动，启动路径上多等一秒都是错的。
 */
/**
 * 从 `releases/latest` 的 302 重定向里取版本。
 *
 * WHY 首选重定向而不是 REST API：api.github.com 未认证限额只有 60 次/小时/IP，
 * 办公网 NAT 下极易打光；打光后所有请求返回 403，功能就静默失效了
 * （实测过：调试期间反复请求后 remaining=0，于是每次都是假阴性）。
 * `github.com/.../releases/latest` 的 302 不消耗 API 额度，
 * `location` 头形如 `.../releases/tag/v0.3.0`，信息量足够。
 */
function parseTagFromLocation(location: string | null): string | null {
  if (location === null) {
    return null;
  }
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(location);
  return match?.[1] === undefined ? null : normalizeVersion(match[1]);
}

/**
 * 查询最新版本。
 *
 * 两条路径按顺序尝试：
 * 1. `github.com` 的 302 重定向（不吃 API 额度）；
 * 2. `api.github.com` 的 REST 接口（备用）。
 *
 * 任何异常（超时、DNS、403、限流、畸形 JSON）都返回 null，
 * 且不重试任何一条：TTL 已经把重试摊到下一次启动。
 */
export async function fetchLatestVersion(options: {
  readonly transport?: UpdateTransport;
  readonly timeoutMs?: number;
} = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const transport = options.transport ?? nodeHttpsTransport;

  // —— 1. 重定向主路径（不吃 API 额度）——
  // 目标主机是编译期字面量，不可能来自运行时数据。
  const htmlTarget = 'https://github.com/hayeslin-ai/finch/releases/latest';
  try {
    const location = await transport.headLocation(htmlTarget, timeoutMs);
    const fromRedirect = parseTagFromLocation(location);
    if (fromRedirect !== null) {
      return fromRedirect;
    }
  } catch {
    // 落到备用路径：某些代理会剥掉 302，或直接把页面返回 200。
  }

  // —— 2. REST 接口备用 ——
  const apiTarget = 'https://api.github.com/repos/hayeslin-ai/finch/releases/latest';
  try {
    const body = await transport.getJson(apiTarget, timeoutMs);
    return body === null ? null : parseLatestRelease(body);
  } catch {
    return null;
  }
}

/**
 * 生产传输层。
 *
 * WHY 不用全局 fetch（真实故障教训）：Pi SDK 导入时会调 `undici.install()`
 * 接管 `globalThis.fetch`；那个 fetch 不跟随重定向、且把响应头全部清空
 * （实测 hdrs=0）。于是“读 location 头”在真实 CLI 进程里 100% 失败，
 * 而用假 fetch 的单测完全发现不了。`node:https` 不经过这个被篡改的全局。
 */
const nodeHttpsTransport: UpdateTransport = {
  headLocation: requestLocationHeader,
  getJson: requestJsonBody,
};

/**
 * 发 HEAD 请求只取 `location` 头。
 *
 * WHY HEAD：版本信息就在 302 的 location 里，不需要下载发布页正文。
 * 目标主机是编译期字面量，且只允许 https，不存在 SSRF 面。
 */
function requestLocationHeader(target: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target,
      { method: 'HEAD', headers: { 'user-agent': USER_AGENT }, timeout: timeoutMs },
      (response: IncomingMessage) => {
        // 必须消费流，否则 socket 不复用、进程可能不退出。
        response.resume();
        const location = response.headers.location;
        resolve(typeof location === 'string' ? location : null);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.end();
  });
}

/**
 * GET 并解析 JSON 正文（限长）。
 *
 * WHY 限长：即使目标会被篡改（DNS 投毒、代理插页），也不让它把内存吐满。
 */
function requestJsonBody(target: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
        timeout: timeoutMs,
      },
      (response: IncomingMessage) => {
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error instanceof Error ? error : new Error('invalid json'));
          }
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.end();
  });
}

/**
 * 检查是否需要提示升级。
 *
 * 顺序刻意如此：
 * 1. 显式关闭优先，连缓存都不读；
 * 2. TTL 内不发请求，离线机器每秒启动也不会反复等待超时；
 * 3. 请求失败时仍沿用旧缓存里的版本，但把 checkedAt 推进到当下，
 *    避免离线机器每次启动都付一次超时代价。
 */
export async function checkForUpdate(options: {
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly now?: Date;
  readonly ttlMs?: number;
  readonly transport?: UpdateTransport;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<UpdateOutcome> {
  const env = options.env ?? process.env;
  if ((env[DISABLE_ENV] ?? '').trim() !== '') {
    return { kind: 'none', reason: 'disabled' };
  }

  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? CHECK_TTL_MS;
  const snapshot = await readCache(options.stateDir);
  let latest = snapshot.cache.latest;

  if (shouldCheck(snapshot.cache, now, ttlMs)) {
    const fetched = await fetchLatestVersion(
      options.transport === undefined ? {} : { transport: options.transport },
    );
    if (fetched === null) {
      // 查询失败：保留已知的远端版本，但推进 checkedAt。
      await writeCache(options.stateDir, snapshot.fingerprint, {
        checkedAt: now.toISOString(),
        ...(latest === undefined ? {} : { latest }),
      });
    } else {
      latest = fetched;
      await writeCache(options.stateDir, snapshot.fingerprint, {
        checkedAt: now.toISOString(),
        latest: fetched,
      });
    }
  }

  if (latest === undefined) {
    return { kind: 'none', reason: 'unknown' };
  }
  if (snapshot.cache.skipped === latest) {
    return { kind: 'none', reason: 'skipped' };
  }
  if (!isNewer(latest, options.currentVersion)) {
    return { kind: 'none', reason: 'up-to-date' };
  }
  return { kind: 'available', latest };
}
