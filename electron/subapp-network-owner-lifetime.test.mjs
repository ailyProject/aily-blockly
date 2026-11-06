import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { SubappOwnerSupervisor } from './subapp-owner-supervisor.js';
import { SubappBrowserExecutionHost } from './subapp-browser-execution-host.js';
import { SubappBrowserProcessBroker } from './subapp-browser-process-broker.js';
import { acquireOwner, ownerKey, bindMessageController, unbindMessageController } from './child-tool-session-leases.js';

const bundled = await build({ entryPoints: [new URL('../src/app/services/integrations/subapps/host-provider/subapp-workspace-host-provider-controller.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { SubappWorkspaceHostProviderController } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('passive network catalog renewal preserves the real acknowledged supervisor/Browser owner and private control', async () => {
  const renderer = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
  const runtime = { toolId: 'simulator', streamId: 'original-stream', running: true, messagePort: {},
    hostInfo: { wsUrl: 'ws://127.0.0.1:44991/ws', runtimeConfig: { agent: { lifecycle: { ownerRelease: { method: 'fixture.release' } } } } } };
  const supervisor = new SubappOwnerSupervisor({ resolveRuntime: () => runtime, send: async () => {} });
  const generation = supervisor.connect(renderer).generation;
  const owner = { generation, ownerSessionId: 'original-real-owner', toolId: 'simulator' };
  await supervisor.track(renderer, owner);
  const guard = supervisor.createOwnerGuard(renderer, owner);
  const host = new SubappBrowserExecutionHost(), broker = new SubappBrowserProcessBroker({ host });
  const lease = { runtimeId: runtime.streamId, executionId: randomUUID(), ownerId: renderer.id, leaseId: owner.ownerSessionId };
  const key = ownerKey(lease.ownerId, lease.leaseId), connectionId = randomUUID(), ownerHandle = randomUUID();
  const node = { nodeBound: true, bindingId: connectionId, owner: { sessionId: lease.leaseId } };
  const binding = { node }, connection = { connectionId, key };
  const execution = { runtimeId: lease.runtimeId, executionId: lease.executionId, owners: new Map(),
    bindings: new Map([[key, binding]]), connections: new Map([[connectionId, connection]]),
    ownerHandles: new Map([[key, ownerHandle]]), retiring: new Set() };
  acquireOwner(execution, lease.ownerId, lease.leaseId); host.runtimes.set(lease.runtimeId, execution);
  const record = { key: JSON.stringify([lease.runtimeId, lease.executionId, lease.ownerId, lease.leaseId]), lease, guard, toolId: 'simulator', connection };
  broker.owners.set(record.key, record); broker.connections.set(connectionId, record);
  host.request = async (_state, type, input) => {
    assert.equal(type, 'network-context'); assert.equal(input.ownerHandle, ownerHandle);
    return { networkContext: { originalPrivateContext: true } };
  };
  const original = broker.resolveNetworkOwner({ runtimeId: runtime.streamId, ownerId: renderer.id, toolId: runtime.toolId });
  const control = host.createNetworkOwnerControl(original), opened = [], bindings = [];
  const controller = new SubappWorkspaceHostProviderController({ instanceId: 'passive-workspace',
    port: {
      async bindMessageController(input) { bindings.push(input.bindingId); return bindMessageController(runtime, renderer.id, input, renderer.id); },
      async unbindMessageController(input) { return unbindMessageController(runtime, renderer.id, input, renderer.id); },
      async sendMessage() { return { success: true }; },
    },
    registry: { hasRegistration: () => true, async open(context) {
      opened.push(context.hostInstanceId); return { async close() {} };
    } },
  });
  await controller.update('project-a', [runtime]);
  const first = bindings[0];
  await controller.networkLifetimeEnded({ toolId: runtime.toolId, streamId: runtime.streamId, bindingId: first });
  assert.equal(bindings.length, 2); assert.notEqual(bindings[1], first); assert.deepEqual(opened, bindings);
  guard(); control.requireCurrent(); assert.deepEqual(await control.query(), { originalPrivateContext: true });
  assert.equal(broker.owners.get(record.key), record); assert.equal(execution.bindings.get(key), binding);
  assert.equal(execution.bindings.get(key).node, node); assert.equal(execution.connections.get(connectionId), connection);
  assert.equal(execution.ownerHandles.get(key), ownerHandle); assert.equal(execution.owners.size, 1);
  const current = broker.resolveNetworkOwner({ runtimeId: runtime.streamId, ownerId: renderer.id, toolId: runtime.toolId });
  assert.equal(current.lease, lease); assert.equal(current.connectionId, connectionId); assert.equal(current.guard, guard);
  await controller.networkLifetimeEnded({ toolId: runtime.toolId, streamId: runtime.streamId, bindingId: first });
  assert.equal(bindings.length, 2); guard();
  await controller.close(); guard(); control.requireCurrent();
  await supervisor.release(renderer, owner);
  assert.throws(guard, /binding has ended/); assert.equal(broker.resolveNetworkOwner({ runtimeId: runtime.streamId, ownerId: renderer.id, toolId: runtime.toolId }), null);
});
