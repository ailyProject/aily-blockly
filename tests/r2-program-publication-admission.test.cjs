'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
// Execute the real service methods without booting Angular or replacing their
// admission logic. Unused application dependencies remain controlled ports.
function load(relative, imports = {}) {
  const file = path.join(root, relative), module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  });
  assert.equal(compiled.diagnostics.length, 0);
  const decorator = () => () => {};
  new Function('require', 'exports', 'module', compiled.outputText)(name => imports[name]
    ?? (name === '@angular/core' ? { Injectable: decorator, Optional: decorator, Inject: decorator } : {}), module.exports, module);
  return module.exports;
}
const publication = load('src/app/services/shared/project-program-publication.ts');
const receipts = load('src/app/services/domains/project/project-save-receipts.ts');
const shared = { '@shared/public-api': publication };
const { _ProjectService: EditorProjectService } = load('src/app/editors/blockly-editor/services/project.service.ts', shared);
const { ProjectService } = load('src/app/services/domains/project/project.service.ts', shared);
const { BlocklyLiveOperationBridgeService: Bridge } = load('src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts', {
  ...shared, '@domain/project/public-api': receipts,
});
const project = '/isolated-r2-program';
const completeHost = () => ({ projectProgramPublicationVersion: 1, nativeSaveReceiptVersion: 2,
  projectSyncStorageVersion: 2, openProjectSyncStorage() { throw new Error('Admission must not open storage'); } });
const request = operation => ({ version: 2, requestId: 'pub2-12345678-1234-4234-8234-123456789abc', operation, waitMs: 0 });
function host(t, capabilities) {
  const previous = global.window;
  global.window = { fs: capabilities, path: { isAbsolute: value => value.startsWith('/') } };
  t.after(() => { global.window = previous; });
}
function editor(handler) {
  let legacyDispatches = 0;
  const service = Object.assign(Object.create(EditorProjectService.prototype), {
    absSaveHandler: handler, captureSaveContext: () => ({ assertCurrent() {} }),
    blocklyService: { runProjectOperation() { legacyDispatches++; return Promise.resolve({ projectSaved: true, partial: false }); } },
  });
  return { service, legacyDispatches: () => legacyDispatches };
}
function bridge(mode = 'blockly') {
  const admitted = [];
  const service = Object.assign(Object.create(Bridge.prototype), {
    projectService: { currentProjectPath: project, getProjectMode: () => mode }, normalizePath: value => value,
    executeAdmittedOperation: async payload => { admitted.push(payload); return { ok: true, controlledDispatch: true }; },
  });
  return { service, admitted };
}

test('missing Blockly publisher cannot fall back to an ABI-only save, even with the complete host cohort', async t => {
  host(t, completeHost()); const f = editor();
  await assert.rejects(Promise.resolve().then(() => f.service.saveProjectAfterPreprocess(project)),
    { code: 'PROJECT_SAVE_DURABILITY_UNAVAILABLE' });
  assert.equal(f.legacyDispatches(), 0);
});

test('editor requires the matching complete cohort before invoking an installed save handler', async t => {
  host(t, { nativeSaveReceiptVersion: 2 }); let dispatches = 0;
  const f = editor(async () => { dispatches++; return { projectSaved: true }; });
  await assert.rejects(Promise.resolve().then(() => f.service.saveProjectAfterPreprocess(project, request('project_save'))),
    { code: 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED' });
  assert.equal(dispatches, 0); assert.equal(f.legacyDispatches(), 0);
});

test('complete editor forwards the exact request and the publisher partial result once', async t => {
  host(t, completeHost()); const input = request('project_save'), partial = { projectSaved: true, partial: true, generatedCodePublished: false };
  const calls = []; const f = editor(async (...args) => { calls.push(args); return partial; });
  assert.equal(await f.service.saveProjectAfterPreprocess(project, input), partial);
  assert.deepEqual(calls, [[project, input]]); assert.equal(f.legacyDispatches(), 0);
});

for (const [operation, params] of [
  ['project_save', { saveRequest: request('project_save') }], ['blocks_tidy', { saveRequest: request('blocks_tidy') }],
  ['abs_apply', {}], ['abs_projection', {}], ['blocks_set_state', { action: 'update' }],
  ['abs_recovery', { action: 'history_publish' }], ['abs_recovery', { action: 'recover_project' }],
  ['abs_recovery', { action: 'repair', authority: 'workspace' }], ['board_switch', {}], ['set_board_config', {}],
  ['abs_recovery', { action: 'recover', observe: true }],
]) test(`mixed host cannot dispatch Blockly ${operation}/${params.action ?? 'start'}`, async t => {
  host(t, { nativeSaveReceiptVersion: 2, projectSyncStorageVersion: 2, openProjectSyncStorage() {} }); const f = bridge();
  const result = await f.service.execute({ operation, path: project, params });
  assert.equal(result.ok, false); assert.equal(result.code, 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED');
  assert.equal(result.commandDispatched, false); assert.equal(f.admitted.length, 0);
});

test('read-only inspection, preview, existing observations and environment operations retain admission on an older host', async t => {
  host(t, {}); const f = bridge();
  for (const [operation, params] of [['app_info', {}], ['abs_projection', { publish: false }],
    ['blocks_set_state', { action: 'inspect' }], ['abs_recovery', { action: 'inspect' }],
    ['abs_recovery', { action: 'observe_apply' }], ['abs_recovery', { action: 'history_observe' }],
    ['abs_recovery', { action: 'read_candidate' }], ['abs_recovery', { action: 'prepare_native' }],
    ['abs_recovery', { action: 'resolve', observe: true }], ['library_runtime_sync', {}]]) {
    const result = await f.service.execute({ operation, path: project, params });
    assert.equal(result.controlledDispatch, true, `${operation}/${params.action ?? 'read'} retains its original execution path`);
  }
  assert.equal(f.admitted.length, 10);
});

test('Coder save does not inherit the Blockly durable request or program capability gate', async t => {
  host(t, { nativeSaveReceiptVersion: 2 }); const f = bridge('coder');
  assert.equal((await f.service.execute({ operation: 'project_save', path: project, params: {} })).controlledDispatch, true);
  assert.equal(f.admitted.length, 1);
});

test('matching host admits canonical operations once while keeping the exact durable request', async t => {
  host(t, completeHost()); const f = bridge(), input = request('blocks_tidy');
  const starts = [];
  f.service.projectService.startProjectSaveReceipt = async (...args) => {
    starts.push(args.slice(0, 2)); return args[2]();
  };
  assert.equal((await f.service.execute({ operation: 'blocks_tidy', path: project, params: { project, saveRequest: input } })).controlledDispatch, true);
  assert.equal(f.admitted.length, 1); assert.deepEqual(starts, [[project, input]]);
  for (const [operation, params] of [['abs_apply', {}], ['abs_projection', {}], ['blocks_set_state', { action: 'update' }],
    ['abs_recovery', { action: 'history_publish' }]]) {
    assert.equal((await f.service.execute({ operation, path: project, params })).controlledDispatch, true);
  }
  assert.equal(f.admitted.length, 5);
});

test('manual Blockly save rejects a mixed host before receipt allocation; Coder still uses its own completion', async t => {
  host(t, { nativeSaveReceiptVersion: 2 }); let receiptCalls = 0, actualCalls = 0, mode = 'blockly';
  const domain = Object.assign(Object.create(ProjectService.prototype), {
    getProjectMode: () => mode, saveContext: () => [],
    guardSaveContext: (_path, _context, run) => run,
    saveProjectActual: async () => { actualCalls++; return { success: true }; },
  });
  Object.defineProperty(domain, 'projectSaveReceipts', { value: { execute: async (_path, _request, _context, run) => {
    receiptCalls++; return { result: await run() };
  } } });
  const blocked = await domain.save(project);
  assert.equal(blocked.success, false); assert.equal(blocked.code, 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED');
  assert.equal(receiptCalls, 0); assert.equal(actualCalls, 0);
  mode = 'coder'; assert.equal((await domain.save(project)).success, true);
  assert.equal(receiptCalls, 1); assert.equal(actualCalls, 1);
});

test('each individual cohort component is required without touching the storage port', t => {
  host(t, completeHost()); publication.requireProjectProgramPublication();
  for (const key of ['projectProgramPublicationVersion', 'nativeSaveReceiptVersion', 'projectSyncStorageVersion', 'openProjectSyncStorage']) {
    const incomplete = completeHost(); delete incomplete[key];
    assert.throws(() => publication.requireProjectProgramPublication(incomplete), { code: 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED' });
  }
});
