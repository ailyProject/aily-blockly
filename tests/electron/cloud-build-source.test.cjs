'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const protocol = require('../../electron/cloud-build/protocol');
const { captureIdentity, captureSnapshot } = require('../../electron/cloud-build/snapshot');
const { captureBuildSource, confirmBuildSource } = require('../../child/scripts/build-source-capture');
const { acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-source-contract-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardModule = '@aily-project/board-source-test';
  const pkg = { name: boardModule, version: '1.0.0' }, board = {};
  const boardRoot = path.join(root, 'node_modules', boardModule);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), JSON.stringify(board));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'source-test', dependencies: { [boardModule]: '1.0.0' } }));
  fs.writeFileSync(path.join(root, 'project.abi'), '{"pages":["externalized native ABI"]}');
  const f = { root, jobs: 0, uploads: 0, next: 0, sender: {}, status: 'succeeded',
    workspace: { documentText: '{"pages":["native-source"]}', revision: 1, runtimeRevision: 1, pageId: 'page-1' },
    settings: { gatewayUrl: 'http://localhost:4318' },
    config: { currentProjectPath: root, boardModule, code: 'void setup() { digitalWrite(6, LOW); }\nvoid loop() {}\n' },
    profile: { profileDigest: 'a'.repeat(64), runner: 'aily-builder', boardModule, boardVersion: '1.0.0',
      boardDigest: protocol.boardDigest(pkg, board), capabilities: { compile: true }, metadata: { boardOptions: {}, defaults: {} } },
    keys: crypto.generateKeyPairSync('ed25519') };
  const artifactBytes = Buffer.from('compiled-firmware');
  const artifact = { artifactId: 'firmware', path: 'sketch.bin', role: 'firmware', sizeBytes: artifactBytes.length, sha256: protocol.sha256(artifactBytes) };
  const broker = f.broker = new CloudBuildBroker({ pollIntervalMs: 1, initialPollIntervalMs: 0,
    getOwner: () => ({ generation: 1 }), fetch: async () => new Response(artifactBytes),
    querySource: async () => ({ ok: true, source: { projectPath: root, boardModule, activationId: 'editor-1', mode: 'blockly',
      workspace: f.config.sourceCapture?.workspace } }) });
  broker.capabilities = async () => ({ protocolVersion: 1, publicKey: f.keys.publicKey.export({ type: 'spki', format: 'pem' }) });
  broker.targets = async () => ({ profiles: [f.profile] });
  broker.uploadSnapshot = async record => { f.uploads++; f.snapshot = record.snapshot; return { inputDigest: record.snapshot.inputDigest, snapshotId: 'input' }; };
  broker.request = async (_settings, endpoint, body) => {
    if (endpoint === '/api/v1/build/jobs') { f.jobs++; return { jobId: 'source-job-' + f.jobs }; }
    if (endpoint.includes('/logs?') || endpoint.endsWith('/cancel')) return {};
    if (endpoint.endsWith('/result')) {
      const manifest = { schemaVersion: 1, kind: 'aily-cloud-build-result', jobId: 'source-job-' + f.jobs,
        inputDigest: f.snapshot.inputDigest, profileDigest: f.profile.profileDigest, boardDigest: f.snapshot.boardDigest,
        boardModule, boardVersion: '1.0.0', action: 'compile', attempt: 1, runner: 'aily-builder', fixture: false, artifacts: [artifact] };
      const signature = { algorithm: 'Ed25519', value: crypto.sign(null, Buffer.from(protocol.canonicalJson(manifest)), f.keys.privateKey).toString('base64') };
      return { manifest, signature, artifacts: [{ ...artifact, downloadUrl: '/api/v1/build/artifacts/firmware' }] };
    }
    return { status: f.status, attempt: 1, lastSeq: 0 };
  };
  f.capture = () => { f.config.sourceCapture = captureBuildSource(f.config, f.workspace); };
  f.capture();
  f.run = () => { const n = ++f.next; return broker.run(f.sender, { requestId: `cloud-${n}`, buildRequestId: `original-tool-${n}`,
    action: 'compile', profileDigest: f.profile.profileDigest, settings: f.settings, config: { ...f.config } }, () => {}); };
  return f;
}

test('isolated Blockly cloud snapshots use captured generator inputs without publishing them to the project', t => {
  const f = fixture(t);
  const manifestPath = path.join(f.root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.MACROS = [['USER=1'], ['OLD=2'], ['EDITED=3'], ['REMOVED=4']];
  manifest.ailyGeneratorMacros = { OLD: 'OLD=2', EDITED: 'EDITED=1' };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const rootBytes = fs.readFileSync(manifestPath);
  const source = path.join(f.root, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'header.h'), 'user source');
  fs.writeFileSync(path.join(source, 'variables_main-12345678.h'), 'prior generated bytes');
  fs.writeFileSync(path.join(source, 'objects_prior-12345678.h'), 'old header to omit');
  Object.assign(f.config, { isolatedCloudBuild: true,
    generatedArtifacts: [{ fileName: 'variables_main-12345678.h', content: 'current generated bytes' }],
    projectMacros: [{ name: 'ADDED', value: 'ADDED=5' }, { name: 'REMOVED', value: null }] });
  f.capture();

  const snapshot = captureSnapshot(f.config, f.profile);
  const file = relative => snapshot.files.find(item => item.path === relative);
  assert.equal(Buffer.from(file('sketch/variables_main-12345678.h').dataBase64, 'base64').toString(), 'current generated bytes');
  assert.equal(Buffer.from(file('sketch/header.h').dataBase64, 'base64').toString(), 'user source');
  assert.equal(file('sketch/objects_prior-12345678.h'), undefined);
  assert.deepEqual(snapshot.macros, [{ name: 'USER', value: '1' }, { name: 'EDITED', value: '3' }, { name: 'ADDED', value: '5' }]);
  const projected = JSON.parse(Buffer.from(file('aily-input/project.json').dataBase64, 'base64'));
  assert.deepEqual(projected.MACROS, [['USER=1'], ['EDITED=3'], ['ADDED=5']]);
  assert.deepEqual(fs.readFileSync(manifestPath), rootBytes);
  assert.equal(fs.readFileSync(path.join(source, 'variables_main-12345678.h'), 'utf8'), 'prior generated bytes');
  assert.equal(fs.readFileSync(path.join(source, 'objects_prior-12345678.h'), 'utf8'), 'old header to omit');
  assert.equal(f.config.sourceCapture.generatedHeaderCount, 1);
  assert.deepEqual(confirmBuildSource(f.config), f.config.sourceCapture);
  fs.writeFileSync(path.join(source, 'variables_main-12345678.h'), 'unrelated generated write');
  assert.equal(captureIdentity(f.config, f.profile).inputDigest, snapshot.inputDigest);
  assert.deepEqual(confirmBuildSource(f.config), f.config.sourceCapture);
  f.config.generatedArtifacts[0].content = 'different captured bytes';
  assert.throws(() => confirmBuildSource(f.config), { code: 'BUILD_SOURCE_STALE' });
  f.config.generatedArtifacts[0].content = 'current generated bytes';
  f.config.projectMacros[0].value = 'ADDED=6';
  assert.throws(() => confirmBuildSource(f.config), { code: 'BUILD_SOURCE_STALE' });
});

test('isolated Blockly cloud snapshots reject invalid generator paths and preserve absent overlays', t => {
  const f = fixture(t);
  const source = path.join(f.root, 'src');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'variables_main-12345678.h'), 'on disk');
  f.config.isolatedCloudBuild = true;
  const paths = () => captureSnapshot(f.config, f.profile).files.map(file => file.path);
  assert(paths().includes('sketch/variables_main-12345678.h'));
  f.config.generatedArtifacts = null;
  assert(paths().includes('sketch/variables_main-12345678.h'));
  f.capture();
  assert.equal(f.config.sourceCapture.generatedHeaderCount, 1);
  f.config.generatedArtifacts = [];
  assert(!paths().includes('sketch/variables_main-12345678.h'));
  f.capture();
  assert.equal(f.config.sourceCapture.generatedHeaderCount, 0);
  f.config.generatedArtifacts = [{ fileName: '../variables_main-12345678.h', content: '' }];
  assert.throws(paths, { code: 'BUILD_SOURCE_STALE' });
  delete f.config.generatedArtifacts;
  f.config.projectMacros = [{ name: 'INVALID', value: 'OTHER=1' }];
  assert.throws(paths, { code: 'BUILD_SOURCE_STALE' });
});

test('cloud compiler result preserves the exact submitted source and native workspace per original tool request', async t => {
  const f = fixture(t), result = await f.run(), ref = result.buildSource;
  assert.equal(ref.status, 'available');
  assert.equal(ref.kind, 'cloud-build-source');
  assert.equal(ref.buildRequestId, 'original-tool-1');
  assert.equal(ref.cloudRequestId, 'cloud-1');
  assert.equal(ref.jobId, result.jobId);
  assert.equal(ref.inputDigest, result.inputDigest);
  assert.equal(ref.sourceSha256, protocol.sha256(f.config.code));
  assert.equal(ref.abiHash, 'sha256:' + protocol.sha256(fs.readFileSync(path.join(f.root, 'project.abi'))));
  assert.notEqual(ref.abiHash, 'sha256:' + protocol.sha256(f.workspace.documentText));
  assert.equal(fs.readFileSync(ref.path, 'utf8'), f.config.code);
  const metadata = JSON.parse(fs.readFileSync(ref.metadataPath));
  assert.deepEqual(metadata.sourceCapture.workspace, f.config.sourceCapture.workspace);
  assert.equal(path.dirname(ref.path), result.artifactPath);
  assert.equal(fs.existsSync(path.join(f.root, '.aily/build-executions')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.temp/sketch/sketch.ino')), false);
});

test('warm cloud reuse binds a new request and current ABI without overwriting the original source receipt', async t => {
  const f = fixture(t), first = await f.run(), original = fs.readFileSync(first.buildSource.metadataPath);
  f.workspace.documentText = '{"pages":["same-code-new-native-identity"]}';
  fs.writeFileSync(path.join(f.root, 'project.abi'), '{"pages":["new saved native ABI"]}');
  f.workspace.revision++;
  f.capture();
  const second = await f.run();
  assert.equal(second.reused, true);
  assert.equal(f.jobs, 1);
  assert.equal(f.uploads, 1);
  assert.equal(second.buildSource.status, 'available');
  assert.equal(second.buildSource.buildRequestId, 'original-tool-2');
  assert.equal(second.buildSource.jobId, first.buildSource.jobId);
  assert.equal(second.buildSource.path, first.buildSource.path);
  assert.notEqual(second.buildSource.metadataPath, first.buildSource.metadataPath);
  assert.notEqual(second.buildSource.abiHash, first.buildSource.abiHash);
  assert.deepEqual(fs.readFileSync(first.buildSource.metadataPath), original);
});

test('upload reuses a signed Blockly build after an equivalent generator refresh', async t => {
  const f = fixture(t);
  f.config.isolatedCloudBuild = true;
  f.config.generatedArtifacts = [{ fileName: 'variables_main-12345678.h', content: '#define VALUE 1' }];
  f.capture();
  const original = f.config.sourceCapture;
  const result = await f.run();
  const sourceReceipt = fs.readFileSync(result.buildSource.metadataPath);
  const firmware = path.join(result.artifactPath, 'sketch.bin');
  const modified = fs.statSync(firmware).mtimeMs;

  // An upload needs a new, live capture before accepting an equivalent runtime.
  f.workspace.runtimeRevision++;
  f.capture();
  await assert.rejects(f.broker.acquireCurrentArtifact(f.sender, f.root), { code: 'BUILD_SOURCE_STALE' });
  assert.equal(await f.broker.reusable(f.sender, f.config), true);
  assert.equal(await f.broker.artifactPath(f.sender, f.root), result.artifactPath);
  const upload = await f.broker.acquireCurrentArtifact(f.sender, f.root);
  try {
    assert.deepEqual(upload.record.config.sourceCapture, original);
    assert.equal(upload.identity.inputDigest, result.inputDigest);
    await upload.assertCurrent();

    f.workspace.runtimeRevision++;
    f.capture();
    await assert.rejects(upload.assertCurrent(), { code: 'BUILD_SOURCE_STALE', sourceReason: 'generator' });
  } finally {
    upload.release();
  }

  // An edited program or changed generated header must not inherit upload authority.
  f.workspace.documentText = '{"pages":["edited native source"]}';
  f.workspace.revision++;
  f.capture();
  assert.equal(await f.broker.reusable(f.sender, f.config), false);
  f.workspace.documentText = '{"pages":["native-source"]}';
  f.config.generatedArtifacts = [{ fileName: 'variables_main-12345678.h', content: '#define VALUE 2' }];
  f.capture();
  assert.equal(await f.broker.reusable(f.sender, f.config), false);
  assert.equal(f.jobs, 1);
  assert.equal(fs.statSync(firmware).mtimeMs, modified);
  assert.deepEqual(fs.readFileSync(result.buildSource.metadataPath), sourceReceipt);
});

test('isolated cloud publication, reuse and upload keep the protected local cache untouched', async t => {
  const f = fixture(t), owner = acquireBuildWorkspace(f.root, 'compile');
  try {
    const localLock = path.join(f.root, '.build', 'aily-workspace.lock');
    const original = fs.readFileSync(localLock);
    f.config.isolatedCloudBuild = true;
    f.config.generatedArtifacts = [{ fileName: 'variables_scope-01234567.h', content: '#define VALUE 1' }];
    f.capture();

    const first = await f.run(), second = await f.run();
    const cloudRoot = path.join(f.root, '.aily', 'cloud-build');
    assert.equal(path.dirname(first.artifactPath), path.join(cloudRoot, '.build', 'cloud'));
    assert.equal(first.buildSource.status, 'available');
    assert.equal(first.buildSource.project, f.root);
    assert.equal(fs.readFileSync(first.buildSource.path, 'utf8'), f.config.code);
    assert.equal(second.reused, true);
    assert.equal(f.jobs, 1);
    assert.equal(await f.broker.reusable(f.sender, f.config), true);
    assert.equal(await f.broker.reusable(f.sender, { ...f.config, isolatedCloudBuild: false }), false);
    const upload = await f.broker.acquireCurrentArtifact(f.sender, f.root);
    try {
      assert.equal(upload.record.directory, first.artifactPath);
      assert.deepEqual(upload.record.config.generatedArtifacts, f.config.generatedArtifacts);
      upload.markDelegated();
      const isolatedOwner = JSON.parse(fs.readFileSync(path.join(cloudRoot, '.build', 'aily-workspace.lock')));
      assert.equal(isolatedOwner.operation, 'verify');
      assert.equal(isolatedOwner.delegated, true);
      await upload.assertCurrent();
    } finally { upload.release(); }

    f.broker.retention = { maxDirectories: 0 };
    f.broker.invalidate(f.root, f.sender);
    assert.equal(fs.existsSync(first.artifactPath), false);
    assert.equal(fs.existsSync(path.join(f.root, '.temp')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.build', 'cloud')), false);
    assert.deepEqual(fs.readFileSync(localLock), original);
  } finally { owner.release(); }
});

test('isolated cloud artifacts cannot follow a linked storage root', async t => {
  const f = fixture(t), other = path.join(f.root, 'unrelated'), coordination = path.join(f.root, '.aily');
  fs.mkdirSync(other);
  fs.mkdirSync(coordination);
  fs.symlinkSync(other, path.join(coordination, 'cloud-build'), process.platform === 'win32' ? 'junction' : 'dir');
  f.config.isolatedCloudBuild = true;
  f.capture();
  await assert.rejects(f.run(), { code: 'UNSAFE_PATH' });
  assert.deepEqual(fs.readdirSync(other), []);
  assert.equal(f.broker.active.has(f.root), false);
});

test('legacy caller without a source capture still compiles, but cannot claim bound source availability', async t => {
  const f = fixture(t);
  delete f.config.sourceCapture;
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.buildSource.status, 'unavailable');
  assert.equal(result.buildSource.path, undefined);
  assert.equal(fs.readdirSync(result.artifactPath).some(name => name.startsWith('aily-cloud-source-')), false);
});

test('saved ABI changed after source capture cannot be attributed to the completed cloud code', async t => {
  const f = fixture(t), request = f.broker.request;
  f.broker.request = async (...args) => {
    const result = await request(...args);
    if (args[1].endsWith('/result')) fs.writeFileSync(path.join(f.root, 'project.abi'), '{"different":"native input"}');
    return result;
  };
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.buildSource.status, 'available');
  assert.equal(result.buildSource.abiHash, undefined);
  assert.equal(fs.readFileSync(result.buildSource.path, 'utf8'), f.config.code);
});

test('a failed new cloud request does not return or retain the previous request source as current', async t => {
  const f = fixture(t), first = await f.run();
  f.config.code += '// changed\n';
  f.capture();
  f.status = 'failed';
  await assert.rejects(f.run());
  assert.equal(f.broker.active.size, 0);
  assert.equal(fs.readFileSync(first.buildSource.path, 'utf8').includes('// changed'), false);
  assert.equal(fs.existsSync(path.join(first.artifactPath, 'aily-cloud-source-' + protocol.sha256('original-tool-2') + '.json')), false);
});

test('Stop during cloud reuse verification cannot publish a new successful source receipt', async t => {
  const f = fixture(t), first = await f.run();
  const original = f.broker.acquireArtifactLease.bind(f.broker);
  f.broker.acquireArtifactLease = record => { const lease = original(record); void f.broker.cancel(f.sender, 'cloud-2'); return lease; };
  await assert.rejects(f.run(), { code: 'CANCELLED' });
  assert.equal(f.broker.active.size, 0);
  assert.equal(fs.existsSync(path.join(first.artifactPath, 'aily-cloud-source-' + protocol.sha256('original-tool-2') + '.json')), false);
});

test('tampered diagnostic source is never overwritten or represented as the reused firmware input', async t => {
  const f = fixture(t), first = await f.run();
  fs.chmodSync(first.buildSource.path, 0o600);
  fs.writeFileSync(first.buildSource.path, 'tampered source');
  const second = await f.run();
  assert.equal(second.reused, true);
  assert.equal(second.success, true);
  assert.equal(second.buildSource.status, 'unavailable');
  assert.equal(second.buildSource.path, undefined);
  assert.equal(fs.readFileSync(first.buildSource.path, 'utf8'), 'tampered source');
});

test('actual broker new/reused source references are consumed by the paired Lex source verifier and artifact publisher', {
  skip: !process.env.AILY_LEX_SOURCE_ROOT,
}, async t => {
  const f = fixture(t), first = await f.run(), second = await f.run();
  f.config.isolatedCloudBuild = true;
  f.capture();
  const isolated = await f.run();
  const input = path.join(f.root, 'source-consumer-input.json');
  fs.writeFileSync(input, JSON.stringify([first, second, isolated].map(result => ({ expectedCode: f.config.code,
    reply: { ok: true, project: f.root, buildSource: result.buildSource,
      buildReceipt: { version: 1, requestId: result.buildSource.buildRequestId, project: f.root, state: 'completed' },
      verification: { scope: 'project-compilation', status: 'passed' } } }))));
  const consumer = path.join(process.env.AILY_LEX_SOURCE_ROOT, 'packages/aily-agent/test/fixtures/cloud-build-source-consumer.mjs');
  execFileSync(process.execPath, [consumer, input], { windowsHide: true,
    env: { ...process.env, AILY_SELF_OPERATION_SOURCE_TEST: '1' }, timeout: 30_000 });
});
