const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');

const base = path.join(__dirname, '../src/app');
function load(relative, imports = {}) {
  const filename = path.join(base, relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', source)(name => {
    if (!Object.hasOwn(imports, name)) throw Error('Unexpected controlled dependency: ' + name);
    return imports[name];
  }, exports);
  return exports;
}
const helper = load('integrations/simulator/blockly-simulator-web-prewarm.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
function activation(name = 'current', signal = new AbortController().signal) {
  return { path: '/projects/normal', projectSessionId: name, signal, requireCurrent() { signal.throwIfAborted(); } };
}
function fixture(t, overrides = {}) {
  const captured = activation(), jobs = new Set(), handles = [], result = { projectPath: captured.path, activation: { original: true } };
  let selection = { captured, revision: 1, code: 'original generated code' };
  const trigger = helper.createBlocklySimulatorPrewarmTrigger({
    readSelection: () => selection,
    schedule(work) { jobs.add(work); return () => jobs.delete(work); },
    prepare(current, signal) {
      const ready = deferred(); let closeCalls = 0, adopted = false;
      const handle = { ready: ready.promise,
        async readPublication(projectPath, consumer) {
          assert.equal(projectPath, current.path); consumer.throwIfAborted(); await ready.promise;
          consumer.throwIfAborted(); adopted = true; return result;
        },
        async close() { closeCalls++; await overrides.close?.(handle); },
        ...overrides.handle,
        control: { current, signal, ready, get closeCalls() { return closeCalls; }, get adopted() { return adopted; } },
      };
      handles.push(handle); return handle;
    },
  });
  t.after(async () => { for (const handle of handles) handle.control.ready.resolve(); await trigger.close(); });
  return { trigger, handles, result, captured,
    selection(value) { selection = value; },
    async flush() { const pending = [...jobs]; jobs.clear(); for (const work of pending) work(); await settle(); },
    async start() { trigger.notify(); await this.flush(); return handles.at(-1); },
  };
}

test('coalesced trusted events prepare once and same original activation is handed off without later trigger cancellation', async t => {
  const f = fixture(t); f.trigger.notify(); f.trigger.notify(); await f.flush();
  assert.equal(f.handles.length, 1); const handle = f.handles[0]; handle.control.ready.resolve(); await settle();
  f.trigger.notify(); await f.flush(); assert.equal(f.handles.length, 1);
  const selected = { ...f.captured, requireCurrent: f.captured.requireCurrent.bind(f.captured) };
  assert.equal(await f.trigger.readPreparedPublication(selected, new AbortController().signal), f.result);
  await f.trigger.invalidate(); assert.equal(handle.control.signal.aborted, false); assert.equal(handle.control.closeCalls, 0);
  assert.equal(f.trigger.snapshot().retainedPreparation, false);
  assert.equal(f.trigger.snapshot().claimed, 1);
});

test('same path/session with a different original signal waits for exact close before null fallback', async t => {
  const closing = deferred(), entered = deferred();
  const f = fixture(t, { async close() { entered.resolve(); await closing.promise; } });
  const handle = await f.start(); handle.control.ready.resolve();
  let done = false;
  const claim = f.trigger.readPreparedPublication(activation(f.captured.projectSessionId), new AbortController().signal).then(value => { done = true; return value; });
  await entered.promise; assert.equal(handle.control.signal.aborted, true); assert.equal(done, false);
  assert.equal(f.trigger.snapshot().retainedPreparation, true); closing.resolve();
  assert.equal(await claim, null); assert.equal(handle.control.closeCalls, 1);
});

test('failed preparation and unknown close retain the exact handle; only original successful retry permits fallback', async t => {
  let rejectClose = true;
  const f = fixture(t, { async close() { if (rejectClose) throw Error('Original cleanup unconfirmed'); } });
  const handle = await f.start(); handle.control.ready.reject(Error('Original Artifact is not available')); await settle();
  await assert.rejects(f.trigger.readPreparedPublication(f.captured, new AbortController().signal), /cleanup unconfirmed/);
  assert.equal(f.trigger.snapshot().retainedPreparation, true); assert.equal(f.handles.length, 1);
  rejectClose = false;
  assert.equal(await f.trigger.readPreparedPublication(f.captured, new AbortController().signal), null);
  assert.equal(f.trigger.snapshot().retainedPreparation, false);
});

test('claim cancellation keeps the original handle until its real claim and close join', async t => {
  const entered = deferred(), finish = deferred(), closing = deferred(); let ended = false;
  const f = fixture(t, { handle: {
    async readPublication(_path, signal) { entered.resolve(); await finish.promise; ended = true; signal.throwIfAborted(); },
    async close() { await finish.promise; await closing.promise; },
  } });
  const handle = await f.start(); handle.control.ready.resolve();
  const consumer = new AbortController(), claim = f.trigger.readPreparedPublication(f.captured, consumer.signal);
  void claim.catch(() => {}); await entered.promise; consumer.abort();
  let closed = false; const cleanup = f.trigger.invalidate().then(() => { closed = true; });
  await settle(); assert.equal(closed, false); assert.equal(ended, false); assert.equal(f.trigger.snapshot().retainedPreparation, true);
  finish.resolve(); await settle(); assert.equal(closed, false); closing.resolve();
  await cleanup; await assert.rejects(claim); assert.equal(f.trigger.snapshot().retainedPreparation, false);
});

test('changed generation never overlaps cleanup, skips superseded intent and prepares only the latest legal state', async t => {
  const closing = deferred(); let hold = true;
  const f = fixture(t, { async close() { if (hold) await closing.promise; } });
  const first = await f.start(); first.control.ready.resolve();
  const second = activation('second'), third = activation('third');
  f.selection({ captured: second, revision: 2, code: 'second' }); f.trigger.notify(); await f.flush();
  assert.equal(f.handles.length, 1); assert.equal(first.control.signal.aborted, true);
  f.selection({ captured: third, revision: 3, code: 'third' }); f.trigger.notify(); await f.flush();
  closing.resolve(); hold = false; await settle(); await f.flush();
  assert.equal(f.handles.length, 2); assert.equal(f.handles[1].control.current, third);
  f.selection(null); await f.trigger.invalidate(); f.trigger.notify(); await f.flush(); assert.equal(f.handles.length, 2);
});

test('actual provider factory wires original events once, defers activation selection until explicit post-init token, and never builds', async t => {
  const subject = () => { const listeners = new Set(); return { subscribe(listener) { listeners.add(listener); return { unsubscribe: () => listeners.delete(listener) }; }, next(value) { for (const listener of [...listeners]) listener(value); }, get size() { return listeners.size; } }; };
  class Token { constructor(name, options) { this.name = name; this.options = options; } }
  class Project {} class Builder {} class Blockly {} class Product {} class Router {}
  class NavigationStart {} class NavigationEnd {} class NavigationCancel {} class NavigationError {}
  const DESTROY = Symbol('DestroyRef'), ACTIVATION = Symbol('activation'), PUBLICATION = Symbol('publication');
  const destroys = [], dependencies = new Map(); let publicationCreates = 0;
  const captured = activation(), ready = deferred(), handles = [];
  const project = { currentProjectPath: captured.path, isProjectOpening: false, isAilyCodeProject: () => false,
    captureCurrentProjectActivation: () => captured, projectActivation$: subject(), projectOpeningChanged$: subject(), stateSubject: subject() };
  let revision = 1, code = 'current';
  const blockly = { getReusableGeneratedCode: () => code, getWorkspaceContentRevision: () => revision,
    workspaceContentRevisionChanged$: subject(), codeSubject: subject() };
  const router = { url: '/main/blockly-editor', events: subject() }, builder = { buildFinishedSubject: subject(), build() { assert.fail('Prewarm must not compile'); } };
  const publication = { async readPublication() { return { original: true }; }, async close() {}, snapshot: () => ({ original: true }),
    preparePublication(current, signal) { const handle = { ready: ready.promise, async readPublication() {}, async close() {} }; handles.push({ current, signal, handle }); return handle; } };
  const module = load('integrations/simulator/blockly-simulator-web.providers.ts', {
    '@angular/core': { DestroyRef: DESTROY, InjectionToken: Token, inject(token) { assert(dependencies.has(token), 'Unexpected eager dependency: ' + String(token?.name)); return dependencies.get(token); }, makeEnvironmentProviders: value => value },
    '@domain/project/public-api': { ProjectService: Project }, '@domain/build/public-api': { BuilderService: Builder },
    '@angular/router': { Router, NavigationStart, NavigationEnd, NavigationCancel, NavigationError },
    './simulator-host-provider-product.service': { SimulatorHostProviderProductService: Product },
    './simulator-web-project-activation.providers': { SIMULATOR_WEB_PROJECT_ACTIVATION: ACTIVATION },
    './simulator-web-app.providers': { SIMULATOR_WEB_PROJECT_PUBLICATION: PUBLICATION },
    './blockly-simulator-web-publication': { createBlocklySimulatorWebPublication() { publicationCreates++; return publication; } },
    '../../editors/blockly-editor/services/blockly.service': { BlocklyService: Blockly },
    './blockly-simulator-web-readiness': { readReadyBlocklySimulatorContext() { assert.fail(); } },
    './blockly-simulator-web-prewarm': helper,
  });
  const factory = module.provideBlocklySimulatorWebProject()[0].useFactory;
  dependencies.set(module.BLOCKLY_SIMULATOR_WEB_DEPLOYMENT, null);
  assert.equal(factory(), null); assert.equal(publicationCreates, 0);
  dependencies.set(module.BLOCKLY_SIMULATOR_WEB_DEPLOYMENT, {});
  dependencies.set(Project, project); dependencies.set(ACTIVATION, {});
  assert.equal(factory(), null); assert.equal(publicationCreates, 0, 'Browser/Coder is never paired with desktop read authority');
  dependencies.set(ACTIVATION, project); dependencies.set(Product, {}); dependencies.set(Blockly, blockly);
  dependencies.set(Router, router); dependencies.set(Builder, builder); dependencies.set(DESTROY, { onDestroy: callback => destroys.push(callback) });
  const facade = factory(); dependencies.set(PUBLICATION, facade);
  assert.equal(module.BLOCKLY_SIMULATOR_WEB_PREWARM.options.factory(), facade);
  t.after(async () => { ready.resolve(); await facade.close(); });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(handles.length, 1);
  revision++; code = null; blockly.workspaceContentRevisionChanged$.next(revision);
  assert.equal(handles[0].signal.aborted, true, 'Dirty event cancels before code generation publishes');
  blockly.codeSubject.next('pending'); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(handles.length, 1);
  router.events.next(new NavigationStart()); code = 'fresh'; blockly.codeSubject.next(code);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(handles.length, 1, 'No prewarm while navigation is pending');
  router.events.next(new NavigationEnd()); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(handles.length, 2);
  builder.buildFinishedSubject.next({ projectPath: '/projects/another', success: true }); await settle(); assert.equal(handles.length, 2);
  builder.buildFinishedSubject.next({ projectPath: captured.path, success: false }); assert.equal(handles[1].signal.aborted, true);
  await facade.close(); assert.equal(project.projectActivation$.size, 0); assert.equal(blockly.workspaceContentRevisionChanged$.size, 0); assert.equal(router.events.size, 0);
  assert.equal(destroys.length, 1);
  const config = ts.createSourceFile('app.config.ts', fs.readFileSync(path.join(base, 'app.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const calls = [];
  function visit(node) { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); } visit(config);
  const eager = calls.find(call => call.getText(config) === 'injector.get(BLOCKLY_SIMULATOR_WEB_PREWARM)');
  assert(eager);
  let parent = eager; while (parent && !ts.isArrowFunction(parent)) parent = parent.parent;
  assert(parent && parent.parent.getText(config).startsWith('inject(ElectronService).init().then('), 'Eager lookup is inside the original fulfilled Electron initializer');
});

test('the actual Blockly dirty method publishes its new revision synchronously at the unique increment point', () => {
  const file = ts.createSourceFile('blockly.service.ts', fs.readFileSync(path.join(base, 'editors/blockly-editor/services/blockly.service.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  let method;
  function visit(node) { if (ts.isMethodDeclaration(node) && node.name.getText(file) === 'markWorkspaceCodeDirty') method = node; ts.forEachChild(node, visit); } visit(file);
  assert(method);
  const events = [], Subject = class { next(value) { events.push(value); } };
  const declaration = ts.transpileModule(`class ActualDirtyMethod { workspaceCodeRevision=8; workspaceContentRevisionChanged=new Subject(); ${method.getText(file)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const Class = new Function('Subject', declaration + '\nreturn ActualDirtyMethod;')(Subject);
  const instance = new Class(); instance.markWorkspaceCodeDirty();
  assert.equal(instance.workspaceCodeRevision, 9); assert.deepEqual(events, [9]);
  assert.equal((file.text.match(/this\.workspaceCodeRevision\+\+/g) || []).length, 1);
  assert(file.text.includes('readonly workspaceContentRevisionChanged$ = this.workspaceContentRevisionChanged.asObservable()'));
});
