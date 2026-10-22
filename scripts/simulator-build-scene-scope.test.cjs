const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Product orchestration source with explicit callback doubles only. No project
// files, Builder CLI, account, Runtime, Worker, or MCU is started here.
const source = fs.readFileSync(path.resolve(__dirname,
  '../src/app/integrations/simulator/simulator-build-execution-port.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const revision = 'a'.repeat(64);
const document = { schemaVersion: 2, kind: 'aily-scene-editor-document',
  sceneId: 'main', graphSemanticRevision: revision };

function fixture(Port) {
  const controller = new AbortController(), builds = [], reads = [], phases = [];
  let active = true;
  let current = async () => document;
  const request = { requestId: 'build-scene', projectIdentity: 'project-original',
    sceneId: 'main', sceneRevision: revision, reason: 'graph-semantic-changed', sceneDocument: { ...document } };
  const options = {
    projectRoot: 'D:/project-original', projectIdentity: request.projectIdentity, sceneId: 'main',
    activeProject: { readActiveBinding: () => active ? { projectRoot: 'D:/project-original',
      projectIdentity: request.projectIdentity, sceneId: 'main', editorKind: 'blockly' } : null,
    isSameProjectRoot: (left, right) => left === right },
    mainAgent: { async execute(input) { return { ...input, outcome: 'completed', agentRunId: 'run-original' }; } },
    readCompileScene: async (expected, signal) => { reads.push({ expected, signal }); return current(); },
    builder: { async build(input, signal) { builds.push({ input, signal }); } },
    artifacts: { async readLatest(projectIdentity) { return { projectIdentity, artifactRevision: 'artifact-current' }; } },
  };
  const port = new Port(options);
  return { options, request, controller, reads, builds, phases,
    readWith: callback => { current = callback; }, revoke: () => { active = false; },
    run: () => port.reconcileAndBuild(request, { report: phase => phases.push(phase) }, controller.signal) };
}

test('Builder receives the current authority Scene document for the exact requested revision', async () => {
  const { BlocklySimulatorBuildExecutionPort } = await subject;
  const f = fixture(BlocklySimulatorBuildExecutionPort);
  const result = await f.run();
  assert.deepEqual(f.reads, [{ expected: revision, signal: f.controller.signal }]);
  assert.equal(f.builds.length, 1);
  assert.equal(f.builds[0].input.sceneDocument, document);
  assert.notEqual(f.builds[0].input.sceneDocument, f.request.sceneDocument);
  assert.equal(f.builds[0].signal, f.controller.signal);
  assert.equal(result.artifactRevision, 'artifact-current');
});

test('a changed Scene revision or identity fails before Builder starts', async () => {
  const { BlocklySimulatorBuildExecutionPort } = await subject;
  for (const change of [{ graphSemanticRevision: 'b'.repeat(64) }, { sceneId: 'other' }]) {
    const f = fixture(BlocklySimulatorBuildExecutionPort);
    f.readWith(async () => ({ ...document, ...change }));
    await assert.rejects(f.run(), { simulatorBuildErrorCode: 'compile-failed' });
    assert.equal(f.builds.length, 0);
  }
});

test('cancellation while the current Scene read is pending rejects its late result', async () => {
  const { BlocklySimulatorBuildExecutionPort } = await subject;
  const f = fixture(BlocklySimulatorBuildExecutionPort);
  let release, entered;
  const waiting = new Promise(done => { entered = done; });
  f.readWith(() => { entered(); return new Promise(done => { release = done; }); });
  const operation = f.run();
  await waiting;
  f.controller.abort(new DOMException('Owner closed.', 'AbortError'));
  release(document);
  await assert.rejects(operation, { simulatorBuildErrorCode: 'cancelled' });
  assert.equal(f.builds.length, 0);
});

test('project revocation during the Scene await prevents the old Builder invocation', async () => {
  const { BlocklySimulatorBuildExecutionPort } = await subject;
  const f = fixture(BlocklySimulatorBuildExecutionPort);
  f.readWith(async () => { f.revoke(); return document; });
  await assert.rejects(f.run(), { simulatorBuildErrorCode: 'project-unavailable' });
  assert.equal(f.builds.length, 0);
});

test('a missing current Scene reader is rejected at composition time', async () => {
  const { BlocklySimulatorBuildExecutionPort } = await subject;
  const f = fixture(BlocklySimulatorBuildExecutionPort);
  const { readCompileScene, ...incomplete } = f.options;
  assert.throws(() => new BlocklySimulatorBuildExecutionPort(incomplete), /Scene reader/);
});
