#!/usr/bin/env node
// Compare the unchanged Aily generators against old and upgraded core packages.
// This is headless contract coverage, not a rendered-workspace performance test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.argv[2];
if (!baseline) throw new Error('Usage: node scripts/verify-blockly-generator-parity.mjs /absolute/path/to/old/node_modules/blockly');

function probe(packagePath) {
  const requireCore = createRequire(path.join(packagePath, 'package.json'));
  const B = requireCore(packagePath);
  const cache = new Map();
  function loadTs(file) {
    if (cache.has(file)) return cache.get(file);
    const module = {exports: {}};
    cache.set(file, module.exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    }).outputText;
    const localRequire = id => id === 'blockly' ? B : id === 'blockly/python'
      ? requireCore(path.join(packagePath, 'python'))
      : id.startsWith('.') ? loadTs(path.resolve(path.dirname(file), `${id}.ts`)) : requireCore(id);
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, {filename: file})(localRequire, module, module.exports);
    return module.exports;
  }
  if (B.VERSION.startsWith('13.')) loadTs(path.join(root, 'src/app/editors/blockly-editor/utils/blockly-legacy-library-compat.ts'));
  B.Blocks.parity_statement = {init() {
    this.appendDummyInput().appendField(new B.FieldTextInput('中文'), 'TEXT');
    this.appendValueInput('VALUE'); this.appendStatementInput('BODY');
    this.setPreviousStatement(true); this.setNextStatement(true);
  }};
  B.Blocks.parity_value = {init() {
    this.appendDummyInput().appendField(new B.FieldNumber(7), 'NUM'); this.setOutput(true);
  }};
  const result = {};
  B.Events.disable();
  try {
    for (const [mode, name] of [['arduino', 'ArduinoGenerator'], ['micropython', 'MicroPythonGenerator'], ['python', 'PythonGenerator']]) {
      const Constructor = loadTs(path.join(root, `src/app/editors/blockly-editor/components/blockly/generators/${mode}/${mode}.ts`))[name];
      const gen = new Constructor();
      gen.forBlock.parity_statement = (block, g) => `${block.getFieldValue('TEXT')}(${g.valueToCode(block, 'VALUE', 99)});\n${g.statementToCode(block, 'BODY')}`;
      gen.forBlock.parity_value = block => [String(block.getFieldValue('NUM')), 0];
      const ws = new B.Workspace();
      const first = ws.newBlock('parity_statement', 'outer');
      const inner = ws.newBlock('parity_statement', 'nested');
      const last = ws.newBlock('parity_statement', 'tail');
      const value = ws.newBlock('parity_value', 'value');
      first.getInput('VALUE').connection.connect(value.outputConnection);
      first.getInput('BODY').connection.connect(inner.previousConnection);
      first.nextConnection.connect(last.previousConnection);
      inner.setCommentText('中文 comment');
      last.setFieldValue('tail', 'TEXT');
      gen.init(ws);
      const fragment = gen.blockToCode(first);
      assert.match(fragment, /7/);
      assert.match(fragment, /tail/);
      const normal = gen.workspaceToCode(ws);
      const saved = B.serialization.workspaces.save(ws);
      B.serialization.workspaces.load(saved, ws);
      assert.equal(gen.workspaceToCode(ws), normal, `${mode} JSON roundtrip`);
      ws.getBlockById('nested').setDisabledReason(true, 'parity');
      gen.init(ws);
      const disabledFragment = gen.blockToCode(ws.getBlockById('outer'));
      assert.notEqual(disabledFragment, fragment);
      result[mode] = {fragment, disabledFragment, normal, disabled: gen.workspaceToCode(ws)};
      ws.dispose();
    }
  } finally { B.Events.enable(); }
  return {version: B.VERSION, result};
}
const old = probe(path.resolve(baseline));
const upgraded = probe(path.join(root, 'node_modules/blockly'));
assert.deepEqual(upgraded.result, old.result);
console.log(JSON.stringify({baseline: old.version, upgraded: upgraded.version, status: 'passed', modes: Object.keys(upgraded.result), results: upgraded.result}, null, 2));
