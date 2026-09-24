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
function handler(root, receiver, channel) {
  return select(root, node => ts.isCallExpression(node) && node.expression.getText(root) === receiver
    && node.arguments[0]?.text === channel);
}
const main = source('main.js');
const waitForResources = select(main, node => ts.isFunctionDeclaration(node) && node.name?.text === 'waitForAppDataResourceCleanup');
const cleanup = select(main, node => ts.isFunctionDeclaration(node) && node.name?.text === 'cleanupRegisteredChildProcesses');
const beforeQuit = select(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'app.on'
  && node.arguments[0]?.text === 'before-quit' && node.arguments[1]?.parameters?.length === 1);
const settle = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  return {
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

function host(overrides = {}) {
  const app = new EventEmitter();
  const calls = [];
  let quits = 0;
  app.quit = () => { quits++; };
  const sandbox = vm.createContext({
    app, setTimeout, clearTimeout,
    console: { info() {}, warn() {} },
    beginCommandShutdown: () => calls.push('block-commands'),
    beginAppDataResourceShutdown: () => calls.push('block-locks'),
    getActiveCmdProcesses: () => [], getActiveNpmProcesses: () => [],
    getActiveTerminals: () => [], getActiveAilyServicesStreams: () => [],
    killAllCmdProcesses: async () => { calls.push('stop-commands'); return true; },
    killAllNpmProcesses: async () => true,
    killAllTerminals: async () => {}, cancelAllAilyServicesStreams: async () => {},
    connector: { shutdown: async () => {} }, simulatorGateway: { stop: async () => {} },
    simulatorSubappHost: { defaultHost: { stop: async () => {} } },
    packagedRendererServer: { close: async () => {} },
    releaseAllAppDataResourceLocks: () => { calls.push('release-locks'); return { ok: true }; },
    ...overrides,
  });
  vm.runInContext('let hasProcessCleanupCompleted = false; let isProcessCleanupInProgress = false;\n'
    + waitForResources + '\n' + cleanup + '\n' + beforeQuit + ';', sandbox);
  return { calls, get quits() { return quits; },
    get completed() { return vm.runInContext('hasProcessCleanupCompleted', sandbox); },
    begin() { let prevented = false; app.emit('before-quit', { preventDefault() { prevented = true; } }); return prevented; },
  };
}

test('quit blocks new work, stops borrowers, then releases AppData locks', async () => {
  const h = host();
  assert.equal(h.begin(), true);
  await settle();
  assert.deepEqual(h.calls, ['block-commands', 'block-locks', 'stop-commands', 'release-locks']);
  assert.equal(h.completed, true);
  assert.equal(h.quits, 1);
  assert.equal(h.begin(), false);
});

test('duplicate quit shares cleanup and waits for renderer writes to return their leases', async () => {
  const time = clock();
  let released = false;
  const h = host({ ...time, releaseAllAppDataResourceLocks: () => ({ ok: released, retained: released ? 0 : 1 }) });
  h.begin(); h.begin(); await settle();
  assert.equal(h.calls.filter(value => value === 'stop-commands').length, 1);
  assert.equal(h.quits, 0);
  await time.advance(499);
  assert.equal(h.quits, 0);
  released = true;
  await time.advance(1);
  assert.equal(h.quits, 1);
});

for (const failed of ['commands', 'npm']) {
  test('failed ' + failed + ' AppData cleanup does not prevent quit or force-delete live locks', async () => {
    const overrides = {};
    if (failed === 'commands') overrides.killAllCmdProcesses = async () => false;
    if (failed === 'npm') overrides.killAllNpmProcesses = async () => false;
    const h = host(overrides);
    h.begin(); await settle();
    assert.equal(h.completed, true);
    assert.equal(h.quits, 1);
    assert.equal(h.calls.includes('release-locks'), false);
    assert.equal(h.begin(), false);
  });
}

test('AppData cleanup waits at most five seconds, and late completion cannot quit twice', async () => {
  let expire, finish, cancelled = false;
  const h = host({
    killAllCmdProcesses: () => new Promise(resolve => { finish = resolve; }),
    setTimeout: (callback, delay) => { assert.equal(delay, 5000); expire = callback; return 7; },
    clearTimeout: id => { assert.equal(id, 7); cancelled = true; },
  });
  h.begin(); h.begin(); await settle();
  assert.equal(h.quits, 0);
  expire(); await settle();
  assert.equal(h.quits, 1);
  assert.equal(cancelled, true);
  assert.equal(h.calls.includes('release-locks'), false);
  finish(false); await settle();
  assert.equal(h.quits, 1);
  assert.equal(h.calls.includes('release-locks'), false);
});

test('native main-window close retains renderer until bounded AppData cleanup returns', () => {
  const win = source('window.js');
  const close = handler(win, 'mainWindow.on', 'close');
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

test('project close waits only for its owner scopes and returns unresolved cleanup after five seconds', async () => {
  const code = handler(main, 'ipcMain.handle', 'project-appdata-drain');
  const sender = { id: 3, mainFrame: {} };
  const time = clock();
  let releaseOk = false;
  const releasedOwners = [];
  let invoke;
  vm.runInNewContext(waitForResources + '\n' + code, {
    ...time,
    ipcMain: { handle: (_channel, callback) => { invoke = callback; } },
    mainWindow: { webContents: sender }, isCurrentMainRenderer: owner => owner === sender,
    releaseAllAppDataResourceLocks: owner => { releasedOwners.push(owner); return { ok: releaseOk }; },
  });
  const event = { sender, senderFrame: sender.mainFrame };
  const closing = invoke(event);
  assert.deepEqual(releasedOwners, [3]);
  releaseOk = true;
  await time.advance(500);
  assert.equal((await closing).ok, true);
  assert.deepEqual(releasedOwners, [3, 3]);
  releaseOk = false;
  let completed = false;
  const unresolved = invoke(event).then(result => { completed = true; return result; });
  await time.advance(4999);
  assert.equal(completed, false);
  await time.advance(1);
  assert.equal((await unresolved).ok, false);
  assert.equal(releasedOwners.every(owner => owner === 3), true);
});
