'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  bridgeFixture,
  mainRouteFixture,
  mainRequestFixture,
  readPureModule,
} = require('./fixtures/bootstrap-host-source.cjs');
const snapshot = (sourceProject = null, rendererGeneration = 7) => ({
  version: 1,
  sourceProject,
  rendererGeneration,
});

function navigationFixture() {
  const source = path.resolve('fixtures/navigation-source'), target = path.resolve('fixtures/navigation-target');
  const f = bridgeFixture(source), { domain, bridge, window } = f;
  let current = source, revision = 0;
  Object.defineProperties(domain, {
    currentProjectPath: { get: () => current, set: project => { current = project; revision++; } },
    projectViewRevision: { get: () => revision },
  });
  const identities = new Map([[source, '1'], [target, '2']]);
  window.fs = { captureProjectAttachment: root => ({ version: 1, root,
    identity: { dev: '1', ino: identities.get(root), birthtimeNs: '1' } }) };
  bridge.electronService.exists = () => true;
  bridge.electronService.pathJoin = path.join;
  bridge.configService.init = async () => undefined;
  bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
  bridge.executeProjectOpen = f.originalMethods.executeProjectOpen;
  bridge.executeProjectClose = f.originalMethods.executeProjectClose;
  domain.getBlocklyProjectLoadStatus = () => ({ ready: true, state: 'loaded' });
  const request = (operation, sourceProject, targetProject) =>
    ({ version: 1, requestId: randomUUID(), rendererGeneration: f.generation, deadlineAt: Date.now() + 100_000,
      operation, sourceProject, targetProject });
  const send = (original, reopenFrom) => bridge.executeOperation({ operation: original.operation,
    path: original.targetProject ?? original.sourceProject, rendererGeneration: f.generation,
    lifecycle: snapshot(original.sourceProject), params: { navigationRequest: original, ...(reopenFrom ? { reopenFrom } : {}) } });
  const observe = (original) => bridge.executeOperation({ operation: 'project_navigation_status',
    rendererGeneration: f.generation, params: { navigationRequest: original } });
  return { ...f, source, target, identities, request, send, observe };
}

test('a fresh open from the blank view accepts only the exact recovered source proof', async () => {
  const f = navigationFixture(), sessionId = randomUUID();
  const original = f.request('project_open', f.source, f.target);
  const proof = { version: 1, originalTargetPid: 41000, originalInstanceId: randomUUID(), sessionId, navigationRequest: original };
  f.domain.currentProjectPath = '';
  let opens = 0, approved = false;
  f.window.projectLock = { canReopenNavigation: async (received, target) => {
    assert.equal(received, proof);
    assert.equal(target, f.source);
    return approved;
  } };
  f.domain.projectOpen = async (target, options) => {
    opens++;
    f.domain.currentProjectPath = target;
    await options.onViewActivated(target, f.domain.projectViewRevision);
    return true;
  };
  const send = (target, navigationSessionId = sessionId) => f.bridge.executeOperation({ operation: 'project_open',
    path: target, rendererGeneration: f.generation, lifecycle: snapshot(null),
    params: { navigationRequest: f.request('project_open', null, target), navigationSessionId, reopenProof: proof } });
  assert.equal((await send(f.target)).code, 'PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID');
  assert.equal((await send(f.source, randomUUID())).code, 'PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID');
  assert.equal((await send(f.source)).code, 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED');
  assert.equal(opens, 0);
  approved = true;
  const reopened = await send(f.source);
  assert.equal(reopened.activationCurrent, true);
  assert.equal(reopened.navigationReceipt.state, 'completed');
  assert.equal(opens, 1);
});

test('ordinary open reports exact activation before editor readiness, then retains it after load failure and lost reply', async () => {
  const f = navigationFixture(), id = f.request('project_open', f.source, f.target);
  let opened = 0, markStarted, finish;
  const started = new Promise(resolve => { markStarted = resolve; });
  const loaded = new Promise(resolve => { finish = resolve; });
  f.domain.projectOpen = async (target, options) => {
    opened++;
    f.domain.currentProjectPath = target;
    options.onViewActivated(target, f.domain.projectViewRevision);
    markStarted();
    return loaded;
  };
  f.domain.getBlocklyProjectLoadStatus = () => ({ ready: false, state: 'error', error: 'Editor initialization failed' });
  const start = f.send(id);
  await started;
  const pending = await f.observe(id);
  assert.equal(pending.navigationReceipt.state, 'pending');
  assert.equal(pending.navigationReceipt.activation.state, 'open');
  assert.equal(pending.navigationReceipt.activation.attachment.identity.ino, '2');
  assert.equal(pending.activationCurrent, true);
  finish(false);
  // Discard the original response as if its HTTP acknowledgement was lost.
  await start;
  const recovered = await f.observe(id);
  assert.equal(recovered.navigationReceipt.state, 'failed');
  assert.equal(recovered.result.reason, 'project_load_failed');
  assert.equal(recovered.result.loadStatus.ready, false);
  assert.equal(recovered.result.nextAction.input.action, 'inspect');
  assert.equal(recovered.activationCurrent, true);
  assert.equal((await f.send(id)).navigationReceipt.state, 'failed');
  assert.equal(opened, 1);
  f.domain.currentProjectPath = f.source;
  f.domain.currentProjectPath = f.target;
  assert.equal((await f.observe(id)).activationCurrent, false);
  assert.equal((await f.observe({ ...id, targetProject: f.source })).navigationReceipt.state, 'unknown');
});

test('ordinary close authorizes only reopening the physically identical project in the same empty view', async () => {
  const f = navigationFixture(), closed = f.request('project_close', f.source, null);
  let openCalls = 0, closeCalls = 0;
  f.domain.close = async options => {
    closeCalls++;
    f.domain.currentProjectPath = '';
    options.onViewActivated(null, f.domain.projectViewRevision);
    return true;
  };
  f.domain.projectOpen = async (target, options) => {
    openCalls++;
    f.domain.currentProjectPath = target;
    options.onViewActivated(target, f.domain.projectViewRevision);
    return true;
  };
  await f.send(closed);
  const status = await f.observe(closed);
  assert.equal(status.navigationReceipt.activation.state, 'closed');
  assert.equal(status.navigationReceipt.sourceAttachment.identity.ino, '1');
  assert.equal(status.result.project, null);
  assert.equal(status.activationCurrent, true);
  assert.equal((await f.send(closed)).ok, true);
  assert.equal(closeCalls, 1);
  assert.equal((await f.send(f.request('project_open', null, f.target), closed)).code, 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED');
  f.identities.set(f.source, '19');
  assert.equal((await f.observe(closed)).activationCurrent, false);
  assert.equal((await f.send(f.request('project_open', null, f.source), closed)).code, 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED');
  f.identities.set(f.source, '1');
  const reopened = await f.send(f.request('project_open', null, f.source), closed);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.navigationReceipt.activation.project, f.source);
  assert.equal(openCalls, 1);
  f.domain.currentProjectPath = '';
  assert.equal((await f.send(f.request('project_open', null, f.source), closed)).code, 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED');
  assert.equal(openCalls, 1);
});

test('Main forwards the original navigation status without substituting the active project', async () => {
  const f = mainRouteFixture(path.resolve('fixtures/another-project'));
  const request = navigationFixture().request('project_close', path.resolve('fixtures/navigation-source'), null);
  const reply = await f.handleCliBridgeCommand('blockly-live-operation', { operation: 'project_navigation_status',
    params: { navigationRequest: request } });
  assert.equal(reply.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].path, '');
  assert.equal(f.calls[0].params.navigationRequest, request);
  assert.equal(f.calls[0].lifecycle, undefined);
});

test('an activated failed view reports its static workspace protocol without preparing or publishing', async () => {
  const project = path.resolve('fixtures/activated-failed-project');
  const reads = [];
  const f = bridgeFixture(project, 7, {
    rejectAbsLiveRequest: () => null,
    absWorkspaceProtocol: async (scope, params, guard) => {
      guard();
      reads.push([scope, Object.keys(params)]);
      return { ok: true, operation: 'abs_protocol', project: scope, protocol: { version: 1, workspaceMode: 'overlay-v1' } };
    },
  });
  f.domain.captureCurrentProjectGuard = () => () => f.domain.currentProjectPath === project;
  f.domain.getBlocklyProjectLoadStatus = () => ({ ready: false, state: 'error', error: 'Editor initialization failed' });
  f.domain.isProjectTransitionInProgress = () => true;
  f.bridge.absGenerationTools = { workspaceMigration: () => assert.fail('would enter the workspace preparer') };
  f.bridge.aiOperations = { setActive: () => assert.fail('would acquire an editor mutation mask') };
  const payload = { operation: 'abs_protocol', path: project, params: { version: 1, action: 'prepare_workspace_migration' } };
  const result = await f.bridge.executeAdmittedOperation(payload);
  assert.equal(result.ok, true);
  assert.equal(result.protocol.workspaceMode, 'overlay-v1');
  assert.equal(result.migrationDeferred.reason, 'editor-not-ready');
  assert.deepEqual(reads, [[project, ['version']]]);
  const wrongScope = await f.bridge.executeAdmittedOperation({ ...payload, path: path.join(project, 'different') });
  assert.equal(wrongScope.code, 'PROJECT_ADMISSION_CONTEXT_STALE');
  assert.equal(reads.length, 1);
});

test('idle app_info advertises lifecycle admission separately from project-bound ABS protocol', async () => {
  const f = bridgeFixture();
  const info = await f.bridge.executeAppInfo();
  assert.equal(info.capabilities.projectLifecycle, 1);
  assert.equal(info.lifecycle.version, 1);
  assert.equal(info.lifecycle.sourceProject, null);
  const protocol = await f.bridge.executeOperation({
    operation: 'abs_protocol',
    path: '/unopened',
    params: { version: 1 },
  });
  assert.equal(
    protocol.ok,
    false,
    'app-level lifecycle support cannot grant a nonexistent project protocol',
  );
  assert.equal(f.calls.length, 0);
});

for (const operation of ['project_create', 'project_open', 'project_close', 'project_reload'])
  test(`${operation} refuses null-to-occupied source change before dispatch`, async () => {
    const f = bridgeFixture('/other');
    let result;
    try {
      result = await f.bridge.executeOperation({
        operation,
        path: '/other',
        params: {},
        rendererGeneration: 7,
        lifecycle: snapshot(),
      });
    } catch (error) {
      result = { code: error.code };
    }
    assert.equal(f.calls.length, 0);
    assert.equal(result.code, 'PROJECT_LIFECYCLE_CONTEXT_CHANGED');
    assert.equal(
      f.domain.projectLifecycle.hasActive('/other'),
      false,
      'failed admission always releases the existing lease',
    );
  });

test('same source path cannot reuse a snapshot after renderer reconnect', async () => {
  const f = bridgeFixture('/source', 8);
  await assert.rejects(
    f.bridge.executeOperation({
      operation: 'project_create',
      params: {},
      rendererGeneration: 8,
      lifecycle: snapshot('/source', 7),
    }),
    { code: 'PROJECT_LIFECYCLE_CONTEXT_CHANGED' },
  );
  assert.equal(f.calls.length, 0);
});

test('the original global lifecycle owner can reenter a concrete target; a different owner remains blocked', () => {
  const { ProjectLifecycleGate } = readPureModule(
    'src/app/services/domains/project/project-lifecycle-gate.ts',
  );
  const gate = new ProjectLifecycleGate(),
    outer = gate.acquire(['*']);
  try {
    const inner = gate.acquire(['/target'], outer.token);
    inner.release();
    assert.throws(() => gate.acquire(['/target']), { code: 'PROJECT_OPERATION_BUSY' });
  } finally {
    outer.release();
  }
  const next = gate.acquire(['/target']);
  next.release();
});

for (const [name, action, payload, source] of [
  ['create', 'blockly-live-operation', { operation: 'project_create', params: {} }, null],
  [
    'project_open',
    'blockly-live-operation',
    { operation: 'project_open', path: '/target', params: {} },
    null,
  ],
  ['app_open', 'open', { path: '/target' }, null],
  ['close', 'close', {}, '/source'],
  ['reload', 'reload', { path: '/source' }, '/source'],
])
  test(`Main ${name} forwards the exact opt-in snapshot through the existing route`, async () => {
    const f = mainRouteFixture(source),
      lifecycle = snapshot(source);
    await f.handleCliBridgeCommand(action, { ...payload, lifecycle });
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(f.calls[0].lifecycle), JSON.stringify(lifecycle));
  });

test('Main rejects an old renderer snapshot at actual dispatch rather than relabeling it with the new generation', async () => {
  const f = mainRequestFixture(8);
  const result = await f.requestMainWindow(
    'request',
    'response',
    { lifecycle: snapshot('/source', 7) },
    100,
  );
  assert.equal(result.code, 'PROJECT_LIFECYCLE_CONTEXT_CHANGED');
  assert.equal(f.sent.length, 0);
});

test('cancellation before Main dispatch sends no lifecycle business request', async () => {
  const f = mainRequestFixture();
  const result = await f.requestMainWindow(
    'request',
    'response',
    { lifecycle: snapshot() },
    100,
    AbortSignal.abort(),
  );
  assert.equal(result.errorCode, 'RENDERER_REQUEST_CANCELLED');
  assert.equal(f.sent.length, 0);
});

test('Main assigns create navigation only at actual current-generation dispatch', async () => {
  const create = mainRequestFixture(8), actual = [];
  const dispatch = (generation) => {
    assert.equal(create.sent.length, 0, 'the main process owns the claim before renderer execution');
    actual.push(generation);
  };
  const send = (generation, signal) => create.requestMainWindow('request', 'response', {
    operation: 'project_create', lifecycle: snapshot('/source', generation),
  }, 100, signal, undefined, dispatch);
  assert.equal((await send(7)).code, 'PROJECT_LIFECYCLE_CONTEXT_CHANGED');
  assert.equal((await send(8, AbortSignal.abort())).errorCode, 'RENDERER_REQUEST_CANCELLED');
  assert.deepEqual(actual, []);
  assert.equal((await send(8)).ok, true);
  assert.deepEqual(actual, [8]);
});

test('timed-out library preparation releases that request on its original renderer generation', async () => {
  const project = path.resolve('fixtures/library-preparation');
  const requestId = 'env1-baf84ee4-c9c0-4e8d-83d9-c4b20bc425e6';
  const f = mainRouteFixture(project, async (_channel, _response, sent, _budget, _signal, onDispatchedTimeout) => {
    if (sent.operation === 'library_mutation_abort') return { ok: true };
    assert.equal(sent.operation, 'library_mutation_prepare');
    await onDispatchedTimeout(7);
    return { ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' };
  });
  const result = await f.handleCliBridgeCommand('blockly-live-operation', {
    path: project, operation: 'library_mutation_prepare', params: { requestId },
  });
  assert.equal(result.errorCode, 'RENDERER_RESPONSE_TIMEOUT');
  assert.deepEqual(f.calls.map(call => call.operation), ['library_mutation_prepare', 'library_mutation_abort']);
  assert.equal(f.calls[1].path, project);
  assert.equal(f.calls[1].params.requestId, requestId);
  assert.equal(f.calls[1].lifecycle.rendererGeneration, 7);
});

test('idle create prepares once and activates directly with the same admitted owner', async () => {
  const f = bridgeFixture();
  f.bridge.executeProjectCreate = f.originalMethods.executeProjectCreate;
  f.bridge.normalizeAilyBoardPackageName = (value) => value;
  f.bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
  f.domain.createDefaultNewProjectData = async () => ({
    path: '/projects',
    name: 'weather',
    board: {},
  });
  let prepared = 0,
    opened = 0;
  f.domain.projectNewWithResult = async (_data, options) => {
    prepared++;
    assert.equal(
      options.deferActivation,
      true,
      'creation must not IPC-serialize or replace the original lease owner',
    );
    assert.equal(f.domain.projectLifecycle.hasActive('/projects/weather'), true);
    return { ok: true, projectPath: path.join('/projects', 'weather') };
  };
  const projectOpen = f.domain.projectOpen.bind(f.domain);
  f.domain.projectOpen = async (target, options) => {
    opened++;
    assert.equal(typeof options.lifecycleOwner, 'symbol');
    assert.equal(options.interactive, false);
    return projectOpen(target, options);
  };
  f.domain.projectOpenInternal = async (target) => {
    f.domain.currentProjectPath = target;
    return true;
  };
  const result = await f.bridge.executeOperation({
    operation: 'project_create',
    params: { boardName: '@aily-project/board-test' },
    rendererGeneration: 7,
    lifecycle: snapshot(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.project, path.join('/projects', 'weather'));
  assert.equal(prepared, 1);
  assert.equal(opened, 1);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});

test('an admitted late operation retains its lease until completion and releases it on failure', async () => {
  const f = bridgeFixture();
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.bridge.executeProjectCreate = async (_params, owner) => {
    entered();
    await barrier;
    const nested = f.domain.projectLifecycle.acquire(['/late-target'], owner);
    nested.release();
    throw new Error('controlled business failure after admission');
  };
  const running = f.bridge.executeOperation({
    operation: 'project_create',
    params: {},
    rendererGeneration: 7,
    lifecycle: snapshot(),
  });
  await started;
  assert.throws(() => f.domain.projectLifecycle.acquire(['/unrelated']), {
    code: 'PROJECT_OPERATION_BUSY',
  });
  assert.equal(f.domain.projectLifecycle.owners.size, 1);
  release();
  await assert.rejects(running, /controlled business failure/);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
  const next = f.domain.projectLifecycle.acquire(['/unrelated']);
  next.release();
});

test('legacy route without an opt-in snapshot keeps its existing payload and admission', async () => {
  const route = mainRouteFixture(null);
  await route.handleCliBridgeCommand('blockly-live-operation', {
    operation: 'project_create',
    params: {},
  });
  assert.equal(Object.hasOwn(route.calls[0], 'lifecycle'), false);
  const f = bridgeFixture();
  assert.equal(
    (await f.bridge.executeOperation({ operation: 'project_create', params: {} })).ok,
    true,
  );
  assert.equal(f.calls.length, 1);
});

for (const failure of ['false', 'throw']) {
  test(`created project retains its exact path when activation returns ${failure}`, async () => {
    const f = bridgeFixture();
    f.bridge.executeProjectCreate = f.originalMethods.executeProjectCreate;
    f.bridge.normalizeAilyBoardPackageName = (value) => value;
    f.bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
    f.domain.createDefaultNewProjectData = async () => ({
      path: '/projects',
      name: 'retained',
      board: {},
    });
    let creations = 0,
      activations = 0;
    f.domain.projectNewWithResult = async () => {
      creations++;
      return { ok: true, projectPath: path.join('/projects', 'retained') };
    };
    f.domain.projectOpen = async () => {
      activations++;
      if (failure === 'throw')
        throw Object.assign(new Error('original loader failure'), {
          code: 'ORIGINAL_LOADER_ERROR',
        });
      return false;
    };
    const result = await f.bridge.executeOperation({
      operation: 'project_create',
      params: { boardName: '@aily-project/board-test' },
      rendererGeneration: 7,
      lifecycle: snapshot(),
    });
    const target = path.join('/projects', 'retained');
    assert.equal(result.ok, false);
    assert.equal(result.projectCreated, true);
    assert.equal(result.createdProject, target);
    assert.equal(
      result.project,
      target,
      'a known created root must not become an unknown/null project',
    );
    assert.equal(result.activation.completed, false);
    assert.equal(result.activation.currentProject, null);
    assert.equal(
      result.code,
      failure === 'throw' ? 'ORIGINAL_LOADER_ERROR' : 'PROJECT_CREATE_ACTIVATION_FAILED',
    );
    if (failure === 'throw') assert.equal(result.message, 'original loader failure');
    assert.equal(creations, 1);
    assert.equal(activations, 1);
    assert.equal(f.domain.projectLifecycle.owners.size, 0);
  });
}

test('expired original creation releases pre-activation ownership and cannot take over after the next request', async () => {
  const { randomUUID } = require('node:crypto');
  const f = bridgeFixture();
  f.bridge.executeProjectCreate = f.originalMethods.executeProjectCreate;
  f.bridge.normalizeAilyBoardPackageName = (value) => value;
  f.bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
  f.domain.createDefaultNewProjectData = async (_board, requested) => ({ path: '/projects', name: requested.name, board: {} });
  const copied = [], activated = [];
  let notifyCopy, continueCopy;
  const firstCopied = new Promise(resolve => { notifyCopy = resolve; });
  const preparation = new Promise(resolve => { continueCopy = resolve; });
  f.domain.projectNewWithResult = async (data, options) => {
    const target = path.join(data.path, data.name);
    options.createAuthority.assertCurrent();
    copied.push(target);
    options.createAuthority.markCreated(target);
    return { ok: true, projectPath: target };
  };
  f.domain.projectOpenInternal = async (target, options) => {
    if (target.endsWith('first')) { notifyCopy(); await preparation; }
    options.createActivation.assertCurrent();
    options.createActivation.markActivated();
    f.domain.currentProjectPath = target;
    activated.push(target);
    return true;
  };
  const request = (deadlineAt) => ({ version: 1, requestId: randomUUID(), rendererGeneration: 7, deadlineAt });
  function call(operation, createRequest, target) {
    return f.bridge.executeOperation({ operation, rendererGeneration: 7, lifecycle: snapshot(), params: {
      createRequest, ...(target ? { name: target, boardName: '@aily-project/board-test' } : {})
    } });
  }
  const old = request(Date.now() + 45);
  const first = call('project_create', old, 'first');
  await firstCopied;
  assert.ok(f.domain.projectLifecycle.owners.size > 0);
  assert.equal((await first).createReceipt.state, 'cancelled');
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
  const next = request(Date.now() + 10_000);
  const second = await call('project_create', next, 'second');
  assert.equal(second.createReceipt.state, 'completed');
  continueCopy();
  await new Promise(resolve => setImmediate(resolve));
  const prior = await call('project_create_status', old);
  assert.equal(prior.createReceipt.createdProject, copied[0]);
  assert.equal(prior.activationCurrent, false);
  const observation = await call('project_create_cancel', next);
  assert.equal(observation.activationCurrent, true);
  assert.equal(observation.projectType, 'blockly');
  assert.equal((await call('project_create', next, 'altered')).code, 'PROJECT_CREATE_REQUEST_REUSED');
  assert.deepEqual(activated, [copied[1]]);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});

for (const source of ['', '/active']) test(`stopping a create during linked environment preparation releases admission (source=${source || 'empty'})`, async () => {
  const { randomUUID } = require('node:crypto');
  const f = bridgeFixture(source);
  const originalProject = path.join('/projects', 'first'), nextProject = path.join('/projects', 'second');
  const saved = new Set(), locked = new Set(source ? [source] : []);
  const touchedSource = [], activated = [], recordedNavigation = [], lateWrites = [];
  const recoverySessionId = '01a1f768-6bb5-703d-9496-344d2845159f', durableClaims = [];
  let enteredPreparation, finishPreparation, originalFinished;
  const entered = new Promise(resolve => { enteredPreparation = resolve; });
  const stalled = new Promise(resolve => { finishPreparation = resolve; });
  const unwound = new Promise(resolve => { originalFinished = resolve; });
  const sessions = new Map();
  Object.assign(f.domain.dependencyLifecycle, {
    beginPreparation(project) {
      const session = { projectPath: project, signal: new AbortController().signal };
      sessions.set(project, session);
      return session;
    },
    release(session) { if (sessions.get(session.projectPath) === session) sessions.delete(session.projectPath); },
    finishPreparation() {},
  });
  f.window.projectLock = {
    tryAcquire: async project => {
      const alreadyHeld = locked.has(project);
      locked.add(project);
      return { ok: true, alreadyHeld };
    },
    release: async project => { locked.delete(project); return { ok: true }; },
    recordActive: async project => { recordedNavigation.push(project); return { ok: true }; },
  };
  if (source) {
    f.window.fs = { captureProjectAttachment: project => ({ version: 1, root: project,
      identity: { dev: '1', ino: project === originalProject ? '10' : '11', birthtimeNs: '1' } }) };
    f.window.projectLock.recordCreatedActive = async claim => {
      assert.equal(f.domain.currentProjectPath, source, 'the proof precedes the renderer project switch');
      assert.deepEqual(activated, []);
      durableClaims.push(claim);
      return { ok: true };
    };
  }
  Object.assign(f.domain, {
    electronService: { isElectron: true, exists: project => saved.has(project) },
    ensureProjectModeAllowed: async () => true,
    application: {
      hasActiveProjectMutation: () => false,
      closeConnectionGraphWindows: async () => { touchedSource.push('close-graph'); return true; },
      async settleEnvironmentBeforeOpen(project, assertCurrent) {
        if (project === originalProject) {
          enteredPreparation();
          await stalled;
          assertCurrent();
          lateWrites.push(project);
        }
      },
    },
    beginBlocklyProjectLoad() {},
    projectActivationSubject: { next: activation => { activated.push(activation.path); } },
    router: { url: source ? '/main/blockly-editor' : '/main/guide', navigate: async () => true },
    rememberDependencyBackend: session => session,
    assertProjectDependencySession: session => assert.equal(sessions.get(session.projectPath), session),
    stopProjectCommands: async project => { touchedSource.push(project); },
    discardDepartingBlocklyProject: async () => { touchedSource.push('retire'); return true; },
    waitForProjectOpenCompletion: async () => undefined,
    createDefaultNewProjectData: async (_board, requested) => ({ path: '/projects', name: requested.name }),
    projectNewWithResult: async (data, options) => {
      const project = path.join(data.path, data.name);
      assert.ok(!saved.has(project), 'a replay would create files twice');
      saved.add(project);
      options.createAuthority.markCreated(project);
      return { ok: true, projectPath: project };
    },
  });
  f.bridge.configService.getPreferredChatAgentRuntimeMode = () => 'blockly';
  f.bridge.normalizeAilyBoardPackageName = value => value;
  f.bridge.executeProjectCreate = async (...args) => {
    try { return await f.originalMethods.executeProjectCreate.apply(f.bridge, args); }
    finally { if (args[0].name === 'first') originalFinished(); }
  };
  const request = () => ({ version: 1, requestId: randomUUID(), rendererGeneration: 7, deadlineAt: Date.now() + 10_000 });
  const call = (operation, createRequest, name) => f.bridge.executeOperation({
    operation, rendererGeneration: 7, lifecycle: snapshot(source || null),
    params: { createRequest, ...(name ? { name, boardName: '@aily-project/board-test',
      ...(source ? { recoverySessionId } : {}) } : {}) },
  });
  const old = request();
  const first = call('project_create', old, 'first');
  await Promise.race([entered, first.then(result => assert.fail(JSON.stringify(result)))]);
  assert.equal(f.domain.currentProjectPath, source);
  assert.deepEqual(touchedSource, []);
  assert.equal(locked.has(originalProject), true);
  const stopped = await call('project_create_cancel', old);
  assert.equal(stopped.createReceipt.state, 'cancelled');
  assert.equal(stopped.createReceipt.createdProject, originalProject);
  assert.equal(stopped.createReceipt.activationCommitted, false);
  assert.equal(stopped.activationCurrent, false);
  assert.equal((await first).createReceipt.state, 'cancelled');
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
  assert.equal(locked.has(originalProject), false);
  assert.equal(sessions.has(originalProject), false);
  assert.equal(f.domain.currentProjectPath, source);
  assert.deepEqual(touchedSource, []);

  const newer = request(), second = await call('project_create', newer, 'second');
  assert.equal(second.createReceipt.state, 'completed');
  assert.equal(second.createReceipt.activationCommitted, true);
  finishPreparation();
  await unwound;
  assert.equal((await call('project_create_status', old)).createReceipt.state, 'cancelled');
  assert.deepEqual([...saved], [originalProject, nextProject]);
  assert.deepEqual(lateWrites, []);
  assert.deepEqual(activated, [nextProject]);
  assert.deepEqual(recordedNavigation, source ? [] : [nextProject]);
  if (source) {
    assert.equal(durableClaims.length, 1);
    assert.equal(durableClaims[0].projectPath, nextProject);
    assert.equal(durableClaims[0].attachment.identity.ino, '11');
    assert.equal(durableClaims[0].recoverySessionId, recoverySessionId);
    assert.equal(durableClaims[0].request.requestId, newer.requestId);
  }
  assert.deepEqual(touchedSource, source ? ['close-graph', source, 'retire'] : []);
  assert.equal(f.domain.currentProjectPath, nextProject);
  assert.equal(f.domain.projectLifecycle.owners.size, 0);
});
