const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** Real Agent tools, from an empty board: no pre-created instances or filtered replay. */
async function runNativeCreation(project, load, call, history) {
  const { createTools } = await load('tools/create-tools.js');
  const tools = createTools(project, history, { allowsApprovedExternalPath: () => false }, []);
  const read = tools.find(tool => tool.name === 'read'), write = tools.find(tool => tool.name === 'write');
  const rounds = [], capabilities = [];
  for (const type of ['dht_init', 'max31865_init']) {
    const info = await call('block_info', { type });
    assert.equal(info.ok, true, JSON.stringify(info)); capabilities.push({ type, capability: info.absCapability });
  }
  let identities;
  const variants = [
    ['dht_init("native_dht", DHT22, D0)', 'max31865_init("native_rtd", SW, D1, MAX31865_2WIRE, D2, D3, D4)'],
    ['dht_init("native_dht", DHT20, Wire)', 'max31865_init("native_rtd", HW, D1, MAX31865_2WIRE)'],
    ['dht_init("native_dht", DHT22, D0)', 'max31865_init("native_rtd", SW, D1, MAX31865_2WIRE, D2, D3, D4)'],
  ];
  for (const [round, calls] of variants.entries()) {
    const exported = await call('abs_export', { initialize: true }); assert.equal(exported.ok, true, JSON.stringify(exported));
    let source = exported.abs;
    if (round === 0) source = source.replace('arduino_setup()', 'arduino_setup()\n    ' + calls.join('\n    '));
    else for (const [i, type] of ['dht_init', 'max31865_init'].entries()) {
      const lines = source.split('\n'), found = lines.map((line, index) => line.trimStart().startsWith(type + '(') ? index : -1).filter(index => index >= 0);
      assert.equal(found.length, 1); const index = found[0];
      lines[index] = lines[index].match(/^\s*/)[0] + calls[i]; source = lines.join('\n');
    }
    assert.notEqual(source, exported.abs);
    await read.execute('native-create-read-' + round, { path: 'project.abs' }, undefined, undefined, {});
    await write.execute('native-create-write-' + round, { path: 'project.abs', content: source }, undefined, undefined, {});
    const mirrors = () => ['project.abi', 'project.abs', 'project.abs.map.json'].map(file => fs.readFileSync(path.join(project, file)));
    const before = mirrors();
    const intent = round === 0 ? { createVariables: [{ name: 'native_dht', type: 'DHT' }, { name: 'native_rtd', type: 'Adafruit_MAX31865' }] } : {};
    const args = { generation: exported.generation, absPath: 'project.abs', chunk: round !== 1, ...intent };
    const validation = await call('abs_validate', args);
    fs.writeFileSync(path.join(project, `native-validation-${round}.json`), JSON.stringify(validation, null, 2));
    assert.equal(validation.ok, true, JSON.stringify(validation)); assert.deepEqual(mirrors(), before);
    const applied = await call('abs_apply', args); assert.equal(applied.ok, true, JSON.stringify(applied));
    const saved = await call('project_save'); assert.equal(saved.ok, true, JSON.stringify(saved));
    const map = JSON.parse(fs.readFileSync(path.join(project, 'project.abs.map.json'), 'utf8'));
    const current = map.nodes.map(node => node.blockId).sort();
    if (identities) assert.deepEqual(current, identities, 'Configuration edits must retain native block identities');
    else identities = current;
    rounds.push({ validation: validation.receipt, applied: applied.receipt, saved: saved.projectionReceipt });
  }
  return { rounds, capabilities, identities, scope: 'agent-tools-native-create-and-reshape' };
}
module.exports = { runNativeCreation };
