const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

async function testFieldShapeGeneration(page, source, parent, mode = 'field-shape') {
  const libraries = mode === 'conditional' ? [process.env.AILY_ABS_CONDITIONAL_LIBRARY] : [];
  for (const library of libraries) assert.ok(library && path.isAbsolute(library), 'Supply readonly absolute library sources');
  const { project, initial } = await openBlankProject(page, source, parent, 'Field Shapes', libraries);
  const agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, mode);
  const inspect = () => page.evaluate(async ({ initial, mode }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const workspace = editor.workspace, code = await editor.runWithPreparedProjectCode(prepared => prepared.code);
    for (const root of initial) {
      const block = workspace.getBlockById(root.id);
      if (!block || block.isDeletable() !== root.deletable) throw new Error('Protected root changed');
    }
    if (mode === 'conditional') {
      const ranges = workspace.getBlocksByType('tt_getSubstring', false);
      if (ranges.length !== 2 || !ranges.some(block => block.getFieldValue('WHERE1') === 'FROM_END' && block.getFieldValue('WHERE2') === 'FROM_START'
        && block.getInputTargetBlock('AT1_VALUE')?.getFieldValue('NUM') === 2 && block.getInputTargetBlock('AT2_VALUE')?.getFieldValue('NUM') === 4)
        || !ranges.some(block => block.getFieldValue('WHERE1') === 'FIRST' && !block.getInput('AT1_VALUE') && !block.getInput('AT2_VALUE'))) throw new Error('Conditional ranges differ from native state');
      const write = workspace.getBlocksByType('esp32_i2c_write_to_device', false)[0];
      if (write?.getFieldValue('ADDRESS') !== 'CUSTOM' || write.getInputTargetBlock('CUSTOM_ADDRESS')?.getFieldValue('NUM') !== 32) throw new Error('Custom I2C address not restored');
    } else {
      const property = workspace.getBlocksByType('math_number_property', false)[0];
      const chars = workspace.getBlocksByType('text_charAt', false);
      if (property?.getFieldValue('PROPERTY') !== 'DIVISIBLE_BY' || !property.getInputTargetBlock('DIVISOR')) throw new Error('Divisor not restored');
      if (chars.length !== 2 || !chars.some(block => block.getFieldValue('WHERE') === 'FROM_END' && block.getInputTargetBlock('AT'))
        || !chars.some(block => block.getFieldValue('WHERE') === 'LAST' && !block.getInput('AT'))) throw new Error('Same-type field variants were mixed');
    }
    return { ids: workspace.getAllBlocks(false).map(block => block.id).sort(), state: JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)), code };
  }, { initial, mode });
  const before = await inspect();
  if (mode === 'conditional') { assert.match(before.code, /Wire\.beginTransmission\(32\)/); assert.match(before.code, /substring\(/); }
  else { assert.match(before.code, /fmod\(\(8 \+ 0\), 4\) == 0/); assert.match(before.code, /charAt\(/); }
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Field shape project reopen failed');
  }, project);
  await waitForBlankProject(page);
  const after = await inspect();
  assert.deepEqual(after.ids, before.ids); assert.equal(after.state, before.state); assert.equal(after.code, before.code);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]));
  return { agent, project, blockCount: after.ids.length, protectedRoots: initial.length, reopened: true, code: after.code };
}
module.exports = { testFieldShapeGeneration };
