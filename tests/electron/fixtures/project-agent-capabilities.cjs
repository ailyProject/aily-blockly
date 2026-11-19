const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runCapabilities(project, call) {
  const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(name => {
    const file = path.join(project, name); return fs.existsSync(file) ? fs.readFileSync(file) : null;
  });
  const before = mirrors();
  const list = await call('blocks_list', { filter: 'procedures_' });
  assert.equal(list.ok, true, JSON.stringify(list)); assert.equal(list.absCapabilities.status, 'current-host');
  for (const type of ['procedures_defnoreturn', 'procedures_defreturn', 'procedures_callnoreturn', 'procedures_callreturn']) {
    assert.equal(list.blocks.find(block => block.type === type)?.absCapability.level, 'reshape', type);
  }
  const definition = await call('block_info', { type: 'procedures_defnoreturn' });
  assert.equal(definition.absCapability.contract, 'bundled-procedures-v1');
  const fixed = await call('block_info', { type: 'math_number' });
  assert.equal(fixed.absCapability.level, 'create'); assert.equal(fixed.metadataSource, 'host-contract');
  const custom = await call('block_info', { type: 'custom_function_def' });
  assert.equal(custom.absCapability.level, 'reshape'); assert.equal(custom.absCapability.contract, 'library-custom-functions-v1');
  const missing = await call('block_info', { type: 'abs_capability_missing_fixture' });
  assert.equal(missing.absCapability.level, 'unavailable'); assert.equal(missing.ok, false);
  assert.deepEqual(mirrors(), before);
  return { evidence: list.absCapabilities, count: list.count,
    levels: [definition, fixed, custom, missing].map(item => ({ type: item.type, level: item.absCapability.level })) };
}
module.exports = { runCapabilities };
