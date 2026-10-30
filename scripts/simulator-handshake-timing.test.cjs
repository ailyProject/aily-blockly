const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const base = path.join(__dirname, '../src/app/integrations/simulator');
const load = file => import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'transform' })).toString('base64'));
const subject = load(path.join(base, 'blockly-simulator-web-publication.ts'));
const simulatorRoot = process.env.AILY_SIMULATOR_SOURCE_ROOT || path.resolve(__dirname, '../../aily-simulator');
const helper = load(path.join(simulatorRoot, 'packages/simulator-gateway/src/host-callback-handshake-timing.ts'));
const origin = 'https://handshake.example.test';
const phases = ['caller.context-before', 'caller.descriptor', 'caller.context-after',
  'open.context-before', 'open.descriptor-refresh', 'open.context-after', 'caller.close-join'];
const privateFree = value => assert(!/private-value|ownerKey|docNonce|privatePath|artifactReference/u.test(JSON.stringify(value)));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function counters() {
  const timing = (await helper).createHostCallbackHandshakeTiming({ now: () => 0 });
  await timing.observe('caller.descriptor', () => Promise.resolve());
  const snapshot = structuredClone(timing.snapshot());
  snapshot.ownerKey = 'private-value'; snapshot.rows[0].privatePath = 'private-value';
  return snapshot;
}
test('new handshake projection is detached, numeric, fixed and compatible with old caller snapshots', async () => {
  const project = (await subject).projectBlocklyArtifactReadTiming;
  const input = { callersObserved: 1, callersTruncated: false, callers: [{ handshakeTiming: await counters(), docNonce: 'private-value' }] };
  const value = project(input); privateFree(value);
  assert.deepEqual(value.callers[0].handshakeTiming.rows.map(row => row.phase), phases);
  assert.equal(value.callers[0].handshakeTiming.rows[1].succeeded, 1);
  input.callers[0].handshakeTiming.rows[1].succeeded = 99;
  assert.equal(value.callers[0].handshakeTiming.rows[1].succeeded, 1);
  assert.equal(project({ callersObserved: 1, callersTruncated: false, callers: [{}] }).callers[0].handshakeTiming, null);
  for (const mutate of [row => { row.rows.push(row.rows[0]); }, row => { row.rows[0].phase = 'private-value'; },
    row => { row.rows[0].totalMs = Infinity; }, row => { row.rows[0].count = -1; }, row => { row.clockFailures = 0.25; }]) {
    const item = await counters(); mutate(item);
    assert.equal(project({ callersObserved: 1, callersTruncated: false, callers: [{ handshakeTiming: item }] }).callers[0].handshakeTiming, null);
  }
});
async function fixture(closeGate) {
  const module = await subject, { createHostCallbackHandshakeTiming } = await helper;
  const calls = { scopes: 0, contexts: 0, factories: 0, snapshots: 0, sourceCloses: 0, scopeCloses: 0 };
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot', projectIdentity: 'handshake-project',
    workspaceIdentity: 'handshake-workspace', activeSceneId: 'main', activeArtifactRevision: 'a'.repeat(64), workspaceSourceSha256: 'b'.repeat(64) };
  const publication = module.createBlocklySimulatorWebPublication({
    async openCurrentProjectScope() { calls.scopes++; return {
      activation: { path: '/normal', signal: new AbortController().signal }, projectIdentity: context.projectIdentity,
      workspaceIdentity: context.workspaceIdentity, callbacks: { readContext() { throw Error('Unexpected callback.'); } },
      project: { handleInvocation() { throw Error('Unexpected invocation.'); }, handleArtifactChunk() { throw Error('Unexpected chunk.'); } },
      requireCurrent() {}, async close() { calls.scopeCloses++; } }; },
    async readContext() { calls.contexts++; return context; },
    deployment: { async readStartup() { return { identity: { projectIdentity: context.projectIdentity, sceneId: 'main', artifactRevision: context.activeArtifactRevision },
      resources: { trustedOrigin: origin, releaseBaseURL: origin + '/releases/' + 'c'.repeat(64) + '/', artifactBaseURL: null } }; } },
    async loadSource() { return { async createHostCallbackProjectSource() {
      calls.factories++; const timing = createHostCallbackHandshakeTiming({ now: () => 0 });
      await timing.observe('caller.descriptor', () => Promise.resolve());
      return { context, store: {}, artifact: null,
        snapshot() { calls.snapshots++; return { handshakeTiming: timing.snapshot(), ownerKey: 'private-value' }; },
        close() { calls.sourceCloses++; return timing.observe('caller.close-join', () => closeGate?.promise ?? Promise.resolve()); } };
    } }; },
  });
  return { publication, calls };
}
function located(name, body) {
  test(name, async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    try { await body(); } finally { if (before) Object.defineProperty(globalThis, 'location', before); else delete globalThis.location; }
  });
}
located('original retained caller projection keeps four separate handshake snapshots without extra business reads', async () => {
  const f = await fixture();
  for (let index = 0; index < 5; index++) await f.publication.readPublication('/normal', new AbortController().signal);
  const before = { ...f.calls }, value = f.publication.snapshot();
  assert.equal(value.artifactReadTiming.callersObserved, 4); assert.equal(value.artifactReadTiming.callersTruncated, true);
  assert.equal(value.artifactReadTiming.callers.length, 4);
  value.artifactReadTiming.callers.forEach(caller => { assert.equal(caller.handshakeTiming.rows[1].succeeded, 1); privateFree(caller); });
  assert.equal(f.calls.contexts, before.contexts); assert.equal(f.calls.factories, before.factories);
  await f.publication.close(); assert.equal(f.publication.snapshot().retainedCallers, 0);
  assert.equal(f.calls.sourceCloses, 5); assert.equal(f.calls.scopeCloses, 5);
});
located('new pending close timing does not retire an original caller before its actual source join', async () => {
  const gate = deferred(), f = await fixture(gate);
  await f.publication.readPublication('/normal', new AbortController().signal);
  let settled = false; const closing = f.publication.close().then(() => { settled = true; });
  for (let index = 0; index < 32 && f.calls.sourceCloses === 0; index++) await Promise.resolve();
  assert.equal(f.calls.sourceCloses, 1); assert.equal(settled, false); assert.equal(f.calls.scopeCloses, 0);
  const value = f.publication.snapshot(); assert.equal(value.retainedCleanupResponsibility, true);
  assert.equal(value.artifactReadTiming.callers[0].handshakeTiming.rows[6].pending, 1);
  gate.resolve(); await closing;
  assert.equal(f.calls.scopeCloses, 1); assert.equal(f.publication.snapshot().retainedCallers, 0);
});
test('actual application projection forwards new handshake rows without business read or private fields', async () => {
  const project = (await subject).projectBlocklyArtifactReadTiming;
  const prewarm = await load(path.join(base, 'blockly-simulator-web-prewarm.ts'));
  const javascript = ts.transpileModule(fs.readFileSync(path.join(base, 'simulator-web-app.providers.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const destroy = Symbol('DestroyRef'), exports = {};
  new Function('require', 'exports', javascript)(name => {
    if (name === '@angular/core') return { DestroyRef: destroy, InjectionToken: class {}, inject(token) { assert.equal(token, destroy); return { onDestroy() {} }; } };
    if (name === './simulator-web-product.providers') return { provideSimulatorWebProduct: factory => factory };
    if (name === './blockly-simulator-web-publication') return { projectBlocklyArtifactReadTiming: project };
    if (name === './blockly-simulator-web-prewarm') return prewarm;
    if (name === './simulator-web-product.source') return { createSimulatorWebProductSource() { throw Error('Unexpected read.'); } };
    if (name === './simulator-web-project-activation') return { createSimulatorWebProjectActivationReader() { throw Error('Unexpected activation.'); } };
    if (name === './simulator-web-project-activation.providers') return { SIMULATOR_WEB_PROJECT_ACTIVATION: Symbol('activation') };
    throw Error('Unexpected dependency: ' + name);
  }, exports);
  let reads = 0;
  const source = exports.provideSimulatorWebApplication()({}, {
    readPublication() { reads++; throw Error('Unexpected publication.'); },
    snapshot() { return { artifactReadTiming: { callersObserved: 1, callersTruncated: false,
      callers: [{ handshakeTiming: { rows: phases.map(phase => ({ phase, count: 1, pending: 0, succeeded: 1, failed: 0, totalMs: 0, maxMs: 0 })), overflow: 0, clockFailures: 0 } }] } }; },
  });
  const value = source.snapshot(); assert.equal(reads, 0); privateFree(value.publicationArtifactReadTiming);
  assert.equal(value.publicationArtifactReadTiming.callers[0].handshakeTiming.rows.length, 7);
  await source.close();
});
