const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeHistoryAbs } = require('../../electron/history-abs-object');
const hash = value => createHash('sha256').update(value).digest('hex');

test('History reconstructs the exact candidate and rejects a changed tail or body', () => {
  const body = Buffer.from('\uFEFF# ABS Schema: 2\r\ntext("药")');
  const tail = Buffer.from('\n# @project-state:{"value":"old"}\r\n');
  const source = Buffer.concat([body, tail]);
  const packed = Buffer.concat([Buffer.from('\0aily-abs-tail-v1\0'), Buffer.from(hash(tail), 'hex'), body]);
  const read = key => { assert.equal(key, hash(tail)); return tail; };
  assert.deepEqual(decodeHistoryAbs(packed, hash(source), read), source);
  assert.equal(decodeHistoryAbs(source, hash(source), () => assert.fail()), source);
  assert.equal(decodeHistoryAbs(packed, hash(packed), () => assert.fail()), packed);
  assert.throws(() => decodeHistoryAbs(packed, hash(source), () => null));
  assert.throws(() => decodeHistoryAbs(packed, hash(source), () => Buffer.concat([tail, Buffer.from('!')])));
  assert.throws(() => decodeHistoryAbs(Buffer.concat([packed, Buffer.from('!')]), hash(source), read));
});
