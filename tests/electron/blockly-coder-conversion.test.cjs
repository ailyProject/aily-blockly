const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { convertBlocklyProjectToCoder } = require('../../electron/blockly-coder-conversion');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'blockly-coder-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const source = path.join(parent, '中文 空格');
  const write = (name, content) => {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  };
  write('package.json', JSON.stringify({ name: 'blocks', nickname: '测试', devmode: 'arduino',
    cloudId: 'old-cloud', codeHash: 'old-build', projectConfig: { CDCOnBoot: 'cdc' },
    dependencies: { '@aily-project/board-test': '1.2.3', '@aily-project/lib-test': '2.0.0', local: 'file:./local' } }));
  write('project.abi', '{"blocks":{}}');
  write('.temp/sketch/sketch.ino', '#include "src/variables.h"\nvoid setup() {}\nvoid loop() {}');
  write('.temp/sketch/secondary.cpp', '// secondary');
  write('.temp/sketch/package.json', '{}');
  write('src/variables.h', '#define VALUE 42');
  write('components/local/src/helper.cpp', '// component');
  write('local/package.json', '{"name":"local","version":"1.0.0"}');
  write('.aily/project-open.lock', 'lock'); write('node_modules/cache/file', 'cache');
  return { source: fs.realpathSync(source), write };
}

test('copies generated source, user headers, components, configuration and outer dependencies', t => {
  const {source}=fixture(t);
  const original=fs.readFileSync(path.join(source,'package.json'),'utf8');
  const target=convertBlocklyProjectToCoder(source);
  const manifest=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8'));
  assert.equal(manifest.type,'coder'); assert.equal(manifest.entry,'src/main.cpp');
  assert.deepEqual(manifest.sourceRoots,['src','libraries']);
  assert.equal(manifest.arduinoSketch,undefined);
  assert.equal(manifest.dependencies['@aily-project/lib-test'],'2.0.0');
  assert.equal(manifest.boardDependencies['@aily-project/board-test'],'1.2.3');
  assert.deepEqual(manifest.projectConfig,{CDCOnBoot:'cdc'});
  assert.equal(manifest.dependencies.local,'file:local');
  assert.equal(manifest.cloudId,undefined); assert.equal(manifest.codeHash,undefined);
  assert.match(fs.readFileSync(path.join(target,'.npmrc'),'utf8'),/install-links=true/);
  assert.match(fs.readFileSync(path.join(target,'sketch/src/main.cpp'),'utf8'),/^#include <Arduino.h>\n\n#include "variables.h"/);
  for(const file of ['sketch/src/variables.h','sketch/src/secondary.cpp','components/local/src/helper.cpp','local/package.json']) {
    assert.ok(fs.existsSync(path.join(target,file)),file);
  }
  for(const file of ['project.abi','project.aci','node_modules','.temp','.aily','sketch/package.json','sketch/sketch.ino','sketch/secondary.cpp','src']) {
    assert.equal(fs.existsSync(path.join(target,file)),false,file);
  }
  assert.equal(fs.readFileSync(path.join(source,'package.json'),'utf8'),original);
  assert.ok(fs.existsSync(path.join(source,'project.abi')));
});

test('merges Arduino tabs and relocates local includes without changing library or nested includes', t => {
  const {source,write}=fixture(t);
  write('.temp/sketch/sketch.ino', '#include <Arduino.h>\n#include "helper.h"\n#include "src/variables.h"\n#include "Library.h"\nvoid setup() { helper(); }');
  write('.temp/sketch/z.ino', 'void loop() {}');
  write('.temp/sketch/a.ino', 'void helper() {}');
  write('.temp/sketch/helper.h', '#include "src/variables.h"\n');
  write('.temp/sketch/secondary.cpp', '#include "helper.h"\n#include "src/variables.h"\n');
  write('src/nested/inner.h', '#include "../variables.h"\n#include "../../helper.h"\n');
  const target=convertBlocklyProjectToCoder(source,path.join(source,'.temp/sketch/z.ino'));
  const main=fs.readFileSync(path.join(target,'sketch/src/main.cpp'),'utf8');
  assert.equal((main.match(/#include <Arduino.h>/g)||[]).length,1);
  assert.match(main,/#include "helper.h"\n#include "variables.h"\n#include "Library.h"/);
  assert.ok(main.indexOf('void setup')<main.indexOf('void helper'));
  assert.ok(main.indexOf('void helper')<main.indexOf('void loop'));
  assert.equal(fs.readFileSync(path.join(target,'sketch/src/helper.h'),'utf8'),'#include "variables.h"\n');
  assert.equal(fs.readFileSync(path.join(target,'sketch/src/secondary.cpp'),'utf8'),'#include "helper.h"\n#include "variables.h"\n');
  assert.equal(fs.readFileSync(path.join(target,'sketch/src/nested/inner.h'),'utf8'),'#include "../variables.h"\n#include "../helper.h"\n');
  for (const file of ['sketch.ino','a.ino','z.ino','helper.h','secondary.cpp']) assert.equal(fs.existsSync(path.join(target,'sketch',file)),false);
});

test('converts a root ino without retaining duplicate source files outside the Coder workspace', t => {
  const {source,write}=fixture(t);
  write('demo.ino','#include "src/variables.h"\nvoid setup() {}\nvoid loop() {}');
  write('helper.cpp','int helper() { return 42; }');
  const target=convertBlocklyProjectToCoder(source,path.join(source,'demo.ino'));
  assert.ok(fs.existsSync(path.join(target,'sketch/src/main.cpp')));
  assert.ok(fs.existsSync(path.join(target,'sketch/src/helper.cpp')));
  for (const file of ['demo.ino','helper.cpp','sketch/demo.ino']) assert.equal(fs.existsSync(path.join(target,file)),false);
});

test('rejects conflicting source names without overwriting user code or retaining a partial copy', t => {
  const {source,write}=fixture(t);
  write('src/main.cpp','// independent user code');
  assert.throws(()=>convertBlocklyProjectToCoder(source),/源文件重名/);
  assert.equal(fs.existsSync(`${source}_coder`),false);
  assert.equal(fs.readFileSync(path.join(source,'src/main.cpp'),'utf8'),'// independent user code');
});

test('reserves a unique sibling without overwriting an existing project', t => {
  const {source}=fixture(t);
  const first=convertBlocklyProjectToCoder(source); const second=convertBlocklyProjectToCoder(source);
  assert.equal(second,`${first}_1`); assert.ok(fs.existsSync(path.join(first,'package.json')));
});

test('persists custom partitions from the project, generated sketch or selected board in priority order', t => {
  const {source,write}=fixture(t);
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  manifest.projectConfig.PartitionScheme='custom'; write('package.json',JSON.stringify(manifest));
  const board='node_modules/@aily-project/board-test/partitions.csv';
  write(board,'board default');
  const check=expected=> {
    const target=convertBlocklyProjectToCoder(source);
    assert.equal(fs.readFileSync(path.join(target,'sketch/src/partitions.csv'),'utf8'),expected);
  };
  check('board default');
  write('.temp/sketch/partitions.csv','generated'); check('generated');
  write('partitions.csv','legacy project'); check('legacy project');
  write('src/partitions.csv','custom user'); check('custom user');
  assert.equal(fs.readFileSync(path.join(source,board),'utf8'),'board default');
});

test('rejects missing or outside source and rolls back a copy failure', t => {
  const {source,write}=fixture(t);
  assert.throws(()=>convertBlocklyProjectToCoder(source,path.join(source,'missing.ino')));
  const outside=path.join(path.dirname(source),'outside.ino'); fs.writeFileSync(outside,'');
  assert.throws(()=>convertBlocklyProjectToCoder(source,outside),/必须位于/);
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  manifest.dependencies.broken='file:.temp/missing'; write('package.json',JSON.stringify(manifest));
  assert.throws(()=>convertBlocklyProjectToCoder(source));
  assert.equal(fs.existsSync(`${source}_coder`),false);
});

test('relocates dependencies inside excluded caches and resolves external relative dependencies', t => {
  const {source,write}=fixture(t);
  write('.temp/local/package.json','{"name":"cached-local","version":"1.0.0"}');
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  manifest.dependencies.cached='file:.temp/local'; manifest.dependencies.external='file:../external';
  write('package.json',JSON.stringify(manifest));
  const target=convertBlocklyProjectToCoder(source);
  const result=JSON.parse(fs.readFileSync(path.join(target,'package.json'),'utf8'));
  assert.ok(fs.existsSync(path.join(target,result.dependencies.cached.slice(5),'package.json')));
  assert.equal(path.resolve(target,result.dependencies.external.slice(5)),path.resolve(source,'../external'));
});
