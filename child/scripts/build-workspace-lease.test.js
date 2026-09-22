'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { acquireBuildWorkspace, createBuildWorkspaceSupervisor, OWNER_ENV, BUILDER_ENV } = require('./build-workspace-lease');
const modulePath = path.join(__dirname, 'build-workspace-lease.js');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-workspace-owner-'));
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-workspace-owner-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = path.join(root, 'project'); fs.mkdirSync(project);
    return { root, project, lock: path.join(project, '.build/aily-workspace.lock') };
}

test('one owner per canonical project; another project remains independent', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile');
    assert.throws(() => acquireBuildWorkspace(f.project, 'preprocess'), { code: 'BUILD_WORKSPACE_BUSY' });
    const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.project, alias, 'junction');
    assert.throws(() => acquireBuildWorkspace(alias, 'compile'), { code: 'BUILD_WORKSPACE_BUSY' });
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    acquireBuildWorkspace(other, 'compile').release();
    owner.assertOwned(); owner.release(); owner.release();
    assert.equal(fs.existsSync(f.lock), false);
    acquireBuildWorkspace(f.project, 'preprocess').release();
});

test('only the direct preprocess child borrows the live compile owner without releasing it', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile');
    const code = `const {acquireBuildWorkspace,OWNER_ENV}=require(process.argv[1]);
      const w=acquireBuildWorkspace(process.argv[2],'preprocess',{inherited:process.env[OWNER_ENV]});w.assertOwned();w.release();`;
    const child = spawnSync(process.execPath, ['-e', code, modulePath, f.project],
        { env: owner.childEnvironment(), encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr); owner.assertOwned();
    const wrong = spawnSync(process.execPath, ['-e', code, modulePath, f.project],
        { env: { ...owner.childEnvironment(), [OWNER_ENV]: 'not-owner' }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(wrong.status, 0); assert.match(wrong.stderr, /OWNER_MISMATCH/);
    const record = JSON.parse(fs.readFileSync(f.lock));
    assert.throws(() => acquireBuildWorkspace(f.project, 'compile', { inherited: record.token }), /OWNER_MISMATCH/);
    owner.release();
});

for (const command of ['compile', 'preprocess']) test(`competing actual ${command} entry preserves owner inputs and old tickets`, t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile');
    fs.mkdirSync(path.join(f.project, '.temp/sketch'), { recursive: true });
    const files = ['.build/aily-artifact-manifest.json', '.build/aily-build-delivery.json', '.build/aily-library-projections.json',
        '.build/firmware.elf', '.temp/preprocess.json', '.temp/sketch/sketch.ino'];
    for (const name of files) fs.writeFileSync(path.join(f.project, name), 'preserve');
    const config = path.join(f.root, 'request.json');
    fs.writeFileSync(config, JSON.stringify({ currentProjectPath: f.project, code: 'contender' }));
    const result = spawnSync(process.execPath, [path.join(__dirname, `${command}.js`), config],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /BUILD_WORKSPACE_BUSY/);
    for (const name of files) assert.equal(fs.readFileSync(path.join(f.project, name), 'utf8'), 'preserve');
    owner.assertOwned(); owner.release();
});

test('normal preprocessing failure releases ownership and revokes old success', t => {
    const f = fixture(t), config = path.join(f.root, 'request.json');
    fs.mkdirSync(path.dirname(f.lock));
    const artifact = path.join(f.project, '.build/aily-artifact-manifest.json'); fs.writeFileSync(artifact, 'old');
    fs.writeFileSync(config, JSON.stringify({ currentProjectPath: f.project, boardModule: 'missing', code: '', appDataPath: f.root }));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'preprocess.js'), config],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.existsSync(artifact), false);
    acquireBuildWorkspace(f.project, 'compile').release();
});

test('replaced/corrupted ownership cannot publish, release or delete another marker', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile');
    const original = fs.readFileSync(f.lock, 'utf8');
    fs.writeFileSync(f.lock, original.replace('compile', 'preprocess'));
    assert.throws(owner.assertOwned, /BUILD_WORKSPACE_CHANGED/);
    assert.throws(owner.release, /BUILD_WORKSPACE_CHANGED/);
    assert.ok(fs.existsSync(f.lock));
    fs.writeFileSync(f.lock, original); owner.release();
});

test('unsafe build directory and lock links are refused without touching their targets', t => {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.project, '.build'), 'junction');
    assert.throws(() => acquireBuildWorkspace(f.project, 'compile'), /symlink\/junction/);
    assert.deepEqual(fs.readdirSync(outside), []);
    fs.unlinkSync(path.join(f.project, '.build')); fs.mkdirSync(path.join(f.project, '.build'));
    const target = path.join(outside, 'data'); fs.writeFileSync(target, 'keep'); fs.linkSync(target, f.lock);
    assert.throws(() => acquireBuildWorkspace(f.project, 'compile'), /BUSY/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('real competing processes never acquire the same workspace together', async t => {
    const f = fixture(t);
    const code = `const {acquireBuildWorkspace}=require(process.argv[1]);
      try { const w=acquireBuildWorkspace(process.argv[2],'compile');process.send('acquired');
        process.once('message',()=>{w.release();process.exit(0)});
      } catch(e) {process.send(e.code);process.exit(0);}`;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['-e', code, modulePath, f.project],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    const finished = children.map(child => once(child, 'close'));
    const results = await Promise.all(children.map(child => once(child, 'message').then(([message]) => message)));
    assert.equal(results.filter(result => result === 'acquired').length, 1);
    assert.equal(results.filter(result => result === 'BUILD_WORKSPACE_BUSY').length, 5);
    children[results.indexOf('acquired')].send('release');
    await Promise.all(finished); assert.equal(fs.existsSync(f.lock), false);
});

test('an exited owner is not automatically reclaimed while untracked compiler descendants could survive', t => {
    const f = fixture(t);
    const result = spawnSync(process.execPath, ['-e', `require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');process.exit(0);`, modulePath, f.project],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const bytes = fs.readFileSync(f.lock);
    assert.throws(() => acquireBuildWorkspace(f.project, 'compile'), /BUILD_WORKSPACE_RECOVERY_REQUIRED/);
    assert.deepEqual(fs.readFileSync(f.lock), bytes);
});

test('confirmed cancellation only releases the marker belonging to that registered supervisor', t => {
    const f = fixture(t), supervisor = createBuildWorkspaceSupervisor(f.project);
    const other = createBuildWorkspaceSupervisor(f.project);
    const result = spawnSync(process.execPath, ['-e', `require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');`, modulePath, f.project],
        { env: { ...process.env, ...supervisor.environment }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(supervisor.releaseAfterTermination(false), false);
    assert.equal(other.releaseAfterTermination(true), false);
    assert.equal(fs.existsSync(f.lock), true);
    assert.equal(supervisor.releaseAfterTermination(true), true);
    assert.equal(supervisor.releaseAfterTermination(true), true);
    acquireBuildWorkspace(f.project, 'compile').release();
});

test('a successful stop claim cannot release a still-live owner', t => {
    const f = fixture(t), supervisor = createBuildWorkspaceSupervisor(f.project);
    const owner = acquireBuildWorkspace(f.project, 'compile');
    const bytes = fs.readFileSync(f.lock, 'utf8');
    fs.writeFileSync(f.lock, JSON.stringify({ ...JSON.parse(bytes), supervisor: Object.values(supervisor.environment)[0] }));
    assert.equal(supervisor.releaseAfterTermination(true), false);
    fs.writeFileSync(f.lock, bytes); owner.release();
});

test('Builder delegation is explicit, scoped and cannot release the parent during an active phase', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'compile');
    const environment = owner.builderEnvironment('preprocess'), grant = JSON.parse(environment[BUILDER_ENV]);
    assert.equal(grant.directory, path.join(fs.realpathSync(f.project), '.build'));
    assert.equal(grant.operation, 'preprocess'); assert.equal(grant.issuerPid, process.pid);
    assert.equal(grant.token, owner.buildId); assert.equal(process.env[BUILDER_ENV], undefined);
    const childMarker = path.join(f.project, '.build/aily-builder.lock'); fs.writeFileSync(childMarker, 'in-progress');
    owner.assertOwned();
    assert.throws(owner.assertBuilderIdle, /RECOVERY_REQUIRED/);
    assert.throws(() => owner.builderEnvironment('compile'), /RECOVERY_REQUIRED/);
    assert.throws(owner.release, /RECOVERY_REQUIRED/); assert.ok(fs.existsSync(f.lock));
    fs.unlinkSync(childMarker); owner.release();
    const publication = acquireBuildWorkspace(f.project, 'publish');
    assert.throws(() => publication.builderEnvironment('compile'), /OWNER_MISMATCH/); publication.release();
});

test('read-only verification shares exclusion but cannot delegate a compiler', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.project, 'verify');
    assert.equal(JSON.parse(owner.builderEnvironment('verify')[BUILDER_ENV]).operation, 'verify');
    for (const operation of ['compile', 'preprocess']) {
        assert.throws(() => owner.builderEnvironment(operation), /OWNER_MISMATCH/);
        assert.throws(() => acquireBuildWorkspace(f.project, operation), /BUSY/);
    }
    owner.release();
    const compiler = acquireBuildWorkspace(f.project, 'compile');
    assert.throws(() => compiler.builderEnvironment('verify'), /OWNER_MISMATCH/);
    compiler.release();
});

test('an orphan Builder phase blocks new host compilation and publication', t => {
    const f = fixture(t); fs.mkdirSync(path.dirname(f.lock));
    const marker = path.join(f.project, '.build/aily-builder.lock'); fs.writeFileSync(marker, 'incomplete');
    for (const operation of ['compile', 'preprocess', 'publish']) {
        assert.throws(() => acquireBuildWorkspace(f.project, operation), /RECOVERY_REQUIRED/);
        assert.equal(fs.existsSync(f.lock), false); assert.equal(fs.readFileSync(marker, 'utf8'), 'incomplete');
    }
});

test('confirmed supervisor cleanup removes only its stopped Builder phase before the parent marker', t => {
    const f = fixture(t), supervisor = createBuildWorkspaceSupervisor(f.project);
    const code = `const fs=require('fs'),path=require('path');const m=require(process.argv[1]);
      const l=m.acquireBuildWorkspace(process.argv[2],'compile');const p=path.join(process.argv[2],'.build');
      const parent=JSON.parse(fs.readFileSync(path.join(p,'aily-workspace.lock')));
      fs.writeFileSync(path.join(p,'aily-builder.lock'),JSON.stringify({...parent,ownerToken:parent.token}));`;
    const result = spawnSync(process.execPath, ['-e', code, modulePath, f.project],
        { env: { ...process.env, ...supervisor.environment }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const childMarker = path.join(f.project, '.build/aily-builder.lock'), bytes = fs.readFileSync(childMarker, 'utf8');
    fs.writeFileSync(childMarker, JSON.stringify({ ...JSON.parse(bytes), pid: process.pid }));
    assert.equal(supervisor.releaseAfterTermination(true), false); assert.ok(fs.existsSync(f.lock));
    fs.writeFileSync(childMarker, JSON.stringify({ ...JSON.parse(bytes), ownerToken: 'another-owner' }));
    assert.equal(supervisor.releaseAfterTermination(true), false); assert.ok(fs.existsSync(f.lock));
    fs.writeFileSync(childMarker, bytes);
    assert.equal(supervisor.releaseAfterTermination(false), false);
    assert.equal(supervisor.releaseAfterTermination(true), true);
    assert.equal(fs.existsSync(childMarker), false); assert.equal(fs.existsSync(f.lock), false);
});
