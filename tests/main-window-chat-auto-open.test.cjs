const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const rx = require('rxjs');

// Execute the real shell lifecycle and UiService with external services stubbed.
// No account, native window, child process, or network connection is created.
function load(relativePath) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true,
    },
  }).outputText;
  const record = { exports: {} };
  new Function('require', 'exports', 'module', compiled)(name => {
    if (name === 'rxjs') return rx;
    if (name === '@angular/core') return {
      Component: () => target => target,
      Injectable: () => target => target,
      ViewChild: () => () => {},
    };
    if (name === '@core/auth/public-api') return {
      isAuthRequiredTool: tool => tool === 'aily-chat',
      registerAilyChatHostAuthRuntimeBridge: () => () => {},
    };
    if (name === '@integration/subapps/public-api') return {
      DEFAULT_AILY_CHAT_SUBAPP_TOOL_ID: 'aily-chat',
    };
    if (name.endsWith('/configs/tool.config')) return {
      isAppAvailableForApplication: only => !only || only === 'all' || only === 'aily blockly',
      getChildToolConfig: tool => tool === 'aily-chat'
        ? { id: tool, app: {}, routePath: '/child-tool/aily-chat' }
        : undefined,
    };
    return {};
  }, record.exports, record);
  return record.exports;
}

const { MainWindowComponent } = load('src/app/main-window/main-window.component.ts');
const { UiService } = load('src/app/services/core/app-shell/ui.service.ts');
const { bootstrapDefaultSubapps } = load('src/app/services/integrations/subapps/bootstrap/default-subapps-bootstrap.ts');

const installedChat = () => ({
  id: 'aily-chat', toolId: 'aily-chat', installed: true, config: {},
  app: { autoInstall: true },
});

function harness(t, { loggedIn = false, ready = Promise.resolve(), chat = installedChat() } = {}) {
  const previousWindow = global.window;
  const previousStorage = global.localStorage;
  global.window = { ipcRenderer: { send() {}, on() {} } };
  global.localStorage = { getItem: () => null };
  const loginState = new rx.BehaviorSubject(loggedIn);
  const authChanged = new rx.Subject();
  const catalog = new rx.BehaviorSubject({ apps: chat ? [chat] : [] });
  const subapps = { state$: catalog.asObservable(), get state() { return catalog.value; } };
  const requests = [];
  const auth = {
    isLoggedIn$: loginState.asObservable(),
    get isLoggedIn() { return loginState.value; },
    authChanged$: authChanged,
    loginDialogRequest$: rx.EMPTY,
    authSessionInvalidationRequest$: rx.EMPTY,
    initializeAuth: async () => {},
    getAuthInitializationState: () => loginState.value ? 'authenticated' : 'signed_out',
    requestLogin: reason => requests.push(reason),
  };
  const ui = Object.assign(Object.create(UiService.prototype), {
    actionSubject: new rx.Subject(),
    openToolList: [],
    authService: auth,
    isMainWindow: false,
    updateFooterState() {},
    init() { this.isMainWindow = true; },
  });
  let opens = 0;
  ui.openPreferredAilyChat = () => {
    opens++;
    return UiService.prototype.openPreferredAilyChat.call(ui);
  };
  const project = {
    init() {},
    currentProjectPath$: new rx.BehaviorSubject(null),
    coderWorkspace$: new rx.BehaviorSubject(null),
    stateSubject: new rx.Subject(),
  };
  const component = new MainWindowComponent(
    ui, project, {}, {}, { detectChanges() {} },
    { init() {} }, { init() {} }, { events: new rx.Subject() },
    { configNotice$: rx.EMPTY, getApplicationName: () => 'aily blockly' }, {}, { show$: rx.EMPTY, config$: rx.EMPTY }, auth,
    { currentRegion: async () => 'cn', isElectron: false, sendRendererReady: async () => {} },
    {}, subapps, {}, {}, {},
    { loadChildTools: () => ready, load: async () => {} },
    { record() {} },
    { selectedPort$: new rx.BehaviorSubject(null) },
  );
  component.setupGlobalOAuthListener = () => {};
  component.setupExampleListListener = () => {};
  t.after(() => {
    component.ngOnDestroy();
    loginState.complete();
    authChanged.complete();
    catalog.complete();
    ui.actionSubject.complete();
    project.currentProjectPath$.complete();
    project.coderWorkspace$.complete();
    project.stateSubject.complete();
    global.window = previousWindow;
    global.localStorage = previousStorage;
  });
  return {
    component, ui, loginState, authChanged, requests, catalog,
    get opens() { return opens; },
    async start() {
      const initializing = component.ngOnInit();
      component.ngAfterViewInit();
      await initializing;
    },
    closeChat() {
      ui.openToolList = ui.openToolList.filter(tool => tool !== 'aily-chat');
      ui.actionSubject.next({ action: 'close', type: 'tool', data: 'aily-chat' });
    },
  };
}

test('signed-out startup and unsuccessful login do not open Chat', async t => {
  const h = harness(t);
  await h.start();
  h.loginState.next(false);
  assert.equal(h.opens, 0);
  assert.equal(h.component.showRbox, false);
  assert.deepEqual(h.ui.openToolList, []);
});

test('successful login opens the canonical Chat tool and the actual right panel', async t => {
  const h = harness(t);
  await h.start();
  h.loginState.next(true);
  assert.equal(h.opens, 1);
  assert.equal(h.component.showRbox, true);
  assert.equal(h.ui.topTool, 'aily-chat');
});

test('a restored login opens Chat after UI initialization and panel subscriptions', async t => {
  const h = harness(t, { loggedIn: true });
  await h.start();
  assert.equal(h.ui.isMainWindow, true);
  assert.equal(h.opens, 1);
  assert.equal(h.component.showRbox, true);
  assert.deepEqual(h.ui.openToolList, ['aily-chat']);
});

test('repeated authenticated snapshots and profile refresh respect manual closure', async t => {
  const h = harness(t);
  await h.start();
  h.loginState.next(true);
  h.closeChat();
  h.loginState.next(true);
  h.authChanged.next();
  h.catalog.next({ apps: [installedChat()] });
  h.loginState.next(true);
  assert.equal(h.opens, 1);
  assert.equal(h.component.showRbox, false);
  assert.deepEqual(h.ui.openToolList, []);
});

test('a manually uninstalled Chat stays closed at startup and on later login', async t => {
  const h = harness(t, { loggedIn: true, chat: {
    ...installedChat(), installed: false, config: null, manuallyUninstalled: true,
  } });
  await h.start();
  h.catalog.next(h.catalog.value);
  h.loginState.next(false);
  h.loginState.next(true);
  assert.equal(h.opens, 0);
  assert.equal(h.component.showRbox, false);
  assert.deepEqual(h.ui.openToolList, []);
});

test('first-run Chat waits for a successful installation before opening', async t => {
  const h = harness(t, { loggedIn: true, chat: {
    ...installedChat(), installed: false, config: null,
  } });
  await h.start();
  assert.equal(h.opens, 0);
  h.catalog.next({ apps: [{ ...installedChat(), config: null, installError: 'incomplete' }] });
  assert.equal(h.opens, 0);
  h.catalog.next({ apps: [installedChat()] });
  assert.equal(h.opens, 1);
  assert.equal(h.component.showRbox, true);
});

test('unavailable catalog and uninstall cleanup never mount an empty Chat panel', async t => {
  const h = harness(t, { loggedIn: true, chat: null });
  await h.start();
  for (const chat of [
    { ...installedChat(), uninstalling: true },
    { ...installedChat(), enabled: false },
    { ...installedChat(), app: { enabled: false } },
    { ...installedChat(), only: 'aily coder' },
  ]) h.catalog.next({ apps: [chat] });
  assert.equal(h.opens, 0);
  assert.equal(h.component.showRbox, false);
});

test('reinstalling Chat while signed out waits for login before opening', async t => {
  const h = harness(t, { chat: { ...installedChat(), installed: false, config: null, manuallyUninstalled: true } });
  await h.start();
  h.catalog.next({ apps: [installedChat()] });
  assert.equal(h.opens, 0);
  h.loginState.next(true);
  assert.equal(h.opens, 1);
});

test('an idle prewarm is cancelled when Chat has been removed before it runs', async t => {
  const h = harness(t, { loggedIn: true });
  await h.start();
  let runIdle;
  window.requestIdleCallback = run => { runIdle = run; return 1; };
  let prewarms = 0;
  h.component.childToolProcessService.prewarm = async () => { prewarms++; };
  h.component.scheduleAilyChatPrewarm();
  h.catalog.next({ apps: [] });
  runIdle();
  assert.equal(prewarms, 0);
});

test('bootstrap distinguishes first-run, explicit removal, and legacy Chat installation history', async () => {
  const missing = { ...installedChat(), installed: false, config: null };
  for (const scenario of [
    { name: 'first run', item: missing, history: false, expected: 1 },
    { name: 'manual uninstall', item: { ...missing, manuallyUninstalled: true }, history: false, expected: 0 },
    { name: 'legacy uninstall', item: missing, history: true, expected: 0 },
    { name: 'first download failed', item: { ...missing, installError: 'offline' }, history: false, expected: 1 },
    { name: 'already installed', item: installedChat(), history: true, expected: 0 },
  ]) {
    const installs = [];
    await bootstrapDefaultSubapps({
      initialize: async () => {}, readCatalog: () => [scenario.item], isAvailable: () => true,
      wasAilyChatInstalled: () => scenario.history, install: async id => { installs.push(id); },
      onError: (id, error) => { throw error; },
    });
    assert.equal(installs.length, scenario.expected, scenario.name);
  }
});

test('signing out and logging in again permits one new automatic open', async t => {
  const h = harness(t, { loggedIn: true });
  await h.start();
  h.closeChat();
  h.loginState.next(false);
  assert.equal(h.opens, 1);
  h.loginState.next(true);
  h.loginState.next(true);
  assert.equal(h.opens, 2);
  assert.equal(h.component.showRbox, true);
});

test('already-open Chat is kept open without a duplicate tool entry', async t => {
  const h = harness(t, { loggedIn: true });
  h.ui.openToolList = ['aily-chat'];
  h.component.showRbox = true;
  await h.start();
  assert.equal(h.component.showRbox, true);
  assert.deepEqual(h.ui.openToolList, ['aily-chat']);
});

test('login while localization is loading waits for the UI to be ready', async t => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const h = harness(t, { ready });
  const starting = h.start();
  h.loginState.next(true);
  assert.equal(h.opens, 0);
  resolveReady();
  await starting;
  assert.equal(h.opens, 1);
  assert.equal(h.component.showRbox, true);
});

test('login followed by logout before UI readiness does not open stale Chat', async t => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const h = harness(t, { ready });
  const starting = h.start();
  h.loginState.next(true);
  h.loginState.next(false);
  resolveReady();
  await starting;
  assert.equal(h.opens, 0);
  assert.equal(h.component.showRbox, false);
});

test('destroying the shell unsubscribes from future login events', async t => {
  const h = harness(t);
  await h.start();
  h.component.ngOnDestroy();
  h.loginState.next(true);
  assert.equal(h.opens, 0);
});

test('destroying the shell during startup cannot install a late subscription', async t => {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const h = harness(t, { ready, loggedIn: true });
  const starting = h.start();
  h.component.ngOnDestroy();
  resolveReady();
  await starting;
  h.loginState.next(false);
  h.loginState.next(true);
  assert.equal(h.ui.isMainWindow, false);
  assert.equal(h.opens, 0);
});
