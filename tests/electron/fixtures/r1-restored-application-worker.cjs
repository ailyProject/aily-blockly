const fs = require('node:fs');
const path = require('node:path');
const { openProjectSyncStorage } = require('../../../electron/project-sync-storage');
const [project, bundle, legacy] = process.argv.slice(2), kernel = require(bundle), guard = () => {};
(async () => {
  const input = JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8'));
  const port = await openProjectSyncStorage(project, guard);
  const journal = new kernel.AbsOperationJournal(legacy === 'legacy' ? { read: key => port.read(key), withLock: run => port.withLock(run) } : port, project);
  const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
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
  document.extension.dirtyS1 = { keepAllPages: true };
  const source = legacy === 'advanced-intent' ? input.baseProjection.abs.replace('root(VALUE=100)', 'root(VALUE=102)') : input.next.inputAbs;
  const requestId = 'r1-restored-original-request';
  const start = input.baseProjection.abs.indexOf('100');
  const validation = { version: 2, requestId, base: (await kernel.generationEvidence(baseProjection, disk.abi)).binding,
    ...(legacy === 'advanced-intent' ? { concurrentEdits: 'request-priority', intentGeneration: input.baseProjection.map.generation,
      sourceEdits: [[{ start, end: start + 3, text: '102' }]] } : {}),
    candidate: { hash: await kernel.hashAbsText(source), bytes: Buffer.byteLength(source) }, workspaceRevision: 1 };
  const operationId = await journal.begin({ kind: 'abs-apply', document, disk,
    candidate: { source, hash: validation.candidate.hash, generation: validation.base.generation }, application: { requestId, validation } }, guard);
  // A pure kernel fixture, not a claim that this Node worker loaded a GUI.
  // The packaged prepreview driver separately verifies actual S1 readback.
  await journal.restored(operationId, guard);
  process.send({ event: 'ready', requestId, operationId, document, executor: port.executor, attachment: port.attachment });
  process.on('message', () => {}); // Keep the real original process alive until the parent explicitly kills it.
  await new Promise(() => {});
})().catch(error => { process.send?.({ event: 'error', code: error.code, message: error.message }); process.exitCode = 1; });
