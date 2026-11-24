const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const { registerCloudBuildHandlers } = require('../../electron/cloud-build/ipc');

// Execute the production preload function, not a second error-projection implementation.
const source = ts.createSourceFile('preload.js', fs.readFileSync(path.join(__dirname, '../../electron/preload.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const method = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'invokeCloudBuild');
assert(method);

for (const fault of [
  { code: 'COMPILE_ERROR', logComplete: true },
  { code: 'COMPILE_ERROR', logComplete: false },
  { code: 'COMPILE_ERROR' },
  { code: 'gateway_closing', httpStatus: 503, cleanupConfirmed: false, remoteCleanupConfirmed: false },
]) {
  test(`cloud failure ${JSON.stringify(fault)} survives IPC and preload`, async t => {
    t.mock.method(CloudBuildBroker.prototype, 'configuration', async () => ({}));
    t.mock.method(CloudBuildBroker.prototype, 'run', async () => {
      throw Object.assign(new Error('Actual cloud failure'), fault);
    });
    const handlers = new Map();
    const frame = {};
    const sender = Object.assign(new EventEmitter(), { id: 41, mainFrame: frame, isDestroyed: () => false });
    registerCloudBuildHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getOwner: () => ({ projectPath: path.join(os.tmpdir(), 'owned-log-transport') }),
      getGatewaySettings: () => ({}), getAuth: () => ({}), querySource: async () => ({}),
      getRuntimeRoot: () => path.join(os.tmpdir(), 'owned-log-runtime'), backend: 'cloud', getRegion: () => 'cn' });
    const invoke = vm.runInNewContext('(' + method.getText(source) + ')', { ipcRenderer: {
      invoke: (channel, payload) => handlers.get(channel)({ sender, senderFrame: frame }, payload),
    } });
    await assert.rejects(invoke({ action: 'compile', requestId: 'bound-request' }), error => {
      assert.equal(error.message, 'Actual cloud failure');
      for (const field of ['code', 'logComplete', 'httpStatus', 'cleanupConfirmed', 'remoteCleanupConfirmed']) {
        assert.equal(error[field], fault[field]);
      }
      return true;
    });
  });
}
