export const FOUNDATIONAL_TOOL_DEFINITIONS = [
    {
        name: 'ask_user',
        description: `向用户提出一个或多个问题并等待回答。当你需要用户做出决策、提供额外信息或确认操作时使用此工具。
    当前 lex 路径中的 ask_user 由 lex core 内建实现；这里保留兼容 schema，供旧 blockly catalog / prompt 注入复用。
工具会暂停对话，在聊天界面显示问题和可选项，等待用户回答后继续。

传入 questions 数组，单问题即长度为 1 的数组。

使用场景：
- 需要用户在多个方案中做选择（提供 options）
- 需要用户提供多项关键信息（如项目名称 + 开发板类型 + 语言偏好）
- 需要用户确认重要操作前的决策
- 需求有歧义时主动澄清

注意：
- 不要滥用此工具，只在确实需要用户输入时使用
- 如果可以合理推断，优先自行决定而非打断用户
- 相关问题可合并为一次调用，减少打断次数`,
        input_schema: {
            type: 'object',
            properties: {
                questions: {
                    type: 'array',
                    description: '问题列表（单问题传长度为 1 的数组即可）',
                    items: {
                        type: 'object',
                        properties: {
                            question: { type: 'string', description: '问题内容' },
                            options: {
                                type: 'array',
                                description: '可选项列表',
                                items: {
                                    type: 'object',
                                    properties: {
                                        label: { type: 'string', description: '选项文本' },
                                        description: { type: 'string', description: '选项说明（可选）' },
                                        recommended: { type: 'boolean', description: '是否为推荐选项' }
                                    },
                                    required: ['label']
                                }
                            },
                            allow_freeform: { type: 'boolean', description: '是否允许自由输入（有 options 时默认 false）', default: false },
                            multi_select: { type: 'boolean', description: '是否允许多选（默认 false）', default: false }
                        },
                        required: ['question']
                    }
                }
            },
            required: ['questions']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'search_available_tools',
        description: `旧 blockly 聊天链路中的延迟工具搜索入口。当你需要使用未在当前工具列表中的工具时，调用此工具按关键词搜索。
    此工具仅用于 legacy search_available_tools 路径；lex runtime 使用独立的 deferred listing 与 tool_search。
成功后工具会被加载，可在后续对话中直接调用。

搜索示例：
- search_available_tools({query: "schematic"}) — 加载接线图相关工具
- search_available_tools({query: "grep"}) — 加载代码搜索工具
- search_available_tools({query: "fetch"}) — 加载网络请求工具
- search_available_tools({query: "abs"}) — 加载 ABS/Blockly 工具`,
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词（工具名、分组名或功能描述）'
                }
            },
            required: ['query']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'load_skill',
        description: `管理领域技能。search/list 用于发现可用 skill；load/unload 按名称管理当前会话的 skill 状态。
    当前 lex 路径中的 load_skill 由 lex core + blockly skill provider 协同实现；这里保留兼容 schema，供旧 blockly catalog / prompt 注入复用。
使用示例：
- load_skill({action: "load", name: "abs-syntax"}) — 加载 ABS 语法 skill；返回 SKILL.md 上下文和 related files
- load_skill({action: "search", query: "abs"}) — 搜索可用 skill；这是可选发现步骤，不是 load 前置条件
- load_skill({action: "list"}) — 列出当前已加载 skill
- load_skill({action: "unload", name: "abs-syntax"}) — 卸载已加载 skill
- load_skill({action: "load", name: "review-rules", task: "Review the latest changes."}) — 运行 fork-mode skill`,
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['search', 'load', 'unload', 'list'],
                    description: '操作类型：search（搜索），load（加载），unload（卸载），list（列出已加载）'
                },
                query: {
                    type: 'string',
                    description: '搜索关键词（仅 search 使用）'
                },
                name: {
                    type: 'string',
                    description: 'skill 名称（load/unload 使用）'
                },
                task: {
                    type: 'string',
                    description: 'fork-mode skill 的可选任务描述；未传时默认使用当前用户请求'
                }
            },
            required: ['action']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'register_agent',
        description: '兼容入口：动态注册一个新的子代理（subagent），注册后即可通过 agent 工具调用。旧前端 catalog 仍保留此定义，但当前 lex 主链路默认不暴露该工具。已注册的同名代理不会被覆盖。',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '子代理唯一标识（英文，如 dataAnalysisAgent）' },
                displayName: { type: 'string', description: '人类可读名称（如"数据分析代理"）' },
                description: { type: 'string', description: '功能描述（帮助 LLM 判断何时使用此代理）' },
                useCases: { type: 'array', items: { type: 'string' }, description: '适用场景列表' },
                suggestedContext: { type: 'string', description: '调用前建议获取的上下文' },
                maxTurns: { type: 'number', description: '最大工具调用轮次（默认 30）' },
            },
            required: ['name', 'displayName', 'description']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'create_project',
        description: '创建一个新项目，返回项目路径。需要提供使用的开发板（如 "@aily-project/board-arduino_uno", "@aily-project/board-arduino_uno_r4_minima"），传入的开发板名称以`https://blockly.yysc.tech/boards.json`中的内容为准。',
        input_schema: {
            type: 'object',
            properties: {
                board: { type: 'string', description: '开发板名称' },
            },
            required: ['board']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'execute_command',
        description: `在 PowerShell 中执行系统 CLI 命令。用于执行系统操作或运行特定命令来完成用户任务中的任何步骤。支持命令链，优先使用相对命令和路径以保持终端一致性。

如果命令需要长时间运行或输出很多内容，请使用 command_exec，并通过 command_write_stdin、command_resize、command_tail、command_read、command_search 或 command_stop 继续控制。`,
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '执行的命令' },
                cwd: { type: 'string', description: '工作目录，可选' }
            },
            required: ['command']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'command_exec',
        description: `执行系统 CLI 命令。默认短等待；如果命令未完成，返回 processId、outputSessionId 和 outputFilePath，后续通过 command_write_stdin 轮询或交互。

适合场景：
- 启动开发服务器（如 npm run dev）
- 启动 CLI 形态的串口/蓝牙/网络调试工具
- 执行耗时较长的编译/下载任务

长输出不要直接要求全文，使用 command_tail、command_read 或 command_search。`,
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令' },
                processId: { type: 'string', description: '可选的调用方进程 ID；交互式 PTY 会话可用它作为稳定 processId' },
                cwd: { type: 'string', description: '工作目录（可选，默认当前项目路径）' },
                timeoutMs: { type: 'number', description: '硬超时毫秒数（默认 30000）。对于长程任务，请显式传递该属性，确保进程完整执行。' },
                yieldTimeMs: { type: 'number', description: '短等待毫秒数，超过后返回 running（默认 1000）' },
                tty: { type: 'boolean', description: '需要真实 PTY 交互时设为 true；默认使用普通 buffered 命令执行' },
                streamStdin: { type: 'boolean', description: '保持 stdin 可写；tty=true 时隐含支持' },
                streamStdoutStderr: { type: 'boolean', description: '流式回传 stdout/stderr 进度；tty=true 时隐含支持' },
                size: {
                    type: 'object',
                    description: 'PTY 初始尺寸，仅 tty=true 时有效',
                    properties: {
                        rows: { type: 'number' },
                        cols: { type: 'number' }
                    },
                    required: ['rows', 'cols']
                }
            },
            required: ['command']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'command_write_stdin',
        description: `向命令进程写入 stdin；input 为空字符串时只轮询进程输出和状态，不写入内容。`,
        input_schema: {
            type: 'object',
            properties: {
                processId: { type: 'string', description: 'command_exec 返回的 processId' },
                input: { type: 'string', description: '精确写入 stdin 的文本；空字符串表示 poll' },
                yieldTimeMs: { type: 'number', description: '等待更多输出的毫秒数' }
            },
            required: ['processId']
        },
        agents: ["mainAgent"]
    },
    { name: 'command_status', description: '获取命令进程状态和有界输出预览。', input_schema: { type: 'object', properties: { processId: { type: 'string' } }, required: ['processId'] }, agents: ["mainAgent"] },
    { name: 'command_resize', description: '调整 tty=true 启动的 PTY 命令进程尺寸。', input_schema: { type: 'object', properties: { processId: { type: 'string' }, size: { type: 'object', properties: { rows: { type: 'number' }, cols: { type: 'number' } }, required: ['rows', 'cols'] } }, required: ['processId', 'size'] }, agents: ["mainAgent"] },
    { name: 'command_stop', description: '停止仍在运行的命令进程并返回最终状态。', input_schema: { type: 'object', properties: { processId: { type: 'string' }, yieldTimeMs: { type: 'number' } }, required: ['processId'] }, agents: ["mainAgent"] },
    { name: 'command_read', description: '按字节 offset 读取命令输出文件的一段内容。', input_schema: { type: 'object', properties: { processId: { type: 'string' }, outputSessionId: { type: 'string' }, offset: { type: 'number' }, maxBytes: { type: 'number' } } }, agents: ["mainAgent"] },
    { name: 'command_tail', description: '读取命令输出文件的最新尾部内容。', input_schema: { type: 'object', properties: { processId: { type: 'string' }, outputSessionId: { type: 'string' }, maxBytes: { type: 'number' } } }, agents: ["mainAgent"] },
    { name: 'command_search', description: '在命令输出文件中检索文本或正则，只返回命中片段。', input_schema: { type: 'object', properties: { processId: { type: 'string' }, outputSessionId: { type: 'string' }, query: { type: 'string' }, regex: { type: 'string' }, beforeLines: { type: 'number' }, afterLines: { type: 'number' }, maxMatches: { type: 'number' } } }, agents: ["mainAgent"] },
    {
        name: 'get_context',
        description: '获取当前的环境上下文信息，包括项目路径、当前平台、系统环境等。可以指定获取特定类型的上下文信息。',
        input_schema: {
            type: 'object',
            properties: {
                info_type: {
                    type: 'string',
                    description: '要获取的上下文信息类型',
                    enum: ['all', 'project', 'platform', 'system'],
                    default: 'all'
                }
            },
            required: ['info_type']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'get_project_info',
        description: '获取当前项目信息。如果项目已创建，返回当前项目使用的开发板及已安装的库列表。如果库中包含 readme_ai.md 文档，则同时输出该文件的路径。可用于了解项目配置、查找库文档等。',
        input_schema: {
            type: 'object',
            properties: {
                include_readme: {
                    type: 'boolean',
                    description: '是否检查并返回库的 readme_ai.md 文件路径',
                    default: true
                }
            },
            required: []
        },
        agents: ["mainAgent", "schematicAgent"]
    },
];
