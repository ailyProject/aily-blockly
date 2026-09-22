'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SubappOwnerSupervisor, registerSubappOwnerSupervisor } = require('./subapp-owner-supervisor');

function contents(id = 1) { return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }); }
function harness(send = async () => {}) {
    const runtime = { streamId: 'runtime-1', hostInfo: { wsUrl: 'ws://127.0.0.1:4000/ws?token=secret',
        runtimeConfig: { agent: { lifecycle: { ownerRelease: { method: 'fixture.release', timeoutMs: 5000 } } } } } };
    const calls = [];
    const errors = [];
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime,
        send: async binding => { calls.push(binding); await send(binding); }, onError: (...args) => errors.push(args) });
    const renderer = contents();
    const generation = supervisor.connect(renderer).generation;
    const binding = (ownerSessionId = 'owner-a', toolId = 'fixture') => ({ generation, ownerSessionId, toolId });
    return { supervisor, renderer, runtime, calls, errors, binding };
}

test('process lease is acknowledged before tools, revoked before cleanup, and shared by concurrent tracking', async () => {
    const fs = require('node:fs');
    const pending = Promise.withResolvers();
    const h = harness(async binding => {
        if (binding.method === 'fixture.lease') {
            assert.equal(fs.existsSync(binding.params.leaseFile), true);
            await pending.promise;
        } else assert.equal(fs.existsSync(binding.processLease.leaseFile), false);
    });
    h.runtime.hostInfo.runtimeConfig.agent.lifecycle.ownerLease = { method: 'fixture.lease', protocol: 'process-file-v1' };
    const a = h.supervisor.track(h.renderer, h.binding());
    const b = h.supervisor.track(h.renderer, h.binding());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1);
    const lease = h.calls[0].params;
    assert.equal(JSON.parse(fs.readFileSync(lease.leaseFile)).ownerPid, process.pid);
    pending.resolve();
    assert.deepEqual((await a).context, { leaseFile: lease.leaseFile });
    assert.deepEqual(await a, await b);
    await h.supervisor.release(h.renderer, h.binding());
    assert.equal(h.calls.length, 2);
});

test('renderer death during lease acquisition cannot acknowledge or resurrect a stale binding', async () => {
    const fs = require('node:fs');
    const pending = Promise.withResolvers();
    const h = harness(binding => binding.method === 'fixture.lease' ? pending.promise : undefined);
    h.runtime.hostInfo.runtimeConfig.agent.lifecycle.ownerLease = { method: 'fixture.lease', protocol: 'process-file-v1' };
    const tracking = h.supervisor.track(h.renderer, h.binding());
    const rejected = assert.rejects(tracking, { code: 'SUBAPP_RENDERER_EXPIRED' });
    await new Promise(resolve => setImmediate(resolve));
    const file = h.calls[0].params.leaseFile;
    const invalidating = h.supervisor.invalidate(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.existsSync(file), false);
    pending.resolve();
    await Promise.all([rejected, invalidating]);
    assert.equal(h.calls.filter(call => call.method === 'fixture.release').length, 1);
});

test('binding is idempotent, callback comes from the registered manifest, not renderer input', async () => {
    const h = harness();
    const input = { ...h.binding(), wsUrl: 'ws://attacker', method: 'delete.all' };
    await h.supervisor.track(h.renderer, input);
    await h.supervisor.track(h.renderer, input);
    await h.supervisor.release(h.renderer, input);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, 'fixture.release');
    assert.match(h.calls[0].wsUrl, /127\.0\.0\.1/);
    assert.equal((await h.supervisor.release(h.renderer, input)).handled, false);
});

test('normal release only touches the requested owner and tool', async () => {
    const h = harness();
    for (const value of [h.binding(), h.binding('owner-b'), h.binding('owner-a', 'other')]) await h.supervisor.track(h.renderer, value);
    await h.supervisor.release(h.renderer, h.binding());
    assert.equal(h.calls.length, 1);
    assert.equal(h.supervisor.renderers.get(1).bindings.size, 2);
});

test('native owner guard requires acknowledgement and pins owner/runtime/generation', async () => {
    const h = harness();
    assert.throws(() => h.supervisor.createOwnerGuard(h.renderer, h.binding()), { code: 'SUBAPP_OWNER_EXPIRED' });
    await h.supervisor.track(h.renderer, h.binding());
    const guard = h.supervisor.createOwnerGuard(h.renderer, h.binding()); guard();
    assert.throws(() => h.supervisor.createOwnerGuard(h.renderer, h.binding('other')), { code: 'SUBAPP_OWNER_EXPIRED' });
    h.runtime.streamId = 'replaced-runtime'; assert.throws(guard, { code: 'SUBAPP_OWNER_EXPIRED' });
    h.runtime.streamId = 'runtime-1'; guard();
    await h.supervisor.release(h.renderer, h.binding()); assert.throws(guard, { code: 'SUBAPP_OWNER_EXPIRED' });
});

test('native Runtime cleanup joins registered callbacks without sending public owner RPC', async () => {
    const h = harness(); h.runtime.nativeOwnerControl = true;
    delete h.runtime.hostInfo.runtimeConfig;
    await h.supervisor.track(h.renderer, h.binding());
    const guard = h.supervisor.createOwnerGuard(h.renderer, h.binding());
    const pending = Promise.withResolvers(); let finished = false, attempts = 0;
    guard.attachCleanup(async () => { attempts++; await pending.promise; finished = true; });
    const release = h.supervisor.release(h.renderer, h.binding());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false); assert.throws(guard, { code: 'SUBAPP_OWNER_EXPIRED' });
    pending.resolve(); assert.equal((await release).ok, true);
    assert.equal(attempts, 1); assert.equal(finished, true); assert.deepEqual(h.calls, []);
});

test('native cleanup failure remains retryable and cannot be hidden by a successful sibling', async () => {
    const h = harness(); h.runtime.nativeOwnerControl = true;
    await h.supervisor.track(h.renderer, h.binding());
    const guard = h.supervisor.createOwnerGuard(h.renderer, h.binding()); let attempts = 0, sibling = 0;
    guard.attachCleanup(async () => { if (++attempts < 2) throw new Error('unconfirmed'); });
    guard.attachCleanup(async () => { sibling++; });
    assert.equal((await h.supervisor.release(h.renderer, h.binding())).ok, false);
    assert.equal((await h.supervisor.release(h.renderer, h.binding())).ok, true);
    assert.equal(attempts, 2); assert.equal(sibling, 1); assert.deepEqual(h.calls, []);
});

test('renderer crash releases all its bindings but not another renderer, and fences late IPC', async () => {
    const h = harness();
    await h.supervisor.track(h.renderer, h.binding());
    const other = contents(2);
    const generation = h.supervisor.connect(other).generation;
    await h.supervisor.track(other, { ...h.binding('owner-b'), generation });
    h.renderer.emit('render-process-gone');
    await h.supervisor.idle();
    assert.deepEqual(h.calls.map(call => call.ownerSessionId), ['owner-a']);
    assert.equal(h.supervisor.renderers.get(2).bindings.size, 1);
    await assert.rejects(h.supervisor.track(h.renderer, h.binding()), { code: 'SUBAPP_RENDERER_EXPIRED' });
});

test('same-document/subframe navigation does not revoke resources; reload starts a new generation', async () => {
    const h = harness();
    await h.supervisor.track(h.renderer, h.binding());
    h.renderer.emit('did-start-navigation', {}, 'url#fragment', true, true);
    h.renderer.emit('did-start-navigation', {}, 'iframe', false, false);
    assert.equal(h.supervisor.connect(h.renderer).generation, h.binding().generation);
    h.renderer.emit('did-start-navigation', {}, 'reload', false, true);
    const next = h.supervisor.connect(h.renderer).generation;
    await h.supervisor.track(h.renderer, { ...h.binding('owner-new'), generation: next });
    await h.supervisor.idle();
    assert.notEqual(next, h.binding().generation);
    assert.equal(h.supervisor.renderers.get(1).bindings.size, 1);
    assert.deepEqual(h.calls.map(call => call.ownerSessionId), ['owner-a']);
});

test('concurrent release and crash join the same in-flight cleanup', async () => {
    const pending = Promise.withResolvers();
    const h = harness(() => pending.promise);
    await h.supervisor.track(h.renderer, h.binding());
    const releases = [h.supervisor.release(h.renderer, h.binding()), h.supervisor.invalidate(1)];
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1);
    pending.resolve();
    await Promise.all(releases);
    assert.equal(h.calls.length, 1);
});

test('failed normal cleanup remains eligible for bounded crash retries', async () => {
    let attempts = 0;
    const h = harness(async () => { if (++attempts < 3) throw new Error('offline'); });
    await h.supervisor.track(h.renderer, h.binding());
    assert.equal((await h.supervisor.release(h.renderer, h.binding())).ok, false);
    assert.equal(h.supervisor.renderers.get(1).bindings.size, 1);
    await h.supervisor.invalidate(1);
    assert.equal(attempts, 3);
    assert.deepEqual(h.errors, []);
});

test('unreachable Runtime is never launched and failure diagnostics omit endpoint tokens', async () => {
    const h = harness(async () => { throw new Error('offline'); });
    await h.supervisor.track(h.renderer, h.binding());
    await h.supervisor.invalidate(1);
    assert.equal(h.calls.length, 3);
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(JSON.stringify(h.errors), /secret|ws:\/\//);
});

test('IPC validates sender generation and rejects an unowned or non-local runtime', async () => {
    const h = harness();
    let invoke;
    registerSubappOwnerSupervisor({ handle: (_name, handler) => { invoke = handler; } }, h.supervisor);
    const event = { sender: h.renderer };
    assert.equal((await invoke(event, { action: 'track', ...h.binding(), generation: 'old' })).errorCode, 'SUBAPP_RENDERER_EXPIRED');
    h.runtime.hostInfo.wsUrl = 'ws://example.com/ws';
    assert.equal((await invoke(event, { action: 'track', ...h.binding() })).ok, false);
    h.supervisor.resolveRuntime = () => null;
    assert.equal((await invoke(event, { action: 'track', ...h.binding() })).ok, false);
    assert.equal((await invoke({ ...event, senderFrame: {} }, { action: 'connect' })).ok, false);
});
