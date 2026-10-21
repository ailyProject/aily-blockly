const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const vm = require('node:vm');

const integrationModulePromise = loadIntegrationModule();
const now = 2_000_000_000_000;
const projectIdentity = 'project-main';
const workspaceIdentity = 'workspace-main';
const sceneId = 'main';
const emptyRevision = '0'.repeat(64);

test('Project callbacks persist a CAS Scene and exchange bounded Artifact bytes through the real Host SDK', async t => {
  const {
    SimulatorProjectArtifactCallbackAuthority,
    SimulatorProjectHostProviderAdapter,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firmware = Buffer.from('firmware-v1');
  const artifact = artifactFixture(firmware, 'a'.repeat(64));
  await fs.mkdir(path.join(root, '.build'), { recursive: true });
  await fs.writeFile(path.join(root, '.build', 'firmware.bin'), firmware);
  await fs.writeFile(
    path.join(root, '.build', 'aily-artifact-manifest.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root,
    projectIdentity,
    workspaceIdentity,
    sceneId,
    files: nodeFilePort(),
    now: () => now,
    createArtifactReference: () => `host-artifact-v1-${'b'.repeat(64)}`,
    createSceneCommitId: () => `scene-commit-v1-${'c'.repeat(64)}`,
  });
  const adapter = new SimulatorProjectHostProviderAdapter({
    ...authority.callbacks,
    now: () => now,
  });
  t.after(() => {
    adapter.close();
    authority.close();
  });

  const empty = await createEmptySceneEditorDocumentV2(sceneId);
  const initialDescriptor = {
    schemaVersion: 1,
    kind: 'aily-project-scene-network-descriptor',
    projectIdentity,
    sceneId,
    storageRevision: emptyRevision,
    document: empty,
    runtimeAttachment: null,
    artifactAlignment: 'detached',
  };
  const writeResult = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.scene.write',
    {
      projectIdentity,
      sceneId,
      expectedStorageRevision: emptyRevision,
      descriptor: initialDescriptor,
    },
  ));
  assert.equal(writeResult.status, 'succeeded');
  assert.match(writeResult.payload.storageRevision, /^[a-f0-9]{64}$/);
  assert.notEqual(writeResult.payload.storageRevision, emptyRevision);

  const contextResult = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.context.read',
    { projectIdentity },
  ));
  assert.equal(contextResult.status, 'succeeded');
  assert.deepEqual(contextResult.payload, {
    schemaVersion: 1,
    kind: 'aily-simulator-host-project-context-snapshot',
    projectIdentity,
    workspaceIdentity,
    activeSceneId: sceneId,
    activeArtifactRevision: artifact.artifactId,
    workspaceSourceSha256: null,
  });

  const sceneResult = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.scene.read',
    { projectIdentity, sceneId },
  ));
  assert.equal(sceneResult.status, 'succeeded');
  assert.equal(
    sceneResult.payload.storageRevision,
    writeResult.payload.storageRevision,
  );
  assert.equal(sceneResult.payload.runtimeAttachment, null);

  const staleWrite = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.scene.write',
    {
      projectIdentity,
      sceneId,
      expectedStorageRevision: emptyRevision,
      descriptor: initialDescriptor,
    },
  ));
  assert.equal(staleWrite.status, 'failed');
  assert.equal(staleWrite.errorCode, 'conflict');

  const artifactResult = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.artifact.read',
    { projectIdentity, artifactRevision: artifact.artifactId },
  ));
  assert.equal(artifactResult.status, 'succeeded');
  assert.equal(
    artifactResult.payload.artifactReference,
    `host-artifact-v1-${'b'.repeat(64)}`,
  );
  assert.equal(JSON.stringify(artifactResult).includes(root), false);

  const firstChunk = await adapter.handleArtifactChunk(chunkRequest(
    artifactResult.payload,
    0,
    4,
    'd',
  ));
  assert.equal(firstChunk.status, 'succeeded');
  assert.equal(firstChunk.eof, false);
  assert.equal(Buffer.from(firstChunk.dataBase64, 'base64').toString(), 'firm');
  const finalChunk = await adapter.handleArtifactChunk(chunkRequest(
    artifactResult.payload,
    4,
    64,
    'e',
  ));
  assert.equal(finalChunk.status, 'succeeded');
  assert.equal(finalChunk.eof, true);
  assert.equal(
    Buffer.from(finalChunk.dataBase64, 'base64').toString(),
    'ware-v1',
  );
});

test('Project context preserves Artifact discovery while reporting live source unavailable, current, failure, or cancellation', async t => {
  const { SimulatorProjectArtifactCallbackAuthority } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-source-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.build'));
  const firmware = Buffer.from('source-context');
  const artifact = artifactFixture(firmware, 'a'.repeat(64));
  const manifestPath = path.join(root, '.build', 'aily-artifact-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(artifact));
  let source = null;
  let failure = null;
  let duringRead = () => {};
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, projectIdentity, workspaceIdentity, files: nodeFilePort(),
    readWorkspaceSource: async signal => {
      duringRead(signal);
      if (failure) throw failure;
      return source === null ? null : { sha256: source, isCurrent: () => true };
    },
  });
  t.after(() => authority.close());
  const read = signal => authority.callbacks.readContext({ projectIdentity }, signal);
  const signal = new AbortController().signal;
  let result = await read(signal);
  assert.equal(result.activeArtifactRevision, artifact.artifactId);
  assert.equal(result.workspaceSourceSha256, null);
  source = 'c'.repeat(64);
  result = await read(signal);
  assert.equal(result.activeArtifactRevision, artifact.artifactId);
  assert.equal(result.workspaceSourceSha256, source);
  await fs.unlink(manifestPath);
  result = await read(signal);
  assert.equal(result.activeArtifactRevision, null);
  assert.equal(result.workspaceSourceSha256, source);
  failure = new Error('source-generation-failed');
  await assert.rejects(read(signal), error => error === failure);
  failure = null;
  const abort = new AbortController();
  duringRead = () => abort.abort();
  await assert.rejects(read(abort.signal), error => error.code === 'cancelled');
});

test('normal Host product source callback fences generation, async hash races, project scope, and cancellation', async () => {
  const currentRoot = 'D:\\projects\\source-current';
  let revision = 1;
  let code = 'void setup() {}\nvoid loop() {}\n';
  let reusable = true;
  let onDigest = () => {};
  let captured;
  const project = {
    currentProjectPath: currentRoot, isProjectOpening: false,
    isAilyCodeProject: () => false,
    projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
  };
  const Service = await loadHostProductService({
    digest: async (_algorithm, bytes) => {
      onDigest();
      return Uint8Array.from(crypto.createHash('sha256').update(bytes).digest()).buffer;
    },
    onComposition: options => { captured = options; },
  });
  const blockly = {
    getWorkspaceContentRevision: () => revision,
    getReusableGeneratedCode: () => reusable ? code : null,
  };
  const service = new Service({}, project, {}, {}, {}, {}, blockly, {}, {});
  const session = await service.open({ hostInstanceId: 'source-test', transport: {} });
  try {
    const read = async signal => {
      const source = await captured.readWorkspaceSource(signal);
      return source?.isCurrent() ? source.sha256 : null;
    };
    const signal = new AbortController().signal;
    assert.equal(await read(signal), sha256(code));
    reusable = false;
    assert.equal(await read(signal), null);
    reusable = true;
    for (const mutation of [
      () => { revision++; },
      () => { code += '// changed\n'; },
      () => { reusable = false; },
      () => { project.currentProjectPath = 'D:\\projects\\other'; },
      () => { project.isProjectOpening = true; },
    ]) {
      project.currentProjectPath = currentRoot;
      project.isProjectOpening = false;
      reusable = true;
      onDigest = mutation;
      assert.equal(await read(signal), null);
      onDigest = () => {};
    }
    for (const mutation of [
      () => { revision++; },
      () => { code += '// after hash\n'; },
      () => { reusable = false; },
      () => { project.currentProjectPath = 'D:\\projects\\other'; },
      () => { project.isProjectOpening = true; },
    ]) {
      project.currentProjectPath = currentRoot;
      project.isProjectOpening = false;
      reusable = true;
      const snapshot = await captured.readWorkspaceSource(signal);
      assert.equal(snapshot.sha256, sha256(code));
      assert.equal(snapshot.isCurrent(), true);
      mutation();
      assert.equal(snapshot.isCurrent(), false);
    }
    project.currentProjectPath = currentRoot;
    project.isProjectOpening = false;
    reusable = true;
    const controller = new AbortController();
    onDigest = () => controller.abort();
    await assert.rejects(read(controller.signal), error => error.code === 'cancelled');
    await assert.rejects(read(controller.signal), error => error.code === 'cancelled');
    onDigest = () => { throw new Error('hash-failed'); };
    await assert.rejects(read(signal), /hash-failed/);
  } finally {
    await session.close();
  }
});

test('Project context refuses during-source-await same-source manifest replacement or removal', async t => {
  const { SimulatorProjectArtifactCallbackAuthority } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-source-manifest-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.build'));
  const firmware = Buffer.from('manifest-race');
  const original = artifactFixture(firmware, 'a'.repeat(64));
  const replacement = artifactFixture(Buffer.from('rebuilt-manifest-race'), 'a'.repeat(64));
  assert.notEqual(original.artifactId, replacement.artifactId);
  assert.equal(original.build.source.sha256, replacement.build.source.sha256);
  const manifestPath = path.join(root, '.build', 'aily-artifact-manifest.json');
  const signal = new AbortController().signal;
  let reads = 0;
  const baseFiles = nodeFilePort();
  const files = {
    ...baseFiles,
    async readFile(filePath, inputSignal) {
      if (filePath === manifestPath) reads++;
      return baseFiles.readFile(filePath, inputSignal);
    },
  };
  for (const mutation of [
    () => fs.writeFile(manifestPath, JSON.stringify(replacement)),
    () => fs.unlink(manifestPath),
  ]) {
    await fs.writeFile(manifestPath, JSON.stringify(original));
    reads = 0;
    const authority = new SimulatorProjectArtifactCallbackAuthority({
      projectRoot: root, projectIdentity, workspaceIdentity, files,
      readWorkspaceSource: async () => {
        await mutation();
        return { sha256: original.build.source.sha256, isCurrent: () => true };
      },
    });
    try {
      const result = await authority.callbacks.readContext({ projectIdentity }, signal);
      assert.equal(result.activeArtifactRevision, null);
      assert.equal(result.workspaceSourceSha256, original.build.source.sha256);
      assert.ok(reads <= 2, 'context uses only a bounded manifest recheck');
    } finally { authority.close(); }
  }
});

test('Project context runs final source/project guard after the second manifest await', async t => {
  const { SimulatorProjectArtifactCallbackAuthority } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-source-final-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.build'));
  const artifact = artifactFixture(Buffer.from('final-guard'), 'a'.repeat(64));
  const manifestPath = path.join(root, '.build', 'aily-artifact-manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(artifact));
  let current = true;
  let reads = 0;
  const baseFiles = nodeFilePort();
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, projectIdentity, workspaceIdentity,
    files: {
      ...baseFiles,
      async readFile(filePath, signal) {
        const bytes = await baseFiles.readFile(filePath, signal);
        if (filePath === manifestPath && ++reads === 2) current = false;
        return bytes;
      },
    },
    readWorkspaceSource: async () => ({ sha256: artifact.build.source.sha256, isCurrent: () => current }),
  });
  t.after(() => authority.close());
  const result = await authority.callbacks.readContext({ projectIdentity }, new AbortController().signal);
  assert.equal(reads, 2);
  assert.equal(result.activeArtifactRevision, artifact.artifactId);
  assert.equal(result.workspaceSourceSha256, null);
});

test('Project callbacks keep the frozen real head bytes and storage revision through the shared codec', async t => {
  const { SimulatorProjectArtifactCallbackAuthority } = await integrationModulePromise;
  const goldenBytes = await fs.readFile(path.resolve(__dirname,
    '../../aily-simulator/packages/simulator-protocol/test/fixtures/project-scene-head-v1-real.json'));
  assert.equal(goldenBytes.length, 64912);
  assert.equal(sha256(goldenBytes), 'f97214a72a2ed43a854a88dd9f930341c5d8e7d45db9b7a18898a647404650fb');
  const golden = JSON.parse(goldenBytes.toString('utf8'));
  const scope = { projectIdentity: golden.descriptor.projectIdentity, sceneId: golden.descriptor.sceneId };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-head-golden-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, ...scope, workspaceIdentity, files: nodeFilePort(),
    createSceneCommitId: () => golden.commitId,
  });
  t.after(() => authority.close());
  const signal = new AbortController().signal;
  const missing = await authority.callbacks.readScene(scope, signal);
  assert.equal(missing.kind, 'aily-simulator-host-project-scene-missing');
  const descriptor = await authority.callbacks.writeScene({
    ...scope, expectedStorageRevision: emptyRevision,
    descriptor: { ...structuredClone(golden.descriptor), storageRevision: emptyRevision },
  }, signal);
  assert.deepEqual(descriptor, golden.descriptor);
  const headPath = path.join(root, '.aily/simulator/scene-network-v2.json');
  assert.deepEqual(await fs.readFile(headPath), goldenBytes);
  assert.deepEqual(await authority.callbacks.readScene(scope, signal), golden.descriptor);
  await assert.rejects(authority.callbacks.writeScene({
    ...scope, expectedStorageRevision: emptyRevision,
    descriptor: { ...golden.descriptor, storageRevision: emptyRevision },
  }, signal), error => error.code === 'conflict');
  // Reusing the same commit/content must not pretend to advance a revision.
  await assert.rejects(authority.callbacks.writeScene({
    ...scope, expectedStorageRevision: descriptor.storageRevision, descriptor,
  }, signal), error => error.code === 'conflict');
  assert.deepEqual(await fs.readFile(headPath), goldenBytes);
});

test('Project callbacks reject corrupt heads and direct descriptors as operation-failed without rewriting them', async t => {
  const { SimulatorProjectArtifactCallbackAuthority, SimulatorProjectHostProviderAdapter } = await integrationModulePromise;
  const goldenBytes = await fs.readFile(path.resolve(__dirname,
    '../../aily-simulator/packages/simulator-protocol/test/fixtures/project-scene-head-v1-real.json'));
  const golden = JSON.parse(goldenBytes.toString('utf8'));
  const scope = { projectIdentity: golden.descriptor.projectIdentity, sceneId: golden.descriptor.sceneId };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-head-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const headPath = path.join(root, '.aily/simulator/scene-network-v2.json');
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, ...scope, workspaceIdentity, files: nodeFilePort(),
  });
  const adapter = new SimulatorProjectHostProviderAdapter({ ...authority.callbacks, now: () => now });
  t.after(() => { adapter.close(); authority.close(); });
  const missingCommit = structuredClone(golden);
  delete missingCommit.commitId;
  const invalidHeads = [
    golden.descriptor,
    { ...golden, kind: 'connection_output' },
    { ...golden, extra: true },
    missingCommit,
    { ...golden, commitId: '' },
    { ...golden, descriptor: { ...golden.descriptor, storageRevision: 'a'.repeat(64) } },
    { ...golden, descriptor: { ...golden.descriptor, projectIdentity: 'project-other' } },
    { ...golden, descriptor: { ...golden.descriptor, artifactAlignment: 'aligned' } },
    { ...golden, descriptor: { ...golden.descriptor, runtimeAttachment: projectHeadRuntimeAttachment(golden.descriptor), artifactAlignment: 'aligned' } },
  ];
  for (const [index, head] of invalidHeads.entries()) {
    const bytes = Buffer.from(JSON.stringify(head));
    await fs.writeFile(headPath, bytes);
    const result = await adapter.handleInvocation(providerInvocation('project', 'project.scene.read', scope, `invalid-${index}`));
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'operation-failed');
    assert.deepEqual(await fs.readFile(headPath), bytes);
    assert.equal(JSON.stringify(result).includes(root), false);
  }
});

test('Project callbacks preserve explicit write errors, factory errors, queued conflicts and cancellation', async t => {
  const { SimulatorProjectArtifactCallbackAuthority, SimulatorProjectHostProviderAdapter, createEmptySceneEditorDocumentV2 } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-head-errors-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = { projectIdentity, sceneId };
  const descriptor = {
    schemaVersion: 1, kind: 'aily-project-scene-network-descriptor', ...scope,
    storageRevision: emptyRevision, document: await createEmptySceneEditorDocumentV2(sceneId),
    runtimeAttachment: null, artifactAlignment: 'detached',
  };
  const signal = new AbortController().signal;
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, ...scope, workspaceIdentity, files: nodeFilePort(),
    createSceneCommitId: () => 'scene-commit-fixed',
  });
  t.after(() => authority.close());
  const write = (value, expectedStorageRevision = emptyRevision) => authority.callbacks.writeScene({
    ...scope, expectedStorageRevision, descriptor: value,
  }, signal);
  await assert.rejects(write({ ...descriptor, projectIdentity: 'project-other' }), error => error.code === 'invalid-request');
  await assert.rejects(write({ ...descriptor, storageRevision: 'a'.repeat(64) }), error => error.code === 'invalid-request');
  await assert.rejects(write({ ...descriptor, runtimeAttachment: projectHeadRuntimeAttachment(descriptor), artifactAlignment: 'aligned' }), error => error.code === 'invalid-request');
  await assert.rejects(write({ ...descriptor, kind: 'wrong' }), error => error.name === 'ProtocolValidationError' && error.code === undefined);
  const badFactory = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root, ...scope, workspaceIdentity, files: nodeFilePort(), createSceneCommitId: () => '',
  });
  t.after(() => badFactory.close());
  await assert.rejects(badFactory.callbacks.writeScene({ ...scope, expectedStorageRevision: emptyRevision, descriptor }, signal), error => error instanceof TypeError && error.code === undefined);
  const badFactoryAdapter = new SimulatorProjectHostProviderAdapter({ ...badFactory.callbacks, now: () => now });
  t.after(() => badFactoryAdapter.close());
  const failedFactory = await badFactoryAdapter.handleInvocation(providerInvocation('project', 'project.scene.write', {
    ...scope, expectedStorageRevision: emptyRevision, descriptor,
  }));
  assert.equal(failedFactory.status, 'failed');
  assert.equal(failedFactory.errorCode, 'operation-failed');
  const queued = await Promise.allSettled([write(descriptor), write(descriptor)]);
  assert.equal(queued[0].status, 'fulfilled');
  assert.equal(queued[1].status, 'rejected');
  assert.equal(queued[1].reason.code, 'conflict');
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(authority.callbacks.readScene(scope, cancel.signal), error => error.code === 'cancelled');
  authority.close();
  await assert.rejects(authority.callbacks.readScene(scope, signal), error => error.code === 'cancelled');
});

test('Project callbacks keep regular-file and root checks outside the pure head codec', async t => {
  const { SimulatorProjectArtifactCallbackAuthority } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-head-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scope = { projectIdentity, sceneId };
  const signal = new AbortController().signal;
  let reads = 0;
  for (const mode of ['symlink', 'directory', 'oversize', 'escaped-root', 'permission-denied']) {
    const files = {
      ...nodeFilePort(),
      async lstat() {
        if (mode === 'permission-denied') throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return { size: mode === 'oversize' ? 32 * 1024 * 1024 + 1 : 1, isFile: mode !== 'directory', isSymbolicLink: mode === 'symlink' };
      },
      async realpath(value) {
        return value === root ? root : path.resolve(root, '..', 'outside-head.json');
      },
      async readFile() { reads += 1; throw new Error('unsafe file must not be read'); },
    };
    const authority = new SimulatorProjectArtifactCallbackAuthority({
      projectRoot: root, ...scope, workspaceIdentity, files,
    });
    try {
      await assert.rejects(authority.callbacks.readScene(scope, signal), error => error.code === 'operation-failed');
    } finally { authority.close(); }
  }
  assert.equal(reads, 0);
});

test('Project callback authority rejects cross-project scope and invalid Artifact handles without leaking paths', async t => {
  const {
    SimulatorProjectArtifactCallbackAuthority,
    SimulatorProjectHostProviderAdapter,
  } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-project-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.build'), { recursive: true });
  const firmware = Buffer.from('x');
  const artifact = artifactFixture(firmware, 'a'.repeat(64));
  await fs.writeFile(path.join(root, '.build', 'firmware.bin'), firmware);
  await fs.writeFile(
    path.join(root, '.build', 'aily-artifact-manifest.json'),
    JSON.stringify(artifact),
  );
  const authority = new SimulatorProjectArtifactCallbackAuthority({
    projectRoot: root,
    projectIdentity,
    workspaceIdentity,
    files: nodeFilePort(),
    now: () => now,
    createArtifactReference: () => `host-artifact-v1-${'f'.repeat(64)}`,
  });
  const adapter = new SimulatorProjectHostProviderAdapter({
    ...authority.callbacks,
    now: () => now,
  });
  t.after(() => {
    adapter.close();
    authority.close();
  });

  const wrongProject = await adapter.handleInvocation(providerInvocation(
    'project',
    'project.context.read',
    { projectIdentity: 'project-other' },
  ));
  assert.equal(wrongProject.status, 'failed');
  assert.equal(wrongProject.errorCode, 'conflict');

  const missingReference = await adapter.handleArtifactChunk({
    schemaVersion: 1,
    kind: 'aily-simulator-host-artifact-chunk-request',
    transferId: `artifact-transfer-v1-${'1'.repeat(64)}`,
    projectIdentity,
    artifactReference: `host-artifact-v1-${'2'.repeat(64)}`,
    artifactRevision: artifact.artifactId,
    path: 'firmware.bin',
    offsetBytes: 0,
    maxBytes: 1,
    deadlineUnixMs: now + 10_000,
  });
  assert.equal(missingReference.status, 'failed');
  assert.equal(missingReference.errorCode, 'reference-not-found');
  assert.equal(JSON.stringify(missingReference).includes(root), false);
});

test('Electron Project file adapter uses only generic preload path/file primitives', async () => {
  const {
    createSimulatorElectronProjectArtifactFilePort,
  } = await integrationModulePromise;
  const calls = [];
  const port = createSimulatorElectronProjectArtifactFilePort({
    path: {
      join: (...segments) => path.join(...segments),
      resolve: filePath => path.resolve(filePath),
      relative: (from, to) => path.relative(from, to),
    },
    fs: {
      existsSync(filePath) {
        calls.push(['exists', filePath]);
        return !filePath.endsWith('/missing') && !filePath.endsWith('\\missing');
      },
      async readFileBufferAsync(filePath) {
        calls.push(['read', filePath]);
        return Uint8Array.from([1, 2, 3]).buffer;
      },
      async replaceProjectText(request, assertCurrent) {
        assertCurrent();
        calls.push(['replace-cas', request]);
        return { status: 'COMMITTED' };
      },
      lstatSync(filePath) {
        calls.push(['lstat', filePath]);
        return {
          size: 3,
          _isFile: true,
          _isSymbolicLink: false,
        };
      },
      async realpathAsync(filePath) {
        calls.push(['realpath', filePath]);
        return path.resolve(filePath);
      },
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    [...await port.readFile('project/.build/firmware.bin', signal)],
    [1, 2, 3],
  );
  assert.equal(await port.replaceFileAtomic(
    'project', '.aily/simulator/scene-network-v2.json', null,
    Uint8Array.from([4, 5]),
    signal,
  ), true);
  assert.deepEqual(calls[1][1], { projectPath: 'project', fileName: '.aily/simulator/scene-network-v2.json',
    expectedHash: null, content: '\u0004\u0005' });
  assert.equal((await port.lstat('project/file', signal)).isFile, true);
  assert.equal(
    await port.realpath('project/file', signal),
    path.resolve('project/file'),
  );
  await assert.rejects(
    port.lstat('project/missing', signal),
    error => error instanceof Error && error.code === 'ENOENT',
  );
  assert.deepEqual(calls.map(call => call[0]), [
    'read',
    'replace-cas',
    'exists',
    'lstat',
    'realpath',
    'exists',
  ]);
});

test('Build callbacks acknowledge, stream ordered progress, and deliver the graph-matched Artifact through the real Host SDK', async () => {
  const {
    SimulatorBuildCallbackAuthority,
    SimulatorBuildHostProviderAdapter,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  let releaseBuild;
  const buildGate = new Promise(resolve => {
    releaseBuild = resolve;
  });
  const artifact = artifactDescriptorFixture(
    Buffer.from('firmware-v2'),
    document.graphSemanticRevision,
  );
  const authority = new SimulatorBuildCallbackAuthority({
    projectIdentity,
    sceneId,
    execution: {
      async reconcileAndBuild(request, observer, signal) {
        observer.report('resolving', 100);
        observer.report('generating', 250);
        observer.report('compiling', 700);
        await buildGate;
        if (signal.aborted) throw new Error('cancelled');
        observer.report('linking', 850);
        return artifact;
      },
    },
  });
  const events = [];
  const adapter = new SimulatorBuildHostProviderAdapter({
    ...authority.callbacks,
    publishProgressEvent(event) {
      events.push(event);
    },
    now: () => now,
    createSubscriptionId: () => (
      `provider-subscription-v1-${'3'.repeat(64)}`
    ),
    createEventId: () => `provider-event-v1-${'4'.repeat(64)}`,
  });
  const rebuild = rebuildRequest(document);

  const ack = await adapter.handleInvocation(providerInvocation(
    'build',
    'build.artifact.request',
    rebuild,
  ));
  assert.equal(ack.status, 'succeeded');
  assert.equal(ack.payload.status, 'accepted');

  const subscription = await adapter.handleInvocation(providerInvocation(
    'build',
    'build.progress.subscribe',
    progressSubscription(rebuild),
  ));
  assert.equal(subscription.status, 'succeeded');
  assert.equal(subscription.payload.acceptedFromSequence, 0);
  await waitFor(() => events.length >= 4);
  assert.deepEqual(
    events.slice(0, 4).map(event => event.payload.stage),
    ['queued', 'resolving', 'generating', 'compiling'],
  );
  releaseBuild();
  await waitFor(() => events.some(event => event.payload.stage === 'completed'));
  const completed = events.find(event => event.payload.stage === 'completed');
  assert.equal(completed.payload.progressPermille, 1000);
  assert.equal(
    completed.payload.artifact.artifact.build.graph.graphSemanticRevision,
    document.graphSemanticRevision,
  );
  assert.deepEqual(
    events.map(event => event.sequence),
    events.map((_, index) => index + 1),
  );
  await waitFor(() => adapter.snapshot().activeSubscriptions === 0);
  adapter.close();
  authority.close();
});

for (const reason of ['graph-semantic-changed', 'workspace-source-rebuild']) test(`Blockly Build execution forwards ${reason} and waits for the visible main Agent before compiling the exact Scene revision`, async () => {
  const {
    BlocklySimulatorBuildExecutionPort,
    createEmptySceneEditorDocumentV2,
    validateSceneArtifactRebuildRequest,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = validateSceneArtifactRebuildRequest({ ...rebuildRequest(document), reason,
    ...(reason === 'workspace-source-rebuild' ? { baseSceneRevision: document.graphSemanticRevision } : {}) });
  const artifact = artifactDescriptorFixture(
    Buffer.from('firmware-v3'),
    document.graphSemanticRevision,
  );
  const agentRequests = [];
  const builderCalls = [];
  let completeMainAgent;
  const execution = new BlocklySimulatorBuildExecutionPort({
    readCompileScene: async () => document,
    projectRoot: 'D:\\projects\\active',
    projectIdentity,
    sceneId,
    activeProject: {
      readActiveBinding() {
        return {
          projectRoot: 'd:/projects/active/',
          projectIdentity,
          sceneId,
          editorKind: 'blockly',
        };
      },
      isSameProjectRoot(left, right) {
        return left.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
          === right.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
      },
    },
    mainAgent: {
      execute(request) {
        agentRequests.push(request);
        return new Promise(resolve => {
          completeMainAgent = resolve;
        });
      },
    },
    builder: {
      async build(request) {
        builderCalls.push(request);
      },
    },
    artifacts: {
      async readLatest(requestProjectIdentity) {
        assert.equal(requestProjectIdentity, projectIdentity);
        return artifact;
      },
    },
  });
  const stages = [];
  const completion = execution.reconcileAndBuild(
    rebuild,
    {
      report(stage, progressPermille) {
        stages.push([stage, progressPermille]);
      },
    },
    new AbortController().signal,
  );
  await waitFor(() => agentRequests.length === 1);
  assert.equal(builderCalls.length, 0);
  assert.equal(agentRequests[0].reason, reason);

  completeMainAgent(mainAgentSceneChangeResult(rebuild, {
    outcome: 'completed',
    agentRunId: 'agent-run-main',
  }));
  assert.equal(await completion, artifact);
  assert.equal(builderCalls.length, 1);
  assert.deepEqual(builderCalls[0], {
    requestId: rebuild.requestId,
    projectRoot: 'D:\\projects\\active',
    projectIdentity,
    graphSemanticRevision: document.graphSemanticRevision,
    sceneDocument: document,
  });
  assert.deepEqual(
    stages.map(([stage]) => stage),
    [
      'resolving',
      'generating',
      'compiling',
      'staging',
    ],
  );
});

for (const reason of [undefined, null, 'unknown']) test(`Blockly Build rejects ${String(reason)} rebuild reason before main Agent or Builder`, async () => {
  const { BlocklySimulatorBuildExecutionPort, createEmptySceneEditorDocumentV2 } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const execution = new BlocklySimulatorBuildExecutionPort({
    readCompileScene: async () => document,
    projectRoot: 'D:\\projects\\active', projectIdentity, sceneId,
    activeProject: activeBlocklyProject('D:\\projects\\active'),
    mainAgent: { async execute() { assert.fail('Invalid reason must not enter the main Agent.'); } },
    builder: { async build() { assert.fail('Invalid reason must not enter Builder.'); } },
    artifacts: { async readLatest() { assert.fail('Invalid reason must not access Artifacts.'); } },
  });
  await assert.rejects(execution.reconcileAndBuild({ ...rebuildRequest(document), reason }, { report() {} },
    new AbortController().signal), error => error.simulatorBuildErrorCode === 'project-unavailable');
});

test('source recovery retries current code after Host completion and failed real Application replacement', async t => {
  const { SimulatorBuildCallbackAuthority, SimulationSessionLifecycle, SimulationSessionScene,
    SimulationBuildJobs, SimulationSceneArtifactReplacementApplication,
    createEmptySceneEditorDocumentV2 } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId), attached = 'a'.repeat(64);
  const current = { artifactRevision: attached, sourceSha256: 'b'.repeat(64) };
  let ids = 0, hostBuilds = 0, subscriptions = 0, references = 0, editAtFirstProbe = true, scene, jobs;
  const lifecyclePorts = controller => ({ assertAccess() {}, controller, isArtifactAligned: () => true,
    debugger: { isAttached: () => false, async release() {} }, clock: { pause() {}, resume() {} },
    assertPeripheralPortsIntegrity() {}, flushOutput() {}, events: { stateChanged() {}, failed() {}, recovered() {} } });
  const boundSource = (artifactRevision, sourceSha256) => ({ artifactRevision, sourceSha256,
    async readCurrent() { return { ...current }; } });
  const lifecycle = new SimulationSessionLifecycle({ ...lifecyclePorts({ snapshot: () => ({ state: 'stopped' }) }),
    executionSource: boundSource(attached, '1'.repeat(64)) });
  scene = new SimulationSessionScene({ sessionId: 'source-recovery', sceneId, artifactRevision: attached,
    artifactGraphSemanticRevision: document.graphSemanticRevision, document, lifecycle, state: () => 'stopped',
    assertAccess() {}, createRebuildRequestId: () => `rebuild-v1-${(++ids).toString(16).padStart(64, '0')}`, publishStale() {} });
  const original = artifactDescriptorFixture(Buffer.from('original'), document.graphSemanticRevision).artifact;
  original.artifactId = attached; original.build.source.sha256 = '1'.repeat(64);
  const artifacts = new Map([[`artifact-v1-${attached}`, { artifact: original, artifactDirectory: `artifact-v1-${attached}` }]]);
  const manifest = { target: original.target, sceneId, sceneRevision: 'd'.repeat(64) };
  const bindings = new Map([['source-recovery', { projectIdentity, artifactHandle: `artifact-v1-${attached}`,
    artifactRevision: attached, artifactGraphSemanticRevision: document.graphSemanticRevision, sceneId,
    sceneRevision: attached, sceneEditorDocument: document, manifest: { ...manifest, sceneRevision: attached },
    projectDebugConfiguration: null, projectSceneLaunchId: 'source-launch' }]]);
  let attachment = { sessionId: 'source-recovery', sceneRevision: attached,
    graphSemanticRevision: document.graphSemanticRevision, artifactRevision: attached, capability: { capabilityId: 'old' } };
  const runtimes = new Map([['source-recovery', { sessionId: 'source-recovery', sceneRevision: attached, state: 'stopped' }]]);
  const access = {
    async inspect(id) { return runtimes.get(id) ?? null; },
    async create(id, recipe) {
      const view = { sessionId: id, sceneRevision: recipe.manifest.sceneRevision, state: 'ready' };
      const controller = { snapshot: () => ({ ...view }), async start() { view.state = 'running'; },
        async pause() { view.state = 'paused'; }, async stop() { view.state = 'stopped'; } };
      view.lifecycle = new SimulationSessionLifecycle({ ...lifecyclePorts(controller),
        executionSource: boundSource(recipe.artifact.artifactId, recipe.artifact.build.source.sha256) });
      runtimes.set(id, view); return view;
    },
    async remove(id) { runtimes.delete(id); },
    async command(id, command) {
      if (id !== 'source-recovery' && command === 'start' && editAtFirstProbe) {
        editAtFirstProbe = false; current.sourceSha256 = 'c'.repeat(64);
      }
      const view = runtimes.get(id); await view.lifecycle.command(command); return view;
    },
    async restore(id, state) { const view = runtimes.get(id); await view.lifecycle.restoreStateForReplacement(state); return view; },
    async closeInstruments() {}, async issueAttachment(scope) { return { ...scope, capability: { capabilityId: 'new' } }; },
    async revokeAttachment() {},
  };
  const replacement = new SimulationSceneArtifactReplacementApplication({
    bindings: { get: id => bindings.get(id), set: (id, binding) => bindings.set(id, binding) },
    async resolveArtifact(project, handle) { assert.equal(project, projectIdentity); return artifacts.get(handle); },
    async retainArtifact() { references++; return () => { references--; }; },
    readRebuild: () => scene.createRebuildRequest(projectIdentity),
    async compileScene() { return { manifest, report: { supported: true } }; },
    async withReplacement(id, probe, operation) { await operation(access); },
    projectScenes: { snapshot: () => ({ sceneId, document, runtimeAttachment: attachment }),
      async replace(project, launch, previous, next) { assert.equal(previous, attachment); attachment = next; } },
  });
  const authority = new SimulatorBuildCallbackAuthority({ projectIdentity, sceneId, execution: {
    async reconcileAndBuild(request, observer) {
      hostBuilds++; observer.report('resolving', 100); observer.report('generating', 250);
      observer.report('compiling', 500); observer.report('staging', 900);
      const descriptor = artifactDescriptorFixture(Buffer.from(current.sourceSha256), request.sceneRevision);
      descriptor.artifact.build.source.sha256 = current.sourceSha256;
      artifacts.set(`artifact-v1-${descriptor.artifact.artifactId}`, { artifact: descriptor.artifact,
        artifactDirectory: `artifact-v1-${descriptor.artifact.artifactId}` });
      // Normal Builder manifest publication is output, not a new source request.
      current.artifactRevision = descriptor.artifact.artifactId;
      assert.equal((await scene.createRebuildRequest(projectIdentity)).requestId, request.requestId);
      return descriptor;
    },
  } });
  const listeners = new Map();
  jobs = new SimulationBuildJobs({
    async request(request) { return authority.callbacks.requestArtifact(request, new AbortController().signal); },
    async subscribe(request) {
      const subscriptionId = `provider-subscription-v1-${(++subscriptions).toString(16).padStart(64, '0')}`;
      listeners.set(subscriptionId, authority.callbacks.subscribeProgress(progressSubscription(request),
        progress => { void jobs.handleBuildEvent({ subscriptionId, payload: progress }); }, new AbortController().signal));
      return { subscriptionId, requestId: request.requestId };
    },
    releaseSubscription(id) { listeners.get(id)?.close(); listeners.delete(id); },
    async importArtifact(descriptor) { return { artifactHandle: `artifact-v1-${descriptor.artifact.artifactId}`,
      artifactId: descriptor.artifact.artifactId, artifactRevision: descriptor.artifactRevision, sourceMapRevision: null }; },
    async releaseArtifact() {}, replace: request => replacement.replace(request),
    operation() { let cancelled = false; const listeners = new Set(); return { context: undefined,
      cancelled: () => cancelled, cancel() { if (cancelled) return; cancelled = true; for (const call of listeners) call(); },
      dispose() {}, subscribeCancel(call) { listeners.add(call); return () => listeners.delete(call); } }; },
    createReplacementId: () => `replacement-v1-${subscriptions.toString(16).padStart(64, '0')}`,
  });
  t.after(async () => { await jobs.close(); authority.close(); await scene.close(); });
  const first = await scene.createRebuildRequest(projectIdentity);
  assert.equal((await scene.createRebuildRequest(projectIdentity)).requestId, first.requestId, 'same source stays idempotent');
  assert.equal((await jobs.requestRebuild(first)).status, 'accepted');
  const failed = await jobs.waitForTerminal(first.requestId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.replacementErrorCode, 'session-create-failed');
  assert.equal(hostBuilds, 1); assert.equal(bindings.get('source-recovery').artifactRevision, attached);
  assert.equal(runtimes.get('source-recovery').state, 'stopped'); assert.equal(references, 0);
  const retry = await scene.createRebuildRequest(projectIdentity);
  assert.notEqual(retry.requestId, first.requestId, 'verified new source must not replay a completed old Host build');
  assert.equal(retry.baseArtifactRevision, attached); assert.equal(retry.sceneRevision, first.sceneRevision);
  assert.equal((await scene.createRebuildRequest(projectIdentity)).requestId, retry.requestId);
  assert.equal((await jobs.requestRebuild(retry)).status, 'accepted');
  const committed = await jobs.waitForTerminal(retry.requestId);
  assert.equal(committed.status, 'committed'); assert.equal(hostBuilds, 2);
  assert.equal(attachment.artifactRevision, current.artifactRevision);
  assert.equal(runtimes.get('source-recovery').state, 'stopped'); assert.equal(runtimes.size, 1); assert.equal(references, 0);
});

test('a main-Agent user-edit conflict fails generation before Builder starts', async () => {
  const {
    BlocklySimulatorBuildExecutionPort,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  let builderCalled = false;
  const execution = new BlocklySimulatorBuildExecutionPort({
    readCompileScene: async () => document,
    projectRoot: 'D:\\projects\\active',
    projectIdentity,
    sceneId,
    activeProject: activeBlocklyProject('D:\\projects\\active'),
    mainAgent: {
      async execute() {
        throw Object.assign(
          new Error('The Blockly Project was edited by the user during the main Agent turn.'),
          { code: 'agent-project-user-edit-conflict' },
        );
      },
    },
    builder: {
      async build() {
        builderCalled = true;
      },
    },
    artifacts: {
      async readLatest() {
        throw new Error('Artifact access must not run after an Agent conflict.');
      },
    },
  });

  await assert.rejects(
    execution.reconcileAndBuild(
      rebuild,
      { report() {} },
      new AbortController().signal,
    ),
    error => {
      assert.equal(error.simulatorBuildErrorCode, 'generation-failed');
      assert.match(error.message, /edited by the user/u);
      return true;
    },
  );
  assert.equal(builderCalled, false);
});

test('Simulator Scene request becomes an ordinary main-Agent message with bounded electrical context', async () => {
  const {
    createSimulatorMainAgentSceneMessage,
    createSimulatorMainAgentSceneResources,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  const request = {
    schemaVersion: 1,
    kind: 'aily-simulator-main-agent-scene-change-request',
    requestId: rebuild.requestId,
    projectIdentity,
    sceneId,
    reason: rebuild.reason,
    graphSemanticRevision: rebuild.sceneRevision,
    sceneDocument: rebuild.sceneDocument,
  };
  const message = createSimulatorMainAgentSceneMessage(request);
  const resources = createSimulatorMainAgentSceneResources(request);
  const scene = JSON.parse(resources[0].content);

  assert.match(message, /当前 Blockly 项目代码/u);
  assert.match(message, new RegExp(rebuild.requestId, 'u'));
  assert.match(message, new RegExp(rebuild.sceneRevision, 'u'));
  assert.match(resources[1].content, /主 Agent/u);
  assert.match(resources[1].content, /不要调用任何 subagent/u);
  assert.equal(scene.requestId, rebuild.requestId);
  assert.equal(scene.graphSemanticRevision, rebuild.sceneRevision);
  assert.equal(scene.sourcePath, '.aily/simulator/scene-network-v2.json');
  assert.equal(message.includes(JSON.stringify(rebuild.sceneDocument)), false);
  assert.equal(message.includes('@SceneCodeReconciliationAgent'), false);
  assert.equal(message.includes('connection_output.json'), false);
});

for (const reason of ['graph-semantic-changed', 'workspace-source-rebuild']) test(`product composition delivers ${reason} through main Agent, normal Scene-bound Builder and Project Artifact callbacks`, async t => {
  const {
    SimulatorBuildHostProviderAdapter,
    SimulatorBuildProductComposition,
    SimulatorProjectHostProviderAdapter,
    createEmptySceneEditorDocumentV2,
    validateSceneArtifactRebuildRequest,
  } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-build-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = validateSceneArtifactRebuildRequest({ ...rebuildRequest(document), reason,
    ...(reason === 'workspace-source-rebuild' ? { baseSceneRevision: document.graphSemanticRevision } : {}) });
  const firmware = Buffer.from('product-composition-firmware');
  const calls = [];
  const events = [];
  const composition = new SimulatorBuildProductComposition({
    projectRoot: root,
    projectIdentity,
    workspaceIdentity,
    sceneId,
    files: nodeFilePort(),
    activeProject: activeBlocklyProject(root),
    mainAgent: {
      async execute(request) {
        assert.equal(request.reason, reason);
        calls.push(['reconcile', request.requestId, request.graphSemanticRevision]);
        return mainAgentSceneChangeResult(rebuild, {
          outcome: 'completed',
          agentRunId: 'main-agent:product-composition',
        });
      },
    },
    builderService: {
      async buildActiveBlocklyProject(input) {
        calls.push(['build', input.requestId, input.graphSemanticRevision]);
        const artifact = artifactFixture(
          firmware,
          input.graphSemanticRevision,
        );
        await fs.mkdir(path.join(root, '.build'), { recursive: true });
        await fs.writeFile(path.join(root, '.build', 'firmware.bin'), firmware);
        await fs.writeFile(
          path.join(root, '.build', 'aily-artifact-manifest.json'),
          `${JSON.stringify(artifact, null, 2)}\n`,
        );
      },
      cancelActiveBlocklyProjectBuild(requestId) {
        calls.push(['cancel', requestId]);
      },
    },
    now: () => now,
    createArtifactReference: () => `host-artifact-v1-${'e'.repeat(64)}`,
    createSceneCommitId: () => `scene-commit-v1-${'f'.repeat(64)}`,
  });
  await composition.projectCallbacks.writeScene({
    projectIdentity, sceneId, expectedStorageRevision: emptyRevision,
    descriptor: { schemaVersion: 1, kind: 'aily-project-scene-network-descriptor',
      projectIdentity, sceneId, storageRevision: emptyRevision, document,
      runtimeAttachment: null, artifactAlignment: 'detached' },
  }, new AbortController().signal);
  const projectAdapter = new SimulatorProjectHostProviderAdapter({
    ...composition.projectCallbacks,
    now: () => now,
  });
  const buildAdapter = new SimulatorBuildHostProviderAdapter({
    ...composition.buildCallbacks,
    publishProgressEvent(event) {
      events.push(event);
    },
    now: () => now,
    createSubscriptionId: () => (
      `provider-subscription-v1-${'d'.repeat(64)}`
    ),
    createEventId: () => `provider-event-v1-${'e'.repeat(64)}`,
  });
  t.after(() => {
    buildAdapter.close();
    projectAdapter.close();
    composition.close();
  });

  const ack = await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.artifact.request',
    rebuild,
  ));
  assert.equal(ack.status, 'succeeded');
  assert.equal(ack.payload.status, 'accepted');
  await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.progress.subscribe',
    progressSubscription(rebuild),
  ));
  await waitFor(() => events.some(event => event.payload.stage === 'completed'));

  assert.deepEqual(calls, [
    ['reconcile', rebuild.requestId, document.graphSemanticRevision],
    ['build', rebuild.requestId, document.graphSemanticRevision],
  ]);
  const completed = events.find(event => event.payload.stage === 'completed');
  assert.equal(completed.payload.artifact.projectIdentity, projectIdentity);
  assert.equal(
    completed.payload.artifact.artifact.build.graph.graphSemanticRevision,
    document.graphSemanticRevision,
  );
  const artifactRead = await projectAdapter.handleInvocation(providerInvocation(
    'project',
    'project.artifact.read',
    { projectIdentity, artifactRevision: null },
  ));
  assert.equal(artifactRead.status, 'succeeded');
  assert.equal(
    artifactRead.payload.artifactRevision,
    completed.payload.artifact.artifactRevision,
  );
  assert.equal(JSON.stringify(artifactRead).includes(root), false);

  composition.close();
  assert.equal(composition.snapshot().closed, true);
  assert.equal(composition.snapshot().project.activeArtifactReferences, 0);
  assert.equal(composition.snapshot().build.activeSubscriptions, 0);
});

test('a failed normal Builder keeps the previous Artifact and the same immutable Scene request can retry to completion', async t => {
  const {
    SimulatorBuildHostProviderAdapter,
    SimulatorBuildProductComposition,
    SimulatorProjectHostProviderAdapter,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-build-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  const previousRevision = '9'.repeat(64);
  const previousFirmware = Buffer.from('previous-recoverable-firmware');
  const previousArtifact = artifactFixture(previousFirmware, previousRevision);
  const rebuiltFirmware = Buffer.from('rebuilt-firmware-after-retry');
  const rebuiltArtifact = artifactFixture(
    rebuiltFirmware,
    document.graphSemanticRevision,
  );
  await fs.mkdir(path.join(root, '.build'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.build', 'firmware.bin'),
    previousFirmware,
  );
  await fs.writeFile(
    path.join(root, '.build', 'aily-artifact-manifest.json'),
    `${JSON.stringify(previousArtifact, null, 2)}\n`,
  );

  const calls = [];
  const events = [];
  let buildAttempts = 0;
  const composition = new SimulatorBuildProductComposition({
    projectRoot: root,
    projectIdentity,
    workspaceIdentity,
    sceneId,
    files: nodeFilePort(),
    activeProject: activeBlocklyProject(root),
    mainAgent: {
      async execute(request) {
        calls.push(['main-agent', request.requestId]);
        return mainAgentSceneChangeResult(rebuild, {
          outcome: 'completed',
          agentRunId: 'main-agent:compile-failure',
        });
      },
    },
    builderService: {
      async buildActiveBlocklyProject(input) {
        calls.push(['build', input.requestId]);
        buildAttempts += 1;
        if (buildAttempts === 1) {
          throw new Error('intentional compile failure');
        }
        await fs.writeFile(
          path.join(root, '.build', 'firmware.bin'),
          rebuiltFirmware,
        );
        await fs.writeFile(
          path.join(root, '.build', 'aily-artifact-manifest.json'),
          `${JSON.stringify(rebuiltArtifact, null, 2)}\n`,
        );
      },
      cancelActiveBlocklyProjectBuild(requestId) {
        calls.push(['cancel', requestId]);
      },
    },
    now: () => now,
    createArtifactReference: () => `host-artifact-v1-${'8'.repeat(64)}`,
  });
  await composition.projectCallbacks.writeScene({
    projectIdentity, sceneId, expectedStorageRevision: emptyRevision,
    descriptor: { schemaVersion: 1, kind: 'aily-project-scene-network-descriptor',
      projectIdentity, sceneId, storageRevision: emptyRevision, document,
      runtimeAttachment: null, artifactAlignment: 'detached' },
  }, new AbortController().signal);
  const projectAdapter = new SimulatorProjectHostProviderAdapter({
    ...composition.projectCallbacks,
    now: () => now,
  });
  const buildAdapter = new SimulatorBuildHostProviderAdapter({
    ...composition.buildCallbacks,
    publishProgressEvent(event) {
      events.push(event);
    },
    now: () => now,
    createSubscriptionId: () => (
      `provider-subscription-v1-${'7'.repeat(64)}`
    ),
    createEventId: () => `provider-event-v1-${'6'.repeat(64)}`,
  });
  t.after(() => {
    buildAdapter.close();
    projectAdapter.close();
    composition.close();
  });

  const ack = await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.artifact.request',
    rebuild,
  ));
  assert.equal(ack.status, 'succeeded');
  assert.equal(ack.payload.status, 'accepted');
  await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.progress.subscribe',
    progressSubscription(rebuild),
  ));
  await waitFor(() => events.some(event => event.payload.stage === 'failed'));

  const failure = events.find(event => event.payload.stage === 'failed');
  assert.equal(failure.payload.errorCode, 'compile-failed');
  assert.equal(events.some(event => event.payload.stage === 'completed'), false);
  assert.deepEqual(calls, [
    ['main-agent', rebuild.requestId],
    ['build', rebuild.requestId],
  ]);

  const previousRead = await projectAdapter.handleInvocation(providerInvocation(
    'project',
    'project.artifact.read',
    { projectIdentity, artifactRevision: previousArtifact.artifactId },
  ));
  assert.equal(previousRead.status, 'succeeded');
  assert.equal(previousRead.payload.artifactRevision, previousArtifact.artifactId);
  assert.equal(
    previousRead.payload.artifact.build.graph.graphSemanticRevision,
    previousRevision,
  );
  assert.notEqual(
    previousRead.payload.artifact.build.graph.graphSemanticRevision,
    document.graphSemanticRevision,
  );

  const retryAck = await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.artifact.request',
    rebuild,
    'retry',
  ));
  assert.equal(retryAck.status, 'succeeded');
  assert.equal(retryAck.payload.status, 'accepted');
  await buildAdapter.handleInvocation(providerInvocation(
    'build',
    'build.progress.subscribe',
    progressSubscription(rebuild),
    'retry',
  ));
  await waitFor(() => events.some(event => event.payload.stage === 'completed'));

  const completed = events.find(event => event.payload.stage === 'completed');
  assert.equal(
    completed.payload.artifact.artifactRevision,
    rebuiltArtifact.artifactId,
  );
  assert.equal(
    completed.payload.artifact.artifact.build.graph.graphSemanticRevision,
    document.graphSemanticRevision,
  );
  assert.deepEqual(calls, [
    ['main-agent', rebuild.requestId],
    ['build', rebuild.requestId],
    ['main-agent', rebuild.requestId],
    ['build', rebuild.requestId],
  ]);
});

for (const firstFailure of [
  { label: 'explicit normal Builder button cancellation', errorCode: 'build-cancelled', expectedStage: 'cancelled', expectedCode: 'cancelled' },
  { label: 'an ordinary warning with cancellation text', state: 'warn', expectedStage: 'failed', expectedCode: 'compile-failed' },
  { label: 'an ordinary compile error', state: 'error', expectedStage: 'failed', expectedCode: 'compile-failed' },
]) test(`Build callback preserves ${firstFailure.label} and retries the same immutable request`, async t => {
  const { BlocklySimulatorBuildExecutionPort, SimulatorBuildCallbackAuthority,
    SimulatorBuildHostProviderAdapter, createSimulatorBlocklyBuilderPort, createEmptySceneEditorDocumentV2 } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  let attempts = 0;
  let artifactReads = 0;
  let hostSignal;
  const descriptor = artifactDescriptorFixture(Buffer.from('retry-after-builder-outcome'), document.graphSemanticRevision);
  const execution = new BlocklySimulatorBuildExecutionPort({
    readCompileScene: async () => document,
    projectRoot: 'project', projectIdentity, sceneId, activeProject: activeBlocklyProject('project'),
    mainAgent: { async execute(request, signal) {
      hostSignal = signal;
      return mainAgentSceneChangeResult(rebuild, { outcome: 'completed', agentRunId: 'agent:builder-outcome' });
    } },
    builder: createSimulatorBlocklyBuilderPort({
      async buildActiveBlocklyProject() {
        if (++attempts === 1) throw Object.assign(new Error('已取消，耗时 1.23 秒'), {
          state: firstFailure.state ?? 'warn',
          ...(firstFailure.errorCode ? { errorCode: firstFailure.errorCode } : {}),
        });
      },
      cancelActiveBlocklyProjectBuild() { assert.fail('Normal button cancellation did not abort the Host request.'); },
    }),
    artifacts: { async readLatest() { artifactReads++; return descriptor; } },
  });
  const authority = new SimulatorBuildCallbackAuthority({ projectIdentity, sceneId, execution });
  const events = [];
  const adapter = new SimulatorBuildHostProviderAdapter({ ...authority.callbacks,
    now: () => now, publishProgressEvent: event => events.push(event),
    createSubscriptionId: () => `provider-subscription-v1-${'5'.repeat(64)}`,
    createEventId: () => `provider-event-v1-${'4'.repeat(64)}`,
  });
  t.after(() => { adapter.close(); authority.close(); });
  async function requestAndSubscribe(suffix) {
    const ack = await adapter.handleInvocation(providerInvocation('build', 'build.artifact.request', rebuild, suffix));
    assert.equal(ack.status, 'succeeded'); assert.equal(ack.payload.status, 'accepted');
    const subscription = await adapter.handleInvocation(providerInvocation('build', 'build.progress.subscribe', progressSubscription(rebuild), suffix));
    assert.equal(subscription.status, 'succeeded');
  }
  await requestAndSubscribe('first');
  await waitFor(() => events.some(event => ['cancelled', 'failed'].includes(event.payload.stage)));
  const terminal = events.find(event => ['cancelled', 'failed'].includes(event.payload.stage)).payload;
  assert.equal(terminal.stage, firstFailure.expectedStage);
  assert.equal(terminal.errorCode, firstFailure.expectedCode);
  assert.equal(terminal.artifact, null);
  assert.equal(artifactReads, 0, 'Failure/cancellation must not read an old latest Artifact.');
  assert.equal(hostSignal.aborted, false, 'User Builder cancellation is a typed outcome, not a synthetic Host abort.');
  await waitFor(() => adapter.snapshot().activeSubscriptions === 0);
  await requestAndSubscribe('retry');
  await waitFor(() => events.some(event => event.payload.stage === 'completed'));
  assert.equal(events.find(event => event.payload.stage === 'completed').payload.requestId, rebuild.requestId);
  assert.equal(attempts, 2); assert.equal(artifactReads, 1);
});

test('closing product composition cancels the pending main Agent before Builder or Artifact access', async () => {
  const {
    SimulatorBuildHostProviderAdapter,
    SimulatorBuildProductComposition,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  let mainAgentStarted = false;
  let mainAgentAborted = false;
  let buildCalled = false;
  const events = [];
  const composition = new SimulatorBuildProductComposition({
    projectRoot: 'project',
    projectIdentity,
    workspaceIdentity,
    sceneId,
    files: nodeFilePort(),
    activeProject: activeBlocklyProject('project'),
    mainAgent: {
      execute(_request, signal) {
        mainAgentStarted = true;
        return new Promise((_resolve, reject) => {
          const abort = () => {
            mainAgentAborted = true;
            reject(new Error('composition closed'));
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    },
    builderService: {
      async buildActiveBlocklyProject() {
        buildCalled = true;
      },
      cancelActiveBlocklyProjectBuild() {},
    },
  });
  const adapter = new SimulatorBuildHostProviderAdapter({
    ...composition.buildCallbacks,
    publishProgressEvent(event) {
      events.push(event);
    },
    now: () => now,
    createSubscriptionId: () => (
      `provider-subscription-v1-${'6'.repeat(64)}`
    ),
    createEventId: () => `provider-event-v1-${'7'.repeat(64)}`,
  });

  await adapter.handleInvocation(providerInvocation(
    'build',
    'build.artifact.request',
    rebuild,
  ));
  await adapter.handleInvocation(providerInvocation(
    'build',
    'build.progress.subscribe',
    progressSubscription(rebuild),
  ));
  await waitFor(() => mainAgentStarted);
  composition.close();
  await waitFor(() => events.some(event => event.payload.stage === 'cancelled'));

  assert.equal(mainAgentAborted, true);
  assert.equal(buildCalled, false);
  assert.equal(composition.snapshot().closed, true);
  assert.equal(composition.snapshot().build.activeRequestId, null);
  assert.equal(composition.snapshot().build.activeSubscriptions, 0);
  assert.equal(composition.snapshot().project.activeArtifactReferences, 0);
  adapter.close();
});

test('Blockly Builder adapter sends only request-scoped cancellation', async () => {
  const {
    createSimulatorBlocklyBuilderPort, createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const sceneDocument = await createEmptySceneEditorDocumentV2(sceneId);
  const calls = [];
  let rejectBuild;
  const port = createSimulatorBlocklyBuilderPort({
    buildActiveBlocklyProject(input) {
      calls.push(['build', input]);
      return new Promise((_resolve, reject) => {
        rejectBuild = reject;
      });
    },
    cancelActiveBlocklyProjectBuild(requestId) {
      calls.push(['cancel', requestId]);
      rejectBuild(new Error('cancelled'));
    },
  });
  const controller = new AbortController();
  const completion = port.build({
    requestId: 'rebuild-main',
    projectRoot: 'project',
    projectIdentity,
    graphSemanticRevision: sceneDocument.graphSemanticRevision,
    sceneDocument,
  }, controller.signal);
  controller.abort(new Error('superseded'));
  await assert.rejects(completion, /cancelled/);
  assert.deepEqual(calls, [
    ['build', {
      projectPath: 'project',
      graphSemanticRevision: sceneDocument.graphSemanticRevision,
    sceneDocument,
      requestId: 'rebuild-main',
    }],
    ['cancel', 'rebuild-main'],
  ]);
});

test('Editor callbacks apply only current source-map blocks and isolate launch clears', async () => {
  const {
    SimulatorBlocklyEditorCallbackAuthority,
    SimulatorEditorHostProviderAdapter,
  } = await integrationModulePromise;
  const sourceMapRevision = '8'.repeat(64);
  const projectRoot = 'D:\\projects\\editor-main';
  const blocks = new Set(['block-loop', 'block-other']);
  const viewCalls = [];
  let active = true;
  let workspaceCurrent = true;
  const authority = new SimulatorBlocklyEditorCallbackAuthority({
    projectRoot,
    projectIdentity,
    sceneId,
    activeProject: {
      readActiveBinding: () => active ? {
        projectRoot,
        projectIdentity,
        sceneId,
        editorKind: 'blockly',
      } : null,
      isSameProjectRoot: (left, right) => left === right,
    },
    source: {
      readState: () => ({
        sourceMapRevision,
        sourcePath: 'sketch.ino',
        workspaceCurrent,
      }),
      resolveBlockIdByGeneratedLine: () => 'block-loop',
    },
    view: {
      hasBlock: blockId => blocks.has(blockId),
      showDebugBlock: (...args) => viewCalls.push(['show', ...args]),
      clearDebugBlock: (...args) => viewCalls.push(['clear', ...args]),
    },
  });
  const adapter = new SimulatorEditorHostProviderAdapter({
    ...authority.callbacks,
    now: () => now,
  });

  const launchA = `launch-v1-${'a'.repeat(64)}`;
  const launchB = `launch-v1-${'b'.repeat(64)}`;
  const first = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    debugLocationEvent({
      launchId: launchA,
      sequence: 1,
      sourceMapRevision,
      blockId: 'block-loop',
    }),
  ));
  assert.equal(first.status, 'succeeded');
  assert.equal(first.payload.disposition, 'applied');
  assert.deepEqual(viewCalls, [
    ['show', projectRoot, 'block-loop', true],
  ]);

  const duplicate = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    debugLocationEvent({
      launchId: launchA,
      sequence: 1,
      sourceMapRevision,
      blockId: 'block-loop',
    }),
  ));
  assert.equal(duplicate.payload.disposition, 'ignored');
  assert.equal(viewCalls.length, 1);

  const secondLaunch = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    debugLocationEvent({
      launchId: launchB,
      sequence: 1,
      sourceMapRevision,
      blockId: 'block-other',
    }),
  ));
  assert.equal(secondLaunch.payload.disposition, 'applied');
  const staleClear = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    clearDebugLocationEvent(launchA, 2),
  ));
  assert.equal(staleClear.payload.disposition, 'applied');
  assert.equal(viewCalls.some(call => call[0] === 'clear'), false);

  workspaceCurrent = false;
  const dirty = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    debugLocationEvent({
      launchId: launchB,
      sequence: 2,
      sourceMapRevision,
      blockId: 'block-other',
    }),
  ));
  assert.equal(dirty.payload.disposition, 'ignored');
  assert.deepEqual(viewCalls.at(-1), ['clear', projectRoot]);

  active = false;
  const inactive = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.debug-location.publish',
    clearDebugLocationEvent(launchB, 3),
  ));
  assert.equal(inactive.payload.disposition, 'ignored');
  authority.close();
});

test('Editor source reveal maps a portable Artifact line without forcing focus', async () => {
  const {
    SimulatorBlocklyEditorCallbackAuthority,
    SimulatorEditorHostProviderAdapter,
  } = await integrationModulePromise;
  const sourceMapRevision = '9'.repeat(64);
  const projectRoot = 'D:\\projects\\editor-reveal';
  const viewCalls = [];
  const authority = new SimulatorBlocklyEditorCallbackAuthority({
    projectRoot,
    projectIdentity,
    sceneId,
    activeProject: activeBlocklyProject(projectRoot),
    source: {
      readState: () => ({
        sourceMapRevision,
        sourcePath: 'sketch.ino',
        workspaceCurrent: true,
      }),
      resolveBlockIdByGeneratedLine: line => (
        line === 42 ? 'block-loop' : null
      ),
    },
    view: {
      hasBlock: blockId => blockId === 'block-loop',
      showDebugBlock: (...args) => viewCalls.push(['show', ...args]),
      clearDebugBlock: (...args) => viewCalls.push(['clear', ...args]),
    },
  });
  const adapter = new SimulatorEditorHostProviderAdapter({
    ...authority.callbacks,
    now: () => now,
  });
  const launchId = `launch-v1-${'c'.repeat(64)}`;
  const reveal = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.source-location.reveal',
    sourceRevealRequest({ launchId, sourceMapRevision, focus: false }),
  ));
  assert.equal(reveal.status, 'succeeded');
  assert.equal(reveal.payload.disposition, 'revealed');
  assert.deepEqual(viewCalls, [
    ['show', projectRoot, 'block-loop', false],
  ]);

  const wrongFile = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.source-location.reveal',
    {
      ...sourceRevealRequest({ launchId, sourceMapRevision, focus: true }),
      location: { file: 'library.cpp', line: 42 },
    },
  ));
  assert.equal(wrongFile.payload.disposition, 'ignored');
  const staleRevision = await adapter.handleInvocation(providerInvocation(
    'editor',
    'editor.source-location.reveal',
    sourceRevealRequest({
      launchId,
      sourceMapRevision: 'a'.repeat(64),
      focus: true,
    }),
  ));
  assert.equal(staleRevision.payload.disposition, 'ignored');
  assert.equal(viewCalls.length, 1);
  authority.close();
  assert.deepEqual(viewCalls.at(-1), ['clear', projectRoot]);
});

test('Entitlement callbacks never derive a signed lease from Blockly account summaries', async () => {
  const {
    SimulatorEntitlementCallbackAuthority,
    SimulatorEntitlementHostProviderAdapter,
  } = await integrationModulePromise;
  let snapshot = {
    state: 'signed-out',
    connectivity: 'online',
  };
  const account = {
    readSnapshot: () => ({ ...snapshot }),
    subscribe: () => ({ close() {} }),
  };
  const authority = new SimulatorEntitlementCallbackAuthority({
    account,
    now: () => now,
  });
  const adapter = new SimulatorEntitlementHostProviderAdapter({
    ...authority.callbacks,
    publishStatusEvent() {},
    now: () => now,
  });
  const signedOut = await adapter.handleInvocation(providerInvocation(
    'entitlement',
    'entitlement.lease.request',
    entitlementLeaseRequest('entitlement-signed-out'),
  ));
  assert.equal(signedOut.status, 'succeeded');
  assert.equal(signedOut.payload.disposition, 'unavailable');
  assert.equal(signedOut.payload.unavailableReason, 'sign-in-required');
  assert.equal(signedOut.payload.lease, null);

  snapshot = {
    state: 'authenticated',
    connectivity: 'online',
  };
  const authenticated = await adapter.handleInvocation(providerInvocation(
    'entitlement',
    'entitlement.lease.request',
    entitlementLeaseRequest('entitlement-authenticated'),
  ));
  assert.equal(authenticated.status, 'succeeded');
  assert.equal(authenticated.payload.disposition, 'unavailable');
  assert.equal(
    authenticated.payload.unavailableReason,
    'temporarily-unavailable',
  );
  assert.equal(authenticated.payload.lease, null);
  assert.equal(authenticated.payload.revocations, null);
  assert.equal(JSON.stringify(authenticated).includes('subscription'), false);
  adapter.close();
  authority.close();
});

test('Entitlement status publishes redacted account/connectivity changes and closes cleanly', async () => {
  const {
    SimulatorEntitlementCallbackAuthority,
    SimulatorEntitlementHostProviderAdapter,
  } = await integrationModulePromise;
  let snapshot = {
    state: 'checking',
    connectivity: 'unknown',
  };
  let listener = null;
  let sourceCloses = 0;
  const published = [];
  const authority = new SimulatorEntitlementCallbackAuthority({
    account: {
      readSnapshot: () => ({ ...snapshot }),
      subscribe(nextListener) {
        listener = nextListener;
        return {
          close() {
            sourceCloses += 1;
            listener = null;
          },
        };
      },
    },
    now: () => now,
  });
  const adapter = new SimulatorEntitlementHostProviderAdapter({
    ...authority.callbacks,
    publishStatusEvent: event => published.push(event),
    now: () => now,
    createSubscriptionId: () => (
      `provider-subscription-v1-${'e'.repeat(64)}`
    ),
    createEventId: () => `provider-event-v1-${'f'.repeat(64)}`,
  });
  const result = await adapter.handleInvocation(providerInvocation(
    'entitlement',
    'entitlement.status.subscribe',
    entitlementStatusRequest('entitlement-status-main', 4),
  ));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.payload.acceptedFromSequence, 4);
  assert.equal(result.payload.status.accountState, 'refreshing');
  assert.equal(result.payload.status.leaseExpiresAtUnixMs, null);

  snapshot = {
    state: 'authenticated',
    connectivity: 'offline',
  };
  listener({ ...snapshot });
  await waitFor(() => published.length === 1);
  assert.equal(published[0].sequence, 5);
  assert.equal(published[0].payload.accountState, 'temporarily-unavailable');
  assert.equal(published[0].payload.connectivity, 'offline');

  snapshot = {
    state: 'signed-out',
    connectivity: 'online',
  };
  listener({ ...snapshot });
  await waitFor(() => published.length === 2);
  assert.equal(published[1].sequence, 6);
  assert.equal(published[1].payload.accountState, 'sign-in-required');
  assert.equal('userId' in published[1].payload, false);

  authority.close();
  assert.equal(sourceCloses, 1);
  assert.equal(adapter.snapshot().activeStatusSubscriptions, 1);
  adapter.close();
  assert.equal(adapter.snapshot().activeStatusSubscriptions, 0);
  assert.equal(sourceCloses, 1);
});

function providerInvocation(provider, capability, payload, invocationSalt = '') {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-subapp-host-provider-invocation',
    invocationId: `provider-invocation-v1-${crypto
      .createHash('sha256')
      .update(`${provider}:${capability}:${invocationSalt}:${JSON.stringify(payload)}`)
      .digest('hex')}`,
    provider,
    providerRevision: 3,
    protocolVersion: 1,
    capability,
    deadlineUnixMs: now + 10_000,
    payload,
  };
}

function entitlementLeaseRequest(requestId) {
  return {
    requestId,
    product: 'aily-simulator',
    currentLeaseId: null,
    forceRefresh: false,
  };
}

function entitlementStatusRequest(requestId, afterSequence = null) {
  return {
    requestId,
    product: 'aily-simulator',
    afterSequence,
  };
}

function debugLocationEvent({
  launchId,
  sequence,
  sourceMapRevision,
  blockId,
}) {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-subapp-debug-location-hint',
    launchId,
    sessionId: 'session-main',
    sceneId,
    sceneRevision: 'd'.repeat(64),
    sequence,
    status: 'available',
    location: { file: 'sketch.ino', line: 42 },
    sourceMapRevision,
    primaryBlockId: blockId,
    mappings: [{
      blockId,
      executionRole: 'statement',
      totalRanges: 1,
      ranges: [{
        startLine: 42,
        endLine: 42,
        role: 'executable',
        current: true,
      }],
      truncated: false,
    }],
    mappingsTruncated: false,
    clearReason: null,
  };
}

function clearDebugLocationEvent(launchId, sequence) {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-subapp-debug-location-hint',
    launchId,
    sessionId: 'session-main',
    sceneId,
    sceneRevision: 'd'.repeat(64),
    sequence,
    status: 'clear',
    location: null,
    sourceMapRevision: null,
    primaryBlockId: null,
    mappings: [],
    mappingsTruncated: false,
    clearReason: 'not-stopped',
  };
}

function sourceRevealRequest({ launchId, sourceMapRevision, focus }) {
  return {
    launchId,
    sessionId: 'session-main',
    sceneId,
    sceneRevision: 'd'.repeat(64),
    location: { file: 'sketch.ino', line: 42 },
    sourceMapRevision,
    focus,
  };
}

function artifactFixture(firmware, graphSemanticRevision) {
  const firmwareHash = sha256(firmware);
  return {
    schemaVersion: 1,
    kind: 'aily-build-artifact',
    artifactId: sha256(Buffer.from(`artifact:${firmwareHash}`)),
    target: {
      fqbn: 'esp32:esp32:XIAO_ESP32S3',
      architecture: 'esp32',
      boardId: 'XIAO_ESP32S3',
      mcu: 'esp32s3',
    },
    build: {
      builtAt: '2026-07-31T00:00:00.000Z',
      source: {
        path: 'sketch.ino',
        sizeBytes: 1,
        sha256: sha256(Buffer.from('x')),
      },
      toolVersions: { 'esp-x32': '14.2.0' },
      graph: {
        schemaVersion: 1,
        kind: 'aily-scene-graph-provenance',
        graphSemanticRevision,
        sourceDocumentSchemaVersion: 2,
      },
    },
    files: [{
      role: 'application',
      path: 'firmware.bin',
      sizeBytes: firmware.byteLength,
      sha256: firmwareHash,
    }],
    primaryFile: 'firmware.bin',
  };
}

function artifactDescriptorFixture(firmware, graphSemanticRevision) {
  const artifact = artifactFixture(firmware, graphSemanticRevision);
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-host-artifact-descriptor',
    projectIdentity,
    artifactReference: `host-artifact-v1-${'5'.repeat(64)}`,
    artifactRevision: artifact.artifactId,
    artifact,
    fileCount: 1,
    totalSizeBytes: firmware.byteLength,
    expiresAtUnixMs: now + 60_000,
  };
}

function chunkRequest(descriptor, offsetBytes, maxBytes, fill) {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-host-artifact-chunk-request',
    transferId: `artifact-transfer-v1-${fill.repeat(64)}`,
    projectIdentity,
    artifactReference: descriptor.artifactReference,
    artifactRevision: descriptor.artifactRevision,
    path: 'firmware.bin',
    offsetBytes,
    maxBytes,
    deadlineUnixMs: now + 10_000,
  };
}

function rebuildRequest(document) {
  return {
    schemaVersion: 1,
    kind: 'aily-scene-artifact-rebuild-request',
    requestId: `rebuild-v1-${'6'.repeat(64)}`,
    sessionId: 'session-main',
    sceneId,
    reason: 'graph-semantic-changed',
    baseSceneRevision: '7'.repeat(64),
    sceneRevision: document.graphSemanticRevision,
    baseArtifactRevision: '8'.repeat(64),
    projectIdentity,
    action: 'reconcile-and-build',
    sceneDocument: document,
  };
}

function progressSubscription(request) {
  return {
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sessionId: request.sessionId,
    sceneId: request.sceneId,
    sceneRevision: request.sceneRevision,
    baseArtifactRevision: request.baseArtifactRevision,
    afterSequence: null,
  };
}

function mainAgentSceneChangeResult(request, overrides) {
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-main-agent-scene-change-result',
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sceneId: request.sceneId,
    graphSemanticRevision: request.sceneRevision,
    outcome: overrides.outcome,
    agentRunId: overrides.agentRunId,
  };
}

function activeBlocklyProject(projectRoot) {
  return {
    readActiveBinding() {
      return {
        projectRoot,
        projectIdentity,
        sceneId,
        editorKind: 'blockly',
      };
    },
    isSameProjectRoot(left, right) {
      return left === right;
    },
  };
}

function nodeFilePort() {
  return {
    join: path.join,
    resolve: path.resolve,
    relative: path.relative,
    async readFile(filePath, signal) {
      throwIfAborted(signal);
      const value = await fs.readFile(filePath);
      throwIfAborted(signal);
      return new Uint8Array(value);
    },
    async replaceFileAtomic(projectRoot, relativePath, expectedBytes, bytes, signal) {
      throwIfAborted(signal);
      const result = await require('./project-file-writer').replaceProjectText({ projectPath: projectRoot,
        fileName: relativePath, expectedHash: expectedBytes === null ? null : `sha256:${sha256(expectedBytes)}`,
        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }, () => throwIfAborted(signal));
      throwIfAborted(signal);
      if (result.status === 'CONFLICT') return false;
      if (result.status !== 'COMMITTED' || result.warnings?.length) throw Object.assign(new Error(result.error ?? 'publication failed'), { code: result.code });
      return true;
    },
    async lstat(filePath, signal) {
      throwIfAborted(signal);
      const stat = await fs.lstat(filePath);
      return {
        size: stat.size,
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    },
    async realpath(filePath, signal) {
      throwIfAborted(signal);
      return await fs.realpath(filePath);
    },
  };
}

function projectHeadRuntimeAttachment(descriptor) {
  const sceneRevision = descriptor.document.visualRevision;
  return {
    schemaVersion: 1, kind: 'aily-project-scene-runtime-attachment', sessionId: 'session-1',
    sceneRevision, graphSemanticRevision: descriptor.document.graphSemanticRevision,
    artifactRevision: 'a'.repeat(64), gatewayOrigin: 'http://127.0.0.1:54321',
    capability: {
      schemaVersion: 1, kind: 'aily-scene-session-capability-grant', capabilityId: 'capability:scene-main',
      sessionId: 'session-1', sceneId: descriptor.sceneId, sceneRevision,
      permissions: ['scene.descriptor', 'scene.events', 'device.action', 'uart.read', 'uart.write', 'debug.inspect', 'debug.control'],
      issuedAtUnixMs: 1000000, expiresAtUnixMs: 4600000,
      accessToken: 'aily_sc_test_token'.padEnd(64, 'x'),
    },
  };
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function loadIntegrationModule() {
  const outfile = path.join(
    os.tmpdir(),
    `aily-simulator-product-callbacks-${process.pid}-${Date.now()}.cjs`,
  );
  const simulatorRoot = path.resolve(__dirname, '../../aily-simulator');
  const sdkEntry = path.join(
    simulatorRoot,
    'packages',
    'simulator-embed-host',
    'src',
    'index.ts',
  );
  const protocolRoot = path.join(simulatorRoot, 'packages', 'simulator-protocol');
  const protocolPackage = JSON.parse(await fs.readFile(path.join(protocolRoot, 'package.json'), 'utf8'));
  const protocolAliases = Object.fromEntries(Object.entries(protocolPackage.exports)
    .filter(([, target]) => typeof target?.import === 'string')
    .map(([subpath, target]) => [
      `${protocolPackage.name}${subpath === '.' ? '' : subpath.slice(1)}`,
      path.join(protocolRoot, target.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')),
    ]));
  const sceneModelEntry = path.join(
    simulatorRoot,
    'packages',
    'scene-model',
    'src',
    'index.ts',
  );
  const projectAuthority = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-project-artifact-callback-authority.ts',
  );
  const buildAuthority = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-build-callback-authority.ts',
  );
  const electronFilePort = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-electron-project-artifact-file-port.ts',
  );
  const buildExecutionPort = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-build-execution-port.ts',
  );
  const mainAgentSceneChangePort = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-main-agent-scene-change-port.ts',
  );
  const mainAgentSceneMessage = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-main-agent-scene-message.ts',
  );
  const blocklyBuilderPort = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-blockly-builder-port.ts',
  );
  const buildProductComposition = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-build-product-composition.ts',
  );
  const editorAuthority = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-blockly-editor-callback-authority.ts',
  );
  const entitlementAuthority = path.resolve(
    __dirname,
    '../src/app/integrations/simulator/simulator-entitlement-callback-authority.ts',
  );
  await esbuild.build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(sdkEntry)};`,
        `export { validateSceneArtifactRebuildRequest } from '@aily-project/simulator-protocol/scene';`,
        `export * from ${JSON.stringify(sceneModelEntry)};`,
        `export * from ${JSON.stringify(projectAuthority)};`,
        `export * from ${JSON.stringify(buildAuthority)};`,
        `export * from ${JSON.stringify(electronFilePort)};`,
        `export * from ${JSON.stringify(buildExecutionPort)};`,
        `export * from ${JSON.stringify(mainAgentSceneChangePort)};`,
        `export * from ${JSON.stringify(mainAgentSceneMessage)};`,
        `export * from ${JSON.stringify(blocklyBuilderPort)};`,
        `export * from ${JSON.stringify(buildProductComposition)};`,
        `export * from ${JSON.stringify(editorAuthority)};`,
        `export * from ${JSON.stringify(entitlementAuthority)};`,
        ...['session-lifecycle', 'session-scene', 'build-jobs', 'scene-artifact-replacement'].map(name =>
          `export * from ${JSON.stringify(path.join(simulatorRoot, 'packages/simulator-application/src', `${name}.ts`))};`),
      ].join('\n'),
      resolveDir: __dirname,
      sourcefile: 'simulator-product-callback-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    alias: {
      '@aily-project/simulator-host-sdk': sdkEntry,
      ...protocolAliases,
      '@aily-project/scene-model': sceneModelEntry,
    },
    logLevel: 'silent',
  });
  try {
    return require(outfile);
  } finally {
    await fs.rm(outfile, { force: true });
  }
}

async function loadHostProductService({ digest, onComposition }) {
  const filename = path.resolve(__dirname,
    '../src/app/integrations/simulator/simulator-host-provider-product.service.ts');
  const source = await fs.readFile(filename, 'utf8');
  const transformed = await esbuild.transform(source, {
    loader: 'ts', format: 'cjs', target: 'node22',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  class ProviderError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  class CallbackAuthority { callbacks = {}; close() {} clearDebugMarker() {} }
  const imports = {
    '@angular/core': { Injectable: () => value => value },
    '@aily-project/simulator-host-sdk': {
      SimulatorHostProviderOperationError: ProviderError,
      createSimulatorHostProviderDispatcherAdapterBundle: () => ({ adapters: [], close() {} }),
    },
    '@integration/subapps/public-api': {
      SubappHostProviderDispatcher: class {
        bindTransport() { return () => {}; }
        async close() {}
      },
    },
    './simulator-build-product-composition': {
      SimulatorBuildProductComposition: class {
        projectCallbacks = {}; buildCallbacks = {};
        constructor(options) { onComposition(options); }
        close() {}
      },
    },
    './simulator-blockly-editor-callback-authority': { SimulatorBlocklyEditorCallbackAuthority: CallbackAuthority },
    './simulator-entitlement-callback-authority': { SimulatorEntitlementCallbackAuthority: CallbackAuthority },
    './simulator-electron-project-artifact-file-port': { createSimulatorElectronProjectArtifactFilePort: () => ({}) },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformed.code, {
    module, exports: module.exports, TextEncoder, Uint8Array,
    crypto: { subtle: { digest } },
    window: { path: path.win32 },
    require(specifier) {
      assert.ok(Object.hasOwn(imports, specifier), `Unexpected product dependency: ${specifier}`);
      return imports[specifier];
    },
  }, { filename, timeout: 10_000 });
  return module.exports.SimulatorHostProviderProductService;
}
