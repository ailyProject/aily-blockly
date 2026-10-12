import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';

export const SIMULATOR_SCENE_RESOURCE_PATH = '.aily/simulator/scene-network-v2.json';
const MAX_SCENE_RESOURCE_BYTES = 48 * 1024;
const SCENE_CODE_INTERPRETATION_RULES = `连线与代码解释原则：
- Scene 描述物理连接与引脚能力，不直接指定固件 API。signalKind=gpio 或普通 GPIO 的 selectedFunction 本身不排除 PWM、定时器输出或软件 UART/I²C/SPI；应核对实际引脚能力与现有代码。连接已匹配时保留已有硬件/软件实现及频率、占空比、延时和协议时序，不把它改写成另一种演示程序。
- 板卡元数据中的总线控制器名、引脚功能名和菜单值不证明 SDK 存在同名对象。保留已匹配的 SDK 对象和显式片选；确需变更时，只核验当前开发板/菜单对应的 SDK 相关声明与 variant 路由，不遍历整套 SDK，不凭外设标签猜对象名。事实缺失或冲突时停止并报告，不通过替换 API 或时序来消除不确定性。`;

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
  const reason = requireRebuildReason(request.reason);
  const instruction = reason === 'workspace-source-rebuild'
    ? '请保留当前用户代码，核对其与 Simulator 原连线场景的一致性，再重新构建。不要按旧图覆盖代码或重新创作场景。'
    : '请将当前 Simulator 连线场景同步到当前 Blockly 项目代码。';
  return `${instruction}

请求：${request.requestId}
Scene：${request.sceneId}
Revision：${request.graphSemanticRevision}
Reason：${reason}

场景与执行规则已作为本轮只读资源提供。${reason === 'workspace-source-rebuild'
    ? '只读核对完成后直接结束，不修改当前代码，Host 会自动重新构建。'
    : '完成代码核对或必要修改后直接结束，Host 会自动构建。'}`;
}

/** Model-only resources: one revision-locked Scene projection plus bounded workflow rules. */
export function createSimulatorMainAgentSceneResources(
  request: SimulatorMainAgentSceneChangeRequest,
): SimulatorMainAgentSceneResource[] {
  const reason = requireRebuildReason(request.reason);
  const sceneResource = JSON.stringify({
    schemaVersion: 1,
    kind: 'aily-simulator-scene-code-resource',
    sourcePath: SIMULATOR_SCENE_RESOURCE_PATH,
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sceneId: request.sceneId,
    reason,
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
  if (request.reason === 'workspace-source-rebuild') {
    return `这是工作区当前源码的显式核对与重新构建任务，源码可以没有变化；不是 Scene-to-code 改写任务。当前用户代码是本轮源码权威，必须完整保留。

权威范围：
- requestId: ${request.requestId}
- projectIdentity: ${request.projectIdentity}
- sceneId: ${request.sceneId}
- graphSemanticRevision: ${request.graphSemanticRevision}
- reason: workspace-source-rebuild
- Scene 持久化位置: ${SIMULATOR_SCENE_RESOURCE_PATH}

${SCENE_CODE_INTERPRETATION_RULES}

执行规则：
1. 使用本轮已内联的 revision-locked「Simulator Scene v2 code resource」核对原 Scene，不要调用 read_file 读取 .aily，也不要修改或重新生成 Scene。资源中的 sceneId、graphSemanticRevision 和 reason 必须与权威范围一致，否则停止并报告。
2. 如工具处于 deferred，只能用一次 tool_load 精确加载 abs_export、get_board_config。第一项 Blockly 工作区操作必须是 abs_export，以当前内存工作区为准；保留全部当前用户代码，不以 Scene 重新生成或覆盖代码。
3. 只读核对当前代码、开发板和库事实，以及 Scene 的 GPIO、总线、上下拉、LED 源/灌电流与电阻要求。ESP32 Arduino 数字引脚使用 terminal.extensions.ailyComponentPinSemantic.gpio.channel 的十进制值；不猜测缺失事实。
4. 不调用 abs_validate、abs_apply、board_switch、set_board_config、lib_add，不修改用户代码、板卡配置、库或工程文件。若当前代码与原 Scene 不一致或事实不可核验，停止并清楚报告冲突，不按旧 Scene 改回用户代码；由用户决定后续如何调整。
5. 一致时立即用简短文本结束。不要构建、调用 subagent、SchematicAgent 或控制 Simulator/QEMU/GDB/UART；Host 会在本轮成功结束后调用正常 Scene-bound Builder。`;
  }
  return `这是主 Agent 的普通项目变更任务；不要调用任何 subagent、SchematicAgent，也不要修改 Simulator Scene。

权威范围：
- requestId: ${request.requestId}
- projectIdentity: ${request.projectIdentity}
- sceneId: ${request.sceneId}
- graphSemanticRevision: ${request.graphSemanticRevision}
- reason: ${request.reason}
- Scene 持久化位置: ${SIMULATOR_SCENE_RESOURCE_PATH}

${SCENE_CODE_INTERPRETATION_RULES}

执行规则：
1. 使用本轮已内联的「Simulator Scene v2 code resource」；它是 Host 从本次已提交 Scene 快照提取的 revision-locked 只读投影，持久化源仍位于上述路径。不要调用 read_file 读取 .aily，也不要修改 Scene。资源中的 sceneId 与 graphSemanticRevision 必须和权威范围一致，否则停止并报告 Scene 已变化。
2. 如所需工具处于 deferred，只能用一次 tool_load 精确加载 board_switch、get_board_config、set_board_config、lib_add、abs_export、abs_validate、abs_apply。第一项 Blockly 工作区操作必须是 abs_export，以当前内存工作区为准。
3. Scene component.extensions.ailyProjectRequirements 是可信的开发板、配置和库要求。精确 packageName/version 必须与既有 Host 项目、板卡和安装事实核对；事实缺失或不匹配时停止并报告，不得猜测版本或搜索替代包。同板不切换；仅确需换板时调用 board_switch(boardName=<精确 packageName>, project=<当前项目绝对路径>)，project 可省略以使用当前工作区，工具不接受 version 参数，切板成功也不代表版本已核验。需要修改板卡配置时先用 get_board_config 取得 config_key 和 options.value，再调用 set_board_config(config_key=<返回的键>, config_value=<返回的值>)。库按精确 packageName@version 调用 lib_add 的 packages 参数；不得使用终端安装、直接编辑 package.json 或 node_modules。
4. terminal.extensions.ailyComponentPinSemantic 是可信引脚语义。ESP32 Arduino 数字引脚使用 gpio.channel 的十进制值，arduinoAliases 只用于核对；只有缺少权威语义时才查询板卡参数。
5. 只分析与 Scene 拓扑有关的 ABS 块，保留无关用户逻辑；核对 GPIO、总线、上下拉、LED 源/灌电流、电阻，以及最终流入 pinMode、digitalRead、digitalWrite 和总线引脚参数的数据流。
6. 如需修改，依次调用 abs_validate(abs=<完整 ABS>) 与 abs_apply(abs=<完整 ABS>) 原子应用。不要直接修改 project.abs、project.abi、Blockly XML 或其他项目文件。若现有代码已匹配，只完成 abs_export 核对，不调用 abs_validate/abs_apply。
7. 完成必要的切板、配置、装库和 ABS 操作后立即用简短文本结束。不要构建、控制 Simulator/QEMU/GDB/UART、创建 Artifact、编写文档或继续浏览源码；Host 会在本轮成功结束后调用正常 Builder。`;
}

function requireRebuildReason(value: unknown): SimulatorMainAgentSceneChangeRequest['reason'] {
  if (value !== 'graph-semantic-changed' && value !== 'workspace-source-rebuild') {
    throw new TypeError('Simulator main-Agent rebuild reason is required and must be supported.');
  }
  return value;
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
