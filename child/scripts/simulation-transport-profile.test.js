'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { PROFILE, PROVIDER, QUERY, RESULT, captureSppCompileIntent, queryCompilationProfile, authorizeSimulationTransportProfile } = require('./simulation-transport-profile');
const { readBuilderCapabilities, supportsSimulationTransportProfile } = require('./builder-capabilities');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-spp-compile-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sdk = path.join(root, 'sdk'), library = path.join(sdk, 'libraries/BluetoothSerial/src');
    fs.mkdirSync(library, { recursive: true });
    const filename = path.join(root, 'preprocess.json'), fqbn = 'esp32:esp32:esp32';
    const data = { success: true, arduinoConfig: { fqbn, fqbnParsed: { package: 'esp32', platform: 'esp32' },
        board: { 'build.mcu': 'esp32' }, platform: { 'runtime.platform.path': sdk } },
        dependencies: [{ type: 'library', name: 'BluetoothSerial', path: library }] };
    const config = { recordProjectDelivery: true, simulationDebug: true };
    const save = () => fs.writeFileSync(filename, JSON.stringify(data)); save();
    return { root, sdk, library, filename, fqbn, data, config, save };
}
function channel(reply) {
    const channel = new EventEmitter(); channel.connected = true; channel.messages = [];
    channel.send = (message, callback) => { channel.messages.push(message); callback(null);
        queueMicrotask(() => channel.emit('message', typeof reply === 'function' ? reply(message) : {
            type: RESULT, requestDigest: message.requestDigest, phase: message.phase, ok: true, profile: reply })); };
    return channel;
}

test('only actual current Classic SDK BluetoothSerial dependency requests the new compilation selection', async t => {
    const f = fixture(t), ipc = channel(PROFILE);
    const authorized = await authorizeSimulationTransportProfile(f.config, f.filename, f.fqbn, ipc);
    assert.equal(authorized.profile, PROFILE); await authorized.confirm();
    assert.deepEqual(ipc.messages.map(value => [value.type, value.phase]), [[QUERY, 'before-compile'], [QUERY, 'before-delivery']]);
    assert.equal(ipc.listenerCount('message'), 0); assert.equal(ipc.listenerCount('disconnect'), 0);
    assert.deepEqual(Object.keys(ipc.messages[0]).sort(), ['phase', 'requestDigest', 'type']);
    fs.appendFileSync(f.filename, ' ');
    assert.throws(authorized.assertCurrent, /UNAVAILABLE/);
    await assert.rejects(authorized.confirm(), /UNAVAILABLE/);
});

for (const variant of ['hardware', 'BLE', 'WiFi', 'foreign-library', 'duplicate-library', 'C3', 'C6', 'S3', 'different-fqbn']) {
    test(`normal ${variant} preprocessing retains its old selection without a profile query`, async t => {
        const f = fixture(t), ipc = channel(PROFILE);
        if (variant === 'hardware') delete f.config.simulationDebug;
        if (variant === 'BLE' || variant === 'WiFi') f.data.dependencies[0].name = variant;
        if (variant === 'foreign-library') { const local = path.join(f.root, 'project-library'); fs.mkdirSync(local); f.data.dependencies[0].path = local; }
        if (variant === 'duplicate-library') f.data.dependencies.push({ ...f.data.dependencies[0] });
        if (['C3', 'C6', 'S3'].includes(variant)) f.data.arduinoConfig.board['build.mcu'] = `esp32${variant.toLowerCase()}`;
        if (variant === 'different-fqbn') f.data.arduinoConfig.fqbn = 'esp32:esp32:other';
        f.save();
        assert.equal(await authorizeSimulationTransportProfile(f.config, f.filename, f.fqbn, ipc), null);
        assert.equal(ipc.messages.length, 0);
        f.config.simulationTransportProfile = PROFILE;
        assert.throws(() => captureSppCompileIntent(f.config, f.filename, f.fqbn), /UNAVAILABLE/);
    });
}

test('old package or unsupervised automatic compile retains AHC1, but explicit project request cannot self-authorize', async t => {
    const f = fixture(t);
    for (const ipc of [channel(null), {}]) {
        assert.equal(await authorizeSimulationTransportProfile(f.config, f.filename, f.fqbn, ipc), null);
        await assert.rejects(authorizeSimulationTransportProfile({ ...f.config, simulationTransportProfile: PROFILE }, f.filename, f.fqbn, ipc), /UNAVAILABLE/);
    }
    assert.throws(() => captureSppCompileIntent({ ...f.config, simulationTransportProfile: 'unknown' }, f.filename, f.fqbn), /UNAVAILABLE/);
});

test('profile reply is finite, request/phase-bound, exact, fail-closed and never reused after owner release', async t => {
    const f = fixture(t);
    for (const patch of [{ requestDigest: '0'.repeat(64) }, { phase: 'before-delivery' }, { ok: false },
        { profile: 'unknown' }, { owner: 'forged' }]) {
        const ipc = channel(message => ({ type: RESULT, requestDigest: message.requestDigest, phase: message.phase, ok: true, profile: PROFILE, ...patch }));
        await assert.rejects(queryCompilationProfile(f.config, 'before-compile', ipc, 20), /UNAVAILABLE/);
        assert.equal(ipc.listenerCount('message'), 0);
    }
    const gone = channel(message => ({ type: RESULT, requestDigest: message.requestDigest, phase: message.phase,
        ok: message.phase === 'before-compile', profile: message.phase === 'before-compile' ? PROFILE : null }));
    const authorized = await authorizeSimulationTransportProfile(f.config, f.filename, f.fqbn, gone);
    await assert.rejects(authorized.confirm(), /UNAVAILABLE/);
    const silent = new EventEmitter(); silent.connected = true; silent.send = (_message, done) => done();
    await assert.rejects(queryCompilationProfile(f.config, 'before-compile', silent, 10), /UNAVAILABLE/);
    assert.equal(silent.listenerCount('message'), 0); assert.equal(silent.listenerCount('disconnect'), 0);
});

test('Builder capability must advertise the exact typed enum/provider and all required evidence', () => {
    const capability = { schemaVersion: 1, cliOption: '--simulation-transport-profile', allowedValues: [PROFILE],
        providerByProfile: { [PROFILE]: PROVIDER }, requiresSimulationDebug: true,
        requiresBuildInputRecord: true, requiresArtifactManifest: true };
    const probe = value => readBuilderCapabilities('fixture', () => ({ status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, capabilities: { simulationTransportProfile: value } }) }));
    assert.equal(probe(capability).simulationTransportProfile, PROFILE);
    for (const patch of [{ allowedValues: [PROFILE, 'other'] }, { providerByProfile: { [PROFILE]: 'wrong' } },
        { cliOption: '--private-profile' }, { requiresSimulationDebug: false }, { requiresBuildInputRecord: false },
        { requiresArtifactManifest: false }]) assert.equal(supportsSimulationTransportProfile({ ...capability, ...patch }), false);
    assert.equal(probe(undefined).simulationTransportProfile, undefined);
});

for (const variant of ['authorized', 'old-package', 'old-builder', 'BLE', 'hardware']) {
    test(`normal compile.js orchestrator serializes only an authorized SPP enum: ${variant}`, async t => {
        const f = fixture(t);
        Object.assign(f.config, { currentProjectPath: f.root, boardModule: '@aily-project/board-test', code: 'void setup(){} void loop(){}' });
        fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ type: 'blockly' }));
        const board = path.join(f.root, 'node_modules/@aily-project/board-test'); fs.mkdirSync(board, { recursive: true });
        fs.writeFileSync(path.join(board, 'package.json'), '{}');
        fs.writeFileSync(path.join(board, 'board.json'), JSON.stringify({ compilerParam: `--board ${f.fqbn}` }));
        fs.writeFileSync(path.join(f.root, 'project.abi'), '{}');
        if (variant === 'hardware') delete f.config.simulationDebug;
        if (variant === 'BLE') f.data.dependencies[0].name = 'BLE';
        f.config.sourceCapture = require('./build-source-capture').captureBuildSource(f.config, {
            documentText: '{}', revision: 1, runtimeRevision: 2, pageId: 'main' });
        const request = path.join(f.root, 'request.json'); fs.writeFileSync(request, JSON.stringify(f.config));
        const ipc = channel(variant === 'old-package' ? null : PROFILE);
        let args, released = 0;
        const messages = [], modules = {
            './build-workspace-lease': { acquireBuildWorkspace: () => ({ assertOwned() {}, assertBuilderIdle() {},
                childEnvironment: () => ({}), builderEnvironment: () => ({}), release() { released++; } }) },
            './compile-preprocess': { async runCompilePreprocess(config, _temp, result) {
                await require('./compile-source').prepareCompileSource(config);
                fs.writeFileSync(result, JSON.stringify(f.data));
            } },
            './library-source-evidence': { readLibraryProjections() {} },
            './blockly-upload-state': { invalidateBlocklyUploadState() {}, captureBlocklyUploadInputs() {} },
            './simulation-transport-profile': { authorizeSimulationTransportProfile: (config, file, fqbn) =>
                authorizeSimulationTransportProfile(config, file, fqbn, ipc) },
            './builder-capabilities': { readBuilderCapabilities: () => ({ artifact: true, debug: true, inputs: true, workspace: true,
                ...(variant === 'old-builder' ? {} : { simulationTransportProfile: PROFILE }) }) },
            './builder-archive-recovery': { async compileWithArchiveRecovery(_command, actualArgs) { args = actualArgs;
                throw new Error('test stops before native compiler launch'); } },
        };
        const filename = path.join(__dirname, 'compile.js'), localRequire = createRequire(filename), module = { exports: {} };
        const source = fs.readFileSync(filename, 'utf8').replace(/\nmain\(\)\.catch\(e => \{[\s\S]*?\n\}\);\s*$/, '');
        assert.ok(!source.includes('main().catch'));
        const fakeProcess = { pid: process.pid, on() {}, env: {}, argv: [process.execPath, filename, request] };
        vm.runInNewContext(`${source}\nmodule.exports = { main };`, { module, __dirname, Buffer, process: fakeProcess,
            require: name => modules[name] || localRequire(name), console: { log() {}, warn() {}, error: (...value) => messages.push(value.join(' ')) } }, { filename });
        await module.exports.main();
        assert.equal(released, 1); assert.equal(fakeProcess.exitCode, 1);
        if (variant === 'old-builder') {
            assert.equal(args, undefined); assert.match(messages.join('\n'), /Builder does not support the host-authorized/);
        } else {
            assert.ok(args, messages.join('\n'));
            const index = args.indexOf('--simulation-transport-profile');
            if (variant === 'authorized') assert.equal(args[index + 1], PROFILE);
            else assert.equal(index, -1);
        }
        assert.equal(ipc.messages.length, ['authorized', 'old-builder', 'old-package'].includes(variant) ? 1 : 0);
    });
}
