const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Source-boundary cases with explicit callback/deployment doubles. They do not
// open the actual Blockly UI, a project, filesystem, account, Worker or MCU.
const text = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/blockly-simulator-web-publication.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(text, { mode: 'transform' })).toString('base64'));
const origin = 'https://app.example.test';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function publicationTest(name, body) {
  test(name, async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    try { await body(); }
    finally {
      if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
      else delete globalThis.location;
    }
  });
}

function fixture() {
  const session = new AbortController(), request = new AbortController();
  const calls = { opened: 0, contexts: 0, startup: 0, modules: [], factories: [],
    sourceCloses: 0, scopeCloses: 0, order: [] };
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot',
    projectIdentity: 'project-original', workspaceIdentity: 'workspace-original', activeSceneId: 'main',
    activeArtifactRevision: 'artifact-original', workspaceSourceSha256: 'a'.repeat(64) };
  const activation = { path: '/normally-opened', projectSessionId: 'original-generation', signal: session.signal,
    requireCurrent() { session.signal.throwIfAborted(); } };
  const scope = { activation, projectIdentity: context.projectIdentity, workspaceIdentity: context.workspaceIdentity,
    callbacks: { async readContext() { return context; } },
    project: { async handleInvocation() {}, async handleArtifactChunk() {} },
    requireCurrent() { assert.equal(this, scope); activation.requireCurrent(); },
    async close() { calls.scopeCloses++; calls.order.push('scope'); } };
  const store = Object.freeze({ originalSceneStore: true });
  const artifact = Object.freeze({ kind: 'sealed-port', originalArtifactAuthority: true });
  const source = { context, store, artifact,
    async close() { calls.sourceCloses++; calls.order.push('source'); } };
  const startup = { identity: { runtimeId: 'runtime-original', version: 'version-original', ownerKey: 'owner-original',
    projectIdentity: context.projectIdentity, sceneId: context.activeSceneId,
    artifactRevision: context.activeArtifactRevision, subjectHash: 'b'.repeat(64) },
    resources: { trustedOrigin: origin, releaseBaseURL: `${origin}/releases/${'c'.repeat(64)}/`, artifactBaseURL: null },
    authorization: { original: true }, instanceAuthority: { original: true }, catalog: { original: true }, workspace: null };
  const module = { async createHostCallbackProjectSource(input) { calls.factories.push(input); return source; } };
  const deployment = { async readStartup(input) {
    assert.equal(this, deployment); calls.startup++; assert.equal(input.activation, activation);
    assert.deepEqual(input.context, context); assert.notEqual(input.context, context);
    input.signal.throwIfAborted(); return startup;
  } };
  const options = {
    async openCurrentProjectScope(signal) {
      assert.equal(this, options); calls.opened++; signal.throwIfAborted(); return scope;
    },
    deployment,
    async readContext(input, signal) {
      assert.equal(this, options); assert.equal(input, scope); calls.contexts++; signal.throwIfAborted(); return context;
    },
    async loadSource(url) { assert.equal(this, options); calls.modules.push(url); return module; },
  };
  return { session, request, calls, context, activation, scope, source, startup, module, options };
}

publicationTest('publication borrows the exact original callback Scene Store and sealed Artifact without IDB', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), publication = createBlocklySimulatorWebPublication(f.options);
  const result = await publication.readPublication(f.activation.path, f.request.signal);
  assert.equal(result.projectPath, f.activation.path);
  assert.equal(result.activation.project.context, f.context);
  assert.equal(result.activation.project.store, f.source.store);
  assert.equal(result.activation.project.artifact, f.source.artifact);
  assert.equal('storage' in result.activation.project, false);
  assert.deepEqual(f.calls.modules, [f.startup.resources.releaseBaseURL + 'host-project-source.mjs']);
  const [input] = f.calls.factories;
  assert.equal(input.adapter, f.scope.project); assert.equal(input.context, f.context);
  assert.equal(input.activation, input.signal); input.owner.requireCurrent();
  assert.equal(f.calls.opened, 1); assert.equal(f.calls.contexts, 1); assert.equal(f.calls.startup, 1);
  await result.activation.project.ownedStore.close();
  assert.deepEqual(f.calls.order, ['source', 'scope']);
  assert.equal(f.session.signal.aborted, false);
  assert.throws(() => result.activation.startupOptions.owner.requireCurrent(), { name: 'AbortError' });
  await publication.close();
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false);
});

publicationTest('missing active scope rejects without reading deployment or importing an adapter', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(); f.options.openCurrentProjectScope = async () => null;
  const publication = createBlocklySimulatorWebPublication(f.options);
  await assert.rejects(publication.readPublication(f.activation.path, f.request.signal), { code: 'project-unavailable' });
  assert.equal(f.calls.startup, 0); assert.equal(f.calls.modules.length, 0);
  await publication.close();
});

publicationTest('a different requested project path cannot publish the currently selected scope', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), publication = createBlocklySimulatorWebPublication(f.options);
  await assert.rejects(publication.readPublication('/foreign-project', f.request.signal), /different project/);
  assert.equal(f.calls.contexts, 0); assert.equal(f.calls.modules.length, 0);
  assert.equal(f.calls.scopeCloses, 1); await publication.close();
});

publicationTest('foreign project, workspace or Scene context fails before deployment and module loading', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  for (const change of [{ projectIdentity: 'foreign' }, { workspaceIdentity: 'foreign' }, { activeSceneId: 'other' }]) {
    const f = fixture(); f.options.readContext = async () => ({ ...f.context, ...change });
    const publication = createBlocklySimulatorWebPublication(f.options);
    await assert.rejects(publication.readPublication(f.activation.path, f.request.signal), /outside the captured project/);
    assert.equal(f.calls.startup, 0); assert.equal(f.calls.modules.length, 0);
    assert.equal(f.calls.scopeCloses, 1); await publication.close();
  }
});

publicationTest('same-path generation abort revokes the returned owner and closes only its borrowed scope', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), publication = createBlocklySimulatorWebPublication(f.options);
  const result = await publication.readPublication(f.activation.path, f.request.signal);
  f.session.abort(new DOMException('Same path reopened with another generation.', 'AbortError'));
  assert.equal(result.projectPath, '/normally-opened'); assert.equal(result.activation.activation.aborted, true);
  assert.throws(() => result.activation.startupOptions.owner.requireCurrent(), { name: 'AbortError' });
  await publication.close();
  assert.deepEqual(f.calls.order, ['source', 'scope']);
  assert.equal(publication.snapshot().retainedCallers, 0);
});

publicationTest('close joins an in-flight module load and never invokes its factory after cancellation', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), entered = deferred(), loading = deferred();
  f.options.loadSource = async () => { entered.resolve(); return loading.promise; };
  const publication = createBlocklySimulatorWebPublication(f.options);
  const reading = publication.readPublication(f.activation.path, f.request.signal); void reading.catch(() => undefined);
  await entered.promise;
  let closed = false; const closing = publication.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.calls.scopeCloses, 0);
  loading.resolve(f.module);
  await assert.rejects(reading, { name: 'AbortError' }); await closing;
  assert.equal(f.calls.factories.length, 0); assert.equal(f.calls.sourceCloses, 0);
  assert.equal(f.calls.scopeCloses, 1); assert.equal(publication.snapshot().retainedCallers, 0);
});

publicationTest('close retains and joins a scope-opening read before its late original scope is returned', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), entered = deferred(), opening = deferred();
  f.options.openCurrentProjectScope = async () => { entered.resolve(); return opening.promise; };
  const publication = createBlocklySimulatorWebPublication(f.options);
  const reading = publication.readPublication(f.activation.path, f.request.signal); void reading.catch(() => undefined);
  await entered.promise;
  let closed = false; const closing = publication.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false); assert.equal(publication.snapshot().retainedCleanupResponsibility, true);
  assert.equal(publication.snapshot().pendingReads, 1);
  opening.resolve(f.scope);
  await assert.rejects(reading, { name: 'AbortError' }); await closing;
  assert.equal(f.calls.modules.length, 0); assert.equal(f.calls.scopeCloses, 1);
  assert.equal(publication.snapshot().pendingReads, 0);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false);
});

publicationTest('late factory results are captured and source cleanup completes before scope cleanup', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), entered = deferred(), creating = deferred();
  f.module.createHostCallbackProjectSource = async input => { f.calls.factories.push(input); entered.resolve(); return creating.promise; };
  const publication = createBlocklySimulatorWebPublication(f.options);
  const reading = publication.readPublication(f.activation.path, f.request.signal); void reading.catch(() => undefined);
  await entered.promise;
  let closed = false; const closing = publication.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.deepEqual(f.calls.order, []);
  creating.resolve(f.source);
  await assert.rejects(reading, { name: 'AbortError' }); await closing;
  assert.deepEqual(f.calls.order, ['source', 'scope']);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false);
});

publicationTest('failed original source cleanup remains owned until an explicit close retry succeeds', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(); f.source.close = async () => {
    f.calls.sourceCloses++; if (f.calls.sourceCloses === 1) throw Error('Original source close refused.');
    f.calls.order.push('source');
  };
  const publication = createBlocklySimulatorWebPublication(f.options);
  await publication.readPublication(f.activation.path, f.request.signal);
  await assert.rejects(publication.close(), /cleanup remains unconfirmed/);
  assert.equal(f.calls.sourceCloses, 1); assert.equal(f.calls.scopeCloses, 1);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, true);
  assert.equal(publication.snapshot().NodeBusinessACK, false); assert.equal(publication.snapshot().MainBusinessACK, false);
  await publication.close();
  assert.equal(f.calls.sourceCloses, 2); assert.equal(f.calls.scopeCloses, 1);
  assert.deepEqual(f.calls.order, ['scope', 'source']);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false);
});

publicationTest('failed scope cleanup retries that scope without closing an already-retired source twice', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(); f.scope.close = async () => {
    f.calls.scopeCloses++; if (f.calls.scopeCloses === 1) throw Error('Original scope close refused.');
  };
  const publication = createBlocklySimulatorWebPublication(f.options);
  await publication.readPublication(f.activation.path, f.request.signal);
  await assert.rejects(publication.close(), /cleanup remains unconfirmed/);
  assert.equal(f.calls.sourceCloses, 1); assert.equal(f.calls.scopeCloses, 1);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, true);
  await publication.close();
  assert.equal(f.calls.sourceCloses, 1); assert.equal(f.calls.scopeCloses, 2);
  assert.equal(publication.snapshot().WorkerPhysicalExitConfirmed, false);
});

publicationTest('foreign origin, noncanonical release and decorated resource URLs are rejected before import', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const bases = [`https://foreign.example.test/releases/${'c'.repeat(64)}/`,
    `${origin}/other/`, `${origin}/releases/${'C'.repeat(64)}/`,
    `${origin}/releases/${'c'.repeat(64)}/?alternative=1`, `${origin}/releases/${'c'.repeat(64)}/#fragment`];
  for (const releaseBaseURL of bases) {
    const f = fixture(); f.startup.resources.releaseBaseURL = releaseBaseURL;
    const publication = createBlocklySimulatorWebPublication(f.options);
    await assert.rejects(publication.readPublication(f.activation.path, f.request.signal), /exact project.*trusted release/);
    assert.equal(f.calls.modules.length, 0); assert.equal(f.calls.scopeCloses, 1); await publication.close();
  }
});

publicationTest('deployment cannot replace the selected project, Scene, Artifact generation or sealed-source policy', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const changes = [f => { f.startup.identity.projectIdentity = 'foreign'; },
    f => { f.startup.identity.sceneId = 'other'; }, f => { f.startup.identity.artifactRevision = 'stale-artifact'; },
    f => { f.startup.resources.trustedOrigin = 'https://foreign.example.test'; },
    f => { f.startup.resources.artifactBaseURL = origin + '/artifacts/'; }];
  for (const change of changes) {
    const f = fixture(); change(f); const publication = createBlocklySimulatorWebPublication(f.options);
    await assert.rejects(publication.readPublication(f.activation.path, f.request.signal), /exact project.*trusted release/);
    assert.equal(f.calls.factories.length, 0); assert.equal(f.calls.scopeCloses, 1); await publication.close();
  }
});

publicationTest('a failed adapter factory closes the original scope without inventing a source close', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(); f.module.createHostCallbackProjectSource = async () => { throw Error('Original adapter factory failed.'); };
  const publication = createBlocklySimulatorWebPublication(f.options);
  await assert.rejects(publication.readPublication(f.activation.path, f.request.signal), /Original adapter factory failed/);
  assert.equal(f.calls.sourceCloses, 0); assert.equal(f.calls.scopeCloses, 1);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false); await publication.close();
});
