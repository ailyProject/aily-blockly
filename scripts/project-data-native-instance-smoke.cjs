const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

async function testNativeInstances(page, source, parent) {
  const libraries = [process.env.AILY_ABS_DHT_LIBRARY, process.env.AILY_ABS_MAX31865_LIBRARY];
  for (const library of libraries) assert.ok(library && path.isAbsolute(library), 'Supply readonly library sources');
  const { project, initial } = await openBlankProject(page, source, parent, 'Native Instances', libraries);
  // This phase tests existing-instance export/edit, not Agent creation. Initialize
  // through actual native constructors and the normal code/save pipeline once.
  const edits = await page.evaluate(async project => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService, workspace = editor.workspace;
    const dht = workspace.newBlock('dht_init'), rtd = workspace.newBlock('max31865_init');
    dht.setFieldValue('native_dht', 'VAR'); dht.setFieldValue('DHT22', 'TYPE');
    rtd.setFieldValue('native_rtd', 'VAR'); rtd.setFieldValue('SW', 'SPI_MODE');
    const result = [[dht, 'PIN'], [rtd, 'SW_MISO_PIN']].map(([block, field]) => {
      const values = [...new Set(block.getField(field).getOptions(false).map(option => option[1]))];
      if (values.length < 2 || !values.slice(0, 2).every(value => typeof value === 'string')) throw new Error('Expected two distinct native pin options');
      block.setFieldValue(values[0], field);
      return { type: block.type, id: block.id, field, from: values[0], to: values[1] };
    });
    workspace.getBlocksByType('arduino_setup', false)[0].getInput('ARDUINO_SETUP').connection.connect(dht.previousConnection);
    dht.nextConnection.connect(rtd.previousConnection);
    for (const block of [dht, rtd]) { block.initSvg(); block.render(); }
    await editor.runWithPreparedProjectCode(prepared => prepared.code);
    const saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw new Error(saved.error);
    return result;
  }, project);
  const previous = process.env.AILY_ABS_NATIVE_EDITS;
  process.env.AILY_ABS_NATIVE_EDITS = JSON.stringify(edits);
  let agent;
  try { agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'native-instances'); }
  finally { if (previous === undefined) delete process.env.AILY_ABS_NATIVE_EDITS; else process.env.AILY_ABS_NATIVE_EDITS = previous; }
  const inspect = () => page.evaluate(async ({ edits, initial }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService, workspace = editor.workspace;
    const code = await editor.runWithPreparedProjectCode(prepared => prepared.code);
    for (const edit of edits) if (workspace.getBlockById(edit.id)?.getFieldValue(edit.field) !== edit.to) throw new Error('Native field not retained');
    for (const root of initial) if (workspace.getBlockById(root.id)?.isDeletable() !== root.deletable) throw new Error('Protected root changed');
    return { ids: workspace.getAllBlocks(false).map(block => block.id).sort(), state: JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)), code };
  }, { edits, initial });
  const before = await inspect(); assert.match(before.code, /DHT native_dht\(/); assert.match(before.code, /Adafruit_MAX31865 native_rtd\(/);
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'], mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  await page.evaluate(async project => {
    if (!await window.projectDataSmokeService.close() || !await window.projectDataSmokeService.projectOpen(project)) throw new Error('Native project reopen failed');
  }, project);
  await waitForBlankProject(page); const after = await inspect(); assert.deepEqual(after, before);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]));
  return { agent, project, edits, blockCount: after.ids.length, protectedRoots: initial.length, reopened: true, code: after.code };
}
module.exports = { testNativeInstances };
