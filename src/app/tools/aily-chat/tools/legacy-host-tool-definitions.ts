import type { Tool } from '../core/chat-types';

export const LEGACY_HOST_SCHEMATIC_TOOLS: Tool[] = [
  {
    name: 'generate_schematic',
    description: `生成硬件接线图的核心工具。分析开发板与外设的引脚映射，返回引脚摘要和生成规则。你需要根据返回内容编写 AWS 连线，再调用 validate_schematic 完成验证、保存与刷新。

完整工作流：
1. 可先调用 get_project_context 获取项目上下文和 pinmapId
2. 调用本工具并传入 pinmapIds
3. 根据返回的引脚摘要编写 AWS 连线内容
4. 调用 validate_schematic 作为最终步骤

多实例对象格式示例：
{ id: 'lib-dht:dht20:asair', alias: 'dht_indoor', label: '室内' }

软件组件格式示例：
{ refId: 'wifi', componentId: 'WiFi', pinmapId: 'lib-wifi:default:default', componentType: 'software' }`,
    input_schema: {
      type: 'object',
      properties: {
        pinmapIds: {
          type: 'array',
          description: `组件 pinmapId 列表。支持字符串或对象格式，例如 'lib-dht:dht20:asair'，或 { id: 'lib-dht:dht20:asair', alias: 'dht_indoor', label: '室内温湿度' }。`,
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'pinmapId 完整标识符' },
                  alias: { type: 'string', description: '别名，用作 refId' },
                  label: { type: 'string', description: '显示名称' },
                },
                required: ['id'],
              },
            ],
          },
        },
        components: {
          type: 'array',
          description: '旧版兼容组件简称列表，优先使用 pinmapIds。',
          items: { type: 'string' },
        },
        requirements: {
          type: 'string',
          description: '特殊连接需求，如 DHT20 用 3.3V 供电，或舵机接 D0。',
        },
      },
      required: [],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'get_pinmap_summary',
    description: '已废弃。generate_schematic 内部已包含完整引脚摘要，通常无需单独调用。',
    input_schema: {
      type: 'object',
      properties: {
        pinmapIds: {
          type: 'array',
          description: '要查询的组件 pinmapId 列表；为空时返回当前开发板的引脚摘要。',
          items: { type: 'string' },
        },
      },
      required: [],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'get_component_catalog',
    description: `获取当前项目的组件目录：开发板、已安装的传感器/外设库以及软件库，并列出所有可用型号和 pinmapId。

返回数据包含：
1. currentBoard：当前开发板的 pinmap 状态和 pinmapId
2. catalogs：传感器与外设库的型号列表和 pinmapId
3. softwareLibraries：WiFi、MQTT、HTTP 等无物理引脚的软件库
4. librariesMissingCatalog：缺少配置、需要 generate_pinmap 的库`,
    input_schema: {
      type: 'object',
      properties: {
        libraryFilter: {
          type: 'string',
          description: '可选，只返回指定库的目录，例如 lib-dht。',
        },
        includeNeedsGeneration: {
          type: 'boolean',
          description: '是否包含需要生成 pinmap 的项目。',
          default: true,
        },
        includeBoards: {
          type: 'boolean',
          description: '是否包含当前项目开发板的 pinmap catalog 信息。',
          default: true,
        },
      },
      required: [],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'get_project_context',
    description: `获取组件目录和当前生成的 C++ 代码，用于推断硬件外设需求。

返回数据包含：cppCode、currentBoard、catalogs、softwareLibraries 和 librariesMissingCatalog。`,
    input_schema: {
      type: 'object',
      properties: {
        includeNeedsGeneration: {
          type: 'boolean',
          description: '是否包含需要生成 pinmap 的项目。',
          default: true,
        },
      },
      required: [],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'validate_schematic',
    description: `验证 AWS 接线图并保存。这是连线工作流的最终步骤，集验证、保存和刷新为一体。

功能：
- 解析 AWS 语法，检查引脚、冲突、电压等安全问题
- 验证通过后自动保存 connection.aws 和 connection_output.json
- 自动通知接线图界面刷新`,
    input_schema: {
      type: 'object',
      properties: {
        aws: {
          type: 'string',
          description: 'AWS 格式的接线描述。',
        },
      },
      required: [],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'get_current_schematic',
    description: `读取当前项目已保存的连线图完整内容。用于编辑流程：先读取当前状态，再基于它编写新的 AWS 内容，然后调用 validate_schematic 保存。`,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    agents: ['mainAgent', 'schematicAgent'],
  },
  {
    name: 'generate_pinmap',
    description: `为缺少引脚配置的组件准备生成素材。返回 README、示例代码和 pinmap 模板，供你生成 pinmap JSON，再调用 save_pinmap 保存。`,
    input_schema: {
      type: 'object',
      properties: {
        pinmapId: {
          type: 'string',
          description: '目标组件的 fullId，例如 lib-servo:sg90:default 或 board-xiao_esp32s3:xiao_esp32s3:default。',
        },
        referenceSource: {
          type: 'string',
          enum: ['readme', 'example', 'auto'],
          description: '参考信息来源。',
          default: 'auto',
        },
      },
      required: ['pinmapId'],
    },
    agents: ['schematicAgent'],
  },
  {
    name: 'save_pinmap',
    description: '保存你生成的 pinmap JSON 到库目录，并自动创建或更新 pinmap_catalog.json，将状态置为 available。',
    input_schema: {
      type: 'object',
      properties: {
        pinmapId: {
          type: 'string',
          description: '目标组件的 fullId，例如 lib-servo:sg90:default。',
        },
        pinmapConfig: {
          type: 'object',
          description: '完整的 pinmap 配置 JSON。',
        },
      },
      required: ['pinmapId', 'pinmapConfig'],
    },
    agents: ['schematicAgent'],
  },
];

export const LEGACY_HOST_SAVE_ARCH_TOOL: Tool = {
  name: 'save_arch',
  description: `保存或覆盖项目目录下的 arch.md 框架图文件。生成 Mermaid 框架图后应直接调用此工具持久化，无需等待用户手动点击保存。

图表格式要求：
1. 必须使用 flowchart TD 或 flowchart LR
2. 节点 ID 使用简洁英文标识，例如 MCU、SENSOR、WIFI
3. 节点显示文本必须使用 []，不要使用 {} 或 ()
4. 数据流使用 -->，物理连接使用 ---
5. 逻辑分组优先使用 subgraph

图中应覆盖：
1. setup 到 loop 的主要执行流程
2. 项目架构和模块设计
3. 必要的注释说明

调用本工具时，code 字段必须只传原始 Mermaid DSL，不要包含 aily-mermaid 这类 fenced code block。

保存成功后框架图会自动在对话中渲染展示，请勿再次输出 Mermaid 源码。`,
  input_schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Mermaid 图表原始 DSL，仅传 raw code，不含 fenced code block。建议使用 flowchart TD/LR，并遵循 save_arch 工具描述中的节点与连线规范。',
      },
    },
    required: ['code'],
  },
  agents: ['mainAgent'],
};

export const LEGACY_HOST_EXTERNAL_TOOLS: Tool[] = [
  ...LEGACY_HOST_SCHEMATIC_TOOLS,
  LEGACY_HOST_SAVE_ARCH_TOOL,
];