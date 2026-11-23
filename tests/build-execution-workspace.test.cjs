'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const api = require('../child/scripts/build-execution-workspace');
const upload = require('../child/scripts/blockly-upload-state');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');
const { createHash, randomUUID } = require('node:crypto');
const { prepareCompileSource, captureBlocklyCompileSource } = require('../child/scripts/compile-source');
const { holdWindowsFileWithoutDeleteSharing } = require('./fixtures/windows-file-sharing.cjs');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-execution-')));
    const cleanup = [];
    t.after(async () => {
        for (const task of cleanup) await task();
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-execution-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (file, bytes) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), bytes); };
    put('package.json', JSON.stringify({ type: 'blockly', dependencies: { '@aily-project/board-test': '1', '@aily-project/lib-test': '1' } }));
    put('node_modules/@aily-project/board-test/package.json', '{"name":"@aily-project/board-test"}');
    put('node_modules/@aily-project/board-test/board.json', '{"compilerParam":"-b test:test:test"}');
    put('node_modules/@aily-project/lib-test/package.json', '{"name":"@aily-project/lib-test"}');
    put('node_modules/@aily-project/lib-test/src/library.h', 'library');
    put('src/user.h', 'user'); put('src/variables_old-deadbeef.h', 'old generated');
    put('project.abi', 'original user program');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}\nvoid loop() {}',
        projectMacros: [{ name: 'CAPTURED', value: 'CAPTURED=1' }],
        generatedArtifacts: [{ fileName: 'variables_new-deadbeef.h', content: 'captured generated', sourceTag: 'test' }], buildRequestId: 'original-request' };
    return { root, put, config, cleanup };
}
function complete(config) {
    const root = config.currentProjectPath, build = path.join(root, '.build'), temp = path.join(root, '.temp');
    let lease;
    if (!fs.existsSync(path.join(path.dirname(root), 'outcome.json'))) {
        lease = acquireBuildWorkspace(root, 'compile');
        api.startBuildExecution(config, lease);
    }
    fs.mkdirSync(build, { recursive: true }); fs.mkdirSync(temp, { recursive: true });
    fs.writeFileSync(path.join(build, 'firmware.bin'), 'trusted firmware');
    fs.writeFileSync(path.join(temp, 'preprocess.json'), JSON.stringify({ success: true, envVars: { BUILD_PATH: build }, upload: { command: `flash "${path.join(build, 'firmware.bin')}"` } }));
    upload.publishBlocklyUploadState(config, upload.captureBlocklyUploadInputs(config));
    lease?.release();
    api.finishBuildExecution(config, true);
}

function sharedFixture(t) {
    const oldSupervisor = process.env.AILY_BUILD_WORKSPACE_SUPERVISOR;
    process.env.AILY_BUILD_WORKSPACE_SUPERVISOR = randomUUID();
    t.after(() => {
        if (oldSupervisor === undefined) delete process.env.AILY_BUILD_WORKSPACE_SUPERVISOR;
        else process.env.AILY_BUILD_WORKSPACE_SUPERVISOR = oldSupervisor;
    });
    const f = fixture(t);
    return { ...f, prepare: (id, workspace, operation = 'compile', explicitPreprocess = operation === 'preprocess') => api.prepareBuildExecution(
        { ...f.config, buildRequestId: id, explicitPreprocess }, workspace, operation, { shared: true }) };
}

for (const legacy of ['.aily/build-executions', '.aily/build-executions/requests'])
test(`a regular file at ${legacy} cannot block a new shared build`, t => {
    const f = sharedFixture(t);
    f.put(legacy, 'old data');
    const first = f.prepare('new-request');
    assert.equal(first.currentProjectPath, f.root);
    assert.throws(() => f.prepare('new-request'));
    assert.equal(fs.readFileSync(path.join(f.root, legacy), 'utf8'), 'old data');
});

test('shared build uses project caches and captures the live canvas without changing saved inputs', async t => {
    const f = sharedFixture(t), sha = data => createHash('sha256').update(data).digest('hex');
    const savedA = JSON.stringify({ pages: [{ code: 'A' }] });
    const liveB = JSON.stringify({ pages: [{ code: 'B' }] });
    f.put('project.abi', savedA);
    f.config.savedBuildComparison = { savedMatch: 'different', savedAbiHash: 'sha256:' + sha(savedA) };
    const audio = 'audio/converted.mp3';
    f.put(audio, 'current audio');
    const manifest = fs.readFileSync(path.join(f.root, 'package.json'));
    const captured = f.prepare('foreground-b', { revision: 4, runtimeRevision: 1, pageId: 'main', documentText: liveB });
    assert.equal(captured.currentProjectPath, f.root);
    assert.equal(captured.execution.layout, 'shared');
    assert.equal(captured.execution.buildSnapshot.savedMatch, 'different');
    assert.equal(captured.execution.buildSnapshot.documentSha256, sha(liveB));
    assert.equal(api.validateSharedBuildLaunch(captured.configFilePath, f.root, 'compile').execution.id, captured.execution.id);
    assert.equal(fs.existsSync(path.join(path.dirname(captured.configFilePath), 'project')), false);
    assert.equal(api.inspectBuildExecution(f.root, 'foreground-b').current, false);

    const sketch = await prepareCompileSource(captured);
    const header = path.join(path.dirname(sketch), 'variables_new-deadbeef.h');
    assert.equal(sketch, path.join(f.root, '.temp', 'sketch', 'sketch.ino'));
    assert.equal(fs.readFileSync(sketch, 'utf8'), captured.code);
    assert.equal(fs.readFileSync(header, 'utf8'), 'captured generated');
    assert.equal(fs.existsSync(path.join(path.dirname(sketch), 'variables_old-deadbeef.h')), false);
    assert.equal(fs.existsSync(path.join(f.root, 'src', 'variables_new-deadbeef.h')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'project.abi'), 'utf8'), savedA);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'package.json')), manifest);
    captureBlocklyCompileSource(captured, sketch);
    fs.writeFileSync(header, 'changed declaration');
    assert.throws(() => captureBlocklyCompileSource(captured, sketch), { code: 'BUILD_SOURCE_STALE' });

    complete(captured);
    assert.equal(api.resolveBuildExecution(f.root).buildPath, path.join(f.root, '.build'));
    assert.equal(api.resolveBuildExecution(f.root).executionId, captured.execution.id);
    assert.equal(api.inspectBuildExecution(f.root, 'foreground-b').buildHistory.sourceSha256, sha(captured.code));
    f.put('project.abi', liveB);
    assert.equal(api.canReuseBuildExecution(f.config), true);
    assert.equal(api.canReuseBuildExecution({ ...f.config, code: 'void setup() { different(); }' }), false);
    f.put(audio, 'new audio');
    assert.equal(api.canReuseBuildExecution(f.config), false);
    assert.throws(() => api.confirmSharedBuildInputs(captured), { code: 'BUILD_SOURCE_STALE' });
});

test('a later shared preparation retires only its pending original without changing current firmware', t => {
    const f = sharedFixture(t);
    const completed = f.prepare('compiled');
    complete(completed);
    const first = f.prepare('early-foreground');
    const background = f.prepare('background', undefined, 'preprocess');
    assert.equal(api.validateSharedBuildLaunch(first.configFilePath, f.root, 'compile').execution.id, first.execution.id);
    const next = f.prepare('late-foreground');
    assert.equal(api.inspectBuildExecution(f.root, 'early-foreground').status, 'cancelled');
    assert.throws(() => api.validateSharedBuildLaunch(first.configFilePath, f.root, 'compile'));
    assert.equal(api.validateSharedBuildLaunch(background.configFilePath, f.root, 'preprocess').execution.id, background.execution.id);
    assert.equal(api.resolveBuildExecution(f.root).executionId, completed.execution.id);
    assert.equal(api.inspectBuildExecution(f.root, 'late-foreground').current, false);
    complete(next);
    assert.equal(fs.existsSync(completed.configFilePath), false);
    assert.equal(api.inspectBuildExecution(f.root, 'compiled').status, 'completed');
    assert.deepEqual(api.settleStoppedSharedBuild(f.root,
        { id: completed.execution.id, buildRequestId: 'compiled' }).status, 'completed');
    assert.equal(api.resolveBuildExecution(f.root).executionId, next.execution.id);
});

for (const operation of ['compile', 'preprocess']) {
    test(`shared ${operation} refusal settles only the original unstarted request`, async t => {
        const f = sharedFixture(t);
        const completed = f.prepare('previous-success');
        complete(completed);
        const owner = acquireBuildWorkspace(f.root, 'verify');
        const pending = f.prepare('lock-refused', undefined, operation);
        const originalMarker = fs.readFileSync(path.join(f.root, '.build', 'aily-workspace.lock'));
        try {
            const child = spawn(process.execPath, [require.resolve('../child/scripts/' + operation), pending.configFilePath],
                { windowsHide: true, stdio: 'ignore' });
            assert.deepEqual(await once(child, 'close'), [1, null]);
            const refused = api.inspectBuildExecution(f.root, pending.execution.buildRequestId);
            assert.equal(refused.executionId, pending.execution.id);
            assert.equal(refused.status, 'not-started');
            assert.equal(refused.code, 'BUILD_WORKSPACE_BUSY');
            assert.equal(refused.nextAction, 'terminal');
            assert.deepEqual(fs.readFileSync(path.join(f.root, '.build', 'aily-workspace.lock')), originalMarker);
            assert.equal(fs.existsSync(pending.configFilePath), false);
            assert.equal(api.inspectBuildExecution(f.root, completed.execution.buildRequestId).status, 'completed');
            assert.equal(api.resolveBuildExecution(f.root).executionId, completed.execution.id);
            assert.throws(() => f.prepare('lock-refused', undefined, operation), { code: 'BUILD_EXECUTION_EXISTS' });
            assert.equal(api.settleStoppedSharedBuild(f.root, pending.execution).status, 'not-started');
        } finally { owner.release(); }
        const next = f.prepare('next-request');
        complete(next);
        assert.equal(api.resolveBuildExecution(f.root).executionId, next.execution.id);
        assert.equal(api.inspectBuildExecution(f.root, 'lock-refused').status, 'not-started');
    });
}

test('shared advisory preprocessing reuses the verified recipe and keeps the foreground firmware current', async t => {
    const f = sharedFixture(t);
    const completed = f.prepare('completed-foreground');
    complete(completed);
    const recipe = path.join(f.root, '.temp', 'preprocess.json');
    const before = fs.readFileSync(recipe, 'utf8');
    const pending = f.prepare('advisory', undefined, 'preprocess', false);
    const child = spawn(process.execPath, [require.resolve('../child/scripts/preprocess'), pending.configFilePath],
        { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors += chunk; });
    assert.deepEqual(await once(child, 'close'), [0, null], errors);
    assert.equal(fs.readFileSync(recipe, 'utf8'), before);
    assert.equal(api.resolveBuildExecution(f.root).executionId, completed.execution.id);
    assert.equal(fs.existsSync(pending.configFilePath), false);
    f.put('.temp/preprocess.json', JSON.stringify({ ...JSON.parse(before), differentCommand: true }));
    assert.equal(api.resolveBuildExecution(f.root), null);
    assert.throws(() => upload.readBlocklyUploadArtifacts(path.join(f.root, '.build')), /BUILD_ARTIFACT_STALE/);
    assert.equal(api.inspectBuildExecution(f.root, 'completed-foreground').status, 'completed');
});

test('shared cache clear waits for the writer, removes legacy payloads and preserves original receipts', t => {
    const f = sharedFixture(t);
    const legacy = api.prepareBuildExecution({ ...f.config, buildRequestId: 'legacy' });
    complete(legacy);
    const current = f.prepare('latest');
    complete(current);
    const pending = f.prepare('queued');
    f.put('.temp/sketch/keep.cpp', 'preprocess data');
    const owner = acquireBuildWorkspace(f.root, 'verify');
    try {
        assert.throws(() => api.clearSharedBuildCache(f.root), { code: 'BUILD_WORKSPACE_BUSY' });
        assert.equal(fs.readFileSync(path.join(f.root, '.build', 'firmware.bin'), 'utf8'), 'trusted firmware');
    } finally { owner.release(); }
    assert.deepEqual(api.clearSharedBuildCache(f.root, { preserveSketch: true }), { cleared: true, retainedExecutionIds: [] });
    assert.equal(fs.existsSync(path.join(f.root, '.build', 'firmware.bin')), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.temp', 'sketch', 'keep.cpp'), 'utf8'), 'preprocess data');
    assert.equal(fs.existsSync(path.join(legacy.currentProjectPath, 'node_modules')), false);
    assert.equal(api.inspectBuildExecution(f.root, 'legacy').status, 'completed');
    assert.equal(api.inspectBuildExecution(f.root, 'latest').status, 'completed');
    assert.equal(api.inspectBuildExecution(f.root, 'queued').status, 'cancelled');
    assert.equal(fs.existsSync(pending.configFilePath), false);
    assert.equal(api.resolveBuildExecution(f.root), null);
});

test('an exact revoked request remains terminal after Windows cache cleanup fails and restarts', {
    skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 20000,
}, async t => {
    const f = sharedFixture(t);
    const pending = [f.prepare('queued-compile'), f.prepare('queued-preprocess', undefined, 'preprocess')];
    const restartedStatus = request => execFileSync(process.execPath, ['-e',
        'const [file, root, request] = process.argv.slice(1); process.stdout.write(require(file).inspectBuildExecution(root, request).status);',
        require.resolve('../child/scripts/build-execution-workspace'), f.root, request], { encoding: 'utf8', windowsHide: true });
    const file = path.join(f.root, '.build', 'held-object.obj');
    f.put('.build/held-object.obj', 'cache object');
    const release = await holdWindowsFileWithoutDeleteSharing(file);
    try {
        assert.throws(() => api.clearSharedBuildCache(f.root), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
        assert.equal(fs.readFileSync(file, 'utf8'), 'cache object');
        for (const original of pending) {
            assert.throws(() => api.validateSharedBuildLaunch(original.configFilePath, f.root, original.execution.operation));
            assert.equal(restartedStatus(original.execution.buildRequestId), 'cancelled');
        }
    } finally { await release(); }
    assert.equal(api.clearSharedBuildCache(f.root).cleared, true);
    assert.equal(fs.existsSync(file), false);
    const next = f.prepare('new-after-clear-retry');
    assert.equal(api.validateSharedBuildLaunch(next.configFilePath, f.root, 'compile').execution.id, next.execution.id);
    for (const original of pending) assert.equal(restartedStatus(original.execution.buildRequestId), 'cancelled');
});

test('shared cache clear removes an exited legacy recovery marker under the current cleaning lease', async t => {
    const f = fixture(t);
    const filename = '.build/aily-workspace-recovery.lock';
    const marker = path.join(f.root, filename);
    const firmware = path.join(f.root, '.build', 'firmware.bin');
    const ownerToken = randomUUID();
    f.put('.build/firmware.bin', 'old firmware');
    for (const bytes of ['incomplete', JSON.stringify({ pid: process.pid, ownerToken })]) {
        f.put(filename, bytes);
        assert.throws(() => api.clearSharedBuildCache(f.root), { code: 'BUILD_WORKSPACE_BUSY' });
        assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
        assert.equal(fs.readFileSync(firmware, 'utf8'), 'old firmware');
    }

    const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    assert.deepEqual(await once(exited, 'close'), [0, null]);
    f.put(filename, JSON.stringify({ pid: exited.pid, ownerToken }));

    assert.deepEqual(api.clearSharedBuildCache(f.root), { cleared: true, retainedExecutionIds: [] });
    assert.deepEqual(fs.readdirSync(path.join(f.root, '.build')), []);
    assert.ok(fs.existsSync(path.join(f.root, '.aily', 'build-workspace.guard')));
    assert.equal(fs.readFileSync(path.join(f.root, 'project.abi'), 'utf8'), 'original user program');
});

function archivedOutcome(project, id) {
    const name = createHash('sha256').update(id).digest('hex') + '.build.json';
    return JSON.parse(fs.readFileSync(path.join(project, '.log/compile/requests', name))).outcome;
}

for (const selector of ['current.json', 'pending-compile.json', 'pending-preprocess.json']) {
    test(`a broken shared ${selector} does not strand a new execution or clear`, t => {
        const f = sharedFixture(t), original = f.prepare('completed-before-selector-damage');
        complete(original);
        const { store, folder } = api.recordFor(original);
        const oldOutcome = fs.readFileSync(path.join(folder, 'outcome.json'));
        const broken = path.join(store.parent, selector);
        fs.writeFileSync(broken, '{"version":');
        const next = f.prepare('next-after-selector-damage', undefined, selector.includes('preprocess') ? 'preprocess' : 'compile');
        const lease = acquireBuildWorkspace(f.root, next.execution.operation);
        try { api.startBuildExecution(next, lease); }
        finally { lease.release(); }
        api.finishBuildExecution(next, false);
        fs.writeFileSync(broken, '{"version":');
        assert.deepEqual(api.clearSharedBuildCache(f.root), { cleared: true, retainedExecutionIds: [] });
        assert.equal(fs.existsSync(broken), false);
        assert.equal(fs.existsSync(path.join(f.root, '.build', 'firmware.bin')), false);
        assert.deepEqual(archivedOutcome(f.root, original.execution.buildRequestId), JSON.parse(oldOutcome));
        assert.equal(api.inspectBuildExecution(f.root, original.execution.buildRequestId).status, 'completed');
        assert.equal(api.inspectBuildExecution(f.root, next.execution.buildRequestId).status, 'failed');
    });
}

test('shared cleanup retires a missing current target without erasing original receipts', t => {
    const f = sharedFixture(t), original = f.prepare('receipt-before-missing-selector-target');
    complete(original);
    const { store, folder } = api.recordFor(original);
    const outcome = fs.readFileSync(path.join(folder, 'outcome.json'));
    fs.writeFileSync(store.pointer, JSON.stringify({ version: 1, id: randomUUID(), buildRequestId: 'missing-current-target' }));
    assert.deepEqual(api.clearSharedBuildCache(f.root), { cleared: true, retainedExecutionIds: [] });
    assert.equal(fs.existsSync(store.pointer), false);
    assert.deepEqual(archivedOutcome(f.root, original.execution.buildRequestId), JSON.parse(outcome));
});

test('a non-file shared selector is refused before any cache or pending selector is removed', t => {
    const f = sharedFixture(t), original = f.prepare('unaltered-selector');
    complete(original);
    const { store } = api.recordFor(original);
    const queued = path.join(store.parent, 'pending-compile.json');
    const pending = fs.readFileSync(queued);
    fs.unlinkSync(store.pointer);
    fs.mkdirSync(store.pointer);
    assert.throws(() => api.clearSharedBuildCache(f.root), { code: 'BUILD_EXECUTION_INVALID' });
    assert.equal(fs.lstatSync(store.pointer).isDirectory(), true);
    assert.deepEqual(fs.readFileSync(queued), pending);
    assert.equal(fs.readFileSync(path.join(f.root, '.build/firmware.bin'), 'utf8'), 'trusted firmware');
    assert.equal(fs.existsSync(path.join(f.root, '.temp', 'preprocess.json')), true);
});

test('shared build rejects a redirected cache directory before taking over the writer', t => {
    const f = sharedFixture(t);
    const request = f.prepare('redirected');
    f.put('user-files/keep.txt', 'user data');
    fs.symlinkSync(path.join(f.root, 'user-files'), path.join(f.root, '.temp'),
        process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => api.validateSharedBuildLaunch(request.configFilePath, f.root, 'compile'), { code: 'BUILD_EXECUTION_INVALID' });
    assert.throws(() => api.confirmSharedBuildInputs(request), { code: 'BUILD_EXECUTION_INVALID' });
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'user-files')), ['keep.txt']);
    assert.equal(api.inspectBuildExecution(f.root, 'redirected').status, 'prepared');
});

test('captures project audio for the build and invalidates upload on replacement or deletion', t => {
    const f = fixture(t);
    const audio = 'audio/73946cc8eb117bdb2d230f34583fcece.mp3';
    f.put(audio, 'first converted audio');
    f.put('assets/audio/source.wav', 'editor source');
    const audioDigest = upload.captureBlocklyUploadInputs(f.config);
    const first = api.prepareBuildExecution(f.config);
    const captured = path.join(first.currentProjectPath, audio);
    assert.equal(fs.readFileSync(captured, 'utf8'), 'first converted audio');
    assert.equal(fs.existsSync(path.join(first.currentProjectPath, 'assets')), false);
    complete(first);
    assert.equal(api.canReuseBuildExecution(f.config), true);

    f.put('assets/audio/source.wav', 'updated editor source');
    assert.equal(api.canReuseBuildExecution(f.config), true);
    f.put(audio, 'second converted audio');
    assert.notEqual(upload.captureBlocklyUploadInputs(f.config), audioDigest);
    assert.equal(api.canReuseBuildExecution(f.config), false);
    assert.equal(fs.readFileSync(captured, 'utf8'), 'first converted audio');

    const next = api.prepareBuildExecution({ ...f.config, buildRequestId: 'new-audio' });
    assert.equal(fs.readFileSync(path.join(next.currentProjectPath, audio), 'utf8'), 'second converted audio');
    complete(next);
    assert.equal(api.canReuseBuildExecution(f.config), true);
    fs.unlinkSync(path.join(f.root, audio));
    assert.equal(api.canReuseBuildExecution(f.config), false);
});

test('project audio capture refuses to follow a junction outside its input directory', t => {
    const project = fixture(t);
    const other = fixture(t);
    other.put('linked.mp3', 'outside media');
    fs.symlinkSync(other.root, path.join(project.root, 'audio'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => api.prepareBuildExecution(project.config), /linked project audio/i);
    assert.throws(() => upload.captureBlocklyUploadInputs(project.config), /linked project audio/i);

    fs.rmSync(path.join(project.root, 'audio'));
    project.put('audio/converted.mp3', 'managed media');
    fs.symlinkSync(other.root, path.join(project.root, 'audio', 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => api.prepareBuildExecution(project.config), /linked project audio escapes/i);
    assert.throws(() => upload.captureBlocklyUploadInputs(project.config), /source link escapes/i);
});

test('publishes the next Windows build after a brief current receipt sharing violation',
    { skip: process.platform !== 'win32' }, t => {
        const f = fixture(t), first = api.prepareBuildExecution(f.config);
        complete(first);
        const pointer = path.join(f.root, '.aily/build-executions/current.json');
        const previous = fs.readFileSync(pointer);
        const rename = fs.renameSync;
        let attempts = 0;
        fs.renameSync = (source, target) => {
            if (target === pointer && ++attempts === 1) {
                assert.deepEqual(fs.readFileSync(pointer), previous);
                throw Object.assign(new Error('Windows sharing violation'), { code: 'EPERM' });
            }
            return rename(source, target);
        };
        let next;
        try { next = api.prepareBuildExecution({ ...f.config, buildRequestId: 'next-request' }); }
        finally { fs.renameSync = rename; }
        assert.equal(attempts, 2);
        assert.equal(JSON.parse(fs.readFileSync(pointer)).id, next.execution.id);
        assert.equal(api.inspectBuildExecution(f.root, first.execution.buildRequestId).status, 'completed');
        assert.equal(api.inspectBuildExecution(f.root, next.execution.buildRequestId).status, 'prepared');
    });

test('allows a restricted renderer to load and read a build receipt without shared memory', t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config);
    complete(config);
    const modulePath = require.resolve('../child/scripts/atomic-replace');
    const cached = require.cache[modulePath];
    const sharedArrayBuffer = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
    try {
        delete require.cache[modulePath];
        Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, value: undefined });
        assert.equal(typeof require(modulePath).renameForAtomicReplace, 'function');
        assert.equal(api.inspectBuildExecution(f.root, config.execution.buildRequestId).status, 'completed');
    } finally {
        if (sharedArrayBuffer) Object.defineProperty(globalThis, 'SharedArrayBuffer', sharedArrayBuffer);
        else delete globalThis.SharedArrayBuffer;
        require.cache[modulePath] = cached;
    }
});

for (const status of ['completed', 'failed']) {
    test(`observes the original ${status} outcome after status publication was interrupted`, t => {
        const f = fixture(t), config = api.prepareBuildExecution(f.config);
        const { folder } = api.recordFor(config);
        const statusFile = path.join(folder, 'execution.json'), outcomeFile = path.join(folder, 'outcome.json');
        const rename = fs.renameSync;
        fs.renameSync = (source, target) => {
            if (target === statusFile && fs.existsSync(outcomeFile)) throw new Error('Interrupted after durable outcome');
            return rename(source, target);
        };
        try {
            assert.throws(() => status === 'completed' ? complete(config) : api.finishBuildExecution(config, false),
                /Interrupted after durable outcome/);
        } finally { fs.renameSync = rename; }

        const previousStatus = fs.readFileSync(statusFile), outcome = fs.readFileSync(outcomeFile);
        assert.equal(JSON.parse(outcome).status, status);
        const observed = api.inspectBuildExecution(f.root, f.config.buildRequestId);
        assert.equal(observed.status, status);
        assert.equal(observed.executionId, config.execution.id);
        assert.equal(observed.nextAction, 'terminal');
        assert.equal(Boolean(observed.result), status === 'completed');
        assert.deepEqual(api.inspectBuildExecution(f.root, f.config.buildRequestId), observed);
        assert.deepEqual(fs.readFileSync(statusFile), previousStatus);
        assert.deepEqual(fs.readFileSync(outcomeFile), outcome);
        assert.equal(api.cancelBuildExecution(config).status, status);

        if (status === 'completed') {
            fs.writeFileSync(path.join(config.currentProjectPath, '.build/firmware.bin'), 'changed output');
            const invalidated = api.inspectBuildExecution(f.root, f.config.buildRequestId);
            assert.equal(invalidated.status, 'completed');
            assert.equal(invalidated.nextAction, 'rebuild-current-inputs');
            assert.equal(invalidated.result, undefined);
        }
        const next = api.prepareBuildExecution({ ...f.config, buildRequestId: 'separate-request' });
        assert.equal(api.inspectBuildExecution(f.root, next.execution.buildRequestId).status, 'prepared');
        assert.equal(api.inspectBuildExecution(f.root, f.config.buildRequestId).status, status);
    });
}

test('rejects cancelled outcomes with a mismatched original execution binding', t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config);
    const file = path.join(api.recordFor(config).folder, 'outcome.json');
    const receipt = api.cancelBuildExecution(config);
    for (const mismatch of [{ version: 2 }, { id: 'other-execution' },
        { buildRequestId: 'other-request' }, { inputDigest: 'other-input' }]) {
        fs.writeFileSync(file, JSON.stringify({ ...receipt, ...mismatch }));
        assert.equal(api.inspectBuildExecution(f.root, f.config.buildRequestId), null);
        assert.throws(() => api.cancelBuildExecution(config), { code: 'BUILD_EXECUTION_INVALID' });
    }
});

test('view-only saves preserve conversion evidence and the existing firmware for upload', async t => {
    const f = fixture(t);
    const document = { pages: [{ id: 'main', blocks: { languageVersion: 0, blocks: [] }, viewState: { scrollX: 0, scrollY: 0, scale: 1 } }] };
    f.put('project.abi', JSON.stringify(document));
    const compiled = api.prepareBuildExecution(f.config); complete(compiled);
    const receipts = ['current.json', `${compiled.execution.id}/execution.json`, `${compiled.execution.id}/outcome.json`]
        .map(name => [name, fs.readFileSync(path.join(f.root, '.aily/build-executions', name))]);
    for (let index = 0; index < 10; index++) {
        document.pages[0].viewState.scrollX = index * 21;
        document.pages[0].viewState.scrollY = index * -42;
        f.put('project.abi', JSON.stringify(document, null, index % 2 ? 2 : 0));
        assert.equal(api.inspectBlocklyCompileProof(f.config).status, 'verified');
        assert.equal(api.canReuseBuildExecution(f.config), true);
        assert.equal(api.resolveBuildExecution(f.root)?.buildRequestId, f.config.buildRequestId);
    }
    for (const [name, content] of receipts) assert.deepEqual(fs.readFileSync(path.join(f.root, '.aily/build-executions', name)), content);
    const worker = fork(require.resolve('../child/scripts/build-execution-worker'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const message = once(worker, 'message'), closed = once(worker, 'close');
    worker.send({ action: 'inspect-compile-proof', config: f.config });
    assert.equal((await message)[0].proof.status, 'verified');
    assert.deepEqual(await closed, [0, null]);
});

test('can upload a compiled unsaved canvas after saving that exact canvas', t => {
    const f = fixture(t);
    const compiledDocument = { pages: [{ id: 'main', blocks: { text: 'compiled' } }] };
    f.put('project.abi', JSON.stringify({ pages: [{ id: 'main', blocks: { text: 'previously saved' } }] }));
    const compiled = api.prepareBuildExecution(f.config, { documentText: JSON.stringify({
        pages: [{ blocks: { text: 'compiled' }, id: 'main' }],
    }), revision: 1, runtimeRevision: 1, pageId: 'main' });
    complete(compiled);
    compiledDocument.pages[0].viewState = { scrollX: 27 };
    f.put('project.abi', JSON.stringify(compiledDocument));
    assert.equal(api.canReuseBuildExecution(f.config), true);
    assert.equal(api.canReuseBuildExecution({ ...f.config, code: 'unsaved code change' }), false);
    assert.equal(api.canReuseBuildExecution({ ...f.config, projectMacros: [] }), false);
    assert.equal(api.canReuseBuildExecution({ ...f.config, generatedArtifacts: [] }), false);
    compiledDocument.pages[0].blocks.text = 'changed after compile';
    f.put('project.abi', JSON.stringify(compiledDocument));
    assert.equal(api.resolveBuildExecution(f.root), null);
});

test('conversion evidence compares actual code, macros, generated artifacts and all compiler files', t => {
    const f = fixture(t), compiled = api.prepareBuildExecution(f.config); complete(compiled);
    const proof = config => api.inspectBlocklyCompileProof(config || f.config).status;
    assert.equal(proof(), 'verified', 'effective generator macros match the compiled manifest');
    assert.equal(proof({ ...f.config, code: 'different generated code' }), 'unverified');
    assert.equal(proof({ ...f.config, projectMacros: [{ name: 'CAPTURED', value: 'CAPTURED=2' }] }), 'unverified');
    assert.equal(proof({ ...f.config, generatedArtifacts: [{ ...f.config.generatedArtifacts[0], content: 'changed declaration' }] }), 'unverified');
    const changedFiles = ['src/user.h', 'components/driver.cpp', 'partitions.csv',
        'node_modules/@aily-project/lib-test/src/library.h', 'node_modules/@aily-project/board-test/board.json'];
    for (const name of changedFiles) {
        const filename = path.join(f.root, name), original = fs.existsSync(filename) ? fs.readFileSync(filename) : undefined;
        f.put(name, 'modified compiler input'); assert.equal(proof(), 'unverified', name);
        if (original) f.put(name, original); else { fs.rmSync(filename); if (name.startsWith('components/')) fs.rmdirSync(path.dirname(filename)); }
        assert.equal(proof(), 'verified', `restored ${name}`);
    }
    const manifest = fs.readFileSync(path.join(f.root, 'package.json'));
    f.put('package.json', JSON.stringify({ ...JSON.parse(manifest), MACROS: [['USER_FLAG=2']] }));
    assert.equal(proof(), 'unverified'); f.put('package.json', manifest);
    fs.writeFileSync(path.join(compiled.currentProjectPath, '.build/firmware.bin'), 'tampered firmware');
    assert.equal(proof(), 'unverified', 'a completed exit code cannot substitute for valid firmware');
});

test('conversion evidence handles missing, failed and unreadable receipts and an initially absent src directory', t => {
    const f = fixture(t);
    fs.rmSync(path.join(f.root, 'src'), { recursive: true }); f.config.generatedArtifacts = [];
    assert.equal(api.inspectBlocklyCompileProof(f.config).status, 'unverified');
    const compiled = api.prepareBuildExecution(f.config); complete(compiled);
    assert.equal(api.inspectBlocklyCompileProof(f.config).status, 'verified');
    const next = api.prepareBuildExecution({ ...f.config, buildRequestId: 'failed-request' });
    api.finishBuildExecution(next, false);
    assert.equal(api.inspectBlocklyCompileProof(f.config).status, 'unverified');
    f.put('.aily/build-executions/current.json', '{incomplete');
    assert.equal(api.inspectBlocklyCompileProof(f.config).status, 'unknown');
});

test('an orphan compiler keeps its old paths and PID while the new execution uses detached captured bytes', async t => {
    const f = fixture(t);
    f.put('.build/aily-workspace.lock', JSON.stringify({ schemaVersion: 1, nativeLeaseVersion: 1, delegationVersion: 1,
        delegated: true, pid: process.pid, token: '11111111-1111-1111-1111-111111111111', operation: 'compile' }));
    f.put('.temp/preprocess.json', 'old preprocess');
    const lock = fs.readFileSync(path.join(f.root, '.build/aily-workspace.lock'));
    const child = spawn(process.execPath, ['-e', `const fs=require('fs'),p=require('path'),r=process.argv[1];
      const timer=setInterval(()=>{fs.writeFileSync(p.join(r,'src/variables_old-deadbeef.h'),'late writer');
        fs.writeFileSync(p.join(r,'.build/firmware.bin'),'untrusted old firmware');fs.writeFileSync(p.join(r,'.temp/preprocess.json'),'late old preprocess');},5);
      process.send('ready');process.on('message',()=>{clearInterval(timer);process.exit(0)});`, f.root], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const closed = once(child, 'close');
    f.cleanup.push(async () => { if (child.connected) child.send('stop'); await closed; });
    await once(child, 'message');
    const config = api.prepareBuildExecution(f.config);
    assert.notEqual(config.currentProjectPath, f.root);
    assert.equal(fs.existsSync(path.join(config.currentProjectPath, 'src/variables_old-deadbeef.h')), false);
    assert.equal(fs.readFileSync(path.join(config.currentProjectPath, 'src/variables_new-deadbeef.h'), 'utf8'), 'captured generated');
    complete(config);
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').status, 'completed');
    assert.throws(() => api.prepareBuildExecution(f.config), { code: 'BUILD_EXECUTION_EXISTS' });
    assert.equal(api.canReuseBuildExecution(f.config), true);
    const selected = api.resolveBuildExecution(f.root);
    assert.equal(selected.buildRequestId, 'original-request');
    assert.equal(fs.readFileSync(path.join(selected.buildPath, 'firmware.bin'), 'utf8'), 'trusted firmware');
    assert.deepEqual(fs.readFileSync(path.join(f.root, '.build/aily-workspace.lock')), lock);
    assert.equal(fs.readFileSync(path.join(f.root, 'project.abi'), 'utf8'), 'original user program');
    process.kill(child.pid, 0); // Recovery did not signal or reclaim the old tree.
});

test('cancellation and superseding requests cannot be undone by a late successful compiler', t => {
    const f = fixture(t), first = api.prepareBuildExecution(f.config);
    assert.throws(() => api.cancelBuildExecution({ ...first, execution: { ...first.execution, buildRequestId: 'some-other-request' } }), /binding changed/);
    api.cancelBuildExecution(first); complete(first);
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').status, 'cancelled');
    assert.equal(api.resolveBuildExecution(f.root), null);
    const second = api.prepareBuildExecution({ ...f.config, buildRequestId: 'second-request' });
    complete(second); complete(first);
    assert.equal(api.resolveBuildExecution(f.root).buildRequestId, 'second-request');
    const reloaded = require('../child/scripts/build-execution-workspace');
    assert.equal(reloaded.resolveBuildExecution(f.root).buildRequestId, 'second-request');
    fs.writeFileSync(path.join(second.currentProjectPath, '.build/firmware.bin'), 'tampered');
    assert.equal(api.resolveBuildExecution(f.root), null);
});

test('library and user-source edits invalidate upload reuse without mutating the captured generation', t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config); complete(config);
    assert.equal(api.canReuseBuildExecution(f.config), true);
    f.put('node_modules/@aily-project/lib-test/src/library.h', 'new library');
    assert.equal(api.canReuseBuildExecution(f.config), false);
    assert.equal(fs.readFileSync(path.join(config.currentProjectPath, 'node_modules/@aily-project/lib-test/src/library.h'), 'utf8'), 'library');
    f.put('node_modules/@aily-project/lib-test/src/library.h', 'library');
    f.put('src/user.h', 'new user source');
    assert.equal(api.canReuseBuildExecution(f.config), false);
    assert.equal(api.resolveBuildExecution(f.root), null);
    f.put('src/user.h', 'user'); f.put('project.abi', 'manually changed document');
    assert.equal(api.resolveBuildExecution(f.root), null);
});

test('background executions do not supersede a completed foreground build', t => {
    const f = fixture(t), compiled = api.prepareBuildExecution(f.config); complete(compiled);
    api.prepareBuildExecution({ ...f.config, code: 'background newer code' }, undefined, 'preprocess');
    assert.equal(api.resolveBuildExecution(f.root).buildRequestId, 'original-request');
});

function completePreprocess(config) {
    const root = config.currentProjectPath, lease = acquireBuildWorkspace(root, 'preprocess');
    try {
        api.startBuildExecution(config, lease);
        for (const relative of ['.temp/libraries/lib/header.h', '.temp/sketch/sketch.ino', '.temp/preprocess.json', '.temp/target-compile.json']) {
            const filename = path.join(root, relative);
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, relative);
        }
    } finally { lease.release(); }
    api.finishBuildExecution(config, true);
}

test('standalone preprocess retirement keeps receipts, generated files and the exact foreground build', t => {
    const f = fixture(t), compiled = api.prepareBuildExecution(f.config); complete(compiled);
    const requestLog = `.log/compile/requests/${createHash('sha256').update(f.config.buildRequestId).digest('hex')}.log`;
    f.put(requestLog, 'full compile output');
    const config = api.prepareBuildExecution({ ...f.config, buildRequestId: 'background' }, undefined, 'preprocess');
    completePreprocess(config);
    const { folder, root } = api.recordFor(config), outcome = fs.readFileSync(path.join(folder, 'outcome.json'));
    api.retireStandalonePreprocessInputs(config);
    api.retireStandalonePreprocessInputs(config);
    for (const relative of ['node_modules', '.temp/libraries']) assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
    for (const relative of ['.temp/sketch/sketch.ino', '.temp/preprocess.json', '.temp/target-compile.json']) {
        assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), relative);
    }
    assert.deepEqual(fs.readFileSync(path.join(folder, 'outcome.json')), outcome);
    assert.equal(api.recordFor(config).record.preprocessInputsRetired, true);
    assert.equal(api.inspectBuildExecution(f.root, f.config.buildRequestId).status, 'completed');
    assert.equal(api.resolveBuildExecution(f.root).currentProjectPath, compiled.currentProjectPath);
    assert.equal(fs.readFileSync(path.join(f.root, requestLog), 'utf8'), 'full compile output');
    assert.equal(fs.readFileSync(path.join(f.root, 'node_modules/@aily-project/lib-test/src/library.h'), 'utf8'), 'library');
});

test('the actual preprocess command retires failed standalone inputs without hiding its diagnostic', async t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config, undefined, 'preprocess');
    const { folder, root } = api.recordFor(config);
    const child = spawn(process.execPath, [require.resolve('../child/scripts/preprocess'), path.join(folder, 'config.json')], {
        env: { ...process.env, AILY_COMPILERS_PATH: 'relative-test-resource-root' }, windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    assert.deepEqual(await once(child, 'close'), [1, null], stderr);
    assert.match(stderr, /AILY_COMPILERS_PATH must be an absolute platform resource root/);
    assert.equal(api.recordFor(config).record.status, 'failed');
    assert.equal(api.recordFor(config).record.preprocessInputsRetired, true);
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

test('explicit preprocess is observed by its original request without replacing current firmware', t => {
    const f = fixture(t);
    const compile = api.prepareBuildExecution(f.config);
    complete(compile);
    const original = api.resolveBuildExecution(f.root);
    const options = { ...f.config, buildRequestId: 'explicit-preprocess', explicitPreprocess: true };
    const prepared = api.prepareBuildExecution(options, undefined, 'preprocess');
    assert.equal(api.inspectBuildExecution(f.root, options.buildRequestId).status, 'prepared');
    assert.throws(() => api.prepareBuildExecution(options, undefined, 'preprocess'), { code: 'BUILD_EXECUTION_EXISTS' });
    const lease = acquireBuildWorkspace(prepared.currentProjectPath, 'preprocess');
    try {
        api.startBuildExecution(prepared, lease);
        const folder = path.join(prepared.currentProjectPath, '.temp', 'sketch');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'sketch.ino'), options.code);
        api.finishBuildExecution(prepared, true);
    } finally { lease.release(); }
    api.retireStandalonePreprocessInputs(prepared);
    const receipt = api.inspectBuildExecution(f.root, options.buildRequestId);
    assert.equal(receipt.status, 'completed');
    assert.equal(receipt.buildHistory.operation, 'preprocess');
    assert.equal(receipt.buildHistory.sourceSha256, createHash('sha256').update(options.code).digest('hex'));
    assert.equal(receipt.nextAction, 'terminal');
    assert.equal(receipt.current, false);
    for (const field of ['result', 'buildInput', 'buildSnapshot']) assert.equal(receipt[field], undefined);
    assert.equal(fs.existsSync(path.join(prepared.currentProjectPath, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(prepared.currentProjectPath, '.temp', 'sketch', 'sketch.ino'), 'utf8'), options.code);
    assert.deepEqual(api.resolveBuildExecution(f.root), original);
    const stopped = api.prepareBuildExecution({ ...options, buildRequestId: 'explicit-preprocess-stopped' }, undefined, 'preprocess');
    assert.equal(api.abandonPreparedPreprocess(stopped), true);
    assert.equal(api.inspectBuildExecution(f.root, stopped.execution.buildRequestId).status, 'cancelled');
});

test('a new build worker prunes verifiable terminal preprocess inputs from a moved archive', async t => {
    const source = fixture(t), target = fixture(t);
    const prepare = buildRequestId => api.prepareBuildExecution({ ...source.config, buildRequestId }, undefined, 'preprocess');
    const completed = prepare('old-completed'), pending = prepare('old-pending');
    const mismatch = prepare('old-mismatch'), indexed = prepare('old-indexed'), busy = prepare('old-busy');
    for (const config of [completed, mismatch, indexed, busy]) completePreprocess(config);
    api.cancelBuildExecution(pending); // A stop receipt without terminal ownership is insufficient.
    const invalidOutcome = path.join(path.dirname(mismatch.currentProjectPath), 'outcome.json');
    fs.writeFileSync(invalidOutcome, JSON.stringify({ ...JSON.parse(fs.readFileSync(invalidOutcome)), status: 'failed' }));
    const index = createHash('sha256').update(indexed.execution.buildRequestId).digest('hex') + '.json';
    source.put(`.aily/build-executions/requests/${index}`, JSON.stringify({ version: 1, id: indexed.execution.id,
        buildRequestId: indexed.execution.buildRequestId }));
    fs.renameSync(path.join(source.root, '.aily'), path.join(target.root, '.aily'));
    const moved = config => path.join(target.root, '.aily', 'build-executions', config.execution.id, 'project');
    const busyLease = acquireBuildWorkspace(moved(busy), 'preprocess');
    try {
        const worker = fork(require.resolve('../child/scripts/build-execution-worker'), [], {
            windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
        });
        const result = once(worker, 'message'), exited = once(worker, 'exit');
        worker.send({ config: target.config, operation: 'compile' });
        assert.equal((await result)[0].ok, true);
        assert.equal((await exited)[0], 0);
        assert.equal(fs.existsSync(path.join(moved(completed), 'node_modules')), false);
        assert.equal(fs.existsSync(path.join(moved(completed), '.temp/libraries')), false);
        for (const config of [pending, mismatch, indexed, busy]) {
            assert.equal(fs.existsSync(path.join(moved(config), 'node_modules')), true, config.execution.buildRequestId);
        }
        assert.equal(api.inspectBuildExecution(target.root, target.config.buildRequestId).status, 'prepared');
    } finally { busyLease.release(); }
});

test('the asynchronous preload adapter captures inputs off the renderer thread and rejects stale source selection', async t => {
    const f = fixture(t), bridge = require('../electron/build-workspace-publication');
    const pending = bridge.prepareBuildExecution(f.config);
    assert.equal(typeof pending.then, 'function');
    const config = await pending; complete(config);
    assert.equal(bridge.canReuseBlocklyUpload(f.config), true);
    assert.equal(bridge.inspectBuildExecution(f.root, 'original-request').status, 'completed');
    f.put('project.abi', 'edited after host restart');
    assert.equal(bridge.resolveBuildExecution(f.root), null);
});

test('the worker retires only the exact unstarted preprocess relinquished by its caller', async t => {
    const f = fixture(t), bridge = require('../electron/build-workspace-publication');
    const compiled = api.prepareBuildExecution(f.config); complete(compiled);
    const prepare = buildRequestId => api.prepareBuildExecution({ ...f.config, buildRequestId }, undefined, 'preprocess');
    const unstarted = prepare('unstarted'), unrelated = prepare('unrelated'), running = prepare('running');
    const { folder, root } = api.recordFor(unstarted);
    const lease = acquireBuildWorkspace(root, 'preprocess');
    const runningLease = acquireBuildWorkspace(running.currentProjectPath, 'preprocess');
    try {
        api.startBuildExecution(running, runningLease);
        await assert.rejects(bridge.abandonPreparedPreprocess(unstarted), { code: 'BUILD_WORKSPACE_BUSY' });
        assert.equal(await bridge.abandonPreparedPreprocess(running), false);
        assert.equal(fs.existsSync(path.join(folder, 'outcome.json')), false);
        assert.equal(fs.existsSync(path.join(root, 'node_modules')), true);
    } finally { lease.release(); runningLease.release(); }

    assert.equal(await bridge.abandonPreparedPreprocess(unstarted), true);
    assert.equal(await bridge.abandonPreparedPreprocess(unstarted), false);
    assert.equal(api.recordFor(unstarted).record.status, 'cancelled');
    assert.equal(api.recordFor(unstarted).record.preprocessInputsRetired, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'outcome.json'))).status, 'cancelled');
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(root, 'src/user.h'), 'utf8'), 'user');
    assert.equal(api.recordFor(unrelated).record.status, 'prepared');
    assert.equal(fs.existsSync(path.join(unrelated.currentProjectPath, 'node_modules')), true);
    assert.equal(fs.existsSync(path.join(running.currentProjectPath, 'node_modules')), true);
    assert.equal(api.resolveBuildExecution(f.root).currentProjectPath, compiled.currentProjectPath);
    const delayed = acquireBuildWorkspace(root, 'preprocess');
    try { assert.throws(() => api.startBuildExecution(unstarted, delayed), /already started or cancelled/); }
    finally { delayed.release(); }
});

test('cancellation wins even while another execution finalizer holds the transition guard', t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config);
    const guard = require('../child/scripts/native-file-lock').tryAcquireFileLock(path.join(f.root, '.aily/build-executions/execution.guard'));
    assert.ok(guard);
    try { assert.doesNotThrow(() => api.cancelBuildExecution(config)); }
    finally { guard.close(); }
    complete(config);
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').status, 'cancelled');
    assert.equal(api.resolveBuildExecution(f.root), null);
});

test('a late Stop preserves the completed outcome and firmware receipt instead of inventing cancellation', t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config); complete(config);
    const folder = path.dirname(config.currentProjectPath), before = fs.readFileSync(path.join(folder, 'outcome.json'));
    assert.equal(api.cancelBuildExecution(config).status, 'completed');
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').status, 'completed');
    assert.deepEqual(fs.readFileSync(path.join(folder, 'outcome.json')), before);
    assert.ok(api.resolveBuildExecution(f.root));
});

test('reconnecting to an interrupted request never substitutes another request current pointer or trusts a reused PID', async t => {
    const f = fixture(t), config = api.prepareBuildExecution(f.config), modulePath = require.resolve('../child/scripts/build-execution-workspace');
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').ownerState, 'start-unobserved');
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').nextAction, 'new-execution-required');
    const child = spawn(process.execPath, ['-e', `const fs=require('fs'),p=require('path'),api=require(process.argv[1]),c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
      const lease=require(p.join(p.dirname(process.argv[1]),'build-workspace-lease')).acquireBuildWorkspace(c.currentProjectPath,'compile');
      api.startBuildExecution(c,lease);lease.childEnvironment();`, modulePath, path.join(path.dirname(config.currentProjectPath), 'config.json')],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    assert.equal((await once(child, 'close'))[0], 0);
    assert.equal(api.inspectBuildExecution(f.root, 'original-request').status, 'interrupted');
    const newer = api.prepareBuildExecution({ ...f.config, buildRequestId: 'newer-request' }); complete(newer);
    const original = api.inspectBuildExecution(f.root, 'original-request');
    assert.equal(original.status, 'interrupted'); assert.equal(original.current, false); assert.equal(original.result, undefined);
    const recordPath = path.join(path.dirname(config.currentProjectPath), 'execution.json'), record = JSON.parse(fs.readFileSync(recordPath));
    record.owner.pid = process.pid; record.owner.creation = 'different-process-creation'; fs.writeFileSync(recordPath, JSON.stringify(record));
    const reused = api.inspectBuildExecution(f.root, 'original-request');
    assert.notEqual(reused.ownerState, 'live'); assert.equal(reused.result, undefined);
    process.kill(process.pid, 0);
});

test('an interrupted current-pointer publication does not hide the original admitted request', t => {
    const f = fixture(t); api.prepareBuildExecution(f.config);
    fs.unlinkSync(path.join(f.root, '.aily/build-executions/current.json'));
    const original = api.inspectBuildExecution(f.root, 'original-request');
    assert.equal(original.buildRequestId, 'original-request'); assert.equal(original.status, 'prepared');
    assert.equal(original.current, false); assert.equal(original.result, undefined);
});

test('R4 build input identifies detached original ABI across live edits, cancel, failure and reconnect', t => {
    const f = fixture(t), first = api.prepareBuildExecution(f.config);
    const expected = 'sha256:' + createHash('sha256').update('original user program').digest('hex');
    assert.equal(first.execution.abiHash, expected);
    f.put('project.abi', 'new live GUI document');
    api.cancelBuildExecution(first);
    const cancelled = api.inspectBuildExecution(f.root, 'original-request');
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.buildInput, { version: 1, executionId: first.execution.id,
        buildRequestId: 'original-request', inputDigest: first.execution.inputDigest, abiHash: expected });
    const second = api.prepareBuildExecution({ ...f.config, buildRequestId: 'failed-request' });
    api.finishBuildExecution(second, false);
    const failed = api.inspectBuildExecution(f.root, 'failed-request');
    assert.equal(failed.status, 'failed');
    assert.notEqual(failed.buildInput.abiHash, expected);
    assert.deepEqual(api.inspectBuildExecution(f.root, 'original-request').buildInput, cancelled.buildInput);
    assert.throws(() => api.recordFor({ ...first, execution: { ...first.execution, abiHash: second.execution.abiHash } }), /binding changed/);
});

test('a dirty Blockly build retains its own source alongside the unchanged saved ABI', t => {
    const f = fixture(t), sha = value => createHash('sha256').update(value).digest('hex');
    const savedAbiHash = `sha256:${sha('original user program')}`;
    const a = api.prepareBuildExecution({ ...f.config, savedBuildComparison: { savedAbiHash, savedMatch: 'matched' } },
        { documentText: '{"value":"A"}', revision: 1, runtimeRevision: 1, pageId: 'main' });
    complete(a);
    assert.equal(api.inspectBuildExecution(f.root, f.config.buildRequestId).buildSnapshot.savedMatch, 'matched');

    const b = { ...f.config, code: 'int value = 2;', buildRequestId: 'unsaved-b',
        savedBuildComparison: { savedAbiHash, savedMatch: 'different' } };
    const built = api.prepareBuildExecution(b, { documentText: '{"value":"B"}', revision: 2, runtimeRevision: 1, pageId: 'main' });
    complete(built);
    const observed = api.inspectBuildExecution(f.root, b.buildRequestId);
    assert.equal(observed.status, 'completed');
    assert.equal(observed.buildInput.abiHash, savedAbiHash);
    assert.deepEqual(observed.buildSnapshot, { version: 1, buildRequestId: b.buildRequestId, inputDigest: built.execution.inputDigest,
        sourceSha256: sha(b.code), documentSha256: sha('{"value":"B"}'), workspaceRevision: 2, savedAbiHash, savedMatch: 'different' });
    assert.equal(fs.readFileSync(path.join(f.root, 'project.abi'), 'utf8'), 'original user program');
    assert.equal(api.canReuseBuildExecution(b), true);
    assert.equal(api.canReuseBuildExecution({ ...b, code: 'int value = 3;' }), false);

    f.put('project.abi', 'changed outside the editor');
    const external = api.prepareBuildExecution({ ...b, buildRequestId: 'external-change' },
        { documentText: '{"value":"B"}', revision: 2, runtimeRevision: 1, pageId: 'main' });
    assert.equal(external.execution.buildSnapshot.savedMatch, 'unknown');
    assert.notEqual(external.execution.buildSnapshot.savedAbiHash, savedAbiHash);
    const historical = api.inspectBuildExecution(f.root, b.buildRequestId);
    assert.equal(historical.current, false);
    assert.equal(historical.result, undefined);
    assert.deepEqual(historical.buildSnapshot, observed.buildSnapshot);
});

test('cache layout retains a compact original receipt after clear without a private execution tree', t => {
    const f = sharedFixture(t);
    const req = f.prepare('receipt-layout');
    const legacy = path.join(f.root, '.aily', 'build-executions');
    const request = path.join(f.root, '.log/compile/requests',
        createHash('sha256').update('receipt-layout').digest('hex') + '.build.json');
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(path.dirname(path.dirname(req.configFilePath)), path.join(f.root, '.build', 'requests'));
    complete(req);
    assert.equal(fs.existsSync(req.configFilePath), false);
    assert.equal(api.resolveBuildExecution(f.root).executionId, req.execution.id);
    const fingerprint = upload.captureFirmware(f.root);
    f.put('.build/requests/misplaced.bin', 'not compiler output');
    assert.equal(upload.captureFirmware(f.root), fingerprint);
    fs.unlinkSync(path.join(f.root, '.build/requests/misplaced.bin'));
    const abandonedUpload = path.join(path.dirname(req.configFilePath), 'upload-request-' + randomUUID() + '.json');
    fs.writeFileSync(abandonedUpload, '{}');
    api.clearSharedBuildCache(f.root);
    assert.equal(fs.existsSync(abandonedUpload), false);
    const observed = api.inspectBuildExecution(f.root, 'receipt-layout');
    assert.equal(observed.status, 'completed');
    assert.equal(observed.current, false);
    assert.equal(observed.buildHistory.executionId, req.execution.id);
    assert.equal(api.resolveBuildExecution(f.root), null);
    assert.ok(fs.statSync(request).size < 4096);
    assert.equal(fs.readFileSync(request, 'utf8').includes('void setup'), false);
    assert.throws(() => f.prepare('receipt-layout'), { code: 'BUILD_EXECUTION_EXISTS' });
    const next = f.prepare('next-compile');
    assert.equal(api.cancelBuildExecution(req).status, 'completed');
    assert.equal(api.inspectBuildExecution(f.root, next.execution.buildRequestId).status, 'prepared');
    assert.equal(fs.existsSync(legacy), false);
});

test('terminal advisory preprocess leaves neither a private project nor a permanent request directory', t => {
    const f = sharedFixture(t), req = f.prepare('automatic-probe', undefined, 'preprocess', false);
    assert.equal(api.abandonPreparedPreprocess(req), true);
    assert.equal(fs.existsSync(path.dirname(req.configFilePath)), false);
    assert.equal(fs.existsSync(path.join(f.root, '.aily/build-executions')), false);
    assert.equal(api.inspectBuildExecution(f.root, 'automatic-probe'), null);
});

test('after upgrade only the newest shared preparation can launch; the old ID remains observable', t => {
    const f = sharedFixture(t), original = f.prepare('pre-upgrade');
    const cache = path.join(f.root, '.build/requests'), legacy = path.join(f.root, '.aily/build-executions');
    fs.mkdirSync(path.join(legacy, 'requests'), { recursive: true });
    const folder = path.join(legacy, original.execution.id);
    fs.renameSync(path.dirname(original.configFilePath), folder);
    fs.renameSync(path.join(cache, 'pending-compile.json'), path.join(legacy, 'pending-compile.json'));
    const key = createHash('sha256').update('pre-upgrade').digest('hex');
    fs.renameSync(path.join(f.root, '.log/compile/requests', key + '.build.json'), path.join(legacy, 'requests', key + '.json'));
    const file = path.join(folder, 'config.json'), cfg = JSON.parse(fs.readFileSync(file));
    delete cfg.execution.storage;
    fs.writeFileSync(file, JSON.stringify(cfg));
    const recordFile = path.join(folder, 'execution.json'), record = JSON.parse(fs.readFileSync(recordFile));
    delete record.storage;
    record.configDigest = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
    fs.writeFileSync(recordFile, JSON.stringify(record));
    assert.equal(api.validateSharedBuildLaunch(file, f.root, 'compile').execution.id, original.execution.id);
    const next = f.prepare('after-upgrade');
    assert.throws(() => api.validateSharedBuildLaunch(file, f.root, 'compile'));
    assert.equal(api.inspectBuildExecution(f.root, 'pre-upgrade').status, 'cancelled');
    assert.equal(api.validateSharedBuildLaunch(next.configFilePath, f.root, 'compile').execution.id, next.execution.id);
});

test('a concurrent receipt update cannot reject an independent build or discard its original outcome', t => {
    const f = sharedFixture(t), current = f.prepare('busy-receipt');
    const guard = require('../child/scripts/native-file-lock').tryAcquireFileLock(path.join(f.root, '.log/compile/requests/.build-receipts.guard'));
    assert.ok(guard);
    try {
        complete(current);
        const other = f.prepare('new-while-index-busy');
        assert.equal(api.inspectBuildExecution(f.root, current.buildRequestId).status, 'completed');
        assert.equal(api.inspectBuildExecution(f.root, other.buildRequestId).status, 'prepared');
    } finally { guard.close(); }
    api.clearSharedBuildCache(f.root);
    assert.equal(api.inspectBuildExecution(f.root, current.buildRequestId).status, 'completed');
});
