/**
 * 日志记录格式测试。
 *
 * 全部基于真实样本的字段布局；重点验证两件容易做错的事：
 * 级别尾随空格与消息内含竖线不会造成字段错位。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRecordStart, parseRecords, sortTimeline } from '../../src/logs/format.js';

const HEADER =
  '2026-11-06 15:33:00.007|//|Qwmw4nqk87eq|22.50.14.22|cogo-user-management|xxl-job, JobThread-399-1793845260030|INFO |com.cogo.user.management.jobhandler.QywxMsgJob:39|发送企业微信定时跑批开始';

test('解析 8 段记录头，级别去掉尾随空格', () => {
  const [record] = parseRecords(HEADER);
  assert.ok(record !== undefined);

  assert.equal(record.timestamp, '2026-11-06 15:33:00.007');
  assert.equal(record.unknownField, '//');
  assert.equal(record.traceId, 'Qwmw4nqk87eq');
  assert.equal(record.host, '22.50.14.22');
  assert.equal(record.app, 'cogo-user-management');
  assert.match(record.thread, /^xxl-job, JobThread-399-/);
  assert.equal(record.level, 'INFO', '级别必须 trim 尾随空格');
  assert.equal(record.logger, 'com.cogo.user.management.jobhandler.QywxMsgJob');
  assert.equal(record.sourceLine, 39);
});

test('消息中包含竖线时不错位', () => {
  const line =
    '2026-11-06 15:33:00.007|//|T1|22.50.14.22|app|main|ERROR |com.x.Y:12|a|b|c 三段竖线';
  const [record] = parseRecords(line);
  assert.equal(record?.logger, 'com.x.Y');
  assert.equal(record?.sourceLine, 12);
  assert.match(record?.body ?? '', /a\|b\|c 三段竖线/);
});

test('异常续行归属上一条记录，不另行成条', () => {
  const text = [
    '2026-11-06 15:33:00.007|//|T1|22.50.14.22|app|main|ERROR |com.x.Y:12|业务异常',
    '\tat com.x.Service.run(Service.java:88)',
    'Caused by: java.net.SocketTimeoutException: Read timed out',
    '\tat com.x.Client.send(Client.java:152)',
    '2026-11-06 15:33:01.000|//|T2|22.50.14.22|app|main|INFO |com.x.Z:5|下一条',
  ].join('\n');

  const records = parseRecords(text);
  assert.equal(records.length, 2, '两条记录头对应两条记录');

  const first = records[0];
  assert.equal(first?.startLine, 1);
  assert.equal(first?.endLine, 4);
  assert.match(first?.body ?? '', /Caused by: java\.net\.SocketTimeoutException/);
  assert.match(first?.body ?? '', /Client\.java:152/);

  assert.equal(records[1]?.startLine, 5);
});

test('记录开始判定只看行首 23 位时间戳', () => {
  assert.equal(isRecordStart('2026-11-06 15:33:00.007|'), true);
  assert.equal(isRecordStart('    2026-11-06 15:33:00.007|'), false, '缩进续行不是记录头');
  assert.equal(isRecordStart('\tat com.x.Foo(Foo.java:1)'), false);
  assert.equal(isRecordStart('2026-11-06 15:33:00.007 缺少竖线'), false);
});

test('时间线按时间戳升序，未知时间排最后', () => {
  const text = [
    '2026-11-06 15:33:02.000|//|T3|h|a|t|INFO |c.X:1|第三',
    '2026-11-06 15:33:00.000|//|T1|h|a|t|INFO |c.X:1|第一',
    '2026-11-06 15:33:01.000|//|T2|h|a|t|INFO |c.X:1|第二',
  ].join('\n');

  const sorted = sortTimeline(parseRecords(text));
  assert.deepEqual(
    sorted.map((record) => record.traceId),
    ['T1', 'T2', 'T3'],
  );
});

test('文件开头的孤立续行不被静默丢弃', () => {
  const records = parseRecords('\tat orphan(Foo.java:1)\n');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.traceId, '', '孤立续行应标记为无记录头');
});
