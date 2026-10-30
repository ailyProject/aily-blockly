import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

describe('native cross-block dropdown dependencies', () => {
  const definitions = [
    { type: 'device_config', message0: 'device %1', args0: [{ type: 'field_input', name: 'NAME', text: 'Device' }], previousStatement: null, nextStatement: null },
    { type: 'device_use', message0: 'use %1', args0: [{ type: 'field_dropdown', name: 'DEVICE', options: [['Default', 'default']] }],
      previousStatement: null, nextStatement: null, extensions: ['device_options'] },
    { type: 'device_group', message0: 'group %1', args0: [{ type: 'input_statement', name: 'DO' }], previousStatement: null, nextStatement: null },
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
    Arduino.forBlock.device_group = b => Arduino.statementToCode(b, 'DO');
  `;
  const request = (source = script): NativeCandidateRequest => ({ blocks: [], steps: [
    { kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'unrelated-device-library', source },
    { kind: 'definitions', definitions },
  ] });
  const run = (input: NativeCandidateRequest) => evaluateNativeCandidate(input, { assertCurrent() {} });
  const keptModel = { id: 'kept-device-model', name: 'Sensor', type: 'DeviceModel' };
  const cleanupScript = script + `
    function options() {
      return [['Default', 'default'], ...Blockly.getMainWorkspace().getVariableMap()
        .getVariablesOfType('DeviceModel').map(model => [model.getName(), model.getName()])];
    }
    Blockly.getMainWorkspace().addChangeListener(event => {
      if (event.type !== Blockly.Events.FINISHED_LOADING) return;
      const workspace = Blockly.getMainWorkspace(), map = workspace.getVariableMap();
      const names = new Set(workspace.getBlocksByType('device_config', false).map(block => block.getFieldValue('NAME')));
      for (const model of map.getVariablesOfType('DeviceModel')) if (!names.has(model.getName())) map.deleteVariable(model);
    });
  `;
  const fragment = (format: 'abs' | 'blocks', source = cleanupScript): NativeCandidateRequest => {
    const input = { ...request(source), variables: [keptModel] };
    if (format === 'abs') {
      input.abs = '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use(default)';
      input.hostCalls = [{ start: input.abs.indexOf('device_config'), type: 'device_config', argumentOrder: [{ name: 'NAME', kind: 'field' }] }];
    } else input.blocks = [{ id: 'use', type: 'device_use', fields: [{ name: 'DEVICE', value: 'default' }] }];
    return input;
  };
  for (const format of ['abs', 'blocks'] as const) it(`does not announce complete loading for a native ${format} fragment with preloaded producer models`, async () => {
    const result = await run(fragment(format));
    expect(result.state['variables']).toEqual([keptModel]);
    expect(result.state['blocks'].blocks.map((block: any) => block.type)).toEqual(['device_use']);
    if (format === 'abs') {
      expect(result.binding!.instances.map(block => block.type)).toEqual(['device_use']);
      expect(result.binding!.instances[0].shape.fields['DEVICE'].options!.map(option => option[1])).toContain('Sensor');
    }
  });
  for (const hasProducer of [true, false]) it(`still delivers one completed-topology notification for ABI and preserves exact model ownership; producer=${hasProducer}`, async () => {
    const blocks: any[] = [{ id: 'use', type: 'device_use', fields: { DEVICE: 'default' } }];
    if (hasProducer) blocks.unshift({ id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } });
    const state = { blocks: { blocks }, variables: [keptModel] };
    const input = { ...request(cleanupScript), verify: { state, contracts: { fields: {} } } };
    if (hasProducer) expect((await run(input)).state['variables']).toEqual([keptModel]);
    else await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_UI_CONTRACT_CHANGED' }));
  });
  for (const format of ['abs', 'blocks'] as const) it(`does not authorize a ${format} fragment's own timer to delete a preloaded model`, async () => {
    const source = cleanupScript.replace("this.getField('DEVICE').menuGenerator_ = options();", `
      this.getField('DEVICE').menuGenerator_ = options();
      const map = this.workspace.getVariableMap(); map.deleteVariable(map.getVariablesOfType('DeviceModel')[0]);`);
    await expectAsync(run(fragment(format, source))).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_UI_CONTRACT_CHANGED' }));
  });
  for (const selected of ['Sensor', 'default']) for (const nested of [false, true]) for (const reverse of [false, true]) {
    it(`binds a whole ABS including initialization of ${selected}; nested=${nested}, reverse=${reverse}`, async () => {
      const use = `device_use(${selected})`;
      const lines = ['device_config("Sensor")', nested ? `device_group()\n    ${use}` : use];
      if (reverse) lines.reverse();
      const bound = await run({ ...request(), abs: '# ABS Schema: 2\n' + lines.join('\n') });
      const roots = bound.state['blocks'].blocks;
      const useState = nested ? roots.find((b: any) => b.type === 'device_group').inputs.DO.block
        : roots.find((b: any) => b.type === 'device_use');
      expect(useState.fields.DEVICE).toBe(selected);
      expect(bound.binding!.instances.find(b => b.type === 'device_use')!.shape.fields['DEVICE'].options!.map(o => o[1])).toContain('Sensor');
    });
    it(`restores complete ABI initialization of ${selected}; nested=${nested}, reverse=${reverse}`, async () => {
      const use = { id: 'use', type: 'device_use', fields: { DEVICE: selected } };
      const blocks: any[] = [{ id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } },
        nested ? { id: 'group', type: 'device_group', inputs: { DO: { block: use } } } : use];
      if (reverse) blocks.reverse();
      const state = { blocks: { languageVersion: 0, blocks } };
      const result = await run({ ...request(), verify: { state, contracts: { fields: {} } } });
      expect(result.state).toEqual(jasmine.objectContaining(state));
    });
  }
  it('settles the block-info/explicit-block construction queue even when the selected value is already valid', async () => {
    const result = await run({ ...request(), blocks: [
      { id: 'use', type: 'device_use', fields: [{ name: 'DEVICE', value: 'default' }] },
      { id: 'config', type: 'device_config', fields: [{ name: 'NAME', value: 'Sensor' }] },
    ] });
    expect(result.state['blocks'].blocks.find((block: any) => block.id === 'use').fields.DEVICE).toBe('default');
  });
  for (const format of ['abs', 'abi', 'blocks']) it(`initializes real SVG before a legal dropdown construction callback; ${format}`, async () => {
    const source = script.replace("this.getField('DEVICE').menuGenerator_ = options();", `
      if (!this.getSvgRoot() || !this.getSvgRoot().parentNode) throw Error('Construction callback ran before SVG initialization');
      this.render();
      const size = this.getHeightWidth();
      if (!(size.width > 0 && size.height > 0)) throw Error('Construction callback lost native geometry');
      this.getField('DEVICE').menuGenerator_ = options();`);
    const input = request(source);
    if (format === 'abs') input.abs = '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use(default)';
    else if (format === 'abi') input.verify = { state: { blocks: { blocks: [
      { id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } },
      { id: 'use', type: 'device_use', fields: { DEVICE: 'default' } },
    ] } }, contracts: { fields: {} } };
    else input.blocks = [
      { id: 'config', type: 'device_config', fields: [{ name: 'NAME', value: 'Sensor' }] },
      { id: 'use', type: 'device_use', fields: [{ name: 'DEVICE', value: 'default' }] },
    ];
    const result = await run(input);
    expect(result.state['blocks'].blocks.find((block: any) => block.type === 'device_use').fields.DEVICE).toBe('default');
  });
  for (const codeEffect of [false, true]) it(`settles dropdown initialization after host placement without hiding code effects; mutation=${codeEffect}`, async () => {
    const source = 'let placementMarker = 1;\n' + script.replace("this.getField('DEVICE').menuGenerator_ = options();", `
      const config = this.workspace.getBlockById('config');
      if (this.getRelativeToSurfaceXY().y <= config.getRelativeToSurfaceXY().y) throw Error('Construction callback ran before host placement');
      this.getField('DEVICE').menuGenerator_ = options();
      ${codeEffect ? 'placementMarker = 2;' : ''}`) + `
      Arduino.forBlock.device_use = () => { Arduino.addSetup('placement-marker', String(placementMarker) + ';'); return ''; };
    `;
    const state = { blocks: { languageVersion: 0, blocks: [
      { id: 'config', type: 'device_config', fields: { NAME: 'Sensor' }, x: 30, y: 500 },
      { id: 'use', type: 'device_use', fields: { DEVICE: 'default' }, x: 30, y: 60 },
    ] } };
    const input = { ...request(source), verify: { state, contracts: { fields: {} }, newRootIds: ['use'] } };
    if (codeEffect) await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_UNSTABLE' }));
    else expect((await run(input)).state).toEqual(jasmine.objectContaining(state));
  });
  for (const format of ['abs', 'abi'] as const) it(`delivers FinishedLoading once even with no pending field or timer; ${format}`, async () => {
    const source = script.replace("setTimeout(() => { this.getField('DEVICE').menuGenerator_ = options(); }, 50);", `
      const block = this;
      this.workspace.addChangeListener(event => {
        if (event.type !== Blockly.Events.FINISHED_LOADING) return;
        window.loadingEvents = (window.loadingEvents || 0) + 1;
        if (window.loadingEvents !== 1) throw Error('Duplicate construction completion');
        setTimeout(() => { block.getField('DEVICE').menuGenerator_ = options(); }, 25);
      });`);
    const input = request(source);
    if (format === 'abs') input.abs = '# ABS Schema: 2\ndevice_use(default)\ndevice_config("Sensor")';
    else input.verify = { state: { blocks: { blocks: [
      { id: 'use', type: 'device_use', fields: { DEVICE: 'default' } },
      { id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } },
    ] } }, contracts: { fields: {} } };
    const result = await run(input);
    expect(result.state['blocks'].blocks.find((block: any) => block.type === 'device_use').fields.DEVICE).toBe('default');
  });
  it('settles nested one-shot initialization tasks without waiting for the host event loop', async () => {
    const source = script.replace("setTimeout(() => { this.getField('DEVICE').menuGenerator_ = options(); }, 50);",
      "setTimeout(() => { setTimeout(() => { this.getField('DEVICE').menuGenerator_ = options(); }, 25); }, 50);");
    const result = await run({ ...request(source), abs: '# ABS Schema: 2\ndevice_use(default)\ndevice_config("Sensor")' });
    expect(result.binding!.instances.find(block => block.type === 'device_use')!.shape.fields['DEVICE'].options!.map(option => option[1])).toContain('Sensor');
  });
  for (const effect of ['code', 'artifact', 'macro']) it(`still proves initialization does not change generated ${effect} when a callback also discovers legal options`, async () => {
    const mutation = script.replace("this.getField('DEVICE').menuGenerator_ = options();",
      "this.getField('DEVICE').menuGenerator_ = options(); marker = 2;");
    const source = 'let marker = 1;\n' + mutation + `
      Arduino.forBlock.device_use = () => {
        Arduino.addSetup('marker', ${effect === 'code' ? 'String(marker)' : '"constant"'} + ';');
        ${effect === 'macro' ? "window.projectService.addMacro('DEPENDENCY_MARKER=' + marker);" : ''}
        return '';
      };
      ${effect === 'artifact' ? "Arduino.getGeneratedArtifacts = () => [{fileName:'variables_dependency-12345678.h',content:String(marker),sourceTag:'dependency'}];" : ''}
    `;
    const input = { ...request(source), verify: { state: { blocks: { blocks: [
      { id: 'config', type: 'device_config', fields: { NAME: 'Sensor' } },
      { id: 'use', type: 'device_use', fields: { DEVICE: 'default' } },
    ] } }, contracts: { fields: {} } } };
    await expectAsync(run(input)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_UNSTABLE' }));
  });
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
  for (const mutation of [
    `Blockly.getMainWorkspace().getBlocksByType('device_config', false)[0].setFieldValue('Changed', 'NAME');`,
    `this.setFieldValue('Sensor', 'DEVICE');`,
    `Blockly.getMainWorkspace().newBlock('device_config');`,
    `Blockly.getMainWorkspace().getVariableMap().createVariable('Injected');`,
    `this.setDisabledReason(true, 'injected-initializer');`,
    `this.setNextStatement(false);`,
    `this.getField('DEVICE').menuGenerator_ = [['Sensor','Sensor']];`,
  ]) it('keeps already-bound values, selected options and all non-option semantics protected: ' + mutation, async () => {
    const source = script.replace("this.getField('DEVICE').menuGenerator_ = options();",
      `this.getField('DEVICE').menuGenerator_ = options(); ${mutation}`);
    await expectAsync(run({ ...request(source), abs: '# ABS Schema: 2\ndevice_config("Sensor")\ndevice_use(default)' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_UI_CONTRACT_CHANGED' }));
  });
  it('keeps the finite callback limit when initialization does not have a pending requested option', async () => {
    const source = script.replace("this.getField('DEVICE').menuGenerator_ = options();", 'function loop() { setTimeout(loop, 0); } loop();');
    await expectAsync(run({ ...request(source), abs: '# ABS Schema: 2\ndevice_use(default)' }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_LIMIT' }));
  });
  it('keeps the finite callback budget instead of waiting for arbitrary asynchronous work', async () => {
    const source = script.replace('this.getField(\'DEVICE\').menuGenerator_ = options();', `function loop() { setTimeout(loop, 0); } loop();`);
    await expectAsync(run({ ...request(source), abs: '# ABS Schema: 2\ndevice_use(Sensor)' }))
      .toBeRejectedWithError(/finite callback/);
  });
});
