const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

test('creates the exact project directory with spaces, quotes and literal shell characters', {skip: process.platform === 'win32'}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-mkdir-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const filename = path.join(__dirname, '../../src/app/services/core/platform/cross-platform-cmd.service.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true},
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, {exports, require: name => {
    if (name === '@angular/core') return {Injectable: () => value => value};
    throw new Error(`Unexpected runtime import: ${name}`);
  }});
  const service = new exports.CrossPlatformCmdService({
    runAsync: async command => execFileSync('/bin/sh', ['-c', command], {cwd: root}),
  }, {isWindows: () => false});
  const directory = path.join(root, 'Blockly 示例\'s "copy" $(touch unexpected) `touch unexpected2`', '.temp');
  await service.createDirectory(directory);
  assert.ok(fs.statSync(directory).isDirectory());
  assert.equal(fs.existsSync(path.join(root, 'unexpected')), false);
  assert.equal(fs.existsSync(path.join(root, 'unexpected2')), false);
  await service.createDirectory(directory);
});
