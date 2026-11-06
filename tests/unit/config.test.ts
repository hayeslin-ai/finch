/**
 * 配置解析与路径边界测试。
 *
 * 全部使用临时目录与构造文本，不读取真实用户配置、不访问网络。
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseDotenv } from '../../src/config/dotenv.js';
import { inspectPath, resolveAppPaths } from '../../src/config/paths.js';
import { validateTargetHost } from '../../src/config/target.js';
import { parseLimits } from '../../src/config/limits.js';
import { loadConfig } from '../../src/config/load.js';

/** 建立隔离的临时 home，模拟真实目录结构。 */
async function createTempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'finch-home-'));
}

test('配置路径固定在用户目录，不依赖当前工作目录', async () => {
  const home = await createTempHome();
  try {
    const paths = resolveAppPaths(home);
    assert.equal(paths.configDir, path.join(home, '.config', 'finch'));
    assert.equal(paths.envFile, path.join(paths.configDir, '.env'));
    assert.equal(paths.modelsFile, path.join(paths.configDir, 'models.json'));
    assert.equal(paths.stateDir, path.join(home, '.local', 'state', 'finch'));
    assert.equal(paths.dataDir, path.join(home, '.local', 'share', 'finch'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('过宽权限、符号链接与非普通文件被标记为不安全', async () => {
  const home = await createTempHome();
  try {
    const dir = path.join(home, 'cfg');
    await mkdir(dir);
    await chmod(dir, 0o755);
    assert.equal(inspectPath(dir, 'directory').unsafe, true, '0755 目录必须被判为过宽');

    await chmod(dir, 0o700);
    assert.equal(inspectPath(dir, 'directory').unsafe, false);

    const file = path.join(dir, '.env');
    await writeFile(file, 'A=1\n', { mode: 0o644 });
    assert.equal(inspectPath(file, 'file').unsafe, true, '0644 文件必须被判为过宽');

    await chmod(file, 0o600);
    assert.equal(inspectPath(file, 'file').unsafe, false);

    const link = path.join(dir, 'link.env');
    await symlink(file, link);
    const linkCheck = inspectPath(link, 'file');
    assert.equal(linkCheck.unsafe, true);
    assert.equal(linkCheck.kind, 'symlink');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('.env 只做字面量解析，不展开变量或执行命令', () => {
  const parsed = parseDotenv(
    [
      '# 注释',
      'REPO_ROOT=/repo',
      'export SERVICE_ID=svc',
      'JUMP_PASSWORD="-literal$[exec BAD]`x`#tail"',
      "MFA_SECRET='single quoted'",
      '',
    ].join('\n'),
  );

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.values.get('REPO_ROOT'), '/repo');
  assert.equal(parsed.values.get('SERVICE_ID'), 'svc');
  assert.equal(parsed.values.get('JUMP_PASSWORD'), '-literal$[exec BAD]`x`#tail');
  assert.equal(parsed.values.get('MFA_SECRET'), 'single quoted');
});

test('.env 格式错误只报告行号与原因', () => {
  const parsed = parseDotenv(['BAD LINE', "BROKEN='unclosed", 'OK=1', 'OK=2'].join('\n'));
  assert.equal(parsed.errors.length, 3);
  assert.deepEqual(
    parsed.errors.map((error) => error.line),
    [1, 2, 4],
  );
  assert.ok(parsed.errors.every((error) => !error.reason.includes('unclosed=')));
});

test('目标机只接受两个资产网段的 IPv4 字面量', () => {
  const accepted = ['22.50.14.22', '10.80.3.7', '22.50.0.1', '10.80.255.254'];
  for (const target of accepted) {
    assert.equal(validateTargetHost(target).ok, true, `${target} 应被接受`);
  }

  const rejected = [
    '22.51.1.1',
    '10.81.1.1',
    '192.168.1.1',
    '22.50.1.1.evil',
    '22.50.1.1/../../',
    '22.50.1',
    '22.50.1.1:22',
    'host.example.com',
    '022.50.1.1',
    '0x16.32.1.1',
    '22.50.1.256',
    ' 22.50.1.1',
    '22.50.1.1 ',
    '-22.50.1.1',
    '::1',
  ];
  for (const target of rejected) {
    assert.equal(validateTargetHost(target).ok, false, `${target} 应被拒绝`);
  }
});

test('数值限制越界不夹取，直接报告问题并保留默认值', () => {
  const { limits, issues } = parseLimits(
    new Map([
      ['QUERY_TIMEOUT_MS', '5'],
      ['MAX_FILES', 'abc'],
      ['MAX_RESULT_LINES', '3000'],
      ['DIAGNOSIS_TIMEOUT_MS', '120000'],
    ]),
  );

  assert.equal(issues.length, 2, '越界与非法格式各算一个问题');
  assert.equal(limits.QUERY_TIMEOUT_MS, 15_000, '越界值必须回落到默认值');
  assert.equal(limits.MAX_FILES, 10);
  assert.equal(limits.MAX_RESULT_LINES, 3_000, '合法值应被采用');
  assert.equal(limits.DIAGNOSIS_TIMEOUT_MS, 120_000);
});

test('单条查询时限等于总预算是允许的，超出才拒绝', () => {
  // 当前取值范围（单查询上限 60s、总预算下限 60s）保证“查询 > 总预算”不可达，
  // 该约束是防御性的：未来放宽范围时必须仍然生效。
  const equal = parseLimits(
    new Map([
      ['DIAGNOSIS_TIMEOUT_MS', '60000'],
      ['QUERY_TIMEOUT_MS', '60000'],
    ]),
  );
  assert.equal(equal.issues.length, 0, '相等不应被判定为问题');
});

test('缺少远程配置时本地可用、远程不可用', async () => {
  const home = await createTempHome();
  try {
    const paths = resolveAppPaths(home);
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.envFile,
      ['REPO_ROOT=/repo', 'SERVICE_ID=svc', 'MODEL_PROVIDER=p', 'MODEL_ID=m'].join('\n'),
      { mode: 0o600 },
    );

    const config = await loadConfig(paths);
    assert.equal(config.available.base, true);
    assert.equal(config.available.local, true, '本地诊断不应被远程配置缺失阻断');
    assert.equal(config.available.remote, false);
    assert.ok(
      config.issues.some((issue) => issue.group === 'remote' && issue.key === 'JUMP_USER'),
      '应明确指出缺失的远程配置键',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('配置目录不存在时给出可操作提示而非异常', async () => {
  const home = await createTempHome();
  try {
    const config = await loadConfig(resolveAppPaths(home));
    assert.equal(config.available.local, false);
    assert.ok(config.issues.some((issue) => issue.key.includes('finch')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('拒绝读取不安全的 .env（过宽权限）', async () => {
  const home = await createTempHome();
  try {
    const paths = resolveAppPaths(home);
    await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
    await writeFile(paths.envFile, 'REPO_ROOT=/repo\n', { mode: 0o644 });

    const config = await loadConfig(paths);
    assert.equal(config.values.size, 0, '不安全文件不得被解析');
    assert.ok(config.issues.some((issue) => issue.reason.includes('不安全')));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
