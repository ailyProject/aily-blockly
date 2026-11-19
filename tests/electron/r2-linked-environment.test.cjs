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
const { LibraryDependencies } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
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
async function fixture(t, { authorDraft, exitedOwner = false, splitOwner = false, archive = false, otherExecutor = false } = {}) {
  const root = fs.mkdtempSync(path.join(parent, 'project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = fork(path.resolve('tests/electron/fixtures/r0-publication-worker.cjs'), ['fixture', root, bundle],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  const close = once(child, 'close'), [message] = await once(child, 'message');
  assert.notEqual(message.event, 'failure', JSON.stringify(message)); assert.equal((await close)[0], 0);
  const input = JSON.parse(fs.readFileSync(path.join(root, 'r0-input.json'), 'utf8'));
  if (authorDraft !== undefined) {
    fs.writeFileSync(path.join(root, '.aily/workspace-mode.json'), '{"version":1,"mode":"project-v1"}');
    fs.writeFileSync(path.join(root, 'project.abs'), authorDraft);
    input.next.expected.abs = authorDraft;
    input.next.authorIntent = 'preserve';
  }
  const io = await openProjectSyncStorage(root, guard);
  if (otherExecutor) io.executor = { ...io.executor, storagePid: 2 ** 30 - 1, instanceId: randomUUID(), processIdentity: null };
  const operations = new kernel.AbsOperationJournal(io, root);
  const applications = new kernel.AbsApplicationJournal(io, root);
  const saveRequest = { version: 2, requestId: 'pub2-' + randomUUID(), operation: 'project_save',
    input: { kind: 'board-config', configKey: 'board', configValue: 'new' } };
  const request = await kernel.nativeSaveIdentity(root, saveRequest);
  const submission = { request, document: input.baseProjection.document, disk: input.next.expected };
  const original = JSON.stringify({ name: 'linked-env', dependencies: {}, projectConfig: { board: 'old' } });
  const desired = JSON.stringify({ ...JSON.parse(original), projectConfig: { board: 'new' } });
  fs.writeFileSync(path.join(root, 'package.json'), original);
  const environments = new LibraryEnvironmentJournal(), environmentId = randomUUID();
  const environment = { requestId: environmentId, operation: 'board-config',
    files: { 'package.json': { expectedHash: await kernel.hashAbsText(original), content: desired } } };
  let ref, exitOriginal;
  if (exitedOwner || splitOwner) {
    const owner = fork(path.resolve('tests/electron/fixtures/r2-linked-environment-owner.cjs'), [root, bundle],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
        ...(splitOwner ? { env: { ...process.env, AILY_LIBRARY_HOST_PID: String(io.executor.hostPid) } } : {}) });
    const closed = once(owner, 'close');
    exitOriginal = async () => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await closed;
    };
    t.after(exitOriginal);
    const ready = once(owner, 'message');
    owner.send({ submission, ...(splitOwner ? {} : { environment }) });
    const [message] = await ready;
    assert.equal(message.event, 'admitted', JSON.stringify(message));
    ref = message.ref;
  } else {
    ref = (await operations.beginDocumentSave(submission, guard)).ref;
  }
  if (!exitedOwner || splitOwner) {
    environments.begin(root, { ...environment, programRef: ref }, null, guard);
    if (archive) {
      const packagePath = 'node_modules/test-linked-dependency';
      fs.mkdirSync(path.join(root, packagePath), { recursive: true });
      fs.writeFileSync(path.join(root, packagePath, 'package.json'), '{"name":"test-linked-dependency"}');
      environments.preserve(root, [packagePath], guard);
    }
    fs.writeFileSync(path.join(root, 'package.json'), desired);
    environments.complete(root, guard);
  }
  return { root, input, io, operations, applications, request, saveRequest, ref, environments, environmentId, original, desired, exitOriginal };
}

test('the original renderer can read its completed environment while dependency writes remain blocked', async t => {
  const ctx = await fixture(t, { otherExecutor: true });
  const main = new LibraryDependencies(), sessions = new LibraryDependencySessions(main);
  const publisher = ctx.ref.executor;
  const blocked = { code: 'LIBRARY_ENVIRONMENT_PROGRAM_PENDING' };

  await assert.rejects(sessions.run('status', ctx.root, { reader: publisher }), blocked);
  await assert.rejects(sessions.readStatus(ctx.root, { ...publisher, instanceId: randomUUID() }), blocked);
  const status = await sessions.readStatus(ctx.root, publisher);
  assert.equal(status.manifest.projectConfig.board, 'new');
  assert.equal((await main.pendingEnvironment(ctx.root)).length, 1);
  await assert.rejects(sessions.run('save', ctx.root), blocked);
});

async function failNative(ctx) {
  await ctx.applications.completeNativeSave(ctx.ref, { projectSaved: false, generatedCodePublished: false, partial: false,
    publication: { status: 'NOT_COMMITTED' }, requiresReload: false, code: 'ABS_OPERATION_CANCELLED', cancelled: true }, guard);
  await ctx.operations.restored(ctx.ref.operationId, guard);
  return ctx.applications.observeNativeSave(ctx.request, guard);
}
test('only the original renderer may exit after its Main completed the linked environment', async t => {
  const ctx = await fixture(t, { splitOwner: true, authorDraft: '# Draft at admission\n' });
  const main = new LibraryDependencies();
  const checkpoint = ctx.environments.find(ctx.root, ctx.environmentId).record;
  assert.notEqual(checkpoint.executor.storagePid, ctx.ref.executor.storagePid);
  assert.equal(checkpoint.executor.hostPid, ctx.ref.executor.hostPid);
  assert.equal((await ctx.io.observeExecutor(checkpoint.executor)).state, 'active');
  assert.equal(await ctx.operations.inspectUnpublishedDocumentSave(ctx.ref, guard), null);
  await ctx.exitOriginal();
  assert.equal((await ctx.io.observeExecutor(ctx.ref.executor)).state, 'exited');
  assert.equal((await ctx.io.observeExecutor(checkpoint.executor)).state, 'active');
  const file = name => path.join(ctx.root, name);
  const draft = '# Later unapplied draft\n';
  fs.writeFileSync(file('project.abs'), draft);
  const result = ctx.environments.find(ctx.root, ctx.environmentId).folder + '/result.json';
  const durableResult = fs.readFileSync(result);
  const recovery = () => kernel.settleOriginalBoardEnvironment(ctx.io, ctx.root,
    { request: ctx.request, hostPid: ctx.ref.executor.hostPid }, main, guard);
  fs.unlinkSync(result); // Missing durable Main terminal must remain uncertain while Main is active.
  await assert.rejects(recovery(), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  fs.writeFileSync(result, durableResult);
  fs.writeFileSync(file('package.json'), JSON.stringify({ ...JSON.parse(ctx.desired), projectConfig: { board: 'competing' } }));
  await assert.rejects(recovery(), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  fs.writeFileSync(file('package.json'), ctx.desired);
  assert.equal(await recovery(), 'settled');
  assert.equal(fs.readFileSync(file('package.json'), 'utf8'), ctx.original);
  assert.equal(fs.readFileSync(file('project.abs'), 'utf8'), draft);
  assert.deepEqual(await main.pendingEnvironment(ctx.root), []);
  const next = await main.historyBegin(ctx.root, { packages: ['@aily-project/lib-audit'] });
  assert.ok(next.token);
  await main.historyDiscard(ctx.root, { token: next.token });
});

test('archive pruning keeps verifiable durable receipts and never prunes an invalid resolution', async t => {
  const ctx = await fixture(t, { archive: true });
  const observation = await failNative(ctx);
  ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation }, guard);
  const { folder } = ctx.environments.find(ctx.root, ctx.environmentId);
  const terminalNames = ['checkpoint.json', 'result.json', 'restoration.json', 'program-resolution.json'];
  const receipts = terminalNames.map(file => fs.readFileSync(path.join(folder, file)));
  const trees = path.join(folder, 'trees'), resolution = path.join(folder, terminalNames.at(-1));
  assert.ok(fs.readdirSync(trees).some(file => file.endsWith('.json')));
  fs.appendFileSync(resolution, 'invalid checksum envelope');
  ctx.environments.prune(ctx.root, 0);
  assert.ok(fs.existsSync(trees), 'Archive remains recoverable while terminal validation fails');
  fs.writeFileSync(resolution, receipts.at(-1));
  ctx.environments.prune(ctx.root, 0);
  assert.equal(fs.existsSync(trees), false);
  assert.deepEqual(terminalNames.map(file => fs.readFileSync(path.join(folder, file))), receipts);
  assert.equal(ctx.environments.observe(ctx.root, ctx.environmentId).status, 'restored');
  assert.deepEqual(ctx.environments.pendingReferences(ctx.root), []);
});
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

for (const exitedOwner of [false, true]) test(
  `the exact ${exitedOwner ? 'exited' : 'NOT_COMMITTED'} board owner releases its environment without replacing a later draft`,
  async t => {
    const ctx = await fixture(t, { authorDraft: '# Independent draft at admission\n', exitedOwner });
    const main = new LibraryDependencies();
    let observation, previousProof;
    if (exitedOwner) {
      assert.equal(await ctx.operations.inspectUnpublishedDocumentSave(ctx.ref, guard), null);
      await ctx.exitOriginal();
      assert.equal((await ctx.io.observeExecutor(ctx.ref.executor)).state, 'exited');
      observation = await ctx.applications.observeNativeSave(ctx.request, guard);
      assert.equal(observation.state, 'pending');
      previousProof = await ctx.operations.inspectUnpublishedDocumentSave(ctx.ref, guard);
      assert.equal(previousProof.kind, 'source-not-published');
    } else {
      observation = await failNative(ctx);
      assert.equal(observation.result.publication.status, 'NOT_COMMITTED');
    }
    const target = file => path.join(ctx.root, file);
    fs.writeFileSync(target('project.abs'), '# Later unapplied draft\n');
    const files = ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json', '.aily/abs-sync/operation.json'];
    const capture = () => files.map(file => fs.readFileSync(target(file)));
    const before = capture();
    const request = { requestId: ctx.environmentId, programRef: ctx.ref, observation };
    if (previousProof) {
      await assert.rejects(main.settleLinkedEnvironment(ctx.root, { ...request, unpublishedSource: previousProof }),
        { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
      request.unpublishedSource = await ctx.operations.inspectUnpublishedDocumentSave(ctx.ref, guard);
      assert.equal(request.unpublishedSource.kind, 'source-not-published');
      assert.notEqual(request.unpublishedSource.saved.absHash, previousProof.saved.absHash);
    }
    const accepted = target('.aily/abs-sync/baselines/r0-base.json'), originalBaseline = fs.readFileSync(accepted);
    fs.appendFileSync(accepted, '\n');
    await assert.rejects(main.settleLinkedEnvironment(ctx.root, request), { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
    fs.writeFileSync(accepted, originalBaseline);
    await assert.rejects(main.historyBegin(ctx.root, { packages: ['@aily-project/lib-audit'] }),
      { code: 'LIBRARY_ENVIRONMENT_PROGRAM_PENDING' });
    const result = await main.settleLinkedEnvironment(ctx.root, request);
    assert.equal(result.environment.status, 'restored');
    assert.equal(fs.readFileSync(target('package.json'), 'utf8'), ctx.original);
    assert.deepEqual(capture(), before);
    assert.deepEqual(await main.pendingEnvironment(ctx.root), []);
    const next = await main.historyBegin(ctx.root, { packages: ['@aily-project/lib-audit'] });
    assert.ok(next.token);
    await main.historyDiscard(ctx.root, { token: next.token });
  },
);
test('original board recovery cannot settle another input, executor or a missing request', async t => {
  const ctx = await fixture(t);
  await failNative(ctx);
  const main = new LibraryDependencies();
  const recovery = (request, hostPid = ctx.ref.executor.hostPid) =>
    kernel.settleOriginalBoardEnvironment(ctx.io, ctx.root, { request, hostPid }, main, guard);
  const originalEnvironment = () => main.pendingEnvironment(ctx.root);
  assert.equal(await recovery({ ...ctx.request, requestId: 'pub2-' + randomUUID() }), 'pending');
  await assert.rejects(recovery({ ...ctx.request, inputDigest: 'sha256:' + '0'.repeat(64) }),
    { code: 'ABS_NATIVE_SAVE_REQUEST_CONFLICT' });
  await assert.rejects(recovery(ctx.request, ctx.ref.executor.hostPid + 1),
    { code: 'PROJECT_SAVE_EXECUTOR_MISMATCH' });
  assert.deepEqual(await originalEnvironment(), [{ requestId: ctx.environmentId, programRef: ctx.ref }]);
  assert.equal(await recovery(ctx.request), 'settled');
  assert.equal(await recovery(ctx.request), 'none');
  assert.deepEqual(await originalEnvironment(), []);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), ctx.original);
});
async function commitNative(ctx) {
  const store = new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' });
  await store.stage(ctx.input.next, ctx.input.expectedPointerHash);
  const evidence = await kernel.generationEvidence(ctx.input.next.projection, ctx.input.next.abi);
  await ctx.applications.stageNativeSave({ ref: ctx.ref, evidence, inputAbiHash: await kernel.hashAbsText(ctx.input.next.expected.abi) }, guard);
  const publication = await store.commit('r0-next', guard, async (text, expected, access) => assert.equal(await access.replace('project.abi', expected, text), true));
  assert.equal(publication.status, 'COMMITTED'); assert.equal(await ctx.applications.sealNativeSave(ctx.ref, guard), true);
  await ctx.applications.completeNativeSave(ctx.ref, { projectSaved: true, generatedCodePublished: true, partial: false,
    publication, evidence, requiresReload: false,
    ...(publication.acceptedSource ? { acceptedSource: publication.acceptedSource } : {}) }, guard);
  await ctx.operations.finish(ctx.ref.operationId, guard);
  const observation = await ctx.applications.observeNativeSave(ctx.request, guard);
  assert.equal(observation.current, true);
  return observation;
}
test('real native COMMITTED retains the new environment while using original output evidence', async t => {
  const ctx = await fixture(t), observation = await commitNative(ctx);
  const absFile = path.join(ctx.root, 'project.abs'), exact = fs.readFileSync(absFile);
  fs.appendFileSync(absFile, '\n# unexpected overlay-v1 mirror change');
  assert.throws(() => ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation }, guard),
    { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
  fs.writeFileSync(absFile, exact);
  const result = ctx.environments.settleLinked(ctx.root, { requestId: ctx.environmentId, programRef: ctx.ref, observation }, guard);
  assert.equal(result.status, 'completed'); assert.equal(result.current, true);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'package.json'), 'utf8'), ctx.desired);
});
test('real Main settles the exact committed board environment while preserving dirty author ABS', async t => {
  const draft = '# This unapplied ABS draft must survive verbatim.\n';
  const ctx = await fixture(t, { authorDraft: draft }), observation = await commitNative(ctx);
  const main = new LibraryDependencies();
  const request = { requestId: ctx.environmentId, programRef: ctx.ref, observation };
  assert.equal(observation.result.acceptedSource.authorSource.pending, true);
  assert.notEqual(observation.result.evidence.binding.absHash, await kernel.hashAbsText(draft));
  const files = ['project.abi', 'project.abs', 'project.abs.map.json', 'package.json', '.aily/abs-sync/committed.json'];
  const capture = () => files.map(relative => fs.readFileSync(path.join(ctx.root, relative)));
  const before = capture();
  const baseline = path.join(ctx.root, '.aily/abs-sync/baselines/r0-next.json');
  const exact = fs.readFileSync(baseline);
  const reject = { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' };
  fs.unlinkSync(baseline);
  await assert.rejects(main.settleLinkedEnvironment(ctx.root, request), reject);
  fs.writeFileSync(baseline, Buffer.concat([exact, Buffer.from('\n')]));
  await assert.rejects(main.settleLinkedEnvironment(ctx.root, request), reject);
  fs.writeFileSync(baseline, exact);
  const foreign = structuredClone(request);
  foreign.observation.result.acceptedSource.attachment.identity.ino = '0';
  await assert.rejects(main.settleLinkedEnvironment(ctx.root, foreign), reject);
  assert.deepEqual(capture(), before);
  assert.deepEqual(await main.pendingEnvironment(ctx.root), [{ requestId: ctx.environmentId, programRef: ctx.ref }]);
  await assert.rejects(main.locked(ctx.root, () => {}), { code: 'LIBRARY_ENVIRONMENT_PROGRAM_PENDING' });

  const result = await main.settleLinkedEnvironment(ctx.root, request);
  assert.equal(result.environment.status, 'completed');
  assert.equal(result.environment.current, true);
  assert.deepEqual(await main.pendingEnvironment(ctx.root), []);
  assert.equal(await main.locked(ctx.root, () => 'new dependency operation admitted'), 'new dependency operation admitted');
  assert.deepEqual(capture(), before);
  assert.equal(fs.readFileSync(path.join(ctx.root, 'project.abs'), 'utf8'), draft);
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

for (const projectMode of [false, true]) test(
  `a newer native admission with an independent draft requires exact ${projectMode ? 'project' : 'legacy'} source witnesses`,
  async t => {
    const ctx = await fixture(t, projectMode ? { authorDraft: '# Draft at native admission\n' } : undefined);
    const observation = await failNative(ctx);
    const request = await kernel.nativeSaveIdentity(ctx.root, {
      version: 2, requestId: 'pub2-' + randomUUID(), operation: 'project_save',
    });
    const store = new kernel.AbsBaselineStore(ctx.io, { projectKey: ctx.root, pageId: 'main' });
    const next = await ctx.operations.beginDocumentSave({ request, document: ctx.input.baseProjection.document,
      disk: await store.captureDisk() }, guard);
    await failNative({ ...ctx, request, ref: next.ref });

    const target = file => path.join(ctx.root, file), author = target('project.abs');
    const newerDraft = '# Later author edit, not a native publication\n';
    fs.writeFileSync(author, newerDraft);
    const files = ['project.abi', 'project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json',
      '.aily/abs-sync/operation.json', 'package.json'];
    const capture = () => files.map(file => fs.readFileSync(target(file)));
    const before = capture(), main = new LibraryDependencies();
    const successor = await inspectSuccessor(ctx.io, ctx.root, guard);
    const settle = proof => main.settleLinkedEnvironment(ctx.root, {
      requestId: ctx.environmentId, programRef: ctx.ref, observation, successor: proof,
    });
    const checkPending = async () => {
      const originals = await main.pendingEnvironment(ctx.root);
      assert.deepEqual(originals, [{ requestId: ctx.environmentId, programRef: ctx.ref }]);
    };
    const rejected = { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' };
    if (!projectMode) {
      assert.equal(successor, undefined);
      await assert.rejects(settle(successor), rejected);
      await checkPending();
      assert.deepEqual(capture(), before);
      return;
    }

    assert.equal(successor?.kind, 'native-admission');
    assert.deepEqual(JSON.parse(JSON.stringify(successor.ref)), next.ref);
    assert.equal(successor.saved.absHash, await kernel.hashAbsText(newerDraft));
    const baseline = target('.aily/abs-sync/baselines/r0-base.json'), baselineBytes = fs.readFileSync(baseline);
    fs.appendFileSync(baseline, '\n');
    await assert.rejects(settle(successor), rejected);
    fs.writeFileSync(baseline, baselineBytes);
    const index = target('.aily/abs-sync/' + await kernel.nativeSaveIndexKey(request.requestId));
    const exactIndex = fs.readFileSync(index);
    fs.unlinkSync(index);
    await assert.rejects(settle(successor), rejected);
    fs.writeFileSync(index, exactIndex);
    fs.appendFileSync(author, '# another writer after proof\n');
    await assert.rejects(settle(successor), rejected);
    fs.writeFileSync(author, newerDraft);
    await checkPending();
    assert.deepEqual(capture(), before);

    const result = await settle(successor);
    assert.equal(result.environment.superseded, true);
    assert.equal(result.environment.current, false);
    assert.deepEqual(await main.pendingEnvironment(ctx.root), []);
    assert.deepEqual(capture(), before);
    const library = await main.historyBegin(ctx.root, { packages: ['@aily-project/lib-audit'] });
    assert.ok(library.token);
    await main.historyDiscard(ctx.root, { token: library.token });
  },
);

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
