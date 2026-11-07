const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const load = name => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(
  fs.readFileSync(path.join(__dirname, name + '.ts'), 'utf8'), { mode: 'transform' })).toString('base64'));
const execution = load('simulator-coder-build-execution-port');
const sources = load('simulator-coder-source-reader');
const revision = 'a'.repeat(64), projectIdentity = 'project-original';
const scene = { sceneId: 'main', graphSemanticRevision: revision };
function fixture(Port) {
  const signal = new AbortController(), calls = [], reports = [];
  let binding = { editorKind: 'coder', projectRoot: '/project', projectIdentity, sceneId: 'main' };
  const options = { projectRoot: '/project', projectIdentity,
    activeProject: { readActiveBinding: () => binding, isSameProjectRoot: (a, b) => a === b },
    builder: { async buildForSimulation(root, input) { calls.push({ type: 'build', root, input }); } },
    readCompileScene: async () => scene,
    artifacts: { async readLatest(id) { calls.push({ type: 'artifact', id }); return { artifactRevision: 'artifact-complete' }; } },
  };
  const request = { requestId: 'original-build', projectIdentity, sceneId: 'main', sceneDocument: { ...scene },
    sceneRevision: revision, baseSceneRevision: revision, reason: 'graph-semantic-changed' };
  const port = new Port(options);
  return { signal, calls, reports, options, request, setBinding: value => { binding = value; },
    run: () => port.reconcileAndBuild(request, { report: phase => reports.push(phase) }, signal.signal) };
}

test('confirmed Coder Scene builds saved files without a Blockly generation/Agent phase', async () => {
  const { CoderSimulatorBuildExecutionPort: Port } = await execution, f = fixture(Port);
  assert.equal((await f.run()).artifactRevision, 'artifact-complete');
  assert.deepEqual(f.reports, ['resolving', 'compiling', 'staging']);
  assert.equal(f.calls[0].root, '/project');
  assert.equal(f.calls[0].input.requestId, f.request.requestId);
  assert.equal(f.calls[0].input.sceneDocument, scene);
  assert.equal(f.calls[0].input.signal, f.signal.signal);
});
test('foreign project/editor/Scene requests are rejected before compilation', async () => {
  const { CoderSimulatorBuildExecutionPort: Port } = await execution;
  for (const mutation of [f => { f.request.projectIdentity = 'foreign'; },
    f => { f.setBinding({ editorKind: 'blockly', projectRoot: '/project', projectIdentity, sceneId: 'main' }); },
    f => { f.request.reason = 'workspace-source-rebuild'; f.request.baseSceneRevision = 'b'.repeat(64); }]) {
    const f = fixture(Port); mutation(f);
    await assert.rejects(f.run(), { simulatorBuildErrorCode: 'project-unavailable' });
    assert.equal(f.calls.length, 0);
  }
});
test('Scene or project changes during the authoritative Scene read fence the old build', async () => {
  const { CoderSimulatorBuildExecutionPort: Port } = await execution;
  const f = fixture(Port);
  f.options.readCompileScene = async () => { f.setBinding(null); return scene; };
  await assert.rejects(f.run(), { simulatorBuildErrorCode: 'project-unavailable' });
  assert.equal(f.calls.length, 0);
});
test('abort retains original build settlement and never stages its late success', async () => {
  const { CoderSimulatorBuildExecutionPort: Port } = await execution, f = fixture(Port);
  let release, entered;
  const started = new Promise(done => { entered = done; });
  f.options.builder.buildForSimulation = () => { entered(); return new Promise(done => { release = done; }); };
  let settled = false;
  const running = f.run().finally(() => { settled = true; });
  await started; f.signal.abort(new Error('cancel original'));
  await Promise.resolve(); assert.equal(settled, false);
  release(); await assert.rejects(running, { simulatorBuildErrorCode: 'cancelled' });
  assert.equal(f.calls.length, 0);
});
test('compilation failure cannot read/install an old Artifact', async () => {
  const { CoderSimulatorBuildExecutionPort: Port } = await execution, f = fixture(Port);
  f.options.builder.buildForSimulation = async () => { throw new Error('actual compiler failed'); };
  await assert.rejects(f.run(), { simulatorBuildErrorCode: 'compile-failed' });
  assert.equal(f.calls.length, 0);
});

function sourceFixture(create) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const manifest = { type: 'coder', entry: 'src/main.cpp', boardDependencies: { '@aily-project/board-esp32c3': '3.3.10' } };
  let saved = true, header = '#define VALUE 1', delivery = null;
  const options = { requireCurrent() {}, hasSavedProject: async () => saved,
    readManifest: () => manifest, readEntry: () => '#include "value.h"\nvoid setup(){}\nvoid loop(){}',
    // The fixture is the trusted Builder boundary: header participates in its
    // private capture digest, while the portable source hash stays entry-only.
    capture(code) { return { mode: 'coder', sourceSha256: hash(code), digest: hash(code + header) }; },
    readDelivery: () => delivery,
  };
  const artifact = { artifactId: 'c'.repeat(64), build: { source: { sha256: hash(options.readEntry()) } } };
  delivery = { kind: 'aily-build-delivery', artifactId: artifact.artifactId, sourceCapture: options.capture(options.readEntry()) };
  return { reader: create(options), options, artifact, setSaved: value => { saved = value; },
    changeHeader() { header = '#define VALUE 2'; }, setDelivery: value => { delivery = value; } };
}
test('only a saved Coder source yields the real entry hash', async () => {
  const { createSimulatorCoderSourceReader: create } = await sources, f = sourceFixture(create), signal = new AbortController().signal;
  assert.equal((await f.reader.read(signal)).sha256, f.artifact.build.source.sha256);
  assert.equal(await f.reader.isArtifactCurrent(f.artifact, signal), true);
  f.setSaved(false); assert.equal(await f.reader.read(signal), null);
  assert.equal(await f.reader.isArtifactCurrent(f.artifact, signal), false);
});
test('header-only changes keep entry SHA but invalidate the previous delivery and snapshot', async () => {
  const { createSimulatorCoderSourceReader: create } = await sources, f = sourceFixture(create), signal = new AbortController().signal;
  const old = await f.reader.read(signal), oldState = f.reader.readState();
  f.changeHeader();
  assert.equal((await f.reader.read(signal)).sha256, old.sha256);
  assert.equal(old.isCurrent(), false);
  assert.notEqual(f.reader.readState().code, oldState.code);
  assert.equal(await f.reader.isArtifactCurrent(f.artifact, signal), false);
});
test('missing or foreign delivery cannot make a Coder Artifact current', async () => {
  const { createSimulatorCoderSourceReader: create } = await sources, f = sourceFixture(create), signal = new AbortController().signal;
  f.setDelivery(null); assert.equal(await f.reader.isArtifactCurrent(f.artifact, signal), false);
  f.setDelivery({ kind: 'aily-build-delivery', artifactId: 'foreign' });
  assert.equal(await f.reader.isArtifactCurrent(f.artifact, signal), false);
});
test('unsafe source paths and spoofed Blockly capture are refused', async () => {
  const { createSimulatorCoderSourceReader: create } = await sources;
  const f = sourceFixture(create); f.options.readManifest().entry = '../secret.cpp';
  assert.throws(() => f.reader.readState(), /within its saved workspace/);
  f.options.readManifest().entry = 'src/main.cpp';
  f.options.capture = () => ({ mode: 'blockly', sourceSha256: 'a'.repeat(64), digest: 'b'.repeat(64) });
  assert.throws(() => f.reader.readState(), /trusted Coder source capture/);
});

// Load the production authority and its relative TS dependency against the
// installed public SDK, rather than substituting its artifact/read logic.
async function loadAuthority() {
  const names = ['@aily-project/simulator-host-sdk', '@aily-project/simulator-protocol/host', '@aily-project/simulator-protocol/scene', '@aily-project/simulator-protocol/artifact'];
  const dependencies = new Map(await Promise.all(names.map(async name => [name, await import(name)])));
  const ts = require('typescript'), cache = new Map();
  function loadFile(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = new Module(filename, module); mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename)); cache.set(filename, mod);
    mod.require = name => {
      if (dependencies.has(name)) return dependencies.get(name);
      if (name.startsWith('.')) {
        const stem = path.resolve(path.dirname(filename), name).replace(/\.[cm]?js$/u, '');
        if (fs.existsSync(stem + '.ts')) return loadFile(stem + '.ts');
      }
      return require(name);
    };
    mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return mod.exports;
  }
  return loadFile(path.join(__dirname, 'simulator-project-artifact-callback-authority.ts')).SimulatorProjectArtifactCallbackAuthority;
}
async function authorityFixture() {
  const Authority = await loadAuthority(), hash = 'd'.repeat(64);
  const artifact = { schemaVersion: 1, kind: 'aily-build-artifact', artifactId: hash, primaryFile: 'application.hex',
    target: { architecture: 'avr', fqbn: 'arduino:avr:uno', boardId: 'uno' },
    build: { builtAt: '2026-11-07T00:00:00Z', source: { path: 'src/main.cpp', sizeBytes: 1, sha256: hash }, toolVersions: {} },
    files: [{ role: 'hex', path: 'application.hex', sizeBytes: 1, sha256: hash }] };
  const data = new Map([['/project/.build/aily-artifact-manifest.json', Buffer.from(JSON.stringify(artifact))],
    ['/project/.build/application.hex', Buffer.from('x')]]);
  let fresh = true;
  const authority = new Authority({ projectRoot: '/project', projectIdentity, workspaceIdentity: 'workspace-original',
    readWorkspaceSource: async () => ({ sha256: hash, isCurrent: () => true }),
    isArtifactCurrent: async () => fresh,
    files: { join: path.join, resolve: path.resolve, relative: path.relative,
      async readFile(p) { return data.get(p); },
      async lstat(p) { if (!data.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { size: data.get(p).length, isFile: true, isSymbolicLink: false }; },
      async realpath(p) { return p; }, async replaceFileAtomic() { throw Error('Writes forbidden'); } },
  });
  return { authority, artifact, stale() { fresh = false; }, signal: new AbortController().signal };
}
test('actual Artifact authority hides and refuses a stale Coder delivery', async () => {
  const f = await authorityFixture(), context = () => f.authority.callbacks.readContext({ projectIdentity }, f.signal);
  assert.equal((await context()).activeArtifactRevision, f.artifact.artifactId);
  f.stale(); assert.equal((await context()).activeArtifactRevision, null);
  await assert.rejects(f.authority.callbacks.readArtifact({ projectIdentity, artifactRevision: null }, f.signal),
    error => error.code === 'conflict' || error.errorCode === 'conflict' || /conflict/.test(error.message));
  f.authority.close();
});
test('actual Artifact authority fences an issued chunk handle after inputs become stale', async () => {
  const f = await authorityFixture();
  const descriptor = await f.authority.callbacks.readArtifact({ projectIdentity, artifactRevision: null }, f.signal);
  f.stale();
  await assert.rejects(f.authority.callbacks.readArtifactChunk({ projectIdentity, artifactRevision: descriptor.artifactRevision,
    artifactReference: descriptor.artifactReference, path: 'application.hex', offsetBytes: 0, maxBytes: 1 }, f.signal),
    error => error.code === 'conflict' || error.errorCode === 'conflict' || /conflict/.test(error.message));
  f.authority.close();
});
