import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { bindAbsSyntax } from './abs-syntax-binding';
import { readAbsSyntax } from './abs-syntax';
import { parseBlockDefinition } from './block-definition.model';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { fieldShapeLibraryFixtures } from './abs-library-field-shape.fixture';
import { nativeHardwareFixtures } from './abs-native-hardware.fixture';

describe('native ABS position binding', () => {
  const number = { type: 'math_number', message0: '%1', args0: [{ type: 'field_number', name: 'NUM', value: 0 }], output: 'Number' };
  const definition = { type: 'native_order', message0: '%3 %1 %2', args0: [
    { type: 'field_dropdown', name: 'MODE', options: [['A', 'A'], ['B', 'B']] },
    { type: 'input_value', name: 'VALUE', check: 'Number' },
    { type: 'field_dropdown', name: 'TYPE', options: [['int', 'int'], ['float', 'float']] },
  ], extensions: ['native_order_shape'], previousStatement: null, nextStatement: null };
  const source = `Blockly.Extensions.register('native_order_shape', function() {
    this.getField('MODE').setValidator(mode => {
      if (this.getInput('MORE')) this.removeInput('MORE');
      if (mode === 'B') this.appendValueInput('MORE').setCheck('Number');
      return mode;
    });
  });`;
  const request = (abs: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + abs,
    steps: [{ kind: 'script', label: 'unknown-native-extension', source }, { kind: 'definitions', definitions: [definition, number] }] });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent: () => {} });
  afterEach(() => expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0));

  it('transports actionable field options and source locations out of the real isolated realm', async () => {
    const value = request('native_order(INVALID, 1, int)');
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_FIELD_OPTION_INVALID', range: { start: value.abs!.indexOf('INVALID'), end: value.abs!.indexOf('INVALID') + 7 },
      diagnostic: jasmine.objectContaining({ blockType: 'native_order', field: 'MODE', received: 'INVALID', allowedValues: ['A', 'B'] }),
    }));
  });

  it('returns a typed variable correction on the first failed reference binding', async () => {
    const value = request('sensor_read($sensor)');
    value.steps = [{ kind: 'definitions', definitions: [{ type: 'sensor_read', message0: '%1',
      args0: [{ type: 'field_variable', name: 'VAR', variableTypes: ['SENSOR'], defaultType: 'SENSOR' }], output: 'Number' }] }];
    value.variables = [{ id: 'owned', name: 'sensor', type: '' }];
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_TYPE_MISMATCH',
      diagnostic: jasmine.objectContaining({ blockType: 'sensor_read', field: 'VAR', modelName: 'sensor', expectedTypes: ['SENSOR'], actualTypes: [''] }) }));
  });

  it('retains source args order despite visual order and binds each native instance independently', async () => {
    const result = await run(request('native_order(B, math_number(3), int, 8)\nnative_order(A, 4, float)\n'));
    const roots = result.state['blocks'].blocks;
    expect(roots.length).toBe(2);
    expect(roots[0].fields).toEqual({ MODE: 'B', TYPE: 'int' });
    expect(roots[0].inputs.VALUE.block.fields.NUM).toBe(3);
    expect(roots[0].inputs.MORE.block.fields.NUM).toBe(8);
    expect(roots[1].fields).toEqual({ MODE: 'A', TYPE: 'float' });
    expect(roots[1].inputs.VALUE.block.fields.NUM).toBe(4);
    expect(roots[1].inputs.MORE).toBeUndefined();
  });

  it('accepts bare multiword dropdown values with the same native validation as quoted values', async () => {
    const value = request('native_order(A, 1, unsigned long)');
    const definitions = structuredClone([definition, number]);
    (definitions[0].args0[2] as any).options.push(['long', 'unsigned long']);
    value.steps[1] = { kind: 'definitions', definitions };
    const bare = await run(value);
    expect(bare.state['blocks'].blocks[0].fields.TYPE).toBe('unsigned long');
    value.abs = value.abs!.replace('unsigned long', '"unsigned long"');
    expect((await run(value)).state['blocks'].blocks[0].fields.TYPE).toBe('unsigned long');
    value.abs = value.abs!.replace('"unsigned long"', 'unsigned unknown');
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_FIELD_OPTION_INVALID' }));
  });

  it('reports all typed-reference collisions with unoccupied suggestions in one isolated pass', async () => {
    const value = request('sensor_read($sensor)\nsensor_read($probe)');
    value.steps = [{ kind: 'definitions', definitions: [{ type: 'sensor_read', message0: '%1',
      args0: [{ type: 'field_variable', name: 'VAR', variableTypes: ['SENSOR'], defaultType: 'SENSOR' }], output: 'Number' }] }];
    value.variables = [{ id: 'a', name: 'sensor', type: '' }, { id: 'b', name: 'probe', type: 'OLD' },
      { id: 'c', name: 'SENSOR_2', type: '' }];
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_TYPE_MISMATCH',
      diagnostic: jasmine.objectContaining({ conflicts: [
        jasmine.objectContaining({ modelName: 'sensor', availableName: 'sensor_3', actualTypes: [''] }),
        jasmine.objectContaining({ modelName: 'probe', availableName: 'probe_2', actualTypes: ['OLD'] }),
      ] }) }));
  });

  it('connects statement sections and next chains through the native checker', async () => {
    const value = request('native_order(A, null, int)\n    @next:\n        native_order(A, 2, float)\n        native_order(B, 3, int, null)\n');
    const result = await run(value), root = result.state['blocks'].blocks[0];
    expect(result.state['blocks'].blocks.length).toBe(1);
    expect(root.next.block.inputs.VALUE.block.fields.NUM).toBe(2);
    expect(root.next.block.next.block.fields.MODE).toBe('B');
  });

  it('binds bundled variadic shorthand in the native candidate without per-library names', async () => {
    const value = request('renamed_join(ADD0=1, ADD1=2, ADD2=3)\nrenamed_if(1, 0)\n    @DO1:\n    @ELSE:');
    value.steps = [{ kind: 'definitions', definitions: [number,
      { type: 'renamed_join', message0: '', args0: [], mutator: 'text_join_mutator', output: null },
      { type: 'renamed_if', message0: '%1 %2', args0: [{ type: 'input_value', name: 'IF0' },
        { type: 'input_statement', name: 'DO0' }], mutator: 'controls_if_mutator', previousStatement: null, nextStatement: null },
    ] }];
    const result = await run(value), [join, conditional] = result.state['blocks'].blocks;
    expect(join.extraState).toEqual({ itemCount: 3 });
    expect(join.inputs.ADD2.block.fields.NUM).toBe(3);
    expect(conditional.extraState).toEqual({ elseIfCount: 1, hasElse: true });
    expect(conditional.inputs.IF1.block.fields.NUM).toBe(0);
    value.abs = '# ABS Schema: 2\nrenamed_join(ADD2=3)';
    await expectAsync(run(value)).toBeRejectedWithError(/contiguous/);
  });

  it('uses the README substring order in all nine real native selector combinations', async () => {
    const fixture = fieldShapeLibraryFixtures['core-text'];
    const calls: string[] = [], variants: Array<[string, string]> = [];
    for (const first of ['FROM_START', 'FROM_END', 'FIRST']) for (const last of ['FROM_START', 'FROM_END', 'LAST']) {
      variants.push([first, last]);
      calls.push(`tt_getSubstring(text("abcdef"), ${first}, ${last}${first === 'FIRST' ? '' : ', 1'}${last === 'LAST' ? '' : ', 3'})`);
    }
    const value = request(calls.join('\n'));
    value.steps = [{ kind: 'script', label: 'core-text/generator.js', source: fixture.source },
      { kind: 'definitions', definitions: [...fixture.blocks, number,
        { type: 'text', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: 'String' }] }];
    const result = await run(value);
    for (const [i, block] of result.state['blocks'].blocks.entries()) {
      const [first, last] = variants[i];
      expect(block.fields).toEqual({ WHERE1: first, WHERE2: last });
      expect(block.inputs.STRING.block.fields.TEXT).toBe('abcdef');
      expect(block.inputs.AT1_VALUE?.block.fields.NUM).toBe(first === 'FIRST' ? undefined : 1);
      expect(block.inputs.AT2_VALUE?.block.fields.NUM).toBe(last === 'LAST' ? undefined : 3);
    }
    expect(result.state['blocks'].blocks.length).toBe(variants.length);
  });

  it('binds README numeric pins and named software SPI fields against actual board options', async () => {
    const pins = ['2', '15', '18', '23', '19'].map(pin => [pin, pin]);
    const value = request('dht_init("dht", DHT11, 2)\nmax31865_init("rtd", SW, 15, MAX31865_3WIRE, SW_SCK_PIN=18, SW_MOSI_PIN=23, SW_MISO_PIN=19)');
    value.variables = [{ id: 'dht-model', name: 'dht', type: 'DHT' }, { id: 'rtd-model', name: 'rtd', type: 'Adafruit_MAX31865' }];
    value.steps = [{ kind: 'context', boardConfig: { digitalPins: pins, i2c: [['Wire', 'Wire']] } },
      ...Object.values(nativeHardwareFixtures).map(fixture => ({ kind: 'script' as const, label: 'hardware-readme', source: fixture.source })),
      { kind: 'definitions', definitions: Object.values(nativeHardwareFixtures).flatMap(fixture =>
        JSON.parse(JSON.stringify(fixture.blocks).replaceAll('"${board.digitalPins}"', JSON.stringify(pins)))) }];
    const [dht, rtd] = (await run(value)).state['blocks'].blocks;
    expect(dht.fields.PIN).toBe('2');
    expect(rtd.fields).toEqual(jasmine.objectContaining({ SPI_MODE: 'SW', CS_PIN: '15', WIRES: 'MAX31865_3WIRE',
      SW_SCK_PIN: '18', SW_MOSI_PIN: '23', SW_MISO_PIN: '19' }));
    value.abs = value.abs!.replace('DHT11, 2', 'DHT11, 99');
    await expectAsync(run(value)).toBeRejectedWithError(/Invalid dropdown/);
  });

  it('captures original argsN when a JS-defined block invokes jsonInit directly', async () => {
    const value = request('native_order(B, math_number(3), int, 8)');
    value.steps[1] = { kind: 'definitions', definitions: [number] };
    value.steps.push({ kind: 'script', label: 'direct-json-init', source: `
      Blockly.Blocks.native_order = { init() { this.jsonInit(${JSON.stringify(definition)}); } };
    ` });
    const root = (await run(value)).state['blocks'].blocks[0];
    expect(root.fields).toEqual({ MODE: 'B', TYPE: 'int' });
    expect(root.inputs.VALUE.block.fields.NUM).toBe(3);
    expect(root.inputs.MORE.block.fields.NUM).toBe(8);
  });

  it('rejects unavailable parameters and incompatible native connections', async () => {
    await expectAsync(run(request('native_order(A, 1, int, 9)'))).toBeRejectedWithError(/No positional/);
    const value = request('native_order(A, math_number(1), int)');
    value.steps.push({ kind: 'script', label: 'connection-check', source: `
      const init = Blockly.Blocks.native_order.init;
      Blockly.Blocks.native_order.init = function() { init.call(this); this.getInput('VALUE').setCheck('String'); };
    ` });
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_CONNECTION_INCOMPATIBLE',
      range: { start: value.abs!.indexOf('math_number'), end: value.abs!.indexOf('math_number') + 'math_number(1)'.length },
      diagnostic: jasmine.objectContaining({ blockType: 'math_number', parentBlockType: 'native_order', field: 'VALUE',
        expectedTypes: ['String'], actualTypes: ['Number'] }),
    }));
  });

  it('explains that a hat block cannot be nested in a next chain', async () => {
    const value = request('native_order(A, 1, int)\n    @next:\n        event_hat()');
    value.steps.push({ kind: 'definitions', definitions: [{ type: 'event_hat', message0: 'event', args0: [] }] });
    await expectAsync(run(value)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CONNECTION_INCOMPATIBLE',
      diagnostic: jasmine.objectContaining({ blockType: 'event_hat', parentBlockType: 'native_order', field: 'next',
        reason: 'missing-previous-connection', hint: jasmine.stringMatching(/top level/) }) }));
  });

  it('rejects a later field callback discarding an already requested child', async () => {
    const value = request('native_order(A, 1, float)');
    value.steps.push({ kind: 'script', label: 'destructive-selector', source: `
      const init = Blockly.Blocks.native_order.init;
      Blockly.Blocks.native_order.init = function() { init.call(this); this.getField('TYPE').setValidator(type => {
        if (type === 'float') this.getInput('VALUE').connection.disconnect(); return type;
      }); };
    ` });
    await expectAsync(run(value)).toBeRejectedWithError(/overwrote connection/);
  });

  it('binds disabled syntax without inventing persisted reasons and keeps model ownership gated', async () => {
    const disabled = await run(request('native_order(A, 1, int) @disabled'));
    expect(disabled.binding!.syntax[0].disabled).toBeTrue();
    expect(disabled.state['blocks'].blocks[0].disabledReasons).toBeUndefined();
    const value = request('variables_get($counter)');
    await expectAsync(run(value)).toBeRejectedWithError(/Cannot uniquely resolve variable/);
    const mixed = request('math_number(1)'); mixed.blocks = [{ id: 'mixed', type: 'math_number', fields: [] }];
    await expectAsync(run(mixed)).toBeRejectedWithError(/not both/);
  });

  it('reads unknown shapes without contracts and permits independent rebinding without mutating the raw AST', () => {
    const raw = readAbsSyntax('# ABS Schema: 2\nunknown(7, int)');
    const snapshot = JSON.stringify(raw);
    for (const names of [['VALUE', 'TYPE'], ['COUNT', 'KIND']]) {
      const bound = bindAbsSyntax(raw, { argumentOrder: () => names.map(name => ({ name, kind: 'field' })) });
      expect(bound[0].fields[names[0]].value).toBe(7);
      expect(bound[0].fields[names[1]].value).toBe('int');
    }
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('does not construct native instances until the whole source passes grammar parsing', () => {
    const create = jasmine.createSpy('create');
    expect(() => bindAbsSyntax(readAbsSyntax('# ABS Schema: 2\nmath_number(1)\nmath_number('), {}, create)).toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves bare variable value expansion and direct dropdown references in the shared binder', () => {
    const defs = new Map([number, { type: 'variables_get', args0: [{ type: 'field_variable', name: 'VAR' }] },
      { type: 'consumer', args0: [{ type: 'field_variable', name: 'TARGET' }, { type: 'input_value', name: 'VALUE' }] }]
      .map(json => [json.type, parseBlockDefinition(json, '')!]));
    const result = bindAbsSyntax(readAbsSyntax('# ABS Schema: 2\nconsumer($counter, $counter)'), {
      argumentOrder: type => defs.get(type)?.argsOrder,
      fieldDefinition: (type, name) => defs.get(type)?.fieldDefinitions?.get(name),
    });
    expect(result[0].fields['TARGET'].reference).toBe('variable');
    expect(result[0].inputs['VALUE']?.type).toBe('variables_get');
    expect(result[0].inputs['VALUE']?.fields['VAR'].reference).toBe('variable');
  });
});
