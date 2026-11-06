/**
 * 目标机解析测试。
 *
 * 三级来源的优先级与安全边界：
 * 显式指定 > 日志提取 > 最近使用；显式值非法时直接报错，不静默回退。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resolveAppPaths } from '../../src/config/paths.js';
import { extractHostFromLogs, resolveTarget } from '../../src/remote/target-resolver.js';

/** 构造合法记录头；host 段用于提取。 */
function record(host: string, traceId = 'T1', level = 'INFO'): string {
  return `2026-11-06 15:33:00.007|//|${traceId}|${host}|app|main|${level} |com.x.Y:1|消息`;
}

async function withTempHome(run: (paths: ReturnType<typeof resolveAppPaths>) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), 'finch-target-'));
  try {
    await run(resolveAppPaths(home));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('从日志记录头提取出现次数最多的合法主机', () => {
  const text = [
    record('22.50.14.22'),
    record('22.50.14.22'),
    record('10.80.3.7'),
    record('192.168.1.1'), // 不在允许网段，忽略
  ].join('\n');

  assert.equal(extractHostFromLogs(text), '22.50.14.22');
});

test('消息正文中的 IP 不会被当作主机', () => {
  const text = `2026-11-06 15:33:00.007|//|T1|22.50.14.22|app|main|INFO |com.x.Y:1|下游 10.80.9.9 超时`;
  assert.equal(extractHostFromLogs(text), '22.50.14.22');
});

test('无合法主机时返回 undefined', () => {
  assert.equal(extractHostFromLogs('普通文本，没有记录头'), undefined);
  assert.equal(extractHostFromLogs(record('8.8.8.8')), undefined);
});

test('显式指定的目标优先，且非法值直接报错不回退', async () => {
  await withTempHome(async (paths) => {
    const provided = await resolveTarget({
      paths,
      requested: '10.80.3.7',
      logText: record('22.50.14.22'),
      recentTargets: ['22.50.9.9'],
    });
    assert.equal(provided.source, 'provided');
    assert.equal(provided.host, '10.80.3.7');

    const invalid = await resolveTarget({ paths, requested: '192.168.1.1' });
    assert.equal(invalid.source, 'none');
    assert.equal(invalid.host, undefined);
    assert.match(invalid.reason, /不合法/);
  });
});

test('未指定时优先从日志提取', async () => {
  await withTempHome(async (paths) => {
    const result = await resolveTarget({
      paths,
      logText: record('22.50.14.22'),
      recentTargets: ['10.80.3.7'],
    });
    assert.equal(result.source, 'log');
    assert.equal(result.host, '22.50.14.22');
    assert.match(result.reason, /请确认/);
  });
});

test('无日志时回退到唯一历史目标', async () => {
  await withTempHome(async (paths) => {
    const result = await resolveTarget({
      paths,
      recentTargets: ['10.80.3.7'],
    });
    assert.equal(result.source, 'history');
    assert.equal(result.host, '10.80.3.7');
  });
});

test('多个历史目标时不擅自选择，返回候选', async () => {
  await withTempHome(async (paths) => {
    const result = await resolveTarget({
      paths,
      recentTargets: ['10.80.3.7', '22.50.14.22'],
    });
    assert.equal(result.source, 'history');
    assert.equal(result.host, undefined, '有多个候选时不得自动挑一个');
    assert.deepEqual(result.candidates, ['10.80.3.7', '22.50.14.22']);
  });
});

test('历史中不合法的目标被过滤掉', async () => {
  await withTempHome(async (paths) => {
    const result = await resolveTarget({
      paths,
      recentTargets: ['192.168.1.1', '10.80.3.7'],
    });
    assert.equal(result.host, '10.80.3.7', '过滤后只剩一个，可直接建议');
    assert.deepEqual(result.candidates, ['10.80.3.7']);
  });
});

test('完全没有来源时给出可操作提示', async () => {
  await withTempHome(async (paths) => {
    const result = await resolveTarget({ paths, recentTargets: [] });
    assert.equal(result.source, 'none');
    assert.equal(result.host, undefined);
    assert.match(result.reason, /提供日志|--host/);
  });
});
