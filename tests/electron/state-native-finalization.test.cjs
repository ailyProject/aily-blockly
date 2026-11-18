'use strict';
// The actual state completion statements feed the unchanged production native
// validator, filesystem storage and journals. This contract covers finalization;
// it does not execute a renderer setter or generated-code publisher.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const ts = require('typescript');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');

const repo = path.resolve(__dirname, '../..');
const file = path.join(repo, 'src/app/integrations/blockly/abs/abs-workspace-sync.service.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const service = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AbsWorkspaceSyncService');
assert.ok(service);
const method = service.members.find(node => node.name?.getText(source) === 'setBlockState');
assert.ok(method);
let completion;
function findCompletion(node) {
  if (ts.isBlock(node)) {
    const start = node.statements.findIndex(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(value => value.name.getText(source) === 'committedOutput'));
    if (start >= 0) {
      assert.equal(completion, undefined, 'there must be exactly one committed state finalization block');
      const end = node.statements.findIndex((statement, index) => index > start && ts.isReturnStatement(statement));
      assert.ok(end > start);
      completion = node.statements.slice(start, end).map(statement => statement.getText(source)).join('\n');
    }
  }
  ts.forEachChild(node, findCompletion);
}
findCompletion(method);
assert.ok(completion, 'locate the actual production state finalization statements');
const finalize = new Function('return ' + ts.transpileModule(
  `async function({ outcome, stateReceipt, applicationJournal, checkpoint, assertCurrent }) { ${completion} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText)();

const bundled = buildSync({ absWorkingDir: repo, stdin: { resolveDir: repo, loader: 'ts', contents: `
  export * from './tests/electron/fixtures/r0-publication-kernel';
  export { blockStatePublicationIdentity } from './src/app/integrations/blockly/abs/abs-native-save-protocol';
  export { nativeSaveResult } from './src/app/integrations/blockly/abs/abs-native-save-result';
` }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
  '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
const compiled = new Module(path.join(__dirname, 'state-native-finalization-kernel.cjs'), module);
compiled.filename = path.join(__dirname, 'state-native-finalization-kernel.cjs');
compiled.paths = module.paths;
compiled._compile(bundled.outputFiles[0].text, compiled.filename);
const kernel = compiled.exports, guard = () => {};

async function fixture(t, { projectMode = true, derivedFailure = false } = {}) {
  const temporary = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporary, 'state-native-finalization-'));
  const project = path.join(directory, 'project');
  fs.mkdirSync(project);
  if (projectMode) {
    fs.mkdirSync(path.join(project, '.aily'));
    fs.writeFileSync(path.join(project, '.aily/workspace-mode.json'), JSON.stringify({ version: 1, mode: 'project-v1' }));
  }
  t.after(() => {
    assert.equal(path.dirname(directory), temporary);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const port = await openProjectSyncStorage(project, guard), scope = { projectKey: project, pageId: 'main' };
  const store = new kernel.AbsBaselineStore(port, scope), application = new kernel.AbsApplicationJournal(port, project);
  const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'main', content: { blocks: { languageVersion: 0,
      blocks: [{ type: 'root', id: 'root', collapsed: false, fields: { VALUE: 100 } }] } } }],
    sharedModel: { procedureBlocks: [], variables: [] } };
  const prepare = async generation => {
    const abi = JSON.stringify(document, null, 2);
    const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), {
      document, generation, baselineRef: kernel.absBaselineKey(generation), scope,
      savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
    return { mode: 'import', abi, projection, inputAbs: projection.abs, expected: await store.captureDisk() };
  };
  const commit = async input => {
    await store.stage(input);
    return store.commit(input.projection.map.generation, guard, async (text, expected, access) => {
      assert.equal(await access.replace('project.abi', expected, text), true);
    });
  };
  await commit(await prepare('state-base'));
  const draft = 'Independent retained author draft\n';
  if (projectMode) fs.writeFileSync(path.join(project, 'project.abs'), draft);
  const input = { version: 2, requestId: randomUUID(), action: 'update', expectedGeneration: 'state-base',
    changes: [{ blockId: 'root', collapsed: true }] };
  const identity = await kernel.blockStatePublicationIdentity(project, input);
  const expected = await store.captureDisk();
  const admitted = await new kernel.AbsOperationJournal(port, project).beginDocumentSave({
    request: identity, document, disk: expected }, guard);
  document.pages[0].content.blocks.blocks[0].collapsed = true;
  const next = await prepare('state-next');
  const evidence = await kernel.generationEvidence(next.projection, next.abi);
  const originalHash = await kernel.hashAbsText(expected.abi);
  const receipt = output => ({ version: 2, requestId: input.requestId, action: 'update',
    expectedGeneration: input.expectedGeneration, changes: input.changes,
    inputAbiHash: originalHash, beforeStates: [{ blockId: 'root', collapsed: false }],
    states: [{ blockId: 'root', collapsed: true }], output });
  await application.stageNativeSave({ ref: admitted.ref, evidence, inputAbiHash: originalHash,
    blockState: receipt(evidence) }, guard);
  const publication = await commit(next);
  assert.equal(publication.status, 'COMMITTED');
  assert.equal(publication.absMirrored, !projectMode);
  assert.equal(await application.sealNativeSave(admitted.ref, guard), true);
  const outcome = { publication, evidence, abs: next.projection.abs, requiresReload: false,
    warnings: derivedFailure ? ['controlled derived publication failure'] : [],
    derivedOutputs: derivedFailure
      ? { published: false, code: 'CONTROLLED_DERIVED_FAILURE', error: 'controlled derived publication failure' }
      : { published: true } };
  return { project, port, store, application, identity, ref: admitted.ref, outcome, draft,
    finish: () => finalize({ outcome, stateReceipt: receipt, applicationJournal: application,
      checkpoint: { native: { ref: admitted.ref } }, assertCurrent: guard }) };
}

test('retained project-v1 draft does not prevent the actual state finalizer from persisting complete original facts', async t => {
  const f = await fixture(t);
  const proof = f.outcome.publication.acceptedSource;
  assert.ok(proof && proof.authorSource.pending);
  await f.finish();
  const reopened = new kernel.AbsApplicationJournal(await openProjectSyncStorage(f.project, guard), f.project);
  const observed = await reopened.observeNativeSave(f.identity, guard);
  assert.equal(observed.state, 'completed');
  assert.equal(observed.result.partial, false);
  assert.equal(observed.result.generatedCodePublished, true);
  assert.deepEqual(observed.result.acceptedSource, proof);
  assert.deepEqual(observed.result.derivedOutputs, { published: true });
  assert.equal(kernel.nativeSaveResult(f.project, f.identity, observed.result).ok, true);
  assert.equal(fs.readFileSync(path.join(f.project, 'project.abs'), 'utf8'), f.draft);
  assert.ok(await f.port.read(`recoveries/application-result-${f.ref.operationId}.json`));
});

test('state finalization keeps a separately reported derived-output failure partial when the retained draft proof is valid', async t => {
  const f = await fixture(t, { derivedFailure: true });
  await f.finish();
  const observed = await f.application.observeNativeSave(f.identity, guard);
  assert.equal(observed.state, 'completed');
  assert.equal(observed.result.partial, true);
  assert.equal(observed.result.generatedCodePublished, false);
  assert.deepEqual(observed.result.derivedOutputs, f.outcome.derivedOutputs);
  assert.deepEqual(observed.result.acceptedSource, f.outcome.publication.acceptedSource);
  assert.equal(kernel.nativeSaveResult(f.project, f.identity, observed.result).ok, false);
  assert.equal(fs.readFileSync(path.join(f.project, 'project.abs'), 'utf8'), f.draft);
});

test('overlay state finalization still accepts its verified mirrored source without an accepted-source proof', async t => {
  const f = await fixture(t, { projectMode: false });
  assert.equal(f.outcome.publication.acceptedSource, undefined);
  await f.finish();
  const observed = await f.application.observeNativeSave(f.identity, guard);
  assert.equal(observed.state, 'completed');
  assert.equal(observed.result.partial, false);
  assert.equal(observed.result.acceptedSource, undefined);
});

test('the unchanged native validator still rejects missing or foreign retained-draft proofs', async t => {
  for (const mode of ['missing', 'foreign']) await t.test(mode, async t => {
    const f = await fixture(t);
    if (mode === 'missing') delete f.outcome.publication.acceptedSource;
    else f.outcome.publication.acceptedSource = { ...f.outcome.publication.acceptedSource,
      binding: { ...f.outcome.publication.acceptedSource.binding, generation: 'another-generation' } };
    await assert.rejects(f.finish(), /Invalid native committed terminal facts/);
    assert.equal(await f.port.read(`recoveries/application-result-${f.ref.operationId}.json`), null);
    assert.equal(fs.readFileSync(path.join(f.project, 'project.abs'), 'utf8'), f.draft);
  });
});
