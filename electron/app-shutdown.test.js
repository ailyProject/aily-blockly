'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const ts = require('typescript');

function source(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
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
const beforeQuit = select(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'app.on'
  && node.arguments[0]?.text === 'before-quit' && node.arguments[1]?.parameters?.length === 1);
const settle = () => new Promise(resolve => setImmediate(resolve));

function host(overrides = {}) {
  const app = new EventEmitter();
  const calls = [];
  let quits = 0;
  app.quit = () => { quits++; };
  const sandbox = vm.createContext({
    app, console: { info() {}, warn() {} },
    beginCommandShutdown: () => calls.push('block-commands'),
    beginNpmShutdown: () => calls.push('block-npm'),
    beginAuthCredentialsShutdown: () => calls.push('block-auth'),
    releaseAllAuthCredentialsLocks: () => calls.push('release-auth'),
    getActiveCmdProcesses: () => [], getActiveNpmProcesses: () => [],
    getActiveTerminals: () => [], getActiveAilyServicesStreams: () => [],
    killAllCmdProcesses: async () => { calls.push('stop-commands'); return true; },
    killAllNpmProcesses: async () => { calls.push('stop-npm'); return true; },
    killAllTerminals: async () => {}, cancelAllAilyServicesStreams: async () => {},
    connector: { shutdown: async () => {} }, simulatorGateway: { stop: async () => {} },
    simulatorSubappHost: { defaultHost: { stop: async () => {} } },
    packagedRendererServer: { close: async () => {} },
    ...overrides,
  });
  vm.runInContext('let hasProcessCleanupCompleted = false; let isProcessCleanupInProgress = false;\n'
    + cleanup + '\n' + beforeQuit + ';', sandbox);
  return { calls, get quits() { return quits; },
    get completed() { return vm.runInContext('hasProcessCleanupCompleted', sandbox); },
    begin() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
  };
}

test('quit blocks new commands and installers before stopping registered processes', async () => {
  const h = host();
  assert.equal(h.begin(), true);
  await settle();
  assert.deepEqual(h.calls, ['block-commands', 'block-npm', 'block-auth', 'stop-commands', 'stop-npm', 'release-auth']);
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
  assert.equal(h.begin(), false);
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
