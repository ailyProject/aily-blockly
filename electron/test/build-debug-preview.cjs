'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { fixture } = require('./fixtures/build-delivery-fixture.cjs');
const { createBuildDebugPreview, resolvePreviewConfiguration, registerBuildDebugPreview } = require('../build-debug-preview');
const { SubappOwnerSupervisor } = require('../subapp-owner-supervisor');
const cmd = require('../cmd');
const debuggerRoot = process.env.AILY_TEST_DEBUGGER_ROOT || path.resolve(__dirname, '../../../aily-subapp/packages/simulator-debugger');
const { connectHostPeer } = require(path.join(debuggerRoot, 'index'));
const { scenario, waitFor } = require(path.join(debuggerRoot, 'test/fixtures/rpc-build.cjs'));

for (const mode of ['normal', 'coder', 'release', 'destroy', 'reload', 'source', 'board', 'project', 'cancel', 'timeout', 'stop']) {
    test(`native batch with supervised child and private owner cleanup: ${mode}`, { timeout: 15000 }, async t => {
        const f = fixture(t, mode === 'coder'), sender = Object.assign(new EventEmitter(), { id: 83, destroyed: false, isDestroyed() { return this.destroyed; } });
        f.state.owner.sender = sender;
        f.publish({ onMessage() {} });
        const work = path.join(f.root, '.temp/runtime'); fs.mkdirSync(work, { recursive: true });
        let registered, stops, publicCalls = 0;
        const supervisor = new SubappOwnerSupervisor({ resolveRuntime: (_id, senderId) => senderId === sender.id ? registered : undefined,
            send: async () => { publicCalls++; throw new Error('Must not use public lifecycle'); } });
        const owner = { ...supervisor.connect(sender), ownerSessionId: 'preview-owner', toolId: 'simulator-debugger' };
        const preview = createBuildDebugPreview({ registry: { supervisor, register: (_sender, value) => {
            registered = { streamId: value.streamId, hostInfo: value.publicInfo, nativeOwnerControl: true }; stops = value.stop;
            return () => { registered = undefined; };
        } }, configuration: () => ({ node: process.execPath, entry: path.join(__dirname, 'fixtures/private-debugger-runtime.cjs'),
            args: [debuggerRoot, work, ['normal', 'coder'].includes(mode) ? 'normal' : ['source', 'board', 'project'].includes(mode) ? 'controlled' : 'pending'], credentialEnv: 'AILY_SIMDEBUG_HOST_TOKEN', connect: connectHostPeer, release() {} }) });
        const controller = new AbortController(), requestId = randomUUID();
        const input = { owner, requestId, manifestPath: path.join(f.root, '.build/aily-artifact-manifest.json'), scenario };
        const outcome = preview.run(sender, input, { signal: controller.signal, timeoutMs: mode === 'timeout' ? 1000 : 10000 })
            .then(report => ({ report }), error => ({ error }));
        t.after(async () => { controller.abort(); await outcome; await supervisor.idle(); });
        await waitFor(() => fs.existsSync(path.join(work, 'started')));
        await assert.rejects(preview.run(sender, input), { code: 'SESSION_BUSY' });
        assert.equal(preview.cancel({}, requestId), false); assert.equal(preview.cancel(sender, randomUUID()), false);
        if (mode === 'release') assert.equal((await supervisor.release(sender, owner)).ok, true);
        if (mode === 'destroy') { sender.destroyed = true; sender.emit('destroyed'); }
        if (mode === 'reload') sender.emit('did-start-navigation', {}, '', false, true);
        if (mode === 'source') f.put('changed.h', 'changed');
        if (mode === 'board') f.state.source.boardModule = 'different';
        if (mode === 'project') f.state.source.activationId = randomUUID();
        if (['source', 'board', 'project'].includes(mode)) fs.writeFileSync(path.join(work, 'continue'), '1');
        if (mode === 'cancel') assert.equal(preview.cancel(sender, requestId), true);
        if (mode === 'stop') await stops();
        const result = await outcome;
        if (['normal', 'coder', 'source', 'board', 'project'].includes(mode)) assert.equal(result.report?.outcome, 'passed', String(result.error));
        else assert.ok(result.error, JSON.stringify(result));
        if (mode === 'timeout') assert.equal(result.error.code, 'RUN_TIMEOUT');
        assert.equal(fs.existsSync(path.join(work, 'closed')), true);
        assert.equal(registered, undefined); assert.equal(cmd.getActiveCmdProcesses().length, 0); assert.equal(publicCalls, 0);
        await supervisor.idle();
    });
}

test('preview IPC rejects other windows/subframes and forwards no executable/runtime paths', async () => {
    const sender = { mainFrame: {} }; let handler, input;
    registerBuildDebugPreview({ handle: (name, fn) => { if (name === 'build-debug-preview') handler = fn; } }, { isCurrentRenderer: value => value === sender,
        preview: { run: async (_sender, value) => { input = value; }, cancel: () => false } });
    await assert.rejects(handler({ sender, senderFrame: {} }, {}), { code: 'RPC_FORBIDDEN' });
    await assert.rejects(handler({ sender: {}, senderFrame: {} }, {}), { code: 'RPC_FORBIDDEN' });
    await handler({ sender, senderFrame: sender.mainFrame }, { action: 'run', requestId: randomUUID(), entry: 'evil', runtimeManifestPath: 'evil' });
    assert.equal(input.entry, undefined); assert.equal(input.runtimeManifestPath, undefined);
});

test('native installed resolver pins package, reads history without Runtime, and rejects path escape', async t => {
    const f = fixture(t), store = path.join(f.root, '.temp/subapps'), pkg = path.join(store, 'node_modules/@aily-project/subapp-simulator-debugger');
    fs.mkdirSync(pkg, { recursive: true });
    const manifest = { name: '@aily-project/subapp-simulator-debugger', version: '0.1.0', main: 'index.cjs' };
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg, 'index.cjs'), 'exports.connectHostPeer = () => {}; exports.readEvidence = async (root, params) => ({root, params});');
    const runtimeManifestPath = f.put('.temp/runtime.json', {});
    const options = { childRoot: f.dependencies.childRoot, appData: path.join(f.root, '.temp/appdata'), subappRoot: store, runtimeManifestPath };
    const config = resolvePreviewConfiguration(options);
    assert.equal(config.entry, path.join(pkg, 'index.cjs')); assert.equal(typeof config.connect, 'function');
    assert.throws(() => resolvePreviewConfiguration(options), { code: 'SUBAPP_BUSY' }); config.release();
    const withoutRuntime = resolvePreviewConfiguration({ ...options, runtimeManifestPath: '' });
    try {
        assert.equal(typeof withoutRuntime.readEvidence, 'function');
        const input = { runId: 'run-abcdef', file: 'report' };
        assert.deepEqual(await withoutRuntime.readEvidence(input), { root: path.join(options.appData, 'simulator-debugger/evidence'), params: input });
        assert.throws(() => withoutRuntime.args, { code: 'DEBUG_RUNTIME_NOT_INSTALLED' });
    }
    finally { withoutRuntime.release(); }
    manifest.main = '../outside.cjs'; fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg, '../outside.cjs'), 'throw new Error("must never execute");');
    assert.throws(() => resolvePreviewConfiguration(options), { code: 'SUBAPP_UNAVAILABLE' });
});

test('unconfirmed private process stop retains registration and blocks a new batch until verified recovery', async t => {
    const f = fixture(t), sender = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false });
    let runtime, registeredStop, removed = 0, stopCalls = 0;
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime });
    const owner = { ...supervisor.connect(sender), ownerSessionId: 'retained-owner' };
    const preview = createBuildDebugPreview({
        registry: { supervisor, register: (_sender, value) => {
            runtime = { streamId: value.streamId, hostInfo: value.publicInfo, nativeOwnerControl: true }; registeredStop = value.stop;
            return () => { runtime = undefined; removed++; };
        } }, configuration: () => ({ release() {} }), launch: async () => ({ streamId: 'retained-stream',
            publicInfo: { wsUrl: `ws://127.0.0.1:4000/ws?token=${'a'.repeat(64)}` },
            connect: async () => { throw Object.assign(new Error('unavailable'), { code: 'RPC_UNAVAILABLE' }); },
            stop: async () => { if (++stopCalls === 1) throw Object.assign(new Error('stop unconfirmed'), { code: 'SUBAPP_STOP_UNCONFIRMED' }); },
        }) });
    const input = { owner, manifestPath: path.join(f.root, '.build/aily-artifact-manifest.json'), requestId: randomUUID() };
    await assert.rejects(preview.run(sender, input), { code: 'SUBAPP_STOP_UNCONFIRMED' });
    assert.equal(removed, 0); assert.ok(runtime);
    await assert.rejects(preview.run(sender, input), { code: 'SESSION_BUSY' });
    await registeredStop(); assert.equal(removed, 1); assert.equal(runtime, undefined);
    await supervisor.release(sender, { ...owner, toolId: 'simulator-debugger' });
});
