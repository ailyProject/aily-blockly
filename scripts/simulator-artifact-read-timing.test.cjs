const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');

// Source-only diagnostics cases. Actual project publication/DI functions with
// explicit local callback doubles; no Main/account/project/Worker/ACK claims.
const base = path.join(__dirname, '../src/app/integrations/simulator');
const dataModule = file => import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'transform' })).toString('base64'));
const subject = dataModule(path.join(base, 'blockly-simulator-web-publication.ts'));
const simulatorRoot = process.env.AILY_SIMULATOR_SOURCE_ROOT || path.resolve(__dirname, '../../aily-simulator');
const timing = dataModule(path.join(simulatorRoot, 'packages/simulator-gateway/src/artifact-read-timing.ts'));
const origin = 'https://timing.example.test';
const rows = async count => {
  const value = structuredClone((await timing).createArtifactReadTiming().snapshot());
  value.rows[0].count = value.rows[0].succeeded = count;
  value.rows[0].totalMs = count + 0.25; value.rows[0].maxMs = count + 0.25;
  value.ownerKey = 'private-owner'; value.docNonce = 'private-document';
  value.rows[0].privatePath = 'private-path';
  return value;
};
const wrapper = async count => ({ callersObserved: 1, callersTruncated: false,
  callers: [{ readTiming: await rows(count), ownerKey: 'private-owner' }], nonce: 'private-document' });
const privateFree = value => assert(!/private-owner|private-document|private-path|ownerKey|docNonce|privatePath/u.test(JSON.stringify(value)));

function withLocation(name, body) {
  test(name, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    try { await body(); } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location;
    }
  });
}

async function fixture() {
  const module = await subject; let factories = 0, sourceCloses = 0, scopeCloses = 0, failClose = false;
  const sourceRows = [];
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot', projectIdentity: 'timing-project',
    workspaceIdentity: 'timing-workspace', activeSceneId: 'main', activeArtifactRevision: 'a'.repeat(64), workspaceSourceSha256: 'b'.repeat(64) };
  const publication = module.createBlocklySimulatorWebPublication({
    async openCurrentProjectScope(signal) {
      signal.throwIfAborted(); const activation = { path: '/normal', projectSessionId: 'generation', signal: new AbortController().signal,
        requireCurrent() {} };
      return { activation, projectIdentity: context.projectIdentity, workspaceIdentity: context.workspaceIdentity,
        callbacks: { readContext: () => context }, project: { async handleInvocation() {}, async handleArtifactChunk() {} },
        requireCurrent() {}, async close() { scopeCloses++; } };
    },
    readContext: async () => context,
    deployment: { async readStartup() { return { identity: { runtimeId: 'runtime', version: 'version', ownerKey: 'owner',
      projectIdentity: context.projectIdentity, sceneId: 'main', artifactRevision: context.activeArtifactRevision },
      resources: { trustedOrigin: origin, releaseBaseURL: origin + '/releases/' + 'c'.repeat(64) + '/', artifactBaseURL: null },
      authorization: {}, instanceAuthority: {}, catalog: {}, workspace: null }; } },
    loadSource: async () => ({ async createHostCallbackProjectSource() {
      const counters = await rows(++factories); sourceRows.push(counters);
      return { context, store: {}, artifact: null, snapshot() { return { readTiming: counters, ownerKey: 'private-owner' }; },
        async close() { sourceCloses++; if (failClose) throw Error('Original source close not confirmed.'); } };
    } }),
  });
  return { publication, sourceRows, calls: () => ({ factories, sourceCloses, scopeCloses }), fail(value) { failClose = value; } };
}

test('fixed row projection drops private fields and rejects unknown/nonfinite dimensions', async () => {
  const { projectBlocklyArtifactReadTiming: project } = await subject;
  const input = await wrapper(3), value = project(input);
  assert.equal(value.callersObserved, 1); assert.equal(value.callers[0].readTiming.rows.length, 30);
  assert.equal(value.callers[0].readTiming.rows[0].count, 3); privateFree(value);
  input.callers[0].readTiming.rows[0].count = 99;
  assert.equal(value.callers[0].readTiming.rows[0].count, 3, 'Snapshot does not retain mutable source data.');
  for (const mutate of [item => item.rows.push(item.rows[0]), item => { item.rows[0].operation = 'foreign-operation'; },
    item => { item.rows[0].totalMs = Infinity; }, item => { item.rows[0].bytes = -1; }]) {
    const changed = await wrapper(1); mutate(changed.callers[0].readTiming);
    assert.equal(project(changed).callers[0].readTiming, null);
  }
  const excess = await wrapper(1); excess.callers = Array(5).fill(excess.callers[0]); excess.callersObserved = 5;
  assert.equal(project(excess), null);
});

withLocation('original retained callers expose at most four separate timing snapshots', async () => {
  const f = await fixture();
  for (let index = 0; index < 5; index++) await f.publication.readPublication('/normal', new AbortController().signal);
  const snapshot = f.publication.snapshot();
  assert.equal(snapshot.retainedCallers, 5); assert.equal(snapshot.artifactReadTiming.callersObserved, 4);
  assert.equal(snapshot.artifactReadTiming.callersTruncated, true);
  assert.deepEqual(snapshot.artifactReadTiming.callers.map(caller => caller.readTiming.rows[0].count), [1, 2, 3, 4]);
  privateFree(snapshot.artifactReadTiming);
  await f.publication.close(); const closed = f.publication.snapshot();
  assert.equal(closed.retainedCleanupResponsibility, false); assert.deepEqual(closed.artifactReadTiming.callers, []);
  assert.deepEqual(f.calls(), { factories: 5, sourceCloses: 5, scopeCloses: 5 });
});

withLocation('original failed close retains the same timing caller until original retry succeeds', async () => {
  const f = await fixture(); await f.publication.readPublication('/normal', new AbortController().signal);
  f.fail(true); await assert.rejects(f.publication.close());
  const failed = f.publication.snapshot(); assert.equal(failed.retainedCallers, 1);
  assert.equal(failed.retainedCleanupResponsibility, true); assert.equal(failed.artifactReadTiming.callers[0].readTiming.rows[0].count, 1);
  f.fail(false); await f.publication.close(); assert.equal(f.publication.snapshot().retainedCallers, 0);
  assert.deepEqual(f.calls(), { factories: 1, sourceCloses: 2, scopeCloses: 1 });
});

test('actual application source forwards only the bounded original publication timing projection', async () => {
  const project = (await subject).projectBlocklyArtifactReadTiming;
  const prewarm = await dataModule(path.join(base, 'blockly-simulator-web-prewarm.ts'));
  const javascript = ts.transpileModule(fs.readFileSync(path.join(base, 'simulator-web-app.providers.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const destroy = Symbol('DestroyRef'), exports = {};
  new Function('require', 'exports', javascript)(name => {
    if (name === '@angular/core') return { DestroyRef: destroy, InjectionToken: class {}, inject(token) {
      assert.equal(token, destroy); return { onDestroy() {} }; } };
    if (name === './simulator-web-product.providers') return { provideSimulatorWebProduct: factory => factory };
    if (name === './blockly-simulator-web-publication') return { projectBlocklyArtifactReadTiming: project };
    if (name === './blockly-simulator-web-prewarm') return prewarm;
    if (name === './simulator-web-product.source') return { createSimulatorWebProductSource() { throw Error('Unexpected business read.'); } };
    if (name === './simulator-web-project-activation') return { createSimulatorWebProjectActivationReader() { throw Error('Unexpected activation read.'); } };
    if (name === './simulator-web-project-activation.providers') return { SIMULATOR_WEB_PROJECT_ACTIVATION: Symbol('activation') };
    throw Error('Unexpected source dependency: ' + name);
  }, exports);
  let reads = 0; const input = await wrapper(7);
  const source = exports.provideSimulatorWebApplication()({}, { readPublication() { reads++; throw Error('Unexpected read.'); },
    snapshot() { return { artifactReadTiming: input, ownerKey: 'private-owner' }; } });
  const snapshot = source.snapshot(); assert.equal(reads, 0); assert.equal(snapshot.retainedCallers, 0);
  assert.equal(snapshot.publicationArtifactReadTiming.callers[0].readTiming.rows[0].count, 7);
  privateFree(snapshot.publicationArtifactReadTiming); await source.close();
});
