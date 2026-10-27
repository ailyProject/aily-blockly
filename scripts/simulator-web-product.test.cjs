const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Test the normal framework-free product service, without Angular, browser,
// network, firmware or a replacement Simulator implementation.
const source = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/simulator-web-product.service.ts'), 'utf8');
const productModule = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const activation = new AbortController();
  const document = {};
  const window = { document, location: { origin: 'https://app.example.test' } };
  document.defaultView = window;
  const surface = { window, document, controls: { ownerDocument: document }, container: { ownerDocument: document } };
  const observations = { reads: 0, modules: [], factories: [], ownerChecks: 0, closes: 0, providersClosed: 0 };
  const options = {
    identity: { runtimeId: 'runtime-original', version: 'version-original', ownerKey: 'owner-original',
      projectIdentity: 'project-original', sceneId: 'main', artifactRevision: null, subjectHash: 'a'.repeat(64) },
    resources: { trustedOrigin: window.location.origin,
      releaseBaseURL: `${window.location.origin}/releases/${'b'.repeat(64)}/`, artifactBaseURL: null },
    owner: { requireCurrent() { observations.ownerChecks++; activation.signal.throwIfAborted(); } },
    project: { readSelection() {} }, artifact: { readBinding() {} }, authorization: { readResponse() {} },
    instanceAuthority: { expectedSubjectHash: 'a'.repeat(64), publicInputOnly: true },
    catalog: { hostProviderSnapshot() {} }, workspace: null,
    ownedProviders: { async close() { observations.providersClosed++; } },
  };
  const composition = { activation: activation.signal, startupOptions: options };
  const provider = { async readComposition(signal) {
    observations.reads++; signal.throwIfAborted(); return composition;
  } };
  const handle = { async close() { observations.closes++; }, snapshot: () => ({ original: true }) };
  const module = { createWebSimulatorStartup(input) { observations.factories.push(input); return handle; } };
  const loader = async url => { observations.modules.push(url); return module; };
  return { activation, surface, observations, options, composition, provider, handle, module, loader };
}

test('missing product source fails closed without loading a technical caller', async () => {
  const { SimulatorWebProductService } = await productModule;
  let loads = 0;
  const service = new SimulatorWebProductService(null, async () => { loads++; throw Error('unexpected'); });
  await assert.rejects(service.mount(fixture().surface), { code: 'web-product-unavailable' });
  assert.equal(loads, 0); await service.close();
  assert.equal(service.snapshot().state, 'closed');
});

test('normal service invokes the original factory with exact release and original provider ports', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), service = new SimulatorWebProductService(f.provider, f.loader);
  await service.mount(f.surface);
  assert.deepEqual(f.observations.modules, [f.options.resources.releaseBaseURL + 'startup.mjs']);
  assert.equal(f.observations.factories.length, 1);
  const forwarded = f.observations.factories[0];
  for (const name of ['project', 'artifact', 'authorization', 'catalog', 'ownedProviders']) {
    assert.equal(forwarded[name], f.options[name], name);
  }
  assert.equal(forwarded.container, f.surface.container);
  assert.equal(forwarded.controls, f.surface.controls);
  assert.deepEqual(forwarded.identity, f.options.identity);
  assert.notEqual(forwarded.identity, f.options.identity);
  assert.equal(service.snapshot().state, 'mounted');
  await service.close(); await service.close();
  assert.equal(f.observations.closes, 1);
  // Owned providers were transferred once, and are closed by original startup.
  assert.equal(f.observations.providersClosed, 0);
  assert.equal(service.snapshot().retainedCleanupResponsibility, false);
  assert.equal(service.snapshot().NodeBusinessACK, false);
  assert.equal(service.snapshot().MainBusinessACK, false);
});

test('foreign origin, non-release base and URL decorations are rejected before import', async () => {
  const { SimulatorWebProductService } = await productModule;
  for (const base of [
    `https://other.example.test/releases/${'b'.repeat(64)}/`,
    'https://app.example.test/technical-caller/',
    `https://app.example.test/releases/${'b'.repeat(64)}/?alternate=1`,
    `https://app.example.test/releases/${'b'.repeat(64)}/#fragment`,
  ]) {
    const f = fixture(); f.options.resources.releaseBaseURL = base;
    const service = new SimulatorWebProductService(f.provider, f.loader);
    await assert.rejects(service.mount(f.surface), { code: 'invalid-web-composition' });
    await service.close();
    assert.equal(f.observations.modules.length, 0);
    assert.equal(f.observations.providersClosed, 1);
  }
});

test('surface document mismatch is rejected before reading a project source', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(); f.surface.controls.ownerDocument = {};
  const service = new SimulatorWebProductService(f.provider, f.loader);
  await assert.rejects(service.mount(f.surface), { code: 'invalid-web-composition' });
  await service.close(); assert.equal(f.observations.reads, 0);
});

test('project activation change closes the mounted original startup', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), service = new SimulatorWebProductService(f.provider, f.loader);
  await service.mount(f.surface); f.activation.abort(); await service.close();
  assert.equal(f.observations.closes, 1);
  assert.equal(service.snapshot().state, 'closed');
  assert.throws(() => f.observations.factories[0].owner.requireCurrent());
});

test('revocation during module load never invokes the factory and joins original provider cleanup', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), loading = deferred(), entered = deferred();
  const service = new SimulatorWebProductService(f.provider, async () => { entered.resolve(); return loading.promise; });
  const mount = service.mount(f.surface); await entered.promise;
  f.activation.abort(); const closing = service.close(); loading.resolve(f.module);
  await assert.rejects(mount); await closing;
  assert.equal(f.observations.factories.length, 0);
  assert.equal(f.observations.providersClosed, 1);
});

test('late source composition after cancellation is adopted for provider cleanup', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), reading = deferred(), entered = deferred();
  const service = new SimulatorWebProductService({ readComposition() { entered.resolve(); return reading.promise; } }, f.loader);
  const mount = service.mount(f.surface); await entered.promise;
  const closing = service.close(); reading.resolve(f.composition);
  await assert.rejects(mount); await closing;
  assert.equal(f.observations.modules.length, 0);
  assert.equal(f.observations.providersClosed, 1);
});

test('resource and identity capture survives caller mutation during module import', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), loading = deferred(), entered = deferred();
  const service = new SimulatorWebProductService(f.provider, async () => { entered.resolve(); return loading.promise; });
  const mount = service.mount(f.surface); await entered.promise;
  f.options.identity.projectIdentity = 'later-project';
  f.options.resources.releaseBaseURL = 'https://other.example.test/later/';
  f.options.instanceAuthority.expectedSubjectHash = 'later-subject';
  loading.resolve(f.module); await mount;
  const captured = f.observations.factories[0];
  assert.equal(captured.identity.projectIdentity, 'project-original');
  assert.equal(captured.resources.releaseBaseURL, 'https://app.example.test/releases/' + 'b'.repeat(64) + '/');
  assert.equal(captured.instanceAuthority.expectedSubjectHash, 'a'.repeat(64));
  await service.close();
});

test('factory failure keeps provider cleanup at the normal caller', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(); f.module.createWebSimulatorStartup = () => { throw Error('original module rejected inputs'); };
  const service = new SimulatorWebProductService(f.provider, f.loader);
  await assert.rejects(service.mount(f.surface), /original module rejected inputs/);
  await service.close(); assert.equal(f.observations.providersClosed, 1);
});

test('activation revoked inside the factory still adopts and closes its returned handle', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(); f.module.createWebSimulatorStartup = () => { f.activation.abort(); return f.handle; };
  const service = new SimulatorWebProductService(f.provider, f.loader);
  await assert.rejects(service.mount(f.surface)); await service.close();
  assert.equal(f.observations.closes, 1);
  assert.equal(f.observations.providersClosed, 0);
});

test('bounded close preserves one outstanding cleanup and unconfirmed responsibility', async () => {
  const { SimulatorWebProductService } = await productModule;
  const f = fixture(), cleanup = deferred(); f.options.cleanupWaitMs = 15;
  f.handle.close = async () => { f.observations.closes++; await cleanup.promise; };
  const service = new SimulatorWebProductService(f.provider, f.loader); await service.mount(f.surface);
  await assert.rejects(service.close(), { code: 'cleanup-unconfirmed' });
  assert.equal(service.snapshot().retainedCleanupResponsibility, true);
  const retried = service.close(); cleanup.resolve(); await retried;
  assert.equal(f.observations.closes, 1);
  assert.equal(service.snapshot().state, 'closed');
  assert.equal(service.snapshot().WorkerPhysicalExitConfirmed, false);
});

test('normal routes select the explicit product caller before generic Child Tool routing', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/app/app.routes.ts'), 'utf8');
  const selected = routes.indexOf('path: "child-tool/simulator"');
  assert.ok(selected >= 0 && selected < routes.indexOf('path: "child-tool/:toolId"'));
  assert.match(routes.slice(selected, selected + 220), /simulator-web\/simulator-route\.component/);
  assert.match(routes, /path: "simulator",\s*redirectTo: "child-tool\/simulator"/);
});
