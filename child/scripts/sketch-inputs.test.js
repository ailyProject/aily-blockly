'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { captureSketchInputs } = require('./sketch-inputs');
const { captureBuildSource, confirmBuildSource, confirmPreparedBuildSource } = require('./build-source-capture');
const { prepareCompileSource } = require('./compile-source');
const { captureProjectSources, publishBuildDelivery } = require('./compile-delivery');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-user-sketch-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-user-sketch-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (relative, contents) => {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents);
    };
    put('package.json', '{"type":"blockly"}');
    put('node_modules/@aily-project/board-test/board.json', '{}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    put('src/helper.cpp', '#include "helper.h"\nint value() { return VALUE; }\n');
    put('src/helper.h', '#define VALUE 42\n');
    put('src/src/nested/extra.c', 'int extra(void) { return 7; }\n');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}\n' };
    config.sourceCapture = captureBuildSource(config);
    return { root, put, config };
}

function emitArtifact(f, sketchInputs = f.config.sourceCapture.sketchInputs) {
    const graph = sketchInputs === null ? '# old graph without source digest\n'
        : `aily_sketch_inputs_digest = ${sketchInputs.digest}\n`;
    f.put('.build/build.ninja', graph);
    const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts',
        configurationSha256: 'c'.repeat(64),
        steps: ['sketch', 'libraries', 'core', 'linking'].map(name => ({ kind: 'ninja-plan', name,
            sha256: name === 'linking' ? hash(graph) : 'd'.repeat(64) })) };
    const record = { ...body, digest: hash(JSON.stringify(body)) }, bytes = JSON.stringify(record);
    f.put('.build/aily-build-inputs.json', bytes);
    f.put('.build/aily-artifact-manifest.json', JSON.stringify({ schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
        target: { fqbn: 'test:core:board' }, build: { source: { sha256: hash(f.config.code), sizeBytes: Buffer.byteLength(f.config.code) },
            inputs: { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest } },
        files: [{ path: 'aily-build-inputs.json', role: 'build-inputs', sizeBytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] }));
    return record;
}

test('manifest is deterministic and content-bound within the explicit Arduino sketch boundary', t => {
    const f = fixture(t);
    f.put('src/sketch.ino', 'replaced generated entry');
    f.put('src/ignored.txt', 'not a C/C++ source input');
    f.put('src/examples/ignored.cpp', '#error unrelated subdirectory');
    f.put('src/include/public.h', '#define PUBLIC_VALUE 1\n');
    f.put('src/include/ignored.cpp', '#error this is not a sketch translation unit');
    f.put('private/ignored.h', 'outside project/src');
    const value = captureBuildSource(f.config).sketchInputs;
    assert.deepEqual(value.files.map(file => file.path), ['helper.cpp', 'helper.h', 'include/public.h', 'src/nested/extra.c']);
    const { digest, ...body } = value;
    assert.equal(digest, hash(JSON.stringify(body)));
    assert.equal(value.scope, 'arduino-sketch-inputs');
    assert.equal(value.schemaVersion, 1);
    assert.equal(JSON.stringify(value).includes(f.root), false);
    assert.notEqual(value.digest, f.config.sourceCapture.sketchInputs.digest);
    for (const file of value.files) {
        const bytes = fs.readFileSync(path.join(f.root, 'src', file.path));
        assert.equal(file.sha256, hash(bytes)); assert.equal(file.sizeBytes, bytes.length);
    }
});

for (const change of ['edit-tu', 'edit-header', 'add-tu', 'remove-tu', 'add-nested', 'remove-nested']) {
    test(`frozen source capture rejects ${change} before preparation`, async t => {
        const f = fixture(t);
        if (change === 'edit-tu') f.put('src/helper.cpp', 'new source');
        if (change === 'edit-header') f.put('src/helper.h', '#define VALUE 77');
        if (change === 'add-tu') f.put('src/new.cpp', '#error newly added unit');
        if (change === 'remove-tu') fs.unlinkSync(path.join(f.root, 'src/helper.cpp'));
        if (change === 'add-nested') f.put('src/src/nested/second.cpp', 'int second;');
        if (change === 'remove-nested') fs.rmSync(path.join(f.root, 'src/src'), { recursive: true });
        assert.throws(() => confirmBuildSource(f.config), { code: 'BUILD_SOURCE_STALE' });
        await assert.rejects(prepareCompileSource(f.config), { code: 'BUILD_SOURCE_STALE' });
        assert.equal(fs.existsSync(path.join(f.root, '.temp')), false);
    });
}

for (const change of ['edit-tu', 'edit-header', 'add-tu', 'remove-tu', 'add-nested']) {
    test(`prepared inputs reject ${change} after preprocessing`, async t => {
        const f = fixture(t); await prepareCompileSource(f.config);
        const before = confirmPreparedBuildSource(f.config);
        if (change === 'edit-tu') f.put('.temp/sketch/helper.cpp', 'foreign source');
        if (change === 'edit-header') f.put('.temp/sketch/helper.h', '#define VALUE 77');
        if (change === 'add-tu') f.put('.temp/sketch/unexpected.cpp', 'int unexpected;');
        if (change === 'remove-tu') fs.unlinkSync(path.join(f.root, '.temp/sketch/helper.cpp'));
        if (change === 'add-nested') f.put('.temp/sketch/src/nested/second.cpp', 'int second;');
        assert.equal(confirmBuildSource(f.config).digest, f.config.sourceCapture.digest);
        assert.throws(() => confirmPreparedBuildSource(f.config, before), { code: 'BUILD_SOURCE_STALE' });
    });
}

test('an edit during asynchronous source copying cannot become a prepared build', async t => {
    const f = fixture(t), original = fs.promises.cp;
    fs.promises.cp = async (...args) => {
        await original(...args); f.put('src/helper.h', '#define VALUE 99\n');
    };
    try { await assert.rejects(prepareCompileSource(f.config), { code: 'BUILD_SOURCE_STALE' }); }
    finally { fs.promises.cp = original; }
    assert.equal(fs.readFileSync(path.join(f.root, 'src/helper.h'), 'utf8'), '#define VALUE 99\n');
});

test('private compile bookends reject mutation-and-restore even when source bytes are restored', async t => {
    const f = fixture(t); await prepareCompileSource(f.config);
    const before = confirmPreparedBuildSource(f.config), target = path.join(f.root, '.temp/sketch/helper.cpp');
    const bytes = fs.readFileSync(target);
    fs.writeFileSync(target, 'temporarily compiled different content'); fs.writeFileSync(target, bytes);
    const later = new Date(Date.now() + 2000); fs.utimesSync(target, later, later);
    assert.deepEqual(confirmPreparedBuildSource(f.config).manifest, before.manifest);
    assert.throws(() => confirmPreparedBuildSource(f.config, before), /changed during compilation/);
});

for (const kind of ['root', 'candidate', 'recursive-directory']) test(`linked ${kind} is rejected without traversal`, t => {
    const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.cpp'), 'must not be read');
    if (kind === 'root') {
        fs.rmSync(path.join(f.root, 'src'), { recursive: true }); fs.symlinkSync(outside, path.join(f.root, 'src'), 'junction');
    } else if (kind === 'candidate') fs.symlinkSync(path.join(outside, 'secret.cpp'), path.join(f.root, 'src/secret.cpp'));
    else fs.symlinkSync(outside, path.join(f.root, 'src/src/link'), 'junction');
    assert.throws(() => captureSketchInputs(path.join(f.root, 'src')), /physical|implicit links/);
});

test('a file changed inside the read is rejected, even if the directory remains unchanged', t => {
    const f = fixture(t), filename = path.join(__dirname, 'sketch-inputs.js'), localRequire = createRequire(filename);
    const source = path.join(f.root, 'src/helper.cpp'); let modified = false;
    const mockedFs = { ...fs, readSync(file, ...args) {
        const count = fs.readSync(file, ...args);
        if (!modified) { modified = true; fs.appendFileSync(source, 'changed while reading'); }
        return count;
    } };
    const record = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: record, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => record.exports.captureSketchInputs(path.join(f.root, 'src')), /changed during capture/);
    assert.equal(modified, true);
});

test('file and aggregate byte budgets reject unbounded source inputs', t => {
    const f = fixture(t);
    f.put('src/huge.cpp', Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.throws(() => captureSketchInputs(path.join(f.root, 'src')), /boundary/);
    fs.unlinkSync(path.join(f.root, 'src/huge.cpp'));
    for (let i = 0; i < 4; i++) f.put(`src/large${i}.cpp`, Buffer.alloc(4 * 1024 * 1024));
    assert.throws(() => captureSketchInputs(path.join(f.root, 'src')), /boundary/);
});

test('sorting is independent of ICU and ignored entries still have a traversal budget', t => {
    const f = fixture(t);
    for (const name of ['z.cpp', 'A.cpp', '_helper.h', '温度.h']) f.put(`src/${name}`, '');
    assert.deepEqual(captureSketchInputs(path.join(f.root, 'src')).manifest.files.map(file => file.path),
        ['A.cpp', '_helper.h', 'helper.cpp', 'helper.h', 'src/nested/extra.c', 'z.cpp', '温度.h']);
    const filename = path.join(__dirname, 'sketch-inputs.js'), localRequire = createRequire(filename), root = path.join(f.root, 'src');
    const mockedFs = { ...fs, readdirSync(directory, ...args) {
        return directory === root ? Array.from({ length: 16385 }, (_, i) => `ignored-${i}.txt`) : fs.readdirSync(directory, ...args);
    } };
    const record = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: record, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => record.exports.captureSketchInputs(root), /traversal exceeds/);
});

test('delivery binds the exact prepared source list through the existing Artifact input-record reference', async t => {
    const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    const record = emitArtifact(f), receipt = publishBuildDelivery(f.config, snapshot, entry, 'test:core:board');
    assert.equal(receipt.buildInputsDigest, record.digest);
    assert.equal(Object.hasOwn(record, 'sketchInputs'), false);
    assert.deepEqual(receipt.sourceCapture.sketchInputs, f.config.sourceCapture.sketchInputs);
    assert.equal(receipt.currentProjectAcceptance, false);
});

for (const change of ['missing', 'missing-file', 'changed-hash', 'extra-file']) {
    test(`self-consistent Artifact with ${change} sketch identity cannot receive delivery`, async t => {
        const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
        const inputs = structuredClone(f.config.sourceCapture.sketchInputs);
        if (change === 'missing-file') inputs.files.pop();
        if (change === 'changed-hash') inputs.files[0].sha256 = 'f'.repeat(64);
        if (change === 'extra-file') inputs.files.push({ path: 'foreign.cpp', sizeBytes: 0, sha256: hash('') });
        const { digest, ...body } = inputs; inputs.digest = hash(JSON.stringify(body));
        emitArtifact(f, change === 'missing' ? null : inputs);
        f.put('.build/firmware.bin', 'preserved firmware');
        assert.throws(() => publishBuildDelivery(f.config, snapshot, entry, 'test:core:board'), { code: 'BUILD_INPUT_RECORD_INVALID' });
        assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
        assert.equal(fs.existsSync(path.join(f.root, '.build/aily-artifact-manifest.json')), false);
        assert.equal(fs.readFileSync(path.join(f.root, '.build/firmware.bin'), 'utf8'), 'preserved firmware');
    });
}

test('a copied source mutation during receipt publication invalidates delivery and removes its temporary', async t => {
    const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    emitArtifact(f);
    const filename = path.join(__dirname, 'compile-delivery.js'), localRequire = createRequire(filename);
    let modified = false;
    const mockedFs = { ...fs, writeFileSync(file, ...args) {
        const result = fs.writeFileSync(file, ...args);
        if (String(file).includes('aily-build-delivery.json.') && !modified) {
            modified = true; f.put('.temp/sketch/helper.cpp', 'changed at publication');
        }
        return result;
    } };
    const record = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: record, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => record.exports.publishBuildDelivery(f.config, snapshot, entry, 'test:core:board'), /Prepared Arduino sketch inputs/);
    assert.equal(modified, true);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(name => name.endsWith('.tmp')), false);
});

test('a build-input record changed during publication cannot retain a delivery ticket', async t => {
    const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    emitArtifact(f);
    const filename = path.join(__dirname, 'compile-delivery.js'), localRequire = createRequire(filename);
    let modified = false;
    const mockedFs = { ...fs, writeFileSync(file, ...args) {
        const result = fs.writeFileSync(file, ...args);
        if (String(file).includes('aily-build-delivery.json.') && !modified) {
            modified = true; fs.appendFileSync(path.join(f.root, '.build/aily-build-inputs.json'), ' ');
        }
        return result;
    } };
    const record = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: record, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => record.exports.publishBuildDelivery(f.config, snapshot, entry, 'test:core:board'), /Build-graph record changed before delivery/);
    assert.equal(modified, true);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(name => name.endsWith('.tmp')), false);
});

test('a final Ninja graph changed during publication cannot retain a delivery ticket', async t => {
    const f = fixture(t), snapshot = captureProjectSources(f.config), entry = await prepareCompileSource(f.config);
    emitArtifact(f);
    const filename = path.join(__dirname, 'compile-delivery.js'), localRequire = createRequire(filename);
    let modified = false;
    const mockedFs = { ...fs, writeFileSync(file, ...args) {
        const result = fs.writeFileSync(file, ...args);
        if (String(file).includes('aily-build-delivery.json.') && !modified) {
            modified = true; fs.appendFileSync(path.join(f.root, '.build/build.ninja'), '# changed after record read\n');
        }
        return result;
    } };
    const record = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: record, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => record.exports.publishBuildDelivery(f.config, snapshot, entry, 'test:core:board'), { code: 'BUILD_INPUT_RECORD_INVALID' });
    assert.equal(modified, true);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
    assert.equal(fs.readdirSync(path.join(f.root, '.build')).some(name => name.endsWith('.tmp')), false);
});
