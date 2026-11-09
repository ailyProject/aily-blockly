// Actual generic Main dispatcher/Product source + actual normally built SDK.
// Only application callbacks/Main device port are memory fixtures. No Main,
// Electron, Native addon, device, network peer or MCU is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire, Module } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = process.env.AILY_CAPABILITY_ALIAS_SDK_ROOT || root;
const { build, transform } = createRequire(path.join(sdkRoot, 'package.json'))('esbuild');
const sdk = await import(pathToFileURL(sdkRoot + '/node_modules/@aily-project/simulator-host-sdk/dist/index.js'));
const protocol = await import(pathToFileURL(sdkRoot + '/node_modules/@aily-project/simulator-protocol/dist/public/host.js'));
const dispatcherFile = root + '/src/app/services/integrations/subapps/host-provider/subapp-host-provider-dispatcher.ts';
const compiled = await build({ entryPoints: [dispatcherFile], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const dispatcher = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const { SubappHostProviderDispatcher: Dispatcher, SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types } = dispatcher;
const productFile = root + '/src/app/integrations/simulator/simulator-host-provider-product.service.ts';
const transformed = await transform(await readFile(productFile, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } } });
const product = new Module(productFile); product.filename = productFile; product.paths = Module._nodeModulePaths(root);
product.require = name => name === '@angular/core' ? { Injectable: () => value => value, NgZone: class {} }
  : name === '@integration/subapps/public-api' ? dispatcher : name === '@aily-project/simulator-host-sdk' ? sdk
  : new Proxy({}, { get: () => function inertApplicationConstructorDependency() {} });
product._compile(transformed.code, productFile);
const tick = () => new Promise(resolve => setImmediate(resolve));
class Transport {
  sent = []; listener;
  onMessage(fn) { this.listener = fn; return () => { if (this.listener === fn) this.listener = undefined; }; }
  async send(message) { this.sent.push(structuredClone(message)); }
  async receive(type, payload) { this.listener?.({ type, version: 1, ...payload }); await tick(); await tick(); }
  async result(id) { for (let i = 0; i < 100; i++) { const row = this.sent.find(x => x.type === types.result && x.invocationId === id); if (row) return row.result; await tick(); } assert.fail('Actual dispatcher did not return original result'); }
}
const raw = (name, capability, payload) => ({ schemaVersion: 1, kind: 'aily-simulator-subapp-host-provider-invocation', invocationId: 'provider-invocation-v1-' + name.repeat(64),
  provider: 'gatt', providerRevision: 1, protocolVersion: 1, capability, deadlineUnixMs: Date.now() + 5000, payload });
const stateRequest = { schemaVersion: 1, kind: 'aily-host-gatt-producer-state-request' };
const state = { schemaVersion: 1, kind: 'aily-main-gatt-producer-state', producerId: 'main-producer', revision: 1, state: 'ready' };
const q = { schemaVersion: 1, kind: 'aily-host-gatt-provider-request', requestId: 'q1', requestSequence: 1, operation: 'catalog' };
const bound = { schemaVersion: 1, kind: 'aily-host-gatt-bound-provider-request', producerId: state.producerId, request: q };
const catalog = { schemaVersion: 1, kind: 'aily-host-connectivity-catalog', hostInstanceId: null, backends: [] };
function adapter(provider, capabilities, hook = () => {}) { return { provider, capabilities, protocolVersions: [1], async handleInvocation(invocation) {
  hook(invocation); return { result: { ...invocation, kind: 'aily-simulator-subapp-host-provider-result', completedAtUnixMs: Date.now(), status: 'succeeded', errorCode: null, payload: { source: provider } } };
}, createFailureResult(invocation, errorCode) { return { ...invocation, status: 'failed', errorCode, payload: null }; } }; }
function actualGatt() { const calls = []; return { calls, gatt: sdk.createSimulatorGattHostProviderAdapter({ bound: true,
  async bindingState() { calls.push('state'); return state; }, async request(id, request) { calls.push({ id, request }); return { schemaVersion: 1,
    kind: 'aily-host-gatt-bound-provider-result', producerId: id, result: { schemaVersion: 1, kind: 'aily-host-gatt-provider-result',
      requestId: request.requestId, requestSequence: request.requestSequence, operation: request.operation, ok: true, catalog } }; },
  async closeProducer(id) { calls.push({ closeProducer: id }); }, async close() { calls.push('close'); } }) }; }

test('default constructor keeps original namespace boundaries; aliases must belong to a registered adapter', () => {
  const a = actualGatt(); assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt] }), /capability is invalid/);
  assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [adapter('project', ['bluetooth.gatt'])] }), /capability is invalid/);
  for (const aliases of [{ missing: ['bluetooth.gatt'] }, { gatt: ['bluetooth.other'] }, { gatt: ['project.context.read'] }, { gatt: ['bluetooth.*'] }])
    assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: aliases }));
  assert.equal(a.calls.length, 0);
});

test('actual Product binding derives aliases from official SDK metadata and preserves Project, GATT state and bound business routing', async () => {
  const transport = new Transport(), calls = [];
  const service = Object.create(product.exports.SimulatorHostProviderProductService.prototype);
  service.openCurrentProjectScope = async () => ({ adapters: [adapter('project', ['project.context.read'], () => calls.push('project'))], async close() { calls.push('scope-close'); } });
  const session = await service.open({ toolId: 'simulator', hostInstanceId: 'workspace:test', transport, localGatt: {
    async bindingState() { calls.push('state'); return state; }, async request(id, request) { calls.push({ id, request }); return { schemaVersion: 1,
      kind: 'aily-host-gatt-bound-provider-result', producerId: id, result: { schemaVersion: 1, kind: 'aily-host-gatt-provider-result',
        requestId: request.requestId, requestSequence: request.requestSequence, operation: request.operation, ok: true, catalog } }; },
    async closeProducer() { assert.fail('No invalid/cancelled producer in positive route'); }, async close() { calls.push('gatt-close'); } } });
  try {
    assert.equal(calls.length, 0, 'Construction does not allocate a device or issue a state request.');
    await transport.receive(types.negotiationRequest, { request: protocol.createSimulatorSubappHostProviderNegotiationRequestV1('normal', { gatt: true }) });
    const offered = transport.sent.find(row => row.type === types.catalog); assert(offered);
    const actual = protocol.validateSimulatorSubappHostProviderCatalogV1(offered.catalog);
    assert.deepEqual(actual.providers.find(p => p.provider === 'gatt').capabilities, ['bluetooth.gatt', 'bluetooth.gatt.binding']);
    assert(actual.providers.some(p => p.provider === 'project'));
    const a = raw('a', 'bluetooth.gatt.binding', stateRequest); await transport.receive(types.invocation, { invocation: a });
    assert.deepEqual((await transport.result(a.invocationId)).payload, state);
    const b = raw('b', 'bluetooth.gatt', bound); await transport.receive(types.invocation, { invocation: b });
    const result = await transport.result(b.invocationId); protocol.validateHostGattBoundProviderExchangeV1(bound, result.payload);
    assert.equal(result.payload.producerId, state.producerId); assert.deepEqual(calls[1], { id: state.producerId, request: q });
    const p = { ...raw('c', 'project.context.read', {}), provider: 'project' }; await transport.receive(types.invocation, { invocation: p });
    assert.equal((await transport.result(p.invocationId)).payload.source, 'project'); assert(calls.includes('project'));
  } finally { await session.close(); }
  assert(calls.includes('scope-close') && calls.includes('gatt-close'));
});

test('one copied alias policy governs constructor, negotiation and invocation; caller mutation cannot extend it', async () => {
  const a = actualGatt(), list = [...a.gatt.capabilities], aliases = { [a.gatt.provider]: list };
  const d = new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: aliases }), transport = new Transport(); d.bindTransport(transport);
  list.push('bluetooth.foreign'); aliases.project = ['bluetooth.foreign'];
  try {
    await transport.receive(types.negotiationRequest, { request: { requestId: 'invalid', providers: [{ provider: 'gatt', protocolVersions: [1], requiredCapabilities: ['bluetooth.foreign'], optionalCapabilities: [] }] }, capabilityAliases: aliases });
    assert.equal(transport.sent.length, 0);
    await transport.receive(types.negotiationRequest, { request: { requestId: 'valid', providers: [{ provider: 'gatt', protocolVersions: [1], requiredCapabilities: ['bluetooth.gatt'], optionalCapabilities: ['bluetooth.gatt.binding'] }] } });
    assert.equal(transport.sent[0].requestId, 'valid');
    await transport.receive(types.invocation, { invocation: raw('d', 'bluetooth.foreign', {}), capabilityAliases: aliases });
    assert.equal(a.calls.length, 0);
    const valid = raw('e', 'bluetooth.gatt.binding', stateRequest); await transport.receive(types.invocation, { invocation: valid });
    assert.equal((await transport.result(valid.invocationId)).status, 'succeeded'); assert.deepEqual(a.calls, ['state']);
  } finally { await d.close(); }
});

test('aliases are bounded plain data; getters and caller iterators are not evaluated', () => {
  const a = actualGatt(); let reads = 0;
  const value = {}; Object.defineProperty(value, 'gatt', { enumerable: true, get() { reads++; return a.gatt.capabilities; } });
  assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: value }));
  const array = [...a.gatt.capabilities]; Object.defineProperty(array, '0', { get() { reads++; return 'bluetooth.gatt'; } });
  assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: { gatt: array } }));
  assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: { gatt: Array(65).fill('bluetooth.gatt') } }));
  assert.throws(() => new Dispatcher({ hostInstanceId: 'test', adapters: [a.gatt], capabilityAliases: { gatt: ['bluetooth.gatt', 'bluetooth.gatt'] } }));
  assert.equal(reads, 0);
});

test('aliases do not leak into another provider or another dispatcher', async () => {
  const a = actualGatt(), project = adapter('project', ['project.context.read']);
  const d = new Dispatcher({ hostInstanceId: 'first', adapters: [a.gatt, project], capabilityAliases: { gatt: a.gatt.capabilities } }), transport = new Transport(); d.bindTransport(transport);
  try {
    await transport.receive(types.negotiationRequest, { request: { requestId: 'cross', providers: [{ provider: 'project', protocolVersions: [1], requiredCapabilities: ['bluetooth.gatt'], optionalCapabilities: [] }] } });
    assert.equal(transport.sent.length, 0);
    await transport.receive(types.invocation, { invocation: { ...raw('f', 'bluetooth.gatt.binding', stateRequest), provider: 'project' } });
    assert.equal(a.calls.length, 0); assert.equal(transport.sent.length, 0);
    assert.throws(() => new Dispatcher({ hostInstanceId: 'second', adapters: [a.gatt] }), /capability is invalid/);
  } finally { await d.close(); }
});
