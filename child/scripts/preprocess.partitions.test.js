const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {copyCustomPartitionFile} = require('./preprocess');

for (const isAilyCode of [false, true]) {
  test(`${isAilyCode ? 'Coder' : 'Blockly'} custom partitions prefer user sources and recover missing files from the selected board`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-partition-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const source = path.join(root, isAilyCode ? 'sketch/src' : 'src', 'partitions.csv');
    const sketchPath = path.join(root, isAilyCode ? 'sketch' : '.temp/sketch');
    const destination = isAilyCode ? source : path.join(sketchPath, 'partitions.csv');
    const boardModulePath = path.join(root, 'node_modules/@aily-project/board-ai-vox');
    const write = (file, content) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,content); };
    fs.mkdirSync(path.dirname(source), {recursive:true}); fs.mkdirSync(sketchPath, {recursive:true});
    const copy = () => copyCustomPartitionFile({currentProjectPath:root, sketchPath,
      boardModulePath, compileSourcePath:path.join(path.dirname(source),'main.cpp'), isAilyCode});
    assert.throws(copy,/未找到 partitions.csv/);
    write(path.join(boardModulePath,'partitions.csv'),'board'); copy();
    assert.equal(fs.readFileSync(destination,'utf8'),'board');
    fs.rmSync(destination); write(path.join(root,'partitions.csv'),'legacy'); copy();
    assert.equal(fs.readFileSync(destination,'utf8'),'legacy');
    write(source,'user'); copy();
    assert.equal(fs.readFileSync(destination,'utf8'),'user');
    assert.equal(fs.readFileSync(path.join(boardModulePath,'partitions.csv'),'utf8'),'board');
  });
}
