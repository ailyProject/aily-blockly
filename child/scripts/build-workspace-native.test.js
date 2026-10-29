'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { acquireBuildWorkspace, createBuildWorkspaceSupervisor, inspectBuildWorkspaceIdle } = require('./build-workspace-lease');
const modulePath = require.resolve('./build-workspace-lease');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-native-workspace-test-')));
    const children = [];
    t.after(async () => {
        await Promise.all(children.map(stopOwned));
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-native-workspace-test-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, children, owner: path.join(root, '.build/aily-workspace.lock'), anchor: path.join(root, '.aily/build-workspace.guard') };
}

async function stopOwned(child) {
    if (child.exitCode !== null || child.signalCode !== null) return { alreadyClosed: true };
    const closed = once(child, 'close'); child.kill();
    let timer;
    try {
        const value = await Promise.race([closed, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Error('Owned fixture process close remained unconfirmed.')), 10000);
        })]);
        return { closeObserved: true, code: value[0], signal: value[1] };
    } finally { clearTimeout(timer); }
}

async function startOwned(t, f, supervisor, delegated) {
    const script = `const lease=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
      if(process.argv[3]==='1')lease.childEnvironment();
      process.stdout.write(JSON.stringify({ready:true,pid:process.pid})+'\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script, modulePath, f.root, delegated ? '1' : '0'], {
        env: { ...process.env, ...supervisor.environment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    f.children.push(child);
    let timer, text = '', stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
    await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('Owned native fixture did not become ready: ' + stderr)), 10000);
        child.once('error', reject); child.once('close', () => reject(Error('Owned native fixture closed before readiness: ' + stderr)));
        child.stdout.on('data', bytes => {
            text += bytes.toString();
            if (text.length > 4096) return reject(Error('Fixture readiness exceeded its bound.'));
            if (!text.includes('\n')) return;
            try { const value = JSON.parse(text.split('\n')[0]); assert.equal(value.ready, true); assert.equal(value.pid, child.pid); resolve(); }
            catch (error) { reject(error); }
        });
    }).finally(() => clearTimeout(timer));
    return child;
}

test('native workspace guard excludes a concurrent real process without changing owner or anchor', t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, 'compile');
    try {
        const bytes = fs.readFileSync(f.owner), record = JSON.parse(bytes), anchor = fs.lstatSync(f.anchor);
        assert.equal(record.nativeLeaseVersion, 1); assert.equal(record.delegationVersion, 1); assert.equal(record.delegated, false);
        const child = spawnSync(process.execPath, ['-e', `try{require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');process.exitCode=2;}
          catch(e){process.stdout.write(e.code);if(e.code!=='BUILD_WORKSPACE_BUSY')process.exitCode=3;}`, modulePath, f.root], {
            env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10000,
        });
        assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'BUILD_WORKSPACE_BUSY');
        assert.deepEqual(fs.readFileSync(f.owner), bytes); assert.equal(fs.lstatSync(f.anchor).ino, anchor.ino); lease.assertOwned();
    } finally { lease.release(); }
    assert(!fs.existsSync(f.owner)); assert(fs.existsSync(f.anchor));
});

for (const delegated of [false, true]) test(`cancelled native owner retains ${delegated ? 'delegated' : 'undelegated'} responsibility until its permitted supervisor action`, async t => {
    const f = fixture(t), supervisor = createBuildWorkspaceSupervisor(f.root), foreign = createBuildWorkspaceSupervisor(f.root);
    const child = await startOwned(t, f, supervisor, delegated), before = fs.readFileSync(f.owner), record = JSON.parse(before);
    assert.equal(record.nativeLeaseVersion, 1); assert.equal(record.delegationVersion, 1); assert.equal(record.delegated, delegated);
    assert.equal(supervisor.canReleaseResources(), false); assert.equal(supervisor.releaseAfterTermination(false), false);
    const terminal = await stopOwned(child); assert.equal(terminal.closeObserved, true);
    assert.equal(foreign.releaseAfterTermination(true), false); assert.deepEqual(fs.readFileSync(f.owner), before);
    if (delegated) {
        assert.equal(supervisor.releaseAfterOwnerExit(), false);
        assert.throws(() => inspectBuildWorkspaceIdle(f.root), error => error.code === 'BUILD_WORKSPACE_RECOVERY_REQUIRED');
        assert.deepEqual(fs.readFileSync(f.owner), before);
        // This fixture has one known process and no delegated child. Only its
        // observed termination permits this explicit complete-tree assertion.
        assert.equal(supervisor.releaseAfterTermination(true), true);
    } else assert.equal(supervisor.releaseAfterOwnerExit(), true);
    assert.equal(supervisor.canReleaseResources(), true); assert(!fs.existsSync(f.owner));
    const idle = inspectBuildWorkspaceIdle(f.root); idle.assertIdle(); idle.release(); assert(fs.existsSync(f.anchor));
});
