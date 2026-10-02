import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

describe('native cross-block dropdown dependencies', () => {
  const definitions = [
    { type: 'device_config', message0: 'device %1', args0: [{ type: 'field_input', name: 'NAME', text: 'Device' }], previousStatement: null, nextStatement: null },
    { type: 'device_use', message0: 'use %1', args0: [{ type: 'field_dropdown', name: 'DEVICE', options: [['Default', 'default']] }],
      previousStatement: null, nextStatement: null, extensions: ['device_options'] },
  ];
  const script = `
    function options() {
      return [['Default', 'default'], ...Blockly.getMainWorkspace().getAllBlocks(false)
        .filter(b => b.type === 'device_config').map(b => [b.getFieldValue('NAME'), b.getFieldValue('NAME')])];
    }
    Blockly.Extensions.register('device_options', function() {
      setTimeout(() => { this.getField('DEVICE').menuGenerator_ = options(); }, 50);
    });
    Arduino.forBlock.device_config = b => { Arduino.addObject(b.id, 'Device ' + b.getFieldValue('NAME') + ';'); return ''; };
    Arduino.forBlock.device_use = b => { Arduino.addSetup(b.id, b.getFieldValue('DEVICE') + '.begin();'); return ''; };
  `;
  const request = (source = script): NativeCandidateRequest => ({ blocks: [], steps: [
    { kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'unrelated-device-library', source },
    { kind: 'definitions', definitions },
  ] });
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent() {} });
  for (const reverse of [false, true]) {
    it('binds a whole ABS without splitting tool calls; reverse=' + reverse, async () => {
      const lines = ['device_config("Sensor")', 'device_use(Sensor)'];
      if (reverse) lines.reverse();
      const bound = await run({ ...request(), abs: '# ABS Schema: 2\n' + lines.join('\n') });
      expect(bound.state['blocks'].blocks.find((b: any) => b.type === 'device_use').fields.DEVICE).toBe('Sensor');
      expect(bound.binding!.instances.find(b => b.type === 'device_use')!.shape.fields['DEVICE'].options!.map(o => o[1])).toContain('Sensor');
    });
    it('restores the complete ABI with the same dependency boundary; reverse=' + reverse, async () => {
      const blocks = [{ id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } },
        { id: 'use', type: 'device_use', fields: { DEVICE: 'Sensor' } }];
      if (reverse) blocks.reverse();
      const state = { blocks: { languageVersion: 0, blocks } };
      const result = await run({ ...request(), verify: { state, contracts: { fields: {} } } });
      expect(result.state).toEqual(jasmine.objectContaining(state));
    });
  }
  it('keeps unknown options invalid after all initializers run', async () => {
    await expectAsync(run({ ...request(), abs: '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use(Missing)' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_FIELD_OPTION_INVALID' }));
  });
  it('does not turn a dropdown reference into a Blockly variable model', async () => {
    await expectAsync(run({ ...request(), abs: '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use($Sensor)' }))
      .toBeRejectedWithError(/variable reference/);
  });
  for (const mutation of [
    `Blockly.getMainWorkspace().getBlocksByType('device_config', false)[0].setFieldValue('Changed', 'NAME');`,
    `Blockly.getMainWorkspace().newBlock('device_config');`,
    `this.getField('DEVICE').setValidator(() => { Blockly.getMainWorkspace().getBlocksByType('device_config', false)[0].setFieldValue('Changed', 'NAME'); return 'Sensor'; });`,
  ]) it('does not hide other field/topology mutations during dependency preparation: ' + mutation, async () => {
    const source = script.replace('this.getField(\'DEVICE\').menuGenerator_ = options();', `this.getField('DEVICE').menuGenerator_ = options(); ${mutation}`);
    await expectAsync(run({ ...request(source), abs: '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use(Sensor)' }))
      .toBeRejectedWithError(/changed.*state|changed.*structure/);
  });
  it('keeps the finite callback budget instead of waiting for arbitrary asynchronous work', async () => {
    const source = script.replace('this.getField(\'DEVICE\').menuGenerator_ = options();', `function loop() { setTimeout(loop, 0); } loop();`);
    await expectAsync(run({ ...request(source), abs: '# ABS Schema: 2\ndevice_use(Sensor)' }))
      .toBeRejectedWithError(/finite callback/);
  });
});
