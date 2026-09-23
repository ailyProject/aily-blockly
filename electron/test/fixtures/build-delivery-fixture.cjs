'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createBuildDeliveryAuthority } = require('../../build-delivery-authority');
const { captureBuildSource } = require('../../../child/scripts/build-source-capture');
const { captureProjectSources, publishBuildDelivery } = require('../../../child/scripts/compile-delivery');
const { createLibraryProjectionRecorder } = require('../../../child/scripts/library-source-evidence');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, coder = false) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-authority-')));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-build-authority-/);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const put = (file, content) => {
        const filename = path.join(root, file); fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, typeof content === 'string' ? content : JSON.stringify(content)); return filename;
    };
    put('package.json', { type: coder ? 'coder' : 'blockly', entry: 'src/main.cpp' });
    put('node_modules/@aily-project/board-test/board.json', {}); put('node_modules/@aily-project/board-test/package.json', {});
    put('project.abi', '{}');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup(){} void loop(){}', recordProjectDelivery: true };
    if (coder) put('sketch/src/main.cpp', config.code);
    config.sourceCapture = captureBuildSource(config, coder ? undefined : { documentText: '{}', revision: 1, runtimeRevision: 2, pageId: 'main' });
    const request = put(`.temp/compile-request-${randomUUID()}.json`, config);
    const sender = { isDestroyed: () => false };
    const state = { owner: { sender, generation: 1 }, source: { projectPath: root, mode: coder ? 'coder' : 'blockly', activationId: randomUUID(),
        boardModule: config.boardModule, ...(coder ? { saved: true } : { workspace: config.sourceCapture.workspace }) }, query: undefined };
    const dependencies = { childRoot: path.resolve(__dirname, '../../../child'), getOwner: () => state.owner,
        querySource: async () => state.query ? state.query() : { ok: true, source: state.source } };
    const api = createBuildDeliveryAuthority(dependencies), libraries = createLibraryProjectionRecorder();
    const options = { command: process.execPath, args: [path.join(dependencies.childRoot, 'scripts/compile.js'), request],
        buildWorkspace: root, buildDeliveryRequest: request, shellProfile: false, appDataResourceToken: 'reader' };
    const query = () => api.query(sender, { projectPath: root });
    const libraryFile = 'node_modules/@aily-project/lib-fixture/src/helper.h';
    function addLibrary() {
        const source = path.dirname(put(libraryFile, 'original'));
        const target = path.dirname(put('.temp/library/helper.h', 'original'));
        libraries.add('@aily-project/lib-fixture', libraries.capture(source), target);
    }
    function publish(handle, overrides = {}, recordedInputs) {
        const source = coder ? path.join(root, 'sketch/src/main.cpp') : put('.temp/sketch/sketch.ino', config.code);
        const before = captureProjectSources(config);
        let librarySnapshot = libraries.snapshot(config);
        if (process.versions.electron) {
            // Production records in child Node and consumes in Electron workers.
            // A same-runtime fixture previously hid Windows stat.dev differences.
            const producer = `const fs=require('node:fs'), {createLibraryProjectionRecorder}=require(${JSON.stringify(path.join(dependencies.childRoot, 'scripts/library-source-evidence'))});
                const {config,entries}=JSON.parse(fs.readFileSync(0,'utf8')), recorder=createLibraryProjectionRecorder();
                for(const entry of entries) recorder.add(entry.owner,recorder.capture(entry.source.requestedPath),entry.target.requestedPath,entry.inputs.map(input=>recorder.capture(input.requestedPath)));
                console.log(JSON.stringify(recorder.snapshot(config)));`;
            librarySnapshot = JSON.parse(require('node:child_process').execFileSync(
                require('../../tools/managed-npm-cli').getChildNodeExecutable(dependencies.childRoot), ['-e', producer],
                { input: JSON.stringify({ config, entries: librarySnapshot.entries }), encoding: 'utf8', windowsHide: true, timeout: 15000 }));
        }
        put('.build/aily-library-projections.json', librarySnapshot);
        const body = { schemaVersion: 1, kind: 'aily-build-input-record', scope: 'prepared-dependency-trees',
            configurationSha256: 'c'.repeat(64), roots: [{ id: 'root-0', locationSha256: 'd'.repeat(64), files: [] }] };
        const inputs = recordedInputs || { ...body, digest: hash(JSON.stringify(body)) };
        const context = { schemaVersion: 1, kind: 'aily-build-input-context', buildPath: path.join(root, '.build'), preparedInputsDigest: inputs.digest };
        if (!recordedInputs) put('.build/aily-build-input-context.json', context);
        put('.build/firmware.bin', 'synthetic firmware');
        put('.build/aily-artifact-manifest.json', { schemaVersion: 1, kind: 'aily-build-artifact', artifactId: 'a'.repeat(64),
            target: { fqbn: 'test:core:board' }, build: { source: { sha256: hash(config.code), sizeBytes: Buffer.byteLength(config.code) }, inputs },
            files: [{ path: 'firmware.bin', role: 'application', sizeBytes: Buffer.byteLength('synthetic firmware'), sha256: hash('synthetic firmware') }] });
        const receipt = publishBuildDelivery(config, before, source, 'test:core:board', librarySnapshot);
        const message = { type: 'aily.build.delivery', requestDigest: hash(JSON.stringify(config)), buildId: receipt.buildId,
            receiptSha256: hash(fs.readFileSync(path.join(root, '.build/aily-build-delivery.json'))),
            inputContextSha256: hash(fs.readFileSync(path.join(root, '.build/aily-build-input-context.json'))), ...overrides };
        handle.onMessage(message); return receipt;
    }
    return { root, put, config, request, sender, state, dependencies, api, options, query, publish, addLibrary, libraryFile };
}
module.exports = { fixture };
