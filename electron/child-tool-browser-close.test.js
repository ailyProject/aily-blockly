'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Execute the original component methods with explicit DI ports. Rendering and
// the real Main/Node/Worker ACKs are covered by the local product acceptance.
const source = fs.readFileSync(path.join(__dirname, '../src/app/tools/child-tool-host/child-tool-host.component.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
const decorator = () => () => undefined;
const imports = new Proxy({}, { get: () => decorator });
const output = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => imports, output, output.exports);
const { ChildToolHostComponent } = output.exports;
function fixture(close) {
  const instance = Object.create(ChildToolHostComponent.prototype), calls = [];
  Object.assign(instance, { config: { runtime: { browserExecution: {} } }, closing: false,
    resolvedToolId: 'simulator', browserSurface: { close },
    uiService: { completeToolClose: id => calls.push(id) },
    notifyChildBeforeClose: () => { throw Error('Browser View has no iframe endpoint'); },
    processService: { forceStop: () => { throw Error('Shared runtime must not be force-stopped'); } },
  });
  Object.defineProperty(instance, 'isStandalone', { value: false });
  return { instance, calls };
}
test('strict Browser close waits for the original cleanup ACK and then removes the panel', async () => {
  let acknowledge; const ack = new Promise(resolve => { acknowledge = resolve; });
  const { instance, calls } = fixture(() => ack), pending = instance.close({ strict: true });
  await Promise.resolve(); assert.deepEqual(calls, []);
  acknowledge({ released: true, refCount: 0, acknowledged: true, physicalClosed: true });
  assert.equal((await pending).ok, true); assert.deepEqual(calls, ['simulator']);
});
test('failed Browser cleanup retains the panel and permits the exact cleanup retry', async () => {
  let attempts = 0;
  const { instance, calls } = fixture(async () => { if (++attempts === 1) throw Error('Node ACK missing'); return { released: true }; });
  assert.equal((await instance.close({ strict: true })).ok, false);
  assert.deepEqual(calls, []); assert.equal(instance.closing, false);
  assert.equal((await instance.close({ strict: true })).ok, true); assert.equal(attempts, 2);
});
test('legacy strict iframe close still respects its beforeClose refusal', async () => {
  const { instance, calls } = fixture(() => { throw Error('Not a Browser View'); });
  instance.config = {}; instance.notifyChildBeforeClose = async () => false;
  assert.equal((await instance.close({ strict: true })).ok, false); assert.deepEqual(calls, []);
});

const flushLifecycle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function legacyFixture({ reply = 'allow', detached = false, beforeDestroy } = {}) {
  const events = [], logs = [], timers = [];
  let response = reply, frameAlive = !detached, settleReply;
  const setTimer = (fire, delay) => { const timer = { fire, delay, cleared: false, fired: false }; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.cleared = true; };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', 'setTimeout', 'clearTimeout', compiled)(
    () => imports, module, module.exports,
    { info: (...values) => logs.push({ level: 'info', values }), error: (...values) => logs.push({ level: 'error', values }) },
    setTimer, clearTimer,
  );
  const instance = Object.create(module.exports.ChildToolHostComponent.prototype);
  Object.assign(instance, {
    config: {}, resolvedToolId: 'aily-chat', currentUrl: '', closing: false, presentationId: '',
    acquired: true, beforeCloseTask: null, settledCloseForDestroy: null,
    penpalRemoteWindow: {}, pendingExternalInputSignals: [],
    createHostContext: () => ({ toolId: instance.resolvedToolId, workspace: null }),
    clearAiOperationNotice() {}, setAilyChatOperationActive() {}, async closeNativeWebviewSurface() {},
    penpalConnection: { destroy() { events.push({ type: 'connection-destroyed' }); } },
    processService: {
      async release(toolId) { events.push({ type: 'release', toolId }); },
      async forceStop(toolId) { events.push({ type: 'force-stop', toolId }); },
    },
    message: { warning(message) { events.push({ type: 'warning', message }); } },
    remoteApi: { beforeClose({ reason }) {
      events.push({ type: 'beforeClose', reason, frameAlive });
      if (!frameAlive || response === 'never') return new Promise(() => {});
      if (response === 'deferred') return new Promise(resolve => { settleReply = resolve; });
      return Promise.resolve(response === 'refuse' ? { canClose: false, message: 'An owned task remains pending' } : { canClose: true, reason });
    } },
    uiService: { completeToolClose(toolId) {
      events.push({ type: 'remove-panel', toolId }); frameAlive = false;
      beforeDestroy?.(instance, events); instance.ngOnDestroy();
    } },
  });
  return { instance, events, logs, timers,
    reply(value) { response = value; },
    settleClose() { assert(settleReply); settleReply({ canClose: true }); },
    fireTimeout() { const timer = timers.find(t => !t.cleared && !t.fired); assert(timer); timer.fired = true; timer.fire(); },
  };
}

test('accepted legacy close destroys its original document without a duplicate RPC or delayed lease release', async () => {
  const f = legacyFixture();
  assert.equal((await f.instance.close()).ok, true); await flushLifecycle();
  assert.deepEqual(f.events.map(e => e.type), ['beforeClose', 'remove-panel', 'connection-destroyed', 'release']);
  assert.equal(f.timers.length, 1); assert.equal(f.timers[0].cleared, true);
  assert.equal(f.logs.filter(e => e.level === 'error').length, 0);
  f.instance.ngOnDestroy(); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 1);
});

for (const reply of ['refuse', 'never']) test('strict legacy ' + reply + ' retains its guard and permits a subsequent normal close retry', async () => {
  const f = legacyFixture({ reply }), pending = f.instance.close({ strict: true });
  await flushLifecycle(); if (reply === 'never') f.fireTimeout();
  assert.equal((await pending).ok, false); await flushLifecycle();
  assert.equal(f.instance.closing, false); assert.equal(f.instance.acquired, true);
  assert.equal(f.instance.settledCloseForDestroy, null);
  assert(!f.events.some(e => ['remove-panel', 'release', 'force-stop'].includes(e.type)));
  f.reply('allow'); assert.equal((await f.instance.close()).ok, true); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 2);
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
});

test('permitted non-strict timeout keeps its first real error and does not repeat it during destruction', async () => {
  const f = legacyFixture({ reply: 'never' }), pending = f.instance.close();
  await flushLifecycle(); f.fireTimeout(); assert.equal((await pending).ok, true); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 1);
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
  const failures = f.logs.filter(e => e.level === 'error'); assert.equal(failures.length, 1);
  assert.equal(failures[0].values[1], 'reason=close error=Timed out after 1500ms');
});

for (const detached of [false, true]) test('unprepared destruction keeps one best-effort close and exactly one release, detached=' + detached, async () => {
  const f = legacyFixture({ detached }); f.instance.ngOnDestroy(); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 1);
  if (detached) { assert(!f.events.some(e => e.type === 'release')); f.fireTimeout(); await flushLifecycle(); }
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
  f.instance.ngOnDestroy(); await flushLifecycle(); assert.equal(f.events.filter(e => e.type === 'release').length, 1);
});

for (const reason of ['restart', 'update']) test(reason + ' preparation is not reused as an ordinary close decision', async () => {
  const f = legacyFixture();
  const prepared = reason === 'update' ? (await f.instance.prepareUpdate({ strict: true })).ok
    : await f.instance.notifyChildBeforeClose(reason, true);
  assert.equal(prepared, true); assert.equal(f.instance.settledCloseForDestroy, null);
  assert.equal((await f.instance.close()).ok, true); await flushLifecycle();
  assert.deepEqual(f.events.filter(e => e.type === 'beforeClose').map(e => e.reason), [reason, 'close']);
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
});

for (const identity of ['tool', 'presentation', 'connection', 'window', 'remote']) test('an accepted close cannot authorize destruction of a changed ' + identity, async () => {
  const f = legacyFixture({ beforeDestroy(instance, events) {
    if (identity === 'tool') instance.resolvedToolId = 'other-child';
    if (identity === 'presentation') instance.presentationId = 'new-presentation';
    if (identity === 'connection') instance.penpalConnection = { destroy() { events.push({ type: 'new-connection-destroyed' }); } };
    if (identity === 'window') instance.penpalRemoteWindow = {};
    if (identity === 'remote') instance.remoteApi = { beforeClose({ reason }) {
      events.push({ type: 'beforeClose', reason, newDocument: true }); return Promise.resolve({ canClose: true });
    } };
  } });
  assert.equal((await f.instance.close()).ok, true); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 2);
  if (identity !== 'remote') { f.fireTimeout(); await flushLifecycle(); }
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
});

test('connection teardown invalidates a previously settled document close decision', () => {
  const f = legacyFixture(); f.instance.settledCloseForDestroy = { toolId: 'aily-chat' };
  f.instance.destroyPenpalConnection(); assert.equal(f.instance.settledCloseForDestroy, null);
});

test('an in-flight close is not a settled decision and its old response cannot authorize a new remote document', async () => {
  const f = legacyFixture({ reply: 'deferred' }), pending = f.instance.close(); await flushLifecycle();
  assert.equal(f.instance.closing, true); assert.equal(f.instance.settledCloseForDestroy, null);
  assert(!f.events.some(e => e.type === 'remove-panel' || e.type === 'release'));
  f.instance.remoteApi = { beforeClose({ reason }) {
    f.events.push({ type: 'beforeClose', reason, newDocument: true }); return Promise.resolve({ canClose: true });
  } };
  f.settleClose(); assert.equal((await pending).ok, true); await flushLifecycle();
  assert.equal(f.events.filter(e => e.type === 'beforeClose').length, 2);
  assert.equal(f.events.filter(e => e.newDocument).length, 1);
  assert.equal(f.events.filter(e => e.type === 'release').length, 1);
});


test('resize retries remeasure the viewport and keep Main bounds failures bounded', async t => {
  const text = fs.readFileSync(path.join(__dirname, '../src/app/tools/child-tool-browser-surface/child-tool-browser-surface.component.ts'), 'utf8');
  const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const module = { exports: {} }; new Function('require','module','exports',code)(() => imports,module,module.exports);
  const surface = Object.create(module.exports.ChildToolBrowserSurfaceComponent.prototype);
  let retries = 0, failures = [], calls = [], reject = true;
  Object.assign(surface, { destroyed: false, lastGeometry: '', geometryRetries: 0, active: true,
    geometry: () => ({ bounds: { x: 0, y: 0, width: 400 - retries, height: 300 }, visible: true }),
    handle: { update: async value => { calls.push(value); if (reject) throw Error('Embedded View bounds exceed its owner viewport'); } },
    schedule: () => { retries++; }, failed: { emit: error => failures.push(error) },
  });
  await surface.update(); assert.equal(retries,1); assert.equal(failures.length,0);
  reject=false; await surface.update(); assert.equal(calls[1].bounds.width,399); assert.equal(surface.geometryRetries,0);
  surface.lastGeometry=''; reject=true;
  for(let i=0;i<4;i++)await surface.update();
  assert.equal(retries,4); assert.equal(failures.length,1);
});
