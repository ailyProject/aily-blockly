'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const protocol = require('../../electron/cloud-build/protocol');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-reuse-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardModule = '@aily-project/board-test';
  const boardPackage = { name: boardModule, version: '1.0.0' }, board = {};
  const boardRoot = path.join(root, 'node_modules', boardModule);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(boardPackage));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), JSON.stringify(board));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test', dependencies: { [boardModule]: '1.0.0' } }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/header.h'), '#define VALUE 1');
  const f = { root, generation: 1, activationId: 'editor-1', jobs: 0, uploads: 0, requestId: 0, settings: { gatewayUrl: 'http://localhost:4318' },
    profile: { profileDigest: 'a'.repeat(64), runner: 'aily-builder', boardModule, boardVersion: '1.0.0',
      boardDigest: protocol.boardDigest(boardPackage, board), capabilities: { compile: true, analysis: true },
      metadata: { boardOptions: { FlashSize: {} }, defaults: { FlashSize: '4M' } } },
    keys: crypto.generateKeyPairSync('ed25519'), sender: {}, events: [],
    config: { currentProjectPath: root, boardModule, code: 'void setup() {}\nvoid loop() {}' } };
  const bytes = Buffer.from('firmware bytes');
  const artifact = { artifactId: 'firmware', path: 'sketch.bin', role: 'firmware', sizeBytes: bytes.length, sha256: protocol.sha256(bytes) };
  const broker = f.broker = new CloudBuildBroker({ pollIntervalMs: 1, initialPollIntervalMs: 0, artifactRetryDelayMs: 0,
    getOwner: () => ({ generation: f.generation }), fetch: async () => new Response(bytes),
    querySource: async () => ({ ok: true, source: { projectPath: root, boardModule, activationId: f.activationId, mode: 'blockly' } }) });
  broker.capabilities = async () => ({ protocolVersion: 1, publicKey: f.keys.publicKey.export({ type: 'spki', format: 'pem' }) });
  broker.targets = async () => ({ profiles: [f.profile] });
  broker.uploadSnapshot = async record => { f.uploads++; f.snapshot = record.snapshot; return { inputDigest: record.snapshot.inputDigest, snapshotId: 'input' }; };
  broker.request = async (_settings, endpoint, body) => {
    if (endpoint === '/api/v1/build/jobs') { f.jobs++; f.action = body.action; return { jobId: 'job-' + f.jobs }; }
    if (endpoint.includes('/logs?') || endpoint.endsWith('/cancel')) return {};
    if (endpoint.endsWith('/result')) {
      const manifest = { schemaVersion: 1, kind: 'aily-cloud-build-result', jobId: 'job-' + f.jobs,
        inputDigest: f.snapshot.inputDigest, profileDigest: f.profile.profileDigest, boardDigest: f.snapshot.boardDigest,
        boardModule, boardVersion: '1.0.0', action: f.action, attempt: 1, runner: 'aily-builder', fixture: false, artifacts: [artifact] };
      const signature = { algorithm: 'Ed25519', value: crypto.sign(null, Buffer.from(protocol.canonicalJson(manifest)), f.keys.privateKey).toString('base64') };
      return { manifest, signature, artifacts: [{ ...artifact, downloadUrl: '/api/v1/build/artifacts/firmware' }] };
    }
    return { status: 'succeeded', attempt: 1, lastSeq: 0 };
  };
  f.run = (action = 'compile') => broker.run(f.sender, { requestId: 'run-' + ++f.requestId, action,
    profileDigest: f.profile.profileDigest, settings: f.settings, config: { ...f.config } }, event => f.events.push(event));
  f.manifest = update => { const filename = path.join(root, 'package.json'); const pkg = JSON.parse(fs.readFileSync(filename)); update(pkg); fs.writeFileSync(filename, JSON.stringify(pkg)); };
  return f;
}

function authenticated(f) {
  f.subject = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', user_type: 'user' };
  f.settings = { gatewayUrl: 'https://api.aily.pro', publicKey: f.keys.publicKey.export({ type: 'spki', format: 'pem' }) };
  f.broker.getAuth = async () => ({ ok: true, authenticated: true, apiServer: f.settings.gatewayUrl, generation: 1,
    accessToken: `e30.${Buffer.from(JSON.stringify({ sub: JSON.stringify(f.subject) })).toString('base64url')}.fixture` });
  return f;
}

test('identical current inputs reuse signed bytes without upload or a new cloud job', async t => {
  const f = fixture(t); const first = await f.run(), second = await f.run();
  assert.equal(first.reused, undefined); assert.equal(second.reused, true);
  assert.equal(second.jobId, first.jobId); assert.equal(second.artifactPath, first.artifactPath);
  assert.equal(f.jobs, 1); assert.equal(f.uploads, 1);
  assert.equal(await f.broker.reusable(f.sender, f.config, f.profile.profileDigest), true);
  assert.equal(f.events.at(-1).reused, true);
  assert.equal(f.broker.requests.size, 0); assert.equal(f.broker.artifactUsers.size, 0);
});

test('the same user can reuse signed output after token role and subject serialization change', async t => {
  const f = authenticated(fixture(t)), first = await f.run();
  f.subject = { user_type: 'admin', id: f.subject.id };
  const second = await f.run();
  assert.equal(second.reused, true); assert.equal(second.jobId, first.jobId);
  assert.equal(f.jobs, 1); assert.equal(f.uploads, 1);
  assert.equal(await f.broker.reusable(f.sender, f.config, f.profile.profileDigest), true);
});

test('an account switch creates a new cloud job instead of reusing the previous user output', async t => {
  const f = authenticated(fixture(t)), first = await f.run();
  f.subject.id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const second = await f.run();
  assert.equal(second.reused, undefined); assert.notEqual(second.jobId, first.jobId);
  assert.equal(f.jobs, 2); assert.equal(f.uploads, 2);
});

test('completed artifacts reject a different token user before any owner snapshot invalidation', async t => {
  const f = authenticated(fixture(t)); await f.run();
  f.subject.id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await assert.rejects(f.broker.artifactPath(f.sender, f.root, f.config), { code: 'AUTH_ACCOUNT_CHANGED' });
  assert.equal(await f.broker.reusable(f.sender, f.config, f.profile.profileDigest), false);
  assert.equal(f.jobs, 1);
});

test('build metadata changes do not invalidate identical build inputs', async t => {
  const f = fixture(t); await f.run();
  f.manifest(pkg => { pkg.buildInfo = { lastBuildTime: new Date().toISOString() }; pkg.codeHash = 'new receipt'; });
  assert.equal((await f.run()).reused, true);
});

for (const [name, change] of [
  ['generated sketch', f => { f.config.code += '\n// edit'; }],
  ['same-size source edit with restored mtime', f => { const file = path.join(f.root, 'src/header.h'), stat = fs.statSync(file); fs.writeFileSync(file, '#define VALUE 2'); fs.utimesSync(file, stat.atime, stat.mtime); }],
  ['added source', f => fs.writeFileSync(path.join(f.root, 'src/new.h'), 'int extra;')],
  ['deleted source', f => fs.unlinkSync(path.join(f.root, 'src/header.h'))],
  ['macros', f => f.manifest(pkg => { pkg.MACROS = ['FEATURE=1']; })],
  ['board option', f => f.manifest(pkg => { pkg.projectConfig = { FlashSize: '8M' }; })],
  ['profile identity', f => { f.profile.profileDigest = 'b'.repeat(64); }],
  ['gateway identity', f => { f.settings.gatewayUrl = 'http://localhost:4319'; }],
  ['gateway signing key', f => { f.keys = crypto.generateKeyPairSync('ed25519'); }],
  ['owner generation', f => { f.generation++; }],
  ['editor activation', f => { f.activationId = 'editor-2'; }],
  ['renderer', f => { f.sender = {}; }],
  ['damaged artifact', f => { const record = f.broker.active.get(f.root); fs.writeFileSync(path.join(record.directory, 'sketch.bin'), 'firmware wrong'); }],
  ['missing artifact', f => { const record = f.broker.active.get(f.root); fs.unlinkSync(path.join(record.directory, 'sketch.bin')); }],
  ['invalid signature', f => { f.broker.active.get(f.root).signature.value = 'invalid'; }],
  ['explicit invalidation', f => f.broker.invalidate(f.root, f.sender)],
]) test(`${name} submits a new task instead of reusing stale output`, async t => {
  const f = fixture(t); await f.run(); change(f);
  const result = await f.run(); assert.equal(result.reused, undefined); assert.equal(f.jobs, 2); assert.equal(f.uploads, 2);
});

test('analysis requests never reuse a compilation result', async t => {
  const f = fixture(t); await f.run(); assert.equal((await f.run('analysis')).reused, undefined); assert.equal(f.jobs, 2);
});

test('a disk result alone cannot restore reuse authority', async t => {
  const f = fixture(t); const first = await f.run(); f.broker.active.clear();
  assert.equal(fs.existsSync(path.join(first.artifactPath, 'aily-cloud-result.json')), true);
  assert.equal((await f.run()).reused, undefined); assert.equal(f.jobs, 2);
});

test('cancel during reuse verification cannot publish or cancel the previous completed job', async t => {
  const f = fixture(t); await f.run();
  const original = f.broker.acquireArtifactLease.bind(f.broker);
  f.broker.acquireArtifactLease = record => { const lease = original(record); void f.broker.cancel(f.sender, 'run-2'); return lease; };
  await assert.rejects(f.run(), { code: 'CANCELLED' });
  assert.equal(f.jobs, 1); assert.equal(f.broker.active.size, 0); assert.equal(f.broker.artifactUsers.size, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.build/aily-workspace.lock')), false);
});

test('source changed during the final owner check rejects the cached result', async t => {
  const f = fixture(t); await f.run(); let verifying = false;
  const originalLease = f.broker.acquireArtifactLease.bind(f.broker), originalSource = f.broker.querySource;
  f.broker.acquireArtifactLease = record => { verifying = true; return originalLease(record); };
  f.broker.querySource = async (...args) => { if (verifying) fs.writeFileSync(path.join(f.root, 'src/header.h'), '#define VALUE 3'); return originalSource(...args); };
  await assert.rejects(f.run(), { code: 'BUILD_SOURCE_STALE' });
  assert.equal(f.jobs, 1); assert.equal(f.broker.active.size, 0);
});

test('a same-version npm library edit invalidates reuse', async t => {
  const f = fixture(t), name = '@aily-project/lib-example';
  const root = path.join(f.root, 'node_modules', name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  const file = path.join(root, 'src/example.h'); fs.writeFileSync(file, '#define LIB_VALUE 1');
  f.manifest(pkg => { pkg.dependencies[name] = '1.0.0'; });
  await f.run(); assert.equal((await f.run()).reused, true);
  const stat = fs.statSync(file); fs.writeFileSync(file, '#define LIB_VALUE 2'); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await f.run()).reused, undefined); assert.equal(f.jobs, 2);
});

test('custom partition bytes participate in reuse identity', async t => {
  const f = fixture(t), partition = path.join(f.root, 'partitions.csv');
  f.manifest(pkg => { pkg.projectConfig = { PartitionScheme: 'custom' }; });
  fs.writeFileSync(partition, 'app0,app,ota_0,0x10000,0x200000\n');
  await f.run(); assert.equal((await f.run()).reused, true);
  fs.writeFileSync(partition, 'app0,app,ota_0,0x10000,0x300000\n');
  assert.equal((await f.run()).reused, undefined); assert.equal(f.jobs, 2);
});

test('Coder entry and helper files use the same verified-result policy', async t => {
  const f = fixture(t), sketch = path.join(f.root, 'sketch/src');
  fs.mkdirSync(sketch, { recursive: true });
  fs.writeFileSync(path.join(sketch, 'main.cpp'), f.config.code);
  fs.writeFileSync(path.join(sketch, 'helper.h'), '#define VALUE 1');
  f.manifest(pkg => { pkg.type = 'coder'; pkg.entry = 'src/main.cpp'; });
  f.broker.querySource = async () => ({ ok: true, source: { projectPath: f.root, boardModule: f.config.boardModule, activationId: f.activationId, mode: 'coder', saved: true } });
  await f.run(); assert.equal((await f.run()).reused, true);
  fs.writeFileSync(path.join(sketch, 'helper.h'), '#define VALUE 2');
  assert.equal((await f.run()).reused, undefined); assert.equal(f.jobs, 2);
});

test('unsaved Coder state cannot reuse an older saved firmware', async t => {
  const f = fixture(t); await f.run();
  f.broker.querySource = async () => ({ ok: true, source: { projectPath: f.root, boardModule: f.config.boardModule, activationId: f.activationId, mode: 'coder', saved: false } });
  await assert.rejects(f.run(), { code: 'BUILD_SOURCE_STALE' });
  assert.equal(f.jobs, 1); assert.equal(f.broker.active.size, 0);
});

test('artifact replaced during async owner verification is recompiled', async t => {
  const f = fixture(t); await f.run(); let verifying = false, replaced = false;
  const previous = f.broker.active.get(f.root), lease = f.broker.acquireArtifactLease.bind(f.broker), query = f.broker.querySource;
  f.broker.acquireArtifactLease = record => { verifying = true; return lease(record); };
  f.broker.querySource = async (...args) => {
    if (verifying && !replaced) { replaced = true; fs.writeFileSync(path.join(previous.directory, 'sketch.bin'), 'tampered'); }
    return query(...args);
  };
  assert.equal((await f.run()).reused, undefined); assert.equal(f.jobs, 2);
});
