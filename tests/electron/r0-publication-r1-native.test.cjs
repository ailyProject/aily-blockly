const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { buildSync } = require('esbuild');
const { before, after, test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'tests/test-results', `r0-publication-r1-native-${Date.now()}`), bundle = path.join(root, 'kernel.cjs');
let kernel;
const children = new Set();
const guard = () => {};
before(() => {
  fs.mkdirSync(root, { recursive: true });
  buildSync({ absWorkingDir: repo, entryPoints: ['tests/electron/fixtures/r0-publication-kernel.ts'], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
  kernel = require(bundle);
});
async function worker(mode, project) {
  const child = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), [mode, project, bundle],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child); let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const closed = new Promise(resolve => child.once('exit', code => { children.delete(child); resolve(code); }));
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('R1 fixture timed out: ' + stderr)), 15000);
      child.once('message', value => { clearTimeout(timer); value.event === 'failure'
        ? reject(Object.assign(new Error(value.error.message), value.error)) : resolve(value.result); });
      child.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('R1 child failed: ' + stderr)); });
    });
    assert.equal(await closed, 0); return result;
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
}
async function fixture(operation = 'project_save') {
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  await worker('fixture', project);
  const input = JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8'));
  const port = await openProjectSyncStorage(project, guard), scope = { projectKey: project, pageId: 'main' };
  const store = new kernel.AbsBaselineStore(port, scope), journal = new kernel.AbsOperationJournal(port, project);
  const application = new kernel.AbsApplicationJournal(port, project);
  const request = { version: 2, requestId: 'pub2-' + randomUUID(), operation,
    inputDigest: await kernel.hashAbsText(kernel.absJson({ project, operation })) };
  fs.writeFileSync(path.join(project, 'r0-native-request.json'), JSON.stringify(request));
  return { project, input, port, store, journal, application, request };
}
async function admit(ctx) {
  return (await ctx.journal.beginDocumentSave({ request: ctx.request, document: ctx.input.baseProjection.document,
    disk: ctx.input.next.expected }, guard)).ref;
}
async function publish(ctx, { complete = true, seal = true } = {}) {
  const ref = await admit(ctx), { input, store, application } = ctx;
  await store.stage(input.next, input.expectedPointerHash);
  const evidence = await kernel.generationEvidence(input.next.projection, input.next.abi);
  await application.stageNativeSave({ ref, evidence, inputAbiHash: await kernel.hashAbsText(input.next.expected.abi) }, guard);
  const publication = await store.commit('r0-next', guard, async (text, expected, access) => {
    assert.equal(await access.replace('project.abi', expected, text), true);
  });
  assert.equal(publication.status, 'COMMITTED');
  if (seal) assert.equal(await application.sealNativeSave(ref, guard), true);
  const facts = { projectSaved: true, generatedCodePublished: true, partial: false, publication,
    evidence, requiresReload: false, warnings: [], derivedOutputs: { published: true } };
  if (complete) await application.completeNativeSave(ref, facts, guard);
  if (seal) await ctx.journal.finish(ref.operationId, guard);
  return { ref, facts };
}

async function withUnreadableFile(filename, inspect) {
  const before = fs.readFileSync(filename), unreadable = Buffer.from([0xff, 0xfe, 0xc0, 0xaf]);
  fs.writeFileSync(filename, unreadable);
  try {
    await inspect();
    assert.deepEqual(fs.readFileSync(filename), unreadable, 'Observation cannot write the current files.');
  } finally { fs.writeFileSync(filename, before); }
}

function readOnlyPort(ctx) {
  return { ...ctx.port, withLock() { assert.fail('Observation should not claim a write lease.'); } };
}

async function applicationInput(ctx, requestId, port = ctx.port) {
  const { input, project } = ctx;
  const source = input.next.inputAbs;
  const hash = await kernel.hashAbsText(source);
  const validation = { version: 2, requestId,
    base: (await kernel.generationEvidence(input.baseProjection, input.next.expected.abi)).binding,
    candidate: { hash, bytes: Buffer.byteLength(source) },
    workspaceRevision: 1, workingCandidate: { version: 1, id: randomUUID(), revisionHash: '4'.repeat(64) },
    libraryRuntimeFingerprint: '5'.repeat(64), validation: { ok: true, scope: 'prepared-generation' } };
  await new kernel.OriginalRequestAdmissions(port, project).reserveApplication(requestId, hash, guard);
  return { kind: 'abs-apply', document: input.baseProjection.document, disk: input.next.expected,
    candidate: { source, generation: input.baseProjection.map.generation, hash }, application: { requestId, validation } };
}

async function publishApplication(ctx, { seal = true } = {}) {
  const input = await applicationInput(ctx, ctx.request.requestId);
  const id = await ctx.journal.begin(input, guard);
  await ctx.store.stage(ctx.input.next, ctx.input.expectedPointerHash);
  const outcome = { publication: { status: 'COMMITTED', generation: 'r0-next', abiSaved: true, absMirrored: true, mapPublished: true },
    requiresReload: false, evidence: await kernel.generationEvidence(ctx.input.next.projection, ctx.input.next.abi),
    appliedRevision: 1, warnings: [], derivedOutputs: { published: true } };
  await ctx.application.stage(id, input.application.validation, outcome, guard);
  assert.equal((await ctx.store.commit('r0-next', guard, async (text, expected, storage) =>
    assert.equal(await storage.replace('project.abi', expected, text), true))).status, 'COMMITTED');
  if (seal) {
    assert.equal(await ctx.application.seal(id, guard), true);
    await ctx.application.complete(id, outcome, guard);
    await ctx.journal.finish(id, guard);
  }
  return { id, outcome };
}

test('ABS apply observes its sealed original result through unreadable current ABS or map', async () => {
  const ctx = await fixture('abs_apply'), { id, outcome } = await publishApplication(ctx);
  const observer = new kernel.AbsApplicationJournal(readOnlyPort(ctx), ctx.project);
  const pid = ctx.port.executor.hostPid, requestId = ctx.request.requestId;
  assert.equal((await observer.observe(requestId, guard)).result.applicationObservation.current, true);
  const document = structuredClone(ctx.input.next.projection.document);
  document.pages[0].content.blocks.blocks[0].fields.VALUE = 103;
  const generation = 'later-save', abi = JSON.stringify(document, null, 2);
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), { document, generation,
    baselineRef: kernel.absBaselineKey(generation), scope: { projectKey: ctx.project, pageId: 'main' },
    savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
  await ctx.store.stage({ mode: 'import', inputAbs: projection.abs, projection, abi, expected: await ctx.store.captureDisk() });
  assert.equal((await ctx.store.commit(generation, guard, async (text, expected, storage) =>
    assert.equal(await storage.replace('project.abi', expected, text), true))).status, 'COMMITTED');
  assert.equal((await observer.observe(requestId, guard)).result.applicationObservation.current, false);
  for (const mirror of ['project.abs', 'project.abs.map.json']) {
    await withUnreadableFile(path.join(ctx.project, mirror), async () => {
      const observed = (await observer.observe(requestId, guard, pid)).result;
      assert.deepEqual(observed.publication, outcome.publication);
      assert.deepEqual(observed.evidence, outcome.evidence);
      assert.deepEqual(observed.applicationObservation, { version: 1, requestId, observationOnly: true, resultKnown: true, current: false });
      assert.equal(observed.publicationObservation.operationId, id);
      await assert.rejects(observer.observe(requestId, guard, pid + 1), { code: 'ABS_APPLY_OBSERVATION_INVALID' });
      for (const record of ['commit', 'result']) {
        await withUnreadableFile(path.join(ctx.project, '.aily/abs-sync/recoveries', `application-${record}-${id}.json`),
          () => assert.rejects(observer.observe(requestId, guard, pid), { code: 'ABS_STORAGE_ENCODING_INVALID' }));
      }
    });
  }
  await withUnreadableFile(path.join(ctx.project, 'project.abs'), () =>
    withUnreadableFile(path.join(ctx.project, 'project.abi'), () =>
      assert.rejects(observer.observe(requestId, guard, pid), { code: 'ABS_STORAGE_ENCODING_INVALID' })));
  assert.equal((await ctx.store.captureDisk()).abi, abi);
});

test('unreadable current ABS cannot promote an unsealed ABS application', async () => {
  const ctx = await fixture('abs_apply');
  await publishApplication(ctx, { seal: false });
  await withUnreadableFile(path.join(ctx.project, 'project.abs'), () =>
    assert.rejects(new kernel.AbsApplicationJournal(readOnlyPort(ctx), ctx.project)
      .observe(ctx.request.requestId, guard, ctx.port.executor.hostPid), { code: 'ABS_STORAGE_ENCODING_INVALID' }));
});

for (const phase of ['snapshot', 'index', 'pointer']) {
  test(`lost ABS ${phase} acknowledgement only settles the exact request before the pending pointer`, async () => {
    const ctx = await fixture('abs_apply'), { port, project } = ctx;
    const requestId = ctx.request.requestId, pid = port.executor.hostPid;
    const input = await applicationInput(ctx, requestId);
    const disk = await ctx.store.captureDisk(), oldPointer = await port.read('operation.json');
    let lost = false;
    const faulting = { ...port, withLock: callback => port.withLock(storage => callback({ ...storage,
      replace: async (key, expected, text) => {
        const replaced = await storage.replace(key, expected, text);
        const targeted = phase === 'snapshot' ? key.startsWith('recoveries/operation-')
          : phase === 'index' ? key.startsWith('recoveries/request-') : key === 'operation.json';
        if (targeted && replaced && !lost) {
          lost = true;
          throw Object.assign(Error('Lost original ABS journal acknowledgement'), { code: 'ABS_COMMIT_UNCERTAIN' });
        }
        return replaced;
      } })) };
    await assert.rejects(new kernel.AbsOperationJournal(faulting, project).begin(input, guard), { code: 'ABS_COMMIT_UNCERTAIN' });
    assert.equal(lost, true);
    assert.deepEqual(await ctx.store.captureDisk(), disk);
    const observation = (await ctx.application.observe(requestId, guard, pid)).result;
    if (phase === 'pointer') {
      assert.equal(observation.publication.status, 'UNKNOWN');
      assert.equal(observation.applicationObservation.resultKnown, false);
      assert.notEqual(await port.read('operation.json'), oldPointer);
      return;
    }
    assert.equal(await port.read('operation.json'), oldPointer);
    assert.deepEqual(observation.admission, { status: 'NOT_STARTED', requestId });
    assert.equal(observation.publication.status, 'NOT_COMMITTED');
    await assert.rejects(ctx.application.observe(requestId, guard, pid + 1), { code: 'ABS_APPLY_OBSERVATION_INVALID' });
    await assert.rejects(ctx.journal.begin(input, guard), { code: 'ABS_APPLY_REQUEST_ALREADY_RECORDED' });
    const newer = await applicationInput(ctx, randomUUID());
    const newerId = await ctx.journal.begin(newer, guard);
    const newerPointer = await port.read('operation.json');
    assert.equal(JSON.parse(newerPointer).id, newerId);
    assert.deepEqual((await ctx.application.observe(requestId, guard, pid)).result, observation);
    assert.equal(await port.read('operation.json'), newerPointer);
  });
}

for (const operation of ['project_save', 'history_restore']) {
  test(`${operation} observes the sealed original result through unreadable current ABS or map`, async () => {
    const ctx = await fixture(operation), published = await publish(ctx);
    const port = readOnlyPort(ctx), observer = new kernel.AbsApplicationJournal(port, ctx.project);
    for (const mirror of ['project.abs', 'project.abs.map.json']) {
      await withUnreadableFile(path.join(ctx.project, mirror), async () => {
        const observed = await observer.observeNativeSave(ctx.request, guard);
        assert.deepEqual(observed, { state: 'completed', ref: published.ref, result: published.facts, current: false });
        const status = await kernel.observeNativePublication(port, ctx.project, ctx.request,
          { originalTargetPid: (published.ref.executor.hostPid ?? process.pid) + 1 });
        assert.equal(status.code, 'PROJECT_SAVE_EXECUTOR_MISMATCH');
        assert.equal(status.saveReceipt.state, 'unknown');
        assert.equal(status.result, undefined);
        await assert.rejects(observer.observeNativeSave({ ...ctx.request, inputDigest: 'sha256:' + 'f'.repeat(64) }, guard),
          { code: 'ABS_NATIVE_SAVE_REQUEST_CONFLICT' });
        const proof = path.join(ctx.project, '.aily/abs-sync/recoveries', `application-commit-${published.ref.operationId}.json`);
        await withUnreadableFile(proof, () => assert.rejects(observer.observeNativeSave(ctx.request, guard),
          { code: 'ABS_STORAGE_ENCODING_INVALID' }));
      });
    }
    // An unreadable mirror cannot cancel an independent concurrent rejection.
    await withUnreadableFile(path.join(ctx.project, 'project.abs'), () =>
      withUnreadableFile(path.join(ctx.project, 'project.abi'), () =>
        assert.rejects(observer.observeNativeSave(ctx.request, guard), { code: 'ABS_STORAGE_ENCODING_INVALID' })));
  });
}

test('unreadable current ABS cannot promote a staged and unsealed result', async () => {
  const ctx = await fixture(), { ref } = await publish(ctx, { complete: false, seal: false });
  await withUnreadableFile(path.join(ctx.project, 'project.abs'), async () => {
    const observed = await new kernel.AbsApplicationJournal(readOnlyPort(ctx), ctx.project).observeNativeSave(ctx.request, guard);
    assert.equal(observed.state, 'unknown');
    assert.equal(observed.publication.status, 'UNKNOWN');
    assert.deepEqual(observed.ref, ref);
    assert.equal(observed.result, undefined);
  });
});

test('an unreadable later prepared generation does not invalidate the sealed History result', async () => {
  const ctx = await fixture('history_restore'), published = await publish(ctx);
  const observer = new kernel.AbsApplicationJournal(readOnlyPort(ctx), ctx.project);
  const document = structuredClone(ctx.input.next.projection.document), generation = 'later-prepared';
  document.pages[0].content.blocks.blocks[0].fields.VALUE = 103;
  const abi = JSON.stringify(document, null, 2);
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), { document, generation,
    baselineRef: kernel.absBaselineKey(generation), scope: { projectKey: ctx.project, pageId: 'main' },
    savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
  await ctx.store.stage({ mode: 'import', inputAbs: projection.abs, projection, abi, expected: await ctx.store.captureDisk() });
  const admitted = Promise.withResolvers(), advance = Promise.withResolvers();
  const writing = ctx.store.commit(generation, guard, async (text, expected, access) => {
    admitted.resolve(); await advance.promise;
    assert.equal(await access.replace('project.abi', expected, text), true);
  });
  try {
    await Promise.race([admitted.promise, writing]);
    await withUnreadableFile(path.join(ctx.project, '.aily/abs-sync/prepared.json'), async () => {
      assert.deepEqual(await observer.observeNativeSave(ctx.request, guard),
        { state: 'completed', ref: published.ref, result: published.facts, current: false });
    });
  } finally { advance.resolve(); await writing; }
  assert.equal((await writing).status, 'COMMITTED');
  assert.equal((await ctx.store.captureDisk()).abi, abi);
});

test('native admission reuses original S1/request/page and rejects a changed digest or legacy ID', async () => {
  const ctx = await fixture(), first = await admit(ctx);
  const second = await ctx.journal.beginDocumentSave({ request: ctx.request,
    document: { current: 'S2 must not replace original S1' }, disk: { abi: 'later', abs: null, map: null } }, guard);
  assert.equal(second.created, false); assert.deepEqual(second.ref, first);
  assert.deepEqual((await ctx.journal.inspect()).document, ctx.input.baseProjection.document);
  await assert.rejects(ctx.journal.findDocumentSave({ ...ctx.request, inputDigest: 'sha256:' + '0'.repeat(64) }, guard),
    { code: 'ABS_NATIVE_SAVE_REQUEST_CONFLICT' });
  await assert.rejects(ctx.application.observeNativeSave({ ...ctx.request, version: 1, requestId: 'legacy-id' }, guard),
    { code: 'ABS_NATIVE_SAVE_REQUEST_INVALID' });
});

test('a different process reads original native COMMITTED/evidence/executor without re-saving', async () => {
  const ctx = await fixture(), published = await publish(ctx);
  const before = await ctx.store.captureDisk(), observed = await worker('native-v2-observe', ctx.project);
  assert.equal(observed.state, 'completed'); assert.deepEqual(observed.ref, published.ref);
  assert.equal(observed.ref.executor.storagePid, process.pid);
  assert.equal(observed.current, true); assert.deepEqual(observed.result, published.facts);
  assert.deepEqual(await ctx.store.captureDisk(), before);
});

test('commit/reply gap derives only the original changed generation and reports post-effects pending', async () => {
  const ctx = await fixture(), { ref } = await publish(ctx, { seal: false, complete: false });
  const observed = await worker('native-v2-observe', ctx.project);
  assert.equal(observed.state, 'completed'); assert.deepEqual(observed.ref, ref);
  assert.equal(observed.result.publication.status, 'COMMITTED'); assert.equal(observed.result.partial, true);
  assert.equal(observed.result.generatedCodePublished, false);
  assert.equal(observed.result.derivedOutputs.published, false);
  assert.equal(await ctx.port.read(`recoveries/application-commit-${ref.operationId}.json`), null,
    'Read-only observation must not append a fake seal.');
});

test('unchanged save needs its original under-lock proof, preserves generation and survives operation retirement', async () => {
  const ctx = await fixture(), ref = await admit(ctx);
  const evidence = await kernel.generationEvidence(ctx.input.baseProjection, ctx.input.next.expected.abi);
  await ctx.application.stageNativeSave({ ref, evidence, inputAbiHash: await kernel.hashAbsText(ctx.input.next.expected.abi) }, guard);
  assert.equal(await ctx.application.sealNativeSave(ref, guard), false, 'Pre-existing head is not a new save commit.');
  assert.equal((await ctx.application.observeNativeSave(ctx.request, guard)).state, 'unknown');
  await ctx.journal.finishUnchangedSave(ref.operationId, ctx.input.next.expected, guard,
    (access, original, pointer) => ctx.application.sealNativeUnchangedLocked(ref, access, original, pointer, guard));
  const observed = await worker('native-v2-observe', ctx.project);
  assert.equal(observed.state, 'completed'); assert.equal(observed.result.publication.generation, 'r0-base');
  assert.equal(observed.result.publication.abiSaved, false, 'No-op must not pretend it wrote ABI.');
  const other = { ...ctx.request, requestId: 'pub2-' + randomUUID() };
  await ctx.journal.beginDocumentSave({ request: other, document: ctx.input.baseProjection.document, disk: ctx.input.next.expected }, guard);
  assert.equal((await ctx.application.observeNativeSave(ctx.request, guard)).state, 'completed');
});

test('explicit pre-commit cancellation is a durable NOT_COMMITTED terminal, not a new admission', async () => {
  const ctx = await fixture(), ref = await admit(ctx);
  const facts = { projectSaved: false, generatedCodePublished: false, partial: false,
    publication: { status: 'NOT_COMMITTED' }, requiresReload: false, code: 'ABS_OPERATION_CANCELLED', cancelled: true };
  await ctx.application.completeNativeSave(ref, facts, guard);
  await ctx.journal.restored(ref.operationId, guard);
  const observed = await worker('native-v2-observe', ctx.project);
  assert.equal(observed.state, 'completed'); assert.deepEqual(observed.result, facts);
  assert.equal((await ctx.journal.beginDocumentSave({ request: ctx.request, document: {}, disk: ctx.input.next.expected }, guard)).created, false);
});

test('an ABI-written operation cannot be falsely sealed as cancelled or NOT_COMMITTED', async () => {
  const ctx = await fixture(), ref = await admit(ctx);
  await ctx.port.withLock(async access => assert.equal(await access.replace('project.abi',
    await kernel.hashAbsText(ctx.input.next.expected.abi), ctx.input.next.abi), true));
  await assert.rejects(ctx.application.completeNativeSave(ref, { projectSaved: false, generatedCodePublished: false,
    partial: false, publication: { status: 'NOT_COMMITTED' }, requiresReload: false, code: 'ABS_OPERATION_CANCELLED', cancelled: true }, guard));
  assert.equal((await ctx.application.observeNativeSave(ctx.request, guard)).state, 'pending');
});

test('copying identical records back into the same path cannot adopt an old physical attachment result', async () => {
  const ctx = await fixture(); await publish(ctx);
  const archived = ctx.project + '-original';
  fs.renameSync(ctx.project, archived); fs.cpSync(archived, ctx.project, { recursive: true });
  const copied = await openProjectSyncStorage(ctx.project, guard);
  await assert.rejects(new kernel.AbsApplicationJournal(copied, ctx.project).observeNativeSave(ctx.request, guard),
    { code: 'ABS_NATIVE_SAVE_ATTACHMENT_CHANGED' });
  await assert.rejects(new kernel.AbsOperationJournal(copied, ctx.project).findDocumentSave(ctx.request, guard),
    { code: 'ABS_NATIVE_SAVE_ATTACHMENT_CHANGED' });
});

test('existing source proof is revalidated rather than trusted on existence', async () => {
  const ctx = await fixture(), { ref } = await publish(ctx);
  const filename = path.join(ctx.project, '.aily/abs-sync', `recoveries/application-commit-${ref.operationId}.json`);
  const proof = JSON.parse(fs.readFileSync(filename, 'utf8')); proof.ref.executor.hostPid++;
  fs.writeFileSync(filename, JSON.stringify(proof));
  await assert.rejects(ctx.application.sealNativeSave(ref, guard));
  await assert.rejects(ctx.application.observeNativeSave(ctx.request, guard));
});

test('hard kill before unchanged proof cannot promote a pre-existing head into this request completion', async () => {
  const ctx = await fixture();
  const child = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), ['native-v2-unchanged-paused', ctx.project, bundle],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  const closed = new Promise(resolve => child.once('exit', () => { children.delete(child); resolve(); }));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Unchanged worker did not pause')), 15000);
      child.once('message', value => { clearTimeout(timer); value.event === 'paused'
        ? resolve() : reject(new Error(value.error?.message ?? 'Unexpected worker response')); });
    });
    child.kill('SIGKILL'); await closed;
    const ref = await ctx.journal.findDocumentSave(ctx.request, guard);
    assert.equal(await ctx.application.sealNativeSave(ref, guard), false);
    const observed = await worker('native-v2-observe', ctx.project);
    assert.equal(observed.state, 'unknown'); assert.equal(observed.publication.status, 'UNKNOWN');
    assert.equal(await ctx.port.read(`recoveries/application-commit-${ref.operationId}.json`), null);
    assert.equal(await ctx.port.read('committed.json'), ctx.input.expectedPointer);
    assert.deepEqual(await ctx.store.captureDisk(), ctx.input.next.expected);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; } }
});

test('a later legitimate head keeps the original native result historical rather than adopting new output', async () => {
  const ctx = await fixture(), published = await publish(ctx);
  const document = structuredClone(ctx.input.next.projection.document);
  document.pages[0].content.blocks.blocks[0].fields.VALUE = 102;
  const abi = JSON.stringify(document, null, 2);
  const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), { document,
    generation: 'r1-later', baselineRef: kernel.absBaselineKey('r1-later'), scope: { projectKey: ctx.project, pageId: 'main' },
    savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
  await ctx.store.stage({ mode: 'import', inputAbs: projection.abs, projection, abi, expected: await ctx.store.captureDisk() });
  assert.equal((await ctx.store.commit('r1-later', guard, async (text, expected, access) => {
    assert.equal(await access.replace('project.abi', expected, text), true);
  })).status, 'COMMITTED');
  const observed = await worker('native-v2-observe', ctx.project);
  assert.equal(observed.state, 'completed'); assert.equal(observed.current, false);
  assert.deepEqual(observed.result, published.facts);
  assert.equal(observed.result.evidence.binding.generation, 'r0-next');
});

test('a malformed planned stage is rejected before poisoning its immutable record', async () => {
  const ctx = await fixture(), ref = await admit(ctx);
  const evidence = await kernel.generationEvidence(ctx.input.next.projection, ctx.input.next.abi);
  await assert.rejects(ctx.application.stageNativeSave({ ref, evidence, inputAbiHash: 'sha256:' + '0'.repeat(64) }, guard));
  assert.equal(await ctx.port.read(`recoveries/application-${ref.operationId}.json`), null);
  await ctx.application.stageNativeSave({ ref, evidence, inputAbiHash: await kernel.hashAbsText(ctx.input.next.expected.abi) }, guard);
  assert.notEqual(await ctx.port.read(`recoveries/application-${ref.operationId}.json`), null);
});

for (const field of ['partial', 'generatedCodePublished']) {
  test(`damaged native post-effect ${field} cannot be promoted to overall completed facts`, async () => {
    const ctx = await fixture(), { ref } = await publish(ctx);
    const filename = path.join(ctx.project, '.aily/abs-sync', `recoveries/application-result-${ref.operationId}.json`);
    const final = JSON.parse(fs.readFileSync(filename, 'utf8'));
    delete final.result[field];
    fs.writeFileSync(filename, JSON.stringify(final));
    await assert.rejects(ctx.application.observeNativeSave(ctx.request, guard),
      { code: 'ABS_NATIVE_SAVE_OBSERVATION_INVALID' });
    assert.equal(JSON.parse(await ctx.port.read('committed.json')).generation, 'r0-next',
      'Invalid post-effect metadata does not roll back the committed source.');
  });
}

after(async () => {
  for (const child of children) child.kill('SIGKILL');
  assert.equal(children.size, 0);
  console.log(`R1_NATIVE_OUTPUT=${root}`);
});
