'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const rxjs = require('rxjs');

const root = path.resolve(__dirname, '..');
const hostFile = path.join(root, 'src/app/tools/child-tool-host/child-tool-host.component.ts');
const original = ts.createSourceFile(hostFile, fs.readFileSync(hostFile, 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = original.statements.find(s => ts.isClassDeclaration(s) && s.name.text === 'ChildToolHostComponent');
const parameters = declaration.members.find(ts.isConstructorDeclaration).parameters.map(p => p.name.getText(original));
const copy = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));

function compile(relative, dependencies) {
  const file = path.join(root, relative), module = { exports: {} };
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics.length, 0);
  vm.runInNewContext(result.outputText, { module, exports: module.exports, require: dependencies, console }, { filename: file });
  return module.exports;
}

function fixture(t, { pending = false } = {}) {
  const angular = { Component: () => value => value, Injectable: () => value => value, Input: () => () => {} };
  const registry = compile('src/app/configs/tool.config.ts', () => ({}));
  const activityModule = compile('src/app/services/integrations/subapps/subapp-activity.service.ts', name => {
    if (name === '@angular/core') return angular;
    if (name === 'rxjs') return rxjs;
    throw Error('Unexpected activity dependency: ' + name);
  });
  const { ChildToolHostComponent } = compile('src/app/tools/child-tool-host/child-tool-host.component.ts', name => {
    if (name === '@angular/core') return angular;
    if (name === 'rxjs') return rxjs;
    if (name === '../../configs/tool.config') return registry;
    return {}; // unrelated constructor ports and component declarations are not exercised
  });
  const language = new rxjs.Subject(), theme = new rxjs.Subject(), catalog = new rxjs.Subject();
  const activity = new activityModule.SubappActivityService();
  const dictionaries = { zh_cn: {}, en: {} }, messages = [], reads = [], contexts = [];
  const translate = {
    currentLang: 'zh_cn', defaultLang: 'en', onLangChange: language,
    instant(key) { return dictionaries[this.currentLang]?.[key] ?? key; },
  };
  const loader = { load(toolId, lang) {
    const row = { toolId, lang }; reads.push(row);
    if (!pending) return Promise.resolve();
    return new Promise((resolve, reject) => { row.resolve = resolve; row.reject = reject; });
  } };
  const subject = () => new rxjs.Subject();
  const ports = {
    projectService: { currentProjectPath$: subject(), coderWorkspace$: subject() },
    blocklyService: { selectedBlockIdsSubject: subject(), blockCodeMapSubject: subject(), aiWriting$: subject(), aiWaitWriting$: subject() },
    authService: { isLoggedIn$: subject(), authChanged$: subject() },
    configService: { getCurrentApiServer: () => '', configReloaded$: subject() },
    themeService: { themeChanged$: theme }, translate, toolI18n: loader,
    subappActivityService: activity, subappManager: { state$: catalog, progress$: subject() },
    uiService: { actionSubject: subject() }, cdr: { markForCheck() {} }, platformService: { isWindows: () => false },
  };
  const host = new ChildToolHostComponent(...parameters.map(name => ports[name] || {}));
  host.resolvedToolId = 'aily-chat'; host.ailyChatSessionId = 'chat';
  host.syncHostContext = () => contexts.push(translate.currentLang);
  host.syncSubappRestartRequirement = () => {};
  host.initTool = async () => {};
  host.remoteApi = { setSubappActivities(payload) { messages.push(copy(payload)); return Promise.resolve({ ok: true }); } };
  const configs = ['ble-debugger', 'serial-debugger', 'network-debugger'].map(id => ({ id, titleKey: id + '.TITLE', namespace: id }));
  registry.replaceChildToolConfigs(configs);
  host.ngOnInit();
  t.after(() => {
    for (const name of ['langSubscription', 'themeSubscription', 'projectPathSubscription', 'blockSelectionSubscription',
      'aiWritingStateSubscription', 'authStateSubscription', 'configReloadSubscription', 'subappCatalogSubscription',
      'subappProgressSubscription', 'toolSignalSubscription', 'subappActivitySubscription']) host[name]?.unsubscribe();
    host.remoteApi = null;
  });
  function add(toolId = 'ble-debugger', title = '历史蓝牙标题') {
    activity.recordInvocationStarted({ sessionId: 'chat', toolId, toolName: 'status', title, now: 1 });
  }
  function lang(value) { translate.currentLang = value; language.next({ lang: value }); }
  function titles() { return Object.fromEntries(messages.at(-1).items.map(row => [row.toolId, row.title])); }
  return { host, activity, registry, configs, dictionaries, translate, language, theme, catalog, messages, reads, contexts, add, lang, titles };
}

test('existing collapsed BLE/serial/network activities follow the host language without repeating business calls', async t => {
  const f = fixture(t);
  for (const config of f.configs) {
    f.dictionaries.zh_cn[config.titleKey] = '中文 ' + config.id;
    f.dictionaries.en[config.titleKey] = 'English ' + config.id;
    f.add(config.id, '历史 ' + config.id);
  }
  const history = copy(f.activity.getSessionActivities('chat'));
  for (const lang of ['zh_cn', 'en', 'zh_cn']) {
    f.lang(lang); await turn();
    for (const config of f.configs) assert.equal(f.titles()[config.id], f.dictionaries[lang][config.titleKey]);
    assert.deepEqual(copy(f.activity.getSessionActivities('chat')), history);
    assert.ok(f.messages.at(-1).items.every(row => row.surfaceState === 'collapsed' && row.invocationCount === 1));
  }
  assert.equal(f.contexts.length, 3);
});

test('a late namespace load replaces the fallback title even while its Dock is collapsed', async t => {
  const f = fixture(t, { pending: true }); f.add(); f.lang('en');
  assert.equal(f.titles()['ble-debugger'], '历史蓝牙标题');
  f.dictionaries.en['ble-debugger.TITLE'] = 'BLE Debugger';
  f.reads.filter(row => row.lang === 'en').forEach(row => row.resolve()); await turn();
  assert.equal(f.titles()['ble-debugger'], 'BLE Debugger');
  assert.equal(f.activity.getActivity('chat', 'ble-debugger').title, '历史蓝牙标题');
});

test('an obsolete language completion never sends a stale-language title', async t => {
  const f = fixture(t, { pending: true }); f.add(); f.lang('en'); f.lang('zh_cn');
  const count = f.messages.length;
  f.dictionaries.en['ble-debugger.TITLE'] = 'English stale';
  f.reads.filter(row => row.lang === 'en').forEach(row => row.resolve()); await turn();
  assert.equal(f.messages.length, count);
  f.dictionaries.zh_cn['ble-debugger.TITLE'] = '当前蓝牙';
  f.reads.filter(row => row.lang === 'zh_cn').forEach(row => row.resolve()); await turn();
  assert.equal(f.titles()['ble-debugger'], '当前蓝牙');
});

test('pending title loads coalesce and publish the latest invocation facts', async t => {
  const f = fixture(t, { pending: true }); f.lang('en'); f.add();
  f.activity.recordInvocationCompleted({ sessionId: 'chat', toolId: 'ble-debugger', state: 'succeeded', runtimeState: 'ready', now: 2 });
  const count = f.messages.length;
  f.dictionaries.en['ble-debugger.TITLE'] = 'BLE Debugger';
  f.reads.forEach(row => row.resolve()); await turn();
  assert.equal(f.messages.length, count + 1);
  assert.equal(f.messages.at(-1).items[0].invocationState, 'succeeded');
  assert.equal(f.messages.at(-1).items[0].activeInvocationCount, 0);
});

test('a pending completion cannot publish to a different chat session or a replaced peer', async t => {
  const f = fixture(t, { pending: true }); f.add();
  f.host.ailyChatSessionId = 'next'; f.host.pushChatSubappActivities();
  const count = f.messages.length;
  f.dictionaries.zh_cn['ble-debugger.TITLE'] = '当前蓝牙'; f.reads.forEach(row => row.resolve()); await turn();
  assert.equal(f.messages.length, count); assert.deepEqual(f.messages.at(-1), { sessionId: 'next', items: [] });
  f.host.ailyChatSessionId = 'chat'; f.host.pushChatSubappActivities();
  f.host.remoteApi = null; f.dictionaries.zh_cn['ble-debugger.TITLE'] = 'Late peer title'; const after = f.messages.length;
  f.reads.forEach(row => row.resolve()); await turn(); assert.equal(f.messages.length, after);
});

test('catalog refresh reprojects a registered title without modifying activity history', async t => {
  const f = fixture(t); f.add(); f.dictionaries.zh_cn['RENAMED.TITLE'] = '新目录标题';
  f.registry.replaceChildToolConfigs([{ ...f.configs[0], titleKey: 'RENAMED.TITLE' }]);
  f.catalog.next({}); await turn();
  assert.equal(f.titles()['ble-debugger'], '新目录标题');
  assert.equal(f.activity.getActivity('chat', 'ble-debugger').invocationCount, 1);
  assert.equal(f.activity.getActivity('chat', 'ble-debugger').title, '历史蓝牙标题');
});

test('unknown tools, missing or non-string translations and load failure preserve a readable fallback', async t => {
  const f = fixture(t, { pending: true }); f.add(); f.add('unregistered', 'Custom tool');
  f.dictionaries.zh_cn['ble-debugger.TITLE'] = {};
  f.host.pushChatSubappActivities(); f.reads.forEach(row => row.reject(Error('dictionary unavailable'))); await turn();
  assert.equal(f.titles()['ble-debugger'], '历史蓝牙标题'); assert.equal(f.titles().unregistered, 'Custom tool');
});

test('a non-Chat host only forwards its ordinary language/theme context', async t => {
  const f = fixture(t); f.host.resolvedToolId = 'serial-debugger';
  const count = f.messages.length; f.lang('en'); f.theme.next('light'); f.add(); await turn();
  assert.equal(f.messages.length, count); assert.equal(f.reads.length, 0); assert.equal(f.contexts.length, 2);
});
