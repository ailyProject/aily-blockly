'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { createTrustedBrowserResourceServer } = require('./subapp-browser-resource-source');

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(options = {}) {
    const bytes = Buffer.from('<!doctype html><title>Trusted execution</title>');
    const source = { protocol: 'aily-browser-execution-v1', identity: 'selected-installed-fixture', packageName: '@fixture/browser', version: '1.0.0',
        entry: 'execution.html', sha256: hash(bytes), surfaces: { full: 'view.html' } };
    const manifest = { schemaVersion: 1, kind: 'aily-browser-resource-release', packageIdentity: { name: source.packageName, version: source.version },
        files: [ { path: source.entry, bytes: bytes.length, sha256: hash(bytes) }, { path: 'view.html', bytes: 0, sha256: hash('') } ] };
    const releaseId = hash(JSON.stringify(manifest));
    return { source, manifest, releaseId, bytes, resourceBaseUrl: `https://assets.example/releases/${releaseId}/`, ...options };
}

test('trusted manifest is pinned to selected package, execution HTML and exact release URL', () => {
    const f = fixture();
    assert.doesNotThrow(() => createTrustedBrowserResourceServer(f));
    for (const change of [ { releaseId: 'f'.repeat(64) }, { source: { ...f.source, version: '2.0.0' } },
        { source: { ...f.source, sha256: '0'.repeat(64) } }, { source: { ...f.source, surfaces: { full: 'missing.html' } } } ]) {
        assert.throws(() => createTrustedBrowserResourceServer({ ...f, ...change }));
    }
    for (const resourceBaseUrl of [ f.resourceBaseUrl + '?token=x', f.resourceBaseUrl + '#x',
        f.resourceBaseUrl.replace('https:', 'http:'), f.resourceBaseUrl.replace('assets.example', 'user:pass@assets.example'),
        f.resourceBaseUrl.replace('/releases/', '/mutable/'), f.resourceBaseUrl.replace('/releases/', '/x/../releases/') ]) {
        assert.throws(() => createTrustedBrowserResourceServer({ ...f, resourceBaseUrl }));
    }
});

test('manifest hashes do not admit malformed, duplicate or traversal resources', () => {
    for (const mutate of [ m => m.files.push({ ...m.files[0] }), m => m.files[1].path = '../private.json',
        m => m.files[1].path = 'x%2fprivate.json', m => m.files[1].bytes = 2 ** 53, m => m.extra = 'unreviewed' ]) {
        const f = fixture(); mutate(f.manifest); f.releaseId = hash(JSON.stringify(f.manifest));
        f.resourceBaseUrl = `https://assets.example/releases/${f.releaseId}/`;
        assert.throws(() => createTrustedBrowserResourceServer(f));
    }
});

async function httpFixture(t, response) {
    const f = fixture(), requests = [];
    const server = createServer((req, res) => { requests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie }); response(req, res, f); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    f.resourceBaseUrl = `http://127.0.0.1:${server.address().port}/releases/${f.releaseId}/`;
    f.allowLoopbackHttp = true;
    return { ...f, requests };
}
test('actual HTTP entry verification freezes selection and has no account or remote shutdown authority', async t => {
    const f = await httpFixture(t, (_req, res, input) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(input.bytes); });
    const adapter = createTrustedBrowserResourceServer(f);
    f.manifest.files[0].sha256 = 'f'.repeat(64); f.source.entry = 'changed.html';
    const [a, b] = await Promise.all([adapter.start(), adapter.start()]);
    assert.equal(a, b); assert.equal(a.resourceBaseUrl, f.resourceBaseUrl); assert.equal(a.resourceIdentity, f.releaseId);
    assert.deepEqual(a.resourcePaths, ['execution.html', 'view.html']); assert.ok(Object.isFrozen(a.resourcePaths));
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, new URL('execution.html', f.resourceBaseUrl).pathname);
    assert.equal(f.requests[0].authorization, undefined); assert.equal(f.requests[0].cookie, undefined);
    await adapter.close(); await assert.rejects(adapter.start(), /closed/);
    assert.equal((await fetch(new URL('execution.html', f.resourceBaseUrl))).status, 200);
});

for (const variant of ['redirect', 'same-size-tamper', 'oversize']) test('actual HTTP rejects ' + variant, async t => {
    const f = await httpFixture(t, (_req, res, input) => {
        if (variant === 'redirect') { res.writeHead(302, { location: '/other.html' }); res.end(); }
        else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(variant === 'oversize' ? Buffer.alloc(input.bytes.length + 1) : Buffer.alloc(input.bytes.length, 120)); }
    });
    const adapter = createTrustedBrowserResourceServer(f);
    await assert.rejects(adapter.start()); await adapter.close(); assert.equal(f.requests.length, 1);
});

test('closing an in-flight selection aborts actual HTTP and prevents late start', async t => {
    let observed; const received = new Promise(resolve => { observed = resolve; });
    const f = await httpFixture(t, (_req, _res) => { observed(); });
    const adapter = createTrustedBrowserResourceServer(f), pending = adapter.start();
    const rejected = assert.rejects(pending, /closed|abort/i);
    await received; await adapter.close(); await rejected; await assert.rejects(adapter.start(), /closed/);
});

test('verification deadline aborts actual HTTP without widening Host budget', async t => {
    const f = await httpFixture(t, () => {}), adapter = createTrustedBrowserResourceServer({ ...f, timeoutMs: 30 });
    await assert.rejects(adapter.start(), /deadline|abort/i); await adapter.close();
});
