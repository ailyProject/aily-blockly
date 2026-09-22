const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

/** Real copy/page UI services; every ABS repair/application uses the registered Agent tools. */
async function testGenerationRebinding(page, source) {
  const copy = path.join(path.dirname(source), 'Generation Copy');
  const files = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const original = files.map(file => fs.readFileSync(path.join(source, file)));
  const originalMap = JSON.parse(original[2]);
  const native = () => page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    return JSON.stringify(window.Blockly.serialization.workspaces.save(editor.workspace));
  });
  const initial = await native();
  await page.evaluate(async ({ source, copy }) => {
    const service = window.projectDataSmokeService;
    if (!await service.close()) throw new Error('Close before copying failed');
    service.importProjectDirectory(source, copy, false);
    if (!await service.projectOpen(copy)) throw new Error('Copied project failed to open');
  }, { source, copy });
  const ready = () => page.waitForFunction(() => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready;
  }, undefined, { timeout: 90000 });
  await ready(); assert.equal(await native(), initial, 'Copy load preserves complete workspace');
  const call = mode => testAgentHostProjection(copy, process.env.AILY_AGENT_ROOT, mode);
  const copied = await call('rebind');
  assert.equal(copied.diagnostics.baselineScope.projectKey, source);
  assert.equal(copied.rebound.base.scope.projectKey, copy);
  assert.equal(await native(), initial, 'Scope repair does not reload/change blocks');

  // Fault injection is limited to this disposable copy; the original map is in an immutable baseline.
  const damagedMap = '{ damaged map 中文😀';
  fs.writeFileSync(path.join(copy, 'project.abs.map.json'), damagedMap);
  const repaired = await call('rebind'); assert.deepEqual(repaired.diagnostics.issues, ['ABS_MAP_INVALID']);
  assert.equal(await native(), initial);

  const otherId = await page.evaluate(async copy => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const other = component.blocklyService.createPage('Rebind test page');
    const saved = await window.projectDataSmokeService.save(copy);
    if (!saved.success) throw new Error(saved.error || 'Saving new page failed');
    return other.id;
  }, copy);
  const other = await native(), pageOut = await call('rebind');
  assert.equal(pageOut.rebound.base.scope.pageId, otherId); assert.equal(await native(), other);
  await page.evaluate(pageId => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    if (!editor.switchPage(pageId)) throw new Error('Switching back failed');
  }, originalMap.scope.pageId);
  assert.equal(await native(), initial);
  const pageBack = await call('rebind'); assert.equal(pageBack.rebound.base.scope.pageId, originalMap.scope.pageId);
  const applied = await call('verify-rebound'); assert.equal(await native(), initial);
  const finalMirrors = files.map(file => fs.readFileSync(path.join(copy, file)));
  await page.evaluate(async copy => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(copy)) throw new Error('Rebound project reopen failed');
  }, copy);
  await ready(); assert.equal(await native(), initial);
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(copy, file))), finalMirrors, 'Reopen does not save/rewrite mirrors');
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(source, file))), original, 'Source project remains unchanged');
  const state = JSON.parse(fs.readFileSync(path.join(copy, 'project.abi'), 'utf8'));
  assert.ok(state.pages.some(item => item.id === otherId)); assert.equal(state.activePageId, originalMap.scope.pageId);
  return { success: true, copy, copied, repaired, pageOut, pageBack, applied, otherPageId: otherId,
    workspaceHash: createHash('sha256').update(initial).digest('hex'), finalGeneration: applied.applied.output.binding.generation };
}

module.exports = { testGenerationRebinding };
