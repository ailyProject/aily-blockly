const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');

const serviceModulePromise = loadServiceModule();

test('upload resource handoff reaches a running Subapp Runtime without a mounted UI', async () => {
  const serviceModule = await serviceModulePromise;
  const originalWindow = global.window;
  const originalWebSocket = global.WebSocket;
  const sent = [];
  global.WebSocket = createFakeWebSocket(sent);
  global.window = {
    childToolSession: {
      list: async () => [{
        toolId: 'serial-debugger',
        running: true,
        hostInfo: { wsUrl: 'ws://127.0.0.1:4100/ws?token=test' },
      }],
    },
  };
  serviceModule.replaceChildToolConfigs([fixtureConfig()]);

  try {
    const service = new serviceModule.SubappResourceLifecycleService();
    await service.handleSignal('serial-monitor:disconnect', {
      port: 'COM3',
      portType: 'serial',
      operationId: 'upload-1',
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'runtime.resource.suspend');
    assert.deepEqual(sent[0].params.resource, { kind: 'serial', id: 'COM3' });
    assert.equal(sent[0].params.operationId, 'upload-1');
    assert.equal(sent[0].context.actor, 'host');
  } finally {
    global.window = originalWindow;
    global.WebSocket = originalWebSocket;
  }
});

test('resource handoff ignores running Subapps that did not declare the capability', async () => {
  const serviceModule = await serviceModulePromise;
  const originalWindow = global.window;
  const originalWebSocket = global.WebSocket;
  const sent = [];
  global.WebSocket = createFakeWebSocket(sent);
  global.window = {
    childToolSession: {
      list: async () => [{
        toolId: 'other-tool',
        running: true,
        hostInfo: { wsUrl: 'ws://127.0.0.1:4200/ws?token=test' },
      }],
    },
  };
  serviceModule.replaceChildToolConfigs([{
    id: 'other-tool',
    titleKey: 'OTHER.TITLE',
    namespace: 'OTHER',
  }]);

  try {
    const service = new serviceModule.SubappResourceLifecycleService();
    await service.handleSignal('serial-monitor:disconnect', {
      port: 'COM3',
      portType: 'serial',
      operationId: 'upload-2',
    });
    assert.equal(sent.length, 0);
  } finally {
    global.window = originalWindow;
    global.WebSocket = originalWebSocket;
  }
});

function fixtureConfig() {
  return {
    id: 'serial-debugger',
    titleKey: 'SERIAL.TITLE',
    namespace: 'SERIAL',
    runtime: {
      resourceLifecycle: {
        resources: ['serial'],
        suspendMethod: 'runtime.resource.suspend',
        resumeMethod: 'runtime.resource.resume',
        timeoutMs: 150000,
      },
    },
  };
}

function createFakeWebSocket(sent) {
  return class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(value) {
      const request = JSON.parse(value);
      sent.push(request);
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({ id: request.id, ok: true, result: { ok: true } }),
      }));
    }

    close() {
      this.emit('close', {});
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  };
}

async function loadServiceModule() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { SubappResourceLifecycleService } from './src/app/services/subapp-resource-lifecycle.service.ts';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'subapp-resource-lifecycle-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'angular-core-stub',
      setup(build) {
        build.onResolve({ filter: /^@angular\/core$/ }, () => ({
          path: 'angular-core',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export function Injectable() { return target => target; }',
          loader: 'js',
        }));
      },
    }],
  });
  const moduleRecord = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    require,
    moduleRecord,
    moduleRecord.exports,
  );
  return moduleRecord.exports;
}
