const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testSelectedAbsContext } = require('./project-data-context-smoke.cjs');

/** An actual installed board template, no variable models or user blocks pre-seeded. */
async function testVariableGeneration(page, source, parent = path.dirname(source)) {
  const { project, previousProject, initial } = await openBlankProject(page, source, parent, 'Blank Variables');
  const ready = () => waitForBlankProject(page);
  const agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'variables');
  const verify = (checkGeneratedCode = true) => page.evaluate(async ({ model, initial, checkGeneratedCode }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService, workspace = editor.workspace;
    if (workspace.getAllVariables().length !== 1 || workspace.getVariable('counter').getId() !== model.id) throw new Error('Variable identity lost');
    for (const root of initial) if (workspace.getBlockById(root.id)?.type !== root.type || workspace.getBlockById(root.id).isDeletable() !== root.deletable) throw new Error('Protected root changed');
    const refs = workspace.getAllBlocks(false).filter(block => block.type === 'variables_get' || block.type === 'variables_set');
    if (refs.length !== 3 || refs.some(block => block.getFieldValue('VAR') !== model.id)) throw new Error('Variable references did not bind the prepared model');
    const code = editor.getGeneratedCode();
    if (checkGeneratedCode && (!/int\s+counter\s*=\s*7\s*;/.test(code) || !/counter\s*=\s*9\s*;/.test(code)
      || !/counter\s*=\s*counter\s*;/.test(code) || !/delay\(1000\)/.test(code))) throw new Error('C++ declaration/use generation is incomplete: ' + code);
    const revision = await component._projectService.getAbiRevisionSnapshot();
    if (revision.changed || revision.memoryHash !== revision.diskHash) throw new Error('Saved model and workspace differ');
    return { state: JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)), revision, code };
  }, { model: agent.model, initial, checkGeneratedCode });
  const before = await verify();
  const selectedContext = await testSelectedAbsContext(page, project);
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'], mirrors = files.map(file => fs.readFileSync(path.join(project, file)));
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Variable project reopen failed');
  }, project);
  // A newly opened editor has no generated-code cache until generation is requested.
  // Code was checked after the real Agent save; reopen verifies persisted workspace/models, not cache readiness.
  await ready(); const reopened = await verify(false);
  assert.equal(reopened.state, before.state); assert.deepEqual(files.map(file => fs.readFileSync(path.join(project, file))), mirrors);
  await page.screenshot({ path: path.join(path.dirname(project), 'variable-generation-page.png'), fullPage: true });
  if (previousProject) await page.evaluate(async previousProject => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(previousProject)) throw new Error('Restoring previous test project failed');
  }, previousProject);
  if (previousProject) await ready();
  return { success: true, project, initial, agent, selectedContext, saved: before.revision, reopened: reopened.revision,
    code: before.code, codeCheckedAt: 'after-second-agent-edit-and-save' };
}

module.exports = { testVariableGeneration };
