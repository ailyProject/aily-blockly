const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const [project, bundle, legacy] = process.argv.slice(2), kernel = require(bundle), guard = () => {};
(async () => {
  const input = JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8'));
  const port = await openProjectSyncStorage(project, guard);
  const journal = new kernel.AbsOperationJournal(legacy === 'legacy' ? { read: key => port.read(key), withLock: run => port.withLock(run) } : port, project);
  const waitForKill = () => new Promise(() => { process.on('message', () => {}); });
  if (legacy === 'recover-metadata-before-reanchor') {
    const restored = await kernel.recoverAbsProjectOperation(port, project, guard);
    await journal.restored(restored.operationId, guard);
    const previous = await port.read('committed.json');
    const baselineKey = kernel.absBaselineKey(JSON.parse(previous).generation);
    const baseline = path.join(project, '.aily/abs-sync', baselineKey);
    // A damaged private baseline is the input to the actual metadata repair.
    fs.renameSync(baseline, path.join(project, 'r1-damaged-baseline-fixture.json'));
    const result = await kernel.recoverAbsBaseline(port, project, guard);
    assert.equal(result.changed, true);
    process.send({ event: 'ready', previous, committed: await port.read('committed.json') });
    await waitForKill();
    return;
  }
  if (legacy === 'recover-original' || legacy === 'recover-before-readback') {
    const original = await journal.inspect();
    const restored = await kernel.recoverAbsProjectOperation(port, project, guard);
    assert.deepEqual(restored.document, original.document);
    await journal.restored(restored.operationId, guard);
    if (legacy === 'recover-original') await journal.recordRestoredApplication(restored.operationId, guard,
      async document => assert.deepEqual(document, original.document));
    const proof = await port.read(`recoveries/application-restored-${restored.operationId}.json`);
    if (legacy === 'recover-original') assert.ok(proof); else assert.equal(proof, null);
    process.send({ event: 'ready', proof, executor: port.executor });
    await waitForKill();
    return;
  }
  const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
  if (legacy === 'native-state-before-abi') {
    const before = input.baseProjection.document, document = structuredClone(before);
    const previous = before.pages[0].content.blocks.blocks[0], block = document.pages[0].content.blocks.blocks[0];
    block.collapsed = !previous.collapsed;
    const state = { version: 2, requestId: randomUUID(), action: 'update', expectedGeneration: 'r0-base',
      changes: [{ blockId: block.id, collapsed: block.collapsed }] };
    const identity = await kernel.blockStatePublicationIdentity(project, state);
    const expected = await store.captureDisk(), abi = JSON.stringify(document), generation = 'native-state-before-abi';
    const { ref } = await journal.beginDocumentSave({ request: identity, document: before, disk: expected }, guard);
    const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), { document, generation,
      scope: { projectKey: project, pageId: 'main' }, baselineRef: kernel.absBaselineKey(generation), savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
    const evidence = await kernel.generationEvidence(projection, abi), inputAbiHash = await kernel.hashAbsText(expected.abi);
    await store.stage({ abi, mode: 'import', inputAbs: projection.abs, projection, expected }, input.expectedPointerHash);
    await new kernel.AbsApplicationJournal(port, project).stageNativeSave({ ref, evidence, inputAbiHash, blockState: {
      ...state, inputAbiHash, output: evidence, beforeStates: [{ blockId: block.id, collapsed: previous.collapsed === true }],
      states: [{ blockId: block.id, collapsed: block.collapsed }] } }, guard);
    await store.commit(generation, guard, async () => {
      process.send({ event: 'ready', ref, identity, executor: port.executor });
      await waitForKill();
    });
    return;
  }
  if (legacy === 'advanced-intent') {
    await store.stage(input.next, input.expectedPointerHash);
    const published = await store.commit(input.next.projection.map.generation, guard, async (text, expected, access) => {
      if (!await access.replace('project.abi', expected, text)) throw Error('Real successor ABI CAS failed');
    });
    if (published.status !== 'COMMITTED') throw Error('Real successor did not commit');
  }
  const baseProjection = legacy === 'advanced-intent' ? input.next.projection : input.baseProjection;
  const disk = await store.captureDisk();
  const document = structuredClone(baseProjection.document);
  if (legacy !== 'identical-document') document.extension.dirtyS1 = { keepAllPages: true };
  const source = legacy === 'advanced-intent' ? input.baseProjection.abs.replace('root(VALUE=100)', 'root(VALUE=102)') : input.next.inputAbs;
  const requestId = 'r1-restored-original-request';
  const start = input.baseProjection.abs.indexOf('100');
  const validation = { version: 2, requestId, base: (await kernel.generationEvidence(baseProjection, disk.abi)).binding,
    ...(legacy === 'advanced-intent' ? { concurrentEdits: 'request-priority', intentGeneration: input.baseProjection.map.generation,
      sourceEdits: [[{ start, end: start + 3, text: '102' }]] } : {}),
    candidate: { hash: await kernel.hashAbsText(source), bytes: Buffer.byteLength(source) }, workspaceRevision: 1 };
  const original = { kind: 'abs-apply', document, disk,
    candidate: { source, hash: validation.candidate.hash, generation: validation.base.generation }, application: { requestId, validation } };
  if (legacy === 'index-before-pointer' || legacy === 'legacy-index-before-pointer') {
    const legacyIndex = legacy === 'legacy-index-before-pointer';
    if (legacyIndex) await new kernel.OriginalRequestAdmissions(port, project).reserveApplication(requestId, validation.candidate.hash, guard);
    const before = await port.read('operation.json');
    let legacySnapshotHash;
    const intercepted = { ...port, withLock: run => port.withLock(storage => run({ ...storage, replace: async (key, expected, content) => {
      if (legacyIndex && content !== null && /^recoveries\/(?:operation-|request-)/.test(key)) {
        const record = JSON.parse(content);
        delete record.sourceStageVersion;
        if (key.startsWith('recoveries/request-')) record.snapshotHash = legacySnapshotHash;
        content = kernel.absJson(record);
        if (key.startsWith('recoveries/operation-')) legacySnapshotHash = await kernel.hashAbsText(content);
      }
      const written = await storage.replace(key, expected, content);
      if (written && key.startsWith('recoveries/request-') && content !== null) {
        assert.equal(await storage.read('operation.json'), before);
        const index = JSON.parse(content);
        process.send({ event: 'ready', requestId, operationId: index.operationId, executor: port.executor });
        await waitForKill();
      }
      return written;
    } })) };
    return new kernel.AbsOperationJournal(intercepted, project).begin(original, guard);
  }
  const operationId = await journal.begin(original, guard);
  const ready = () => process.send({ event: 'ready', requestId, operationId, document, executor: port.executor, attachment: port.attachment });
  if (legacy === 'staged-before-abi') {
    await store.stage(input.next, input.expectedPointerHash);
    const evidence = await kernel.generationEvidence(input.next.projection, input.next.abi);
    await new kernel.AbsApplicationJournal(port, project).stage(operationId, validation, {
      evidence, publication: { status: 'COMMITTED', generation: evidence.binding.generation },
    }, guard);
    await store.commit(evidence.binding.generation, guard, async () => {
      // The production prepared pointer exists; the ABI writer has not begun.
      ready(); await waitForKill();
    });
    return;
  }
  // A pure kernel fixture, not a claim that this Node worker loaded a GUI.
  // The packaged prepreview driver separately verifies actual S1 readback.
  await journal.restored(operationId, guard);
  ready(); await waitForKill();
})().catch(error => { process.send?.({ event: 'error', code: error.code, message: error.message }); process.exitCode = 1; });
