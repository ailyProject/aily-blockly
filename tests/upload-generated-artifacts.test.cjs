const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureBlocklyUploadInputs, publishBlocklyUploadState, readBlocklyUploadArtifacts } = require('../child/scripts/blockly-upload-state');
const { processUploadParams, selectUploadParamForPort } = require('../child/scripts/upload');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-generated 产物-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const build = path.join(root, '.build');
    const put = (name, text = name) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
        return file;
    };
    put('package.json', JSON.stringify({ name: 'test', dependencies: {} }));
    put('node_modules/@aily-project/board-test/package.json', '{}');
    put('node_modules/@aily-project/board-test/board.json', '{}');
    for (const name of ['sketch.bin', 'sketch.bootloader.bin', 'sketch.partitions.bin', 'sketch.merged.bin',
        '000-old.bin', 'backup/sketch.bin', 'old.bootloader.bin', 'sketch_flashed.bin']) put(`.build/${name}`);
    const prepared = { success: true, envVars: { BUILD_PATH: build }, upload: { command:
        `esptool write_flash 0x0 "${build}/sketch.bootloader.bin" 0x8000 "${build}/sketch.partitions.bin" 0x10000 "${build}/sketch.bin"` } };
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}' };
    const publish = () => {
        put('.temp/preprocess.json', JSON.stringify(prepared));
        publishBlocklyUploadState(config, captureBlocklyUploadInputs(config));
    };
    const upload = () => processUploadParams("esptool 0x0 ${bootloader} 0x8000 ${partitions} 0x10000 ${'*.bin'}",
        build, root, root, '921600', {}, 'TEST_PORT', 'darwin', undefined, true);
    return { root, build, put, publish, upload, prepared };
}

test('legacy wildcard uses exact completed-build outputs while retaining old applications and SDK copies', async t => {
    const f = fixture(t); f.publish();
    const command = await f.upload();
    for (const [address, name] of [['0x0', 'sketch.bootloader.bin'], ['0x8000', 'sketch.partitions.bin'], ['0x10000', 'sketch.bin']]) {
        assert.equal(command.args[command.args.indexOf(address) + 1], `"${path.join(f.build, name)}"`);
    }
    assert(fs.existsSync(path.join(f.build, '000-old.bin')));
    assert(fs.existsSync(path.join(f.build, 'backup/sketch.bin')));
});

test('changing a generated application rejects the receipt instead of uploading another candidate', async t => {
    const f = fixture(t); f.publish(); f.put('.build/sketch.bin', 'replaced');
    await assert.rejects(f.upload(), /BUILD_ARTIFACT_STALE/);
});

test('adding an extra application requires a fresh build, which restores exact selection', async t => {
    const f = fixture(t); f.publish(); f.put('.build/another.bin');
    await assert.rejects(f.upload(), /BUILD_ARTIFACT_STALE/);
    f.publish(); assert((await f.upload()).args.includes(`"${path.join(f.build, 'sketch.bin')}"`));
});

test('later background preprocessing cannot redirect a completed-build receipt', async t => {
    const f = fixture(t); f.publish();
    f.prepared.upload.command = `flash "${f.build}/000-old.bin"`;
    f.put('.temp/preprocess.json', JSON.stringify(f.prepared));
    assert((await f.upload()).args.includes(`"${path.join(f.build, 'sketch.bin')}"`));
});

test('a recipe for another output directory cannot authorize guessing between application images', async t => {
    const f = fixture(t); f.prepared.envVars.BUILD_PATH = path.join(f.root, 'another-build'); f.publish();
    await assert.rejects(f.upload(), /FIRMWARE_AMBIGUOUS/);
});

test('an old receipt provides no generated-output authority', async t => {
    const f = fixture(t); f.put('.build/aily-upload-state.json', JSON.stringify({ schemaVersion: 1 }));
    assert.deepEqual(readBlocklyUploadArtifacts(f.build), []);
    await assert.rejects(f.upload(), /FIRMWARE_AMBIGUOUS/);
});


function espSrFixture(t) {
    const f = fixture(t);
    f.prepared.upload = {
        toolName: 'esptool_py', command: f.prepared.upload.command + ` 0xC10000 ${f.build}/srmodels.bin`
    };
    f.prepared.arduinoConfig = { board: {
        'build.mcu': 'esp32s3', 'build.partitions': 'esp_sr_16', 'upload.extra_flags': '0xC10000 {build.path}/srmodels.bin'
    } };
    return f;
}

test('ESP SR partition without the library omits only its optional model from the receipt and upload command', t => {
    const f = espSrFixture(t);
    const original = f.prepared.upload.command;
    f.publish();
    assert.deepEqual(readBlocklyUploadArtifacts(f.build), ['sketch.bin', 'sketch.bootloader.bin', 'sketch.partitions.bin']
        .map(name => path.join(f.build, name)));
    const upload = selectUploadParamForPort(f.root, 'serial', {});
    assert.equal(upload.success, true);
    assert.equal(upload.uploadParam, original.slice(0, original.indexOf(' 0xC10000 ')));
});

test('an ESP_SR build requires its model and records it when present', t => {
    const f = espSrFixture(t);
    f.put('.build/libraries/ESP_SR/esp_sr.cpp.o');
    assert.throws(f.publish, /ESP_SR was built but srmodels.bin is missing/);
    assert.throws(() => selectUploadParamForPort(f.root, 'serial', {}), /ESP_SR was built but srmodels.bin is missing/);
    const model = f.put('.build/srmodels.bin');
    f.publish();
    assert.ok(readBlocklyUploadArtifacts(f.build).includes(model));
    assert.equal(selectUploadParamForPort(f.root, 'serial', {}).uploadParam, f.prepared.upload.command);
});

test('an unrelated missing image or an invalid existing model still fails artifact validation', t => {
    const f = espSrFixture(t);
    fs.unlinkSync(path.join(f.build, 'sketch.bootloader.bin'));
    assert.throws(f.publish, /Generated upload output is missing or invalid/);
    f.put('.build/sketch.bootloader.bin');
    f.put('.build/srmodels.bin', '');
    assert.throws(f.publish, /Empty firmware output/);
    assert.throws(() => selectUploadParamForPort(f.root, 'serial', {}), /Invalid ESP_SR model image/);
});
