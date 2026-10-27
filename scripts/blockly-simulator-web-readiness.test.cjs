const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Original generator/callback boundary doubles only: no UI, filesystem provider,
// account, Worker, Artifact admission, or MCU is started by these cases.
const text = fs.readFileSync(path.join(__dirname,
  '../src/app/integrations/simulator/blockly-simulator-web-readiness.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(text, { mode: 'transform' })).toString('base64'));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const signal = new AbortController(), ready = deferred(), calls = [];
  const context = { schemaVersion: 1, kind: 'aily-simulator-host-project-context-snapshot',
    projectIdentity: 'project-original', workspaceIdentity: 'workspace-original', activeSceneId: 'main',
    activeArtifactRevision: 'a'.repeat(64), workspaceSourceSha256: 'b'.repeat(64) };
  let generation = 1;
  const scope = { projectIdentity: context.projectIdentity,
    requireCurrent() { assert.equal(this, scope); if (generation !== 1) throw Object.assign(new Error('Original generation ended.'), { code: 'generation-ended' }); },
    callbacks: { async readContext(request, current) {
      assert.equal(this, scope.callbacks); assert.equal(request.projectIdentity, context.projectIdentity);
      assert.equal(current, signal.signal); calls.push('context'); return context;
    } },
  };
  const generatedCode = { async waitForReusableGeneratedCode(options) {
    assert.equal(this, generatedCode); assert.equal(options.signal, signal.signal);
    assert.equal(options.timeoutMs, 30_000); calls.push('generation-wait');
    return ready.promise;
  } };
  return { signal, ready, calls, context, scope, generatedCode, replaceGeneration: () => { generation++; } };
}

test('pending original generation completes before its original context is captured', async () => {
  const { readReadyBlocklySimulatorContext } = await subject;
  const f = fixture(), reading = readReadyBlocklySimulatorContext(f.scope, f.generatedCode, f.signal.signal);
  await Promise.resolve(); assert.deepEqual(f.calls, ['generation-wait']);
  f.ready.resolve('normally generated code');
  assert.equal(await reading, f.context); assert.deepEqual(f.calls, ['generation-wait', 'context']);
});

test('cancelled readiness cannot read a context even when the generator returns late', async () => {
  const { readReadyBlocklySimulatorContext } = await subject;
  const f = fixture(), reading = readReadyBlocklySimulatorContext(f.scope, f.generatedCode, f.signal.signal);
  f.signal.abort(new DOMException('The original caller closed.', 'AbortError'));
  f.ready.resolve('late original generated code');
  await assert.rejects(reading, { name: 'AbortError' });
  assert.deepEqual(f.calls, ['generation-wait']);
});

test('same-path generation replacement cannot borrow the new generation context', async () => {
  const { readReadyBlocklySimulatorContext } = await subject;
  const f = fixture(), reading = readReadyBlocklySimulatorContext(f.scope, f.generatedCode, f.signal.signal);
  f.replaceGeneration(); f.ready.resolve('new generation code at the same project path');
  await assert.rejects(reading, { code: 'generation-ended' });
  assert.deepEqual(f.calls, ['generation-wait']);
});

test('an Authority still reporting pending source remains unavailable after generation readiness', async () => {
  const { readReadyBlocklySimulatorContext } = await subject;
  const f = fixture(); f.context.workspaceSourceSha256 = null;
  const reading = readReadyBlocklySimulatorContext(f.scope, f.generatedCode, f.signal.signal);
  f.ready.resolve('code invalidated while the Authority hashes its snapshot');
  await assert.rejects(reading, { code: 'source-not-ready' });
  assert.deepEqual(f.calls, ['generation-wait', 'context']);
  assert.equal(f.context.workspaceSourceSha256, null);
});
