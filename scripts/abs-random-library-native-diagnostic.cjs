// Root-cause control: run unmodified registrations with the real Blockly library,
// without ABS, candidate-policy, mock fields, or per-library shape emulation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Blockly = require('blockly');
const { DOMParser, XMLSerializer, DOMImplementation } = require('@xmldom/xmldom');
Blockly.utils.xml.injectDependencies({ document: new DOMImplementation().createDocument(null, 'xml', null), DOMParser, XMLSerializer });
const libraryRoot = process.argv[2], boardFile = process.argv[3];
if (!libraryRoot || !boardFile) throw new Error('Pass readonly library root and board.json');
const boardConfig = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
const report = [];
for (const [library, type, change] of [
  ['simple-keypad', 'simple_keypad_init', { field: 'LAYOUT', value: '3x1' }],
  ['unihiker_k10_speech', 'k10_asr_speak', null],
]) {
  const root = path.join(libraryRoot, library);
  const context = vm.createContext({ Blockly, Arduino: { forBlock: {} }, window: { boardConfig }, console });
  vm.runInContext(fs.readFileSync(path.join(root, 'generator.js'), 'utf8'), context, { filename: path.join(root, 'generator.js') });
  Blockly.common.defineBlocksWithJsonArray(JSON.parse(fs.readFileSync(path.join(root, 'block.json'), 'utf8')));
  const workspace = new Blockly.Workspace();
  try {
    const block = workspace.newBlock(type);
    const inspect = () => ({ fields: Object.fromEntries(block.inputList.flatMap(input => input.fieldRow.filter(field => field.name).map(field => [field.name, field.getValue()]))),
      inputs: block.inputList.map(input => ({ name: input.name, connection: !!input.connection })) });
    const before = inspect();
    if (change) block.setFieldValue(change.value, change.field);
    report.push({ library, before, change, after: inspect() });
  } finally { workspace.dispose(); }
}
console.log(JSON.stringify(report, null, 2));
