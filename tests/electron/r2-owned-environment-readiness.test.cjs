const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { transformSync } = require('esbuild');
const { createHash } = require('node:crypto');

function methods(file, className, names) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
  assert.ok(declaration);
  return names.map(name => { const member = declaration.members.find(node => node.name?.getText(source) === name);
    assert.ok(member, name); return member.getText(source); }).join('\n');
}
function evaluate(source, globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module, exports: module.exports, console, ...globals });
  return module.exports;
}
const gateModule = evaluate(fs.readFileSync('src/app/editors/blockly-editor/services/blockly-workspace-edit-lease.ts', 'utf8'));
const Blockly = evaluate(`class Blockly { ${methods('src/app/editors/blockly-editor/services/blockly.service.ts', 'BlocklyService', ['isLibraryRuntimeReady'])} }; module.exports = Blockly;`);
const domainMethods = methods('src/app/services/domains/project/project.service.ts', 'ProjectService',
  ['captureBlocklyRuntimeRecoveryAcknowledgement', 'readBlocklyEnvironmentRuntime']);
const editorMethods = methods('src/app/editors/blockly-editor/services/project.service.ts', '_ProjectService', ['rebuildOwnedEnvironment']);

function fixture() {
  const gate = new gateModule.BlocklyWorkspaceEditGate(), lease = gate.acquire();
  let generatorReady = true, projectCurrent = true, environment = 'R2Mode:two', rebuild, acknowledgeCalls = 0;
  const blockly = Object.assign(new Blockly(), { workspaceEditGate: gate, generatorRuntime: { isReady: () => generatorReady } });
  const actualEnvironment = { status: 'completed', current: true }, native = { packageJson: {}, boardConfig: {},
    libraryDependencies: { observeEnvironment: async () => ({ environment: actualEnvironment }) } };
  const Domain = evaluate(`class Domain { ${domainMethods} }; module.exports = Domain;`, {
    window: native, sha256Hex: async text => createHash('sha256').update(text).digest('hex') });
  const domain = Object.assign(new Domain(), { currentProjectPath: 'D:/owned-environment', currentPackageData: {},
    captureCurrentProjectGuard: () => () => projectCurrent,
    isSameProjectPath: (a, b) => a === b, getPackageJson: async () => ({ projectConfig: { R2Mode: 'two' } }),
    loadBoardMenuConfig: async () => {}, getBoardJson: async () => ({ name: 'UNO' }), resolveBoardConfigForRuntime: async board => board,
    getEffectivePackageText: () => environment, getBlocklyLibraryRuntimeSignature: (_project, text) => text,
    blocklyLibraryRuntimeSignatures: new Map(), application: { isBlocklyLibraryRuntimeReady: () => blockly.isLibraryRuntimeReady() } });
  const Editor = evaluate(`class Editor { ${editorMethods} }; module.exports = Editor;`, { window: native, isAilyLibraryPackageName: () => true });
  const fullDocument = { pages: [{ id: 'main', content: { blocks: [{ id: 'C', fields: { VALUE: 201 } }] } }], activePageId: 'main' };
  const editor = Object.assign(new Editor(), { currentProjectPath: domain.currentProjectPath, blocklyService: blockly,
    environmentRuntimeReader: async path => {
      const reader = await domain.readBlocklyEnvironmentRuntime(path), original = reader.acknowledge;
      return { ...reader, libraryNames: [], acknowledge: () => { acknowledgeCalls++; return original(); } };
    } });
  blockly.setToolboxSortOrder = () => {};
  blockly.rebuildLibraryRuntimeInPlace = async (_options, owner, guard, retained) => {
    owner.assertCurrent(); gate.assertAvailable(owner); guard(); assert.deepEqual(retained, fullDocument);
    if (rebuild) await rebuild(); generatorReady = true; owner.assertCurrent(); guard();
  };
  return { gate, lease, blockly, domain, editor, fullDocument, actualEnvironment,
    ready: value => { generatorReady = value; }, changeEnvironment: () => { environment = 'R2Mode:external'; },
    changeProject: () => { projectCurrent = false; }, onRebuild: callback => { rebuild = callback; },
    acknowledgements: () => acknowledgeCalls };
}

test('the original publisher can acknowledge a rebuilt runtime under its actual current lease while public readiness remains blocked', async () => {
  const f = fixture();
  assert.equal(f.blockly.isLibraryRuntimeReady(), false);
  const genericRecoveryAck = await f.domain.captureBlocklyRuntimeRecoveryAcknowledgement(f.domain.currentProjectPath);
  assert.equal(genericRecoveryAck(), false, 'Unowned recovery acknowledgement remains blocked during a publication');
  await f.editor.rebuildOwnedEnvironment(f.fullDocument, f.lease, () => f.lease.assertCurrent(), 'original-environment');
  assert.equal(f.acknowledgements(), 1);
  assert.equal(f.domain.blocklyLibraryRuntimeSignatures.get(f.domain.currentProjectPath), 'R2Mode:two');
  assert.equal(f.blockly.isLibraryRuntimeReady(), false, 'Read-only callers must not enter while the publisher owns its lease');
  f.lease.release(); assert.equal(f.blockly.isLibraryRuntimeReady(), true);
});

test('owner-aware readiness rejects foreign objects, released owners, an unready generator and any quarantined workspace', () => {
  const f = fixture();
  assert.equal(f.blockly.isLibraryRuntimeReady(f.lease), true);
  assert.equal(f.blockly.isLibraryRuntimeReady({ assertCurrent: () => f.lease.assertCurrent() }), false, 'Delegating the same lease assertion is not its object identity');
  f.ready(false); assert.equal(f.blockly.isLibraryRuntimeReady(f.lease), false); f.ready(true);
  const grant = f.lease.quarantine('unfinished original mutation');
  assert.equal(f.blockly.isLibraryRuntimeReady(f.lease), false);
  f.lease.release(); assert.equal(f.blockly.isLibraryRuntimeReady(f.lease), false);
  const recovering = f.gate.acquireRecovery(grant);
  assert.equal(f.blockly.isLibraryRuntimeReady(recovering), false, 'A recovery grant is not a completed runtime');
  recovering.completeRecovery(); assert.equal(f.blockly.isLibraryRuntimeReady(recovering), true);
  recovering.release(); assert.equal(f.blockly.isLibraryRuntimeReady(recovering), false);
});

test('a genuine environment input change during reconstruction still rejects the original acknowledgement', async () => {
  const f = fixture(); f.onRebuild(() => f.changeEnvironment());
  await assert.rejects(f.editor.rebuildOwnedEnvironment(f.fullDocument, f.lease, () => f.lease.assertCurrent(), 'original-environment'), /Installed environment changed/);
  assert.equal(f.acknowledgements(), 0); assert.equal(f.domain.blocklyLibraryRuntimeSignatures.size, 0);
});

test('an expired publisher cannot acknowledge or update the new owner environment', async () => {
  const f = fixture(); f.onRebuild(() => { f.lease.release(); f.gate.acquire(); });
  await assert.rejects(f.editor.rebuildOwnedEnvironment(f.fullDocument, f.lease, () => f.lease.assertCurrent(), 'original-environment'), /no longer active/);
  assert.equal(f.acknowledgements(), 0); assert.equal(f.domain.blocklyLibraryRuntimeSignatures.size, 0);
});

test('an unverified original environment remains incomplete despite a successfully reconstructed runtime', async () => {
  const f = fixture(); f.actualEnvironment.current = false;
  await assert.rejects(f.editor.rebuildOwnedEnvironment(f.fullDocument, f.lease, () => f.lease.assertCurrent(), 'original-environment'),
    { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  assert.equal(f.acknowledgements(), 0); assert.equal(f.domain.blocklyLibraryRuntimeSignatures.size, 0);
});

test('environment acknowledgement stays single-use and rejects navigation before it is consumed', async () => {
  const f = fixture(), reader = await f.domain.readBlocklyEnvironmentRuntime(f.domain.currentProjectPath);
  f.lease.release(); assert.equal(reader.acknowledge(), true); assert.equal(reader.acknowledge(), false);
  const newer = await f.domain.readBlocklyEnvironmentRuntime(f.domain.currentProjectPath); f.changeProject();
  assert.throws(() => newer.acknowledge(), /Installed environment changed/);
});
