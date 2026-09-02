const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const processModulePromise = loadProcessModule();

test('child tool startup is single-flight for concurrent acquire calls', async () => {
  const processModule = await processModulePromise;
  const originalWindow = global.window;
  const harness = createHarness({ ready: true });
  global.window = harness.window;
  processModule.replaceChildToolConfigs([fixtureConfig(200)]);
  const service = createService(processModule);

  try {
    const [first, second] = await Promise.all([
      service.acquire('fixture'),
      service.acquire('fixture'),
    ]);

    assert.equal(harness.acquireCalls, 1);
    assert.equal(harness.runCalls.length, 1);
    assert.deepEqual(first, second);
    assert.equal(first.url, 'http://127.0.0.1:4100/');
    assert.equal(harness.registerCalls.length, 1);
  } finally {
    await service.stop('fixture');
    global.window = originalWindow;
  }
});

test('timed out child tool startup kills its exact stream and ignores a late ready event', async () => {
  const processModule = await processModulePromise;
  const originalWindow = global.window;
  const harness = createHarness({ ready: false });
  global.window = harness.window;
  processModule.replaceChildToolConfigs([fixtureConfig(20)]);
  const service = createService(processModule);

  try {
    await assert.rejects(
      service.acquire('fixture'),
      /server did not report ready/,
    );

    assert.equal(harness.runCalls.length, 1);
    const failedStreamId = harness.runCalls[0].streamId;
    assert.deepEqual(harness.killCalls, [failedStreamId]);
    assert.equal(harness.registerCalls.length, 0);

    harness.emitCaptured(failedStreamId, readyOutput(4199));
    await Promise.resolve();
    assert.equal(harness.registerCalls.length, 0);

    harness.ready = true;
    const recovered = await service.acquire('fixture');
    assert.equal(recovered.url, 'http://127.0.0.1:4100/');
    assert.equal(harness.runCalls.length, 2);
    assert.equal(harness.registerCalls.length, 1);
    assert.notEqual(harness.runCalls[1].streamId, failedStreamId);
  } finally {
    await service.stop('fixture');
    global.window = originalWindow;
  }
});

test('runtime observation is read-only and reports lifecycle snapshots', async () => {
  const processModule = await processModulePromise;
  const originalWindow = global.window;
  const harness = createHarness({ ready: true });
  global.window = harness.window;
  processModule.replaceChildToolConfigs([fixtureConfig(200)]);
  const service = createService(processModule);
  const snapshots = [];
  const subscription = service.observeRuntime('fixture').subscribe(snapshot => {
    snapshots.push(snapshot);
  });

  try {
    assert.equal(snapshots.at(-1).state, 'unknown');
    assert.equal(harness.acquireCalls, 0);
    assert.equal(harness.runCalls.length, 0);

    await service.acquire('fixture');
    assert.equal(snapshots.at(-1).state, 'ready');
    assert.equal(snapshots.at(-1).running, true);
    assert.equal(snapshots.at(-1).refCount, 1);

    await service.stop('fixture');
    assert.equal(snapshots.at(-1).state, 'stopped');
    assert.equal(snapshots.at(-1).running, false);
  } finally {
    subscription.unsubscribe();
    await service.stop('fixture');
    global.window = originalWindow;
  }
});

test('Agent and full UI leases share one Runtime while compact observation owns no lease', async () => {
  const processModule = await processModulePromise;
  const originalWindow = global.window;
  const harness = createHarness({ ready: true });
  global.window = harness.window;
  processModule.replaceChildToolConfigs([fixtureConfig(200)]);
  const service = createService(processModule);
  const subscription = service.observeRuntime('fixture').subscribe(() => undefined);

  try {
    await Promise.all([
      service.acquire('fixture'),
      service.acquire('fixture'),
    ]);
    assert.equal(harness.runCalls.length, 1);
    assert.equal(service.getRuntimeSnapshot('fixture').refCount, 2);

    await service.release('fixture');
    assert.equal(service.getRuntimeSnapshot('fixture').state, 'ready');
    assert.equal(service.getRuntimeSnapshot('fixture').refCount, 1);
    assert.equal(harness.releaseCalls, 0);

    subscription.unsubscribe();
    assert.equal(service.getRuntimeSnapshot('fixture').refCount, 1);

    await service.release('fixture');
    assert.equal(service.getRuntimeSnapshot('fixture').refCount, 0);
    assert.equal(harness.releaseCalls, 0);
  } finally {
    subscription.unsubscribe();
    await service.stop('fixture');
    global.window = originalWindow;
  }
});

test('declared process message port is direct, stream-bound and bidirectional', async () => {
  const processModule = await processModulePromise;
  const originalWindow = global.window;
  const harness = createHarness({ ready: true });
  global.window = harness.window;
  processModule.replaceChildToolConfigs([fixtureConfig(200)]);
  const service = createService(processModule);
  const received = [];
  const removeMessageListener = service.onMessage(
    'fixture',
    message => received.push(message),
  );

  try {
    await service.acquire('fixture');
    const streamId = harness.runCalls[0].streamId;
    assert.equal(harness.runCalls[0].shellProfile, false);
    assert.deepEqual(harness.runCalls[0].messagePort, {
      transport: 'node-ipc-v1',
      maxMessageBytes: 1048576,
    });

    harness.emitMessage({
      toolId: 'fixture',
      streamId,
      message: { type: 'fixture.request', requestId: 'request-1' },
    });
    harness.emitMessage({
      toolId: 'fixture',
      streamId: 'stale-stream',
      message: { type: 'stale' },
    });
    assert.deepEqual(received, [{
      type: 'fixture.request',
      requestId: 'request-1',
    }]);

    await service.sendMessage('fixture', {
      type: 'fixture.response',
      requestId: 'request-1',
    });
    assert.deepEqual(harness.sendMessageCalls, [{
      toolId: 'fixture',
      streamId,
      leaseId: harness.registerCalls[0].leaseId,
      message: {
        type: 'fixture.response',
        requestId: 'request-1',
      },
    }]);
  } finally {
    removeMessageListener();
    await service.stop('fixture');
    global.window = originalWindow;
  }
});

function fixtureConfig(startupTimeoutMs) {
  return {
    id: 'fixture',
    titleKey: 'FIXTURE.TITLE',
    namespace: 'FIXTURE',
    packagePath: '/subapps/fixture',
    entry: 'index.js',
    uiIndex: 'ui/index.html',
    startupTimeoutMs,
    runtime: {
      processMessagePort: {
        transport: 'node-ipc-v1',
        maxMessageBytes: 1048576,
      },
    },
  };
}

function createService(processModule) {
  return new processModule.ChildToolProcessService(
    { getCurrentApiServer: () => '' },
    { currentProjectPath: undefined },
  );
}

function createHarness(options) {
  const activeListeners = new Map();
  const capturedListeners = new Map();
  const registered = new Map();
  let messageListener = null;
  const harness = {
    ready: options.ready,
    acquireCalls: 0,
    runCalls: [],
    killCalls: [],
    registerCalls: [],
    releaseCalls: 0,
    sendMessageCalls: [],
    emitCaptured(streamId, output) {
      capturedListeners.get(streamId)?.(output);
    },
    emitMessage(event) {
      messageListener?.(event);
    },
  };

  harness.window = {
    path: {
      getAilyChildPath: () => '/child',
      join: (...parts) => path.posix.join(...parts),
    },
    fs: {
      existsSync: () => true,
    },
    childToolSession: {
      async acquire() {
        harness.acquireCalls += 1;
        await Promise.resolve();
        return null;
      },
      async register(payload) {
        harness.registerCalls.push(payload);
        registered.set(payload.toolId, payload);
        return { success: true };
      },
      async release(payload) {
        harness.releaseCalls += 1;
        const current = registered.get(payload.toolId);
        if (!current || current.streamId !== payload.streamId) {
          return { success: false, reason: 'not-found' };
        }
        registered.delete(payload.toolId);
        return { success: true };
      },
      async unregister(payload) {
        const current = registered.get(payload.toolId);
        if (current?.streamId === payload.streamId) {
          registered.delete(payload.toolId);
          return { success: true };
        }
        return { success: false, reason: 'not-found' };
      },
      async restart() {
        return { success: true };
      },
      async stop() {
        return { success: true };
      },
      async sendMessage(payload) {
        harness.sendMessageCalls.push(payload);
        return { success: true };
      },
      onMessage(listener) {
        messageListener = listener;
        return () => {
          if (messageListener === listener) messageListener = null;
        };
      },
    },
    cmd: {
      onData(streamId, listener) {
        activeListeners.set(streamId, listener);
        capturedListeners.set(streamId, listener);
        return () => activeListeners.delete(streamId);
      },
      async run(input) {
        harness.runCalls.push(input);
        if (harness.ready) {
          queueMicrotask(() => {
            activeListeners.get(input.streamId)?.(readyOutput(4100));
          });
        }
        return { success: true, streamId: input.streamId, pid: 1000 + harness.runCalls.length };
      },
      async kill(streamId) {
        harness.killCalls.push(streamId);
        activeListeners.delete(streamId);
        return { success: true, streamId };
      },
    },
  };

  return harness;
}

function readyOutput(port) {
  return {
    type: 'stdout',
    data: `${JSON.stringify({
      event: 'ready',
      data: {
        url: `http://127.0.0.1:${port}/`,
        origin: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/ws`,
        port,
        pid: 5000 + port,
      },
    })}\n`,
  };
}

async function loadProcessModule() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { ChildToolProcessService } from './src/app/services/integrations/subapps/child-tool-process.service.ts';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';",
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'child-tool-process-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'child-tool-process-stubs',
      setup(build) {
        build.onResolve({ filter: /^@angular\/core$/ }, () => ({
          path: 'angular-core',
          namespace: 'stub',
        }));
        build.onResolve({ filter: /\/(?:config|project)\.service$/ }, args => ({
          path: args.path,
          namespace: 'stub',
        }));
        build.onResolve({ filter: /project-log\.utils$/ }, () => ({
          path: 'project-log',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, args => {
          if (args.path === 'angular-core') {
            return {
              contents: 'export function Injectable() { return target => target; }',
              loader: 'js',
            };
          }
          if (args.path === 'project-log') {
            return {
              contents: 'export function appendProjectLog() { return null; }',
              loader: 'js',
            };
          }
          return {
            contents: 'export class ConfigService {} export class ProjectService {}',
            loader: 'js',
          };
        });
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
