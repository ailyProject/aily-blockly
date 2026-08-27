const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const dispatcherModulePromise = loadDispatcherModule();

test('negotiates a catalog assembled from five product-neutral adapters', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-1',
    adapters: fixture.adapters,
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);

  await transport.receive({
    type: types.negotiationRequest,
    version: 1,
    request: negotiationRequest('catalog-request-1'),
  });
  const catalogMessage = await transport.waitFor(
    message => message.type === types.catalog,
  );

  assert.equal(catalogMessage.requestId, 'catalog-request-1');
  assert.equal(catalogMessage.catalog.hostInstanceId, 'host-fixture-1');
  assert.deepEqual(
    catalogMessage.catalog.providers.map(offer => offer.provider),
    ['project', 'build', 'editor', 'agent', 'entitlement'],
  );
  assert.deepEqual(
    catalogMessage.catalog.providers.find(offer => offer.provider === 'project').capabilities,
    ['project.artifact.read', 'project.context.read'],
  );
  await dispatcher.close();
});

test('negotiates an empty catalog when the product has no active project binding', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-standalone',
    adapters: [],
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);

  await transport.receive({
    type: types.negotiationRequest,
    version: 1,
    request: negotiationRequest('standalone-catalog-request'),
  });
  const catalogMessage = await transport.waitFor(
    message => message.type === types.catalog,
  );

  assert.equal(catalogMessage.requestId, 'standalone-catalog-request');
  assert.equal(catalogMessage.catalog.hostInstanceId, 'host-fixture-standalone');
  assert.deepEqual(catalogMessage.catalog.providers, []);
  await dispatcher.close();
});

test('routes invocations to each adapter without importing product payloads', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-2',
    adapters: fixture.adapters,
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);

  const invocations = [
    ['project', 'project.context.read'],
    ['build', 'build.artifact.request'],
    ['editor', 'editor.source-location.reveal'],
    ['agent', 'agent.scene.propose'],
    ['entitlement', 'entitlement.lease.request'],
  ];
  for (const [index, [provider, capability]] of invocations.entries()) {
    const invocationId = `invoke-${index + 1}`;
    await transport.receive({
      type: types.invocation,
      version: 1,
      invocation: invocation(invocationId, provider, capability),
    });
    const result = await transport.waitFor(
      message => message.type === types.result
        && message.invocationId === invocationId,
    );
    assert.equal(result.result.provider, provider);
    assert.equal(result.result.capability, capability);
    assert.equal(result.result.payload.echo, provider);
  }

  assert.deepEqual(
    fixture.calls.map(call => call.provider),
    ['project', 'build', 'editor', 'agent', 'entitlement'],
  );
  assert.equal(dispatcher.snapshot().activeInvocations, 0);
  await dispatcher.close();
});

test('keeps subscription events routed and cancellation aborts the exact invocation', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-3',
    adapters: fixture.adapters,
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);

  await transport.receive({
    type: types.invocation,
    version: 1,
    invocation: invocation(
      'subscribe-build-1',
      'build',
      'build.progress.subscribe',
    ),
  });
  await transport.waitFor(
    message => message.type === types.result
      && message.invocationId === 'subscribe-build-1',
  );
  const earlyEvent = await transport.waitFor(
    message => message.type === types.event
      && message.subscriptionId === 'subscription-build-1'
      && message.event.sequence === 0,
  );
  const resultIndex = transport.sent.findIndex(
    message => message.type === types.result
      && message.invocationId === 'subscribe-build-1',
  );
  assert.ok(resultIndex < transport.sent.indexOf(earlyEvent));
  assert.equal(dispatcher.snapshot().activeSubscriptions, 1);

  const eventPublished = await fixture.publishByInvocation
    .get('subscribe-build-1')('subscription-build-1', {
      kind: 'fixture-progress',
      sequence: 1,
    });
  assert.equal(eventPublished, true);
  const eventMessage = await transport.waitFor(
    message => message.type === types.event
      && message.subscriptionId === 'subscription-build-1'
      && message.event.sequence === 1,
  );
  assert.equal(eventMessage.event.sequence, 1);

  await transport.receive({
    type: types.cancel,
    version: 1,
    invocationId: 'subscribe-build-1',
  });
  await waitFor(() => fixture.aborted.has('subscribe-build-1'));
  assert.equal(dispatcher.snapshot().activeSubscriptions, 0);
  assert.equal(
    await dispatcher.publishEvent('subscription-build-1', {
      kind: 'late-event',
    }),
    false,
  );

  await transport.receive({
    type: types.invocation,
    version: 1,
    invocation: invocation(
      'pending-agent-1',
      'agent',
      'agent.pending',
    ),
  });
  await waitFor(() => fixture.calls.some(
    call => call.invocationId === 'pending-agent-1',
  ));
  await transport.receive({
    type: types.cancel,
    version: 1,
    invocationId: 'pending-agent-1',
  });
  await waitFor(() => fixture.aborted.has('pending-agent-1'));
  assert.equal(
    transport.sent.some(message => message.invocationId === 'pending-agent-1'),
    false,
  );
  await dispatcher.close();
});

test('routes bounded artifact chunks through the single declared reader', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-4',
    adapters: fixture.adapters,
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);

  await transport.receive({
    type: types.artifactChunkRequest,
    version: 1,
    request: {
      transferId: 'transfer-1',
      deadlineUnixMs: Date.now() + 10_000,
      path: 'firmware.bin',
      offsetBytes: 0,
      maxBytes: 1024,
    },
  });
  const result = await transport.waitFor(
    message => message.type === types.artifactChunkResult
      && message.transferId === 'transfer-1',
  );
  assert.deepEqual(result.result, {
    transferId: 'transfer-1',
    status: 'succeeded',
    dataBase64: 'Zml4dHVyZQ==',
  });
  assert.deepEqual(fixture.artifactReads, ['transfer-1']);
  await dispatcher.close();
});

test('expired invocations fail once without entering a domain adapter', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-deadline',
    adapters: fixture.adapters,
    now: () => 5000,
  });
  const transport = new FakeTransport();
  dispatcher.bindTransport(transport);
  const expired = invocation(
    'expired-project-1',
    'project',
    'project.context.read',
  );
  expired.deadlineUnixMs = 4999;

  await transport.receive({
    type: types.invocation,
    version: 1,
    invocation: expired,
  });
  const failure = await transport.waitFor(
    message => message.type === types.result
      && message.invocationId === 'expired-project-1',
  );
  assert.equal(failure.result.errorCode, 'deadline-exceeded');
  assert.equal(
    transport.sent.filter(
      message => message.invocationId === 'expired-project-1',
    ).length,
    1,
  );
  assert.equal(fixture.calls.length, 0);
  await dispatcher.close();
});

test('transport replacement aborts old work and only the new owner can respond', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const fixture = createFixtureAdapters();
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-5',
    adapters: fixture.adapters,
  });
  const oldTransport = new FakeTransport();
  const newTransport = new FakeTransport();
  dispatcher.bindTransport(oldTransport);

  await oldTransport.receive({
    type: types.invocation,
    version: 1,
    invocation: invocation('pending-agent-rebind', 'agent', 'agent.pending'),
  });
  await waitFor(() => fixture.calls.some(
    call => call.invocationId === 'pending-agent-rebind',
  ));
  dispatcher.bindTransport(newTransport);
  await waitFor(() => fixture.aborted.has('pending-agent-rebind'));

  await oldTransport.receive({
    type: types.negotiationRequest,
    version: 1,
    request: negotiationRequest('old-owner-request'),
  });
  await flushAsync();
  assert.equal(oldTransport.sent.length, 0);

  await newTransport.receive({
    type: types.negotiationRequest,
    version: 1,
    request: negotiationRequest('new-owner-request'),
  });
  const catalog = await newTransport.waitFor(
    message => message.type === types.catalog,
  );
  assert.equal(catalog.requestId, 'new-owner-request');
  assert.equal(dispatcher.snapshot().activeInvocations, 0);
  await dispatcher.close();
});

test('generic Child Tool transport binds dispatcher messages to one declared tool ID', async () => {
  const {
    SUBAPP_HOST_PROVIDER_MESSAGE_TYPES: types,
    SubappHostProviderDispatcher,
  } = await dispatcherModulePromise;
  const {
    createSubappHostProviderChildToolTransport,
  } = await loadChildToolTransportModule();
  const fixture = createFixtureAdapters();
  const sent = [];
  let listener = null;
  const bridge = {
    onMessage(toolId, nextListener) {
      assert.equal(toolId, 'fixture-tool');
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    async sendMessage(toolId, message) {
      assert.equal(toolId, 'fixture-tool');
      sent.push(structuredClone(message));
    },
  };
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: 'host-fixture-6',
    adapters: fixture.adapters,
  });
  dispatcher.bindTransport(
    createSubappHostProviderChildToolTransport('fixture-tool', bridge),
  );

  listener({
    type: types.negotiationRequest,
    version: 1,
    request: negotiationRequest('child-tool-request'),
  });
  await waitFor(() => sent.some(message => message.type === types.catalog));
  assert.equal(sent[0].requestId, 'child-tool-request');
  await dispatcher.close();
  assert.equal(listener, null);
});

function createFixtureAdapters() {
  const calls = [];
  const aborted = new Set();
  const publishByInvocation = new Map();
  const artifactReads = [];
  const offers = [
    ['project', ['project.artifact.read', 'project.context.read']],
    ['build', ['build.artifact.request', 'build.progress.subscribe']],
    ['editor', ['editor.debug-location.publish', 'editor.source-location.reveal']],
    ['agent', ['agent.pending', 'agent.scene.propose']],
    ['entitlement', ['entitlement.lease.request', 'entitlement.status.subscribe']],
  ];
  const adapters = offers.map(([provider, capabilities]) => {
    const adapter = {
      provider,
      protocolVersions: [1],
      capabilities,
      async handleInvocation(value, context) {
        const invocationId = value.invocationId;
        calls.push({
          invocationId,
          provider,
          capability: value.capability,
        });
        publishByInvocation.set(invocationId, context.publishEvent);
        context.signal.addEventListener(
          'abort',
          () => aborted.add(invocationId),
          { once: true },
        );
        if (value.capability === 'agent.pending') {
          await new Promise((resolve, reject) => {
            context.signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            );
          });
        }
        if (value.capability === 'build.progress.subscribe') {
          await context.publishEvent('subscription-build-1', {
            kind: 'fixture-progress',
            sequence: 0,
          });
        }
        const subscriptionIds = value.capability === 'build.progress.subscribe'
          ? ['subscription-build-1']
          : [];
        return {
          result: successResult(value),
          ...(subscriptionIds.length ? { subscriptionIds } : {}),
        };
      },
      createFailureResult(value, code) {
        return {
          invocationId: value.invocationId,
          provider: value.provider,
          capability: value.capability,
          status: 'failed',
          errorCode: code,
        };
      },
    };
    if (provider === 'project') {
      adapter.readArtifactChunk = async request => {
        artifactReads.push(request.transferId);
        return {
          transferId: request.transferId,
          status: 'succeeded',
          dataBase64: 'Zml4dHVyZQ==',
        };
      };
      adapter.createArtifactChunkFailureResult = (request, code) => ({
        transferId: request.transferId,
        status: 'failed',
        errorCode: code,
      });
    }
    return adapter;
  });
  return {
    adapters,
    calls,
    aborted,
    publishByInvocation,
    artifactReads,
  };
}

function negotiationRequest(requestId) {
  return {
    schemaVersion: 1,
    kind: 'fixture-provider-negotiation-request',
    requestId,
    providers: [
      requirement('project', ['project.context.read']),
      requirement('build', ['build.artifact.request']),
      requirement('editor', ['editor.debug-location.publish']),
      requirement('agent', ['agent.scene.propose']),
      requirement('entitlement', ['entitlement.lease.request']),
    ],
  };
}

function requirement(provider, requiredCapabilities) {
  return {
    provider,
    protocolVersions: [1],
    requiredCapabilities,
    optionalCapabilities: [],
  };
}

function invocation(invocationId, provider, capability) {
  return {
    schemaVersion: 1,
    kind: 'fixture-provider-invocation',
    invocationId,
    provider,
    providerRevision: 1,
    protocolVersion: 1,
    capability,
    deadlineUnixMs: Date.now() + 10_000,
    payload: { fixture: true },
  };
}

function successResult(value) {
  return {
    invocationId: value.invocationId,
    provider: value.provider,
    providerRevision: value.providerRevision,
    protocolVersion: value.protocolVersion,
    capability: value.capability,
    status: 'succeeded',
    payload: { echo: value.provider },
    errorCode: null,
  };
}

class FakeTransport {
  constructor() {
    this.listener = null;
    this.sent = [];
  }

  onMessage(listener) {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  async send(message) {
    this.sent.push(structuredClone(message));
  }

  async receive(message) {
    this.listener?.(structuredClone(message));
    await flushAsync();
  }

  async waitFor(predicate) {
    await waitFor(() => this.sent.some(predicate));
    return this.sent.find(predicate);
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function flushAsync() {
  await new Promise(resolve => setImmediate(resolve));
}

async function loadDispatcherModule() {
  return await loadTypeScriptModule(
    '../src/app/services/subapp-host-provider-dispatcher.ts',
    'aily-subapp-provider-dispatcher',
  );
}

async function loadChildToolTransportModule() {
  return await loadTypeScriptModule(
    '../src/app/services/subapp-host-provider-child-tool-transport.ts',
    'aily-subapp-provider-child-tool-transport',
  );
}

async function loadTypeScriptModule(relativeEntry, prefix) {
  const outfile = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`,
  );
  await esbuild.build({
    entryPoints: [
      path.resolve(__dirname, relativeEntry),
    ],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  try {
    return require(outfile);
  } finally {
    await fs.rm(outfile, { force: true });
  }
}
