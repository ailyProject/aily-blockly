import {
  createSimulatorSceneGpioBuildMetadata,
} from './simulator-scene-gpio-build-metadata';

describe('Simulator Scene GPIO build metadata', () => {
  const graphSemanticRevision = 'a'.repeat(64);

  function pinSemantic(physicalPin: string, channel: string): {
    schemaVersion: number; physicalPin: string;
    gpio: { controllerId: string; channel: string } | null;
    adcChannels: { controllerId: string; channel: string }[];
  } {
    return { schemaVersion: 1, physicalPin, gpio: { controllerId: 'gpio', channel }, adcChannels: [] };
  }

  function sceneHead(revision = graphSemanticRevision) {
    return {
      schemaVersion: 1,
      kind: 'aily-blockly-simulator-project-scene-head',
      descriptor: {
        kind: 'aily-project-scene-network-descriptor',
        document: {
          schemaVersion: 2,
          kind: 'aily-scene-editor-document',
          graphSemanticRevision: revision,
          componentConfigs: {
            xiao_esp32s3: {
              id: 'component-xiao-esp32s3',
              pins: [
                {
                  id: 'pin_3',
                  functions: [
                    { name: 'D2', type: 'digital' },
                    { name: 'GPIO3', type: 'gpio' },
                  ],
                },
                {
                  id: 'pin_4',
                  functions: [
                    { name: 'D3', type: 'digital' },
                    { name: 'GPIO4', type: 'gpio' },
                  ],
                },
              ],
            },
          },
          components: [
            {
              instanceId: 'xiao_esp32s3',
              componentId: 'component-xiao-esp32s3',
            },
          ],
          terminals: [
            { instanceId: 'xiao_esp32s3', pinId: 'pin_3',
              extensions: { ailyComponentPinSemantic: pinSemantic('PA3', '3') } },
            { instanceId: 'xiao_esp32s3', pinId: 'pin_4',
              extensions: { ailyComponentPinSemantic: pinSemantic('PA4', '4') } },
          ],
        },
      },
    };
  }

  function duplicatedContact(physicalPin = 'PA3', channel = '3') {
    const head = sceneHead(), document = head.descriptor.document;
    document.componentConfigs.xiao_esp32s3.pins.push({ id: 'pin_3_alias',
      functions: [{ name: 'D2', type: 'digital' }, { name: 'GPIO3', type: 'gpio' }] });
    document.terminals.push({ instanceId: 'xiao_esp32s3', pinId: 'pin_3_alias',
      extensions: { ailyComponentPinSemantic: pinSemantic(physicalPin, channel) } });
    return head;
  }

  it('projects Arduino pin modes onto revision-locked Scene endpoints', () => {
    const metadata = createSimulatorSceneGpioBuildMetadata(
      sceneHead().descriptor.document,
      `
        void setup() {
          pinMode(3, OUTPUT);
          pinMode(4, INPUT_PULLUP);
        }
      `,
      graphSemanticRevision,
    );

    expect(metadata).toEqual({
      directions: {
        'xiao_esp32s3.pin_3': 'output',
        'xiao_esp32s3.pin_4': 'input',
      },
      pulls: {
        'xiao_esp32s3.pin_4': 'up',
      },
    });
  });

  it('rejects metadata generation after the Scene revision changes', () => {
    expect(() => createSimulatorSceneGpioBuildMetadata(
      sceneHead('b'.repeat(64)).descriptor.document,
      'pinMode(3, OUTPUT);',
      graphSemanticRevision,
    )).toThrowError(/Scene changed/u);
  });

  it('keeps explicitly configured directions when firmware reads outputs or writes inputs', () => {
    expect(createSimulatorSceneGpioBuildMetadata(
      sceneHead().descriptor.document,
      'pinMode(D2, OUTPUT); digitalRead(D2); pinMode(D3, INPUT_PULLUP); digitalWrite(D3, HIGH);',
      graphSemanticRevision,
    )).toEqual({
      directions: {
        'xiao_esp32s3.pin_3': 'output',
        'xiao_esp32s3.pin_4': 'input',
      },
      pulls: { 'xiao_esp32s3.pin_4': 'up' },
    });
  });

  it('retains ADC usage as input evidence when no pin mode is configured', () => {
    expect(createSimulatorSceneGpioBuildMetadata(
      sceneHead().descriptor.document,
      'analogRead(D2);',
      graphSemanticRevision,
    )).toEqual({
      directions: { 'xiao_esp32s3.pin_3': 'input' },
      pulls: {},
    });
  });

  it('resolves constants and multiline configurations without treating comments as modes', () => {
    expect(createSimulatorSceneGpioBuildMetadata(
      sceneHead().descriptor.document,
      '#define LED D2\npinMode(\n LED,\n OUTPUT\n); digitalRead(LED); // pinMode(LED, INPUT);',
      graphSemanticRevision,
    ).directions).toEqual({ 'xiao_esp32s3.pin_3': 'output' });
  });

  it('defers sequential direction changes to native pad state', () => {
    expect(createSimulatorSceneGpioBuildMetadata(
      sceneHead().descriptor.document,
      'pinMode(3, INPUT); pinMode(D2, OUTPUT);', graphSemanticRevision,
    )).toEqual({ directions: {}, pulls: {} });
  });

  it('coalesces repeated contacts only through their same declared physical pad', () => {
    const head = duplicatedContact();
    const expected = { directions: { 'xiao_esp32s3.pin_3': 'input' }, pulls: { 'xiao_esp32s3.pin_3': 'up' } } as const;
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document, 'pinMode(3, INPUT_PULLUP);', graphSemanticRevision)).toEqual(expected);
    head.descriptor.document.terminals.reverse();
    head.descriptor.document.componentConfigs.xiao_esp32s3.pins.reverse();
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document, 'pinMode(D2, INPUT_PULLUP);', graphSemanticRevision)).toEqual(expected);
  });

  it('coalesces dynamic directions on the same physical pad', () => {
    expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact().descriptor.document,
      'pinMode(3, INPUT); pinMode(D2, OUTPUT);', graphSemanticRevision)).toEqual({ directions: {}, pulls: {} });
  });

  it('omits changing pulls on one physical pad in either source order', () => {
    for (const [first, second] of [
      ['INPUT_PULLUP', 'INPUT_PULLDOWN'], ['INPUT_PULLDOWN', 'INPUT_PULLUP'],
      ['INPUT_PULLUP', 'INPUT'], ['INPUT', 'INPUT_PULLUP'],
      ['INPUT_PULLDOWN', 'INPUT'], ['INPUT', 'INPUT_PULLDOWN'],
    ]) {
      expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact().descriptor.document,
        `pinMode(3, ${first}); pinMode(D2, ${second});`, graphSemanticRevision))
        .toEqual({ directions: { 'xiao_esp32s3.pin_3': 'input' }, pulls: {} });
    }
  });

  it('accepts repeated equal explicit pulls without letting unknown usage clear them', () => {
    for (const [mode, pull] of [['INPUT_PULLUP', 'up'], ['INPUT_PULLDOWN', 'down']] as const) {
      expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact().descriptor.document,
        `pinMode(3, ${mode}); pinMode(D2, ${mode}); digitalRead(3); analogRead(D2);`, graphSemanticRevision))
        .toEqual({ directions: { 'xiao_esp32s3.pin_3': 'input' }, pulls: { 'xiao_esp32s3.pin_3': pull } });
    }
    expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact().descriptor.document,
      'pinMode(3, INPUT); pinMode(D2, INPUT); digitalRead(3);', graphSemanticRevision))
      .toEqual({ directions: { 'xiao_esp32s3.pin_3': 'input' }, pulls: {} });
  });

  it('does not merge real cross-pad aliases even when their GPIO labels match', () => {
    expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact('PA5').descriptor.document,
      'pinMode(3, OUTPUT);', graphSemanticRevision).directions).toEqual({});
  });

  it('does not merge same-named pads with different controller or channel routes', () => {
    for (const difference of ['controller', 'channel'] as const) {
      const head = duplicatedContact(), semantic = head.descriptor.document.terminals[2]!.extensions.ailyComponentPinSemantic;
      semantic.gpio = { controllerId: difference === 'controller' ? 'other-gpio' : 'gpio',
        channel: difference === 'channel' ? '7' : '3' };
      expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document,
        'pinMode(3, OUTPUT);', graphSemanticRevision).directions).toEqual({});
    }
  });

  it('does not merge duplicated appearance labels without valid physical routing evidence', () => {
    const head = duplicatedContact();
    head.descriptor.document.terminals[2]!.extensions.ailyComponentPinSemantic.schemaVersion = 0;
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document,
      'pinMode(3, OUTPUT);', graphSemanticRevision).directions).toEqual({});
  });

  it('does not merge identical physical routing across different MCU instances', () => {
    const head = duplicatedContact(), document = head.descriptor.document;
    document.components.push({ instanceId: 'other_mcu', componentId: 'component-xiao-esp32s3' });
    document.terminals[2]!.instanceId = 'other_mcu';
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document,
      'pinMode(3, OUTPUT);', graphSemanticRevision).directions).toEqual({});
  });

  it('coalesces analog-only contacts through their exact ADC controller/channel identity', () => {
    const head = duplicatedContact('ADC6', '6'), document = head.descriptor.document;
    for (const index of [0, 2]) {
      const semantic = document.terminals[index]!.extensions.ailyComponentPinSemantic;
      semantic.physicalPin = 'ADC6'; semantic.gpio = null;
      semantic.adcChannels = [{ controllerId: 'adc0', channel: '6' }];
    }
    for (const pin of document.componentConfigs.xiao_esp32s3.pins.filter(pin => pin.id !== 'pin_4'))
      pin.functions = [{ name: 'A6', type: 'analog' }];
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document,
      'analogRead(A6);', graphSemanticRevision).directions).toEqual({ 'xiao_esp32s3.pin_3': 'input' });
    document.terminals[2]!.extensions.ailyComponentPinSemantic.adcChannels[0]!.channel = '7';
    expect(createSimulatorSceneGpioBuildMetadata(head.descriptor.document,
      'analogRead(A6);', graphSemanticRevision).directions).toEqual({});
  });
  it('never turns runtime mode expressions or open drain into fixed directions/pulls', () => {
    for (const mode of ['desiredMode', 'condition ? INPUT_PULLUP : INPUT_PULLDOWN', 'chooseMode(flag)', 'OUTPUT_OPEN_DRAIN']) {
      for (const source of [
        `pinMode(D2, INPUT_PULLUP); pinMode(3, ${mode}); digitalWrite(D2, 1);`,
        `pinMode(3, ${mode}); pinMode(D2, INPUT_PULLUP); digitalRead(D2);`,
      ]) expect(createSimulatorSceneGpioBuildMetadata(duplicatedContact().descriptor.document, source, graphSemanticRevision))
        .toEqual({ directions: {}, pulls: {} });
    }
  });

  it('keeps unknown usage conflicts and Scene identity validation strict', () => {
    expect(() => createSimulatorSceneGpioBuildMetadata(sceneHead().descriptor.document,
      'digitalRead(D2); digitalWrite(D2, 1);', graphSemanticRevision)).toThrowError(/direction is ambiguous/);
    expect(() => createSimulatorSceneGpioBuildMetadata(sceneHead().descriptor.document,
      'pinMode(D2, mode);', 'invalid')).toThrowError(/graph revision/);
  });

  it('keeps a separate pad static when another pad changes mode', () => {
    expect(createSimulatorSceneGpioBuildMetadata(sceneHead().descriptor.document,
      'pinMode(D2, INPUT); pinMode(D2, OUTPUT); pinMode(D3, INPUT_PULLUP);', graphSemanticRevision))
      .toEqual({ directions: { 'xiao_esp32s3.pin_4': 'input' }, pulls: { 'xiao_esp32s3.pin_4': 'up' } });
  });

});
