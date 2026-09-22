'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { loadAgentBridge } = require('./fixtures/subapp-agent-test-build.cjs');
const { registerBuildDebugPreview } = require('../build-debug-preview');
const moduleReady = loadAgentBridge();
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: (...args) => resolve(...args) }; };

async function fixture(t, options = {}) {
    const { SubappAgentBridgeService, replaceChildToolConfigs } = await moduleReady;
    replaceChildToolConfigs([{ id: 'simulator-debugger', runtime: { headless: true }, agent: { protocolVersion: 1, transport: 'aily-child-rpc',
        tools: [{ name: 'run', rpc: { method: 'simdebug.run' }, supportsCancellation: true },
            { name: 'describe', rpc: { method: 'runtime.capabilities' } },
            { name: 'evidence', rpc: { method: 'simdebug.evidence.read' } }] } }]);
    const original = global.window, calls = [], activity = [];
    global.window = { electronAPI: { childToolSession: {
        superviseOwner: async input => { await options.connect?.(input); return { ok: true, generation: 'native-generation' }; },
        invokeNativeAgent: async input => { calls.push(input); return options.invoke ? options.invoke(input) : { ok: true, result: { outcome: 'passed' } }; },
    } } };
    const forbidden = () => assert.fail('Must not acquire a UI Runtime or open a public socket');
    const service = new SubappAgentBridgeService({ acquire: forbidden, release: forbidden }, { openChildApp: forbidden, isChildAppWindowOpen: forbidden }, {
        recordInvocationStarted() {}, recordInvocationCompleted: value => activity.push(value), releaseSession() {}, recordRuntimeState() {},
    });
    t.after(async () => { await service.ownerGuard.close(); service.ngOnDestroy(); global.window = original; });
    const lease = await service.manageOwnerLease({ action: 'acquire', sessionId: 'chat-a' });
    const run = (context = lease, signal, tool = 'run') => service.execute({ toolId: 'simulator-debugger', tool,
        params: { manifestPath: 'C:/selected-other-project/aily-artifact-manifest.json', scenario: {}, owner: 'forged', runtimeManifestPath: 'forged', presentUi: true } }, signal,
        { ...context, toolCallId: 'tool-call-a', workspaceRoot: 'C:/current-project' });
    return { service, lease, run, calls, activity, release: () => service.manageOwnerLease({ action: 'release', ...lease }) };
}

test('native batch keeps host-issued owner, ignores workspace selection and never starts a UI Runtime', async t => {
    const f = await fixture(t); assert.equal((await f.run()).ok, true);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].owner, { generation: 'native-generation', ownerSessionId: f.lease.ownerLeaseId });
    assert.equal(f.calls[0].params.manifestPath, 'C:/selected-other-project/aily-artifact-manifest.json');
    assert.equal(f.calls[0].params.presentUi, undefined);
});

test('headless tools reject missing, forged, expired and cross-conversation leases', async t => {
    const f = await fixture(t);
    for (const [context, code] of [[{}, 'SUBAPP_SESSION_REQUIRED'], [{ ownerLeaseId: 'fake', sessionId: 'chat-a' }, 'SUBAPP_OWNER_EXPIRED'],
        [{ ...f.lease, sessionId: 'chat-b' }, 'SUBAPP_OWNER_MISMATCH']]) assert.equal((await f.run(context)).errorCode, code);
    await f.release(); assert.equal((await f.run()).errorCode, 'SUBAPP_OWNER_EXPIRED'); assert.equal(f.calls.length, 0);
});

for (const mode of ['cancel', 'close', 'expire']) test(`${mode} waits for native cleanup, without an early successful release`, async t => {
    const entered = deferred(), finished = deferred(), cancelled = deferred();
    const f = await fixture(t, { invoke: async input => {
        if (input.action === 'cancel') { cancelled.resolve(); return { ok: true, result: { cancelled: true } }; }
        entered.resolve(); await finished.promise; return { ok: false, errorCode: 'CANCELLED', error: 'Native batch cancelled' };
    } });
    const controller = new AbortController(); const running = f.run(f.lease, controller.signal);
    await entered.promise;
    let released = false, cleanup;
    if (mode === 'cancel') { controller.abort(); cleanup = running; }
    else if (mode === 'close') cleanup = f.release();
    else { f.service.ownerLeases.leases.get(f.lease.ownerLeaseId).expiresAt = 0; cleanup = f.service.ownerLeases.expire(); }
    const waiting = cleanup.then(() => { released = true; });
    await cancelled.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false);
    finished.resolve(); assert.equal((await running).errorCode, 'SUBAPP_RPC_CANCELLED'); await waiting;
    assert.equal(f.calls.filter(input => input.action === 'cancel').length, 1);
});

test('closing during native owner connection prevents a delayed launch', async t => {
    const entered = deferred(), resume = deferred();
    const f = await fixture(t, { connect: async input => { if (input.action === 'connect') { entered.resolve(); await resume.promise; } } });
    const running = f.run(); await entered.promise; const closed = f.release(); resume.resolve();
    await closed; assert.equal((await running).errorCode, 'SUBAPP_RPC_CANCELLED'); assert.equal(f.calls.length, 0);
});

test('owner release preserves an unconfirmed native cleanup failure', async t => {
    const entered = deferred(), cancelled = deferred();
    const f = await fixture(t, { invoke: async input => {
        if (input.action === 'cancel') { cancelled.resolve(); return { ok: true }; }
        entered.resolve(); await cancelled.promise;
        return { ok: false, errorCode: 'SUBAPP_STOP_UNCONFIRMED', error: 'Process stop unconfirmed' };
    } });
    const running = f.run(); await entered.promise;
    const released = await f.release();
    assert.equal(released.ok, false); assert.match(released.cleanupErrors[0].error, /unconfirmed/);
    assert.equal((await running).errorCode, 'SUBAPP_STOP_UNCONFIRMED');
});

test('native error details survive transport and host releases input budgets normally', async t => {
    const f = await fixture(t, { invoke: () => ({ ok: false, errorCode: 'TARGET_UNSUPPORTED', error: 'Wrong chip', details: { targets: ['esp32s3'] } }) });
    const result = await f.run(); assert.equal(result.errorCode, 'TARGET_UNSUPPORTED'); assert.deepEqual(result.details, { targets: ['esp32s3'] });
});

test('evidence uses the same host-issued lease and native transport without a UI Runtime', async t => {
    const f = await fixture(t);
    assert.equal((await f.run(f.lease, undefined, 'evidence')).ok, true);
    assert.equal(f.calls[0].method, 'simdebug.evidence.read');
    assert.equal(f.calls[0].owner.ownerSessionId, f.lease.ownerLeaseId);
    await f.release();
    assert.equal((await f.run(f.lease, undefined, 'evidence')).errorCode, 'SUBAPP_OWNER_EXPIRED');
});

test('evidence native IPC accepts only the main frame and fixed installed adapter', async () => {
    const handlers = new Map(), sender = { mainFrame: {} }; let actual;
    registerBuildDebugPreview({ handle: (name, fn) => handlers.set(name, fn) }, { previewEnabled: false,
        isCurrentRenderer: value => value === sender, preview: { readEvidence: async (_sender, value) => { actual = value; return { text: '{}' }; } } });
    const call = handlers.get('subapp-native-agent');
    const input = { action: 'call', toolId: 'simulator-debugger', method: 'simdebug.evidence.read', owner: { generation: 'g' },
        params: { runId: 'run-abcdef', file: 'report' }, entry: 'evil' };
    assert.equal((await call({ sender, senderFrame: sender.mainFrame }, input)).ok, true);
    assert.deepEqual(actual.params, input.params); assert.equal(actual.entry, undefined);
    assert.equal((await call({ sender, senderFrame: {} }, input)).errorCode, 'RPC_FORBIDDEN');
});

test('native IPC works without experimental preview and rejects method/path injection', async () => {
    const handlers = new Map(), sender = { mainFrame: {} }; let actual;
    registerBuildDebugPreview({ handle: (name, fn) => handlers.set(name, fn) }, { previewEnabled: false, isCurrentRenderer: value => value === sender,
        preview: { run: async (_sender, input, options) => { actual = { input, options }; return { outcome: 'passed' }; } } });
    assert.equal(handlers.has('build-debug-preview'), false);
    const call = handlers.get('subapp-native-agent'), event = { sender, senderFrame: sender.mainFrame };
    const input = { action: 'call', toolId: 'simulator-debugger', method: 'simdebug.run', requestId: crypto.randomUUID(),
        owner: { generation: 'g', ownerSessionId: 'owner' }, timeoutMs: 180000, params: { manifestPath: 'C:/build/a.json', scenario: {}, entry: 'evil', runtimeManifestPath: 'evil' } };
    assert.equal((await call(event, input)).ok, true);
    assert.equal(actual.input.entry, undefined); assert.equal(actual.input.runtimeManifestPath, undefined);
    assert.equal(actual.options.timeoutMs, 180000);
    assert.equal((await call(event, { ...input, method: 'shutdown' })).errorCode, 'SUBAPP_NATIVE_UNSUPPORTED');
    assert.equal((await call({ sender, senderFrame: {} }, input)).errorCode, 'RPC_FORBIDDEN');
});
