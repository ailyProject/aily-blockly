// Cross-repository, source-only controlled ports. No Electron, socket, Worker,
// chooser, Host provider, Core or MCU starts. Explicit frozen inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const sim = process.env.AILY_NODE_CONTROL_BUDGET_SIMULATOR_SOURCE_ROOT;
const protocolRoot = process.env.AILY_NODE_CONTROL_BUDGET_PROTOCOL_SOURCE_ROOT;
const baseMain = process.env.AILY_NODE_CONTROL_BUDGET_BASE_MAIN_ROOT;
if (!sim || !protocolRoot || !baseMain) {
  test('select budget source composition needs explicit frozen Simulator/protocol/baseline Main roots', { skip: true }, () => {});
} else {
  const require = createRequire(import.meta.url);
  const { build } = require('esbuild');
  const { SubappNodeControlBroker, TYPES } = require('./subapp-node-control-broker.js');
  const { SubappNodeControlBroker: OldBroker } = require(baseMain + '/electron/subapp-node-control-broker.js');
  const transportFile = '/packages/simulator-protocol/src/simulator-subapp-node-control-transport.ts';
  async function loadSource(filename) {
    const result = await build({ entryPoints: [filename], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
    return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
  }
  const { createBrowserShellPagePorts } = await loadSource(sim + '/packages/simulator-subapp-runtime/src/browser-shell-page-ports.ts');
  const fixed = await loadSource(protocolRoot + transportFile), original = await loadSource(sim + transportFile);
  const host = await import(pathToFileURL(sim + '/packages/simulator-protocol/dist/public/host.js'));
  const runtimeId = '11111111-1111-4111-8111-111111111111';
  const connectionId = '22222222-2222-4222-8222-222222222222';
  const launchId = 'launch-v1-' + 'a'.repeat(64);
  const payload = action => ({ schemaVersion: 1, kind: 'aily-project-scene-shell-request', operation: 'local-network', launchId, action });
  const frame = (body, timeoutMs, id = 'request-original') => ({ type: TYPES.request, version: 1, runtimeId, connectionId, requestId: id, timeoutMs, payload: body });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function through(Broker, input, validator) {
    const sent = [], replies = [];
    let broker;
    const record = { active: true, closed: false, guard() {}, assertCurrent() {}, target: { isDestroyed: () => false },
      lease: { runtimeId: 'registered-stream' }, runtimeId, connectionId, maxBytes: 1024 * 1024,
      controls: new Map(), pending: new Map(), seen: new Set(), sends: new Set(), port: { postMessage(value) { replies.push(value); } } };
    broker = new Broker({ MessageChannelMain: class Unused {}, resolveRuntime: () => ({ messagePort: {} }),
      async send(stream, value) {
        assert.equal(stream, 'registered-stream');
        if (validator) validator(value);
        sent.push(value);
        queueMicrotask(() => broker.handle(stream, { type: TYPES.result, version: 1, runtimeId, connectionId,
          requestId: value.requestId, ok: true, result: { originalTerminal: true } }));
        return { success: true };
      } });
    broker.connections.set(connectionId, record);
    broker.fromView(record, input);
    for (let i = 0; i < 10 && !replies.length; i++) await tick();
    assert.equal(replies.length, 1);
    assert.equal(record.pending.size, 0); assert.equal(broker.pendingCount, 0); assert.equal(broker.pendingBytes, 0);
    broker.connections.clear();
    return { sent, reply: replies[0] };
  }
  async function actualBrowserRequests() {
    const requests = [], grant = { schemaVersion: 1, kind: 'aily-project-scene-capability-grant', capabilityId: 'project:controlled',
      projectIdentity: 'controlled-project', sceneId: 'main', permissions: ['project.scene.inspect', 'project.scene.edit'],
      issuedAtUnixMs: Date.now(), expiresAtUnixMs: Date.now() + 120000, accessToken: 'q'.repeat(64) };
    const claim = { schemaVersion: 1, kind: 'aily-simulator-subapp-tool-launch-claim', launchId,
      view: { schemaVersion: 1, kind: 'aily-simulator-subapp-tool-project-view', toolId: 'scene', authorityKind: 'project.scene', projectIdentity: grant.projectIdentity, sceneId: grant.sceneId },
      capability: { schemaVersion: 1, kind: 'aily-simulator-subapp-browser-tool-capability', endpoint: { kind: 'browser-message-port', runtimeId }, toolId: 'scene', authorityKind: 'project.scene', grant } };
    const hostProviders = host.createSimulatorSubappHostProviderRuntimeSnapshotV1(host.negotiateSimulatorSubappHostProvidersV1(
      host.createSimulatorSubappHostProviderNegotiationRequestV1('controlled-network', { network: true }),
      { schemaVersion: 1, kind: 'aily-subapp-host-provider-catalog', hostInstanceId: 'controlled-host', providers: [{ provider: 'network', protocolVersions: [1], capabilities: ['network.ip'] }] }), 1);
    const project = { async request(body, signal, timeoutMs) {
      signal?.throwIfAborted(); let value;
      if (body.operation === 'bootstrap') value = { schemaVersion: 1, kind: 'aily-project-scene-browser-shell-bootstrap', hostProviders,
        launches: [{ launchId, projectIdentity: grant.projectIdentity, sceneId: grant.sceneId }], availability: { agentCandidates: false, sourceRebuild: false, debugger: false, instruments: false } };
      else if (body.operation === 'claim') value = claim;
      else { assert.equal(body.operation, 'local-network'); requests.push({ payload: body, timeoutMs });
        value = { schemaVersion: 1, kind: 'aily-scene-local-network-result', operation: body.action, ok: true,
          ...(body.action === 'select' ? { outcome: 'cancelled' } : body.action === 'release' ? { state: 'released' }
            : { catalog: { schemaVersion: 1, kind: 'aily-host-connectivity-catalog', hostInstanceId: null, backends: [] } }) }; }
      return { value, ports: [] };
    } };
    const ports = await createBrowserShellPagePorts({ runtimeId, project, execution: { request: async () => assert.fail('No Worker call') } }, new AbortController().signal);
    const actualClaim = await ports.launch.claimLaunch(launchId), local = ports.scene.localNetworkFactory(actualClaim);
    assert.equal(typeof local, 'function');
    for (const action of ['catalog', 'select', 'release']) await local(action, new AbortController().signal);
    return requests;
  }
  test('actual Browser Shell sends 60s select: both original gates fail and both fixed gates retain the unchanged frame', async () => {
    const requests = await actualBrowserRequests();
    assert.deepEqual(requests.map(r => [r.payload.action, r.timeoutMs]), [['catalog', 15000], ['select', 60000], ['release', 15000]]);
    const select = requests[1], input = frame(select.payload, select.timeoutMs);
    const before = await through(OldBroker, input); assert.equal(before.sent.length, 0); assert.equal(before.reply.errorCode, 'NODE_CONTROL_INVALID_REQUEST');
    assert.throws(() => original.validateSimulatorSubappNodeControlParentMessage(input), /Invalid Node control/);
    assert.deepEqual(fixed.validateSimulatorSubappNodeControlParentMessage(input), input);
    const after = await through(SubappNodeControlBroker, input, fixed.validateSimulatorSubappNodeControlParentMessage);
    assert.equal(after.sent.length, 1); assert.deepEqual(after.sent[0], input); assert.equal(after.reply.ok, true);
  });
  test('catalog/release and unknown action keep 30s caps; legal select caps exactly60s', async () => {
    for (const action of ['catalog', 'release', 'unknown']) for (const timeoutMs of [30001, 60000]) {
      const input = frame(payload(action), timeoutMs); assert.throws(() => fixed.validateSimulatorSubappNodeControlParentMessage(input));
      const value = await through(SubappNodeControlBroker, input); assert.equal(value.sent.length, 0); assert.equal(value.reply.errorCode, 'NODE_CONTROL_INVALID_REQUEST');
    }
    for (const timeoutMs of [60001, 300000]) { const input = frame(payload('select'), timeoutMs);
      assert.throws(() => fixed.validateSimulatorSubappNodeControlParentMessage(input)); assert.equal((await through(SubappNodeControlBroker, input)).sent.length, 0); }
    for (const timeoutMs of [100, 30000, 60000]) assert.equal((await through(SubappNodeControlBroker, frame(payload('select'), timeoutMs), fixed.validateSimulatorSubappNodeControlParentMessage)).sent.length, 1);
  });
  test('forged finite selection shape cannot borrow the60s exception at either gate', async () => {
    for (const change of [p => p.schemaVersion = 2, p => p.kind = 'forged', p => p.launchId = 'forged', p => p.scope = {}, p => p.action = 'release']) {
      const body = payload('select'); change(body); const input = frame(body, 60000);
      assert.throws(() => fixed.validateSimulatorSubappNodeControlParentMessage(input));
      const value = await through(SubappNodeControlBroker, input); assert.equal(value.sent.length, 0); assert.equal(value.reply.errorCode, 'NODE_CONTROL_INVALID_REQUEST');
    }
  });
  test('existing runtime/demonstration budgets and ordinary30s frames are unchanged', async () => {
    for (const body of [{ operation: 'runtime', action: 'start' }, { operation: 'runtime', action: 'recover' }, { operation: 'demonstration', request: { operation: 'prepare' } }, { operation: 'demonstration', request: { operation: 'command' } }]) {
      const input = frame(body, 300000); assert.deepEqual(fixed.validateSimulatorSubappNodeControlParentMessage(input), original.validateSimulatorSubappNodeControlParentMessage(input));
      assert.equal((await through(SubappNodeControlBroker, input, fixed.validateSimulatorSubappNodeControlParentMessage)).sent.length, 1);
    }
    const normal = frame({ method: 'controlled.read' }, 30000); assert.deepEqual(fixed.validateSimulatorSubappNodeControlParentMessage(normal), original.validateSimulatorSubappNodeControlParentMessage(normal));
    assert.equal((await through(SubappNodeControlBroker, normal, fixed.validateSimulatorSubappNodeControlParentMessage)).sent.length, 1);
  });
}
