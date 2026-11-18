'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture(snapshots, kills = [], { deferSnapshots = false, boundResults = [], nativeJob } = {}) {
  const called = [], logs = [], snapshotCalls = [], pendingSnapshots = [], bound = [], nativeStops = [];
  const context = { module: { exports: {} }, Buffer, process: { env: { SystemRoot: 'C:\\Windows' } },
    console: { info: (_tag, value) => logs.push(value), warn() {} },
    setTimeout: callback => setImmediate(callback),
    require(name) {
      if (name === './platform') return { isWin32: true };
      if (name === './owned-process') return {
        getOwnedProcessInfo: registered => registered === nativeJob ? {} : null,
        async stopOwnedProcess(registered) { nativeStops.push(registered); return false; },
      };
      if (name === 'node:fs') return fs;
      if (name === 'node:path') return path;
      if (name === 'child_process') return {
        exec(command, _options, callback) {
          called.push(Number(/PID (\d+)/.exec(command)[1]));
          const ok = kills.shift() === true;
          callback(ok ? null : new Error('native child exited during taskkill'), '', '');
        },
        execFile(_exe, args, _options, callback) {
          const encoded = /FromBase64String\('([^']+)'\)/.exec(args.at(-1));
          if (encoded) {
            bound.push(...JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')));
            callback(boundResults.shift() || null, '');
            return;
          }
          snapshotCalls.push(true);
          const next = snapshots.shift();
          const finish = () => callback(next instanceof Error ? next : null, next instanceof Error ? '' : JSON.stringify(next));
          if (deferSnapshots) pendingSnapshots.push(finish); else finish();
        },
      };
      throw new Error(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../electron/process-tree.js'), 'utf8'), context);
  return { stop: (options, pid = 10) => context.module.exports.killRegisteredProcessTree(pid, 'cmd:build', options),
    finishSnapshot: () => pendingSnapshots.shift()(), called, logs, snapshotCalls, bound, nativeStops };
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


test('foreground background-preprocess cancellation accepts native tree success without CIM enumeration', async () => {
  const f = fixture([], [true]);
  assert.equal(await f.stop({ preferNativeAck: true }), true);
  assert.deepEqual(f.called, [10]);
  assert.equal(f.snapshotCalls.length, 0);
});

test('fast native failure stays unconfirmed without guessing from parent exit or removing ownership', async () => {
  const f = fixture([], [false]);
  assert.equal(await f.stop({ preferNativeAck: true }), false);
  assert.equal(f.snapshotCalls.length, 0);
});

test('concurrent Windows tree stops share a fresh snapshot before either tree is killed', async () => {
  const other = { pid: 20, parent: 1, created: '102' };
  const f = fixture([[root, child, other]], [true, true]);
  assert.deepEqual(await Promise.all([f.stop(), f.stop(undefined, 20)]), [true, true]);
  assert.equal(f.snapshotCalls.length, 1);
  assert.deepEqual(f.called, [10, 20]);
  assert.equal(f.logs[1].targetPids.includes(20), true);
});

test('a later stop gets a new snapshot instead of reusing stale process identities', async () => {
  const f = fixture([[root, child], [{ ...root, created: '200' }]], [true, true]);
  assert.equal(await f.stop(), true);
  assert.equal(await f.stop(), true);
  assert.equal(f.snapshotCalls.length, 2);
  assert.deepEqual(Array.from(f.logs[1].targetPids), [10]);
});

test('a failed shared snapshot does not poison subsequent Windows stops', async () => {
  const f = fixture([new Error('CIM unavailable'), [root, child], []], [true, false]);
  assert.equal(await f.stop(), true);
  assert.equal(await f.stop(), true);
  assert.equal(f.snapshotCalls.length, 3);
  assert.equal(f.logs[1].verifiedAfterFailure, true);
});

test('a stop requested after a query starts never joins that older in-flight snapshot', async () => {
  const other = { pid: 20, parent: 1, created: '102' };
  const f = fixture([[root, child], [other]], [true, true], { deferSnapshots: true });
  const first = f.stop(); await Promise.resolve();
  const second = f.stop(undefined, 20); await Promise.resolve();
  assert.equal(f.snapshotCalls.length, 2); assert.deepEqual(f.called, []);
  f.finishSnapshot(); assert.equal(await first, true); assert.deepEqual(f.called, [10]);
  f.finishSnapshot(); assert.equal(await second, true); assert.deepEqual(f.called, [10, 20]);
  assert.deepEqual(Array.from(f.logs[1].targetPids), [20]);
});

test('shared capture keeps each tree separate when only one native stop needs descendant recovery', async () => {
  const other = { pid: 20, parent: 1, created: '102' };
  const f = fixture([[root, child, other], [child], []], [false, true, true]);
  assert.deepEqual(await Promise.all([f.stop(), f.stop(undefined, 20)]), [true, true]);
  assert.deepEqual(f.called, [10, 20, 11]);
  const recovered = f.logs.find(row => row.pid === 10);
  assert.equal(recovered.verifiedAfterFailure, true);
  assert(!recovered.targetPids.includes(20));
});

test('a registered command never force-stops a replacement Windows PID', async () => {
  const replacement = { ...root, created: '200' };
  const f = fixture([[replacement]], [true]);
  const registered = { pid: 10, exitCode: null, signalCode: null };
  assert.equal(await f.stop({ registered, identity: Promise.resolve('100') }), false);
  assert.deepEqual(f.called, []);
});

test('an exited registered Windows command never sends a later force-stop', async () => {
  const f = fixture([[root]], [true]);
  const registered = { pid: 10, exitCode: 0, signalCode: null };
  assert.equal(await f.stop({ registered, identity: Promise.resolve('100') }), false);
  assert.deepEqual(f.called, []);
});

test('a new child of an absent Windows parent is never attributed to its former identity', async () => {
  const alreadyOwned = { ...child, created: '110' };
  const ambiguous = { pid: 12, parent: 10, created: '120' };
  const f = fixture([[root, alreadyOwned], [ambiguous], [ambiguous], [ambiguous], []]);
  const registered = { pid: 10, exitCode: null, signalCode: null };
  let observe;
  assert.equal(await f.stop({ registered, identity: Promise.resolve('100'), observe: reader => { observe = reader; } }), false);
  assert.deepEqual(f.bound.map(entry => entry.pid), [10, 11]);
  assert.equal(await observe(), true);
});

test('a lost force-stop response can settle from the original tree proof without signaling again', async () => {
  const f = fixture([[root], []], [], { boundResults: [new Error('helper exit acknowledgement lost')] });
  const registered = { pid: 10, exitCode: null, signalCode: null };
  assert.equal(await f.stop({ registered, identity: Promise.resolve('100') }), true);
  assert.deepEqual(f.bound.map(entry => entry.pid), [10]);
});

test('a registered Job remains the sole stop target after its launcher exits', async () => {
  const registered = { pid: 10, exitCode: 0, signalCode: null };
  const f = fixture([], [], { nativeJob: registered });
  assert.equal(await f.stop({ registered }), false);
  assert.deepEqual(f.nativeStops, [registered]);
  assert.deepEqual(f.snapshotCalls, []);
  assert.deepEqual(f.called, []);
  assert.deepEqual(f.bound, []);
});
