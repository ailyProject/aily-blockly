'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { acquireBuildWorkspace } = require('./build-workspace-lease');
const { publishArduinoGeneratedCode: publish, patchBuildMetadata: patch } = require('./build-workspace-publication');
const header = (content = 'const int a = 1;') => ({ fileName: 'variables_data-12345678.h', content, sourceTag: 'data' });

function fixture(t, type = 'blockly') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-publication-'));
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-build-publication-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write('package.json', JSON.stringify({ type, dependencies: { board: '1' }, unrelated: 'keep' }));
    return { root, write, read: name => fs.readFileSync(path.join(root, name), 'utf8'), exists: name => fs.existsSync(path.join(root, name)) };
}

test('publishes headers and sketch together, removes only owned names, leaves firmware bytes intact', t => {
    const f = fixture(t);
    for (const name of ['src/user.h', 'src/objects_old-abcdef12.h', '.temp/sketch/generated/objects_old-abcdef12.h',
        '.temp/sketch/generated/user.h', '.build/aily-artifact-manifest.json', '.build/aily-build-delivery.json', '.build/firmware.elf']) f.write(name, 'old');
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'sketch' }), { changed: true });
    assert.equal(f.read('src/variables_data-12345678.h'), header().content);
    assert.equal(f.read('.temp/sketch/sketch.ino'), 'sketch');
    assert.equal(f.read('src/user.h'), 'old'); assert.equal(f.read('.temp/sketch/generated/user.h'), 'old');
    for (const name of ['src/objects_old-abcdef12.h', '.temp/sketch/generated/objects_old-abcdef12.h', '.build/aily-artifact-manifest.json', '.build/aily-build-delivery.json', '.build/aily-workspace.lock']) assert.equal(f.exists(name), false);
    assert.equal(f.read('.build/firmware.elf'), 'old');
});

test('identical publication does not touch inputs, old success tickets or their mtimes', t => {
    const f = fixture(t); publish(f.root, { artifacts: [header()], sketchCode: 'sketch' });
    f.write('.build/aily-artifact-manifest.json', 'success');
    const before = fs.statSync(path.join(f.root, 'src', header().fileName));
    assert.deepEqual(publish(f.root, { artifacts: [header()], sketchCode: 'sketch' }), { changed: false });
    assert.equal(fs.statSync(path.join(f.root, 'src', header().fileName)).mtimeMs, before.mtimeMs);
    assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

for (const operation of ['compile', 'preprocess']) test(`${operation} owner blocks all publication before changing any file`, t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, operation);
    f.write('src/user.h', 'keep'); f.write('.temp/sketch/sketch.ino', 'keep');
    const pkg = f.read('package.json');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /BUILD_WORKSPACE_BUSY/);
    assert.throws(() => patch(f.root, { codeHash: 'a'.repeat(64) }), /BUILD_WORKSPACE_BUSY/);
    assert.equal(f.read('package.json'), pkg); assert.equal(f.read('.temp/sketch/sketch.ino'), 'keep');
    assert.equal(f.exists(`src/${header().fileName}`), false); lease.release();
});

test('actual compile/preprocess processes cannot enter while publication owns the workspace', t => {
    const f = fixture(t), owner = acquireBuildWorkspace(f.root, 'publish');
    const filename = path.join(f.root, 'request.json'); f.write('request.json', JSON.stringify({ currentProjectPath: f.root }));
    for (const command of ['compile', 'preprocess']) {
        const result = spawnSync(process.execPath, [path.join(__dirname, `${command}.js`), filename], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        assert.equal(result.status, 1); assert.match(result.stderr, /BUILD_WORKSPACE_BUSY/);
    }
    owner.release();
});

test('invalid namespace, duplicates, wrong project mode and oversized lists fail without partial writes', t => {
    const f = fixture(t);
    const invalid = [[header(), { ...header(), fileName: '../user.h' }], [header(), header()], Array(257).fill(header())];
    for (const artifacts of invalid) assert.throws(() => publish(f.root, { artifacts }), /BUILD_PUBLICATION_INVALID/);
    assert.equal(f.exists('src'), false);
    f.write('package.json', '{"type":"coder"}');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /only for Blockly/);
    assert.equal(f.exists('src'), false); assert.equal(f.exists('.build/aily-workspace.lock'), false);
    for (const value of ['null', '[]']) {
        f.write('package.json', value);
        assert.throws(() => publish(f.root, { artifacts: [header()] }), /Invalid project manifest/);
    }
    fs.unlinkSync(path.join(f.root, 'package.json'));
    assert.throws(() => publish(f.root, { artifacts: [header()] }), /package.json is missing/);
    assert.equal(f.exists('src'), false);
});

for (const directory of ['src', '.temp', '.temp/sketch', '.temp/sketch/generated']) test(`refuses ${directory} junction without changing external targets or tickets`, t => {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const link = path.join(f.root, directory); fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link, 'junction');
    f.write('.build/aily-artifact-manifest.json', 'success');
    assert.throws(() => publish(f.root, { artifacts: [header()], sketchCode: 'wrong' }), /linked/);
    assert.deepEqual(fs.readdirSync(outside), []); assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

test('refuses hardlinked generated headers before invalidating the previous success', t => {
    const f = fixture(t); f.write('other.h', 'keep'); fs.mkdirSync(path.join(f.root, 'src'));
    fs.linkSync(path.join(f.root, 'other.h'), path.join(f.root, 'src', header().fileName));
    f.write('.build/aily-artifact-manifest.json', 'success');
    assert.throws(() => publish(f.root, { artifacts: [header()] }), /linked/);
    assert.equal(f.read('other.h'), 'keep'); assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
});

test('metadata patches preserve each latest manifest, mirror configuration and success ticket', t => {
    const f = fixture(t); f.write('.temp/package.json', '{"dependencies":{"board":"2"},"custom":true}');
    f.write('.build/aily-artifact-manifest.json', 'success');
    const info = { lastBuildTime: new Date().toISOString(), lastBuildCode: 'b'.repeat(64), lastBuildStatus: 'success', lastBuildDuration: 1 };
    const result = patch(f.root, { codeHash: 'a'.repeat(64), buildInfo: info });
    assert.equal(result.unrelated, 'keep'); assert.deepEqual(result.dependencies, { board: '1' });
    const mirror = JSON.parse(f.read('.temp/package.json')); assert.deepEqual(mirror.dependencies, { board: '2' });
    assert.equal(mirror.custom, true); assert.deepEqual(mirror.buildInfo, info);
    assert.equal(f.read('.build/aily-artifact-manifest.json'), 'success');
    assert.equal(f.exists('.build/aily-workspace.lock'), false);
});

test('Coder metadata does not create a Blockly package mirror; unrelated fields are not patchable', t => {
    const f = fixture(t, 'coder'); patch(f.root, { codeHash: 'a'.repeat(64) });
    assert.equal(f.exists('.temp'), false);
    const original = f.read('package.json');
    for (const change of [{ dependencies: {} }, { codeHash: 'bad' }, { buildInfo: {} }]) assert.throws(() => patch(f.root, change), /BUILD_PUBLICATION_INVALID/);
    assert.equal(f.read('package.json'), original);
});
