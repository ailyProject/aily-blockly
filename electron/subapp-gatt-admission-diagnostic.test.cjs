'use strict';
// Actual Main owner and private sink; only typed memory control/composition
// ports are injected. No Main window, driver, radio, USB or MCU is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMainConnectivityProviderOwner } = require('./subapp-connectivity-provider-owner');
const { createGattAdmissionDiagnostic } = require('./subapp-gatt-main-ipc');
const LOG_ROOT = '/Volumes/data/aily-work/logs/w8-main-gatt-admission-diagnostic-20261108-a01';
const file = () => path.join(LOG_ROOT, 'gatt-admission-test-' + randomUUID() + '.ndjson');
const rows = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
function fixture(phase, observer = () => {}, { nullResult = false, cleanupFailure = false } = {}) {
  const calls = [], failure = Object.assign(new Error('private peer/token/value must never escape'), { code: 'unavailable' });
  const control = { requireCurrent() {}, async query() { calls.push('query'); if (phase === 'query-context' && !nullResult) throw failure; return { actual: true }; }, registerOwnerRelease() { return () => {}; } };
  let failCleanup = cleanupFailure;
  const composition = {
    context(value) { return phase === 'query-context' && nullResult ? null : value; },
    bind() { calls.push('bind'); if (phase === 'bind') throw failure; return { acquireGrantBackend() {}, async request() {}, async close() { calls.push('binding-close'); } }; },
    async close() { calls.push('composition-close'); if (failCleanup) throw new Error('Original retained cleanup'); },
  };
  const owner = createMainConnectivityProviderOwner({ MessageChannelMain: class { constructor() { assert.fail('No MessageChannel in failed admission'); } },
    async resolveOriginalOwnerControl() { calls.push('resolve'); if (phase === 'resolve-original-owner-control') { if (nullResult) return null; throw failure; } return control; },
    async acquireComposition() { calls.push('acquire'); if (phase === 'acquire-composition') throw failure; return composition; },
    onDiagnostic(stage, error) { calls.push(['diagnostic', stage, error]); observer(stage, error); },
  });
  return { owner, calls, failure, clearCleanupFailure() { failCleanup = false; }, input: { authority: { senderId: 1, toolId: 'simulator', streamId: 'memory-stream', bindingId: 'memory-binding' }, requireCurrentController() {} } };
}
for (const phase of ['resolve-original-owner-control', 'acquire-composition', 'query-context', 'bind']) {
  test('actual owner ' + phase + ' failure keeps original null/cleanup and diagnostic cannot replace it', async () => {
    const f = fixture(phase, () => { throw new Error('observer must remain optional'); });
    assert.equal(await f.owner.bind(f.input), null);
    const observed = f.calls.filter(x => Array.isArray(x)); assert.equal(observed.length, 1); assert.equal(observed[0][1], phase); assert.equal(observed[0][2], f.failure);
    assert.equal(f.calls.filter(x => x === 'composition-close').length, ['query-context', 'bind'].includes(phase) ? 1 : 0);
    assert.equal(f.calls.includes('binding-close'), false); await f.owner.dispose();
  });
}
test('ordinary no-control/no-context rejection is observed but never allocates a new owner or bypasses cleanup', async () => {
  for (const phase of ['resolve-original-owner-control', 'query-context']) {
    const f = fixture(phase, undefined, { nullResult: true }); assert.equal(await f.owner.bind(f.input), null);
    const observed = f.calls.filter(x => Array.isArray(x)); assert.equal(observed.length, 1); assert.equal(observed[0][1], phase);
    assert.equal(f.calls.includes('acquire'), phase === 'query-context'); assert.equal(f.calls.filter(x => x === 'composition-close').length, phase === 'query-context' ? 1 : 0);
    await f.owner.dispose();
  }
});
test('failed admission cleanup remains quarantined and only explicit close confirms the original retained resources', async () => {
  const f = fixture('query-context', undefined, { cleanupFailure: true }); const retained = await f.owner.bind(f.input);
  assert(retained && typeof retained.close === 'function'); await assert.rejects(retained.request({}), /fenced for cleanup/);
  assert.equal(f.calls.filter(x => x === 'composition-close').length, 1); f.clearCleanupFailure(); await retained.close();
  assert.equal(f.calls.filter(x => x === 'composition-close').length, 2); await f.owner.dispose();
});
test('private diagnostic defaults off and observes only bounded fixed vocabulary without reading error getters or values', () => {
  const target = file(), previous = process.env.AILY_W8_GATT_ADMISSION_DIAGNOSTIC_PATH;
  process.env.AILY_W8_GATT_ADMISSION_DIAGNOSTIC_PATH = target;
  const off = createGattAdmissionDiagnostic(); off('bind', new Error('Original connectivity control is unavailable.')); off.close(); assert.equal(fs.existsSync(target), false);
  if (previous === undefined) delete process.env.AILY_W8_GATT_ADMISSION_DIAGNOSTIC_PATH; else process.env.AILY_W8_GATT_ADMISSION_DIAGNOSTIC_PATH = previous;
  const active = file(), emit = createGattAdmissionDiagnostic({ file: active }); let getters = 0;
  const secret = Object.assign(new Error('peer secret-address token=private payload=123 uuid=redact-me'), { code: 'not-a-public-code', value: 'do-not-log-this', stack: 'private stack' });
  emit('bind', secret);
  const accessor = {}; for (const key of ['name', 'message', 'code', 'connectivityCode', 'value', 'stack', 'cause']) Object.defineProperty(accessor, key, { enumerable: true, get() { getters++; throw Error('must not run'); } });
  emit('query-context', accessor); emit('query-context', Object.assign(new TypeError('Invalid Session Bluetooth context identity.'), { code: 'invalid-input' }));
  emit('untrusted-secret-stage', secret); emit.close(); emit('bind', secret);
  assert.equal(getters, 0); const result = rows(active); assert.equal(result.length, 3); assert.equal(result[0].message, '[message redacted]'); assert.equal(result[0].errorCode, null);
  assert.equal(result[2].message, 'Invalid Session Bluetooth context identity.'); assert.equal(result[2].errorCode, 'invalid-input');
  const text = fs.readFileSync(active, 'utf8'); assert.doesNotMatch(text, /secret-address|private|123|redact-me|do-not-log-this|untrusted-secret-stage/); assert.equal(fs.statSync(active).mode & 0o777, 0o600);
});
test('private diagnostic log is bounded, refuses old files/symlinks/outside roots and never truncates retained evidence', () => {
  fs.mkdirSync(LOG_ROOT, { recursive: true }); const bounded = file(), emit = createGattAdmissionDiagnostic({ file: bounded });
  for (let i = 0; i < 256; i++) emit('bind', new Error('Original connectivity control is unavailable.')); emit.close(); assert.equal(rows(bounded).length, 128);
  const before = fs.readFileSync(bounded); const old = createGattAdmissionDiagnostic({ file: bounded }); old('bind', new Error('unavailable')); old.close(); assert.deepEqual(fs.readFileSync(bounded), before);
  const link = file(); fs.symlinkSync(bounded, link); const symlink = createGattAdmissionDiagnostic({ file: link }); symlink('bind', new Error('unavailable')); symlink.close(); assert.deepEqual(fs.readFileSync(bounded), before); assert(fs.lstatSync(link).isSymbolicLink());
  const outside = '/Volumes/data/aily-work/test-results/w8-main-gatt-admission-diagnostic-20261108-a01/outside-' + randomUUID() + '.ndjson';
  const invalid = createGattAdmissionDiagnostic({ file: outside }); invalid('bind', new Error('unavailable')); invalid.close(); assert.equal(fs.existsSync(outside), false);
});

test('actual GATT owner choose-peer observer preserves the original rejection before any Native scan', async () => {
  const { createMainGattProviderOwner } = require('./subapp-gatt-provider-owner');
  const api = require(process.env.AILY_GATT_TEST_PROVIDER_MODULE || '/Volumes/data/aily-work/work/w8-normal-product-20261108-a01/simulator-a01/package/distribution/local-gatt-backend.cjs');
  const scope = { worldId: 'world', nodeId: 'node', clockDomainId: 'clock' };
  const context = { schemaVersion: 1, kind: 'aily-session-bluetooth-context', sessionId: 'memory-session', sceneRevision: 'a'.repeat(64), runtimeGeneration: 1, runtimeTimeEpoch: 1, sessionState: 'running', unavailableReason: null,
    bluetooth: { descriptor: { schemaVersion: 1, kind: 'aily-bluetooth-controller-port', scope, profileId: 'memory-profile', executionId: 'memory-execution', framing: 'hci-h4-v1', controllerModes: ['le'], aclDataPacketBytes: 251,
      limits: { maxBufferedPackets: 4, maxBufferedBytes: 4096, maxReadPackets: 4, maxReadBytes: 4096, maxPendingWrites: 2 } },
    snapshot: { schemaVersion: 1, kind: 'aily-bluetooth-controller-snapshot', scope, generation: 1, timeEpoch: 1, connectionEpoch: 1, state: 'open', readSequence: 0, writeSequence: 0, readBufferedPackets: 0, readBufferedBytes: 0, writeQueueCreditPackets: 2, writeQueueCreditBytes: 4096, pendingWrites: 0, droppedPackets: 0, droppedBytes: 0 } } };
  let captured, scans = 0; const marker = new Error('original chooser rejection'), observed = [];
  const module = { ...api, createNodeHostGattProvider(options) { const provider = api.createNodeHostGattProvider(options); return { ...provider, bind(input) { captured = input.choosePeer; return provider.bind(input); } }; } };
  const control = { requireCurrent() {}, async query() { return context; }, async attach() { assert.fail('No Runtime attach'); }, async detach() {}, registerOwnerRelease() { return () => {}; } };
  const owner = createMainGattProviderOwner({ MessageChannelMain: class {}, dialog: { async showMessageBox() { assert.fail('No dialog in this injected rejection vector'); } }, getMainWindow: () => ({ isDestroyed: () => false }),
    resolveOriginalOwnerBluetoothControl: async () => control,
    loadComposition: async () => ({ provider: { module }, native: { module: { createHostGattNativeBackend: () => ({ scan() { scans++; assert.fail('No Native scan'); }, createDriver() { assert.fail('No driver'); }, releaseSelection() {}, async dispose() {} }) } }, async release() {} }),
    onDiagnostic(stage, error) { observed.push({ stage, error }); throw new Error('observer rejection'); } });
  const port = await owner.bind({ authority: { senderId: 1, toolId: 'simulator', streamId: 'memory-stream', bindingId: 'memory-binding' }, producerId: 'memory-producer', requireCurrentController() {}, async choosePeer() { throw marker; } });
  assert(port && captured); await assert.rejects(captured({}, new AbortController().signal), error => error === marker);
  assert.deepEqual(observed, [{ stage: 'choose-peer', error: marker }]); assert.equal(scans, 0); await port.close(); await owner.dispose();
});

test('actual installed-state env whitelist forwards only fixed opt-in to formal Simulator, never Native BLE', () => {
  const Module = require('node:module');
  const normalMain = '/Volumes/data/aily-work/work/w8-normal-product-20261108-a01/main-a02/source';
  const filename = path.join(normalMain, 'electron/subapp-manager.js');
  const manager = new Module(filename); manager.filename = filename; manager.paths = Module._nodeModulePaths(path.dirname(filename));
  // Compile current manager text, with real previously normal-built Main
  // dependency modules. No package installer or runnable entry is invoked.
  manager._compile(fs.readFileSync(path.join(__dirname, 'subapp-manager.js'), 'utf8'), filename);
  const root = '/Volumes/data/aily-work/work/w8-normal-activation-20261108-a02/private-activation-a02/subapps';
  const index = JSON.parse(fs.readFileSync(path.join(root, 'subapp-index.json'), 'utf8'));
  const key = 'AILY_PRIVATE_NODE_LOCAL_GATT_DIAGNOSTIC_V1', previous = process.env[key];
  try {
    for (const setting of [undefined, '0', '1']) {
      if (setting === undefined) delete process.env[key]; else process.env[key] = setting;
      const simulator = manager.exports.readInstalledState(root, index['aily-simulator']);
      const native = manager.exports.readInstalledState(root, index['ble-debugger']);
      assert.equal(simulator.installed, true); assert.equal(native.installed, true);
      assert.equal(simulator.config.packageName, '@aily-project/aily-simulator');
      assert.equal(simulator.config.env[key], setting === '1' ? '1' : undefined);
      assert.equal(Object.hasOwn(simulator.config.env, key), setting === '1');
      assert.equal(Object.hasOwn(native.config.env, key), false);
      assert.equal(simulator.config.env.AILY_SUBAPP_INSTALL_ROOT, root);
      assert.equal(native.config.env.AILY_SUBAPP_INSTALL_ROOT, root);
    }
  } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; }
});
