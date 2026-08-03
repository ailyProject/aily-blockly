const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { originFromSenderUrl } = require('./simulator-gateway');
const { resolveSubappRoot } = require('./subapp-manager');

const CONTROL_SCHEMA_VERSION = 2;
const CONTROL_REQUEST_TYPE = 'aily-simulator-subapp.control.request';
const CONTROL_RESPONSE_TYPE = 'aily-simulator-subapp.control.response';
const REBUILD_SCHEMA_VERSION = 1;
const REBUILD_REQUEST_TYPE =
  'aily-simulator-subapp.scene-artifact-rebuild-request';
const REBUILD_ACK_TYPE =
  'aily-simulator-subapp.scene-artifact-rebuild-ack';
const REPLACEMENT_REQUEST_TYPE =
  'aily-simulator-subapp.scene-artifact-replacement-request';
const REPLACEMENT_RESULT_TYPE =
  'aily-simulator-subapp.scene-artifact-replacement-result';
const SHUTDOWN_MESSAGE = Object.freeze({
  type: 'aily-simulator-subapp.shutdown',
  version: 1,
});
const START_TIMEOUT_MS = 20_000;
const CONTROL_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const DIAGNOSTIC_TAIL_BYTES = 32 * 1024;
const CONNECTION_GRAPH_MAX_BYTES = 4 * 1024 * 1024;
const CONNECTION_GRAPH_MAX_DEPTH = 128;
const CONNECTION_GRAPH_MAX_NODES = 200_000;
const AGENT_SCENE_PROPOSAL_MAX_BYTES = 256 * 1024;
const SCENE_GENERATION_REQUEST_TTL_MS = 5 * 60 * 1000;
const LEGACY_CONNECTION_GRAPH_FILE = 'connection_output.json';
const PROJECT_DEBUG_CONFIGURATION_MAX_BYTES = 1024 * 1024;
const PROJECT_DEBUG_CONFIGURATION_FILE = 'aily-debug.json';
const TOOLS = new Set(['scene', 'debugger']);
const registeredIpcMains = new WeakSet();

function createSimulatorSubappHost(options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const runtimeResolver = options.runtimeResolver || resolveSimulatorSubappRuntime;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || (() => new Date());
  const startTimeoutMs = positiveTimeout(options.startTimeoutMs, START_TIMEOUT_MS);
  const controlTimeoutMs = positiveTimeout(
    options.controlTimeoutMs,
    CONTROL_TIMEOUT_MS,
  );
  const stopTimeoutMs = positiveTimeout(options.stopTimeoutMs, STOP_TIMEOUT_MS);
  const forceStopTimeoutMs = positiveTimeout(
    options.forceStopTimeoutMs,
    FORCE_STOP_TIMEOUT_MS,
  );
  const processExecutable = options.processExecutable || process.execPath;
  const moduleDirectory = options.moduleDirectory || __dirname;
  const onStateChanged = typeof options.onStateChanged === 'function'
    ? options.onStateChanged
    : () => {};
  let rebuildCoordinator = options.rebuildCoordinator || null;
  let sceneGenerationBroker = options.sceneGenerationBroker || null;

  let child = null;
  let ready = null;
  let active = null;
  let lastFailure = null;
  let stdoutTail = '';
  let stderrTail = '';
  let stdoutBuffer = '';
  let requestSequence = 0;
  let transition = Promise.resolve();
  let expectedExitChild = null;
  const pendingControls = new Map();
  const pendingReplacements = new Map();

  function serialize(operation) {
    const run = transition.then(operation, operation);
    transition = run.catch(() => undefined);
    return run;
  }

  async function open(options_) {
    return serialize(async () => {
      const input = validateOpenInput(options_);
      const projectRoot = requireProjectRoot(input.projectPath);
      const projectSceneOnly = input.mode === 'project-scene';
      const buildDirectory = projectSceneOnly
        ? projectRoot
        : path.join(projectRoot, '.build');
      if (!projectSceneOnly) requireArtifact(buildDirectory);
      const rendererOrigin = requireHttpOrigin(input.rendererOrigin);
      const projectIdentity = createProjectIdentity(projectRoot);
      const projectSceneBootstrap = projectSceneOnly
        ? resolveProjectSceneBootstrap(projectRoot)
        : null;
      const projectDebugConfiguration = projectSceneOnly
        ? null
        : readProjectDebugConfiguration(projectRoot);
      const launchRevision = projectSceneOnly
        ? createProjectSceneLaunchRevision(input)
        : createLaunchRevision(buildDirectory, input);

      if (
        active
        && child
        && !hasChildExited(child)
        && active.projectRoot === projectRoot
        && active.tool === input.tool
        && active.mode === input.mode
        && active.launchRevision === launchRevision
      ) {
        active.ownerId = input.ownerId;
        return publicOpenResult();
      }

      if (child) {
        await closeInternal();
      }

      const runtime = runtimeResolver({
        app: input.app,
        moduleDirectory,
        projectRoot,
      });
      if (input.tool === 'debugger' && !runtime.gdbExecutable) {
        throw new Error('Simulator Subapp debugger runtime is unavailable.');
      }
      const workDirectory = path.join(
        runtime.workRoot,
        projectIdentity,
      );
      fs.mkdirSync(workDirectory, { recursive: true });

      stdoutTail = '';
      stderrTail = '';
      stdoutBuffer = '';
      lastFailure = null;
      requestSequence = 0;

      const childArguments = createChildArguments({
        runtime,
        buildDirectory,
        rendererOrigin,
        workDirectory,
      });
      const spawned = spawnProcess(processExecutable, childArguments, {
        cwd: runtime.simulatorRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      child = spawned;
      attachChild(spawned);
      emitState({ state: 'starting' });

      try {
        ready = await waitForReady(spawned, rendererOrigin, startTimeoutMs);
        if (projectSceneOnly) {
          const launched = await sendControl(spawned, {
            operation: 'open-project-scene',
            projectIdentity,
            sceneId: input.sceneId,
            projectSceneFilePath: projectSceneBootstrap.sceneFilePath,
            ...(projectSceneBootstrap.legacyConnectionGraphFilePath
              ? {
                  legacyConnectionGraphFilePath:
                    projectSceneBootstrap.legacyConnectionGraphFilePath,
                }
              : {}),
          });
          requireSuccess(launched, 'open-project-scene');
          if (launched.state === 'legacy-scene-regeneration-required') {
            const requirement = validateLegacySceneRegenerationRequirement(
              launched.requirement,
              projectIdentity,
              input.sceneId,
            );
            active = {
              mode: 'project-scene',
              projectRoot,
              projectIdentity,
              ownerId: input.ownerId,
              tool: 'scene',
              sceneId: input.sceneId,
              initialization: 'legacy-detected',
              launchRevision,
              sessionId: null,
              artifactHandle: null,
              launchId: null,
              session: null,
              runtime: publicRuntime(runtime),
              rebuildRequest: null,
              rebuildCandidate: null,
              regenerationRequirement: requirement,
              sceneGeneration: null,
            };
            const result = publicRegenerationRequired();
            emitState(result);
            return result;
          }
          if (launched.state !== 'opening') {
            throw new Error('Simulator Subapp returned an invalid Project Scene state.');
          }
          const launchId = requireLaunchId(launched.launchId);
          active = {
            mode: 'project-scene',
            projectRoot,
            projectIdentity,
            ownerId: input.ownerId,
            tool: 'scene',
            sceneId: input.sceneId,
            initialization: projectSceneBootstrap.initialization,
            launchRevision,
            sessionId: null,
            artifactHandle: null,
            launchId,
            session: null,
            runtime: publicRuntime(runtime),
            rebuildRequest: null,
            rebuildCandidate: null,
            regenerationRequirement: null,
            sceneGeneration: null,
          };
          emitState({ state: 'ready', surface: publicSurface() });
          return publicSurface();
        }
        const sessionId = `session-v1-${randomBytes(16).toString('hex')}`;
        const imported = await sendControl(spawned, {
          operation: 'import-artifact',
          projectIdentity,
          sourceArtifactDirectory: '.',
        });
        requireSuccess(imported, 'import-artifact');
        const artifactHandle = requireArtifactHandle(imported.artifactHandle);

        const prepared = await sendControl(spawned, {
          operation: 'prepare-session',
          projectIdentity,
          sessionId,
          artifactHandle,
          sceneId: input.sceneId,
          connectionGraph: input.connectionGraph,
          ...(projectDebugConfiguration
            ? { projectDebugConfiguration }
            : {}),
        });
        requireSuccess(prepared, 'prepare-session');
        const session = publicSession(prepared.session, sessionId);

        const openOperation = input.tool === 'debugger'
          ? 'open-debugger'
          : 'open-scene';
        const launched = await sendControl(spawned, {
          operation: openOperation,
          projectIdentity,
          sessionId,
        });
        requireSuccess(launched, openOperation);
        const launchId = requireLaunchId(launched.launchId);

        active = {
          mode: 'session',
          projectRoot,
          projectIdentity,
          ownerId: input.ownerId,
          tool: input.tool,
          sceneId: input.sceneId,
          launchRevision,
          sessionId,
          artifactHandle,
          launchId,
          session,
          runtime: publicRuntime(runtime),
          rebuildRequest: null,
          rebuildCandidate: null,
          regenerationRequirement: null,
          sceneGeneration: null,
        };
        emitState({
          state: 'ready',
          surface: publicSurface(),
        });
        return publicSurface();
      } catch (error) {
        lastFailure = createFailure(
          'start',
          error,
          spawned,
          now,
          stdoutTail,
          stderrTail,
        );
        emitState({
          state: 'failed',
          failure: publicFailure(lastFailure),
        });
        await shutdownChild(spawned);
        if (child === spawned) clearChildState();
        throw error;
      }
    });
  }

  async function close(options_ = {}) {
    return serialize(async () => {
      if (
        active
        && options_?.ownerId !== undefined
        && normalizeOwnerId(options_.ownerId) !== active.ownerId
      ) {
        return status();
      }
      await closeInternal();
      return status();
    });
  }

  function openProjectScene(options_) {
    return open({
      ...options_,
      mode: 'project-scene',
      tool: 'scene',
    });
  }

  function requestProjectSceneGeneration(options_ = {}) {
    const input = validateProjectSceneGenerationStartInput(options_);
    if (!sceneGenerationBroker) {
      throw new Error('Project Scene generation broker is unavailable.');
    }
    if (
      !child
      || !active
      || hasChildExited(child)
      || active.mode !== 'project-scene'
      || (input.ownerId !== null && input.ownerId !== active.ownerId)
    ) {
      throw new Error('No matching Project Scene generation request is pending.');
    }
    const legacyRequest = input.regenerationId !== null;
    if (
      legacyRequest
        ? (
            active.launchId !== null
            || !active.regenerationRequirement
            || active.regenerationRequirement.regenerationId
              !== input.regenerationId
          )
        : (
            active.launchId !== input.launchId
            || active.regenerationRequirement !== null
          )
    ) {
      throw new Error('No matching Project Scene generation request is pending.');
    }

    const request = legacyRequest
      ? createLegacySceneGenerationRequest(active.regenerationRequirement)
      : createOpenSceneGenerationRequest(active, input.base, now);
    if (
      active.sceneGeneration
      && active.sceneGeneration.request.requestId === request.requestId
      && active.sceneGeneration.state !== 'failed'
    ) {
      return publicSceneGenerationAccepted(active.sceneGeneration.request);
    }
    active.sceneGeneration = {
      state: 'requested',
      request,
      proposal: null,
      failure: null,
    };
    emitState({
      state: 'scene-generation-requested',
      requestId: request.requestId,
      reason: request.reason,
    });
    void sceneGenerationBroker.request(request).catch((error) => {
      void serialize(async () => {
        if (
          !active?.sceneGeneration
          || active.sceneGeneration.request.requestId !== request.requestId
        ) {
          return;
        }
        const failure = publicSceneGenerationFailure(error, request.requestId);
        active.sceneGeneration.state = 'failed';
        active.sceneGeneration.failure = failure;
        emitState({ state: 'scene-generation-failed', failure });
      });
    });
    return publicSceneGenerationAccepted(request);
  }

  function stageSceneGenerationCandidate(value) {
    return serialize(async () => {
      if (!isRecord(value) || !isRecord(value.request)) {
        throw new Error('Project Scene generation candidate is invalid.');
      }
      const requestId = requirePortableIdentifier(
        value.request.requestId,
        'requestId',
        128,
      );
      if (
        !child
        || !active
        || hasChildExited(child)
        || active.mode !== 'project-scene'
        || !active.sceneGeneration
        || active.sceneGeneration.request.requestId !== requestId
        || JSON.stringify(active.sceneGeneration.request)
          !== JSON.stringify(value.request)
        || active.sceneGeneration.request.expiresAtUnixMs <= now().getTime()
        || (
          active.sceneGeneration.request.reason === 'legacy-detected'
            ? (
                active.launchId !== null
                || !active.regenerationRequirement
              )
            : (
                active.launchId === null
                || active.regenerationRequirement !== null
              )
        )
      ) {
        throw new Error('Project Scene generation candidate is stale.');
      }
      const proposal = validateAgentSceneChangeProposalForHost(
        value.proposal,
        active.projectIdentity,
        active.sceneId,
      );
      if (!sameSceneGenerationBase(
        proposal.base,
        active.sceneGeneration.request.base,
      )) {
        throw new Error('Project Scene generation candidate base is stale.');
      }
      active.sceneGeneration = {
        ...active.sceneGeneration,
        state: 'candidate-ready',
        proposal,
        failure: null,
      };
      const result = {
        schemaVersion: 1,
        kind: 'aily-simulator-subapp-project-scene-generation-candidate-result',
        state: 'candidate-ready',
        requestId,
        projectIdentity: active.projectIdentity,
        sceneId: active.sceneId,
        proposalId: proposal.proposalId,
      };
      emitState({
        state: 'scene-generation-candidate-ready',
        candidate: result,
      });
      return result;
    });
  }

  function resolveProjectSceneRegeneration(options_ = {}) {
    return serialize(async () => {
      const input = validateProjectSceneRegenerationResolutionInput(options_);
      if (
        !child
        || !active
        || hasChildExited(child)
        || active.mode !== 'project-scene'
        || active.launchId !== null
        || !active.regenerationRequirement
        || active.regenerationRequirement.regenerationId !== input.regenerationId
        || (input.ownerId !== null && input.ownerId !== active.ownerId)
      ) {
        throw new Error('No matching Project Scene regeneration is pending.');
      }
      const proposal = input.proposal === undefined
        ? undefined
        : validateAgentSceneChangeProposalForHost(
            input.proposal,
            active.projectIdentity,
            active.sceneId,
          );
      const resolved = await sendControl(child, {
        operation: 'resolve-project-scene-regeneration',
        projectIdentity: active.projectIdentity,
        regenerationId: input.regenerationId,
        resolution: input.resolution,
        ...(proposal ? { proposal } : {}),
      });
      requireSuccess(resolved, 'resolve-project-scene-regeneration');
      if (
        resolved.regenerationId !== input.regenerationId
        || (resolved.state !== 'cancelled' && resolved.state !== 'opening')
      ) {
        throw new Error(
          'Simulator Subapp returned an invalid regeneration result.',
        );
      }
      if (input.resolution === 'cancel') {
        if (resolved.state !== 'cancelled' || resolved.launchId !== undefined) {
          throw new Error('Simulator Subapp returned an invalid cancellation result.');
        }
        const result = {
          schemaVersion: 1,
          kind: 'aily-simulator-subapp-project-scene-regeneration-result',
          state: 'cancelled',
          regenerationId: input.regenerationId,
        };
        await closeInternal();
        return result;
      }
      if (resolved.state !== 'opening') {
        throw new Error('Simulator Subapp did not open the regenerated Scene.');
      }
      active.launchId = requireLaunchId(resolved.launchId);
      active.initialization = 'regenerated-v2';
      active.regenerationRequirement = null;
      emitState({ state: 'ready', surface: publicSurface() });
      return publicSurface();
    });
  }

  function applyProjectSceneAgentProposal(options_ = {}) {
    return serialize(async () => {
      if (
        !isRecord(options_)
        || Object.keys(options_).some((key) => key !== 'ownerId' && key !== 'proposal')
        || !Object.hasOwn(options_, 'proposal')
      ) {
        throw new Error('Project Scene Agent proposal request is invalid.');
      }
      const ownerId = normalizeOwnerId(options_?.ownerId);
      if (
        !child
        || !active
        || hasChildExited(child)
        || active.mode !== 'project-scene'
        || !active.launchId
        || active.regenerationRequirement
        || (ownerId !== null && ownerId !== active.ownerId)
      ) {
        throw new Error('No matching Project Scene is open.');
      }
      const proposal = validateAgentSceneChangeProposalForHost(
        options_?.proposal,
        active.projectIdentity,
        active.sceneId,
      );
      const applied = await sendControl(child, {
        operation: 'apply-project-scene-agent-proposal',
        projectIdentity: active.projectIdentity,
        launchId: active.launchId,
        proposal,
      });
      requireSuccess(applied, 'apply-project-scene-agent-proposal');
      if (applied.launchId !== active.launchId || applied.state !== 'applied') {
        throw new Error('Simulator Subapp returned an invalid Agent proposal result.');
      }
      return validateAgentSceneChangeReceiptForHost(
        applied.receipt,
        proposal,
        active.projectIdentity,
        active.sceneId,
      );
    });
  }

  function attachProjectSceneSession(options_ = {}) {
    return serialize(async () => {
      const ownerId = normalizeOwnerId(options_?.ownerId);
      if (
        !child
        || !active
        || hasChildExited(child)
        || active.mode !== 'project-scene'
        || !active.launchId
        || active.regenerationRequirement
        || (ownerId !== null && ownerId !== active.ownerId)
      ) {
        throw new Error('No matching Project Scene is open.');
      }
      if (active.sessionId && active.artifactHandle && active.session) {
        return {
          schemaVersion: 1,
          kind: 'aily-project-scene-session-attachment-result',
          state: 'attached',
          session: { ...active.session },
        };
      }
      const buildDirectory = path.join(active.projectRoot, '.build');
      requireArtifact(buildDirectory);
      const sessionId = `session-v1-${randomBytes(16).toString('hex')}`;
      const projectDebugConfiguration = readProjectDebugConfiguration(
        active.projectRoot,
      );
      let artifactHandle = null;
      try {
        const imported = await sendControl(child, {
          operation: 'import-artifact',
          projectIdentity: active.projectIdentity,
          sourceArtifactDirectory: '.build',
        });
        requireSuccess(imported, 'import-artifact');
        artifactHandle = requireArtifactHandle(imported.artifactHandle);
        const attached = await sendControl(child, {
          operation: 'attach-project-scene-session',
          projectIdentity: active.projectIdentity,
          launchId: active.launchId,
          sessionId,
          artifactHandle,
          ...(projectDebugConfiguration ? { projectDebugConfiguration } : {}),
        });
        requireSuccess(attached, 'attach-project-scene-session');
        if (
          attached.launchId !== active.launchId
          || attached.state !== 'attached'
        ) {
          throw new Error(
            'Simulator Subapp returned an invalid Project Scene attachment.',
          );
        }
        const session = publicSession(attached.session, sessionId);
        active.sessionId = sessionId;
        active.artifactHandle = artifactHandle;
        active.session = session;
        emitState({ state: 'ready', surface: publicSurface() });
        return {
          schemaVersion: 1,
          kind: 'aily-project-scene-session-attachment-result',
          state: 'attached',
          session: { ...session },
        };
      } catch (error) {
        if (artifactHandle) {
          await bestEffortControl(child, {
            operation: 'release-artifact',
            projectIdentity: active.projectIdentity,
            artifactHandle,
          });
        }
        throw error;
      }
    });
  }

  function detachProjectSceneSession(options_ = {}) {
    return serialize(async () => {
      const ownerId = normalizeOwnerId(options_?.ownerId);
      if (
        !child
        || !active
        || hasChildExited(child)
        || active.mode !== 'project-scene'
        || !active.launchId
        || active.regenerationRequirement
        || (ownerId !== null && ownerId !== active.ownerId)
      ) {
        throw new Error('No matching Project Scene is open.');
      }
      if (!active.sessionId || !active.artifactHandle) {
        return {
          schemaVersion: 1,
          kind: 'aily-project-scene-session-detachment-result',
          state: 'detached',
        };
      }
      const sessionId = active.sessionId;
      const artifactHandle = active.artifactHandle;
      const detached = await sendControl(child, {
        operation: 'detach-project-scene-session',
        projectIdentity: active.projectIdentity,
        launchId: active.launchId,
      });
      requireSuccess(detached, 'detach-project-scene-session');
      if (
        detached.launchId !== active.launchId
        || detached.sessionId !== sessionId
        || detached.state !== 'detached'
      ) {
        throw new Error(
          'Simulator Subapp returned an invalid Project Scene detachment.',
        );
      }
      await sendControl(child, {
        operation: 'release-artifact',
        projectIdentity: active.projectIdentity,
        artifactHandle,
      });
      active.sessionId = null;
      active.artifactHandle = null;
      active.session = null;
      emitState({ state: 'ready', surface: publicSurface() });
      return {
        schemaVersion: 1,
        kind: 'aily-project-scene-session-detachment-result',
        state: 'detached',
      };
    });
  }

  async function closeInternal() {
    const closingChild = child;
    const closingActive = active;
    if (!closingChild) {
      clearChildState();
      return;
    }
    expectedExitChild = closingChild;
    emitState({ state: 'stopping' });

      if (!hasChildExited(closingChild) && closingActive) {
      if (
        closingActive.mode === 'project-scene'
        && closingActive.launchId
        && closingActive.sessionId
      ) {
        await bestEffortControl(closingChild, {
          operation: 'detach-project-scene-session',
          projectIdentity: closingActive.projectIdentity,
          launchId: closingActive.launchId,
        });
      }
      if (closingActive.launchId) {
        const closeOperation = closingActive.tool === 'debugger'
          ? 'close-debugger'
          : 'close-scene';
        await bestEffortControl(closingChild, {
          operation: closeOperation,
          projectIdentity: closingActive.projectIdentity,
          launchId: closingActive.launchId,
        });
      }
        if (closingActive.sessionId && closingActive.mode !== 'project-scene') {
          await bestEffortControl(closingChild, {
            operation: 'close-session',
            sessionId: closingActive.sessionId,
          });
        }
        if (
          closingActive.rebuildCandidate
          && closingActive.artifactHandle
          && closingActive.rebuildCandidate.artifactHandle
            !== closingActive.artifactHandle
        ) {
          await bestEffortControl(closingChild, {
            operation: 'release-artifact',
            projectIdentity: closingActive.projectIdentity,
            artifactHandle: closingActive.rebuildCandidate.artifactHandle,
          });
        }
        if (closingActive.artifactHandle) {
          await bestEffortControl(closingChild, {
            operation: 'release-artifact',
            projectIdentity: closingActive.projectIdentity,
            artifactHandle: closingActive.artifactHandle,
          });
        }
    }

    await shutdownChild(closingChild);
    if (child === closingChild) clearChildState();
    if (expectedExitChild === closingChild) expectedExitChild = null;
    emitState({ state: 'stopped' });
  }

  async function bestEffortControl(target, request) {
    try {
      await sendControl(target, request);
    } catch {
      // Shutdown remains authoritative even if a cleanup request cannot complete.
    }
  }

  async function shutdownChild(target) {
    if (hasChildExited(target)) return;
    try {
      if (target.connected && typeof target.send === 'function') {
        target.send(SHUTDOWN_MESSAGE);
      }
    } catch {
      // Fall through to bounded termination.
    }
    if (await waitForExit(target, stopTimeoutMs)) return;
    try {
      target.kill();
    } catch {
      // The process may have exited between the check and kill.
    }
    await waitForExit(target, forceStopTimeoutMs);
  }

  function status() {
    if (child && active && !hasChildExited(child)) {
      if (active.regenerationRequirement) {
        return publicRegenerationRequired();
      }
      return {
        state: 'ready',
        tool: active.tool,
        launchId: active.launchId,
        sessionState: active.session?.state ?? 'not-attached',
        ...(active.mode === 'project-scene'
          ? { initialization: active.initialization }
          : {}),
        runtimeSource: active.runtime.runtimeSource,
        ...(active.runtime.runtimePackId
          ? { runtimePackId: active.runtime.runtimePackId }
          : {}),
        ...(active.runtime.runtimeMode
          ? { runtimeMode: active.runtime.runtimeMode }
          : {}),
        ...(active.rebuildCandidate
          ? {
              artifactRebuild: {
                state: 'candidate-ready',
                requestId: active.rebuildCandidate.requestId,
                sceneRevision: active.rebuildCandidate.sceneRevision,
                candidateArtifactRevision:
                  active.rebuildCandidate.artifactRevision,
              },
            }
          : active.rebuildRequest
          ? {
              artifactRebuild: {
                state: 'requested',
                requestId: active.rebuildRequest.request.requestId,
                sceneRevision: active.rebuildRequest.request.sceneRevision,
              },
            }
          : {}),
      };
    }
    return {
      state: 'stopped',
      ...(lastFailure ? { lastFailure: publicFailure(lastFailure) } : {}),
    };
  }

  function publicSurface() {
    if (!ready || !active || !active.launchId || active.regenerationRequirement) {
      throw new Error('Simulator Subapp surface is not ready.');
    }
    return {
      schemaVersion: 1,
      kind: 'aily-simulator-subapp-surface',
      state: 'ready',
      tool: active.tool,
      url: new URL(ready.shellPath, `${ready.url}/`).toString(),
      origin: ready.origin,
      launchId: active.launchId,
      runtimeSource: active.runtime.runtimeSource,
      ...(active.mode === 'project-scene'
        ? { initialization: active.initialization }
        : {}),
      ...(active.runtime.runtimePackId
        ? { runtimePackId: active.runtime.runtimePackId }
        : {}),
      ...(active.runtime.runtimeMode
        ? { runtimeMode: active.runtime.runtimeMode }
        : {}),
    };
  }

  function publicRegenerationRequired() {
    if (!ready || !active?.regenerationRequirement) {
      throw new Error('Project Scene regeneration is not pending.');
    }
    return {
      schemaVersion: 1,
      kind: 'aily-simulator-subapp-project-scene-regeneration-required',
      state: 'legacy-scene-regeneration-required',
      tool: 'scene',
      initialization: active.initialization,
      requirement: structuredClone(active.regenerationRequirement),
      runtimeSource: active.runtime.runtimeSource,
      ...(active.runtime.runtimePackId
        ? { runtimePackId: active.runtime.runtimePackId }
        : {}),
      ...(active.runtime.runtimeMode
        ? { runtimeMode: active.runtime.runtimeMode }
        : {}),
    };
  }

  function publicOpenResult() {
    return active?.regenerationRequirement
      ? publicRegenerationRequired()
      : publicSurface();
  }

  function attachChild(target) {
    target.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdoutTail = appendTail(stdoutTail, text);
      stdoutBuffer += text;
    });
    target.stderr?.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk.toString('utf8'));
    });
    target.on('message', (message) => handleChildMessage(target, message));
    target.once('error', (error) => {
      handleChildFailure(target, error);
    });
    target.once('exit', (code, signal) => {
      const expected = expectedExitChild === target;
      rejectPendingForChild(
        target,
        new Error(`Simulator Subapp exited (${code ?? signal ?? 'unknown'}).`),
      );
      if (child !== target) return;
      if (!expected) {
        lastFailure = {
          phase: active ? 'runtime' : 'start',
          message: 'Simulator Subapp exited unexpectedly.',
          code: code ?? null,
          signal: signal ?? null,
          stdoutTail,
          stderrTail,
          occurredAt: now().toISOString(),
        };
        emitState({
          state: 'failed',
          unexpected: true,
          failure: publicFailure(lastFailure),
        });
      }
      clearChildState();
    });
  }

  function handleChildFailure(target, error) {
    rejectPendingForChild(target, error);
    if (child !== target) return;
    lastFailure = createFailure(
      active ? 'runtime' : 'start',
      error,
      target,
      now,
      stdoutTail,
      stderrTail,
    );
    emitState({
      state: 'failed',
      unexpected: expectedExitChild !== target,
      failure: publicFailure(lastFailure),
    });
  }

  function handleControlMessage(target, message) {
    if (
      !isRecord(message)
      || Object.keys(message).sort().join('\0')
        !== ['response', 'type', 'version'].join('\0')
      || message.type !== CONTROL_RESPONSE_TYPE
      || message.version !== CONTROL_SCHEMA_VERSION
      || !isRecord(message.response)
    ) {
      return;
    }
    const response = message.response;
    const requestId = response.requestId;
    if (typeof requestId !== 'string') return;
    const pending = pendingControls.get(requestId);
    if (!pending || pending.child !== target) return;
    pendingControls.delete(requestId);
    clearTimeout(pending.timer);
    if (
      response.schemaVersion !== CONTROL_SCHEMA_VERSION
      || response.operation !== pending.operation
    ) {
      pending.reject(new Error('Simulator Subapp returned an invalid control response.'));
      return;
    }
    if (response.kind === 'aily-simulator-subapp-control-failure') {
      const errorCode = typeof response.errorCode === 'string'
        ? response.errorCode
        : 'invalid-response';
      pending.reject(
        new Error(`Simulator Subapp ${pending.operation} failed (${errorCode}).`),
      );
      return;
    }
    if (response.kind !== 'aily-simulator-subapp-control-success') {
      pending.reject(new Error('Simulator Subapp returned an invalid control response.'));
      return;
    }
    pending.resolve(response);
  }

  function handleChildMessage(target, message) {
    if (handleRebuildRequestMessage(target, message)) return;
    if (handleReplacementResultMessage(target, message)) return;
    handleControlMessage(target, message);
  }

  function handleReplacementResultMessage(target, message) {
    if (
      !isRecord(message)
      || Object.keys(message).sort().join('\0')
        !== ['result', 'type', 'version'].join('\0')
      || message.type !== REPLACEMENT_RESULT_TYPE
      || message.version !== REBUILD_SCHEMA_VERSION
    ) {
      return false;
    }
    let result;
    try {
      result = validateSceneArtifactReplacementResult(message.result);
    } catch {
      return true;
    }
    const pending = pendingReplacements.get(result.replacementId);
    if (!pending || pending.child !== target) return true;
    pendingReplacements.delete(result.replacementId);
    clearTimeout(pending.timer);
    if (
      result.requestId !== pending.request.requestId
      || result.sessionId !== pending.request.sessionId
      || result.sceneId !== pending.request.sceneId
    ) {
      pending.reject(new Error(
        'Simulator Subapp returned a replacement result with mismatched scope.',
      ));
      return true;
    }
    pending.resolve(result);
    return true;
  }

  function handleRebuildRequestMessage(target, message) {
    if (
      !isRecord(message)
      || Object.keys(message).sort().join('\0')
        !== ['request', 'type', 'version'].join('\0')
      || message.type !== REBUILD_REQUEST_TYPE
      || message.version !== REBUILD_SCHEMA_VERSION
    ) {
      return false;
    }
    let request;
    try {
      request = validateSceneArtifactRebuildRequest(message.request);
    } catch (error) {
      emitState({
        state: 'rebuild-request-invalid',
        errorCode: 'invalid-request',
        detail: error instanceof Error
          ? error.message
          : 'Invalid Scene Artifact rebuild request.',
      });
      return true;
    }
    if (
      target !== child
      || hasChildExited(target)
      || !target.connected
      || typeof target.send !== 'function'
    ) {
      return true;
    }
    if (
      !active
      || active.tool !== 'scene'
      || request.projectIdentity !== active.projectIdentity
      || request.sessionId !== active.sessionId
      || request.sceneId !== active.sceneId
    ) {
      sendRebuildAck(target, createRebuildAck(
        request,
        'rejected',
        'project-not-active',
      ));
      return true;
    }
    const identity = JSON.stringify(request);
    if (
      active.rebuildRequest?.request.requestId === request.requestId
      && active.rebuildRequest.identity !== identity
    ) {
      sendRebuildAck(target, createRebuildAck(
        request,
        'conflict',
        'request-superseded',
      ));
      return true;
    }
    if (rebuildCoordinator) {
      let registration;
      try {
        registration = rebuildCoordinator.enqueue({
          request: structuredClone(request),
          projectRoot: active.projectRoot,
        });
      } catch {
        registration = { accepted: false, errorCode: 'host-unavailable' };
      }
      if (!registration?.accepted) {
        const superseded = registration?.errorCode === 'request-superseded';
        sendRebuildAck(target, createRebuildAck(
          request,
          superseded ? 'conflict' : 'rejected',
          superseded ? 'request-superseded' : 'host-unavailable',
        ));
        return true;
      }
    }
    if (!active.rebuildRequest || active.rebuildRequest.identity !== identity) {
      const previousCandidate = active.rebuildCandidate;
      active.rebuildCandidate = null;
      if (
        previousCandidate
        && previousCandidate.artifactHandle !== active.artifactHandle
      ) {
        void bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: active.projectIdentity,
          artifactHandle: previousCandidate.artifactHandle,
        });
      }
      active.rebuildRequest = {
        identity,
        request: structuredClone(request),
      };
      emitState({
        state: 'rebuild-requested',
        artifactRebuild: {
          state: 'requested',
          requestId: request.requestId,
          sceneRevision: request.sceneRevision,
        },
      });
    }
    sendRebuildAck(target, createRebuildAck(request, 'accepted', null));
    return true;
  }

  function sendRebuildAck(target, ack) {
    try {
      target.send({
        type: REBUILD_ACK_TYPE,
        version: REBUILD_SCHEMA_VERSION,
        ack,
      }, () => undefined);
    } catch {
      // Child disconnect is handled by the normal process lifecycle.
    }
  }

  async function stageRebuildCandidate(candidateEvent) {
    return serialize(async () => {
      const request = candidateEvent?.request;
      const candidate = candidateEvent?.candidate;
      const projectRoot = candidateEvent?.projectRoot;
      const target = child;
      if (
        !active
        || !target
        || hasChildExited(target)
        || projectRoot !== active.projectRoot
        || request?.projectIdentity !== active.projectIdentity
        || request?.sessionId !== active.sessionId
        || request?.sceneId !== active.sceneId
        || request?.requestId !== active.rebuildRequest?.request.requestId
        || request?.sceneRevision
          !== active.rebuildRequest?.request.sceneRevision
        || !isSha256(candidate?.artifactId)
        || candidate?.graphSemanticRevision !== request.sceneRevision
      ) {
        throw new Error('Simulator rebuild candidate is no longer current.');
      }

      const imported = await sendControl(target, {
        operation: 'import-artifact',
        projectIdentity: active.projectIdentity,
        sourceArtifactDirectory: '.',
      });
      requireSuccess(imported, 'import-artifact');
      const artifactHandle = requireArtifactHandle(imported.artifactHandle);
      if (
        !active
        || child !== target
        || request.requestId !== active.rebuildRequest?.request.requestId
        || request.sceneRevision
          !== active.rebuildRequest?.request.sceneRevision
      ) {
        await bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: request.projectIdentity,
          artifactHandle,
        });
        throw new Error('Simulator rebuild candidate was superseded during import.');
      }

      const previousCandidate = active.rebuildCandidate;
      active.rebuildCandidate = {
        requestId: request.requestId,
        sceneRevision: request.sceneRevision,
        artifactRevision: candidate.artifactId,
        artifactHandle,
      };
      if (
        previousCandidate
        && previousCandidate.artifactHandle !== artifactHandle
        && previousCandidate.artifactHandle !== active.artifactHandle
      ) {
        await bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: active.projectIdentity,
          artifactHandle: previousCandidate.artifactHandle,
        });
      }
      emitState({
        state: 'artifact-replacement-validating',
        artifactRebuild: {
          state: 'replacement-validating',
          requestId: request.requestId,
          sceneRevision: request.sceneRevision,
          candidateArtifactRevision: candidate.artifactId,
        },
      });
      const replacementRequest = validateSceneArtifactReplacementRequest({
        schemaVersion: REBUILD_SCHEMA_VERSION,
        kind: 'aily-scene-artifact-replacement-request',
        requestId: request.requestId,
        replacementId:
          `replacement-v1-${randomBytes(32).toString('hex')}`,
        projectIdentity: request.projectIdentity,
        sessionId: request.sessionId,
        sceneId: request.sceneId,
        baseSceneRevision: request.baseSceneRevision,
        expectedSceneRevision: request.sceneRevision,
        baseArtifactRevision: request.artifactRevision,
        artifactHandle,
        candidateArtifactRevision: candidate.artifactId,
      });
      let result;
      try {
        result = await sendReplacement(target, replacementRequest);
      } catch (error) {
        await bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: request.projectIdentity,
          artifactHandle,
        });
        if (active?.rebuildCandidate?.artifactHandle === artifactHandle) {
          active.rebuildCandidate = null;
        }
        throw error;
      }
      if (
        !active
        || child !== target
        || active.rebuildCandidate?.artifactHandle !== artifactHandle
      ) {
        throw new Error('Simulator replacement completed after its host was superseded.');
      }
      if (result.status === 'rejected') {
        await bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: request.projectIdentity,
          artifactHandle,
        });
        active.rebuildCandidate = null;
        emitState({
          state: 'artifact-replacement-rejected',
          artifactRebuild: {
            state: 'replacement-rejected',
            requestId: request.requestId,
            sceneRevision: result.sceneRevision,
            errorCode: result.errorCode,
          },
        });
        throw new Error(
          `Simulator Artifact replacement was rejected (${result.errorCode}).`,
        );
      }
      const previousArtifactHandle = active.artifactHandle;
      active.artifactHandle = artifactHandle;
      active.session = {
        ...active.session,
        sceneRevision: result.sceneRevision,
      };
      active.rebuildRequest = null;
      active.rebuildCandidate = null;
      if (previousArtifactHandle !== artifactHandle) {
        await bestEffortControl(target, {
          operation: 'release-artifact',
          projectIdentity: request.projectIdentity,
          artifactHandle: previousArtifactHandle,
        });
      }
      emitState({
        state: 'artifact-replacement-committed',
        artifactRebuild: {
          state: 'aligned',
          requestId: request.requestId,
          sceneRevision: result.sceneRevision,
          artifactRevision: result.artifactRevision,
        },
      });
      return status();
    });
  }

  function sendReplacement(target, request) {
    if (
      target !== child
      || hasChildExited(target)
      || !target.connected
      || typeof target.send !== 'function'
    ) {
      return Promise.reject(
        new Error('Simulator Subapp replacement channel is unavailable.'),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplacements.delete(request.replacementId);
        reject(new Error('Simulator Subapp Artifact replacement timed out.'));
      }, Math.max(controlTimeoutMs, 120_000));
      pendingReplacements.set(request.replacementId, {
        child: target,
        request,
        resolve,
        reject,
        timer,
      });
      try {
        target.send({
          type: REPLACEMENT_REQUEST_TYPE,
          version: REBUILD_SCHEMA_VERSION,
          request,
        }, (error) => {
          if (!error) return;
          const pending = pendingReplacements.get(request.replacementId);
          if (!pending) return;
          pendingReplacements.delete(request.replacementId);
          clearTimeout(pending.timer);
          pending.reject(new Error(
            'Simulator Subapp replacement request could not be sent.',
          ));
        });
      } catch {
        const pending = pendingReplacements.get(request.replacementId);
        if (pending) {
          pendingReplacements.delete(request.replacementId);
          clearTimeout(pending.timer);
          pending.reject(new Error(
            'Simulator Subapp replacement request could not be sent.',
          ));
        }
      }
    });
  }

  function sendControl(target, request) {
    if (
      target !== child
      || hasChildExited(target)
      || !target.connected
      || typeof target.send !== 'function'
    ) {
      return Promise.reject(new Error('Simulator Subapp control channel is unavailable.'));
    }
    requestSequence += 1;
    const requestId = `request-v1-${requestSequence}-${randomBytes(8).toString('hex')}`;
    const completeRequest = {
      schemaVersion: CONTROL_SCHEMA_VERSION,
      kind: 'aily-simulator-subapp-control-request',
      requestId,
      ...request,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingControls.delete(requestId);
        reject(new Error(`Simulator Subapp ${request.operation} timed out.`));
      }, controlTimeoutMs);
      pendingControls.set(requestId, {
        child: target,
        operation: request.operation,
        resolve,
        reject,
        timer,
      });
      try {
        target.send({
          type: CONTROL_REQUEST_TYPE,
          version: CONTROL_SCHEMA_VERSION,
          request: completeRequest,
        }, (error) => {
          if (!error) return;
          const pending = pendingControls.get(requestId);
          if (!pending) return;
          pendingControls.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error('Simulator Subapp control message could not be sent.'));
        });
      } catch {
        const pending = pendingControls.get(requestId);
        if (pending) {
          pendingControls.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error('Simulator Subapp control message could not be sent.'));
        }
      }
    });
  }

  function waitForReady(target, rendererOrigin, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error('Simulator Subapp startup timed out.'));
      }, timeoutMs);

      const onStdout = () => {
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event?.event === 'fatal') {
            finish(new Error(
              typeof event?.data?.message === 'string'
                ? event.data.message
                : 'Simulator Subapp startup failed.',
            ));
            return;
          }
          if (event?.event !== 'ready') continue;
          try {
            const descriptor = validateReady(event.data, rendererOrigin);
            finish(null, descriptor);
          } catch (error) {
            finish(error);
          }
          return;
        }
      };
      const onExit = (code, signal) => {
        finish(new Error(
          `Simulator Subapp exited during startup (${code ?? signal ?? 'unknown'}).`,
        ));
      };
      const onError = (error) => finish(error);

      function finish(error, descriptor) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.stdout?.removeListener('data', onStdout);
        target.removeListener('exit', onExit);
        target.removeListener('error', onError);
        if (error) reject(error);
        else resolve(descriptor);
      }

      target.stdout?.on('data', onStdout);
      target.once('exit', onExit);
      target.once('error', onError);
      onStdout();
    });
  }

  function waitForExit(target, timeoutMs) {
    if (hasChildExited(target)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish(false), timeoutMs);
      const onExit = () => finish(true);
      target.once('exit', onExit);
      function finish(exited) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        target.removeListener('exit', onExit);
        resolve(exited);
      }
    });
  }

  function rejectPendingForChild(target, error) {
    for (const [requestId, pending] of pendingControls) {
      if (pending.child !== target) continue;
      pendingControls.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [replacementId, pending] of pendingReplacements) {
      if (pending.child !== target) continue;
      pendingReplacements.delete(replacementId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  function clearChildState() {
    if (active?.sceneGeneration?.request?.requestId) {
      try {
        sceneGenerationBroker?.cancel?.(
          active.sceneGeneration.request.requestId,
          'Project Scene host was closed.',
        );
      } catch {
        // Scene generation cleanup must not interfere with process ownership.
      }
    }
    try {
      rebuildCoordinator?.reset?.();
    } catch {
      // Rebuild cleanup must not interfere with child process ownership.
    }
    child = null;
    ready = null;
    active = null;
    stdoutBuffer = '';
  }

  function emitState(payload) {
    try {
      onStateChanged(Object.freeze({ ...payload }));
    } catch {
      // Renderer notifications must never affect process ownership.
    }
  }

  function setRebuildCoordinator(coordinator) {
    if (
      coordinator !== null
      && (
        typeof coordinator !== 'object'
        || typeof coordinator.enqueue !== 'function'
        || typeof coordinator.reset !== 'function'
      )
    ) {
      throw new Error('Simulator project rebuild coordinator is invalid.');
    }
    rebuildCoordinator = coordinator;
  }

  function setSceneGenerationBroker(broker) {
    if (
      broker !== null
      && (
        typeof broker !== 'object'
        || typeof broker.request !== 'function'
        || typeof broker.cancel !== 'function'
      )
    ) {
      throw new Error('Project Scene generation broker is invalid.');
    }
    sceneGenerationBroker = broker;
  }

  return Object.freeze({
    open,
    openProjectScene,
    requestProjectSceneGeneration,
    stageSceneGenerationCandidate,
    resolveProjectSceneRegeneration,
    applyProjectSceneAgentProposal,
    attachProjectSceneSession,
    detachProjectSceneSession,
    close,
    stop: close,
    status,
    setRebuildCoordinator,
    setSceneGenerationBroker,
    stageRebuildCandidate,
  });
}

function resolveSimulatorSubappRuntime({ app, moduleDirectory }) {
  const workspaceRoot = path.resolve(moduleDirectory, '..', '..', 'aily-simulator');
  const installedRoot = path.join(
    resolveSubappRoot({
      env: process.env,
      platform: process.platform,
      home: os.homedir(),
    }),
    'node_modules',
    '@aily-project',
    'subapp-aily-simulator',
  );
  const simulatorRoot = firstExistingDirectory([
    process.env.AILY_SIMULATOR_SUBAPP_ROOT,
    process.env.AILY_SIMULATOR_ROOT,
    app?.isPackaged ? installedRoot : workspaceRoot,
    app?.isPackaged ? path.join(process.resourcesPath, 'simulator') : installedRoot,
  ]);
  if (!simulatorRoot) {
    throw new Error(
      'Simulator Subapp is not installed. Set AILY_SIMULATOR_SUBAPP_ROOT for development.',
    );
  }
  const manifestPath = path.join(
    simulatorRoot,
    'aily-simulator-runtime.json',
  );
  const manifest = fs.existsSync(manifestPath)
    ? readJsonFile(manifestPath, 'Simulator Runtime Manifest')
    : null;
  if (
    manifest
    && (
      manifest.schemaVersion !== 1
      || manifest.platform !== `${process.platform}-${process.arch}`
      || !isRecord(manifest.entrypoints)
    )
  ) {
    throw new Error('Simulator Runtime Manifest is invalid for this platform.');
  }
  const entrypoints = isRecord(manifest?.entrypoints)
    ? manifest.entrypoints
    : {};
  const productionEntry = firstExistingPath([
    process.env.AILY_SIMULATOR_SUBAPP_ENTRY,
    resolveOptionalBundlePath(simulatorRoot, entrypoints.subappService),
    path.join(
      simulatorRoot,
      'packages',
      'simulator-gateway',
      'dist',
      'production-cli.js',
    ),
  ]);
  if (!productionEntry) {
    throw new Error(
      'Simulator Subapp service has not been built. Run npm run gateway:build in aily-simulator.',
    );
  }

  const entitlementConfigPath = firstExistingPath([
    process.env.AILY_SIMULATOR_ENTITLEMENT_CONFIG,
    resolveOptionalBundlePath(
      simulatorRoot,
      entrypoints.entitlementConfig,
    ),
    path.join(simulatorRoot, 'runtime', 'entitlement', 'trust-config.json'),
  ]);
  if (!entitlementConfigPath) {
    throw new Error(
      'Simulator entitlement trust configuration is unavailable. '
      + 'Set AILY_SIMULATOR_ENTITLEMENT_CONFIG for the development runtime.',
    );
  }

  const instrumentAssetsDirectory = firstExistingDirectory([
    process.env.AILY_SIMULATOR_INSTRUMENT_ASSETS,
    resolveOptionalBundlePath(
      simulatorRoot,
      entrypoints.instrumentAssets,
    ),
    typeof entrypoints.subappShell === 'string'
      ? path.dirname(resolveOptionalBundlePath(simulatorRoot, entrypoints.subappShell))
      : null,
    path.join(
      simulatorRoot,
      'packages',
      'simulator-subapp-runtime',
      'page-dist',
    ),
  ]);
  if (!instrumentAssetsDirectory) {
    throw new Error('Simulator Subapp browser assets have not been built.');
  }

  const workRoot = process.env.AILY_SIMULATOR_SUBAPP_WORK_ROOT
    || path.join(app.getPath('userData'), 'simulator-subapp', 'v1');
  const qemuExecutable = firstExistingPath([
    process.env.AILY_PATCHED_QEMU,
    process.env.AILY_SIMULATOR_QEMU,
    resolveOptionalBundlePath(simulatorRoot, entrypoints.qemu),
    path.join(
      simulatorRoot,
      'runtime',
      'qemu',
      'bin',
      process.platform === 'win32'
        ? 'qemu-system-xtensa.exe'
        : 'qemu-system-xtensa',
    ),
    path.join(
      simulatorRoot,
      '.runtime',
      'build',
      'aily-qemu',
      process.platform === 'win32'
        ? `windows-${process.arch}`
        : `${process.platform}-${process.arch}`,
      'install',
      'qemu',
      'bin',
      process.platform === 'win32'
        ? 'qemu-system-xtensa.exe'
        : 'qemu-system-xtensa',
    ),
  ]);
  if (!qemuExecutable) {
    throw new Error('Aily patched QEMU runtime is unavailable.');
  }
  const qemuDataDirectory = firstExistingDirectory([
    process.env.AILY_SIMULATOR_QEMU_DATA,
    resolveOptionalBundlePath(simulatorRoot, entrypoints.qemuData),
    path.resolve(path.dirname(qemuExecutable), '..', 'share', 'qemu'),
  ]);
  const gdbExecutableName = process.platform === 'win32'
    ? 'xtensa-esp32s3-elf-gdb.exe'
    : 'xtensa-esp32s3-elf-gdb';
  const gdbExecutable = firstExistingPath([
    process.env.AILY_SIMULATOR_GDB,
    resolveOptionalBundlePath(simulatorRoot, entrypoints.gdb),
    path.join(simulatorRoot, 'runtime', 'gdb', 'bin', gdbExecutableName),
    path.join(
      simulatorRoot,
      '.runtime',
      'qemu',
      'espressif-qemu-xtensa-9.2.2-20250817',
      'win32-x64',
      'debugger',
      'xtensa-esp-elf-gdb',
      'bin',
      gdbExecutableName,
    ),
  ]);
  const freeRtosBridgePath = firstExistingPath([
    process.env.AILY_SIMULATOR_FREERTOS_BRIDGE,
    resolveOptionalBundlePath(simulatorRoot, entrypoints.freeRtosBridge),
    path.join(
      simulatorRoot,
      'packages',
      'simulator-host',
      'gdb',
      'aily_freertos_snapshot.gdb',
    ),
  ]);
  const source = process.env.AILY_SIMULATOR_SUBAPP_ROOT
    || process.env.AILY_SIMULATOR_ROOT
    ? 'environment'
    : simulatorRoot === workspaceRoot
    ? 'workspace'
    : simulatorRoot === installedRoot
    ? 'installed-subapp'
    : 'packaged';
  return {
    simulatorRoot,
    productionEntry,
    entitlementConfigPath,
    instrumentAssetsDirectory,
    workRoot,
    qemuExecutable,
    qemuDataDirectory,
    gdbExecutable,
    freeRtosBridgePath,
    runtimePackId: typeof manifest?.id === 'string' ? manifest.id : null,
    runtimeMode: typeof manifest?.mode === 'string' ? manifest.mode : null,
    source,
  };
}

function createChildArguments({
  runtime,
  buildDirectory,
  rendererOrigin,
  workDirectory,
}) {
  const result = [
    runtime.productionEntry,
    'serve',
    '--qemu',
    runtime.qemuExecutable,
    '--artifact-root',
    buildDirectory,
    '--work-directory',
    workDirectory,
    '--entitlement-config',
    runtime.entitlementConfigPath,
    '--origin',
    rendererOrigin,
    '--port',
    '0',
    '--instrument-assets',
    runtime.instrumentAssetsDirectory,
  ];
  if (runtime.qemuDataDirectory) {
    result.push('--qemu-data', runtime.qemuDataDirectory);
  }
  if (runtime.gdbExecutable) {
    result.push('--gdb', runtime.gdbExecutable);
    if (runtime.freeRtosBridgePath) {
      result.push('--freertos-bridge', runtime.freeRtosBridgePath);
    }
  }
  return result;
}

function validateOpenInput(value) {
  if (!isRecord(value)) throw new Error('Simulator Subapp open request is invalid.');
  const allowedKeys = new Set([
    'app',
    'connectionGraph',
    'mode',
    'ownerId',
    'projectPath',
    'rendererOrigin',
    'sceneId',
    'tool',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Simulator Subapp open request contains unsupported fields.');
  }
  const tool = value.tool ?? 'scene';
  if (!TOOLS.has(tool)) {
    throw new Error('Simulator Subapp tool must be scene or debugger.');
  }
  const mode = value.mode ?? 'session';
  if (
    (mode !== 'session' && mode !== 'project-scene')
    || (mode === 'project-scene' && tool !== 'scene')
  ) {
    throw new Error('Simulator Subapp mode is invalid.');
  }
  const sceneId = requirePortableIdentifier(value.sceneId ?? 'main', 'sceneId', 128);
  const connectionGraph = mode === 'session'
    ? validateConnectionGraph(value.connectionGraph ?? {})
    : {};
  return {
    app: value.app,
    projectPath: value.projectPath,
    rendererOrigin: value.rendererOrigin,
    ownerId: normalizeOwnerId(value.ownerId),
    tool,
    mode,
    sceneId,
    connectionGraph,
  };
}

function resolveProjectSceneBootstrap(projectRoot) {
  const sceneFilePath = path.join(projectRoot, '.aily', 'scene.json');
  if (fs.existsSync(sceneFilePath)) {
    if (!fs.lstatSync(sceneFilePath).isFile()) {
      throw new Error('Project Scene path is not a file.');
    }
    return {
      sceneFilePath,
      initialization: 'existing',
      legacyConnectionGraphFilePath: null,
    };
  }
  const legacyFilePath = path.join(projectRoot, LEGACY_CONNECTION_GRAPH_FILE);
  const legacyExists = fs.existsSync(legacyFilePath);
  if (legacyExists && !fs.lstatSync(legacyFilePath).isFile()) {
    throw new Error('Legacy connection graph path is not a file.');
  }
  return {
    sceneFilePath,
    initialization: legacyExists ? 'legacy-detected' : 'created-empty',
    // The Simulator owns fingerprinting and regeneration. Blockly binds only
    // the path and never parses or imports the legacy document.
    legacyConnectionGraphFilePath: legacyFilePath,
  };
}

function validateLegacySceneRegenerationRequirement(
  value,
  projectIdentity,
  sceneId,
) {
  const keys = [
    'catalogRevision',
    'draftGraphSemanticRevision',
    'draftVisualRevision',
    'expiresAtUnixMs',
    'kind',
    'legacySourceBytes',
    'legacySourceKind',
    'legacySourceRevision',
    'projectIdentity',
    'regenerationId',
    'sceneId',
    'schemaVersion',
  ];
  if (
    !hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.kind !== 'aily-project-scene-legacy-regeneration-required'
    || !/^regeneration-v1-[a-f0-9]{64}$/.test(value.regenerationId)
    || value.projectIdentity !== projectIdentity
    || value.sceneId !== sceneId
    || value.legacySourceKind !== 'connection-output-v1'
    || !isSha256(value.legacySourceRevision)
    || !Number.isSafeInteger(value.legacySourceBytes)
    || value.legacySourceBytes < 0
    || value.legacySourceBytes > CONNECTION_GRAPH_MAX_BYTES
    || !isSha256(value.catalogRevision)
    || !isSha256(value.draftVisualRevision)
    || !isSha256(value.draftGraphSemanticRevision)
    || !Number.isSafeInteger(value.expiresAtUnixMs)
    || value.expiresAtUnixMs <= 0
  ) {
    throw new Error('Simulator Subapp returned an invalid regeneration requirement.');
  }
  return structuredClone(value);
}

function validateProjectSceneGenerationStartInput(value) {
  const hasRegenerationId = isRecord(value)
    && Object.hasOwn(value, 'regenerationId');
  const hasLaunchId = isRecord(value) && Object.hasOwn(value, 'launchId');
  const hasBase = isRecord(value) && Object.hasOwn(value, 'base');
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => ![
      'base', 'launchId', 'ownerId', 'regenerationId',
    ].includes(key))
    || (hasRegenerationId === hasLaunchId)
    || (hasRegenerationId === hasBase)
    || (
      hasRegenerationId
        ? (
            typeof value.regenerationId !== 'string'
            || !/^regeneration-v1-[a-f0-9]{64}$/.test(value.regenerationId)
          )
        : (
            typeof value.launchId !== 'string'
            || !/^launch-v1-[a-f0-9]{64}$/.test(value.launchId)
            || !hasExactKeys(value.base, [
              'catalogRevision',
              'graphSemanticRevision',
              'visualRevision',
            ])
            || !isSha256(value.base.visualRevision)
            || !isSha256(value.base.graphSemanticRevision)
            || !isSha256(value.base.catalogRevision)
          )
    )
  ) {
    throw new Error('Project Scene generation start request is invalid.');
  }
  return {
    ownerId: normalizeOwnerId(value.ownerId),
    regenerationId: hasRegenerationId ? value.regenerationId : null,
    launchId: hasLaunchId ? value.launchId : null,
    base: hasBase ? structuredClone(value.base) : null,
  };
}

function createLegacySceneGenerationRequest(requirement) {
  if (requirement.legacySourceBytes < 1) {
    throw new Error('Empty legacy connection metadata cannot start Scene generation.');
  }
  const requestDigest = crypto.createHash('sha256')
    .update(JSON.stringify({
      regenerationId: requirement.regenerationId,
      projectIdentity: requirement.projectIdentity,
      sceneId: requirement.sceneId,
      legacySourceRevision: requirement.legacySourceRevision,
      catalogRevision: requirement.catalogRevision,
      draftVisualRevision: requirement.draftVisualRevision,
      draftGraphSemanticRevision: requirement.draftGraphSemanticRevision,
    }))
    .digest('hex');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'aily-project-scene-generation-request',
    requestId: `scene-generation-v1-${requestDigest}`,
    projectIdentity: requirement.projectIdentity,
    sceneId: requirement.sceneId,
    reason: 'legacy-detected',
    base: {
      visualRevision: requirement.draftVisualRevision,
      graphSemanticRevision: requirement.draftGraphSemanticRevision,
      catalogRevision: requirement.catalogRevision,
    },
    legacySource: {
      kind: 'connection-output-v1',
      revision: requirement.legacySourceRevision,
      bytes: requirement.legacySourceBytes,
    },
    expiresAtUnixMs: requirement.expiresAtUnixMs,
  });
}

function createOpenSceneGenerationRequest(active, base, now) {
  const reason = active.initialization === 'created-empty'
    ? 'missing-scene'
    : 'user-regenerate';
  const requestDigest = crypto.createHash('sha256')
    .update(JSON.stringify({
      launchId: active.launchId,
      projectIdentity: active.projectIdentity,
      sceneId: active.sceneId,
      reason,
      base,
    }))
    .digest('hex');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'aily-project-scene-generation-request',
    requestId: `scene-generation-v1-${requestDigest}`,
    projectIdentity: active.projectIdentity,
    sceneId: active.sceneId,
    reason,
    base: structuredClone(base),
    legacySource: null,
    expiresAtUnixMs: now().getTime() + SCENE_GENERATION_REQUEST_TTL_MS,
  });
}

function publicSceneGenerationAccepted(request) {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'aily-simulator-subapp-project-scene-generation-request-result',
    state: 'accepted',
    requestId: request.requestId,
    reason: request.reason,
  });
}

function publicSceneGenerationFailure(error, requestId) {
  return Object.freeze({
    requestId,
    code: typeof error?.code === 'string'
      ? error.code
      : 'SCENE_GENERATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  });
}

function sameSceneGenerationBase(left, right) {
  return left.visualRevision === right.visualRevision
    && left.graphSemanticRevision === right.graphSemanticRevision
    && left.catalogRevision === right.catalogRevision;
}

function validateProjectSceneRegenerationResolutionInput(value) {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => ![
      'ownerId', 'proposal', 'regenerationId', 'resolution',
    ].includes(key))
    || !Object.hasOwn(value, 'regenerationId')
    || !Object.hasOwn(value, 'resolution')
  ) {
    throw new Error('Project Scene regeneration resolution is invalid.');
  }
  const ownerId = normalizeOwnerId(value.ownerId);
  if (
    typeof value.regenerationId !== 'string'
    || !/^regeneration-v1-[a-f0-9]{64}$/.test(value.regenerationId)
    || (value.resolution !== 'cancel' && value.resolution !== 'commit')
    || (value.resolution === 'cancel' && value.proposal !== undefined)
    || (value.resolution === 'commit' && value.proposal === undefined)
  ) {
    throw new Error('Project Scene regeneration resolution is invalid.');
  }
  return {
    ownerId,
    regenerationId: value.regenerationId,
    resolution: value.resolution,
    ...(value.proposal === undefined
      ? {}
      : { proposal: value.proposal }),
  };
}

function validateAgentSceneChangeProposalForHost(
  value,
  projectIdentity,
  sceneId,
) {
  const keys = [
    'agentRunId',
    'base',
    'batch',
    'componentMutations',
    'kind',
    'proposalId',
    'reason',
    'schemaVersion',
    'summary',
    'target',
  ];
  if (
    !hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.kind !== 'aily-agent-scene-change-proposal'
    || !['user-requested-change', 'artifact-rebuild', 'legacy-regeneration']
      .includes(value.reason)
    || typeof value.summary !== 'string'
    || value.summary.length < 1
    || value.summary.length > 1024
    || /[\u0000-\u001f\u007f]/.test(value.summary)
    || !hasExactKeys(value.target, ['projectIdentity', 'sceneId'])
    || value.target.projectIdentity !== projectIdentity
    || value.target.sceneId !== sceneId
    || !hasExactKeys(value.base, [
      'catalogRevision',
      'graphSemanticRevision',
      'visualRevision',
    ])
    || !isSha256(value.base.catalogRevision)
    || !isSha256(value.base.graphSemanticRevision)
    || !isSha256(value.base.visualRevision)
    || !Array.isArray(value.componentMutations)
    || value.componentMutations.length > 64
    || (value.batch !== null && !isRecord(value.batch))
  ) {
    throw new Error('Project Scene Agent proposal is invalid.');
  }
  requirePortableIdentifier(value.proposalId, 'proposalId', 128);
  requirePortableIdentifier(value.agentRunId, 'agentRunId', 128);
  validateJsonNode(
    value,
    0,
    { count: CONNECTION_GRAPH_MAX_NODES },
    'Project Scene Agent proposal',
  );
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > AGENT_SCENE_PROPOSAL_MAX_BYTES) {
    throw new Error('Project Scene Agent proposal exceeds the 256 KiB limit.');
  }
  return JSON.parse(serialized);
}

function validateAgentSceneChangeReceiptForHost(
  value,
  proposal,
  projectIdentity,
  sceneId,
) {
  const keys = [
    'agentRunId',
    'catalogRevision',
    'changedRevisions',
    'commandCount',
    'graphSemanticRevision',
    'kind',
    'policy',
    'proposalId',
    'schemaVersion',
    'status',
    'storageRevision',
    'target',
    'visualRevision',
  ];
  const changed = value?.changedRevisions;
  if (
    !hasExactKeys(value, keys)
    || value.schemaVersion !== 1
    || value.kind !== 'aily-agent-scene-change-receipt'
    || value.status !== 'applied'
    || value.proposalId !== proposal.proposalId
    || value.agentRunId !== proposal.agentRunId
    || !hasExactKeys(value.target, ['projectIdentity', 'sceneId'])
    || value.target.projectIdentity !== projectIdentity
    || value.target.sceneId !== sceneId
    || !isSha256(value.catalogRevision)
    || !isSha256(value.visualRevision)
    || !isSha256(value.graphSemanticRevision)
    || typeof value.storageRevision !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.storageRevision)
    || !hasExactKeys(value.policy, [
      'impact',
      'invalidatesArtifact',
      'mayKeepRunning',
      'requiresSessionRestart',
    ])
    || !['visual', 'semantic', 'runtime'].includes(value.policy.impact)
    || typeof value.policy.invalidatesArtifact !== 'boolean'
    || typeof value.policy.mayKeepRunning !== 'boolean'
    || typeof value.policy.requiresSessionRestart !== 'boolean'
    || !Array.isArray(changed)
    || changed.length > 2
    || new Set(changed).size !== changed.length
    || changed.some((entry) => (
      entry !== 'visualRevision' && entry !== 'graphSemanticRevision'
    ))
    || !Number.isSafeInteger(value.commandCount)
    || value.commandCount < 1
    || value.commandCount > 64
  ) {
    throw new Error('Simulator Subapp returned an invalid Agent proposal receipt.');
  }
  return structuredClone(value);
}

function hasExactKeys(value, expectedKeys) {
  return isRecord(value)
    && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0');
}

function validateConnectionGraph(value) {
  if (!isRecord(value)) {
    throw new Error('Simulator connectionGraph must be a JSON object.');
  }
  const remaining = { count: CONNECTION_GRAPH_MAX_NODES };
  validateJsonNode(value, 0, remaining);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Simulator connectionGraph must be serializable JSON.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > CONNECTION_GRAPH_MAX_BYTES) {
    throw new Error('Simulator connectionGraph exceeds the 4 MiB limit.');
  }
  return value;
}

function readProjectDebugConfiguration(projectRoot) {
  const configurationPath = path.join(
    projectRoot,
    PROJECT_DEBUG_CONFIGURATION_FILE,
  );
  if (!fs.existsSync(configurationPath)) return null;
  const bytes = fs.readFileSync(configurationPath);
  if (bytes.byteLength > PROJECT_DEBUG_CONFIGURATION_MAX_BYTES) {
    throw new Error('Project debug configuration exceeds the 1 MiB limit.');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Project debug configuration is not valid JSON.');
  }
  if (
    !isRecord(value)
    || Object.keys(value).sort().join('\0')
      !== ['breakpoints', 'kind', 'schemaVersion'].join('\0')
    || value.schemaVersion !== 1
    || value.kind !== 'aily-project-debug-configuration'
    || !Array.isArray(value.breakpoints)
    || value.breakpoints.length > 256
  ) {
    throw new Error('Project debug configuration is invalid.');
  }
  const blockIds = new Set();
  for (const breakpoint of value.breakpoints) {
    if (
      !isRecord(breakpoint)
      || Object.keys(breakpoint).sort().join('\0')
        !== ['blockId', 'enabled', 'sourceMapRevision'].join('\0')
      || typeof breakpoint.blockId !== 'string'
      || breakpoint.blockId.length < 1
      || breakpoint.blockId.length > 256
      || /[\u0000-\u001f\u007f]/.test(breakpoint.blockId)
      || blockIds.has(breakpoint.blockId)
      || typeof breakpoint.enabled !== 'boolean'
      || typeof breakpoint.sourceMapRevision !== 'string'
      || !/^[a-f0-9]{64}$/.test(breakpoint.sourceMapRevision)
    ) {
      throw new Error(
        'Project debug configuration contains an invalid breakpoint.',
      );
    }
    blockIds.add(breakpoint.blockId);
  }
  return value;
}

function validateJsonNode(
  value,
  depth,
  remaining,
  label = 'Simulator connectionGraph',
) {
  if (depth > CONNECTION_GRAPH_MAX_DEPTH) {
    throw new Error(`${label} exceeds the nesting limit.`);
  }
  remaining.count -= 1;
  if (remaining.count < 0) {
    throw new Error(`${label} contains too many values.`);
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonNode(item, depth + 1, remaining, label);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (Buffer.byteLength(key, 'utf8') > 8 * 1024) {
        throw new Error(`${label} contains an oversized key.`);
      }
      validateJsonNode(item, depth + 1, remaining, label);
    }
    return;
  }
  throw new Error(`${label} contains a non-JSON value.`);
}

function requireProjectRoot(projectPath) {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    throw new Error('Open a Blockly project before launching the Simulator Subapp.');
  }
  let projectRoot;
  try {
    projectRoot = fs.realpathSync(projectPath);
  } catch {
    throw new Error('The current project directory does not exist.');
  }
  if (!fs.statSync(projectRoot).isDirectory()) {
    throw new Error('The current project path is not a directory.');
  }
  return projectRoot;
}

function requireArtifact(buildDirectory) {
  const manifestPath = path.join(
    buildDirectory,
    'aily-artifact-manifest.json',
  );
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      'Missing .build/aily-artifact-manifest.json. Compile the project with the latest aily-builder first.',
    );
  }
}

function requireHttpOrigin(value) {
  if (typeof value !== 'string') {
    throw new Error('Simulator Subapp requires an explicit HTTP(S) renderer origin.');
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.origin === value
    ) {
      return value;
    }
  } catch {
    // Use the stable public error below.
  }
  throw new Error(
    'Simulator Subapp requires an explicit HTTP(S) renderer origin; opaque file origins are not accepted.',
  );
}

function validateReady(value, rendererOrigin) {
  if (!isRecord(value)) throw new Error('Simulator Subapp ready event is invalid.');
  const expectedKeys = [
    'controlProtocolVersion',
    'controlTransport',
    'kind',
    'mode',
    'origin',
    'pid',
    'port',
    'schemaVersion',
    'service',
    'shellPath',
    'url',
  ];
  if (Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')) {
    throw new Error('Simulator Subapp ready event contains an invalid shape.');
  }
  if (
    value.schemaVersion !== 1
    || value.kind !== 'aily-simulator-subapp-ready'
    || value.mode !== 'serve'
    || value.service !== 'aily-simulator'
    || value.controlProtocolVersion !== CONTROL_SCHEMA_VERSION
    || value.controlTransport !== 'parent-ipc'
    || value.shellPath !== '/subapp'
    || !Number.isInteger(value.port)
    || value.port <= 0
    || value.port > 65_535
    || !Number.isInteger(value.pid)
    || value.pid <= 0
  ) {
    throw new Error('Simulator Subapp ready event is incompatible.');
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error('Simulator Subapp returned an invalid local URL.');
  }
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.port !== String(value.port)
    || url.origin !== value.origin
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('Simulator Subapp did not bind a valid loopback URL.');
  }
  requireHttpOrigin(rendererOrigin);
  return {
    url: url.origin,
    origin: url.origin,
    shellPath: value.shellPath,
  };
}

function requireSuccess(response, operation) {
  if (
    !isRecord(response)
    || response.kind !== 'aily-simulator-subapp-control-success'
    || response.schemaVersion !== CONTROL_SCHEMA_VERSION
    || response.operation !== operation
  ) {
    throw new Error(`Simulator Subapp returned an invalid ${operation} response.`);
  }
}

function publicSession(value, expectedSessionId) {
  if (
    !isRecord(value)
    || value.sessionId !== expectedSessionId
    || ![
      'idle',
      'preflighting',
      'ready',
      'starting',
      'running',
      'paused',
      'stopping',
      'stopped',
      'crashed',
      'unsupported',
    ].includes(value.state)
    || !(value.sceneRevision === null || typeof value.sceneRevision === 'string')
  ) {
    throw new Error('Simulator Subapp returned an invalid redacted session.');
  }
  return {
    sessionId: expectedSessionId,
    state: value.state,
    sceneRevision: value.sceneRevision,
  };
}

function requireArtifactHandle(value) {
  if (typeof value !== 'string' || !/^artifact-v1-[a-f0-9]{64}$/.test(value)) {
    throw new Error('Simulator Subapp returned an invalid artifact handle.');
  }
  return value;
}

function validateSceneArtifactRebuildRequest(value) {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join('\0') !== [
      'action',
      'artifactRevision',
      'baseSceneRevision',
      'kind',
      'projectIdentity',
      'reason',
      'requestId',
      'sceneDocument',
      'sceneId',
      'sceneRevision',
      'schemaVersion',
      'sessionId',
    ].join('\0')
    || value.schemaVersion !== REBUILD_SCHEMA_VERSION
    || value.kind !== 'aily-scene-artifact-rebuild-request'
    || value.action !== 'reconcile-and-build'
    || value.reason !== 'graph-semantic-changed'
    || typeof value.requestId !== 'string'
    || !/^rebuild-v1-[a-f0-9]{64}$/.test(value.requestId)
    || typeof value.sessionId !== 'string'
    || !/^[A-Za-z0-9._-]{1,64}$/.test(value.sessionId)
    || !isSha256(value.baseSceneRevision)
    || !isSha256(value.sceneRevision)
    || value.baseSceneRevision === value.sceneRevision
    || !isSha256(value.artifactRevision)
  ) {
    throw new Error('Invalid Scene Artifact rebuild request.');
  }
  requirePortableIdentifier(value.projectIdentity, 'projectIdentity', 128);
  requirePortableIdentifier(value.sceneId, 'sceneId', 128);
  validateSceneEditorDocumentScope(
    value.sceneDocument,
    value.sceneId,
    value.sceneRevision,
  );
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > CONNECTION_GRAPH_MAX_BYTES) {
    throw new Error('Scene Artifact rebuild request is too large.');
  }
  return structuredClone(value);
}

function validateSceneEditorDocumentScope(value, sceneId, sceneRevision) {
  const requiredKeys = [
    'componentConfigs',
    'components',
    'extensions',
    'graphSemanticRevision',
    'kind',
    'presentation',
    'sceneId',
    'schemaVersion',
    'visualRevision',
    'wires',
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    'description',
    'legacyVersion',
  ]);
  if (
    !isRecord(value)
    || !requiredKeys.every((key) => Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.schemaVersion !== 1
    || value.kind !== 'aily-scene-editor-document'
    || value.sceneId !== sceneId
    || value.graphSemanticRevision !== sceneRevision
    || !isSha256(value.visualRevision)
    || !isRecord(value.componentConfigs)
    || !Array.isArray(value.components)
    || !Array.isArray(value.wires)
    || !isRecord(value.presentation)
    || !isRecord(value.extensions)
    || (
      value.description !== undefined
      && typeof value.description !== 'string'
    )
    || (
      value.legacyVersion !== undefined
      && typeof value.legacyVersion !== 'string'
      && typeof value.legacyVersion !== 'number'
    )
  ) {
    throw new Error('Invalid Scene Artifact rebuild document.');
  }
}

function createRebuildAck(request, status, errorCode) {
  return {
    schemaVersion: REBUILD_SCHEMA_VERSION,
    kind: 'aily-scene-artifact-rebuild-ack',
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sessionId: request.sessionId,
    sceneId: request.sceneId,
    status,
    errorCode,
  };
}

function validateSceneArtifactReplacementRequest(value) {
  if (
    !isRecord(value)
    || Object.keys(value).sort().join('\0') !== [
      'artifactHandle',
      'baseArtifactRevision',
      'baseSceneRevision',
      'candidateArtifactRevision',
      'expectedSceneRevision',
      'kind',
      'projectIdentity',
      'replacementId',
      'requestId',
      'sceneId',
      'schemaVersion',
      'sessionId',
    ].join('\0')
    || value.schemaVersion !== REBUILD_SCHEMA_VERSION
    || value.kind !== 'aily-scene-artifact-replacement-request'
    || !/^rebuild-v1-[a-f0-9]{64}$/.test(value.requestId)
    || !/^replacement-v1-[a-f0-9]{64}$/.test(value.replacementId)
    || !/^[A-Za-z0-9._-]{1,64}$/.test(value.sessionId)
    || !isSha256(value.baseSceneRevision)
    || !isSha256(value.expectedSceneRevision)
    || value.baseSceneRevision === value.expectedSceneRevision
    || !isSha256(value.baseArtifactRevision)
    || !/^artifact-v1-[a-f0-9]{64}$/.test(value.artifactHandle)
    || !isSha256(value.candidateArtifactRevision)
  ) {
    throw new Error('Invalid Scene Artifact replacement request.');
  }
  requirePortableIdentifier(value.projectIdentity, 'projectIdentity', 128);
  requirePortableIdentifier(value.sceneId, 'sceneId', 128);
  return structuredClone(value);
}

function validateSceneArtifactReplacementResult(value) {
  const failures = new Set([
    'request-superseded',
    'artifact-unavailable',
    'artifact-integrity-failed',
    'artifact-incompatible',
    'scene-compile-failed',
    'session-stop-failed',
    'session-create-failed',
    'commit-failed',
  ]);
  if (
    !isRecord(value)
    || Object.keys(value).sort().join('\0') !== [
      'artifactRevision',
      'errorCode',
      'kind',
      'previousArtifactRevision',
      'replacementId',
      'requestId',
      'sceneId',
      'sceneRevision',
      'schemaVersion',
      'sessionId',
      'status',
    ].join('\0')
    || value.schemaVersion !== REBUILD_SCHEMA_VERSION
    || value.kind !== 'aily-scene-artifact-replacement-result'
    || !/^rebuild-v1-[a-f0-9]{64}$/.test(value.requestId)
    || !/^replacement-v1-[a-f0-9]{64}$/.test(value.replacementId)
    || !/^[A-Za-z0-9._-]{1,64}$/.test(value.sessionId)
    || !isSha256(value.sceneRevision)
    || !isSha256(value.previousArtifactRevision)
    || !isSha256(value.artifactRevision)
    || (
      value.status === 'committed'
        ? value.errorCode !== null
        : value.status !== 'rejected'
          || !failures.has(value.errorCode)
          || value.artifactRevision !== value.previousArtifactRevision
    )
  ) {
    throw new Error('Invalid Scene Artifact replacement result.');
  }
  requirePortableIdentifier(value.sceneId, 'sceneId', 128);
  return structuredClone(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requireLaunchId(value) {
  if (typeof value !== 'string' || !/^launch-v1-[a-f0-9]{64}$/.test(value)) {
    throw new Error('Simulator Subapp returned an invalid launch id.');
  }
  return value;
}

function requirePortableIdentifier(value, label, maximumLength) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error(`${label} must be a portable identifier.`);
  }
  return value;
}

function normalizeOwnerId(value) {
  if (value === undefined || value === null || value === '') return null;
  return requirePortableIdentifier(value, 'ownerId', 128);
}

function createProjectIdentity(projectRoot) {
  const digest = crypto
    .createHash('sha256')
    .update(projectRoot)
    .digest('hex');
  return `project-v1-${digest}`;
}

function createLaunchRevision(buildDirectory, input) {
  const manifestPath = path.join(
    buildDirectory,
    'aily-artifact-manifest.json',
  );
  const projectDebugConfigurationPath = path.join(
    path.dirname(buildDirectory),
    PROJECT_DEBUG_CONFIGURATION_FILE,
  );
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(manifestPath))
    .update('\0')
    .update(input.tool)
    .update('\0')
    .update(input.sceneId)
    .update('\0')
    .update(JSON.stringify(input.connectionGraph))
    .update('\0')
    .update(
      fs.existsSync(projectDebugConfigurationPath)
        ? fs.readFileSync(projectDebugConfigurationPath)
        : Buffer.alloc(0),
    )
    .digest('hex');
}

function createProjectSceneLaunchRevision(input) {
  return crypto
    .createHash('sha256')
    .update('project-scene-v1')
    .update('\0')
    .update(input.sceneId)
    .digest('hex');
}

function publicRuntime(runtime) {
  return {
    runtimeSource: typeof runtime.source === 'string' ? runtime.source : 'unknown',
    runtimePackId: typeof runtime.runtimePackId === 'string'
      ? runtime.runtimePackId
      : null,
    runtimeMode: typeof runtime.runtimeMode === 'string'
      ? runtime.runtimeMode
      : null,
  };
}

function createFailure(phase, error, target, now, stdoutTail, stderrTail) {
  return {
    phase,
    message: safeErrorMessage(error),
    code: target?.exitCode ?? null,
    signal: target?.signalCode ?? null,
    stdoutTail,
    stderrTail,
    occurredAt: now().toISOString(),
  };
}

function publicFailure(failure) {
  return {
    phase: failure.phase,
    message: failure.message,
    code: failure.code,
    signal: failure.signal,
    occurredAt: failure.occurredAt,
  };
}

function safeErrorMessage(error) {
  if (!(error instanceof Error)) return 'Simulator Subapp failed.';
  const message = error.message.trim();
  return message && message.length <= 1_024
    ? message
    : 'Simulator Subapp failed.';
}

function appendTail(current, text) {
  const next = current + text;
  return next.length <= DIAGNOSTIC_TAIL_BYTES
    ? next
    : next.slice(next.length - DIAGNOSTIC_TAIL_BYTES);
}

function hasChildExited(target) {
  return target.exitCode !== null || target.signalCode !== null;
}

function firstExistingPath(candidates) {
  return candidates.find(
    (candidate) => typeof candidate === 'string'
      && candidate.length > 0
      && fs.existsSync(candidate)
      && fs.statSync(candidate).isFile(),
  ) || null;
}

function firstExistingDirectory(candidates) {
  return candidates.find(
    (candidate) => typeof candidate === 'string'
      && candidate.length > 0
      && fs.existsSync(candidate)
      && fs.statSync(candidate).isDirectory(),
  ) || null;
}

function resolveOptionalBundlePath(root, value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (
    relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  throw new Error('Simulator Runtime Manifest entrypoint escapes its root.');
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveTimeout(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? value : fallback;
}

const defaultHost = createSimulatorSubappHost({
  onStateChanged(payload) {
    sendStateChanged(defaultMainWindow, payload);
  },
});
let defaultMainWindow = () => null;

function registerHandlers({ ipcMain, app, mainWindow, host = defaultHost }) {
  defaultMainWindow = mainWindow || defaultMainWindow;
  if (registeredIpcMains.has(ipcMain)) return;
  registeredIpcMains.add(ipcMain);

  ipcMain.handle('simulator-subapp-open', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.open({
      ...payload,
      app,
      rendererOrigin: originFromSenderUrl(event.senderFrame?.url),
    });
  });
  ipcMain.handle('simulator-subapp-open-project-scene', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.openProjectScene({
      ...payload,
      app,
      rendererOrigin: originFromSenderUrl(event.senderFrame?.url),
    });
  });
  ipcMain.handle('simulator-subapp-request-project-scene-generation', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.requestProjectSceneGeneration(payload);
  });
  ipcMain.handle('simulator-subapp-resolve-project-scene-regeneration', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.resolveProjectSceneRegeneration(payload);
  });
  ipcMain.handle('simulator-subapp-apply-project-scene-agent-proposal', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.applyProjectSceneAgentProposal(payload);
  });
  ipcMain.handle('simulator-subapp-attach-project-scene-session', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.attachProjectSceneSession(payload);
  });
  ipcMain.handle('simulator-subapp-detach-project-scene-session', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.detachProjectSceneSession(payload);
  });
  ipcMain.handle('simulator-subapp-status', async (event) => {
    requireTrustedSender(event, mainWindow);
    return host.status();
  });
  ipcMain.handle('simulator-subapp-close', async (event, payload) => {
    requireTrustedSender(event, mainWindow);
    return host.close(payload);
  });
}

function requireTrustedSender(event, getMainWindow) {
  const window = getMainWindow?.();
  if (
    !window
    || window.isDestroyed()
    || window.webContents?.isDestroyed()
    || event.sender !== window.webContents
  ) {
    throw new Error('Simulator Subapp IPC sender is not trusted.');
  }
}

function sendStateChanged(getMainWindow, payload) {
  const window = getMainWindow?.();
  if (!window || window.isDestroyed() || window.webContents?.isDestroyed()) return;
  window.webContents.send('simulator-subapp-state-changed', payload);
}

module.exports = {
  CONNECTION_GRAPH_MAX_BYTES,
  CONTROL_REQUEST_TYPE,
  CONTROL_RESPONSE_TYPE,
  CONTROL_SCHEMA_VERSION,
  REBUILD_ACK_TYPE,
  REBUILD_REQUEST_TYPE,
  REBUILD_SCHEMA_VERSION,
  REPLACEMENT_REQUEST_TYPE,
  REPLACEMENT_RESULT_TYPE,
  SHUTDOWN_MESSAGE,
  createChildArguments,
  createLaunchRevision,
  createProjectIdentity,
  createSimulatorSubappHost,
  defaultHost,
  hasChildExited,
  registerHandlers,
  requireHttpOrigin,
  resolveSimulatorSubappRuntime,
  validateConnectionGraph,
  validateSceneArtifactRebuildRequest,
  validateSceneArtifactReplacementRequest,
  validateSceneArtifactReplacementResult,
  validateReady,
};
