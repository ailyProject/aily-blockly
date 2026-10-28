const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { routeLiveOperationProject } = require('../../electron/live-operation-project-routing');

for (const operation of ['project_fork_status', 'project_recovery_open']) {
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

test('ordinary workspace operations retain existing current-project fallback and requirement', () => {
  for (const operation of ['project_fork', 'abs_apply', 'abs_validate', 'project_save', 'project_build', 'unknown-operation']) {
    assert.deepEqual(routeLiveOperationProject(operation, undefined, '/isolated/current'), {
      path: '/isolated/current', parameterScoped: false,
    });
    assert.deepEqual(routeLiveOperationProject(operation, undefined, ''), { path: '', parameterScoped: false });
  }
});
