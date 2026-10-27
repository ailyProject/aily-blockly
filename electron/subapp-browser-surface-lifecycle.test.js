'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');

// Unit ports only. Actual Angular DI, IPC, Worker and Node ACK acceptance is a
// separate product run; these tests exercise the original controller source.
const loaded = esbuild.build({
  stdin: { contents: [
    "export { SubappBrowserSurfaceService } from './src/app/services/integrations/subapps/subapp-browser-surface.service.ts';",
    "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
  ].join('\n'), resolveDir: path.resolve(__dirname, '..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'explicit-unit-ports', setup(build) {
    build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'unit' }));
    build.onResolve({ filter: /\/child-tool-process\.service$/ }, () => ({ path: 'process', namespace: 'unit' }));
    build.onLoad({ filter: /.*/, namespace: 'unit' }, args => ({ contents: args.path === 'angular'
      ? 'export const Injectable = () => target => target;'
      : 'export class ChildToolProcessService {}', loader: 'js' }));
  } }],
}).then(result => { const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports; });

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const geometry = { bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true };
const runtimeId = '11111111-1111-4111-8111-111111111111', processConnection = '22222222-2222-4222-8222-222222222222';
const viewConnection = '33333333-3333-4333-8333-333333333333';
async function fixture(t, options = {}) {
  const { SubappBrowserSurfaceService, replaceChildToolConfigs } = await loaded;
  replaceChildToolConfigs([{ id: 'fixture', runtime: { browserExecution: { protocol: 'aily-browser-execution-v1' } },
    ui: { surfaces: { full: { entry: 'ui/full.html' } } } }]);
  const previous = global.window, calls = []; let processReleased = 0;
  global.window = { electronAPI: { childToolSession: {
    async superviseOwner(input) { calls.push({ kind: 'supervisor', ...input });
      if (options.supervise) return options.supervise(input);
      return { ok: true, generation: 'actual-generation-fixture', tracked: true, handled: true }; },
    async browserExecution(input) { calls.push({ kind: 'browser', ...input });
      if (options.browser) { const result = await options.browser(input); if (result !== undefined) return result; }
      if (input.action === 'bindProcess') return { endpoint: { kind: 'browser-message-port', runtimeId }, connectionId: processConnection };
      if (input.action === 'openView') return { executionId: runtimeId, connectionId: viewConnection, presentation: 'embedded' };
      if (input.action === 'updateView') return { updated: true };
      if (input.action === 'closeView') return { detached: true, physicalClosed: true };
      if (input.action === 'release') return { released: true, refCount: 1 };
      throw Error('Unexpected fixture action');
    },
  } } };
  const service = new SubappBrowserSurfaceService({
    async acquire() { calls.push({ kind: 'process', action: 'acquire' }); await options.acquire?.promise; return { url: 'http://127.0.0.1/fixture' }; },
    async release() { calls.push({ kind: 'process', action: 'release' }); processReleased++; },
  });
  t.after(() => { global.window = previous; });
  return { service, calls, open: () => service.open('fixture', geometry), get processReleased() { return processReleased; } };
}

test('UI owns an independent binding; close joins View/owner ACK before its local process ref', async t => {
  const h = await fixture(t), handle = h.open(), ready = await handle.ready;
  assert.equal(ready.runtimeId, runtimeId); assert.equal(ready.connectionId, viewConnection);
  assert.ok(ready.ownerSessionId.startsWith('ui-'));
  assert.equal(h.calls.find(call => call.action === 'track').ownerSessionId, ready.ownerSessionId);
  await handle.update(geometry); const receipt = await handle.close();
  assert.deepEqual(receipt, { released: true, refCount: 1 }); assert.equal(h.processReleased, 1);
  const end = h.calls.slice(-3).map(call => call.kind + ':' + call.action);
  assert.deepEqual(end, ['browser:closeView', 'browser:release', 'process:release']);
  assert.equal(h.calls.some(call => call.action === 'dispose'), false);
  assert.equal(h.service.surfaces.size, 0); await handle.close(); assert.equal(h.processReleased, 1);
});

test('failed View close retains its exact record/ref and retries without disposing Agent generation', async t => {
  let closeAttempts = 0;
  const h = await fixture(t, { browser: input => { if (input.action === 'closeView' && ++closeAttempts === 1) throw Error('View detach ACK missing'); } });
  const handle = h.open(); await handle.ready;
  await assert.rejects(handle.close(), /View detach ACK missing/);
  assert.equal(h.processReleased, 0); assert.equal(h.service.surfaces.size, 1);
  assert.equal(h.calls.some(call => call.kind === 'browser' && call.action === 'release'), false);
  await h.service.retryClose(handle.ownerSessionId);
  assert.equal(h.processReleased, 1); assert.equal(h.service.surfaces.size, 0);
  assert.equal(h.calls.some(call => call.action === 'dispose'), false);
});

test('Node/business release rejection is preserved after View detaches and retains UI process ownership', async t => {
  let releases = 0;
  const h = await fixture(t, { browser: input => { if (input.action === 'release' && ++releases === 1) throw Error('Original Node business ACK unconfirmed'); } });
  const handle = h.open(); await handle.ready;
  await assert.rejects(handle.close(), /Original Node business ACK unconfirmed/);
  assert.equal(h.processReleased, 0); assert.equal(h.service.surfaces.size, 1);
  await handle.close(); assert.equal(h.processReleased, 1);
  assert.equal(h.calls.filter(call => call.action === 'closeView').length, 1);
  assert.equal(h.calls.filter(call => call.action === 'release' && call.kind === 'browser').length, 2);
});

test('a late process acquire joins cancellation and releases the local ref without starting a View', async t => {
  const acquire = deferred(), h = await fixture(t, { acquire }), handle = h.open();
  await Promise.resolve(); const rejected = assert.rejects(handle.ready, /closed during startup/), closed = handle.close();
  acquire.resolve(); await Promise.all([rejected, closed]);
  assert.equal(h.processReleased, 1); assert.equal(h.service.surfaces.size, 0);
  assert.equal(h.calls.some(call => call.action === 'openView'), false);
});

test('an incomplete final-owner receipt cannot release the UI process reference', async t => {
  const h = await fixture(t, { browser: input => input.action === 'release' ? { released: true, refCount: 0, acknowledged: false, physicalClosed: true } : undefined });
  const handle = h.open(); await handle.ready;
  await assert.rejects(handle.close(), /owner cleanup remains unconfirmed/);
  assert.equal(h.processReleased, 0); assert.equal(h.service.surfaces.size, 1);
});

test('a late successful View open after close is detached and released using the same original owner', async t => {
  const opened = deferred(), allocated = deferred();
  const h = await fixture(t, { browser: async input => { if (input.action === 'openView') { allocated.resolve(); await opened.promise; } } });
  const handle = h.open(), rejected = assert.rejects(handle.ready, /closed during startup/);
  await allocated.promise; const closed = handle.close(); opened.resolve(); await Promise.all([closed, rejected]);
  assert.equal(h.processReleased, 1); assert.equal(h.service.surfaces.size, 0);
  assert.equal(h.calls.filter(call => call.action === 'closeView').length, 1);
  const owners = h.calls.filter(call => call.kind === 'browser').map(call => call.ownerSessionId);
  assert.ok(owners.every(owner => owner === handle.ownerSessionId));
});
