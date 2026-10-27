const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Boundary tests use an explicit registry/host double; no Browser, Worker,
// account or original business ACK is inferred from these tests.
function load(relative) {
  const text = fs.readFileSync(path.join(__dirname, relative), 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(
    stripTypeScriptTypes(text, { mode: 'transform' })).toString('base64'));
}
const subject = load('../src/app/tools/child-tool-presentation/web-tool-lifecycle.ts');
const lifecycle = load('../src/app/services/integrations/subapps/operations/child-tool-close-lifecycle.ts');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function registry() {
  const entries = new Map();
  return { entries,
    register(toolId, controller, options) {
      const entry = { toolId, controller, options }; entries.set(options.instanceId, entry);
      return () => { if (entries.get(options.instanceId) === entry) entries.delete(options.instanceId); };
    } };
}

test('ordinary tool removal awaits the original close, including concurrent requests', async () => {
  const { registerWebToolLifecycle } = await subject;
  const { closeToolThroughLifecycle } = await lifecycle;
  const reg = registry(), waiting = deferred(); let calls = 0, removed = 0;
  const host = { close() { assert.equal(this, host); calls++; return waiting.promise; }, snapshot() { return { original: true }; } };
  const binding = registerWebToolLifecycle(reg, { toolId: 'a', instanceId: 'exact-a' }, host);
  const pending = binding.close(); assert.equal(binding.close(), pending);
  const close = closeToolThroughLifecycle({ childHostRegistered: true,
    requestChildClose: () => binding.close(), completeClose: () => { removed++; } });
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(removed, 0); assert.equal(reg.entries.size, 1);
  waiting.resolve(); assert.equal(await close, true); assert.equal(removed, 1); assert.equal(reg.entries.size, 0);
  const result = await pending; assert.equal(result.closeSettled, true);
  assert.equal(result.WorkerPhysicalExitConfirmed, false); assert.equal(result.NodeBusinessACK, false); assert.equal(result.MainBusinessACK, false);
  assert.equal(binding.snapshot().closing, false);
});

test('failed cleanup vetoes removal and remains registered for an exact retry', async () => {
  const { registerWebToolLifecycle } = await subject;
  const { closeToolThroughLifecycle } = await lifecycle;
  const reg = registry(); let calls = 0, removed = 0;
  const binding = registerWebToolLifecycle(reg, { toolId: 'a', instanceId: 'exact-a' }, {
    async close() { if (++calls === 1) throw Error('original cleanup unconfirmed'); }, snapshot: () => ({}) });
  const remove = () => closeToolThroughLifecycle({ childHostRegistered: true,
    requestChildClose: () => binding.close(), completeClose: () => { removed++; } });
  assert.equal(await remove(), false); assert.equal(removed, 0); assert.equal(reg.entries.size, 1);
  assert.equal(binding.snapshot().retainedCleanupResponsibility, true);
  assert.equal(await remove(), true); assert.equal(calls, 2); assert.equal(removed, 1); assert.equal(reg.entries.size, 0);
});

test('two presentations share only the existing registry and retire independently', async () => {
  const { registerWebToolLifecycle } = await subject;
  const reg = registry(); let bCloses = 0;
  const a = registerWebToolLifecycle(reg, { toolId: 'same-tool', instanceId: 'a' }, { close: async () => {}, snapshot: () => ({}) });
  registerWebToolLifecycle(reg, { toolId: 'same-tool', instanceId: 'b' }, { close: async () => { bCloses++; }, snapshot: () => ({}) });
  assert.equal(reg.entries.size, 2); assert.equal((await a.close()).ok, true);
  assert.equal(bCloses, 0); assert.deepEqual([...reg.entries.keys()], ['b']);
  const controller = reg.entries.get('b').controller;
  for (const action of ['prepareUpdate', 'restart', 'detach', 'embed']) assert.equal((await controller[action]()).ok, false);
  assert.equal(bCloses, 0); assert.equal((await controller.close()).ok, true); assert.equal(bCloses, 1);
});

test('legacy controller receipts keep their original presentation completion semantics', async () => {
  const { closeToolThroughLifecycle } = await lifecycle;
  let removed = 0;
  const close = result => closeToolThroughLifecycle({ childHostRegistered: true,
    requestChildClose: async () => result, completeClose: () => { removed++; } });
  assert.equal(await close({ ok: true }), true); assert.equal(removed, 0);
  assert.equal(await close({ ok: false, closeSettled: true }), false); assert.equal(removed, 0);
  assert.equal(await close({ ok: true, closeSettled: false }), true); assert.equal(removed, 0);
  assert.equal(await close({ ok: true, closeSettled: true }), true); assert.equal(removed, 1);
});
