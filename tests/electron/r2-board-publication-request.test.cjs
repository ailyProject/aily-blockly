const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { buildSync, transformSync } = require('esbuild');
const crypto = require('node:crypto');

function bundle(file) {
  const module = { exports: {} };
  vm.runInNewContext(buildSync({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text,
    { module, exports: module.exports, crypto, Error, setTimeout, clearTimeout, console });
  return module.exports;
}
const { boardPublicationRequest } = bundle('src/app/services/domains/project/project-board-publication-request.ts');
const { ProjectSaveReceipts, readProjectSaveRequest } = bundle('src/app/services/domains/project/project-save-receipts.ts');
const input = { kind: 'board-config', configKey: 'Mode', configValue: '' };
const request = { version: 2, requestId: 'pub2-00000000-0000-4000-8000-000000000001', operation: 'project_save', input };

function methods(file, className, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
  return names.map(name => { const member = declaration.members.find(node => node.name?.getText(source) === name); assert.ok(member, name); return member.getText(source); }).join('\n');
}
function subject(source, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(`class Subject { ${source} }; module.exports = Subject;`, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module, exports: module.exports, boardPublicationRequest, Error, crypto, console, ...globals });
  return new module.exports();
}

test('only the same original typed board intent can use a supplied native publication ID', () => {
  const actual = boardPublicationRequest(input, request);
  assert.equal(actual.requestId, request.requestId); assert.equal(JSON.stringify(actual.input), JSON.stringify(input));
  const fresh = boardPublicationRequest({ kind: 'board-switch', boardName: '@aily-project/board-next' });
  assert.match(fresh.requestId, /^pub2-/); assert.notEqual(fresh.requestId, request.requestId);
  for (const invalid of [null, {}, { ...request, version: 1 }, { ...request, operation: 'blocks_tidy' },
    { ...request, input: { ...input, configValue: 'different' } }, { ...request, input: { ...input, extra: true } },
    { ...request, input: { kind: 'board-switch', boardName: '@aily-project/board-next' } }]) {
    assert.throws(() => boardPublicationRequest(input, invalid), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  }
});

test('Bridge binds board request input before dispatch and does not grant the same ID to another operation', () => {
  const bridge = subject(methods('src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts', 'BlocklyLiveOperationBridgeService', ['readBoardPublicationRequest']));
  bridge.projectService = { currentProjectPath: 'D:/board', getProjectMode: () => 'blockly' };
  assert.equal(bridge.readBoardPublicationRequest({ saveRequest: request }, input).requestId, request.requestId);
  for (const params of [{}, { saveRequest: undefined }])
    assert.throws(() => bridge.readBoardPublicationRequest(params, input), { code: 'PROJECT_SAVE_PROTOCOL_UPGRADE_REQUIRED' });
  assert.throws(() => bridge.readBoardPublicationRequest({ saveRequest: request }, { ...input, configValue: 'other' }), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  bridge.projectService.getProjectMode = () => 'coder';
  assert.equal(bridge.readBoardPublicationRequest({}, input), undefined, 'Coder keeps its existing source workflow');
});

test('generic CLI save cannot consume board input; the original publication status remains read-only and accepts it', async () => {
  const calls = [], bridge = subject(methods('src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts', 'BlocklyLiveOperationBridgeService', ['execute']), {
    window: { fs: { nativeSaveReceiptVersion: 2 }, path: { isAbsolute: () => true } },
    readProjectSaveRequest, publishesProjectProgram: () => true, requireProjectProgramPublication() {},
  });
  bridge.normalizePath = value => value;
  bridge.projectService = { currentProjectPath: 'D:/board', getProjectMode: () => 'blockly',
    startProjectSaveReceipt: () => { throw Error('The generic writer must not consume a board request'); },
    observeProjectPublication: async (...args) => { calls.push(args); return { ok: true, readonlyObservation: true }; } };
  const mutation = await bridge.execute({ operation: 'project_save', path: 'D:/board', params: { saveRequest: request } });
  assert.equal(mutation.ok, false); assert.equal(mutation.code, 'PROJECT_SAVE_RECEIPT_INVALID'); assert.equal(calls.length, 0);
  const observation = await bridge.execute({ operation: 'project_publication_status', path: 'D:/board',
    params: { saveRequest: request, originalTargetPid: 123 } });
  assert.equal(observation.readonlyObservation, true); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0][1].input), JSON.stringify(input)); assert.equal(calls[0][2], 123);
});

test('a hidden same-value board selection uses the original ordinary-save request once; UI no-op still does not save', async () => {
  const saves = []; let terminal;
  // Controlled native port for this caller test. The actual durable journal
  // and cold identity tests are separate; RAM alone must never grant v2 success.
  const receipts = new ProjectSaveReceipts({ durableOnly: () => true, durableLookup: async (project, original) => terminal ? {
    ok: true, operation: 'project_save_status', saveReceipt: { ...original, project, state: 'completed' }, result: terminal,
  } : null });
  const domain = subject(methods('src/app/services/domains/project/project.service.ts', 'ProjectService',
    ['save', 'guardSaveContext', 'applyBoardConfiguration']), { window: { fs: { nativeSaveReceiptVersion: 2 } }, requireProjectProgramPublication() {} });
  Object.assign(domain, { currentProjectPath: 'D:/board', getProjectMode: () => 'blockly', isCoderProjectContext: false,
    captureCurrentProjectGuard: () => () => true, saveContext: () => [], projectSaveReceipts: receipts,
    getPackageJson: async () => ({ projectConfig: { Mode: '' } }), publishManifestEnvironment: () => { throw Error('No environment change is required'); },
    saveProjectActual: async (_path, original) => { saves.push(original); terminal = { ok: true, projectSaved: true, partial: false,
      publication: { status: 'COMMITTED' }, generation: 'same-head', projectionReceipt: { version: 2, requestId: original.requestId } }; return terminal; } });
  assert.equal((await domain.applyBoardConfiguration({ key: 'Mode', data: '' })).changed, false); assert.equal(saves.length, 0);
  const result = await domain.applyBoardConfiguration({ key: 'Mode', data: '' }, request);
  assert.equal(result.changed, false); assert.equal(result.success, true); assert.equal(saves.length, 1);
  assert.equal(saves[0].requestId, request.requestId); assert.equal(JSON.stringify(saves[0].input), JSON.stringify(input));
  const repeated = await domain.applyBoardConfiguration({ key: 'Mode', data: '' }, request);
  assert.equal(repeated.success, true); assert.equal(saves.length, 1, 'The actual existing receipt manager retains the original result');
  await assert.rejects(domain.applyBoardConfiguration({ key: 'Mode', data: 'other' }, request), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  assert.equal(saves.length, 1); assert.equal(Object.hasOwn(result, 'environment'), false, 'A source save does not fabricate an environment completion');
});

test('adapter and editor forward the exact original request into the single native publisher', async () => {
  const adapter = subject(methods('src/app/integrations/project/project-application.adapter.ts', 'ProjectApplicationAdapter', ['publishBlocklyEnvironmentMutation']));
  const calls = [];
  adapter.blocklyEditorProjectService = { publishEnvironmentMutation: (...args) => { calls.push(args); return Promise.resolve({ projectSaved: true }); } };
  const mutation = async () => ({}); await adapter.publishBlocklyEnvironmentMutation('D:/board', mutation, request);
  assert.equal(calls[0][2], request); assert.equal(calls[0][1], mutation);
  const editor = subject(methods('src/app/editors/blockly-editor/services/project.service.ts', '_ProjectService', ['publishEnvironmentMutation']),
    { settleLinkedProjectEnvironment: async () => {} });
  let captured;
  editor.publishRuntimeMutation = (_path, _mutate, original) => { captured = original; return Promise.resolve({ projectSaved: true }); };
  await editor.publishEnvironmentMutation('D:/board', mutation, request); assert.equal(captured, request);
});
