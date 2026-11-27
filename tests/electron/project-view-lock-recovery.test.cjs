const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { buffer } = require('node:stream/consumers');
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
test('case aliases on case-insensitive storage use the same project lease', t => {
  const f = fixture(t);
  const alias = path.join(path.dirname(f.project), path.basename(f.project).replace(/^case-/, 'CASE-'));
  if (!fs.existsSync(alias)) return t.skip('Project volume is case-sensitive');
  const original = fs.statSync(f.project, { bigint: true }), other = fs.statSync(alias, { bigint: true });
  if (original.dev !== other.dev || original.ino !== other.ino) return t.skip('Path casing denotes a different directory');
  const locks = load();
  try {
    const expected = fs.realpathSync.native(f.project);
    assert.equal(locks.normalizeProjectPathStrict(alias), expected);
    assert.equal(locks.normalizeProjectPathLoose(alias), expected);
    const opened = locks.tryAcquireLock(f.project);
    assert.equal(opened.ok, true);
    const reopened = locks.tryAcquireLock(alias);
    assert.equal(reopened.alreadyHeld, true);
    assert.equal(reopened.viewToken, opened.viewToken);
    assert.equal(locks.isHeld(alias, opened.viewToken), true);
    assert.equal(locks.releaseLock(alias, { viewToken: opened.viewToken }).ok, true);
    assert.equal(locks.isHeld(f.project), false);
  } finally { locks.releaseAll(); }
});
test('a possibly active legacy owner rejects even when force is requested', t => {
  const f = fixture(t); f.write(f.owner); const locks = load({ pid: 101, processState: () => true });
  const before = fs.readFileSync(f.lock); assert.equal(locks.tryAcquireLock(f.project).conflict, true);
  assert.deepEqual(fs.readFileSync(f.lock), before);
  assert.equal(locks.tryAcquireLock(f.project, { force: true }).code, 'PROJECT_VIEW_OWNER_UNKNOWN');
  assert.deepEqual(fs.readFileSync(f.lock), before);
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
test('a missing local PID cannot settle a hostname-free legacy record on shared storage', t => {
  const f = fixture(t); f.write(f.owner);
  const locks = load({ pid: 101, processState: () => false });
  const result = locks.tryAcquireLock(f.project);
  assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN');
  assert.equal(result.ownership.reason, 'legacy-owner-unverified');
  assert.equal(locks.inspectViewLock(f.project).state, 'unknown');
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).pid, f.owner.pid);
});

test('a foreign-platform legacy archive is retained without checking for a local PID', t => {
  const f = fixture(t);
  const execPath = process.platform === 'win32' ? '/Applications/aily.app/Contents/MacOS/aily' : 'C:\\Users\\original\\aily.exe';
  f.write({ ...f.owner, execPath });
  let checkedPid = false;
  const locks = load({ pid: 101, processState: () => { checkedPid = true; return false; } });
  const result = locks.tryAcquireLock(f.project);
  assert.equal(result.code, 'PROJECT_VIEW_OWNER_UNKNOWN');
  assert.equal(result.focus, undefined);
  assert.equal(checkedPid, false);
  assert.equal(JSON.parse(fs.readFileSync(f.lock)).execPath, execPath);
});

test('the permanent native view guard serializes normal acquire and release without touching a held record', t => {
  const f = fixture(t), locks = load({ pid: 101 }); f.write(f.owner);
  const guard = tryAcquireFileLock(path.join(f.project, '.aily', 'project-view.guard'));
  try { assert.equal(locks.tryAcquireLock(f.project).code, 'PROJECT_VIEW_BUSY'); assert.equal(locks.releaseLock(f.project).ok, true); }
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

test('a separate process holds the guard until killed and its retained marker no longer blocks reopening', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const child = fork(require.resolve('./fixtures/project-view-locks.cjs'), [f.project], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [owned] = await once(child, 'message');
    assert.equal(owned.ok, true);
    const anchor = path.join(f.project, '.aily', 'project-view.guard');
    assert.equal(fs.readFileSync(anchor).length, 0);
    assert.equal((await buffer(fs.createReadStream(anchor))).length, 0);
    const legacyGuard = tryAcquireFileLock(anchor);
    try { assert.equal(legacyGuard, null); }
    finally { legacyGuard?.close(); }
    const locks = load();
    try {
      const occupied = locks.tryAcquireLock(f.project, { force: true });
      assert.equal(occupied.code, 'PROJECT_VIEW_OCCUPIED');
      assert.equal(occupied.holder.pid, child.pid);
      assert.equal(locks.inspectViewLock(f.project).state, 'busy');

      const copy = fixture(t);
      fs.copyFileSync(f.lock, copy.lock);
      fs.writeFileSync(path.join(copy.project, '.aily', 'project-view.guard'), '');
      const copied = locks.tryAcquireLock(copy.project);
      assert.equal(copied.ok, true);
      assert.equal(copied.recoveredStale, true);
      assert.notEqual(copied.viewToken, owned.viewToken);
      assert.equal(locks.inspectViewLock(f.project).snapshot.owner.viewToken, owned.viewToken);

      const owner = JSON.parse(fs.readFileSync(f.lock));
      child.kill('SIGKILL');
      await exited;
      assert.equal(JSON.parse(fs.readFileSync(f.lock)).viewToken, owned.viewToken);
      const reopened = load({ pid: owner.pid, processState: () => true });
      try {
        assert.equal(reopened.inspectViewLock(f.project).state, 'available');
        const next = reopened.tryAcquireLock(f.project);
        assert.equal(next.ok, true);
        assert.equal(next.recoveredStale, true);
        assert.notEqual(next.viewToken, owned.viewToken);
        assert.equal(reopened.releaseLock(f.project, { viewToken: owned.viewToken }).code, 'PROJECT_VIEW_CHANGED');
        assert.equal(reopened.isHeld(f.project, next.viewToken), true);
      } finally { reopened.releaseAll(); }
    } finally { locks.releaseAll(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
