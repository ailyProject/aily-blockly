const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Pure factory cases use explicit original-activation/provider doubles. No
// project, browser, filesystem provider, authorization service or MCU starts.
const source = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/blockly-simulator-web-deployment.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const origin = 'https://app.example.test';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function factoryTest(name, body) {
  test(name, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
    try { await body((await subject).createBlocklyProjectScopedWebDeployment); }
    finally { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; }
  });
}
function fixture() {
  const calls = [], authorization = { async readResponse() { throw Error('No authorization requested in this fixture.'); } };
  const catalog = { hostProviderSnapshot() { return { fixture: true }; } }, runtime = { fixture: true };
  const options = { trustedOrigin: origin, releaseId: 'a'.repeat(64),
    instance: { runtimeId: '146d805f-c657-4cea-ad70-db55dbabb79f', version: '0.1.0', ownerKey: 'original-owner',
      subjectHash: 'b'.repeat(64), configuration: { url: origin + '/instances/146d805f-c657-4cea-ad70-db55dbabb79f/entitlement-config.json',
        sizeBytes: 804, sha256: 'c'.repeat(64) } },
    async readInputs(input) { assert.equal(this, options); calls.push(input); input.requireCurrent(); return { authorization, catalog, runtime }; } };
  return { options, calls, authorization, catalog, runtime };
}
function selection(name, revision = null) {
  const lifetime = new AbortController(), request = new AbortController(); let current = true;
  const activation = { path: '/' + name, projectSessionId: 'original-activation-' + name, signal: lifetime.signal,
    requireCurrent() { assert.equal(this, activation); lifetime.signal.throwIfAborted(); if (!current) throw Error('Original activation replaced.'); } };
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot',
    projectIdentity: 'project-' + name, workspaceIdentity: 'workspace-' + name, activeSceneId: 'main',
    activeArtifactRevision: revision, workspaceSourceSha256: 'd'.repeat(64) };
  return { activation, context, signal: request.signal, request, lifetime, replace() { current = false; } };
}

factoryTest('one static deployment captures independent A/B scopes with null and normal Artifact revisions', async create => {
  const f = fixture(), deployment = create(f.options), a = selection('A'), b = selection('B', 'e'.repeat(64));
  const first = await deployment.readStartup(a), second = await deployment.readStartup(b);
  for (const [value, selected] of [[first, a], [second, b]]) {
    assert.equal(value.identity.projectIdentity, selected.context.projectIdentity);
    assert.equal(value.identity.sceneId, 'main'); assert.equal(value.identity.artifactRevision, selected.context.activeArtifactRevision);
    assert.equal(value.workspace, 'browser:' + selected.context.projectIdentity);
    assert.equal(value.resources.artifactBaseURL, null); assert.equal(value.authorization, f.authorization);
    assert.equal(value.catalog, f.catalog); assert.equal(value.runtime, f.runtime);
    assert.equal('owner' in value, false); assert.equal('project' in value, false); assert.equal('artifact' in value, false);
    assert(Object.isFrozen(value) && Object.isFrozen(value.identity) && Object.isFrozen(value.resources));
  }
  assert.notEqual(first.identity, second.identity); assert.notEqual(first.workspace, second.workspace);
  assert.equal(f.calls[0].activation, a.activation); assert.notEqual(f.calls[0].context, a.context);
  assert(Object.isFrozen(f.calls[0].context)); assert.equal(f.calls[1].context.workspaceSourceSha256, b.context.workspaceSourceSha256);
  assert.equal(f.calls[0].releaseBaseURL, origin + '/releases/' + f.options.releaseId + '/');
});

factoryTest('non-null Artifact requires original runtime inputs while an empty project needs none', async create => {
  const f = fixture(); f.options.readInputs = async () => ({ authorization: f.authorization, catalog: f.catalog });
  const deployment = create(f.options);
  const empty = await deployment.readStartup(selection('empty')); assert.equal('runtime' in empty, false);
  await assert.rejects(deployment.readStartup(selection('built', 'e'.repeat(64))), /Invalid project-scoped/);
});

factoryTest('a cancelled request or replaced original activation rejects the actual late inputs result', async create => {
  for (const revoke of [s => s.request.abort(), s => s.lifetime.abort(), s => s.replace()]) {
    const f = fixture(), entered = deferred(), result = deferred(), selected = selection('A');
    f.options.readInputs = async () => { entered.resolve(); return result.promise; };
    const reading = create(f.options).readStartup(selected); await entered.promise; revoke(selected);
    result.resolve({ authorization: f.authorization, catalog: f.catalog, runtime: f.runtime });
    await assert.rejects(reading);
  }
});

factoryTest('full context, activation path and session identity cannot drift during input loading', async create => {
  const changes = [s => { s.context.workspaceIdentity = 'workspace-other'; },
    s => { s.context.activeArtifactRevision = 'e'.repeat(64); }, s => { s.context.workspaceSourceSha256 = 'f'.repeat(64); },
    s => { s.activation.path = '/other'; }, s => { s.activation.projectSessionId = 'other-generation'; }];
  for (const change of changes) {
    const f = fixture(), entered = deferred(), result = deferred(), selected = selection('A');
    f.options.readInputs = async () => { entered.resolve(); return result.promise; };
    const reading = create(f.options).readStartup(selected); await entered.promise; change(selected);
    result.resolve({ authorization: f.authorization, catalog: f.catalog, runtime: f.runtime });
    await assert.rejects(reading, /Invalid project-scoped/);
  }
});

factoryTest('static options cannot inject project, Artifact or resource scope and instance data is captured once', async create => {
  for (const key of ['expectedProject', 'path', 'project', 'artifact', 'artifactRevision', 'releaseBaseURL', 'workspace']) {
    const f = fixture(); f.options[key] = 'foreign'; assert.throws(() => create(f.options), /Invalid project-scoped/);
  }
  for (const change of [f => { f.options.trustedOrigin = 'https://foreign.example.test'; },
    f => { f.options.instance.configuration.url += '?foreign=1'; },
    f => { f.options.instance.configuration.url = origin + '/instances/foreign/entitlement-config.json'; }]) {
    const f = fixture(); change(f); assert.throws(() => create(f.options), /Invalid project-scoped/);
  }
  const f = fixture(), deployment = create(f.options);
  f.options.instance.ownerKey = 'changed'; f.options.instance.configuration.sha256 = 'f'.repeat(64); f.options.releaseId = 'f'.repeat(64);
  const value = await deployment.readStartup(selection('A'));
  assert.equal(value.identity.ownerKey, 'original-owner'); assert.equal(value.instanceAuthority.configuration.sha256, 'c'.repeat(64));
  assert.equal(value.resources.releaseBaseURL, origin + '/releases/' + 'a'.repeat(64) + '/');
});

factoryTest('input providers cannot replace output identity and a changed document origin is refused', async create => {
  const f = fixture(); f.options.readInputs = async () => ({ authorization: f.authorization, catalog: f.catalog,
    runtime: f.runtime, identity: { projectIdentity: 'foreign' }, resources: { trustedOrigin: 'https://foreign.example.test' },
    project: { foreign: true }, artifact: { foreign: true } });
  const deployment = create(f.options), selected = selection('A');
  const value = await deployment.readStartup(selected);
  assert.equal(value.identity.projectIdentity, selected.context.projectIdentity); assert.equal(value.resources.trustedOrigin, origin);
  assert.equal('project' in value, false); assert.equal('artifact' in value, false);
  const changed = fixture(), entered = deferred(), result = deferred();
  changed.options.readInputs = async () => { entered.resolve(); return result.promise; };
  const reading = create(changed.options).readStartup(selection('B')); await entered.promise;
  globalThis.location.origin = 'https://foreign.example.test';
  result.resolve({ authorization: changed.authorization, catalog: changed.catalog });
  await assert.rejects(reading, /Invalid project-scoped/);
});
