const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runFieldShape(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write');
  const capabilities = [];
  for (const type of ['math_arithmetic', 'math_single', 'math_trig', 'seeed_gfx_play_animation', 'math_number_property', 'text_charAt']) {
    const info = await call('block_info', { type });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.absCapability.contract, ['math_number_property', 'text_charAt'].includes(type) ? 'field-shape-v1' : 'declarative-v1', JSON.stringify(info));
    capabilities.push({ type, capability: info.absCapability });
  }
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const exported = await call('abs_export', { initialize: true });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const candidate = round === 0
      ? exported.abs.replace('arduino_setup()', 'arduino_setup()\n    controls_if(math_number_property(math_arithmetic(8, ADD, 0), DIVISIBLE_BY, 2))\n        time_delay(text_length(text_charAt("abc", FROM_START, 1)))\n        time_delay(text_length(text_charAt("xyz", LAST)))')
      : round === 1 ? exported.abs.replace(/DIVISIBLE_BY, math_number\(2\)/, 'EVEN').replace(/FROM_START, math_number\(1\)/, 'FIRST')
        : exported.abs.replace('EVEN)', 'DIVISIBLE_BY, math_number(4))').replace('FIRST)', 'FROM_END, math_number(2))');
    assert.notEqual(candidate, exported.abs, 'Edit must change actual exported ABS');
    await read.execute('read-field-shape-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('write-field-shape-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
    const before = fs.readFileSync(path.join(project, 'project.abi'));
    const validation = await call('abs_validate', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    assert.deepEqual(fs.readFileSync(path.join(project, 'project.abi')), before);
    const applied = await call('abs_apply', { generation: exported.generation, absPath: 'project.abs' });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    rounds.push({ validation: validation.receipt, applied: applied.receipt });
  }
  return { capabilities, rounds };
}
module.exports = { runFieldShape };
