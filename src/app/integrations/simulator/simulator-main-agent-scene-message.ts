import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';

export const SIMULATOR_SCENE_RESOURCE_PATH = '.aily/simulator/scene-network-v2.json';
const MAX_SCENE_RESOURCE_BYTES = 48 * 1024;

export interface SimulatorMainAgentSceneResource {
  readonly type: 'file';
  readonly name: string;
  readonly path?: string;
  readonly content?: string;
}

/** User-visible request. Structured Scene data stays out of the chat message. */
export function createSimulatorMainAgentSceneMessage(
  request: SimulatorMainAgentSceneChangeRequest,
): string {
  return `请将当前 Simulator 连线场景同步到当前 Blockly 项目代码。

请求：${request.requestId}
Scene：${request.sceneId}
Revision：${request.graphSemanticRevision}

场景与执行规则已作为本轮只读资源提供。完成代码核对或必要修改后直接结束，Host 会自动构建。`;
}

/** Model-only resources: one revision-locked Scene projection plus bounded workflow rules. */
export function createSimulatorMainAgentSceneResources(
  request: SimulatorMainAgentSceneChangeRequest,
): SimulatorMainAgentSceneResource[] {
  const sceneResource = JSON.stringify({
    schemaVersion: 1,
    kind: 'aily-simulator-scene-code-resource',
    sourcePath: SIMULATOR_SCENE_RESOURCE_PATH,
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sceneId: request.sceneId,
    graphSemanticRevision: request.graphSemanticRevision,
    document: createCodeRelevantSceneProjection(request.sceneDocument),
  });
  if (new TextEncoder().encode(sceneResource).byteLength > MAX_SCENE_RESOURCE_BYTES) {
    throw new Error('Simulator Scene code resource is too large for Chat.');
  }

  return [{
    type: 'file',
    name: 'Simulator Scene v2 code resource',
    content: sceneResource,
  }, {
    type: 'file',
    name: 'Simulator Scene-to-code rules',
    content: createSceneToCodeRules(request),
  }];
}

function createSceneToCodeRules(
  request: SimulatorMainAgentSceneChangeRequest,
): string {
  return `这是主 Agent 的普通项目变更任务；不要调用任何 subagent、SchematicAgent，也不要修改 Simulator Scene。

权威范围：
- requestId: ${request.requestId}
- projectIdentity: ${request.projectIdentity}
- sceneId: ${request.sceneId}
- graphSemanticRevision: ${request.graphSemanticRevision}
- Scene 持久化位置: ${SIMULATOR_SCENE_RESOURCE_PATH}

执行规则：
1. 使用本轮已内联的「Simulator Scene v2 code resource」；它是 Host 从本次已提交 Scene 快照提取的 revision-locked 只读投影，持久化源仍位于上述路径。不要调用 read_file 读取 .aily，也不要修改 Scene。资源中的 sceneId 与 graphSemanticRevision 必须和权威范围一致，否则停止并报告 Scene 已变化。
2. 如所需工具处于 deferred，只能用一次 tool_load 精确加载 switch_board、set_board_config、lib_add、abs_export、abs_validate、abs_apply。第一项 Blockly 工作区操作必须是 abs_export，以当前内存工作区为准。
3. Scene component.extensions.ailyProjectRequirements 是可信的开发板、配置和库要求。按精确 packageName/version 调用 switch_board、set_board_config、lib_add；不得搜索替代包、使用终端安装、直接编辑 package.json 或 node_modules。
4. terminal.extensions.ailyComponentPinSemantic 是可信引脚语义。ESP32 Arduino 数字引脚使用 gpio.channel 的十进制值，arduinoAliases 只用于核对；只有缺少权威语义时才查询板卡参数。
5. 只分析与 Scene 拓扑有关的 ABS 块，保留无关用户逻辑；核对 GPIO、总线、上下拉、LED 源/灌电流、电阻，以及最终流入 pinMode、digitalRead、digitalWrite 和总线引脚参数的数据流。
6. 如需修改，依次调用 abs_validate(abs=<完整 ABS>) 与 abs_apply(abs=<完整 ABS>) 原子应用。不要直接修改 project.abs、project.abi、Blockly XML 或其他项目文件。若现有代码已匹配，只完成 abs_export 核对，不调用 abs_validate/abs_apply。
7. 完成必要的切板、配置、装库和 ABS 操作后立即用简短文本结束。不要构建、控制 Simulator/QEMU/GDB/UART、创建 Artifact、编写文档或继续浏览源码；Host 会在本轮成功结束后调用正常 Builder。`;
}

export function createCodeRelevantSceneProjection(
  sceneValue: unknown,
): Record<string, unknown> {
  const scene = requireRecord(sceneValue, 'Simulator Scene document');
  return {
    schemaVersion: scene['schemaVersion'],
    kind: scene['kind'],
    sceneId: scene['sceneId'],
    graphSemanticRevision: scene['graphSemanticRevision'],
    components: projectRecords(scene['components'], component => ({
      ...pickFields(component, [
        'instanceId',
        'componentId',
        'componentName',
        'componentType',
        'pinmapId',
      ]),
      extensions: pickFields(
        optionalRecord(component['extensions']),
        [
          'simulationProperties',
          'ailySimulatorComponentPackage',
          'ailyProjectRequirements',
        ],
      ),
    })),
    terminals: projectRecords(scene['terminals'], terminal => ({
      ...pickFields(
        terminal,
        ['terminalId', 'instanceId', 'pinId', 'selectedFunction'],
      ),
      extensions: pickFields(
        optionalRecord(terminal['extensions']),
        ['ailyComponentPinSemantic'],
      ),
    })),
    nets: projectRecords(scene['nets'], net => pickFields(
      net,
      [
        'netId',
        'signalKind',
        'terminalIds',
        'danglingTerminalIds',
        'extensions',
      ],
    )),
    busGroups: projectRecords(
      scene['busGroups'],
      busGroup => structuredClone(busGroup),
    ),
    extensions: structuredClone(optionalRecord(scene['extensions'])),
  };
}

function projectRecords(
  value: unknown,
  project: (record: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => project(
    requireRecord(item, `Simulator Scene collection item ${index}`),
  ));
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function pickFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      selected[field] = structuredClone(value[field]);
    }
  }
  return selected;
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}
