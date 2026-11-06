'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readBuildInputRecordBinding } = require('./build-input-record');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-record-binding-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-record-binding-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const buildPath = path.join(root, '.build'); fs.mkdirSync(buildPath);
    const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'build-graph-facts', configurationSha256: 'c'.repeat(64),
        steps: ['sketch', 'libraries', 'core', 'linking'].map(name => ({ kind: 'ninja-plan', name, sha256: 'd'.repeat(64) })) };
    const record = { ...body, digest: hash(JSON.stringify(body)) };
    const reference = { schemaVersion: 1, kind: 'aily-build-input-reference', scope: 'build-graph-facts', path: 'aily-build-inputs.json', digest: record.digest };
    const file = path.join(buildPath, reference.path); fs.writeFileSync(file, JSON.stringify(record));
    return { root, file, record, reference };
}

test('Host binds exact build-graph record bytes, distinct from semantic metadata digest', t => {
    const f = fixture(t), expected = hash(fs.readFileSync(f.file));
    assert.equal(readBuildInputRecordBinding(f.root, f.reference), expected);
    assert.notEqual(expected, f.reference.digest);
    fs.appendFileSync(f.file, ' ');
    assert.notEqual(readBuildInputRecordBinding(f.root, f.reference), expected);
    assert.equal(JSON.stringify(f.record).includes(f.root), false);
});

test('only the exact portable input reference contract is bindable', t => {
    const f = fixture(t);
    for (const patch of [{ schemaVersion: 2 }, { kind: 'other' }, { scope: 'whole-project' },
        { path: '../outside.json' }, { path: 'other.json' }, { digest: 'bad' }, { digest: 'f'.repeat(64) }]) {
        assert.throws(() => readBuildInputRecordBinding(f.root, { ...f.reference, ...patch }), { code: 'BUILD_INPUT_RECORD_INVALID' });
    }
});

test('record scope, schema, kind and semantic body digest must match the reference', t => {
    const f = fixture(t);
    for (const patch of [{ schemaVersion: 2 }, { kind: 'other' }, { scope: 'whole-project' },
        { digest: 'f'.repeat(64) }, { configurationSha256: 'e'.repeat(64) }, { steps: [] }]) {
        fs.writeFileSync(f.file, JSON.stringify({ ...f.record, ...patch }));
        assert.throws(() => readBuildInputRecordBinding(f.root, f.reference), { code: 'BUILD_INPUT_RECORD_INVALID' });
    }
});

test('oversized, hardlinked, redirected and missing record files are not bindable', t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference), { code: 'BUILD_INPUT_RECORD_INVALID' });
    fs.unlinkSync(f.file);
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference), { code: 'ENOENT' });
    const other = path.join(f.root, 'other'); fs.writeFileSync(other, JSON.stringify(f.record)); fs.linkSync(other, f.file);
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference), { code: 'BUILD_INPUT_RECORD_INVALID' });
    fs.unlinkSync(f.file); fs.writeFileSync(f.file, JSON.stringify(f.record));
    const outside = path.join(f.root, 'outside'); fs.renameSync(path.dirname(f.file), outside);
    fs.symlinkSync(outside, path.join(f.root, '.build'), 'junction');
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference), { code: 'BUILD_INPUT_RECORD_INVALID' });
    assert.equal(fs.readFileSync(path.join(outside, f.reference.path), 'utf8'), JSON.stringify(f.record));
});

function graphFixture(t, graph = `aily_sketch_inputs_digest = ${'e'.repeat(64)}\n`) {
    const f = fixture(t), expected = { digest: 'e'.repeat(64) }, graphFile = path.join(f.root, '.build/build.ninja');
    const publish = (text = graph, mutate = () => {}) => {
        fs.writeFileSync(graphFile, text);
        const { digest, ...body } = structuredClone(f.record);
        body.steps.find(step => step.name === 'linking').sha256 = hash(text); mutate(body);
        const record = { ...body, digest: hash(JSON.stringify(body)) };
        fs.writeFileSync(f.file, JSON.stringify(record)); f.reference.digest = record.digest;
        return record;
    };
    publish(); return { ...f, expected, graphFile, publish };
}

test('private source identity binds the actual final linking graph without public record extensions', async t => {
    const f = graphFixture(t);
    assert.equal(readBuildInputRecordBinding(f.root, f.reference, f.expected), hash(fs.readFileSync(f.file)));
    const frozen = '/Volumes/data/aily-work/work/sim-wireless-20261101/w5-c6/verified-byte-cache-product-a02/isolated/aily-simulator-browser-workspaces/7d0c9925c25dfd20/wireless-verified-byte-cache-product-a02/source/packages/simulator-protocol/dist/build-input-record.js';
    const { validateBuildInputRecord } = await import(pathToFileURL(frozen).href);
    const record = JSON.parse(fs.readFileSync(f.file, 'utf8'));
    assert.deepEqual(validateBuildInputRecord(record), record);
    const incompatible = { ...record, sketchInputs: { schemaVersion: 1, scope: 'arduino-sketch-inputs', files: [], digest: f.expected.digest } };
    assert.throws(() => validateBuildInputRecord(incompatible), /sketchInputs|unsupported/);
    f.publish(undefined, body => { body.sketchInputs = incompatible.sketchInputs; });
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference, f.expected), { code: 'BUILD_INPUT_RECORD_INVALID' });
});

for (const change of ['wrong-digest', 'missing-marker', 'duplicate-marker', 'expanded-value', 'indented-marker', 'continued-marker',
    'missing-linking', 'duplicate-linking', 'wrong-linking-kind', 'unrecorded-graph-edit']) {
    test(`self-consistent input record cannot bind ${change}`, t => {
        const f = graphFixture(t), marker = `aily_sketch_inputs_digest = ${f.expected.digest}\n`;
        let graph = marker;
        if (change === 'wrong-digest') graph = `aily_sketch_inputs_digest = ${'f'.repeat(64)}\n`;
        if (change === 'missing-marker') graph = '# legacy graph\n';
        if (change === 'duplicate-marker') graph = marker + marker;
        if (change === 'expanded-value') graph = 'aily_sketch_inputs_digest = $foreign_digest\n';
        if (change === 'indented-marker') graph = '  ' + marker;
        if (change === 'continued-marker') graph = 'description = hidden $\n' + marker;
        f.publish(graph, body => {
            if (change === 'missing-linking') body.steps = body.steps.filter(step => step.name !== 'linking');
            if (change === 'duplicate-linking') body.steps.push(body.steps.find(step => step.name === 'linking'));
            if (change === 'wrong-linking-kind') body.steps.find(step => step.name === 'linking').kind = 'recipe-run';
        });
        if (change === 'unrecorded-graph-edit') fs.appendFileSync(f.graphFile, '# changed after linking\n');
        assert.throws(() => readBuildInputRecordBinding(f.root, f.reference, f.expected), { code: 'BUILD_INPUT_RECORD_INVALID' });
    });
}

for (const change of ['symlink', 'hardlink', 'oversized', 'missing']) test(`unsafe ${change} final graph is rejected`, t => {
    const f = graphFixture(t);
    if (change === 'oversized') fs.truncateSync(f.graphFile, 8 * 1024 * 1024 + 1);
    else {
        fs.renameSync(f.graphFile, path.join(f.root, 'original.ninja'));
        if (change === 'symlink') fs.symlinkSync(path.join(f.root, 'original.ninja'), f.graphFile);
        if (change === 'hardlink') fs.linkSync(path.join(f.root, 'original.ninja'), f.graphFile);
    }
    assert.throws(() => readBuildInputRecordBinding(f.root, f.reference, f.expected),
        change === 'missing' ? { code: 'ENOENT' } : { code: 'BUILD_INPUT_RECORD_INVALID' });
});

test('a final graph changed during its bounded fd read fails closed', t => {
    const f = graphFixture(t), filename = path.join(__dirname, 'build-input-record.js'), localRequire = createRequire(filename);
    let graphFd, changed = false;
    const mockedFs = { ...fs, openSync(file, ...args) {
        const fd = fs.openSync(file, ...args); if (file === f.graphFile) graphFd = fd; return fd;
    }, readSync(fd, ...args) {
        const count = fs.readSync(fd, ...args);
        if (fd === graphFd && !changed) { changed = true; fs.appendFileSync(f.graphFile, '# changed during read\n'); }
        return count;
    } };
    const moduleRecord = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: moduleRecord, Buffer, process,
        require: name => name === 'node:fs' ? mockedFs : localRequire(name) }, { filename });
    assert.throws(() => moduleRecord.exports.readBuildInputRecordBinding(f.root, f.reference, f.expected), { code: 'BUILD_INPUT_RECORD_INVALID' });
    assert.equal(changed, true);
});
