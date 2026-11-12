const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { buildSync, transformSync } = require('esbuild');
const ts = require('typescript');
const vm = require('node:vm');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const { LibraryEnvironmentJournal } = require('../../electron/library-environment-journal');
const guard = () => {};
let kernel, bundle, parent, inspectSuccessor;
test.before(() => {
  parent = path.resolve('tests/test-results/r2-linked-environment'); fs.mkdirSync(parent, { recursive: true });
  bundle = path.join(parent, `kernel-${Date.now()}.cjs`);
  buildSync({ entryPoints: ['tests/electron/fixtures/r0-publication-kernel.ts'], bundle: true, platform: 'node',
    format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent', alias: {
      '@domain/project/public-api': path.resolve('tests/electron/fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.resolve('tests/electron/fixtures/r0-publication-domain-exports.ts'),
    } });
  kernel = require(bundle);
  const source = ts.createSourceFile('environment-settlement.ts', fs.readFileSync(
    'src/app/integrations/blockly/environment-settlement.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const method = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'inspectEnvironmentSuccessor');
  const module = { exports: {} };
  vm.runInNewContext(transformSync(method.getText(source), { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
    { module, exports: module.exports, ...kernel });
  inspectSuccessor = module.exports.inspectEnvironmentSuccessor;
});
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(parent, 'project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = fork(path.resolve('tests/electron/fixtures/r0-publication-worker.cjs'), ['fixture', root, bundle],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const close = once(child, 'close'), [message] = await once(child, 'message');
  assert.notEqual(message.event, 'failure', JSON.stringify(message)); assert.equal((await close)[0], 0);
  const input = JSON.parse(fs.readFileSync(path.join(root, 'r0-input.json'), 'utf8'));
  const io = await openProjectSyncStorage(root, guard), operations = new kernel.AbsOperationJournal(io, root);
  const applications = new kernel.AbsApplicationJournal(io, root);
  const request = { version: 2, requestId: 'pub2-' + randomUUID(), operation: 'project_save',
    inputDigest: await kernel.hashAbsText(kernel.absJson({ root, operation: 'project_save' })) };
  const ref = (await operations.beginDocumentSave({ request, document: input.baseProjection.document, disk: input.next.expected }, guard)).ref;
  const original = JSON.stringify({ name: 'linked-env', dependencies: {}, projectConfig: { board: 'old' } });
  const desired = JSON.stringify({ ...JSON.parse(original), projectConfig: { board: 'new' } });
  fs.writeFileSync(path.join(root, 'package.json'), original);
  const environments = new LibraryEnvironmentJournal(), environmentId = randomUUID();
  environments.begin(root, { requestId: environmentId, operation: 'board-config', programRef: ref,
    files: { 'package.json': { expectedHash: await kernel.hashAbsText(original), content: desired } } }, null, guard);
  fs.writeFileSync(path.join(root, 'package.json'), desired); environments.complete(root, guard);
  return { root, input, io, operations, applications, request, ref, environments, environmentId, original, desired };
}
async function failNative(ctx) {
  await ctx.applications.completeNativeSave(ctx.ref, { projectSaved: false, generatedCodePublished: false, partial: false,
    publication: { status: 'NOT_COMMITTED' }, requiresReload: false, code: 'ABS_OPERATION_CANCELLED', cancelled: true }, guard);
  await ctx.operations.restored(ctx.ref.operationId, guard);
  return ctx.applications.observeNativeSave(ctx.request, guard);
}
test('real native NOT_COMMITTED restores only its original linked environment and preserves later derived metadata', async t => {
  const ctx = await fixture(t), observed = await failNative(ctx);
  const generated = { ...JSON.parse(ctx.desired), codeHash: 'later-generated', buildInfo: { success: true }, notes: 'later-user-metadata' };
  fs.writeFileSync(path.join(ctx.root, 'package.json'), JSON.stringify(generated));
  const beforeProgram = await new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' }).captureDisk();
  const result = ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation: observed }, guard);
  assert.equal(result.status, 'restored');
  const restored = JSON.parse(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'));
  assert.equal(restored.projectConfig.board, 'old'); assert.equal(restored.codeHash, generated.codeHash);
  assert.equal(restored.notes, generated.notes); assert.deepEqual(restored.buildInfo, generated.buildInfo);
  assert.deepEqual(await new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' }).captureDisk(), beforeProgram);
  assert.deepEqual(ctx.environments.pendingReferences(ctx.root), []);
});
test('real native COMMITTED retains the new environment while using original output evidence', async t => {
  const ctx = await fixture(t), store = new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' });
  await store.stage(ctx.input.next, ctx.input.expectedPointerHash);
  const evidence = await kernel.generationEvidence(ctx.input.next.projection, ctx.input.next.abi);
  await ctx.applications.stageNativeSave({ ref: ctx.ref, evidence, inputAbiHash: await kernel.hashAbsText(ctx.input.next.expected.abi) }, guard);
  const publication = await store.commit('r0-next', guard, async (text, expected, access) => assert.equal(await access.replace('project.abi', expected, text), true));
  assert.equal(publication.status, 'COMMITTED'); assert.equal(await ctx.applications.sealNativeSave(ctx.ref, guard), true);
  await ctx.applications.completeNativeSave(ctx.ref, { projectSaved: true, generatedCodePublished: true, partial: false,
    publication, evidence, requiresReload: false }, guard);
  await ctx.operations.finish(ctx.ref.operationId, guard);
  const observation = await ctx.applications.observeNativeSave(ctx.request, guard);
  assert.equal(observation.current, true);
  const result = ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation }, guard);
  assert.equal(result.status, 'completed'); assert.equal(result.current, true);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), ctx.desired);
});
test('unknown active native owner and a superseding owner cannot authorize old environment rollback', async t => {
  const ctx = await fixture(t), before = fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8');
  const unknown = await ctx.applications.observeNativeSave(ctx.request, guard);
  assert.equal(unknown.state, 'pending');
  assert.throws(() => ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref,
    observation: unknown }, guard), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  const observation = await failNative(ctx);
  await ctx.operations.beginDocumentSave({ request: { ...ctx.request, requestId: 'pub2-' + randomUUID() },
    document: ctx.input.baseProjection.document, disk: ctx.input.next.expected }, guard);
  assert.throws(() => ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation }, guard),
    { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), before);
  const successor = await inspectSuccessor(ctx.io, ctx.root, guard);
  assert.equal(successor.kind, 'native-admission');
  const abiFile = path.join(ctx.root, 'project.abi'), exactAbi = fs.readFileSync(abiFile);
  fs.appendFileSync(abiFile, '\n'); // Isolated negative fixture: a source delta outside that admitted owner.
  assert.equal(await inspectSuccessor(ctx.io, ctx.root, guard), undefined, 'A mixed/torn source is not a verified successor');
  assert.throws(() => ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref,
    observation, successor }, guard), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), before);
  assert.equal(ctx.environments.pendingReferences(ctx.root).length, 1);
  fs.writeFileSync(abiFile, exactAbi); // Return this test-owned corruption fixture to its explicit positive control.
  const result = ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation, successor }, guard);
  assert.equal(result.current, false); assert.equal(result.superseded, true);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), before, 'Retirement writes no environment bytes');
  assert.deepEqual(ctx.environments.pendingReferences(ctx.root), [], 'A verified new owner is not gated by historical environment work');
  ctx.environments.begin(ctx.root, { operation: 'next-environment', requestId: randomUUID() }, null, guard);
});

test('a complete later published head retires old failed environment work without replay or rollback', async t => {
  const ctx = await fixture(t), observation = await failNative(ctx), before = fs.readFileSync(path.join(ctx.root, 'package.json'));
  const operation = await ctx.operations.begin({ kind: 'abs-apply', document: ctx.input.baseProjection.document, disk: ctx.input.next.expected }, guard);
  const store = new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' });
  await store.stage(ctx.input.next, ctx.input.expectedPointerHash);
  const published = await store.commit('r0-next', guard, async (text, expected, access) => assert.equal(await access.replace('project.abi', expected, text), true));
  assert.equal(published.status, 'COMMITTED'); await ctx.operations.finish(operation, guard);
  const successor = await inspectSuccessor(ctx.io, ctx.root, guard);
  assert.equal(successor.kind, 'complete-published-successor');
  const disk = await store.captureDisk();
  const result = ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation, successor }, guard);
  assert.equal(result.current, false); assert.equal(result.superseded, true);
  assert.ok(fs.readFileSync(path.join(ctx.root, 'package.json')).equals(before));
  assert.deepEqual(await store.captureDisk(), disk);
  assert.deepEqual(ctx.environments.pendingReferences(ctx.root), []);
});
