'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const rxjs = require('rxjs');
const root = path.resolve(__dirname, '..');
const angular = { Component: () => value => value, Injectable: () => value => value, Input: () => () => {} };

function compile(relative, imports = {}) {
  const file = path.join(root, relative), module = { exports: {} };
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
  });
  assert.equal(result.diagnostics.length, 0);
  vm.runInNewContext(result.outputText, { module, exports: module.exports, console, setTimeout, clearTimeout,
    require(name) { return name === '@angular/core' ? angular : name === 'rxjs' ? rxjs : imports[name] || {}; },
  }, { filename: file });
  return module.exports;
}

const stateModule = compile('src/app/tools/child-tool-host/child-tool-ai-operation-state.ts');
const noticeModule = compile('src/app/tools/child-tool-host/child-tool-ai-operation-notice.ts');
const { ChildAiOperationState } = stateModule;
const { ChildToolHostComponent } = compile('src/app/tools/child-tool-host/child-tool-host.component.ts', {
  './child-tool-ai-operation-state': stateModule, './child-tool-ai-operation-notice': noticeModule,
});
const { AiOperationRegistryService } = compile('src/app/services/integrations/automation/ai-operation-registry.service.ts');
const { NoticeService } = compile('src/app/services/core/app-shell/notice.service.ts');
const { NotificationComponent } = compile('src/app/components/notification/notification.component.ts');
const copy = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const run = (sessionId = 'A', turnId = 'turn-A', extra = {}) => ({ sessionId, turnId, active: true, running: true, phase: 'running', ...extra });
const snapshot = (revision, runs = [run()], extra = {}) => ({ version: 2, scope: 'scope', bridgeInstanceId: 'bridge',
  revision, visibleSessionId: 'A', runs, ...extra });

function fixture(t, { stop } = {}) {
  const host = Object.create(ChildToolHostComponent.prototype);
  const notices = new NoticeService({ update() {} });
  const notification = new NotificationComponent(notices, { detectChanges() {} }, {});
  notification.ngOnInit();
  host.hostContextId = 'host'; host.aiOperationStateScope = 'scope';
  host.resolvedToolId = 'aily-chat'; host.projectService = { currentProjectPath: '/project/A' };
  host.aiOperationRegistry = new AiOperationRegistryService(); host.noticeService = notices;
  host.ailyChatOperationActive = false; host.aiLegacyRunning = false; host.aiLegacyStopping = false;
  const registry = new Map(), calls = [], errors = [];
  host.blocklyService = { aiWriting: false, aiWaitWriting: false, recoveryRequired: false,
    setAiExecutionActive(source, active) { if (active) registry.set(source, true); else registry.delete(source); },
    isWorkspaceRecoveryRequired() { return this.recoveryRequired; },
    clearAiWaitWriting() { this.aiWaitWriting = false; },
  };
  host.remoteApi = { async stopActiveTurn(owner) { calls.push(copy(owner)); return stop ? stop(owner) : { ok: true, requestAccepted: true, settled: false }; } };
  host.logError = (_message, error) => errors.push(error);
  t.after(() => notification.ngOnDestroy());
  const report = value => host.reportAiOperationState(value);
  const native = value => { Object.assign(host.blocklyService, value); host.refreshAiOperationNotice(); };
  return { host, notices, notification, calls, errors, registry, report, native };
}

function rebuildNotification(t, f) {
  f.notification.ngOnDestroy();
  const notification = new NotificationComponent(f.notices, { detectChanges() {} }, {});
  notification.ngOnInit();
  t.after(() => notification.ngOnDestroy());
  return notification;
}

test('an editor rebuild restores the current owned AI notice without rerunning or stopping its operation', async t => {
  const f = fixture(t);
  f.native({ aiWriting: true });
  f.report(snapshot(1));
  const notice = f.notices.data;
  const next = rebuildNotification(t, f);
  f.host.refreshAiOperationNotice(); // The unchanged owner intentionally emits no second notice.
  assert.equal(next.data?.title, 'AI正在操作');
  assert.equal(next.data.state, 'doing');
  assert.equal(next.data.showProgress, false);
  assert.equal(next.data.closable, false);
  assert.equal(next.data.stop, notice.stop);
  assert.equal(f.notices.data, notice, 'restoring a view must not republish the notice');
  assert.equal(f.calls.length, 0, 'mounting the view never invokes Stop');
  next.stop();
  await turn();
  assert.deepEqual(f.calls, [{ version: 2, bridgeInstanceId: 'bridge', sessionId: 'A', turnId: 'turn-A', scope: 'scope' }]);
  assert.equal(next.data.title, '正在停止 AI');
  f.report(snapshot(2, []));
  assert.equal(next.data.title, '正在结束工作区操作');
  f.native({ aiWriting: false });
  assert.equal(next.data, null);
  assert.equal(rebuildNotification(t, f).data ?? null, null, 'settled owners are not replayed');
});

test('an editor rebuild restores ownership after a load error covered the live AI operation, then Stop settles cleanly', async t => {
  const f = fixture(t);
  f.native({ aiWriting: true });
  f.report(snapshot(1));
  const running = f.notices.data;
  f.notices.update({ title: '加载项目失败', state: 'error' });
  f.host.refreshAiOperationNotice(); // Same live owner and kind: no new business publication.
  assert.equal(f.notices.data.title, '加载项目失败');

  const next = rebuildNotification(t, f);
  assert.equal(next.data?.title, 'AI正在操作');
  assert.equal(f.notices.data, running, 'the service must restore presentation ownership too');
  assert.equal(next.data.stop, running.stop);
  assert.equal(f.calls.length, 0);
  next.stop();
  await turn();
  assert.deepEqual(f.calls, [{ version: 2, bridgeInstanceId: 'bridge', sessionId: 'A', turnId: 'turn-A', scope: 'scope' }]);
  assert.equal(next.data.title, '正在停止 AI');
  f.report(snapshot(2, []));
  f.native({ aiWriting: false });
  assert.equal(next.data, null, 'the restored owner must be able to clear the view');
  assert.equal(f.notices.data, null);
  assert.equal(rebuildNotification(t, f).data ?? null, null);
});

test('restoring an owned presentation emits no duplicate log or business callback', t => {
  const logs = [];
  const notices = new NoticeService({ update(value) { logs.push(value); } });
  let stopCalls = 0;
  const notice = { title: 'Owned operation', state: 'doing', showProgress: false, detail: 'Original log', stop() { stopCalls++; } };
  notices.updateOwned('owner', notice);
  assert.equal(logs.length, 1);
  notices.update({ title: 'Load error', state: 'error', sendToLog: false });
  const views = [];
  t.after(() => views.forEach(view => view.ngOnDestroy()));
  for (let index = 0; index < 2; index++) {
    const view = new NotificationComponent(notices, { detectChanges() {} }, {});
    views.push(view);
    view.ngOnInit();
    assert.equal(view.data?.title, 'Owned operation');
    assert.equal(notices.data, notice);
    view.ngOnDestroy();
  }
  assert.equal(logs.length, 1);
  assert.equal(stopCalls, 0);
  assert.equal(notices.clearOwned('owner'), true);
});

test('a dismissed recovery warning does not revive after an editor rebuild', t => {
  const f = fixture(t);
  f.native({ recoveryRequired: true });
  f.notification.close();
  assert.equal(f.notification.data, null, 'the owner callback withdraws the presentation immediately');
  assert.equal(f.host.blocklyService.recoveryRequired, true);
  f.host.refreshAiOperationNotice();
  assert.equal(rebuildNotification(t, f).data ?? null, null);
});

test('an editor rebuild never replays locally closed owned results without an owner close callback', t => {
  for (const state of ['done', 'error', 'warn']) {
    const f = fixture(t);
    f.notices.updateOwned('finished-owner', { title: 'Old result', state });
    f.notification.close();
    const next = rebuildNotification(t, f);
    assert.equal(f.notices.data.title, 'Old result', 'the legacy close did not withdraw the owned service entry');
    assert.equal(next.data ?? null, null, `a closed ${state} notice must not return`);
  }
});

test('an editor rebuild does not replay a locally closed legacy notice', t => {
  const f = fixture(t);
  f.notices.update({ title: 'Old compiler result', state: 'done' });
  f.notification.close();
  const next = rebuildNotification(t, f);
  assert.equal(f.notices.data.title, 'Old compiler result', 'legacy data still exists in the service');
  assert.equal(next.data ?? null, null, 'legacy data is not a replayable owned presentation');
});

test('rebuilding under a compiler does not expose a covered AI owner, but clearing it restores that owner', t => {
  const f = fixture(t);
  f.report(snapshot(1));
  f.notices.update({ title: 'Compiling project', state: 'doing' });
  const next = rebuildNotification(t, f);
  assert.equal(next.data ?? null, null, 'a pending owner must not cover the current legacy notice');
  f.notices.clear();
  assert.equal(next.data.title, 'AI正在操作');
  assert.equal(f.calls.length, 0);
});

test('complete snapshots use operation owners despite a different visible session', t => {
  const f = fixture(t);
  f.report(snapshot(1));
  f.report(snapshot(2, [run(), run('B', 'turn-B', { active: false })], { visibleSessionId: 'B' }));
  assert.equal(f.notification.data.title, 'AI正在操作');
  f.notification.stop();
  assert.deepEqual(f.calls[0], { version: 2, bridgeInstanceId: 'bridge', sessionId: 'A', turnId: 'turn-A', scope: 'scope' });
  assert.equal(f.notification.data.title, '正在停止 AI');
  f.report(snapshot(3, [], { visibleSessionId: 'B' }));
  assert.equal(f.notification.data, null);
  assert.equal(f.host.aiOperationRegistry.readActive().length, 0);
});

test('duplicate acknowledgements converge while older/conflicting snapshots cannot revive a settled run', () => {
  const state = new ChildAiOperationState('scope');
  assert.equal(state.apply(snapshot(1)).applied, true);
  assert.equal(state.apply(snapshot(2, [])).applied, true);
  assert.equal(state.apply(snapshot(2, [])).applied, true, 'lost ACK resend is idempotently acknowledged');
  const stale = state.apply(snapshot(1));
  assert.equal(stale.applied, false); assert.equal(stale.currentRevision, 2);
  assert.equal(state.apply(snapshot(2)).code, 'AI_OPERATION_REVISION_CONFLICT');
  assert.equal(state.hasRunning, false);
});

test('connection scope and bridge binding reject old frame reports without touching new activity', t => {
  const f = fixture(t);
  f.report(snapshot(1));
  f.host.aiOperationStateScope = 'new-scope';
  f.host.aiOperationProtocol.reset('new-scope');
  assert.equal(f.report(snapshot(2)).code, 'AI_OPERATION_SCOPE_CHANGED');
  assert.equal(f.host.reportAiOperationState(snapshot(2, [], { scope: 'new-scope' }), 'scope').code, 'AI_OPERATION_SCOPE_CHANGED');
  const accepted = f.report(snapshot(1, [run('B', 'new-turn')], { scope: 'new-scope', bridgeInstanceId: 'new-bridge' }));
  assert.equal(accepted.applied, true);
  assert.equal(f.report(snapshot(3, [], { scope: 'new-scope' })).code, 'AI_OPERATION_BRIDGE_CHANGED');
  assert.equal(f.host.aiOperationProtocol.hasRunning, true);
});

test('malformed snapshots do not gain an owner or replace the current run', () => {
  const state = new ChildAiOperationState('scope');
  for (const invalid of [snapshot(0), snapshot(1, [run('A', '')]), snapshot(1, [run(), run()]),
    snapshot(1, [run('A', 'turn', { phase: 'idle' })]), snapshot(1, [run('A', 'turn', { active: 'yes' })])]) {
    assert.equal(state.apply(invalid).ok, false);
    assert.equal(state.hasRunning, false);
  }
});

test('Stop acceptance does not retire a busy native writer, and quarantine becomes a dismissible warning', async t => {
  const f = fixture(t);
  f.native({ aiWriting: true }); f.report(snapshot(1));
  const stop = f.notification.data.stop;
  stop(); stop(); await turn();
  assert.equal(f.calls.length, 1, 'the same exact owner has one pending cancellation');
  assert.equal(f.notification.data.title, '正在停止 AI');
  assert.equal(f.host.blocklyService.aiWriting, true);
  f.report(snapshot(2, []));
  assert.equal(f.notification.data.title, '正在结束工作区操作');
  assert.equal(f.notification.data.stop, undefined);
  f.native({ aiWriting: false, recoveryRequired: true });
  assert.equal(f.notification.data.title, '工作区需要恢复');
  assert.equal(f.notification.data.state, 'warn'); assert.equal(f.notification.data.closable, true);
  assert.equal(f.notification.data.stop, undefined);
  f.notification.close();
  f.host.refreshAiOperationNotice();
  assert.equal(f.host.blocklyService.recoveryRequired, true, 'dismissing a notice never releases source protection');
  assert.equal(f.host.blocklyService.aiWriting, false);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(f.notification.data, null, 'the recovery warning can be dismissed');
  f.host.refreshAiOperationNotice();
  assert.equal(f.notification.data, null, 'an unchanged recovery state does not reopen a dismissed warning');
  f.native({ recoveryRequired: false });
  assert.equal(f.notification.data, null);
});

test('a rejected Stop request becomes retryable without claiming the task settled', async t => {
  const f = fixture(t, { stop: async () => ({ ok: false, requestAccepted: false, settled: false }) });
  f.report(snapshot(1)); f.notification.stop(); await turn();
  assert.equal(f.notification.data.title, 'AI正在操作');
  f.notification.stop(); await turn();
  assert.equal(f.calls.length, 2); assert.equal(f.host.aiOperationProtocol.hasRunning, true);
});

test('an old stop callback cannot cancel a replacement turn in the same session', t => {
  const f = fixture(t);
  f.report(snapshot(1)); const oldStop = f.notification.data.stop;
  f.report(snapshot(2, [run('A', 'replacement-turn')]));
  oldStop();
  assert.equal(f.calls.length, 0);
  assert.equal(f.notification.data.title, 'AI正在操作');
});

test('idle cleanup and recovery warnings never remove or replace a compiler notice', t => {
  const f = fixture(t);
  f.notices.update({ title: 'Compiling project', state: 'doing', stop() {} });
  f.report(snapshot(1));
  assert.equal(f.notification.data.title, 'Compiling project');
  f.report(snapshot(2, [])); f.native({ recoveryRequired: true });
  assert.equal(f.notification.data.title, 'Compiling project');
  f.host.clearAiOperationNotice();
  assert.equal(f.notification.data.title, 'Compiling project');
});

test('one child owner cannot clear another child notice', () => {
  const notices = new NoticeService({ update() {} });
  assert.equal(notices.updateOwned('A', { title: 'A', state: 'doing' }), true);
  assert.equal(notices.updateOwned('B', { title: 'B', state: 'doing' }), false);
  assert.equal(notices.clearOwned('B'), false); assert.equal(notices.data.title, 'A');
  assert.equal(notices.clearOwned('A'), true); assert.equal(notices.data, null, 'B already withdrew its pending presentation');
});

test('a compiler temporarily covering AI work restores its current notice despite presentation caching', t => {
  const f = fixture(t);
  f.report(snapshot(1));
  f.notices.update({ title: 'Compiling project', state: 'doing' });
  f.host.refreshAiOperationNotice();
  assert.equal(f.notification.data.title, 'Compiling project');
  f.notices.clear();
  assert.equal(f.notification.data.title, 'AI正在操作');
  f.notices.update({ title: 'Second compilation', state: 'doing' });
  f.report(snapshot(2, []));
  assert.equal(f.notification.data.title, 'Second compilation');
  f.notices.clear();
  assert.equal(f.notification.data, null, 'a settled pending AI presentation is withdrawn');
});

test('dismissing a recovery warning withdraws it from ownership restoration without changing protection', t => {
  const f = fixture(t);
  f.native({ recoveryRequired: true });
  f.notification.close();
  assert.equal(f.notification.data, null);
  f.notices.update({ title: 'Compilation', state: 'doing' }); f.notices.clear();
  assert.equal(f.notification.data, null);
  assert.equal(f.host.blocklyService.recoveryRequired, true);
});

test('a reconnect keeps known work synchronizing without Stop until its new-scope snapshot arrives', t => {
  const f = fixture(t);
  f.host.closeNativeWebviewSurface = async () => ({ ok: true });
  f.report(snapshot(1));
  const oldStop = f.notification.data.stop;
  f.host.destroyPenpalConnection();
  assert.equal(f.host.aiOperationProtocol.hasRunning, true);
  assert.equal(f.notification.data.title, '正在同步 AI 状态');
  assert.equal(f.notification.data.stop, undefined);
  assert.equal(f.host.aiOperationRegistry.readActive().length > 0, true);
  oldStop(); assert.equal(f.calls.length, 0);
  assert.equal(f.report(snapshot(2, [])).code, 'AI_OPERATION_SCOPE_CHANGED');
  assert.equal(f.notification.data.title, '正在同步 AI 状态');
  const scope = f.host.aiOperationStateScope;
  f.report(snapshot(1, [], { scope, bridgeInstanceId: 'reconnected-bridge' }));
  assert.equal(f.notification.data, null);
  assert.equal(f.host.aiOperationRegistry.readActive().length, 0);
});

test('legacy session idle retains its own scope and cannot mutate another active owner registry', t => {
  const f = fixture(t);
  f.report({ running: true, active: true, sessionId: 'A' });
  const before = copy(f.host.aiOperationRegistry.readActive());
  f.report({ running: false, active: false, sessionId: 'B' });
  assert.deepEqual(copy(f.host.aiOperationRegistry.readActive()), before);
  assert.equal(f.notification.data.title, 'AI正在操作');
  f.report({ running: false, active: false, sessionId: 'A' });
  assert.equal(f.notification.data, null);
});

test('actual host subscriptions turn a settled writer into a recovery warning without another child report', t => {
  const notices = new NoticeService({ update() {} });
  const notification = new NotificationComponent(notices, { detectChanges() {} }, {});
  notification.ngOnInit();
  const writing = new rxjs.BehaviorSubject(false), waiting = new rxjs.BehaviorSubject(false), recovery = new rxjs.BehaviorSubject(false);
  const subject = () => new rxjs.Subject();
  const blockly = { aiWriting$: writing, aiWaitWriting$: waiting, workspaceRecoveryRequired$: recovery,
    selectedBlockIdsSubject: subject(), blockCodeMapSubject: subject(),
    get aiWriting() { return writing.value; }, get aiWaitWriting() { return waiting.value; },
    isWorkspaceRecoveryRequired: () => recovery.value, clearAiWaitWriting() { waiting.next(false); }, setAiExecutionActive() {},
  };
  const ports = { noticeService: notices, aiOperationRegistry: new AiOperationRegistryService(), blocklyService: blockly,
    projectService: { currentProjectPath: '/A', currentProjectPath$: subject(), coderWorkspace$: subject() },
    platformService: { isWindows: () => false }, translate: { onLangChange: subject() }, themeService: { themeChanged$: subject() },
    authService: { isLoggedIn$: subject(), authChanged$: subject() }, configService: { getCurrentApiServer: () => '', configReloaded$: subject() },
  };
  const file = path.join(root, 'src/app/tools/child-tool-host/child-tool-host.component.ts');
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(item => ts.isClassDeclaration(item) && item.name.text === 'ChildToolHostComponent');
  const args = declaration.members.find(ts.isConstructorDeclaration).parameters.map(item => ports[item.name.getText(ast)] || {});
  const host = new ChildToolHostComponent(...args);
  host.resolvedToolId = 'aily-chat';
  host.reportAiOperationState(snapshot(1, [run()], { scope: host.aiOperationStateScope }));
  writing.next(true);
  host.reportAiOperationState(snapshot(2, [], { scope: host.aiOperationStateScope }));
  assert.equal(notification.data.title, '正在结束工作区操作');
  recovery.next(true); writing.next(false);
  assert.equal(notification.data.title, '工作区需要恢复'); assert.equal(notification.data.stop, undefined);
  recovery.next(false);
  assert.equal(notification.data, null);
  t.after(() => {
    notification.ngOnDestroy();
    for (const name of ['langSubscription', 'themeSubscription', 'projectPathSubscription', 'blockSelectionSubscription',
      'aiWritingStateSubscription', 'authStateSubscription', 'configReloadSubscription']) host[name]?.unsubscribe();
  });
});
