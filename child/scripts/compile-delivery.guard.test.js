'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { captureProjectSources, confirmProjectSources } = require('./compile-delivery');

// An explicitly selected original native-file-lock module keeps this narrow
// regression usable with installed or source layouts without copying an addon.
const nativeModule = process.env.AILY_NATIVE_FILE_LOCK_MODULE;
test('Windows native anchor remains locked while capture excludes only its exact root path', {
    skip: process.platform !== 'win32' ? 'Windows byte-range locking regression.'
        : !nativeModule ? 'Set AILY_NATIVE_FILE_LOCK_MODULE to the original native-file-lock.js.' : false
}, t => {
    assert(path.isAbsolute(nativeModule)); assert.equal(path.basename(nativeModule), 'native-file-lock.js');
    const { tryAcquireFileLock } = require(nativeModule);
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-delivery-guard-test-')));
    let guard;
    t.after(() => {
        guard?.close();
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-delivery-guard-test-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (relative, text) => {
        const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
    };
    put('package.json', JSON.stringify({ type: 'blockly' }));
    put('node_modules/@aily-project/board-test/board.json', '{}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    put('src/user.h', 'real header');
    put('.aily/source.h', 'real source in the same coordination parent');
    put('.aily/build-workspace.guard-custom', 'not the owned anchor');
    put('.aily/nested/build-workspace.guard', 'not the root anchor');
    const anchor = path.join(root, '.aily/build-workspace.guard');
    guard = tryAcquireFileLock(anchor); assert(guard); guard.assertHeld();
    const anchorIdentity = fs.lstatSync(anchor);
    assert.equal(anchorIdentity.size, 0);
    assert.throws(() => fs.readFileSync(anchor), error => error.code === 'EBUSY',
        'The original exclusive native lock must really reject a second-handle read.');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}' };
    const read = fs.readFileSync; let anchorReadAttempts = 0, before;
    fs.readFileSync = function (file, ...args) {
        if (typeof file === 'string' && path.resolve(file).toLowerCase() === anchor.toLowerCase()) anchorReadAttempts++;
        return read.call(this, file, ...args);
    };
    try {
        before = captureProjectSources(config);
        confirmProjectSources(before, config);
        assert.equal(anchorReadAttempts, 0);
    } finally { fs.readFileSync = read; }
    const names = before.body.files.map(file => file.path);
    assert(!names.includes('.aily/build-workspace.guard'));
    for (const name of ['.aily/source.h', '.aily/build-workspace.guard-custom', '.aily/nested/build-workspace.guard', 'src/user.h']) {
        assert(names.includes(name), 'Every neighboring source remains captured: ' + name);
        const original = fs.readFileSync(path.join(root, name), 'utf8');
        put(name, original + ' changed');
        assert.throws(() => confirmProjectSources(before, config), /PROJECT_INPUTS_CHANGED/);
        put(name, original);
        // Capture again because source freshness also guards real metadata.
        before = captureProjectSources(config);
    }
    guard.assertHeld(); assert.equal(fs.lstatSync(anchor).ino, anchorIdentity.ino);
    assert.equal(fs.lstatSync(anchor).size, 0);
    guard.close(); guard = undefined;
    assert.equal(fs.readFileSync(anchor).length, 0);
    t.diagnostic('Original native lock held; second-handle read EBUSY; capture anchor reads 0; four real source mutations rejected.');
});
