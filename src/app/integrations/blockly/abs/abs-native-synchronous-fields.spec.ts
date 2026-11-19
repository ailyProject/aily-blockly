import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { u8g2InitFixture } from './abs-native-u8g2-init.fixture';
import { modelSteps } from './abs-native-models.fixture';

describe('native synchronous field configuration', () => {
  const generic: NativeCandidateRequest['steps'] = [
    { kind: 'context', mode: 'arduino' },
    { kind: 'script', label: 'unknown-synchronous-library', source: `
      Blockly.Extensions.register('sync_shape', function() {
        this.pins = mode => {
          if (this.getInput('PINS')) this.removeInput('PINS');
          const row = this.appendDummyInput('PINS');
          for (const name of mode === 'SW' ? ['CLOCK', 'DATA'] : ['CLOCK']) {
            let writes = 0;
            row.appendField(new Blockly.FieldTextInput('13', value => {
              if (++writes > 1) throw Error('Unchanged field instance was loaded twice');
              return value;
            }), name);
          }
        };
        this.family = value => {
          if (this.getInput('MODE')) this.removeInput('MODE');
          this.appendDummyInput('MODE').appendField(new Blockly.FieldDropdown([['HW','HW'],['SW','SW']], mode => {
            this.pins(mode); return mode;
          }), 'MODE');
          this.pins('HW');
        };
        this.getField('FAMILY').setValidator(value => { this.family(value); return value; });
        this.family(this.getFieldValue('FAMILY'));
      });
      Arduino.forBlock.sync_device = () => '';
    ` },
    { kind: 'definitions', definitions: [{ type: 'sync_device', message0: '%1',
      args0: [{ type: 'field_dropdown', name: 'FAMILY', options: [['A','A'],['B','B']] }],
      extensions: ['sync_shape'], previousStatement: null, nextStatement: null }] },
  ];
  const run = (request: NativeCandidateRequest) => evaluateNativeCandidate(request, { assertCurrent() {} });
  const base = (abs: string): NativeCandidateRequest => ({ blocks: [], steps: generic, abs: '# ABS Schema: 2\n' + abs });

  for (const abs of [
    'sync_device(DATA=8, CLOCK=9, MODE=SW, FAMILY=B)',
    'sync_device(CLOCK=9, FAMILY=B, MODE=SW, DATA=8)',
    'sync_device(B, SW, 9, 8)',
  ]) it('settles supplied fields against their final actual instances: ' + abs, async () => {
    const bound = await run(base(abs));
    expect(bound.state['blocks'].blocks[0].fields).toEqual({ FAMILY: 'B', MODE: 'SW', CLOCK: '9', DATA: '8' });
    const verify = { state: normalizeAbsSerializedWorkspace(bound.state),
      contracts: { fields: Object.fromEntries(bound.binding!.instances.map(item => [item.id, item.shape.fields])) } };
    const copy = JSON.stringify(verify.state);
    for (let iteration = 0; iteration < 2; iteration++) {
      expect((await run({ blocks: [], steps: generic, verify })).state).toEqual(jasmine.objectContaining(verify.state));
    }
    expect(JSON.stringify(verify.state)).toBe(copy);
  });

  for (const abs of ['sync_device(FAMILY=B, MODE=HW, DATA=8)', 'sync_device(FAMILY=B, MODE=UNKNOWN)',
    'sync_device(FAMILY=B, CLOCK=9, CLOCK=8)']) it('still rejects unavailable, invalid or duplicate fields: ' + abs, async () => {
    await expectAsync(run(base(abs))).toBeRejected();
  });

  for (const family of ['A', 'B']) for (const mode of ['HW', 'SW']) {
    it(`keeps the selected ${family}/${mode} shape without inventing missing pins`, async () => {
      const bound = await run(base(`sync_device(CLOCK=9, ${mode === 'SW' ? 'DATA=8, ' : ''}MODE=${mode}, FAMILY=${family})`));
      const fields = bound.state['blocks'].blocks[0].fields;
      expect(fields).toEqual({ FAMILY: family, MODE: mode, CLOCK: '9', ...(mode === 'SW' ? { DATA: '8' } : {}) });
    });
  }

  it('does not treat disabled syntax or diagnostic operations as permission to ignore illegal fields', async () => {
    await expectAsync(run(base('sync_device(FAMILY=B, MODE=HW, DATA=8) @disabled'))).toBeRejected();
    await expectAsync(run({ steps: generic, blocks: [{ id: 'duplicate', type: 'sync_device',
      fields: [{ name: 'CLOCK', value: '9' }, { name: 'CLOCK', value: '8' }] }] })).toBeRejected();
  });

  it('retains disabled reasons, collapse and protection through repeated full ABI verification', async () => {
    const bound = await run(base('sync_device(DATA=8, CLOCK=9, MODE=SW, FAMILY=B) @disabled'));
    const state = normalizeAbsSerializedWorkspace(bound.state);
    Object.assign(state.blocks.blocks[0], { disabledReasons: ['MANUALLY_DISABLED', 'USER_RULE'],
      collapsed: true, deletable: false, editable: false, movable: false });
    const original = JSON.stringify(state);
    const contracts = { fields: Object.fromEntries(bound.binding!.instances.map(item => [item.id, item.shape.fields])) };
    for (let iteration = 0; iteration < 2; iteration++) {
      const verified = await run({ steps: generic, blocks: [], verify: { state, contracts } });
      expect(verified.state['blocks'].blocks[0]).toEqual(jasmine.objectContaining(state.blocks.blocks[0]));
    }
    expect(JSON.stringify(state)).toBe(original);
  });

  it('rejects cyclic field replacement within a finite construction budget', async () => {
    const steps: NativeCandidateRequest['steps'] = [generic[0], { kind: 'script', label: 'cyclic-synchronous-shape', source: `
      Blockly.Blocks.cyclic_selector = { init() {
        const replace = (name, other) => {
          if (this.getInput(name)) this.removeInput(name);
          this.appendDummyInput(name).appendField(new Blockly.FieldTextInput('0', value => {
            replace(other, name); return value;
          }), name);
        };
        replace('LEFT', 'RIGHT'); replace('RIGHT', 'LEFT');
      } };
      Arduino.forBlock.cyclic_selector = () => '';
    ` }];
    await expectAsync(run({ steps, blocks: [], abs: '# ABS Schema: 2\ncyclic_selector(LEFT=1, RIGHT=2)' }))
      .toBeRejectedWithError(/Native field configuration did not stabilize/);
  });

  it('still rejects a selector overwriting an already configured unchanged field instance', async () => {
    const steps: NativeCandidateRequest['steps'] = [generic[0], { kind: 'script', label: 'in-place-overwrite', source: `
      Blockly.Blocks.in_place_selector = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldTextInput('13'), 'CLOCK')
          .appendField(new Blockly.FieldDropdown([['A','A'],['B','B']], value => {
            this.setFieldValue('13', 'CLOCK'); return value;
          }), 'MODE');
      } };
      Arduino.forBlock.in_place_selector = () => '';
    ` }];
    await expectAsync(run({ steps, blocks: [], abs: '# ABS Schema: 2\nin_place_selector(CLOCK=9, MODE=B)' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_CONFIGURATION_CONFLICT' }));
  });

  const modelSelector = (abs: string, initialPin = false, resetInPlace = false): NativeCandidateRequest => ({
    blocks: [], modelRequestId: 'synchronous-selector-model', abs: '# ABS Schema: 2\n' + abs,
    steps: [...modelSteps, { kind: 'script', label: 'model-synchronous-selector', source: `
      Blockly.Blocks.model_selector = { init() {
        const pin = () => {
          if (${resetInPlace} && this.getField('PIN')) { this.setFieldValue('13', 'PIN'); return; }
          if (this.getInput('PINS')) this.removeInput('PINS');
          this.appendDummyInput('PINS').appendField(new Blockly.FieldTextInput('13'), 'PIN');
        };
        const object = new Blockly.FieldVariable('sensor', undefined, ['Sensor'], 'Sensor');
        const load = object.loadState;
        object.loadState = function(value) { load.call(this, value); pin(); };
        this.appendDummyInput().appendField(object, 'OBJECT');
        if (${initialPin}) pin();
      } };
      Arduino.forBlock.model_selector = () => '';
    ` }],
  });
  for (const initialPin of [false, true]) it('settles synchronous fields after a missing model becomes available; initialPin=' + initialPin, async () => {
    const request = modelSelector('test_object_init("device", Sensor)\nmodel_selector(OBJECT=$device, PIN=9)', initialPin);
    const result = await run(request);
    expect(result.state['blocks'].blocks[1].fields).toEqual({
      OBJECT: { id: result.binding!.modelDeclarations![0].id }, PIN: '9',
    });
    expect(result.binding!.modelDeclarations!.map(item => item.name)).toEqual(['device']);
    await run({ blocks: [], steps: request.steps, verify: {
      state: normalizeAbsSerializedWorkspace(result.state),
      contracts: { fields: Object.fromEntries(result.binding!.instances.map(item => [item.id, item.shape.fields])) },
      modelDeclarations: result.binding!.modelDeclarations!.map(effect => ({ ...effect,
        ownerId: result.binding!.instances.find(item => item.start === effect.start)!.id })),
    } });
  });

  it('keeps a truly missing model as the primary error rather than its not-yet-created fields', async () => {
    await expectAsync(run(modelSelector('model_selector(PIN=9, OBJECT=$missing)')))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_SYMBOL_MISSING',
        diagnostic: jasmine.objectContaining({ blockType: 'model_selector', field: 'OBJECT' }) }));
  });

  it('rejects a still-unavailable field after the model selector settles', async () => {
    await expectAsync(run(modelSelector('test_object_init("device", Sensor)\nmodel_selector(GHOST=9, OBJECT=$device)')))
      .toBeRejectedWithError(/Native field is unavailable: GHOST/);
  });

  it('does not replay a same-instance reset when a model selector becomes available', async () => {
    await expectAsync(run(modelSelector('test_object_init("device", Sensor)\nmodel_selector(PIN=9, OBJECT=$device)', true, true)))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_CONFIGURATION_CONFLICT' }));
  });

  const u8g2 = (abs: string): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + abs, steps: [
    { kind: 'context', mode: 'arduino', boardConfig: { core: 'esp32:esp32' } },
    { kind: 'script', label: 'actual-U8G2-initializer', source: u8g2InitFixture.source },
    { kind: 'definitions', definitions: u8g2InitFixture.blocks },
  ] });
  for (const abs of [
    'u8g2_begin(TYPE=SSD1306, MODE=FULL_BUFFER, RESOLUTION=128X64_NONAME, CLOCK_PIN=9, DATA_PIN=8, RESET_PIN=U8X8_PIN_NONE, PROTOCOL=_SW_I2C)',
    'u8g2_begin(SCL_PIN=9, SDA_PIN=8, RESET_PIN=U8X8_PIN_NONE, TYPE=SSD1306, MODE=FULL_BUFFER, RESOLUTION=128X64_NONAME, PROTOCOL=_HW_I2C)',
    'u8g2_begin(SSD1306, FULL_BUFFER, 128X64_NONAME, _SW_I2C, 9, 8, U8X8_PIN_NONE)',
  ]) it('preserves explicit pins through actual U8G2 synchronous shape changes: ' + abs, async () => {
    const request = u8g2(abs), bound = await run(request);
    const fields = bound.state['blocks'].blocks[0].fields;
    if (fields.PROTOCOL === '_SW_I2C') expect(fields).toEqual(jasmine.objectContaining({ CLOCK_PIN: '9', DATA_PIN: '8' }));
    else expect(fields).toEqual(jasmine.objectContaining({ SCL_PIN: '9', SDA_PIN: '8' }));
    await run({ blocks: [], steps: request.steps, verify: { state: normalizeAbsSerializedWorkspace(bound.state),
      contracts: { fields: Object.fromEntries(bound.binding!.instances.map(item => [item.id, item.shape.fields])) } } });
  });
});
