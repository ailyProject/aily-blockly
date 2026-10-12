import {
  SIMULATOR_SCENE_RESOURCE_PATH,
  createSimulatorMainAgentSceneMessage,
  createSimulatorMainAgentSceneResources,
} from './simulator-main-agent-scene-message';
import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';
import { SimulatorMainAgentSceneChangeProviderService } from './simulator-main-agent-scene-change-provider.service';

describe('Simulator main Agent Scene message', () => {
  const request: SimulatorMainAgentSceneChangeRequest = {
    schemaVersion: 1,
    kind: 'aily-simulator-main-agent-scene-change-request',
    requestId: 'scene-agent-request-1',
    projectIdentity: 'project-v1-test',
    sceneId: 'main',
    reason: 'graph-semantic-changed',
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
    expect(sceneResource.reason).toBe('graph-semantic-changed');
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

  it('loads the canonical board and config tools in the existing single deferred batch', () => {
    const rules = createSimulatorMainAgentSceneResources(request)[1].content || '';
    const deferredRule = rules.split('\n').find(line => line.startsWith('2.')) || '';

    expect(deferredRule).toContain('只能用一次 tool_load');
    expect(deferredRule).toContain(
      'board_switch、get_board_config、set_board_config、lib_add、abs_export、abs_validate、abs_apply',
    );
    expect(deferredRule).toContain('第一项 Blockly 工作区操作必须是 abs_export');
    expect(rules).not.toContain('switch_board');
  });

  it('preserves physical capabilities and bus roles without deriving SDK object names', () => {
    const terminal = {
      terminalId: 'mcu.pad7', instanceId: 'mcu', pinId: 'pad7', selectedFunction: 'GPIO7',
      extensions: { ailyComponentPinSemantic: {
        gpio: { channel: 7 }, pwmChannels: [{ timer: 3, channel: 2 }],
        spi: { role: 'sck', peripheralId: 'controller-1' },
      } },
    };
    const net = { netId: 'signal-1', signalKind: 'gpio', terminalIds: ['mcu.pad7'] };
    const busGroup = { busId: 'bus-1', protocol: 'spi', roles: { sck: 'signal-1' } };
    const resources = createSimulatorMainAgentSceneResources({
      ...request,
      sceneDocument: {
        ...request.sceneDocument, terminals: [terminal], nets: [net], busGroups: [busGroup],
      } as unknown as SimulatorMainAgentSceneChangeRequest['sceneDocument'],
    });
    const projection = JSON.parse(resources[0].content || '{}').document;

    expect(projection.terminals).toEqual([terminal]);
    expect(projection.nets).toEqual([net]);
    expect(projection.busGroups).toEqual([busGroup]);
    expect(projection.terminals[0].sdkObject).toBeUndefined();
    expect(projection.busGroups[0].sdkObject).toBeUndefined();
  });

  it('uses the real board/config schema without claiming version-pinned board switching', () => {
    const rules = createSimulatorMainAgentSceneResources(request)[1].content || '';

    expect(rules).toContain('精确 packageName/version 必须与既有 Host 项目、板卡和安装事实核对');
    expect(rules).toContain('事实缺失或不匹配时停止并报告');
    expect(rules).toContain('同板不切换');
    expect(rules).toContain('board_switch(boardName=<精确 packageName>, project=<当前项目绝对路径>)');
    expect(rules).toContain('project 可省略以使用当前工作区');
    expect(rules).toContain('工具不接受 version 参数');
    expect(rules).toContain('切板成功也不代表版本已核验');
    expect(rules).toContain('先用 get_board_config 取得 config_key 和 options.value');
    expect(rules).toContain('set_board_config(config_key=<返回的键>, config_value=<返回的值>)');
    expect(rules).toContain('不得猜测版本或搜索替代包');
    expect(rules).not.toMatch(/board_switch\([^)]*\bversion\s*=/);
  });

  it('preserves current user code for source-only rebuild instead of applying the old Scene to it', () => {
    const sourceRequest: SimulatorMainAgentSceneChangeRequest = { ...request, reason: 'workspace-source-rebuild' };
    const message = createSimulatorMainAgentSceneMessage(sourceRequest);
    const resources = createSimulatorMainAgentSceneResources(sourceRequest);
    const resource = JSON.parse(resources[0].content || '{}');
    const rules = resources[1].content || '';

    expect(message.length).toBeLessThan(600);
    expect(message).toContain('保留当前用户代码');
    expect(message).toContain('不要按旧图覆盖代码或重新创作场景');
    expect(message).toContain('只读核对完成后直接结束，不修改当前代码');
    expect(resource.reason).toBe('workspace-source-rebuild');
    expect(resource.graphSemanticRevision).toBe(request.graphSemanticRevision);
    expect(rules).toContain('当前用户代码是本轮源码权威，必须完整保留');
    expect(rules).toContain('源码可以没有变化');
    expect(rules).toContain('只能用一次 tool_load 精确加载 abs_export、get_board_config');
    expect(rules).toContain('不调用 abs_validate、abs_apply、board_switch、set_board_config、lib_add');
    expect(rules).toContain('停止并清楚报告冲突，不按旧 Scene 改回用户代码');
    expect(rules).not.toContain('abs_apply(abs=<完整 ABS>)');
    expect(rules).toContain('正常 Scene-bound Builder');
  });

  it('rejects missing or unknown rebuild reasons without falling back to code rewriting', () => {
    for (const reason of [undefined, null, 'source-change', '']) {
      const invalid = { ...request, reason } as unknown as SimulatorMainAgentSceneChangeRequest;
      expect(() => createSimulatorMainAgentSceneMessage(invalid)).toThrowError(TypeError, /rebuild reason/);
      expect(() => createSimulatorMainAgentSceneResources(invalid)).toThrowError(TypeError, /rebuild reason/);
    }
  });

  for (const reason of ['graph-semantic-changed', 'workspace-source-rebuild'] as const) {
    it(`keeps physical wiring separate from firmware implementation for ${reason}`, () => {
      const resources = createSimulatorMainAgentSceneResources({ ...request, reason });
      const rules = resources[1].content || '';

      expect(rules).toContain('signalKind=gpio 或普通 GPIO 的 selectedFunction 本身不排除 PWM');
      expect(rules).toContain('软件 UART/I²C/SPI');
      expect(rules).toContain('保留已有硬件/软件实现及频率、占空比、延时和协议时序');
      expect(rules).toContain('不证明 SDK 存在同名对象');
      expect(rules).toContain('保留已匹配的 SDK 对象和显式片选');
      expect(rules).toContain('只核验当前开发板/菜单对应的 SDK 相关声明与 variant 路由');
      expect(rules).toContain('不遍历整套 SDK');
      expect(rules).toContain('事实缺失或冲突时停止并报告');
      expect(rules).not.toContain('BLACK_F407VG');
      expect(rules).not.toContain('SPI2');
      expect(rules).not.toContain('TIM4');
      expect(createSimulatorMainAgentSceneMessage({ ...request, reason })).not.toContain('连线与代码解释原则');
    });

    it(`passes ${reason} to the ordinary visible main-Agent session with the matching action title`, async () => {
      const calls: Array<{ message: string; title: string; resources: unknown[] }> = [];
      const sessions = { async requestCodeSync(message: string, title: string, resources: unknown[]) {
        calls.push({ message, title, resources });
        return { sessionId: 'main-agent-session-1' };
      } } as unknown as ConstructorParameters<typeof SimulatorMainAgentSceneChangeProviderService>[0];
      const provider = new SimulatorMainAgentSceneChangeProviderService(sessions);
      const result = await provider.request({ ...request, reason });

      expect(result.requestId).toBe(request.requestId);
      expect(calls).toHaveSize(1);
      expect(calls[0].message).toContain(reason);
      expect(calls[0].title).toBe(reason === 'workspace-source-rebuild'
        ? '保留当前代码，核对 Simulator 原场景后构建' : '同步 Simulator 连线场景到项目代码');
      expect(provider.cancel(request.requestId)).toBeFalse();
    });
  }
});
