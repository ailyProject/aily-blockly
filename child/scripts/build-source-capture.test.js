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
    const workspace = coder ? undefined : { documentText: '{"blocks":[]}', revision: 4, runtimeRevision: 9, pageId: 'main' };
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
    f.put('.build/aily-artifact-manifest.json', JSON.stringify({ schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
        target: { fqbn: 'test:core:board' }, build: { source: { sha256: hash(f.config.code), sizeBytes: Buffer.byteLength(f.config.code) },
            inputs: { scope: 'prepared-dependency-trees', digest: 'b'.repeat(64) } } }));
    const receipt = publishBuildDelivery(f.config, snapshot, entry, 'test:core:board');
    assert.deepEqual(receipt.sourceCapture, f.config.sourceCapture); assert.equal(receipt.currentProjectAcceptance, false);
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
