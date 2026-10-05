'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const test = require('node:test');
const { CommandManager } = require('./cmd');
const { createBuildWorkspaceSupervisor } = require('./build-workspace-supervisor');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');

// Keep event ordering deterministic without killing real processes or exposing
// test-only command APIs. Real process-tree/marker integration is covered below.
function cancellationFixture({ terminate, workspace, viaIpc = false } = {}) {
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const filename = require.resolve('./cmd');
  let killCalls = 0, spawnCalls = 0;
  const timers = [], handlers = new Map();
  const context = { module: { exports: {} }, process, console: { info() {}, log() {}, warn() {}, error() {} },
    setTimeout: callback => { const timer = { callback, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
    require: name => {
      if (name === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
      if (name === 'child_process') return { spawn: () => { spawnCalls++; return child; } };
      if (name === './platform') return { isLinux: true };
      if (name === './process-tree') return { killRegisteredProcessTree: () => { killCalls++; return terminate(); } };
      if (name === './build-workspace-supervisor') return { createBuildWorkspaceSupervisor: () => workspace };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports, manager = new api.CommandManager();
  if (!viaIpc) manager.executeCommand({ command: process.execPath, streamId: 'cancel', shellProfile: false });
  return { manager, api, handlers, child, get killCalls() { return killCalls; }, get spawnCalls() { return spawnCalls; },
    retryCleanup: () => {
      const timer = timers.shift();
      if (timer && !timer.cancelled) timer.callback();
      return !!timer;
    },
  };
}

test('Windows taskkill has a finite deadline and timeout cannot confirm termination', async () => {
  const context = { module: { exports: {} }, console: { info() {} },
    require: name => {
      if (name === './platform') return { isWin32: true };
      return { exec: (command, options, done) => {
        assert.equal(command, 'taskkill /PID 12345 /T /F');
        assert.equal(options.windowsHide, true);
        assert.ok(options.timeout > 0 && options.timeout <= 10000);
        done(Object.assign(new Error('timed out'), { killed: true }), '', '');
      } };
    },
  };
  const filename = require.resolve('./process-tree');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  assert.equal(await context.module.exports.killRegisteredProcessTree(12345, 'timeout-test'), false);
});

test('concurrent cancellation waits for one tree result even when parent close happens first', async () => {
  let finish;
  const f = cancellationFixture({ terminate: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.manager.killProcess('cancel'), second = f.manager.killProcess('cancel');
  f.child.emit('close', 1, null);
  assert.equal(f.killCalls, 1); assert.equal(f.manager.getProcess('cancel'), f.child);
  finish(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.manager.getProcess('cancel'), undefined);
  assert.equal(await f.manager.killProcess('cancel'), true);
});

test('failed cancellation remains retryable while live and cannot retarget a closed PID', async () => {
  let stopped = false;
  const f = cancellationFixture({ terminate: async () => stopped });
  assert.equal(await f.manager.killProcess('cancel'), false);
  assert.equal(f.manager.getProcess('cancel'), f.child);
  stopped = true;
  assert.equal(await f.manager.killProcess('cancel'), true);
  assert.equal(f.killCalls, 2); assert.equal(f.manager.getProcess('cancel'), undefined);

  const closed = cancellationFixture({ terminate: async () => false });
  assert.equal(await closed.manager.killProcess('cancel'), false);
  closed.child.emit('close', 0, null);
  assert.equal(await closed.manager.killProcess('cancel'), true);
  assert.equal(closed.killCalls, 1); assert.equal(closed.manager.getProcess('cancel'), undefined);
});

test('confirmed termination retries failed marker cleanup without killing the process again', async () => {
  let finish, attempts = 0, markerPresent = true;
  const f = cancellationFixture({
    terminate: () => new Promise(resolve => { finish = resolve; }),
    workspace: {
      releaseAfterTermination: () => {
        if (++attempts === 1) throw Object.assign(new Error('temporary unlink failure'), { code: 'EPERM' });
        markerPresent = false;
        return true;
      },
      canReleaseResources: () => !markerPresent,
    },
  });
  const first = f.manager.killProcess('cancel');
  f.child.emit('close', 1, null);
  finish(true);
  assert.equal(await first, true);
  assert.equal(f.manager.getProcess('cancel'), f.child);
  assert.equal(f.retryCleanup(), true);
  assert.equal(f.killCalls, 1); assert.equal(attempts, 2);
  assert.equal(f.manager.getProcess('cancel'), undefined);
});

test('persistent marker failure has bounded cleanup retries and never retargets a stopped process', async () => {
  let attempts = 0;
  const f = cancellationFixture({ terminate: async () => true, workspace: {
    releaseAfterTermination: () => { attempts++; throw new Error('EPERM'); },
    canReleaseResources: () => false,
  } });
  assert.equal(await f.manager.killProcess('cancel'), true);
  f.child.emit('close', 1, null);
  while (f.retryCleanup()) {}
  assert.equal(f.killCalls, 1);
  assert.equal(attempts, 5); // Initial attempt, close event, and three retries.
  assert.equal(f.manager.getProcess('cancel'), f.child);
  assert.equal(await f.manager.killProcess('cancel'), true);
  assert.equal(f.killCalls, 1);
});

for (const closeFirst of [false, true]) test(`failed cancellation accepts a supervised normal finish ${closeFirst ? 'before' : 'after'} its result`, async () => {
  let finish, markerPresent = true;
  const f = cancellationFixture({
    terminate: () => new Promise(resolve => { finish = resolve; }),
    workspace: {
      releaseAfterTermination: () => true,
      canReleaseResources: () => !markerPresent,
    },
  });
  const stopping = f.manager.killProcess('cancel');
  if (!closeFirst) {
    finish(false);
    assert.equal(await stopping, false);
    assert.equal(f.manager.getProcess('cancel'), f.child);
  }
  markerPresent = false;
  f.child.emit('close', 0, null);
  if (closeFirst) {
    assert.equal(f.manager.getProcess('cancel'), f.child);
    finish(false);
    assert.equal(await stopping, true);
  }
  assert.equal(f.killCalls, 1);
  assert.equal(f.manager.getProcess('cancel'), undefined);
});

test('upload needs no workspace and cancellation waits for tree termination after parent close', async () => {
  let finish;
  const f = cancellationFixture({ viaIpc: true,
    terminate: () => new Promise(resolve => { finish = resolve; }) });
  f.api.registerCmdHandlers(undefined, { buildDeliveryAuthority: {
    invalidate: () => assert.fail('Uploading must not invalidate compiled delivery'),
  } });
  const owner = { id: 7, isDestroyed: () => false, send() {} };
  const result = await f.handlers.get('cmd-run')({ sender: owner }, {
    command: process.execPath, streamId: 'upload', shellProfile: false,
  });
  assert.equal(result.success, true);
  const stopping = f.api.killCmdProcess('upload');
  f.child.emit('close', 1, null);
  assert.equal(f.api.getCmdProcess('upload'), f.child);
  finish(true);
  assert.equal(await stopping, true);
  assert.equal(f.api.getCmdProcess('upload'), undefined);
});

for (const cancellation of ['command', 'project', 'shutdown']) test(`${cancellation} cancellation prevents a pending delivery command from launching`, async () => {
  const f = cancellationFixture({ viaIpc: true });
  let resume, abandoned = false;
  f.api.registerCmdHandlers(undefined, { buildDeliveryAuthority: {
    invalidate() {}, begin: () => new Promise(resolve => { resume = () => resolve({ abandon() { abandoned = true; } }); }),
  } });
  const owner = { mainFrame: {}, isDestroyed: () => false, send() {} }, projectPath = path.resolve('pending-build-fixture');
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const options = { command: process.execPath, streamId: 'pending-build', shellProfile: false,
    buildWorkspace: projectPath, buildDeliveryRequest: 'request.json' };
  const running = f.handlers.get('cmd-run')(event, options);
  if (cancellation === 'command') assert.equal((await f.handlers.get('cmd-kill')(event, { streamId: options.streamId })).success, true);
  if (cancellation === 'project') assert.equal(await f.api.killOwnerProjectCmdProcesses(owner, projectPath), true);
  if (cancellation === 'shutdown') { f.api.beginCommandShutdown(); assert.equal(await f.api.killAllCmdProcesses(), true); }
  resume();
  const result = await running;
  assert.equal(result.success, false); assert.match(result.error, /CANCELLED_BEFORE_LAUNCH/);
  assert.equal(f.spawnCalls, 0); assert.equal(f.killCalls, 0); assert.equal(abandoned, true);
  if (cancellation !== 'shutdown') {
    assert.equal((await f.handlers.get('cmd-run')(event, { command: process.execPath, streamId: options.streamId })).success, true);
    f.child.emit('close', 0, null);
  }
});

test('duplicate pending command streams are rejected without replacing the original cancellation target', async () => {
  const f = cancellationFixture({ viaIpc: true });
  let resume;
  f.api.registerCmdHandlers(undefined, { buildDeliveryAuthority: {
    begin: () => new Promise(resolve => { resume = () => resolve({ abandon() {} }); }),
  } });
  const owner = { mainFrame: {}, isDestroyed: () => false }, event = { sender: owner, senderFrame: owner.mainFrame };
  const options = { command: process.execPath, streamId: 'duplicate', buildDeliveryRequest: 'request.json' };
  const running = f.handlers.get('cmd-run')(event, options);
  const duplicate = await f.handlers.get('cmd-run')(event, options);
  assert.equal(duplicate.success, false); assert.match(duplicate.error, /already registered/);
  assert.equal(await f.api.killCmdProcess(options.streamId), true);
  resume(); assert.match((await running).error, /CANCELLED_BEFORE_LAUNCH/);
  assert.equal(f.spawnCalls, 0);
});

test('cancelled project scopes fence pending and late commands while allowing a reopened session', async () => {
  const { cancelProjectTaskScope } = require('./project-task-scope');
  const f = cancellationFixture({ viaIpc: true });
  let resume;
  f.api.registerCmdHandlers(undefined, { buildDeliveryAuthority: {
    begin: () => new Promise(resolve => { resume = () => resolve({ abandon() {} }); }),
  } });
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const scope = { projectPath: path.resolve('owned-project'), projectSessionId: 'first' };
  const options = { command: process.execPath, streamId: 'pending-owned', cwd: os.tmpdir(),
    shellProfile: false, buildDeliveryRequest: 'request.json', ...scope };
  const pending = f.handlers.get('cmd-run')(event, options);
  cancelProjectTaskScope(owner, scope);
  assert.equal(await f.api.killOwnerProjectCmdProcesses(owner, scope.projectPath, scope.projectSessionId), true);
  resume();
  assert.equal((await pending).success, false);
  const late = await f.handlers.get('cmd-run')(event, { ...options, buildDeliveryRequest: undefined });
  assert.equal(late.success, false); assert.match(late.error, /PROJECT_TASK_CANCELLED/);
  assert.equal(f.spawnCalls, 0);
  const reopened = await f.handlers.get('cmd-run')(event, { ...options, buildDeliveryRequest: undefined, projectSessionId: 'second' });
  assert.equal(reopened.success, true);
  f.child.emit('close', 0, null);
});

test('scoped command cancellation failure survives root close without killing its dead PID again', async () => {
  const f = cancellationFixture({ viaIpc: true, terminate: async () => false });
  f.api.registerCmdHandlers();
  const owner = { isDestroyed: () => false, send() {} };
  const scope = { projectPath: path.resolve('owned-project'), projectSessionId: 'first' };
  await f.handlers.get('cmd-run')({ sender: owner }, { command: process.execPath, streamId: 'uncertain', cwd: os.tmpdir(), ...scope });
  assert.equal(await f.api.killOwnerProjectCmdProcesses(owner, scope.projectPath, scope.projectSessionId), false);
  f.child.emit('close', 0, null);
  assert.equal(await f.api.killOwnerProjectCmdProcesses(owner, scope.projectPath, scope.projectSessionId), false);
  assert.equal(f.killCalls, 1);
  assert.equal(f.api.getActiveCmdProcesses().length, 1);
});

test('unrelated commands do not get a build lifecycle; invalid workspace is refused', () => {
  assert.equal(createBuildWorkspaceSupervisor(undefined), undefined);
  assert.throws(() => createBuildWorkspaceSupervisor('relative/path'), /absolute/);
});

test('registered cancellation stops the owner and descendant before releasing its build marker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-supervised-build-'));
  const manager = new CommandManager(), streamId = 'owned-build-cancel-test';
  t.after(async () => {
    if (manager.getProcess(streamId)) await manager.killProcess(streamId);
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-supervised-build-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `require(process.argv[1]).acquireBuildWorkspace(process.argv[2], 'compile');
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    console.log(JSON.stringify({owner:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`;
  const started = manager.executeCommand({ command: process.execPath,
    args: ['-e', script, path.resolve(__dirname, '../child/scripts/build-workspace-lease.js'), root],
    streamId, shellProfile: false, buildWorkspace: root });
  const closed = once(started.process, 'close');
  const [line] = await once(started.process.stdout, 'data');
  const pids = JSON.parse(String(line));
  assert.ok(fs.existsSync(path.join(root, '.build/aily-workspace.lock')));
  assert.equal(await manager.killProcess(streamId), true);
  await closed;
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(path.join(root, '.build/aily-workspace.lock')), false);
  acquireBuildWorkspace(root, 'compile').release();
});

test('a parent exiting with its build marker remains unresolved and cannot retarget its closed PID', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-supervised-build-'));
  const manager = new CommandManager(), streamId = 'abandoned-owner';
  const child = manager.executeCommand({ command: process.execPath, streamId, shellProfile: false, buildWorkspace: root,
    args: ['-e', 'require(process.argv[1]).acquireBuildWorkspace(process.argv[2], "compile");process.exit(1)',
      path.resolve(__dirname, '../child/scripts/build-workspace-lease.js'), root] }).process;
  await once(child, 'close');
  assert.equal(manager.getProcess(streamId), child);
  assert.throws(() => manager.executeCommand({ command: process.execPath, streamId }), /already registered/);
  assert.equal(await manager.killProcess(streamId), false);
  // Fixture never spawned descendants. Explicit verified test cleanup only.
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  manager.processes.delete(streamId);
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-supervised-build-'));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const code of [0, 7]) test(`registered installer is removed on a completed exit (${code})`, async () => {
  const manager = new CommandManager();
  const child = manager.executeCommand({ command: process.execPath, args: ['-e', `process.exit(${code})`],
    streamId: 'installer', shellProfile: false }).process;
  await once(child, 'close');
  assert.equal(manager.getProcess('installer'), undefined);
});

test('legacy borrowed AppData markers do not block a command without a token', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-legacy-appdata-'));
  const previousAppData = process.env.AILY_APPDATA_PATH;
  process.env.AILY_APPDATA_PATH = root;
  t.after(() => {
    if (previousAppData === undefined) delete process.env.AILY_APPDATA_PATH;
    else process.env.AILY_APPDATA_PATH = previousAppData;
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-legacy-appdata-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lockRoot = path.join(root, '.lock/appdata-resource-lock');
  fs.mkdirSync(path.join(lockRoot, 'readers'), { recursive: true });
  const marker = JSON.stringify({ pid: process.pid, commandBorrowed: true, startedAt: Date.now() });
  const markers = [path.join(lockRoot, 'writer.lock'), path.join(lockRoot, 'readers/legacy.lock')];
  for (const filename of markers) fs.writeFileSync(filename, marker);
  const manager = new CommandManager();
  const child = manager.executeCommand({ command: process.execPath, args: ['-e', 'process.exit(0)'],
    streamId: 'legacy-markers', shellProfile: false }).process;
  const [code] = await once(child, 'close');
  assert.equal(code, 0); assert.equal(manager.getProcess('legacy-markers'), undefined);
  for (const filename of markers) assert.equal(fs.readFileSync(filename, 'utf8'), marker);
});

test('failed installer termination never retargets a subsequently closed PID', async () => {
  const manager = new CommandManager();
  const child = manager.executeCommand({ command: process.execPath,
    args: ['-e', 'console.log("ready");setTimeout(()=>process.exit(0),200)'],
    streamId: 'uncertain-installer', shellProfile: false }).process;
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  // Deterministic failed-stop injection: never target a foreign PID. The real
  // fixture exits on its own; the manager must not retarget its closed PID.
  const entry = manager.processes.get('uncertain-installer'); entry.process = { pid: 0 };
  assert.equal(await manager.killProcess('uncertain-installer'), false);
  entry.process = child;
  await closed;
  assert.equal(await manager.killProcess('uncertain-installer'), true);
  assert.equal(manager.getProcess('uncertain-installer'), undefined);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('project stop targets its owner and exact project, including commands without a build workspace', async () => {
  const manager = new CommandManager(), owner = {}, other = {};
  const root = path.resolve(os.tmpdir(), 'aily-stop-project');
  manager.processes.set('project', { ownerWebContents: owner, cwd: root });
  manager.processes.set('nested', { ownerWebContents: owner, cwd: path.join(root, '.temp') });
  manager.processes.set('supervised', { ownerWebContents: owner, cwd: os.tmpdir(), buildWorkspacePath: root });
  manager.processes.set('nested-build', { ownerWebContents: owner, cwd: path.join(root, 'firmware'), buildWorkspacePath: path.join(root, 'firmware') });
  manager.processes.set('other-workspace', { ownerWebContents: owner, cwd: root, buildWorkspacePath: `${root}-other` });
  manager.processes.set('other-tab', { ownerWebContents: other, cwd: root });
  manager.processes.set('prefix-only', { ownerWebContents: owner, cwd: `${root}-other` });
  manager.processes.set('upload', { ownerWebContents: owner, cwd: root });
  manager.processes.set('scoped-shared-cwd', { ownerWebContents: owner, cwd: os.tmpdir(), projectPath: root, projectSessionId: 'first' });
  manager.processes.set('other-session', { ownerWebContents: owner, cwd: root, projectPath: root, projectSessionId: 'other' });
  const stopped = [];
  manager.killProcess = async id => { stopped.push(id); return id !== 'supervised'; };
  assert.equal(await manager.killOwnerProjectProcesses(owner, root, 'first'), false);
  assert.deepEqual(stopped, ['project', 'supervised', 'upload', 'scoped-shared-cwd']);
  assert.equal(await manager.killAllProcesses(), false);
  manager.processes.clear();
  assert.equal(await manager.killAllProcesses(), true);
});

test('command shutdown refuses native launches', () => {
  const isolated = cancellationFixture({ viaIpc: true });
  isolated.api.beginCommandShutdown();
  assert.throws(() => isolated.manager.executeCommand({}), /SHUTDOWN/);
});
