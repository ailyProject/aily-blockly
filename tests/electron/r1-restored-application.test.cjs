const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
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
async function fixture(legacy = false) {
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  await new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), ['fixture', project, bundle],
      { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Fixture failed ' + code)));
  });
  const child = fork(path.join(__dirname, 'fixtures/r1-restored-application-worker.cjs'), [project, bundle, legacy === true ? 'legacy' : legacy || ''],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.add(child);
  const closed = new Promise(resolve => child.once('exit', () => { children.delete(child); resolve(); }));
  const original = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Original worker failed to prepare')), 15000);
    child.once('message', value => { clearTimeout(timer); value.event === 'ready' ? resolve(value) : reject(Error(value.message)); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Original worker exited before ready')); });
  });
  const port = await openProjectSyncStorage(project, guard), journal = new kernel.AbsOperationJournal(port, project);
  return { project, original, port, journal, child, closed, stop: async () => { child.kill('SIGKILL'); await closed; } };
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

after(async () => { for (const child of children) child.kill('SIGKILL'); console.log('R1_RESTORED_OUTPUT=' + root); });
