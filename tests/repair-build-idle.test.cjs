'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { inspectBuildWorkspaceIdle, acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');
const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');

const output = path.resolve(__dirname, 'test-results/abs-recovery-restart-20261026/build-idle');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(output, 'case-'));
    t.after(() => {
        assert.ok(path.resolve(root).startsWith(output + path.sep));
        assert.equal(fs.readFileSync(path.join(root, 'project/.aily/build-workspace.guard'), 'utf8'), 'permanent anchor');
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'project'), build = path.join(project, '.build'), coordination = path.join(project, '.aily');
    fs.mkdirSync(build, { recursive: true }); fs.mkdirSync(coordination);
    const anchor = path.join(coordination, 'build-workspace.guard'); fs.writeFileSync(anchor, 'permanent anchor');
    const owner = path.join(build, 'aily-workspace.lock'), builder = path.join(build, 'aily-builder.lock'), legacy = path.join(build, 'aily-workspace-recovery.lock');
    // Windows enforces the kernel byte-range lock against separate reads of
    // the anchor too. Journal bytes are observable while held; anchor bytes
    // are checked after release in fixture teardown.
    const paths = [owner, builder, legacy];
    const bytes = () => paths.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null]);
    return { root, project, owner, builder, legacy, anchor, bytes,
        write(record, file = owner) { fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record)); } };
}
function record(pid, extra = {}) {
    return { schemaVersion: 1, nativeLeaseVersion: 1, delegationVersion: 1, delegated: false,
        pid, token: randomUUID(), operation: 'compile', ...extra };
}
function deadPid() {
    const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 10000 });
    assert.equal(exited.status, 0);
    assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
    return exited.pid;
}
function rejectUnchanged(f, reason, code = 'BUILD_WORKSPACE_RECOVERY_REQUIRED') {
    const before = f.bytes();
    assert.throws(() => inspectBuildWorkspaceIdle(f.project), error => {
        assert.equal(error.code, code); assert.equal(error.details.resource, 'build-workspace');
        assert.equal(error.details.reason, reason); assert.equal(error.resource, 'build-workspace');
        assert.ok(Object.hasOwn(error.details, 'owner')); return true;
    });
    assert.deepEqual(f.bytes(), before);
    const available = tryAcquireFileLock(f.anchor); assert.ok(available, 'rejected inspection must release its own kernel handle'); available.close();
}

test('an empty workspace is observed under a held guard without publishing an owner', t => {
    const f = fixture(t), before = f.bytes(), lease = inspectBuildWorkspaceIdle(f.project);
    try {
        lease.assertIdle(); assert.equal(tryAcquireFileLock(f.anchor), null);
        assert.deepEqual(f.bytes(), before);
    } finally { lease.release(); lease.release(); }
    const available = tryAcquireFileLock(f.anchor); assert.ok(available); available.close();
});
test('explicitly released native owner remains byte-for-byte while its idle inspection is held', t => {
    const f = fixture(t); f.write(record(process.pid, { delegated: true, released: true }));
    const before = f.bytes(), lease = inspectBuildWorkspaceIdle(f.project);
    try { lease.assertIdle(); assert.deepEqual(f.bytes(), before); } finally { lease.release(); }
    assert.deepEqual(f.bytes(), before);
});
test('a confirmed exited native owner with no delegation is idle without retiring its record', t => {
    const f = fixture(t); f.write(record(deadPid())); const before = f.bytes();
    const lease = inspectBuildWorkspaceIdle(f.project); lease.assertIdle(); lease.release();
    assert.deepEqual(f.bytes(), before);
});
test('an alive unclosed owner is not declared idle merely because its native guard is free', t => {
    const f = fixture(t); f.write(record(process.pid)); rejectUnchanged(f, 'owner-alive', 'BUILD_WORKSPACE_BUSY');
});
test('a delegated exited owner preserves unknown compiler descendants and all journals', t => {
    const f = fixture(t); f.write(record(deadPid(), { delegated: true })); rejectUnchanged(f, 'delegation-unconfirmed');
});
test('a legacy exited owner is not upgraded or marked observed during idle inspection', t => {
    const f = fixture(t); f.write({ schemaVersion: 1, pid: deadPid(), token: randomUUID(), operation: 'compile' });
    rejectUnchanged(f, 'legacy-owner-unconfirmed');
});
test('an unreadable owner is retained and reported rather than treated as an empty workspace', t => {
    const f = fixture(t); f.write('partial owner\r\n'); rejectUnchanged(f, 'owner-unreadable');
});
for (const name of ['builder', 'legacy']) test(`${name} evidence blocks idle inspection even without a host owner`, t => {
    const f = fixture(t); f.write('unconfirmed marker\r\n', f[name]);
    rejectUnchanged(f, name === 'builder' ? 'builder-phase-unconfirmed' : 'legacy-recovery-unconfirmed');
});
test('an existing active kernel guard is not released or rewritten by the rejected observer', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile'), before = f.bytes();
    try {
        assert.throws(() => inspectBuildWorkspaceIdle(f.project), error => error.code === 'BUILD_WORKSPACE_BUSY'
            && error.details.reason === 'native-guard-unavailable' && error.details.owner.pid === process.pid);
        assert.deepEqual(f.bytes(), before); assert.equal(tryAcquireFileLock(f.anchor), null); owner.assertOwned();
    } finally { owner.release(); }
});
test('an ongoing observer rechecks new evidence, closes its guard on rejection and leaves the evidence intact', t => {
    const f = fixture(t), lease = inspectBuildWorkspaceIdle(f.project);
    f.write('new unknown phase', f.builder); const before = f.bytes();
    assert.throws(lease.assertIdle, error => error.details.reason === 'builder-phase-unconfirmed');
    assert.deepEqual(f.bytes(), before); lease.release();
    const available = tryAcquireFileLock(f.anchor); assert.ok(available); available.close();
});
