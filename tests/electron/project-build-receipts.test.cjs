'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { routeLiveOperationProject } = require('../../electron/live-operation-project-routing');

// Exercise the production selector without launching the application or a build.
const main = fs.readFileSync(path.join(__dirname, '../../electron/main.js'), 'utf8');
const selection = main.match(/const liveOperationTimeoutMs = [\s\S]+?;/)?.[0];
assert.ok(selection, 'production live-operation timeout selector exists');
const timeout = (operation, params = {}) => vm.runInNewContext(`${selection}\nliveOperationTimeoutMs`, { operation, payload: { params } });

test('receipt start and status use bounded observation RPCs, not the legacy ten-minute receipt', () => {
  assert.equal(timeout('project_build', { buildRequest: { version: 1, requestId: 'build', waitMs: 10000 } }), 25000);
  assert.equal(timeout('project_build_status', { buildRequest: { version: 1, requestId: 'build', waitMs: 10000 } }), 25000);
});

test('legacy compile and hardware upload deadlines remain unchanged', () => {
  assert.equal(timeout('project_build'), 620000);
  assert.equal(timeout('project_upload'), 920000);
});

test('the receipt selector does not broaden unrelated project or ABS requests', () => {
  assert.equal(timeout('abs_apply', { chunk: true }), 600000);
  assert.equal(timeout('project_save'), 12000);
  assert.equal(timeout('project_create'), 300000);
});

test('new recovery operations have scoped budgets without extending inspection or ordinary save', () => {
  assert.equal(timeout('project_fork'), 300000);
  assert.equal(timeout('abs_recovery', { action: 'repair' }), 120000);
  assert.equal(timeout('abs_recovery', { action: 'observe_apply' }), 120000);
  assert.equal(timeout('abs_recovery', { action: 'inspect' }), 12000);
  assert.equal(timeout('project_save'), 12000);
});

const ts = require('typescript');
const source = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const handler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleCliBridgeCommand');
assert.ok(handler, 'production CLI handler exists');
const invoke = (result, operation, params = {}) => vm.runInNewContext(`(${handler.getText(source)})`, {
  path, routeLiveOperationProject, getOpenedProjectPathFromWindow: () => 'D:/isolated', requestMainWindow: async () => result,
})('blockly-live-operation', { path: 'D:/isolated', operation, params });

for (const errorCode of ['RENDERER_RESPONSE_TIMEOUT', 'RENDERER_REQUEST_CANCELLED', 'RENDERER_UNAVAILABLE', 'RENDERER_NOT_READY']) {
  test(`${errorCode} is unknown for receipt observation, never a compiler failure`, async () => {
    const original = { ok: false, errorCode, message: 'transport not confirmed' };
    for (const operation of ['project_build', 'project_build_status']) {
      const result = await invoke(original, operation, { buildRequest: { version: 1, requestId: 'build', waitMs: 10000 } });
      assert.equal(result.buildOutcome, 'unknown');
      assert.equal(result.errorCode, 'BUILD_OBSERVATION_UNCONFIRMED');
      assert.equal(result.buildRequestId, 'build');
    }
    assert.deepEqual(await invoke(original, 'project_build'), original);
  });
}

test('the native boundary preserves real compiler results and protocol rejections', async () => {
  const params = { buildRequest: { version: 1, requestId: 'build' } };
  const compiler = { ok: true, buildReceipt: { state: 'completed' }, result: { ok: false, buildOutcome: 'failed', message: 'compiler error' } };
  assert.deepEqual(await invoke(compiler, 'project_build', params), compiler);
  const rejected = { ok: false, code: 'BUILD_RECEIPT_CONFLICT', buildOutcome: 'not-started' };
  assert.deepEqual(await invoke(rejected, 'project_build', params), rejected);
});

test('explicit preprocessing stays pending until the original foreground task settles', async () => {
  const load = (filename, globals = {}) => {
    const file = fs.readFileSync(path.join(__dirname, '../..', filename), 'utf8');
    const compiled = ts.transpileModule(file, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, setTimeout, clearTimeout, require: () => ({ isBuildCancelled: () => false }), ...globals });
    return exports;
  };
  const { ProjectBuildReceipts, readNativeBuildReceipt } = load('src/app/services/integrations/automation/project-build-receipts.ts', {
    window: { builder: { inspectBuildExecution: (_project, buildRequestId) => ({ version: 1, buildRequestId,
      operation: 'preprocess', status: 'completed', buildHistory: { operation: 'preprocess' } }) } },
  });
  const { runProjectBuild } = load('src/app/integrations/blockly/project-build-operation.ts');
  const project = 'D:/isolated', requestId = 'explicit-request';
  const request = { version: 1, requestId };
  let finish;
  const builder = { build: (_target, options) => {
    assert.equal(options.requestId, requestId);
    assert.equal(options.preprocessOnly, true);
    assert.equal(options.expectedProjectPath, project);
    return new Promise(resolve => { finish = resolve; });
  } };
  const receipts = new ProjectBuildReceipts();
  const start = await receipts.start(project, request, 'preprocess', async () => {
    const result = await runProjectBuild(builder, { preprocessOnly: true, requestId }, project);
    return { ok: !result.is_error, ...result.metadata.buildResult };
  });
  assert.equal(start.buildReceipt.state, 'running');
  assert.equal((await receipts.status(project, request)).buildReceipt.state, 'running');
  finish({ buildHistory: { operation: 'preprocess' } });
  const settled = await receipts.status(project, { ...request, waitMs: 100 });
  assert.equal(settled.buildReceipt.state, 'completed');
  assert.equal(settled.result.buildHistory.operation, 'preprocess');
  const recovered = readNativeBuildReceipt(project, requestId);
  assert.equal(recovered.result.buildExecutionKind, 'preprocessing');
  assert.equal(recovered.result.buildInput, undefined);
});
