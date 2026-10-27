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
test('ordinary view acquisition retains an unknown owner instead of treating access denial as exit', t => {
  const f = fixture(t); f.write(f.owner); const before = fs.readFileSync(f.lock);
  const locks = load({ pid: 101, processState: () => undefined });
  const result = locks.tryAcquireLock(f.project);
  assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN');
  assert.equal(result.conflict, true); assert.equal(result.ownership.state, 'unknown');
  assert.deepEqual(fs.readFileSync(f.lock), before);
});
for (const query of [() => { throw Object.assign(new Error('query denied'), { code: 'EPERM' }); }, () => '']) {
  test('an unavailable executable query is not evidence of PID reuse', t => {
    const f = fixture(t); f.write(f.owner); const before = fs.readFileSync(f.lock);
    const locks = load({ pid: 101, processState: () => true, executableQuery: query });
    const result = locks.tryAcquireLock(f.project);
    assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN');
    assert.deepEqual(fs.readFileSync(f.lock), before);
  });
}
test('a wall clock correction does not retire a live legacy view record', t => {
  const f = fixture(t); f.write({ ...f.owner, startedAt: 1 }); const before = fs.readFileSync(f.lock);
  const locks = load({ pid: 101, processState: () => true });
  assert.equal(locks.tryAcquireLock(f.project).ok, false); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('an invalid existing owner record is retained and diagnosed, not replaced', t => {
  const f = fixture(t); fs.writeFileSync(f.lock, '{incomplete'); const before = fs.readFileSync(f.lock);
  const result = load({ pid: 101 }).tryAcquireLock(f.project);
  assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN'); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('ordinary acquisition still recovers a definitely exited owner without force', t => {
  const f = fixture(t); f.write(f.owner);
  const locks = load({ pid: 101, processState: () => false });
  const result = locks.tryAcquireLock(f.project);
  assert.equal(result.ok, true); assert.equal(result.recoveredStale, true);
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, 101); locks.releaseLock(f.project);
});
test('a stored boot hint does not override live PID/executable evidence', t => {
  const f = fixture(t); f.write({ ...f.owner, bootId: 'win32:11111111-1111-4111-8111-111111111111' });
  const before = fs.readFileSync(f.lock), locks = load({ pid: 101, processState: () => true });
  assert.equal(locks.tryAcquireLock(f.project).conflict, true); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('a stored boot hint does not turn a permission-denied owner into an exited owner', t => {
  const f = fixture(t); f.write({ ...f.owner, bootId: 'win32:11111111-1111-4111-8111-111111111111' });
  const before = fs.readFileSync(f.lock), result = load({ pid: 101, processState: () => undefined }).tryAcquireLock(f.project);
  assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN'); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('malformed executable query output is unknown instead of proof of PID reuse', t => {
  const f = fixture(t); f.write(f.owner); const before = fs.readFileSync(f.lock);
  const result = load({ pid: 101, processState: () => true, executableQuery: () => 'ExecutablePath=unavailable' }).tryAcquireLock(f.project);
  assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN'); assert.deepEqual(fs.readFileSync(f.lock), before);
});
test('a proven different executable recovers only the stale original view', t => {
  const f = fixture(t); f.write(f.owner);
  const locks = load({ pid: 101, processState: () => true,
    executableQuery: () => 'ExecutablePath=' + path.join(path.parse(process.execPath).root, 'different.exe') });
  assert.equal(locks.tryAcquireLock(f.project).recoveredStale, true); locks.releaseLock(f.project);
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
