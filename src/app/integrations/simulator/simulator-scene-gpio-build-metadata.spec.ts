import {
  createSimulatorSceneGpioBuildMetadata,
} from './simulator-scene-gpio-build-metadata';

describe('Simulator Scene GPIO build metadata', () => {
  const graphSemanticRevision = 'a'.repeat(64);

  function sceneHead(revision = graphSemanticRevision): unknown {
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
            { instanceId: 'xiao_esp32s3', pinId: 'pin_3' },
            { instanceId: 'xiao_esp32s3', pinId: 'pin_4' },
          ],
        },
      },
    };
  }

  it('projects Arduino pin modes onto revision-locked Scene endpoints', () => {
    const metadata = createSimulatorSceneGpioBuildMetadata(
      sceneHead(),
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
      sceneHead('b'.repeat(64)),
      'pinMode(3, OUTPUT);',
      graphSemanticRevision,
    )).toThrowError(/Scene changed/u);
  });

  it('rejects conflicting firmware directions for one Scene endpoint', () => {
    expect(() => createSimulatorSceneGpioBuildMetadata(
      sceneHead(),
      'pinMode(3, INPUT); digitalWrite(3, HIGH);',
      graphSemanticRevision,
    )).toThrowError(/direction is ambiguous/u);
  });
});
