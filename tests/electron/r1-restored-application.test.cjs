const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { buildSync } = require('esbuild');
const { before, after, test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const repo = path.resolve(__dirname, '../..'), root = path.join(repo, 'tests/test-results', 'r1-restored-application-' + Date.now());
let bundle, kernel;
const children = new Set(), guard = () => {};
before(() => {
  fs.mkdirSync(root, { recursive: true });
  bundle = process.env.R1_RESTORED_KERNEL || path.join(root, 'kernel.cjs');
  if (!process.env.R1_RESTORED_KERNEL) buildSync({ absWorkingDir: repo, entryPoints: ['tests/electron/fixtures/r0-publication-kernel.ts'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
  kernel = require(bundle);
});
async function worker(project, mode) {
  const child = fork(path.join(__dirname, 'fixtures/r1-restored-application-worker.cjs'), [project, bundle, mode],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.add(child);
  const closed = new Promise(resolve => child.once('exit', () => { children.delete(child); resolve(); }));
  const original = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Original worker failed to prepare')), 15000);
    child.once('message', value => { clearTimeout(timer); value.event === 'ready' ? resolve(value) : reject(Error(value.message)); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Original worker exited before ready')); });
  });
  return { original, child, closed, stop: async () => { child.kill('SIGKILL'); await closed; } };
}
async function fixture(legacy = false, projectMode = false) {
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  await new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), ['fixture', project, bundle],
      { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Fixture failed ' + code)));
  });
  if (projectMode) fs.writeFileSync(path.join(project, '.aily/workspace-mode.json'), '{"version":1,"mode":"project-v1"}');
  const originalWorker = await worker(project, legacy === true ? 'legacy' : legacy || '');
  const port = await openProjectSyncStorage(project, guard), journal = new kernel.AbsOperationJournal(port, project);
  return { project, port, journal, ...originalWorker };
}
const recover = ctx => ctx.journal.inspectRestoredApplication(ctx.original.requestId, guard, async document => assert.deepEqual(document, ctx.original.document));

test('restored S1 with a live original writer is denied; actual process death grants only independent Working facts', async () => {
  const ctx = await fixture();
  try {
    const snapshot = await ctx.journal.inspect();
    assert.deepEqual(snapshot.attachment, ctx.original.attachment); assert.deepEqual(snapshot.executor, ctx.original.executor);
    assert.equal(await recover(ctx), null, 'A restored pointer is not a writer fence');
    await ctx.stop();
    const disk = await new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' }).captureDisk();
    const facts = await recover(ctx);
    assert.equal(facts.scope, 'restored-working-document'); assert.equal(facts.state, 'restored');
    assert.equal(facts.requestId, ctx.original.requestId); assert.equal(facts.operationId, ctx.original.operationId);
    assert.equal(facts.originalPublication, 'UNKNOWN'); assert.equal(facts.candidateApplied, false);
    assert.equal(facts.oldWriter.state, 'exited'); assert.equal(facts.originalExecutor.storagePid, ctx.child.pid);
    assert.equal(facts.observerExecutor.storagePid, process.pid); assert.deepEqual(facts.attachment, ctx.port.attachment);
    assert.equal(facts.documentHash, await kernel.hashAbsText(kernel.absJson(ctx.original.document)));
    for (const key of ['abi', 'abs', 'map']) assert.equal(facts.saved[key + 'Hash'], await kernel.hashAbsText(disk[key]));
    const old = await new kernel.AbsApplicationJournal(ctx.port, ctx.project).observe(ctx.original.requestId, guard);
    assert.equal(old.result.publication.status, 'UNKNOWN'); assert.equal(old.result.applicationObservation.current, false);
    assert.deepEqual(await new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' }).captureDisk(), disk);
  } finally { if (children.has(ctx.child)) await ctx.stop(); }
});
test('a project-v1 draft independent of the recovered Working document preserves the durable writer fence', async () => {
  const ctx = await fixture('identical-document', true);
  await ctx.stop();
  const source = path.join(ctx.project, 'project.abs'), draft = '# Authored after the interrupted application\n';
  fs.writeFileSync(source, draft);
  const marker = `recoveries/application-restored-${ctx.original.operationId}.json`;
  const restored = await kernel.recoverAbsProjectOperation(ctx.port, ctx.project, guard);
  assert.deepEqual(restored.document, ctx.original.document);
  await ctx.journal.restored(restored.operationId, guard);
  const store = new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' });
  const before = await store.captureDisk();

  const baseline = path.join(ctx.project, '.aily/abs-sync/baselines/r0-base.json'), exactBaseline = fs.readFileSync(baseline);
  try {
    fs.appendFileSync(baseline, '\n');
    await assert.rejects(ctx.journal.recordRestoredApplication(restored.operationId, guard,
      async () => assert.fail('Invalid accepted generation cannot reach Working readback')));
  } finally { fs.writeFileSync(baseline, exactBaseline); }
  await ctx.journal.recordRestoredApplication(restored.operationId, guard, async () => fs.appendFileSync(source, '# Newer writer'));
  assert.equal(await ctx.port.read(marker), null);
  assert.equal(fs.readFileSync(source, 'utf8'), draft + '# Newer writer');
  fs.writeFileSync(source, draft);

  await ctx.journal.recordRestoredApplication(restored.operationId, guard, async document => {
    assert.deepEqual(document, ctx.original.document);
  });
  const stored = await ctx.port.read(marker);
  assert.ok(stored);
  assert.deepEqual(await store.captureDisk(), before);
  const next = await ctx.journal.begin({ kind: 'document-save', document: JSON.parse(before.abi), disk: before }, guard);
  await ctx.journal.finishUnchangedSave(next, before, guard);
  const reply = (await new kernel.AbsApplicationJournal(ctx.port, ctx.project).observe(ctx.original.requestId, guard)).result;
  assert.equal(reply.publication.status, 'UNKNOWN');
  assert.equal(reply.currentDocumentRecovery.oldWriter.state, 'exited');
  assert.equal(reply.currentDocumentRecovery.settlement.recordHash, await kernel.hashAbsText(stored));
  assert.equal(fs.readFileSync(source, 'utf8'), draft);
});

test('a second restart reuses the sealed original ABS fence when process identity is temporarily unavailable', async () => {
  const ctx = await fixture('identical-document', true);
  await ctx.stop();
  const authorFile = path.join(ctx.project, 'project.abs'), draft = '# Preserve independent author changes across both restarts\n';
  fs.writeFileSync(authorFile, draft);
  const store = new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' });
  const before = await store.captureDisk();
  const recovery = await worker(ctx.project, 'recover-original');
  await recovery.stop();
  const cold = await openProjectSyncStorage(ctx.project, guard), marker = `recoveries/application-restored-${ctx.original.operationId}.json`;
  assert.notEqual(ctx.original.executor.storagePid, recovery.original.executor.storagePid);
  assert.notEqual(recovery.original.executor.storagePid, cold.executor.storagePid);
  const inspect = (state, reason) => new kernel.AbsApplicationJournal({ ...cold, observeExecutor: async executor => {
    assert.deepEqual(executor, ctx.original.executor);
    return { version: 1, state, reason };
  } }, ctx.project).observe(ctx.original.requestId, guard).then(({ result }) => result);

  const reply = await inspect('unknown', 'identity-unavailable');
  assert.equal(reply.publication.status, 'UNKNOWN');
  assert.equal(reply.applicationObservation.current, false);
  assert.equal(reply.currentDocumentRecovery?.settlement.recordHash, await kernel.hashAbsText(recovery.original.proof));
  assert.equal(reply.currentDocumentRecovery.oldWriter.state, 'exited');
  assert.equal(reply.currentDocumentRecovery.originalExecutor.storagePid, ctx.original.executor.storagePid);
  assert.equal(reply.currentDocumentRecovery.observerExecutor.storagePid, recovery.original.executor.storagePid);
  assert.equal((await inspect('active', 'process-matched')).currentDocumentRecovery, undefined, 'Positive contradictory evidence fails closed');
  assert.equal((await inspect('unknown', 'invalid-executor')).currentDocumentRecovery, undefined, 'Malformed identity does not count as transient');
  const record = JSON.parse(recovery.original.proof);
  const file = path.join(ctx.project, '.aily/abs-sync', marker);
  try {
    record.recovery.documentHash = 'sha256:' + '0'.repeat(64);
    fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(inspect('unknown', 'identity-unavailable'), { code: 'ABS_OPERATION_CONFLICT' });
  } finally { fs.writeFileSync(file, recovery.original.proof); }
  assert.equal(await cold.read(marker), recovery.original.proof);
  assert.deepEqual(await store.captureDisk(), before);
  assert.equal(fs.readFileSync(authorFile, 'utf8'), draft);
});

test('pending/completed/different pointers, changed mirrors, prepared or application facts never grant a restored Working fact', async () => {
  const ctx = await fixture(); await ctx.stop();
  const folder = path.join(ctx.project, '.aily/abs-sync'), pointer = path.join(folder, 'operation.json');
  for (const [file, content] of [
    [pointer, JSON.stringify({ ...JSON.parse(fs.readFileSync(pointer)), state: 'pending' })],
    [pointer, JSON.stringify({ ...JSON.parse(fs.readFileSync(pointer)), state: 'completed' })],
    [path.join(ctx.project, 'project.abi'), '{}'], [path.join(ctx.project, 'project.abs'), 'different draft'],
    [path.join(ctx.project, 'project.abs.map.json'), '{}'], [path.join(folder, 'committed.json'), '{}'],
    ...['prepared.json', 'recoveries/application-', 'recoveries/application-commit-', 'recoveries/application-result-'].map(key =>
      [path.join(folder, key === 'prepared.json' ? key : key + ctx.original.operationId + '.json'), '{}'])
  ]) {
    const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try { fs.writeFileSync(file, content); assert.equal(await recover(ctx), null, file); }
    finally { old === null ? fs.unlinkSync(file) : fs.writeFileSync(file, old); }
  }
  assert.ok(await recover(ctx));
});

test('foreign physical attachment, unknown executor and stale or failed GUI readback fail closed', async () => {
  const ctx = await fixture(); await ctx.stop();
  for (const port of [
    { ...ctx.port, attachment: { ...ctx.port.attachment, identity: { ...ctx.port.attachment.identity, ino: '999999' } } },
    { ...ctx.port, observeExecutor: async () => ({ version: 1, state: 'unknown', reason: 'process-unavailable' }) },
    { ...ctx.port, observeExecutor: undefined },
  ]) assert.equal(await new kernel.AbsOperationJournal(port, ctx.project).inspectRestoredApplication(ctx.original.requestId, guard,
    async () => { throw Error('Untrusted inputs cannot reach live GUI readback'); }), null);
  await assert.rejects(ctx.journal.inspectRestoredApplication(ctx.original.requestId, guard, async () => { throw Error('Actual S1 readback differs'); }), /S1 readback/);
  let current = true;
  await assert.rejects(ctx.journal.inspectRestoredApplication(ctx.original.requestId, () => { if (!current) throw Error('Owner cancelled'); },
    async () => { current = false; }), /Owner cancelled/);
  const file = path.join(ctx.project, 'project.abi'), old = fs.readFileSync(file);
  try {
    assert.equal(await ctx.journal.inspectRestoredApplication(ctx.original.requestId, guard, async () => { fs.writeFileSync(file, '{}'); }), null);
  } finally { fs.writeFileSync(file, old); }
});

test('legacy operations cannot gain a new attachment, and corrupted original snapshots cannot authorize recovery', async () => {
  const legacy = await fixture(true); await legacy.stop();
  assert.equal((await legacy.journal.inspect()).attachment, undefined);
  assert.equal(await recover(legacy), null);
  const ctx = await fixture(); await ctx.stop();
  const file = path.join(ctx.project, '.aily/abs-sync/recoveries', 'operation-' + ctx.original.operationId + '.json');
  const old = fs.readFileSync(file);
  try { fs.writeFileSync(file, '{}'); await assert.rejects(recover(ctx), { code: 'ABS_OPERATION_CONFLICT' }); }
  finally { fs.writeFileSync(file, old); }
  const copied = ctx.project + '-copy'; fs.cpSync(ctx.project, copied, { recursive: true });
  const copiedPort = await openProjectSyncStorage(copied, guard);
  assert.notDeepEqual(copiedPort.attachment, ctx.port.attachment);
  await assert.rejects(new kernel.AbsOperationJournal(copiedPort, copied).inspectRestoredApplication(ctx.original.requestId, guard,
    async () => { throw Error('Copied records cannot reach readback'); }), { code: 'ABS_OPERATION_CONFLICT' });
  assert.ok(await recover(ctx));
});

test('a real committed successor base keeps the older tracked intent in restored-document facts', async () => {
  const ctx = await fixture('advanced-intent'); await ctx.stop();
  const snapshot = await ctx.journal.inspect(), validation = snapshot.application.validation;
  const store = new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' });
  const current = await store.loadCommitted(), origin = await store.load('r0-base');
  assert.equal(current.map.generation, 'r0-next'); assert.equal(origin.map.generation, 'r0-base');
  assert.deepEqual(validation.base, (await kernel.generationEvidence(current, snapshot.disk.abi)).binding);
  assert.equal(snapshot.candidate.generation, validation.base.generation);
  assert.equal(validation.intentGeneration, origin.map.generation); assert.notEqual(validation.intentGeneration, validation.base.generation);
  let source = origin.abs;
  for (const batch of validation.sourceEdits) for (const edit of [...batch].sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  assert.equal(source, snapshot.candidate.source, 'The genuine edit chain starts at the original committed intent');
  assert.equal(await kernel.hashAbsText(source), validation.candidate.hash);
  const facts = await recover(ctx);
  assert.ok(facts); assert.equal(facts.candidate.intentGeneration, origin.map.generation);
  assert.equal(facts.candidate.hash, validation.candidate.hash); assert.equal(facts.originalPublication, 'UNKNOWN');
  assert.equal((await new kernel.AbsApplicationJournal(ctx.port, ctx.project).observe(ctx.original.requestId, guard)).result.publication.status, 'UNKNOWN');
  assert.deepEqual((await ctx.journal.inspect()).candidate, snapshot.candidate, 'Observation cannot rewrite the snapshot generation');
});

test('only recovered-view readback retains an original writer fence across a later unchanged save', async () => {
  const ctx = await fixture('identical-document');
  try {
    const readback = async document => assert.deepEqual(document, ctx.original.document);
    await ctx.journal.recordRestoredApplication(ctx.original.operationId, guard, async () => {
      assert.fail('A live original writer cannot authorize recovery');
    });
    const marker = `recoveries/application-restored-${ctx.original.operationId}.json`;
    assert.equal(await ctx.port.read(marker), null);
    await ctx.stop();
    const restored = await kernel.recoverAbsProjectOperation(ctx.port, ctx.project, guard);
    assert.deepEqual(restored.document, ctx.original.document);
    await ctx.journal.restored(restored.operationId, guard);
    await assert.rejects(ctx.journal.recordRestoredApplication(restored.operationId, guard,
      async () => { throw Error('Recovered live document changed'); }), /live document changed/);
    assert.equal(await ctx.port.read(marker), null);
    await ctx.journal.recordRestoredApplication(restored.operationId, guard, readback);
    const stored = await ctx.port.read(marker);
    const result = await ctx.journal.inspectRestoredApplication(ctx.original.requestId, guard);
    assert.equal(result.settlement.recordHash, await kernel.hashAbsText(stored));
    assert.equal(result.originalPublication, 'UNKNOWN');

    const store = new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' });
    const disk = await store.captureDisk();
    const savedDocument = JSON.parse(disk.abi);
    assert.deepEqual(savedDocument, restored.document);
    const next = await ctx.journal.begin({ kind: 'document-save', document: savedDocument, disk }, guard);
    await ctx.journal.finishUnchangedSave(next, disk, guard);
    assert.deepEqual(await store.captureDisk(), disk);
    const coldPort = await openProjectSyncStorage(ctx.project, guard);
    const reply = (await new kernel.AbsApplicationJournal(coldPort, ctx.project).observe(ctx.original.requestId, guard)).result;
    assert.equal(reply.publication.status, 'UNKNOWN');
    assert.equal(reply.ok, false);
    assert.deepEqual(reply.currentDocumentRecovery, result);
    assert.equal(await coldPort.read(marker), stored);

    const { next: nextGeneration, expectedPointerHash } = JSON.parse(fs.readFileSync(path.join(ctx.project, 'r0-input.json'), 'utf8'));
    await store.stage(nextGeneration, expectedPointerHash);
    const publication = await store.commit(nextGeneration.projection.map.generation, guard,
      async (content, expected, access) => assert.equal(await access.replace('project.abi', expected, content), true));
    assert.equal(publication.status, 'COMMITTED');
    assert.notDeepEqual(await store.captureDisk(), disk);
    const historical = (await new kernel.AbsApplicationJournal(coldPort, ctx.project).observe(ctx.original.requestId, guard)).result;
    assert.equal(historical.publication.status, 'UNKNOWN');
    assert.deepEqual(historical.currentDocumentRecovery, result);
    assert.equal(await coldPort.read(marker), stored);
  } finally { if (children.has(ctx.child)) await ctx.stop(); }
});

test('cold recovery settles exact pre-ABI staging without granting an application result', async () => {
  const ctx = await fixture('staged-before-abi');
  try {
    assert.ok(await ctx.port.read('prepared.json'));
    await ctx.stop();
    const restored = await kernel.recoverAbsProjectOperation(ctx.port, ctx.project, guard);
    assert.equal(await ctx.port.read('prepared.json'), null);
    assert.deepEqual(restored.document, ctx.original.document);
    const store = new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' });
    const disk = await store.captureDisk();
    assert.equal(JSON.parse(disk.abi).pages[0].content.blocks.blocks[0].fields.VALUE, 100);
    await ctx.journal.restored(restored.operationId, guard);
    const staged = await ctx.port.read(`recoveries/application-${restored.operationId}.json`);
    assert.ok(staged);
    await ctx.journal.recordRestoredApplication(restored.operationId, guard,
      async actual => assert.deepEqual(actual, restored.document));
    const observed = (await new kernel.AbsApplicationJournal(ctx.port, ctx.project).observe(ctx.original.requestId, guard)).result;
    assert.equal(observed.code, 'ABS_APPLY_OBSERVATION_PENDING');
    assert.equal(observed.publication.status, 'UNKNOWN');
    assert.equal(observed.currentDocumentRecovery.oldWriter.state, 'exited');
    assert.equal(observed.currentDocumentRecovery.candidateApplied, false);
    const marker = JSON.parse(await ctx.port.read(`recoveries/application-restored-${restored.operationId}.json`));
    assert.equal(marker.stagedHash, await kernel.hashAbsText(staged));
    assert.deepEqual(await store.captureDisk(), disk);
  } finally { if (children.has(ctx.child)) await ctx.stop(); }
});

test('a second process interruption leaves only old indexed ABS writer proof after the next save', async () => {
  const ctx = await fixture('staged-before-abi');
  await ctx.stop();
  const interrupted = await worker(ctx.project, 'recover-before-readback');
  await interrupted.stop();
  const port = await openProjectSyncStorage(ctx.project, guard);
  const journal = new kernel.AbsOperationJournal(port, ctx.project);
  const disk = await new kernel.AbsBaselineStore(port, { projectKey: ctx.project, pageId: 'main' }).captureDisk();
  const old = ctx.original;
  const nextId = await journal.begin({ kind: 'document-save', document: JSON.parse(disk.abi), disk }, guard);
  await journal.finishUnchangedSave(nextId, disk, guard);

  const pointer = await port.read('operation.json');
  const later = new kernel.AbsApplicationJournal(await openProjectSyncStorage(ctx.project, guard), ctx.project);
  for (const target of [undefined, old.executor.hostPid]) {
    const { result } = await later.observe(old.requestId, guard, target);
    assert.equal(result.publication.status, 'UNKNOWN');
    assert.equal(result.currentDocumentRecovery, undefined);
    assert.equal(result.publicationObservation, undefined);
    assert.deepEqual(result.applicationObservation, { version: 1, requestId: old.requestId, current: false });
    const proof = result.writerObservation;
    assert.equal(proof.kind, 'indexed-application-retired');
    assert.equal(proof.operationId, old.operationId);
    assert.deepEqual(proof.executor, old.executor);
    assert.equal(proof.oldWriter.state, 'exited');
    assert.equal(proof.settlement.recordHash, await kernel.hashAbsText(await port.read(`recoveries/application-retired-${old.operationId}.json`)));
  }
  await assert.rejects(later.observe(old.requestId, guard, process.pid), { code: 'ABS_APPLY_OBSERVATION_INVALID' });
  assert.equal(await port.read(`recoveries/application-restored-${old.operationId}.json`), null);
  assert.equal(await port.read('operation.json'), pointer);
  assert.deepEqual(await new kernel.AbsBaselineStore(port, { projectKey: ctx.project, pageId: 'main' }).captureDisk(), disk);
  assert.ok(JSON.parse(await port.read(`recoveries/operation-${old.operationId}.json`)).candidate.source);
});

test('an unavailable exit probe keeps staged state evidence available after a distinct request advances', async () => {
  const f = await fixture('native-state-before-abi', true);
  await f.stop();
  const { ref, identity, executor } = f.original;
  assert.equal((await f.port.observeExecutor(executor)).state, 'exited');
  let exitProbes = 0;
  const port = { ...f.port, observeExecutor: async original => {
    assert.deepEqual(original, executor);
    exitProbes++;
    return { version: 1, state: 'unknown', reason: 'identity-unavailable' };
  } };
  const journal = new kernel.AbsOperationJournal(port, f.project);
  const restored = await kernel.recoverAbsProjectOperation(port, f.project, guard);
  assert.equal(restored.operationId, ref.operationId);
  await journal.restored(restored.operationId, guard);
  const disk = await new kernel.AbsBaselineStore(port, { projectKey: f.project, pageId: 'main' }).captureDisk();
  const draft = '# Independent author draft while the exit probe is unavailable\n';
  fs.writeFileSync(path.join(f.project, 'project.abs'), draft);
  const nextDisk = { ...disk, abs: draft };
  const nextId = await journal.begin({ kind: 'document-save', document: JSON.parse(disk.abi), disk: nextDisk }, guard);
  await journal.finishUnchangedSave(nextId, nextDisk, guard);
  assert.ok(exitProbes >= 2);
  assert.equal(await port.read(kernel.nativeSaveSettlementKey(ref.operationId)), null);
  const handoff = JSON.parse(await port.read(`recoveries/operation-handoff-${ref.operationId}.json`));
  assert.equal(handoff.saved.absHash, await kernel.hashAbsText(draft));
  assert.equal(JSON.parse(handoff.operationPointer).id, ref.operationId);

  const finalPort = await openProjectSyncStorage(f.project, guard);
  const options = { originalTargetPid: executor.hostPid };
  const old = await kernel.observeNativePublication(finalPort, f.project, identity, options);
  assert.equal(old.saveReceipt.state, 'unknown');
  assert.equal(old.publicationObservation, undefined);
  assert.deepEqual(old.writerObservation.executor, executor);
  assert.equal(old.writerObservation.kind, 'indexed-save-retired');
  assert.equal(old.writerObservation.settlement.kind, 'source-not-published');
  assert.equal(JSON.parse(await finalPort.read('operation.json')).id, nextId);
  assert.equal(await finalPort.read('project.abs'), draft);
  assert.equal((await kernel.observeNativePublication(finalPort, f.project, identity, options)).writerObservation.settlement.recordHash,
    old.writerObservation.settlement.recordHash);
});

async function publishSuccessorSave(project, port, generation) {
  const scope = { projectKey: project, pageId: 'main' };
  const store = new kernel.AbsBaselineStore(port, scope), operations = new kernel.AbsOperationJournal(port, project);
  const previous = await port.read('committed.json'), disk = await store.captureDisk(), document = JSON.parse(disk.abi);
  const request = await kernel.nativeSaveIdentity(project, { version: 2, requestId: 'pub2-' + randomUUID(), operation: 'project_save' });
  const { ref } = await operations.beginDocumentSave({ request, document, disk }, guard);
  document.pages[0].content.blocks.blocks[0].fields.VALUE = 140;
  const abi = JSON.stringify(document);
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), { document, generation,
    scope, baselineRef: kernel.absBaselineKey(generation), savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
  const evidence = await kernel.generationEvidence(projection, abi);
  const applications = new kernel.AbsApplicationJournal(port, project);
  await store.stage({ projection, mode: 'import', inputAbs: projection.abs, abi, expected: disk }, await kernel.hashAbsText(previous));
  await applications.stageNativeSave({ ref, evidence, inputAbiHash: await kernel.hashAbsText(disk.abi) }, guard);
  const result = await store.commit(generation, guard, async (text, expected, storage) => {
    assert.equal(await storage.replace('project.abi', expected, text), true);
  });
  assert.equal(result.status, 'COMMITTED');
  assert.ok(await applications.sealNativeSave(ref, guard));
  await operations.finish(ref.operationId, guard);
  return { ref, disk: await store.captureDisk() };
}

async function observeAdvancedWriter(ctx, saved) {
  const { requestId, operationId, executor } = ctx.original;
  const port = await openProjectSyncStorage(ctx.project, guard);
  const applications = new kernel.AbsApplicationJournal(port, ctx.project);
  const read = async () => (await applications.observe(requestId, guard, executor.hostPid)).result;
  const result = await read();
  assert.equal(result.publication.status, 'UNKNOWN');
  assert.equal(result.currentDocumentRecovery, undefined);
  assert.equal(result.publicationObservation, undefined);
  const proof = result.writerObservation;
  assert.equal(proof?.kind, 'indexed-application-retired');
  assert.equal(proof.operationId, operationId);
  assert.deepEqual(proof.executor, executor);
  assert.equal(proof.oldWriter.state, 'exited');
  assert.equal((await read()).writerObservation.settlement.recordHash, proof.settlement.recordHash);
  await assert.rejects(applications.observe(requestId, guard, process.pid), { code: 'ABS_APPLY_OBSERVATION_INVALID' });
  assert.equal(JSON.parse(await port.read('operation.json')).id, saved.ref.operationId);
  const current = await kernel.observeNativePublication(port, ctx.project, saved.ref.request, { originalTargetPid: saved.ref.executor.hostPid });
  assert.equal(current.result.publication.status, 'COMMITTED');
  assert.deepEqual(await new kernel.AbsBaselineStore(port, { projectKey: ctx.project, pageId: 'main' }).captureDisk(), saved.disk);
  return JSON.parse(await port.read(`recoveries/application-retired-${operationId}.json`));
}

test('an indexed original interrupted before the ABS pointer can retire after a newer save', async () => {
  const ctx = await fixture('index-before-pointer'); await ctx.stop();
  assert.equal(await kernel.recoverAbsProjectOperation(ctx.port, ctx.project, guard), null);
  const saved = await publishSuccessorSave(ctx.project, ctx.port, 'saved-after-original-index');
  const proof = await observeAdvancedWriter(ctx, saved);
  assert.equal(proof.reason, 'before-source-stage');
  assert.equal(proof.handoffHash, undefined);
  const { operationId, requestId, executor } = ctx.original;
  const folder = path.join(ctx.project, '.aily/abs-sync/recoveries');
  const stage = path.join(folder, `application-${operationId}.json`);
  fs.writeFileSync(stage, '{}', { flag: 'wx' });
  try {
    assert.equal(await ctx.journal.observeApplicationWriterSettlement(requestId, guard, executor.hostPid), null);
  } finally { fs.unlinkSync(stage); }
  const indexPath = path.join(folder, `request-${(await kernel.hashAbsText(requestId)).slice(7)}.json`);
  const indexed = fs.readFileSync(indexPath, 'utf8'), changedIndex = JSON.parse(indexed);
  delete changedIndex.sourceStageVersion;
  try {
    fs.writeFileSync(indexPath, JSON.stringify(changedIndex));
    await assert.rejects(ctx.journal.observeApplicationWriterSettlement(requestId, guard, executor.hostPid), { code: 'ABS_OPERATION_CONFLICT' });
  } finally { fs.writeFileSync(indexPath, indexed); }
});

test('an unmarked validated writer retires after the exact preimage was saved by its successor', async () => {
  const ctx = await fixture('legacy-index-before-pointer');
  const { operationId, requestId, executor } = ctx.original;
  const writerKey = `recoveries/application-writer-${(await kernel.hashAbsText(requestId)).slice(7)}.json`;
  const indexKey = `recoveries/request-${(await kernel.hashAbsText(requestId)).slice(7)}.json`;
  const snapshotKey = `recoveries/operation-${operationId}.json`;
  const writer = await ctx.port.read(writerKey), index = await ctx.port.read(indexKey), snapshot = await ctx.port.read(snapshotKey);
  assert.equal(JSON.parse(index).sourceStageVersion, undefined);
  assert.equal(JSON.parse(snapshot).sourceStageVersion, undefined);
  assert.equal(JSON.parse(index).snapshotHash, await kernel.hashAbsText(snapshot));
  const observer = await openProjectSyncStorage(ctx.project, guard, { timeoutMs: 100 });
  try {
    assert.equal((await observer.observeExecutor(executor)).state, 'active');
    await assert.rejects(new kernel.AbsOperationJournal(observer, ctx.project)
      .observeApplicationWriterSettlement(requestId, guard, executor.hostPid), { code: 'PROJECT_FILE_BUSY' });
  } finally { await ctx.stop(); }
  assert.equal(await kernel.recoverAbsProjectOperation(ctx.port, ctx.project, guard), null);
  const saved = await publishSuccessorSave(ctx.project, ctx.port, 'saved-after-unmarked-original');
  const successor = JSON.parse(await ctx.port.read(`recoveries/operation-${saved.ref.operationId}.json`));
  assert.deepEqual(successor.disk, JSON.parse(snapshot).disk);
  assert.equal(successor.committed, JSON.parse(snapshot).committed);
  const retired = await observeAdvancedWriter(ctx, saved);
  assert.equal(retired.reason, 'legacy-validated-writer');
  assert.equal(retired.legacyWriterHash, await kernel.hashAbsText(writer));
  assert.equal(retired.handoffHash, undefined);
  const result = (await new kernel.AbsApplicationJournal(ctx.port, ctx.project).observe(requestId, guard, executor.hostPid)).result;
  assert.deepEqual(result.applicationObservation, { version: 1, requestId, observationOnly: true, resultKnown: false, current: false });
  assert.equal(await ctx.port.read(indexKey), index);
  assert.equal(await ctx.port.read(snapshotKey), snapshot);
  assert.equal(await ctx.port.read(writerKey), writer);
});

test('an unmarked index rejects inconsistent source or a mismatched validated writer', async () => {
  const ctx = await fixture('legacy-index-before-pointer'); await ctx.stop();
  const { operationId, requestId, executor } = ctx.original;
  const retire = () => ctx.journal.observeApplicationWriterSettlement(requestId, guard, executor.hostPid);
  const testPath = name => path.join(ctx.project, '.aily/abs-sync', name);
  const writerPath = testPath(`recoveries/application-writer-${(await kernel.hashAbsText(requestId)).slice(7)}.json`);
  const writer = fs.readFileSync(writerPath);
  const changedWriter = { ...JSON.parse(writer), candidateHash: await kernel.hashAbsText('unrelated candidate') };
  try {
    fs.writeFileSync(writerPath, JSON.stringify(changedWriter));
    assert.equal(await retire(), null);
  } finally { fs.writeFileSync(writerPath, writer); }
  const stage = testPath(`recoveries/application-${operationId}.json`);
  const prepared = testPath('prepared.json');
  for (const file of [stage, prepared]) {
    try {
      fs.writeFileSync(file, '{}', { flag: 'wx' });
      assert.equal(await retire(), null);
    } finally { fs.unlinkSync(file); }
  }
  const abiPath = path.join(ctx.project, 'project.abi'), abi = fs.readFileSync(abiPath);
  try {
    fs.appendFileSync(abiPath, '\n');
    assert.equal(await retire(), null, 'External ABI changes do not supply a published preimage');
  } finally { fs.writeFileSync(abiPath, abi); }
  assert.equal(await ctx.port.read(`recoveries/application-retired-${operationId}.json`), null);
  assert.equal((await retire()).kind, 'indexed-application-retired', 'The verified unchanged source is an alternative to a successor save');
});

test('an unmarked index without a reservation retires only its exited writer and consumes the original request', async () => {
  const ctx = await fixture('legacy-index-without-writer');
  const { operationId, requestId, executor } = ctx.original;
  const requestHash = (await kernel.hashAbsText(requestId)).slice(7);
  const indexKey = `recoveries/request-${requestHash}.json`;
  const snapshotKey = `recoveries/operation-${operationId}.json`;
  const indexText = await ctx.port.read(indexKey), snapshotText = await ctx.port.read(snapshotKey);
  const snapshot = JSON.parse(snapshotText), writerKey = `recoveries/application-writer-${requestHash}.json`;
  assert.equal(await ctx.port.read(writerKey), null);
  assert.equal(JSON.parse(indexText).sourceStageVersion, undefined);
  assert.equal(snapshot.sourceStageVersion, undefined);
  assert.equal(JSON.parse(indexText).snapshotHash, await kernel.hashAbsText(snapshotText));
  const observer = await openProjectSyncStorage(ctx.project, guard, { timeoutMs: 100 });
  try {
    assert.equal((await observer.observeExecutor(executor)).state, 'active');
    await assert.rejects(new kernel.AbsOperationJournal(observer, ctx.project)
      .observeApplicationWriterSettlement(requestId, guard, executor.hostPid), { code: 'PROJECT_FILE_BUSY' });
  } finally { await ctx.stop(); }
  const uncertainPort = { ...ctx.port, observeExecutor: async () => ({ version: 1, state: 'unknown', reason: 'process-unavailable' }) };
  assert.equal(await new kernel.AbsOperationJournal(uncertainPort, ctx.project)
    .observeApplicationWriterSettlement(requestId, guard, executor.hostPid), null);

  const saved = await publishSuccessorSave(ctx.project, ctx.port, 'saved-after-unreserved-original');
  const retired = await observeAdvancedWriter(ctx, saved);
  assert.equal(retired.reason, 'legacy-index-exited-writer');
  assert.equal(retired.legacyWriterHash, undefined);
  assert.equal(retired.handoffHash, undefined);
  const original = { kind: snapshot.kind, document: snapshot.document, candidate: snapshot.candidate,
    application: snapshot.application, disk: saved.disk };
  const folder = path.join(ctx.project, '.aily/abs-sync/recoveries');
  const files = fs.readdirSync(folder);
  await assert.rejects(ctx.journal.begin(original, guard), { code: 'ABS_APPLY_REQUEST_ALREADY_RECORDED' });
  await assert.rejects(new kernel.OriginalRequestAdmissions(ctx.port, ctx.project)
    .reserveApplication(requestId, snapshot.candidate.hash, guard), { code: 'PROJECT_ADMISSION_RECEIPT_INVALID' });
  assert.deepEqual(fs.readdirSync(folder), files, 'Replay cannot create another snapshot');
  assert.equal(await ctx.port.read(indexKey), indexText);
  assert.equal(await ctx.port.read(snapshotKey), snapshotText);
  assert.equal(await ctx.port.read(writerKey), null);
  assert.equal(JSON.parse(await ctx.port.read('operation.json')).id, saved.ref.operationId);
  assert.deepEqual(await new kernel.AbsBaselineStore(ctx.port, { projectKey: ctx.project, pageId: 'main' }).captureDisk(), saved.disk);
});

test('a missing reservation does not let an unmarked index bypass contradictory source or ownership evidence', async () => {
  const ctx = await fixture('legacy-index-without-writer'); await ctx.stop();
  const { operationId, requestId, executor } = ctx.original;
  const retire = () => ctx.journal.observeApplicationWriterSettlement(requestId, guard, executor.hostPid);
  const testPath = name => path.join(ctx.project, '.aily/abs-sync', name);
  const requestHash = (await kernel.hashAbsText(requestId)).slice(7);
  const writerPath = testPath(`recoveries/application-writer-${requestHash}.json`);
  const snapshotText = await ctx.port.read(`recoveries/operation-${operationId}.json`);
  for (const key of [`recoveries/application-${operationId}.json`, 'prepared.json', `recoveries/application-commit-${operationId}.json`]) {
    const file = testPath(key);
    try {
      fs.writeFileSync(file, '{}', { flag: 'wx' });
      assert.equal(await retire(), null, key);
    } finally { fs.unlinkSync(file); }
  }
  const pointer = testPath('operation.json');
  try {
    fs.writeFileSync(pointer, JSON.stringify({ version: 1, id: operationId, hash: await kernel.hashAbsText(snapshotText), state: 'pending' }), { flag: 'wx' });
    assert.equal(await retire(), null);
  } finally { fs.unlinkSync(pointer); }
  try {
    fs.writeFileSync(writerPath, JSON.stringify({ version: 1, kind: 'validated-writer', project: ctx.project, requestId,
      attachment: ctx.port.attachment, executor, candidateHash: await kernel.hashAbsText('unrelated') }), { flag: 'wx' });
    assert.equal(await retire(), null, 'A mismatched writer is present, not missing');
    fs.writeFileSync(writerPath, '{}');
    await assert.rejects(retire());
  } finally { fs.unlinkSync(writerPath); }
  const abiPath = path.join(ctx.project, 'project.abi'), abi = fs.readFileSync(abiPath);
  try {
    fs.appendFileSync(abiPath, '\n');
    assert.equal(await retire(), null);
  } finally { fs.writeFileSync(abiPath, abi); }
  assert.equal(await ctx.port.read(`recoveries/application-retired-${operationId}.json`), null);
  assert.equal((await retire()).kind, 'indexed-application-retired');
});

test('a metadata repair interrupted again keeps the original ABS writer proof through a newer save', async () => {
  const ctx = await fixture('staged-before-abi'); await ctx.stop();
  const repair = await worker(ctx.project, 'recover-metadata-before-reanchor'); await repair.stop();
  const port = await openProjectSyncStorage(ctx.project, guard), operations = new kernel.AbsOperationJournal(port, ctx.project);
  const restored = await kernel.recoverAbsProjectOperation(port, ctx.project, guard);
  assert.equal(restored.operationId, ctx.original.operationId);
  assert.deepEqual(restored.document, ctx.original.document);
  assert.equal(JSON.parse(await port.read('operation.json')).sourceCommitted, repair.original.committed);
  await operations.restored(restored.operationId, guard);
  const before = await port.read('project.abi');
  const saved = await publishSuccessorSave(ctx.project, port, 'saved-after-metadata-recovery');
  assert.notEqual(saved.disk.abi, before);
  const proof = await observeAdvancedWriter(ctx, saved);
  const handoff = await port.read(`recoveries/operation-handoff-${ctx.original.operationId}.json`);
  assert.equal(proof.handoffHash, await kernel.hashAbsText(handoff));
  assert.equal(JSON.parse(handoff).metadataAnchor.committedHash, await kernel.hashAbsText(repair.original.committed));
  assert.ok(JSON.parse(await port.read(`recoveries/operation-${ctx.original.operationId}.json`)).candidate.source);
  const file = path.join(ctx.project, '.aily/abs-sync/recoveries', `operation-handoff-${ctx.original.operationId}.json`);
  const changed = JSON.parse(handoff);
  changed.metadataAnchor.mapHash = 'sha256:' + '0'.repeat(64);
  try {
    fs.writeFileSync(file, JSON.stringify(changed));
    await assert.rejects(operations.observeApplicationWriterSettlement(ctx.original.requestId, guard, ctx.original.executor.hostPid),
      { code: 'ABS_OPERATION_CONFLICT' });
  } finally { fs.writeFileSync(file, handoff); }
});

after(async () => { for (const child of children) child.kill('SIGKILL'); console.log('R1_RESTORED_OUTPUT=' + root); });
