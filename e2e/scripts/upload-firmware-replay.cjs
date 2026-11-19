'use strict';

// Replays issue #695 with installed SDK/compiler tools and published board
// snapshots. Always uses a nonexistent device; it never flashes hardware.
// node e2e/scripts/upload-firmware-replay.cjs <app-data> <baseline-evidence> <new-output>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const host = path.resolve(__dirname, '../..');
const [appDataArg, baselineArg, outputArg] = process.argv.slice(2);
if (!appDataArg || !baselineArg || !outputArg) throw new Error('Expected app-data, baseline-evidence, new-output paths.');
const appData = path.resolve(appDataArg), baseline = path.resolve(baselineArg), output = path.resolve(outputArg);
assert(!fs.existsSync(output), 'Use a new output directory to preserve earlier evidence.');
fs.mkdirSync(output, {recursive:true});
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const put = (file, data) => { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data,null,2)); };
const stripQuotes = value => value.replace(/^"|"$/g, '');
const build = path.join(output,'current/.build');
const current = path.join(output,'current');
const builder = path.join(appData,'npm-global/lib/node_modules/@aily-project/aily-builder/index.js');
const uploader = path.join(host,'child/scripts/upload.js');
const {processUploadParams, selectUploadParamForPort} = require(uploader);
const {selectFirmwareFile} = require(path.join(host,'child/scripts/firmware-selection.js'));
const cases = [], executions = [];
const device = process.platform === 'win32' ? 'COM99999' : '/dev/aily-issue695-nonexistent';

function run(args, logfile, timeout = 120000) {
    const result = spawnSync(process.execPath,args,{encoding:'utf8',timeout,cwd:host,maxBuffer:32*1024*1024});
    const log = `${result.stdout || ''}\n${result.stderr || ''}`;
    put(logfile,log);
    assert(!result.error, String(result.error));
    return {status:result.status,log};
}

(async () => {
    fs.mkdirSync(build,{recursive:true});
    const sketch = path.join(current,'sketch.ino');
    put(sketch,fs.readFileSync(path.join(baseline,'current/sketch.ino'),'utf8'));
    const preprocess = path.join(current,'.temp/preprocess.json');
    fs.mkdirSync(path.dirname(preprocess),{recursive:true});
    const options = ['--board','esp32:esp32:esp32s3','--sdk-path',path.join(appData,'sdk/esp32_3.3.10'),
        '--tools-path',path.join(appData,'tools'),'--build-path',build,
        '--tool-versions','esp-x32@14.2.0,esptool_py@5.3.0,esp32s3-libs@3.3.10,ctags@5.8.0'];
    assert.equal(run([builder,'preprocess',sketch,...options,'--save-result',preprocess],path.join(current,'preprocess.log')).status,0);
    const compilation = run([builder,'compile',sketch,...options,'--preprocess-result',preprocess,'--no-archive-cloud-cache','--no-fetch-archive-cloud-cache','-j','4'],path.join(current,'compile.log'));
    assert.equal(compilation.status,0,compilation.log.slice(-5000));
    const binaries = fs.readdirSync(build).filter(file=>file.endsWith('.bin'));
    assert(binaries.includes('boot_app0.bin') && binaries.includes('sketch.bin'));
    const artifacts = binaries.map(file=>{const bytes=fs.readFileSync(path.join(build,file));return {file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
    const clean = path.join(output,'without-boot-app0');
    fs.mkdirSync(clean);
    binaries.filter(file=>file!=='boot_app0.bin').forEach(file=>fs.copyFileSync(path.join(build,file),path.join(clean,file)));

    for (const version of ['3.3.10','3.3.11','3.2.1']) {
        const project = path.join(output,`replay-${version}`);
        const boardDir = path.join(project,'node_modules/@aily-project/board-esp32s3');
        fs.mkdirSync(boardDir,{recursive:true});
        for(const file of ['board.json','package.json']) fs.copyFileSync(path.join(baseline,'published',version,file),path.join(boardDir,file));
        put(path.join(project,'package.json'),{name:'firmware-replay',type:'arduino',dependencies:{'@aily-project/board-esp32s3':version}});
        put(path.join(project,'.temp/preprocess.json'),fs.readFileSync(preprocess,'utf8'));
        const board=json(path.join(boardDir,'board.json')), pkg=json(path.join(boardDir,'package.json'));
        const selected=selectUploadParamForPort(project,'serial',board,undefined);
        assert(selected.success);
        const dependencies=Object.fromEntries(Object.entries(pkg.boardDependencies).filter(([key])=>key.startsWith('@aily-project/tool-')).map(([key,value])=>[key.replace('@aily-project/tool-',''),value]));
        for(const [scenario,directory] of [['real-build-with-boot-app0',build],['without-boot-app0',clean]]) {
            if(version==='3.3.10' && directory===clean) continue;
            const parsed=await processUploadParams(selected.uploadParam,directory,path.join(appData,'tools'),path.join(appData,'sdk/esp32_'+pkg.boardDependencies['@aily-project/sdk-esp32']),'921600',dependencies,device,process.platform,undefined,selected.source==='preprocess');
            const application=stripQuotes(parsed.args[parsed.args.indexOf('0x10000')+1]);
            assert.equal(path.basename(application),'sketch.bin');
            cases.push({version,scenario,source:selected.source,application,command:parsed.command,args:parsed.args});
        }
        const config=path.join(project,'.temp/upload-config.json');
        put(config,{currentProjectPath:project,buildPath:build,boardModule:'@aily-project/board-esp32s3',appDataPath:appData,serialPort:device,portType:'serial',use_1200bps_touch:false,wait_for_upload:false});
        const baselineRun=run([uploader,config],path.join(project,'upload.log'),30000);
        const execution=baselineRun.log.split('\n').find(line=>line.startsWith('Executing:'));
        assert(execution && /0x10000 "[^"]*sketch\.bin"/.test(execution),baselineRun.log);
        assert.notEqual(baselineRun.status,0);
        assert(baselineRun.log.includes('Could not open '+device),baselineRun.log);
        executions.push({version,scenario:'normal',status:baselineRun.status,execution,stoppedAt:'nonexistent serial port'});

        for(const extra of ['000-ai-output.bin','backup/old.bin','old.bootloader.bin']) {
            const filename=path.join(build,extra);
            fs.mkdirSync(path.dirname(filename),{recursive:true});
            fs.copyFileSync(path.join(build,'sketch.bin'),filename);
            try {
                const result=run([uploader,config],path.join(project,extra.replaceAll('/','-')+'.log'),30000);
                const blocked=version!=='3.3.10';
                if(blocked) {
                    assert.equal(result.status,1,result.log);
                    assert(result.log.includes('FIRMWARE_AMBIGUOUS') && result.log.includes(extra),result.log);
                    assert(!result.log.includes('Executing:'),result.log);
                } else {
                    assert(result.log.includes('0x10000 "'+path.join(build,'sketch.bin')+'"'),result.log);
                    assert(result.log.includes('Could not open '+device),result.log);
                }
                executions.push({version,scenario:extra,status:result.status,stoppedAt:blocked?'firmware ambiguity before tool launch':'explicit SDK path, then nonexistent serial port'});
                if(extra.endsWith('old.bin') || extra==='000-ai-output.bin') {
                    assert.throws(()=>selectFirmwareFile([...binaries.map(name=>path.join(build,name)),filename]),/FIRMWARE_AMBIGUOUS/);
                }
            } finally {fs.unlinkSync(filename);}
        }
    }
    const report={hostVersion:json(path.join(host,'package.json')).version,builderVersion:json(path.join(path.dirname(builder),'package.json')).version,
        platform:process.platform,compiledSdk:'3.3.10',artifacts,cases,executions,
        scope:'Real SDK compilation and actual upload.js CLI runs with published board configurations. No Windows or hardware acceptance. Legacy board recipes replayed against current SDK artifacts.'};
    put(path.join(output,'result.json'),report);
    console.log(JSON.stringify({output,artifacts,cases:cases.map(({version,scenario,application})=>({version,scenario,application})),executions},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
