'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const ts = require('typescript');
const { createApplicationQuitCoordinator } = require('../../electron/application-quit');

function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, "../../electron", file), 'utf8'), ts.ScriptTarget.Latest, true);
}
function select(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  assert.equal(found.length, 1);
  return found[0].getText(root);
}
const main = source('main.js');
const cleanup = select(main, node => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupRegisteredChildProcesses');
const quitSetup = select(main, node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => declaration.name.getText(main) === 'applicationQuit'));
const settle = () => new Promise(resolve => setImmediate(resolve));

function host(overrides = {}) {
  const app = new EventEmitter();
  const calls = [];
  const warnings = [];
  let quits = 0;
  app.quit = () => { quits++; };
  const sandbox = vm.createContext({
    app, console: { info() {}, warn(...args) { warnings.push({ args, calls: [...calls] }); } },
    ipcMain: new EventEmitter(), mainWindow: null, createApplicationQuitCoordinator,
    isCurrentRendererGenerationReady: () => false,
    beginWindowShutdown: () => calls.push('notify-windows'), cliBridge: { close: () => calls.push('stop-cli') },
    beginCommandShutdown: () => calls.push('block-commands'),
    beginNpmShutdown: () => calls.push('block-npm'),
    beginAuthCredentialsShutdown: () => calls.push('block-auth'),
    stopAllChildToolSessions: async () => { calls.push('stop-child-tools'); return { complete: true }; },
    releaseAllAuthCredentialsLocks: () => calls.push('release-auth'),
    getActiveCmdProcesses: () => [], getActiveNpmProcesses: () => [],
    getActiveTerminals: () => [], getActiveAilyServicesStreams: () => [],
    require: name => {
      assert.equal(name, './library-dependencies');
      return { stopLibraryDependencyWorkers: async () => calls.push('stop-libraries') };
    },
    cloudBuildController: { shutdown: async () => calls.push('stop-cloud') },
    killAllCmdProcesses: async () => { calls.push('stop-commands'); return true; },
    killAllNpmProcesses: async () => { calls.push('stop-npm'); return true; },
    killAllTerminals: async () => {}, cancelAllAilyServicesStreams: async () => {},
    connector: { shutdown: async () => {} }, simulatorGateway: { stop: async () => {} },
    simulatorSubappHost: { defaultHost: { stop: async () => {} } },
    packagedRendererServer: { close: async () => {} },
    ...overrides,
  });
  vm.runInContext(cleanup + '\n' + quitSetup, sandbox);
  return { calls, warnings, get quits() { return quits; },
    get completed() { return vm.runInContext('applicationQuit.canClose()', sandbox); },
    begin() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
  };
}

test('quit blocks new commands and installers before stopping registered processes', async () => {
  const h = host();
  assert.equal(h.begin(), true);
  await settle();
  assert.deepEqual(h.calls, ['notify-windows', 'stop-cli', 'block-commands', 'block-npm', 'block-auth', 'stop-child-tools', 'stop-libraries', 'stop-cloud', 'stop-commands', 'stop-npm', 'release-auth']);
  assert.deepEqual(h.warnings, []);
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
  assert.equal(h.begin(), false);
});

test('quit waits for both pending library mutations and cloud cancellation', async () => {
  let finishLibrary, finishCloud;
  const h = host({
    require: () => ({ stopLibraryDependencyWorkers: () => new Promise(resolve => { finishLibrary = resolve; }) }),
    cloudBuildController: { shutdown: () => new Promise(resolve => { finishCloud = resolve; }) },
  });
  h.begin(); await settle();
  assert.equal(h.quits, 0);
  finishLibrary(); await settle();
  assert.equal(h.quits, 0);
  finishCloud(); await settle();
  assert.equal(h.quits, 1);
  assert.equal(h.completed, true);
});

test('duplicate quit shares cleanup and waits for registered process cleanup', async () => {
  let finish, stops = 0;
  const h = host({ killAllCmdProcesses: () => { stops++; return new Promise(resolve => { finish = resolve; }); } });
  h.begin(); h.begin(); await settle();
  assert.equal(stops, 1);
  assert.equal(h.quits, 0);
  finish(true); await settle();
  assert.equal(h.quits, 1);
});

test('one failing cleanup still allows the remaining services to finish before quit', async () => {
  let finish;
  const h = host({
    killAllCmdProcesses: async () => { throw new Error('fixture stop failure'); },
    killAllNpmProcesses: () => new Promise(resolve => { finish = resolve; }),
  });
  h.begin(); await settle();
  assert.equal(h.quits, 0);
  finish(true); await settle();
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
});

test('application cleanup waits for child-tool owner and Runtime drain before the process fallback', async () => {
  const childTools = Promise.withResolvers(); let drains = 0;
  const h = host({ stopAllChildToolSessions: () => { drains++; return childTools.promise; } });
  h.begin(); h.begin(); await settle();
  assert.equal(drains, 1);
  assert.deepEqual(h.calls, ['notify-windows', 'stop-cli', 'block-commands', 'block-npm', 'block-auth']);
  assert.equal(h.completed, false); assert.equal(h.quits, 0);
  childTools.resolve({ complete: true }); await settle();
  assert(h.calls.indexOf('stop-libraries') > h.calls.indexOf('block-auth'));
  assert(h.calls.includes('stop-commands'));
  assert.equal(h.completed, true); assert.equal(h.quits, 1); assert.deepEqual(h.warnings, []);
});

test('an incomplete child-tool drain is reported before the registered-process fallback', async () => {
  const failure = { complete: false, timedOut: true, sessions: 1, pending: 1,
    ownerCleanup: { complete: false, timedOut: true, pending: 1, errors: ['deadline'] } };
  let drains = 0;
  const h = host({ stopAllChildToolSessions: async () => { drains++; return failure; } });
  h.begin(); await settle();
  assert.equal(drains, 1); assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.warnings[0].args, ['[PROC_TRACE][CHILD_TOOL_SHUTDOWN_INCOMPLETE]', failure]);
  assert.deepEqual(h.warnings[0].calls, ['notify-windows', 'stop-cli', 'block-commands', 'block-npm', 'block-auth']);
  assert(h.calls.includes('stop-commands')); assert(h.calls.includes('stop-npm'));
  assert.equal(h.completed, true); assert.equal(h.quits, 1);
  assert.equal(failure.ownerCleanup.complete, false, 'fallback must not relabel owner cleanup as acknowledged');
});

test('native main-window close waits for process cleanup', () => {
  const win = source('window.js');
  const close = select(win, node => ts.isCallExpression(node) && node.expression.getText(win) === 'mainWindow.on'
    && node.arguments[0]?.text === 'close');
  const mainWindow = new EventEmitter();
  let complete = false, quits = 0, prevented = 0;
  vm.runInNewContext(close, { mainWindow, options: { canCloseMainWindow: () => complete },
    process: { platform: 'win32' }, applicationIsQuitting: false, app: { quit: () => { quits++; } } });
  mainWindow.emit('close', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(quits, 1);
  complete = true;
  mainWindow.emit('close', { preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1); assert.equal(quits, 1);
});
