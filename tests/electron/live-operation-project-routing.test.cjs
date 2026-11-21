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

test('ordinary workspace operations retain existing current-project fallback and requirement', () => {
  for (const operation of ['project_fork', 'abs_apply', 'abs_validate', 'project_save', 'project_build', 'unknown-operation']) {
    assert.deepEqual(routeLiveOperationProject(operation, undefined, '/isolated/current'), {
      path: '/isolated/current', parameterScoped: false,
    });
    assert.deepEqual(routeLiveOperationProject(operation, undefined, ''), { path: '', parameterScoped: false });
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
  ]) {
    assert.deepEqual(routeLiveOperationProject(operation, a, a, path.resolve, params).originalAdmissionAttachment, attachment);
    assert.equal(routeLiveOperationProject(operation, a, b, path.resolve, {
      ...params, originalAdmissionAttachment: attachment,
    }).originalAdmissionAttachment, undefined);
  }
  assert.equal(routeLiveOperationProject('abs_apply', a, a, path.resolve, { version: 1 }).originalAdmissionAttachment, undefined);
  assert.equal(routeLiveOperationProject('project_build', a, a, path.resolve, { version: 2 }).originalAdmissionAttachment, undefined);
});

test('only a renderer command stopped before sending its original publication records non-dispatch', async () => {
  const original = { ok: false, errorCode: 'RENDERER_RESPONSE_TIMEOUT' };
  const request = { path: '/source', operation: 'project_save', params: { saveRequest: { version: 2 } } };
  const stopped = mainRouteFixture('/source', async () => original);
  const timeout = mainRouteFixture('/source', async (...args) => {
    args[6](7);
    return original;
  });
  const result = await stopped.handleCliBridgeCommand('blockly-live-operation', request);
  assert.equal(result.commandDispatched, false);
  assert.deepEqual(await timeout.handleCliBridgeCommand('blockly-live-operation', request), original);
});
