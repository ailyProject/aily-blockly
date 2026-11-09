const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { buildSync } = require('esbuild');
const { before, test, after } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');

const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'tests/test-results', `r1-native-observation-cost-${Date.now()}`);
const project = path.join(root, 'project');
const guard = () => {};
const metrics = [];
let kernel, port, store, application, request, ref, facts, abi, baselineKey;

before(async () => {
  fs.mkdirSync(project, { recursive: true });
  const bundle = path.join(root, 'kernel.cjs');
  buildSync({ absWorkingDir: repo, entryPoints: ['tests/electron/fixtures/r0-publication-kernel.ts'],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
  kernel = require(bundle);
  port = await openProjectSyncStorage(project, guard);
  const scope = { projectKey: project, pageId: 'main' };
  store = new kernel.AbsBaselineStore(port, scope);
  application = new kernel.AbsApplicationJournal(port, project);
  // Large complete-document metadata exercises the real v2 snapshot decoder and
  // ABI recipe, rather than substituting a precomputed output or fake receipt.
  const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'main', content: { blocks: { languageVersion: 0,
      blocks: [{ type: 'root', id: 'root', fields: { VALUE: 100 } }] } } }],
    sharedModel: { procedureBlocks: [], variables: [] },
    extension: { retained: 'large-document-metadata '.repeat(410000) } };
  const prepare = async generation => {
    const text = JSON.stringify(document, null, 2);
    const projection = await kernel.createAbsProjection(kernel.composeBlocklyPage(document, 'main'), {
      document, generation, baselineRef: kernel.absBaselineKey(generation), scope,
      savedAbiHash: await kernel.hashAbsText(kernel.absJson(document)) });
    return { mode: 'import', abi: text, projection, inputAbs: projection.abs, expected: await store.captureDisk() };
  };
  const commit = async input => {
    await store.stage(input);
    const result = await store.commit(input.projection.map.generation, guard, async (text, expected, access) => {
      assert.equal(await access.replace('project.abi', expected, text), true);
    });
    assert.equal(result.status, 'COMMITTED');
    return result;
  };
  await commit(await prepare('cost-base'));
  document.pages[0].content.blocks.blocks[0].fields.VALUE = 101;
  const input = await prepare('cost-next');
  request = { version: 2, requestId: `pub2-${randomUUID()}`, operation: 'project_save',
    inputDigest: await kernel.hashAbsText(kernel.absJson({ project, operation: 'project_save' })) };
  const admitted = await new kernel.AbsOperationJournal(port, project).beginDocumentSave({
    request, document, disk: input.expected }, guard);
  ref = admitted.ref;
  const evidence = await kernel.generationEvidence(input.projection, input.abi);
  await application.stageNativeSave({ ref, evidence, inputAbiHash: await kernel.hashAbsText(input.expected.abi) }, guard);
  const publication = await commit(input);
  assert.equal(await application.sealNativeSave(ref, guard), true);
  facts = { projectSaved: true, generatedCodePublished: true, partial: false,
    publication, evidence, requiresReload: false, warnings: [], derivedOutputs: { published: true } };
  await application.completeNativeSave(ref, facts, guard);
  abi = input.abi;
  baselineKey = kernel.absBaselineKey('cost-next');
  metrics.push({ abiBytes: Buffer.byteLength(abi), baselineBytes: Buffer.byteLength(await port.read(baselineKey)) });
});

function measuredPort() {
  const reads = new Map();
  return { reads, value: { attachment: port.attachment, executor: port.executor,
    read: async key => { reads.set(key, (reads.get(key) || 0) + 1); return port.read(key); },
    withLock: action => port.withLock(action) } };
}

test('verified ancestor returns its already-decoded exact ABI', async () => {
  const measured = measuredPort();
  const observed = await new kernel.AbsBaselineStore(measured.value, { projectKey: project, pageId: 'main' })
    .inspectCommittedAncestor('cost-next');
  assert.equal(typeof observed.abi, 'string');
  assert.equal(await kernel.hashAbsText(observed.abi), await kernel.hashAbsText(abi));
  assert.equal(measured.reads.get(baselineKey), 1);
});

test('sealed native observation validates the large generation once and remains read-only', async () => {
  const before = await store.captureDisk(), pointer = await port.read('committed.json');
  const measured = measuredPort(), started = performance.now();
  const observed = await new kernel.AbsApplicationJournal(measured.value, project).observeNativeSave(request, guard);
  metrics.push({ elapsedMs: performance.now() - started, targetBaselineReads: measured.reads.get(baselineKey),
    reads: Object.fromEntries(measured.reads) });
  assert.equal(observed.state, 'completed');
  assert.equal(observed.current, true);
  assert.deepEqual(observed.result, facts);
  assert.equal(measured.reads.get(baselineKey), 1, 'Do not decode and derive the same immutable target twice.');
  assert.deepEqual(await store.captureDisk(), before);
  assert.equal(await port.read('committed.json'), pointer);
});

async function withChangedFile(key, transform, check) {
  const filename = path.join(project, ['project.abi', 'project.abs', 'project.abs.map.json'].includes(key) ? key : `.aily/abs-sync/${key}`);
  const original = fs.readFileSync(filename, 'utf8');
  const changed = transform(original);
  fs.writeFileSync(filename, changed);
  try { await check(); assert.equal(fs.readFileSync(filename, 'utf8'), changed, 'Observation never repairs or overwrites an external change.'); }
  finally { fs.writeFileSync(filename, original); }
}

test('immutable target checksum and stage evidence are still verified', async () => {
  await withChangedFile(baselineKey, text => text + ' ', async () => {
    await assert.rejects(application.observeNativeSave(request, guard), { code: 'ABS_BASELINE_CORRUPT' });
  });
  await withChangedFile(`recoveries/application-${ref.operationId}.json`, text => {
    const value = JSON.parse(text); value.evidence.binding.abiHash = `sha256:${'0'.repeat(64)}`;
    return JSON.stringify(value);
  }, async () => { await assert.rejects(application.observeNativeSave(request, guard)); });
});

test('current three mirrors retain their exact-byte checks despite a sealed final result', async () => {
  for (const key of ['project.abi', 'project.abs', 'project.abs.map.json']) {
    await withChangedFile(key, text => text + '\nexternal-change', async () => {
      const observed = await application.observeNativeSave(request, guard);
      assert.equal(observed.state, 'unknown', key);
      assert.equal(observed.publication.status, 'UNKNOWN');
    });
  }
});

test('a committed pointer change during decode is still rejected', async () => {
  let pointers = 0;
  const reader = { attachment: port.attachment, executor: port.executor, withLock: action => port.withLock(action),
    read: async key => { const text = await port.read(key); return key === 'committed.json' && ++pointers === 2 ? text + ' ' : text; } };
  await assert.rejects(new kernel.AbsApplicationJournal(reader, project).observeNativeSave(request, guard),
    { code: 'ABS_BASELINE_STALE' });
});

after(() => {
  fs.writeFileSync(path.join(root, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(`R1_NATIVE_OBSERVATION_COST_OUTPUT=${root}`);
});
