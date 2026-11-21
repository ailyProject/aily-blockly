const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { routeLiveOperationProject, routeProjectReload } = require('../../electron/live-operation-project-routing');
const { rootAttachment } = require('../../electron/project-file-lock-owner');
const { mainRouteFixture } = require('./fixtures/bootstrap-host-source.cjs');

for (const operation of ['project_fork_status', 'project_recovery_open', 'project_save_status']) {
  test(`${operation} keeps params.project authority after the active view has changed`, () => {
    const result = routeLiveOperationProject(operation, undefined, '/isolated/already-activated-target');
    assert.deepEqual(result, { path: '', parameterScoped: true });
  });
  test(`${operation} remains reachable with no currently open project`, () => {
    assert.deepEqual(routeLiveOperationProject(operation, undefined, ''), { path: '', parameterScoped: true });
  });
  test(`${operation} preserves an explicitly provided path rather than hiding a mismatch`, () => {
    const requested = path.resolve('explicit-source');
    assert.equal(routeLiveOperationProject(operation, requested, '/isolated/current').path, requested);
  });
}

test('board settlement never infers its original attachment from the active project', () => {
  const operation = 'project_board_environment_settle', requested = path.resolve('explicit-board-project');
  assert.deepEqual(routeLiveOperationProject(operation, undefined, '/isolated/current'), { path: '', parameterScoped: true });
  assert.equal(routeLiveOperationProject(operation, requested, '/isolated/current').path, requested);
});

test('ABS admission status routes only the absolute original project regardless of the active view', async () => {
  const operation = 'abs_admission_status', project = path.resolve('explicit-original');
  const params = { version: 2, requestId: '00000000-0000-4000-8000-000000000abc' };
  for (const active of ['different-current-project', '']) {
    const host = mainRouteFixture(active);
    await host.handleCliBridgeCommand('blockly-live-operation', { path: project, operation, params });
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].path, project);
    assert.equal(host.calls[0].params, params);
    assert.equal(host.calls[0].originalAdmissionAttachment, undefined);
  }
  assert.deepEqual(routeLiveOperationProject('abs_admission_status', 'relative-source', '/current-project'), {
    path: '', parameterScoped: true,
  });
});

test('state publication read routes to its original project without an attached canvas', async () => {
  const operation = 'abs_recovery', project = path.resolve('state-show-original');
  const params = { version: 2, action: 'observe_state' };
  for (const active of ['different-current-project', '']) {
    const host = mainRouteFixture(active);
    await host.handleCliBridgeCommand('blockly-live-operation', { path: project, operation, params });
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0].path, project);
    assert.equal(host.calls[0].params, params);
    assert.equal(host.calls[0].originalAdmissionAttachment, undefined);
  }
  assert.deepEqual(routeLiveOperationProject(operation, 'relative-project', '/current-project', path.resolve, params), {
    path: '', parameterScoped: true,
  });
});

test('ordinary workspace operations retain existing current-project fallback and requirement', () => {
  for (const operation of ['project_fork', 'abs_apply', 'abs_validate', 'project_save', 'project_build', 'unknown-operation']) {
    assert.deepEqual(routeLiveOperationProject(operation, undefined, '/isolated/current'), {
      path: '/isolated/current', parameterScoped: false,
    });
    assert.deepEqual(routeLiveOperationProject(operation, undefined, ''), { path: '', parameterScoped: false });
  }
});

test('explicit recovery Stop keeps its original absolute project after navigation', async () => {
  const operation = 'abs_recovery', project = path.resolve('recovery-source'), current = path.resolve('replacement-view');
  const params = { version: 2, action: 'cancel_project', requestId: 'exact-recovery-id' };
  const host = mainRouteFixture(current);
  await host.handleCliBridgeCommand('blockly-live-operation', { path: project, operation, params });
  assert.equal(host.calls[0].path, project);
  assert.equal(host.calls[0].params, params);
  for (const missing of [undefined, 'relative-source']) {
    assert.deepEqual(routeLiveOperationProject(operation, missing, current, path.resolve, params), {
      path: '', parameterScoped: true,
    });
  }
});

test('a lifecycle-bound Blockly reload never routes a different path as open', () => {
  const current = path.resolve('active'), requested = path.resolve('different');
  for (const target of [undefined, current, requested]) {
    assert.deepEqual(routeProjectReload(target, current, true), {
      path: target || current, operation: 'project_reload', canFallbackToOpen: false,
    });
  }
  assert.deepEqual(routeProjectReload(requested, current, false), {
    path: requested, operation: 'project_open', canFallbackToOpen: true,
  });
});

test('versioned publication routing captures only the current physical project attachment', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-publication-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = fs.mkdirSync(path.join(home, 'a'), { recursive: true });
  const b = fs.mkdirSync(path.join(home, 'b'), { recursive: true });
  const attachment = rootAttachment(fs.realpathSync.native(a));
  assert.ok(attachment);

  for (const [operation, params] of [
    ['abs_apply', { version: 2 }],
    ['project_save', { saveRequest: { version: 2 } }],
    ['blocks_tidy', { saveRequest: { version: 2 } }],
    ['blocks_set_state', { version: 2, action: 'update' }],
  ]) {
    assert.deepEqual(routeLiveOperationProject(operation, a, a, path.resolve, params).originalAdmissionAttachment, attachment);
    assert.equal(routeLiveOperationProject(operation, a, b, path.resolve, {
      ...params, originalAdmissionAttachment: attachment,
    }).originalAdmissionAttachment, undefined);
  }
  assert.equal(routeLiveOperationProject('abs_apply', a, a, path.resolve, { version: 1 }).originalAdmissionAttachment, undefined);
  assert.equal(routeLiveOperationProject('blocks_set_state', a, a, path.resolve, { version: 2, action: 'inspect' }).originalAdmissionAttachment, undefined);
  assert.equal(routeLiveOperationProject('project_build', a, a, path.resolve, { version: 2 }).originalAdmissionAttachment, undefined);
});

test('only a renderer command stopped before sending its original publication records non-dispatch', async () => {
  const original = { ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' };
  const request = { path: '/source', operation: 'abs_apply', params: { version: 2 } };
  const stopped = mainRouteFixture('/source', async () => original);
  const timeout = mainRouteFixture('/source', async (...args) => {
    args[6](7);
    return original;
  });
  const result = await stopped.handleCliBridgeCommand('blockly-live-operation', request);
  assert.equal(result.commandDispatched, false);
  assert.deepEqual(await timeout.handleCliBridgeCommand('blockly-live-operation', request), original);
});

test('native save preparation reaches only the current physical view and precedes the first writer dispatch', async t => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(temp, 'aily-save-dispatch-')));
  t.after(() => {
    assert.equal(path.dirname(directory), temp);
    assert.match(path.basename(directory), /^aily-save-dispatch-[A-Za-z0-9]+$/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const project = path.join(directory, 'a'), newer = path.join(directory, 'b');
  fs.mkdirSync(project);
  fs.mkdirSync(newer);
  const request = { version: 2, operation: 'project_save', requestId: 'pub2-00000000-0000-4000-8000-000000000abc' };
  const saveWriter = { viewRevision: 7, intentHash: 'sha256:' + 'a'.repeat(64) };
  const invoke = (fixture, operation) => fixture.handleCliBridgeCommand('blockly-live-operation', {
    path: project, operation, params: { saveRequest: request },
  });
  const host = mainRouteFixture(project, async (...args) => {
    if (args[2].operation === 'project_publication_prepare') return { ok: true, rendererGeneration: 8, saveWriter };
    args[6](8);
    return { ok: true };
  });
  assert.equal((await invoke(host, 'project_publication_prepare')).saveWriter, saveWriter);
  assert.deepEqual(host.calls.map(call => call.operation), ['project_publication_prepare']);
  await invoke(host, 'project_save');
  assert.deepEqual(host.calls.map(call => call.operation), ['project_publication_prepare', 'project_publication_prepare', 'project_save']);
  assert.deepEqual(host.calls[1].originalAdmissionAttachment, rootAttachment(project));
  assert.equal(host.calls[2].nativeSaveWriter, saveWriter);
  assert.equal(host.calls[2].lifecycle.rendererGeneration, 8);
  const different = mainRouteFixture(newer);
  assert.equal((await invoke(different, 'project_publication_prepare')).commandDispatched, false);
  assert.equal(different.calls.length, 0);
  const proof = { ...saveWriter, version: 1, kind: 'admitted-save', attachment: rootAttachment(project) };
  const detached = mainRouteFixture(newer, async (...args) => {
    args[6](8);
    return { ok: true };
  });
  await detached.handleCliBridgeCommand('blockly-live-operation', {
    path: project, operation: 'project_save', params: { saveRequest: request, saveWriter: proof },
  });
  assert.deepEqual(detached.calls.map(call => call.operation), ['project_save']);
  assert.deepEqual(detached.calls[0].originalAdmissionAttachment, proof.attachment);
  assert.equal(detached.calls[0].params.saveWriter, undefined);
  assert.equal(detached.calls[0].nativeSaveWriter, proof);
  const lost = mainRouteFixture(project, async () => ({ ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' }));
  assert.equal((await invoke(lost, 'project_save')).commandDispatched, false);
  assert.deepEqual(lost.calls.map(call => call.operation), ['project_publication_prepare']);
  const observed = mainRouteFixture(project, async (_channel, _response, { operation }) =>
    operation === 'project_publication_prepare'
      ? { ok: false, code: 'PROJECT_SAVE_REQUEST_CONSUMED' }
      : { ok: true, state: 'completed' });
  assert.equal((await invoke(observed, 'project_save')).state, 'completed');
  assert.deepEqual(observed.calls.map(call => call.operation), ['project_publication_prepare', 'project_save_status']);
});
