// Environment control only: full readonly library in a separate real SVG page.
// This is not production ABS validation or permission to use the active workspace.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function main() {
  const [library, boardFile] = process.argv.slice(2);
  if (!library || !boardFile) throw Error('Pass readonly aily_iic directory and board.json');
  const boardConfig = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
  const definitions = JSON.parse(fs.readFileSync(path.join(library, 'block.json'), 'utf8'), (_key, value) => {
    const match = typeof value === 'string' && /^\$\{board\.([^}]+)\}$/.exec(value);
    return match ? boardConfig[match[1]] : value;
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort()); // No external library assets or services.
    await page.setContent('<div id="workspace" style="width:800px;height:600px"></div>');
    const root = path.dirname(require.resolve('blockly'));
    for (const name of ['blockly_compressed.js', 'blocks_compressed.js']) {
      await page.addScriptTag({ content: fs.readFileSync(path.join(root, name), 'utf8') });
    }
    await page.evaluate(boardConfig => { window.boardConfig = boardConfig; window.Arduino = { forBlock: {} }; }, boardConfig);
    await page.addScriptTag({ content: fs.readFileSync(path.join(library, 'generator.js'), 'utf8') });
    const result = await page.evaluate(definitions => {
      Blockly.defineBlocksWithJsonArray(definitions);
      const workspace = Blockly.inject(document.getElementById('workspace'), { sounds: false, trashcan: false, scrollbars: false });
      try {
        const owner = workspace.newBlock('wire_begin'); owner.initSvg(); owner.render();
        owner.setFieldValue('SLAVE', 'MODE');
        const child = owner.getInputTargetBlock('ADDRESS');
        return { workspace: workspace.constructor.name, rendered: workspace.rendered, synchronous: true,
          addressConnected: !!child, value: child?.getFieldValue('NUM'), shadow: child?.isShadow(),
          initSvg: typeof child?.initSvg, render: typeof child?.render,
          orphanBlocks: workspace.getAllBlocks(false).filter(block => block !== owner && !block.getParent()).length };
      } finally { workspace.dispose(); }
    }, definitions);
    assert.equal(result.rendered, true); assert.equal(result.addressConnected, true);
    assert.equal(result.value, 8); assert.equal(result.orphanBlocks, 0);
    console.log(JSON.stringify(result, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
