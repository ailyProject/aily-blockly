const fs = require('node:fs');
const path = require('node:path');
const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const [mode, project, kernelFile, point = ''] = process.argv.slice(2);
const kernel = require(kernelFile);
const guard = () => {};
const scope = { projectKey: project, pageId: 'main' };
const send = value => process.send?.(value);
const pause = async label => {
  send({ event: 'paused', label, pid: process.pid });
  await new Promise(resolve => process.once('message', message => {
    if (message?.action !== 'continue') throw new Error('Expected explicit test continuation.');
    resolve();
  }));
};
const readFixture = () => JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8'));
const open = () => openProjectSyncStorage(project, guard, { timeoutMs: 100 });

async function fixture() {
  const port = await open(), store = new kernel.AbsBaselineStore(port, scope);
  const document = value => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main', 'other'],
    pages: [{ id: 'main', title: 'main', content: { blocks: { languageVersion: 0, blocks: [
      { type: 'root', id: 'retained-root', fields: { VALUE: value }, collapsed: true,
        data: 'opaque-keep', icons: { comment: { text: 'keep-comment', pinned: true } } },
    ] } } }, { id: 'other', title: 'untouched', content: { blocks: { languageVersion: 0, blocks: [] } }, custom: { retained: true } }],
    sharedModel: { procedureBlocks: [], variables: [{ id: 'model-1', name: 'stable', type: '' }] },
    extension: { retained: [1, 2, 3] } });
  const input = async (generation, value) => {
    const doc = document(value), abi = JSON.stringify(doc, null, 2);
    const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(doc, 'main'), { document: doc,
      generation, baselineRef: kernel.absBaselineKey(generation), scope,
      savedAbiHash: await kernel.hashAbsText(kernel.absJson(doc)) });
    return { projection, mode: 'import', inputAbs: projection.abs, abi, expected: await store.captureDisk() };
  };
  const base = await input('r0-base', 100);
  await store.stage(base);
  const publication = await store.commit('r0-base', guard, async (text, expected, access) => {
    if (!await access.replace('project.abi', expected, text)) throw new Error('Fixture ABI CAS failed.');
  });
  if (publication.status !== 'COMMITTED') throw new Error('Fixture base did not commit.');
  const next = await input('r0-next', 101);
  const expectedPointer = await port.read('committed.json');
  const inputRecord = { next, baseProjection: base.projection, expectedPointer,
    expectedPointerHash: await kernel.hashAbsText(expectedPointer), requestId: 'r0-original-apply', nativeId: 'r0-original-native-save' };
  fs.writeFileSync(path.join(project, 'r0-input.json'), JSON.stringify(inputRecord, null, 2));
  return { publication, generation: base.projection.map.generation };
}

async function publish() {
  const fixture = readFixture(), port = await open();
  const store = new kernel.AbsBaselineStore(port, scope);
  const journal = new kernel.AbsOperationJournal(port, project);
  const application = new kernel.AbsApplicationJournal(port, project);
  const validation = { version: 2, requestId: fixture.requestId, base: (await kernel.generationEvidence(
    fixture.baseProjection, fixture.next.expected.abi)).binding,
    candidate: { hash: await kernel.hashAbsText(fixture.next.inputAbs), bytes: Buffer.byteLength(fixture.next.inputAbs) }, workspaceRevision: 1 };
  const operationId = await journal.begin({ kind: 'abs-apply', document: fixture.baseProjection.document,
    disk: fixture.next.expected, candidate: { source: fixture.next.inputAbs,
      generation: fixture.baseProjection.map.generation, hash: validation.candidate.hash },
    application: { requestId: fixture.requestId, validation } }, guard);
  await store.stage(fixture.next, fixture.expectedPointerHash);
  const outcome = { publication: { status: 'COMMITTED', generation: 'r0-next', abiSaved: true, absMirrored: true, mapPublished: true },
    requiresReload: false, evidence: await kernel.generationEvidence(fixture.next.projection, fixture.next.abi),
    appliedRevision: 1, warnings: [], derivedOutputs: { published: false, code: 'PROJECT_DERIVED_OUTPUT_PENDING' } };
  await application.stage(operationId, validation, outcome, guard);
  fs.writeFileSync(path.join(project, 'r0-operation.json'), JSON.stringify({ operationId, requestId: fixture.requestId }));
  const wrapped = { read: key => port.read(key), withLock: action => port.withLock(access => action({
    read: key => access.read(key), replace: async (key, expected, content) => {
      const result = await access.replace(key, expected, content);
      if (result && key === point && content !== null) {
        if (mode === 'throw') throw Object.assign(new Error('R0 exact persisted boundary'), { code: 'R0_INJECTED_AFTER_WRITE' });
        await pause(key);
      }
      return result;
    },
  })) };
  const writer = new kernel.AbsBaselineStore(wrapped, scope);
  const publication = await writer.commit('r0-next', guard, async (text, expected, access) => {
    if (!await access.replace('project.abi', expected, text)) throw new Error('Original ABI CAS failed.');
  });
  if (mode === 'throw') return { publication, operationId };
  if (point === 'reply-loss') await pause('reply-loss'); // Commit has released the real file lock; no result was returned.
  return { publication, operationId };
}

async function inspect() {
  const fixture = readFixture(), port = await open(), store = new kernel.AbsBaselineStore(port, scope);
  const application = new kernel.AbsApplicationJournal(port, project);
  const before = await store.captureDisk(), pointer = await port.read('committed.json');
  const committed = await store.inspectCommitted();
  const observation = await application.observe(fixture.requestId, guard);
  let recovery;
  try {
    const offered = await store.inspectJournalRecovery();
    if (offered?.action === 'abandon') { await store.abandon(offered.generation, offered.token); recovery = { action: 'abandon' }; }
    else recovery = { action: 'recover', result: await store.recover(guard, offered || undefined) };
  } catch (error) { recovery = { code: error.code, message: error.message }; }
  return { before, pointer, committed, observation, recovery, after: await store.captureDisk(),
    afterPointer: await port.read('committed.json'), prepared: await port.read('prepared.json'),
    afterObservation: await application.observe(fixture.requestId, guard),
    lockPresent: fs.existsSync(path.join(project, '.aily/project-files.write.lock')) };
}

async function native() {
  const fixture = readFixture(), registry = new kernel.ProjectSaveReceipts();
  const request = { version: 1, requestId: fixture.nativeId, operation: 'project_save', waitMs: 0 };
  if (mode === 'native-observe') {
    const observed = await registry.status(project, request);
    let reentered = 0;
    await registry.execute(project, request, ['fresh-runtime'], async () => { reentered++; return { projectSaved: true }; });
    return { observed, reentered, interpretation: 'Callback re-admission only; no second native save was executed by this probe.' };
  }
  const result = await registry.execute(project, request, ['original-runtime'], async () => {
    const port = await open(), store = new kernel.AbsBaselineStore(port, scope);
    await store.stage(fixture.next, fixture.expectedPointerHash);
    const publication = await store.commit('r0-next', guard, async (text, expected, access) => {
      if (!await access.replace('project.abi', expected, text)) throw new Error('Native ABI CAS failed.');
    });
    if (publication.status !== 'COMMITTED') throw new Error('Native fixture did not commit.');
    return { projectSaved: true, generatedCodePublished: false, partial: true };
  });
  send({ event: 'native-completed', result });
  await pause('native-reply-loss');
  return result;
}

async function dirtyJournal() {
  const fixture = readFixture(), port = await open(), journal = new kernel.AbsOperationJournal(port, project);
  // The production apply caller passes materialized before.document, not the
  // candidate's older baseline. This probe checks that exact durable boundary;
  // it does not pretend to capture a real GUI in this Node process.
  const working = structuredClone(fixture.baseProjection.document);
  working.pages[1].title = 'unsaved real-working S1';
  working.extension.actualUnsavedWorking = { keep: true };
  const validation = { version: 2, requestId: fixture.requestId, base: { generation: 'r0-base' },
    candidate: { hash: await kernel.hashAbsText(fixture.next.inputAbs) } };
  const operationId = await journal.begin({ kind: 'abs-apply', document: working,
    disk: fixture.next.expected, candidate: { source: fixture.next.inputAbs, generation: 'r0-base', hash: validation.candidate.hash },
    application: { requestId: fixture.requestId, validation } }, guard);
  const reopened = new kernel.AbsOperationJournal(await open(), project);
  return { operationId, working, retained: await reopened.inspect(), disk: await new kernel.AbsBaselineStore(port, scope).captureDisk(),
    prepared: await port.read('prepared.json'), pointer: await port.read('committed.json') };
}

(async () => {
  let result;
  if (mode === 'fixture') result = await fixture();
  else if (mode === 'dirty-journal') result = await dirtyJournal();
  else if (mode === 'native-v2-observe') {
    const request = JSON.parse(fs.readFileSync(path.join(project, 'r0-native-request.json'), 'utf8'));
    result = await new kernel.AbsApplicationJournal(await open(), project).observeNativeSave(request, guard);
  }
  else if (mode === 'native-v2-unchanged-paused') {
    const fixture = readFixture(), port = await open();
    const request = JSON.parse(fs.readFileSync(path.join(project, 'r0-native-request.json'), 'utf8'));
    const admitted = await new kernel.AbsOperationJournal(port, project).beginDocumentSave({ request,
      document: fixture.baseProjection.document, disk: fixture.next.expected }, guard);
    const application = new kernel.AbsApplicationJournal(port, project);
    await application.stageNativeSave({ ref: admitted.ref,
      evidence: await kernel.generationEvidence(fixture.baseProjection, fixture.next.expected.abi),
      inputAbiHash: await kernel.hashAbsText(fixture.next.expected.abi) }, guard);
    await pause('unchanged-before-proof');
    result = { resumed: true };
  }
  else if (['publish', 'throw'].includes(mode)) result = await publish();
  else if (mode === 'inspect') result = await inspect();
  else if (mode === 'compete') {
    const fixture = readFixture(), store = new kernel.AbsBaselineStore(await open(), scope);
    try { await store.stage(fixture.next, fixture.expectedPointerHash); result = { accepted: true }; }
    catch (error) { result = { accepted: false, code: error.code }; }
  } else if (mode.startsWith('native')) result = await native();
  else throw new Error('Unknown R0 worker mode.');
  send({ event: 'result', result }); process.disconnect?.();
})().catch(error => {
  send({ event: 'failure', error: { code: error.code, message: error.message, stack: error.stack } });
  process.exitCode = 1; process.disconnect?.();
});
