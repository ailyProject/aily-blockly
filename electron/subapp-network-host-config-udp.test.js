'use strict';
// Trusted config + actual inert chooser adapter only; no sockets, DNS or Main.
const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { parseMainNetworkHostConfiguration } = require('./subapp-network-host-config');
const { createMainNetworkEndpointSelection } = require('./subapp-network-endpoint-selection');
const { createMainNetworkNativeChooser } = require('./subapp-network-native-chooser');
const config = () => ({ schemaVersion: 1, kind: 'aily-main-host-network-config', enabled: true,
    endpoints: [{ endpointId: 'fixed-peer', label: 'Fixed local peer', hostname: null, addresses: ['127.0.0.1'],
        connectAddress: '127.0.0.1', port: 65046, transports: ['tcp', 'udp'], recordTypes: [], guest: { tcpPort: 18080, udpPort: 18081 } }] });
const parse = value => parseMainNetworkHostConfiguration(Buffer.from(JSON.stringify(value)));
test('UDP and dual aliases are explicit immutable trusted Main routes, with transport-labelled native details', () => {
    const value = config(), parsed = parse(value);
    assert.deepEqual(parsed.routes, [{ endpointId: 'fixed-peer', tcpPort: 18080, udpPort: 18081 }]);
    assert.match(parsed.resources[0].detail, /TCP 10\.0\.2\.2:18080 \/ UDP 10\.0\.2\.2:18081/);
    assert.equal(parsed.endpoints[0].port, 65046); assert(!Object.hasOwn(parsed.endpoints[0], 'guest'));
    assert(Object.isFrozen(parsed.routes[0])); value.endpoints[0].guest.udpPort = 19000;
    assert.equal(parsed.routes[0].udpPort, 18081);
    const udp = config(); udp.endpoints[0].transports = ['udp']; udp.endpoints[0].guest = { udpPort: 18081 };
    assert.deepEqual(parse(udp).routes, [{ endpointId: 'fixed-peer', udpPort: 18081 }]);
    assert.match(parse(udp).resources[0].detail, /仿真访问 UDP 10\.0\.2\.2:18081$/);
});
test('legacy TCP default and existing explicit TCP metadata remain exactly compatible; UDP never defaults', () => {
    const value = config(); value.endpoints[0].transports = ['tcp']; delete value.endpoints[0].guest;
    const parsed = parse(value);
    assert.deepEqual(parsed.routes, [{ endpointId: 'fixed-peer', tcpPort: 18080 }]);
    assert.equal(parsed.resources[0].detail, '127.0.0.1:65046 · TCP · 仿真访问 10.0.2.2:18080');
    value.endpoints[0].guest = { tcpPort: 18080 };
    assert.deepEqual(parse(value).routes, parsed.routes); assert.deepEqual(parse(value).resources, parsed.resources);
    value.endpoints[0].transports = ['udp']; delete value.endpoints[0].guest; assert.throws(() => parse(value));
});
test('alias requires its configured transport and bounded port, never a Guest Host address, scope or DNS route', () => {
    for (const guest of [{}, { udpPort: 0 }, { udpPort: 80 }, { udpPort: 65536 }, { udpPort: 18081.5 },
        { udpPort: '18081' }, { udpPort: 18081, host: '127.0.0.2' }, { udpPort: 18081, endpointId: 'foreign' },
        { udpPort: 18081, scope: {} }, { udpPort: 18081, connectAddress: '127.0.0.2' }, { dnsName: 'injected.test' }]) {
        const value = config(); value.endpoints[0].guest = guest; assert.throws(() => parse(value));
    }
    for (const [transports, guest] of [[['tcp'], { udpPort: 18081 }], [['udp'], { tcpPort: 18080 }], [['tcp'], { tcpPort: 18080, udpPort: 18081 }]]) {
        const value = config(); Object.assign(value.endpoints[0], { transports, guest }); assert.throws(() => parse(value));
    }
});
test('same numeric TCP/UDP alias port is unambiguous; endpoint identities and file authority remain strict', () => {
    const value = config(); value.endpoints[0].guest.udpPort = 18080;
    assert.deepEqual(parse(value).routes, [{ endpointId: 'fixed-peer', tcpPort: 18080, udpPort: 18080 }]);
    value.endpoints.push({ ...value.endpoints[0] }); assert.throws(() => parse(value));
    assert.throws(() => parse({ ...config(), autoGrant: true }));
});
test('actual native chooser shows only fixed configured routes and returns an opaque endpoint; abort cannot grant', async () => {
    const fixed = parse(config()), main = { isDestroyed: () => false }, abort = new AbortController(); let options, current = true;
    const showChooser = createMainNetworkNativeChooser({ getMainWindow: () => main, dialog: {
        async showMessageBox(parent, value) { assert.equal(parent, main); options = value; return { response: 1 }; } } });
    const selection = createMainNetworkEndpointSelection({ resources: fixed.resources, showChooser });
    const requireCurrent = () => { assert(current); };
    const selected = await selection.chooseEndpoints({ choices: fixed.resources }, abort.signal, requireCurrent);
    assert.deepEqual(selected, { outcome: 'selected', resourceIds: ['fixed-peer'] });
    assert.match(options.detail, /TCP 10\.0\.2\.2:18080 \/ UDP 10\.0\.2\.2:18081/);
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.signal, abort.signal);
    const mismatch = fixed.resources.map(row => ({ ...row, transports: ['tcp'] }));
    await assert.rejects(selection.chooseEndpoints({ choices: mismatch }, abort.signal, requireCurrent));
    current = false; await assert.rejects(selection.chooseEndpoints({ choices: fixed.resources }, abort.signal, requireCurrent));
    current = true; abort.abort(); assert.deepEqual(await selection.chooseEndpoints({ choices: fixed.resources }, abort.signal, requireCurrent), { outcome: 'cancelled' });
});
test('new aliases reuse actual shared route and inert Node endpoint validators without opening network resources', async () => {
    const root = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT; assert(root, 'An explicit immutable actual Simulator build is required');
    const { createNodeHostNetworkDriver } = await import(pathToFileURL(root + '/packages/simulator-connectivity-node/dist/index.js'));
    const { validateHostNetworkGuestRoutes } = await import(pathToFileURL(root + '/packages/simulator-connectivity/dist/index.js'));
    const fixed = parse(config()), driver = createNodeHostNetworkDriver({ endpoints: fixed.endpoints });
    assert.equal(driver.snapshot().connections, 0); assert.equal(driver.snapshot().pendingDns, 0);
    const grant = { schemaVersion: 1, kind: 'aily-host-connectivity-grant', grantId: 'g', backendId: 'b', capability: 'network.ip',
        profileId: 'wifi-functional-host-ip-v1', executionId: 'e', executionLocation: 'user-device', resourceLocation: 'user-device',
        permissionAuthority: 'local-user', expiresAtUnixMs: Date.now() + 30000, resourceIds: ['fixed-peer'], scope: { sessionId: 's',
            sceneRevision: 'a'.repeat(64), worldId: 'w', nodeId: 'n', clockDomainId: 'c', runtimeGeneration: 1, coreGeneration: 1, timeEpoch: 2, connectionEpoch: 1 } };
    assert.deepEqual(validateHostNetworkGuestRoutes(fixed.routes, grant), fixed.routes);
    assert.throws(() => validateHostNetworkGuestRoutes(fixed.routes, { ...grant, resourceIds: ['foreign'] }));
    await driver.dispose(); assert.equal(driver.snapshot().connections, 0);
});
