import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { modelSteps } from './abs-native-models.fixture';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { dhtModelFixture } from './abs-native-dht-model.fixture';
import { spiModelFixture } from './abs-native-spi-model.fixture';

describe('native initializer model preparation', () => {
  const request = (abs: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + abs, steps: structuredClone(modelSteps), modelRequestId: 'native-model-test-namespace' });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('resolves dependent initializers to a fixed point without inventing missing or cyclic models', async () => {
    const value = request('test_object_init("a", Sensor)\ndependent_init("b", test_object_read($a))\ndependent_init("c", test_object_read($b))\ntest_object_read($c)');
    value.steps.push({ kind: 'definitions', definitions: [{ type: 'dependent_init', message0: '%1 %2', args0: [
      { type: 'field_input', name: 'NAME', text: 'device' }, { type: 'input_value', name: 'VALUE' },
    ], previousStatement: null, nextStatement: null }] }, { kind: 'script', label: 'dependent-producer', source: `
      Arduino.forBlock.dependent_init = (block, generator) => {
        const value = generator.valueToCode(block, 'VALUE', 0);
        if (!value) throw new Error('Initializer must not execute before its input is ready');
        registerVariableToBlockly(block.getFieldValue('NAME'), 'Sensor');
        return '';
      };
    ` });
    const result = await run(value);
    expect(result.binding!.modelDeclarations!.map(item => item.name)).toEqual(['a', 'b', 'c']);
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    await run({ blocks: [], steps: value.steps, verify: { state: normalizeAbsSerializedWorkspace(result.state), contracts,
      modelDeclarations: result.binding!.modelDeclarations!.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })) } });
    for (const source of ['dependent_init("b", test_object_read($missing))',
      'dependent_init("a", test_object_read($b))\ndependent_init("b", test_object_read($a))']) {
      await expectAsync(run({ ...value, abs: '# ABS Schema: 2\n' + source }))
        .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
    }
  });

  it('owns fresh core loop counters without granting model creation to ordinary consumers', async () => {
    const value = request('controls_for($i, null, null, null)\ncontrols_for($i, null, null, null)');
    value.steps = [{ kind: 'context', mode: 'arduino' }, { kind: 'definitions', definitions: [{
      type: 'controls_for', message0: '%1 %2 %3 %4 %5', args0: [
        { type: 'field_variable', name: 'VAR' }, ...['FROM', 'TO', 'BY'].map(name => ({ type: 'input_value', name })),
        { type: 'input_statement', name: 'DO' },
      ], previousStatement: null, nextStatement: null,
    }] }, { kind: 'script', label: 'core-loop', source: 'Arduino.forBlock.controls_for = () => "";' }];
    const result = await run(value), effect = result.binding!.modelDeclarations![0];
    expect(effect).toEqual(jasmine.objectContaining({ kind: 'loop', name: 'i', type: '' }));
    expect(result.state['variables'].length).toBe(1);
    const replay = await run({ ...value, variables: result.state['variables'],
      identities: result.binding!.instances.map(item => ({ start: item.start, id: 'owned-' + item.start })), creations: [] });
    expect(replay.binding!.modelDeclarations).toEqual(result.binding!.modelDeclarations);
    const verify = { state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: [{ ...effect, ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id }] };
    await run({ blocks: [], steps: value.steps, verify });
    await expectAsync(run({ ...value, abs: '# ABS Schema: 2\ncontrols_for($i, null, null, null) @disabled' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
    verify.modelDeclarations[0].name = 'other';
    await expectAsync(run({ blocks: [], steps: value.steps, verify }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
  });

  it('accepts the local-library scaffold declaration pattern and typed consumers in one ABS batch', async () => {
    const value = request('scaffold_read($output)\nscaffold_begin("output")');
    value.steps = [{ kind: 'context', mode: 'arduino' }, {
      kind: 'definitions', definitions: [
        { type: 'scaffold_begin', message0: '%1', args0: [{ type: 'field_input', name: 'NAME', text: 'device' }],
          previousStatement: null, nextStatement: null },
        { type: 'scaffold_read', message0: '%1', args0: [
          { type: 'field_variable', name: 'VAR', variableTypes: ['ExampleDevice'], defaultType: 'ExampleDevice' },
        ], output: 'Number' },
      ],
    }, { kind: 'script', label: 'local-library-scaffold', source: `
      function registerVariableToBlockly(name, type) {
        const workspace = Blockly.getMainWorkspace();
        if (!workspace.getVariable(name)) workspace.createVariable(name, type);
      }
      Arduino.forBlock["scaffold_begin"] = function (block, generator) {
        registerVariableToBlockly(block.getFieldValue("NAME"), "ExampleDevice");
        return block.getFieldValue("NAME") + '.begin();\\n';
      };
      Arduino.forBlock["scaffold_read"] = function (block, generator) {
        return [block.getField('VAR').getVariable().name + '.read()', 0];
      };
    ` }];
    const result = await run(value), declaration = result.binding!.modelDeclarations![0];
    expect(declaration).toEqual(jasmine.objectContaining({ name: 'output', type: 'ExampleDevice', blockType: 'scaffold_begin' }));
    expect(result.state['variables']).toEqual([{ id: declaration.id, name: 'output', type: 'ExampleDevice' }]);
    const state = normalizeAbsSerializedWorkspace(result.state);
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    await run({ blocks: [], steps: value.steps, verify: { state, contracts,
      modelDeclarations: [{ ...declaration, ownerId: result.binding!.instances.find(item => item.start === declaration.start)!.id }] } });
    await expectAsync(run({ ...value, abs: '# ABS Schema: 2\nscaffold_read($undeclared)' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
  });

  it('runs the installed DHT full generator and binds README syntax without manually creating DHT models', async () => {
    const value = request('dht_read_temperature($sensor)\ndht_init("sensor", DHT11, 2)');
    value.steps = [{ kind: 'context', mode: 'arduino', boardConfig: { digitalPins: [['D2', '2']], i2c: [['Wire', 'Wire']] } },
      { kind: 'script', label: 'actual-installed-DHT', source: 'window.ENTRY_BLOCK_TYPES = ["arduino_setup", "arduino_loop"];\n' + dhtModelFixture.source },
      { kind: 'definitions', definitions: dhtModelFixture.blocks }];
    const result = await run(value), effect = result.binding!.modelDeclarations![0];
    expect(effect.name).toBe('sensor'); expect(effect.type).toBe('DHT');
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    await run({ blocks: [], steps: value.steps, verify: { state: normalizeAbsSerializedWorkspace(result.state), contracts,
      modelDeclarations: [{ ...effect, ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id }] } });
  });

  for (const initializer of ['max31865_init("rtd", HW, 5, MAX31865_2WIRE)',
    'max31865_init("rtd", SW, 15, MAX31865_3WIRE, SW_SCK_PIN=18, SW_MOSI_PIN=23, SW_MISO_PIN=19)']) {
    it('prepares real MAX31865 README hardware/software SPI model and dynamic fields: ' + initializer, async () => {
      const value = request('max31865_read_rtd($rtd)\n' + initializer);
      const pins = ['5', '15', '18', '23', '19'].map(pin => [pin, pin]);
      value.steps = [{ kind: 'context', mode: 'arduino', boardConfig: { digitalPins: pins } },
        { kind: 'script', label: 'actual-SPI-generator', source: spiModelFixture.source },
        { kind: 'definitions', definitions: JSON.parse(JSON.stringify(spiModelFixture.blocks).replaceAll('"${board.digitalPins}"', JSON.stringify(pins))) }];
      const result = await run(value), effect = result.binding!.modelDeclarations![0];
      expect(effect.name).toBe('rtd'); expect(effect.type).toBe('Adafruit_MAX31865');
      const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
      const verify = { state: normalizeAbsSerializedWorkspace(result.state), contracts,
        modelDeclarations: [{ ...effect, ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id }] };
      await run({ blocks: [], steps: value.steps, verify });
      value.steps.push({ kind: 'script', label: 'missing-final-registration', source: 'Arduino.forBlock.max31865_init = () => "";' });
      await expectAsync(run({ blocks: [], steps: value.steps, verify })).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
    });
  }

  for (const abs of ['test_object_init("sensor", Sensor)\ntest_object_read($sensor)',
    'test_object_read($sensor)\ntest_object_init("sensor", Sensor)']) {
    it('binds a whole batch with no createVariables regardless of declaration order: ' + abs, async () => {
      const value = request(abs), result = await run(value);
      const effect = result.binding!.modelDeclarations![0];
      expect(effect).toEqual(jasmine.objectContaining({ name: 'sensor', type: 'Sensor', blockType: 'test_object_init' }));
      expect(result.state['variables']).toEqual([{ name: 'sensor', type: 'Sensor', id: effect.id }]);
      const reader = result.binding!.instances.find(item => item.type === 'test_object_read')!;
      expect(reader.seed.fields!['OBJECT']).toEqual({ id: effect.id });
      const replay = await run({ ...value, variables: result.state['variables'], identities: result.binding!.instances.map(item => ({ start: item.start, id: 'owned-' + item.start })), creations: [] });
      expect(replay.binding!.modelDeclarations).toEqual(result.binding!.modelDeclarations);
      const state = normalizeAbsSerializedWorkspace(replay.state);
      const contracts = { fields: Object.fromEntries(replay.binding!.instances.map(item => [item.id, item.shape.fields])) };
      await run({ blocks: [], steps: value.steps, verify: { state, contracts,
        modelDeclarations: [{ ...effect, ownerId: 'owned-' + effect.start }] } });
    });
  }
  it('does not guess models from missing references or disabled initializers', async () => {
    for (const abs of ['test_object_read($missing)', 'test_object_read($sensor)\ntest_object_init("sensor", Sensor) @disabled']) {
      await expectAsync(run(request(abs))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING' }));
    }
  });
  it('preserves supplied identities, rejects type/case conflicts and duplicate producers', async () => {
    const value = request('test_object_init("sensor", Sensor)\ntest_object_read($sensor)');
    value.variables = [{ id: 'existing', name: 'sensor', type: 'Sensor' }];
    expect((await run(value)).binding!.modelDeclarations![0].id).toBe('existing');
    value.variables[0].type = 'Other';
    await expectAsync(run(value)).toBeRejected();
    for (const abs of ['test_object_init("sensor", Sensor)\ntest_object_init("sensor", Sensor)',
      'test_object_init("sensor", Other)\ntest_object_read($sensor)']) await expectAsync(run(request(abs))).toBeRejected();
  });
  it('prepares multiple independent objects and rejects unowned generator side effects', async () => {
    const value = request('test_object_read($a)\ntest_object_read($b)\ntest_object_init("a", Sensor)\ntest_object_init("b", Sensor)');
    expect((await run(value)).binding!.modelDeclarations!.map(item => item.name)).toEqual(['a', 'b']);
    value.steps.push({ kind: 'script', label: 'unowned-side-effect', source: 'Arduino.forBlock.test_object_init = block => { block.workspace.createVariable("leaked", "Sensor"); return ""; };' });
    await expectAsync(run(value)).toBeRejectedWithError(/unrequested blocks or models/);
  });

  it('rejects registration/registry replacement and swallowed declaration conflicts', async () => {
    for (const source of [
      'Arduino.forBlock.test_object_init = () => { Arduino.forBlock.test_object_read = () => ["0", 0]; return ""; };',
      'Arduino.forBlock.test_object_init = () => { registerVariableToBlockly = () => {}; return ""; };',
      'Arduino.forBlock.test_object_init = block => { try { registerVariableToBlockly("bad", null); } catch {} return ""; };',
    ]) {
      const value = request('test_object_init("sensor", Sensor)');
      value.steps.push({ kind: 'script', label: 'unowned-registry-effect', source });
      await expectAsync(run(value)).toBeRejected();
    }
  });
});
