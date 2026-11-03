'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/app/services/domains/project/project-save-receipts.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { ProjectSaveReceipts, readProjectSaveRequest } = compiled.exports;
const request = (requestId = 'save-1', extra = {}) => ({ version: 1, requestId, operation: 'project_save', ...extra });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a dropped observer never releases or repeats the original save', async () => {
  const store = new ProjectSaveReceipts(), pending = deferred(), session = {}, context = [session, false, 'blockly'];
  let writes = 0;
  const run = () => { writes++; return pending.promise; };
  const first = await store.start('/isolated', request(), context, run);
  assert.ok(['queued', 'running'].includes(first.saveReceipt.state));
  await store.start('/isolated', request(), context, run);
  const running = await store.status('/isolated', request());
  assert.equal(running.saveReceipt.state, 'running'); assert.equal(writes, 1);
  pending.resolve({ ok: true, projectSaved: true, generation: 'original-generation' });
  const final = await store.status('/isolated', request('save-1', { waitMs: 100 }));
  assert.equal(final.saveReceipt.state, 'completed');
  assert.deepEqual(final.result, { ok: true, projectSaved: true, generation: 'original-generation' });
  assert.equal(writes, 1);
});

test('an observation timeout leaves the original task live and late result queryable', async () => {
  const store = new ProjectSaveReceipts(), pending = deferred(); let writes = 0;
  const early = await store.start('/isolated', request('late', { waitMs: 1 }), [], () => { writes++; return pending.promise; });
  assert.equal(early.saveReceipt.state, 'running');
  pending.resolve({ ok: true, savedAbiSha256: 'a'.repeat(64) });
  const late = await store.status('/isolated', request('late', { waitMs: 100 }));
  assert.equal(late.saveReceipt.state, 'completed'); assert.equal(writes, 1);
});

test('UI retains real completion beyond the observation budget', async () => {
  const store = new ProjectSaveReceipts(), pending = deferred(); let settled = false;
  const save = store.execute('/isolated', request('manual', { waitMs: 1 }), [], () => pending.promise).then(v => { settled = true; return v; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(settled, false);
  pending.resolve({ success: true }); assert.equal((await save).result.success, true);
});

test('terminal partial/failure facts remain complete and isolated from caller mutation', async () => {
  const store = new ProjectSaveReceipts();
  const result = { ok: false, projectSaved: true, generatedCodePublished: false, partial: true,
    code: 'DERIVED_OUTPUT_FAILED', generation: 'g1', absPersistence: { state: 'committed' } };
  const answer = await store.execute('/isolated', request(), [], async () => result);
  assert.deepEqual(answer.result, result); answer.result.absPersistence.state = 'forged'; result.generation = 'changed';
  const observed = await store.status('/isolated', request());
  assert.equal(observed.result.absPersistence.state, 'committed'); assert.equal(observed.result.generation, 'g1');
});

test('execution rejection is an original terminal business failure, not an observer failure', async () => {
  const store = new ProjectSaveReceipts();
  const response = await store.execute('/isolated', request(), [], async () => {
    throw Object.assign(new Error('derived failed'), { code: 'DERIVED_FAILED', projectSaved: true, partial: true });
  });
  assert.equal(response.ok, true); assert.equal(response.saveReceipt.state, 'completed');
  assert.equal(response.result.ok, false); assert.equal(response.result.code, 'DERIVED_FAILED');
  assert.equal(response.result.projectSaved, true); assert.equal(response.result.partial, true);
});

test('cross-project and cross-operation identity reuse cannot execute or observe another task', async () => {
  const store = new ProjectSaveReceipts(); await store.execute('/isolated', request(), [], async () => ({ ok: true }));
  for (const op of [() => store.start('/another', request(), [], async () => assert.fail('must not run')),
    () => store.status('/another', request()),
    () => store.start('/isolated', request('save-1', { operation: 'blocks_tidy' }), [], async () => assert.fail('must not run'))])
    assert.throws(op, { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('same path reopened with another session cannot resubmit the old identity but can read its historical receipt', async () => {
  const store = new ProjectSaveReceipts();
  await store.execute('/isolated', request(), [{}], async () => ({ ok: true, projectSaved: true }));
  assert.throws(() => store.start('/isolated', request(), [{}], async () => assert.fail('must not run')),
    { code: 'PROJECT_SAVE_RECEIPT_CONTEXT_STALE' });
  assert.equal((await store.status('/isolated', request())).result.projectSaved, true);
});

test('status of a missing receipt or a new renderer is pure unknown', async () => {
  const store = new ProjectSaveReceipts();
  const response = await store.status('/isolated', request());
  assert.equal(response.saveReceipt.state, 'unknown'); assert.equal(response.result, undefined);
  assert.equal(response.code, 'PROJECT_SAVE_RECEIPT_UNKNOWN');
});

test('expired results retain consumed IDs instead of silently re-executing saves', async () => {
  let now = 100; const store = new ProjectSaveReceipts({ now: () => now, retentionMs: 10 });
  await store.execute('/isolated', request(), [], async () => ({ ok: true })); now = 111;
  assert.equal((await store.status('/isolated', request())).code, 'PROJECT_SAVE_RECEIPT_EXPIRED');
  assert.throws(() => store.start('/isolated', request(), [], async () => assert.fail('must not run')),
    { code: 'PROJECT_SAVE_RECEIPT_EXPIRED' });
  assert.throws(() => store.status('/another', request()), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('completed eviction preserves tombstones; running saves are never evicted', async () => {
  const store = new ProjectSaveReceipts({ completedLimit: 1 }), pending = deferred();
  await store.start('/isolated', request('live'), [], () => pending.promise);
  await store.execute('/isolated', request('old'), [], async () => ({ ok: true }));
  await store.execute('/isolated', request('new'), [], async () => ({ ok: true }));
  assert.equal((await store.status('/isolated', request('old'))).code, 'PROJECT_SAVE_RECEIPT_EXPIRED');
  assert.equal((await store.status('/isolated', request('live'))).saveReceipt.state, 'running');
  pending.resolve({ ok: true });
});

test('finite identity exhaustion rejects admission and still observes existing consumed IDs', async () => {
  const store = new ProjectSaveReceipts({ completedLimit: 0, identityLimit: 1 });
  await store.execute('/isolated', request(), [], async () => ({ ok: true }));
  assert.throws(() => store.start('/isolated', request('new'), [], async () => assert.fail('must not run')),
    { code: 'PROJECT_SAVE_RECEIPT_CAPACITY' });
  assert.equal((await store.status('/isolated', request())).code, 'PROJECT_SAVE_RECEIPT_EXPIRED');
});

test('a new intentional save gets a new task and never coalesces with earlier content', async () => {
  const store = new ProjectSaveReceipts(); let calls = 0;
  const run = async () => ({ ok: true, revision: ++calls });
  const a = await store.execute('/isolated', request('a'), [], run);
  const b = await store.execute('/isolated', request('b'), [], run);
  assert.equal(a.result.revision, 1); assert.equal(b.result.revision, 2);
});

test('Windows aliases bind to one normalized project but never to another', async () => {
  const store = new ProjectSaveReceipts(); await store.execute('C:\\Private\\Project', request(), [], async () => ({ ok: true }));
  assert.equal((await store.status('c:/private/project/', request())).saveReceipt.state, 'completed');
  assert.throws(() => store.status('c:/private/other', request()), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('malformed identity, operation, budgets and non-absolute paths are rejected', () => {
  for (const value of [null, {}, request('../id'), request('id', { version: 2 }), request('id', { operation: 'project_build' }),
    request('id', { waitMs: -1 }), request('id', { waitMs: 10001 }), request('id', { waitMs: 0.5 }), request('id', { force: true })])
    assert.throws(() => readProjectSaveRequest(value), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  const store = new ProjectSaveReceipts();
  assert.throws(() => store.status('relative/project', request()), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
});
