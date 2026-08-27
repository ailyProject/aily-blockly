const assert = require('node:assert/strict');
const test = require('node:test');
const esbuild = require('esbuild');

const bridgeModulePromise = loadBridgeModule();

test('generic Subapp Agent bridge forwards AbortSignal cancellation to the Runtime', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: false }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig()]);
  const processService = createProcessService();
  const activityService = new bridgeModule.SubappActivityService();
  const service = new bridgeModule.SubappAgentBridgeService(
    processService,
    { openChildApp: async () => ({ ok: true }) },
    activityService,
  );

  try {
    const abortController = new AbortController();
    const execution = service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: { timeoutMs: 30000 }
    }, abortController.signal, { sessionId: 'chat-cancel' });
    await waitUntil(() => fakeWebSocket.sent.some(message => message.method === 'fixture.wait'));
    abortController.abort();
    const result = await execution;

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SUBAPP_RPC_CANCELLED');
    assert.ok(fakeWebSocket.sent.some(message =>
      message.method === 'runtime.request.cancel'
      && message.params?.requestId
    ));
    assert.equal(
      activityService.getActivity('chat-cancel', 'fixture').invocationState,
      'cancelled',
    );
    assert.equal(
      activityService.getActivity('chat-cancel', 'fixture').runtimeState,
      'ready',
    );
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('failed invocation is projected per session and a later retry succeeds', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig()]);
  const activityService = new bridgeModule.SubappActivityService();
  const service = new bridgeModule.SubappAgentBridgeService(
    createProcessService(),
    { openChildApp: async () => ({ ok: true }) },
    activityService,
  );

  try {
    const failed = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: { payload: 'x'.repeat(2048) },
    }, undefined, { sessionId: 'chat-retry' });
    assert.equal(failed.ok, false);
    assert.equal(failed.errorCode, 'SUBAPP_INPUT_TOO_LARGE');
    assert.equal(
      activityService.getActivity('chat-retry', 'fixture').invocationState,
      'failed',
    );

    const retried = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {},
    }, undefined, { sessionId: 'chat-retry' });
    assert.equal(retried.ok, true);
    assert.equal(
      activityService.getActivity('chat-retry', 'fixture').invocationState,
      'succeeded',
    );
    assert.equal(
      activityService.getActivity('chat-retry', 'fixture').runtimeState,
      'ready',
    );
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('generic Subapp Agent bridge reacquires once after a connection failure without replaying a request', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([
    { open: false },
    { open: true, respond: true }
  ]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig()]);
  const processService = createProcessService();
  const service = new bridgeModule.SubappAgentBridgeService(
    processService,
    { openChildApp: async () => ({ ok: true }) },
    createActivityService(),
  );

  try {
    const result = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {}
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.result, { value: 'ok' });
    assert.equal(processService.acquireCount, 2);
    assert.equal(processService.releaseCount, 1);
    assert.equal(
      fakeWebSocket.sent.filter(message => message.method === 'fixture.wait').length,
      1,
      'the domain request must only be sent after a connection is established'
    );
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('generic Subapp Agent bridge opens requested UI and returns presentation evidence', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig()]);
  const processService = createProcessService();
  const presentationCalls = [];
  const service = new bridgeModule.SubappAgentBridgeService(
    processService,
    {
      async openChildApp(input) {
        presentationCalls.push(input);
        return {
          ok: true,
          operation: 'child_app_open',
          requestedMode: input.mode,
        };
      }
    },
    createActivityService(),
  );

  try {
    const result = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {
        presentUi: 'embedded',
        timeoutMs: 1000,
      }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(presentationCalls, [{
      toolId: 'fixture',
      mode: 'embedded',
    }]);
    assert.deepEqual(result.presentation, {
      ok: true,
      operation: 'child_app_open',
      requestedMode: 'embedded',
    });
    const request = fakeWebSocket.sent.find(message => message.method === 'fixture.wait');
    assert.equal(request.params.presentUi, undefined);
    assert.equal(request.params.timeoutMs, 1000);
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('generic Subapp Agent bridge applies a conditional manifest presentation policy', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig({
    mode: 'embedded',
    when: { param: 'action', values: ['open'] },
  })]);
  const presentationCalls = [];
  const service = new bridgeModule.SubappAgentBridgeService(
    createProcessService(),
    {
      async openChildApp(input) {
        presentationCalls.push(input);
        return { ok: true, requestedMode: input.mode };
      }
    },
    createActivityService(),
  );

  try {
    const result = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: { action: 'open' }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(presentationCalls, [{
      toolId: 'fixture',
      mode: 'embedded',
    }]);
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('explicit presentUi none suppresses a manifest presentation policy', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig({
    mode: 'embedded',
    when: { param: 'action', values: ['open'] },
  })]);
  const presentationCalls = [];
  const service = new bridgeModule.SubappAgentBridgeService(
    createProcessService(),
    {
      async openChildApp(input) {
        presentationCalls.push(input);
        return { ok: true };
      }
    },
    createActivityService(),
  );

  try {
    const result = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: { action: 'open', presentUi: 'none' }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(presentationCalls, []);
    const request = fakeWebSocket.sent.find(message => message.method === 'fixture.wait');
    assert.equal(request.params.presentUi, undefined);
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('session leases run manifest cleanup and release the Runtime after the last session', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig(undefined, {
    sessionRelease: {
      method: 'fixture.session.close',
      params: { reason: 'session-ended' },
      timeoutMs: 1000,
    },
  })]);
  const processService = createProcessService();
  const activityService = new bridgeModule.SubappActivityService();
  const service = new bridgeModule.SubappAgentBridgeService(
    processService,
    { openChildApp: async () => ({ ok: true }) },
    activityService,
  );

  try {
    await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {}
    }, undefined, { sessionId: 'chat-a' });
    await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {}
    }, undefined, { sessionId: 'chat-b' });

    const firstRelease = await service.releaseSession('chat-a');
    assert.deepEqual(firstRelease.retainedTools, ['fixture']);
    assert.equal(processService.releaseCount, 0);
    assert.equal(activityService.getActivity('chat-a', 'fixture').runtimeState, 'stopped');
    assert.equal(activityService.getActivity('chat-b', 'fixture').runtimeState, 'ready');

    const finalRelease = await service.releaseSession('chat-b');
    assert.deepEqual(finalRelease.releasedTools, ['fixture']);
    assert.equal(processService.releaseCount, 1);
    assert.equal(activityService.getActivity('chat-b', 'fixture').runtimeState, 'stopped');
    assert.ok(fakeWebSocket.sent.some(message =>
      message.method === 'fixture.session.close'
      && message.params?.reason === 'session-ended'
    ));
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('unexpected shared Runtime close marks every owning session errored and retry restores them', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([
    { open: true, respond: true },
    { open: true, respond: true },
  ]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig()]);
  const activityService = new bridgeModule.SubappActivityService();
  const service = new bridgeModule.SubappAgentBridgeService(
    createProcessService(),
    { openChildApp: async () => ({ ok: true }) },
    activityService,
  );

  try {
    await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {},
    }, undefined, { sessionId: 'chat-a' });
    await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {},
    }, undefined, { sessionId: 'chat-b' });

    fakeWebSocket.instances[0].close();
    await waitUntil(() =>
      activityService.getActivity('chat-a', 'fixture').runtimeState === 'error'
      && activityService.getActivity('chat-b', 'fixture').runtimeState === 'error');

    const retry = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {},
    }, undefined, { sessionId: 'chat-a' });

    assert.equal(retry.ok, true);
    assert.equal(activityService.getActivity('chat-a', 'fixture').runtimeState, 'ready');
    assert.equal(activityService.getActivity('chat-b', 'fixture').runtimeState, 'ready');
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('dock presentation records session activity without opening the full child app', async () => {
  const bridgeModule = await bridgeModulePromise;
  const originalWebSocket = global.WebSocket;
  const fakeWebSocket = createFakeWebSocket([{ open: true, respond: true }]);
  global.WebSocket = fakeWebSocket.WebSocket;
  bridgeModule.replaceChildToolConfigs([fixtureConfig({
    mode: 'dock',
    surface: 'compact',
    autoOpen: 'first-active',
  })]);
  const presentationCalls = [];
  const activityService = new bridgeModule.SubappActivityService();
  const service = new bridgeModule.SubappAgentBridgeService(
    createProcessService(),
    {
      async openChildApp(input) {
        presentationCalls.push(input);
        return { ok: true };
      }
    },
    activityService,
  );

  try {
    const result = await service.execute({
      toolId: 'fixture',
      tool: 'fixture_wait',
      params: {}
    }, undefined, {
      sessionId: 'chat-a',
      toolCallId: 'call-a',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(presentationCalls, []);
    assert.deepEqual(activityService.getActivity('chat-a', 'fixture').presentation, {
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'first-active',
    });
    assert.equal(activityService.getActivity('chat-a', 'fixture').invocationState, 'succeeded');
    assert.equal(activityService.getActivity('chat-a', 'fixture').runtimeState, 'ready');
    assert.equal(activityService.getActivity('chat-a', 'fixture').lastToolCallId, 'call-a');
  } finally {
    service.ngOnDestroy();
    global.WebSocket = originalWebSocket;
  }
});

test('Subapp activity keeps invocation and Runtime state independent across concurrent calls', async () => {
  const bridgeModule = await bridgeModulePromise;
  const activityService = new bridgeModule.SubappActivityService();
  activityService.recordInvocationStarted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    toolName: 'fixture_wait',
    toolCallId: 'call-1',
    now: 100,
  });
  activityService.recordInvocationStarted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    toolName: 'fixture_wait',
    toolCallId: 'call-2',
    now: 101,
  });
  activityService.recordInvocationCompleted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    state: 'failed',
    runtimeState: 'ready',
    error: 'first call failed',
    now: 102,
  });

  assert.deepEqual(
    {
      invocationState: activityService.getActivity('chat-a', 'fixture').invocationState,
      runtimeState: activityService.getActivity('chat-a', 'fixture').runtimeState,
      activeInvocationCount: activityService.getActivity('chat-a', 'fixture').activeInvocationCount,
      invocationCount: activityService.getActivity('chat-a', 'fixture').invocationCount,
    },
    {
      invocationState: 'running',
      runtimeState: 'ready',
      activeInvocationCount: 1,
      invocationCount: 2,
    },
  );
});

test('Subapp activity honors on-error dock auto-open without starting expanded', async () => {
  const bridgeModule = await bridgeModulePromise;
  const activityService = new bridgeModule.SubappActivityService();
  activityService.recordInvocationStarted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    toolName: 'fixture_wait',
    presentation: {
      mode: 'dock',
      surface: 'compact',
      autoOpen: 'on-error',
    },
    now: 100,
  });
  assert.equal(activityService.getActivity('chat-a', 'fixture').surfaceState, 'collapsed');

  activityService.recordInvocationCompleted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    state: 'failed',
    runtimeState: 'ready',
    error: 'fixture failed',
    now: 101,
  });
  assert.equal(activityService.getActivity('chat-a', 'fixture').surfaceState, 'expanded');
});

test('Subapp activity stores a copied bounded-summary projection independently per session', async () => {
  const bridgeModule = await bridgeModulePromise;
  const activityService = new bridgeModule.SubappActivityService();
  activityService.recordInvocationStarted({
    sessionId: 'chat-a',
    toolId: 'fixture',
    toolName: 'fixture_wait',
    now: 100,
  });
  activityService.recordInvocationStarted({
    sessionId: 'chat-b',
    toolId: 'fixture',
    toolName: 'fixture_wait',
    now: 101,
  });

  const input = {
    state: 'active',
    label: 'COM3 · 115200',
    detail: 'Connected',
    badge: 'RX 2.4 KB',
  };
  activityService.recordActivitySummary('chat-a', 'fixture', input);
  input.label = 'mutated';

  assert.equal(activityService.getActivity('chat-a', 'fixture').summary.label, 'COM3 · 115200');
  assert.equal(activityService.getActivity('chat-a', 'fixture').summary.state, 'active');
  assert.equal(activityService.getActivity('chat-b', 'fixture').summary, undefined);
});

test('Subapp activity projects multiple tools per session and release cannot look active', async () => {
  const bridgeModule = await bridgeModulePromise;
  const activityService = new bridgeModule.SubappActivityService();
  const presentation = {
    mode: 'dock',
    surface: 'compact',
    autoOpen: 'always',
  };
  for (const toolId of ['fixture-a', 'fixture-b']) {
    activityService.recordInvocationStarted({
      sessionId: 'chat-a',
      toolId,
      toolName: `${toolId}_wait`,
      presentation,
      now: toolId === 'fixture-a' ? 100 : 101,
    });
    activityService.recordInvocationCompleted({
      sessionId: 'chat-a',
      toolId,
      state: 'succeeded',
      runtimeState: 'ready',
      now: toolId === 'fixture-a' ? 102 : 103,
    });
  }
  activityService.recordInvocationStarted({
    sessionId: 'chat-b',
    toolId: 'fixture-a',
    toolName: 'fixture-a_wait',
    presentation,
    now: 104,
  });
  activityService.recordInvocationCompleted({
    sessionId: 'chat-b',
    toolId: 'fixture-a',
    state: 'succeeded',
    runtimeState: 'ready',
    now: 105,
  });
  activityService.recordActivitySummary('chat-a', 'fixture-a', {
    state: 'active',
    label: 'Fixture A',
    detail: 'Connected',
    badge: '12',
  });

  assert.deepEqual(
    activityService.getSessionActivities('chat-a').map(activity => activity.toolId).sort(),
    ['fixture-a', 'fixture-b'],
  );
  assert.equal(
    activityService.getSessionActivities('chat-a').every(activity => activity.surfaceState === 'expanded'),
    true,
  );

  activityService.releaseSession('chat-a');
  const released = activityService.getSessionActivities('chat-a');
  assert.equal(released.every(activity => activity.runtimeState === 'stopped'), true);
  assert.equal(released.every(activity => activity.activeInvocationCount === 0), true);
  assert.equal(activityService.getActivity('chat-a', 'fixture-a').summary.state, 'idle');
  assert.equal(activityService.getActivity('chat-a', 'fixture-a').summary.badge, '');
  assert.equal(activityService.recordActivitySummary('chat-a', 'fixture-a', {
    state: 'active',
    label: 'stale',
    detail: 'stale',
    badge: 'stale',
  }), null);
  assert.equal(activityService.getActivity('chat-b', 'fixture-a').runtimeState, 'ready');
});

function fixtureConfig(presentation, lifecycle) {
  return {
    id: 'fixture',
    titleKey: 'FIXTURE.TITLE',
    namespace: 'FIXTURE',
    packagePath: '/subapps/fixture',
    agent: {
      protocolVersion: 1,
      transport: 'aily-child-rpc',
      manifestPath: 'agent/tools.json',
      skills: [],
      ...(lifecycle ? { lifecycle } : {}),
      tools: [{
        name: 'fixture_wait',
        description: 'Wait in a fixture Runtime.',
        rpc: { method: 'fixture.wait' },
        permission: 'change',
        supportsCancellation: true,
        timeoutMs: 30000,
        maxTimeoutMs: 60000,
        maxInputBytes: 1024,
        maxOutputBytes: 49152,
        ...(presentation ? { presentation } : {}),
        inputSchema: { type: 'object' }
      }]
    }
  };
}

function createActivityService() {
  return {
    events: [],
    recordInvocationStarted(input) {
      this.events.push({ type: 'started', input });
    },
    recordInvocationCompleted(input) {
      this.events.push({ type: 'completed', input });
    },
    recordRuntimeState(input) {
      this.events.push({ type: 'runtime', input });
    },
    releaseSession(sessionId, error) {
      this.events.push({ type: 'released', input: { sessionId, error } });
    }
  };
}

function createProcessService() {
  return {
    acquireCount: 0,
    releaseCount: 0,
    async acquire() {
      this.acquireCount += 1;
      return { wsUrl: 'ws://fixture.test/ws', url: 'http://fixture.test/' };
    },
    async release() {
      this.releaseCount += 1;
    }
  };
}

function createFakeWebSocket(behaviors) {
  const sent = [];
  const instances = [];
  let connectionIndex = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.listeners = new Map();
      this.behavior = behaviors[connectionIndex++] || { open: true, respond: true };
      instances.push(this);
      queueMicrotask(() => {
        if (this.behavior.open) {
          this.readyState = FakeWebSocket.OPEN;
          this.emit('open', {});
        } else {
          this.emit('error', {});
        }
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    send(value) {
      const message = JSON.parse(String(value));
      sent.push(message);
      if (message.method === 'runtime.request.cancel' || !this.behavior.respond) return;
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          id: message.id,
          ok: true,
          result: { value: 'ok' }
        })
      }));
    }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      queueMicrotask(() => this.emit('close', {}));
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) listener(event);
    }
  }

  return { WebSocket: FakeWebSocket, sent, instances };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for bridge activity');
}

async function loadBridgeModule() {
  const result = await esbuild.build({
    stdin: {
      contents: [
        "export { SubappAgentBridgeService } from './src/app/services/subapp-agent-bridge.service.ts';",
        "export { SubappActivityService } from './src/app/services/subapp-activity.service.ts';",
        "export { replaceChildToolConfigs } from './src/app/configs/tool.config.ts';"
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'subapp-agent-bridge-test-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'angular-service-stubs',
      setup(build) {
        build.onResolve({ filter: /^@angular\/core$/ }, () => ({ path: 'angular-core', namespace: 'stub' }));
        build.onResolve(
          { filter: /(?:child-tool-process|main-ui-automation)\.service$/ },
          args => ({ path: args.path, namespace: 'stub' })
        );
        build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
          contents: args.path === 'angular-core'
            ? 'export function Injectable() { return target => target; }'
            : 'export class StubService {}',
          loader: 'js'
        }));
      }
    }]
  });
  const moduleRecord = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    require,
    moduleRecord,
    moduleRecord.exports
  );
  return moduleRecord.exports;
}
