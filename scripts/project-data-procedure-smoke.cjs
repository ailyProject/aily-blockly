const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAbsCapabilities } = require('./project-data-capability-smoke.cjs');

async function testProcedureGeneration(page, source, parent) {
  const custom = process.env.AILY_ABS_CUSTOM_FUNCTIONS === '1';
  const library = process.env.AILY_ABS_PROCEDURE_LIBRARY;
  assert.ok(library && path.isAbsolute(library), 'Pass a read-only core-functions library fixture');
  const { project, initial } = await openBlankProject(page, source, parent, 'Blank Procedures', [library]);
  // Optional read-only saved ABI fixture isolates recovery/page/reopen regressions
  // from creation. Full acceptance leaves this unset and executes all three edits.
  const fixture = custom && process.env.AILY_ABS_CUSTOM_FIXTURE;
  if (fixture) assert.ok(path.isAbsolute(fixture));
  const capabilities = fixture ? undefined : await testAbsCapabilities(page, project);
  const agent = fixture ? await page.evaluate(async ({ snapshot, project }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    editor.loadProjectDocument(snapshot);
    const saved = await window.projectDataSmokeService.save(project); if (!saved.success) throw new Error(saved.error);
    return { definitionId: snapshot.sharedModel.procedureBlocks[0].id, savedFixture: true };
  }, { snapshot: JSON.parse(fs.readFileSync(fixture, 'utf8')), project })
    : await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, custom ? 'custom-functions' : 'procedures');
  const verify = checkCode => page.evaluate(async ({ initial, id, checkCode, custom }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService, workspace = editor.workspace;
    for (const root of initial) if (workspace.getBlockById(root.id)?.isDeletable() !== root.deletable) throw new Error('Protected root changed');
    const definition = workspace.getBlockById(id);
    const state = definition.saveExtraState(), params = state.params;
    const model = workspace.getVariable('amount');
    if (params.length !== 1 || (custom ? state.paramVarIds[0] : params[0].id) !== model.getId()
      || definition.getFieldValue(custom ? 'PARAM_NAME0' : params[0].argId) !== 'amount') throw new Error('Parameter identity lost');
    const caller = workspace.getAllBlocks(false).find(block => block.type === (custom ? 'custom_function_call_advance' : 'procedures_callnoreturn'));
    if ((custom ? caller.getField('FUNC_NAME').getVariable().name !== 'abs_custom' : caller.getProcedureCall() !== 'abs_work')
      || caller.getInputTargetBlock(custom ? 'INPUT0' : 'ARG0').getFieldValue('NUM') !== 9) throw new Error('Call argument lost');
    const code = editor.getGeneratedCode();
    if (checkCode && !(custom ? /int\s+abs_custom\s*\(\s*float\s+amount\s*\)/.test(code) && /abs_custom\(9\)/.test(code) && /return amount;/.test(code)
      : /void\s+abs_work\s*\(\s*int\s+amount\s*\)/.test(code) && /abs_work\(9\)/.test(code))) throw new Error('C++ procedure signature/call incorrect: ' + code);
    const revision = await component._projectService.getAbiRevisionSnapshot();
    if (revision.changed) {
      const memory = editor.normalizeProjectAbi(editor.getProjectAbiForSave());
      const disk = editor.normalizeProjectAbi(JSON.parse(window.fs.readFileSync(component.projectService.currentProjectPath + '/project.abi', 'utf8')));
      const differences = [];
      const compare = (a, b, path = '') => {
        if (JSON.stringify(a) === JSON.stringify(b) || differences.length >= 12) return;
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) compare(a[key], b[key], path + '/' + key);
        } else differences.push({ path, memory: a, disk: b });
      };
      compare(memory, disk); throw new Error('Saved procedure state differs: ' + JSON.stringify({ revision, differences }));
    }
    return { state: JSON.stringify(window.Blockly.serialization.workspaces.save(workspace)), revision, code, parameter: custom ? { ...params[0], id: state.paramVarIds[0], funcVarId: state.funcVarId } : params[0], callerId: caller.id };
  }, { initial, id: agent.definitionId, checkCode, custom });
  const saved = await verify(true);
  let rollback;
  if (custom) {
    await page.evaluate(() => {
      const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
      const guard = { editor, original: editor.prepareProjectCode, hits: 0 };
      window.customRollbackGuard = guard;
      editor.prepareProjectCode = async function(...args) {
        const result = await guard.original.apply(this, args);
        // Background generation before abs_export must not pollute its baseline.
        // Arm only for the changed candidate, never the saved float signature.
        if (this.workspace.getBlocksByType('custom_function_def', false).some(block => block.saveExtraState().params[0]?.type === 'int')) {
          guard.hits++; this.workspace.createVariable('unexpected_custom_model');
        }
        return result;
      };
    });
    let injection;
    try { rollback = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'custom-rollback'); }
    finally { injection = await page.evaluate(() => {
      const guard = window.customRollbackGuard; guard.editor.prepareProjectCode = guard.original;
      delete window.customRollbackGuard; return { hits: guard.hits };
    }); }
    assert.equal(injection.hits, 1); rollback.injection = injection;
    assert.equal((await verify(false)).state, saved.state);
  }
  const pageIds = await page.evaluate(async project => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const original = editor.getActivePageId(), other = editor.createPage('Shared procedure check');
    const result = await window.projectDataSmokeService.save(project); if (!result.success) throw new Error(result.error);
    return { original, other: other.id };
  }, project);
  const call = mode => testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, mode);
  const pageOut = await call('rebind');
  const crossPage = await call(custom ? 'custom-cross-page' : 'procedure-cross-page');
  await page.evaluate(async ({ project, pageIds }) => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    if (!editor.switchPage(pageIds.original)) throw new Error('Switching back failed');
    const result = await window.projectDataSmokeService.save(project); if (!result.success) throw new Error(result.error);
  }, { project, pageIds });
  const pageBack = await call('rebind');
  const afterPages = await verify(false); assert.equal(afterPages.state, saved.state);
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
  const before = mirrors();
  await page.evaluate(async project => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(project)) throw new Error('Procedure reopen failed');
  }, project);
  await waitForBlankProject(page); const reopened = await verify(false);
  assert.equal(reopened.state, saved.state); assert.deepEqual(mirrors(), before);
  await page.screenshot({ path: path.join(parent, 'procedure-generation-page.png'), fullPage: true });
  return { success: true, project, custom, fixture: fixture || undefined, capabilities, agent, rollback, crossPage: { ...crossPage, pageIds, pageOut, pageBack }, saved: afterPages.revision, reopened: reopened.revision, parameter: saved.parameter,
    callerId: saved.callerId, code: saved.code };
}
module.exports = { testProcedureGeneration };
