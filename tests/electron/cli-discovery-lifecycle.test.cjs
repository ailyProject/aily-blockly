'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pruneDiscoveryFiles } = require('../../electron/cli-discovery-lifecycle');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const removed = [];
  const native = { binding: { identity: () => '100', removeDescriptor: (...args) => removed.push(args) } };
  function write(pid, data = {}) { const file = path.join(root, pid + '.json');fs.writeFileSync(file, JSON.stringify({ pid, token: 'a'.repeat(32), ...data }));return file; }
  return { root, native, removed, write };
}
test('keeps live and unresponsive instances without probing their HTTP endpoint', async t => {
  const f = fixture(t);f.write(101, { processCreated: '100' });
  await pruneDiscoveryFiles(f.root, { native: f.native, isAlive: () => true });assert.deepEqual(f.removed, []);
});
test('removes only a confirmed dead descriptor with its exact publication identity', async t => {
  const f = fixture(t);const file = f.write(102, { instanceId: 'b'.repeat(32) });
  await pruneDiscoveryFiles(f.root, { native: f.native, isAlive: () => false });assert.deepEqual(f.removed, [[file, 'instanceId', 'b'.repeat(32)]]);
});
test('PID reuse does not keep a descriptor belonging to an older process', async t => {
  const f = fixture(t);const file = f.write(103, { processCreated: '99' });
  await pruneDiscoveryFiles(f.root, { native: f.native, isAlive: () => true });assert.deepEqual(f.removed, [[file, 'token', 'a'.repeat(32)]]);
});
test('inaccessible process identities, malformed files and mismatched filenames remain untouched', async t => {
  const f = fixture(t);f.write(104, { processCreated: '100' });f.native.binding.identity = () => { throw Error('access denied'); };
  f.write(105, { pid: 106 });fs.writeFileSync(path.join(f.root, '107.json'), '{');
  await pruneDiscoveryFiles(f.root, { native: f.native, isAlive: () => true });assert.deepEqual(f.removed, []);
});
