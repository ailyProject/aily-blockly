const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepareCompileSource } = require('./compile-source');
const { readBuilderCapabilities } = require('./builder-capabilities');
const { captureProjectSources, confirmProjectSources, invalidateBuildDelivery, publishBuildDelivery } = require('./compile-delivery');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, coder = false) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-delivery-test-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-delivery-test-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (name, text) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text); };
    put('package.json', JSON.stringify({ type: coder ? 'coder' : 'blockly' }));
    put('node_modules/@aily-project/board-test/board.json', '{}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    put(coder ? 'sketch/src/main.cpp' : 'src/helper.h', coder ? 'void setup() {}' : '#pragma once');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}', recordProjectDelivery: true };
    const artifact = '.build/aily-artifact-manifest.json', delivery = '.build/aily-build-delivery.json';
    const emit = () => put(artifact, JSON.stringify({ schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
        target: { fqbn: 'test:core:board' }, build: { source: { sizeBytes: Buffer.byteLength(config.code), sha256: hash(config.code) },
            inputs: { scope: 'prepared-dependency-trees', digest: 'b'.repeat(64) } } }));
    return { root, config, put, emit, artifact, delivery, exists: name => fs.existsSync(path.join(root, name)) };
}

test('Blockly source preparation removes deleted files and entry collisions on subsequent builds', async t => {
    const f = fixture(t);
    f.put('src/old.h', 'old'); f.put('src/sketch.ino', 'not generated');
    const entry = await prepareCompileSource(f.config);
    assert.equal(fs.readFileSync(entry, 'utf8'), f.config.code);
    fs.unlinkSync(path.join(f.root, 'src/old.h'));
    f.put('src/new.h', 'new');
    await prepareCompileSource(f.config);
    assert.equal(f.exists('.temp/sketch/old.h'), false);
    assert.equal(f.exists('.temp/sketch/new.h'), true);
    assert.equal(f.exists('src/helper.h'), true);
    fs.rmSync(path.join(f.root, 'src'), { recursive: true });
    await prepareCompileSource(f.config);
    assert.deepEqual(fs.readdirSync(path.dirname(entry)), ['sketch.ino']);
});

test('Coder source preparation leaves user files and unchanged entry metadata intact', async t => {
    const f = fixture(t, true);
    f.put('sketch/libraries/Local/src/lib.h', 'local');
    const entry = path.join(f.root, 'sketch/src/main.cpp'), before = fs.statSync(entry);
    await prepareCompileSource(f.config);
    assert.equal(fs.statSync(entry).mtimeMs, before.mtimeMs);
    assert.equal(f.exists('sketch/libraries/Local/src/lib.h'), true);
    f.put('sketch/src/main.cpp', 'user edit');
    await assert.rejects(prepareCompileSource(f.config), /PROJECT_INPUTS_CHANGED/);
    assert.equal(fs.readFileSync(entry, 'utf8'), 'user edit');
});

for (const target of ['.temp', '.temp/sketch', 'src', 'sketch/src']) test(`source preparation rejects unsafe link at ${target}`, async t => {
    const f = fixture(t, target.startsWith('sketch'));
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    const destination = path.join(f.root, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.symlinkSync(outside, destination, 'junction');
    await assert.rejects(prepareCompileSource(f.config), /link|junction/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

for (const coder of [false, true]) test(`source capture and delivery bind ${coder ? 'Coder' : 'Blockly'} without claiming freshness`, async t => {
    const f = fixture(t, coder), before = captureProjectSources(f.config);
    const entry = await prepareCompileSource(f.config);
    f.put(coder ? 'sketch/preprocess.json' : '.temp/preprocess.json', '{}');
    f.put('.build/some.o', 'compiled'); f.emit();
    const receipt = publishBuildDelivery(f.config, before, entry, 'test:core:board');
    assert.equal(receipt.currentProjectAcceptance, false);
    assert.equal(receipt.project.scope, 'project-source-boundary');
    assert.equal(receipt.project.mode, coder ? 'coder' : 'blockly');
    assert.equal(receipt.manifestSha256, hash(fs.readFileSync(path.join(f.root, f.artifact))));
    assert.equal(receipt.project.digest, before.digest);
    assert.equal(JSON.stringify(receipt).includes(f.root), false);
    assert.equal(f.exists(f.delivery), true);
});

for (const changed of ['package.json', 'src/new.h', 'components/Local/lib.h', 'project.abi', 'node_modules/@aily-project/board-test/board.json']) {
    test(`source capture invalidates a build after changing ${changed}`, async t => {
        const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
        f.emit(); f.put(f.delivery, 'old'); f.put(changed, '{}');
        assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /PROJECT_INPUTS_CHANGED/);
        assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    });
}

test('capture detects Coder local library edits, deletion, restored mtime and changed input code', t => {
    const f = fixture(t, true);
    f.put('sketch/libraries/Local/a.h', 'aaa');
    let before = captureProjectSources(f.config);
    f.put('sketch/libraries/Local/a.h', 'bbb');
    assert.throws(() => confirmProjectSources(before, f.config), /changed/);
    before = captureProjectSources(f.config);
    fs.unlinkSync(path.join(f.root, 'sketch/libraries/Local/a.h'));
    assert.throws(() => confirmProjectSources(before, f.config), /changed/);
    const file = path.join(f.root, 'sketch/src/main.cpp'), stat = fs.statSync(file);
    before = captureProjectSources(f.config);
    f.put('sketch/src/main.cpp', f.config.code); fs.utimesSync(file, stat.atime, stat.mtime);
    assert.throws(() => confirmProjectSources(before, f.config), /changed/);
    before = captureProjectSources(f.config); f.config.code += '\n';
    assert.throws(() => confirmProjectSources(before, f.config), /changed/);
});

test('no receipt survives mismatched source or unsupported prepared input metadata', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit(); fs.writeFileSync(entry, 'stale prepared code');
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /does not match/);
    assert.equal(f.exists(f.artifact), false);
    await prepareCompileSource(f.config); f.emit();
    const file = path.join(f.root, f.artifact), manifest = JSON.parse(fs.readFileSync(file));
    delete manifest.build.inputs; fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /does not match/);
});

test('early invalidation removes only tickets; build junction is refused', t => {
    const f = fixture(t); f.emit(); f.put(f.delivery, 'old'); f.put('.build/firmware.elf', 'keep');
    invalidateBuildDelivery(f.root);
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    assert.equal(f.exists('.build/firmware.elf'), true);
    fs.renameSync(path.join(f.root, '.build'), path.join(f.root, 'outside'));
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, '.build'), 'junction');
    assert.throws(() => invalidateBuildDelivery(f.root), /link/);
    assert.equal(f.exists('outside/firmware.elf'), true);
});

test('capabilities queried once; malformed/old versions cannot enable strict delivery', () => {
    let calls = 0;
    const current = readBuilderCapabilities('builder', () => { calls++; return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, capabilities: {
        simulationArtifactManifest: { schemaVersion: 1 }, buildInputRecord: { schemaVersion: 1, cliOption: '--record-build-inputs' },
        buildWorkspaceLease: { schemaVersion: 1, delegationEnvironment: 'AILY_BUILDER_WORKSPACE' },
        buildPackageInputs: { schemaVersion: 1, scope: 'resolved-sdk-tool-trees', verification: 'content-and-state-at-build-boundaries' },
        buildInputVerification: { schemaVersion: 1, command: 'verify-build-inputs', contextFileName: 'aily-build-input-context.json', scope: 'prepared-dependency-trees-and-sdk-tools' },
        sceneGraphProvenance: { schemaVersion: 1, cliOption: '--graph-semantic-revision' } } }) }; });
    assert.deepEqual(current, { artifact: true, graph: true, inputs: true, workspace: true, packages: true, verification: true }); assert.equal(calls, 1);
    calls = 0;
    const legacy = readBuilderCapabilities('builder', () => ({ status: 0, stdout: ++calls === 1 ? 'malformed' : '--emit-artifact-manifest' }));
    assert.deepEqual(legacy, { artifact: true, graph: false, inputs: false, workspace: false, packages: false, verification: false }); assert.equal(calls, 2);
    for (const packageCapability of [undefined,
        { schemaVersion: 2, scope: 'resolved-sdk-tool-trees', verification: 'content-and-state-at-build-boundaries' },
        { schemaVersion: 1, scope: 'version-labels', verification: 'content-and-state-at-build-boundaries' },
        { schemaVersion: 1, scope: 'resolved-sdk-tool-trees', verification: 'mtime-only' },
    ]) {
        const unsupported = readBuilderCapabilities('builder', () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1,
            capabilities: { buildPackageInputs: packageCapability } }) }));
        assert.equal(unsupported.packages, false, 'Missing or different evidence contracts must not enable package coverage.');
    }
});

test('actual compile entry invalidates old delivery before preprocessing can fail', t => {
    const f = fixture(t); f.emit(); f.put(f.delivery, 'old'); f.put('.build/firmware.elf', 'keep');
    f.put('.temp/build-config.json', JSON.stringify({ ...f.config, appDataPath: path.join(f.root, 'missing-sdk') }));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'compile.js'), path.join(f.root, '.temp/build-config.json')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    assert.equal(f.exists('.build/firmware.elf'), true);
    assert.match(result.stderr, /预编译|Preprocess|SDK/);
});

test('wrong target cannot receive delivery even when source and prepared-input hashes match', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'other:core:board'), /does not match/);
    assert.equal(f.exists(f.artifact), false);
});
