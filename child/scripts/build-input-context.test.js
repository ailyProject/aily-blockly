'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readBuildInputContextBinding } = require('./build-input-context');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-context-binding-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-context-binding-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const buildPath = path.join(root, '.build'); fs.mkdirSync(buildPath);
    const context = { schemaVersion: 1, kind: 'aily-build-input-context', buildPath, preparedInputsDigest: 'a'.repeat(64) };
    const file = path.join(buildPath, 'aily-build-input-context.json'); fs.writeFileSync(file, JSON.stringify(context));
    return { root, file, context };
}
test('host binds exact private bytes without exporting their absolute paths', t => {
    const f = fixture(t), expected = createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
    assert.equal(readBuildInputContextBinding(f.root, f.context.preparedInputsDigest), expected);
    assert.throws(() => readBuildInputContextBinding(f.root, 'b'.repeat(64)), { code: 'BUILD_INPUT_CONTEXT_INVALID' });
    fs.writeFileSync(f.file, JSON.stringify({ ...f.context, buildPath: f.root }));
    assert.throws(() => readBuildInputContextBinding(f.root, f.context.preparedInputsDigest), { code: 'BUILD_INPUT_CONTEXT_INVALID' });
});
test('oversized, hardlinked and missing private files are not bindable', t => {
    const f = fixture(t);
    fs.writeFileSync(f.file, Buffer.alloc(4 * 1024 * 1024 + 1));
    assert.throws(() => readBuildInputContextBinding(f.root, f.context.preparedInputsDigest), { code: 'BUILD_INPUT_CONTEXT_INVALID' });
    fs.unlinkSync(f.file);
    assert.throws(() => readBuildInputContextBinding(f.root, f.context.preparedInputsDigest), { code: 'ENOENT' });
    const other = path.join(f.root, 'other'); fs.writeFileSync(other, JSON.stringify(f.context)); fs.linkSync(other, f.file);
    assert.throws(() => readBuildInputContextBinding(f.root, f.context.preparedInputsDigest), { code: 'BUILD_INPUT_CONTEXT_INVALID' });
});
