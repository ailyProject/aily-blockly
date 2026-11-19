import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { modelSteps } from './abs-native-models.fixture';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { indexAbsAbi } from './abs-abi-index';
import { dhtModelFixture } from './abs-native-dht-model.fixture';
import { spiModelFixture } from './abs-native-spi-model.fixture';
import { adoptAbsNativeModels, assertAbsNativeModelDeclarations } from './abs-native-model-declarations';

describe('native initializer model preparation', () => {
  const request = (abs: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + abs, steps: structuredClone(modelSteps), modelRequestId: 'native-model-test-namespace' });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('returns a bounded producer diagnostic for invalid native initializer registrations', async () => {
    for (const [name, reason] of [[null, 'invalid-type'], ['', 'empty-text'], ['private-payload'.repeat(1000), 'text-limit']] as const) {
      const value = request('test_object_init("sensor", Sensor)');
      value.steps.push({ kind: 'script', label: 'invalid-producer-value', source:
        `Arduino.forBlock.test_object_init = () => { registerVariableToBlockly(${JSON.stringify(name)}, 'Sensor'); return ''; };` });
      await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({
        code: 'ABS_MODEL_DECLARATION_INVALID',
        diagnostic: jasmine.objectContaining({ reason, field: 'name', blockType: 'test_object_init', phase: 'model-declaration' }),
      }));
    }
  });

  it('adopts more than 128 genuine native declarations without dropping producer identities', async () => {
    const value = request(Array.from({ length: 186 }, (_, i) => `test_object_init("sensor${i}", Sensor)`).join('\n'));
    const result = await run(value), declarations = result.binding!.modelDeclarations!;
    expect(declarations.length).toBe(186);
    const workspace: any = {};
    adoptAbsNativeModels(workspace, declarations);
    expect(workspace.variables).toEqual(result.state['variables']);
    await run({ blocks: [], steps: value.steps, verify: {
      state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: declarations.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
  });

  it('bounds whole-candidate declarations at 512 and still rejects duplicate names and identities', () => {
    const declarations = Array.from({ length: 513 }, (_, i) => ({ start: i, blockType: 'init_sensor',
      id: `model-${i}`, name: `sensor${i}`, type: 'Sensor' }));
    expect(() => assertAbsNativeModelDeclarations(declarations.slice(0, 512))).not.toThrow();
    expect(() => assertAbsNativeModelDeclarations(declarations)).toThrowError(/513.*512/);
    for (const changed of [{ name: 'SENSOR0' }, { id: 'model-0' }]) {
      const candidate = declarations.slice(0, 512);
      candidate[511] = { ...candidate[511], ...changed };
      expect(() => assertAbsNativeModelDeclarations(candidate)).toThrowError(/unique/);
    }
  });

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

  for (const source of [
    'variable_define("i")\ncontrols_for($i, null, null, null)',
    'controls_for($i, null, null, null)\nvariable_define("i")',
  ]) it('keeps loop identity bound to its producer when an ordinary declaration reuses it: ' + source, async () => {
    const value = request(source);
    value.steps = [{ kind: 'context', mode: 'arduino' }, { kind: 'definitions', definitions: [
      { type: 'variable_define', message0: '%1', args0: [{ type: 'field_input', name: 'NAME', text: 'i' }],
        previousStatement: null, nextStatement: null },
      { type: 'controls_for', message0: '%1 %2 %3 %4 %5', args0: [
        { type: 'field_variable', name: 'VAR' }, ...['FROM', 'TO', 'BY'].map(name => ({ type: 'input_value', name })),
        { type: 'input_statement', name: 'DO' },
      ], previousStatement: null, nextStatement: null },
    ] }, { kind: 'script', label: 'ordinary-and-loop-declarations', source: `
      function registerVariableToBlockly(name, type) { Blockly.getMainWorkspace().createVariable(name, type); }
      Arduino.forBlock.variable_define = block => { registerVariableToBlockly(block.getFieldValue('NAME'), ''); return ''; };
      Arduino.forBlock.controls_for = () => '';
    ` }];
    const result = await run(value), declarations = result.binding!.modelDeclarations!;
    expect(declarations.length).toBe(1);
    const effect = declarations[0], start = value.abs!.indexOf('controls_for');
    expect(effect).toEqual(jasmine.objectContaining({ start, blockType: 'controls_for', kind: 'loop', name: 'i', type: '' }));
    expect(effect.id).toBe(`abs-model:${value.modelRequestId}:${start}:0`);
    const replay = await run({ ...value, variables: result.state['variables'],
      identities: result.binding!.instances.map(item => ({ start: item.start, id: 'owned-' + item.start })), creations: [] });
    expect(replay.binding!.modelDeclarations).toEqual(declarations);
    const verify = { state: normalizeAbsSerializedWorkspace(replay.state),
      contracts: { fields: Object.fromEntries(replay.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: [{ ...effect, ownerId: 'owned-' + start }] };
    await run({ blocks: [], steps: value.steps, verify });
    await expectAsync(run({ ...value, abs: value.abs + '\nvariable_define("i")' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
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

  for (const receiver of ['window', 'Arduino']) it('owns the registration helper on ' + receiver + ' and preserves its receiver', async () => {
    const value = request('helper_read($sensor)\nhelper_init("sensor")');
    value.steps = [{ kind: 'context', mode: 'arduino' }, { kind: 'definitions', definitions: [
      { type: 'helper_init', message0: '%1', args0: [{ type: 'field_input', name: 'NAME', text: 'sensor' }], previousStatement: null, nextStatement: null },
      { type: 'helper_read', message0: '%1', args0: [{ type: 'field_variable', name: 'VAR', variableTypes: ['Sensor'], defaultType: 'Sensor' }], output: 'Number' },
    ] }, { kind: 'script', label: 'receiver-registration', source: `
      delete window.registerVariableToBlockly;
      ${receiver}.registerVariableToBlockly = function(name, type) {
        if (this !== ${receiver}) throw new Error('Registration helper receiver changed');
        Blockly.getMainWorkspace().createVariable(name, type);
      };
      Arduino.forBlock.helper_init = block => { ${receiver}.registerVariableToBlockly(block.getFieldValue('NAME'), 'Sensor'); return ''; };
      Arduino.forBlock.helper_read = block => [block.getField('VAR').getVariable().name + '.read()', 0];
    ` }];
    const result = await run(value), effect = result.binding!.modelDeclarations![0];
    expect(effect).toEqual(jasmine.objectContaining({ name: 'sensor', type: 'Sensor', blockType: 'helper_init' }));
    await run({ blocks: [], steps: value.steps, verify: { state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: [{ ...effect, ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id }] } });
    for (const target of ['window', 'Arduino']) {
      const changed = { ...value, steps: [...value.steps, { kind: 'script' as const, label: 'replace-helper',
        source: `Arduino.forBlock.helper_init = block => { ${target}.registerVariableToBlockly = () => {}; return ''; };` }] };
      await expectAsync(run(changed)).toBeRejectedWithError(/replaced the model registration boundary/);
    }
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
  it('keeps an enabled next statement active after a disabled sibling', async () => {
    const result = await run(request('test_object_init("ignored", Sensor) @disabled\n    @next:\n        test_object_init("active", Sensor)\ntest_object_read($active)'));
    expect(result.binding!.modelDeclarations!.map(item => item.name)).toEqual(['active']);
  });
  it('honors disabled producers during recursive native generation without disabling their next sibling', async () => {
    const value = request('model_scope()\n    test_object_init("ignored", Sensor) @disabled\n    test_object_init("active", Sensor)\ntest_object_read($active)');
    value.steps.push({ kind: 'definitions', definitions: [{ type: 'model_scope', message0: '%1',
      args0: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null,
    }] }, { kind: 'script', label: 'recursive-model-scope', source: `
      Arduino.forBlock.model_scope = (block, generator) => generator.statementToCode(block, 'DO');
    ` });
    const result = await run(value), declarations = result.binding!.modelDeclarations!;
    expect(declarations.map(item => item.name)).toEqual(['active']);
    const ignored = result.binding!.instances.find(item => item.seed.fields?.['NAME'] === 'ignored')!;
    expect(ignored.seed['disabledReasons']).toBeUndefined();
    const state = normalizeAbsSerializedWorkspace(result.state);
    // Reconciliation owns persisted reasons; shape discovery must not invent them.
    indexAbsAbi(state).get(ignored.id)!['disabledReasons'] = ['MANUALLY_DISABLED', 'LIBRARY_DISABLED'];
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    const verified = await run({ blocks: [], steps: value.steps, verify: { state, contracts,
      modelDeclarations: declarations.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
    expect(indexAbsAbi(normalizeAbsSerializedWorkspace(verified.state)).get(ignored.id)!['disabledReasons'])
      .toEqual(['MANUALLY_DISABLED', 'LIBRARY_DISABLED']);
  });
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
  for (const reverse of [false, true]) it('reuses exact typed identities regardless of same-name model order: ' + reverse, async () => {
    const value = request('test_object_read($sensor)\ntest_object_init("sensor", Sensor)\ntest_object_init("sensor", Other)');
    value.variables = [
      { id: 'preserved-function', name: 'sensor', type: 'FUNC' },
      { id: 'preserved-sensor', name: 'sensor', type: 'Sensor' },
      { id: 'preserved-other', name: 'sensor', type: 'Other' },
      { id: 'other-page', name: 'shared', type: 'Shared' },
    ];
    if (reverse) value.variables.reverse();
    const result = await run(value), effects = result.binding!.modelDeclarations!;
    expect(effects.map(item => item.id)).toEqual(['preserved-sensor', 'preserved-other']);
    expect(result.state['variables']).toEqual(value.variables);
    const state = normalizeAbsSerializedWorkspace(result.state);
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    await run({ blocks: [], steps: value.steps, verify: { state, contracts,
      modelDeclarations: effects.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
    await expectAsync(run({ ...value, abs: value.abs!.replace('"sensor", Sensor', '"SENSOR", Sensor') }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
  });

  it('adopts by exact identity without retyping or authorizing fresh same-name typed models', () => {
    const variables = [{ id: 'function', name: 'sensor', type: 'FUNC' },
      { id: 'sensor', name: 'sensor', type: 'TASK' }];
    const declaration = { start: 0, blockType: 'test_task_init', id: 'sensor', name: 'sensor', type: 'TASK' };
    const workspace: any = { variables: structuredClone(variables) };
    adoptAbsNativeModels(workspace, [declaration]);
    expect(workspace.variables).toEqual(variables);
    for (const changed of [{ id: 'new-id' }, { type: 'FUNC' }, { name: 'renamed' }, { name: 'SENSOR' }]) {
      expect(() => adoptAbsNativeModels(workspace, [{ ...declaration, ...changed }]))
        .toThrow(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
      expect(workspace.variables).toEqual(variables);
    }
    expect(() => adoptAbsNativeModels(workspace, [{ ...declaration, id: 'new-kind', type: 'Other' }]))
      .toThrow(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
    const fresh: any = {};
    expect(() => adoptAbsNativeModels(fresh, [declaration, { ...declaration, start: 1, id: 'other-id', type: 'Other' }]))
      .toThrow(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
    expect(fresh.variables).toBeUndefined();
  });
  it('does not let a prepared producer add an unproved registration in another existing type namespace', async () => {
    const value = request('test_object_init("sensor", Sensor)');
    value.variables = [{ id: 'sensor', name: 'sensor', type: 'Sensor' }, { id: 'other', name: 'sensor', type: 'Other' }];
    const result = await run(value), effect = result.binding!.modelDeclarations![0];
    const contracts = { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) };
    value.steps.push({ kind: 'script', label: 'changed-model-registration', source: `
      Arduino.forBlock.test_object_init = block => {
        registerVariableToBlockly('sensor', 'Sensor'); registerVariableToBlockly('sensor', 'Other'); return '';
      };
    ` });
    await expectAsync(run({ blocks: [], steps: value.steps, verify: { state: normalizeAbsSerializedWorkspace(result.state), contracts,
      modelDeclarations: [{ ...effect, ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id }] } }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CHANGED' }));
  });
  it('prepares multiple independent objects and rejects unowned generator side effects', async () => {
    const value = request('test_object_read($a)\ntest_object_read($b)\ntest_object_init("a", Sensor)\ntest_object_init("b", Sensor)');
    expect((await run(value)).binding!.modelDeclarations!.map(item => item.name)).toEqual(['a', 'b']);
    value.steps.push({ kind: 'script', label: 'unowned-side-effect', source: 'Arduino.forBlock.test_object_init = block => { block.workspace.createVariable("leaked", "Sensor"); return ""; };' });
    await expectAsync(run(value)).toBeRejectedWithError(/unrequested blocks or models/);
  });
  it('retains repeated committed registrations without accepting new duplicate producers or type changes', async () => {
    const value = request('test_object_init("sensor", Sensor)\ntest_object_init("sensor", Sensor)\ntest_object_read($sensor)');
    value.variables = [{ id: 'existing', name: 'sensor', type: 'Sensor' }];
    value.retainedModelIds = ['existing'];
    value.retainedModelCalls = [value.abs!.indexOf('test_object_init'), value.abs!.indexOf('test_object_init', value.abs!.indexOf('test_object_init') + 1)];
    const result = await run(value);
    expect(result.binding!.modelDeclarations).toBeUndefined();
    expect(result.state['variables']).toEqual(value.variables);
    value.retainedModelCalls = [value.retainedModelCalls[0]];
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_MODEL_DECLARATION_CONFLICT' }));
    value.retainedModelCalls = [value.abs!.indexOf('test_object_init'), value.abs!.indexOf('test_object_init', value.abs!.indexOf('test_object_init') + 1)];
    value.variables[0].type = 'Other';
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_TYPE_MISMATCH' }));
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
