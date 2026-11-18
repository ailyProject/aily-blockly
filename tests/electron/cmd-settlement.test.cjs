'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const project = path.resolve('cmd-settlement-project');

function fixture({ canRelease = () => true, stop = async () => false } = {}) {
  const filename = path.join(__dirname, '../../electron/cmd.js');
  const realRequire = createRequire(filename);
  const handlers = new Map(), children = [], signals = [];
  const original = { exports: {} };
  const childOwner = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename), module: original, exports: original.exports, process,
    AbortController, setTimeout, clearTimeout, console: { log() {}, info() {}, warn() {}, error() {} },
    require(name) {
      if (name === 'electron') return childOwner;
      if (name === './process-tree') return {
        captureRegisteredProcessIdentity: async () => '123456',
        async killRegisteredProcessTree(pid, name, options) { signals.push({ pid, name, options }); return stop(options); }
      };
      if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: workspace => workspace && {
        releaseAfterOwnerExit: () => false, releaseAfterTermination: () => false, canReleaseResources: canRelease
      } };
      if (name === 'child_process') return { spawn() {
        const child = Object.assign(new EventEmitter(), {
          pid: 70001 + children.length, exitCode: null, signalCode: null, stderr: new EventEmitter(), stdout: new EventEmitter()
        });
        children.push(child);
        return child;
      } };
      return realRequire(name);
    }
  }, { filename });
  const api = original.exports;
  api.registerCmdHandlers();
  const events = [];
  const owner = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false, send: (...args) => events.push(args)
  });
  const other = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const foreign = { sender: other, senderFrame: other.mainFrame };
  return {
    api, owner, children, events, signals,
    start: (streamId, opts = {}) => handlers.get('cmd-run')(event, {
      streamId, command: 'node', args: ['-e', ''], cwd: project, shellProfile: false, ...opts
    }),
    stop: streamId => handlers.get('cmd-kill')(event, { streamId }),
    foreignStop: streamId => handlers.get('cmd-kill')(foreign, { streamId }),
    status: streamId => handlers.get('cmd-status')(event, { streamId }),
    foreignStatus: streamId => handlers.get('cmd-status')(foreign, { streamId })
  };
}

function close(child, code = 0) {
  child.exitCode = code;
  child.emit('close', code, null);
}

test('a late exact workspace proof releases only the original stream without a second signal', async () => {
  let prove = false, finish;
  const f = fixture({ canRelease: () => prove, stop: () => new Promise(resolve => { finish = resolve; }) });
  const original = 'original-cancel-unconfirmed';
  assert.equal((await f.start(original, { buildWorkspace: project, backgroundPreprocess: true })).success, true);
  const stopping = f.stop(original);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  close(f.children[0]);
  finish(false);
  assert.equal((await stopping).success, false);
  assert.equal((await f.status(original)).ownershipReleased, false);
  const newer = 'new-unrelated-command';
  assert.equal((await f.start(newer)).success, true);
  prove = true;
  const receipt = await f.status(original);
  assert.equal(receipt.streamId, original);
  assert.equal(receipt.state, 'exited');
  assert.equal(receipt.code, 0);
  assert.equal(receipt.terminationConfirmed, true);
  assert.equal(receipt.ownershipReleased, true);
  assert.equal(f.api.getCmdProcess(original), undefined);
  assert.equal((await f.status(newer)).state, 'running');
  assert.equal(f.api.getCmdProcess(newer), f.children[1]);
  assert.equal(f.signals.length, 1);
  assert.equal((await f.foreignStatus(original)).state, 'unknown');
  assert.equal((await f.status('unseen-command')).ownershipReleased, false);
  close(f.children[1]);
});

test('a stop cannot address a foreign live stream or a new admission under a retained stream ID', async () => {
  const f = fixture();
  const original = 'has-immutable-ownership';
  await f.start(original);
  assert.equal((await f.foreignStop(original)).success, false);
  assert.deepEqual(f.signals, []);
  close(f.children[0]);
  assert.equal((await f.start(original)).success, false);
  assert.equal(f.children.length, 1);
  assert.equal((await f.status(original)).ownershipReleased, true);
  assert.equal((await f.stop(original)).success, true);
  assert.deepEqual(f.signals, []);
});

test('an old project opening stop cannot select a later same-directory command', async () => {
  const f = fixture();
  const oldOpening = 'old-opening', newOpening = 'new-opening';
  assert.equal((await f.start('scoped-new', { projectPath: project, projectSessionId: newOpening })).success, true);
  assert.equal((await f.start('legacy-new')).success, true);
  assert.equal(await f.api.killOwnerProjectCmdProcesses(f.owner, project, oldOpening), true);
  assert.deepEqual(f.signals, []);
  for (const child of f.children) close(child);
});

test('the host rechecks the closed original tree after a failed stop without a second signal', async () => {
  let released = false, finish;
  const f = fixture({ stop: ({ observe }) => {
    observe(async () => released);
    return new Promise(resolve => { finish = resolve; });
  } });
  const original = 'original-project-command';
  assert.equal((await f.start(original, { projectPath: project, projectSessionId: 'opening-1' })).success, true);
  const stopping = f.stop(original);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  close(f.children[0]);
  finish(false);
  assert.equal((await stopping).success, false);
  released = true;
  const started = Date.now();
  while (f.api.getCmdProcess(original) && Date.now() - started < 4000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(f.api.getCmdProcess(original), undefined);
  assert.equal((await f.status(original)).ownershipReleased, true);
  assert.equal(f.signals.length, 1);
});
