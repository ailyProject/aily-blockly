'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

// This path is supplied by normal Main from app.getPath('userData'), never by
// an IPC payload. The shared driver remains the authority for literal IP/DNS,
// transport and connection policy; this loader validates the file container.
const CONFIG_FILE_NAME = 'simulator-network-endpoints.json';
function exact(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new TypeError('Invalid normal Host network configuration');
}
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function parseMainNetworkHostConfiguration(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) throw new TypeError('Normal Host network configuration exceeds its file budget');
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (value?.enabled === false) {
        exact(value, ['schemaVersion', 'kind', 'enabled']);
        if (value.schemaVersion !== 1 || value.kind !== 'aily-main-host-network-config') throw new TypeError('Unsupported Host network configuration');
        return null;
    }
    exact(value, ['schemaVersion', 'kind', 'enabled', 'endpoints']);
    if (value.schemaVersion !== 1 || value.kind !== 'aily-main-host-network-config' || value.enabled !== true
        || !Array.isArray(value.endpoints) || value.endpoints.length < 1 || value.endpoints.length > 16) throw new TypeError('Unsupported Host network configuration');
    const ids = new Set(), endpoints = [], resources = [], routes = [];
    for (const entry of value.endpoints) {
        exact(entry, ['endpointId', 'label', 'hostname', 'addresses', 'connectAddress', 'port', 'transports', 'recordTypes', ...(Object.hasOwn(entry, 'guest') ? ['guest'] : [])]);
        if (typeof entry.endpointId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(entry.endpointId) || ids.has(entry.endpointId)
            || typeof entry.label !== 'string' || entry.label.length < 1 || entry.label.length > 96 || /[\u0000-\u001f\u007f]/u.test(entry.label)
            || typeof entry.connectAddress !== 'string' || entry.connectAddress.length > 64
            || entry.hostname !== null && (typeof entry.hostname !== 'string' || entry.hostname.length > 253)
            || !Array.isArray(entry.addresses) || entry.addresses.length < 1 || entry.addresses.length > 16 || entry.addresses.some(address => typeof address !== 'string' || address.length > 64)
            || !Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535
            || !Array.isArray(entry.transports) || entry.transports.length < 1 || entry.transports.length > 2 || entry.transports.some(transport => !['tcp', 'udp'].includes(transport))
            || !Array.isArray(entry.recordTypes) || entry.recordTypes.length > 2 || entry.recordTypes.some(type => !['A', 'AAAA'].includes(type))) throw new TypeError('Invalid normal Host endpoint metadata');
        ids.add(entry.endpointId);
        // Only this trusted Main file supplies the fixed Guest aliases. A
        // browser request cannot choose an address, port or transport. The
        // omitted legacy guest field remains TCP-only; UDP is always explicit.
        const guest = entry.guest ?? { tcpPort: 18080 };
        if (!guest || Object.getPrototypeOf(guest) !== Object.prototype
            || Object.keys(guest).length < 1 || Object.keys(guest).some(key => !['tcpPort', 'udpPort', 'dnsName'].includes(key))
            || !Object.hasOwn(guest, 'tcpPort') && !Object.hasOwn(guest, 'udpPort'))
            throw new TypeError('A fixed supported Guest transport alias is required');
        for (const [key, transport] of [['tcpPort', 'tcp'], ['udpPort', 'udp']]) {
            if (!Object.hasOwn(guest, key)) continue;
            if (!Number.isSafeInteger(guest[key]) || guest[key] < 1024 || guest[key] > 65535
                || !entry.transports.includes(transport)) throw new TypeError('Guest alias must match an explicitly configured transport and port >=1024');
        }
        if (Object.hasOwn(guest, 'dnsName') && (!canonicalDnsName(guest.dnsName)
            || !canonicalDnsName(entry.hostname) || !entry.recordTypes.includes('A')))
            throw new TypeError('Guest DNS alias requires canonical selected names and a trusted Host A resolver');
        const { label, guest: _guest, ...endpoint } = entry;
        endpoints.push(endpoint);
        routes.push({ endpointId: entry.endpointId, ...guest });
        const guestDetail = Object.hasOwn(guest, 'udpPort')
            ? `${Object.hasOwn(guest, 'tcpPort') ? `TCP 10.0.2.2:${guest.tcpPort} / ` : ''}UDP 10.0.2.2:${guest.udpPort}`
            : `10.0.2.2:${guest.tcpPort}`;
        const dnsDetail = Object.hasOwn(guest, 'dnsName') ? ` / DNS ${guest.dnsName} → 10.0.2.2` : '';
        resources.push({ endpointId: entry.endpointId, label, transports: [...entry.transports], recordTypes: [...entry.recordTypes],
            detail: `${entry.connectAddress.includes(':') ? `[${entry.connectAddress}]` : entry.connectAddress}:${entry.port} · ${entry.transports.join('/').toUpperCase()}${entry.hostname ? ` · DNS ${entry.hostname} → ${entry.addresses.join(', ')}` : ''} · 仿真访问 ${guestDetail}${dnsDetail}` });
    }
    return freeze({ endpoints, resources, routes, fingerprint: createHash('sha256').update(bytes).digest('hex') });
}
function canonicalDnsName(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 253 && value === value.toLowerCase()
        && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label));
}
async function readMainNetworkHostConfiguration(configurationPath) {
    if (typeof configurationPath !== 'string') throw new TypeError('Normal Main configuration path is required');
    let bytes;
    try { bytes = await fs.readFile(configurationPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return parseMainNetworkHostConfiguration(bytes);
}
module.exports = { CONFIG_FILE_NAME, parseMainNetworkHostConfiguration, readMainNetworkHostConfiguration };
