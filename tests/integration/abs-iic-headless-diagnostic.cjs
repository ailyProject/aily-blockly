// Run the complete readonly library without ABS. Do not stub initSvg/render or
// discard its orphan: the report must expose the headless/native UI mismatch.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Blockly = require('blockly');
require('blockly/blocks');
const { DOMParser, XMLSerializer, DOMImplementation } = require('@xmldom/xmldom');
Blockly.utils.xml.injectDependencies({ document: new DOMImplementation().createDocument(null, 'xml', null), DOMParser, XMLSerializer });
async function main() {
  const [library, boardFile] = process.argv.slice(2);
  if (!library || !boardFile) throw Error('Pass readonly aily_iic directory and board.json');
  const boardConfig = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const workspace = new Blockly.Workspace(), pending = new Set();
  const oldMain = Blockly.getMainWorkspace; Blockly.getMainWorkspace = () => workspace;
  const context = vm.createContext({ Blockly, Arduino: { forBlock: {} }, window: { boardConfig }, console,
    setTimeout(callback, delay, ...args) { const id = setTimeout(() => { pending.delete(id); callback(...args); }, delay); pending.add(id); return id; },
    clearTimeout(id) { pending.delete(id); clearTimeout(id); },
  });
  try {
    vm.runInContext(fs.readFileSync(path.join(library, 'generator.js'), 'utf8'), context);
    Blockly.common.defineBlocksWithJsonArray(JSON.parse(fs.readFileSync(path.join(library, 'block.json'), 'utf8'), (_key, value) => {
      const match = typeof value === 'string' && /^\$\{board\.([^}]+)\}$/.exec(value);
      return match ? boardConfig[match[1]] : value;
    }));
    const owner = workspace.newBlock('wire_begin'); owner.setFieldValue('SLAVE', 'MODE');
    const inspect = () => ({ mode: owner.getFieldValue('MODE'), addressExists: !!owner.getInput('ADDRESS'),
      addressConnected: !!owner.getInputTargetBlock('ADDRESS'), blocks: workspace.getAllBlocks(false).map(block => ({
        type: block.type, shadow: block.isShadow(), parent: block.getParent()?.type ?? null,
        initSvg: typeof block.initSvg, render: typeof block.render,
      })) });
    const synchronous = inspect();
    await new Promise(resolve => setTimeout(resolve, 350));
    console.log(JSON.stringify({ synchronous, afterTimers: inspect() }, null, 2));
  } finally {
    for (const id of pending) clearTimeout(id);
    workspace.dispose(); Blockly.getMainWorkspace = oldMain;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
