const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fork } = require('node:child_process');
const { buildSync } = require('esbuild');
const { before, test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');
const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'tests/test-results', `r2-board-request-input-${Date.now()}`);
const bundle = path.join(output, 'kernel.cjs');
const guard = () => {};
let kernel;
const boardInput = value => ({ kind: 'board-config', configKey: 'R2Mode', configValue: value });
const request = (input, requestId = `pub2-${randomUUID()}`) => ({ version: 2, requestId, operation: 'project_save', ...(input ? { input } : {}) });

before(() => {
  fs.mkdirSync(output, { recursive: true });
  buildSync({ absWorkingDir: repo, stdin: { resolveDir: repo, contents: `
    export * from './tests/electron/fixtures/r0-publication-kernel';
    export { nativeSaveIdentity, nativeSaveObservationResponse } from './src/app/integrations/blockly/abs/abs-native-save-result';
    export { readProjectSaveRequest } from './src/app/services/domains/project/project-save-receipts';
  ` }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'silent',
  alias: { '@domain/project/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts'),
    '@domain/project/project-data/public-api': path.join(__dirname, 'fixtures/r0-publication-domain-exports.ts') } });
  kernel = require(bundle);
});

async function child(mode, project) {
  const worker = fork(path.join(__dirname, 'fixtures/r0-publication-worker.cjs'), [mode, project, bundle],
    { execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  worker.stderr.on('data', data => { stderr += data; });
  const exit = new Promise(resolve => worker.once('exit', resolve));
  try {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Original request fixture timed out: ' + stderr)), 15000);
      worker.once('message', message => { clearTimeout(timer); message.event === 'failure'
        ? reject(Object.assign(new Error(message.error.message), message.error)) : resolve(message.result); });
      worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(stderr || `Fixture exit ${code}`)); });
    });
    assert.equal(await exit, 0);
    return value;
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await exit; }
  }
}

async function fixture(input) {
  const project = fs.mkdtempSync(path.join(output, 'project-'));
  await child('fixture', project);
  const original = JSON.parse(fs.readFileSync(path.join(project, 'r0-input.json'), 'utf8'));
  const port = await openProjectSyncStorage(project, guard);
  const command = request(input), identity = await kernel.nativeSaveIdentity(project, command);
  const store = new kernel.AbsBaselineStore(port, { projectKey: project, pageId: 'main' });
  const journal = new kernel.AbsOperationJournal(port, project), application = new kernel.AbsApplicationJournal(port, project);
  const admitted = await journal.beginDocumentSave({ request: identity, document: original.baseProjection.document,
    disk: original.next.expected }, guard);
  return { project, original, port, command, identity, store, journal, application, ref: admitted.ref };
}

test('board input is normalized, copied and restricted to the original durable project-save contract', () => {
  const input = boardInput('two'), command = request(input);
  const parsed = kernel.readProjectSaveRequest(command);
  assert.deepEqual(parsed.input, input);
  input.configValue = 'later';
  assert.equal(parsed.input.configValue, 'two');
  for (const bad of [null, {}, { ...boardInput('two'), extra: true }, boardInput(2),
    { kind: 'board-config', configKey: '', configValue: 'two' },
    { kind: 'board-switch', boardName: '../other' }, { kind: 'board-switch', boardName: '@aily-project/board-uno', extra: true }])
    assert.throws(() => kernel.readProjectSaveRequest({ ...command, input: bad }), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  assert.deepEqual(kernel.readProjectSaveRequest(request({ kind: 'board-switch', boardName: '@aily-project/board-nano' })).input,
    { kind: 'board-switch', boardName: '@aily-project/board-nano' });
  assert.throws(() => kernel.readProjectSaveRequest({ version: 1, requestId: 'legacy', operation: 'project_save', input: boardInput('two') }));
  assert.throws(() => kernel.readProjectSaveRequest({ ...request(boardInput('two')), operation: 'blocks_tidy' }));
});

test('ordinary saves keep their exact old identity while each board meaning has a distinct digest', async () => {
  const plain = request(), project = 'D:/Original/Project';
  const ordinary = await kernel.nativeSaveIdentity(project, plain);
  assert.equal(ordinary.inputDigest, await kernel.hashAbsText(kernel.absJson({ version: 2, project: 'd:/original/project', operation: 'project_save' })));
  const first = await kernel.nativeSaveIdentity(project, request(boardInput('one'), plain.requestId));
  const second = await kernel.nativeSaveIdentity(project, request(boardInput('two'), plain.requestId));
  assert.notEqual(first.inputDigest, ordinary.inputDigest);
  assert.notEqual(first.inputDigest, second.inputDigest);
  const reordered = { configValue: 'one', configKey: 'R2Mode', kind: 'board-config' };
  assert.deepEqual(await kernel.nativeSaveIdentity(project, { ...request(reordered, plain.requestId), waitMs: 100 }), first);
  const nano = await kernel.nativeSaveIdentity(project, request({ kind: 'board-switch', boardName: '@aily-project/board-nano' }, plain.requestId));
  const uno = await kernel.nativeSaveIdentity(project, request({ kind: 'board-switch', boardName: '@aily-project/board-uno' }, plain.requestId));
  assert.notEqual(nano.inputDigest, uno.inputDigest);
  assert.notEqual(nano.inputDigest, first.inputDigest);
});

test('the actual native journal rejects another board payload or omitted payload under the consumed ID', async () => {
  const f = await fixture(boardInput('two'));
  const original = await f.journal.beginDocumentSave({ request: f.identity, document: { mustNotReplace: 'S1' }, disk: { abi: 'later', abs: null, map: null } }, guard);
  assert.equal(original.created, false); assert.deepEqual(original.ref, f.ref);
  assert.deepEqual((await f.journal.inspect()).document, f.original.baseProjection.document);
  for (const input of [boardInput('one'), undefined, { kind: 'board-switch', boardName: '@aily-project/board-nano' }]) {
    const different = await kernel.nativeSaveIdentity(f.project, request(input, f.command.requestId));
    await assert.rejects(f.journal.findDocumentSave(different, guard), { code: 'ABS_NATIVE_SAVE_REQUEST_CONFLICT' });
  }
});

test('a cold process observes the exact board publication and original executor without another write', async () => {
  const f = await fixture({ kind: 'board-switch', boardName: '@aily-project/board-nano' });
  await f.store.stage(f.original.next, f.original.expectedPointerHash);
  const evidence = await kernel.generationEvidence(f.original.next.projection, f.original.next.abi);
  await f.application.stageNativeSave({ ref: f.ref, evidence, inputAbiHash: await kernel.hashAbsText(f.original.next.expected.abi) }, guard);
  const publication = await f.store.commit('r0-next', guard, async (text, expected, access) => {
    assert.equal(await access.replace('project.abi', expected, text), true);
  });
  assert.equal(publication.status, 'COMMITTED');
  assert.equal(await f.application.sealNativeSave(f.ref, guard), true);
  await f.application.completeNativeSave(f.ref, { projectSaved: true, generatedCodePublished: true, partial: false,
    publication, evidence, requiresReload: false, warnings: [] }, guard);
  await f.journal.finish(f.ref.operationId, guard);
  fs.writeFileSync(path.join(f.project, 'r0-native-request.json'), JSON.stringify(f.identity));
  const before = await f.store.captureDisk();
  const cold = await child('native-v2-observe', f.project);
  assert.equal(cold.state, 'completed'); assert.equal(cold.current, true);
  assert.deepEqual(cold.ref, f.ref); assert.equal(cold.ref.executor.storagePid, process.pid);
  assert.deepEqual(await f.store.captureDisk(), before);
  const wrong = await kernel.nativeSaveIdentity(f.project, { ...f.command, input: { kind: 'board-switch', boardName: '@aily-project/board-uno' } });
  await assert.rejects(f.application.observeNativeSave(wrong, guard), { code: 'ABS_NATIVE_SAVE_REQUEST_CONFLICT' });
});

test('in-memory and retired receipt identities also reject the same ID with a different board input', async () => {
  let now = 0, writes = 0, finish;
  const receipts = new kernel.ProjectSaveReceipts({ now: () => now, retentionMs: 1, durableLookup: async () => null });
  const command = request(boardInput('two'));
  await receipts.start('D:/Original/Project', command, [], () => { writes++; return new Promise(resolve => { finish = resolve; }); });
  assert.equal(writes, 1);
  await assert.rejects(receipts.status('D:/Original/Project', { ...command, input: boardInput('one') }), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  finish({ projectSaved: false }); await new Promise(resolve => setImmediate(resolve)); now = 2;
  await assert.rejects(receipts.status('D:/Original/Project', { ...command, input: boardInput('one') }), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  assert.equal(writes, 1);
});

test('durable lookups cannot substitute another board input before admitting any mutation', async () => {
  const command = request(boardInput('two')); let writes = 0;
  const receipts = new kernel.ProjectSaveReceipts({ durableLookup: async () => ({ ok: true, operation: 'project_save_status',
    saveReceipt: { version: 2, requestId: command.requestId, operation: command.operation,
      project: 'D:/Original/Project', state: 'completed', input: boardInput('one') } }) });
  await assert.rejects(receipts.start('D:/Original/Project', command, [], async () => { writes++; return {}; }),
    { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  assert.equal(writes, 0);
});
