const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');

// Presentation-only source cases: real component classes and lifecycle, explicit
// Angular/product doubles. No Browser, Runtime, account or business ACK inferred.
const base = path.join(__dirname, '../src/app');
function load(relative, imports = {}, globals = {}) {
  const filename = path.join(base, relative);
  const javascript = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(globals), javascript)(name => {
    if (!Object.hasOwn(imports, name)) throw Error(`Unexpected dependency: ${name}`);
    return imports[name];
  }, exports, ...Object.values(globals));
  return exports;
}
const angular = {
  Component: metadata => subject => { subject.metadata = metadata; },
  Input: () => () => {}, ViewChild: () => () => {},
  ChangeDetectionStrategy: { OnPush: 'OnPush' },
  ChangeDetectorRef: Symbol('change detector'),
};
const statusModule = load('tools/simulator-web/simulator-startup-status.component.ts', { '@angular/core': angular });
const agentModel = load('services/integrations/subapps/models/subapp-registered-agent.ts');
const lifecycleModule = load('tools/child-tool-presentation/web-tool-lifecycle.ts', {
  '../../services/integrations/subapps/models/subapp-registered-agent': agentModel,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); }
function fixture() {
  const mounted = deferred(), presented = deferred(), registrations = new Map();
  const calls = { present: 0, close: 0, agent: 0, changes: 0 };
  let closeFailure = false;
  const product = {
    mount: () => mounted.promise,
    present() { assert.equal(this, product); calls.present++; return presented.promise; },
    async close() { assert.equal(this, product); calls.close++; if (closeFailure) throw Error('cleanup uncertain'); },
    snapshot() { assert.equal(this, product); return { original: true }; },
    async agentRequest() { assert.equal(this, product); calls.agent++; return 'original-agent'; },
  };
  const sourceToken = Symbol('source'), registryToken = Symbol('registry');
  const registry = { register(id, controller, options) {
    registrations.set(options.instanceId, controller);
    return () => registrations.delete(options.instanceId);
  } };
  const { SimulatorWebComponent } = load('tools/simulator-web/simulator-web.component.ts', {
    '@angular/core': { ...angular, inject(token) {
      if (token === sourceToken) return {};
      if (token === registryToken) return registry;
      if (token === angular.ChangeDetectorRef) return { markForCheck() { calls.changes++; }, detectChanges() { calls.changes++; } };
      throw Error('Unknown injection');
    } },
    '../../integrations/simulator/simulator-web-product.service': { SimulatorWebProductService: class {
      constructor() { return product; }
    } },
    '../../integrations/simulator/simulator-web-product.providers': { SIMULATOR_WEB_PRODUCT_SOURCE: sourceToken },
    '../../services/integrations/subapps/child-app-host-registry.service': { ChildAppHostRegistryService: registryToken },
    '../child-tool-presentation/web-tool-lifecycle': lifecycleModule,
    './simulator-startup-status.component': statusModule,
  }, { window: {}, document: {} });
  const component = new SimulatorWebComponent();
  component.controls = { nativeElement: {} }; component.surface = { nativeElement: {} };
  component.ngAfterViewInit();
  const controller = [...registrations.values()][0];
  return { component, controller, mounted, presented, registrations, calls, failClose(value) { closeFailure = value; } };
}

test('loading labels follow project/view/error inputs and never imply MCU progress', () => {
  const component = new statusModule.SimulatorStartupStatusComponent();
  assert.equal(component.title, '正在准备仿真环境');
  component.phase = 'view'; assert.equal(component.title, '正在打开仿真视图');
  component.phase = 'error'; component.message = 'original cleanup remains unconfirmed';
  assert.equal(component.detail, component.message);
  const template = fs.readFileSync(path.join(base, 'tools/simulator-web/simulator-startup-status.component.html'), 'utf8');
  const styles = fs.readFileSync(path.join(base, 'tools/simulator-web/simulator-startup-status.component.scss'), 'utf8');
  assert.match(template, /phase === 'error' \? 'alert' : 'status'/u);
  assert.match(template, /aria-hidden="true"/u); assert.match(styles, /prefers-reduced-motion: reduce/u);
});

test('real mount and presentation settlements select phases and finally remove the overlay', async () => {
  const f = fixture(); assert.equal(f.component.phase, 'project');
  f.mounted.resolve(); await settle();
  assert.equal(f.component.phase, 'view'); assert.equal(f.calls.present, 1);
  f.presented.resolve(); await settle();
  assert.equal(f.component.phase, null);
  await f.controller.close();
});

test('close during project loading keeps late mount from presenting or revealing a loader', async () => {
  const f = fixture(); await f.controller.close();
  assert.equal(f.component.phase, null); assert.equal(f.registrations.size, 0);
  f.mounted.resolve(); await settle();
  assert.equal(f.calls.present, 0); assert.equal(f.component.phase, null);
});

test('close during presentation keeps its late success hidden and retires the same registration', async () => {
  const f = fixture(); f.mounted.resolve(); await settle();
  assert.equal(f.component.phase, 'view');
  await f.controller.close(); f.presented.resolve(); await settle();
  assert.equal(f.component.phase, null); assert.equal(f.calls.close, 1); assert.equal(f.registrations.size, 0);
});

test('destroy prevents late failure from restoring status or creating another product', async () => {
  const f = fixture(); f.component.ngOnDestroy();
  f.mounted.reject(Error('late startup failure')); await settle();
  assert.equal(f.component.phase, null); assert.equal(f.calls.present, 0);
  assert.equal(f.calls.close, 1); assert.equal(f.registrations.size, 0);
});

test('startup failure is static error and original cleanup failure retains the exact close retry', async () => {
  const f = fixture(); f.failClose(true);
  f.mounted.reject(Error('original provider failure')); await settle();
  assert.equal(f.component.phase, 'error'); assert.match(f.component.status, /清理尚未确认/u);
  assert.equal(f.registrations.size, 1); assert.equal(f.calls.close, 1);
  assert.equal((await f.controller.close()).ok, false); assert.equal(f.calls.close, 2);
  f.failClose(false); assert.equal((await f.controller.close()).ok, true);
  assert.equal(f.calls.close, 3); assert.equal(f.calls.present, 0); assert.equal(f.registrations.size, 0);
});

test('registered Agent calls still borrow the original product and are revoked after close', async () => {
  const f = fixture();
  assert.equal(await f.controller.agentRequest('status', {}, new AbortController().signal, 1000, {}), 'original-agent');
  assert.equal(f.calls.agent, 1); await f.controller.close();
  await assert.rejects(f.controller.agentRequest('status', {}, new AbortController().signal, 1000, {}),
    { code: 'SUBAPP_WEB_REVOKED' });
  f.mounted.resolve(); await settle();
});
