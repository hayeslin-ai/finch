/**
 * 安装与打包集成测试。
 *
 * WHY：真实故障发现，通过 npm bin 软链启动时路径比较失败会让命令静默退出且返回 0。
 * 因此必须用真实安装路径执行一次，而不是只测 run() 函数。
 * 本测试不访问网络、不读取用户配置。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cliEntry = path.join(repositoryRoot, 'dist/src/cli/main.js');

/** 直接以 node 执行入口，返回输出与退出码；非零退出不抛异常。 */
async function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repositoryRoot,
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
  assert.match(result.stdout, /^finch 0\.1\.0 \(node v\d+\.\d+\.\d+, commit \S+\)\n$/);
});

test('--help 输出用法且退出码为 0', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /用法：/);
  assert.match(result.stdout, /finch -c/);
});

test('未实现的命令明确失败，不静默成功', async () => {
  const result = await runCli(['doctor']);
  assert.equal(result.code, 2, '未知或未实现命令必须返回非零退出码');
  assert.match(result.stderr, /尚未实现/);
});

test('无参数时不进入交互，返回未实现状态', async () => {
  const result = await runCli([]);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /P0 阶段/);
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
