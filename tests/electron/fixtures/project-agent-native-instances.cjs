const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runNativeInstances(project, load, call, history) {
  const edits = JSON.parse(process.env.AILY_ABS_NATIVE_EDITS);
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write');
  for (const edit of edits) {
    const info = await call('block_info', { type: edit.type });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.absCapability.level, 'validate', 'A replayable runtime offers validation, not pre-approved creation');
  }
  const rounds = [];
  const pinToken = value => /^[A-Za-z_]\w*$/.test(value) && !['true', 'false', 'null'].includes(value) ? value : JSON.stringify(value);
  for (let round = 0; round < 3; round++) {
    const exported = await call('abs_export', { initialize: true }); assert.equal(exported.ok, true, JSON.stringify(exported));
    let candidate = exported.abs;
    for (const edit of edits) {
      const lines = candidate.split('\n'), matches = lines.map((line, i) => line.trimStart().startsWith(edit.type + '(') ? i : -1).filter(i => i >= 0);
      assert.equal(matches.length, 1);
      const index = matches[0], from = round === 1 ? edit.to : edit.from, to = round === 1 ? edit.from : edit.to;
      const suffix = ', ' + pinToken(from) + ')';
      assert.ok(lines[index].endsWith(suffix), 'Final native argument is the requested pin, not a guessed slot');
      lines[index] = lines[index].slice(0, -suffix.length) + ', ' + pinToken(to) + ')'; candidate = lines.join('\n');
    }
    await read.execute('native-read-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('native-write-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
    const before = fs.readFileSync(path.join(project, 'project.abi'));
    const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(validation.ok, true, JSON.stringify(validation)); assert.deepEqual(fs.readFileSync(path.join(project, 'project.abi')), before);
    const applied = await call('abs_apply', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(applied.ok, true, JSON.stringify(applied)); rounds.push({ validation: validation.receipt, applied: applied.receipt });
  }
  return { rounds, scope: 'existing-native-instances', noPreapprovedCreation: true };
}
module.exports = { runNativeInstances };
