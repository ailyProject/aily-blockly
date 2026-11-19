const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function runConditional(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write');
  const capabilities = [];
  for (const type of ['tt_getSubstring', 'esp32_i2c_write_to_device', 'esp32_i2c_read_from_device']) {
    const info = await call('block_info', { type });
    assert.equal(info.ok, true, JSON.stringify(info));
    assert.equal(info.absCapability.contract, 'field-shape-v1', JSON.stringify(info));
    capabilities.push({ type, capability: info.absCapability });
  }
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const exported = await call('abs_export', { initialize: true });
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const range = round === 0 ? 'FROM_START, FROM_END, 1, 2' : round === 1 ? 'FIRST, LAST' : 'FROM_END, FROM_START, 2, 4';
    const address = round === 1 ? '"0x3C"' : 'CUSTOM', custom = round === 1 ? '' : ', 32';
    const start = exported.abs.indexOf('arduino_setup()'), end = exported.abs.indexOf('\narduino_loop()', start);
    assert.ok(start >= 0 && end > start, 'Actual board roots must be present');
    const candidate = exported.abs.slice(0, start) + 'arduino_setup()\n'
      + `    time_delay(text_length(tt_getSubstring("abcdef", ${range})))\n`
      + `    esp32_i2c_write_to_device(${address}, tt_getSubstring("xyz", FIRST, LAST)${custom})\n`
      + exported.abs.slice(end);
    await read.execute('read-conditional-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('write-conditional-' + round, { path: 'project.abs', content: candidate }, undefined, undefined, {});
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
module.exports = { runConditional };
