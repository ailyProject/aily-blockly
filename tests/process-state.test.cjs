const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../child/scripts/process-state.js'), 'utf8');
function load(kill) {
  const module = { exports: {} };
  new Function('module', 'exports', 'process', source)(module, module.exports, { kill });
  return module.exports.getProcessState;
}
for (const pid of [0, -1, 1.5, NaN, Infinity, '123', null, Number.MAX_SAFE_INTEGER + 1]) {
  test(`unusable PID ${String(pid)} remains unknown without querying a different process`, () => {
    const probe = load(() => assert.fail('invalid PID must not reach native kill'));
    assert.equal(probe(pid), 'unknown');
  });
}
test('a successful existence probe is alive and uses signal zero only', () => {
  let calls = 0;
  assert.equal(load((pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0); calls++; })(123), true);
  assert.equal(calls, 1);
});
for (const code of ['ESRCH', 'EPERM', 'EACCES', 'EINVAL', undefined]) {
  test(`only ESRCH proves exit, not ${String(code)}`, () => {
    const probe = load(() => { throw Object.assign(new Error('native probe'), { code }); });
    assert.equal(probe(123), code === 'ESRCH' ? false : 'unknown');
  });
}
