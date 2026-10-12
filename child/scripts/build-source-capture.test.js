'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureBuildSource, confirmBuildSource } = require('./build-source-capture');
const { captureProjectSources, publishBuildDelivery } = require('./compile-delivery');
const { prepareCompileSource } = require('./compile-source');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, coder = false) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-source-capture-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-source-capture-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    put('package.json', JSON.stringify({ type: coder ? 'coder' : 'blockly', projectConfig: { CPUFreq: '240' } }));
    put('node_modules/@aily-project/board-test/board.json', '{}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    const header = 'src/variables_test-12345678.h';
    put(coder ? 'sketch/src/main.cpp' : header, coder ? 'void setup() {}' : 'int data = 1;');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}' };
    const documentText = '{"blocks":[]}';
    if (!coder) put('project.abi', documentText);
    const workspace = coder ? undefined : { documentText, revision: 4, runtimeRevision: 9, pageId: 'main',
        savedProjectFiles: [{ path: 'project.abi', sizeBytes: Buffer.byteLength(documentText), sha256: hash(documentText) }] };
    config.sourceCapture = captureBuildSource(config, workspace);
    return { root, config, put, workspace, header };
}

for (const coder of [false, true]) test(`capture binds ${coder ? 'Coder disk entry' : 'Blockly prepared revision'} and ignores only build result metadata`, t => {
    const f = fixture(t, coder), first = confirmBuildSource(f.config);
    assert.ok(first.digest); assert.equal(first.mode, coder ? 'coder' : 'blockly');
    assert.equal(first.workspace?.revision, f.workspace?.revision);
    assert.equal(JSON.stringify(first).includes(f.root), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8'));
    f.put('package.json', JSON.stringify({ ...manifest, buildInfo: { lastBuildTime: 'later' }, codeHash: 'x' }, null, 2));
    assert.equal(confirmBuildSource(f.config).digest, first.digest);
});

for (const change of ['config', 'board', 'board-package', 'code', 'header', 'header-add', 'header-delete', 'digest', 'workspace']) {
    test(`capture rejects ${change} drift before preprocessing`, t => {
        const f = fixture(t);
        if (change === 'config') f.put('package.json', '{"projectConfig":{"CPUFreq":"80"}}');
        if (change === 'board') f.put('node_modules/@aily-project/board-test/board.json', '{"changed":true}');
        if (change === 'board-package') f.put('node_modules/@aily-project/board-test/package.json', '{"version":"2"}');
        if (change === 'code') f.config.code = 'void loop() {}';
        if (change === 'header') f.put(f.header, 'int data = 2;');
        if (change === 'header-add') f.put('src/objects_extra-12345678.h', 'int extra;');
        if (change === 'header-delete') fs.unlinkSync(path.join(f.root, f.header));
        if (change === 'digest') f.config.sourceCapture.digest = 'f'.repeat(64);
        if (change === 'workspace') f.config.sourceCapture.workspace.revision++;
        assert.throws(() => confirmBuildSource(f.config), /BUILD_SOURCE_STALE/);
    });
}

test('Coder queued stale code cannot overwrite a newer user edit even without full input recording', t => {
    const f = fixture(t, true);
    f.put('sketch/src/main.cpp', 'new user edit');
    f.put('.build/aily-artifact-manifest.json', 'previous');
    f.put('.temp/stale.json', JSON.stringify(f.config));
    for (const command of ['compile', 'preprocess']) {
        const r = spawnSync(process.execPath, [path.join(__dirname, `${command}.js`), path.join(f.root, '.temp/stale.json')],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /BUILD_SOURCE_STALE/);
        assert.equal(fs.readFileSync(path.join(f.root, 'sketch/src/main.cpp'), 'utf8'), 'new user edit');
        assert.equal(fs.readFileSync(path.join(f.root, '.build/aily-artifact-manifest.json'), 'utf8'), 'previous');
        assert.equal(fs.existsSync(path.join(f.root, '.build/aily-workspace.lock')), false);
    }
});

test('capture refuses linked generated files and foreign workspace claims', t => {
    const f = fixture(t);
    fs.unlinkSync(path.join(f.root, f.header)); fs.mkdirSync(path.join(f.root, 'outside'));
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, f.header), 'junction');
    assert.throws(() => confirmBuildSource(f.config), /implicit links/);
    const coder = fixture(t, true);
    assert.throws(() => captureBuildSource(coder.config, f.workspace), /Coder cannot/);
    assert.throws(() => captureBuildSource(coder.config, { ...f.workspace, revision: -1 }), /Invalid workspace/);
});

test('delivery carries the exact captured origin, never current-project authority', async t => {
    const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts', configurationSha256: 'c'.repeat(64),
        steps: ['sketch', 'libraries', 'core', 'linking'].map(name => ({ kind: 'ninja-plan', name, sha256: 'd'.repeat(64) })) };
    const record = { ...body, digest: hash(JSON.stringify(body)) }, bytes = JSON.stringify(record);
    f.put('.build/aily-build-inputs.json', bytes);
    f.put('.build/aily-artifact-manifest.json', JSON.stringify({ schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
        target: { fqbn: 'test:core:board' }, build: { source: { sha256: hash(f.config.code), sizeBytes: Buffer.byteLength(f.config.code) },
            inputs: { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest } },
        files: [{ path: 'aily-build-inputs.json', role: 'build-inputs', sizeBytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] }));
    const receipt = publishBuildDelivery(f.config, snapshot, entry, 'test:core:board');
    assert.deepEqual(receipt.sourceCapture, f.config.sourceCapture); assert.equal(receipt.currentProjectAcceptance, false);
    assert.equal(receipt.buildInputsDigest, record.digest);
    f.put(f.header, 'changed before publication');
    assert.throws(() => publishBuildDelivery(f.config, snapshot, entry, 'test:core:board'), /CHANGED|STALE/);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
});

test('capture quotas refuse oversized configuration and too many generated headers without partial evidence', t => {
    const f = fixture(t);
    f.put('node_modules/@aily-project/board-test/board.json', ' '.repeat(2 * 1024 * 1024 + 1));
    assert.throws(() => captureBuildSource(f.config, f.workspace), /boundary/);
    f.put('node_modules/@aily-project/board-test/board.json', '{}');
    for (let i = 0; i < 256; i++) f.put(`src/objects_test${i}-12345678.h`, '');
    assert.throws(() => captureBuildSource(f.config, f.workspace), /count exceeds/);
});

test('explicit board root retargeting invalidates capture even with identical files', t => {
    const f = fixture(t), board = path.join(f.root, 'node_modules/@aily-project/board-test');
    const original = path.join(f.root, 'board-original');
    fs.renameSync(board, original); fs.symlinkSync(original, board, 'junction');
    f.config.sourceCapture = captureBuildSource(f.config, f.workspace);
    const other = path.join(f.root, 'board-other'); fs.cpSync(original, other, { recursive: true });
    fs.unlinkSync(board); fs.symlinkSync(other, board, 'junction');
    assert.throws(() => confirmBuildSource(f.config), /BUILD_SOURCE_STALE/);
});

test('saved workspace facts bind exact ABI bytes and optional ABS/map pair, without fresh-source authority', t => {
    const f = fixture(t);
    assert.deepEqual(f.config.sourceCapture.workspace.savedProjectFiles, f.workspace.savedProjectFiles);
    assert.equal(Object.hasOwn(f.config.sourceCapture, 'currentProjectAcceptance'), false);
    for (const [relative, contents] of [['project.abs', 'setup:\n'], ['project.abs.map.json', '{"map":[]}\n']]) {
        f.put(relative, contents);
        f.workspace.savedProjectFiles.push({ path: relative, sizeBytes: Buffer.byteLength(contents), sha256: hash(contents) });
    }
    f.config.sourceCapture = captureBuildSource(f.config, f.workspace);
    assert.deepEqual(confirmBuildSource(f.config).workspace.savedProjectFiles, f.workspace.savedProjectFiles);
    f.put('project.abs.map.json', '{"map":[1]}\n');
    assert.throws(() => confirmBuildSource(f.config), /Saved workspace files differ/);
});

for (const change of ['abi-change', 'abi-remove', 'abs-add', 'map-add', 'pair-add', 'digest', 'path', 'duplicate', 'quota']) {
    test(`saved workspace boundary rejects ${change}`, t => {
        const f = fixture(t);
        if (change === 'abi-change') f.put('project.abi', '{"blocks":[1]}');
        if (change === 'abi-remove') fs.unlinkSync(path.join(f.root, 'project.abi'));
        if (change === 'abs-add' || change === 'pair-add') f.put('project.abs', 'setup:');
        if (change === 'map-add' || change === 'pair-add') f.put('project.abs.map.json', '{}');
        if (change === 'digest') f.config.sourceCapture.workspace.savedProjectFiles[0].sha256 = 'f'.repeat(64);
        if (change === 'path') f.config.sourceCapture.workspace.savedProjectFiles[0].path = '../project.abi';
        if (change === 'duplicate') f.config.sourceCapture.workspace.savedProjectFiles.push(f.config.sourceCapture.workspace.savedProjectFiles[0]);
        if (change === 'quota') f.config.sourceCapture.workspace.savedProjectFiles[0].sizeBytes = 128 * 1024 * 1024 + 1;
        assert.throws(() => confirmBuildSource(f.config), /BUILD_SOURCE_STALE/);
    });
}

test('only Scene-bound delivery requires saved facts; ordinary non-saved source captures stay ordinary', t => {
    const f = fixture(t), workspace = { ...f.workspace };
    delete workspace.savedProjectFiles;
    f.config.recordProjectDelivery = true;
    assert.equal(Object.hasOwn(captureBuildSource(f.config, workspace).workspace, 'savedProjectFiles'), false);
    f.config.graphSemanticRevision = 'e'.repeat(64);
    assert.throws(() => captureBuildSource(f.config, workspace), /Scene-bound delivery requires/);
    f.config.recordProjectDelivery = false;
    assert.equal(Object.hasOwn(captureBuildSource(f.config, workspace).workspace, 'savedProjectFiles'), false);
});

test('capture rereads saved files across configuration bookends and refuses linked ABI files', t => {
    const f = fixture(t), filename = path.join(__dirname, 'build-source-capture.js'), localRequire = createRequire(filename);
    const boardPackage = path.join(f.root, 'node_modules/@aily-project/board-test/package.json');
    let changed = false;
    const mockedFs = { ...fs, readFileSync(file, ...args) {
        const contents = fs.readFileSync(file, ...args);
        if (file === boardPackage && !changed) { changed = true; f.put('project.abi', '{"blocks":[1]}'); }
        return contents;
    } };
    const moduleRecord = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleRecord,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name), Buffer, process }, { filename });
    assert.throws(() => moduleRecord.exports.captureBuildSource(f.config, f.workspace), /Saved workspace files differ/);
    assert.equal(changed, true);
    fs.unlinkSync(path.join(f.root, 'project.abi'));
    fs.mkdirSync(path.join(f.root, 'linked-document'));
    fs.symlinkSync(path.join(f.root, 'linked-document'), path.join(f.root, 'project.abi'), 'junction');
    assert.throws(() => confirmBuildSource(f.config), /implicit links/);
});
