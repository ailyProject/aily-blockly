import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BehaviorSubject, Subject } from 'rxjs';

// Compile the current service and its real controller in memory, not installed dist.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/app/services/integrations/subapps/host-provider/subapp-workspace-host-provider.service.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{ name: 'angular-service-type-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'readiness-stub' }));
    builder.onResolve({ filter: /^@domain\/project\/public-api$/ }, () => ({ path: 'project', namespace: 'readiness-stub' }));
    builder.onLoad({ filter: /.*/, namespace: 'readiness-stub' }, ({ path }) => ({
      contents: path === 'angular'
        ? 'export const Injectable = () => value => value;'
        : 'export class ProjectService {}',
      loader: 'js',
    }));
  } }],
});
const { SubappWorkspaceHostProviderService } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`,
);

const runtime = (toolId = 'simulator', streamId = 'stream-1') => ({
  toolId, streamId, running: true, messagePort: {},
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function settled(predicate) {
  for (let turn = 0; turn < 40; turn++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'Controlled callback/reconciliation did not settle.');
}
async function turn() { await new Promise(resolve => setImmediate(resolve)); }

function fixture(t, options = {}) {
  const previousWindow = globalThis.window;
  const paths = new BehaviorSubject(options.root ?? '/a');
  const stateSubject = new BehaviorSubject(options.state ?? 'loaded');
  const openingChanged = new Subject();
  const activation = new Subject();
  let opening = options.opening ?? false;
  let loadedRoot = options.loadedRoot ?? paths.value;
  let coder = false;
  const project = {
    currentProjectPath$: paths.asObservable(), stateSubject,
    projectActivation$: activation.asObservable(),
    projectOpeningChanged$: openingChanged.asObservable(),
    get currentProjectPath() { return paths.value; },
    get isProjectOpening() { return opening || stateSubject.value === 'loading'; },
    isAilyCodeProject() { return coder; },
    getBlocklyProjectLoadStatus(root) {
      return { project: root, state: stateSubject.value, ready: !!root && root === paths.value && root === loadedRoot };
    },
  };
  const stateListeners = new Set(), messageListeners = new Set(), shutdownListeners = new Set();
  const calls = [], openedRoots = [], closedRoots = [];
  const gates = options.openGates ?? new Map();
  const listGate = options.listGate;
  let runtimes = options.runtimes ?? [runtime()];
  const listen = set => callback => { set.add(callback); return () => set.delete(callback); };
  const api = {
    onStateChanged: listen(stateListeners), onMessage: listen(messageListeners),
    onHostShutdown: listen(shutdownListeners),
    list: () => { calls.push(['list']); return listGate ? listGate.promise : Promise.resolve(runtimes); },
    async bindMessageController(input) { calls.push(['bind', input.toolId, input.streamId]); return { success: true }; },
    async unbindMessageController(input) { calls.push(['unbind', input.toolId, input.streamId]); return {success:true}; },
    async sendMessage(input) { calls.push(['send', input.toolId, input.message.type]); return { success: true }; },
  };
  const registry = {
    hasRegistration: toolId => toolId === 'simulator',
    async open(context) {
      const root = project.currentProjectPath;
      if (!root || project.isProjectOpening || (!coder && !project.getBlocklyProjectLoadStatus(root).ready)) return null;
      openedRoots.push(root);
      if (gates.has(root)) await gates.get(root).promise;
      if (options.failOpenRoots?.includes(root)) throw new Error('fixture Provider open failure');
      const remove = context.transport.onMessage(() => undefined);
      return { async close() { closedRoots.push(root); if(options.closeGate)await options.closeGate.promise;if(options.closeFailures){options.closeFailures--;throw Error('fixture close failure');} remove(); } };
    },
  };
  globalThis.window = { electronAPI: { childToolSession: api } };
  const service = new SubappWorkspaceHostProviderService(registry, project);
  const baseEvents = [], projectionEvents = [];
  const subscriptions = [
    service.readyBaseWorkspace$.subscribe(value => baseEvents.push(value)),
    service.readyWorkspaceChanges$.subscribe(() => projectionEvents.push(service.readReadyWorkspace('simulator'))),
  ];
  t.after(async () => {
    for (const gate of gates.values()) gate.resolve();
    listGate?.resolve(runtimes);
    await service.stop();
    for (const subscription of subscriptions) subscription.unsubscribe();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  service.start();
  return {
    service, project, calls, openedRoots, closedRoots, baseEvents, projectionEvents,
    shutdown(){for(const listener of shutdownListeners)listener();},
    begin(root) { opening = true; loadedRoot = ''; paths.next(root); stateSubject.next('loading'); openingChanged.next(); },
    markLoaded(root = paths.value) { loadedRoot = root; stateSubject.next('loaded'); },
    settleOpen() { opening = false; openingChanged.next(); },
    ready(root) { opening = false; loadedRoot = root; paths.next(root); stateSubject.next('loaded'); openingChanged.next(); },
    fail() { opening = false; loadedRoot = ''; stateSubject.next('error'); openingChanged.next(); },
    closeRoot() { opening = false; loadedRoot = ''; paths.next(''); stateSubject.next('default'); openingChanged.next(); },
    save(state) { stateSubject.next(state); },
    makeCoder() { coder = true; activation.next({ path: paths.value }); },
    runtimes(next) { runtimes = next; for (const listener of stateListeners) listener(next); },
  };
}

test('loading and loaded-before-exact-task-clear remain null, then B publishes without another path/state event', async t => {
  const f = fixture(t, { root: '/b', state: 'loading', opening: true, loadedRoot: '' });
  await turn();
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  f.markLoaded('/b');
  await turn();
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  f.settleOpen();
  await settled(() => f.service.readReadyWorkspace('simulator') === '/b');
  assert.equal(f.service.readyBaseWorkspace, '/b');
  assert.equal(f.baseEvents.at(-1), '/b');
  assert.equal(f.projectionEvents.at(-1), '/b');
});

test('failed stop retains controller for retry and cannot be bypassed by start',async t=>{
  const options={closeFailures:1},f=fixture(t,options);await settled(()=>f.service.readyBaseWorkspace==='/a');
  await assert.rejects(f.service.stop());assert.equal(f.service.readyBaseWorkspace,null);
  const count=f.calls.filter(c=>c[0]==='list').length;f.service.start();await turn();assert.equal(f.calls.filter(c=>c[0]==='list').length,count);
  await f.service.stop();assert.equal(f.closedRoots.length,2);
  f.service.start();await settled(()=>f.service.readReadyWorkspace('simulator')==='/a');
});

test('pending stop fences discovery and start until original product cleanup settles',async t=>{
  const closeGate=deferred(),f=fixture(t,{closeGate});await settled(()=>f.service.readyBaseWorkspace==='/a');
  const stop=f.service.stop();
  try{await turn();const count=f.calls.filter(c=>c[0]==='list').length;
  f.service.start();f.ready('/b');await turn();assert.equal(f.service.readyBaseWorkspace,null);assert.equal(f.calls.filter(c=>c[0]==='list').length,count);}
  finally{closeGate.resolve();await stop;}
  closeGate.resolve();await stop;f.service.start();await settled(()=>f.service.readReadyWorkspace('simulator')==='/b');
});

test('shutdown observes failed async cleanup and preserves the original retry',async t=>{
  const options={closeFailures:1},f=fixture(t,options);await settled(()=>f.service.readyBaseWorkspace==='/a');
  f.shutdown();await turn();await turn();assert.equal(f.service.readyBaseWorkspace,null);
  await f.service.stop();assert.equal(f.closedRoots.length,2);
});

test('registered Provider opening keeps both base and tool projection null until the real controller settles', async t => {
  const gate = deferred();
  const f = fixture(t, { root: '/b', openGates: new Map([['/b', gate]]) });
  await settled(() => f.openedRoots.includes('/b'));
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.equal(f.service.readReadyWorkspace('plain-tool'), '/b', 'Unregistered embedded tools retain their old raw-path contract.');
  gate.resolve();
  await settled(() => f.service.readyBaseWorkspace === '/b');
  assert.equal(f.service.readReadyWorkspace('simulator'), '/b');
});

test('late B Provider completion cannot publish B or overwrite the newer C root', async t => {
  const gate = deferred();
  const f = fixture(t, { root: '/b', openGates: new Map([['/b', gate]]) });
  await settled(() => f.openedRoots.includes('/b'));
  f.ready('/c');
  assert.equal(f.service.readyBaseWorkspace, null);
  gate.resolve();
  await settled(() => f.service.readReadyWorkspace('simulator') === '/c');
  assert.ok(!f.baseEvents.includes('/b'));
  assert.equal(f.baseEvents.at(-1), '/c');
  assert.ok(f.closedRoots.includes('/b'));
});

test('project loading failure withdraws both ready projections instead of publishing the failed root', async t => {
  const f = fixture(t);
  await settled(() => f.service.readReadyWorkspace('simulator') === '/a');
  f.begin('/b'); f.fail();
  await turn();
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.ok(!f.baseEvents.includes('/b'));
});

test('Provider opening failure leaves a newly loaded root unready', async t => {
  const f = fixture(t, { root: '/b', failOpenRoots: ['/b'] });
  await settled(() => f.calls.some(call => call[0] === 'unbind'));
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.ok(!f.baseEvents.includes('/b'));
});

test('saving and saved states preserve the already ready same-root Provider binding', async t => {
  const f = fixture(t);
  await settled(() => f.service.readReadyWorkspace('simulator') === '/a');
  const eventStart = f.baseEvents.length;
  f.save('saving'); f.save('saved');
  await turn();
  assert.equal(f.service.readyBaseWorkspace, '/a');
  assert.equal(f.service.readReadyWorkspace('simulator'), '/a');
  assert.ok(!f.baseEvents.slice(eventStart).includes(null));
  assert.equal(f.openedRoots.filter(root => root === '/a').length, 1);
});

test('closing the root withdraws ready state and retires its current binding', async t => {
  const f = fixture(t);
  await settled(() => f.service.readReadyWorkspace('simulator') === '/a');
  f.closeRoot();
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  await settled(() => f.closedRoots.includes('/a'));
  assert.equal(f.baseEvents.at(-1), null);
});

test('stop fences a late runtime discovery response and removes event subscriptions', async t => {
  const listGate = deferred();
  const f = fixture(t, { root: '/b', listGate });
  await f.service.stop();
  listGate.resolve([runtime()]);
  f.ready('/c'); f.runtimes([runtime('simulator', 'late-stream')]);
  await turn();
  assert.equal(f.service.readyBaseWorkspace, null);
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.deepEqual(f.openedRoots, []);
});

test('stop fences a late Provider-open result and closes that exact old session', async t => {
  const gate = deferred();
  const f = fixture(t, { root: '/b', openGates: new Map([['/b', gate]]) });
  await settled(() => f.openedRoots.includes('/b'));
  const stopped = f.service.stop();
  assert.equal(f.service.readyBaseWorkspace, null);
  gate.resolve(); await stopped;
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.ok(!f.baseEvents.includes('/b'));
  assert.deepEqual(f.closedRoots, ['/b']);
});

test('unrelated Runtime changes do not withdraw the same-root base projection', async t => {
  const f = fixture(t);
  await settled(() => f.service.readReadyWorkspace('simulator') === '/a');
  const eventStart = f.baseEvents.length;
  f.runtimes([runtime(), runtime('unregistered', 'plain-stream')]);
  await turn();
  assert.equal(f.service.readyBaseWorkspace, '/a');
  assert.equal(f.service.readReadyWorkspace('simulator'), '/a');
  assert.ok(!f.baseEvents.slice(eventStart).includes(null));
  assert.equal(f.openedRoots.filter(root => root === '/a').length, 1);
});

test('Coder base can publish while the registered simulator workspace remains null', async t => {
  const f = fixture(t, { root: '/coder' });
  f.makeCoder();
  await settled(() => f.service.readyBaseWorkspace === '/coder');
  assert.equal(f.service.readReadyWorkspace('simulator'), null);
  assert.equal(f.service.readReadyWorkspace('plain-tool'), '/coder');
});
