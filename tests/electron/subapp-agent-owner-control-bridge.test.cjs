const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const esbuild = require('esbuild');
const { SubappOwnerSupervisor } = require('../../electron/subapp-owner-supervisor');

const loaded = esbuild.build({ stdin: { contents: "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service.ts';",
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'angular-decorator-only', setup(build) {
        build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents:
            'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}', loader: 'js' }));
    } }] }).then(result => {
        const record = { exports: {} };
        new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, record, record.exports);
        return record.exports;
    });

async function fixture(t) {
    const { SubappAgentBridgeService } = await loaded;
    let now = Date.now();
    const sender = Object.assign(new EventEmitter(), { id: 9, getOSProcessId: () => 109, isDestroyed: () => false });
    const runtime = { streamId: 'owned-native-fixture', nativeOwnerControl: true, hostInfo: { wsUrl: 'ws://127.0.0.1:4310/ws' } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime, now: () => now });
    const oldWindow = global.window, services = [];
    const actions = [];
    global.window = { childToolSession: { superviseOwner: async input => {
        actions.push(input.action);
        try {
            switch (input.action) {
                case 'connect': return supervisor.connect(sender);
                case 'track': return await supervisor.track(sender, input);
                case 'release': return await supervisor.release(sender, input);
                case 'agent-acquire': return supervisor.acquireAgentOwner(sender, input);
                case 'agent-renew': return supervisor.renewAgentOwner(sender, input);
                case 'agent-inspect': return supervisor.inspectAgentOwner(sender, input);
                case 'agent-retire': return await supervisor.retireAgentOwner(sender, input);
                case 'agent-recover': return await supervisor.recoverAgentOwner(sender, input);
                default: throw Error('Unexpected supervision action');
            }
        } catch (error) { return { ok: false, errorCode: error.code || 'SUBAPP_SUPERVISION_FAILED', error: error.message }; }
    } } };
    const create = () => {
        const service = new SubappAgentBridgeService({}, {}, { releaseSession() {} });
        services.push(service); return service;
    };
    t.after(async () => {
        for (const service of services) { await service.ownerGuard.close().catch(() => {}); service.ownerLeases.stop(); }
        global.window = oldWindow;
    });
    return { supervisor, sender, runtime, actions, create, expire: () => { now += 46_000; },
        async attach(lease, cleanup) {
            const owner = { generation: lease.ownerControl.generation, ownerSessionId: lease.ownerLeaseId, toolId: 'fixture' };
            await supervisor.track(sender, owner);
            supervisor.createOwnerGuard(sender, owner).attachCleanup(cleanup);
        },
        input: (lease, action, extra = {}) => ({ version: 1, action, sessionId: lease.sessionId,
            ownerLeaseId: lease.ownerLeaseId, ownerControl: lease.ownerControl, ...extra }),
    };
}

test('renderer registry loss uses independently issued control, real native cleanup and the original recovery nonce', async t => {
    const f = await fixture(t), first = f.create();
    const lease = await first.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    assert.equal(lease.ok, true); let cleanupCount = 0;
    await f.attach(lease, async () => { cleanupCount++; });
    const replacement = f.create(); // Deliberately has no renderer owner registry/control cache.
    const active = await replacement.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId: randomUUID() }));
    assert.equal(active.errorCode, 'SUBAPP_OWNER_ACTIVE'); assert.equal(cleanupCount, 0);
    f.expire(); const requestId = randomUUID();
    const recovered = await replacement.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId: requestId }));
    assert.equal(recovered.ok, true); assert.equal(cleanupCount, 1);
    assert.notEqual(recovered.ownerLeaseId, lease.ownerLeaseId);
    replacement.ownerLeases.require(recovered.ownerLeaseId, 'chat');
    const replay = await replacement.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId: requestId }));
    assert.equal(replay.ownerLeaseId, recovered.ownerLeaseId);
    assert.deepEqual(replay.ownerControl, recovered.ownerControl); assert.equal(cleanupCount, 1);
    const inspection = await replacement.manageOwnerLease(f.input(recovered, 'inspect'));
    assert.equal(inspection.state, 'active'); assert.equal(inspection.ownerControl, undefined);
    assert.equal(f.actions.includes('dispose'), false);
});

test('independent active-owner proof restores only its original missing renderer registration', async t => {
    const f = await fixture(t), original = f.create();
    const lease = await original.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    const replacement = f.create();
    assert.throws(() => replacement.ownerLeases.require(lease.ownerLeaseId, 'chat'), { code: 'SUBAPP_OWNER_EXPIRED' });
    const inspected = await replacement.manageOwnerLease(f.input(lease, 'inspect'));
    assert.equal(inspected.ownerRestored, true); assert.equal(inspected.expiresAt, lease.expiresAt);
    assert.equal(inspected.state, 'active'); assert.equal(inspected.cleanup, 'unknown');
    assert.equal(inspected.ownerLeaseId, lease.ownerLeaseId); assert.equal(inspected.ownerControl, undefined);
    replacement.ownerLeases.require(lease.ownerLeaseId, 'chat');
    assert.equal(f.supervisor.agentOwners.size, 1);
    assert.equal(f.actions.includes('agent-retire'), false); assert.equal(f.actions.includes('agent-recover'), false);
});

test('pending native work or a newer active owner prevents historical registration readoption', async t => {
    const f = await fixture(t), original = f.create();
    const lease = await original.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    const cleanup = Promise.withResolvers();
    await f.attach(lease, async () => cleanup.promise);
    const replacement = f.create();
    const pending = await replacement.manageOwnerLease(f.input(lease, 'inspect'));
    assert.ok(pending.pendingRequests > 0); assert.equal(pending.ownerRestored, undefined); assert.equal(pending.expiresAt, undefined);
    assert.throws(() => replacement.ownerLeases.require(lease.ownerLeaseId, 'chat'), { code: 'SUBAPP_OWNER_EXPIRED' });
    const newer = await replacement.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    const stale = await replacement.manageOwnerLease(f.input(lease, 'inspect'));
    assert.equal(stale.errorCode, 'SUBAPP_OWNER_SUPERSEDED');
    replacement.ownerLeases.require(newer.ownerLeaseId, 'chat');
    cleanup.resolve();
});

test('an actual failed native cleanup is retried with original credentials rather than declared successful', async t => {
    const f = await fixture(t), service = f.create();
    const lease = await service.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    let broken = true, calls = 0;
    await f.attach(lease, async () => { calls++; if (broken) throw Error('transient native cleanup failure'); });
    f.expire(); const recoveryRequestId = randomUUID();
    const failed = await service.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId }));
    assert.equal(failed.ok, false); assert.equal(f.supervisor.agentOwners.size, 1);
    assert.equal((await service.manageOwnerLease(f.input(lease, 'inspect'))).cleanup, 'failed');
    broken = false;
    const recovered = await service.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId }));
    assert.equal(recovered.ok, true); assert.equal(f.supervisor.agentOwners.size, 2); assert.ok(calls >= 2);
});

test('unknown or wrong old controls cannot create an owner, and a late old guard close cannot retire the new owner', async t => {
    const f = await fixture(t), original = f.create();
    const lease = await original.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    const replacement = f.create(); f.expire();
    const unknown = await replacement.manageOwnerLease(f.input({ ...lease, ownerLeaseId: `owner-${randomUUID()}` }, 'recover', { recoveryRequestId: randomUUID() }));
    assert.equal(unknown.errorCode, 'SUBAPP_OWNER_CONTROL_INVALID'); assert.equal(f.supervisor.agentOwners.size, 1);
    const successor = await replacement.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId: randomUUID() }));
    assert.equal(successor.ok, true);
    await original.ownerGuard.close();
    assert.equal(f.supervisor.agentOwners.get(successor.ownerLeaseId).state, 'active');
    const renewed = await replacement.manageOwnerLease(f.input(successor, 'renew'));
    assert.equal(renewed.ok, true); assert.deepEqual(renewed.ownerControl, successor.ownerControl);
    const lateCancel = await replacement.manageOwnerLease(f.input(lease, 'cancel', { requestId: 'old-cancel' }));
    assert.equal(lateCancel.ok, false);
    replacement.ownerLeases.require(successor.ownerLeaseId, 'chat');
});

test('successor admission waits until an independently tracked native cleanup has really completed', async t => {
    const f = await fixture(t), original = f.create();
    const lease = await original.manageOwnerLease({ action: 'acquire', sessionId: 'chat' });
    const cleanup = Promise.withResolvers(); let calls = 0;
    await f.attach(lease, async () => { calls++; await cleanup.promise; });
    const replacement = f.create(); f.expire();
    const recovering = replacement.manageOwnerLease(f.input(lease, 'recover', { recoveryRequestId: randomUUID() }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.supervisor.agentOwners.size, 1);
    const inspection = await replacement.manageOwnerLease(f.input(lease, 'inspect'));
    assert.equal(inspection.state, 'retiring'); assert.ok(inspection.pendingRequests > 0);
    cleanup.resolve(); assert.equal((await recovering).ok, true); assert.equal(calls, 1);
});
