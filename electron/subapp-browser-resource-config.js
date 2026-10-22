'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SubappBrowserExecutionHost } = require('./subapp-browser-execution-host');
const { createTrustedBrowserResourceServer } = require('./subapp-browser-resource-source');

const CONFIG_FILENAME = 'subapp-browser-resource-config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const identityKey = (name, version) => JSON.stringify([name, version]);

function bundledBrowserResourceConfigPath(moduleDirectory = __dirname) {
    if (typeof moduleDirectory !== 'string' || !path.isAbsolute(moduleDirectory)) {
        throw new TypeError('Browser resource configuration directory must be absolute');
    }
    return path.join(moduleDirectory, 'resources', CONFIG_FILENAME);
}

function freezeTree(value) {
    if (value && typeof value === 'object') {
        for (const member of Object.values(value)) freezeTree(member);
        Object.freeze(value);
    }
    return value;
}

/** The path is selected by trusted Main code, never by an IPC payload, an
 * installed package declaration, environment variables or user preferences.
 * The bundled file is part of the host application distribution. */
function loadBrowserResourceConfig(filePath = bundledBrowserResourceConfigPath(), { allowLoopbackHttp = false } = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('Browser resource configuration path must be absolute');
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
        throw new TypeError('Browser resource configuration must be a bounded regular file');
    }
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!exact(config, ['schemaVersion', 'kind', 'releases']) || config.schemaVersion !== 1
        || config.kind !== 'aily-subapp-browser-resource-config' || !Array.isArray(config.releases)
        || config.releases.length > 64) throw new TypeError('Invalid host Browser resource configuration');
    const identities = new Set();
    for (const release of config.releases) {
        const packageIdentity = release?.manifest?.packageIdentity;
        if (!exact(release, ['resourceBaseUrl', 'releaseId', 'manifest'])
            || !exact(packageIdentity, ['name', 'version']) || typeof packageIdentity.name !== 'string'
            || !packageIdentity.name || packageIdentity.name.length > 256 || typeof packageIdentity.version !== 'string'
            || !packageIdentity.version || packageIdentity.version.length > 128
            || !/^[a-f0-9]{64}$/.test(release.releaseId || '')
            || createHash('sha256').update(JSON.stringify(release.manifest)).digest('hex') !== release.releaseId
            || typeof release.resourceBaseUrl !== 'string' || release.resourceBaseUrl.length > 4096) {
            throw new TypeError('Invalid configured Browser release identity');
        }
        const base = new URL(release.resourceBaseUrl);
        if (base.href !== release.resourceBaseUrl || base.username || base.password || base.search || base.hash
            || !base.pathname.endsWith(`/releases/${release.releaseId}/`)
            || base.protocol !== 'https:' && !(allowLoopbackHttp === true && base.protocol === 'http:' && base.hostname === '127.0.0.1')) {
            throw new TypeError('Configured Browser release requires an exact trusted version URL');
        }
        const key = identityKey(packageIdentity.name, packageIdentity.version);
        if (identities.has(key)) throw new TypeError('A package version cannot select multiple Browser releases');
        identities.add(key);
    }
    return freezeTree(config);
}

/** Composes existing Main-only authorities: installed package selection and a
 * host-bundled public release. A configured release fails closed; only an
 * unconfigured package version uses the original local server. */
function createConfiguredBrowserExecutionHost({ configurationFilePath, allowLoopbackHttp = false, ...hostOptions } = {}) {
    const config = loadBrowserResourceConfig(configurationFilePath, { allowLoopbackHttp });
    const releases = new Map(config.releases.map(release => {
        const { name, version } = release.manifest.packageIdentity;
        return [identityKey(name, version), release];
    }));
    const host = new SubappBrowserExecutionHost(hostOptions), createLocalServer = host.createServer;
    host.createServer = (entry, source) => {
        const release = releases.get(identityKey(source?.packageName, source?.version));
        return release ? createTrustedBrowserResourceServer({ ...release, source, allowLoopbackHttp,
            timeoutMs: host.timeoutMs }) : createLocalServer(entry, source);
    };
    return host;
}

module.exports = { CONFIG_FILENAME, MAX_CONFIG_BYTES, bundledBrowserResourceConfigPath,
    loadBrowserResourceConfig, createConfiguredBrowserExecutionHost };
