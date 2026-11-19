'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectProjectCopyBuild } = require('../../electron/project-copy-admission');
const { acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');
const { tryAcquireFileLock } = require('../../child/scripts/native-file-lock');

const output = path.resolve(__dirname, '../test-results/abs-five-fixes-final-20261027/copy-admission');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-')), project = path.join(root, 'project');
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, '.build')); fs.mkdirSync(path.join(project, '.aily'));
  fs.writeFileSync(path.join(project, 'project.abi'), '{"blocks":{"blocks":[]}}');
  t.after(() => { assert.ok(root.startsWith(output + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = path.join(project, '.build/aily-workspace.lock');
  const record = (pid, extra = {}) => ({ schemaVersion: 1, nativeLeaseVersion: 1, delegationVersion: 1,
    delegated: true, pid, token: randomUUID(), operation: 'compile', ...extra });
  return { root, project, owner, record, write(value, filename = owner) { fs.writeFileSync(filename, JSON.stringify(value)); },
    bytes: filename => fs.readFileSync(filename || owner) };
}
function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); return child.pid;
}
function deniedOwner(pid, action) {
  const kill = process.kill;
  try {
    process.kill = function (target, signal) {
      if (target === pid && signal === 0) throw Object.assign(new Error('Fixture access denied'), { code: 'EPERM' });
      return kill.apply(this, arguments);
    };
    return action();
  } finally { process.kill = kill; }
}

test('empty source build is observed idle without creating a build owner', t => {
  const f = fixture(t), result = inspectProjectCopyBuild(f.project);
  assert.deepEqual(result, { ok: true, build: { state: 'idle' } }); assert.equal(fs.existsSync(f.owner), false);
});
test('an explicitly released native owner remains unchanged and is idle even when its old PID lives', t => {
  const f = fixture(t); f.write(f.record(process.pid, { released: true })); const before = f.bytes();
  assert.equal(inspectProjectCopyBuild(f.project).build.state, 'idle'); assert.deepEqual(f.bytes(), before);
});
test('an exited nondelegating native owner is idle without changing its journal', t => {
  const f = fixture(t); f.write(f.record(exitedPid(), { delegated: false })); const before = f.bytes();
  assert.equal(inspectProjectCopyBuild(f.project).build.state, 'idle'); assert.deepEqual(f.bytes(), before);
});
test('a real held native build lease rejects a copy and preserves its owner', t => {
  const f = fixture(t), lease = acquireBuildWorkspace(f.project, 'compile');
  try {
    const before = f.bytes(), result = inspectProjectCopyBuild(f.project);
    assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_BUSY');
    assert.equal(result.build.reason, 'native-guard-unavailable'); assert.deepEqual(f.bytes(), before); lease.assertOwned();
  } finally { lease.release(); }
});
test('a held native guard is busy even when no readable PID record exists', t => {
  const f = fixture(t), guard = tryAcquireFileLock(path.join(f.project, '.aily/build-workspace.guard')); assert.ok(guard);
  try { assert.equal(inspectProjectCopyBuild(f.project).code, 'PROJECT_RECOVERY_SOURCE_BUSY'); assert.equal(fs.existsSync(f.owner), false); }
  finally { guard.close(); }
});
test('a confirmed alive unreleased owner is busy even when its native guard is currently free', t => {
  const f = fixture(t); f.write(f.record(process.pid)); const before = f.bytes(), result = inspectProjectCopyBuild(f.project);
  assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_BUSY');
  assert.equal(result.build.owner.pid, process.pid); assert.deepEqual(f.bytes(), before);
});
for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'delegated'} exited orphan permits an independent copy, not a source takeover`, t => {
  const f = fixture(t), value = f.record(exitedPid());
  if (legacy) { delete value.nativeLeaseVersion; delete value.delegationVersion; }
  f.write(value); const before = f.bytes(), result = inspectProjectCopyBuild(f.project);
  assert.equal(result.ok, true); assert.equal(result.build.state, 'ownership-unconfirmed');
  assert.equal(result.build.owner.processState, 'exited'); assert.deepEqual(f.bytes(), before);
  const guard = tryAcquireFileLock(path.join(f.project, '.aily/build-workspace.guard')); assert.ok(guard); guard.close();
});
for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'delegated'} PID query denial remains unconfirmed, not active or idle`, t => {
  const f = fixture(t), pid = 987654321, value = f.record(pid);
  if (legacy) { delete value.nativeLeaseVersion; delete value.delegationVersion; }
  f.write(value); const before = f.bytes();
  const result = deniedOwner(pid, () => inspectProjectCopyBuild(f.project));
  assert.equal(result.ok, true); assert.equal(result.build.state, 'ownership-unconfirmed');
  assert.equal(result.build.owner.processState, 'unknown'); assert.deepEqual(f.bytes(), before);
});
for (const marker of ['aily-builder.lock', 'aily-workspace-recovery.lock']) {
  test(`a valid exited ${marker} is retained as unknown ownership`, t => {
    const f = fixture(t), filename = path.join(f.project, '.build', marker); f.write(f.record(exitedPid()), filename);
    const before = f.bytes(filename), result = inspectProjectCopyBuild(f.project);
    assert.equal(result.ok, true); assert.equal(result.build.state, 'ownership-unconfirmed'); assert.deepEqual(f.bytes(filename), before);
  });
  test(`a valid alive ${marker} still blocks the independent copy`, t => {
    const f = fixture(t), filename = path.join(f.project, '.build', marker); f.write(f.record(process.pid), filename);
    const before = f.bytes(filename), result = inspectProjectCopyBuild(f.project);
    assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_BUSY'); assert.deepEqual(f.bytes(filename), before);
  });
  test(`a malformed ${marker} is unverified, never accepted as an old orphan`, t => {
    const f = fixture(t), filename = path.join(f.project, '.build', marker); fs.writeFileSync(filename, '{incomplete');
    const before = f.bytes(filename), result = inspectProjectCopyBuild(f.project);
    assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.deepEqual(f.bytes(filename), before);
  });
}
test('an unreadable owner is unverified rather than idle', t => {
  const f = fixture(t); fs.writeFileSync(f.owner, '{incomplete'); const before = f.bytes(), result = inspectProjectCopyBuild(f.project);
  assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.deepEqual(f.bytes(), before);
});
test('an unsupported native lease version is not downgraded to an accepted orphan', t => {
  const f = fixture(t); f.write(f.record(exitedPid(), { nativeLeaseVersion: 2 })); const before = f.bytes();
  const result = inspectProjectCopyBuild(f.project); assert.equal(result.code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.deepEqual(f.bytes(), before);
});
test('a hardlinked owner is not treated as an unknown orphan', t => {
  const f = fixture(t); f.write(f.record(exitedPid())); const other = path.join(f.root, 'outside-owner');
  fs.linkSync(f.owner, other); const before = f.bytes();
  assert.equal(inspectProjectCopyBuild(f.project).code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.deepEqual(f.bytes(), before);
});
test('a linked build directory fails closed without following it into another directory', t => {
  const f = fixture(t), build = path.join(f.project, '.build'), outside = path.join(f.root, 'outside-build');
  fs.rmdirSync(build); fs.mkdirSync(outside); fs.symlinkSync(outside, build, process.platform === 'win32' ? 'junction' : 'dir');
  const record = path.join(outside, 'aily-workspace.lock'); f.write(f.record(exitedPid()), record); const before = f.bytes(record);
  assert.equal(inspectProjectCopyBuild(f.project).code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.deepEqual(f.bytes(record), before);
});
