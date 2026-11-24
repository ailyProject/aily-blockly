const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createHash, webcrypto } = require('node:crypto');
const ts = require('typescript');
const { openProjectSyncStorage, openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');
const { rootAttachment } = require('../../electron/project-file-lock-owner');

const root = path.resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(nativeProject) {
  const files = new Map(), modules = new Map();
  const project = nativeProject || '/project';
  let projectSessionId = 'project-session-1';
  let load = { project, ready: true, state: 'loaded' };
  let statusReads = 0, recoveries = 0, preparations = 0;
  const globals = { window: { crypto: webcrypto, platform: { isWindows: process.platform === 'win32' && !!nativeProject },
    path: nativeProject ? path : path.posix }, TextEncoder, TextDecoder,
    Buffer, structuredClone, console, setTimeout, clearTimeout,
    projectDataRuntime: { getSessionToken: () => projectSessionId } };
  const compile = (source, file, imports = {}) => {
    const module = { exports: {} };
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    vm.runInNewContext(output, { ...globals, ...imports, require: imports.require ?? require,
      module, exports: module.exports }, { filename: file });
    return module.exports;
  };
  function loadModule(relative) {
    const file = path.join(root, relative);
    if (modules.has(file)) return modules.get(file);
    const exports = compile(fs.readFileSync(file, 'utf8'), file, { require: name => {
      if (name === '@shared/public-api') return loadModule('src/app/services/shared/project-sync-storage-bridge.ts');
      if (name.startsWith('.')) return loadModule(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
      return require(name);
    } });
    modules.set(file, exports);
    return exports;
  }
  function selectClass(relative, className, methods, imports) {
    const file = path.join(root, relative), source = fs.readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), printer = ts.createPrinter();
    const declaration = tree.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
    const text = methods.map(name => {
      const method = declaration.members.find(node => ts.isMethodDeclaration(node) && node.name?.getText(tree) === name);
      assert.ok(method, 'Actual method exists: ' + name);
      return printer.printNode(ts.EmitHint.Unspecified, method, tree);
    }).join('\n');
    return compile(`export class ${className} {\n${text}\n}`, file, imports)[className];
  }
  const attachment = { version: 1, root: project, identity: { dev: '1', ino: '2', birthtimeNs: '3' } };
  globals.window.fs = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (target, guard) => {
    assert.equal(target, project);
    const read = async key => { guard(); return files.get(key) ?? null; };
    return { attachment, read, withLock: run => new Promise((resolve, reject) => run({ attachment, read,
      replace: async (key, expected, value) => {
        const before = await read(key);
        if ((before === null ? null : 'sha256:' + sha(before)) !== expected) return false;
        files.set(key, value); return true;
      }
    }, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), { code: result.error.code })))) };
  } };
  if (nativeProject) Object.assign(globals.window.fs, { openProjectSyncStorage: openProjectSyncStorageBridge,
    realpathAsync: fs.promises.realpath, captureProjectAttachment: project => rootAttachment(fs.realpathSync.native(project)) });
  const Service = selectClass('src/app/services/domains/project/project.service.ts', 'ProjectService',
    ['recoverFailedBlocklyProject', 'recoverSavedBlocklyView', 'cancelFailedBlocklyProject'], {
      ...loadModule('src/app/services/domains/project/project-recovery-request.ts'),
      ...loadModule('src/app/services/domains/project/project-recovery-backup.ts'),
      withCurrentProjectRecoveryStatus: loadModule('src/app/services/domains/project/project-recovery-status.ts').withCurrentProjectRecoveryStatus,
    });
  const service = new Service();
  const reload = async () => { recoveries++; return { ok: true, project, ready: true, loadStatus: structuredClone(load) }; };
  Object.assign(service, { currentProjectPath: project, projectViewRevision: 1, coderProjects: [],
    getProjectMode: () => 'blockly', getBlocklyProjectLoadStatus: () => { statusReads++; return structuredClone(load); },
    isSameProjectPath: (a, b) => a === b,
    electronService: { currentRendererGeneration: 1 }, isProjectOpening: false, isProjectTransitionInProgress: () => false,
    assertSavedRecoveryContext() {}, savedRecoveryTargets: { inspect: async () => ({ project }) }, reloadSavedRecoveryTarget: reload,
  });
  const Bridge = selectClass('src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts',
    'BlocklyLiveOperationBridgeService', ['executeOperation', 'getProjectRuntimeStatus'], {
      sameAbsProjectDirectory: loadModule('src/app/integrations/blockly/abs/abs-project-path.ts').sameAbsProjectDirectory,
      openAbsHostStorage: async () => { preparations++; throw Object.assign(new Error('Controlled native preparation failure'), { code: 'PREPARATION_FAILED' }); },
    });
  const bridge = new Bridge();
  Object.assign(bridge, { projectService: service, boardSwitchInProgress: false, absApplyInProgress: false,
    aiOperations: { hasBlocking: () => false } });
  return { service, bridge, files, project, reload,
    replaceView() { projectSessionId = 'replacement-project-session'; service.projectViewRevision++; },
    failed() { load = { project, ready: false, state: 'error', error: 'Later library rebuild failed' };
      projectSessionId = 'project-session-2'; service.electronService.currentRendererGeneration = 2; },
    get statusReads() { return statusReads; }, get recoveries() { return recoveries; }, get preparations() { return preparations; },
  };
}

for (const durable of [false, true]) test(`completed ${durable ? 'durable' : 'cached'} recovery returns fresh failed readiness without altering its old result`, async () => {
  const f = fixture(), requestId = 'completed-original-recovery';
  const first = await f.service.recoverFailedBlocklyProject(requestId, false, f.reload);
  assert.equal(first.ok, true); assert.equal(first.currentProjectRuntime.projectSessionId, 'project-session-1');
  const durableBefore = [...f.files.entries()];
  for (const [, text] of durableBefore) assert.equal(text.includes('currentProjectRuntime'), false, 'Fresh status is never persisted as the old outcome');
  f.failed();
  if (durable) f.service.failedLoadRecoveries = undefined;
  const reads = f.statusReads;
  const observed = await f.bridge.executeOperation({ operation: 'abs_recovery', path: f.project,
    params: { action: 'recover_project', requestId, observe: true } });
  assert.equal(observed.ok, false); assert.equal(observed.ready, false);
  assert.equal(observed.code, 'PROJECT_RECOVERY_CURRENT_NOT_READY');
  assert.equal(observed.originalRecovery.ok, true); assert.equal(observed.originalRecovery.ready, true);
  assert.equal(observed.currentProjectRuntime.projectSessionId, 'project-session-2');
  assert.equal(observed.currentProjectRuntime.rendererGeneration, 2);
  assert.equal(observed.currentProjectRuntime.loadStatus.error, 'Later library rebuild failed');
  assert.equal(f.statusReads, reads + 1);
  assert.deepEqual(JSON.parse(JSON.stringify(observed.receipt)), JSON.parse(JSON.stringify(first.receipt)));
  assert.deepEqual([...f.files.entries()], durableBefore); assert.equal(f.recoveries, 1);
  assert.equal(observed.nextAction.input.action, 'recover_project'); assert.equal(observed.nextAction.input.requestId, undefined);
  const ordinary = await f.bridge.executeOperation({ operation: 'abs_validate', path: f.project, params: {} });
  assert.equal(ordinary.code, 'PROJECT_LOAD_FAILED');
  const repeated = await f.bridge.executeOperation({ operation: 'abs_recovery', path: f.project,
    params: { action: 'recover_project', requestId } });
  assert.equal(repeated.code, 'PROJECT_RECOVERY_CURRENT_NOT_READY');
  assert.equal(f.preparations, 0, 'A repeated old request must not prepare or mutate before checking its journal');
  assert.equal(f.recoveries, 1); assert.deepEqual([...f.files.entries()], durableBefore);
});

test('native preparation belongs to its original new request and cannot repeat on a failed retry', async () => {
  const f = fixture(); f.failed();
  const payload = { operation: 'abs_recovery', path: f.project, params: { action: 'recover_project', requestId: 'failed-preparation-request' } };
  const first = await f.bridge.executeOperation(payload), second = await f.bridge.executeOperation(payload);
  assert.equal(first.ok, false); assert.equal(first.code, 'PREPARATION_FAILED');
  assert.equal(second.code, 'PREPARATION_FAILED'); assert.equal(f.preparations, 1); assert.equal(f.recoveries, 0);
});

test('a project switch while an original recovery is pending cannot return current readiness for the old project', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const pending = f.service.recoverFailedBlocklyProject('late-original-recovery', false, async () => {
    entered.resolve(); await release.promise; return { ok: true, ready: true, loadStatus: { ready: true, state: 'loaded' } };
  });
  await entered.promise; f.service.currentProjectPath = '/different-project'; release.resolve();
  const result = await pending;
  assert.equal(result.currentProjectRuntime.ready, false); assert.equal(result.currentProjectRuntime.sameProject, false);
  assert.notEqual(result.ok, true); assert.equal(result.currentProjectRuntime.projectSessionId, null);
});

test('a same-path replacement retires the departed view but the original refusal stays queryable', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const requestId = 'view-replaced-original-recovery';
  let touched = false;
  const pending = f.service.recoverFailedBlocklyProject(requestId, false, async guard => {
    entered.resolve(); await release.promise;
    guard?.(); touched = true;
    return { ok: true, ready: true };
  });
  await entered.promise;
  f.replaceView();
  release.resolve();
  const result = await pending;
  assert.equal(touched, false);
  assert.equal(result.code, 'PROJECT_RECOVERY_CONTEXT_STALE');
  assert.equal(result.currentProjectRuntime.projectSessionId, 'replacement-project-session');
  f.service.failedLoadRecoveries = undefined;
  const observed = await f.service.recoverFailedBlocklyProject(requestId, true);
  assert.equal(observed.code, 'PROJECT_RECOVERY_CONTEXT_STALE');
  assert.equal(observed.receipt.requestId, requestId);
  assert.equal(observed.recoveryObservation?.resultKnown, true);
});

test('an explicit Stop can fence only its exact original recovery before dispatch reaches admission', async () => {
  const f = fixture(), requestId = 'stopped-before-recovery-dispatch';
  const stop = project => f.bridge.executeOperation({ operation: 'abs_recovery', path: project,
    params: { version: 2, action: 'cancel_project', requestId } });
  assert.equal((await stop('/different-project')).ok, false);
  assert.equal((await stop(f.project)).ok, true);
  assert.equal(f.files.size, 0, 'A pre-admission fence cannot claim a completed original request');
  const prevented = await f.service.recoverFailedBlocklyProject(requestId, false, f.reload);
  assert.equal(prevented.ok, false);
  assert.equal(prevented.code, 'PROJECT_RECOVERY_CANCELLED');
  assert.equal(f.recoveries, 0);
  assert.equal((await f.service.recoverFailedBlocklyProject('new-independent-recovery', false, f.reload)).ok, true);
  assert.equal(f.recoveries, 1);
});

test('an explicit Stop settles the original request after it has started without affecting a newer request', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const requestId = 'stopped-after-recovery-admission';
  const pending = f.service.recoverFailedBlocklyProject(requestId, false, async guard => {
    entered.resolve(); await release.promise; guard?.();
    return { ok: true, ready: true };
  });
  await entered.promise;
  const stop = await f.bridge.executeOperation({ operation: 'abs_recovery', path: f.project,
    params: { version: 2, action: 'cancel_project', requestId } });
  assert.equal(stop.ok, true);
  assert.equal(stop.recoveryCancellation?.requestId, requestId);
  const newer = await f.service.recoverFailedBlocklyProject('new-after-recovery-stop', false, f.reload);
  assert.equal(newer.ok, true);
  release.resolve();
  assert.equal((await pending).code, 'PROJECT_RECOVERY_CANCELLED');
  f.service.failedLoadRecoveries = undefined;
  const verified = await f.service.recoverFailedBlocklyProject(requestId, true);
  assert.equal(verified.code, 'PROJECT_RECOVERY_CANCELLED');
  assert.equal(verified.recoveryObservation?.resultKnown, true);
  assert.equal((await f.service.recoverFailedBlocklyProject('new-after-recovery-stop', true)).ok, true);
});

test('an explicit Stop revokes a detached owner waiting for the real project lock and leaves the lock holder intact', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-recovery-owner-'));
  t.after(() => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.match(path.basename(base), /^aily-recovery-owner-[A-Za-z0-9]+$/);
    fs.rmSync(base, { recursive: true, force: true });
  });
  const f = fixture(fs.realpathSync(base)), entered = Promise.withResolvers(), holding = Promise.withResolvers(), release = Promise.withResolvers();
  const requestId = 'recovery-waiting-for-native-lock';
  let wrote = false, newerLock;
  const pending = f.service.recoverFailedBlocklyProject(requestId, false, async guard => {
    const store = await openProjectSyncStorage(f.project, guard);
    const exactNewerLock = await openProjectSyncStorage(f.project, () => {});
    newerLock = exactNewerLock.withLock(async () => { holding.resolve(); await release.promise; });
    await holding.promise;
    entered.resolve();
    return store.withLock(async () => { wrote = true; return { ok: true, ready: true }; });
  });
  try {
    await entered.promise;
    const lock = path.join(f.project, '.aily', 'project-files.write.lock');
    const marker = fs.readFileSync(lock);
    f.service.currentProjectPath = path.join(f.project, 'newer-view');
    const stop = await f.bridge.executeOperation({ operation: 'abs_recovery', path: f.project,
      params: { version: 2, action: 'cancel_project', requestId } });
    assert.equal(stop.recoveryCancellation?.accepted, true);
    assert.deepEqual(fs.readFileSync(lock), marker);
    assert.equal(wrote, false);
  } finally {
    release.resolve();
    await newerLock;
  }
  const stopped = await pending;
  assert.equal(stopped.currentProjectRuntime.sameProject, false);
  assert.equal(stopped.code, 'PROJECT_RECOVERY_CANCELLED');
  const durable = await f.bridge.executeOperation({ operation: 'abs_recovery', path: f.project,
    params: { action: 'recover_project', requestId, observe: true } });
  assert.equal(durable.code, 'PROJECT_RECOVERY_CANCELLED');
  assert.equal(durable.recoveryObservation?.resultKnown, true);
  assert.equal(wrote, false);
});
