/**
 * 输入解析测试。
 *
 * 关键不变量：日志正文里的 `@` 不是文件授权；代码块内的 `@` 同样不解析；
 * traceId 解析失败时必须报错而不是静默降级。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { parseTraceCommand, parseUserInput } from '../../src/cli/input.js';

const HOME = '/Users/tester';

test('解析相对路径与 ~ 附件引用', () => {
  const parsed = parseUserInput('分析 @./logs/app.log 中的异常', HOME);
  assert.deepEqual(parsed.attachments, ['./logs/app.log']);
  assert.equal(parsed.instruction, '分析 中的异常');
});

test('支持带引号的含空格路径', () => {
  const parsed = parseUserInput('看下 @"/tmp/my logs/app.log" 的报错', HOME);
  assert.deepEqual(parsed.attachments, ['/tmp/my logs/app.log']);
});

test('展开 ~ 为 home 目录，且不展开环境变量', () => {
  const parsed = parseUserInput('@~/logs/a.log @$HOME/b.log', HOME);
  assert.equal(parsed.attachments[0], path.join(HOME, 'logs/a.log'));
  assert.equal(parsed.attachments[1], '$HOME/b.log', '不展开环境变量，避免隐式读取');
});

test('代码块内的 @ 不构成附件授权', () => {
  const text = ['请看这段日志：', '```', 'user@example.com 出现在正文里', '@./not-a-file.log', '```'].join('\n');
  const parsed = parseUserInput(text, HOME);
  assert.deepEqual(parsed.attachments, [], '围栏内的 @ 必须被忽略');
});

test('日志正文中的邮箱不会被当成附件', () => {
  const parsed = parseUserInput('报错来自 user@example.com 发送的消息', HOME);
  assert.deepEqual(parsed.attachments, [], '邮箱前的 @ 没有空白分隔，不应触发');
});

test('重复附件被去重', () => {
  const parsed = parseUserInput('@./a.log 和 @./a.log', HOME);
  assert.deepEqual(parsed.attachments, ['./a.log']);
});

test('/trace 解析 traceId、目标与时间', () => {
  const parsed = parseTraceCommand('/trace Qwmw4nqk87eq --host 22.50.14.22 --since "2026-11-06 15:00"');
  assert.ok(!('error' in parsed));
  assert.equal(parsed.traceId, 'Qwmw4nqk87eq');
  assert.equal(parsed.targetHost, '22.50.14.22');
  assert.equal(parsed.since, '"2026-11-06 15:00"');
});

test('/trace 只带 traceId 时其余字段为空', () => {
  const parsed = parseTraceCommand('/trace ABC123');
  assert.ok(!('error' in parsed));
  assert.equal(parsed.traceId, 'ABC123');
  assert.equal(parsed.targetHost, undefined);
  assert.equal(parsed.since, undefined);
});

test('/trace 拒绝未知参数与非法 traceId', () => {
  const unknown = parseTraceCommand('/trace ABC --verbose');
  assert.ok('error' in unknown);
  assert.match(unknown.error, /未知参数/, '未知选项应报未知参数，而不是取值问题');

  const invalid = parseTraceCommand('/trace bad;id');
  assert.ok('error' in invalid);
  assert.match(invalid.error, /traceId/);

  const missingValue = parseTraceCommand('/trace ABC --host');
  assert.ok('error' in missingValue);
  assert.match(missingValue.error, /缺少取值/);
});

test('parseUserInput 对非法 /trace 抛出明确错误', () => {
  assert.throws(() => parseUserInput('/trace', HOME), /用法/);
});
