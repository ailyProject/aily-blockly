const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { prepareCompileSource } = require('./compile-source');
const { readBuilderCapabilities } = require('./builder-capabilities');
const { captureProjectSources, confirmProjectSources, invalidateBuildDelivery, invalidateBuildDeliveryTicket, publishBuildDelivery, reportBuildDelivery } = require('./compile-delivery');
const { captureBuildSource } = require('./build-source-capture');
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
    const emit = () => {
        const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts', configurationSha256: 'c'.repeat(64),
            steps: ['sketch', 'libraries', 'core', 'linking'].map(name => ({ kind: 'ninja-plan', name, sha256: 'd'.repeat(64) })) };
        const record = { ...body, digest: hash(JSON.stringify(body)) }, bytes = JSON.stringify(record);
        put('.build/aily-build-inputs.json', bytes);
        put(artifact, JSON.stringify({ schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
            target: { fqbn: 'test:core:board' }, build: { source: { sizeBytes: Buffer.byteLength(config.code), sha256: hash(config.code) },
                inputs: { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest } },
            files: [{ path: 'aily-build-inputs.json', role: 'build-inputs', sizeBytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] }));
    };
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
    assert.deepEqual(receipt.executionSource, { scope: 'project-compiler-entry',
        path: coder ? 'sketch/src/main.cpp' : '.temp/sketch/sketch.ino',
        sizeBytes: Buffer.byteLength(f.config.code), sha256: hash(f.config.code) });
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

for (const coder of [false, true]) for (const directory of ['.log', '.workspace-history']) {
    test(`${coder ? 'Coder' : 'Blockly'} source capture excludes only product-owned ${directory} contents, additions and GC removals`, t => {
        const f = fixture(t, coder);
        f.put(`${directory}/objects/aa/existing.blob`, 'generated before build');
        const before = captureProjectSources(f.config);
        assert.equal(before.body.files.some(file => file.path.startsWith(directory + '/')), false);
        f.put(`${directory}/objects/aa/existing.blob`, 'generated during build');
        f.put(`${directory}/new-session/added.log`, 'new generated record');
        assert.doesNotThrow(() => confirmProjectSources(before, f.config, 'before-target-compile'));
        fs.unlinkSync(path.join(f.root, `${directory}/objects/aa/existing.blob`));
        fs.unlinkSync(path.join(f.root, `${directory}/new-session/added.log`));
        assert.doesNotThrow(() => confirmProjectSources(before, f.config, 'before-delivery'));
        f.put(`${directory}-custom/user-header.h`, 'user source outside the exact owned root');
        assert.throws(() => confirmProjectSources(before, f.config), /PROJECT_INPUTS_CHANGED/);
    });
}

for (const coder of [false, true]) test(`${coder ? 'Coder' : 'Blockly'} capture keeps arbitrary root headers guarded for contents, additions and deletion`, t => {
    const f = fixture(t, coder);
    f.put('foo.h', 'root user source');
    let before = captureProjectSources(f.config);
    f.put('foo.h', 'root edited source');
    assert.throws(() => confirmProjectSources(before, f.config), /PROJECT_INPUTS_CHANGED/);
    before = captureProjectSources(f.config);
    f.put('another-root-header.h', 'added root source');
    assert.throws(() => confirmProjectSources(before, f.config), /PROJECT_INPUTS_CHANGED/);
    before = captureProjectSources(f.config);
    fs.unlinkSync(path.join(f.root, 'foo.h'));
    assert.throws(() => confirmProjectSources(before, f.config), /PROJECT_INPUTS_CHANGED/);
});

for (const location of ['src/partitions.csv', 'partitions.csv', 'node_modules/@aily-project/partition-test/partitions.csv']) {
    test(`capture retains partition input guard at ${location}`, t => {
        const f = fixture(t);
        f.put(location, 'partition before');
        if (location.startsWith('node_modules/')) f.config.partitionFilePath = path.join(f.root, location);
        const before = captureProjectSources(f.config);
        f.put(location, 'partition changed');
        assert.throws(() => confirmProjectSources(before, f.config), /PROJECT_INPUTS_CHANGED/);
    });
}

function inputChange(before, config, phase) {
    try { confirmProjectSources(before, config, phase); }
    catch (error) {
        assert.equal(error.code, 'PROJECT_INPUTS_CHANGED');
        assert.equal(error.message, 'PROJECT_INPUTS_CHANGED: Project sources/configuration changed; discard this build and retry.');
        assert.equal(JSON.stringify(error).includes(config.currentProjectPath), false);
        return error;
    }
    assert.fail('Input changes must remain rejected.');
}

test('project input diagnostics distinguish contents, addition and removal without source text or absolute paths', t => {
    const f = fixture(t);
    f.put('src/removed.h', 'previous private source');
    const before = captureProjectSources(f.config);
    f.put('src/helper.h', 'changed private source');
    f.put('src/added.h', 'new private source');
    fs.unlinkSync(path.join(f.root, 'src/removed.h'));
    const error = inputChange(before, f.config, 'before-target-compile');
    assert.deepEqual(error.projectInputDifferences, {
        schemaVersion: 1, kind: 'aily-project-input-differences', phase: 'before-target-compile', bodyChanged: false,
        differences: [{ path: 'src/added.h', change: 'added' }, { path: 'src/helper.h', change: 'content' },
            { path: 'src/removed.h', change: 'removed' }], totalCount: 3, truncatedCount: 0,
    });
    assert.equal(JSON.stringify(error.projectInputDifferences).includes('private source'), false);
    assert.equal(JSON.stringify(error.projectInputDifferences).includes(f.root), false);
});

test('project input diagnostics retain rejection for pure stat changes and default to unspecified phase', t => {
    const f = fixture(t), before = captureProjectSources(f.config), file = path.join(f.root, 'src/helper.h');
    const info = fs.statSync(file);
    fs.utimesSync(file, info.atime, new Date(info.mtimeMs + 2000));
    const error = inputChange(before, f.config);
    assert.deepEqual(error.projectInputDifferences.differences, [{ path: 'src/helper.h', change: 'stat' }]);
    assert.equal(error.projectInputDifferences.phase, 'unspecified');
});

test('semantic package metadata remains unchanged for project input confirmation', t => {
    const f = fixture(t), before = captureProjectSources(f.config);
    f.put('package.json', JSON.stringify({ buildInfo: { lastBuildStatus: 'failed' }, codeHash: 'result', type: 'blockly' }));
    assert.doesNotThrow(() => confirmProjectSources(before, f.config, 'after-delivery'));
});

test('project input diagnostics truncate after 12 actual differences without relaxing the guard', t => {
    const f = fixture(t), before = captureProjectSources(f.config);
    for (let index = 0; index < 15; index++) f.put(`src/add-${String(index).padStart(2, '0')}.h`, 'new');
    const error = inputChange(before, f.config, 'after-delivery');
    assert.equal(error.projectInputDifferences.differences.length, 12);
    assert.equal(error.projectInputDifferences.totalCount, 15);
    assert.equal(error.projectInputDifferences.truncatedCount, 3);
    assert.equal(error.projectInputDifferences.phase, 'after-delivery');
});

function compileDiagnosticEntry(overrides = {}) {
    const filename = path.join(__dirname, 'compile.js'), module = { exports: {} };
    const source = fs.readFileSync(filename, 'utf8').replace(/\nmain\(\)\.catch\(e => \{[\s\S]*?\n\}\);\s*$/, '');
    assert.equal(source.includes('main().catch'), false);
    const localRequire = createRequire(filename);
    vm.runInNewContext(`${source}\nmodule.exports = { writeProjectInputDifference, main };`, {
        require: name => overrides.modules?.[name] || localRequire(name), module, __dirname, Buffer,
        process: overrides.process || { pid: process.pid, on() {}, env: {}, argv: [] },
        console: overrides.console || { log() { assert.fail('Diagnostics must not reach stdout.'); },
            warn() { assert.fail('Diagnostics must not reach stderr.'); }, error() { assert.fail('No primary error in writer test.'); } },
    }, { filename });
    return module.exports;
}
const compileDiagnosticWriter = overrides => compileDiagnosticEntry(overrides).writeProjectInputDifference;

test('code-only configuration differences remain rejected and report bodyChanged without disclosing values', t => {
    const f = fixture(t), before = captureProjectSources(f.config);
    f.config.code += '\n// private code';
    const error = inputChange(before, f.config);
    assert.equal(error.projectInputDifferences.bodyChanged, true);
    assert.deepEqual(error.projectInputDifferences.differences, []);
    assert.equal(JSON.stringify(error.projectInputDifferences).includes('private code'), false);
});

test('diagnostic writer refuses parent identity changes after write even when build leaf identity is unchanged', t => {
    const f = fixture(t); f.emit();
    const before = captureProjectSources(f.config); f.put('src/helper.h', 'changed');
    const error = inputChange(before, f.config);
    let swapped = false, unlinked = false;
    const mockedFs = { ...fs, writeFileSync(filename, ...args) { fs.writeFileSync(filename, ...args); swapped = true; },
        realpathSync(filename, ...args) { return swapped && filename === f.root ? `${f.root}-moved` : fs.realpathSync(filename, ...args); },
        unlinkSync() { unlinked = true; } };
    compileDiagnosticWriter({ modules: { fs: mockedFs } })(error);
    assert.equal(f.exists('.build/aily-project-input-difference.json'), false);
    assert.equal(unlinked, false, 'Cleanup must not follow the replaced parent.');
});

for (const phase of ['before-target-compile', 'before-delivery']) test(`normal compile main catch silently records ${phase} rejection and releases its workspace`, async t => {
    const f = fixture(t); f.emit();
    f.put('node_modules/@aily-project/board-test/board.json', JSON.stringify({ compilerParam: '--board test:core:board' }));
    f.put('.temp/build-config.json', JSON.stringify(f.config));
    const messages = [], fakeProcess = { pid: process.pid, on() {}, env: { ...process.env },
        argv: [process.execPath, 'compile.js', path.join(f.root, '.temp/build-config.json')],
        stdout: { write() {} }, stderr: { write() {} }, exit(code) { assert.fail(`Unexpected exit ${code}`); } };
    const modules = {
        './compile-preprocess': { async runCompilePreprocess() {
            await prepareCompileSource(f.config);
            if (phase === 'before-target-compile') f.put('src/helper.h', 'changed');
        } },
        './builder-capabilities': { readBuilderCapabilities: () => ({ artifact: true, inputs: true, workspace: true }) },
        './library-source-evidence': { readLibraryProjections: () => undefined },
        './blockly-upload-state': { captureBlocklyUploadInputs: () => ({}), publishBlocklyUploadState() {}, invalidateBlocklyUploadState() {} },
        './builder-archive-recovery': { async compileWithArchiveRecovery(command, args) {
            assert.equal(command, 'aily-builder');
            f.emit(); f.put('src/helper.h', 'changed');
            return { exitCode: 0, signal: null, spawnError: null, args: [...args], output: [], archiveRecovery: null };
        } },
    };
    const entry = compileDiagnosticEntry({ modules, process: fakeProcess,
        console: { log() {}, warn() {}, error: (...args) => messages.push(args.join(' ')) } });
    await entry.main();
    assert.equal(fakeProcess.exitCode, 1);
    assert.deepEqual(messages, ['[ERROR] PROJECT_INPUTS_CHANGED: Project sources/configuration changed; discard this build and retry.']);
    const written = JSON.parse(fs.readFileSync(path.join(f.root, '.build/aily-project-input-difference.json')));
    assert.equal(written.phase, phase);
    assert.deepEqual(written.differences, [{ path: 'src/helper.h', change: 'content' }]);
    assert.equal(f.exists('.build/aily-workspace.lock'), false);
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
});

test('normal compile diagnostic writer persists bounded failure facts silently in existing build output', t => {
    const f = fixture(t); f.emit();
    const before = captureProjectSources(f.config);
    f.put('src/helper.h', 'changed');
    const error = inputChange(before, f.config, 'before-delivery');
    compileDiagnosticWriter()(error);
    const written = JSON.parse(fs.readFileSync(path.join(f.root, '.build/aily-project-input-difference.json')));
    assert.deepEqual(written, error.projectInputDifferences);
    assert.equal(JSON.stringify(written).includes(f.root), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(file => file.endsWith('.tmp')), false);
});

test('normal compile diagnostic write failure cannot replace the original rejection or traverse a linked build directory', t => {
    const f = fixture(t); f.emit();
    const before = captureProjectSources(f.config);
    f.put('src/helper.h', 'changed');
    const error = inputChange(before, f.config);
    fs.renameSync(path.join(f.root, '.build'), path.join(f.root, 'outside'));
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, '.build'), 'junction');
    assert.doesNotThrow(() => compileDiagnosticWriter()(error));
    assert.equal(f.exists('outside/aily-project-input-difference.json'), false);
    assert.equal(error.code, 'PROJECT_INPUTS_CHANGED');
    assert.equal(error.message, 'PROJECT_INPUTS_CHANGED: Project sources/configuration changed; discard this build and retry.');
});

test('no receipt survives mismatched source or unsupported build-graph metadata', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit(); fs.writeFileSync(entry, 'stale prepared code');
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /does not match/);
    assert.equal(f.exists(f.artifact), false);
    await prepareCompileSource(f.config); f.emit();
    const file = path.join(f.root, f.artifact), manifest = JSON.parse(fs.readFileSync(file));
    delete manifest.build.inputs; fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /does not match/);
});

test('full invalidation removes the Artifact and tickets but preserves firmware; build junction is refused', t => {
    const f = fixture(t); f.emit(); f.put(f.delivery, 'old'); f.put('.build/firmware.elf', 'keep');
    invalidateBuildDelivery(f.root);
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    assert.equal(f.exists('.build/firmware.elf'), true);
    fs.renameSync(path.join(f.root, '.build'), path.join(f.root, 'outside'));
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, '.build'), 'junction');
    assert.throws(() => invalidateBuildDelivery(f.root), /link/);
    assert.equal(f.exists('outside/firmware.elf'), true);
});

test('ticket-only invalidation preserves exact Artifact bytes and makes an old delivery unreportable', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    const receipt = publishBuildDelivery(f.config, before, entry, 'test:core:board');
    f.put('.build/aily-library-projections.json', 'old');
    const bytes = fs.readFileSync(path.join(f.root, f.artifact));
    const inputBytes = fs.readFileSync(path.join(f.root, '.build/aily-build-inputs.json'));
    invalidateBuildDeliveryTicket(f.root);
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.artifact)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.build/aily-build-inputs.json')), inputBytes);
    for (const name of [f.delivery, '.build/aily-library-projections.json']) {
        assert.equal(f.exists(name), false);
    }
    await assert.rejects(reportBuildDelivery(f.config, receipt), { code: 'ENOENT' });
    fs.renameSync(path.join(f.root, '.build'), path.join(f.root, 'outside'));
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, '.build'), 'junction');
    assert.throws(() => invalidateBuildDeliveryTicket(f.root), /link/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'outside/aily-artifact-manifest.json')), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'outside/aily-build-inputs.json')), inputBytes);
});

for (const changedMetadata of [false, true]) test(`actual background preprocess ${changedMetadata ? 'rejects changed metadata' : 'completes'} while preserving Artifact and revoking old tickets`, async t => {
    const f = fixture(t);
    f.put('node_modules/@aily-project/board-test/board.json', JSON.stringify({ compilerParam: '--board test:core:board' }));
    f.put('node_modules/@aily-project/board-test/package.json', JSON.stringify({ boardDependencies: {
        '@aily-project/compiler-test': '1', '@aily-project/sdk-test': '1' } }));
    f.emit(); f.put(f.delivery, 'old'); f.put('.build/aily-library-projections.json', 'old');
    f.put('.build/firmware.elf', 'compiled');
    const bytes = fs.readFileSync(path.join(f.root, f.artifact));
    const inputBytes = fs.readFileSync(path.join(f.root, '.build/aily-build-inputs.json'));
    const config = { ...f.config, recordProjectDelivery: false, appDataPath: path.join(f.root, 'app-data') };
    config.sourceCapture = captureBuildSource(config);
    const request = path.join(f.root, 'request.json'); f.put('request.json', JSON.stringify(config));
    const filename = path.join(__dirname, 'preprocess.js'), localRequire = createRequire(filename);
    let spawnCalls = 0;
    const mockedRequire = name => name === 'child_process' ? { ...localRequire(name), spawn(command, args, options) {
        spawnCalls++;
        assert.equal(command, 'aily-builder'); assert.equal(args[0], 'preprocess');
        assert.equal(JSON.parse(options.env.AILY_BUILDER_WORKSPACE).operation, 'preprocess');
        const child = new EventEmitter();
        queueMicrotask(() => {
            f.put('.temp/preprocess.json', JSON.stringify({ success: true }));
            if (changedMetadata) f.put('package.json', JSON.stringify({ type: 'blockly', macros: ['changed'] }));
            child.emit('close', 0, null);
        });
        return child;
    } } : localRequire(name);
    const module = { exports: {} };
    vm.runInNewContext(`${fs.readFileSync(filename, 'utf8')}\nmodule.exports.testMain = main;`, {
        require: mockedRequire, module, __dirname, Buffer,
        process: { argv: [process.execPath, filename, request], env: { ...process.env },
            on() {}, exit(code) { throw new Error(`Unexpected exit ${code}`); } },
        console: { log() {}, warn() {}, error() {} },
    }, { filename });
    if (changedMetadata) await assert.rejects(module.exports.testMain(), { code: 'BUILD_SOURCE_STALE' });
    else await module.exports.testMain();
    assert.equal(spawnCalls, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.root, f.artifact)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.build/aily-build-inputs.json')), inputBytes);
    assert.equal(fs.readFileSync(path.join(f.root, '.build/firmware.elf'), 'utf8'), 'compiled');
    for (const name of [f.delivery, '.build/aily-library-projections.json', '.build/aily-workspace.lock']) {
        assert.equal(f.exists(name), false);
    }
});

test('capabilities queried once; malformed/old versions cannot enable strict delivery', () => {
    let calls = 0;
    const current = readBuilderCapabilities('builder', () => { calls++; return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, capabilities: {
        simulationArtifactManifest: { schemaVersion: 1 }, buildInputRecord: { schemaVersion: 1, cliOption: '--record-build-inputs',
            scope: 'build-graph-facts', currentProjectFreshness: false, defaultFileName: 'aily-build-inputs.json' },
        buildWorkspaceLease: { schemaVersion: 1, delegationEnvironment: 'AILY_BUILDER_WORKSPACE' },
        simulationSourceDebug: { schemaVersion: 1, cliOption: '--simulation-debug' },
        sceneGraphProvenance: { schemaVersion: 1, cliOption: '--graph-semantic-revision' } } }) }; });
    assert.deepEqual(current, { artifact: true, debug: true, graph: true, inputs: true, workspace: true }); assert.equal(calls, 1);
    calls = 0;
    const legacy = readBuilderCapabilities('builder', () => ({ status: 0, stdout: ++calls === 1 ? 'malformed' : '--emit-artifact-manifest' }));
    assert.deepEqual(legacy, { artifact: true, debug: false, graph: false, inputs: false, workspace: false }); assert.equal(calls, 2);
    for (const patch of [{ schemaVersion: 2 }, { cliOption: '--other' }, { scope: undefined }, { scope: 'version-labels' },
        { currentProjectFreshness: undefined }, { currentProjectFreshness: true }, { defaultFileName: 'other.json' }]) {
        const unsupported = readBuilderCapabilities('builder', () => ({ status: 0, stdout: JSON.stringify({ schemaVersion: 1,
            capabilities: { buildInputRecord: { schemaVersion: 1, cliOption: '--record-build-inputs', scope: 'build-graph-facts',
                currentProjectFreshness: false, defaultFileName: 'aily-build-inputs.json', ...patch } } }) }));
        assert.equal(unsupported.inputs, false, 'Different build-graph contracts must not be accepted silently.');
        assert.equal(Object.hasOwn(unsupported, 'verification'), false);
        assert.equal(Object.hasOwn(unsupported, 'packages'), false);
    }
});

test('actual compile entry invalidates old delivery before preprocessing can fail', t => {
    const f = fixture(t); f.emit(); f.put(f.delivery, 'old'); f.put('.build/firmware.elf', 'keep');
    f.put('.build/aily-library-projections.json', 'old');
    f.put('.temp/build-config.json', JSON.stringify({ ...f.config, appDataPath: path.join(f.root, 'missing-sdk') }));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'compile.js'), path.join(f.root, '.temp/build-config.json')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    assert.equal(f.exists('.build/aily-library-projections.json'), false);
    assert.equal(f.exists('.build/firmware.elf'), true);
    assert.match(result.stderr, /预编译|Preprocess|SDK/);
});

test('wrong target cannot receive delivery even when source and build-graph hashes match', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'other:core:board'), /does not match/);
    assert.equal(f.exists(f.artifact), false);
});

test('execution source records the actual compiler entry, not a derived basename or historical source snapshot', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    const actual = path.join(f.root, '.temp/compiler-driver/actual-input.cpp');
    fs.mkdirSync(path.dirname(actual)); fs.renameSync(entry, actual); f.emit();
    const receipt = publishBuildDelivery(f.config, before, actual, 'test:core:board');
    assert.deepEqual(receipt.executionSource, { scope: 'project-compiler-entry', path: '.temp/compiler-driver/actual-input.cpp',
        sizeBytes: Buffer.byteLength(f.config.code), sha256: hash(f.config.code) });
    assert.equal(receipt.currentProjectAcceptance, false);
    assert.equal(Object.hasOwn(receipt, 'sourceCurrent'), false);
    assert.equal(Object.hasOwn(receipt, 'workspaceSourceSha256'), false);
});

for (const invalid of ['relative', 'outside', 'linked-directory', 'oversized']) {
    test(`execution source refuses ${invalid} without publishing a receipt`, async t => {
        const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
        f.emit();
        let source = entry;
        if (invalid === 'relative') source = '.temp/sketch/sketch.ino';
        if (invalid === 'outside') source = path.resolve(f.root, '..', 'non-project-compiler-entry.cpp');
        if (invalid === 'linked-directory') {
            const alias = path.join(f.root, '.temp/linked-entry');
            fs.symlinkSync(path.dirname(entry), alias, 'junction'); source = path.join(alias, path.basename(entry));
        }
        if (invalid === 'oversized') fs.truncateSync(entry, 128 * 1024 * 1024 + 1);
        assert.throws(() => publishBuildDelivery(f.config, before, source, 'test:core:board'), /Compiler entry/);
        assert.equal(f.exists(f.delivery), false);
    });
}

test('execution source is reread before delivery publication even when the source tree excludes compiler scratch files', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    const filename = path.join(__dirname, 'compile-delivery.js'), localRequire = createRequire(filename);
    let changed = false;
    const mockedFs = { ...fs, writeFileSync(file, ...args) {
        fs.writeFileSync(file, ...args);
        if (typeof file === 'string' && file.startsWith(path.join(f.root, f.delivery)) && file.endsWith('.tmp')) {
            changed = true; fs.writeFileSync(entry, `${f.config.code}\n// source changed after receipt capture`);
        }
    } };
    const moduleRecord = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleRecord, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => moduleRecord.exports.publishBuildDelivery(f.config, before, entry, 'test:core:board'), /Compiler entry changed before delivery/);
    assert.equal(changed, true);
    assert.equal(f.exists(f.delivery), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(file => file.endsWith('.tmp')), false);
});

test('source mutation after temporary delivery write retains after-delivery diagnostics and revokes publication', async t => {
    const f = fixture(t), before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    const filename = path.join(__dirname, 'compile-delivery.js'), localRequire = createRequire(filename);
    const mockedFs = { ...fs, writeFileSync(file, ...args) {
        fs.writeFileSync(file, ...args);
        if (typeof file === 'string' && file.startsWith(path.join(f.root, f.delivery)) && file.endsWith('.tmp')) {
            f.put('src/helper.h', 'changed after delivery capture');
        }
    } };
    const moduleRecord = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleRecord, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    let error;
    try { moduleRecord.exports.publishBuildDelivery(f.config, before, entry, 'test:core:board'); }
    catch (caught) { error = caught; }
    assert.equal(error.code, 'PROJECT_INPUTS_CHANGED');
    assert.equal(error.projectInputDifferences.phase, 'after-delivery');
    compileDiagnosticWriter()(error);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.build/aily-project-input-difference.json'))).phase, 'after-delivery');
    assert.equal(f.exists(f.artifact), false); assert.equal(f.exists(f.delivery), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(file => file.endsWith('.tmp')), false);
});

test('compiler source byte size is UTF-8 exact and must match the Artifact source record', async t => {
    const f = fixture(t);
    f.config.code = 'void setup() { /* 温度 */ }\r\n';
    const before = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    f.emit();
    const receipt = publishBuildDelivery(f.config, before, entry, 'test:core:board');
    assert.equal(receipt.executionSource.sizeBytes, Buffer.byteLength(f.config.code));
    assert.equal(receipt.executionSource.sha256, hash(Buffer.from(f.config.code, 'utf8')));
    const manifestPath = path.join(f.root, f.artifact), artifact = JSON.parse(fs.readFileSync(manifestPath));
    artifact.build.source.sizeBytes--;
    fs.writeFileSync(manifestPath, JSON.stringify(artifact));
    assert.throws(() => publishBuildDelivery(f.config, before, entry, 'test:core:board'), /Artifact does not match/);
    assert.equal(f.exists(f.delivery), false);
});
