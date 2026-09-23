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
  if (options.supervise) global.window = { electronAPI: { childToolSession: { superviseOwner: options.supervise } } };
  global.WebSocket = Socket;
  const service = new SubappAgentBridgeService({
    async acquire() { acquired++; await options.acquireBarrier?.promise; return { wsUrl: 'ws://fixture' }; },
    async release() { released++; await options.releaseBarrier?.promise; },
  }, options.automation || {}, {
    releaseSession(sessionId) { activities.push({ released: sessionId }); },
    recordRuntimeState(value) { activities.push(value); },
    recordInvocationStarted(value) { activities.push({ started: value }); },
    recordInvocationCompleted(value) { activities.push({ completed: value }); },
  });
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

async function loadBridge() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service.ts';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
      ].join('\n'),
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'angular-decorator-stub', setup(build) {
      build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: 'export const Injectable = () => target => target; export const Inject = () => () => {}; export class InjectionToken {}',
        loader: 'js',
      }));
    } }],
  });
  const record = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, record, record.exports);
  return record.exports;
}
