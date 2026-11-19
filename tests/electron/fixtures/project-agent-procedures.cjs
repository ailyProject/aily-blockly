const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runProcedures(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const general = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = general.find(tool => tool.name === 'read'), write = general.find(tool => tool.name === 'write');
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFileSync(path.join(project, name)));
  const rounds = [];
  let identity;
  for (let round = 0; round < 3; round++) {
    const exported = await call('abs_export', { initialize: round === 0 }); assert.equal(exported.ok, true, JSON.stringify(exported));
    const candidate = round === 0 ? exported.abs.replace('arduino_setup()', 'arduino_setup()\n    @ARDUINO_SETUP:\n        procedures_callnoreturn() @extra:{"name":"abs_work"}')
      + '\nprocedures_defnoreturn(NAME="abs_work")'
      : round === 1 ? exported.abs.replace('procedures_defnoreturn(NAME="abs_work")', 'procedures_defnoreturn(NAME="abs_work") @extra:{"params":[{"name":"amount"}]}')
        .replace('procedures_callnoreturn() @extra:{"name":"abs_work"}', 'procedures_callnoreturn(ARG0=math_number(NUM=7)) @extra:{"name":"abs_work","params":["amount"]}')
      : exported.abs.replace('NUM=7', 'NUM=9');
    assert.notEqual(candidate, exported.abs);
    const createVariables = round === 1 ? [{ name: 'amount' }] : undefined;
    await read.execute('read-procedures-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('write-procedures-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
    const before = mirrors();
    const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs', createVariables });
    assert.equal(validation.ok, true, JSON.stringify(validation)); assert.deepEqual(mirrors(), before);
    const applied = await call(round === 2 ? 'abs_import' : 'abs_apply', { generation: exported.generation, absPath: 'project.abs', createVariables, chunk: round === 1 });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const doc = JSON.parse(fs.readFileSync(path.join(project, 'project.abi'), 'utf8'));
    assert.equal(doc.sharedModel.procedureBlocks.length, 1);
    const definition = doc.sharedModel.procedureBlocks[0];
    if (round === 0) identity = definition.id; else assert.equal(definition.id, identity);
    rounds.push({ validation: validation.receipt, applied: applied.receipt });
  }
  const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
  const exported = await call('abs_export'); assert.equal(exported.ok, true, JSON.stringify(exported));
  const before = mirrors();
  const bad = exported.abs.replace('"name":"abs_work","params":["amount"]', '"name":"abs_work","params":["missing"]');
  assert.notEqual(bad, exported.abs);
  const rejected = await call('abs_apply', { generation: exported.generation, abs: bad });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'ABS_PROCEDURE_INVALID'); assert.deepEqual(mirrors(), before);
  const inspection = await call('project_recover', { action: 'inspect' }); assert.equal(inspection.pending, null);
  return { definitionId: identity, rounds, rejected: rejected.code, saved: saved.projectionReceipt, diagnostics: inspection.diagnostics };
}

async function rejectCrossPageSignature(project, call) {
  const exported = await call('abs_export'); assert.equal(exported.ok, true, JSON.stringify(exported));
  const before = ['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFileSync(path.join(project, name)));
  const candidate = exported.abs.replace(/@extra:\{"params":\[\{[^\n]+?\}\]\}/, '@extra:{"params":[{"name":"other_amount"}]}');
  assert.notEqual(candidate, exported.abs);
  const result = await call('abs_apply', { generation: exported.generation, abs: candidate, createVariables: [{ name: 'other_amount' }] });
  assert.equal(result.ok, false); assert.equal(result.code, 'ABS_SHARED_CONTRACT_REQUIRED', JSON.stringify(result));
  assert.deepEqual(['project.abi', 'project.abs', 'project.abs.map.json'].map(name => fs.readFileSync(path.join(project, name))), before);
  return { rejected: result.code };
}

module.exports = { runProcedures, rejectCrossPageSignature };
