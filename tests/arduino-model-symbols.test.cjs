const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const Blockly = require('blockly');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts');
const compiled = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['blockly'], logLevel: 'silent' }).outputFiles[0].text;
const loaded = new Module(entry, module);
loaded.paths = Module._nodeModulePaths(root);
loaded._compile(compiled, entry);
const { createArduinoGenerator } = loaded.exports;

// The desktop installs its legacy procedure adapter. These contracts have no
// procedure definitions and isolate the real generator's symbol lifecycle.
const populateProcedures = Blockly.Names.prototype.populateProcedures;
Blockly.Names.prototype.populateProcedures = function () {};
test.after(() => { Blockly.Names.prototype.populateProcedures = populateProcedures; });

function fixture(t, records = []) {
  const workspace = new Blockly.Workspace();
  const map = workspace.getVariableMap();
  const models = records.map(([name, type, id]) => map.createVariable(name, type, id));
  const generator = createArduinoGenerator();
  t.after(() => workspace.dispose());
  return { workspace, map, models, generator, begin: () => generator.init(workspace) };
}

function declareModels(f, ids = f.models.map(model => model.getId())) {
  f.generator.registerModelSymbolDeclarations('fixture-declarations', workspace => ids.flatMap(id => {
    const model = workspace.getVariableMap().getVariableById(id);
    return model ? [{ nameOrId: id, type: model.getType(), by: 'id' }] : [];
  }));
}

test('typed declaration labels and field IDs share a generated name outside SDK globals', t => {
  const f = fixture(t, [['link', 'Widget', 'widget-link-id']]);
  declareModels(f); f.begin();
  const name = f.generator.getModelSymbol('link', 'Widget');
  assert.match(name, /^ailyModel_[A-Za-z0-9_]+$/);
  assert.notEqual(name, 'link');
  assert.equal(f.generator.getModelSymbol(f.models[0].getId(), 'Widget'), name);
  assert.equal(f.generator.getModelSymbolReference(f.models[0]), name);
  f.generator.addVariable('widget', `void * ${name};`);
  f.generator.addSetup('widget', `${name} = nullptr;`);
  const code = f.generator.finish('');
  assert.ok(code.includes(`void * ${name};`));
  assert.ok(code.includes(`${name} = nullptr;`));
  assert.doesNotMatch(code, /void \* link;/);
  assert.equal(f.models[0].getName(), 'link');
});

test('Unicode, punctuation and identical names of different native types retain distinct model identities', t => {
  const records = [['温度 A', 'Device', 'id-one'], ['温度-A', 'Device', 'id-two'],
    ['shared', 'Device', 'id-three'], ['shared', 'OtherDevice', 'id-four']];
  const f = fixture(t, records);
  declareModels(f);
  f.begin();
  const names = records.map(([name, type]) => f.generator.getModelSymbol(name, type));
  assert.equal(new Set(names).size, records.length);
  for (const name of names) assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
  assert.deepEqual(f.map.getAllVariables().map(model => model.getName()), records.map(record => record[0]));
});

test('display renaming leaves code identity stable without modifying the native model', t => {
  const f = fixture(t, [['old label', 'Device', 'fixed-id']]);
  declareModels(f); f.begin();
  const before = f.generator.getModelSymbol('old label', 'Device');
  f.map.renameVariable(f.models[0], 'new label');
  assert.equal(f.generator.getModelSymbol('new label', 'Device'), before);
  f.begin();
  assert.equal(f.generator.getModelSymbol('new label', 'Device'), before);
  assert.equal(f.models[0].getName(), 'new label');
});

test('generation reset and declaration reordering cannot swap generated symbols', t => {
  const records = [['one', 'Device', 'native-one'], ['two', 'Device', 'native-two']];
  const f = fixture(t, records), reverse = fixture(t, [...records].reverse());
  for (const item of [f, reverse]) { declareModels(item); item.begin(); }
  const expected = records.map(([name, type]) => f.generator.getModelSymbol(name, type));
  for (const [name, type] of [...records].reverse()) reverse.generator.getModelSymbol(name, type);
  assert.deepEqual(records.map(([name, type]) => reverse.generator.getModelSymbol(name, type)), expected);
  f.begin();
  assert.deepEqual(records.map(([name, type]) => f.generator.getModelSymbol(name, type)), expected);
});

test('registered declaration resolvers opt in individual untyped models before any consumer runs', t => {
  const f = fixture(t, [['link', '', 'ordinary-link'], ['legacy', '', 'unmigrated']]);
  let runs = 0;
  f.generator.registerModelSymbolDeclarations('plain-declarations', workspace => {
    runs++;
    return [{ nameOrId: workspace.getVariableMap().getVariable('link', '').getId(), type: '' }];
  });
  f.begin();
  const beforeDeclaration = f.generator.getModelSymbolReference('ordinary-link');
  assert.match(beforeDeclaration, /^ailyModel_/);
  assert.equal(beforeDeclaration, f.generator.getModelSymbol('link', ''));
  assert.equal(f.generator.getModelSymbolReference('unmigrated'), undefined);
  f.begin();
  assert.equal(runs, 2);
  assert.equal(f.generator.getModelSymbolReference('ordinary-link'), beforeDeclaration);
});

test('declaration registrations replace by key and old generation claims do not leak', t => {
  const f = fixture(t, [['one', '', 'one'], ['two', '', 'two']]);
  f.generator.registerModelSymbolDeclarations('owner', () => [{ nameOrId: 'one', type: '' }]);
  f.begin(); assert.match(f.generator.getModelSymbolReference('one'), /^ailyModel_/);
  f.generator.registerModelSymbolDeclarations('owner', () => [{ nameOrId: 'two', type: '' }]);
  f.begin();
  assert.equal(f.generator.getModelSymbolReference('one'), undefined);
  assert.match(f.generator.getModelSymbolReference('two'), /^ailyModel_/);
});

test('role and lexical scope are separate claims while unmatched locals stay local', t => {
  const f = fixture(t, [['link', '', 'global-link']]);
  f.generator.registerModelSymbolDeclarations('global', () => [{ nameOrId: 'global-link', type: '' }]);
  f.begin();
  const global = f.generator.getModelSymbolReference('global-link');
  assert.equal(f.generator.getModelSymbolReference('link'), undefined, 'Display text is not an exact native ID');
  assert.equal(f.generator.getModelSymbolReference('procedure-param-link'), undefined);
  assert.equal(f.generator.getModelSymbolReference('global-link', { scope: 'procedure-1' }), undefined);
  const local = f.generator.getModelSymbol('global-link', '', { scope: 'procedure-1' });
  const handle = f.generator.getModelSymbol('global-link', '', { role: 'handle' });
  assert.notEqual(local, global); assert.notEqual(handle, global); assert.notEqual(local, handle);
  assert.equal(f.generator.getModelSymbolReference('global-link', { scope: 'procedure-1' }), local);
});

test('unmigrated raw references retain their original Names mapping while owned IDs share the opt-in symbol', t => {
  const f = fixture(t, [['link', 'Widget', 'widget'], ['legacy', '', 'plain']]);
  declareModels(f, ['widget']); f.begin();
  assert.equal(f.generator.getVariableName('plain'), 'legacy');
  const symbol = f.generator.getModelSymbolReference('widget');
  assert.match(symbol, /^ailyModel_/);
  assert.equal(f.generator.getVariableName('widget'), symbol, 'Legacy native-ID readers join the owned symbol');
  assert.equal(f.generator.getModelSymbolReference('plain'), undefined);
});

test('missing or differently typed declarations are rejected without creating another variable', t => {
  const f = fixture(t, [['sensor', 'Device', 'sensor-id']]);
  f.begin();
  const before = f.map.getAllVariables().map(model => [model.getId(), model.getName(), model.getType()]);
  assert.throws(() => f.generator.getModelSymbol('missing', 'Device'), /model/i);
  assert.throws(() => f.generator.getModelSymbol('sensor-id', 'WrongDevice'), /type|model/i);
  assert.equal(f.generator.getModelSymbolReference('missing'), undefined);
  assert.deepEqual(f.map.getAllVariables().map(model => [model.getId(), model.getName(), model.getType()]), before);
});

test('registration belongs to a generator instance and a new workspace has fresh native ownership', t => {
  const f = fixture(t, [['shared', 'Device', 'old-model']]);
  const other = fixture(t, [['shared', 'Device', 'new-model']]);
  f.generator.registerModelSymbolDeclarations('owned-creators', workspace => workspace.getVariableMap().getAllVariables().map(model =>
    ({ nameOrId: model.getId(), type: model.getType(), by: 'id' })));
  f.begin(); other.begin();
  const old = f.generator.getModelSymbolReference('old-model');
  assert.equal(other.generator.getModelSymbolReference('new-model'), undefined);
  f.generator.init(other.workspace);
  assert.equal(f.generator.getModelSymbolReference('old-model'), undefined);
  assert.notEqual(f.generator.getModelSymbolReference('new-model'), old);
});

test('a declaration label equal to another native ID cannot silently claim the other model', t => {
  const f = fixture(t, [['first', 'Device', 'second'], ['second', 'Device', 'actual-second']]);
  declareModels(f); f.begin();
  const first = f.generator.getModelSymbolReference('second');
  const second = f.generator.getModelSymbolReference('actual-second');
  assert.notEqual(first, second);
  assert.equal(f.generator.getModelSymbol('second', 'Device', { by: 'name' }), second);
  assert.equal(f.generator.getModelSymbol('second', 'Device', { by: 'id' }), first);
  assert.throws(() => f.generator.getModelSymbol('second', 'Device'), /ambiguous/i);
});

test('invalid declaration preparation cannot leave partial claims active', t => {
  const f = fixture(t, [['one', '', 'one-id']]);
  f.generator.registerModelSymbolDeclarations('invalid', () => [
    { nameOrId: 'one-id', type: '', by: 'id' }, { nameOrId: 'missing', type: '', by: 'id' },
  ]);
  assert.throws(() => f.begin(), /model/i);
  assert.equal(f.generator.getModelSymbolReference('one-id'), undefined);
});

test('a migrated declaration cannot take ownership of another creator merely sharing its model type', t => {
  const f = fixture(t, [['owned', 'Device', 'owned-id'], ['legacy creator', 'Device', 'legacy-id']]);
  // Exercise the initial unreleased extension hook if present: a type label
  // must never imply ownership of every third-party creator with that type.
  f.generator.registerModelSymbolType?.('Device');
  f.generator.registerModelSymbolDeclarations('migrated-creator', () => [
    { nameOrId: 'owned-id', type: 'Device', by: 'id' },
  ]);
  f.begin();
  assert.match(f.generator.getModelSymbolReference('owned-id'), /^ailyModel_/);
  assert.equal(f.generator.getModelSymbolReference('legacy-id'), undefined);
  assert.equal(f.models[1].getName(), 'legacy creator');
});

test('legacy Names consumers share an owned native symbol while unrelated IDs and local text keep raw names', t => {
  const f = fixture(t, [['link', '', 'owned-link'], ['raw', '', 'raw-id']]);
  declareModels(f, ['owned-link']); f.begin();
  const symbol = f.generator.getModelSymbolReference('owned-link');
  assert.equal(f.generator.nameDB_.getName('owned-link', Blockly.Names.NameType.VARIABLE), symbol);
  assert.equal(f.generator.getVariableName('owned-link'), symbol);
  assert.equal(f.generator.nameDB_.getName('raw-id', 'VARIABLE'), 'raw');
  assert.equal(f.generator.getVariableName('raw-id'), 'raw');
  assert.equal(f.generator.nameDB_.getName('link', 'VARIABLE'), 'link', 'Parameter text is not a native ID');
  assert.equal(f.generator.nameDB_.getName('owned-link', 'PROCEDURE'), 'owned_link');
  const isolated = new Blockly.Names(''); isolated.setVariableMap(f.map);
  assert.equal(isolated.getName('owned-link', 'VARIABLE'), 'link', 'No Blockly prototype or other generator is rewritten');
});

test('a late declaration changes only its native Names reference and reset removes that ownership', t => {
  const f = fixture(t, [['link', '', 'owned-link'], ['raw', '', 'raw-id']]); f.begin();
  assert.equal(f.generator.getVariableName('owned-link'), 'link');
  const symbol = f.generator.getModelSymbol('owned-link', '', { by: 'id' });
  assert.equal(f.generator.getVariableName('owned-link'), symbol);
  assert.equal(f.generator.nameDB_.getName('owned-link', 'VARIABLE'), symbol);
  assert.equal(f.generator.getVariableName('raw-id'), 'raw');
  f.begin();
  assert.equal(f.generator.getModelSymbolReference('owned-link'), undefined);
  assert.equal(f.generator.getVariableName('owned-link'), 'link');
});

test('Names population sees no previous generation ownership and its instance adapter is installed only once', t => {
  const f = fixture(t, [['link', '', 'owned-link']]); declareModels(f);
  f.generator.nameDB_ = new Blockly.Names('');
  const originalPopulation = f.generator.nameDB_.populateVariables;
  let populations = 0;
  f.generator.nameDB_.populateVariables = function(workspace) {
    populations++;
    assert.equal(f.generator.getModelSymbolReference('owned-link'), undefined);
    return originalPopulation.call(this, workspace);
  };
  f.begin();
  const adapted = f.generator.nameDB_.getName, symbol = f.generator.getVariableName('owned-link');
  for (let iteration = 0; iteration < 3; iteration++) {
    f.begin();
    assert.equal(f.generator.nameDB_.getName, adapted);
    assert.equal(f.generator.getVariableName('owned-link'), symbol);
  }
  assert.equal(populations, 4);
});

test('native procedure context keeps actual untyped parameters local without shadowing a typed same-name model', t => {
  const types = ['model_symbol_contract_scope', 'model_symbol_contract_read'];
  const originals = types.map(type => Blockly.Blocks[type]);
  Blockly.defineBlocksWithJsonArray([
    { type: types[0], message0: 'scope %1', args0: [{ type: 'input_statement', name: 'BODY' }] },
    { type: types[1], message0: '%1', args0: [{ type: 'field_input', name: 'MODEL', text: '' }], previousStatement: null, nextStatement: null },
  ]);
  t.after(() => types.forEach((type, index) => { if (originals[index]) Blockly.Blocks[type] = originals[index]; else delete Blockly.Blocks[type]; }));
  const f = fixture(t, [['link', '', 'global-link'], ['link', 'Device', 'typed-link']]); declareModels(f); f.begin();
  const scope = f.workspace.newBlock(types[0]); scope.getProcedureDef = () => ['a_native_procedure', ['link'], false];
  const plainRead = f.workspace.newBlock(types[1]), typedRead = f.workspace.newBlock(types[1]);
  plainRead.setFieldValue('global-link', 'MODEL'); typedRead.setFieldValue('typed-link', 'MODEL');
  scope.getInput('BODY').connection.connect(plainRead.previousConnection); plainRead.nextConnection.connect(typedRead.previousConnection);
  f.generator.forBlock[types[1]] = (block, generator) => generator.getVariableName(block.getFieldValue('MODEL')) + ';\n';
  f.generator.forBlock[types[0]] = (block, generator) => `void native_scope(int ${generator.getVariableName('global-link')}) {\n${generator.statementToCode(block, 'BODY')}}\n`;
  const global = f.generator.getModelSymbolReference('global-link'), typed = f.generator.getModelSymbolReference('typed-link');
  const code = f.generator.blockToCode(scope);
  assert.ok(code.includes('int link)'));
  assert.ok(code.includes('link;'));
  assert.ok(code.includes(typed + ';'));
  assert.ok(!code.includes(global));
  assert.equal(f.generator.getVariableName('global-link'), global, 'Leaving the block frame restores global ownership');
});

test('a library-owned scope provider preserves its actual local model without teaching the host private block shapes', t => {
  const types = ['model_symbol_extension_scope', 'model_symbol_extension_read'];
  const originals = types.map(type => Blockly.Blocks[type]);
  Blockly.defineBlocksWithJsonArray([
    { type: types[0], message0: 'scope %1', args0: [{ type: 'input_statement', name: 'BODY' }] },
    { type: types[1], message0: '%1', args0: [{ type: 'field_input', name: 'MODEL', text: '' }], previousStatement: null, nextStatement: null },
  ]);
  t.after(() => types.forEach((type, index) => { if (originals[index]) Blockly.Blocks[type] = originals[index]; else delete Blockly.Blocks[type]; }));
  const f = fixture(t, [['link', '', 'global-link'], ['other', '', 'other-id']]); declareModels(f);
  const scope = f.workspace.newBlock(types[0]); scope.extensionOwnedParameters = ['global-link'];
  assert.equal(typeof scope.getProcedureDef, 'undefined', 'The extension owns a different native scope protocol');
  const local = f.workspace.newBlock(types[1]), global = f.workspace.newBlock(types[1]);
  local.setFieldValue('global-link', 'MODEL'); global.setFieldValue('other-id', 'MODEL');
  scope.getInput('BODY').connection.connect(local.previousConnection); local.nextConnection.connect(global.previousConnection);
  const observedModels = new Set();
  f.generator.registerModelSymbolLocalScope('extension.scope', (block, model) => {
    observedModels.add(model);
    return block.extensionOwnedParameters?.includes(model.getId()) === true;
  });
  f.generator.forBlock[types[1]] = (block, generator) => generator.getVariableName(block.getFieldValue('MODEL')) + ';\n';
  f.generator.forBlock[types[0]] = (block, generator) => generator.statementToCode(block, 'BODY');
  f.begin();
  const outside = f.generator.getModelSymbolReference('global-link'), other = f.generator.getModelSymbolReference('other-id');
  const code = f.generator.blockToCode(scope);
  assert.ok(code.includes('link;')); assert.ok(!code.includes(outside)); assert.ok(code.includes(other));
  assert.ok(observedModels.has(f.models[0]));
  assert.equal(f.generator.getVariableName('global-link'), outside);
  f.generator.registerModelSymbolLocalScope('extension.scope', () => false);
  assert.ok(f.generator.blockToCode(scope).includes(outside));
});
