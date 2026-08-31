const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

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
      async writeFileBufferAtomicAsync(filePath, bytes) {
        calls.push(['write-atomic', filePath, bytes.byteLength]);
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
  await port.writeFileAtomic(
    'project/.aily/simulator/scene-network-v2.json',
    Uint8Array.from([4, 5]),
    signal,
  );
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
    'write-atomic',
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

test('Blockly Build execution waits for the visible main Agent before compiling the exact Scene revision', async () => {
  const {
    BlocklySimulatorBuildExecutionPort,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  const artifact = artifactDescriptorFixture(
    Buffer.from('firmware-v3'),
    document.graphSemanticRevision,
  );
  const agentRequests = [];
  const builderCalls = [];
  let completeMainAgent;
  const execution = new BlocklySimulatorBuildExecutionPort({
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

test('a main-Agent user-edit conflict fails generation before Builder starts', async () => {
  const {
    BlocklySimulatorBuildExecutionPort,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  let builderCalled = false;
  const execution = new BlocklySimulatorBuildExecutionPort({
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
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
  const message = createSimulatorMainAgentSceneMessage({
    schemaVersion: 1,
    kind: 'aily-simulator-main-agent-scene-change-request',
    requestId: rebuild.requestId,
    projectIdentity,
    sceneId,
    graphSemanticRevision: rebuild.sceneRevision,
    sceneDocument: rebuild.sceneDocument,
  });

  assert.match(message, /主 Agent/u);
  assert.match(message, new RegExp(rebuild.requestId, 'u'));
  assert.match(message, new RegExp(rebuild.sceneRevision, 'u'));
  assert.match(message, /不要调用任何 subagent/u);
  assert.equal(message.includes('@SceneCodeReconciliationAgent'), false);
  assert.equal(message.includes('connection_output.json'), false);
});

test('product composition delivers the main-Agent Scene change through normal Builder and Project Artifact callbacks', async t => {
  const {
    SimulatorBuildHostProviderAdapter,
    SimulatorBuildProductComposition,
    SimulatorProjectHostProviderAdapter,
    createEmptySceneEditorDocumentV2,
  } = await integrationModulePromise;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-build-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const document = await createEmptySceneEditorDocumentV2(sceneId);
  const rebuild = rebuildRequest(document);
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
    createSimulatorBlocklyBuilderPort,
  } = await integrationModulePromise;
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
    graphSemanticRevision: 'd'.repeat(64),
  }, controller.signal);
  controller.abort(new Error('superseded'));
  await assert.rejects(completion, /cancelled/);
  assert.deepEqual(calls, [
    ['build', {
      projectPath: 'project',
      graphSemanticRevision: 'd'.repeat(64),
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
    async writeFileAtomic(filePath, bytes, signal) {
      throwIfAborted(signal);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
        throwIfAborted(signal);
        await fs.rename(temporaryPath, filePath);
      } finally {
        await fs.rm(temporaryPath, { force: true });
      }
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
  const protocolEntry = path.join(
    simulatorRoot,
    'packages',
    'simulator-protocol',
    'src',
    'index.ts',
  );
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
      '@aily-project/simulator-protocol': protocolEntry,
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
