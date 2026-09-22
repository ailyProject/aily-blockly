'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { resolveDebuggerRuntime } = require('../simulator-debug-runtime');
const { createBuildDebugPreview, registerBuildDebugPreview } = require('../build-debug-preview');
const versions = require('../subapp-version-store');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-runtime-discovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (relative, value = '{}') => {
        const filename = path.join(root, relative); fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value)); return filename;
    };
    const options = { subappRoot: path.join(root, 'app'), resourcesPath: path.join(root, 'resources') };
    const pkg = 'app/node_modules/@aily-project/aily-simulator';
    return { root, put, options, pkg, install() {
        put(`${pkg}/package.json`, { name: '@aily-project/aily-simulator', version: '0.1.0' });
        return put(`${pkg}/aily-simulator-runtime.json`);
    } };
}

test('default discovery uses current installed Runtime identity, not old subapp alias', t => {
    const f = fixture(t), expected = f.install();
    f.put('app/node_modules/@aily-project/subapp-aily-simulator/aily-simulator-runtime.json');
    f.put('resources/simulator/aily-simulator-runtime.json');
    assert.deepEqual(resolveDebuggerRuntime(f.options), { manifestPath: expected, source: 'installed' });
});

test('explicit selection wins and an invalid override is never silently bypassed', t => {
    const f = fixture(t); f.install();
    const explicit = f.put('explicit/runtime.json');
    assert.deepEqual(resolveDebuggerRuntime({ ...f.options, runtimeManifestPath: explicit }), { manifestPath: explicit, source: 'explicit' });
    for (const runtimeManifestPath of ['relative.json', path.join(f.root, 'missing.json'), f.root]) {
        assert.throws(() => resolveDebuggerRuntime({ ...f.options, runtimeManifestPath }), { code: 'DEBUG_RUNTIME_INVALID' });
    }
});

test('bundled fallback is allowed only when there is no installed selection', t => {
    const f = fixture(t), expected = f.put('resources/simulator/aily-simulator-runtime.json');
    assert.deepEqual(resolveDebuggerRuntime(f.options), { manifestPath: expected, source: 'bundled' });
    f.put(`${f.pkg}/package.json`, { name: '@aily-project/aily-simulator', version: '0.1.0' });
    assert.throws(() => resolveDebuggerRuntime(f.options), { code: 'DEBUG_RUNTIME_INVALID' });
});

test('missing Runtime returns one actionable installation error without searching workspaces', t => {
    const f = fixture(t); f.put('aily-simulator/.runtime/distribution/aily-simulator-runtime.json');
    assert.throws(() => resolveDebuggerRuntime(f.options), error => error.code === 'DEBUG_RUNTIME_NOT_INSTALLED'
        && error.details.packageName === '@aily-project/aily-simulator');
});

test('invalid installed package identity is not executable or replaced by bundled fallback', t => {
    const f = fixture(t); f.install(); f.put(`${f.pkg}/package.json`, { name: 'unrelated', version: '0.1.0' });
    f.put('resources/simulator/aily-simulator-runtime.json');
    assert.throws(() => resolveDebuggerRuntime(f.options), { code: 'DEBUG_RUNTIME_INVALID' });
});

test('bounded manifest lookup rejects empty and oversized files', t => {
    const f = fixture(t), filename = f.install();
    for (const value of ['', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
        fs.writeFileSync(filename, value);
        assert.throws(() => resolveDebuggerRuntime(f.options), { code: 'DEBUG_RUNTIME_INVALID' });
    }
});

test('default discovery honors pinned version-store selection over legacy npm', t => {
    const f = fixture(t); f.install();
    const entry = { id: 'aily-simulator', package: '@aily-project/aily-simulator', version: '0.1.0-dev' };
    const candidate = versions.createCandidate(f.options.subappRoot, entry);
    const put = (name, value) => fs.writeFileSync(path.join(candidate.source, name), value);
    put('package.json', JSON.stringify({ name: entry.package, version: entry.version, main: 'index.js', ailySubapp: { runtime: { headless: true } } }));
    put('index.js', 'throw new Error("Lookup must never execute Runtime package code");');
    put('aily-simulator-runtime.json', '{}');
    const prepared = versions.publishCandidate(f.options.subappRoot, entry, candidate, { distribution: null, installMode: 'development' });
    versions.activate(f.options.subappRoot, entry, prepared, { mode: 'pinned' });
    const result = resolveDebuggerRuntime(f.options);
    assert.ok(result.manifestPath.includes(path.join('store', 'aily-simulator', '0.1.0-dev')));
    versions.beginUninstall(f.options.subappRoot, entry);
    f.put('resources/simulator/aily-simulator-runtime.json');
    assert.throws(() => resolveDebuggerRuntime(f.options), { code: 'DEBUG_RUNTIME_UNAVAILABLE' });
});

test('native description releases selection lock on success and failure without launching', async () => {
    let released = 0, fail = false;
    const preview = createBuildDebugPreview({ registry: {}, launch: () => assert.fail('Description must not start a process'),
        configuration: () => ({ describe: async () => { if (fail) throw new Error('bad metadata'); return { executionVerified: false }; }, release: () => released++ }) });
    assert.deepEqual(await preview.describe(), { executionVerified: false });
    fail = true; await assert.rejects(preview.describe(), /bad metadata/); assert.equal(released, 2);
});

test('native description accepts no renderer Runtime paths and enforces current main frame', async () => {
    let handler, calls = 0; const sender = { mainFrame: {} };
    registerBuildDebugPreview({ handle: (name, fn) => { if (name === 'build-debug-preview') handler = fn; } }, { isCurrentRenderer: value => value === sender,
        preview: { describe: (...args) => { assert.equal(args.length, 0); calls++; return { check: 'manifest-only' }; } } });
    assert.deepEqual(await handler({ sender, senderFrame: sender.mainFrame }, { action: 'describe', runtimeManifestPath: 'untrusted' }), { check: 'manifest-only' });
    await assert.rejects(handler({ sender, senderFrame: {} }, { action: 'describe' }), { code: 'RPC_FORBIDDEN' });
    assert.equal(calls, 1);
});
