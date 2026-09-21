const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** Extends the existing real-page runner; no extra renderer/runtime or substitute editor services. */
async function testWorkspaceGeneration(page, destination) {
  const previous = await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return JSON.stringify(window.Blockly.serialization.workspaces.save(component.blocklyService.workspace));
  });
  const { testAgentHostCandidate } = require('../electron/test/project-agent-host-projection.cjs');
  const agent = await testAgentHostCandidate(destination, process.env.AILY_AGENT_ROOT);
  const prepared = await page.evaluate(async ({ before }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    const editor = component.blocklyService;
    const targetId = 'project_data_smoke_text';
    const value = editor.workspace.getBlockById(targetId).getFieldValue('TEXT');
    const after = window.Blockly.serialization.workspaces.save(editor.workspace);
    const index = state => {
      const result = {};
      const visit = block => {
        const { fields, inputs, next, ...attributes } = block;
        result[block.id] = attributes;
        for (const input of Object.values(inputs ?? {})) { if (input.block) visit(input.block); if (input.shadow) visit(input.shadow); }
        if (next?.block) visit(next.block);
      };
      for (const block of state.blocks?.blocks ?? []) visit(block);
      return result;
    };
    const previousState = JSON.parse(before);
    const previous = index(previousState), current = index(after);
    for (const [id, attributes] of Object.entries(previous)) {
      if (JSON.stringify(attributes) !== JSON.stringify(current[id])) throw new Error('v2 changed original IDs/protection/opaque block attributes');
    }
    const addedIds = Object.keys(current).filter(id => !Object.hasOwn(previous, id));
    if (addedIds.length !== 1 || current[addedIds[0]].type !== 'string_add_string') throw new Error('Declared new block was not applied exactly once');
    const addedBounds = editor.workspace.getBlockById(addedIds[0]).getBoundingRectangle();
    for (const block of editor.workspace.getTopBlocks(false).filter(block => !addedIds.includes(block.id))) {
      if (addedBounds.intersects(block.getBoundingRectangle())) throw new Error('New root overlaps an existing stack');
    }
    if (JSON.stringify(previousState.variables ?? []) !== JSON.stringify(after.variables ?? [])) throw new Error('v2 changed variable model identities');
    const saved = await component._projectService.getAbiRevisionSnapshot();
    if (saved.changed || saved.memoryHash !== saved.diskHash) throw new Error('v2 memory differs from saved ABI');
    return { value, saved, targetId, addedIds, blockAttributes: current, variables: after.variables ?? [], code: editor.getGeneratedCode() };
  }, { before: previous });
  const hash = text => createHash('sha256').update(text).digest('hex');
  const abi = fs.readFileSync(path.join(destination, 'project.abi'), 'utf8');
  const abs = fs.readFileSync(path.join(destination, 'project.abs'), 'utf8');
  const map = JSON.parse(fs.readFileSync(path.join(destination, 'project.abs.map.json'), 'utf8'));
  prepared.generation = map.generation;
  assert.equal(hash(prepared.value), agent.valueHash); assert.equal(prepared.value.length, agent.valueLength);
  assert.ok(abs.includes('$ailyProjectDataValue')); assert.ok(!abs.includes(prepared.value));
  const headers = [...prepared.code.matchAll(/#include\s+"((?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h)"/g)].map(match => match[1]);
  prepared.headers = headers.map(fileName => {
    const bytes = fs.readFileSync(path.join(destination, 'src', fileName)); assert.ok(bytes.length > 0);
    return { fileName, bytes: bytes.length, hash: hash(bytes) };
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'package.json'), 'utf8')).codeHash, hash(prepared.code));
  await page.evaluate(async destination => {
    const service = window.projectDataSmokeService;
    if (!await service.close() || !await service.projectOpen(destination)) throw new Error('v2 project reopen failed');
  }, destination);
  await page.waitForFunction(({ targetId, value, addedIds }) => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return component?.projectService.getBlocklyProjectLoadStatus(component.projectService.currentProjectPath)?.ready
      && component.blocklyService.workspace?.getBlockById(targetId)?.getFieldValue('TEXT') === value
      && addedIds.every(id => component.blocklyService.workspace.getBlockById(id)?.type === 'string_add_string');
  }, { targetId: prepared.targetId, value: prepared.value, addedIds: prepared.addedIds }, { timeout: 90000 });
  assert.equal(fs.readFileSync(path.join(destination, 'project.abi'), 'utf8'), abi, 'Reopening v2 must not re-save ABI');
  assert.equal(fs.readFileSync(path.join(destination, 'project.abs'), 'utf8'), abs, 'Reopening must not regenerate a legacy ABS mirror');
  const reopened = await page.evaluate(() => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'));
    return component._projectService.getAbiRevisionSnapshot();
  });
  assert.equal(reopened.changed, false); assert.equal(reopened.memoryHash, reopened.diskHash);
  delete prepared.code; delete prepared.value;
  return { ...prepared, agent, reopened, success: true };
}

module.exports = { testWorkspaceGeneration };
