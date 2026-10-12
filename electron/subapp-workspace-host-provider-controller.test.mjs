import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const result = await build({
  entryPoints: [new URL('../src/app/services/integrations/subapps/host-provider/subapp-workspace-host-provider-controller.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const { SubappWorkspaceHostProviderController } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`,
);
const runtime = (streamId = 'stream-1') => ({ toolId: 'simulator', streamId, running: true, messagePort: {} });

function fixture(options = {}) {
  const calls = [];
  const port = {
    async bindMessageController(input) {
      calls.push(['bind', input.streamId, input.bindingId]);
      return { success: options.bindSuccess !== false,
        negotiationRequest: { type: 'negotiate', requestId: 'runtime-request' } };
    },
    async unbindMessageController(input) { calls.push(['unbind', input.streamId]); },
    async sendMessage(input) { calls.push(['send', input.streamId, input.message]); return { success: true }; },
  };
  const registry = {
    hasRegistration: toolId => toolId === 'simulator',
    async open(context) {
      calls.push(['open', context.hostInstanceId]);
      if (options.beforeOpen) await options.beforeOpen();
      const unbind = context.transport.onMessage(message => {
        calls.push(['received', message.type]);
        void context.transport.send({ type: message.type === 'negotiate' ? 'catalog' : 'accepted' });
      });
      return { async close() {
        calls.push(['close']);
        if (options.closeFailure) throw new Error('fixture close failure');
        await context.transport.send({ type: 'catalog', catalog: null });
        unbind();
      } };
    },
  };
  const controller = new SubappWorkspaceHostProviderController({
    port, registry, instanceId: 'workspace:test', onError: tool => calls.push(['error', tool]),
  });
  return { controller, calls };
}

test('passive workspace binding survives Agent owner removal with the same live UI Runtime', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [{ ...runtime(), refCount: 2 }]);
  await controller.update('project-a', [{ ...runtime(), refCount: 1 }]);
  controller.receive({ toolId: 'simulator', streamId: 'stream-1', message: { type: 'build' } });
  assert.equal(calls.filter(call => call[0] === 'open').length, 1);
  assert.equal(calls.filter(call => call[0] === 'received' && call[1] === 'build').length, 1);
  assert.equal(controller.snapshot()[0].ready, true);
  await controller.close();
});

test('last consumer Runtime removal withdraws callbacks and unbinds without starting or retaining a process', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [runtime()]);
  await controller.update('project-a', []);
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(calls.filter(call => call[0] === 'close').length, 1);
  const withdrawn = calls.findIndex(call => call[0] === 'send' && call[2].catalog === null);
  assert.ok(withdrawn >= 0 && withdrawn < calls.findIndex(call => call[0] === 'unbind'));
  await controller.close();
});

test('independent UI startup negotiates cached request through the main workspace dispatcher', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [runtime()]);
  assert.ok(calls.some(call => call[0] === 'received' && call[1] === 'negotiate'));
  assert.ok(calls.some(call => call[0] === 'send' && call[2].type === 'catalog'));
  await controller.close();
});

test('Runtime replacement rejects old stream messages and rebinds the new stream', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [runtime()]);
  await controller.update('project-a', [runtime('stream-2')]);
  controller.receive({ toolId: 'simulator', streamId: 'stream-1', message: { type: 'old-build' } });
  controller.receive({ toolId: 'simulator', streamId: 'stream-2', message: { type: 'build' } });
  assert.ok(!calls.some(call => call[1] === 'old-build'));
  assert.equal(controller.snapshot()[0].streamId, 'stream-2');
  assert.equal(calls.filter(call => call[0] === 'close').length, 1);
  await controller.close();
});

test('project switch and no-project scope close the previous authority before re-opening', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [runtime()]);
  await controller.update('project-b', [runtime()]);
  await controller.update(null, [runtime()]);
  assert.equal(controller.snapshot()[0].scope, null);
  assert.equal(calls.filter(call => call[0] === 'close').length, 2);
  assert.equal(calls.filter(call => call[0] === 'open').length, 3);
  await controller.close();
});

test('scope change while product opening cannot leave the stale authority bound', async () => {
  let release;
  let first = true;
  const { controller, calls } = fixture({ beforeOpen: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  } });
  const initial = controller.update('project-a', [runtime()]);
  await new Promise(resolve => setImmediate(resolve));
  const next = controller.update('project-b', [runtime()]);
  release();
  await Promise.all([initial, next]);
  assert.equal(controller.snapshot()[0].scope, 'project-b');
  assert.equal(calls.filter(call => call[0] === 'close').length, 1);
  await controller.close();
});

test('scope change rejects ingress before asynchronous reconciliation closes the old product', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [runtime()]);
  const changed = controller.update('project-b', [runtime()]);
  assert.equal(controller.snapshot()[0].ready, false);
  controller.receive({ toolId: 'simulator', streamId: 'stream-1', message: { type: 'stale-build' } });
  await changed;
  assert.ok(!calls.some(call => call[0] === 'received' && call[1] === 'stale-build'));
  await controller.close();
});

test('binding refusal fails closed and never opens product callbacks', async () => {
  const { controller, calls } = fixture({ bindSuccess: false });
  await controller.update('project-a', [runtime()]);
  assert.deepEqual(controller.snapshot(), []);
  assert.ok(!calls.some(call => call[0] === 'open'));
  assert.ok(calls.some(call => call[0] === 'error'));
  await controller.close();
});

test('cleanup failure still removes controller and stream binding', async () => {
  const { controller, calls } = fixture({ closeFailure: true });
  await controller.update('project-a', [runtime()]);
  await controller.close();
  assert.deepEqual(controller.snapshot(), []);
  assert.ok(calls.some(call => call[0] === 'unbind'));
});

test('unregistered, stopped and no-message-port tools preserve their existing lifecycle', async () => {
  const { controller, calls } = fixture();
  await controller.update('project-a', [
    { ...runtime(), toolId: 'plain' }, { ...runtime(), running: false },
    { ...runtime(), messagePort: null },
  ]);
  assert.deepEqual(calls, []);
  await controller.close();
});

test('temporary Agent and UI hosts do not construct or close workspace product providers', async () => {
  for (const relative of [
    '../src/app/services/integrations/subapps/subapp-agent-bridge.service.ts',
    '../src/app/tools/child-tool-host/child-tool-host.component.ts',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.ok(!/providerProducts\.open|providerSession|providerProductSession/.test(source));
  }
});
