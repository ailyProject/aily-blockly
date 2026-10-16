const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { build } = require('esbuild');

// Actual TypeScript kernel in memory only: no dist/buildinfo, Electron or project writes.
const repository = path.resolve(__dirname, '..');
let AbsBaselineStore, absBaselineKey, absJson, createAbsProjection, hashAbsText, inspectAbsGeneration;
const ready = build({ stdin: { contents: [
  "export { AbsBaselineStore, absBaselineKey } from './src/app/integrations/blockly/abs/abs-baseline-store';",
  "export { absJson, createAbsProjection, hashAbsText } from './src/app/integrations/blockly/abs/abs-identity-map';",
  "export { inspectAbsGeneration } from './src/app/integrations/blockly/abs/abs-generation-inspection';",
].join('\n'), resolveDir: repository, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'error',
  plugins: [{ name: 'pure-kernel-barrels', setup(builder) {
    // Re-export the real pure implementations, excluding application/DOM barrel side effects.
    builder.onResolve({ filter: /^@(?:domain\/project(?:\/project-data)?|shared)\/public-api$/ }, args => ({ path: args.path, namespace: 'pure-kernel' }));
    builder.onLoad({ filter: /.*/, namespace: 'pure-kernel' }, args => ({ loader: 'ts', resolveDir: repository,
      contents: args.path === '@domain/project/project-data/public-api'
        ? "export { canonicalProjectJsonStringify } from './src/app/services/domains/project/project-document-json';"
        : args.path.startsWith('@domain') ? [
        "export { assertNoOversizedInlineValues } from './src/app/services/domains/project/project-data/project-data-policy';",
        "export { canonicalJsonStringify } from './src/app/services/domains/project/project-data/project-data-codec.registry';",
      ].join('\n') : "export { readAbsSingleQuotedToken, readAbsJsonToken } from './src/app/services/shared/abs/abs-json-tokens';" }));
  } }],
}).then(result => {
  const record = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, record, record.exports);
  ({ AbsBaselineStore, absBaselineKey, absJson, createAbsProjection, hashAbsText, inspectAbsGeneration } = record.exports);
});
const scope = { projectKey: 'fixture-project', pageId: 'main' };
const guard = () => {};

class MemoryStorage {
  files = new Map(); writes = []; held = false; refuse = null; onWrite = () => {};
  async read(key) { return this.files.get(key) ?? null; }
  async withLock(callback) {
    assert.equal(this.held, false, 'no nested storage lock'); this.held = true;
    try { return await callback(this); } finally { this.held = false; }
  }
  async replace(key, expected, value) {
    assert.equal(this.held, true, 'every mutation uses the callback-scoped lock');
    const before = await this.read(key);
    if (key === this.refuse || (before === null ? null : await hashAbsText(before)) !== expected) return false;
    if (value === null) this.files.delete(key); else this.files.set(key, value);
    this.writes.push(key); this.onWrite(key); return true;
  }
}

async function fixture(mode = 'import') {
  await ready;
  const storage = new MemoryStorage(), store = new AbsBaselineStore(storage, scope);
  const workspace = { blocks: { blocks: [{ type: 'root', id: 'one', fields: { VALUE: 'new' } }] } };
  const abi = JSON.stringify(workspace, null, 2);
  const original = { abi: mode === 'export' ? abi : '{"old":true}', abs: '# ABS Schema: 2\nold()\r\n', map: '{"old":true}' };
  for (const [key, value] of Object.entries(original)) storage.files.set({ abi: 'project.abi', abs: 'project.abs', map: 'project.abs.map.json' }[key], value);
  const projection = await createAbsProjection(workspace, { document: { pages: [workspace] }, generation: 'committed1',
    baselineRef: absBaselineKey('committed1'), scope, savedAbiHash: await hashAbsText(absJson(workspace)) });
  await store.stage({ mode, inputAbs: mode === 'import' ? original.abs : null, abi: mode === 'import' ? abi : null, expected: original, projection });
  await store.commit('committed1', guard, async (value, expected, locked) => {
    assert.equal(await locked.replace('project.abi', expected, value), true);
  });
  const target = await store.captureDisk(), committed = await storage.read('committed.json');
  for (const [key, value] of Object.entries(original)) storage.files.set({ abi: 'project.abi', abs: 'project.abs', map: 'project.abs.map.json' }[key], value);
  storage.writes = [];
  return { storage, store, target, committed, original, projection };
}

test('explicit committed repair archives exact original bytes and restores three mirrors without a new generation or pointer write', async () => {
  const f = await fixture(), offer = await f.store.inspectCommittedRestoration();
  assert.equal(offer.pending, false); assert.equal(offer.generation, 'committed1');
  const result = await f.store.restoreCommittedMirrors(offer.generation, offer.token, guard);
  assert.equal(result.publication.status, 'COMMITTED');
  assert.deepEqual(await f.store.captureDisk(), f.target);
  assert.equal(await f.storage.read('committed.json'), f.committed);
  assert.equal(f.storage.writes.includes('committed.json'), false);
  assert.equal(f.storage.writes.some(key => key.startsWith('baselines/')), false);
  assert.equal(await f.storage.read('prepared.json'), null);
  const archive = JSON.parse(await f.storage.read(`restorations/${result.restorationArchive.id}.json`));
  assert.deepEqual(archive.original, f.original);
  assert.equal(archive.committed, f.committed);
  assert.deepEqual(result.restorationArchive.hashes, offer.hashes);
  assert.equal(await f.store.inspectCommittedRestoration(), undefined);
});

test('token rejects changed mirrors, wrong generation and changed committed pointer without publication', async () => {
  for (const mutation of ['mirror', 'generation', 'pointer']) {
    const f = await fixture(), offer = await f.store.inspectCommittedRestoration();
    if (mutation === 'mirror') f.storage.files.set('project.abs', 'external newer bytes');
    if (mutation === 'pointer') f.storage.files.set('committed.json', f.committed + '\n');
    await assert.rejects(f.store.restoreCommittedMirrors(mutation === 'generation' ? 'different' : offer.generation, offer.token, guard));
    assert.deepEqual(f.storage.writes, []);
    if (mutation === 'mirror') assert.equal(await f.storage.read('project.abs'), 'external newer bytes');
  }
});

test('all three mirror CAS failure boundaries retain a recoverable prepared record across a new store instance', async t => {
  for (const key of ['project.abi', 'project.abs', 'project.abs.map.json']) await t.test(key, async () => {
    const f = await fixture(), offer = await f.store.inspectCommittedRestoration(); f.storage.refuse = key;
    await assert.rejects(f.store.restoreCommittedMirrors(offer.generation, offer.token, guard), { code: 'ABS_TRANSACTION_CONFLICT' });
    assert.equal(JSON.parse(await f.storage.read('prepared.json')).kind, 'aily-abs-committed-mirror-restoration');
    const reopened = new AbsBaselineStore(f.storage, scope);
    assert.equal(await reopened.inspectCommittedRestoration(), undefined);
    await assert.rejects(reopened.restoreCommittedMirrors(offer.generation, offer.token, guard), { code: 'ABS_TRANSACTION_PENDING' });
    assert.equal((await reopened.inspectPending()).status, 'MIRROR_PENDING');
    f.storage.refuse = null;
    assert.equal((await reopened.recover(guard)).status, 'COMMITTED');
    assert.deepEqual(await reopened.captureDisk(), f.target);
    assert.equal(await f.storage.read('committed.json'), f.committed);
  });
});

test('a third-party new edit during restoration is preserved and recover refuses to overwrite it', async () => {
  const f = await fixture(), offer = await f.store.inspectCommittedRestoration();
  f.storage.onWrite = key => { if (key === 'project.abi') f.storage.files.set('project.abs', 'third-party edit'); };
  await assert.rejects(f.store.restoreCommittedMirrors(offer.generation, offer.token, guard), { code: 'ABS_TRANSACTION_CONFLICT' });
  assert.equal(await f.storage.read('project.abs'), 'third-party edit');
  f.storage.onWrite = () => {};
  await assert.rejects(new AbsBaselineStore(f.storage, scope).recover(guard), { code: 'ABS_TRANSACTION_CONFLICT' });
  assert.ok(await f.storage.read('prepared.json'));
});

test('a member reverting to original after its write cannot pass final full-target proof or clear the journal', async () => {
  const f = await fixture(), offer = await f.store.inspectCommittedRestoration();
  f.storage.onWrite = key => { if (key === 'project.abs.map.json') f.storage.files.set('project.abi', f.original.abi); };
  await assert.rejects(f.store.restoreCommittedMirrors(offer.generation, offer.token, guard), { code: 'ABS_TRANSACTION_CONFLICT' });
  assert.ok(await f.storage.read('prepared.json')); assert.equal(await f.storage.read('project.abi'), f.original.abi);
  f.storage.onWrite = () => {};
  assert.equal((await new AbsBaselineStore(f.storage, scope).recover(guard)).status, 'COMMITTED');
});

test('existing pending generations, corrupt immutable authority and foreign scope never authorize repair', async () => {
  const f = await fixture(); f.storage.files.set('prepared.json', 'unrelated journal');
  assert.equal(await f.store.inspectCommittedRestoration(), undefined);
  await assert.rejects(f.store.restoreCommittedMirrors('committed1', 'sha256:' + 'a'.repeat(64), guard), { code: 'ABS_TRANSACTION_PENDING' });
  f.storage.files.delete('prepared.json');
  assert.equal(await new AbsBaselineStore(f.storage, { ...scope, pageId: 'other' }).inspectCommittedRestoration(), undefined);
  const foreign = await inspectAbsGeneration(new AbsBaselineStore(f.storage, { ...scope, pageId: 'other' }), { ...scope, pageId: 'other' });
  assert.ok(foreign.diagnostics.issues.includes('ABS_SCOPE_INVALID'));
  f.storage.files.set(absBaselineKey('committed1'), (await f.storage.read(absBaselineKey('committed1'))) + '\n');
  await assert.rejects(f.store.inspectCommittedRestoration(), { code: 'ABS_BASELINE_CORRUPT' });
});

test('an export without exact saved ABI bytes keeps normal inspect diagnostics but has no repair offer', async () => {
  const f = await fixture('export');
  f.storage.files.set('project.abi', '{"unrelated":true}');
  const inspection = await inspectAbsGeneration(f.store, scope);
  assert.equal(inspection.diagnostics.restoreCommitted, undefined);
  assert.ok(inspection.diagnostics.issues.includes('ABS_MAP_INVALID'));
});
