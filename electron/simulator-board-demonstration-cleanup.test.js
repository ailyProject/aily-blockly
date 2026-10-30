const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const test = require('node:test');
const esbuild = require('esbuild');

// The real Host product scope and command callback, with explicit inert
// framework/command ports. No Builder, process, Runtime or network is started.
async function loadService() {
  const filename = path.resolve(__dirname,
    '../src/app/integrations/simulator/simulator-host-provider-product.service.ts');
  const transformed = await esbuild.transform(await fs.readFile(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  });
  class CallbackAuthority { callbacks = {}; close() {} clearDebugMarker() {} }
  const imports = {
    '@angular/core': { Injectable: () => value => value },
    'rxjs': { lastValueFrom: async value => value },
    '@core/platform/public-api': {},
    '@aily-project/simulator-host-sdk': {
      SimulatorHostProviderOperationError: class extends Error {},
      createSimulatorHostProviderDispatcherAdapterBundle: () => ({ adapters: [], close() {} }),
    },
    '@integration/subapps/public-api': {},
    './simulator-build-product-composition': {
      SimulatorBuildProductComposition: class { projectCallbacks = {}; buildCallbacks = {}; close() {} },
    },
    './simulator-build-callback-authority': { createSimulatorBuildExecutionSlot: () => ({}) },
    './simulator-board-demonstration-provider': {
      SimulatorBoardDemonstrationProvider: class {
        constructor(options) { this.options = options; }
        compile(_request, signal) {
          return this.options.compile({ path: 'D:\\board', demoPath: 'D:\\demo' }, 'a'.repeat(64), signal);
        }
        close() {}
      },
    },
    './simulator-blockly-editor-callback-authority': { SimulatorBlocklyEditorCallbackAuthority: CallbackAuthority },
    './simulator-entitlement-callback-authority': { SimulatorEntitlementCallbackAuthority: CallbackAuthority },
    './simulator-current-project-scope': {},
    './simulator-electron-project-artifact-file-port': { createSimulatorElectronProjectArtifactFilePort: () => ({}) },
  };
  const module = { exports: {} };
  vm.runInNewContext(transformed.code, {
    module, exports: module.exports, TextEncoder, Uint8Array, AbortController, AbortSignal, DOMException, crypto,
    window: { path: { ...path.win32, getAilyChildPath: () => 'D:\\child', getAppDataPath: () => 'D:\\appdata' } },
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected product dependency: ${name}`);
      return imports[name];
    },
  }, { filename, timeout: 10_000 });
  return module.exports.SimulatorHostProviderProductService;
}

async function fixture(t) {
  const Service = await loadService();
  let settle, acknowledge = true, killError = null;
  const spawns = [], kills = [];
  const commands = {
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return new Promise((resolve, reject) => {
        const aborted = () => reject(options.signal.reason);
        options.signal.addEventListener('abort', aborted, { once: true });
        settle = value => { options.signal.removeEventListener('abort', aborted); resolve(value); };
      });
    },
    async kill(streamId) { kills.push(streamId); if (killError) throw killError; return acknowledge; },
  };
  const activation = new AbortController();
  const project = {
    currentProjectPath: 'D:\\project', isProjectOpening: false, isAilyCodeProject: () => false,
    projectActivation$: { subscribe: () => ({ unsubscribe() {} }) },
    captureCurrentProjectActivation: () => ({ path: 'D:\\project', projectSessionId: 'original-generation',
      signal: activation.signal, requireCurrent() { activation.signal.throwIfAborted(); } }),
  };
  const service = new Service({}, project, {}, {}, {}, {}, {}, {}, {}, {}, commands);
  const scope = await service.openCurrentProjectScope();
  t.after(async () => { acknowledge = true; killError = null; await scope.close(); });
  return {
    scope, spawns, kills,
    acknowledge(value) { acknowledge = value; },
    killError(value) { killError = value; },
    settle(value) { settle(value); },
    compile(signal) { return scope.callbacks.compileBoardDemonstration({ projectIdentity: scope.projectIdentity }, signal); },
  };
}

async function started(f) {
  for (let index = 0; index < 100 && !f.spawns.length; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.spawns.length, 1);
}

for (const failure of ['false', 'throw']) {
  test(`cancelled demo retains the original scope after kill ${failure}, then retry ACK closes without recompiling`, async t => {
    const f = await fixture(t), controller = new AbortController();
    f.acknowledge(false);
    if (failure === 'throw') f.killError(new Error('stop-failed'));
    const operation = f.compile(controller.signal);
    const observed = operation.catch(error => error);
    await started(f);
    const cancelled = new DOMException('Original cancellation', 'AbortError');
    controller.abort(cancelled);
    const error = await observed;
    assert.equal(error.name, 'AggregateError');
    assert.equal(error.errors[0], cancelled);
    assert.match(error.errors[1].message, /cleanup remains unconfirmed|stop-failed/);
    await assert.rejects(f.scope.close(), /cleanup remains unconfirmed/);
    assert.equal(f.scope.snapshot().closed, false);
    assert.ok(f.scope.snapshot().retainedCleanupSteps > 0);
    f.acknowledge(true); f.killError(null);
    await f.scope.close();
    assert.equal(f.scope.snapshot().closed, true);
    assert.equal(f.scope.snapshot().retainedCleanupSteps, 0);
    assert.equal(f.spawns.length, 1);
    assert.ok(f.kills.length >= 2);
    assert.ok(f.kills.every(streamId => streamId === f.spawns[0].options.streamId));
  });
}

for (const code of [0, 7]) {
  test(`natural demo command close ${code} releases responsibility without a second compilation`, async t => {
    const f = await fixture(t);
    const operation = f.compile(new AbortController().signal);
    const observed = operation.then(value => ({ value }), error => ({ error }));
    await started(f);
    f.settle({ type: 'close', code, stdout: 'AILY_DEMO_BUILD {"root":"D:\\\\built"}\n', stderr: 'compile-failed' });
    const result = await observed;
    if (code === 0) assert.equal(result.value, 'D:\\built');
    else assert.match(result.error.message, /compile-failed/);
    const killsBeforeClose = f.kills.length;
    await f.scope.close();
    assert.equal(f.scope.snapshot().closed, true);
    assert.equal(f.kills.length, killsBeforeClose);
    assert.equal(f.spawns.length, 1);
  });
}
