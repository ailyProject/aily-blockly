const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { selection, cases } = require('./abs-random-library-cases.cjs');
const { openBlankProject, waitForBlankProject } = require('./project-data-blank-project-smoke.cjs');
const { testAgentHostProjection } = require('../electron/test/project-agent-host-projection.cjs');

async function testRandomLibraries(page, source, root) {
  const libraryRoot = process.env.AILY_ABS_LIBRARY_ROOT; assert.ok(path.isAbsolute(libraryRoot));
  const results = [];
  const only = process.env.AILY_ABS_RANDOM_LIBRARY?.split(',');
  if (only) only.forEach(name => assert.ok(cases.some(item => item.library === name), 'Rerun only a selected library'));
  const report = { selection, ...(only ? { rerun: only } : {}), results };
  const record = () => fs.writeFileSync(path.join(root, 'random-library-audit.json'), JSON.stringify(report, null, 2));
  for (const fixture of cases.filter(item => !only || only.includes(item.library))) {
    console.log('RANDOM_LIBRARY=' + fixture.library);
    const result = { library: fixture.library }; results.push(result); record();
    try {
      const library = path.join(libraryRoot, fixture.library);
      const files = ['block.json', 'generator.js', 'readme_ai.md', 'package.json'];
      const hashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(library, file))).digest('hex')]));
      result.sourceHashes = hashes();
      const { project, initial } = await openBlankProject(page, source, root, fixture.library, [library]); result.project = project;
      result.agent = await testAgentHostProjection(project, process.env.AILY_AGENT_ROOT, 'random-library');
      const inspect = () => page.evaluate(async initial => {
        const editor = window.ng.getComponent(document.querySelector('app-blockly-editor')).blocklyService;
        const workspace = editor.workspace;
        for (const entry of initial) if (workspace.getBlockById(entry.id)?.isDeletable() !== entry.deletable) throw new Error('Protected root changed');
        const code = await editor.runWithPreparedProjectCode(prepared => prepared.code);
        return { state: editor.getWorkspaceJson(), code, blocks: workspace.getAllBlocks(false).map(block => ({
          id: block.id, type: block.type,
          fields: Object.fromEntries(block.inputList.flatMap(input => input.fieldRow.filter(field => field.name).map(field => [field.name, field.getValue()]))),
          inputs: block.inputList.map(input => input.name),
        })) };
      }, initial);
      result.beforeReopen = await inspect();
      const mirrors = ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
      await page.evaluate(async project => {
        const service = window.projectDataSmokeService;
        if (!await service.close() || !await service.projectOpen(project)) throw new Error('Random project reopen failed');
      }, project);
      await waitForBlankProject(page);
      result.afterReopen = await inspect();
      // getAllBlocks(false) is an unordered diagnostic enumeration, not ABI root
      // or connection order. Compare it by identity; keep state/code exact.
      const comparable = value => ({ ...value, blocks: [...value.blocks].sort((a, b) => a.id.localeCompare(b.id)) });
      assert.deepEqual(comparable(result.afterReopen), comparable(result.beforeReopen), 'Workspace/code changed on reopen');
      ['project.abi', 'project.abs', 'project.abs.map.json'].forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(project, file)), mirrors[i]));
      result.reopened = true;
      const accepted = result.agent.rounds.filter(round => round.applied?.ok);
      const last = accepted.at(-1);
      if (last) {
        const expected = fixture.rounds[last.index], blocks = result.afterReopen.blocks.filter(block => fixture.types.includes(block.type));
        assert.equal(blocks.length, expected.calls.length);
        for (const [index, value] of (expected.instances || [expected]).entries()) {
          for (const [field, target] of Object.entries(value.fields || {})) assert.equal(blocks[index].fields[field], target, field);
          for (const field of value.absentFields || []) assert.equal(Object.hasOwn(blocks[index].fields, field), false, field);
          for (const input of value.inputs || []) assert.ok(blocks[index].inputs.includes(input), input);
          for (const input of value.absentInputs || []) assert.equal(blocks[index].inputs.includes(input), false, input);
        }
        assert.ok(result.afterReopen.code.includes(expected.code), expected.code);
      } else assert.equal(result.afterReopen.blocks.length, 3, 'Refusals must retain the blank board');
      result.allRoundsAccepted = accepted.length === fixture.rounds.length && accepted.every(round => round.semanticFieldsVerified);
      assert.deepEqual(hashes(), result.sourceHashes, 'Readonly library changed');
      result.libraryUnchanged = true;
      await page.screenshot({ path: path.join(root, fixture.library + '.png'), fullPage: true });
    } catch (error) { result.error = error.stack; console.error('RANDOM_LIBRARY_FAILURE=' + fixture.library + ': ' + error.message); }
    record();
  }
  report.passed = results.filter(result => result.allRoundsAccepted && result.reopened && !result.error).length;
  record(); return report;
}
module.exports = { testRandomLibraries };
