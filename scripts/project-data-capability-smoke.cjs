const assert = require('node:assert/strict');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

async function testAbsCapabilities(page, project) {
  await page.evaluate(() => {
    const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
    const prototype = window.Blockly.Workspace.prototype, original = prototype.newBlock;
    const guard = { original, originalMetadata: editor.getRuntimeBlockMetadataSnapshot, probes: 0, backgroundProbes: 0,
      stacks: [], editor, state: JSON.stringify(window.Blockly.serialization.workspaces.save(editor.workspace)) };
    window.absCapabilitySmoke = guard;
    editor.getRuntimeBlockMetadataSnapshot = function() { guard.probes++; throw new Error('ABS discovery must not call the legacy metadata probe'); };
    prototype.newBlock = function(...args) {
      const stack = new Error().stack || '';
      if (/describeCapabilities|describeAbsBlockCapability|getRuntimeBlockMetadataSnapshot|executeBlockMetadataSnapshot/.test(stack)) {
        guard.probes++; throw new Error('Capability discovery must not instantiate blocks');
      }
      guard.backgroundProbes++;
      if (guard.stacks.length < 3 && !guard.stacks.includes(stack)) guard.stacks.push(stack);
      return original.apply(this, args);
    };
  });
  try {
    const result = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'capabilities');
    const checked = await page.evaluate(() => {
      const guard = window.absCapabilitySmoke;
      return { probes: guard.probes, backgroundProbes: guard.backgroundProbes, backgroundStacks: guard.stacks,
        unchanged: guard.state === JSON.stringify(window.Blockly.serialization.workspaces.save(guard.editor.workspace)) };
    });
    assert.equal(checked.probes, 0); assert.equal(checked.unchanged, true);
    return { ...result, ...checked };
  } finally {
    await page.evaluate(() => {
      const guard = window.absCapabilitySmoke;
      window.Blockly.Workspace.prototype.newBlock = guard.original;
      guard.editor.getRuntimeBlockMetadataSnapshot = guard.originalMetadata;
      delete window.absCapabilitySmoke;
    });
  }
}
module.exports = { testAbsCapabilities };
