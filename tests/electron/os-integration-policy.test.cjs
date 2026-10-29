'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { resolveOsIntegrationPolicy } = require('../../electron/os-integration-policy');
const filename = path.join(__dirname, '../../electron/main.js');
const main = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
function select(predicate, count) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node.getText(main)); ts.forEachChild(node, visit); }
  visit(main); assert.equal(result.length, count); return result;
}
const setup = select(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(
  declaration => declaration.name.getText(main) === 'osIntegrationPolicy'), 1)[0];
const protocols = select(node => ts.isForOfStatement(node)
  && node.expression.getText(main).includes('osIntegrationPolicy.registerProtocols'), 2);
const tasks = select(node => ts.isIfStatement(node)
  && node.expression.getText(main) === 'osIntegrationPolicy.registerWindowsUserTasks', 1)[0];
const resourceRoute = select(node => ts.isIfStatement(node)
  && node.expression.getText(main) === 'repairBootstrap'
  && node.thenStatement.getText(main) === 'applyChildToolEnv(childPath);'
  && node.elseStatement?.getText(main) === 'runInstallEnv(childPath);', 1)[0];
function boot({ flag, platform = 'win32', repair = false, development = false } = {}) {
  const calls = [];
  const sandbox = { resolveOsIntegrationPolicy, repairBootstrap: repair ? {} : null,
    process: { env: flag === undefined ? {} : { AILY_E2E: flag }, platform, defaultApp: development,
      execPath: '/owned/executable', argv: ['/owned/executable', '/owned/application'] },
    app: { removeAsDefaultProtocolClient: (...args) => calls.push(['remove', ...args]),
      setAsDefaultProtocolClient: (...args) => calls.push(['register', ...args]) },
    PROTOCOLS: ['fixture-one', 'fixture-two'], path,
    createDevelopmentProtocolArgs: value => ['owned-development', value.appEntry],
    getBuildProduct: () => 'blockly', serve: development,
    setupWindowsJumpListTasks: () => calls.push(['tasks']),
    childPath: '/owned/child', applyChildToolEnv: () => calls.push(['repair-env']),
    runInstallEnv: () => calls.push(['install-env']),
  };
  vm.runInNewContext([setup, ...protocols, tasks, resourceRoute].join('\n'), sandbox);
  return calls;
}
test('normal Windows policy preserves protocol and UserTasks integration', () => {
  assert.deepEqual(resolveOsIntegrationPolicy({ platform: 'win32' }),
    { registerProtocols: true, registerWindowsUserTasks: true });
  assert.deepEqual(boot(), [['remove', 'fixture-one'], ['remove', 'fixture-two'],
    ['register', 'fixture-one'], ['register', 'fixture-two'], ['tasks'], ['install-env']]);
});
test('normal macOS/Linux keep protocols without Windows UserTasks', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(resolveOsIntegrationPolicy({ platform }),
      { registerProtocols: true, registerWindowsUserTasks: false });
    assert.deepEqual(boot({ platform }).map(row => row[0]), ['remove', 'remove', 'register', 'register', 'install-env']);
  }
});
test('E2E disables both OS registrations on every platform and still prepares child resources', () => {
  for (const platform of ['win32', 'darwin', 'linux']) assert.deepEqual(boot({ flag: '1', platform }), [['install-env']]);
});
test('repair isolation stays disabled and retains its existing environment route', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(boot({ repair: true, platform }), [['repair-env']]);
    assert.deepEqual(boot({ repair: true, flag: '1', platform }), [['repair-env']]);
  }
});
test('only the existing exact AILY_E2E=1 value enables E2E isolation', () => {
  for (const flag of ['', '0', 'true']) assert.deepEqual(boot({ flag }), boot());
});
test('normal development registration keeps its executable and application arguments', () => {
  const registrations = boot({ development: true }).filter(row => row[0] === 'register');
  assert.equal(registrations.length, 2);
  for (const row of registrations) {
    assert.equal(row[2], '/owned/executable');
    assert.equal(row[3][0], 'owned-development');
    assert.equal(row[3][1], path.resolve('/owned/application'));
  }
});
test('repair code identity binds the OS integration module as a main-process dependency', t => {
  const { codeIdentity } = require('../../electron/project-repair-environment');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-os-policy-identity-'));
  const directory = path.join(root, 'electron'), policy = path.join(directory, 'os-integration-policy.js');
  fs.mkdirSync(directory);
  t.after(() => { fs.unlinkSync(policy); fs.rmdirSync(directory); fs.rmdirSync(root); });
  fs.writeFileSync(policy, 'module.exports = { original: true };');
  const before = codeIdentity('/owned/executable', root);
  fs.writeFileSync(policy, 'module.exports = { changed: true };');
  assert.notEqual(codeIdentity('/owned/executable', root), before);
});
