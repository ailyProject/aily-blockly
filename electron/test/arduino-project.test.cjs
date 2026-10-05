const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const { projectDirectoryFromArgs, projectDirectoryForFile } = require('../project-open-path');
const { createBuildPlan, createBuilderConfig } = require('../../scripts/build-electron');
const compileProject = require('../../child/scripts/aily-code-project');
const { prepareCompileSource } = require('../../child/scripts/compile-source');
function loadTs(file, window) {
 const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../src/app/services/domains/project', file), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports = {};
 vm.runInNewContext(source, {exports,window});
 return exports;
}
function fixture(t, name = 'Blink') {
 const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'arduino-open-'));
 fs.mkdirSync(path.join(parent,name)); const root = fs.realpathSync(path.join(parent,name));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const window = {path, fs:{...fs, statSync:file=>({_isFile:fs.statSync(file).isFile()}), readDirSync:dir=>fs.readdirSync(dir,{withFileTypes:true}).map(item=>({name:item.name,_isFile:item.isFile()}))}};
 return {root,api:loadTs('coder/arduino-sketch.ts',window)};
}
test('Arduino open preserves sources, picks the primary tab and reuses saved settings', async t=>{
 const {root,api}=fixture(t); const source='void setup(){}\nvoid loop(){}';
 fs.writeFileSync(path.join(root,'Blink.ino'),source); fs.writeFileSync(path.join(root,'A.ino'),'int extra;');
 assert.equal(api.normalizeProjectOpenPath(path.join(root,'A.ino')),root);
 assert.equal(api.findArduinoSketchEntry(root),'Blink.ino');
 api.prepareArduinoSketchProject(root);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
 assert.equal(manifest.arduinoSketch,true); assert.equal(manifest.entry,'Blink.ino');
 assert.equal(fs.readFileSync(path.join(root,'Blink.ino'),'utf8'),source);
 assert.equal(compileProject.resolveCompileSourcePath(root),path.join(root,'Blink.ino'));
 assert.equal(compileProject.resolveCompileWorkspacePath(root),path.join(root,'sketch'));
 assert.equal(await prepareCompileSource({currentProjectPath:root,code:source,recordProjectDelivery:true}),path.join(root,'Blink.ino'));
 manifest.projectConfig={cpu:'atmega2560'}; fs.writeFileSync(path.join(root,'package.json'),JSON.stringify(manifest));
 api.prepareArduinoSketchProject(root);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).projectConfig,manifest.projectConfig);
});
test('Marlin layout retains src and configuration files; board switch retains the native entry',t=>{
 const {root,api}=fixture(t,'Marlin'); fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'Marlin.ino'),'// entry'); fs.writeFileSync(path.join(root,'Configuration.h'),'#define USER_SETTING 1');
 fs.writeFileSync(path.join(root,'src','MarlinCore.cpp'),'void setup(){}');
 api.prepareArduinoSketchProject(root);
 const old=JSON.parse(fs.readFileSync(path.join(root,'package.json'))); const next={};
 loadTs('coder/coder-project-template.ts',{}).applyCoderProjectPackageConfig(next,'@aily-project/board-arduino_mega','1.8.6',old);
 assert.equal(next.arduinoSketch,true); assert.equal(next.entry,'Marlin.ino');
 assert.equal(fs.readFileSync(path.join(root,'Configuration.h'),'utf8'),'#define USER_SETTING 1');
 assert.ok(fs.existsSync(path.join(root,'src','MarlinCore.cpp')));
});
test('ambiguous sketches and existing manifests are never silently converted',t=>{
 const {root,api}=fixture(t); for(const name of ['A.ino','B.ino'])fs.writeFileSync(path.join(root,name),'');
 assert.equal(api.findArduinoSketchEntry(root),null); assert.throws(()=>api.prepareArduinoSketchProject(root));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}'); api.prepareArduinoSketchProject(root);
 assert.equal(fs.readFileSync(path.join(root,'package.json'),'utf8'),'{"type":"module"}');
 const mode=loadTs('project-mode.ts',{});
 assert.equal(mode.detectProjectMode({hasAbi:false,hasAci:false,hasArduinoSketch:true}),'coder');
 assert.equal(mode.detectProjectMode({hasAbi:true,hasAci:false,hasArduinoSketch:true}),'blockly');
 assert.equal(mode.detectProjectMode({manifest:{type:'module'},hasAbi:false,hasAci:false,hasArduinoSketch:true}),null);
});
test('file launch resolves paths with spaces, relative second-instance paths, and rejects directories ending ino',t=>{
 const {root}=fixture(t,'Arduino 空格'); const file=path.join(root,'Arduino 空格.ino'); fs.writeFileSync(file,'');
 assert.equal(projectDirectoryForFile(file),root);
 assert.equal(projectDirectoryFromArgs(['coder',path.basename(file)],root),root);
 assert.equal(projectDirectoryFromArgs(['coder',`--open-project=${file}`]),root);
 assert.equal(projectDirectoryFromArgs(['coder',`--open-project=${root}`]),root);
 fs.mkdirSync(path.join(root,'fake.ino')); assert.equal(projectDirectoryForFile(path.join(root,'fake.ino')),null);
});
test('Coder packages register ino on all platforms without giving Blockly the association',()=>{
 const config={regions:{cn:{updater:'https://example.test/blockly'}}};
 const coder=createBuilderConfig(createBuildPlan(['--product','coder'],config),{});
 const blockly=createBuilderConfig(createBuildPlan([],config),{});
 for(const platform of ['win','mac','linux']) {
  assert.deepEqual(coder[platform].fileAssociations.map(item=>item.ext),['aci','ino']);
  assert.equal(blockly[platform].fileAssociations,undefined);
 }
});

test('native firmware names are exposed to Coder and resolve in the upload command',async t=>{
 const {root}=fixture(t,'Arduino 空格'); const build=path.join(root,'.build'); fs.mkdirSync(build);
 const firmware=path.join(build,'Blink.v2.hex'); fs.writeFileSync(firmware,':00000001FF');
 fs.writeFileSync(path.join(build,'Blink.v2.with_bootloader.hex'),':00000001FF');
 fs.writeFileSync(path.join(build,'Blink.v2.bin'),'binary');
 const window={path,fs,tools:{findFileByName:async dir=>fs.readdirSync(dir).map(name=>path.join(dir,name))}};
 const artifacts=loadTs('../../../utils/builder.utils.ts',window);
 const outputs=await artifacts.resolveActualBuildOutputs(root,build);
 assert.ok(outputs.artifacts.some(file=>file.label==='Blink.v2.hex' && file.rel==='.build/Blink.v2.hex'));
 assert.ok(outputs.artifacts.some(file=>file.label==='Blink.v2.bin'));
 assert.equal(await artifacts.resolveMainHexAbsolutePath(build),firmware);
 assert.equal((await artifacts.resolveActualMainHexLocation(root,build)).abs,firmware);
 const {processUploadParams}=require('../../child/scripts/upload');
 const command=await processUploadParams("avrdude -P${serial} -b${baud} -Uflash:w:${'*.hex'}:i",build,root,root,115200,{},'/dev/validation','darwin',null,true);
 assert.equal(command.command,'avrdude');
 assert.ok(command.args.includes(`-Uflash:w:"${firmware}":i`));
 assert.ok(command.args.includes('-P/dev/validation'));
});
