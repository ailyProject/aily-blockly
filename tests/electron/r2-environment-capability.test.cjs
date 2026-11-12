const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { transformSync } = require('esbuild');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
function find(node, predicate) {
  if (predicate(node)) return node;
  let result; ts.forEachChild(node, child => { if (!result) result = find(child, predicate); }); return result;
}
const source = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
function fixture(capability = 'actual-main', currentFrame = true) {
  const main = source('electron/main.js'), preload = source('electron/preload.js'), handlers = new Map(), calls = [];
  const registration = find(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'ipcMain.handle'
    && node.arguments[0]?.text === 'library-dependencies:capabilities');
  assert.ok(registration, 'The capability must be registered by the actual Main source');
  const sender = { mainFrame: {} }, sessions = new LibraryDependencySessions({});
  vm.runInNewContext(registration.getText(main), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, librarySessions: sessions,
    isCurrentMainRenderer: candidate => candidate === sender,
  });
  const functions = ['readDependencyEnvironmentCapability', 'invokeDependencyEnvironmentMutation'].map(name => {
    const found = find(preload, node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(found); return found.getText(preload);
  });
  const bridge = find(preload, node => ts.isPropertyAssignment(node) && node.name.getText(preload) === 'libraryDependencies'
    && ts.isObjectLiteralExpression(node.initializer));
  const module = { exports: {} };
  vm.runInNewContext(transformSync(`${functions.join('\n')}\nmodule.exports = ${bridge.initializer.getText(preload)};`,
    { loader: 'ts', format: 'cjs', target: 'es2022' }).code, { module, exports: module.exports, ipcRenderer: {
    invoke: async (channel, input) => {
      calls.push({ channel, operation: input?.operation });
      if (channel === 'library-dependencies:capabilities') {
        if (capability === 'old-main') throw Error('No handler registered');
        if (capability === 'wrong-version') return { dependencyEnvironmentVersion: 1 };
        return handlers.get(channel)({ sender, senderFrame: currentFrame ? sender.mainFrame : {} });
      }
      assert.equal(channel, 'library-dependencies'); return { ok: true, operation: input.operation };
    },
  } });
  return { bridge: module.exports, calls, sessions };
}
test('real Main handler, not a preload constant, admits each requested environment write', async () => {
  const f = fixture();
  assert.equal(f.bridge.environmentVersion, 2);
  assert.equal((await f.bridge.capabilities()).dependencyEnvironmentVersion, 2);
  for (const operation of ['configure', 'reconcile', 'mutate', 'historyBegin']) {
    f.calls.length = 0;
    assert.equal((await f.bridge[operation]('owned-project', {})).operation, operation);
    assert.deepEqual(f.calls, [{ channel: 'library-dependencies:capabilities', operation: undefined },
      { channel: 'library-dependencies', operation }]);
  }
  assert.equal(f.sessions.sessions.size, 0, 'Capability reads create no transaction or project state');
});
for (const capability of ['old-main', 'wrong-version']) test(`${capability} cannot be hidden by a newer preload version`, async () => {
  const f = fixture(capability);
  assert.equal(f.bridge.environmentVersion, 2, 'The static UI property deliberately looks current');
  for (const operation of ['configure', 'reconcile', 'mutate', 'historyBegin']) await assert.rejects(
    f.bridge[operation]('owned-project', {}), { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
  assert.equal(f.calls.some(call => call.channel === 'library-dependencies'), false, 'No actual mutation is dispatched');
  f.calls.length = 0;
  await f.bridge.status('owned-project');
  assert.deepEqual(f.calls, [{ channel: 'library-dependencies', operation: 'status' }], 'Ordinary reads do not acquire a mutation gate');
});
test('the Main capability rejects a different renderer frame before dispatch', async () => {
  const f = fixture('actual-main', false);
  await assert.rejects(f.bridge.mutate('owned-project', {}), { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
  assert.equal(f.calls.some(call => call.channel === 'library-dependencies'), false);
});
