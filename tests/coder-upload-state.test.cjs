'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canReuseCoderUpload: verifyInWorker } = require('../electron/build-workspace-publication');
const { captureCoderUploadInputs, publishCoderUploadState, invalidateCoderUploadState, canReuseCoderUpload } =
    require('../child/scripts/coder-upload-state');

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-upload-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, 'project');
    const appDataPath = path.join(root, 'appdata');
    const boardModule = '@aily-project/board-test';
    const library = '@aily-project-coder/lib-test';
    const put = (relative, contents) => {
        const filename = path.join(project, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, contents);
    };
    const manifest = { type: 'coder', entry: 'src/main.cpp', dependencies: { [boardModule]: '1', [library]: '1' } };
    const recipe = { success: true, upload: { command: 'flash main.hex', waitForUploadPort: false } };
    put('package.json', JSON.stringify(manifest));
    put(`node_modules/${boardModule}/package.json`, '{}');
    put(`node_modules/${boardModule}/board.json`, '{"name":"Test"}');
    put(`node_modules/${library}/package.json`, '{}');
    put(`node_modules/${library}/src/lib.h`, '#pragma once');
    put('sketch/src/main.cpp', 'int main() {}');
    put('sketch/src/other.h', '#pragma once');
    put('sketch/libraries/Local/src/local.h', '#pragma once');
    put('sketch/preprocess.json', JSON.stringify(recipe));
    put('.build/main.hex', 'firmware');
    const config = { currentProjectPath: project, boardModule, appDataPath };
    return { project, config, put, manifest, recipe, boardModule, library };
}

test('Coder upload reuses verified firmware across saves and checks in the native worker', async t => {
    const f = fixture(t);
    assert.equal(canReuseCoderUpload(f.config), false);
    publishCoderUploadState(f.config, captureCoderUploadInputs(f.config));
    f.put('package.json', JSON.stringify({ ...f.manifest, codeHash: 'new', buildInfo: { lastBuildStatus: 'success' } }));
    f.put('sketch/preprocess.json', JSON.stringify({ ...f.recipe, preprocessTime: new Date().toISOString() }));
    f.put('sketch/upload-config.json', '{"serialPort":"next port"}');
    assert.equal(canReuseCoderUpload(f.config), true);
    assert.equal(await verifyInWorker(f.config), true);

    for (const filename of ['sketch/src/main.cpp', 'sketch/src/other.h', 'sketch/libraries/Local/src/local.h',
        `node_modules/${f.boardModule}/board.json`, `node_modules/${f.library}/src/lib.h`, '.build/main.hex']) {
        const original = fs.readFileSync(path.join(f.project, filename));
        f.put(filename, 'changed bytes');
        assert.equal(canReuseCoderUpload(f.config), false, filename);
        f.put(filename, original);
        assert.equal(canReuseCoderUpload(f.config), true, filename);
    }
    f.put('sketch/src/partitions.csv', 'custom partitions');
    assert.equal(canReuseCoderUpload(f.config), false);
    fs.rmSync(path.join(f.project, 'sketch/src/partitions.csv'));
    f.put('package.json', JSON.stringify({ ...f.manifest, projectConfig: { FlashSize: 'smaller' } }));
    assert.equal(canReuseCoderUpload(f.config), false);
    f.put('package.json', JSON.stringify(f.manifest));
    f.put('sketch/preprocess.json', JSON.stringify({ ...f.recipe, upload: { command: 'other command' } }));
    assert.equal(canReuseCoderUpload(f.config), false);
});

test('Coder rejects stale compiler inputs and refuses a replaced firmware before opening a port', t => {
    const f = fixture(t);
    const original = captureCoderUploadInputs(f.config);
    f.put('sketch/src/other.h', '#define VALUE 42');
    assert.throws(() => publishCoderUploadState(f.config, original), /BUILD_SOURCE_STALE/);
    assert.equal(canReuseCoderUpload(f.config), false);
    publishCoderUploadState(f.config, captureCoderUploadInputs(f.config));
    f.put('.build/main.hex', 'tampered');
    f.put('sketch/upload-config.json', JSON.stringify({
        ...f.config, buildPath: path.join(f.project, '.build'), verifyCoderBuild: true,
    }));
    const result = spawnSync(process.execPath, [require.resolve('../child/scripts/upload'),
        path.join(f.project, 'sketch/upload-config.json')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BUILD_ARTIFACT_STALE/);
    assert.equal(fs.existsSync(path.join(f.project, '.build/aily-workspace.lock')), false);
    invalidateCoderUploadState(f.project);
    assert.equal(canReuseCoderUpload(f.config), false);
});
