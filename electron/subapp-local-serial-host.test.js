'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SubappLocalSerialHost, monotonicOperationId, monotonicSequence } = require('./subapp-local-serial-host');
const { registerLocalSerialHandlers } = require('./subapp-local-serial-ipc');
const { createInstalledBridge } = require('./subapp-local-serial-ipc');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { authorizeMessagePortSend } = require('./child-tool-session-leases');

const scope = { sessionId: 'session-1', nodeId: 'board-1', clockDomainId: 'clock-1', generation: 1 };
const command = (op, extra = {}, target = scope) => ({ schemaVersion: 1, kind: 'aily-local-serial-command', command: op, scope: target, ...extra });
const envelope = (payload, bindingId = 'binding-1') => ({ toolId: 'simulator', streamId: 'stream-1', bindingId, command: payload });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(options = {}) {
  let live = true, time = 1000, openCount = 0, revokeCount = 0, confirmCount = 0;
  const bridge = {
    writeProtocols: options.writeProtocols,
    async listPorts() { return [{ path: '/dev/private-board', manufacturer: 'Test board', vendorId: '1234' }]; },
    async open(input) { openCount++; await options.openGate?.promise; return { handleId: 'native-secret',
      ...(input.writeProtocol && !options.omitWriteProtocol ? { writeProtocol: input.writeProtocol } : {}) }; },
    async read() { return { records: [{ sequence: 1, dataBase64: 'AAH/', dataByteLength: 3 }], nextSequence: 1, hasMore: false, droppedBytes: 0, state: 'open' }; },
    async write(input) { if (options.writeError) throw options.writeError; return { operationId: input.operationId, acceptedBytes: input.dataByteLength }; },
    async close() { if (options.closeError) throw options.closeError; return { state: 'closed' }; },
    async status() { return { state: 'open', bufferedBytes: 0, droppedBytes: 0, nextSequence: 1 }; },
    async revokeOwner() { revokeCount++; if (options.revokeError) throw options.revokeError; },
    async dispose() {},
  };
  const host = new SubappLocalSerialHost({ authorize(event, input) {
    if (event.sender.id !== 1 || !['binding-1', 'binding-2'].includes(input.bindingId)) throw Error('forbidden');
    return () => { if (!live) throw Error('expired'); };
  }, createBridge: async () => bridge, confirmOpen: async () => { confirmCount++; await options.confirmGate?.promise; return options.grant !== false; },
  now: () => time, idleMs: 1000, onError() {} });
  const event = { sender: { id: 1 } };
  const invoke = (c, binding) => host.invoke(event, envelope(c, binding));
  const open = async (extra = {}) => {
    const listed = await invoke(command('list'));
    const result = await invoke(command('open', { deviceId: listed.devices[0].deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', ...extra }));
    assert.equal(result.ok, true); return result.handleId;
  };
  return { host, bridge, event, invoke, open, setLive(value) { live = value; }, setTime(value) { time = value; },
    get openCount() { return openCount; }, get revokeCount() { return revokeCount; }, get confirmCount() { return confirmCount; } };
}

test('only explicit grant opens, paths and native handles never cross the IPC result', async () => {
  const f = fixture({ grant: false });
  try {
    const listed = await f.invoke(command('list'));
    assert.equal(JSON.stringify(listed).includes('/dev/'), false);
    const result = await f.invoke(command('open', { deviceId: listed.devices[0].deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
    assert.equal(result.errorCode, 'denied'); assert.equal(f.openCount, 0);
  } finally { await f.host.dispose(); }
});

test('opaque handle, binary drain and write metadata stay bound to exact owner scope', async () => {
  const f = fixture();
  try {
    const handleId = await f.open(); assert.notEqual(handleId, 'native-secret');
    const read = await f.invoke(command('read', { handleId, afterSequence: 0, maxBytes: 4096, maxRecords: 32 }));
    assert.deepEqual(read.records, [{ sequence: 1, dataBase64: 'AAH/', dataByteLength: 3 }]);
    const write = await f.invoke(command('write', { handleId, operationId: 'write-1', dataBase64: 'AAH/', dataByteLength: 3 }));
    assert.equal(write.acceptedBytes, 3);
    assert.equal((await f.invoke(command('status', { handleId }), 'binding-2')).errorCode, 'revoked');
    assert.equal((await f.invoke(command('status', { handleId }, { ...scope, generation: 2 }))).errorCode, 'revoked');
    await f.invoke(command('close', { handleId }));
    assert.equal((await f.invoke(command('status', { handleId }))).errorCode, 'revoked');
  } finally { await f.host.dispose(); }
});

test('invalid framing, oversize, raw paths and unknown keys cannot reach backend', async () => {
  const f = fixture();
  try {
    for (const value of [command('open', { portPath: '/dev/x' }), command('write', { handleId: 'x', operationId: 'x', dataBase64: 'AA==', dataByteLength: 4097 }),
      command('read', { handleId: 'x', afterSequence: 0, maxBytes: 4097, maxRecords: 32 }), { ...command('list'), native: true }]) {
      assert.equal((await f.invoke(value)).ok, false);
    }
    assert.equal(f.openCount, 0); assert.equal(f.host.owners.size, 0);
  } finally { await f.host.dispose(); }
});

test('revoke fences a pending real open, joins cleanup and never republishes its late handle', async () => {
  const gate = deferred(), f = fixture({ openGate: gate });
  try {
    const listed = await f.invoke(command('list'));
    const opening = f.invoke(command('open', { deviceId: listed.devices[0].deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
    await new Promise(resolve => setImmediate(resolve));
    const revoking = f.invoke(command('revoke')); gate.resolve();
    assert.equal((await opening).errorCode, 'revoked'); assert.equal((await revoking).ok, true);
    assert.equal(f.host.owners.size, 0); assert.ok(f.revokeCount >= 1);
  } finally { gate.resolve(); await f.host.dispose(); }
});

test('failed physical cleanup remains fenced and can retry on original owner', async () => {
  const options = {}, f = fixture(options);
  try {
    await f.open(); options.revokeError = Error('native path must not escape /dev/private-board');
    const result = await f.invoke(command('revoke'));
    assert.equal(result.errorCode, 'io-error'); assert.equal(JSON.stringify(result).includes('/dev'), false);
    assert.equal(f.host.owners.size, 1);
    assert.equal((await f.invoke(command('list'))).ok, false);
    options.revokeError = null;
    assert.equal((await f.invoke(command('revoke'))).ok, true); assert.equal(f.host.owners.size, 0);
  } finally { options.revokeError = null; await f.host.dispose(); }
});

test('idle expiry, renderer revocation and runtime revocation close only owned resources', async () => {
  const f = fixture();
  try {
    await f.open(); f.setTime(2001); await f.host.expire(); assert.equal(f.host.owners.size, 0);
    await f.open(); await f.host.revokeSender(2); assert.equal(f.host.owners.size, 1);
    await f.host.revokeRuntime('stream-1'); assert.equal(f.host.owners.size, 0);
    await f.open(); await f.host.revokeBinding(1, envelope(command('revoke'))); assert.equal(f.host.owners.size, 0);
  } finally { await f.host.dispose(); }
});

test('real IPC registration uses current Main frame and existing exact message-controller guard', async () => {
  const handlers = new Map(), frame = {}, sender = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const session = { streamId: 'stream-1', messagePort: {}, providerMessageController: { ownerId: 1, bindingId: 'binding-1' } };
  let calls = 0, installed;
  const host = registerLocalSerialHandlers({ ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    getMainWindow: () => ({ webContents: sender, isDestroyed: () => false }), installHost(value) { installed = value; },
    requireController(ownerId, input) { if (!authorizeMessagePortSend(session, ownerId, input).success) throw Error('denied'); },
    createBridge: async () => ({ async listPorts() { calls++; return []; }, async revokeOwner() {}, async dispose() {} }), confirmOpen: async () => false });
  try {
    assert.equal(installed, host);
    const invoke = (event, c = command('list')) => handlers.get('subapp-local-serial')(event, envelope(c));
    assert.equal((await invoke({ sender, senderFrame: {} })).errorCode, 'denied');
    assert.equal((await invoke({ sender: { ...sender, id: 2 }, senderFrame: frame })).errorCode, 'denied');
    assert.equal(calls, 0);
    assert.equal((await invoke({ sender, senderFrame: frame })).ok, true); assert.equal(calls, 1);
    session.providerMessageController = { ownerId: 1, bindingId: 'replacement' };
    assert.equal((await invoke({ sender, senderFrame: frame })).errorCode, 'denied');
    await host.revokeRuntime('stream-1');
  } finally { await host.dispose(); }
});

test('normal installed entry retains failed acquisition cleanup and package holder until retry succeeds', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'serial-installed-contract-')); let released = 0;
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@aily-project/subapp-serial-debugger', version: '1.0.0',
      ailySubapp: { runtime: { localSerialBackend: { kind: 'aily-local-serial-backend', apiVersion: 1, entry: 'local-serial-backend.cjs' } } } }));
    // Invalid acquired shape plus failed first disposer must remain owned.
    await fs.writeFile(path.join(root, 'local-serial-backend.cjs'), "let attempts=0;module.exports={LOCAL_SERIAL_BRIDGE_API_VERSION:1,createSessionSerialBridge(){return{async dispose(){if(++attempts===1)throw Error('cleanup failed');}}}};");
    const bridge = await createInstalledBridge(async input => {
      assert.deepEqual(input, { id: 'serial-debugger', deferPreparedUpdate: true });
      return { config: { catalogId: 'serial-debugger', packageName: '@aily-project/subapp-serial-debugger', packagePath: root, version: '1.0.0' }, release() { released++; } };
    });
    assert.equal(released, 0);
    await assert.rejects(bridge.listPorts(), error => error.code === 'BRIDGE_UNAVAILABLE');
    await bridge.revokeOwner('original-owner'); assert.equal(released, 1);
    await bridge.dispose(); assert.equal(released, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('normal installed admission rejects unknown profiles and path escapes before loading code', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'serial-installed-escape-')); let released = 0;
  try {
    const config = { catalogId: 'serial-debugger', packageName: '@aily-project/subapp-serial-debugger', packagePath: root, version: '1.0.0' };
    const prepare = async () => ({ config, release() { released++; } });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: config.packageName, version: config.version }));
    await assert.rejects(createInstalledBridge(prepare), /capability/u); assert.equal(released, 1);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: config.packageName, version: config.version,
      ailySubapp: { runtime: { localSerialBackend: { kind: 'aily-local-serial-backend', apiVersion: 1, entry: 'local-serial-backend.cjs' } } } }));
    await fs.symlink(path.join(root, '..', 'not-allowed'), path.join(root, 'local-serial-backend.cjs'));
    await assert.rejects(createInstalledBridge(prepare)); assert.equal(released, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const action of ['close', 'revoke']) test(`${action} cancels a pending native write before joining it, with no replay or late success`, async () => {
  const f = fixture(), entered = deferred(), finish = deferred(); let writes = 0, cancelled = false;
  try {
    const handleId = await f.open();
    f.bridge.write = async () => { writes++; entered.resolve(); await finish.promise; return { acceptedBytes: 1 }; };
    const previous = f.bridge[action === 'close' ? 'close' : 'revokeOwner'];
    f.bridge[action === 'close' ? 'close' : 'revokeOwner'] = async (...args) => {
      cancelled = true; finish.resolve(); return await previous(...args);
    };
    const writing = f.invoke(command('write', { handleId, operationId: 'single', dataBase64: 'AQ==', dataByteLength: 1 }));
    await entered.promise;
    const result = await f.invoke(command(action, action === 'close' ? { handleId } : {}));
    assert.equal(cancelled, true); assert.equal(result.ok, true);
    const late = await writing;
    assert.equal(late.ok, false); assert.ok(['delivery-unknown', 'revoked'].includes(late.errorCode)); assert.equal(writes, 1);
  } finally { finish.resolve(); await f.host.dispose(); }
});

test('revoke fences an outstanding native-confirmation callback before it can open any serial device', async () => {
  const confirmGate = deferred(), f = fixture({ confirmGate });
  try {
    const listed = await f.invoke(command('list'));
    const opening = f.invoke(command('open', { deviceId: listed.devices[0].deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
    await new Promise(resolve => setImmediate(resolve));
    const revoke = f.invoke(command('revoke'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.openCount, 0); assert.ok(f.revokeCount > 0);
    confirmGate.resolve(true);
    assert.equal((await opening).errorCode, 'revoked'); assert.equal((await revoke).ok, true); assert.equal(f.openCount, 0);
    const fresh = await f.invoke(command('list'));
    assert.notEqual(fresh.devices[0].deviceId, listed.devices[0].deviceId);
    const stale = await f.invoke(command('open', { deviceId: listed.devices[0].deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' }));
    assert.equal(stale.errorCode, 'denied'); assert.equal(f.openCount, 0);
  } finally { confirmGate.resolve(); await f.host.dispose(); }
});

test('Main inventory uses the same 128-device maximum as the public serial result schema', async () => {
  const f = fixture();
  try {
    f.bridge.listPorts = async () => ({ ports: Array.from({ length: 129 }, (_, i) => ({ portPath: `/dev/test-${i}` })) });
    const value = await f.invoke(command('list'));
    assert.equal(value.ok, false); assert.equal(value.errorCode, 'unavailable'); assert.equal(f.openCount, 0);
  } finally { await f.host.dispose(); }
});

const orderedOpen = { writeProtocol: 'monotonic-v1' };
const openCommand = deviceId => command('open', { deviceId, baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', ...orderedOpen });

test('explicit streaming capability is required before confirmation or native open', async () => {
  const f = fixture();
  try {
    const listed = await f.invoke(command('list'));
    const result = await f.invoke(openCommand(listed.devices[0].deviceId));
    assert.equal(result.errorCode, 'unsupported'); assert.equal(f.openCount, 0); assert.equal(f.confirmCount, 0);
    const legacy = await f.open(); assert.ok(legacy); assert.equal(f.openCount, 1);
  } finally { await f.host.dispose(); }
});

test('8193 same-handle writes rewrite public identity to native identity and echo only public identity', async () => {
  const f = fixture({ writeProtocols: ['monotonic-v1'] }); let calls = 0;
  try {
    const handleId = await f.open(orderedOpen);
    f.bridge.write = async input => {
      calls++; assert.equal(input.operationId, monotonicOperationId('native-secret', calls));
      return { operationId: input.operationId, acceptedBytes: input.dataByteLength };
    };
    for (let sequence = 1; sequence <= 8193; sequence++) {
      const operationId = monotonicOperationId(handleId, sequence);
      const value = await f.invoke(command('write', { handleId, operationId, dataBase64: Buffer.from([sequence & 255]).toString('base64'), dataByteLength: 1 }));
      assert.equal(value.ok, true); assert.equal(value.operationId, operationId); assert.equal(value.acceptedBytes, 1);
      assert.equal(JSON.stringify(value).includes('native-secret'), false);
    }
    assert.equal(calls, 8193);
    for (const operationId of ['monotonic-v1:another-handle:8194', `monotonic-v1:${handleId}:08194`, `monotonic-v1:${handleId}:9007199254740992`]) {
      const value = await f.invoke(command('write', { handleId, operationId, dataBase64: 'AQ==', dataByteLength: 1 }));
      assert.equal(value.errorCode, 'invalid-input');
    }
    assert.equal(calls, 8193);
    await f.invoke(command('close', { handleId }));
    const next = await f.open(orderedOpen); assert.notEqual(next, handleId);
    const stale = await f.invoke(command('write', { handleId: next, operationId: monotonicOperationId(handleId, 8194), dataBase64: 'AQ==', dataByteLength: 1 }));
    assert.equal(stale.errorCode, 'invalid-input'); assert.equal(calls, 8193);
  } finally { await f.host.dispose(); }
});

test('canonical monotonic parser retains colons in full handle and rejects unsafe counters', () => {
  const handleId = 'serial-handle:native:nonce';
  for (const sequence of [1, 4097, 8193, Number.MAX_SAFE_INTEGER]) {
    assert.equal(monotonicSequence(monotonicOperationId(handleId, sequence), handleId), sequence);
  }
  for (const suffix of ['0', '-1', '01', '+1', '1e3', '1:2', '9007199254740992']) {
    assert.throws(() => monotonicSequence(`monotonic-v1:${handleId}:${suffix}`, handleId));
  }
});

for (const closeFails of [false, true]) test(`negotiation ACK mismatch captures and closes owned native resource (cleanup failure ${closeFails})`, async () => {
  const options = { writeProtocols: ['monotonic-v1'], omitWriteProtocol: true, closeError: closeFails ? Error('native close failed') : null };
  const f = fixture(options); let closes = 0;
  const close = f.bridge.close; f.bridge.close = async input => { closes++; assert.equal(input.handleId, 'native-secret'); return close(input); };
  try {
    const listed = await f.invoke(command('list'));
    const result = await f.invoke(openCommand(listed.devices[0].deviceId));
    assert.equal(result.errorCode, closeFails ? 'io-error' : 'unsupported'); assert.equal(f.openCount, 1); assert.equal(closes, 1);
    assert.equal([...f.host.owners.values()][0].handles.size, closeFails ? 1 : 0);
    if (closeFails) assert.equal([...f.host.owners.values()][0].handles.values().next().value.fenced, true);
    options.closeError = null;
    assert.equal((await f.invoke(command('revoke'))).ok, true); assert.equal(f.host.owners.size, 0);
  } finally { options.closeError = null; await f.host.dispose(); }
});

for (const receipt of [undefined, {}, { acceptedBytes: 1, operationId: 'wrong' }, { acceptedBytes: 0, operationId: 'legacy' }]) {
  test(`invalid write receipt fences without replay: ${JSON.stringify(receipt)}`, async () => {
    const f = fixture(); let calls = 0;
    try {
      const handleId = await f.open(); f.bridge.write = async () => { calls++; return receipt; };
      const write = () => f.invoke(command('write', { handleId, operationId: 'legacy', dataBase64: 'AQ==', dataByteLength: 1 }));
      assert.equal((await write()).errorCode, 'delivery-unknown');
      assert.equal((await write()).errorCode, 'revoked'); assert.equal(calls, 1);
      assert.equal((await f.invoke(command('close', { handleId }))).ok, true);
    } finally { await f.host.dispose(); }
  });
}

for (const code of ['BRIDGE_DELIVERY_UNKNOWN', 'BRIDGE_IO_ERROR', undefined]) test(`uncertain native write error fences ${code || 'untyped'}`, async () => {
  const f = fixture({ writeError: Object.assign(Error('native error'), code ? { code } : {}) });
  try {
    const handleId = await f.open();
    const input = command('write', { handleId, operationId: 'single', dataBase64: 'AQ==', dataByteLength: 1 });
    assert.equal((await f.invoke(input)).errorCode, 'delivery-unknown');
    assert.equal((await f.invoke(input)).errorCode, 'revoked');
  } finally { await f.host.dispose(); }
});

for (const metadata of [undefined, ['monotonic-v1']]) test(`installed factory intersects trusted metadata and actual feature (${JSON.stringify(metadata)})`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'serial-installed-ordered-')); let released = 0;
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@aily-project/subapp-serial-debugger', version: '0.1.13',
      ailySubapp: { runtime: { localSerialBackend: { kind: 'aily-local-serial-backend', apiVersion: 1, entry: 'local-serial-backend.cjs', ...(metadata ? { writeProtocols: metadata } : {}) } } } }));
    await fs.writeFile(path.join(root, 'local-serial-backend.cjs'), `module.exports={LOCAL_SERIAL_BRIDGE_API_VERSION:1,createSessionSerialBridge(){return {apiVersion:1,writeProtocols:Object.freeze(['monotonic-v1']),${['execute','listPorts','open','read','write','close','status','revokeOwner','dispose'].map(method=>`async ${method}(){}`).join(',')}}}};`);
    const bridge = await createInstalledBridge(async () => ({ config: { catalogId: 'serial-debugger', packageName: '@aily-project/subapp-serial-debugger', version: '0.1.13', packagePath: root }, release() { released++; } }));
    assert.deepEqual(bridge.writeProtocols, metadata || []); assert.equal(Object.isFrozen(bridge.writeProtocols), true);
    await bridge.dispose(); assert.equal(released, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('installed metadata/runtime capability mismatch disposes acquired resource and releases holder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'serial-installed-mismatch-')); let released = 0;
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@aily-project/subapp-serial-debugger', version: '0.1.13',
      ailySubapp: { runtime: { localSerialBackend: { kind: 'aily-local-serial-backend', apiVersion: 1, entry: 'local-serial-backend.cjs', writeProtocols: ['monotonic-v1'] } } } }));
    const entry = path.join(root, 'local-serial-backend.cjs');
    await fs.writeFile(entry, "module.exports={disposed:0,LOCAL_SERIAL_BRIDGE_API_VERSION:1,createSessionSerialBridge(){return{apiVersion:1,async dispose(){module.exports.disposed++}}}};");
    await assert.rejects(createInstalledBridge(async () => ({ config: { catalogId: 'serial-debugger', packageName: '@aily-project/subapp-serial-debugger', version: '0.1.13', packagePath: root }, release() { released++; } })), /capability/u);
    assert.equal(require(entry).disposed, 1); assert.equal(released, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
