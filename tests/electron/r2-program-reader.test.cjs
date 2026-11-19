const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { before, after, test } = require('node:test');
const { buildSync } = require('esbuild');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const repo = path.resolve(__dirname, '../..');
const root = path.join(repo, 'tests/test-results', `r2-program-reader-${Date.now()}`);
const bundle = path.join(root, 'kernel.cjs'), children = new Set();
let kernel;
const guard = () => {};
before(() => {
  fs.mkdirSync(root, { recursive: true });
  buildSync({ absWorkingDir: repo, entryPoints: ['tests/electron/fixtures/r2-program-reader-kernel.ts'], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent',
    alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
      '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
  kernel = require(bundle);
});
function launch(mode, project, point) {
  const child = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), [mode, project, bundle, point ?? ''],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.add(child);
  const closed = once(child, 'exit').then(([code]) => { children.delete(child); return code; });
  return { child, closed, next: () => once(child, 'message', { signal: AbortSignal.timeout(30000) }).then(([value]) => {
    assert.notEqual(value.event, 'failure', JSON.stringify(value.error)); return value;
  }) };
}
async function fixture() {
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'r2-reader', type: 'blockly' }));
  const setup = launch('fixture', project);
  assert.equal((await setup.next()).event, 'result'); assert.equal(await setup.closed, 0);
  return { project, input: JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8')),
    port: await openProjectSyncStorage(project, guard) };
}
after(async () => {
  await Promise.all([...children].map(async child => { const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed; }));
});

test('a background reader pins the complete old generation while the real writer has replaced only ABI', async () => {
  const { project, input, port } = await fixture();
  const writer = launch('publish', project, 'project.abi');
  assert.equal((await writer.next()).event, 'paused');
  assert.equal(await port.read('project.abi'), input.next.abi);
  assert.equal(await port.read('project.abs'), input.next.expected.abs);
  const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
  const selected = await store.readCommittedSnapshot();
  assert.equal(selected.abi, input.next.expected.abi);
  assert.equal(selected.projection.abs, input.baseProjection.abs);
  assert.equal(selected.projection.map.generation, 'r0-base');
  const completion = writer.next(); writer.child.send({ action: 'continue' });
  assert.equal((await completion).result.publication.status, 'COMMITTED'); assert.equal(await writer.closed, 0);
  const next = await store.readCommittedSnapshot();
  assert.equal(next.abi, input.next.abi); assert.equal(next.projection.abs, input.next.projection.abs);
  assert.equal(next.projection.map.generation, 'r0-next');
});

test('saved exports use selected immutable program bytes and cannot write the captured manifest', async () => {
  const { project, input, port } = await fixture();
  fs.writeFileSync(path.join(project, 'project.abs'), 'unpublished external draft');
  const saved = await kernel.readSavedProjectProgram(project, guard, port);
  assert.equal(saved.source, 'committed'); assert.equal(saved.files['project.abi'], input.next.expected.abi);
  assert.equal(saved.files['project.abs'], input.baseProjection.abs);
  assert.equal(fs.readFileSync(path.join(project, 'project.abs'), 'utf8'), 'unpublished external draft');
  const original = fs.readFileSync(path.join(project, 'package.json'), 'utf8');
  assert.equal(saved.packageText, original);
  await assert.rejects(port.withLock(access => access.replace('package.json', null, '{}')), { code: 'ABS_STORAGE_WRITE_INVALID' });
  assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), original);
});

test('a mismatched host remains readable but cannot publish mirrors through the shared storage boundary', async () => {
  const { project, port } = await fixture();
  const host = { projectSyncStorageVersion: 2, openProjectSyncStorage: async () => ({
    read: key => port.read(key), withLock: callback => port.withLock(access => new Promise((resolve, reject) => {
      callback(access, result => result.ok ? resolve(result.value) : reject(Object.assign(new Error(result.error.message), result.error)));
    })) }) };
  const restricted = await kernel.openAbsHostStorage(project, guard, host);
  assert.equal(await restricted.read('project.abs'), await port.read('project.abs'));
  await assert.rejects(restricted.withLock(access => access.replace('project.abs', null, 'unsafe replacement')),
    { code: 'PROJECT_PROGRAM_HOST_UPDATE_REQUIRED' });
});

test('history deletion preserves a changed Working node as a conflict and field changes retain newer order', () => {
  const base = { blocks: [{ id: 'a', value: 1 }, { id: 'b', value: 2 }] };
  assert.throws(() => kernel.mergeAbsHistoryDocument(base, { blocks: [{ id: 'a', value: 3 }, { id: 'b', value: 2 }] },
    { blocks: [{ id: 'b', value: 2 }] }), { code: 'ABS_HISTORY_DOCUMENT_CONFLICT' });
  const merged = kernel.mergeAbsHistoryDocument(base, { blocks: [{ id: 'b', value: 2 }, { id: 'a', value: 1 }] },
    { blocks: [{ id: 'a', value: 4 }, { id: 'b', value: 2 }] });
  assert.deepEqual(merged, { blocks: [{ id: 'b', value: 2 }, { id: 'a', value: 4 }] });
});

test('a same-head map repair preserves saved sources, pending intent and the exact damaged map', async () => {
  const { project, input, port } = await fixture();
  const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
  const beforePointer = await port.read('committed.json');
  const beforeABI = await port.read('project.abi');
  const beforeABS = await port.read('project.abs');
  const damaged = JSON.stringify({ ...input.baseProjection.map, nodes: {} }, null, 2);
  fs.writeFileSync(path.join(project, 'project.abs.map.json'), damaged);
  const repaired = await store.restoreCommittedMap(guard);
  assert.equal(repaired.changed, true); assert.equal(repaired.generation, 'r0-base');
  assert.equal(await port.read('committed.json'), beforePointer);
  assert.equal(await port.read('project.abi'), beforeABI); assert.equal(await port.read('project.abs'), beforeABS);
  assert.equal(await port.read('project.abs.map.json'), kernel.absJson(input.baseProjection.map));
  const archives = fs.readdirSync(path.join(project, '.aily/abs-sync/recoveries'));
  assert.equal(archives.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.aily/abs-sync/recoveries', archives[0]), 'utf8')).map, damaged);
  assert.equal((await store.restoreCommittedMap(guard)).changed, false);
});

test('map cache repair refuses a later source edit, a prepared transaction and changed observation', async () => {
  for (const kind of ['source', 'prepared', 'observation']) {
    const { project, port } = await fixture();
    const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
    const selected = await store.readCommittedSnapshot();
    fs.writeFileSync(path.join(project, 'project.abs.map.json'), 'broken map');
    if (kind === 'source') fs.appendFileSync(path.join(project, 'project.abs'), '\n// newer edit');
    if (kind === 'prepared') await port.withLock(io => io.replace('prepared.json', null, '{}'));
    const before = await store.captureDisk();
    await assert.rejects(store.restoreCommittedMap(guard, kind === 'observation' ? { pointerHash: selected.pointerHash,
      disk: { ...before, map: 'different observation' } } : undefined));
    assert.deepEqual(await store.captureDisk(), before);
  }
});

test('actual Shell map diagnostics invoke Host repair, preserve the private draft, and keep the same head', { skip: !process.env.AILY_R2_LEX_REPO }, async () => {
  const { project, port } = await fixture();
  const lexRoot = path.resolve(process.env.AILY_R2_LEX_REPO);
  const { createJiti } = require('node:module').createRequire(path.join(lexRoot, 'packages/aily-agent/package.json'))('jiti');
  const jiti = createJiti(__filename);
  const { withReadOnlyAbsRoots } = await jiti.import(path.join(lexRoot, 'packages/aily-agent/src/operations/abs-shell-guard.ts'));
  const { bindAbsEditOrigin, publishAbsEdit, withTextEditProvenance } = await jiti.import(path.join(lexRoot, 'packages/aily-agent/src/operations/abs-edit-provenance.ts'));
  const { execFileSync } = require('node:child_process');
  const view = path.join(project, '.aily/r2-private-view'); fs.mkdirSync(view);
  const canonical = path.join(project, 'project.abs'), privateFile = path.join(view, 'project.abs');
  const source = await port.read('project.abs'), beforeMap = await port.read('project.abs.map.json');
  fs.writeFileSync(privateFile, source); bindAbsEditOrigin(canonical, privateFile);
  const draft = source + '\n// private draft remains unapplied\n';
  const anchor = source.slice(-32);
  withTextEditProvenance(anchor, anchor + '\n// private draft remains unapplied\n', () =>
    publishAbsEdit(privateFile, source, draft, () => fs.writeFileSync(privateFile, draft)));
  const head = await port.read('committed.json'); let callbacks = 0;
  await withReadOnlyAbsRoots([view], async () => {
    execFileSync(process.execPath, ['-e', 'const fs=require("node:fs");let f=process.argv[1];fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,"utf8")),null,2))', path.join(project, 'project.abs.map.json')]);
  }, { proofSources: [privateFile], onCanonicalChanged: async observations => {
    callbacks++; assert.equal(observations.length, 1);
    const result = await kernel.restoreObservedProgramMap(port, project, observations[0], guard);
    assert.equal(result.mapRestored, true);
  } });
  assert.equal(callbacks, 1); assert.equal(await port.read('committed.json'), head);
  assert.equal(await port.read('project.abs.map.json'), beforeMap);
  assert.equal(await port.read('project.abs'), source); assert.equal(fs.readFileSync(privateFile, 'utf8'), draft);
});
