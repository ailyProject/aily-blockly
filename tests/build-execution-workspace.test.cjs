'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const api = require('../child/scripts/build-execution-workspace');
const upload = require('../child/scripts/blockly-upload-state');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');
const { createHash } = require('node:crypto');

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
