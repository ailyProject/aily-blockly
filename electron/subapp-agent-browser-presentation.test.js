'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const esbuild = require('esbuild');
const fs = require('node:fs');
const ts = require('typescript');

// Explicit unit ports. Real BrowserProject/MCU acceptance remains a separate
// product run; these tests exercise the original Main lease and View sources.
const loaded = esbuild.build({
  stdin: { contents: [
    "export { SubappAgentBridgeService } from './src/app/services/integrations/subapps/subapp-agent-bridge.service.ts';",
    "export { SubappBrowserSurfaceService } from './src/app/services/integrations/subapps/subapp-browser-surface.service.ts';",
    "export { SubappBrowserPresentationService, SUBAPP_BROWSER_PRESENTATION } from './src/app/services/integrations/subapps/subapp-browser-presentation.service.ts';",
    "export { MainUiAutomationService } from './src/app/services/integrations/automation/main-ui-automation.service.ts';",
    "export { AutomationUiAdapter } from './src/app/integrations/automation/automation-ui.adapter.ts';",
    "export { SubappAutomationAdapter } from './src/app/integrations/subapps/subapp-automation.adapter.ts';",
    "export { replaceChildToolConfigs, getChildToolConfig } from './src/app/configs/tool.config.ts';",
  ].join('\n'), resolveDir: path.resolve(__dirname, '..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'explicit-unit-ports', setup(build) {
    build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular', namespace: 'unit' }));
    build.onResolve({ filter: /^@ngx-translate\/core$/ }, () => ({ path: 'translate', namespace: 'unit' }));
    build.onResolve({ filter: /^@integration\/subapps\/public-api$/ }, () => ({ path: 'registry', namespace: 'unit' }));
    build.onResolve({ filter: /^@core\/app-shell\/public-api$/ }, () => ({ path: 'ui', namespace: 'unit' }));
    build.onResolve({ filter: /^@integration\/automation\/public-api$/ }, () => ({ path: 'automation-types', namespace: 'unit' }));
    build.onResolve({ filter: /\/ui-automation-registry\.service$/ }, () => ({ path: 'automation', namespace: 'unit' }));
    build.onResolve({ filter: /\/child-tool-process\.service$/ }, () => ({ path: 'process', namespace: 'unit' }));
    build.onLoad({ filter: /.*/, namespace: 'unit' }, args => ({ contents: {
      angular: 'export const Injectable = () => target => target; export const Inject = () => () => {}; export const Optional = () => () => {}; export class InjectionToken {}',
      translate: 'export class TranslateService {}', registry: 'export class ChildAppHostRegistryService {}',
      automation: 'export class UiAutomationRegistryService {}', process: 'export class ChildToolProcessService {}',
      ui: 'export class UiService {}', 'automation-types': `export { MainUiAutomationService } from ${JSON.stringify(path.resolve(__dirname, '../src/app/services/integrations/automation/main-ui-automation.service.ts'))};`,
    }[args.path], loader: 'js' }));
  } }],
}).then(result => { const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports; });

const geometry = { bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true };
const runtimeId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function actualUiService(getChildToolConfig, childHosts) {
  const filename = path.resolve(__dirname, '../src/app/services/core/app-shell/ui.service.ts');
  const javascript = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  const ignoredInjectedPorts = new Set(['@core/platform/public-api', '../../../tools/terminal/terminal.service',
    '@angular/router', '../../../components/feedback-dialog/feedback-dialog.component', 'ng-zorro-antd/modal',
    'ng-zorro-antd/message', '../../../components/project-setting-dialog/project-setting-dialog.component',
    '@core/preferences/public-api', '../../../main-window/components/board-selector-dialog/board-selector-dialog.component',
    '@integration/subapps/public-api', './project-window-lifecycle', './workflow.service']);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', javascript)(name => {
    if (name === '@angular/core') return { Injectable: () => value => value };
    if (name === 'rxjs') return require('rxjs');
    if (name === '@core/auth/public-api') return { isAuthRequiredTool: () => false };
    if (name === '../../../configs/tool.config') return { getChildToolConfig };
    if (ignoredInjectedPorts.has(name)) return {};
    throw Error('Unexpected UI unit port: ' + name);
  }, module, module.exports);
  return new module.exports.UiService(null, null, null, { isLoggedIn: true }, null, null, null, childHosts, null);
}

async function fixture(t, options = {}) {
  const { SubappAgentBridgeService, SubappBrowserSurfaceService, SubappBrowserPresentationService,
    SUBAPP_BROWSER_PRESENTATION, replaceChildToolConfigs, getChildToolConfig, MainUiAutomationService, AutomationUiAdapter, SubappAutomationAdapter } = await loaded;
  replaceChildToolConfigs([{ id: 'fixture', titleKey: 'Fixture', runtime: options.native ? {} : { browserExecution: { protocol: 'aily-browser-execution-v1' } },
    ui: { surfaces: { full: { entry: 'ui/full.html' } } },
    agent: { protocolVersion: 1, transport: 'aily-child-rpc', lifecycle: {
      ownerRelease: { method: 'fixture.owner.release' }, sessionRelease: { method: 'fixture.session.release' },
    }, tools: [{ name: 'fixture_tool', rpc: { method: 'fixture.work' },
      ...(options.presentation ? { presentation: options.presentation } : {}) }] } }]);
  const calls = [], handles = [], registry = new SubappBrowserPresentationService();
  const previousWindow = global.window, previousWebSocket = global.WebSocket;
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2; readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(text) { const message = JSON.parse(text); calls.push({ kind: 'rpc', ...message });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, ok: true, result: {} }) }))); }
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  global.WebSocket = Socket;
  global.window = { electronAPI: { childToolSession: {
    async superviseOwner(input) { calls.push({ kind: 'supervisor', ...input });
      return { ok: true, generation: 'fixture-generation', tracked: true, handled: true }; },
    async browserExecution(input) { calls.push({ kind: 'browser', ...input });
      const override = await options.browser?.(input); if (override !== undefined) return override;
      if (input.action === 'bindProcess') return { endpoint: { kind: 'browser-message-port', runtimeId }, connectionId };
      if (input.action === 'openView') return { executionId: runtimeId, connectionId, presentation: 'embedded' };
      if (input.action === 'closeView') return { detached: true, physicalClosed: true };
      if (input.action === 'updateView') return { updated: true };
      if (input.action === 'release') return { released: true, refCount: 1 };
      throw Error('Unexpected Browser operation: ' + input.action);
    },
  } } };
  const processes = { async acquire() { calls.push({ kind: 'process', action: 'acquire' }); return { wsUrl: 'ws://fixture' }; },
    async release() { calls.push({ kind: 'process', action: 'release' }); } };
  const surfaces = new SubappBrowserSurfaceService(processes, registry);
  let ui, mainAutomation;
  const mountErrors = [];
  if (options.mountLifecycle) {
    const hosts = { ensureInitialized() {}, has: () => false };
    ui = actualUiService(getChildToolConfig, hosts);
    const complete = ui.completeToolPresentationClose.bind(ui);
    ui.completeToolPresentationClose = (tool, grant) => { options.completeMount?.(); complete(tool, grant); };
    ui.actionSubject.subscribe(action => {
      calls.push({ kind: 'ui-shell', ...action });
      if (action.action !== 'open') return;
      const grant = ui.toolPresentationIds['fixture'];
      void (async () => {
        await options.mountGate?.promise;
        const handle = surfaces.open('fixture', geometry, grant); handles.push(handle);
        await handle.ready;
      })().catch(error => mountErrors.push(error));
    });
    mainAutomation = new MainUiAutomationService({}, hosts, new AutomationUiAdapter(ui), { instant: value => value }, registry);
    mainAutomation.readWindowState = async () => { await options.readWindowState?.(); return { open: false }; };
  }
  const automation = {
    async isChildAppWindowOpen() { calls.push({ kind: 'automation', action: 'window-state' }); return false; },
    async waitForChildAppHostReady() { calls.push({ kind: 'automation', action: 'legacy-host-ready' }); return { ok: true }; },
    async openChildApp(input) {
    calls.push({ kind: 'automation', action: 'open', input });
    await options.beforeOpen?.();
    if (options.native) return { ok: true };
    if (mainAutomation) return mainAutomation.openChildApp(input);
    if (input[SUBAPP_BROWSER_PRESENTATION]) registry.registerMount('fixture', input[SUBAPP_BROWSER_PRESENTATION], () => undefined);
    const handle = surfaces.open('fixture', geometry, input[SUBAPP_BROWSER_PRESENTATION]); handles.push(handle);
    await handle.ready; return { ok: true };
  }, async focusChildAppPresentation(toolId, presentationId) {
    calls.push({ kind: 'automation', action: 'focus-owned', toolId, presentationId });
    if (mainAutomation) return mainAutomation.focusChildAppPresentation(toolId, presentationId);
    registry.requireReusableMount(toolId, presentationId); return { ok: true };
  } };
  const activity = { releaseSession() {}, recordRuntimeState() {}, recordInvocationStarted() {}, recordInvocationCompleted() {} };
  // Match app.config's production SUBAPP_AUTOMATION_PORT provider. Every
  // presentation test crosses this adapter, including the actual Main UI path.
  const bridge = new SubappAgentBridgeService(processes, new SubappAutomationAdapter(automation), activity, null, 'native', {}, {}, registry);
  t.after(async () => {
    for (const handle of handles) await handle.close().catch(() => undefined);
    for (const owner of [...bridge.ownerLeases.leases.values()]) await bridge.ownerLeases.release(owner.ownerLeaseId).catch(() => undefined);
    await bridge.ownerGuard.close().catch(() => undefined); bridge.ngOnDestroy();
    global.window = previousWindow; global.WebSocket = previousWebSocket;
  });
  return { bridge, surfaces, registry, handles, calls, ui, mountErrors,
    acquire: sessionId => bridge.manageOwnerLease({ action: 'acquire', sessionId }),
    execute: (lease, params = {}) => bridge.execute({ toolId: 'fixture', tool: 'fixture_tool', params }, undefined,
      { sessionId: lease.sessionId, ownerLeaseId: lease.ownerLeaseId, toolCallId: crypto.randomUUID() }),
    present: lease => bridge.manageOwnerLease({ action: 'present', toolId: 'fixture', ...lease }),
    release: lease => bridge.manageOwnerLease({ action: 'release', ...lease }),
  };
}

test('same-owner Agent presentation borrows the original binding; closing the View preserves Agent work', async t => {
  const h = await fixture(t), lease = await h.acquire('chat-a');
  assert.equal((await h.execute(lease)).ok, true);
  const presented = await h.present(lease); assert.equal(presented.ok, true);
  assert.equal(presented.ownerSessionId, lease.ownerLeaseId); assert.equal(presented.runtimeId, runtimeId);
  const browser = h.calls.filter(value => value.kind === 'browser');
  assert.deepEqual(browser.map(value => value.action), ['bindProcess', 'bindProcess', 'openView']);
  assert.ok(browser.every(value => value.ownerSessionId === lease.ownerLeaseId));
  assert.equal(h.calls.filter(value => value.action === 'track').length, 1);
  await h.handles[0].close();
  assert.equal(h.calls.filter(value => value.action === 'release' && value.kind === 'supervisor').length, 0);
  assert.equal(h.calls.filter(value => value.kind === 'process' && value.action === 'release').length, 1);
  assert.equal(h.bridge.channels.get('fixture').sessionIds.has(lease.ownerLeaseId), true);
  assert.equal((await h.execute(lease)).ok, true);
  assert.equal((await h.release(lease)).ok, true);
});

const automaticFullPresentation = { mode: 'window', surface: 'full', autoOpen: 'always' };

test('a Browser execution auto-open uses the trusted same-owner full View before its domain RPC', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation }), lease = await h.acquire('chat-auto');
  const result = await h.execute(lease);
  assert.equal(result.ok, true); assert.equal(result.presentation.mode, 'embedded');
  assert.equal(result.presentation.ownerSessionId, lease.ownerLeaseId);
  const opened = h.calls.find(value => value.kind === 'automation' && value.action === 'open');
  assert.equal(opened.input.mode, 'embedded'); assert.equal(Object.getOwnPropertySymbols(opened.input).length, 1);
  assert.equal(h.calls.some(value => value.action === 'window-state' || value.action === 'legacy-host-ready'), false);
  const viewIndex = h.calls.findIndex(value => value.action === 'openView');
  const rpcIndex = h.calls.findIndex(value => value.kind === 'rpc' && value.method === 'fixture.work');
  assert.ok(viewIndex >= 0 && rpcIndex > viewIndex);
  assert.equal(h.handles[0].ownerSessionId, lease.ownerLeaseId);
  assert.ok(h.calls.filter(value => value.kind === 'browser').every(value => value.ownerSessionId === lease.ownerLeaseId));
  const rpc = h.calls[rpcIndex]; assert.equal(rpc.context.sessionId, lease.ownerLeaseId);
  assert.deepEqual(rpc.context.browserExecution, { endpoint: { kind: 'browser-message-port', runtimeId }, connectionId });
});

test('a Browser declaration requires the verified Agent lease before any runtime or UI acquisition', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation });
  const result = await h.bridge.execute({ toolId: 'fixture', tool: 'fixture_tool' }, undefined, { sessionId: 'chat-without-lease' });
  assert.equal(result.errorCode, 'SUBAPP_SESSION_REQUIRED'); assert.equal(h.calls.length, 0);
});

test('foreign and expired Agent leases cannot auto-open a Browser execution View', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation }), lease = await h.acquire('chat-auto');
  assert.equal((await h.execute({ ...lease, sessionId: 'foreign-chat' })).errorCode, 'SUBAPP_OWNER_MISMATCH');
  h.bridge.ownerLeases.leases.get(lease.ownerLeaseId).expiresAt = 0;
  assert.equal((await h.execute(lease)).errorCode, 'SUBAPP_OWNER_EXPIRED'); assert.equal(h.calls.length, 0);
});

test('explicit presentation suppression still runs the original Browser execution RPC without opening a View', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation }), lease = await h.acquire('chat-auto');
  const result = await h.execute(lease, { presentUi: 'none' }); assert.equal(result.ok, true);
  assert.equal(h.handles.length, 0); assert.equal(h.calls.some(value => value.kind === 'automation'), false);
  const rpc = h.calls.find(value => value.kind === 'rpc' && value.method === 'fixture.work');
  assert.equal(rpc.params.presentUi, undefined); assert.equal(rpc.context.sessionId, lease.ownerLeaseId);
});

test('a failed full View acknowledgement prevents the Browser domain RPC and retains its original owner', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation,
    browser: input => { if (input.action === 'openView') throw Error('full View allocation refused'); } });
  const lease = await h.acquire('chat-auto'), result = await h.execute(lease);
  assert.equal(result.ok, false); assert.match(result.error, /full View allocation refused/);
  assert.equal(h.calls.some(value => value.kind === 'rpc' && value.method === 'fixture.work'), false);
  assert.equal(h.registry.active.size, 0); assert.equal(h.surfaces.surfaces.size, 0);
  assert.equal(h.bridge.channels.get('fixture').sessionIds.has(lease.ownerLeaseId), true);
  assert.equal((await h.release(lease)).ok, true);
});

test('revocation during auto-open joins the actual late View allocation and never starts the domain RPC', async t => {
  const entered = deferred(), resume = deferred();
  const h = await fixture(t, { presentation: automaticFullPresentation,
    browser: async input => { if (input.action === 'openView') { entered.resolve(); await resume.promise; } } });
  const lease = await h.acquire('chat-auto'), opening = h.execute(lease); await entered.promise;
  const releasing = h.release(lease); resume.resolve();
  assert.equal((await opening).ok, false); assert.equal((await releasing).ok, true);
  assert.equal(h.calls.some(value => value.kind === 'rpc' && value.method === 'fixture.work'), false);
  assert.equal(h.calls.filter(value => value.action === 'closeView').length, 1);
  assert.equal(h.registry.active.size, 0); assert.equal(h.surfaces.surfaces.size, 0);
});

test('ordinary native tools keep their existing automatic window and host readiness route', async t => {
  const h = await fixture(t, { native: true, presentation: automaticFullPresentation }), lease = await h.acquire('chat-native');
  const result = await h.execute(lease); assert.equal(result.ok, true);
  const opened = h.calls.find(value => value.kind === 'automation' && value.action === 'open');
  assert.deepEqual(opened.input, { toolId: 'fixture', mode: 'window' });
  assert.equal(h.calls.some(value => value.action === 'legacy-host-ready'), true);
  assert.equal(h.calls.some(value => value.kind === 'browser'), false);
});

test('repeated automatic open focuses the same acknowledged Owner View without opening or mounting again', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true }), lease = await h.acquire('chat-repeat');
  const first = await h.execute(lease), grant = h.ui.toolPresentationIds.fixture, handle = h.handles[0];
  h.ui.openToolList.unshift('other'); h.ui.openToolList.push('other-top');
  const second = await h.execute(lease), third = await h.execute(lease);
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(third.ok, true, JSON.stringify(third));
  assert.deepEqual(second.presentation, first.presentation); assert.deepEqual(third.presentation, first.presentation);
  assert.equal(h.ui.topTool, 'fixture'); assert.equal(h.ui.toolPresentationIds.fixture, grant);
  assert.equal(h.handles.length, 1); assert.equal(h.handles[0], handle);
  assert.equal(h.calls.filter(x => x.kind === 'automation' && x.action === 'open').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'automation' && x.action === 'focus-owned').length, 2);
  assert.equal(h.calls.filter(x => x.kind === 'ui-shell' && x.action === 'open').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'browser' && x.action === 'openView').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'rpc' && x.method === 'fixture.work').length, 3);
});

test('production adapter chain follows the actual app provider and forwards same-owner focus to Main UI', async t => {
  const { SubappAutomationAdapter } = await loaded;
  const filename = path.resolve(__dirname, '../src/app/app.config.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest);
  let provider;
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(source), p.initializer.getText(source)]));
      if (properties.get('provide') === 'SUBAPP_AUTOMATION_PORT') provider = properties;
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(provider?.get('useExisting'), 'SubappAutomationAdapter');
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true });
  assert.ok(h.bridge.automation instanceof SubappAutomationAdapter);
  assert.equal(typeof h.bridge.automation.focusChildAppPresentation, 'function');
  const lease = await h.acquire('chat-production-adapter'), first = await h.execute(lease), second = await h.execute(lease);
  assert.equal(first.ok, true); assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(second.presentation, first.presentation); assert.equal(h.handles.length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'automation' && x.action === 'focus-owned').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'ui-shell' && x.action === 'open').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'rpc' && x.method === 'fixture.work').length, 2);
});

test('ordinary explicit presentation still rejects an existing View even for its same Owner', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true }), lease = await h.acquire('chat-repeat');
  await h.execute(lease); const result = await h.present(lease);
  assert.equal(result.ok, false); assert.match(result.error, /presentation already exists/);
  assert.equal(h.handles.length, 1); assert.equal(h.calls.some(x => x.action === 'focus-owned'), false);
});

test('automatic reuse cannot focus or acquire another Owner or an unowned View', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true });
  const a = await h.acquire('chat-a'), b = await h.acquire('chat-b'); await h.execute(a);
  assert.equal((await h.execute(b)).ok, false); assert.equal(h.handles.length, 1);
  assert.equal(h.handles[0].ownerSessionId, a.ownerLeaseId); assert.equal(h.calls.some(x => x.action === 'focus-owned'), false);
  assert.equal((await h.release(b)).ok, true); assert.equal(h.handles.length, 1);
  h.bridge.ownerLeases.leases.get(a.ownerLeaseId).expiresAt = 0;
  assert.equal((await h.execute(a)).errorCode, 'SUBAPP_OWNER_EXPIRED');
});

test('an unowned ordinary View is never adopted by automatic same-tool presentation', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation });
  const ordinary = h.surfaces.open('fixture', geometry); await ordinary.ready;
  const lease = await h.acquire('chat-agent'), result = await h.execute(lease);
  assert.equal(result.ok, false); assert.match(result.error, /another or unowned View/);
  assert.equal(h.calls.some(x => x.action === 'focus-owned'), false); assert.ok(ordinary.ownerSessionId.startsWith('ui-'));
  await ordinary.close();
});

test('a pending View cannot be reused before its actual readiness acknowledgement', async t => {
  const entered = deferred(), resume = deferred();
  const h = await fixture(t, { presentation: automaticFullPresentation,
    browser: async input => { if (input.action === 'openView') { entered.resolve(); await resume.promise; } } });
  const lease = await h.acquire('chat-pending'), first = h.execute(lease); await entered.promise;
  assert.equal((await h.execute(lease)).ok, false); assert.equal(h.calls.some(x => x.action === 'focus-owned'), false);
  resume.resolve(); assert.equal((await first).ok, true); assert.equal(h.handles.length, 1);
});

test('a closing View cannot be reused; after actual detach the same Owner may open a fresh View', async t => {
  const entered = deferred(), resume = deferred(); let held = false;
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true,
    browser: async input => { if (input.action === 'closeView' && !held) { held = true; entered.resolve(); await resume.promise; } } });
  const lease = await h.acquire('chat-closing'); await h.execute(lease); const oldGrant = h.ui.toolPresentationIds.fixture;
  const closing = h.handles[0].close(); await entered.promise;
  assert.equal((await h.execute(lease)).ok, false); assert.equal(h.calls.some(x => x.action === 'focus-owned'), false);
  resume.resolve(); await closing; assert.equal((await h.execute(lease)).ok, true);
  assert.notEqual(h.ui.toolPresentationIds.fixture, oldGrant); assert.equal(h.handles.length, 2);
});

test('failed focus of a stale pane grant never cancels or remounts the original active View', async t => {
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true }), lease = await h.acquire('chat-focus');
  await h.execute(lease); const original = h.registry.active.get('fixture'), grant = h.ui.toolPresentationIds.fixture;
  h.ui.toolPresentationIds.fixture = 'foreign-grant'; assert.equal((await h.execute(lease)).ok, false);
  assert.equal(h.registry.active.get('fixture'), original); assert.equal(original.revoked, false); assert.equal(h.handles.length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'rpc' && x.method === 'fixture.work').length, 1);
  h.ui.toolPresentationIds.fixture = grant; assert.equal((await h.execute(lease)).ok, true); assert.equal(h.handles.length, 1);
});

test('an unconfirmed detach keeps its claim unavailable until the original View cleanup succeeds', async t => {
  let attempts = 0;
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true,
    browser: input => { if (input.action === 'closeView' && ++attempts === 1) throw Error('detach ACK missing'); } });
  const lease = await h.acquire('chat-unconfirmed'); await h.execute(lease);
  const original = h.registry.active.get('fixture'), oldGrant = h.ui.toolPresentationIds.fixture;
  await assert.rejects(h.handles[0].close(), /detach ACK missing/);
  assert.equal((await h.execute(lease)).ok, false); assert.equal(h.registry.active.get('fixture'), original);
  assert.equal(h.handles.length, 1); assert.equal(h.calls.some(x => x.action === 'focus-owned'), false);
  await h.handles[0].close(); assert.equal(h.registry.active.size, 0);
  assert.equal((await h.execute(lease)).ok, true); assert.equal(h.handles.length, 2);
  assert.notEqual(h.ui.toolPresentationIds.fixture, oldGrant);
});

test('Owner revocation during the focus window lookup cannot focus, remount or send another domain RPC', async t => {
  const entered = deferred(), resume = deferred(); let lookups = 0;
  const h = await fixture(t, { presentation: automaticFullPresentation, mountLifecycle: true,
    readWindowState: async () => { if (++lookups === 2) { entered.resolve(); await resume.promise; } } });
  const lease = await h.acquire('chat-revoked-focus'); await h.execute(lease);
  const second = h.execute(lease); await entered.promise; const releasing = h.release(lease); resume.resolve();
  assert.equal((await second).ok, false); assert.equal((await releasing).ok, true);
  assert.equal(h.calls.filter(x => x.kind === 'rpc' && x.method === 'fixture.work').length, 1);
  assert.equal(h.calls.filter(x => x.kind === 'browser' && x.action === 'openView').length, 1);
  assert.equal(h.registry.active.size, 0); assert.deepEqual(h.ui.openToolList, []);
});

test('missing, foreign and expired leases cannot present; an acquired lease must first own this tool', async t => {
  const h = await fixture(t), lease = await h.acquire('chat-a');
  assert.equal((await h.present(lease)).errorCode, 'SUBAPP_OWNER_TOOL_REQUIRED');
  await h.execute(lease);
  assert.equal((await h.present({ ...lease, sessionId: 'chat-b' })).errorCode, 'SUBAPP_OWNER_MISMATCH');
  assert.equal((await h.present({ ...lease, ownerLeaseId: 'owner-forged' })).errorCode, 'SUBAPP_OWNER_EXPIRED');
  h.bridge.ownerLeases.leases.get(lease.ownerLeaseId).expiresAt = 0;
  assert.equal((await h.present(lease)).errorCode, 'SUBAPP_OWNER_EXPIRED');
  assert.equal(h.handles.length, 0);
});

test('UI-first ownership is never converted to an Agent owner', async t => {
  const h = await fixture(t), original = h.surfaces.open('fixture', geometry); await original.ready;
  const lease = await h.acquire('chat-a'); await h.execute(lease);
  assert.equal((await h.present(lease)).ok, false);
  assert.ok(original.ownerSessionId.startsWith('ui-'));
  assert.equal(h.handles.length, 0); await original.close();
});

test('a concurrent ordinary UI mount cannot consume the exact trusted open grant', async t => {
  const entered = deferred(), resume = deferred();
  const h = await fixture(t, { beforeOpen: async () => { entered.resolve(); await resume.promise; } });
  const lease = await h.acquire('chat-a'); await h.execute(lease);
  const presenting = h.present(lease); await entered.promise;
  assert.throws(() => h.surfaces.open('fixture', geometry), /presentation already exists/);
  assert.throws(() => h.surfaces.open('fixture', geometry, 'forged-grant'), /grant is invalid/);
  resume.resolve(); assert.equal((await presenting).ok, true);
});

test('owner release closes only its borrowed View before Node owner cleanup', async t => {
  const h = await fixture(t), a = await h.acquire('chat-a'), b = await h.acquire('chat-b');
  await h.execute(a); await h.execute(b); assert.equal((await h.present(a)).ok, true);
  assert.equal((await h.release(b)).ok, true);
  assert.equal(h.calls.filter(value => value.action === 'closeView').length, 0);
  const marker = h.calls.length; assert.equal((await h.release(a)).ok, true);
  const close = h.calls.findIndex((value, index) => index >= marker && value.action === 'closeView');
  const release = h.calls.findIndex((value, index) => index >= marker && value.action === 'release' && value.kind === 'supervisor');
  assert.ok(close >= marker && release > close);
  assert.equal(h.surfaces.surfaces.size, 0); assert.equal(h.registry.active.size, 0);
});

test('lease expiry revokes presentation and joins View cleanup before releasing its Node owner', async t => {
  const h = await fixture(t), lease = await h.acquire('chat-a'); await h.execute(lease); await h.present(lease);
  h.bridge.ownerLeases.leases.get(lease.ownerLeaseId).expiresAt = 0;
  await h.bridge.ownerLeases.expire();
  assert.equal(h.surfaces.surfaces.size, 0); assert.equal(h.registry.active.size, 0);
  assert.equal(h.calls.filter(value => value.action === 'closeView').length, 1);
  assert.equal(h.bridge.channels.has('fixture'), false);
  assert.equal((await h.present(lease)).errorCode, 'SUBAPP_OWNER_EXPIRED');
});

test('failed borrowed View detach retains claim and original Agent channel for explicit cleanup retry', async t => {
  let attempts = 0;
  const h = await fixture(t, { browser: input => { if (input.action === 'closeView' && ++attempts === 1) throw Error('detach ACK missing'); } });
  const lease = await h.acquire('chat-a'); await h.execute(lease); await h.present(lease);
  assert.equal((await h.release(lease)).ok, false);
  assert.equal(h.registry.active.size, 1); assert.equal(h.surfaces.surfaces.size, 1);
  assert.equal(h.bridge.channels.get('fixture').sessionIds.has(lease.ownerLeaseId), true);
  assert.equal(h.calls.some(value => value.kind === 'supervisor' && value.action === 'release'), false);
  assert.equal((await h.bridge.releaseSession(lease.ownerLeaseId, lease.sessionId)).ok, true);
  assert.equal(h.registry.active.size, 0); assert.equal(h.surfaces.surfaces.size, 0);
});

test('revocation during a late View allocation joins the original connection cleanup', async t => {
  const entered = deferred(), resume = deferred();
  const h = await fixture(t, { browser: async input => { if (input.action === 'openView') { entered.resolve(); await resume.promise; } } });
  const lease = await h.acquire('chat-a'); await h.execute(lease);
  const presenting = h.present(lease); await entered.promise;
  const releasing = h.release(lease); resume.resolve();
  assert.equal((await presenting).ok, false); assert.equal((await releasing).ok, true);
  assert.equal(h.calls.filter(value => value.action === 'closeView').length, 1);
  assert.equal(h.registry.active.size, 0); assert.equal(h.surfaces.surfaces.size, 0);
});

test('Main UI forwards only the in-process grant key; JSON fields cannot select an Agent owner', async () => {
  const { MainUiAutomationService, AutomationUiAdapter, SubappBrowserPresentationService, SUBAPP_BROWSER_PRESENTATION, replaceChildToolConfigs } = await loaded;
  replaceChildToolConfigs([{ id: 'fixture', titleKey: 'Fixture', ui: { route: '/fixture' } }]);
  const forwarded = [], ui = { openToolList: [], topTool: 'fixture', openToolEmbedded: (...values) => { forwarded.push(values); return true; }, completeToolPresentationClose() {} };
  const registry = new SubappBrowserPresentationService(), ticket = registry.prepare('fixture', 'owner', () => undefined);
  const service = new MainUiAutomationService({}, { ensureInitialized() {} }, new AutomationUiAdapter(ui), { instant: value => value }, registry);
  service.readWindowState = async () => ({ open: false });
  assert.equal((await service.openChildApp({ toolId: 'fixture', presentationId: 'forged', ownerLeaseId: 'forged' })).ok, true);
  assert.deepEqual(forwarded[0], ['fixture']);
  assert.equal((await service.openChildApp({ toolId: 'fixture', [SUBAPP_BROWSER_PRESENTATION]: ticket.id })).ok, true);
  assert.deepEqual(forwarded[1], ['fixture', ticket.id]);
  ui.openToolList.push('fixture');
  assert.equal((await service.openChildApp({ toolId: 'fixture', [SUBAPP_BROWSER_PRESENTATION]: ticket.id })).ok, false);
  assert.equal(forwarded.length, 2);
  await registry.cancel(ticket.id, Error('unit cleanup'));
});

test('owner release removes the exact UI pane/grant after View ACK and a fresh owner can present immediately', async t => {
  const h = await fixture(t, { mountLifecycle: true }), a = await h.acquire('chat-a');
  await h.execute(a); assert.equal((await h.present(a)).ok, true);
  const oldGrant = h.ui.toolPresentationIds['fixture']; assert.ok(oldGrant);
  assert.deepEqual(h.ui.openToolList, ['fixture']);
  assert.equal((await h.release(a)).ok, true);
  assert.deepEqual(h.ui.openToolList, []); assert.equal(h.ui.toolPresentationIds['fixture'], undefined);
  assert.ok(h.calls.findIndex(value => value.action === 'closeView') < h.calls.findIndex(value => value.kind === 'ui-shell' && value.action === 'close'));
  const b = await h.acquire('chat-b'); await h.execute(b);
  assert.equal((await h.present(b)).ok, true);
  const newGrant = h.ui.toolPresentationIds['fixture']; assert.notEqual(newGrant, oldGrant);
  h.ui.completeToolPresentationClose('fixture', oldGrant);
  h.ui.completeToolPresentationClose('foreign-tool', newGrant);
  assert.deepEqual(h.ui.openToolList, ['fixture']); assert.equal(h.ui.toolPresentationIds['fixture'], newGrant);
  assert.equal(h.handles.at(-1).ownerSessionId, b.ownerLeaseId);
});

test('closing a borrowed View clears its pane and grant while its Agent owner remains usable', async t => {
  const h = await fixture(t, { mountLifecycle: true }), lease = await h.acquire('chat-a');
  await h.execute(lease); await h.present(lease); await h.handles[0].close();
  assert.deepEqual(h.ui.openToolList, []); assert.equal(h.ui.toolPresentationIds['fixture'], undefined);
  assert.equal((await h.execute(lease)).ok, true);
  assert.equal(h.calls.some(value => value.kind === 'supervisor' && value.action === 'release'), false);
  assert.equal((await h.present(lease)).ok, true);
});

test('post-ACK UI completion failure retains the exact record for explicit owner cleanup retry', async t => {
  let attempts = 0;
  const h = await fixture(t, { mountLifecycle: true, completeMount: () => { if (++attempts === 1) throw Error('UI completion failed'); } });
  const lease = await h.acquire('chat-a'); await h.execute(lease); await h.present(lease);
  assert.equal((await h.release(lease)).ok, false);
  assert.equal(h.registry.active.size, 1); assert.equal(h.surfaces.surfaces.size, 1);
  assert.deepEqual(h.ui.openToolList, ['fixture']);
  assert.equal(h.calls.some(value => value.kind === 'supervisor' && value.action === 'release'), false);
  assert.equal((await h.bridge.releaseSession(lease.ownerLeaseId, lease.sessionId)).ok, true);
  assert.deepEqual(h.ui.openToolList, []); assert.equal(h.registry.active.size, 0);
  assert.equal(h.calls.filter(value => value.action === 'closeView').length, 1);
  assert.equal((await h.release(lease)).ok, false); // Original sticky receipt is historical.
});

test('lease expiry removes only its own mounted UI and never retains an expired grant', async t => {
  const h = await fixture(t, { mountLifecycle: true }), a = await h.acquire('chat-a'), b = await h.acquire('chat-b');
  await h.execute(a); await h.execute(b); await h.present(a);
  assert.equal((await h.release(b)).ok, true); assert.deepEqual(h.ui.openToolList, ['fixture']);
  h.bridge.ownerLeases.leases.get(a.ownerLeaseId).expiresAt = 0; await h.bridge.ownerLeases.expire();
  assert.deepEqual(h.ui.openToolList, []); assert.equal(h.ui.toolPresentationIds['fixture'], undefined);
});

test('cancellation before the UI mounts clears its pending shell and its old grant cannot remount', async t => {
  const mountGate = deferred(), h = await fixture(t, { mountLifecycle: true, mountGate });
  const lease = await h.acquire('chat-a'); await h.execute(lease);
  const presenting = h.present(lease);
  while (!h.ui.openToolList.length) await new Promise(resolve => setImmediate(resolve));
  const grant = h.ui.toolPresentationIds['fixture'];
  assert.equal((await h.release(lease)).ok, true); assert.equal((await presenting).ok, false);
  assert.deepEqual(h.ui.openToolList, []); assert.equal(h.ui.toolPresentationIds['fixture'], undefined);
  assert.throws(() => h.surfaces.open('fixture', geometry, grant), /grant is invalid/);
  mountGate.resolve(); await new Promise(resolve => setImmediate(resolve));
});

test('ordinary UI completion clears an old mount marker without closing a newer or unrelated grant', async () => {
  const { getChildToolConfig } = await loaded, ui = actualUiService(getChildToolConfig, {});
  ui.openToolList = ['fixture', 'other']; ui.toolPresentationIds['fixture'] = 'current'; ui.toolPresentationIds['other'] = 'other-grant';
  ui.completeToolPresentationClose('fixture', 'old'); assert.deepEqual(ui.openToolList, ['fixture', 'other']);
  ui.completeToolClose('fixture'); assert.deepEqual(ui.openToolList, ['other']);
  assert.equal(ui.toolPresentationIds['fixture'], undefined); assert.equal(ui.toolPresentationIds['other'], 'other-grant');
});

function actualHostClass() {
  const filename = path.resolve(__dirname, '../src/app/tools/child-tool-host/child-tool-host.component.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const imports = new Set(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest).statements
    .filter(ts.isImportDeclaration).map(value => value.moduleSpecifier.text));
  const javascript = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
  } }).outputText;
  const module = { exports: {} };
  // No Host is constructed. Each case supplies only the explicit lifecycle
  // ports needed to exercise the original admission/completion methods.
  new Function('require', 'module', 'exports', javascript)(name => {
    assert.equal(imports.has(name), true);
    return name === '@angular/core' ? { Component: () => value => value, Input: () => () => {}, ViewChild: () => () => {} } : {};
  }, module, module.exports);
  return module.exports.ChildToolHostComponent;
}

test('a borrowed Host rejects detach before invoking any window or Runtime port', async () => {
  const result = await actualHostClass().prototype.detach.call({ presentationId: 'borrowed-grant',
    get config() { assert.fail('A borrowed View cannot reach ordinary detach ports'); } });
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'SUBAPP_OWNER_PRESENTATION_MODE');
});

test('a delayed old Host close completes its captured grant, never a newer input identity', async () => {
  const entered = deferred(), resume = deferred(), completions = [];
  const host = { closing: false, presentationId: 'old-grant', resolvedToolId: 'fixture', isBrowserExecution: true, isStandalone: false,
    browserSurface: { async close() { entered.resolve(); await resume.promise; } },
    uiService: { completeToolPresentationClose: (...args) => completions.push(args), completeToolClose: () => assert.fail('Exact grant required') } };
  const closing = actualHostClass().prototype.close.call(host); await entered.promise;
  host.presentationId = 'new-grant'; host.resolvedToolId = 'new-tool'; resume.resolve();
  const result = await closing; assert.equal(result.ok, true); assert.equal(result.toolId, 'fixture');
  assert.deepEqual(completions, [['fixture', 'old-grant']]);
});
