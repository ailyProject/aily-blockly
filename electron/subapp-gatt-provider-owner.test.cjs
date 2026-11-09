'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { MessageChannel } = require('node:worker_threads');
const { createMainGattProviderOwner } = require('./subapp-gatt-provider-owner');
// The integration job supplies the actual separately built Simulator entry.
// This task's immutable module is the local default; no fake provider fallback.
const api = require(process.env.AILY_GATT_TEST_PROVIDER_MODULE ||
  '/Volumes/data/aily-work/work/w8-gatt-message-port-20261108-a01/main-module-a01/local-gatt-backend.cjs');
const deferred = () => Promise.withResolvers();
const turn = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await turn(); } assert.fail('Original in-memory owner did not reach the expected boundary'); }
async function untilImmediate(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('Original in-memory owner did not reach the expected boundary'); }
function context() {
  const scope = { worldId: 'world-original', nodeId: 'node-original', clockDomainId: 'clock-original' };
  return { schemaVersion: 1, kind: 'aily-session-bluetooth-context', sessionId: 'session-original', sceneRevision: 'a'.repeat(64),
    runtimeGeneration: 2, runtimeTimeEpoch: 4, sessionState: 'running', unavailableReason: null,
    bluetooth: { descriptor: { schemaVersion: 1, kind: 'aily-bluetooth-controller-port', scope, profileId: 'actual-runtime',
      executionId: 'actual-execution', framing: 'hci-h4-v1', controllerModes: ['le'], aclDataPacketBytes: 251,
      limits: { maxBufferedPackets: 4, maxBufferedBytes: 4096, maxReadPackets: 4, maxReadBytes: 4096, maxPendingWrites: 2 } },
    snapshot: { schemaVersion: 1, kind: 'aily-bluetooth-controller-snapshot', scope, generation: 3, timeEpoch: 4, connectionEpoch: 5,
      state: 'open', readSequence: 0, writeSequence: 0, readBufferedPackets: 0, readBufferedBytes: 0,
      writeQueueCreditPackets: 2, writeQueueCreditBytes: 4096, pendingWrites: 0, droppedPackets: 0, droppedBytes: 0 } } };
}

/** Real shared Node provider/ledger/transport and linked MessagePorts. Only the
 * installed holders, Native I/O and parent dialog decision are memory ports. */
function fixture(t, { idleTimeoutMs = 30000 } = {}) {
  const calls = [], callbacks = new Set(), ports = [], gates = [], attachments = new Map(), peers = [], notifications = [];
  const h = { controllerCurrent: true, ownerCurrent: true, noOwner: false, context: context(), providerLoad: null,
    nativeDisposeFailure: false, nativeHolderFailure: false, providerHolderFailure: false, peerCloseFailure: false,
    attachGate: null, attachThrows: false, detachJoinsAttach: true, detachGate: null, peerCloseGate: null, selectResultGate: null, dialogHook: null, writeHook: null,
    now: Date.now(), clientTimeoutMs: 80, reads: 0, writes: [], innerAuthorities: [], retireCallbacks: [], retireEvents: [],
    retired: [], states: [], nodeRequests: [], nodeResults: [], nativeConstructed: 0, nativeDisposed: 0, scans: 0, driverDisposed: 0,
    providerHolderReleased: 0, nativeHolderReleased: 0, selectionReleases: 0 };
  const authority = Object.freeze({ senderId: 7, toolId: 'simulator', streamId: 'original-stream', bindingId: 'workspace:original' });
  const main = { isDestroyed: () => false };
  class MainPort extends EventEmitter {
    constructor(raw) { super(); this.raw = raw; this.closed = false; ports.push(this);
      raw.on('message', data => this.emit('message', { data, ports: [] }));
      raw.on('messageerror', error => this.emit('messageerror', error)); raw.on('close', () => this.emit('close')); }
    postMessage(value) { this.raw.postMessage(value); }
    start() { this.raw.start(); }
    close() { this.closed = true; this.raw.close(); }
  }
  class MainChannel { constructor() { const pair = new MessageChannel(); this.port1 = new MainPort(pair.port1); this.port2 = new MainPort(pair.port2); } }
  const nativeModule = { createHostGattNativeBackend() {
    h.nativeConstructed++; let ended = false; const selections = new WeakMap(), drivers = new Set();
    return {
      scan(input, signal) {
        assert.equal(ended, false); assert.equal(input.durationMs, 5000); assert.equal(input.maxCandidates, 16); h.scans++;
        let stopped = false, selected = false;
        return { ready: Promise.resolve(), async close() { calls.push('scan-close'); stopped = true; },
          snapshot() { assert(stopped); return { state: 'stopped', candidates: [{ candidateId: 'opaque-candidate', label: 'Controlled BLE peer', rssi: -50 }] }; },
          select(candidateId) { assert(stopped); assert(!selected); assert.equal(candidateId, 'opaque-candidate'); assert(!signal.aborted); selected = true;
            const value = Object.freeze({ peerId: `opaque-peer-${h.scans}` }); selections.set(value, { consumed: false, released: false }); return value; } };
      },
      releaseSelection(selected) { const entry = selections.get(selected); if (entry && !entry.consumed && !entry.released) { entry.released = true; h.selectionReleases++; } },
      createDriver(selected) {
        const entry = selections.get(selected); assert(entry && !entry.consumed && !entry.released && !ended); entry.consumed = true;
        let disposed = false; const ownPeers = [];
        const driver = { async open(peerId, observer) {
          assert.equal(peerId, selected.peerId); assert(!disposed && !ended);
          const peer = { closed: false, observer,
            async discover() { return [{ serviceId: 'service', uuid: '9c36a100-6d62-4d6f-a000-001122334455', characteristics: [
              { characteristicId: 'characteristic', uuid: '9c36a101-6d62-4d6f-a000-001122334455', properties: ['read', 'write-with-response', 'write-without-response', 'notify'] }] }]; },
            async read() { h.reads++; return Uint8Array.of(0, 255, 3); },
            async write(id, mode, bytes) { h.writes.push([...bytes]); await h.writeHook?.(); return { acceptedBytes: bytes.length, completion: mode === 'with-response' ? 'peer-acknowledged' : 'queued' }; },
            async subscribe(id, mode, receive) { const sub = { receive, closed: false, async close() { sub.closed = true; } }; notifications.push(sub); return sub; },
            async close() { if (peer.closed) return; calls.push('peer-close'); if (h.peerCloseFailure) throw Error('Original physical disconnect is unknown'); await h.peerCloseGate?.promise; peer.closed = true; } };
          ownPeers.push(peer); peers.push(peer); return peer;
        }, async dispose() { if (disposed) return; await Promise.all(ownPeers.map(peer => peer.close())); disposed = true; h.driverDisposed++; drivers.delete(driver); } };
        drivers.add(driver); return driver;
      },
      async dispose() { if (ended) return; calls.push('native-dispose'); if (h.nativeDisposeFailure) throw Error('Original Native manager cleanup is unknown');
        await Promise.all([...drivers].map(driver => driver.dispose())); ended = true; h.nativeDisposed++; },
    };
  } };
  const control = {
    requireCurrent() { if (!h.ownerCurrent) throw Error('Original private execution owner ended'); },
    async query() { calls.push('query-original'); return structuredClone(h.context); },
    async attach(input, remote) {
      calls.push(['runtime-attach', input.grant.grantId]);
      const backend = api.createHostGattMessagePortBackend({ port: remote.raw, descriptor: input.descriptor, grant: input.grant, timeoutMs: h.clientTimeoutMs });
      const original = { input, backend, attaching: h.attachGate?.promise ?? Promise.resolve() }; attachments.set(input.grant.grantId, original);
      await original.attaching; if (h.attachThrows) throw Error('Original attach ACK lost');
    },
    async detach(sessionId, grantId) {
      calls.push(['runtime-detach', sessionId, grantId]); const original = attachments.get(grantId);
      if (!original) return; assert.equal(sessionId, original.input.sessionId);
      await original.backend.dispose(); if (h.detachJoinsAttach) await original.attaching; await h.detachGate?.promise;
      if (attachments.get(grantId) === original) attachments.delete(grantId);
    },
    registerOwnerRelease(callback) { callbacks.add(callback); return () => { calls.push('owner-unsubscribe'); callbacks.delete(callback); }; },
  };
  const module = { ...api, createNodeHostGattProvider(options) { const provider = api.createNodeHostGattProvider({ ...options, now: () => h.now });
    return { ...provider, bind(input) { h.innerAuthorities.push({ ...input.authority }); h.retireCallbacks.push(input.onGrantRetiring);
      const observed = typeof input.onGrantRetiring === 'function' ? { ...input, onGrantRetiring(grant, reason) {
        h.retireEvents.push({ grantId: grant.grantId, reason }); input.onGrantRetiring(grant, reason);
      } } : input;
      const binding = provider.bind(observed);
      return { ...binding, async request(q, signal) { h.nodeRequests.push(q); const result = await binding.request(q, signal); h.nodeResults.push(result);
        if (result.ok && result.operation === 'select' && result.outcome === 'selected') await h.selectResultGate?.promise;
        return result; } }; } }; } };
  const manager = createMainGattProviderOwner({ MessageChannelMain: MainChannel,
    limits: { maxLeases: 1, maxPendingRequests: 8, maxQueuedRecords: 16, maxQueuedBytes: 1024,
      maxReadRecords: 16, maxReadBytes: 256, maxPayloadBytes: 16, idleTimeoutMs },
    dialog: { async showMessageBox(parent, input) {
    assert.equal(parent, main); assert.equal(input.defaultId, 0); assert.equal(input.cancelId, 0); assert(input.signal);
    calls.push(['parent-dialog', input.title]); return h.dialogHook ? h.dialogHook(input) : { response: 1 };
  } }, getMainWindow: () => main,
    resolveOriginalOwnerBluetoothControl: async input => { assert.deepEqual(input.authority, authority); return h.noOwner ? null : control; },
    loadComposition: async () => { calls.push('load-provider'); if (h.providerLoad) await h.providerLoad.promise;
      calls.push('load-native'); let released = false;
      return { provider: { module }, native: { module: nativeModule }, async release() {
        if (released) return;
        if (h.providerHolderFailure) throw Error('Original provider holder release unknown');
        if (h.nativeHolderFailure) throw Error('Original Native holder release unknown');
        calls.push('provider-holder-release', 'native-holder-release'); released = true;
        h.providerHolderReleased++; h.nativeHolderReleased++;
      } }; },
    onBindingRetired(value) { h.retired.push(value); }, onBindingState(value) { h.states.push(value); },
  });
  function bind(producerId = 'main-producer-1') { return manager.bind({ authority, producerId, choosePeer: manager.choosePeer,
    requireCurrentController() { if (!h.controllerCurrent) throw Error('Original workspace controller ended'); } }); }
  function client(port) { let sequence = 0;
    const send = (operation, signal = new AbortController().signal) => port.request({ schemaVersion: 1, kind: 'aily-host-gatt-provider-request',
      requestId: `outer-${++sequence}`, requestSequence: sequence, operation }, signal);
    return { port, send, async select(signal) { const result = await send('select', signal); assert.equal(result.outcome, 'selected');
      const original = attachments.get(result.grant.grantId); assert(original); let inner = 0;
      const command = (operation, extra = {}) => { const { backendId, grantId, profileId, executionId, executionLocation, resourceLocation, permissionAuthority, scope } = result.grant;
        return { schemaVersion: 1, kind: 'aily-host-gatt-command', requestId: `inner-${++inner}`, requestSequence: inner,
          backendId, grantId, profileId, executionId, executionLocation, resourceLocation, permissionAuthority, scope, command: operation, ...extra }; };
      return { grant: result.grant, backend: original.backend, command,
        execute: (operation, extra) => original.backend.execute(command(operation, extra)) };
    } };
  }
  t.after(async () => { h.nativeDisposeFailure = h.nativeHolderFailure = h.providerHolderFailure = h.peerCloseFailure = false;
    h.attachThrows = false; h.controllerCurrent = h.ownerCurrent = true; h.dialogHook = null; h.writeHook = null;
    for (const gate of gates) gate.resolve({ response: 0 });
    await manager.dispose(); for (const port of ports) port.close(); });
  return { h, calls, control, callbacks, attachments, peers, notifications, ports, authority, manager, bind, client,
    gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test('GATT Main optional construction and absent original owner acquire neither installed holder nor Native', async t => {
  const f = fixture(t); f.h.noOwner = true; assert.equal(await f.bind(), null); assert.deepEqual(f.calls, []);
});

test('GATT Main real common provider transfers selected full scope, exchanges bytes and joins both holders', async t => {
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  assert.deepEqual(f.h.innerAuthorities, [{ ...f.authority, bindingId: 'main-producer-1' }]);
  assert.equal(selected.grant.executionId, 'actual-execution'); assert.equal(selected.grant.scope.coreGeneration, 3);
  assert.equal(selected.grant.scope.connectionEpoch, 5); assert.equal(selected.grant.scope.runtimeGeneration, 2);
  const opened = await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' }); assert(opened.ok);
  const leaseId = opened.leaseId; assert.equal((await selected.execute('discover', { leaseId })).services.length, 1);
  assert.equal((await selected.execute('read', { leaseId, characteristicId: 'characteristic' })).dataBase64, 'AP8D');
  assert.equal((await selected.execute('write', { leaseId, characteristicId: 'characteristic', mode: 'with-response', dataBase64: 'AP8=', dataByteLength: 2 })).completion, 'peer-acknowledged');
  const sub = await selected.execute('subscribe', { leaseId, characteristicId: 'characteristic', mode: 'notify' });
  f.notifications[0].receive(Uint8Array.of(9, 0, 255));
  assert.equal((await selected.execute('read-events', { leaseId, subscriptionId: sub.subscriptionId, afterSequence: 0, maxRecords: 1, maxBytes: 16 })).records[0].dataBase64, 'CQD/');
  await client.port.close(); assert.equal(f.peers[0].closed, true); assert.equal(f.notifications[0].closed, true);
  assert.deepEqual(f.h.states, []); // Expected Stop/dispose does not become autonomous grant retirement.
  assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1); assert.equal(f.h.retired.length, 1);
  assert.deepEqual(f.h.retired[0], { ...f.authority, producerId: 'main-producer-1' }); assert(f.ports.every(port => port.closed));
  assert(f.calls.indexOf('native-holder-release') > f.calls.indexOf('native-dispose'));
});

for (const failed of ['nativeDisposeFailure', 'nativeHolderFailure', 'providerHolderFailure', 'peerCloseFailure']) test(`GATT Main retains original ${failed} until explicit cleanup retry`, async t => {
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  assert((await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' })).ok);
  f.h[failed] = true;
  try {
    await assert.rejects(client.port.close()); assert.equal(f.h.retired.length, 0);
    assert.equal(f.h.nativeHolderReleased === 1 && f.h.providerHolderReleased === 1, false);
    await assert.rejects(client.send('catalog')); assert.equal(f.h.scans, 1);
  } finally { f.h[failed] = false; }
  await client.port.close(); assert.equal(f.h.retired.length, 1); assert.equal(f.peers[0].closed, true);
  assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1);
});

test('GATT Main joins a late installed acquisition after its controller ended without advancing a producer', async t => {
  const f = fixture(t); f.h.providerLoad = f.gate(); const pending = f.bind();
  await until(() => f.calls.includes('load-provider')); f.h.controllerCurrent = false;
  assert.equal(f.h.providerHolderReleased, 0); f.h.providerLoad.resolve();
  assert.equal(await pending, null); assert.equal(f.h.scans, 0); assert.equal(f.h.retired.length, 0);
  assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1);
});

test('GATT Main cancellation retains a late original dialog and never creates a late scan or driver', async t => {
  const f = fixture(t), port = await f.bind(), dialog = f.gate(), abort = new AbortController();
  f.h.dialogHook = () => dialog.promise;
  const selecting = f.client(port).send('select', abort.signal).catch(error => error);
  await until(() => f.calls.some(value => Array.isArray(value) && value[0] === 'parent-dialog'));
  abort.abort(); let closed = false; const closing = port.close().then(() => { closed = true; });
  await turn(); assert.equal(closed, false); assert.equal(f.h.providerHolderReleased, 0);
  dialog.resolve({ response: 1 }); await selecting; await closing;
  assert.equal(f.h.scans, 0); assert.equal(f.peers.length, 0); assert.equal(f.h.retired.length, 1);
});

test('GATT Main lost attach ACK waits for exact Runtime detach and original late attach before holder release', async t => {
  const f = fixture(t), port = await f.bind(); f.h.attachGate = f.gate(); f.h.attachThrows = true;
  const selecting = f.client(port).send('select').catch(error => error);
  await until(() => f.attachments.size === 1); let closed = false;
  const ending = port.close().then(() => { closed = true; });
  await until(() => f.calls.some(value => Array.isArray(value) && value[0] === 'runtime-detach'));
  assert.equal(closed, false); assert.equal(f.h.nativeHolderReleased, 0); assert.equal(f.h.providerHolderReleased, 0);
  f.h.attachGate.resolve(); assert(await selecting instanceof Error); await ending; assert.equal(f.h.retired.length, 1);
});

test('GATT Main terminal result waits for the original consumer frontier, retires independently and never replays a write', async t => {
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  const opened = await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' }), leaseId = opened.leaseId;
  await selected.execute('discover', { leaseId });
  const frontier = f.gate(), command = selected.command('write', { leaseId, characteristicId: 'characteristic', mode: 'with-response', dataBase64: 'AQD/', dataByteLength: 3 });
  const registered = api.registerHostGattResultConsumption(selected.backend, command, frontier.promise); assert(registered);
  f.h.writeHook = () => { f.h.context.runtimeTimeEpoch++; f.h.context.bluetooth.snapshot.timeEpoch++; };
  const result = await selected.backend.execute(command); assert.equal(result.ok, false); assert.equal(result.errorCode, 'delivery-unknown');
  assert.equal(registered.terminal, true); await turn(); assert.equal(f.h.retired.length, 0); assert.deepEqual(f.h.writes, [[1, 0, 255]]);
  frontier.resolve(true); await until(() => f.h.retired.length === 1);
  assert(f.peers[0].closed); await assert.rejects(selected.backend.execute(command)); assert.deepEqual(f.h.writes, [[1, 0, 255]]);
  f.h.writeHook = null; const renewed = f.client(await f.bind('main-producer-2')), next = await renewed.select();
  assert.equal(next.grant.scope.timeEpoch, f.h.context.runtimeTimeEpoch); await client.port.close();
  assert.equal(f.h.retired.length, 1); await renewed.port.close(); assert.equal(f.h.retired.length, 2);
});

test('GATT Main explicit old-producer release retries failed physical close and returns the real Node receipt after full retirement', async t => {
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  assert((await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' })).ok);
  f.h.peerCloseFailure = true;
  await assert.rejects(client.port.close());
  assert.equal(f.peers[0].closed, false); assert.equal(f.h.retired.length, 0);
  assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0);
  f.h.peerCloseFailure = false;
  const result = await client.send('release');
  api.validateHostGattProviderExchangeV1(f.h.nodeRequests.at(-1), result);
  assert.equal(f.h.nodeRequests.at(-1).operation, 'release'); assert.equal(f.h.nodeRequests.at(-1).requestSequence, 2);
  assert.deepEqual(result, f.h.nodeResults.at(-1)); // Actual Node result, not a void close ACK.
  assert.equal(result.ok, true); assert.equal(result.operation, 'release'); assert.equal(result.state, 'released');
  assert.equal(f.peers[0].closed, true); assert.equal(f.attachments.size, 0);
  assert.equal(f.h.nativeDisposed, 1); assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1);
  assert.deepEqual(f.h.retired, [{ ...f.authority, producerId: 'main-producer-1' }]);
  assert(f.ports.every(port => port.closed));
});

test('GATT Main real negative release on an already closed Node binding still retries original Native and holder owners only', async t => {
  for (const failure of ['nativeDisposeFailure', 'nativeHolderFailure', 'providerHolderFailure']) {
    const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
    assert((await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' })).ok);
    f.h[failure] = true;
    await assert.rejects(client.port.close()); assert.equal(f.h.retired.length, 0);
    assert.equal(f.peers[0].closed, true); // Real Node binding has already completed its physical close.
    f.h[failure] = false;
    const result = await client.send('release');
    api.validateHostGattProviderExchangeV1(f.h.nodeRequests.at(-1), result);
    assert.deepEqual(result, f.h.nodeResults.at(-1));
    assert.equal(result.ok, false); assert.equal(result.operation, 'release'); assert.equal(result.errorCode, 'lease-revoked');
    assert.equal(f.h.nativeDisposed, 1); assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1);
    assert.deepEqual(f.h.retired, [{ ...f.authority, producerId: 'main-producer-1' }]);
    const successor = f.client(await f.bind('main-producer-2')); await successor.select();
    const late = await client.send('release'); assert.equal(late.ok, false);
    assert.equal(f.h.retired.length, 1); // Old producer cannot publish retirement for the successor.
    assert.equal(f.h.scans, 2); assert.equal(f.h.nativeDisposed, 1);
    await successor.port.close(); assert.equal(f.h.retired.length, 2);
    assert.equal(f.h.retired[1].producerId, 'main-producer-2');
  }
});

test('GATT autonomous idle fences immediately but waits physical close and exact Runtime detach before publishing a successor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  assert((await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' })).ok);
  f.h.peerCloseGate = f.gate(); f.h.detachGate = f.gate();
  f.h.now += 30000; t.mock.timers.tick(30000);
  await untilImmediate(() => f.h.states[0]?.phase === 'closing');
  assert.deepEqual(f.h.retireEvents, [{ grantId: selected.grant.grantId, reason: 'lease-revoked' }]);
  assert.deepEqual(f.h.states[0].selection, { requestId: 'outer-1', requestSequence: 1 });
  assert.equal(f.h.states[0].grant.grantId, selected.grant.grantId);
  assert.equal(f.peers[0].closed, false); assert.equal(f.h.retired.length, 0);
  assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0);
  assert.equal(f.ports[0].closed, false);
  await assert.rejects(client.send('catalog')); assert.equal(f.h.scans, 1);
  f.h.peerCloseGate.resolve();
  await untilImmediate(() => f.peers[0].closed && selected.backend.snapshot().retired);
  assert.equal(f.h.retired.length, 0); assert.equal(f.ports[0].closed, false);
  assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0);
  f.h.detachGate.resolve(); await untilImmediate(() => f.h.retired.length === 1);
  assert(f.ports.every(port => port.closed)); assert.equal(f.h.nativeHolderReleased, 1);
  const successor = f.client(await f.bind('main-producer-2'));
  const catalog = await successor.send('catalog'); assert.equal(catalog.catalog.backends[0].permissionState, 'prompt');
  assert.equal(f.h.scans, 1); // A ready successor never selects a peer automatically.
  await successor.select(); assert.equal(f.h.scans, 2); await successor.port.close();
});

test('GATT autonomous idle close failure retains the original owner until explicit retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  assert((await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' })).ok);
  f.h.peerCloseFailure = true; f.h.now += 30000; t.mock.timers.tick(30000);
  await untilImmediate(() => f.h.states.at(-1)?.phase === 'cleanup-unconfirmed');
  assert.equal(f.h.retired.length, 0); assert.equal(f.peers[0].closed, false);
  assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0); assert.equal(f.ports[0].closed, false);
  const closeAttempts = f.calls.filter(value => value === 'peer-close').length;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(value => value === 'peer-close').length, closeAttempts);
  f.h.peerCloseFailure = false; await client.port.close();
  assert.deepEqual(f.h.states.map(value => value.phase), ['closing', 'cleanup-unconfirmed', 'closing']);
  assert.equal(f.h.retired.length, 1); assert.equal(f.h.scans, 1);
});

test('GATT autonomous callback cannot retire a different grant or a later producer', async t => {
  const f = fixture(t), client = f.client(await f.bind()), selected = await client.select();
  const old = f.h.retireCallbacks[0]; assert.equal(typeof old, 'function');
  old({ ...selected.grant, scope: { ...selected.grant.scope, timeEpoch: selected.grant.scope.timeEpoch + 1 } }, 'lease-revoked');
  old({ ...selected.grant, grantId: 'foreign-grant' }, 'lease-revoked');
  await turn(); assert.equal(f.h.states.length, 0); assert.equal(f.h.retired.length, 0);
  await client.port.close(); const successor = f.client(await f.bind('main-producer-2'));
  const current = await successor.select(); const callbacks = f.callbacks.size;
  old(selected.grant, 'lease-revoked'); await turn();
  assert.equal(f.h.states.length, 0); assert.equal(f.h.retired.length, 1); assert.equal(f.callbacks.size, callbacks);
  assert((await current.execute('open', { peerId: current.grant.resourceIds[0], role: 'central' })).ok);
  await successor.port.close();
});

test('GATT autonomous idle during original attach joins its late ACK without releasing ports or holders early', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), client = f.client(await f.bind()); f.h.attachGate = f.gate(); f.h.detachJoinsAttach = false;
  const selected = client.send('select').catch(error => error);
  await untilImmediate(() => f.attachments.size === 1);
  f.h.now += 30000; t.mock.timers.tick(30000);
  await untilImmediate(() => f.h.states[0]?.phase === 'closing');
  await untilImmediate(() => f.attachments.size === 0); // Real detach ACK does not settle the original attach flight in this vector.
  assert.equal(f.h.retired.length, 0); assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0);
  assert.equal(f.ports[0].closed, false);
  f.h.attachGate.resolve(); assert(await selected instanceof Error);
  await untilImmediate(() => f.h.retired.length === 1); assert(f.ports.every(port => port.closed));
});

test('GATT autonomous idle before the select handoff closes only its original binding without inventing an attachment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t), client = f.client(await f.bind()); f.h.selectResultGate = f.gate();
  const selecting = client.send('select').catch(error => error);
  await untilImmediate(() => f.h.nodeResults.some(value => value.operation === 'select' && value.outcome === 'selected'));
  f.h.now += 30000; t.mock.timers.tick(30000);
  await untilImmediate(() => f.h.retired.length === 1);
  assert.equal(f.attachments.size, 0); assert.equal(f.ports.length, 0);
  assert.deepEqual(f.h.states, []); // No installed grant was ever exposed to the Runtime/UI.
  assert.equal(f.calls.some(value => Array.isArray(value) && value[0] === 'runtime-detach'), false);
  assert.equal(f.h.nativeHolderReleased, 1); assert.equal(f.h.providerHolderReleased, 1);
  f.h.selectResultGate.resolve(); assert(await selecting instanceof Error);
});

test('GATT autonomous idle abandons a held business result honestly and joins the original write without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { idleTimeoutMs: 1000 }); f.h.clientTimeoutMs = 30000;
  const client = f.client(await f.bind()), selected = await client.select();
  const opened = await selected.execute('open', { peerId: selected.grant.resourceIds[0], role: 'central' }), leaseId = opened.leaseId;
  await selected.execute('discover', { leaseId });
  const original = f.gate(); f.h.writeHook = () => original.promise;
  const write = selected.execute('write', { leaseId, characteristicId: 'characteristic', mode: 'with-response', dataBase64: 'AQD/', dataByteLength: 3 }).catch(error => error);
  await untilImmediate(() => f.h.writes.length === 1);
  f.h.now += 1000; t.mock.timers.tick(1000);
  await untilImmediate(() => f.h.states[0]?.phase === 'closing');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.h.retireEvents, [{ grantId: selected.grant.grantId, reason: 'lease-revoked' }]);
  assert.equal(f.h.retired.length, 0); assert.equal(f.h.nativeHolderReleased + f.h.providerHolderReleased, 0);
  assert.equal(f.ports[0].closed, false); assert.deepEqual(f.h.writes, [[1, 0, 255]]);
  original.resolve(); const outcome = await write; assert.notEqual(outcome.ok, true);
  await untilImmediate(() => f.h.retired.length === 1);
  assert.deepEqual(f.h.writes, [[1, 0, 255]]); assert.equal(f.peers[0].closed, true);
});
