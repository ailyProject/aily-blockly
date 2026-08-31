import type {
  SimulatorMainAgentSceneChangeRequest,
} from './simulator-main-agent-scene-change-port';

const MAX_SCENE_MESSAGE_CHARACTERS = 2_000_000;

/**
 * Build the ordinary user message submitted to Blockly's existing main Agent.
 *
 * The independent Simulator supplies one revision-locked Scene document. The
 * message exposes only code-relevant electrical semantics; visual placement,
 * iframe/runtime handles, host paths, and Simulator process authority never
 * enter Chat.
 */
export function createSimulatorMainAgentSceneMessage(
  request: SimulatorMainAgentSceneChangeRequest,
): string {
  const scene = createCodeRelevantSceneProjection(request.sceneDocument);
  const serializedScene = JSON.stringify(scene, null, 2);
  if (serializedScene.length > MAX_SCENE_MESSAGE_CHARACTERS) {
    throw new Error('Simulator Scene code context is too large for Chat.');
  }

  const topologySummary = [
    'Trusted library repair rule: deduplicate every component.extensions.ailyProjectRequirements.libraries entry by packageName. Compare each exact packageName and version with the injected current-project library inventory. If a required library is absent or has a different version, call lib_add once from the current project with packages=["<packageName>@<version>"] and exact=true. Do not search for another package name, use a terminal installer, edit package.json directly, or edit node_modules. Library repair never grants Simulator source, build, QEMU, or GDB authority.',
    createTopologySummary(scene),
  ].join('\n');

  return `请根据 Aily Simulator 当前连线场景，直接修改当前已打开项目中的开发板、库和 Blockly 程序，使代码与连线一致。

这是主 Agent 的普通项目变更任务；不要调用任何 subagent，使用当前 Simulator Scene v2 工作流。

执行顺序（必须遵守）：
1. 如所需工具处于 deferred，只能用一次 tool_load 精确加载 switch_board、set_board_config、lib_add、abs_export、abs_validate、abs_apply；不要加载项目搜索、状态、文件、应用或子应用工具。第一项 Blockly 工作区操作必须调用 abs_export，以当前内存中的 Blockly 工作区为准。不要先用 list_dir 或反复 read_file 清点整个项目。
2. 只分析 abs_export 返回的完整 ABS 中与下方 Scene 拓扑有关的块。确定修改后，依次调用 abs_validate(abs=<完整 ABS>) 和 abs_apply(abs=<完整 ABS>) 原子应用；不要直接修改 project.abi，不要操作 Blockly XML，也不要使用离线 abs_import 覆盖已打开的工作区。
3. Scene component.extensions.ailyProjectRequirements 与 terminal.extensions.ailyComponentPinSemantic 都是已安装 Component Package 的可信投影。前者若声明 board，必须调用 switch_board(project=<当前项目绝对路径>, board_name=<精确包名>, board_version=<精确版本>)，切板后逐项调用 set_board_config(project=<当前项目绝对路径>, config_key=<键>, config_value=<值>) 应用 options；权威 options 已给出时禁止另行查询。若声明 libraries，只对当前项目确实缺失或版本不符的项调用 lib_add(project=<当前项目绝对路径>, packages=["<精确包名>@<精确版本>"], exact=true)。不得调用复合 project 工具处理切板/配置，不得从显示名称猜包名/版本/配置。对于当前 ESP32 Arduino 数字引脚块，直接使用后者 gpio.channel 的十进制值；arduinoAliases（例如 D2）只用于核对丝印/别名。存在权威引脚语义时禁止浏览板卡源码或猜测 pinId，也无需调用 get_board_parameters。只有 Scene 未提供权威语义时才调用 get_board_parameters。
4. 做最小必要修改，保留与本次硬件连线无关的用户逻辑；正确处理 GPIO、总线、上下拉、LED 源/灌电流极性和外接电阻。必须按数据流穷尽核对所有最终流入引脚参数的值：不仅是硬件块上的直接数字，还包括变量初始值、变量赋值和表达式中间接传入 pin 的值。在 import 前逐项复核每个 pinMode/digitalRead/digitalWrite/总线引脚数据流，不得遗留与 Scene 矛盾的旧引脚值。
5. 一旦代码与 Scene 一致，立即结束本轮。不要继续浏览库源码，不要修改 Scene，不要控制 Simulator、QEMU、GDB、UART 或仪器，也不要自行编译或创建 Artifact。
6. Host 会在本轮成功结束后调用正常 Builder，并把 Artifact 返回 Simulator。如果现有代码已经匹配，也必须完成一次 abs_export 检查，然后说明无需修改并结束。
7. 这是一次有界硬件同步，不是项目文档或架构任务。禁止调用 save_arch，禁止创建或修改 README/arch/方案等文档；禁止用 write_file/edit_file 修改 project.abs、project.abi 或其他项目文件。Blockly 程序只能通过 abs_apply 应用，开发板只能通过 switch_board 切换，库只能通过 lib_add 安装可信 Scene 明确要求的精确包版本。
8. 完成必需的切板/配置/装库和最终一次 abs_apply（无需修改时为 abs_export 检查）后，不再调用 lint、list/read、构建或其他检查工具，立即用一条简短文本说明已完成并结束本轮；Host 才能在 turn 结束后安全启动 Builder。

请求范围：
- requestId: ${request.requestId}
- projectIdentity: ${request.projectIdentity}
- sceneId: ${request.sceneId}
- graphSemanticRevision: ${request.graphSemanticRevision}

权威电气拓扑摘要：
${topologySummary}

代码相关 Scene 语义：
${serializedScene}`;
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
      ],
    )),
    busGroups: projectRecords(
      scene['busGroups'],
      busGroup => structuredClone(busGroup),
    ),
  };
}

function createTopologySummary(scene: Record<string, unknown>): string {
  const components = new Map<string, Record<string, unknown>>(
    projectRecords(scene['components'], component => component)
      .map(component => [String(component['instanceId'] ?? ''), component]),
  );
  const terminals = new Map<string, Record<string, unknown>>(
    projectRecords(scene['terminals'], terminal => terminal)
      .map(terminal => [String(terminal['terminalId'] ?? ''), terminal]),
  );
  const lines = projectRecords(scene['nets'], net => net).map(net => {
    const terminalIds = Array.isArray(net['terminalIds'])
      ? net['terminalIds'].filter((value): value is string => typeof value === 'string')
      : [];
    const endpoints = terminalIds.map(terminalId => {
      const terminal = terminals.get(terminalId);
      if (!terminal) return terminalId;
      const instanceId = String(terminal['instanceId'] ?? 'unknown-component');
      const component = components.get(instanceId);
      const componentName = String(component?.['componentName'] ?? instanceId);
      const pinId = String(terminal['pinId'] ?? 'unknown-pin');
      const selectedFunction = typeof terminal['selectedFunction'] === 'string'
        ? ` / ${terminal['selectedFunction']}`
        : '';
      const semantic = optionalRecord(
        optionalRecord(terminal['extensions'])['ailyComponentPinSemantic'],
      );
      const gpio = optionalRecord(semantic['gpio']);
      const gpioController = typeof gpio['controllerId'] === 'string'
        ? gpio['controllerId']
        : '';
      const gpioChannel = typeof gpio['channel'] === 'string'
        ? gpio['channel']
        : '';
      const physicalPin = typeof semantic['physicalPin'] === 'string'
        ? semantic['physicalPin']
        : '';
      const arduinoAliases = Array.isArray(semantic['arduinoAliases'])
        ? semantic['arduinoAliases'].filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
      const semanticDetails = [
        physicalPin ? `physical=${physicalPin}` : '',
        gpioController && gpioChannel
          ? `gpio=${gpioController}:${gpioChannel}`
          : '',
        gpioController === 'gpio' && /^\d+$/u.test(gpioChannel)
          ? `ESP32 Arduino numeric pin=${gpioChannel}`
          : '',
        arduinoAliases.length > 0
          ? `Arduino aliases=${arduinoAliases.join(',')}`
          : '',
      ].filter(Boolean);
      return `${componentName} (${instanceId}).${pinId}${selectedFunction}`
        + (semanticDetails.length > 0 ? ` [${semanticDetails.join('; ')}]` : '');
    });
    return `- ${String(net['signalKind'] ?? 'unknown')} ${String(net['netId'] ?? '')}: ${endpoints.join(' <-> ')}`;
  });
  return lines.length > 0 ? lines.join('\n') : '- No connected nets.';
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
