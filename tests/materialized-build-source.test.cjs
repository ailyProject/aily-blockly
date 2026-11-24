'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { prepareCompileSource, captureBlocklyCompileSource } = require('../child/scripts/compile-source');
const { captureBuildSource } = require('../child/scripts/build-source-capture');
function fixture(t, coder = false) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-materialized-source-')));
    t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.match(path.basename(root), /^aily-materialized-source-/); fs.rmSync(root, { recursive: true, force: true }); });
    const put = (file, data) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); return target; };
    put('package.json', JSON.stringify({ type: coder ? 'coder' : 'blockly' }));
    put('node_modules/@aily-project/board-test/board.json', '{"compilerParam":"-b test:core:test"}');
    put('node_modules/@aily-project/board-test/package.json', '{}');
    const config = { currentProjectPath: root, boardModule: '@aily-project/board-test', code: 'void setup(){}\r\nvoid loop(){} // 中文 UTF-8\r\n' };
    return { root, put, config };
}
test('materialized checks bind exact UTF-8 input and detect a changed-and-restored file identity', async t => {
    const f = fixture(t), entry = await prepareCompileSource(f.config);
    const captured = captureBlocklyCompileSource(f.config, entry);
    assert.doesNotThrow(() => captureBlocklyCompileSource(f.config, entry, captured));
    const alternate = f.put('.temp/sketch/other.ino', f.config.code);
    fs.unlinkSync(entry); fs.renameSync(alternate, entry);
    assert.throws(() => captureBlocklyCompileSource(f.config, entry, captured), { code: 'BUILD_SOURCE_STALE' });
});
test('shared Blockly staging preserves identical files and prunes removed or replaced inputs', async t => {
    const f = fixture(t);
    const header = 'variables_main-12345678.h';
    const oldHeader = 'objects_old-12345678.h';
    const retainedInput = 'nested/保留.h';
    const removedInput = 'nested/removed.cpp';
    f.config.execution = { layout: 'shared' };
    f.config.generatedArtifacts = [{ fileName: header, content: '#define VALUE 1' }, { fileName: oldHeader, content: '' }];
    f.put(`src/${header}`, 'obsolete declaration on disk');
    f.put('src/sketch.ino', 'obsolete sketch on disk');
    f.put(`src/${retainedInput}`, 'unchanged user header');
    f.put(`src/${removedInput}`, 'removed user source');
    f.put('src/flipped/old.h', 'old nested source');
    const filename = await prepareCompileSource(f.config);
    const destination = path.dirname(filename);
    const entry = name => path.join(destination, name);
    const stable = ['sketch.ino', header, retainedInput];
    for (const name of stable) fs.utimesSync(entry(name), 1_600_000_000, 1_600_000_000);
    const stats = name => {
        const { ino, size, mtimeMs, ctimeMs } = fs.statSync(entry(name));
        return { ino, size, mtimeMs, ctimeMs };
    };
    const before = stable.map(stats);
    const proof = captureBlocklyCompileSource(f.config, filename);
    assert.equal(await prepareCompileSource(f.config), filename);
    assert.deepEqual(stable.map(stats), before);
    assert.deepEqual(captureBlocklyCompileSource(f.config, filename, proof), proof);
    assert.equal(fs.readFileSync(entry(header), 'utf8'), '#define VALUE 1');

    f.config.code = f.config.code.replace('setup()', 'setup( )');
    f.config.generatedArtifacts = [{ fileName: header, content: '#define VALUE 2' }];
    fs.unlinkSync(path.join(f.root, 'src', removedInput));
    fs.rmSync(path.join(f.root, 'src/flipped'), { recursive: true });
    f.put('src/flipped', 'replacement source file');
    await prepareCompileSource(f.config);
    assert.equal(fs.readFileSync(filename, 'utf8'), f.config.code);
    assert.equal(fs.readFileSync(entry(header), 'utf8'), '#define VALUE 2');
    assert.equal(fs.readFileSync(entry('flipped'), 'utf8'), 'replacement source file');
    assert.equal(fs.existsSync(entry(oldHeader)), false);
    assert.equal(fs.existsSync(entry(removedInput)), false);
    assert.deepEqual(stats(retainedInput), before[2]);
    assert.equal(fs.readFileSync(path.join(f.root, 'src/sketch.ino'), 'utf8'), 'obsolete sketch on disk');
    assert.notDeepEqual(stats('sketch.ino'), before[0]);
    assert.doesNotThrow(() => captureBlocklyCompileSource(f.config, filename));
});
test('Coder keeps its existing capture contract instead of applying Blockly paths or fingerprints', t => {
    const f = fixture(t, true);
    assert.equal(captureBlocklyCompileSource(f.config, path.join(f.root, 'sketch/src/main.cpp')), undefined);
});
for (const timing of ['none', 'before', 'after']) for (const captured of [false, true]) {
    test(`ordinary compile ${captured ? 'with' : 'without'} host source capture rejects ${timing} materialized input drift`, t => {
        const f = fixture(t);
        if (captured) f.config.sourceCapture = captureBuildSource(f.config);
        const request = f.put('.temp/request.json', JSON.stringify(f.config));
        f.put('.build/aily-upload-state.json', 'old success');
        const compiler = path.resolve(__dirname, '../child/scripts/compile.js');
        const boot = `const fs=require('fs'),p=require('path'),Module=require('module'),original=Module._load,c=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),timing=process.argv[3];
          const root=c.currentProjectPath,entry=p.join(root,'.temp/sketch/sketch.ino');
          const put=(f,b)=>{fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,b)};
          Module._load=function(name,parent,...args){
            if(parent?.filename===process.argv[1] && name==='./compile-preprocess')return{runCompilePreprocess:async()=>{put(entry,c.code);put(p.join(root,'.temp/preprocess.json'),JSON.stringify({success:true,envVars:{BUILD_PATH:p.join(root,'.build')},upload:{command:'flash "'+p.join(root,'.build/firmware.bin')+'"'}}))}};
            if(parent?.filename===process.argv[1] && name==='./builder-capabilities')return{readBuilderCapabilities:()=>{if(timing==='before')put(entry,'changed before Builder spawn');return{}}};
            if(parent?.filename===process.argv[1] && name==='./builder-archive-recovery')return{...original.call(this,name,parent,...args),compileWithArchiveRecovery:async(_command,args)=>{put(p.join(root,'builder-started'),'yes');put(p.join(root,'.build/firmware.bin'),'firmware');if(timing==='after')put(entry,'changed after Builder close');return{exitCode:0,signal:null,spawnError:null,args,output:[]}}};
            return original.call(this,name,parent,...args)
          };require(process.argv[1]);`;
        const result = spawnSync(process.execPath, ['-e', boot, compiler, request, timing], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.ifError(result.error);
        assert.equal(result.status, timing === 'none' ? 0 : 1, result.stderr);
        assert.equal(fs.existsSync(path.join(f.root, '.build/aily-upload-state.json')), timing === 'none');
        if (timing !== 'none') assert.match(result.stderr, /BUILD_SOURCE_STALE/);
        assert.equal(fs.existsSync(path.join(f.root, 'builder-started')), timing !== 'before');
        if (timing === 'after') {
            const report = JSON.parse(fs.readFileSync(path.join(f.root, '.build/aily-builder-compile-report.json'), 'utf8'));
            assert.equal(report.status, 'failed');
            assert.equal(fs.existsSync(path.join(f.root, '.build/aily-build-delivery.json')), false);
        }
    });
}
