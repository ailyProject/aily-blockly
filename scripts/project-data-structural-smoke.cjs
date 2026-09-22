const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

async function testStructuralGeneration(page, source, parent) {
  const { project, initial } = await openBlankProject(page, source, parent, 'Structural Mutators');
  const agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'structural');
  const inspect = () => page.evaluate(async initial => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService, workspace = editor.workspace;
    // Reopening intentionally starts without a code cache. Use the same prepared queue as UI/build.
    const code = await editor.runWithPreparedProjectCode(prepared => prepared.code);
    for (const root of initial) {
      const block = workspace.getBlockById(root.id);
      if (!block || block.isDeletable() !== root.deletable) throw new Error('Protected root changed');
    }
    const conditional = workspace.getBlocksByType('controls_if', false)[0];
    const selection = workspace.getBlocksByType('controls_switch', false)[0];
    const join = workspace.getBlocksByType('text_join', false)[0];
    if (!conditional?.getInput('IF2') || !selection?.getInput('CASE2') || selection.getInput('DEFAULT') || !join?.getInput('ADD2')) throw new Error('Native dynamic inputs differ from prepared state');
    return { ids: workspace.getAllBlocks(false).map(block => block.id).sort(),
      state: JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)), code };
  }, initial);
  const before = await inspect();
  assert.match(before.code, /switch\s*\(/); assert.match(before.code, /delay\(7\)/); assert.match(before.code, /delay\(8\)/);
  const mirrors = ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Structural project reopen failed');
  }, project);
  await waitForBlankProject(page);
  const after = await inspect(); assert.deepEqual(after.ids, before.ids); assert.equal(after.state, before.state);
  assert.equal(after.code, before.code);
  for (const [i, file] of ['project.abi', 'project.abs', 'project.abs.map.json'].entries()) assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]);
  return { agent, project, blockCount: after.ids.length, protectedRoots: initial.length, reopened: true, code: after.code };
}
module.exports = { testStructuralGeneration };
