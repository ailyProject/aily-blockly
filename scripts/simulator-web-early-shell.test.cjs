const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');
const load = name => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(
  fs.readFileSync(path.join(__dirname, '../src/app/integrations/simulator/', name), 'utf8'),
  { mode: 'transform' })).toString('base64'));
const product = load('simulator-web-product.service.ts');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const document = {}, window = { document, location: { origin: 'https://app.example.test' } };
  document.defaultView = window;
  const surface = { window, document, controls: { ownerDocument: document }, container: { ownerDocument: document } };
  const lifetime = new AbortController(), selected = new AbortController();
  const identity = { runtimeId: '146d805f-c657-4cea-ad70-db55dbabb79f', version: '0.1.0' };
  const resources = { trustedOrigin: window.location.origin, releaseBaseURL: window.location.origin + '/releases/' + 'a'.repeat(64) + '/' };
  const counts = { publicReads: 0, compositionReads: 0, presentFactories: 0, presents: 0, revokes: 0,
    shellCloses: 0, startupFactories: 0, startupCloses: 0, providersClosed: 0, ownerChecks: 0, visible: 0 };
  const presentation = { activation: lifetime.signal, identity, resources,
    requireCurrent() { lifetime.signal.throwIfAborted(); } };
  const composition = { activation: selected.signal, startupOptions: {
    identity: { ...identity, ownerKey: 'original-execution-owner', projectIdentity: 'original-project', sceneId: 'main',
      artifactRevision: 'b'.repeat(64), subjectHash: 'c'.repeat(64) },
    resources: { ...resources, artifactBaseURL: null }, owner: { requireCurrent() { counts.ownerChecks++; selected.signal.throwIfAborted(); } },
    project: {}, artifact: {}, authorization: {}, catalog: {}, instanceAuthority: {}, workspace: null,
    ownedProviders: { async close() { counts.providersClosed++; } },
  } };
  const result = deferred(), readStarted = deferred(), shown = deferred();
  const source = { async readPresentation(signal) { counts.publicReads++; signal.throwIfAborted(); return presentation; },
    readComposition() { counts.compositionReads++; readStarted.resolve(); return result.promise; } };
  const shell = { descriptor: { window, document, container: surface.container, identity, releaseBase: resources.releaseBaseURL,
    shellURL: resources.releaseBaseURL + 'shell.html' },
    async present() { counts.presents++; shown.resolve(); }, revokeDocument() { counts.revokes++; },
    async close() { counts.shellCloses++; }, snapshot: () => ({ state: 'waiting-admission', generation: 1, pending: 0,
      current: { presented: true, admissionStarted: false, handedOff: false,
        docNonce: 'private-document-capability', projectConnectionId: 'private-port-capability' } }) };
  const publicModule = { createWebShellPresentation(input) {
    counts.presentFactories++;
    assert.deepEqual(Object.keys(input).sort(), ['container', 'document', 'identity', 'releaseBase', 'shellURL', 'window']);
    assert.equal(input.releaseBase.href, resources.releaseBaseURL); assert.equal(input.shellURL.href, resources.releaseBaseURL + 'shell.html');
    return shell;
  } };
  const handle = { async close() { counts.startupCloses++; }, snapshot: () => ({ original: true }) };
  const startup = { createWebSimulatorStartup(input) {
    counts.startupFactories++; assert.equal(input.shellPresentation, shell); return handle;
  } };
  return { surface, lifetime, selected, identity, resources, counts, presentation, composition, source, shell, publicModule, startup,
    result, shown, readStarted, handle };
}

test('public original Shell is presented while composition remains held, then the same local handle transfers', async () => {
  const { SimulatorWebProductService } = await product, f = fixture();
  const service = new SimulatorWebProductService(f.source, async () => f.startup, async url => {
    assert.equal(url, f.resources.releaseBaseURL + 'presentation.mjs'); return f.publicModule;
  });
  const mounted = service.mount(f.surface, () => { f.counts.visible++; });
  await f.shown.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.compositionReads, 1); assert.equal(f.counts.visible, 1);
  assert.equal(f.counts.startupFactories, 0); assert.equal(f.counts.ownerChecks, 0);
  assert.equal(service.snapshot().state, 'loading');
  assert.equal(service.snapshot().publicPresentation.presented, true);
  assert.equal(JSON.stringify(service.snapshot()).includes('private-document-capability'), false);
  assert.equal(JSON.stringify(service.snapshot()).includes('private-port-capability'), false);
  f.result.resolve(f.composition); await mounted;
  assert.equal(f.counts.startupFactories, 1); assert.equal(service.snapshot().publicPresentation.transferred, true);
  await service.close(); assert.equal(f.counts.startupCloses, 1);
  assert.equal(f.counts.shellCloses, 0); assert.equal(f.counts.providersClosed, 0); assert.equal(f.counts.revokes, 0);
});

test('preadmit close fences and closes presentation before late composition returns, then adopts original providers', async () => {
  const { SimulatorWebProductService } = await product, f = fixture();
  const service = new SimulatorWebProductService(f.source, async () => f.startup, async () => f.publicModule);
  const mounted = service.mount(f.surface); const rejected = assert.rejects(mounted);
  await f.shown.promise; const closing = service.close();
  assert.equal(f.counts.shellCloses, 1); // Original close is called synchronously before composition can settle.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.revokes, 0); assert.equal(f.counts.shellCloses, 1);
  assert.equal(f.counts.startupFactories, 0); assert.equal(service.snapshot().retainedCleanupResponsibility, true);
  f.result.resolve(f.composition); await rejected; await closing;
  assert.equal(f.counts.providersClosed, 1); assert.equal(f.counts.shellCloses, 1);
  assert.equal(service.snapshot().state, 'closed'); assert.equal(service.snapshot().NodeBusinessACK, false);
});

test('late presentation module after cancellation creates neither document nor startup', async () => {
  const { SimulatorWebProductService } = await product, f = fixture(), loading = deferred(), entered = deferred();
  const service = new SimulatorWebProductService(f.source, async () => f.startup, async () => { entered.resolve(); return loading.promise; });
  const mounted = service.mount(f.surface), rejected = assert.rejects(mounted);
  await entered.promise; const closing = service.close();
  f.result.resolve(f.composition); loading.resolve(f.publicModule); await rejected; await closing;
  assert.equal(f.counts.presentFactories, 0); assert.equal(f.counts.startupFactories, 0); assert.equal(f.counts.providersClosed, 1);
});

test('composition cannot attach a different release, instance or version to an already presented document', async () => {
  const { SimulatorWebProductService } = await product;
  for (const mutate of [f => { f.composition.startupOptions.resources.releaseBaseURL = f.surface.window.location.origin + '/releases/' + 'd'.repeat(64) + '/'; },
    f => { f.composition.startupOptions.identity.runtimeId = 'foreign-runtime'; },
    f => { f.composition.startupOptions.identity.version = 'different-version'; },
    f => { f.shell.descriptor.container = { ownerDocument: f.surface.document }; }]) {
    const f = fixture(), service = new SimulatorWebProductService(f.source, async () => f.startup, async () => f.publicModule);
    const mounted = service.mount(f.surface), rejected = assert.rejects(mounted, { code: 'invalid-web-composition' });
    await f.shown.promise; mutate(f); f.result.resolve(f.composition); await rejected; await service.close();
    assert.equal(f.counts.startupFactories, 0); assert.equal(f.counts.providersClosed, 1); assert.equal(f.counts.shellCloses, 1);
  }
});

test('public input containing execution authority is refused before the presentation factory', async () => {
  const { SimulatorWebProductService } = await product;
  for (const change of [f => { f.presentation.ownerKey = 'forbidden'; },
    f => { f.presentation.identity.subjectHash = 'c'.repeat(64); },
    f => { f.presentation.resources.artifactBaseURL = 'https://app.example.test/private/'; }]) {
    const f = fixture(); change(f);
    const service = new SimulatorWebProductService(f.source, async () => f.startup, async () => f.publicModule);
    const mounted = service.mount(f.surface); f.result.resolve(f.composition);
    await assert.rejects(mounted, { code: 'invalid-web-composition' }); await service.close();
    assert.equal(f.counts.presentFactories, 0); assert.equal(f.counts.startupFactories, 0); assert.equal(f.counts.providersClosed, 1);
  }
});

test('failed original presentation close retains the same handle for explicit retry', async () => {
  const { SimulatorWebProductService } = await product, f = fixture(); let failures = 1;
  f.shell.close = async () => { f.counts.shellCloses++; if (failures-- > 0) throw Error('Original document close failed'); };
  const service = new SimulatorWebProductService(f.source, async () => f.startup, async () => f.publicModule);
  const mounted = service.mount(f.surface), rejected = assert.rejects(mounted);
  await f.shown.promise; const closing = service.close(), closeFailed = assert.rejects(closing, /Original document close failed/);
  f.result.resolve(f.composition); await rejected; await closeFailed;
  assert.equal(service.snapshot().state, 'unconfirmed'); assert.equal(service.snapshot().retainedCleanupResponsibility, true);
  await service.close(); assert.equal(f.counts.shellCloses, 2); assert.equal(f.counts.providersClosed, 1);
  assert.equal(service.snapshot().state, 'closed');
});

test('trusted deployment exposes only fixed public fields without reading project/account inputs, per caller', async () => {
  const { createBlocklyProjectScopedWebDeployment } = await load('blockly-simulator-web-deployment.ts');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://app.example.test' } });
  try {
    let inputs = 0;
    const deployment = createBlocklyProjectScopedWebDeployment({ trustedOrigin: globalThis.location.origin, releaseId: 'a'.repeat(64),
      instance: { runtimeId: '146d805f-c657-4cea-ad70-db55dbabb79f', version: '0.1.0', ownerKey: 'private-owner', subjectHash: 'b'.repeat(64),
        configuration: { url: globalThis.location.origin + '/instances/146d805f-c657-4cea-ad70-db55dbabb79f/entitlement-config.json', sizeBytes: 1, sha256: 'c'.repeat(64) } },
      async readInputs() { inputs++; throw Error('Unexpected business input'); } });
    const a = new AbortController(), b = new AbortController();
    const first = await deployment.readPresentation(a.signal), second = await deployment.readPresentation(b.signal);
    assert.deepEqual(Object.keys(first).sort(), ['activation', 'identity', 'requireCurrent', 'resources']);
    assert.deepEqual(Object.keys(first.identity).sort(), ['runtimeId', 'version']);
    assert.deepEqual(Object.keys(first.resources).sort(), ['releaseBaseURL', 'trustedOrigin']); assert.equal(inputs, 0);
    a.abort(); assert.throws(() => first.requireCurrent()); second.requireCurrent();
    assert.notEqual(first.activation, second.activation);
  } finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
});

test('original Blockly publication forwards public input without opening a project scope or sharing caller lifetime', async () => {
  const { createBlocklySimulatorWebPublication } = await load('blockly-simulator-web-publication.ts');
  let business = 0;
  const publication = createBlocklySimulatorWebPublication({
    deployment: { async readPresentation(signal) { return { activation: signal, identity: { runtimeId: 'same', version: '0.1' },
      resources: { trustedOrigin: 'https://app.example.test', releaseBaseURL: 'https://app.example.test/releases/' + 'a'.repeat(64) + '/' },
      requireCurrent() { signal.throwIfAborted(); } }; }, async readStartup() { business++; throw Error('Unexpected startup'); } },
    async openCurrentProjectScope() { business++; throw Error('Unexpected scope'); },
    async readContext() { business++; throw Error('Unexpected generated context'); } });
  const a = new AbortController(), b = new AbortController();
  const first = await publication.readPresentation(a.signal), second = await publication.readPresentation(b.signal);
  a.abort(); assert.throws(() => first.requireCurrent()); second.requireCurrent();
  assert.equal(business, 0); assert.equal(publication.snapshot().retainedCallers, 0);
  await publication.close(); assert.throws(() => second.requireCurrent());
});

test('the normal source optional public path never reads an activation or allocates providers', async () => {
  const { createSimulatorWebProductSource } = await load('simulator-web-product.source.ts');
  const f = fixture(); let business = 0;
  const source = createSimulatorWebProductSource({
    readPresentation: f.source.readPresentation.bind(f.source),
    async readActivation() { business++; throw Error('Unexpected original activation'); },
    async loadProviders() { business++; throw Error('Unexpected provider allocation'); },
  });
  const a = new AbortController(), b = new AbortController();
  const first = await source.readPresentation(a.signal), second = await source.readPresentation(b.signal);
  a.abort(); assert.throws(() => first.requireCurrent()); second.requireCurrent();
  assert.equal(business, 0); assert.equal(source.snapshot().retainedCleanupResponsibility, false);
  await source.close(); assert.throws(() => second.requireCurrent()); assert.equal(business, 0);
});

test('a caller without the optional presentation seam retains the original mount path', async () => {
  const { SimulatorWebProductService } = await product, f = fixture();
  delete f.source.readPresentation;
  const service = new SimulatorWebProductService(f.source, async () => ({ createWebSimulatorStartup(input) {
    f.counts.startupFactories++; assert.equal('shellPresentation' in input, false); return f.handle;
  } }), async () => { throw Error('An unconfigured presentation must not load.'); });
  const mounted = service.mount(f.surface); f.result.resolve(f.composition); await mounted; await service.close();
  assert.equal(f.counts.startupFactories, 1); assert.equal(f.counts.startupCloses, 1); assert.equal(f.counts.presentFactories, 0);
});
