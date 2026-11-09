'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { createGattAdmissionDiagnostic } = require('./subapp-gatt-main-ipc');
const { createMainGattProviderOwner } = require('./subapp-gatt-provider-owner');
const logFile = () => path.join('/Volumes/data/aily-work/logs/w8-native-scan-diagnostic-20261108-a01', `gatt-admission-test-${randomUUID()}.ndjson`);
const read = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('existing private sink stores only closed Native scan stage/category and never reads raw failure fields', () => {
  const offFile = logFile(), off = createGattAdmissionDiagnostic(); off('native-scan-prepare', { scanCategory: 'adapter-unauthorized' }); off.close();
  assert.equal(fs.existsSync(offFile), false);
  const file = logFile(), sink = createGattAdmissionDiagnostic({ file }); let getters = 0;
  for (const stage of ['native-scan-create-runtime', 'native-scan-prepare', 'native-scan-on-candidate', 'native-scan-start', 'native-scan-retire'])
    sink(stage, { scanCategory: 'adapter-unauthorized', message: 'private device address', value: 'payload' });
  sink('native-scan-prepare', { scanCategory: 'arbitrary device value' });
  const accessors = {}; for (const key of ['scanCategory', 'message', 'stack', 'value', 'code'])
    Object.defineProperty(accessors, key, { get() { getters++; throw Error('must not inspect'); } });
  sink('native-scan-prepare', accessors); sink.close();
  assert.equal(getters, 0); const rows = read(file); assert.equal(rows.length, 7);
  assert.equal(rows[5].scanCategory, 'unknown'); assert.equal(rows[6].scanCategory, 'unknown');
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['at', 'kind', 'scanCategory', 'schemaVersion', 'stage']);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private device|payload|arbitrary device|stack|message/);
});

test('actual Main GATT owner connects the optional Native factory callback to the existing sink without scanning', async () => {
  const api = require(process.env.AILY_GATT_TEST_PROVIDER_MODULE || '/Volumes/data/aily-work/work/w8-gatt-message-port-20261108-a01/main-module-a01/local-gatt-backend.cjs');
  const scope = { worldId: 'world', nodeId: 'node', clockDomainId: 'clock' };
  const context = { schemaVersion: 1, kind: 'aily-session-bluetooth-context', sessionId: 'memory-session', sceneRevision: 'a'.repeat(64), runtimeGeneration: 1, runtimeTimeEpoch: 1, sessionState: 'running', unavailableReason: null,
    bluetooth: { descriptor: { schemaVersion: 1, kind: 'aily-bluetooth-controller-port', scope, profileId: 'memory-profile', executionId: 'memory-execution', framing: 'hci-h4-v1', controllerModes: ['le'], aclDataPacketBytes: 251,
      limits: { maxBufferedPackets: 4, maxBufferedBytes: 4096, maxReadPackets: 4, maxReadBytes: 4096, maxPendingWrites: 2 } },
    snapshot: { schemaVersion: 1, kind: 'aily-bluetooth-controller-snapshot', scope, generation: 1, timeEpoch: 1, connectionEpoch: 1, state: 'open', readSequence: 0, writeSequence: 0, readBufferedPackets: 0, readBufferedBytes: 0, writeQueueCreditPackets: 2, writeQueueCreditBytes: 4096, pendingWrites: 0, droppedPackets: 0, droppedBytes: 0 } } };
  const file = logFile(), sink = createGattAdmissionDiagnostic({ file }); let options, released = 0, disposed = 0;
  const control = { requireCurrent() {}, async query() { return context; }, async attach() { assert.fail('No Runtime attach'); }, async detach() {}, registerOwnerRelease() { return () => {}; } };
  const owner = createMainGattProviderOwner({ MessageChannelMain: class {}, dialog: { async showMessageBox() { assert.fail('No user interaction'); } }, getMainWindow: () => ({ isDestroyed: () => false }),
    resolveOriginalOwnerBluetoothControl: async () => control, onDiagnostic: sink,
    loadComposition: async () => ({ provider: { module: api }, native: { module: { createHostGattNativeBackend(input) { options = input; return {
      scan() { assert.fail('No scan'); }, createDriver() { assert.fail('No driver'); }, releaseSelection() {}, async dispose() { disposed++; } }; } } }, async release() { released++; } }) });
  const port = await owner.bind({ authority: { senderId: 1, toolId: 'simulator', streamId: 'memory', bindingId: 'memory-binding' }, producerId: 'memory-producer', requireCurrentController() {}, choosePeer: owner.choosePeer });
  assert(port && typeof options.onScanDiagnostic === 'function');
  options.onScanDiagnostic({ stage: 'prepare', category: 'adapter-powered-off', rawValue: 'never-forward' });
  options.onScanDiagnostic({ stage: 'createRuntime', category: 'raw-secret-value' });
  options.onScanDiagnostic({ stage: 'raw-secret-stage', category: 'unknown' });
  const poison = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('Diagnostic must not alter resources'); } });
  options.onScanDiagnostic(poison);
  await port.close(); await owner.dispose(); sink.close();
  assert.equal(disposed, 1); assert.equal(released, 1);
  const rows = read(file); assert.equal(rows.length, 2);
  assert.equal(rows[0].stage, 'native-scan-prepare'); assert.equal(rows[0].scanCategory, 'adapter-powered-off');
  assert.equal(rows[1].scanCategory, 'unknown'); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /raw-secret|never-forward/);
});
