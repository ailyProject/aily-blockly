'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { LibraryDependencies } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');

function fixture(t, intercept) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-lib-original-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageFile = path.join(root, 'package.json');
  fs.writeFileSync(packageFile, '{"name":"contract-project","version":"1.0.0"}\n');
  const calls = [];
  const api = new LibraryDependencies({ run: async (project, request) => {
    calls.push({ id: request.environmentRequestId, save: !!request.save, sources: !!request.materializeSources });
    await intercept?.(request);
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (request.install?.length) {
      manifest.dependencies = { ...manifest.dependencies };
      for (const spec of request.install) manifest.dependencies[spec] = '1.0.0';
    }
    return { manifest };
  } });
  const sessions = new LibraryDependencySessions(api, { cancellationWaitMs: 25 });
  const install = (name, deadline) => ({
    requestId: 'env1-' + randomUUID(), action: 'install', packages: [name], ...(deadline ? { expiresAt: deadline } : {})
  });
  const run = (operation, input) => sessions.run(operation, root, input);
  return { root, api, calls, install, run, manifest: () => JSON.parse(fs.readFileSync(packageFile, 'utf8')) };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Request remained behind the original writer')), 150);
    })]);
  } finally { clearTimeout(timer); }
}

test('a busy identified install is never queued, and old status is readable during the writer', async t => {
  const entered = Promise.withResolvers(), hold = Promise.withResolvers();
  const f = fixture(t, async request => {
    if (request.install?.includes('original')) { entered.resolve(); await hold.promise; }
  });
  const a = f.install('original'), b = f.install('must-not-run');
  const original = f.run('mutate', a);
  void original.catch(() => {});
  let attempt;
  try {
    await entered.promise;
    const receipt = await within(f.run('observeEnvironment', { requestId: a.requestId }));
    assert.equal(receipt.environment.requestId, a.requestId);
    assert.equal(receipt.environment.status, 'unknown');
    attempt = f.run('mutate', b);
    await assert.rejects(within(attempt), { code: 'LIBRARY_OPERATION_BUSY' });
  } finally {
    hold.resolve();
    await original.catch(() => {});
    await attempt?.catch(() => {});
  }
  const { environment: refused } = await f.run('mutate', b);
  assert.equal(refused.status, 'not-started');
  assert.equal(refused.code, 'LIBRARY_OPERATION_BUSY');
  assert.ok(!f.calls.some(item => item.id === b.requestId));
  assert.equal(f.manifest().dependencies?.['must-not-run'], undefined);
  const c = f.install('next');
  await f.run('mutate', c);
  assert.equal(f.manifest().dependencies.next, '1.0.0');
});

test('an expired request records refusal without claiming execution or starting a worker', async t => {
  const f = fixture(t);
  const original = f.install('expired', Date.now() - 1000);
  await assert.rejects(f.run('mutate', original), { code: 'LIBRARY_OPERATION_EXPIRED' });
  const { environment } = await f.run('observeEnvironment', { requestId: original.requestId });
  assert.equal(environment.status, 'not-started');
  assert.equal(environment.code, 'LIBRARY_OPERATION_EXPIRED');
  assert.deepEqual(f.api.environment.pending(f.root), []);
  assert.deepEqual(f.calls, []);
  await f.run('mutate', f.install('next'));
  assert.equal(f.manifest().dependencies.next, '1.0.0');
});

test('Stop between source materialization and publication fences the original save', async t => {
  const entered = Promise.withResolvers(), hold = Promise.withResolvers();
  let first = true;
  const f = fixture(t, async request => {
    if (request.materializeSources && first) { first = false; entered.resolve(); await hold.promise; }
  });
  const a = f.install('original');
  const original = f.run('mutate', a);
  void original.catch(() => {});
  try {
    await entered.promise;
    const stop = await within(f.run('cancelEnvironment', { requestId: a.requestId }));
    assert.equal(stop.environment.requestId, a.requestId);
    assert.equal(stop.environment.status, 'unknown');
    assert.equal(f.manifest().dependencies, undefined);
  } finally {
    hold.resolve();
    await original.catch(() => {});
  }
  await assert.rejects(original, { code: 'LIBRARY_OPERATION_CANCELLED' });
  assert.ok(!f.calls.some(item => item.id === a.requestId && item.save));
  assert.equal((await f.run('observeEnvironment', { requestId: a.requestId })).environment.status, 'restored');
  await f.run('mutate', f.install('next'));
  assert.equal(f.manifest().dependencies.next, '1.0.0');
});

test('identified install cannot publish a staged UI change between preparation and admission', async t => {
  const f = fixture(t);
  const original = f.install('agent', Date.now() + 2000);
  const history = await f.run('historyBegin', { packages: original.packages, requestId: original.requestId, expiresAt: original.expiresAt });
  try {
    assert.ok(history.token);
    await f.api.mutate(f.root, { action: 'install', packages: ['manual'] });
    const staged = f.api.states.get(f.root), calls = f.calls.length;
    assert.ok(staged);
    await assert.rejects(f.run('mutate', original), { code: 'LIBRARY_CHANGES_UNSAVED', commandDispatched: false });
    assert.equal(f.api.states.get(f.root), staged);
    const { environment } = await f.run('observeEnvironment', { requestId: original.requestId });
    assert.equal(environment.status, 'not-started');
    assert.equal(environment.code, 'LIBRARY_CHANGES_UNSAVED');
    assert.equal(f.calls.length, calls);
    assert.equal(f.manifest().dependencies, undefined);
  } finally { await f.run('historyDiscard', { token: history.token }); }
});
