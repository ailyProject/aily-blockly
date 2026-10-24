const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');

const bridgeModule = loadBridge();
const lifecycle = {
  ownerRelease: { method: 'fixture.owner.release' },
  sessionRelease: { method: 'fixture.final.release' },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(t, options = {}) {
  const { SubappAgentBridgeService, replaceChildToolConfigs } = await bridgeModule;
  replaceChildToolConfigs([{
    id: 'fixture', namespace: 'FIXTURE', titleKey: 'Fixture',
    ...(options.processMessagePort || options.browserExecution ? { runtime: {
      ...(options.processMessagePort ? { processMessagePort: { transport: 'node-ipc-v1', maxMessageBytes: 4096 } } : {}),
      ...(options.browserExecution ? { browserExecution: { protocol: 'aily-browser-execution-v1' } } : {}),
    } } : {}),
    agent: { protocolVersion: 1, transport: 'aily-child-rpc', lifecycle: options.lifecycle ?? lifecycle, tools: [{
      name: 'fixture_tool', rpc: { method: 'fixture.work' }, supportsCancellation: true, presentation: options.presentation,
    }] },
  }]);
  const messages = [];
  const sockets = [];
  let acquired = 0;
  let released = 0;
  const activities = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      if (!options.manualOpen) queueMicrotask(() => this.open());
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(text) {
      const message = JSON.parse(text);
      messages.push(message);
      if (!options.hold?.(message)) queueMicrotask(() => this.reply(message));
    }
    reply(message, ok = true) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        id: message.id, ok, result: { method: message.method }, error: 'fixture cleanup failed',
      }) }));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  }
  const previous = global.WebSocket;
  const previousWindow = global.window;
  if (options.supervise) global.window = { electronAPI: { childToolSession: { superviseOwner: options.supervise,
    ...(options.bindProcess ? { browserExecution: options.bindProcess } : {}),
  } } };
  global.WebSocket = Socket;
  const service = new SubappAgentBridgeService({
    async acquire() { acquired++; await options.acquireBarrier?.promise; return { wsUrl: 'ws://fixture' }; },
    async release() { released++; await options.releaseBarrier?.promise; },
  }, options.automation || {}, {
    releaseSession(sessionId) { activities.push({ released: sessionId }); },
    recordRuntimeState(value) { activities.push(value); },
    recordInvocationStarted(value) { activities.push({ started: value }); },
    recordInvocationCompleted(value) { activities.push({ completed: value }); },
  }, options.webAgent ? { captureAgentRequest: () => options.webAgent } : null, 'native',
  options.webAgent ? { fixture: 'web' } : {}, options.webAgent ? { fixture: { load() {} } } : {});
  t.after(async () => {
    await service.ownerGuard.close().catch(() => undefined);
    service.ngOnDestroy(); global.WebSocket = previous; global.window = previousWindow;
  });
  return {
    service, messages, sockets, activities,
    acquire: sessionId => service.manageOwnerLease({ action: 'acquire', sessionId }),
    release: lease => service.manageOwnerLease({ action: 'release', ...lease }),
    execute: (lease, requestId = 'call-a') => service.execute({ toolId: 'fixture', tool: 'fixture_tool' }, undefined, {
      ownerLeaseId: lease.ownerLeaseId, sessionId: lease.sessionId, toolCallId: requestId,
    }),
    call: (owner, method = 'fixture.read', signal) => service.request('fixture', method, {}, 5000, true, signal, owner),
    get acquired() { return acquired; },
    get released() { return released; },
  };
}

test('each owner receives a generic callback; only the last owner releases the shared process', async t => {
  const h = await harness(t);
  await Promise.all([h.call('a'), h.call('b')]);
  assert.equal(h.acquired, 1);
  assert.deepEqual((await h.service.releaseSession('a')).retainedTools, ['fixture']);
  assert.equal(h.released, 0);
  assert.equal(h.messages.at(-1).context.sessionId, 'a');
  assert.equal(h.messages.at(-1).method, lifecycle.ownerRelease.method);
  await h.service.releaseSession('b');
  assert.deepEqual(h.messages.filter(item => item.method.includes('release')).map(item => item.method), [
    lifecycle.ownerRelease.method, lifecycle.ownerRelease.method, lifecycle.sessionRelease.method,
  ]);
  assert.equal(h.released, 1);
  const count = h.messages.length;
  await h.service.releaseSession('b');
  assert.equal(h.messages.length, count);
});

test('temporary Agent owners of process-message tools release only their Runtime lease', async t => {
  const h = await harness(t, { processMessagePort: true });
  const lease = await h.acquire('scene-agent');
  assert.equal((await h.execute(lease)).ok, true);
  assert.equal(h.acquired, 1);
  assert.equal((await h.release(lease)).ok, true);
  assert.equal(h.released, 1);
  assert.equal(h.service.channels.has('fixture'), false);
  // The workspace Provider is independent: this Agent bridge has no registry
  // or process-message listener to open, close or transfer during teardown.
  assert.equal(h.messages.filter(message => message.method === lifecycle.ownerRelease.method).length, 1);
});

test('legacy manifests keep final-only cleanup; unscoped callers keep the process', async t => {
  const h = await harness(t, { lifecycle: { sessionRelease: lifecycle.sessionRelease } });
  await Promise.all([h.call('a'), h.call('b')]);
  await h.service.releaseSession('a');
  assert.equal(h.messages.length, 2);
  await h.call('');
  await h.service.releaseSession('b');
  assert.equal(h.released, 0);
  assert.equal(h.messages.length, 3);
});

test('concurrent releases notify both owners before one final cleanup', async t => {
  const h = await harness(t);
  await Promise.all([h.call('a'), h.call('b')]);
  await Promise.all([h.service.releaseSession('a'), h.service.releaseSession('b')]);
  const cleanup = h.messages.filter(item => item.method.includes('release'));
  assert.deepEqual(cleanup.map(item => item.context.sessionId), ['a', 'b', undefined]);
  assert.equal(h.released, 1);
});

test('owner departure cancels only its pending request and never sends its delayed open', async t => {
  const h = await harness(t, { hold: item => item.method === 'fixture.wait' });
  await Promise.all([h.call('a'), h.call('b')]);
  const pending = h.call('a', 'fixture.wait');
  const rejected = assert.rejects(pending, { code: 'SUBAPP_RPC_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  await h.service.releaseSession('a');
  await rejected;
  assert.ok(h.messages.some(item => item.method === 'runtime.request.cancel'));
  await h.call('b');
  assert.equal(h.released, 0);
});

test('release while process acquisition is pending cannot send a late request or leak a process', async t => {
  const acquireBarrier = deferred();
  const h = await harness(t, { acquireBarrier });
  const pending = h.call('a', 'fixture.open');
  const rejected = assert.rejects(pending, { code: 'SUBAPP_RPC_CANCELLED' });
  await new Promise(resolve => setImmediate(resolve));
  const releasing = h.service.releaseSession('a');
  acquireBarrier.resolve();
  await Promise.all([releasing, rejected]);
  assert.ok(!h.messages.some(item => item.method === 'fixture.open'));
  assert.equal(h.released, 1);
});

test('a new owner waits for old cleanup, without being closed by it', async t => {
  const h = await harness(t, { hold: item => item.method === lifecycle.ownerRelease.method });
  await h.call('a');
  const releasing = h.service.releaseSession('a');
  await new Promise(resolve => setImmediate(resolve));
  const next = h.call('b', 'fixture.new-owner');
  assert.ok(!h.messages.some(item => item.method === 'fixture.new-owner'));
  h.sockets[0].reply(h.messages.at(-1));
  await Promise.all([releasing, next]);
  assert.equal(h.released, 0);
  assert.ok(!h.messages.some(item => item.method === lifecycle.sessionRelease.method));
  assert.equal(h.messages.at(-1).method, 'fixture.new-owner');
});

test('window presentation waits for the previous owner cleanup before opening', async t => {
  let opened = 0;
  const h = await harness(t, {
    hold: item => item.method === lifecycle.ownerRelease.method,
    presentation: { mode: 'window' },
    automation: {
      async isChildAppWindowOpen() { return false; },
      async openChildApp() { opened++; return { ok: true }; },
      async waitForChildAppHostReady() { return { ok: true }; },
    },
  });
  await h.call('old');
  const releasing = h.service.releaseSession('old');
  await new Promise(resolve => setImmediate(resolve));
  const lease = await h.acquire('new');
  const running = h.execute(lease);
  await new Promise(resolve => setImmediate(resolve));
  const openedBeforeCleanup = opened;
  h.sockets[0].reply(h.messages.at(-1));
  await releasing;
  assert.equal((await running).ok, true);
  assert.equal(openedBeforeCleanup, 0);
  assert.equal(opened, 1);
  assert.equal(h.acquired, 1);
  assert.equal(h.released, 0);
});

test('a new owner during final process release reacquires once and retains its channel', async t => {
  const releaseBarrier = deferred();
  const h = await harness(t, { releaseBarrier });
  await h.call('a');
  const releasing = h.service.releaseSession('a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.released, 1);
  const next = h.call('b');
  releaseBarrier.resolve();
  await Promise.all([releasing, next]);
  assert.equal(h.acquired, 2);
  assert.equal(h.service.channels.size, 1);
  assert.equal(h.service.channels.get('fixture').sessionIds.has('b'), true);
});

test('cleanup errors are reported but do not leak the final process lease', async t => {
  const h = await harness(t, { hold: item => item.method === lifecycle.ownerRelease.method });
  await h.call('a');
  const releasing = h.service.releaseSession('a');
  await new Promise(resolve => setImmediate(resolve));
  h.sockets[0].reply(h.messages.at(-1), false);
  const result = await releasing;
  assert.equal(result.ok, false);
  assert.equal(result.cleanupErrors[0].error, 'fixture cleanup failed');
  assert.equal(h.released, 1);
});

test('destroying the bridge during acquire releases the late process without reconnecting', async t => {
  const acquireBarrier = deferred();
  const h = await harness(t, { acquireBarrier });
  const pending = h.call('a');
  const rejected = assert.rejects(pending);
  await new Promise(resolve => setImmediate(resolve));
  h.service.ngOnDestroy();
  acquireBarrier.resolve();
  await rejected;
  assert.equal(h.acquired, 1);
  assert.equal(h.released, 1);
  assert.equal(h.sockets.length, 0);
});

test('host leases route opaque owner ids to Runtime while keeping logical ids in Activity', async t => {
  const h = await harness(t);
  const lease = await h.acquire('chat-a');
  assert.equal(lease.ok, true);
  assert.equal((await h.execute(lease)).ok, true);
  assert.equal(h.messages[0].context.sessionId, lease.ownerLeaseId);
  assert.equal(h.activities[0].started.sessionId, 'chat-a');
  await h.release(lease);
  assert.equal(h.messages.find(item => item.method === lifecycle.ownerRelease.method).context.sessionId, lease.ownerLeaseId);
  assert.ok(h.activities.some(item => item.released === 'chat-a'));
});

test('released and mismatched leases reject before starting UI, Runtime or Activity', async t => {
  const h = await harness(t);
  const lease = await h.acquire('chat-a');
  assert.equal((await h.execute({ ...lease, sessionId: 'chat-b' })).errorCode, 'SUBAPP_OWNER_MISMATCH');
  await h.release(lease);
  assert.equal((await h.execute(lease)).errorCode, 'SUBAPP_OWNER_EXPIRED');
  assert.equal(h.acquired, 0);
  assert.equal(h.activities.filter(item => item.started).length, 0);
});

test('close/reopen of the same logical session cannot inherit or revoke the new owner', async t => {
  const h = await harness(t, { hold: item => item.method === lifecycle.ownerRelease.method });
  const old = await h.acquire('chat-a');
  await h.execute(old);
  const closing = h.release(old);
  await new Promise(resolve => setImmediate(resolve));
  const next = await h.acquire('chat-a');
  assert.notEqual(next.ownerLeaseId, old.ownerLeaseId);
  const running = h.execute(next, 'call-b');
  assert.equal((await h.execute(old)).errorCode, 'SUBAPP_OWNER_EXPIRED');
  h.sockets[0].reply(h.messages.at(-1));
  await closing;
  assert.equal((await running).ok, true);
  assert.equal(h.released, 0);
  assert.ok(!h.activities.some(item => item.released === 'chat-a'));
  const finish = h.release(next);
  await new Promise(resolve => setImmediate(resolve));
  h.sockets[0].reply(h.messages.at(-1));
  await finish;
  assert.equal(h.released, 1);
});

test('cancel fences an early-arriving cancellation and aborts only the matching pending request', async t => {
  const h = await harness(t, { hold: item => item.method === 'fixture.work' });
  const lease = await h.acquire('chat-a');
  const cancel = requestId => h.service.manageOwnerLease({ action: 'cancel', ...lease, requestId });
  await cancel('early');
  assert.equal((await h.execute(lease, 'early')).errorCode, 'SUBAPP_RPC_CANCELLED');
  assert.equal(h.acquired, 0);
  const cancelled = h.execute(lease, 'cancelled');
  const retained = h.execute(lease, 'retained');
  await new Promise(resolve => setImmediate(resolve));
  await cancel('cancelled');
  assert.equal((await cancelled).errorCode, 'SUBAPP_RPC_CANCELLED');
  const pending = h.messages.filter(item => item.method === 'fixture.work').at(-1);
  h.sockets[0].reply(pending);
  assert.equal((await retained).ok, true);
  assert.equal(h.released, 0);
  await h.release(lease);
});

test('expired Agent owner is collected without releasing another live owner', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = await harness(t);
  const expired = await h.acquire('chat-a');
  const live = await h.acquire('chat-b');
  await Promise.all([h.execute(expired), h.execute(live)]);
  t.mock.timers.setTime(40_000);
  assert.equal((await h.service.manageOwnerLease({ action: 'renew', ...live })).ok, true);
  t.mock.timers.setTime(46_000);
  assert.equal((await h.execute(expired)).errorCode, 'SUBAPP_OWNER_EXPIRED');
  await h.service.ownerLeases.expire();
  assert.equal(h.released, 0);
  const releases = h.messages.filter(item => item.method === lifecycle.ownerRelease.method);
  assert.deepEqual(releases.map(item => item.context.sessionId), [expired.ownerLeaseId]);
  assert.equal((await h.execute(live, 'still-live')).ok, true);
  await h.release(live);
  assert.equal(h.released, 1);
});

test('expiry cancels a long-running call and final owner teardown releases its process', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const h = await harness(t, { hold: item => item.method === 'fixture.work' });
  const lease = await h.acquire('chat-a');
  const pending = h.execute(lease);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.setTime(46_000);
  await h.service.ownerLeases.expire();
  assert.equal((await pending).errorCode, 'SUBAPP_RPC_CANCELLED');
  assert.ok(h.messages.some(item => item.method === 'runtime.request.cancel'));
  assert.equal(h.released, 1);
  assert.equal((await h.service.manageOwnerLease({ action: 'renew', ...lease })).errorCode, 'SUBAPP_OWNER_EXPIRED');
});

test('concurrent release acknowledgements await the same Runtime cleanup', async t => {
  const h = await harness(t, { hold: item => item.method === lifecycle.ownerRelease.method });
  const lease = await h.acquire('chat-a');
  await h.execute(lease);
  let done = 0;
  const pending = Promise.all([h.release(lease), h.release(lease)].map(value => value.then(() => done++)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, 0);
  assert.equal(h.messages.filter(item => item.method === lifecycle.ownerRelease.method).length, 1);
  h.sockets[0].reply(h.messages.at(-1));
  await pending;
  assert.equal(done, 2);
  assert.equal(h.released, 1);
});

test('owner closure during presentation lookup never opens a late window or Runtime', async t => {
  const lookup = deferred();
  let opened = 0;
  const h = await harness(t, { presentation: { mode: 'window' }, automation: {
    isChildAppWindowOpen: () => lookup.promise,
    async openChildApp() { opened++; return { ok: true }; },
  } });
  const lease = await h.acquire('chat-a');
  const running = h.execute(lease);
  await h.release(lease);
  lookup.resolve(false);
  assert.equal((await running).errorCode, 'SUBAPP_RPC_CANCELLED');
  assert.equal(opened, 0);
  assert.equal(h.acquired, 0);
});

test('a lost Bridge socket still cleans its owner through the known endpoint without starting a process', async t => {
  const h = await harness(t, { lifecycle: { ownerRelease: lifecycle.ownerRelease } });
  const lease = await h.acquire('chat-a');
  await h.execute(lease);
  h.sockets[0].close();
  await new Promise(resolve => setImmediate(resolve));
  const result = await h.release(lease);
  assert.equal(result.ok, true);
  assert.equal(h.acquired, 1);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.messages.at(-1).context.sessionId, lease.ownerLeaseId);
  assert.equal(h.sockets[1].readyState, 3);
});

test('unacknowledged disconnected cleanup reports a failure and never respawns a Runtime', async t => {
  const h = await harness(t, {
    lifecycle: { ownerRelease: lifecycle.ownerRelease },
    hold: item => item.method === lifecycle.ownerRelease.method,
  });
  const lease = await h.acquire('chat-a');
  await h.execute(lease);
  h.sockets[0].close();
  await new Promise(resolve => setImmediate(resolve));
  const releasing = h.release(lease);
  await new Promise(resolve => setImmediate(resolve));
  h.sockets[1].close();
  const result = await releasing;
  assert.equal(result.ok, false);
  assert.match(result.cleanupErrors[0].error, /before acknowledgement/);
  assert.equal(h.acquired, 1);
});

test('main-process registration precedes domain RPC and handles normal owner release', async t => {
  const actions = [];
  let h;
  h = await harness(t, { lifecycle: { ownerRelease: lifecycle.ownerRelease }, supervise: async input => {
    actions.push(input.action);
    if (input.action === 'track') assert.equal(h.messages.length, 0);
    return { ok: true, generation: 'generation-a', handled: input.action === 'release',
      context: { leaseFile: 'fixture-owned-lease.json', actor: 'untrusted', sessionId: 'untrusted' } };
  } });
  await h.call('owner-a');
  await h.service.releaseSession('owner-a');
  assert.deepEqual(actions, ['connect', 'track', 'release']);
  assert.deepEqual(h.messages.map(message => message.method), ['fixture.read']);
  assert.equal(h.messages[0].context.leaseFile, 'fixture-owned-lease.json');
  assert.equal(h.messages[0].context.actor, 'agent');
  assert.equal(h.messages[0].context.sessionId, 'owner-a');
});

test('failed main-process binding blocks a domain RPC', async t => {
  const h = await harness(t, { supervise: async input => input.action === 'track'
    ? { ok: false, error: 'renderer expired', errorCode: 'SUBAPP_RENDERER_EXPIRED' }
    : { ok: true, generation: 'generation-a' } });
  await assert.rejects(h.call('owner-a'), { code: 'SUBAPP_RENDERER_EXPIRED' });
  assert.equal(h.messages.length, 0);
});

test('cancellation during main-process binding never sends a late domain RPC', async t => {
  const tracking = deferred();
  const entered = deferred();
  const h = await harness(t, { supervise: async input => {
    if (input.action === 'track') { entered.resolve(); await tracking.promise; }
    return { ok: true, generation: 'generation-a' };
  } });
  const controller = new AbortController();
  const result = assert.rejects(h.call('owner-a', 'fixture.read', controller.signal), { code: 'SUBAPP_RPC_CANCELLED' });
  await entered.promise;
  controller.abort();
  tracking.resolve();
  await result;
  assert.equal(h.messages.length, 0);
});

test('declared Browser package binds its real standard Agent owner before Node RPC without opening FullUI', async t => {
  const calls = [];
  const connection = { endpoint: { kind: 'browser-message-port', runtimeId: '12345678-1234-4234-8234-123456789abc' },
    connectionId: '87654321-4321-4321-8321-cba987654321' };
  const h = await harness(t, { browserExecution: true, processMessagePort: true,
    supervise: async input => { calls.push(input); return { ok: true, generation: 'real-main-generation' }; },
    bindProcess: async input => { assert.equal(calls.at(-1).action, 'track'); calls.push(input); return connection; },
    automation: { openChildApp() { assert.fail('Browser execution must start without FullUI'); } },
  });
  const lease = await h.acquire('browser-agent');
  assert.equal((await h.execute(lease)).ok, true);
  assert.deepEqual(calls.map(call => call.action), ['connect', 'track', 'bindProcess']);
  assert.equal(calls.at(-1).ownerSessionId, lease.ownerLeaseId);
  assert.equal(calls.at(-1).generation, 'real-main-generation');
  assert.deepEqual(h.messages[0].context.browserExecution, connection);
  assert.equal(h.messages[0].context.sessionId, lease.ownerLeaseId);
});

test('Browser binding failure never falls back to FullUI or sends an unbound Node domain request', async t => {
  const h = await harness(t, { browserExecution: true, supervise: async () => ({ ok: true, generation: 'generation' }),
    automation: { openChildApp() { assert.fail('No FullUI fallback'); } },
  });
  await assert.rejects(h.call('owner-a'), /Restart the host to enable Browser execution/);
  assert.equal(h.messages.length, 0);
});

test('request cancellation while Browser binding is held cannot send a late Node request', async t => {
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  const h = await harness(t, { browserExecution: true, supervise: async () => ({ ok: true, generation: 'generation' }),
    bindProcess: async () => { entered.resolve(); await gate.promise; return { endpoint: { kind: 'browser-message-port',
      runtimeId: '12345678-1234-4234-8234-123456789abc' }, connectionId: '87654321-4321-4321-8321-cba987654321' }; },
  });
  const cancelled = assert.rejects(h.call('owner-a', 'fixture.work', controller.signal), { code: 'SUBAPP_RPC_CANCELLED' });
  await entered.promise; controller.abort(); gate.resolve(); await cancelled;
  assert.equal(h.messages.length, 0);
});

test('FN owner requests retain unknown cleanup before release, after finish and through stop', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), a = requests.start('a', undefined, 'call-a');
  a.waitForCleanup('web-semantic'); a.finish('original cleanup-unconfirmed');
  const expected = [{ source: 'web-semantic', error: 'original cleanup-unconfirmed' }];
  assert.deepEqual(await requests.release('a'), expected); assert.equal(a.signal.aborted, true);
  a.finish(); // An ordinary Promise observation cannot upgrade the old unknown.
  requests.stop(); assert.deepEqual(await requests.release('a'), expected);
  const b = requests.start('b'); b.waitForCleanup();
  b.signal.addEventListener('abort', () => b.finish(), { once: true });
  assert.deepEqual(await requests.release('b'), []);
  assert.deepEqual(await requests.release('a'), expected);
});

test('FN concurrent owner release joins the held Web call and preserves its unconfirmed result', async t => {
  const entered = deferred(), terminal = deferred(); let calls = 0;
  const h = await harness(t, { webAgent: async (_method, _params, signal) => {
    calls++; entered.resolve(); await terminal.promise;
    assert.equal(signal.aborted, true);
    throw Object.assign(Error('original semantic cleanup-unconfirmed'), { code: 'cleanup-unconfirmed' });
  } });
  const owner = await h.acquire('chat-a'), running = h.execute(owner); await entered.promise;
  let finished = 0;
  const first = h.release(owner).then(value => { finished++; return value; });
  const second = h.release(owner).then(value => { finished++; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, 0);
  terminal.resolve(); assert.equal((await running).errorCode, 'cleanup-unconfirmed');
  const result = await first; assert.equal(result.ok, false); assert.deepEqual(await second, result);
  assert.deepEqual(result.cleanupErrors, [{ toolId: 'web-semantic', error: 'original semantic cleanup-unconfirmed' }]);
  assert.deepEqual(await h.release(owner), result); assert.equal(calls, 1);
  assert.equal((await h.execute(owner, 'late')).errorCode, 'SUBAPP_OWNER_EXPIRED');
  assert.equal(h.acquired, 0); assert.equal(h.sockets.length, 0);
});

test('FN completed Web observation failure remains visible to a later and repeated owner release', async t => {
  const h = await harness(t, { webAgent: async () => {
    throw Object.assign(Error('original early cleanup-unconfirmed'), { code: 'cleanup-unconfirmed' });
  } });
  const owner = await h.acquire('chat-a');
  assert.equal((await h.execute(owner)).errorCode, 'cleanup-unconfirmed');
  const result = await h.release(owner); assert.equal(result.ok, false);
  assert.deepEqual(result.cleanupErrors, [{ toolId: 'web-semantic', error: 'original early cleanup-unconfirmed' }]);
  assert.deepEqual(await h.release(owner), result);
  assert.equal(h.acquired, 0); assert.equal(h.sockets.length, 0);
});

test('FN a normally settled cancelled Web call releases only its owner after the original call joins', async t => {
  const entered = deferred(), cancelled = deferred(), terminal = deferred();
  const h = await harness(t, { webAgent: async (_method, _params, signal, _timeout, context) => {
    if (context.toolCallId === 'other-owner') return { ready: true };
    entered.resolve(); signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    await terminal.promise; return { acknowledged: true };
  } });
  const a = await h.acquire('chat-a'), b = await h.acquire('chat-b'), running = h.execute(a);
  await entered.promise;
  let released = false; const releasing = h.release(a).then(value => { released = true; return value; });
  await cancelled.promise; await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false);
  assert.equal((await h.execute(b, 'other-owner')).ok, true);
  terminal.resolve(); assert.equal((await running).errorCode, 'SUBAPP_RPC_CANCELLED');
  assert.equal((await releasing).ok, true); assert.equal((await h.release(b)).ok, true);
  assert.equal(h.acquired, 0); assert.equal(h.sockets.length, 0);
});

test('FN unconfirmed release records remain within the existing 256 owner responsibility budget after stop', async () => {
  const { SubappAgentOwnerLeases } = await bridgeModule;
  const owners = new SubappAgentOwnerLeases(async () => ({ ok: false, error: 'original unknown' }));
  const leases = Array.from({ length: 256 }, (_, index) => owners.acquire('chat-' + index));
  assert.throws(() => owners.acquire('overflow'), { code: 'SUBAPP_OWNER_LIMIT' });
  for (const lease of leases) assert.equal((await owners.release(lease.ownerLeaseId, lease.sessionId)).ok, false);
  assert.throws(() => owners.acquire('unknown-overflow'), { code: 'SUBAPP_OWNER_LIMIT' });
  owners.stop(); assert.throws(() => owners.acquire('after-stop'), { code: 'SUBAPP_OWNER_LIMIT' });
  assert.equal((await owners.release(leases[0].ownerLeaseId)).ok, false);
});

test('FN a rejected release callback stays rejected and concurrent callers share the original promise', async () => {
  const { SubappAgentOwnerLeases } = await bridgeModule;
  const entered = deferred(), terminal = deferred(), original = Error('original release rejection'); let calls = 0;
  const owners = new SubappAgentOwnerLeases(async () => { calls++; entered.resolve(); await terminal.promise; throw original; });
  const owner = owners.acquire('chat-a'), first = owners.release(owner.ownerLeaseId), rejected = assert.rejects(first, error => error === original);
  await entered.promise; assert.equal(owners.release(owner.ownerLeaseId), first);
  terminal.resolve(); await rejected; owners.stop();
  assert.equal(owners.release(owner.ownerLeaseId), first);
  await assert.rejects(owners.release(owner.ownerLeaseId), error => error === original); assert.equal(calls, 1);
});

test('FN stopping an active owner revokes admission and keeps its original unknown cleanup for release', async () => {
  const { SubappOwnerRequests, SubappAgentOwnerLeases } = await bridgeModule;
  const requests = new SubappOwnerRequests();
  const owners = new SubappAgentOwnerLeases(async lease => {
    const errors = await requests.release(lease.ownerLeaseId); return { ok: !errors.length, errors };
  });
  const lease = owners.acquire('chat-a'), request = requests.start(lease.ownerLeaseId, undefined, 'call-a');
  request.waitForCleanup('web-semantic'); request.finish('original before-stop cleanup-unconfirmed');
  owners.stop(); assert.throws(() => owners.require(lease.ownerLeaseId, lease.sessionId), { code: 'SUBAPP_OWNER_EXPIRED' });
  const result = await owners.release(lease.ownerLeaseId, lease.sessionId); assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ source: 'web-semantic', error: 'original before-stop cleanup-unconfirmed' }]);
  assert.deepEqual(await owners.release(lease.ownerLeaseId, lease.sessionId), result);
});

test('FN a foreign session cannot join pending or retained failed owner cleanup', async () => {
  const { SubappAgentOwnerLeases } = await bridgeModule;
  const terminal = deferred(); let calls = 0;
  const owners = new SubappAgentOwnerLeases(async () => { calls++; await terminal.promise; return { ok: false, error: 'private original unknown' }; });
  const lease = owners.acquire('chat-a'), cleanup = owners.release(lease.ownerLeaseId, lease.sessionId);
  await assert.rejects(owners.release(lease.ownerLeaseId, 'chat-b'), { code: 'SUBAPP_OWNER_MISMATCH' });
  assert.equal(owners.release(lease.ownerLeaseId, 'chat-a'), cleanup);
  terminal.resolve(); assert.equal((await cleanup).ok, false);
  await assert.rejects(owners.release(lease.ownerLeaseId, 'chat-b'), { code: 'SUBAPP_OWNER_MISMATCH' });
  assert.equal(owners.release(lease.ownerLeaseId, 'chat-a'), cleanup); assert.equal(calls, 1); owners.stop();
});

test('GB01 single request cancellation waits for its joined original terminal', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), call = requests.start('owner-a', undefined, 'call-a');
  call.waitForCleanup('web-semantic');
  let settled = false;
  const cancelling = requests.cancel('owner-a', 'call-a').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(call.signal.aborted, true); assert.equal(settled, false);
  call.finish();
  assert.deepEqual(await cancelling, { schemaVersion: 1, requestId: 'call-a', terminalReceived: true,
    cleanupConfirmed: true, source: 'web-semantic', reason: 'cleanup-acknowledged' });
  assert.deepEqual(await requests.release('owner-a'), []);
});

test('GB01 failed request cleanup is a negative receipt and retains release responsibility', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), call = requests.start('owner-a', undefined, 'call-a');
  call.waitForCleanup('native-batch');
  const cancelling = requests.cancel('owner-a', 'call-a');
  call.finish('original cleanup remains unconfirmed');
  assert.deepEqual(await cancelling, { schemaVersion: 1, requestId: 'call-a', terminalReceived: true,
    cleanupConfirmed: false, source: 'native-batch', reason: 'cleanup-failed' });
  const failures = [{ source: 'native-batch', error: 'original cleanup remains unconfirmed' }];
  assert.deepEqual(await requests.release('owner-a'), failures);
  assert.deepEqual(await requests.release('owner-a'), failures);
});

test('GB01 cancellation observer timeout does not retire the original task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), call = requests.start('owner-a', undefined, 'call-a');
  call.waitForCleanup('web-semantic');
  let cancelled = false, released = false;
  const cancelling = requests.cancel('owner-a', 'call-a').then(value => { cancelled = true; return value; });
  t.mock.timers.tick(2999); await Promise.resolve(); assert.equal(cancelled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await cancelling, { schemaVersion: 1, requestId: 'call-a', terminalReceived: false,
    cleanupConfirmed: false, source: 'web-semantic', reason: 'cleanup-timeout' });
  const releasing = requests.release('owner-a').then(value => { released = true; return value; });
  await Promise.resolve(); assert.equal(released, false);
  call.finish(); assert.deepEqual(await releasing, []); assert.equal(released, true);
});

test('GB01 request cleanup receipt cannot cancel or join another owner or request', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests();
  const a = requests.start('owner-a', undefined, 'call-a'), otherCall = requests.start('owner-a', undefined, 'call-b');
  const otherOwner = requests.start('owner-b', undefined, 'call-a');
  a.waitForCleanup('web-semantic'); otherCall.waitForCleanup('web-semantic'); otherOwner.waitForCleanup('web-semantic');
  const cancelling = requests.cancel('owner-a', 'call-a');
  assert.equal(a.signal.aborted, true); assert.equal(otherCall.signal.aborted, false); assert.equal(otherOwner.signal.aborted, false);
  a.finish(); assert.equal((await cancelling).cleanupConfirmed, true);
  assert.equal(otherCall.signal.aborted, false); assert.equal(otherOwner.signal.aborted, false);
  otherCall.finish(); otherOwner.finish();
  assert.deepEqual(await requests.release('owner-a'), []); assert.deepEqual(await requests.release('owner-b'), []);
});

test('GB01 unknown and already-retired requests never become cleanup ACKs', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests();
  const expected = { schemaVersion: 1, requestId: 'call-a', terminalReceived: false,
    cleanupConfirmed: false, source: null, reason: 'request-not-observed' };
  assert.deepEqual(await requests.cancel('owner-a', 'call-a'), expected);
  const call = requests.start('owner-a', undefined, 'call-a'); call.waitForCleanup('web-semantic'); call.finish();
  assert.deepEqual(await requests.cancel('owner-a', 'call-a'), expected);
});

test('GB01 ambiguous request IDs are cancelled without assigning a false terminal ACK', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), a = requests.start('owner-a', undefined, 'same');
  const b = requests.start('owner-a', undefined, 'same');
  a.waitForCleanup('web-semantic'); b.waitForCleanup('web-semantic');
  assert.deepEqual(await requests.cancel('owner-a', 'same'), { schemaVersion: 1, requestId: 'same', terminalReceived: false,
    cleanupConfirmed: false, source: null, reason: 'request-ambiguous' });
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, true); a.finish(); b.finish();
});

test('GB01 an ordinary nonjoined invocation terminal cannot acknowledge resource cleanup', async () => {
  const { SubappOwnerRequests } = await bridgeModule;
  const requests = new SubappOwnerRequests(), call = requests.start('owner-a', undefined, 'call-a');
  const cancelling = requests.cancel('owner-a', 'call-a'); call.finish();
  assert.deepEqual(await cancelling, { schemaVersion: 1, requestId: 'call-a', terminalReceived: true,
    cleanupConfirmed: false, source: 'none', reason: 'cleanup-not-joined' });
});

test('GB01 public owner cancellation separates acceptance from exact joined Web cleanup', async t => {
  const entered = deferred(), cancelled = deferred(), terminal = deferred();
  const h = await harness(t, { webAgent: async (_method, _params, signal) => {
    entered.resolve(); signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    await cancelled.promise; await terminal.promise; signal.throwIfAborted();
  } });
  const owner = await h.acquire('chat-a'), running = h.execute(owner, 'exact-call'); await entered.promise;
  let cleanupAcknowledged = false;
  const cancelling = h.service.manageOwnerLease({ action: 'cancel', ...owner, requestId: 'exact-call' })
    .then(value => { cleanupAcknowledged = true; return value; });
  await cancelled.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanupAcknowledged, false); assert.equal(h.released, 0);
  terminal.resolve(); assert.equal((await running).errorCode, 'SUBAPP_RPC_CANCELLED');
  assert.deepEqual(await cancelling, { ok: true, cancelled: true, cleanup: { schemaVersion: 1,
    requestId: 'exact-call', terminalReceived: true, cleanupConfirmed: true, source: 'web-semantic', reason: 'cleanup-acknowledged' } });
  assert.equal((await h.service.manageOwnerLease({ action: 'renew', ...owner })).ok, true);
  assert.equal(h.released, 0); assert.equal((await h.release(owner)).ok, true);
});

test('GB01 public owner cancellation never hides joined Web cleanup failure', async t => {
  const entered = deferred(), cancelled = deferred(), terminal = deferred();
  const h = await harness(t, { webAgent: async (_method, _params, signal) => {
    entered.resolve(); signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    await cancelled.promise; await terminal.promise;
    throw Object.assign(new Error('original cleanup is unconfirmed'), { code: 'cleanup-unconfirmed' });
  } });
  const owner = await h.acquire('chat-a'), running = h.execute(owner, 'exact-call'); await entered.promise;
  const cancelling = h.service.manageOwnerLease({ action: 'cancel', ...owner, requestId: 'exact-call' });
  await cancelled.promise; terminal.resolve(); assert.equal((await running).errorCode, 'cleanup-unconfirmed');
  assert.deepEqual(await cancelling, { ok: true, cancelled: true, cleanup: { schemaVersion: 1,
    requestId: 'exact-call', terminalReceived: true, cleanupConfirmed: false, source: 'web-semantic', reason: 'cleanup-failed' } });
  const release = await h.release(owner); assert.equal(release.ok, false);
  assert.deepEqual(await h.release(owner), release);
});

async function loadBridge() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service.ts';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
        "export { SubappOwnerRequests } from './src/app/services/integrations/subapps/models/subapp-owner-requests.ts';",
        "export { SubappAgentOwnerLeases } from './src/app/services/integrations/subapps/models/subapp-agent-owner-leases.ts';",
      ].join('\n'),
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'angular-decorator-stub', setup(build) {
      build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const Injectable = () => target => target; export const Inject = () => () => {}; export const Optional = () => () => {}; export class InjectionToken {}',
        loader: 'js',
      }));
    } }],
  });
  const record = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, record, record.exports);
  return record.exports;
}
