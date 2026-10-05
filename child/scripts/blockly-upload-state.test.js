'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { captureBlocklyUploadInputs: capture, publishBlocklyUploadState: publish,
    invalidateBlocklyUploadState: invalidate, canReuseBlocklyUpload: reusable } = require('./blockly-upload-state');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-upload-reuse-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
    write('package.json', JSON.stringify({ name: 'test', dependencies: { '@aily-project/board-test': '1', '@aily-project/lib-test': '1' }, MACROS: [['WIDTH=240']] }));
    write('node_modules/@aily-project/board-test/package.json', '{}');
    write('node_modules/@aily-project/board-test/board.json', '{"compilerParam":"--board test"}');
    write('node_modules/@aily-project/lib-test/package.json', '{"name":"@aily-project/lib-test"}');
    write('node_modules/@aily-project/lib-test/src/test.h', '#define VALUE 1');
    write('src/custom.h', '#define CUSTOM 1');
    write('partitions.csv', 'first');
    write('.build/sketch.ino.hex', 'firmware');
    write('.build/sketch.ino.elf', 'symbols');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup() {}',
        projectMacros: [{ name: 'WIDTH', value: 'WIDTH=240' }], generatedArtifacts: [] };
    const build = () => publish(config, capture(config));
    build();
    return { root, write, config, build };
}

test('unchanged successful build is reusable without writing inputs, firmware or metadata', t => {
    const f = fixture(t), filename = path.join(f.root, '.build/aily-upload-state.json');
    const before = fs.statSync(filename).mtimeMs;
    assert.equal(reusable(f.config), true);
    assert.equal(fs.statSync(filename).mtimeMs, before);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-workspace.lock')), false);
});

for (const [name, mutate] of [
    ['code', f => { f.config.code = 'changed'; }],
    ['generator macros only', f => { f.config.projectMacros[0].value = 'WIDTH=320'; }],
    ['generated header only', f => { f.config.generatedArtifacts = [{ fileName: 'variables_data-12345678.h', content: 'new' }]; }],
    ['project macros', f => { const file = path.join(f.root, 'package.json'), pkg = JSON.parse(fs.readFileSync(file)); pkg.MACROS = [['WIDTH=320']]; fs.writeFileSync(file, JSON.stringify(pkg)); }],
    ['project source', f => f.write('src/custom.h', '#define CUSTOM 2')],
    ['partition', f => f.write('partitions.csv', 'second')],
    ['board options', f => f.write('node_modules/@aily-project/board-test/board.json', '{"compilerParam":"--board other"}')],
    ['library source', f => f.write('node_modules/@aily-project/lib-test/src/test.h', '#define VALUE 2')],
    ['new library source', f => f.write('node_modules/@aily-project/lib-test/src/new.cpp', 'int x;')],
    ['deleted firmware', f => fs.unlinkSync(path.join(f.root, '.build/sketch.ino.hex'))],
    ['changed firmware', f => f.write('.build/sketch.ino.hex', 'other firmware')],
    ['empty firmware', f => f.write('.build/sketch.ino.hex', '')],
]) test(`${name} requires rebuilding`, t => {
    const f = fixture(t); mutate(f); assert.equal(reusable(f.config), false);
});

test('deleted build directory stays absent during the read-only decision', t => {
    const f = fixture(t), dir = path.join(f.root, '.build'); fs.rmSync(dir, { recursive: true });
    assert.equal(reusable(f.config), false); assert.equal(fs.existsSync(dir), false);
    fs.mkdirSync(dir); assert.equal(reusable(f.config), false);
});

test('result metadata and background caches do not invalidate successful firmware', t => {
    const f = fixture(t), pkg = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json')));
    f.write('package.json', JSON.stringify({ ...pkg, codeHash: 'new', buildInfo: { lastBuildStatus: 'success' } }));
    f.write('.temp/preprocess.json', '{"success":true}'); f.write('.build/aily-artifact-manifest.json', '{}');
    assert.equal(reusable(f.config), true);
});

test('failed or cancelled compilation cannot reuse the old success receipt', t => {
    const f = fixture(t); invalidate(f.root); assert.equal(reusable(f.config), false);
});

test('input changes during compilation refuse publication; only a fresh build becomes reusable', t => {
    const f = fixture(t), before = capture(f.config); invalidate(f.root);
    f.write('src/custom.h', 'new source');
    assert.throws(() => publish(f.config, before), /BUILD_SOURCE_STALE/);
    assert.equal(reusable(f.config), false);
    f.build(); assert.equal(reusable(f.config), true);
});

test('nested and linked libraries follow preprocessing resolution', t => {
    const f = fixture(t);
    f.write('node_modules/@aily-project/lib-test/package.json', '{"dependencies":{"@aily-project/lib-nested":"1"}}');
    const nested = 'node_modules/@aily-project/lib-test/node_modules/@aily-project/lib-nested';
    f.write(`${nested}/package.json`, '{}'); f.write(`${nested}/src/a.h`, 'nested');
    f.build(); f.write(`${nested}/src/a.h`, 'changed'); assert.equal(reusable(f.config), false);
    const lib = path.join(f.root, 'node_modules/@aily-project/lib-test');
    const linked = path.join(f.root, 'linked-library'); fs.renameSync(lib, linked); fs.symlinkSync(linked, lib, 'junction');
    f.build(); f.write('linked-library/src/test.h', 'linked change'); assert.equal(reusable(f.config), false);
});

test('Coder cannot enter Blockly reuse even with a copied receipt', t => {
    const f = fixture(t); f.write('package.json', '{"type":"coder"}');
    assert.equal(reusable(f.config), false);
});
