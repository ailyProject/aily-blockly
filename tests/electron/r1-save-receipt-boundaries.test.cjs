'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { buildSync } = require('esbuild');

const repo = path.resolve(__dirname, '../..');
const output = path.join(repo, 'tests/test-results', `r1-save-receipt-${randomUUID()}`);
fs.mkdirSync(output, { recursive: true });
const source = 'src/app/services/domains/project/project-save-receipts.ts';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Pure manager only. This does not build product dist or import the runtime/UI.
const bundle = buildSync({ absWorkingDir: repo, entryPoints: [source], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', write: false, logLevel: 'silent' }).outputFiles[0].contents;
const compiled = path.join(output, 'manager.cjs'); fs.writeFileSync(compiled, bundle);
const { ProjectSaveReceipts, readProjectSaveRequest } = require(compiled);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
write(path.join(output, 'source-manifest.json'), { source, sha256: sha(fs.readFileSync(path.join(repo, source))),
  bundleSha256: sha(bundle), node: process.version,
  qualification: 'actual pure manager with controlled durable port; no native publication, journal, renderer or host claimed' });

const request = (operation = 'project_save') => ({ version: 2, requestId: `pub2-${randomUUID()}`, operation, waitMs: 0 });
const deferred = () => {
  let resolve; const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
};
const rootIdentity = project => {
  const stat = fs.statSync(project, { bigint: true });
  return { root: fs.realpathSync(project), dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
};

function fixture(name) {
  const folder = path.join(output, name), project = path.join(folder, 'project');
  fs.mkdirSync(project, { recursive: true });
  const original = rootIdentity(project), recordFile = path.join(project, 'controlled-manager-port.json');
  const lookups = [];
  const response = (input, state, marker) => ({ ok: true, operation: input.operation,
    saveReceipt: { version: 2, project, requestId: input.requestId, operation: input.operation, state },
    ...(marker ? { result: { controlledPortMarker: marker, nativePublicationProven: false } } : {}) });
  const put = value => write(recordFile, value);
  const lookup = async (currentProject, input) => {
    const actual = rootIdentity(currentProject);
    lookups.push({ actual, requestId: input.requestId });
    if (JSON.stringify(actual) !== JSON.stringify(original) || !fs.existsSync(recordFile)) return null;
    return JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  };
  const saveEvidence = value => write(path.join(folder, 'evidence.json'), value);
  return { folder, project, original, recordFile, lookups, lookup, response, put, saveEvidence };
}

function assertUnknown(response, input) {
  assert.equal(response.saveReceipt.version, 2);
  assert.equal(response.saveReceipt.requestId, input.requestId);
  assert.equal(response.saveReceipt.state, 'unknown');
  assert.equal(Object.hasOwn(response, 'result'), false);
}

test('capability v2 refuses a previously executed legacy ID before start/execute callback admission', async () => {
  const f = fixture('legacy-unknown'), input = { version: 1, requestId: 'legacy-original-id', operation: 'project_save' };
  let legacyCalls = 0, newCalls = 0;
  const legacy = new ProjectSaveReceipts();
  const before = await legacy.execute(f.project, input, ['legacy-turn'], async () => ({ oldMarker: ++legacyCalls }));
  assert.equal(before.saveReceipt.state, 'completed'); assert.equal(legacyCalls, 1);
  const manager = new ProjectSaveReceipts({ durableOnly: true, durableLookup: f.lookup });
  for (const method of ['start', 'execute']) await assert.rejects(manager[method](f.project, input,
    ['new-turn'], async () => ({ newMarker: ++newCalls })), { code: 'PROJECT_SAVE_PROTOCOL_UPGRADE_REQUIRED' });
  const observed = await manager.status(f.project, input);
  assert.equal(observed.saveReceipt.state, 'unknown'); assert.equal(Object.hasOwn(observed, 'result'), false);
  assert.equal(newCalls, 0); assert.equal(f.lookups.length, 0, 'v1 must not be promoted through the v2 lookup');
  f.saveEvidence({ legacyCalls, newCalls, observed, proof: 'registry routing only; legacy callback did not publish a document' });
});

test('completed RAM never supplies root A success after the same path becomes an empty physical root B', async () => {
  const f = fixture('empty-replacement'), input = request(); let calls = 0;
  const manager = new ProjectSaveReceipts({ durableOnly: true, durableLookup: f.lookup });
  const run = async () => {
    calls++; f.put(f.response(input, 'completed', 'root-A-controlled-port'));
    return { memoryOnlyMarker: 'RAM-is-not-a-source-receipt' };
  };
  const first = await manager.execute(f.project, input, ['same-owner'], run);
  assert.equal(first.result.controlledPortMarker, 'root-A-controlled-port');
  assert.equal(first.result.nativePublicationProven, false);
  const moved = path.join(f.folder, 'original-root-A');
  fs.renameSync(f.project, moved); fs.mkdirSync(f.project);
  const replacement = rootIdentity(f.project);
  assert.notDeepEqual(replacement, f.original);
  assert.notEqual(replacement.ino, f.original.ino, 'test must replace the actual directory, not only clear an in-memory map');
  assert.equal(fs.readdirSync(f.project).length, 0);
  const results = [];
  results.push(await manager.status(f.project, input));
  for (const method of ['start', 'execute']) results.push(await manager[method](f.project, input, ['same-owner'], run));
  for (const response of results) assertUnknown(response, input);
  assert.equal(calls, 1, 'a consumed ID must not reenter its callback');
  assert.ok(fs.existsSync(path.join(moved, 'controlled-manager-port.json')));
  assert.equal(fs.readdirSync(f.project).length, 0, 'observation did not materialize or alter the new root');
  f.saveEvidence({ original: f.original, replacement, calls, results,
    proof: 'physical root identity changed; controlled port intentionally returned null, not a forged native result' });
});

test('v2 without the durable adapter cannot enter a callback', async () => {
  const f = fixture('adapter-required'), manager = new ProjectSaveReceipts({ durableOnly: true });
  let calls = 0;
  for (const method of ['start', 'execute']) await assert.rejects(manager[method](f.project, request(), [], async () => ++calls),
    { code: 'PROJECT_SAVE_DURABILITY_UNAVAILABLE' });
  assert.equal(calls, 0);
});

test('wire version and pub2 namespace cannot be mixed or promoted by the request reader', () => {
  const current = request('blocks_tidy');
  assert.deepEqual(readProjectSaveRequest(current), current);
  assert.equal(readProjectSaveRequest({ version: 1, requestId: 'legacy-id', operation: 'project_save' }).version, 1);
  for (const invalid of [
    { ...current, version: 1 }, { ...current, requestId: 'legacy-id' },
    { ...current, requestId: `pub2-${randomUUID()}`, extra: true }, { ...current, version: 3 },
  ]) assert.throws(() => readProjectSaveRequest(invalid), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
});

test('pending and completed observations follow the durable port even after the callback returned a misleading success', async () => {
  const f = fixture('pending-to-port-completion'), input = request();
  const manager = new ProjectSaveReceipts({ durableOnly: true, durableLookup: f.lookup });
  const entered = deferred(), release = deferred(); let calls = 0;
  const execution = manager.execute(f.project, input, ['original-turn'], async () => {
    calls++; entered.resolve(); await release.promise;
    return { ok: true, projectSaved: true, publication: { status: 'COMMITTED' }, misleadingMemoryOnly: true };
  });
  await entered.promise;
  const before = await manager.status(f.project, input);
  assert.ok(['queued', 'running'].includes(before.saveReceipt.state));
  assert.equal(Object.hasOwn(before, 'result'), false);
  f.put(f.response(input, 'running'));
  release.resolve();
  const callbackFinished = await execution;
  assert.equal(callbackFinished.saveReceipt.state, 'running');
  assert.equal(Object.hasOwn(callbackFinished, 'result'), false, 'RAM COMMITTED text cannot supersede the durable port');
  fs.unlinkSync(f.recordFile);
  assertUnknown(await manager.status(f.project, input), input);
  f.put(f.response(input, 'completed', 'only-the-controlled-port-completed'));
  const after = await manager.status(f.project, input);
  assert.equal(after.saveReceipt.state, 'completed');
  assert.equal(after.result.controlledPortMarker, 'only-the-controlled-port-completed');
  assert.equal(Object.hasOwn(after.result, 'misleadingMemoryOnly'), false);
  assert.equal(calls, 1);
  f.saveEvidence({ before, callbackFinished, after, calls,
    proof: 'a controlled port tests authority precedence; no real source commit is asserted' });
});

test('a new registry observes the already supplied durable result and never admits another callback', async () => {
  const f = fixture('registry-recreated'), input = request('blocks_tidy');
  f.put(f.response(input, 'completed', 'original-operation-port-result'));
  const manager = new ProjectSaveReceipts({ durableOnly: true, durableLookup: f.lookup }); let calls = 0;
  for (const method of ['start', 'execute']) {
    const observed = await manager[method](f.project, input, ['different-runtime'], async () => ++calls);
    assert.equal(observed.result.controlledPortMarker, 'original-operation-port-result');
  }
  assert.equal(calls, 0);
});

test('a mismatched port request, operation, project or wire version cannot admit a callback', async () => {
  for (const change of ['request', 'operation', 'project', 'version']) {
    const f = fixture(`foreign-port-${change}`), input = request();
    const value = f.response(input, 'completed', 'foreign-controlled-result');
    if (change === 'request') value.saveReceipt.requestId = `pub2-${randomUUID()}`;
    if (change === 'operation') value.saveReceipt.operation = 'blocks_tidy';
    if (change === 'project') value.saveReceipt.project = path.join(f.folder, 'other-project');
    if (change === 'version') value.saveReceipt.version = 1;
    f.put(value);
    const manager = new ProjectSaveReceipts({ durableOnly: true, durableLookup: f.lookup }); let calls = 0;
    await assert.rejects(manager.execute(f.project, input, [], async () => ++calls), { code: 'PROJECT_SAVE_RECEIPT_CONFLICT' });
    assert.equal(calls, 0);
  }
});

process.on('exit', () => console.log(`R1 save manager artifacts: ${output}`));
