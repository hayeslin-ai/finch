/**
 * 版本一致性测试。
 *
 * WHY：`--version` 是排障时判断团队实际安装版本的唯一依据，
 * 因此源码常量必须与 package.json 严格一致，不能各写各的。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PACKAGE_NAME, VERSION } from '../../src/version.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('源码版本与 package.json 保持一致', async () => {
  const raw = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { name: string; version: string; bin: Record<string, string> };

  assert.equal(PACKAGE_NAME, pkg.name, 'PACKAGE_NAME 必须与 package.json 的 name 一致');
  assert.equal(VERSION, pkg.version, 'VERSION 必须与 package.json 的 version 一致');
  assert.equal(pkg.bin['finch'], 'dist/src/cli/main.js', 'bin 入口必须指向编译产物');
});
