/**
 * 安装与打包集成测试。
 *
 * WHY：真实故障发现，通过 npm bin 软链启动时路径比较失败会让命令静默退出且返回 0。
 * 因此必须用真实安装路径执行一次，而不是只测 run() 函数。
 * 本测试不访问网络、不读取用户配置。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { VERSION } from '../../src/version.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliEntry = path.join(repositoryRoot, 'dist/src/cli/main.js');

/**
 * 隔离的用户目录。
 *
 * WHY：本文件此前直接继承开发机的 HOME，于是「非 TTY 拒绝」这类断言在
 * 有真实 ~/.config/finch 的机器上通过、在干净的 CI 上失败——本地绿不等于
 * CI 绿。所有 CLI 调用统一指向空 HOME，结果与开发机配置无关。
 */
const isolatedHome = await mkdtemp(path.join(tmpdir(), 'finch-home-'));
after(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});

/** 直接以 node 执行入口，返回输出与退出码；非零退出不抛异常。 */
async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: isolatedHome },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
  }
}

test('--version 输出包名、版本、Node 版本与提交号', async () => {
  const result = await runCli(['--version']);
  assert.equal(result.code, 0, result.stderr);
  // 版本从源码常量读取，不写死字面量：否则每次回写版本，复测都会在这里变红。
  assert.ok(
    result.stdout.startsWith(`finch ${VERSION} (node `),
    `--version 必须以 finch ${VERSION} 开头，实际：${JSON.stringify(result.stdout)}`,
  );
  assert.match(result.stdout, /^finch \S+ \(node v\d+\.\d+\.\d+, commit \S+\)\n$/);
});

test('--help 输出用法且退出码为 0', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /用法：/);
  assert.match(result.stdout, /finch -c/);
  assert.match(result.stdout, /finch init/);
});

test('未实现的命令明确失败，不静默成功', async () => {
  const result = await runCli(['--not-a-real-command']);
  assert.equal(result.code, 2, '未知或未实现命令必须返回非零退出码');
  assert.match(result.stderr, /尚未实现/);
});

test('非 TTY 下不使用无参数入口，明确拒绝并返回不可用状态', async () => {
  // 无参数已改为进入交互式诊断；管道/重定向下必须拒绝，
  // 避免脚本在无人值守时误触发模型调用与费用。
  const result = await runCli([]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /需要 TTY/);
});

test('doctor 无真实配置时按能力报告，且不生成 OTP 或连接', async () => {
  const result = await runCli(['doctor']);
  // 测试机通常没有 ~/.config/finch；此时基础或本地能力不可用，
  // 退出码为 3，但输出必须是结构化报告而不是异常堆栈。
  assert.ok([0, 3].includes(result.code), `退出码应可解释，实际 ${result.code}`);
  assert.match(result.stdout, /基础/);
  assert.match(result.stdout, /Node\.js/);
  assert.ok(!result.stdout.includes('OTP'), 'doctor 不得生成或提及实际 OTP');
});

test('打包只包含运行产物与模板，不含测试与私密配置', async () => {
  const pkg = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
    files: string[];
  };
  assert.deepEqual(pkg.files, ['dist/src/', 'assets/', 'templates/', 'README.md']);

  for (const forbidden of ['dist/tests/', '.env', 'docs/models.json']) {
    assert.ok(!pkg.files.includes(forbidden), `files 白名单不得包含 ${forbidden}`);
  }
});
