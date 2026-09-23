'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { readBuildRequest } = require('./build-request');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-request-'));
    fs.mkdirSync(path.join(root, '.temp'));
    t.after(() => {
        assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('aily-build-request-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

test('consumes only its immutable per-call request while leaving another pending request intact', t => {
    const root = fixture(t), a = path.join(root, '.temp', `compile-request-${randomUUID()}.json`),
        b = path.join(root, '.temp', `compile-request-${randomUUID()}.json`);
    fs.writeFileSync(a, JSON.stringify({ currentProjectPath: root, code: 'first' }));
    fs.writeFileSync(b, JSON.stringify({ currentProjectPath: root, code: 'second' }));
    assert.equal(readBuildRequest(a).code, 'first'); assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), true); assert.equal(readBuildRequest(b).code, 'second');
});

for (const location of ['saved', 'outside', 'wrong-project']) test(`does not delete ${location} configuration`, t => {
    const root = fixture(t), filename = location === 'saved' ? path.join(root, '.temp/build-config.json')
        : path.join(root, location === 'outside' ? '' : '.temp', `compile-request-${randomUUID()}.json`);
    const other = path.join(root, 'other'); fs.mkdirSync(other);
    fs.writeFileSync(filename, JSON.stringify({ currentProjectPath: location === 'wrong-project' ? other : root, code: 'keep' }));
    assert.equal(readBuildRequest(filename).code, 'keep'); assert.equal(fs.existsSync(filename), true);
});
