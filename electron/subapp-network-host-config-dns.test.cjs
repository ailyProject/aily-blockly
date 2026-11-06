'use strict';
// Trusted config and actual inert shared validators only; no DNS/network/Main.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { parseMainNetworkHostConfiguration } = require('./subapp-network-host-config');
const config = () => ({ schemaVersion: 1, kind: 'aily-main-host-network-config', enabled: true, endpoints: [{ endpointId: 'fixed-peer', label: 'Fixed DNS peer',
    hostname: 'controlled.example.test', addresses: ['127.0.0.1'], connectAddress: '127.0.0.1', port: 65047,
    transports: ['tcp', 'udp'], recordTypes: ['A'], guest: { tcpPort: 18080, udpPort: 18081, dnsName: 'guest.peer.test' } }] });
const parse = value => parseMainNetworkHostConfiguration(Buffer.from(JSON.stringify(value)));
test('Guest DNS name stays only in immutable selected route; trusted Host hostname/address remain unchanged', () => {
    const value = config(), result = parse(value); value.endpoints[0].guest.dnsName = 'changed.test';
    assert.deepEqual(result.routes, [{ endpointId: 'fixed-peer', tcpPort: 18080, udpPort: 18081, dnsName: 'guest.peer.test' }]);
    assert.equal(result.endpoints[0].hostname, 'controlled.example.test'); assert.equal(result.endpoints[0].connectAddress, '127.0.0.1');
    assert(!Object.hasOwn(result.endpoints[0], 'guest')); assert(!Object.hasOwn(result.endpoints[0], 'dnsName'));
    assert(Object.isFrozen(result.routes[0])); assert.match(result.resources[0].detail, /DNS guest\.peer\.test → 10\.0\.2\.2$/);
});
test('DNS alias requires canonical Guest name, an actual canonical trusted Host hostname and enabled A record', () => {
    for (const dnsName of ['', 'Peer.test', 'a..test', '-a.test', 'a-.test', 'a_test', 'peer.test.', 'a'.repeat(64) + '.test', 'a'.repeat(254), 'http://peer.test', null, 7]) {
        const value = config(); value.endpoints[0].guest.dnsName = dnsName; assert.throws(() => parse(value));
    }
    for (const hostname of [null, '', 'UPPER.test', 'a..test', 'https://peer.test', 'peer.test.']) {
        const value = config(); value.endpoints[0].hostname = hostname; assert.throws(() => parse(value));
    }
    for (const recordTypes of [[], ['AAAA']]) { const value = config(); value.endpoints[0].recordTypes = recordTypes; assert.throws(() => parse(value)); }
});
test('DNS cannot create a transport or accept Guest OS destination/authority fields', () => {
    for (const guest of [{ dnsName: 'guest.peer.test' }, { dnsName: 'guest.peer.test', tcpPort: 80 },
        { dnsName: 'guest.peer.test', udpPort: 18081, hostname: 'injected.test' }, { dnsName: 'guest.peer.test', udpPort: 18081, endpointId: 'other' },
        { dnsName: 'guest.peer.test', udpPort: 18081, recordTypes: ['A'] }, { dnsName: 'guest.peer.test', udpPort: 18081, connectAddress: '127.0.0.2' }]) {
        const value = config(); value.endpoints[0].guest = guest; assert.throws(() => parse(value));
    }
    const mismatch = config(); mismatch.endpoints[0].transports = ['tcp']; assert.throws(() => parse(mismatch));
});
test('legacy TCP/default and explicit UDP remain byte-compatible when DNS alias is absent', () => {
    const tcp = config(); Object.assign(tcp.endpoints[0], { hostname: null, recordTypes: [], transports: ['tcp'] }); delete tcp.endpoints[0].guest;
    const original = parse(tcp); assert.deepEqual(original.routes, [{ endpointId: 'fixed-peer', tcpPort: 18080 }]);
    assert.equal(original.resources[0].detail, '127.0.0.1:65047 · TCP · 仿真访问 10.0.2.2:18080');
    tcp.endpoints[0].guest = { tcpPort: 18080 }; const explicit = parse(tcp);
    for (const key of ['routes', 'resources', 'endpoints']) assert.deepEqual(explicit[key], original[key]);
    assert.notEqual(explicit.fingerprint, original.fingerprint);
    tcp.endpoints[0].transports = ['udp']; tcp.endpoints[0].guest = { udpPort: 18081 };
    assert.deepEqual(parse(tcp).routes, [{ endpointId: 'fixed-peer', udpPort: 18081 }]); assert.match(parse(tcp).resources[0].detail, /仿真访问 UDP 10\.0\.2\.2:18081$/);
});
test('actual selected-route authority and inert Node endpoint validators accept the split names without opening DNS', async () => {
    const root = process.env.AILY_NETWORK_TEST_PROTOCOL_ROOT; assert(root);
    const { createNodeHostNetworkDriver } = await import(pathToFileURL(root + '/packages/simulator-connectivity-node/dist/index.js'));
    const { validateHostNetworkGuestRoutes } = await import(pathToFileURL(root + '/packages/simulator-connectivity/dist/index.js'));
    const selected = parse(config()), driver = createNodeHostNetworkDriver({ endpoints: selected.endpoints });
    assert.equal(driver.snapshot().connections, 0); assert.equal(driver.snapshot().pendingDns, 0);
    const grant = { schemaVersion: 1, kind: 'aily-host-connectivity-grant', grantId: 'g', backendId: 'b', capability: 'network.ip',
        profileId: 'wifi-functional-host-ip-v1', executionId: 'e', executionLocation: 'user-device', resourceLocation: 'user-device', permissionAuthority: 'local-user',
        expiresAtUnixMs: Date.now() + 30000, resourceIds: ['fixed-peer'], scope: { sessionId: 's', sceneRevision: 'a'.repeat(64), worldId: 'w', nodeId: 'n', clockDomainId: 'c', runtimeGeneration: 1, coreGeneration: 1, timeEpoch: 2, connectionEpoch: 1 } };
    assert.deepEqual(validateHostNetworkGuestRoutes(selected.routes, grant), selected.routes);
    assert.throws(() => validateHostNetworkGuestRoutes(selected.routes, { ...grant, resourceIds: ['foreign'] }));
    await driver.dispose(); assert.equal(driver.snapshot().pendingDns, 0);
});
