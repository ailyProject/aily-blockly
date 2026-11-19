const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runStructural(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write');
  const capabilities = [];
  for (const type of ['controls_if', 'controls_switch', 'text_join']) {
    const info = await call('block_info', { type });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.absCapability.contract, 'structural-mutator-v1', JSON.stringify(info));
    capabilities.push({ type, mutation: info.absCapability.shape.mutation });
  }
  const rounds = [];
  let identities;
  for (let round = 0; round < 2; round++) {
    const exported = await call('abs_export', { initialize: true });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const candidate = round ? exported.abs.replace('"elseIfCount":1', '"elseIfCount":2').replace('"caseCount":1', '"caseCount":2').replace('"hasDefault":true', '"hasDefault":false').replace('"itemCount":2', '"itemCount":3')
      : exported.abs.replace('arduino_setup()', 'arduino_setup()\n    controls_if(true, false)\n        @DO0:\n            time_delay(7)\n        @DO1:\n            time_delay(number(8))\n        @ELSE:\n    controls_switch(7, 1, 2)\n    time_delay(text_length(text_join(ADD0="a", ADD1="b")))');
    assert.notEqual(candidate, exported.abs);
    await read.execute('read-structural-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('write-structural-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
    const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
    const before = mirrors();
    const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.deepEqual(mirrors(), before);
    const applied = await call('abs_apply', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
    const current = JSON.parse(fs.readFileSync(path.join(project, 'project.abs.map.json'), 'utf8')).nodes.map(node => node.blockId).sort();
    if (identities) assert.deepEqual(current, identities, 'Adding empty slots must retain all block identities');
    identities = current;
    rounds.push({ validation: validation.receipt, applied: applied.receipt, saved: saved.projectionReceipt });
  }
  return { capabilities, rounds, identities, scope: 'readme-shorthand-and-explicit-empty-slots' };
}
module.exports = { runStructural };
