'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { withProjectCopySource } = require('../../electron/project-copy-source');
const { createProjectFileAccess, acquireProjectFileLock } = require('../../electron/project-file-access');
const { acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');

const output = path.resolve(__dirname, '../test-results/abs-five-fixes-final-20261027/copy-source');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-')), project = path.join(root, 'A'), target = path.join(root, 'B.txt');
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, '.aily'));
  fs.writeFileSync(path.join(project, 'project.abi'), '{"source":"preserved"}');
  t.after(() => { assert.ok(root.startsWith(output + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, target, owner: path.join(project, '.aily/project-files.write.lock') };
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }); assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }); return child.pid;
}
function retain(f, pid = deadPid()) {
  const bytes = JSON.stringify({ pid, token: randomUUID() }); fs.writeFileSync(f.owner, bytes); return bytes;
}
function done(settle, action) {
  Promise.resolve().then(action).then(() => settle({ ok: true }), error => settle({ ok: false,
    error: { code: error.code, message: error.message } }));
}
async function heldWriter(project) {
  const module = path.resolve(__dirname, '../../electron/project-file-access.js');
  const child = spawn(process.execPath, ['-e', `const p=process.argv[1],m=require(process.argv[2]);(async()=>{const l=await m.acquireProjectFileLock(m.createProjectFileAccess(p,p),()=>{},0);process.stdout.write('READY\\n');process.stdin.once('data',()=>{l.release();process.exit(0)});})().catch(e=>{console.error(e);process.exit(1)});`, project, module],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Owned writer fixture did not start')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', value => { clearTimeout(timer); assert.match(String(value), /READY/); resolve(); });
    child.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error('Owned writer fixture exited ' + code)); } });
  });
  return { pid: child.pid, async close() { const stopped = new Promise(resolve => child.once('exit', resolve)); child.stdin.end('release'); await stopped; } };
}

test('normal copy holds source publication exclusion, publishes once and revokes its assertion after settlement', async t => {
  const f = fixture(t); let calls = 0, savedGuard;
  const result = await withProjectCopySource(f.project, () => {}, (guard, settle) => {
    calls++; savedGuard = guard;
    done(settle, async () => {
      guard(); assert.equal(typeof guard.replace, 'undefined'); assert.equal(typeof guard.release, 'undefined');
      await assert.rejects(acquireProjectFileLock(createProjectFileAccess(f.project, f.project), () => {}, 0), { code: 'PROJECT_FILE_BUSY' });
      fs.writeFileSync(f.target, 'independent target'); guard();
    });
  });
  assert.equal(result.ok, true); assert.equal(result.source.mode, 'exclusive'); assert.equal(result.source.build.state, 'idle');
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.owner), false); assert.equal(fs.readFileSync(f.target, 'utf8'), 'independent target');
  assert.throws(savedGuard, { code: 'PROJECT_RECOVERY_COPY_CLOSED' });
});
test('a real child writer is retained and rejected before callback execution', async t => {
  const f = fixture(t), child = await heldWriter(f.project); let calls = 0;
  try {
    const before = fs.readFileSync(f.owner), result = await withProjectCopySource(f.project, () => {}, () => { calls++; });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_BUSY');
    assert.equal(result.error.callbackStarted, false); assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.owner), before);
    assert.equal(JSON.parse(before).pid, child.pid);
  } finally { await child.close(); }
});
test('an intact exited marker admits only an independent read scope and still blocks ordinary source writers', async t => {
  const f = fixture(t), before = retain(f); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, (guard, settle) => {
    calls++; done(settle, async () => {
      guard(); await assert.rejects(acquireProjectFileLock(createProjectFileAccess(f.project, f.project), () => {}, 0), { code: 'PROJECT_FILE_BUSY' });
      fs.writeFileSync(f.target, 'saved copy'); guard();
    });
  });
  assert.equal(result.ok, true); assert.equal(result.source.mode, 'retained-dead-owner'); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), before); assert.equal(fs.readFileSync(f.target, 'utf8'), 'saved copy');
});
test('an unqueryable PID is not treated as exited', async t => {
  const f = fixture(t), pid = 987654321, before = retain(f, pid), kill = process.kill; let calls = 0, result;
  try {
    process.kill = function (value, signal) {
      if (value === pid && signal === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return kill.apply(this, arguments);
    };
    result = await withProjectCopySource(f.project, () => {}, () => { calls++; });
  } finally { process.kill = kill; }
  assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_BUSY'); assert.equal(calls, 0); assert.equal(fs.readFileSync(f.owner, 'utf8'), before);
});
for (const value of ['{incomplete', JSON.stringify({ pid: 1.5, token: randomUUID() }), JSON.stringify({ pid: 100, token: 'not-a-token' }),
  JSON.stringify({ pid: 100, token: randomUUID(), foreignProtocol: true })]) test('an invalid retained file owner fails closed without starting publication', async t => {
  const f = fixture(t); fs.writeFileSync(f.owner, value); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, () => { calls++; });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.equal(calls, 0);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), value);
});
test('a hardlinked retained owner is not a source-copy capability', async t => {
  const f = fixture(t), before = retain(f); fs.linkSync(f.owner, path.join(f.root, 'linked-owner')); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, () => { calls++; });
  assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'); assert.equal(calls, 0); assert.equal(fs.readFileSync(f.owner, 'utf8'), before);
});
test('a changed retained marker ends its copy scope without deleting the newer owner', async t => {
  const f = fixture(t); retain(f); const changed = JSON.stringify({ pid: process.pid, token: randomUUID() }); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, (guard, settle) => {
    calls++; done(settle, () => { fs.writeFileSync(f.owner, changed); guard(); });
  });
  assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_CHANGED'); assert.equal(calls, 1); assert.equal(fs.readFileSync(f.owner, 'utf8'), changed);
});
for (const next of ['alive', 'unknown']) test(`a retained owner that becomes ${next} revokes the read scope`, async t => {
  const f = fixture(t), pid = 987654321, before = retain(f, pid), kill = process.kill; let state = 'exited', calls = 0, result;
  try {
    process.kill = function (value, signal) {
      if (value !== pid || signal !== 0) return kill.apply(this, arguments);
      if (state === 'alive') return;
      throw Object.assign(new Error(state), { code: state === 'exited' ? 'ESRCH' : 'EPERM' });
    };
    result = await withProjectCopySource(f.project, () => {}, (guard, settle) => {
      calls++; done(settle, () => { state = next; guard(); });
    });
  } finally { process.kill = kill; }
  assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_CHANGED'); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), before);
});
test('a physical root replacement cannot keep a retained read scope valid', async t => {
  const f = fixture(t), before = retain(f), moved = path.join(f.root, 'old-A'); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, (guard, settle) => {
    calls++; done(settle, () => {
      fs.renameSync(f.project, moved); fs.mkdirSync(f.project); fs.mkdirSync(path.join(f.project, '.aily'));
      fs.writeFileSync(f.owner, before); guard();
    });
  });
  assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_CHANGED'); assert.equal(calls, 1);
  assert.equal(fs.readFileSync(path.join(moved, '.aily/project-files.write.lock'), 'utf8'), before);
  assert.equal(fs.readFileSync(f.owner, 'utf8'), before);
});
test('a callback PROJECT_FILE_BUSY failure never triggers unlocked replay', async t => {
  const f = fixture(t); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, (_guard, settle) => {
    calls++; settle({ ok: false, error: { code: 'PROJECT_FILE_BUSY', message: 'callback conflict' } });
  });
  assert.equal(result.error.code, 'PROJECT_FILE_BUSY'); assert.equal(result.error.callbackStarted, true);
  assert.equal(calls, 1); assert.equal(fs.existsSync(f.owner), false);
});
test('returning a Promise is rejected even if the callback synchronously settles', async t => {
  const f = fixture(t); let calls = 0;
  const result = await withProjectCopySource(f.project, () => {}, (_guard, settle) => { calls++; settle({ ok: true }); return Promise.resolve(); });
  assert.equal(result.error.code, 'PROJECT_RECOVERY_COPY_INVALID'); assert.equal(calls, 1); assert.equal(fs.existsSync(f.owner), false);
});
test('a completed target survives a final context-check failure and is reported uncertain', async t => {
  const f = fixture(t); let complete = false, calls = 0;
  const result = await withProjectCopySource(f.project, () => {
    if (complete) throw Object.assign(new Error('late context'), { code: 'TEST_CONTEXT_CHANGED' });
  }, (_guard, settle) => { calls++; fs.writeFileSync(f.target, 'committed target'); complete = true; settle({ ok: true }); });
  assert.equal(result.error.code, 'TEST_CONTEXT_CHANGED'); assert.equal(result.error.uncertain, true);
  assert.equal(result.error.callbackCompleted, true); assert.equal(calls, 1); assert.equal(fs.readFileSync(f.target, 'utf8'), 'committed target');
});
test('a release-tail I/O failure retains its target and reports completion separately from ownership uncertainty', async t => {
  const f = fixture(t), unlink = fs.unlinkSync; let calls = 0, result;
  try {
    fs.unlinkSync = function (filename) {
      if (filename === f.owner) throw Object.assign(new Error('Injected release tail'), { code: 'EIO' });
      return unlink.apply(this, arguments);
    };
    result = await withProjectCopySource(f.project, () => {}, (_guard, settle) => {
      calls++; fs.writeFileSync(f.target, 'committed target'); settle({ ok: true });
    });
  } finally { fs.unlinkSync = unlink; }
  assert.equal(result.error.code, 'PROJECT_RECOVERY_COPY_UNCERTAIN'); assert.equal(result.error.uncertain, true);
  assert.equal(result.error.callbackCompleted, true); assert.equal(calls, 1); assert.equal(fs.readFileSync(f.target, 'utf8'), 'committed target');
  assert.equal(JSON.parse(fs.readFileSync(f.owner)).pid, process.pid);
});
test('a currently held build lease blocks the callback without changing that build owner', async t => {
  const f = fixture(t), lease = acquireBuildWorkspace(f.project, 'compile'), owner = path.join(f.project, '.build/aily-workspace.lock'); let calls = 0;
  try {
    const before = fs.readFileSync(owner), result = await withProjectCopySource(f.project, () => {}, () => { calls++; });
    assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_BUSY'); assert.equal(result.error.callbackStarted, false);
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(owner), before); lease.assertOwned(); assert.equal(fs.existsSync(f.owner), false);
  } finally { lease.release(); }
});
test('a build that starts after publication is not mislabeled as a completed safe copy', async t => {
  const f = fixture(t); let lease, calls = 0;
  try {
    const result = await withProjectCopySource(f.project, () => {}, (_guard, settle) => {
      calls++; fs.writeFileSync(f.target, 'saved target'); lease = acquireBuildWorkspace(f.project, 'compile'); settle({ ok: true });
    });
    assert.equal(result.error.code, 'PROJECT_RECOVERY_SOURCE_BUSY'); assert.equal(result.error.uncertain, true);
    assert.equal(result.error.callbackCompleted, true); assert.equal(calls, 1); lease.assertOwned();
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'saved target'); assert.equal(fs.existsSync(f.owner), false);
  } finally { lease?.release(); }
});
test('a retained orphan build and exited file marker preserve the independent-copy escape route', async t => {
  const f = fixture(t), pid = deadPid(), before = retain(f, pid); fs.mkdirSync(path.join(f.project, '.build'));
  const build = path.join(f.project, '.build/aily-workspace.lock'), bytes = JSON.stringify({ schemaVersion: 1, nativeLeaseVersion: 1,
    delegationVersion: 1, delegated: true, pid, token: randomUUID(), operation: 'compile' }); fs.writeFileSync(build, bytes);
  const result = await withProjectCopySource(f.project, () => {}, (guard, settle) => { guard(); fs.writeFileSync(f.target, 'independent'); settle({ ok: true }); });
  assert.equal(result.ok, true); assert.equal(result.source.mode, 'retained-dead-owner'); assert.equal(result.source.build.state, 'ownership-unconfirmed');
  assert.equal(fs.readFileSync(f.owner, 'utf8'), before); assert.equal(fs.readFileSync(build, 'utf8'), bytes);
});
