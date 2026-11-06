import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, transform } from 'esbuild';
// The optional root is test-only: the identical regression can demonstrate
// the old immutable Main candidate's failure without editing either capture.
const root = process.env.AILY_PROVIDER_RETIREMENT_BASELINE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert(path.isAbsolute(root));
const require = createRequire(import.meta.url);
const { createMainNetworkHostBoundary } = require(root + '/electron/subapp-network-host-boundary.js');
const { createMainNetworkEndpointSelection } = require(root + '/electron/subapp-network-endpoint-selection.js');
const leases = require(root + '/electron/child-tool-session-leases.js');
const sdk = await import(pathToFileURL(path.join(root, 'node_modules/@aily-project/simulator-host-sdk/dist/index.js')));
const protocol = { ...await import(pathToFileURL(path.join(root, 'node_modules/@aily-project/simulator-protocol/dist/connectivity-network-provider.js'))),
  ...await import(pathToFileURL(path.join(root, 'node_modules/@aily-project/simulator-protocol/dist/connectivity-host.js'))) };
async function loadPureTs(relative) {
  const bundled = await build({ entryPoints: [path.join(root, relative)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}
const { SubappWorkspaceHostProviderController } = await loadPureTs('src/app/services/integrations/subapps/host-provider/subapp-workspace-host-provider-controller.ts');
const dispatcher = await loadPureTs('src/app/services/integrations/subapps/host-provider/subapp-host-provider-dispatcher.ts');
// Transpile the actual ProductService file unchanged. Angular/other application
// dependencies are inert constructor-only fixtures. Its actual private open(),
// bindProviderSession(), shared SDK adapter and real dispatcher are exercised.
const productFile = path.join(root, 'src/app/integrations/simulator/simulator-host-provider-product.service.ts');
const transformed = await transform(await readFile(productFile, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022',
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
const productModule = new Module(productFile); productModule.filename = productFile;
productModule.paths = Module._nodeModulePaths(root);
productModule.require = name => {
  if (name === '@angular/core') return { Injectable: () => value => value, NgZone: class {} };
  if (name === '@integration/subapps/public-api') return dispatcher;
  if (name === '@aily-project/simulator-host-sdk') return sdk;
  return new Proxy({}, { get: () => function inertApplicationDependency() {} });
};
productModule._compile(transformed.code, productFile);
const { SimulatorHostProviderProductService } = productModule.exports;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (id = 'catalog.original', sequence = 1) => ({ schemaVersion: 1, kind: 'aily-host-network-provider-request', requestId: id, requestSequence: sequence, operation: 'catalog' });
const unavailable = req => ({ schemaVersion: 1, kind: 'aily-host-network-provider-result', requestId: req.requestId,
  requestSequence: req.requestSequence, operation: req.operation, ok: false, errorCode: 'unavailable' });
function fixture(options = {}) {
  const sender = { id: 7, mainFrame: {}, isDestroyed: () => false };
  let main = { webContents: sender, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame };
  let session = { toolId: 'simulator', streamId: 'stream.original', running: true, messagePort: {}, owners: new Map() };
  const events = [], contexts = [];
  let factoryCalls = 0;
  const selection = options.configured ? createMainNetworkEndpointSelection({ resources: [{ endpointId: 'controlled.peer', label: 'Controlled fake', detail: 'No network operations', transports: ['tcp'], recordTypes: ['A'] }],
    showChooser: async () => assert.fail('pure test never opens a chooser') }) : null;
  const boundary = createMainNetworkHostBoundary({ protocol, getMainWindow: () => main,
    requireController(ownerId, input) {
      const auth = leases.authorizeMessagePortSend(session, ownerId, input);
      if (!session?.providerMessageController || !auth.success) throw Error('Local serial controller binding has ended');
    }, selection,
    ...(options.configured ? { resolveOriginalOwnerNetworkPort: async input => { factoryCalls++; return options.acquire ? options.acquire(input) : null; } } : {}),
  });
  const service = Object.create(SimulatorHostProviderProductService.prototype);
  // No project/Artifact operation is needed for the network lifetime. The real
  // ProductService still creates and closes its network adapter/dispatcher.
  service.openCurrentProjectScope = async () => null;
  const controller = new SubappWorkspaceHostProviderController({ instanceId: 'workspace:product-test',
    port: {
      async bindMessageController(input) { events.push({ kind: 'bind', ...input }); return leases.bindMessageController(session, sender.id, input, sender.id); },
      async unbindMessageController(input) { events.push({ kind: 'unbind', ...input }); return leases.unbindMessageController(session, sender.id, input, sender.id); },
      async sendMessage(input) { events.push({ kind: 'send', ...input }); return { success: true }; },
      async localNetwork(input) { const result = await boundary.invoke(event, input); events.push({ kind: 'network', input, result }); return result; },
    }, registry: { hasRegistration: toolId => toolId === 'simulator', async open(context) { contexts.push(context); return service.open(context); } },
  });
  const authority = () => ({ senderId: sender.id, toolId: 'simulator', streamId: session.streamId, bindingId: session.providerMessageController.bindingId });
  return { boundary, controller, events, contexts, event, sender, factoryCalls: () => factoryCalls, authority,
    snapshot: () => session,
    async start() { await controller.update('project.original', [session]); assert.equal(controller.snapshot()[0].ready, true); },
    exit() { const original = session; original.exit = { expected: true }; original.running = false; leases.clearMessageControllerBinding(original); },
    restart() { session = { toolId: 'simulator', streamId: 'stream.restarted', running: true, messagePort: {}, owners: new Map() }; },
    update: () => controller.update('project.original', [session]),
    replaceMain() { const replacement = { ...sender, mainFrame: {} }; main = { webContents: replacement, isDestroyed: () => false }; return { sender: replacement, senderFrame: replacement.mainFrame }; },
    async close() { await controller.close(); await boundary.dispose(); },
  };
}
function closeInput(authority) { const { senderId, ...input } = authority; return { action: 'close', ...input }; }

test('actual ProductService unused channel exits and binds a new stream without any Main network IPC', async () => {
  const h = fixture(); await h.start(); h.exit(); await h.update(); h.restart(); await h.update();
  assert.deepEqual(h.events.filter(x => x.kind === 'bind').map(x => x.streamId), ['stream.original', 'stream.restarted']);
  assert.equal(h.controller.snapshot()[0].ready, true); assert.equal(h.events.filter(x => x.kind === 'network').length, 0);
  assert.equal(h.factoryCalls(), 0); await h.close();
});
test('validated unconfigured catalog has a resource-free receipt after exit; malformed/unknown tuples do not', async () => {
  const h = fixture(); await h.start(); const old = h.authority();
  await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  assert.equal(h.boundary.snapshot().bindings, 0); assert.equal(h.boundary.snapshot().retirementReceipts, 1);
  h.exit(); await h.update(); h.restart(); await h.update();
  assert.equal(h.controller.snapshot()[0].streamId, 'stream.restarted');
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(old)), { ok: true, closed: true });
  for (const patch of [{ streamId: 'unknown.stream' }, { bindingId: 'unknown.binding' }, { toolId: 'other' }]) {
    assert.equal((await h.boundary.invoke(h.event, { ...closeInput(old), ...patch })).errorCode, 'permission-denied');
  }
  assert.equal(h.factoryCalls(), 0); await h.close();
});
test('positive absent original acquisition remains closeable after Runtime exit without minting an owner', async () => {
  const h = fixture({ configured: true }); await h.start(); const old = h.authority();
  await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  assert.equal(h.factoryCalls(), 1); assert.equal(h.boundary.snapshot().bindings, 0);
  h.exit(); await h.update(); h.restart(); await h.update();
  assert.equal(h.controller.snapshot()[0].ready, true);
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(old)), { ok: true, closed: true });
  assert.equal(h.factoryCalls(), 1); await h.close();
});
test('Main closeRuntime and ProductService join one real original close before a new stream is bound', async () => {
  const closeStarted = deferred(), closeGate = deferred(); let closes = 0;
  const h = fixture({ configured: true, acquire: async () => ({ request: async req => unavailable(req), async close() { closes++; closeStarted.resolve(); await closeGate.promise; } }) });
  await h.start(); const old = h.authority(); await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  const retiring = h.boundary.closeRuntime(old.streamId); await closeStarted.promise;
  h.exit(); h.restart(); let updated = false; const update = h.update().then(() => { updated = true; });
  await tick(); assert.equal(updated, false); assert.equal(closes, 1); assert.equal(h.events.filter(x => x.kind === 'bind').length, 1);
  closeGate.resolve(); await retiring; await update;
  assert.equal(closes, 1); assert.equal(h.controller.snapshot()[0].streamId, 'stream.restarted'); assert.equal(h.controller.snapshot()[0].ready, true);
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(old)), { ok: true, closed: true }); await h.close();
});
test('old receipt cannot touch successor resources; foreign sender/frame/tool/stream/binding and old business requests stay denied', async () => {
  const closed = [], h = fixture({ configured: true, acquire: async ({ authority }) => ({ request: async req => unavailable(req), async close() { closed.push(authority.streamId); } }) });
  await h.start(); const old = h.authority(); await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  await h.boundary.closeRuntime(old.streamId); h.exit(); h.restart(); await h.update();
  const current = h.authority(); await h.contexts[1].localNetwork.request(request('successor.catalog'), new AbortController().signal);
  assert.deepEqual(closed, ['stream.original']); assert.equal(h.boundary.snapshot().bindings, 1);
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(old)), { ok: true, closed: true });
  for (const event of [{ ...h.event, sender: { ...h.sender } }, { ...h.event, senderFrame: {} }]) {
    assert.equal((await h.boundary.invoke(event, closeInput(current))).errorCode, 'permission-denied');
  }
  for (const patch of [{ toolId: 'foreign' }, { streamId: 'foreign.stream' }, { bindingId: 'foreign.binding' }]) {
    assert.equal((await h.boundary.invoke(h.event, { ...closeInput(current), ...patch })).errorCode, 'permission-denied');
  }
  for (const action of ['request', 'cancel']) {
    const input = { ...closeInput(old), action, ...(action === 'request' ? { request: request('old.request') } : { requestId: 'old.request' }) };
    assert.equal((await h.boundary.invoke(h.event, input)).errorCode, 'permission-denied');
  }
  assert.deepEqual(closed, ['stream.original']); assert.equal(h.boundary.snapshot().bindings, 1); assert.equal(h.factoryCalls(), 2);
  await h.close(); assert.deepEqual(closed, ['stream.original', 'stream.restarted']);
});
test('failed real close retains the original fenced owner until explicit retry, without replay or successor binding', async () => {
  let fail = true, closes = 0, requests = 0;
  const h = fixture({ configured: true, acquire: async () => ({ async request(req) { requests++; return unavailable(req); }, async close() { closes++; if (fail) throw Error('original cleanup not confirmed'); } }) });
  await h.start(); const old = h.authority(); await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  await assert.rejects(h.boundary.closeRuntime(old.streamId)); h.exit(); h.restart(); await assert.rejects(h.update());
  assert.equal(h.boundary.snapshot().bindings, 1); assert.equal(h.boundary.snapshot().fenced, 1);
  assert.equal(h.boundary.snapshot().retirementReceipts, 0); assert.equal(h.events.filter(x => x.kind === 'bind').length, 1);
  assert.equal(h.controller.snapshot()[0].ready, false); assert.equal(requests, 1);
  fail = false; await h.update(); assert.equal(h.controller.snapshot()[0].ready, true); assert.equal(h.boundary.snapshot().bindings, 0);
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(old)), { ok: true, closed: true }); assert.equal(requests, 1); assert(closes > 1); await h.close();
});
test('confirmed receipts are bounded and consume no backend binding slots; unvalidated requests cannot create receipts', async () => {
  const h = fixture(); await h.start(); const original = h.authority();
  const invalid = { ...closeInput(original), action: 'request', request: { ...request(), requestSequence: 0 } };
  assert.equal((await h.boundary.invoke(h.event, invalid)).errorCode, 'invalid-input'); assert.equal(h.boundary.snapshot().retirementReceipts, 0);
  for (let i = 0; i < 300; i++) {
    const session = h.snapshot(); session.providerMessageController.bindingId = `issued.binding.${i}`;
    const current = h.authority(); const input = { ...closeInput(current), action: 'request', request: request(`catalog.${i}`) };
    assert.equal((await h.boundary.invoke(h.event, input)).ok, true);
  }
  const newest = h.authority(); h.exit();
  assert.equal(h.boundary.snapshot().retirementReceipts, 256); assert.equal(h.boundary.snapshot().bindings, 0);
  assert.equal((await h.boundary.invoke(h.event, { ...closeInput(newest), bindingId: 'issued.binding.0' })).errorCode, 'permission-denied');
  assert.deepEqual(await h.boundary.invoke(h.event, closeInput(newest)), { ok: true, closed: true });
  await h.update(); await h.boundary.dispose(); assert.equal(h.boundary.snapshot().retirementReceipts, 0);
});
test('a replacement Main sender cannot reuse another Main lifetime receipt even with the same numeric sender id', async () => {
  const h = fixture(); await h.start(); const old = h.authority(); await h.contexts[0].localNetwork.request(request(), new AbortController().signal);
  h.exit(); const replacement = h.replaceMain();
  assert.equal((await h.boundary.invoke(replacement, closeInput(old))).errorCode, 'permission-denied');
  await assert.rejects(h.update()); assert.equal(h.controller.snapshot()[0].ready, false);
  await h.boundary.dispose();
});
