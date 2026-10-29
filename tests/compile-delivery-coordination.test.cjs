'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { captureProjectSources, confirmProjectSources } = require('../child/scripts/compile-delivery');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');
const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-delivery-coordination-')));
    const put = (relative, text) => {
        const filename = path.join(root, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, text);
        return filename;
    };
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(root), /^aily-delivery-coordination-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    put('package.json', JSON.stringify({ type: 'blockly' }));
    put('node_modules/@aily-project/board-test/board.json', '{}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    put('src/helper.h', '#pragma once');
    return { root, put, config: { currentProjectPath: root, boardModule: '@aily-project/board-test',
        code: 'void setup() {}\nvoid loop() {}', recordProjectDelivery: true } };
}

test('strict source capture succeeds while its actual compile lease holds the native guard', t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, 'compile');
    try {
        const guard = path.join(f.root, '.aily/build-workspace.guard');
        if (process.platform === 'win32') assert.throws(() => fs.readFileSync(guard), { code: 'EBUSY' });
        const snapshot = captureProjectSources(f.config);
        assert.equal(snapshot.body.files.some(file => file.path === '.aily/build-workspace.guard'), false);
        assert.equal(snapshot.body.files.some(file => file.path === 'src/helper.h'), true);
        confirmProjectSources(snapshot, f.config);
        assert.throws(() => acquireBuildWorkspace(f.root, 'compile'), { code: 'BUILD_WORKSPACE_BUSY' });
        lease.assertOwned();
    } finally { lease.release(); }
});

test('view guard and runtime owner churn do not invalidate source identity or release ownership', t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, 'compile');
    let view;
    try {
        view = tryAcquireFileLock(path.join(f.root, '.aily/project-view.guard'));
        assert.ok(view);
        f.put('.aily/project-open.lock', '{"owner":"first"}');
        f.put('.aily/project-files.write.lock', '{"owner":"first"}');
        const snapshot = captureProjectSources(f.config);
        f.put('.aily/project-open.lock', '{"owner":"second"}');
        fs.unlinkSync(path.join(f.root, '.aily/project-files.write.lock'));
        confirmProjectSources(snapshot, f.config);
        assert.equal(snapshot.body.files.some(file => file.path.startsWith('.aily/')), false);
        assert.equal(fs.readFileSync(path.join(f.root, '.aily/project-open.lock'), 'utf8'), '{"owner":"second"}');
        view.assertHeld();
        lease.assertOwned();
    } finally { view?.close(); lease.release(); }
});

for (const relative of ['.aily/assets/image.txt', '.aily/abs-sync/prepared.json', '.aily/custom.guard',
    '.aily/custom.lock', '.aily/backup/build-workspace.guard', 'src/project-open.lock']) {
    test(`strict capture still includes and detects changes in ${relative}`, t => {
        const f = fixture(t);
        f.put(relative, 'original');
        const lease = acquireBuildWorkspace(f.root, 'compile');
        try {
            const snapshot = captureProjectSources(f.config);
            assert.ok(snapshot.body.files.some(file => file.path === relative));
            f.put(relative, 'changed');
            assert.throws(() => confirmProjectSources(snapshot, f.config), /PROJECT_INPUTS_CHANGED/);
            assert.equal(fs.readFileSync(path.join(f.root, relative), 'utf8'), 'changed');
        } finally { lease.release(); }
    });
}

test('an unreadable real source remains a failure, not an excluded EBUSY', t => {
    const f = fixture(t);
    f.put('.aily/unknown.guard', 'real source');
    const lease = acquireBuildWorkspace(f.root, 'compile');
    const locked = tryAcquireFileLock(path.join(f.root, '.aily/unknown.guard'));
    try {
        assert.ok(locked);
        if (process.platform === 'win32') assert.throws(() => captureProjectSources(f.config), { code: 'EBUSY' });
        else {
            // Unix locks are advisory. A source read denial must still propagate.
            const original = fs.readFileSync;
            t.mock.method(fs, 'readFileSync', (filename, ...args) => {
                if (filename === path.join(f.root, '.aily/unknown.guard')) throw Object.assign(new Error('source unreadable'), { code: 'EACCES' });
                return original(filename, ...args);
            });
            assert.throws(() => captureProjectSources(f.config), { code: 'EACCES' });
        }
        lease.assertOwned();
        locked.assertHeld();
    } finally { locked?.close(); lease.release(); }
});

test('an explicitly configured source is not excluded merely because it names a coordination path', t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, 'compile');
    try {
        const guard = path.join(f.root, '.aily/build-workspace.guard');
        f.config.partitionFilePath = guard;
        if (process.platform === 'win32') assert.throws(() => captureProjectSources(f.config), { code: 'EBUSY' });
        else assert.ok(captureProjectSources(f.config).body.files.some(file => file.path === 'configured-partition'));
        lease.assertOwned();
    } finally { lease.release(); }
});

for (const entry of ['directory', 'link']) test(`reserved coordination path cannot hide a ${entry}`, t => {
    const f = fixture(t), lease = acquireBuildWorkspace(f.root, 'compile');
    try {
        if (entry === 'directory') f.put('.aily/project-open.lock/real.h', 'keep');
        else {
            const target = path.join(f.root, 'outside'); fs.mkdirSync(target);
            f.put('outside/real.h', 'keep');
            fs.symlinkSync(target, path.join(f.root, '.aily/project-open.lock'), 'junction');
        }
        assert.throws(() => captureProjectSources(f.config), /PROJECT_INPUTS_CHANGED/);
        assert.equal(fs.readFileSync(path.join(f.root, entry === 'directory' ? '.aily/project-open.lock/real.h' : 'outside/real.h'), 'utf8'), 'keep');
        lease.assertOwned();
    } finally { lease.release(); }
});

test('actual strict compile passes source capture, invalidates old tickets and preserves firmware on SDK failure', t => {
    const f = fixture(t);
    for (const name of ['aily-artifact-manifest.json', 'aily-build-delivery.json']) f.put(`.build/${name}`, 'old');
    f.put('.build/firmware.elf', 'keep firmware');
    const configPath = f.put('.temp/request.json', JSON.stringify({ ...f.config, appDataPath: path.join(f.root, 'missing-sdk') }));
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../child/scripts/compile.js'), configPath],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /预编译|Preprocess|SDK/);
    assert.doesNotMatch(result.stderr, /EBUSY/);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-artifact-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.build/firmware.elf'), 'utf8'), 'keep firmware');
});
