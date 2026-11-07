/**
 * 发布级别判定与版本回写测试（Spec 4.1.1）。
 *
 * WHY：版本号直接决定 tag 与对外发布物，写错一次就会产生不可回收的 Release；
 * 判定规则与回写必须离线可测，不能只靠 CI 跑通一次就算验证过。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  bumpVersion,
  decideRelease,
  detectLevel,
  formatVersion,
  parseLevelInput,
  parseVersion,
} from '../../scripts/release/semver.js';
import { runReleaseCli } from '../../scripts/release/cli.js';

/** 构造一个最小可用仓库工作区，用于验证回写行为。 */
async function makeWorkspace(version: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'finch-release-'));
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'finch', version, bin: { finch: 'dist/src/cli/main.js' } }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, 'npm-shrinkwrap.json'),
    `${JSON.stringify(
      { name: 'finch', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'finch', version } } },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'src/version.ts'),
    `export const PACKAGE_NAME = 'finch';\n\nexport const VERSION = '${version}';\n`,
    'utf8',
  );
  return root;
}

test('标题判级覆盖级别表每一行', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['fix: 修复预算计时', 'patch'],
    ['fix(cli): 修复残留进程', 'patch'],
    ['perf: 减少全仓扫描', 'patch'],
    ['feat: 增加附件解析', 'minor'],
    ['feat(trace): 支持 gz 日志', 'minor'],
    ['BREAKING CHANGE: 移除旧参数', 'major'],
    ['BREAKING-CHANGE: 移除旧参数', 'major'],
    ['feat!: 重写会话格式', 'major'],
    ['fix(cli)!: 改退出码', 'major'],
    ['docs: 补说明', undefined],
    ['chore: 升级依赖', undefined],
    ['refactor: 拆分模块', undefined],
    ['test: 补测试', undefined],
    ['ci: 调整工作流', undefined],
    ['build: 调整产物', undefined],
    ['style: 格式化', undefined],
    ['Feat: 大写类型不算', undefined],
    ['更新文档', undefined],
    ['', undefined],
  ];

  for (const [title, expected] of cases) {
    assert.equal(detectLevel(title), expected, `标题 ${JSON.stringify(title)} 应判为 ${String(expected)}`);
  }
});

test('破坏性标记优先于 feat 与 fix', () => {
  assert.equal(detectLevel('feat: 新能力（BREAKING CHANGE: 老参数移除）'), 'major');
  assert.equal(detectLevel('fix!: 恢复语义'), 'major');
});

test('按级别升版本，高位升级时低位归零', () => {
  assert.equal(bumpVersion('1.0.0', 'patch'), '1.0.1');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  // 0.x 不做特殊语义：按级别字面执行，0.1.0 遇 major 即 1.0.0。
  assert.equal(bumpVersion('0.1.0', 'major'), '1.0.0');
  assert.equal(bumpVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
});

test('版本解析拒绝前缀、缺段与预发布标记', () => {
  assert.deepEqual(parseVersion(' 1.2.3 '), { major: 1, minor: 2, patch: 3 });
  assert.equal(formatVersion({ major: 1, minor: 2, patch: 3 }), '1.2.3');
  for (const invalid of ['v1.0.0', '1.0', '01.0.0', '1.0.0-beta', '1..0', '']) {
    assert.throws(() => parseVersion(invalid), /版本号必须形如/, `应拒绝 ${JSON.stringify(invalid)}`);
  }
});

test('跳过发版时版本号原样保留并给出原因', () => {
  const decision = decideRelease('0.1.0', 'chore: 清理注释');
  assert.equal(decision.release, false);
  assert.equal(decision.version, '0.1.0');
  assert.match(decision.reason, /跳过发版/);

  const released = decideRelease('0.1.0', 'feat: 新能力');
  assert.equal(released.release, true);
  assert.equal(released.release ? released.level : '', 'minor');
  assert.equal(released.version, '0.2.0');
});

test('手动级别入参只接受四值', () => {
  assert.equal(parseLevelInput('none'), 'none');
  assert.equal(parseLevelInput(' patch '), 'patch');
  assert.throws(() => parseLevelInput('Patch'), /level 只能是/);
});

test('plan 模式把结果写入 GITHUB_OUTPUT', async () => {
  const root = await makeWorkspace('0.1.0');
  const outputFile = path.join(root, 'github-output.txt');
  try {
    const code = await runReleaseCli(['plan', '--root', root, '--title', 'feat: 增加能力', '--output', outputFile]);
    assert.equal(code, 0);
    const written = await readFile(outputFile, 'utf8');
    assert.match(written, /^release=true$/m);
    assert.match(written, /^level=minor$/m);
    assert.match(written, /^version=0\.2\.0$/m);
    assert.match(written, /^current=0\.1\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan 模式未知标题输出 release=false 且退出码为 0', async () => {
  const root = await makeWorkspace('0.1.0');
  const outputFile = path.join(root, 'github-output.txt');
  try {
    const code = await runReleaseCli(['plan', '--root', root, '--title', 'docs: 补文档', '--output', outputFile]);
    assert.equal(code, 0, '跳过发版不是错误，退出码必须为 0');
    const written = await readFile(outputFile, 'utf8');
    assert.match(written, /^release=false$/m);
    assert.match(written, /^version=0\.1\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan 模式手动 level=none 按当前版本原样发版', async () => {
  const root = await makeWorkspace('0.1.0');
  const outputFile = path.join(root, 'github-output.txt');
  try {
    const code = await runReleaseCli(['plan', '--root', root, '--level', 'none', '--output', outputFile]);
    assert.equal(code, 0);
    const written = await readFile(outputFile, 'utf8');
    assert.match(written, /^release=true$/m);
    assert.match(written, /^level=none$/m);
    assert.match(written, /^version=0\.1\.0$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan 模式缺少标题与级别时按用法错误退出', async () => {
  const root = await makeWorkspace('0.1.0');
  try {
    assert.equal(await runReleaseCli(['plan', '--root', root]), 2);
    assert.equal(await runReleaseCli(['plan', '--root', root, '--title', 'fix: x', '--bogus', 'y']), 2);
    assert.equal(await runReleaseCli(['nope', '--root', root]), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply 模式同时回写 manifest、shrinkwrap 与源码常量', async () => {
  const root = await makeWorkspace('0.1.0');
  try {
    const code = await runReleaseCli(['apply', '--root', root, '--version', '0.2.0']);
    assert.equal(code, 0);

    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const shrinkwrap = JSON.parse(await readFile(path.join(root, 'npm-shrinkwrap.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    const source = await readFile(path.join(root, 'src/version.ts'), 'utf8');

    assert.equal(manifest.version, '0.2.0');
    assert.equal(shrinkwrap.version, '0.2.0');
    assert.equal(shrinkwrap.packages['']?.version, '0.2.0', 'shrinkwrap 的 packages[""] 也要同步');
    assert.match(source, /^export const VERSION = '0\.2\.0';$/m);
    assert.match(source, /^export const PACKAGE_NAME = 'finch';$/m, '其他常量不得被改动');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply 模式在源码缺少版本常量时拒绝盲写', async () => {
  const root = await makeWorkspace('0.1.0');
  try {
    await writeFile(path.join(root, 'src/version.ts'), `export const VERSION_ALIAS = '0.1.0';\n`, 'utf8');
    assert.equal(await runReleaseCli(['apply', '--root', root, '--version', '0.2.0']), 3);
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(manifest.version, '0.2.0', 'manifest 已写入属于预期：失败点必须在源码常量的显式阻断上');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('当前版本非法时报状态错误而不是猜一个版本', async () => {
  const root = await makeWorkspace('0.1.0');
  try {
    const manifestPath = path.join(root, 'package.json');
    await writeFile(manifestPath, `${JSON.stringify({ name: 'finch', version: 'v0.1.0' }, null, 2)}\n`, 'utf8');
    assert.equal(await runReleaseCli(['plan', '--root', root, '--title', 'fix: x']), 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
