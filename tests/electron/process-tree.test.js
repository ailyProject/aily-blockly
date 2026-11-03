'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture(snapshots, kills = []) {
  const called = [], logs = [];
  const context = { module: { exports: {} }, process: { env: { SystemRoot: 'C:\\Windows' } },
    console: { info: (_tag, value) => logs.push(value), warn() {} },
    setTimeout: callback => setImmediate(callback),
    require(name) {
      if (name === './platform') return { isWin32: true };
      if (name === 'node:path') return path;
      if (name === 'child_process') return {
        exec(command, _options, callback) {
          called.push(Number(/PID (\d+)/.exec(command)[1]));
          const ok = kills.shift() === true;
          callback(ok ? null : new Error('native child exited during taskkill'), '', '');
        },
        execFile(_exe, _args, _options, callback) {
          const next = snapshots.shift();
          callback(next instanceof Error ? next : null, next instanceof Error ? '' : JSON.stringify(next));
        },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/process-tree.js'), 'utf8'), context);
  return { stop: () => context.module.exports.killRegisteredProcessTree(10, 'cmd:build'), called, logs };
}
const root = { pid: 10, parent: 1, created: '100' }, child = { pid: 11, parent: 10, created: '101' };

test('a nonzero taskkill is accepted only after the captured tree has disappeared', async () => {
  const f = fixture([[root, child], []]);
  assert.equal(await f.stop(), true);
  assert.equal(f.logs[0].verifiedAfterFailure, true);
  assert.deepEqual(f.called, [10]);
});

test('remaining descendants are stopped while recycled process identities are left alone', async () => {
  const recycled = { ...root, created: '200' };
  const f = fixture([[root, child], [recycled, child], [recycled]], [false, true]);
  assert.equal(await f.stop(), true);
  assert.deepEqual(f.called, [10, 11]);
});

test('a surviving descendant or an unavailable verification cannot release ownership', async () => {
  const alive = fixture([[root, child], [child], [child], [child]]);
  assert.equal(await alive.stop(), false);
  const unknown = fixture([[root, child], new Error('CIM unavailable')]);
  assert.equal(await unknown.stop(), false);
  const missingBefore = fixture([[], []]);
  assert.equal(await missingBefore.stop(), false);
});

test('native taskkill success retains its normal acknowledgement if CIM is unavailable', async () => {
  const f = fixture([new Error('CIM unavailable')], [true]);
  assert.equal(await f.stop(), true);
});
