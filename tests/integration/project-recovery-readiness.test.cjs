const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createHash, webcrypto } = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const files = new Map(), modules = new Map();
  const project = '/project';
  let projectSessionId = 'project-session-1';
  let load = { project, ready: true, state: 'loaded' };
  let statusReads = 0, recoveries = 0, preparations = 0;
  const globals = { window: { crypto: webcrypto, platform: { isWindows: false } }, TextEncoder, TextDecoder,
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
  globals.window.fs = { projectSyncStorageVersion: 2, openProjectSyncStorage: async (target, guard) => {
    assert.equal(target, project);
    const read = async key => { guard(); return files.get(key) ?? null; };
    return { read, withLock: run => new Promise((resolve, reject) => run({ read,
      replace: async (key, expected, value) => {
        const before = await read(key);
        if ((before === null ? null : 'sha256:' + sha(before)) !== expected) return false;
        files.set(key, value); return true;
      }
    }, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), { code: result.error.code })))) };
  } };
  const Service = selectClass('src/app/services/domains/project/project.service.ts', 'ProjectService',
    ['recoverFailedBlocklyProject'], {
      ProjectRecoveryRequests: loadModule('src/app/services/domains/project/project-recovery-request.ts').ProjectRecoveryRequests,
      withCurrentProjectRecoveryStatus: loadModule('src/app/services/domains/project/project-recovery-status.ts').withCurrentProjectRecoveryStatus,
    });
  const service = new Service();
  const reload = async () => { recoveries++; return { ok: true, project, ready: true, loadStatus: structuredClone(load) }; };
  Object.assign(service, { currentProjectPath: project, coderProjects: [],
    getProjectMode: () => 'blockly', getBlocklyProjectLoadStatus: () => { statusReads++; return structuredClone(load); },
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
