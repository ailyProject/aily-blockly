'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMainNetworkHostConfiguration, readMainNetworkHostConfiguration, CONFIG_FILE_NAME } = require('./subapp-network-host-config');
const { createMainNetworkNativeChooser } = require('./subapp-network-native-chooser');
const { pathToFileURL } = require('node:url');
const config = () => ({ schemaVersion: 1, kind: 'aily-main-host-network-config', enabled: true, endpoints: [{ endpointId: 'controlled.http', label: 'Controlled HTTP peer', hostname: null, addresses: ['127.0.0.1'], connectAddress: '127.0.0.1', port: 8090, transports: ['tcp'], recordTypes: [], guest: { tcpPort: 8091 } }] });
const parse = value => parseMainNetworkHostConfiguration(Buffer.from(JSON.stringify(value)));
test('normal configuration is versioned optional user-data JSON; absent or explicitly disabled opens nothing', async () => {
    assert.equal(CONFIG_FILE_NAME, 'simulator-network-endpoints.json'); assert.equal(await readMainNetworkHostConfiguration(__filename + '.absent-config'), null);
    assert.equal(parse({ schemaVersion: 1, kind: 'aily-main-host-network-config', enabled: false }), null);
});
test('fixed configuration separates immutable Node endpoint and guest route from chooser presentation', () => {
    const value = config(), result = parse(value); value.endpoints[0].connectAddress = '127.0.0.2';
    assert.equal(result.endpoints[0].connectAddress, '127.0.0.1'); assert(!Object.hasOwn(result.endpoints[0], 'label')); assert(!Object.hasOwn(result.endpoints[0], 'guest'));
    assert.deepEqual(result.routes, [{ endpointId: 'controlled.http', tcpPort: 8091 }]); assert(result.resources[0].detail.includes('127.0.0.1:8090')); assert(result.resources[0].detail.includes('8091')); assert(Object.isFrozen(result.endpoints[0])); assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
});
test('configuration refuses unknown authorization, URL, Core identity and endpoint fields', () => {
    for (const extra of [{ autoGrant: true }, { scope: {} }, { userId: 'pretend' }]) assert.throws(() => parse({ ...config(), ...extra }));
    for (const extra of [{ url: 'https://peer.example' }, { permissionState: 'granted' }]) { const value = config(); Object.assign(value.endpoints[0], extra); assert.throws(() => parse(value)); }
    assert.throws(() => parse({ ...config(), schemaVersion: 2 })); assert.throws(() => parseMainNetworkHostConfiguration(Buffer.alloc(65537)));
});
test('fixed guest routes cannot supply another endpoint, host address or scope', () => {
    for (const extra of [{ endpointId: 'foreign' }, { connectAddress: '127.0.0.2' }, { scope: {} }, { url: 'http://peer' }]) { const value = config(); Object.assign(value.endpoints[0].guest, extra); assert.throws(() => parse(value)); }
    for (const guest of [{}, { tcpPort: 0 }, { tcpPort: 80 }, { tcpPort: 8091, udpPort: 8092 }, { udpPort: 65536 }, { dnsName: 'guest.peer' }]) { const value = config(); value.endpoints[0].guest = guest; assert.throws(() => parse(value)); }
    const udpOnly = config(); udpOnly.endpoints[0].transports = ['udp']; assert.throws(() => parse(udpOnly));
    const defaultAlias = config(); delete defaultAlias.endpoints[0].guest; assert.deepEqual(parse(defaultAlias).routes, [{ endpointId: 'controlled.http', tcpPort: 18080 }]);
});
test('normal configuration relies on the same public inert Node driver for IP/DNS policy', async () => {
    const root = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT;
    const module = root ? await import(pathToFileURL(root + '/packages/simulator-connectivity-node/dist/index.js')) : await import('@aily-project/simulator-connectivity-node');
    const selected = parse(config()), driver = module.createNodeHostNetworkDriver({ endpoints: selected.endpoints });
    assert.equal(driver.snapshot().connections, 0); assert.equal(driver.snapshot().pendingDns, 0); await driver.dispose();
    const malformed = config(); malformed.endpoints[0].connectAddress = 'https://peer.example';
    assert.throws(() => module.createNodeHostNetworkDriver({ endpoints: parse(malformed).endpoints }));
    const rebound = config(); rebound.endpoints[0].connectAddress = '127.0.0.2';
    assert.throws(() => module.createNodeHostNetworkDriver({ endpoints: parse(rebound).endpoints }));
});
const choices = [{ endpointId: 'controlled.http', label: 'Controlled HTTP peer', detail: '127.0.0.1:8090 · TCP' }];
const input = () => ({ title: 'Network', message: 'Select fixed peer', choices, initialSelection: null });
test('native chooser is unavailable without actual normal dialog/window ports', () => {
    assert.equal(createMainNetworkNativeChooser(), null); assert.equal(createMainNetworkNativeChooser({ dialog: {} }), null);
});
test('native chooser always parents Main and passes true AbortSignal with default cancel', async () => {
    const main = { isDestroyed: () => false }, controller = new AbortController(); let call;
    const show = createMainNetworkNativeChooser({ getMainWindow: () => main, dialog: { showMessageBox: async (parent, options) => { call = { parent, options }; return { response: 1 }; } } });
    assert.deepEqual(await show(input(), controller.signal), { outcome: 'selected', endpointId: 'controlled.http' }); assert.equal(call.parent, main); assert.equal(call.options.signal, controller.signal); assert.equal(call.options.defaultId, 0); assert.equal(call.options.cancelId, 0); assert.equal(call.options.buttons[0], '取消'); assert(call.options.detail.includes('127.0.0.1:8090')); assert(!Object.hasOwn(call.options, 'checkboxChecked'));
});
test('native chooser abort or replaced Main discards a late positive click', async () => {
    let resolve; const controller = new AbortController(), original = { isDestroyed: () => false }; let main = original;
    const show = createMainNetworkNativeChooser({ getMainWindow: () => main, dialog: { showMessageBox: () => new Promise(done => { resolve = done; }) } });
    const pending = show(input(), controller.signal); controller.abort(); resolve({ response: 1 }); assert.deepEqual(await pending, { outcome: 'cancelled' });
    const pending2 = show(input(), new AbortController().signal); main = { isDestroyed: () => false }; resolve({ response: 1 }); assert.deepEqual(await pending2, { outcome: 'cancelled' });
});
test('native chooser never selects on cancellation, absent parent or invalid native result', async () => {
    let calls = 0; const show = createMainNetworkNativeChooser({ getMainWindow: () => null, dialog: { showMessageBox: async () => { calls++; return { response: 1 }; } } });
    assert.deepEqual(await show(input(), new AbortController().signal), { outcome: 'cancelled' }); assert.equal(calls, 0);
    const cancel = createMainNetworkNativeChooser({ getMainWindow: () => ({ isDestroyed: () => false }), dialog: { showMessageBox: async () => ({ response: 0 }) } });
    assert.deepEqual(await cancel(input(), new AbortController().signal), { outcome: 'cancelled' });
    const main = { isDestroyed: () => false }, invalid = createMainNetworkNativeChooser({ getMainWindow: () => main, dialog: { showMessageBox: async () => ({ response: 2 }) } });
    await assert.rejects(invalid(input(), new AbortController().signal));
});
