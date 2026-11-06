/**
 * 远程协议测试。
 *
 * 重点验证：帧边界不可被内容破坏、非法帧一律拒绝、
 * 响应必须与请求四项匹配（ID/nonce/op/seq）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ProtocolError,
  createNonce,
  decodeFrame,
  encodeFrame,
  matchesRequest,
  type Frame,
} from '../../src/remote/protocol.js';

function frame(overrides: Partial<Frame> = {}): Frame {
  return {
    v: 1,
    op: 'SEARCH',
    id: 1,
    nonce: 'abcdef0123456789',
    seq: 1,
    ...overrides,
  };
}

test('编码后的帧可往返解析', () => {
  const original = frame({ payload: JSON.stringify({ terms: ['NullPointerException'] }) });
  const decoded = decodeFrame(encodeFrame(original));
  assert.deepEqual(decoded, original);
});

test('负载中的换行与控制字符不会破坏帧边界', () => {
  const evil = frame({ payload: 'line1\nline2\r\x00{"op":"CLOSE"}' });
  const encoded = encodeFrame(evil);

  assert.equal(encoded.split('\n').length, 2, '编码后必须只有一行内容加换行');
  assert.deepEqual(decodeFrame(encoded), evil);
});

test('拒绝非法帧：空、非 JSON、版本错误、未知操作、非法字段', () => {
  const invalid = [
    '',
    'not json',
    '{"v":2,"op":"SEARCH","id":1,"nonce":"abcdef0123456789","seq":1}',
    '{"v":1,"op":"RUN","id":1,"nonce":"abcdef0123456789","seq":1}',
    '{"v":1,"op":"SEARCH","id":-1,"nonce":"abcdef0123456789","seq":1}',
    '{"v":1,"op":"SEARCH","id":1,"nonce":"short","seq":1}',
    '{"v":1,"op":"READY","id":0,"nonce":"wrong","seq":0}',
    '{"v":1,"op":"SEARCH","id":1,"nonce":"abcdef0123456789","seq":0}',
    '{"v":1,"op":"SEARCH","id":1,"nonce":"abcdef0123456789","seq":1,"payload":123}',
  ];

  for (const raw of invalid) {
    assert.throws(() => decodeFrame(raw), ProtocolError, `应拒绝：${raw.slice(0, 40)}`);
  }
});

test('响应必须四项同时匹配才被接受', () => {
  const request = { id: 7, nonce: 'abcdef0123456789', op: 'SEARCH' as const, seq: 3 };
  const good = frame({ id: 7, nonce: 'abcdef0123456789', op: 'SEARCH', seq: 3 });
  assert.equal(matchesRequest(good, request), true);

  assert.equal(matchesRequest({ ...good, id: 8 }, request), false, 'ID 不符');
  assert.equal(matchesRequest({ ...good, nonce: 'ffffffffffffffff' }, request), false, 'nonce 不符');
  assert.equal(matchesRequest({ ...good, op: 'READ' }, request), false, '操作不符');
  assert.equal(matchesRequest({ ...good, seq: 4 }, request), false, '序号不符');
});

test('超大负载被拒绝，避免单帧拖垮进程', () => {
  const huge = frame({ payload: 'x'.repeat(600 * 1024) });
  assert.throws(() => encodeFrame(huge), ProtocolError);
});

test('每次生成的 nonce 不同且长度足够', () => {
  const values = new Set(Array.from({ length: 50 }, () => createNonce()));
  assert.equal(values.size, 50, 'nonce 必须随机');
  for (const value of values) {
    assert.match(value, /^[0-9a-f]{32}$/, '128 位随机数的十六进制表示');
  }
});
