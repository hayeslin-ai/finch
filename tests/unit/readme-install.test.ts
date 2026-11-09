/**
 * README 安装命令的回归测试。
 *
 * WHY：安装命令曾写死 `releases/download/v0.1.0/finch-0.1.0.tgz`，发版后
 * 没人改 README，新用户就会装到旧版。发布流程改为同时上传固定文件名
 * `finch.tgz`，README 用 `releases/latest/download/finch.tgz` 永远指向最新版。
 * 本测试防止再退回按版本写死的 URL。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('README 的安装命令使用 latest/download 稳定地址', async () => {
  const readme = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');

  const install = readme.match(/npm install[^\n]*\n?[^\n]*finch[^\n]*\.tgz/g) ?? [];
  assert.ok(install.length > 0, 'README 必须包含一条 tarball 安装命令');

  const stable = 'https://github.com/hayeslin-ai/finch/releases/latest/download/finch.tgz';
  assert.ok(
    install.some((command) => command.includes(stable)),
    `安装命令必须使用稳定地址 ${stable}，实际：${JSON.stringify(install)}`,
  );

  // 任何带真实版本号的下载地址都会在发版后过期。
  for (const command of install) {
    assert.doesNotMatch(
      command,
      /releases\/download\/v\d+\.\d+\.\d+\//,
      `安装命令不得写死版本号：${command}`,
    );
  }
});
