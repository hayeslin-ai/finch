/**
 * 依赖方向测试。
 *
 * WHY：Spec 4.2 要求核心不反向依赖适配器与 Pi，端口不依赖具体实现。
 * 这类约束只靠代码评审会随时间失效，因此直接扫描源码的 import 语句强制检查。
 * 本测试不执行被检查的代码，只做静态文本分析。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceRoot = path.join(repositoryRoot, 'src');

/** 递归收集 TypeScript 源文件。 */
async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/** 提取相对导入的目标模块路径。 */
function extractRelativeImports(text: string): string[] {
  const targets: string[] = [];
  const pattern = /from\s+['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  return targets;
}

test('端口层不导入具体适配器或 Pi SDK', async () => {
  const files = await collectSourceFiles(path.join(sourceRoot, 'ports'));
  assert.ok(files.length > 0, '端口目录必须存在');

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.ok(
      !text.includes('@earendil-works/'),
      `${path.relative(repositoryRoot, file)} 不得导入 Pi SDK`,
    );

    for (const relative of extractRelativeImports(text)) {
      assert.ok(
        !relative.includes('../agent/') &&
          !relative.includes('../remote/') &&
          !relative.includes('../repository/') &&
          !relative.includes('../logs/') &&
          !relative.includes('../storage/') &&
          !relative.includes('../knowledge/') &&
          !relative.includes('../cli/'),
        `${path.relative(repositoryRoot, file)} 不得反向依赖适配器：${relative}`,
      );
    }
  }
});

test('核心层不导入适配器、CLI 或 Pi SDK', async () => {
  const files = await collectSourceFiles(path.join(sourceRoot, 'core'));
  assert.ok(files.length > 0, '核心目录必须存在');

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    assert.ok(
      !text.includes('@earendil-works/'),
      `${path.relative(repositoryRoot, file)} 不得直接导入 Pi SDK`,
    );

    for (const relative of extractRelativeImports(text)) {
      for (const forbidden of ['../agent/', '../remote/', '../repository/', '../logs/', '../storage/', '../knowledge/', '../cli/']) {
        assert.ok(
          !relative.includes(forbidden),
          `${path.relative(repositoryRoot, file)} 核心不得依赖适配器：${relative}`,
        );
      }
    }
  }
});

test('Pi SDK 只允许出现在 Agent 适配层与组装根', async () => {
  const files = await collectSourceFiles(sourceRoot);
  const importingPi: string[] = [];

  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('@earendil-works/')) {
      importingPi.push(path.relative(repositoryRoot, file));
    }
  }

  // Spec 4.2：agent/ 是 Pi 的适配实现，app/ 是组装与交互启动层；
  // 核心、端口、CLI 与其余适配器都不得直接依赖 SDK。
  const allowed = [path.join('src', 'agent'), path.join('src', 'app')];
  for (const file of importingPi) {
    assert.ok(
      allowed.some((prefix) => file.startsWith(prefix)),
      `Pi SDK 只允许在 ${allowed.join(' 或 ')} 中导入，实际出现在：${file}`,
    );
  }
});
