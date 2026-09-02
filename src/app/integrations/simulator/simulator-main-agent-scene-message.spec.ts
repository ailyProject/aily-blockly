import {
  SIMULATOR_SCENE_RESOURCE_PATH,
  createSimulatorMainAgentSceneMessage,
  createSimulatorMainAgentSceneResources,
} from './simulator-main-agent-scene-message';
import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';

describe('Simulator main Agent Scene message', () => {
  const request: SimulatorMainAgentSceneChangeRequest = {
    schemaVersion: 1,
    kind: 'aily-simulator-main-agent-scene-change-request',
    requestId: 'scene-agent-request-1',
    projectIdentity: 'project-v1-test',
    sceneId: 'main',
    graphSemanticRevision: 'a'.repeat(64),
    sceneDocument: {
      schemaVersion: 2,
      kind: 'aily-scene-editor-document',
      sceneId: 'main',
      graphSemanticRevision: 'a'.repeat(64),
      components: [{
        instanceId: 'xiao_esp32s3_1',
        componentId: '@aily-project/board-xiao_esp32s3',
        componentName: 'XIAO ESP32S3',
        componentType: 'board',
        pinmapId: 'xiao-esp32s3',
        placement: { x: 100, y: 80 },
        extensions: {},
      }],
      terminals: [],
      nets: [],
      busGroups: [],
      danglingTerminals: [],
      junctions: [],
      wireSegments: [],
      extensions: {},
    } as unknown as SimulatorMainAgentSceneChangeRequest['sceneDocument'],
  };

  it('keeps the visible message short and free of serialized Scene data', () => {
    const message = createSimulatorMainAgentSceneMessage(request);

    expect(message.length).toBeLessThan(600);
    expect(message).toContain('scene-agent-request-1');
    expect(message).toContain('a'.repeat(64));
    expect(message).not.toContain('components');
    expect(message).not.toContain('@aily-project/board-xiao_esp32s3');
    expect(message).not.toContain('{');
  });

  it('passes a revision-locked Scene projection through model-only resources', () => {
    const resources = createSimulatorMainAgentSceneResources(request);

    expect(resources).toHaveSize(2);
    expect(resources[0].type).toBe('file');
    expect(resources[0].name).toBe('Simulator Scene v2 code resource');
    expect(resources[0].path).toBeUndefined();
    const sceneResource = JSON.parse(resources[0].content || '{}');
    expect(sceneResource.sourcePath).toBe(SIMULATOR_SCENE_RESOURCE_PATH);
    expect(sceneResource.graphSemanticRevision).toBe('a'.repeat(64));
    expect(sceneResource.document.components[0].instanceId)
      .toBe('xiao_esp32s3_1');
    expect(sceneResource.document.components[0].componentId)
      .toBe('@aily-project/board-xiao_esp32s3');
    expect(sceneResource.document.components[0].placement).toBeUndefined();
    expect(resources[1].content).toContain('不要调用任何 subagent、SchematicAgent');
    expect(resources[1].content).toContain('不要调用 read_file 读取 .aily');
    expect(resources[1].content).toContain('abs_export');
    expect(resources[1].content).toContain('abs_validate(abs=<完整 ABS>)');
    expect(resources[1].content).toContain('abs_apply(abs=<完整 ABS>)');
    expect(resources[1].content).toContain('gpio.channel 的十进制值');
    expect(resources[1].content).toContain('Host 会在本轮成功结束后调用正常 Builder');
  });
});
