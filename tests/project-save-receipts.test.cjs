'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../src/app/services/domains/project/project-save-receipts.ts');
const loadTypescript = file => {
  const compiled = new Module(file, module);
  compiled.require = name => loadTypescript(path.resolve(path.dirname(file), name + '.ts'));
  compiled._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, file);
  return compiled.exports;
};
const { ProjectSaveReceipts, readProjectSaveRequest } = loadTypescript(filename);
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
    await assert.rejects(op, { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('same path reopened with another session cannot resubmit the old identity but can read its historical receipt', async () => {
  const store = new ProjectSaveReceipts();
  await store.execute('/isolated', request(), [{}], async () => ({ ok: true, projectSaved: true }));
  await assert.rejects(() => store.start('/isolated', request(), [{}], async () => assert.fail('must not run')),
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
  await assert.rejects(() => store.start('/isolated', request(), [], async () => assert.fail('must not run')),
    { code: 'PROJECT_SAVE_RECEIPT_EXPIRED' });
  await assert.rejects(() => store.status('/another', request()), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
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
  await assert.rejects(() => store.start('/isolated', request('new'), [], async () => assert.fail('must not run')),
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
  await assert.rejects(() => store.status('c:/private/other', request()), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('malformed identity, operation, budgets and non-absolute paths are rejected', async () => {
  for (const value of [null, {}, request('../id'), request('id', { version: 2 }), request('id', { operation: 'project_build' }),
    request('id', { waitMs: -1 }), request('id', { waitMs: 10001 }), request('id', { waitMs: 0.5 }), request('id', { force: true })])
    assert.throws(() => readProjectSaveRequest(value), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  const store = new ProjectSaveReceipts();
  await assert.rejects(() => store.status('relative/project', request()), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
});

const durableRequest = number => request(`pub2-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`, { version: 2 });
const project = '/isolated';
const exactTerminal = (input, attachmentRoot = project) => ({
  ok: true, operation: 'project_save_status',
  saveReceipt: { ...input, project, state: 'completed' },
  result: { ok: true, projectSaved: true, publication: { status: 'COMMITTED' } },
  publicationObservation: {
    version: 1, durable: true, requestId: input.requestId, operation: input.operation, operationId: 'f'.repeat(36),
    attachment: { version: 1, root: attachmentRoot, identity: { dev: '1', ino: '2', birthtimeNs: '3' } },
    executor: { version: 1, hostPid: 101, storagePid: 102, instanceId: 'owner', processIdentity: null, bootId: null },
    observer: { hostPid: 101 }, current: true,
  },
});

function saveFixture(options = {}) {
  const native = new Map(), remembered = new Map();
  const durableLookup = async (target, input) => target === project ? native.get(input.requestId) ?? null : null;
  const settledIdentities = {
    inspect(id, binding) {
      return !remembered.has(id) ? 'missing' : remembered.get(id) === binding ? 'matching' : 'different';
    },
    remember(id, binding) { remembered.set(id, binding); },
    ...options.settledIdentities,
  };
  const create = () => new ProjectSaveReceipts({ ...options, durableOnly: true, durableLookup, settledIdentities });
  return { create, native, remembered };
}

test('verified native terminal saves can exceed the default lifetime limit without dropping the original binding', async () => {
  let now = 100, starts = 0;
  const { create, native, remembered } = saveFixture({ now: () => now });
  const store = create();
  for (let i = 1; i <= 8193; i++) {
    if (i === 8193) now += 24 * 60 * 60 * 1000;
    const input = durableRequest(i);
    const response = await store.execute(project, input, [], async () => {
      starts++;
      const receipt = exactTerminal(input);
      native.set(input.requestId, receipt);
      return receipt.result;
    });
    assert.equal(response.saveReceipt.state, 'completed');
  }
  assert.equal(starts, 8193);
  assert.equal(remembered.size, 8193);
  const original = durableRequest(1);
  const noReplay = async () => assert.fail('a consumed ID must never write again');
  const old = await store.start(project, original, [], noReplay);
  assert.equal(old.result.projectSaved, true);
  await assert.rejects(store.start('/other-project', original, [], noReplay), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  native.delete(original.requestId); // A replacement root has no original journal.
  const restarted = create();
  assert.equal((await restarted.status(project, original)).code, 'PROJECT_SAVE_RECEIPT_EXPIRED');
  await assert.rejects(restarted.start(project, original, [], noReplay), { code: 'PROJECT_SAVE_RECEIPT_EXPIRED' });
  await assert.rejects(restarted.start(project, { ...original, operation: 'blocks_tidy' }, [], noReplay),
    { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  assert.equal(starts, 8193);
});

test('receipt-only, wrong-attachment and failed index writes keep the conservative capacity fence', async () => {
  for (const mode of ['unproven', 'wrong-attachment', 'failed-index']) {
    const { create, native, remembered } = saveFixture({ identityLimit: 1, completedLimit: 0,
      ...(mode === 'failed-index' ? { settledIdentities: { remember() { throw new Error('disk unavailable'); } } } : {}) });
    const input = durableRequest(1);
    const store = create();
    const terminal = await store.execute(project, input, [], async () => {
      const receipt = exactTerminal(input, mode === 'wrong-attachment' ? '/different-attachment' : project);
      if (mode === 'unproven') delete receipt.publicationObservation;
      native.set(input.requestId, receipt);
      return receipt.result;
    });
    assert.equal(terminal.result.projectSaved, true);
    assert.equal(remembered.size, 0);
    await assert.rejects(store.start(project, durableRequest(2), [], async () => assert.fail('must not run unbounded writers')),
      { code: 'PROJECT_SAVE_RECEIPT_CAPACITY' });
    assert.equal((await store.status(project, input)).result.projectSaved, true);
  }
});

test('the writer can retire an exact terminal identity without a connected observer', async () => {
  const { create, native, remembered } = saveFixture({ identityLimit: 1 });
  const store = create(), finished = deferred(), input = durableRequest(1);
  const response = await store.start(project, input, [], () => finished.promise);
  assert.equal(response.saveReceipt.state, 'running');
  const receipt = exactTerminal(input);
  native.set(input.requestId, receipt);
  finished.resolve(receipt.result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(remembered.has(input.requestId), true);
  assert.equal((await store.status(project, input)).result.projectSaved, true);
});

test('a later exact status retires a save that was initially unconfirmed and lets the next ID write', async () => {
  const { create, native, remembered } = saveFixture({ identityLimit: 1, completedLimit: 0 });
  const store = create(), a = durableRequest(1), b = durableRequest(2);
  let writes = 0;
  const first = await store.execute(project, a, [], async () => {
    writes++;
    native.set(a.requestId, { ok: true, operation: 'project_save_status',
      saveReceipt: { ...a, project, state: 'unknown' }, code: 'ABS_NATIVE_SAVE_OBSERVATION_PENDING' });
    return { ok: true, projectSaved: true };
  });
  assert.equal(first.saveReceipt.state, 'unknown');
  assert.equal(remembered.has(a.requestId), false);

  native.set(a.requestId, exactTerminal(a));
  const recovered = await store.status(project, a);
  assert.equal(recovered.result.projectSaved, true);
  assert.equal(remembered.has(a.requestId), true);
  const next = await store.execute(project, b, [], async () => {
    writes++;
    const receipt = exactTerminal(b);
    native.set(b.requestId, receipt);
    return receipt.result;
  });
  assert.equal(next.saveReceipt.state, 'completed');
  await store.start(project, a, [], async () => assert.fail('must observe the original terminal save'));
  assert.equal(writes, 2);
});

test('an original v2 publication observed by a replacement host backfills the index before a project path replacement', async () => {
  const { create, native, remembered } = saveFixture();
  const a = durableRequest(1), wrongInput = { ...a, operation: 'blocks_tidy' }, restarted = create();
  const durableA = exactTerminal(a);
  const durableObserve = async () => durableA;
  await assert.rejects(restarted.status(project, wrongInput, durableObserve), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
  assert.equal(remembered.has(a.requestId), false);

  // Project publication status runs the same registry lookup with an exact
  // original executor checked by the independent native observation port.
  const cold = await restarted.status(project, a, durableObserve);
  assert.equal(cold.publicationObservation.executor.hostPid, 101);
  assert.equal(cold.result.projectSaved, true);
  assert.equal(remembered.has(a.requestId), true);
  assert.equal(native.has(a.requestId), false, 'replacement physical root has none of the old project journal');
  const third = create();
  const noReplay = async () => assert.fail('a known old ID must not run against replacement content');
  await assert.rejects(third.start(project, a, [], noReplay), { code: 'PROJECT_SAVE_RECEIPT_EXPIRED' });
  await assert.rejects(third.start('/other-project', a, [], noReplay), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
});

test('an index write interrupted at completion can be retried by exact observation without repeating the writer', async () => {
  let indexWrites = 0;
  const { create, native, remembered } = saveFixture({ identityLimit: 1, settledIdentities: {
    remember(id, binding) {
      if (++indexWrites === 1) throw new Error('interrupted index write');
      remembered.set(id, binding);
    },
  } });
  const store = create(), a = durableRequest(1);
  let writes = 0;
  const original = await store.execute(project, a, [], async () => {
    writes++;
    const receipt = exactTerminal(a);
    native.set(a.requestId, receipt);
    return receipt.result;
  });
  assert.equal(original.saveReceipt.state, 'completed');
  assert.equal(remembered.has(a.requestId), false);
  assert.equal((await store.status(project, a)).saveReceipt.state, 'completed');
  assert.equal(remembered.has(a.requestId), true);
  assert.equal(indexWrites, 2);
  assert.equal(writes, 1);
});

test('a durable observation does not release a still-running in-memory writer', async () => {
  const { create, native, remembered } = saveFixture({ identityLimit: 1 });
  const store = create(), a = durableRequest(1), b = durableRequest(2), reading = deferred(), writer = deferred();
  const terminal = exactTerminal(a);
  const overlapping = store.status(project, a, () => reading.promise);
  assert.equal((await store.start(project, a, [], () => writer.promise)).saveReceipt.state, 'running');
  native.set(a.requestId, terminal);
  reading.resolve(terminal);
  assert.equal((await overlapping).saveReceipt.state, 'running');
  assert.equal(remembered.has(a.requestId), true);
  await assert.rejects(store.start(project, b, [], async () => assert.fail('the old writer still owns its slot')),
    { code: 'PROJECT_SAVE_RECEIPT_CAPACITY' });
  writer.resolve(terminal.result);
  assert.equal((await store.status(project, { ...a, waitMs: 100 })).saveReceipt.state, 'completed');
});
