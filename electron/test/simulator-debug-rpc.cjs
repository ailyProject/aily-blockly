'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), { EventEmitter } = require('node:events');
const { fixture } = require('./fixtures/build-delivery-fixture.cjs');
const { bindSimulatorDebugRpc } = require('../simulator-debug-rpc');
const { SubappOwnerSupervisor } = require('../subapp-owner-supervisor');
const debuggerRoot = process.env.AILY_TEST_DEBUGGER_ROOT || path.resolve(__dirname, '../../../aily-subapp/packages/simulator-debugger');
const { startDebuggerServer } = require(path.join(debuggerRoot, 'server'));
const { connectHostPeer } = require(path.join(debuggerRoot, 'runtime/host-client'));
const { scenario, delay, waitFor } = require(path.join(debuggerRoot, 'test/fixtures/rpc-build.cjs'));

for (const change of ['none', 'coder', 'source', 'board', 'project', 'owner-release', 'runtime-replaced', 'generation', 'cancel', 'timeout']) {
  test(`native owner -> duplex runtime -> selected firmware: ${change}`, async t => {
    const f = fixture(t, change === 'coder'), sender = Object.assign(new EventEmitter(), { id: 61, isDestroyed: () => false });
    f.state.owner.sender = sender;
    f.publish({ onMessage() {} });
    let started = false, closed = 0;
    const server = await startDebuggerServer({ runtimeManifestPath: path.join(f.root, 'unused.json'), evidenceRoot: path.join(f.root, '.temp/evidence'),
      backendFactory: async ({ onEvent }) => {
        started = true;
        if (change === 'source') f.put('main.h', 'changed');
        if (change === 'board') f.state.source.boardModule = 'other-board';
        if (change === 'project') f.state.source.activationId = require('node:crypto').randomUUID();
        return { identity: { engine: 'test-double' }, capabilities: ['uart.console'], resume: async () => {
          if (['none', 'coder', 'source', 'board', 'project'].includes(change)) onEvent({ type: 'uart', data: 'READY' });
        }, close: async () => { await delay(15); closed++; return { resources: { executionUnits: 0 } }; } };
      } });
    t.after(() => server.stop());
    const runtime = { streamId: 'owned-runtime', hostInfo: { wsUrl: server.publicInfo.wsUrl,
      runtimeConfig: { agent: { lifecycle: { ownerRelease: { method: 'runtime.owner.release' } } } } } };
    const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime, send: async () => {} });
    const owner = { ...supervisor.connect(sender), ownerSessionId: 'agent-owner-a', toolId: 'simulator-debugger' };
    await supervisor.track(sender, owner);
    const binding = await bindSimulatorDebugRpc({ connect: connectHostPeer, endpoint: server.hostWsUrl, supervisor,
      sender, owner, manifestPath: path.join(f.root, '.build/aily-artifact-manifest.json') });
    t.after(() => binding.close());
    const controller = new AbortController();
    const running = binding.run(scenario, { timeoutMs: change === 'timeout' ? 400 : 10000, signal: controller.signal });
    const outcome = running.then(report => ({ report }), error => ({ error }));
    await waitFor(() => started);
    if (change === 'owner-release') await supervisor.release(sender, owner);
    if (change === 'runtime-replaced') runtime.streamId = 'different-runtime';
    if (change === 'generation') sender.emit('render-process-gone');
    if (change === 'cancel') controller.abort();
    const result = await outcome;
    if (['none', 'coder', 'source', 'board', 'project'].includes(change)) {
      assert.equal(result.report?.outcome, 'passed', JSON.stringify(result)); assert.equal(result.report.hostInputVerification, undefined);

    } else assert.ok(result.error, JSON.stringify(result));
    if (change === 'timeout') assert.equal(result.error.code, 'RUN_TIMEOUT');
    assert.equal(closed, 1); assert.equal(server.status().active, false);
    await binding.close(); await supervisor.idle(); assert.equal(sender.listenerCount('destroyed'), 1); // Existing supervisor owns one.
  });
}

test('owner release during private connection setup cancels and joins initialization', async t => {
  const f = fixture(t), sender = Object.assign(new EventEmitter(), { id: 62, isDestroyed: () => false });
  f.state.owner.sender = sender;
  const runtime = { streamId: 'starting', nativeOwnerControl: true, hostInfo: { wsUrl: `ws://127.0.0.1:4000/ws?token=${'a'.repeat(64)}` } };
  const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime, send: async () => { throw new Error('Public control forbidden'); } });
  const owner = { ...supervisor.connect(sender), ownerSessionId: 'starting-owner', toolId: 'simulator-debugger' };
  await supervisor.track(sender, owner);
  let cleaning = false, cleaned = false;
  const binding = bindSimulatorDebugRpc({ sender, owner, supervisor, manifestPath: path.join(f.root, '.build/aily-artifact-manifest.json'), endpoint: runtime.hostInfo.wsUrl,
    connect: (_endpoint, _handler, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', async () => { cleaning = true; await delay(25); cleaned = true; reject(signal.reason); }, { once: true });
    }) });
  const rejected = assert.rejects(binding, { code: 'CANCELLED' });
  const releasing = supervisor.release(sender, owner);
  await waitFor(() => cleaning); assert.equal(cleaned, false);
  assert.equal((await releasing).ok, true); await rejected; assert.equal(cleaned, true);
});
