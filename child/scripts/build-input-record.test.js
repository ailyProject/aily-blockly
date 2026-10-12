'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readBuildInputRecordBinding } = require('./build-input-record');
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
