const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('../../scripts/abs-random-library-cases.cjs');

/** Collect real model-facing content as well as structured receipts; no mocked catalog. */
async function runRandomLibrary(project, load, call, history, catalog) {
  const fixture = cases.find(item => path.basename(project) === item.library); assert.ok(fixture);
  const evidence = { library: fixture.library, discovery: [], rounds: [] };
  // Test evidence is not project content and must never enter a turn/rollback plan.
  const save = () => fs.writeFileSync(path.join(path.dirname(project), fixture.library + '-evidence.json'), JSON.stringify(evidence, null, 2));
  for (const [name, args] of [['blocks_list', { filter: fixture.types[0] }], ...fixture.types.map(type => ['block_info', { type }])]) {
    const result = await catalog.find(tool => tool.name === name).execute({ project, ...args });
    evidence.discovery.push({ tool: name, args, result }); save();
  }
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write'), edit = tools.find(tool => tool.name === 'edit');
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
  let accepted = 0;
  let baseline;
  for (const [index, round] of fixture.rounds.entries()) {
    const record = { index, calls: round.calls }; evidence.rounds.push(record); save();
    record.reusedGeneration = !!baseline;
    const exported = baseline ?? await call('abs_export', { initialize: true });
    record.exported = exported;
    if (!exported.ok) { save(); continue; }
    baseline = exported;
    // Rebuild just the tested setup body, retaining the exported header and protected roots.
    const lines = exported.abs.split('\n');
    const start = lines.findIndex(line => line === 'arduino_setup()'); assert.ok(start >= 0);
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    const oldCalls = lines.slice(start + 1, end).filter(line => line.trim());
    const sourceFor = calls => [...lines.slice(0, start + 1), ...calls.map(line => '    ' + line), '', ...lines.slice(end)].join('\n');
    const source = sourceFor(round.calls); record.source = source;
    if (round.invalidCalls) {
      const before = mirrors();
      record.invalidVariant = await call('abs_validate', { generation: exported.generation, abs: sourceFor(round.invalidCalls) });
      save();
      assert.equal(record.invalidVariant.ok, false, 'Missing native shape state must not invent inputs');
      assert.match(record.invalidVariant.error, /Native input is unavailable: ADD2/);
      assert.deepEqual(mirrors(), before, 'Negative variant changed project mirrors');
    }
    await read.execute('random-read-' + index, { path: 'project.abs' }, undefined, undefined, {});
    if (round.batchEdit) {
      assert.equal(oldCalls.length, round.calls.length);
      const edits = oldCalls.map((oldText, i) => ({ oldText, newText: '    ' + round.calls[i] })).filter(e => e.oldText !== e.newText);
      assert.ok(edits.length > 1, 'Batch scenario must change multiple calls');
      record.editToolCalls = 1; record.editCount = edits.length;
      await edit.execute('random-batch-' + index, { path: 'project.abs', edits }, undefined, undefined, {});
    } else await write.execute('random-write-' + index, { path: 'project.abs', content: source }, undefined, undefined, {});
    const before = mirrors();
    const args = { generation: exported.generation, absPath: 'project.abs', chunk: true,
      ...(accepted === 0 && fixture.createVariables ? { createVariables: fixture.createVariables } : {}) };
    record.validation = await call('abs_validate', args); save(); assert.deepEqual(mirrors(), before);
    // Test the real import endpoint too, including atomic refusal for invalid candidates.
    record.applied = await call('abs_import', args); save();
    if (!record.applied.ok) {
      const after = mirrors();
      record.refusalFileChanges = ['project.abi', 'project.abs', 'project.abs.map.json'].filter((_, i) => !after[i].equals(before[i]));
      record.refusalMirrorsUnchanged = record.refusalFileChanges.length === 0;
      // General Agent writes first enter its VFS. External-mutation tools
      // materialize that draft even if the host then refuses the candidate.
      record.refusalCommittedStateUnchanged = after[0].equals(before[0]) && after[2].equals(before[2]);
      record.refusedDraftPreserved = after[1].toString('utf8') === source;
      save(); continue;
    }
    assert.equal(record.validation.ok, true, 'Import must not succeed after validation refused');
    accepted++;
    baseline = undefined;
    record.saved = await call('project_save'); assert.equal(record.saved.ok, true, JSON.stringify(record.saved));
    record.canonicalAbs = fs.readFileSync(path.join(project, 'project.abs'), 'utf8');
    record.abi = JSON.parse(fs.readFileSync(path.join(project, 'project.abi'), 'utf8'));
    try {
      const blocks = [];
      const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (fixture.types.includes(value.type)) blocks.push(value);
        Object.values(value).forEach(visit);
      };
      visit(record.abi);
      assert.equal(blocks.length, round.calls.length);
      record.testedBlockIds = blocks.map(block => block.id).sort();
      const previous = evidence.rounds.slice(0, -1).filter(item => item.testedBlockIds).at(-1);
      if (previous) assert.deepEqual(record.testedBlockIds, previous.testedBlockIds, 'Tested native block identities changed');
      for (const [i, expected] of (round.instances || [round]).entries()) {
        for (const [name, target] of Object.entries(expected.fields || {})) assert.equal(blocks[i].fields?.[name], target, name);
        for (const name of expected.absentFields || []) assert.equal(Object.hasOwn(blocks[i].fields || {}, name), false, name);
        if (expected.extraState) assert.deepEqual(blocks[i].extraState, expected.extraState);
        for (const name of expected.absentInputs || []) assert.equal(Object.hasOwn(blocks[i].inputs || {}, name), false, name);
        for (const [name, target] of Object.entries(expected.inputValues || {})) assert.equal(blocks[i].inputs?.[name]?.block?.fields?.NUM, target, name);
      }
      record.semanticFieldsVerified = true;
    } catch (error) { record.semanticError = error.message; }
    save();
  }
  evidence.accepted = accepted;
  evidence.finalExport = await call('abs_export', { initialize: true });
  save();
  return evidence;
}
module.exports = { runRandomLibrary };
