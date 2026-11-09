/**
 * 脱敏测试。
 *
 * 重点验证：同一值稳定映射、不同值可区分、跨 chunk 不泄漏、
 * 以及常见凭证格式都能被识别。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Redactor } from '../../src/security/redactor.js';

test('同一敏感值在同一次运行中映射为相同占位符', () => {
  const redactor = new Redactor();
  const first = redactor.redact('password=hunter2 and password=hunter2');
  assert.equal((first.match(/<SECRET_1>/g) ?? []).length, 2, '相同值必须复用同一编号');
});

test('不同敏感值映射为不同占位符', () => {
  const redactor = new Redactor();
  const output = redactor.redact('password=alpha; password=beta');
  assert.match(output, /<SECRET_1>/);
  assert.match(output, /<SECRET_2>/);
});

test('手机号、邮箱、JWT、连接串凭证均被脱敏', () => {
  const redactor = new Redactor();
  const output = redactor.redact(
    [
      'user phone 13800138000',
      'contact someone@example.com',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop',
      'jdbc: mysql://root:s3cretPwd@db.example.com:3306/app',
    ].join('\n'),
  );

  assert.ok(!output.includes('13800138000'));
  assert.ok(!output.includes('someone@example.com'));
  assert.ok(!output.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!output.includes('s3cretPwd'));
  assert.match(output, /<PHONE_1>/);
  assert.match(output, /<EMAIL_1>/);
});

test('普通业务文本不被误伤', () => {
  const redactor = new Redactor();
  const text = '2026-11-06 15:33:00.007|//|abc123def456|22.50.0.1|app|main|INFO |com.x.Y:39|定时任务开始';
  assert.equal(redactor.redact(text), text, '记录头与业务消息不应被改动');
});

test('清除映射后重新编号', () => {
  const redactor = new Redactor();
  const first = redactor.redact('password=abc');
  redactor.clear();
  const second = redactor.redact('password=xyz');
  assert.match(first, /<SECRET_1>/);
  assert.match(second, /<SECRET_1>/, '新会话重新从 1 开始，不继承旧映射');
});
