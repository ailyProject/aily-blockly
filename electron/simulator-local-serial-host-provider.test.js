'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const loaded = esbuild.build({ entryPoints: [path.join(root, 'src/app/integrations/simulator/simulator-local-serial-host-provider.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' }).then(result => {
  const filename = path.join(__dirname, 'serial-provider-test.cjs');
  const compiled = new Module(filename, module); compiled.filename = filename; compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename); return compiled.exports;
});
const scope = { sessionId: 'session-1', nodeId: 'board-1', clockDomainId: 'clock-1', generation: 1 };
const command = (op, extra = {}) => ({ schemaVersion: 1, kind: 'aily-local-serial-command', command: op, scope, ...extra });
const invocation = payload => ({ schemaVersion: 1, kind: 'aily-simulator-subapp-host-provider-invocation', invocationId: `provider-invocation-v1-${'1'.repeat(64)}`,
  provider: 'hardware', providerRevision: 1, protocolVersion: 1, capability: 'hardware.serial', deadlineUnixMs: Date.now() + 10000, payload });
const result = (input, fields) => ({ schemaVersion: 1, kind: 'aily-local-serial-result', command: input.command, scope: input.scope, ok: true, ...fields });
const context = signal => ({ signal, publishEvent: async () => false });

test('hardware negotiates separately and validates a bounded binary exchange with no project authority', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded; const calls = [];
  const adapter = createSimulatorLocalSerialHostProvider(async input => { calls.push(input); return result(input, input.command === 'revoke'
    ? { state: 'revoked', closedHandles: 0 } : { devices: [] }); });
  assert.equal(adapter.provider, 'hardware'); assert.deepEqual(adapter.capabilities, ['hardware.serial']);
  const output = await adapter.handleInvocation(invocation(command('list')), context(new AbortController().signal));
  assert.equal(output.result.status, 'succeeded'); assert.deepEqual(output.result.payload.devices, []);
  assert.equal(JSON.stringify(calls).includes('projectIdentity'), false);
  await adapter.close(); assert.equal(calls.at(-1).command, 'revoke');
});

test('foreign-scope native responses fail shared exchange validation', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded;
  const adapter = createSimulatorLocalSerialHostProvider(async input => input.command === 'revoke' ? result(input, { state: 'revoked', closedHandles: 0 })
    : { ...result(input, { devices: [] }), scope: { ...scope, generation: 2 } });
  await assert.rejects(adapter.handleInvocation(invocation(command('list')), context(new AbortController().signal)), /scope/u);
  await adapter.close();
});

test('cancellation revokes late acquisition and never reports it succeeded', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded; let resolve, calls = [];
  const gate = new Promise(r => { resolve = r; });
  const adapter = createSimulatorLocalSerialHostProvider(async input => { calls.push(input.command);
    if (input.command === 'revoke') return result(input, { state: 'revoked', closedHandles: 0 });
    await gate; return result(input, { devices: [] }); });
  const abort = new AbortController();
  const pending = adapter.handleInvocation(invocation(command('list')), context(abort.signal));
  await new Promise(r => setImmediate(r)); abort.abort(); resolve();
  assert.equal((await pending).result.errorCode, 'cancelled'); assert.deepEqual(calls, ['list', 'revoke']);
  await adapter.close();
});

test('failed cleanup is retained for retry and an old provider cannot dispatch new hardware work', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded; let fail = true, revokes = 0;
  const adapter = createSimulatorLocalSerialHostProvider(async input => {
    if (input.command !== 'revoke') return result(input, { devices: [] });
    revokes++; return fail ? { ...result(input, {}), ok: false, errorCode: 'io-error' } : result(input, { state: 'revoked', closedHandles: 0 });
  });
  await adapter.handleInvocation(invocation(command('list')), context(new AbortController().signal));
  await assert.rejects(adapter.close(), /cleanup/u); fail = false; await adapter.close();
  assert.equal(revokes, 2);
  assert.equal((await adapter.handleInvocation(invocation(command('list')), context(new AbortController().signal))).result.errorCode, 'cancelled');
});

test('rejected distinct scopes cannot grow the cleanup ledger beyond Main capacity', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded; let calls = 0, revokes = 0;
  const adapter = createSimulatorLocalSerialHostProvider(async input => {
    if (input.command === 'revoke') { revokes++; return result(input, { state: 'revoked', closedHandles: 0 }); }
    calls++; return { ...result(input, {}), ok: false, errorCode: 'busy' };
  });
  for (let generation = 0; generation < 100; generation++) {
    const response = await adapter.handleInvocation(invocation({ ...command('list'), scope: { ...scope, generation } }), context(new AbortController().signal));
    assert.equal(response.result.status, generation < 64 ? 'succeeded' : 'failed');
  }
  assert.equal(calls, 64); await adapter.close(); assert.equal(revokes, 64);
});

test('negotiated streaming open crosses shared HostProvider with exact capability echo', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded;
  const adapter = createSimulatorLocalSerialHostProvider(async input => result(input, input.command === 'revoke'
    ? { state: 'revoked', closedHandles: 0 } : { handleId: 'public:handle:nonce', state: 'open', nextSequence: 0, writeProtocol: 'monotonic-v1' }));
  const open = command('open', { deviceId: 'opaque-device', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', writeProtocol: 'monotonic-v1' });
  try {
    const output = await adapter.handleInvocation(invocation(open), context(new AbortController().signal));
    assert.equal(output.result.status, 'succeeded'); assert.equal(output.result.payload.writeProtocol, 'monotonic-v1');
  } finally { await adapter.close(); }
});

test('shared HostProvider rejects missing negotiation echo but retains scope for explicit cleanup', async () => {
  const { createSimulatorLocalSerialHostProvider } = await loaded; let revokes = 0;
  const adapter = createSimulatorLocalSerialHostProvider(async input => {
    if (input.command === 'revoke') { revokes++; return result(input, { state: 'revoked', closedHandles: 1 }); }
    return result(input, { handleId: 'public:handle:nonce', state: 'open', nextSequence: 0 });
  });
  try {
    await assert.rejects(adapter.handleInvocation(invocation(command('open', { deviceId: 'opaque-device', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', writeProtocol: 'monotonic-v1' })), context(new AbortController().signal)), /negotiated/u);
  } finally { await adapter.close(); }
  assert.equal(revokes, 1);
});
