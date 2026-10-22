const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Changed-source boundary checks with explicit project/callback/deployment
// doubles. No real Blockly UI, Worker, Session, account or Source Map is opened.
const source = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/blockly-simulator-web-publication.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const origin = 'https://app.example.test';
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function sourceCase(name, body) {
  test(name, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    try { await body(); }
    finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
  });
}
function fixture() {
  const activation = new AbortController(), calls = { reads: [], publications: [], reveals: [], sourceCloses: 0, scopeCloses: 0 };
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot', projectIdentity: 'original-project',
    workspaceIdentity: 'original-workspace', activeSceneId: 'main', activeArtifactRevision: 'a'.repeat(64),
    workspaceSourceSha256: 'b'.repeat(64) };
  const configuration = { schemaVersion: 1, kind: 'aily-simulator-host-project-debug-configuration-snapshot',
    projectIdentity: context.projectIdentity, artifactRevision: context.activeArtifactRevision,
    sourceMapRevision: 'd'.repeat(64), configuration: { fixtureOriginalConfiguration: true } };
  const scope = { activation: { path: '/normally-selected', projectSessionId: 'original-generation', signal: activation.signal },
    projectIdentity: context.projectIdentity, workspaceIdentity: context.workspaceIdentity,
    callbacks: {
      readContext: () => context,
      async readDebugConfiguration(request, signal) {
        assert.equal(this, scope.callbacks); calls.reads.push({ request, signal }); return configuration;
      },
    },
    editorCallbacks: {
      publishDebugLocation(event) { assert.equal(this, scope.editorCallbacks); calls.publications.push(event); return 'applied'; },
      revealSourceLocation(request) { assert.equal(this, scope.editorCallbacks); calls.reveals.push(request); return 'revealed'; },
    },
    project: { async handleInvocation() {}, async handleArtifactChunk() {} },
    requireCurrent() { assert.equal(this, scope); activation.signal.throwIfAborted(); },
    async close() { calls.scopeCloses++; },
  };
  const originalSource = { context, store: { originalStore: true }, artifact: null, async close() { calls.sourceCloses++; } };
  const startup = { identity: { runtimeId: 'original-runtime', version: '0.1.0', ownerKey: 'original-owner',
    projectIdentity: context.projectIdentity, sceneId: 'main', artifactRevision: context.activeArtifactRevision,
    subjectHash: 'c'.repeat(64) },
    resources: { trustedOrigin: origin, releaseBaseURL: origin + '/releases/' + 'e'.repeat(64) + '/', artifactBaseURL: null },
    instanceAuthority: {}, catalog: {}, workspace: null,
    debugger: { substitutedByDeployment: true } };
  const options = { openCurrentProjectScope: async () => scope, readContext: async () => context,
    deployment: { readStartup: async () => startup },
    loadSource: async () => ({ createHostCallbackProjectSource: async input => {
      assert.equal(input.adapter, scope.project); return originalSource;
    } }),
  };
  return { activation, calls, context, configuration, scope, options };
}
const event = status => ({ schemaVersion: 1, kind: 'aily-simulator-subapp-debug-location-hint',
  launchId: 'original-launch', sessionId: 'original-session', sceneId: 'main', sceneRevision: 'f'.repeat(64), sequence: 1,
  status, location: status === 'available' ? { file: 'sketch.ino', line: 10 } : null,
  sourceMapRevision: status === 'available' ? 'd'.repeat(64) : null,
  primaryBlockId: status === 'available' ? 'original-block' : null, mappings: [], mappingsTruncated: false,
  clearReason: status === 'clear' ? 'launch-closed' : null });

sourceCase('Browser debugger stays absent without the original complete scope capability, even if deployment supplies a substitute', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  for (const absent of ['both', 'editor']) {
    const f = fixture(); delete f.scope.editorCallbacks;
    if (absent === 'both') delete f.scope.callbacks.readDebugConfiguration;
    const publication = createBlocklySimulatorWebPublication(f.options);
    const selected = await publication.readPublication(f.scope.activation.path, new AbortController().signal);
    assert.equal(Object.hasOwn(selected.activation.startupOptions, 'debugger'), false);
    await publication.close(); assert.equal(f.calls.scopeCloses, 1);
  }
});

sourceCase('Browser publication borrows configuration and Editor methods from exactly the same original scope and preserves receivers', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), publication = createBlocklySimulatorWebPublication(f.options);
  const selected = await publication.readPublication(f.scope.activation.path, new AbortController().signal);
  const debuggerCallbacks = selected.activation.startupOptions.debugger;
  assert.equal(f.calls.reads.length, 0);
  const request = { projectIdentity: f.context.projectIdentity, artifactRevision: f.context.activeArtifactRevision,
    sourceMapRevision: f.configuration.sourceMapRevision };
  assert.equal(await debuggerCallbacks.readConfiguration(request, new AbortController().signal), f.configuration);
  assert.equal(f.calls.reads[0].request, request); assert.equal(f.calls.reads[0].signal.aborted, false);
  const location = event('available');
  assert.equal(await debuggerCallbacks.editorCallbacks.publishDebugLocation(location), 'applied');
  assert.equal(f.calls.publications[0], location);
  const reveal = { launchId: location.launchId, sessionId: location.sessionId, sceneId: location.sceneId,
    sceneRevision: location.sceneRevision, sourceMapRevision: location.sourceMapRevision, location: location.location, focus: true };
  assert.equal(await debuggerCallbacks.editorCallbacks.revealSourceLocation(reveal), 'revealed');
  assert.equal(f.calls.reveals[0], reveal);
  await publication.close(); assert.equal(f.calls.sourceCloses, 1); assert.equal(f.calls.scopeCloses, 1);
});

sourceCase('Revocation joins a late original debugger read and rejects ordinary Editor work while allowing its original marker clear', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), entered = deferred(), reply = deferred();
  f.scope.callbacks.readDebugConfiguration = async function(request, signal) {
    assert.equal(this, f.scope.callbacks); f.calls.reads.push({ request, signal }); entered.resolve(); return reply.promise;
  };
  const publication = createBlocklySimulatorWebPublication(f.options);
  const selected = await publication.readPublication(f.scope.activation.path, new AbortController().signal);
  const callbacks = selected.activation.startupOptions.debugger;
  const reading = callbacks.readConfiguration({ projectIdentity: f.context.projectIdentity,
    artifactRevision: f.context.activeArtifactRevision, sourceMapRevision: f.configuration.sourceMapRevision }, new AbortController().signal);
  void reading.catch(() => undefined); await entered.promise;
  f.activation.abort(new DOMException('Original generation ended.', 'AbortError'));
  let finished = false; const closing = publication.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(f.calls.scopeCloses, 0);
  assert.equal(f.calls.reads[0].signal.aborted, true);
  await assert.rejects(callbacks.editorCallbacks.publishDebugLocation(event('available')), { name: 'AbortError' });
  await assert.rejects(callbacks.editorCallbacks.revealSourceLocation({}), { name: 'AbortError' });
  assert.equal(f.calls.publications.length, 0); assert.equal(f.calls.reveals.length, 0);
  const clear = event('clear');
  assert.equal(await callbacks.editorCallbacks.publishDebugLocation(clear), 'applied');
  assert.equal(f.calls.publications[0], clear); assert.equal(finished, false);
  reply.resolve(f.configuration); await assert.rejects(reading, { name: 'AbortError' }); await closing;
  assert.equal(f.calls.sourceCloses, 1); assert.equal(f.calls.scopeCloses, 1);
  assert.equal(publication.snapshot().retainedCleanupResponsibility, false);
});

sourceCase('A revoked original Editor result is not accepted as current after its real callback settles', async () => {
  const { createBlocklySimulatorWebPublication } = await subject;
  const f = fixture(), entered = deferred(), reply = deferred();
  f.scope.editorCallbacks.publishDebugLocation = function(value) {
    assert.equal(this, f.scope.editorCallbacks); f.calls.publications.push(value); entered.resolve(); return reply.promise;
  };
  const publication = createBlocklySimulatorWebPublication(f.options);
  const selected = await publication.readPublication(f.scope.activation.path, new AbortController().signal);
  const publishing = selected.activation.startupOptions.debugger.editorCallbacks.publishDebugLocation(event('available'));
  void publishing.catch(() => undefined); await entered.promise;
  f.activation.abort(new DOMException('Original generation changed during publication.', 'AbortError'));
  const closing = publication.close(); reply.resolve('applied');
  await assert.rejects(publishing, { name: 'AbortError' }); await closing;
  assert.equal(f.calls.publications.length, 1); assert.equal(f.calls.scopeCloses, 1);
});
