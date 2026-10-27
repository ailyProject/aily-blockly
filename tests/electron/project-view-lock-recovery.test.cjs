const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./fixtures/project-view-locks.cjs');
const { tryAcquireFileLock } = require('../../child/scripts/native-file-lock');
const output = path.resolve(__dirname, '../test-results/abs-recovery-restart-20261026/view-locks'); fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const project = fs.mkdtempSync(path.join(output, 'case-')); fs.mkdirSync(path.join(project, '.aily'));
  t.after(() => { assert.ok(project.startsWith(output + path.sep)); fs.rmSync(project, { recursive: true, force: true }); });
  const lock = path.join(project, '.aily', 'project-open.lock');
  const owner = { pid: 200, execPath: process.execPath, appVersion: 'fixture-version', startedAt: Date.now() };
  const write = value => fs.writeFileSync(lock, JSON.stringify(value));
  return { project, lock, owner, write };
}
test('ordinary view acquire, repeated acquire, own release and foreign release retain their API semantics', t => {
  const f = fixture(t), first = load({ pid: 100 }), other = load({ pid: 101 });
  assert.equal(first.tryAcquireLock(f.project).ok, true); assert.equal(first.tryAcquireLock(f.project).alreadyHeld, true);
  assert.equal(other.releaseLock(f.project).ok, true); assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, 100);
  assert.equal(first.releaseLock(f.project).ok, true); assert.equal(fs.existsSync(f.lock), false);
  assert.equal(first.releaseLock(f.project).ok, true);
});
test('ordinary alive foreign owner rejects while an explicit ordinary force remains available', t => {
  const f = fixture(t); f.write(f.owner); const locks = load({ pid: 101, processState: () => true });
  const before = fs.readFileSync(f.lock); assert.equal(locks.tryAcquireLock(f.project).conflict, true);
  assert.deepEqual(fs.readFileSync(f.lock), before);
  assert.equal(locks.tryAcquireLock(f.project, { force: true }).ok, true); assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, 101);
  locks.releaseLock(f.project);
});
test('strict repair acquire never forces a foreign owner even if force was requested', t => {
  const f = fixture(t); f.write(f.owner); const before = fs.readFileSync(f.lock), locks = load({ pid: 101, processState: () => false });
  assert.equal(locks.tryAcquireLock(f.project, { strict: true, force: true }).ok, false);
  assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('public acquire cannot claim an alive foreign PID is confirmed dead', t => {
  const f = fixture(t); f.write(f.owner); const before = fs.readFileSync(f.lock), locks = load({ pid: 101, processState: () => true });
  const result = locks.tryAcquireLock(f.project, { confirmedDeadPid: 200, noForceRetry: false });
  assert.equal(result.conflict, true); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('the permanent native view guard serializes normal acquire and release without touching a held record', t => {
  const f = fixture(t), locks = load({ pid: 101 }); f.write(f.owner);
  const guard = tryAcquireFileLock(path.join(f.project, '.aily', 'project-view.guard'));
  try { assert.equal(locks.tryAcquireLock(f.project).code, 'PROJECT_VIEW_BUSY'); assert.equal(locks.releaseLock(f.project).code, 'PROJECT_VIEW_BUSY'); }
  finally { guard.close(); }
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, 200);
});
test('an exact exited view uses normal non-force acquire/release and leaves its captured bytes intact as evidence', t => {
  const f = fixture(t); f.write(f.owner); const locks = load({ pid: 101 }), snapshot = locks.readViewLockSnapshot(f.project);
  const recovered = locks.recoverExitedViewLock(f.project, snapshot, () => {}, () => true);
  assert.equal(recovered.ok, true); assert.equal(recovered.recoveredStaleView, true); assert.equal(fs.existsSync(f.lock), false);
  assert.equal(snapshot.contents, JSON.stringify(f.owner));
  assert.equal(locks.tryAcquireLock(f.project, { strict: true }).ok, true); locks.releaseLock(f.project);
});
for (const state of [false, undefined]) test(`alive/unconfirmed process evidence ${String(state)} cannot retire a view`, t => {
  const f = fixture(t); f.write(f.owner); const locks = load({ pid: 101 }), snapshot = locks.readViewLockSnapshot(f.project), before = fs.readFileSync(f.lock);
  assert.equal(locks.recoverExitedViewLock(f.project, snapshot, () => {}, () => state).ok, false);
  assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('a changed view record refuses CAS and preserves the newer owner bytes', t => {
  const f = fixture(t); f.write(f.owner); const locks = load({ pid: 101 }), snapshot = locks.readViewLockSnapshot(f.project);
  const changed = { ...f.owner, pid: 300 }; let checks = 0;
  const result = locks.recoverExitedViewLock(f.project, snapshot, () => { if (++checks === 2) f.write(changed); }, () => true);
  assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_VIEW_CHANGED'); assert.equal(fs.readFileSync(f.lock, 'utf8'), JSON.stringify(changed));
});
