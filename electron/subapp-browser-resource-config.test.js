'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { CONFIG_FILENAME, MAX_CONFIG_BYTES, bundledBrowserResourceConfigPath,
    loadBrowserResourceConfig, createConfiguredBrowserExecutionHost } = require('./subapp-browser-resource-config');

const hash = value => createHash('sha256').update(value).digest('hex');
const emptyConfig = () => ({ schemaVersion: 1, kind: 'aily-subapp-browser-resource-config', releases: [] });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-browser-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bytes = Buffer.from('<!doctype html><title>Configured execution</title>');
    fs.writeFileSync(path.join(root, 'execution.html'), bytes);
    fs.writeFileSync(path.join(root, 'view.html'), '');
    fs.writeFileSync(path.join(root, '.secret.json'), '{}');
    const source = { protocol: 'aily-browser-execution-v1', identity: 'installed-config-fixture',
        packageName: '@fixture/config', version: '1.0.0', entry: 'execution.html', rootDirectory: root,
        sha256: hash(bytes), surfaces: { full: 'view.html' } };
    const manifest = { schemaVersion: 1, kind: 'aily-browser-resource-release',
        packageIdentity: { name: source.packageName, version: source.version },
        files: [{ path: source.entry, bytes: bytes.length, sha256: hash(bytes) },
            { path: 'view.html', bytes: 0, sha256: hash('') }] };
    const releaseId = hash(JSON.stringify(manifest));
    const release = { resourceBaseUrl: `https://assets.example/releases/${releaseId}/`, releaseId, manifest };
    const filePath = path.join(root, 'config.json');
    const write = config => fs.writeFileSync(filePath, JSON.stringify(config));
    write({ ...emptyConfig(), releases: [release] });
    return { root, bytes, source, release, filePath, write };
}

test('bundled configuration has a fixed path, empty local default and immutable data', () => {
    assert.equal(bundledBrowserResourceConfigPath(), path.join(__dirname, 'resources', CONFIG_FILENAME));
    assert.throws(() => bundledBrowserResourceConfigPath('relative'));
    const config = loadBrowserResourceConfig();
    assert.deepEqual(config, emptyConfig());
    assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.releases));
});

test('rejects missing, relative, malformed, oversized and unknown-field configurations', t => {
    const f = fixture(t);
    for (const filePath of ['relative.json', path.join(f.root, 'missing'), f.root]) {
        assert.throws(() => loadBrowserResourceConfig(filePath));
    }
    fs.writeFileSync(f.filePath, '{'); assert.throws(() => loadBrowserResourceConfig(f.filePath));
    fs.writeFileSync(f.filePath, Buffer.alloc(MAX_CONFIG_BYTES + 1)); assert.throws(() => loadBrowserResourceConfig(f.filePath));
    for (const config of [{ ...emptyConfig(), url: 'https://untrusted.example' },
        { ...emptyConfig(), schemaVersion: 2 }, { ...emptyConfig(), releases: Array(65).fill(f.release) },
        { ...emptyConfig(), releases: [{ ...f.release, allowLoopbackHttp: true }] }]) {
        f.write(config); assert.throws(() => loadBrowserResourceConfig(f.filePath));
    }
});

test('rejects ambiguous package versions, changed manifest identity and mutable URL geometry', t => {
    const f = fixture(t);
    f.write({ ...emptyConfig(), releases: [f.release, f.release] });
    assert.throws(() => loadBrowserResourceConfig(f.filePath), /multiple/);
    const changed = structuredClone(f.release); changed.manifest.packageIdentity.version = '2.0.0';
    f.write({ ...emptyConfig(), releases: [changed] }); assert.throws(() => loadBrowserResourceConfig(f.filePath), /identity/);
    for (const resourceBaseUrl of [f.release.resourceBaseUrl + '?token=not-accepted',
        f.release.resourceBaseUrl + '#mutable', f.release.resourceBaseUrl.replace('https:', 'http:'),
        f.release.resourceBaseUrl.replace('assets.example', 'user:password@assets.example'),
        f.release.resourceBaseUrl.replace('/releases/', '/mutable/'),
        f.release.resourceBaseUrl.replace('/releases/', '/x/../releases/')]) {
        f.write({ ...emptyConfig(), releases: [{ ...f.release, resourceBaseUrl }] });
        assert.throws(() => loadBrowserResourceConfig(f.filePath));
    }
});

test('unconfigured package versions retain the original strict local HTTP server', async t => {
    const f = fixture(t);
    const host = createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath });
    for (const source of [{ ...f.source, version: '2.0.0' }, { ...f.source, packageName: '@other/package',
        resourceBaseUrl: 'https://renderer-declared.invalid/' }]) {
        const server = host.createServer(source.entry, source);
        const location = await server.start({ rootDirectory: source.rootDirectory });
        try {
            assert.equal(location.resourceBaseUrl, undefined);
            const response = await fetch(new URL(source.entry, location.origin));
            assert.equal(await response.text(), f.bytes.toString());
            assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
            assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
            assert.match(response.headers.get('content-security-policy'), /worker-src 'self' blob:/);
            assert.equal((await fetch(new URL('.secret.json', location.origin))).status, 404);
        } finally { await server.close(); }
        await assert.rejects(fetch(location.origin));
    }
});

test('configured entry identity and malformed member list fail without local fallback', t => {
    const f = fixture(t); let localCalls = 0;
    let host = createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath, createServer: () => { localCalls++; } });
    assert.throws(() => host.createServer(f.source.entry, { ...f.source, sha256: '0'.repeat(64) }), /differs/);
    const release = structuredClone(f.release); release.manifest.files.push({ ...release.manifest.files[0] });
    release.releaseId = hash(JSON.stringify(release.manifest));
    release.resourceBaseUrl = `https://assets.example/releases/${release.releaseId}/`;
    f.write({ ...emptyConfig(), releases: [release] });
    host = createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath, createServer: () => { localCalls++; } });
    assert.throws(() => host.createServer(f.source.entry, f.source), /Duplicate/);
    assert.equal(localCalls, 0);
});

async function httpFixture(t, reply) {
    const f = fixture(t), requests = [];
    const server = createServer((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization,
        cookie: req.headers.cookie }); reply(req, res, f); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    f.release.resourceBaseUrl = `http://127.0.0.1:${server.address().port}/releases/${f.release.releaseId}/`;
    f.write({ ...emptyConfig(), releases: [f.release] });
    return { ...f, requests };
}

test('Main-only loopback opt-in reuses the same frozen selection and actual HTTP verification', async t => {
    const f = await httpFixture(t, (_req, res, input) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(input.bytes); });
    assert.throws(() => createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath }), /version URL/);
    const host = createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath, allowLoopbackHttp: true });
    // Changing the file after Main selection cannot change this execution provider.
    f.write(emptyConfig());
    const server = host.createServer(f.source.entry, f.source), location = await server.start();
    assert.equal(location.resourceBaseUrl, f.release.resourceBaseUrl);
    assert.equal(location.resourceIdentity, f.release.releaseId);
    assert.deepEqual(location.resourcePaths, ['execution.html', 'view.html']);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].authorization, undefined); assert.equal(f.requests[0].cookie, undefined);
    await server.close(); await assert.rejects(server.start(), /closed/);
    assert.equal((await fetch(new URL(f.source.entry, f.release.resourceBaseUrl))).status, 200);
});

test('window initialization admits exact loopback releases only in unpackaged --serve mode', t => {
    const f = fixture(t);
    f.release.resourceBaseUrl = `http://127.0.0.1:50075/releases/${f.release.releaseId}/`;
    f.write({ ...emptyConfig(), releases: [f.release] });
    const source = fs.readFileSync(path.join(__dirname, 'window.js'), 'utf8');
    const boundary = source.indexOf("const { requestWindowAttention }");
    assert.ok(boundary > 0);
    const initialization = new vm.Script(source.slice(0, boundary) + '\nbrowserExecutionHost;');
    const initialize = (isPackaged, argv) => initialization.runInNewContext({
        process: { argv },
        require(name) {
            if (name === 'electron') return { app: { isPackaged } };
            assert.equal(name, './subapp-browser-resource-config');
            return { createConfiguredBrowserExecutionHost: options => createConfiguredBrowserExecutionHost({
                ...options, configurationFilePath: f.filePath,
            }) };
        },
    });
    assert.doesNotThrow(() => initialize(false, ['electron', 'main.js', '--serve']));
    for (const [isPackaged, argv] of [[true, ['electron', 'main.js', '--serve']],
        [true, ['electron', 'main.js']], [false, ['electron', 'main.js']],
        [false, ['electron', 'main.js', '--serve=true']]]) {
        assert.throws(() => initialize(isPackaged, argv), /exact trusted version URL/);
    }
    f.release.resourceBaseUrl = f.release.resourceBaseUrl.replace('127.0.0.1', '192.168.1.1');
    f.write({ ...emptyConfig(), releases: [f.release] });
    assert.throws(() => initialize(false, ['electron', 'main.js', '--serve']), /exact trusted version URL/);
});

for (const variant of ['redirect', 'tamper', 'unavailable']) test(`configured actual HTTP ${variant} does not silently use installed assets`, async t => {
    const f = await httpFixture(t, (_req, res, input) => {
        if (variant === 'redirect') { res.writeHead(302, { location: '/other.html' }); res.end(); }
        else if (variant === 'unavailable') { res.writeHead(503); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(Buffer.alloc(input.bytes.length, 120)); }
    });
    let localCalls = 0;
    const host = createConfiguredBrowserExecutionHost({ configurationFilePath: f.filePath, allowLoopbackHttp: true,
        createServer: () => { localCalls++; } });
    const server = host.createServer(f.source.entry, f.source);
    await assert.rejects(server.start()); await server.close();
    assert.equal(f.requests.length, 1); assert.equal(localCalls, 0);
});

test('Electron product uses the default fixed bundled configuration and ships its resource', () => {
    const windowSource = fs.readFileSync(path.join(__dirname, 'window.js'), 'utf8');
    assert.match(windowSource, /require\('\.\/subapp-browser-resource-config'\)/);
    assert.match(windowSource, /createConfiguredBrowserExecutionHost\(\{ BrowserWindow, MessageChannelMain,/);
    const configSource = fs.readFileSync(path.join(__dirname, 'subapp-browser-resource-config.js'), 'utf8');
    assert.doesNotMatch(configSource, /process\.env|ipcMain|localStorage|getPath\('userData'\)/);
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const rule = manifest.build.files.find(value => value && typeof value === 'object' && value.from === 'electron');
    assert.ok(rule?.filter.includes('**/*'));
    assert.equal(rule.filter.some(value => value.startsWith('!') && value.includes('resources')), false);
    assert.ok(fs.statSync(bundledBrowserResourceConfigPath()).isFile());
});
