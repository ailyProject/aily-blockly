'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const project = path.resolve('cmd-settlement-project');

function fixture({ canRelease = () => true, stop = async () => false, stopJob, buildDeliveryAuthority, shared } = {}) {
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
      if (shared && name === './shared-blockly-build') return {
        sharedBlocklyBuildEnabled: () => true, sharedBuildCommand: () => shared.config,
        withSharedBuildAdmission: shared.admit,
      };
      if (shared && name === './child-script-path') return { childScriptPath: () => 'fixture:build-execution-workspace' };
      if (shared && name === 'fixture:build-execution-workspace') return { settleUnstartedSharedBuild: shared.settle };
      if (name === './process-tree') return {
        captureRegisteredProcessIdentity: async () => '123456',
        async killRegisteredProcessTree(pid, name, options) { signals.push({ pid, name, options }); return stop(options); }
      };
      if (name === './child-process-message-port') {
        const port = realRequire(name);
        return { ...port, normalizeProcessMessagePortConfig: value =>
          port.normalizeProcessMessagePortConfig(value && { ...value }) };
      }
      if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: workspace => workspace && {
        releaseAfterOwnerExit: () => false, releaseAfterTermination: () => false, canReleaseResources: canRelease
      } };
      if (name === './owned-process') return {
        spawn() {
          const child = Object.assign(new EventEmitter(), {
            pid: 70001 + children.length, exitCode: null, signalCode: null, stderr: new EventEmitter(), stdout: new EventEmitter()
          });
          children.push(child);
          return child;
        },
        getOwnedProcessInfo: () => stopJob ? { released: false } : null,
        stopOwnedProcess: stopJob,
      };
      return realRequire(name);
    }
  }, { filename });
  const api = original.exports;
  api.registerCmdHandlers(undefined, { buildDeliveryAuthority, canClearSharedBuild: () => !!shared });
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

test('host admission refusal records only the exact undispatched shared build and preserves the cause', async () => {
  const execution = { id: 'pending-execution', buildRequestId: 'pending-build', operation: 'compile' };
  const error = Object.assign(new Error('Original Job is not verified.'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
  const settled = [];
  const f = fixture({ shared: {
    config: { execution }, admit: async () => { throw error; },
    settle(...args) {
      settled.push(args);
      return { status: 'not-started', code: error.code, message: 'The previous cache owner is unverified.' };
    },
  } });
  const result = await f.start('new-stream', { projectPath: project, projectSessionId: 'active-opening', buildWorkspace: project });
  assert.equal(result.success, false);
  assert.equal(result.buildOutcome, 'not-started');
  assert.equal(result.code, error.code);
  assert.equal(result.error, 'The previous cache owner is unverified.');
  assert.deepEqual(settled, [[project, execution, error]]);
  assert.equal(f.children.length, 0);
});

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

test('build delivery and the renderer close wait for native Job cleanup', async () => {
  let finish;
  const deliveryExits = [];
  const f = fixture({
    stopJob: () => new Promise(resolve => { finish = resolve; }),
    buildDeliveryAuthority: {
      invalidate() {},
      async begin() {
        return { handle: 'delivery', onExit: (...args) => deliveryExits.push(args), abandon() {} };
      },
    },
  });
  const streamId = 'normal-native-build';
  assert.equal((await f.start(streamId, { buildWorkspace: project, buildDeliveryRequest: 'request.json' })).success, true);
  close(f.children[0]);
  assert.deepEqual(deliveryExits, []);
  assert.deepEqual(f.events, []);
  assert.equal((await f.status(streamId)).state, 'running');
  assert.equal((await f.status(streamId)).ownershipReleased, false);

  finish(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(deliveryExits, [[0, null, false]]);
  assert.equal(f.events[0]?.[1].type, 'close');
  assert.equal(f.events[0]?.[1].ownershipReleased, true);
  assert.equal((await f.status(streamId)).code, 0);
  assert.deepEqual(f.signals, []);
});

test('a closed build with a retained Job can retry the original Job', async () => {
  const f = fixture({ stopJob: async () => false, stop: async () => true });
  const streamId = 'retained-native-build';
  assert.equal((await f.start(streamId, { buildWorkspace: project })).success, true);
  close(f.children[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.status(streamId)).ownershipReleased, false);
  assert.equal(f.events[0]?.[1].ownershipReleased, false);

  assert.equal((await f.stop(streamId)).success, true);
  assert.equal(f.signals[0]?.options.registered, f.children[0]);
  assert.equal((await f.status(streamId)).ownershipReleased, true);
});
