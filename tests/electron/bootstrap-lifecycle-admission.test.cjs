'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
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
  f.domain.projectNew = async (_data, options) => {
    prepared++;
    assert.equal(
      options.deferActivation,
      true,
      'creation must not IPC-serialize or replace the original lease owner',
    );
    assert.equal(f.domain.projectLifecycle.hasActive('/projects/weather'), true);
    return true;
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
    f.domain.projectNew = async () => {
      creations++;
      return true;
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
