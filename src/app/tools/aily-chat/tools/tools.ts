import { json } from "stream/consumers";

import { buildRunSubagentDescription } from './runSubagentTool';

export const toolParamNames = [
    "command"
] as const;

export type ToolParamName = (typeof toolParamNames)[number];

/**
 * 工具延迟加载分组定义
 * 参考 Copilot 的 deferred tool loading 策略：
 * - Core 工具：始终发送给 LLM（name + description + input_schema）
 * - Deferred 工具：仅在系统提示中列出名称，通过 search_available_tools 按需加载
 */
export interface DeferredToolGroup {
  name: string;
  brief: string; // 一行中文描述，用于 deferred listing
  tools: string[]; // 该分组下的工具名称
}

export const DEFERRED_TOOL_GROUPS: DeferredToolGroup[] = [
  {
    name: '文件工具',
    brief: '文件夹创建、文件/文件夹删除',
    tools: ['create_folder', 'delete_file', 'delete_folder']
  },
  {
    name: '搜索工具',
    brief: '全局文本搜索(grep)、文件模式匹配(glob)',
    tools: ['grep_tool', 'glob_tool']
  },
  {
    name: '网络工具',
    brief: '网页/API 请求(fetch)、网络搜索(web_search)、仓库克隆(clone_repository)',
    tools: ['fetch', 'web_search', 'clone_repository']
  },
  {
    name: '硬件/库搜索',
    brief: '搜索开发板和库、获取硬件分类、查询开发板参数',
    tools: ['search_boards_libraries', 'get_hardware_categories', 'get_board_parameters']
  },
//   {
//     name: 'ABS 工具',
//     // brief: 'ABS 文件同步、版本控制、ABS 语法参考、库块定义分析',
//     // tools: ['sync_abs_file', 'abs_version_control', 'get_abs_syntax', 'analyze_library_blocks']
//     brief: '版本控制',
//     tools: ['abs_version_control']
//   },
//   {
//     name: '接线图工具',
//     brief: '生成/验证/保存接线图、组件目录、引脚映射',
//     tools: ['generate_schematic', 'get_pinmap_summary', 'get_component_catalog', 'validate_schematic', 'apply_schematic', 'get_current_schematic', 'generate_pinmap', 'save_pinmap']
//   },
  {
    name: '项目管理',
    brief: '创建项目、重新加载项目、切换开发板、开发板配置',
    tools: ['create_project', 'reload_project', 'switch_board', 'get_board_config', 'set_board_config']
  },
  {
    name: '终端工具',
    brief: '后台命令执行、获取终端输出',
    tools: ['start_background_command', 'get_terminal_output']
  }
];

/** 所有 deferred 工具名称的 Set（快速查找） */
const DEFERRED_TOOL_NAMES = new Set(
  DEFERRED_TOOL_GROUPS.flatMap(g => g.tools)
);

/** 获取核心工具（非 deferred，始终发送给 LLM） */
export function getCoreTools(allTools: any[]): any[] {
  return allTools.filter(t => !DEFERRED_TOOL_NAMES.has(t.name));
}

/** 获取 deferred 工具（按需加载） */
export function getDeferredTools(allTools: any[]): any[] {
  return allTools.filter(t => DEFERRED_TOOL_NAMES.has(t.name));
}

/** 检查工具是否为 deferred */
export function isDeferredTool(name: string): boolean {
  return DEFERRED_TOOL_NAMES.has(name);
}

/**
 * 生成 deferred 工具列表文本（注入到规则中，告知 LLM 可用的延迟工具）
 * 参考 Copilot 的 <availableDeferredTools> 系统提示词段
 * @param agentName 当前 agent 名称，过滤工具的 agents 字段
 * @param excludeTools 配置中禁用的工具名称集合
 */
export function getDeferredToolsListing(agentName?: string, excludeTools?: Set<string>): string {
  const lines: string[] = [];
  for (const g of DEFERRED_TOOL_GROUPS) {
    const filteredTools = g.tools.filter(toolName => {
      if (excludeTools?.has(toolName)) return false;
      if (agentName) {
        const toolDef = (TOOLS as any[]).find(t => t.name === toolName);
        if (toolDef?.agents && !toolDef.agents.includes(agentName)) return false;
      }
      return true;
    });
    if (filteredTools.length === 0) continue;
    lines.push(`- ${g.name}: ${filteredTools.join(', ')}（${g.brief}）`);
  }
  if (lines.length === 0) return '';
  return `<availableTools>\n以下工具可通过 search_available_tools 按需加载后使用：\n${lines.join('\n')}\n调用 search_available_tools 时传入关键词或工具名即可加载对应工具的完整定义。\n</availableTools>`;
}

/**
 * 搜索 deferred 工具（供 search_available_tools 元工具使用）
 * @param query 搜索关键词
 * @param allTools 全部工具定义数组
 * @param agentName 当前 agent 名称，过滤工具的 agents 字段
 * @param excludeTools 配置中禁用的工具名称集合
 */
export function searchDeferredTools(query: string, allTools: any[], agentName?: string, excludeTools?: Set<string>): any[] {
  const q = query.toLowerCase();
  let deferredTools = getDeferredTools(allTools);

  // 按 agent 权限过滤
  if (agentName) {
    deferredTools = deferredTools.filter(t => !t.agents || t.agents.includes(agentName));
  }
  // 按配置过滤（尊重 aily config 中的 disabledTools）
  if (excludeTools && excludeTools.size > 0) {
    deferredTools = deferredTools.filter(t => !excludeTools.has(t.name));
  }

  // 1. 精确名称匹配
  const exactMatch = deferredTools.filter(t => t.name === q);
  if (exactMatch.length > 0) return exactMatch;

  // 2. 分组名称匹配
  const groupMatch = DEFERRED_TOOL_GROUPS.find(g =>
    g.name.toLowerCase().includes(q) || g.brief.toLowerCase().includes(q)
  );
  if (groupMatch) {
    return deferredTools.filter(t => groupMatch.tools.includes(t.name));
  }

  // 3. 名称/描述模糊匹配
  return deferredTools.filter(t =>
    t.name.toLowerCase().includes(q) ||
    (t.description && t.description.toLowerCase().includes(q))
  );
}

// export interface ToolUse {
//     type: "tool_use"
//     name: ToolName
// }

export interface ToolUseResult {
    is_error: boolean;
    content: string;
    details?: string;
    metadata?: any; // 添加 metadata 支持
}

export const TOOLS = [
    // =============================================================================
    // 用户交互工具 - ask_user（始终可用，用于向用户提问并等待回答）
    // =============================================================================
    {
        name: 'ask_user',
        description: `向用户提出一个或多个问题并等待回答。当你需要用户做出决策、提供额外信息或确认操作时使用此工具。
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
    // =============================================================================
    // 元工具 - search_available_tools（始终可用，用于发现和加载 deferred 工具）
    // =============================================================================
    {
        name: 'search_available_tools',
        description: `搜索并加载可用的扩展工具。当你需要使用未在当前工具列表中的工具时，调用此工具按关键词搜索。
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
    // =============================================================================
    // 技能工具 - load_skill（始终可用，用于加载领域知识/最佳实践指南）
    // =============================================================================
    {
        name: 'load_skill',
        description: `激活或卸载领域技能。激活后的技能内容会持久注入到每轮请求中，直到卸载。
使用示例：
- load_skill({query: "abs-syntax"}) — 激活 ABS 语法参考技能
- load_skill({query: "abs-syntax", action: "unload"}) — 卸载技能
- load_skill({url: "https://example.com/SKILL.md"}) — 从 URL 加载并激活`,
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '技能名称或搜索关键词'
                },
                action: {
                    type: 'string',
                    enum: ['load', 'unload'],
                    description: '操作类型：load（激活，默认）或 unload（卸载）'
                },
                url: {
                    type: 'string',
                    description: '直接从 URL 加载 SKILL.md 文件（一次性使用）'
                }
            },
            required: ['query']
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 技能管理工具 - manage_skills（Hub 搜索/安装/卸载）
    // TODO: 后续以 npm 包形式实现 Skills Hub，暂不启用
    // =============================================================================
    /*
    {
        name: 'manage_skills',
        description: `管理技能：搜索/安装/卸载/列出技能。当用户提到安装技能、查找最佳实践、管理领域知识包时使用。

操作类型：
- list_available — 列出所有已注册的技能
- list_installed — 列出从 Hub 安装的技能
- search_hub — 在 Skills Hub 中搜索可用技能
- install — 从 Hub 安装技能到全局或项目
- uninstall — 卸载已安装的技能`,
        input_schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['search_hub', 'install', 'uninstall', 'list_installed', 'list_available'],
                    description: '操作类型'
                },
                query: {
                    type: 'string',
                    description: '搜索关键词或技能名称'
                },
                download_url: {
                    type: 'string',
                    description: '技能包下载 URL（install 时需要）'
                },
                scope: {
                    type: 'string',
                    enum: ['global', 'project'],
                    description: '安装范围：global 全局 / project 项目级'
                }
            },
            required: ['action']
        },
        agents: ["mainAgent"]
    },
    */
    // =============================================================================
    // 子代理工具 - 始终发送给 LLM（core）
    // =============================================================================
    {
        name: 'run_subagent',
        get description() { return buildRunSubagentDescription(); },
        input_schema: {
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    description: '目标子代理名称（如 schematicAgent）'
                },
                task: {
                    type: 'string',
                    description: '交给子代理的具体任务描述'
                },
                context: {
                    type: 'string',
                    description: '相关上下文信息（项目信息、代码片段、硬件连接等）'
                }
            },
            required: ['agent', 'task']
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 核心工具 - 始终发送给 LLM
    // =============================================================================
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

如果命令需要长时间运行（如服务器、监控），请使用 start_background_command 代替。`,
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
    // =============================================================================
    // 终端会话工具 — 后台命令执行与输出获取（参考 Copilot run_in_terminal/get_terminal_output）
    // =============================================================================
    {
        name: 'start_background_command',
        description: `在后台启动一个长时间运行的命令，不等待完成即返回。返回 session_id 用于后续查询输出。

适合场景：
- 启动开发服务器（如 npm run dev）
- 启动串口监控
- 执行耗时较长的编译/下载任务

启动后使用 get_terminal_output 查看实时输出。`,
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令' },
                cwd: { type: 'string', description: '工作目录（可选，默认当前项目路径）' },
                label: { type: 'string', description: '可选标签，用于识别该会话（如 "build", "server"）' }
            },
            required: ['command']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'get_terminal_output',
        description: `获取后台命令的当前输出。默认返回自上次读取以来的新输出（增量模式）。

使用场景：
- 检查后台命令的执行进度和输出
- 获取服务器启动日志
- 监控编译进度`,
        input_schema: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: '终端会话 ID（由 start_background_command 返回）' },
                incremental: { type: 'boolean', description: '是否仅获取新输出（默认 true）', default: true },
                max_chars: { type: 'number', description: '最大返回字符数（默认 50000）', default: 50000 }
            },
            required: ['session_id']
        },
        agents: ["mainAgent"]
    },
    {
        name: "get_context",
        description: `获取当前的环境上下文信息，包括项目路径、当前平台、系统环境等。可以指定获取特定类型的上下文信息。`,
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
        name: "get_project_info",
        description: `获取当前项目信息。如果项目已创建，返回当前项目使用的开发板及已安装的库列表。如果库中包含 readme_ai.md 文档，则同时输出该文件的路径。可用于了解项目配置、查找库文档等。`,
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
    // {
    //     name: "list_directory",
    //     description: `列出指定目录的内容，包括文件和文件夹信息。返回每个项目的名称、类型、大小和修改时间。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要列出内容的目录路径'
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
    {
        name: "read_file",
        description: `读取指定文件的内容。支持完整读取或按行/字节范围读取，自动处理大文件和单行文件。

**读取模式：**
1. **完整读取**（默认）：读取整个文件（文件需小于 maxSize）
2. **按行范围读取**：指定起始行号和行数（行号从1开始）
3. **按字节范围读取**：指定起始字节位置和字节数（推荐用于大文件，优先级最高）

**自动优化（内部处理，无需手动配置）：**
- 单行大文件（如压缩JSON）：自动转换行范围为字节范围读取
- 超长行检测：自动选择最优读取策略
- 多行文件指定行范围时：自动计算等效字节范围，选择覆盖更大的方式

**大文件处理：**
- 默认限制 1MB，超过限制需指定范围读取或增加 maxSize
- 字节范围读取使用流式读取，不会一次性加载整个文件

**使用场景：**
- 小文件（<1MB）：直接完整读取
- 大文件：使用字节范围读取 (startByte + byteCount)
- 已知行号：使用行范围读取 (startLine + lineCount)，工具会自动优化
- **库readme或文档**：完整读取
- 搜索内容：使用 grep_tool 工具

**注意：**
- 行号从 1 开始计数
- 字节位置从 0 开始计数
- 字节范围读取优先级最高`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要读取的文件完整路径'
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式',
                    default: 'utf-8'
                },
                startLine: {
                    type: 'number',
                    description: '起始行号（从1开始）。指定后按行范围读取',
                    minimum: 1
                },
                lineCount: {
                    type: 'number',
                    description: '要读取的行数。不指定则读到文件末尾（或达到 maxSize 限制）',
                    minimum: 1
                },
                startByte: {
                    type: 'number',
                    description: '起始字节位置（从0开始）。指定后按字节范围读取（优先级最高，推荐用于大文件）',
                    minimum: 0
                },
                byteCount: {
                    type: 'number',
                    description: '要读取的字节数。不指定则读到文件末尾（或达到 maxSize 限制）',
                    minimum: 1
                },
                maxSize: {
                    type: 'number',
                    description: '最大读取大小（字节）。默认 1MB (1048576)。超过此大小需使用范围读取',
                    default: 1048576,
                    minimum: 1024
                }
            },
            required: ['path']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "create_file",
        description: `创建新文件并写入内容，需文件完整路径。如果目录不存在会自动创建。可选择是否覆盖已存在的文件。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要创建的文件完整路径'
                },
                content: {
                    type: 'string',
                    description: '文件内容',
                    default: ''
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式',
                    default: 'utf-8'
                },
                overwrite: {
                    type: 'boolean',
                    description: '是否覆盖已存在的文件',
                    default: false
                }
            },
            required: ['path']
        },
        agents: ["mainAgent"]
    },
    {
        name: "create_folder",
        description: `创建新文件夹。支持递归创建多级目录。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要创建的文件夹路径'
                },
                recursive: {
                    type: 'boolean',
                    description: '是否递归创建父目录',
                    default: true
                }
            },
            required: ['path']
        },
        agents: ["mainAgent"]
    },
    {
        name: "edit_file",
        description: `编辑文件工具 - 支持多种编辑模式（推荐使用 String Replace 模式以获得最佳安全性）

**编辑模式：**
1. **String Replace**（推荐）：替换文件中的特定字符串，自动检测多匹配防止意外修改
2. **Whole File**：替换整个文件内容
3. **Line-based**：在指定行插入或替换指定行范围
4. **Append**：追加内容到文件末尾

使用示例：

// 替换文件中的特定字符串（最安全的方式）
editFileTool({
  path: "/path/to/file.ts",
  oldString: "const value = 123;",
  newString: "const value = 456;",
  replaceMode: "string"
});

// 替换整个文件
editFileTool({
  path: "/path/to/file.txt",
  content: 'new file content',
  replaceMode: "whole"
});

// 在第5行插入内容
editFileTool({
  path: "/path/to/file.txt", 
  content: 'new line content',
  insertLine: 5
});

// 替换第3-5行的内容
editFileTool({
  path: "/path/to/file.txt",
  content: 'multi-line\nreplacement\ncontent',
  replaceStartLine: 3,
  replaceEndLine: 5
});

// 追加到文件末尾
editFileTool({
  path: "/path/to/file.txt",
  content: 'append content'
});

**String Replace 模式优势：**
- 自动检测并拒绝多个匹配（防止意外修改错误位置）
- 支持创建新文件（oldString 为空）
- 提供精确的行号和修改信息
- 自动检测文件编码

**重要：**
- 不支持编辑 .ipynb 文件
- String Replace 模式要求字符串在文件中唯一匹配
- 建议在 oldString 中包含 3-5 行上下文以确保唯一性`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要编辑的文件路径（支持相对路径和绝对路径）'
                },
                oldString: {
                    type: 'string',
                    description: '要替换的原字符串（String Replace 模式）。为空时创建新文件。必须在文件中唯一匹配，建议包含 3-5 行上下文'
                },
                newString: {
                    type: 'string',
                    description: '替换后的新字符串（String Replace 模式）。与 oldString 配合使用'
                },
                content: {
                    type: 'string',
                    description: '要写入的内容（其他模式使用）。Whole File 模式下是完整文件内容；Line-based 和 Append 模式下是要插入/追加的内容'
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式。不指定时自动检测（UTF-8 优先）',
                    default: 'utf-8'
                },
                createIfNotExists: {
                    type: 'boolean',
                    description: '文件不存在时是否创建（仅用于非 String Replace 模式）',
                    default: false
                },
                insertLine: {
                    type: 'number',
                    description: '插入行号（从1开始，Line-based 模式）。在指定行插入 content 的内容'
                },
                replaceStartLine: {
                    type: 'number',
                    description: '替换起始行号（从1开始，Line-based 模式）。替换从此行开始的内容'
                },
                replaceEndLine: {
                    type: 'number',
                    description: '替换结束行号（从1开始，Line-based 模式）。与 replaceStartLine 配合可替换多行。不指定则只替换起始行'
                },
                replaceMode: {
                    type: 'string',
                    enum: ['string', 'whole', 'line', 'append'],
                    description: '编辑模式：string=字符串替换（推荐，最安全），whole=替换整个文件，line=行级操作（需配合 insertLine/replaceStartLine），append=追加到末尾',
                    default: 'string'
                }
            },
            required: ['path']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    // =============================================================================
    // 精确替换工具（从 edit_file 拆分，参考 Copilot replace_string_in_file）
    // =============================================================================
    {
        name: 'replace_string_in_file',
        description: `精确替换文件中的一段字符串。要求 old_string 在文件中唯一匹配（不允许多个匹配，确保精确修改）。

这是编辑文件最安全的方式：
- 自动检测并拒绝多匹配（防止意外修改错误位置）
- 建议在 old_string 中包含 3-5 行上下文以确保唯一性
- 当 old_string 为空时，创建新文件并写入 new_string
- 自动 lint 检测（JSON/JS 文件）

适合场景：单个小改动、修改函数、修复 bug、调整配置项`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要编辑的文件路径'
                },
                old_string: {
                    type: 'string',
                    description: '要替换的原字符串。必须在文件中唯一匹配，建议包含 3-5 行上下文。为空时创建新文件'
                },
                new_string: {
                    type: 'string',
                    description: '替换后的新字符串'
                }
            },
            required: ['path', 'old_string', 'new_string']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'multi_replace_string_in_file',
        description: `批量精确替换 — 在一次调用中对一个或多个文件执行多次字符串替换。每个替换操作按顺序执行。

适合场景：
- 需要同时修改多个文件
- 一个文件中需要修改多处不同位置
- 重构操作（如重命名变量、更新导入路径）

每个替换等同于单独调用 replace_string_in_file，均要求唯一匹配。
最多支持 50 个替换操作。`,
        input_schema: {
            type: 'object',
            properties: {
                replacements: {
                    type: 'array',
                    description: '替换操作列表',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: '文件路径' },
                            old_string: { type: 'string', description: '要替换的原字符串' },
                            new_string: { type: 'string', description: '替换后的新字符串' }
                        },
                        required: ['path', 'old_string', 'new_string']
                    }
                }
            },
            required: ['replacements']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "delete_file",
        description: `删除指定文件。可选择是否在删除前创建备份。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要删除的文件路径'
                },
                createBackup: {
                    type: 'boolean',
                    description: '删除前是否创建备份',
                    default: true
                }
            },
            required: ['path']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "delete_folder",
        description: `删除指定文件夹及其内容。可选择是否在删除前创建备份。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要删除的文件夹路径'
                },
                createBackup: {
                    type: 'boolean',
                    description: '删除前是否创建备份',
                    default: true
                },
                recursive: {
                    type: 'boolean',
                    description: '是否递归删除',
                    default: true
                }
            },
            required: ['path']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    // {
    //     name: "check_exists",
    //     description: `检查指定路径的文件或文件夹是否存在，返回详细信息包括类型、大小、修改时间等。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要检查的路径'
    //             },
    //             type: {
    //                 type: 'string',
    //                 description: '期望的类型：file(文件)、folder(文件夹)或any(任意类型)',
    //                 enum: ['file', 'folder', 'any'],
    //                 default: 'any'
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
    // {
    //     name: "get_directory_tree",
    //     description: `获取指定目录的树状结构，可控制遍历深度和是否包含文件。适合了解项目结构。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要获取树状结构的目录路径'
    //             },
    //             maxDepth: {
    //                 type: 'number',
    //                 description: '最大遍历深度',
    //                 default: 3
    //             },
    //             includeFiles: {
    //                 type: 'boolean',
    //                 description: '是否包含文件（false时只显示文件夹）',
    //                 default: true
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
    {
        name: "search_boards_libraries",
        description: `智能开发板和库搜索工具，支持文本搜索和结构化筛选。
使用前可使用get_hardware_categories工具获取可用的分类和筛选维度。
**⭐ 推荐调用方式（统一使用 filters）：**
\`\`\`json
// 文本搜索
{ "type": "boards", "filters": { "keywords": ["wifi", "esp32", "arduino"] } }

// 结构化筛选 + 文本搜索
{ "type": "boards", "filters": { "keywords": ["esp32"], "connectivity": ["WiFi"], "flash": ">4096" } }

// 纯结构化筛选
{ "type": "libraries", "filters": { "category": "sensor", "communication": ["I2C"] } }
\`\`\`

**使用场景：**
1. 查找特定功能的库（如"温度传感器"、"舵机"、"OLED"）
2. 查找支持特定芯片的开发板（如"esp32"、"arduino"）
3. 按硬件规格筛选开发板（如"Flash >= 4MB"、"支持WiFi和BLE"）
4. 按类别筛选库（如"sensor类"、"通信类"）

**筛选参数说明：**

*通用参数：*
- keywords: 文本搜索关键词（字符串或数组），如 "esp32 wifi" 或 ["esp32", "wifi"]

*开发板筛选（filters）：*
- flash: Flash大小筛选（KB），支持比较运算符（如 ">4096", ">=1024"）
- sram: SRAM大小筛选（KB）
- frequency: 主频筛选（MHz）
- cores: 核心数筛选
- architecture: 架构筛选（如 "xtensa-lx7", "avr"）
- connectivity: 连接方式数组（如 ["WiFi", "BLE"]）
- interfaces: 接口数组（如 ["SPI", "I2C", "camera"]）
- brand: 品牌筛选
- voltage: 工作电压筛选

*库筛选（filters）：*
- category: 类别筛选（如 "sensor", "actuator", "communication"）
- hardwareType: 硬件类型数组（如 ["temperature", "humidity"]）
- supportedCores: 支持的核心数组（如 ["esp32:esp32", "arduino:avr"]）
- communication: 通信方式数组（如 ["I2C", "SPI"]）

**注意：**
- 返回结果默认限制在前50条最相关匹配
- 数值筛选支持运算符：>, >=, <, <=, =, !=`,
        input_schema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['boards', 'libraries'],
                    description: '搜索类型：boards(仅开发板), libraries(仅库)。默认为 boards',
                    default: 'boards'
                },
                filters: {
                    type: 'object',
                    description: '筛选条件（支持文本搜索和结构化筛选）',
                    properties: {
                        // 通用文本搜索
                        keywords: {
                            oneOf: [
                                { type: 'string', description: '搜索关键词，空格分隔多个词' },
                                { type: 'array', items: { type: 'string' }, description: '搜索关键词数组' }
                            ],
                            description: '文本搜索关键词（OR逻辑：匹配任意一个关键词即可返回）。例如: "wifi esp32" 或 ["wifi", "esp32", "arduino"] 会返回包含wifi或esp32或arduino的所有结果，匹配越多分数越高'
                        },
                        // 开发板筛选
                        flash: {
                            type: 'string',
                            description: 'Flash大小筛选（KB），支持比较运算符：>=4096, >2048, =16384'
                        },
                        sram: {
                            type: 'string',
                            description: 'SRAM大小筛选（KB），支持比较运算符'
                        },
                        frequency: {
                            type: 'string',
                            description: '主频筛选（MHz），支持比较运算符'
                        },
                        cores: {
                            type: 'string',
                            description: '核心数筛选，支持比较运算符'
                        },
                        architecture: {
                            type: 'string',
                            description: '架构筛选，如 xtensa-lx7, avr, arm-cortex-m4'
                        },
                        connectivity: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '连接方式数组（AND逻辑），如 ["WiFi", "BLE", "Ethernet"]'
                        },
                        interfaces: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '接口数组（AND逻辑），如 ["SPI", "I2C", "UART", "camera"]'
                        },
                        brand: {
                            type: 'string',
                            description: '品牌筛选，如 Espressif, Arduino, Seeed'
                        },
                        voltage: {
                            type: 'string',
                            description: '工作电压筛选（V）'
                        },
                        // 库筛选
                        category: {
                            type: 'string',
                            description: '库类别筛选，如 sensor, actuator, communication, display'
                        },
                        hardwareType: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '硬件类型数组，如 ["temperature", "humidity"]'
                        },
                        supportedCores: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '支持的核心数组，如 ["esp32:esp32", "arduino:avr"]'
                        },
                        communication: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '通信方式数组，如 ["I2C", "SPI", "UART", "OneWire"]'
                        }
                    }
                },
                maxResults: {
                    type: 'number',
                    description: '最大返回结果数，默认50',
                    default: 50
                }
            },
            required: ['filters']
        },
        agents: ["mainAgent"]
    },
    {
        name: "get_hardware_categories",
        description: `获取开发板或库的分类信息，用于引导式选型流程。

**⭐ 推荐使用流程：**
1. 先调用此工具获取分类概览（如传感器有哪些类型？开发板有哪些品牌？）
2. 根据分类结果，调用 search_boards_libraries 进行精确搜索

**开发板分类维度（dimension）：**
- architecture: 架构（avr, xtensa-lx6, xtensa-lx7, riscv, arm-cortex-m4...）
- connectivity: 连接方式（wifi, ble, bluetooth-classic, zigbee...）
- interfaces: 接口类型（camera, sd-card, display, usb-device, ethernet...）
- tags: 用途标签（AI, IoT, ARM, 教育, 入门...）

**库分类维度（dimension）：**
- category: 主分类（sensor, motor, display, communication, audio...）
- hardwareType: 硬件类型（temperature, humidity, led, oled, touch, stepper...）
- communication: 通信协议（i2c, spi, uart, gpio, pwm...）

**使用示例：**
\`\`\`json
// 获取所有库的主分类
{ "type": "libraries", "dimension": "category" }

// 获取传感器类库的硬件类型
{ "type": "libraries", "dimension": "hardwareType", "filterBy": { "category": "sensor" } }

// 获取开发板的接口类型分类（camera, sd-card, display等）
{ "type": "boards", "dimension": "interfaces" }

// 获取开发板的用途标签（AI, IoT, ARM等）
{ "type": "boards", "dimension": "tags" }

// 获取支持WiFi的开发板的架构分布
{ "type": "boards", "dimension": "architecture", "filterBy": { "connectivity": ["wifi"] } }
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['boards', 'libraries'],
                    description: '获取分类的类型：boards(开发板) 或 libraries(库)'
                },
                dimension: {
                    type: 'string',
                    description: '分类维度：开发板可选 architecture/connectivity/interfaces/tags；库可选 category/hardwareType/communication'
                },
                filterBy: {
                    type: 'object',
                    description: '可选的预过滤条件，用于获取特定范围内的分类',
                    properties: {
                        category: {
                            type: 'string',
                            description: '仅限库：先按主分类过滤，再获取子分类'
                        },
                        architecture: {
                            type: 'string',
                            description: '仅限开发板：先按架构过滤'
                        },
                        connectivity: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '仅限开发板：先按连接方式过滤'
                        },
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '仅限开发板：先按用途标签过滤'
                        }
                    }
                }
            },
            required: ['type', 'dimension']
        },
        agents: ["mainAgent"]
    },
    {
        name: "get_board_parameters",
        description: `获取当前项目开发板的详细参数配置工具。
从当前打开项目的开发板配置(board.json)中读取详细的硬件配置参数。

**可用参数类型：**
引脚相关：
- analogPins
- digitalPins
- pwmPins
- servoPins
- interruptPins
通信接口：
- serialPort
- serialSpeed
- spi
- spiPins
- i2c
- i2cPins
- i2cSpeed

其他配置：
- builtinLed
- rgbLed
- batteryPin
- name
- description
- compilerParam
- uploadParam

**使用场景：**
1. 用户询问"这个开发板有哪些模拟引脚"
2. 需要知道当前开发板支持的串口波特率
3. 查询SPI/I2C引脚配置
4. 获取PWM引脚列表用于舵机控制
5. 查看开发板的完整硬件参数

**示例：**
获取当前开发板的模拟和数字引脚：
\`\`\`json
{
  "parameters": ["analogPins", "digitalPins"]
}
\`\`\`

获取当前开发板的所有参数：
\`\`\`json
{}
\`\`\`

获取通信接口配置：
\`\`\`json
{
  "parameters": ["serialPort", "spi", "i2c", "spiPins", "i2cPins"]
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                parameters: {
                    type: 'array',
                    items: {
                        type: 'string'
                    },
                    description: '要获取的参数列表。如果不指定，返回所有参数。常用参数：analogPins, digitalPins, pwmPins, servoPins, serialPort, spi, i2c, spiPins, i2cPins 等'
                }
            },
            required: []
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "grep_tool",
        description: `- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Use this tool when you need to find files containing specific patterns
- Use word boundaries \\b to ensure a complete word match.
support two modes:
1. File name mode (default): returns a list of file paths containing the matched content
2. Content mode: returns the specific line content, file path, and line number of the matches

Basic Syntax:
Query board info in boards.json (returns filenames)
\`\`\`json
{
  "pattern": "WIFI|BLE",
  "path": "D:\\\\codes\\\\aily-blockly",
  "include": "*boards.json"
}
\`\`\`

Query and return specific content (for detailed info)
\`\`\`json
{
  "pattern": "\\\\bWIFI\\\\b|\\\\bBLE\\\\b",
  "path": "D:\\\\codes\\\\aily-blockly",
  "include": "*boards.json"
  "returnContent": true,
  "contextLines": 1
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '要搜索的模式（支持正则表达式或普通文本）'
                },
                path: {
                    type: 'string',
                    description: '搜索路径（目录）。如果不提供，默认使用当前项目路径'
                },
                include: {
                    type: 'string',
                    description: '文件包含模式（glob格式），如 "*.js"（仅搜索JS文件）、"*.{ts,tsx}"（搜索TS和TSX文件）、"*boards.json"（文件名包含boards.json）'
                },
                isRegex: {
                    type: 'boolean',
                    description: '搜索模式是否为正则表达式。true=正则表达式（支持 | 或 .* 等元字符），false=普通文本（自动转义特殊字符）。使用正则时需手动添加 \\b 实现全词匹配',
                    default: true
                },
                returnContent: {
                    type: 'boolean',
                    description: '是否返回匹配的具体内容。false=只返回文件名列表（快速），true=返回匹配的行内容、文件路径和行号（详细）',
                    default: false
                },
                contextLines: {
                    type: 'number',
                    description: '上下文行数（0-5）。当returnContent为true时，显示匹配行周围的上下文。0=只显示匹配行，1=上下各1行，2=上下各2行',
                    default: 0
                },
                maxLineLength: {
                    type: 'number',
                    description: '每行最大字符长度（100-2000）。用于控制返回内容的长度，避免单行超大文件（如压缩JSON）返回过多数据。推荐值：20',
                    default: 100
                },
                maxResults: {
                    type: 'number',
                    description: '最大结果数量限制',
                    default: 20
                }
                // ignoreCase: {
                //     type: 'boolean',
                //     description: '是否忽略大小写',
                //     default: true
                // },
                // wholeWord: {
                //     type: 'boolean',
                //     description: '是否全词匹配（仅在 isRegex=false 时有效）。启用后只匹配完整单词，避免部分匹配。使用正则表达式时此参数无效，需手动在模式中添加 \\b 边界符',
                //     default: false
                // }
            },
            required: ['pattern']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "glob_tool",
        description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead

快速文件模式匹配工具，用于按文件名模式查找文件。

基本语法:
查找所有 JavaScript 文件
\`\`\`json
{
  "pattern": "**/*.js",
  "path": "D:\\\\codes\\\\aily-blockly"
}
\`\`\`

查找特定名称的文件
\`\`\`json
{
  "pattern": "*boards.json",
  "path": "C:\\\\Users\\\\LENOVO\\\\AppData\\\\Local\\\\aily-project"
}
\`\`\`

查找多种文件类型
\`\`\`json
{
  "pattern": "**/*.{ts,tsx,js,jsx}",
  "path": "D:\\\\codes\\\\aily-blockly\\\\src"
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '文件匹配模式（支持 glob 语法）。例如: "**/*.js"（所有JS文件）, "src/**/*.ts"（src目录下所有TS文件）, "*boards.json"（文件名包含boards.json）'
                },
                path: {
                    type: 'string',
                    description: '搜索路径（目录）。如果不提供，默认使用当前工作目录'
                },
                limit: {
                    type: 'number',
                    description: '返回结果的最大数量限制（防止返回过多文件）',
                    default: 100
                }
            },
            required: ['pattern']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: "fetch",
        description: `获取网页内容和API数据。支持HTTP/HTTPS请求。
- 内容超过限制字符时自动截断，截断时会提示剩余字符数
- 支持分页读取：当内容被截断时，可用 startIndex 从截断位置继续读取
如需搜索信息请优先使用 web_search 工具。`,
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '要请求的URL地址（仅支持 http:// 和 https://）'
                },
                method: {
                    type: 'string',
                    description: 'HTTP请求方法',
                    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                    default: 'GET'
                },
                headers: {
                    type: 'object',
                    description: '请求头（键值对）'
                },
                body: {
                    description: '请求体'
                },
                timeout: {
                    type: 'number',
                    description: '请求超时时间（毫秒）',
                    default: 30000
                },
                startIndex: {
                    type: 'number',
                    description: '分页读取的起始字符索引（0-based）。当上次调用的响应提示内容被截断时，使用此参数从截断位置继续读取'
                }
            },
            required: ['url']
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'clone_repository',
        description: `克隆/下载远程 Git 仓库到本地。通过平台 zip 下载 API 获取整个仓库代码并解压，无需本地安装 git。

支持平台：GitHub、Gitee、GitLab、Bitbucket

使用场景：
- 用户提供了一个仓库 URL，需要获取其完整源码
- 需要参考某个开源项目的代码结构
- 下载示例项目或模板项目

注意：
- 仓库 zip 大小限制 50MB
- 默认尝试 main 分支，失败后自动回退到 master
- 支持 sparse_paths 只下载指定子目录`,
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '仓库 URL，如 https://github.com/owner/repo'
                },
                branch: {
                    type: 'string',
                    description: '分支名称（默认 main，失败自动回退 master）',
                    default: 'main'
                },
                target_dir: {
                    type: 'string',
                    description: '目标目录路径（相对项目根或绝对路径，默认为项目根下以仓库名命名的目录）'
                },
                sparse_paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '仅下载指定子目录（稀疏检出），如 ["src", "docs"]'
                }
            },
            required: ['url']
        },
        agents: ["mainAgent"]
    },
    {
        name: "web_search",
        description: `搜索网络以获取最新信息。使用 DuckDuckGo 搜索引擎，返回搜索结果列表（标题、摘要、链接）。
适用场景：
- 查找最新的技术文档、库版本信息、API 参考
- 搜索错误信息的解决方案
- 获取项目、产品、工具的最新状态
- 查找教程、指南和示例代码
- 在不知道确切 URL 时先搜索再用 fetch 获取详情
注意：搜索结果仅包含标题和摘要，如需完整内容请使用 fetch 工具访问结果中的链接。`,
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词，建议使用具体、有针对性的搜索词以获得更好的结果'
                },
                maxResults: {
                    type: 'number',
                    description: '返回的最大结果数量',
                    default: 10
                }
            },
            required: ['query']
        },
        agents: ["mainAgent"]
    },
    // {
    //     name: "reload_abi_json",
    //     description: `重新加载 project.abi 数据到 Blockly 工作区。可以从文件加载或直接提供 JSON 数据。适用于需要刷新 Blockly 块数据的场景。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             projectPath: {
    //                 type: 'string',
    //                 description: '项目路径，如果不提供将使用当前项目路径'
    //             },
    //             jsonData: {
    //                 type: 'object',
    //                 description: '直接提供.abi文件的内容'
    //             }
    //         },
    //         required: []
    //     }
    // },
    // {
    //     name: "edit_abi_file",
    //     description: `编辑ABI文件工具。支持多种编辑模式：1) 替换整个文件内容（默认）；2) 在指定行插入内容；3) 替换指定行或行范围；4) 追加到文件末尾。自动查找当前路径下的.abi文件，如果不存在会自动创建。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             content: {
    //                 type: 'string',
    //                 description: '要写入的内容。替换模式下必须是有效的JSON格式；插入/替换模式下可以是任意文本内容'
    //             },
    //             insertLine: {
    //                 type: 'number',
    //                 description: '插入行号（从1开始）。指定此参数时会在该行插入内容'
    //             },
    //             replaceStartLine: {
    //                 type: 'number',
    //                 description: '替换起始行号（从1开始）。指定此参数时会替换指定行的内容'
    //             },
    //             replaceEndLine: {
    //                 type: 'number',
    //                 description: '替换结束行号（从1开始）。与replaceStartLine配合使用，可替换多行内容。如不指定则只替换起始行'
    //             },
    //             replaceMode: {
    //                 type: 'boolean',
    //                 description: '是否替换整个文件内容。true=替换整个文件（默认），false=执行其他操作（插入、替换行、追加）',
    //                 default: true
    //             }
    //         },
    //         required: ['content']
    //     }
    // },
    // =============================================================================
    // 原子化块操作工具（推荐用于复杂结构）
    // =============================================================================
//     {
//         name: "create_single_block",
//         description: `创建单个 Blockly 块，支持 inputs 嵌套、动态块配置和创建时直接连接。<system-reminder>使用前需读取对应库的 Readme</system-reminder>

// **特性**：shadow 块嵌套 | extraState 配置 | 创建时直接连接（可选）| 返回块 ID

// **关键示例**：
// \`\`\`json
// // 创建并直接连接到 arduino_setup
// {"type": "serial_begin", "fields": {"SERIAL": "Serial", "SPEED": "9600"}, "connect": {"action": "put_into", "target": "arduino_setup"}}

// // 创建 math_number 并设为 delay 的 TIME 输入
// {"type": "math_number", "fields": {"NUM": 1000}, "connect": {"action": "set_as_input", "target": "delay_id", "input": "TIME"}}

// // 动态块（需指定 extraState）
// {"type": "controls_if", "extraState": {"elseIfCount": 1, "hasElse": true}}

// // 带输入的块
// {"type": "io_digitalwrite", "inputs": {"PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}}}}
// \`\`\``,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 type: { 
//                     type: 'string', 
//                     description: '块类型，如 serial_begin, io_digitalwrite, text_join 等' 
//                 },
//                 fields: { 
//                     type: 'object', 
//                     description: '块字段值，如 {SERIAL: "Serial", SPEED: "9600"}' 
//                 },
//                 inputs: {
//                     type: 'object',
//                     description: '块输入配置。每个输入可以是: {"shadow": {"type": "块类型", "fields": {...}}} 或 {"blockId": "已存在的块ID"}',
//                     additionalProperties: {
//                         type: 'object',
//                         properties: {
//                             shadow: {
//                                 type: 'object',
//                                 properties: {
//                                     type: { type: 'string', description: 'shadow块类型' },
//                                     fields: { type: 'object', description: 'shadow块字段' }
//                                 },
//                                 required: ['type']
//                             },
//                             blockId: { type: 'string', description: '已存在的块ID' }
//                         }
//                     }
//                 },
//                 extraState: {
//                     type: 'object',
//                     description: '动态块的额外状态配置。text_join/lists_create_with 用 {itemCount: N}; controls_if 用 {elseIfCount: N, hasElse: true}',
//                     properties: {
//                         itemCount: { type: 'number', description: 'text_join/lists_create_with 的输入数量' },
//                         elseIfCount: { type: 'number', description: 'controls_if 的 else if 分支数量' },
//                         hasElse: { type: 'boolean', description: 'controls_if 是否有 else 分支' }
//                     }
//                 },
//                 position: {
//                     type: 'object',
//                     properties: {
//                         x: { type: 'number', description: 'X坐标' },
//                         y: { type: 'number', description: 'Y坐标' }
//                     },
//                     description: '可选，块的位置'
//                 },
//                 connect: {
//                     type: 'object',
//                     description: '可选，创建后立即连接到目标块（参考 connect_blocks_simple）',
//                     properties: {
//                         action: {
//                             type: 'string',
//                             enum: ['put_into', 'chain_after', 'set_as_input'],
//                             description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
//                         },
//                         target: {
//                             type: 'string',
//                             description: '目标块 ID 或类型名（如 "arduino_setup", "arduino_loop"）'
//                         },
//                         input: {
//                             type: 'string',
//                             description: '目标输入名（可选，会自动检测）'
//                         },
//                         moveWithChain: {
//                             type: 'boolean',
//                             description: '是否将块后面连接的块一起移动（默认 false）',
//                             default: false
//                         }
//                     },
//                     required: ['action', 'target']
//                 }
//             },
//             required: ['type']
//         }
//     },
//     {
//         name: "connect_blocks_simple",
//         description: `【原子化工具-推荐】连接两个 Blockly 块，使用直观的语义。

// **连接动作**：
// | action | 说明 | 适用块类型 |
// |--------|------|-----------|
// | put_into | 放入容器的语句输入 | 语句块 → 容器块 |
// | chain_after | 链接到块后面 | 语句块 → 语句块 |
// | set_as_input | 设为值输入 | 值块 → 任意块 |

// **moveWithChain 选项**：
// - true（默认）：移动块时，将其后面连接的所有块一起移动
// - false：只移动单个块，原来连接在其后面的块会保持在原位置并自动重连

// **示例**：
// \`\`\`json
// // 将 serial_begin 放入 arduino_setup
// {"block": "serial_begin_id", "action": "put_into", "target": "arduino_setup_id"}

// // 将 delay 链接到 serial_println 后面
// {"block": "delay_id", "action": "chain_after", "target": "serial_println_id"}

// // 将 math_number 设为 delay 的 TIME 输入
// {"block": "math_number_id", "action": "set_as_input", "target": "delay_id", "input": "TIME"}

// // 只移动单个块（不带后面连接的块）
// {"block": "some_block_id", "action": "chain_after", "target": "target_id", "moveWithChain": false}
// \`\`\`

// **与 connect_blocks_tool 的区别**：
// - 语义更清晰：put_into/chain_after/set_as_input
// - 自动检测输入名（input 参数可选）
// - 支持 moveWithChain 选项控制是否移动整个块链
// - 更详细的错误提示`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 block: { 
//                     type: 'string', 
//                     description: '要操作的块 ID（来自 create_single_block 的返回值）' 
//                 },
//                 action: {
//                     type: 'string',
//                     enum: ['put_into', 'chain_after', 'set_as_input'],
//                     description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
//                 },
//                 target: { 
//                     type: 'string', 
//                     description: '目标块 ID' 
//                 },
//                 input: { 
//                     type: 'string', 
//                     description: '目标输入名（可选，会自动检测）' 
//                 },
//                 moveWithChain: {
//                     type: 'boolean',
//                     description: '是否将块后面连接的块一起移动（默认 false）。设为 false 时只移动单个块，原来在其后的块会自动重连',
//                     default: false
//                 }
//             },
//             required: ['block', 'action', 'target']
//         }
//     },
//     {
//         name: "set_block_field",
//         description: `【原子化工具】设置块的字段值。用于修改已创建块的字段。

// **示例**：
// \`\`\`json
// {"blockId": "abc123", "fieldName": "SPEED", "value": "115200"}
// {"blockId": "abc123", "fieldName": "VAR", "value": {"name": "myVar"}}
// \`\`\``,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockId: { type: 'string', description: '块 ID' },
//                 fieldName: { type: 'string', description: '字段名' },
//                 value: { description: '字段值（字符串、数字或变量对象）' }
//             },
//             required: ['blockId', 'fieldName', 'value']
//         }
//     },
//     {
//         name: "set_block_input",
//         description: `【原子化工具】将块连接到另一个块的指定输入。支持两种模式：连接已存在的块，或创建新块并连接。

// **模式1：连接已存在的块**（使用 sourceBlockId）
// \`\`\`json
// {"blockId": "if_block_id", "inputName": "IF0", "sourceBlockId": "condition_block_id"}
// \`\`\`

// **模式2：创建新块并连接**（使用 newBlock）
// \`\`\`json
// {
//   "blockId": "delay_block_id",
//   "inputName": "TIME",
//   "newBlock": {"type": "math_number", "fields": {"NUM": "1000"}}
// }
// \`\`\`

// **创建 shadow 块并连接**：
// \`\`\`json
// {
//   "blockId": "io_digitalwrite_id",
//   "inputName": "PIN",
//   "newBlock": {"type": "io_pin_digi", "fields": {"PIN": "13"}, "shadow": true}
// }
// \`\`\`

// **注意**：sourceBlockId 和 newBlock 必须二选一，不能同时提供`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockId: { type: 'string', description: '目标块 ID' },
//                 inputName: { type: 'string', description: '输入名称' },
//                 sourceBlockId: { type: 'string', description: '要连接的已存在块 ID（与 newBlock 二选一）' },
//                 newBlock: {
//                     type: 'object',
//                     description: '要创建并连接的新块配置（与 sourceBlockId 二选一）',
//                     properties: {
//                         type: { type: 'string', description: '块类型' },
//                         fields: { type: 'object', description: '块字段值' },
//                         shadow: { type: 'boolean', description: '是否作为 shadow 块', default: false }
//                     },
//                     required: ['type']
//                 }
//             },
//             required: ['blockId', 'inputName']
//         }
//     },
//     {
//         name: "get_workspace_blocks",
//         description: `【原子化工具】获取工作区当前的所有块列表。

// **用途**：
// - 查看已创建的块和它们的 ID
// - 检查哪些块有空输入需要填充
// - 分析块之间的连接关系

// **返回信息**：
// - 每个块的 ID、类型、是否为根块
// - 空输入列表（提示需要连接）
// - 块按类型分组统计`,
//         input_schema: {
//             type: 'object',
//             properties: {}
//         }
//     },
//     {
//         name: "batch_create_blocks",
//         description: `批量创建块并建立连接，一次调用完成整个结构。<system-reminder>使用前需读取对应库的 Readme</system-reminder>

// **核心特性**：扁平化 blocks+connections 数组 | 使用临时ID（如 "b1"）引用 | 一次调用完成多块创建和连接

// **示例**（DHT温度读取+LED控制）：
// \`\`\`json
// {
//   "blocks": [
//     {"id": "b1", "type": "dht_init", "fields": {"VAR": {"name": "dht"}}},
//     {"id": "b2", "type": "controls_if", "extraState": {"hasElse": true}},
//     {"id": "b3", "type": "logic_compare", "fields": {"OP": "GT"}},
//     {"id": "b4", "type": "dht_read_temperature", "fields": {"VAR": {"name": "dht"}}},
//     {"id": "b5", "type": "math_number", "fields": {"NUM": 30}}
//   ],
//   "connections": [
//     {"block": "b1", "action": "put_into", "target": "arduino_setup"},
//     {"block": "b2", "action": "put_into", "target": "arduino_loop"},
//     {"block": "b3", "action": "set_as_input", "target": "b2", "input": "IF0"},
//     {"block": "b4", "action": "set_as_input", "target": "b3", "input": "A"},
//     {"block": "b5", "action": "set_as_input", "target": "b3", "input": "B"}
//   ]
// }
// \`\`\`

// **块类型与动作**：
// - **语句块**（io_digitalwrite, dht_init, controls_if）：用 put_into（放入容器）或 chain_after（垂直堆叠）
// - **值块**（math_number, dht_read_temperature, logic_compare）：用 set_as_input（设为输入）

// **关键规则**：
// 1. chain_after 不支持 input 参数！放入 controls_if 的 DO0/ELSE 用 put_into
// 2. 临时ID 仅单次调用有效，跨调用需用返回的真实ID
// 3. inputs 配置：shadow块 | 嵌套块 | blockRef 引用
// 4. target 支持：临时ID（"b1"）| 类型名（"arduino_setup"）| 真实ID`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blocks: {
//                     type: 'array',
//                     description: '要创建的块列表（扁平化数组）',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             id: { type: 'string', description: '临时ID，用于 connections 中引用（如 "b1", "b2"）' },
//                             type: { type: 'string', description: '块类型（如 "dht_init", "controls_if"）' },
//                             fields: { type: 'object', description: '块字段值' },
//                             inputs: { 
//                                 type: 'object', 
//                                 description: '输入配置，支持 shadow 块或 blockRef 引用'
//                             },
//                             extraState: { type: 'object', description: '动态块的额外状态（如 controls_if 的 {hasElse: true}）' }
//                         },
//                         required: ['id', 'type']
//                     }
//                 },
//                 connections: {
//                     type: 'array',
//                     description: '连接规则列表',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             block: { type: 'string', description: '要操作的块（临时ID）' },
//                             action: { 
//                                 type: 'string', 
//                                 enum: ['put_into', 'chain_after', 'set_as_input'],
//                                 description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值'
//                             },
//                             target: { type: 'string', description: '目标块（临时ID 或 已存在块的真实ID）' },
//                             input: { type: 'string', description: '目标输入名（可选，会自动检测）' }
//                         },
//                         required: ['block', 'action', 'target']
//                     }
//                 },
//                 position: {
//                     type: 'object',
//                     properties: {
//                         x: { type: 'number' },
//                         y: { type: 'number' }
//                     },
//                     description: '起始位置（可选）'
//                 }
//             },
//             required: ['blocks', 'connections']
//         }
//     },
    // =============================================================================
    // 🔇 以下块操作工具已被 DSL 工具替代，暂时注释保留
    // 统一使用 sync_dsl_file 进行块的创建、修改、删除操作
    // =============================================================================
    // {
    //     name: "smart_block_tool",
    //     description: `智能块创建Blockly工作区中的块，一次只能创建一个块。<system-reminder>使用工具前必须确保已经读取了将要使用的block所属库的Readme。注意：当需要创建3个以上的块或嵌套超过2层时，推荐使用create_code_structure_tool创建。</system-reminder>
    // 基本语法:
    // \`\`\`json
    // {
    //   "type": "块类型",
    //   "position": {"x": 数字, "y": 数字}, // 可选
    //   "fields": {"字段名": "字段值"},
    //   "inputs": {"输入名": "块ID或配置"}, // 可选
    //   "parentConnection": {
    //     "blockId": "父块ID",
    //     "connectionType": "next|input|statement",
    //     "inputName": "输入名，如ARDUINO_SETUP"
    //   } // 父块连接配置（可选）
    // }
    // \`\`\`
    // 示例:
    // 创建数字块
    // \`\`\`json
    // {
    //   "type": "math_number",
    //   "fields": {"NUM": "123"}
    // }
    // \`\`\`
    // 创建变量块
    // \`\`\`json
    // {
    //   "type": "variable_define",
    //   "fields": {
    //     "VAR": "sensor_value",
    //     "TYPE": "int"
    //   },
    //   "inputs": {
    //     "VALUE": {"block": {"type": "math_number", "fields": {"NUM": "0"}}}
    //   }
    // }
    // \`\`\`
    // 创建Arduino数字输出
    // \`\`\`json
    // {
    //   "type": "io_digitalwrite",
    //   "inputs": {
    //     "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
    //     "STATE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
    //   }
    // }
    // \`\`\`
    // 创建串口打印
    // \`\`\`json
    // {
    //   "type": "serial_println",
    //   "fields": {"SERIAL": "Serial"},
    //   "inputs": {
    //     "VAR": {"block": {"type": "text", "fields": {"TEXT": "Hello"}}}
    //   }
    // }
    // \`\`\`
    // `,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             type: {
    //                 type: 'string',
    //                 description: '块类型，如 logic_boolean、controls_if、math_number 等'
    //             },
    //             position: {
    //                 type: 'object',
    //                 properties: {
    //                     x: { type: 'number', description: 'X坐标' },
    //                     y: { type: 'number', description: 'Y坐标' }
    //                 },
    //                 description: '块在工作区中的位置（可选）'
    //             },
    //             fields: {
    //                 type: 'object',
    //                 description: '块的字段配置，如布尔值、数字值、变量名等'
    //             },
    //             inputs: {
    //                 type: 'object',
    //                 description: '块的输入配置，连接其他块'
    //             },
    //             parentConnection: {
    //                 type: 'object',
    //                 properties: {
    //                     blockId: { type: 'string', description: '父块ID' },
    //                     connectionType: { type: 'string', description: '连接类型' },
    //                     inputName: { type: 'string', description: '输入名称' }
    //                 },
    //                 description: '父块连接配置（可选）。不提供时创建独立块，适用于全局变量、函数定义等顶级代码块'
    //             }
    //         },
    //         required: ['type']
    //     }
    // },
    // {
    //     name: "connect_blocks_tool",
    //     description: `块连接工具，通过修改连接关系移动Blockly块，但不会新建块，支持四种连接类型：next（顺序连接）、input（输入连接）、statement（语句连接）、disconnect（断开连接变独立块）。
    // 
    // ⚠️ **重要**：连接语义说明
    // - containerBlock: **容器块/父块** (提供连接点的块，如arduino_setup、if_else、repeat等)
    // - contentBlock: **内容块/子块** (要被连接的块，如digital_write、delay等)
    // - 例如：将digital_write放入arduino_setup中
    //   - containerBlock: "arduino_setup_id0" (容器)  
    //   - contentBlock: "digital_write_id1" (内容)
    //   - connectionType: "statement"
    //   - inputName: "input_statement"
    // 
    // 🔓 **断开连接（变独立块）**：
    // - 使用 connectionType: "disconnect" 将块从父块断开，变成工作区中的独立块
    // - moveChain: false（默认）- 只断开指定块，后续块保持在原位置
    // - moveChain: true - 断开整个块链，包括后续所有块一起变成独立块
    // 
    // 常见错误：不要混淆容器和内容的关系！`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             containerBlock: {
    //                 type: 'string',
    //                 description: '🔳 容器块ID（父块，提供连接点的块，如arduino_setup、if_else、repeat等容器类型块）。disconnect模式时可省略'
    //             },
    //             contentBlock: {
    //                 type: 'string', 
    //                 description: '📦 内容块ID（子块，要被放入容器的块，或要断开连接的块）'
    //             },
    //             connectionType: {
    //                 type: 'string',
    //                 enum: ['next', 'input', 'statement', 'disconnect'],
    //                 description: '连接类型：statement=语句连接（推荐），input=输入连接，next=顺序连接，disconnect=断开连接变独立块'
    //             },
    //             inputName: {
    //                 type: 'string',
    //                 description: '输入端口名称（statement连接时指定容器的哪个端口，如"input_statement"、"DO"、"ELSE"等，不指定时自动检测）'
    //             },
    //             moveChain: {
    //                 type: 'boolean',
    //                 description: '是否移动整个块链。false=只移动/断开单个块，后续块保持或重连；true（默认）=移动/断开整个块链',
    //                 default: true
    //             }
    //         },
    //         required: ['contentBlock', 'connectionType']
    //     }
    // },
    // {
    //     name: "create_code_structure_tool", 
    //     description: `动态结构创建工具，创建包含多个块的代码结构并连接到工作区。
    // 
    // **注意事项**:
    // - 使用工具前必须确保已读取使用的 block 所属库的 Readme
    // - 建议分步生成代码：全局变量 → 初始化 → loop → 回调函数
    // - 不要一次性生成超过 10 个 block 的代码块结构
    // 
    // **参数说明**:
    // - \`structureDefinition\`: 定义要创建的块（rootBlock + additionalBlocks）
    // - \`connectionRules\`: 定义所有块之间的连接（包括新创建的块之间，以及新块与工作区已有块之间）
    // 
    // **示例: 在 Arduino Setup 中添加初始化代码**
    // \`\`\`json
    // {
    //   "structure": "init-code",
    //   "config": {
    //     "structureDefinition": {
    //       "rootBlock": {
    //         "type": "control_if",
    //         "id": "if_check",
    //         "extraState": {"hasElse": true},
    //         "inputs": {
    //           "IF0": {"block": {"type": "logic_compare", "id": "logic_compare_id", "fields": {"OP": "GT"}, ...}},
    //           "DO0": {"block": {"type": "io_digitalwrite", "id": "green_led_on", "inputs": {...}}},
    //           "ELSE": {}
    //         }
    //       },
    //       "additionalBlocks": [
    //         {
    //           "type": "io_digitalwrite",
    //           "id": "red_led_on",
    //           "inputs": {
    //             "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
    //             "MODE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
    //           }
    //         },
    //         {
    //           "type": "io_digitalwrite",
    //           "id": "red_led_off",
    //           "inputs": {
    //             "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
    //             "MODE": {"shadow": {"type": "io_state", "fields": {"STATE": "LOW"}}}
    //           }
    //         }
    //       ]
    //     }
    //   },
    //   "connectionRules": [
    //     {"source": "arduino_setup_id", "target": "if_check", "connectionType": "statement", "inputName": "ARDUINO_SETUP"},
    //     {"source": "green_led_on", "target": "red_led_on", "connectionType": "next"},
    //     {"source": "if_check", "target": "red_led_off", "connectionType": "statement", "inputName": "ELSE"}
    //   ]
    // }
    // \`\`\`
    // `,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             structure: {
    //                 type: 'string',
    //                 description: '结构名称（用于日志和调试）'
    //             },
    //             config: {
    //                 type: 'object',
    //                 properties: {
    //                     structureDefinition: {
    //                         type: 'object',
    //                         properties: {
    //                             rootBlock: {
    //                                 type: 'object',
    //                                 description: '根块配置（必须包含 type 和 id）'
    //                             },
    //                             additionalBlocks: {
    //                                 type: 'array',
    //                                 items: { type: 'object' },
    //                                 description: '附加块配置数组'
    //                             }
    //                         },
    //                         required: ['rootBlock'],
    //                         description: '动态结构定义（仅定义要创建的块）'
    //                     }
    //                 },
    //                 required: ['structureDefinition'],
    //                 description: '结构配置对象'
    //             },
    //             connectionRules: {
    //                 type: 'array',
    //                 items: {
    //                     type: 'object',
    //                     properties: {
    //                         source: { type: 'string', description: '源块的 id（可以是新创建的块 id，也可以是工作区已有块的 id）' },
    //                         target: { type: 'string', description: '目标块的 id（可以是新创建的块 id，也可以是工作区已有块的 id）' },
    //                         inputName: { type: 'string', description: 'statement/input 连接时指定输入名称' },
    //                         connectionType: { 
    //                             type: 'string', 
    //                             enum: ['next', 'input', 'statement'],
    //                             description: 'next=source.nextConnection→target.previousConnection，statement=source.getInput(inputName).connection→target.previousConnection，input=source.getInput(inputName).connection→target.outputConnection' 
    //                         }
    //                     },
    //                     required: ['source', 'target', 'connectionType']
    //                 },
    //                 description: '块之间的连接规则（统一定义所有连接，包括新块之间和新块与已有块之间）'
    //             },
    //             position: {
    //                 type: 'object',
    //                 properties: {
    //                     x: { type: 'number', description: 'X坐标' },
    //                     y: { type: 'number', description: 'Y坐标' }
    //                 },
    //                 description: '结构在工作区中的坐标位置'
    //             }
    //         },
    //         required: ['structure']
    //     }
    // },
    // {
    //     name: "configure_block_tool",
    //     description: `用途：修改已存在 Blockly 块的字段值与动态结构（extraState），用于调整块的显示/配置但不创建或删除块。
    // 
    // 主要能力：
    // - 更新字段（field_dropdown、field_input、field_number、field_checkbox、text 等）。
    // - 修改动态结构（如 controls_if 的 else/elseif 分支、text_join 或 lists_create_with 的项目数）。
    // - 支持通过 blockId 精准定位或通过 blockType 查找第一个匹配块。
    // 
    // 前提条件：
    // - 目标块必须已存在于工作区。
    // - 必须提供有效的 blockId 或 blockType。
    // - 字段修改需提供非空的 fields 对象；结构修改需提供 extraState 对象。
    // - 修改前请确保理解目标块的字段名与 extraState 结构，错误参数可能导致操作失败。
    // 
    // **extraState 使用示例：**
    // 为 controls_if 块添加 1 个 else if 和 1 个 else 分支：
    // \`\`\`json
    // {
    //   "blockId": "if_block_id",
    //   "extraState": {
    //     "elseIfCount": 1,
    //     "hasElse": true
    //   }
    // }
    // \`\`\`
    // 
    // 修改IO下拉菜单字段：
    // \`\`\`json
    // {
    //   "blockId": "pin_block_id",
    //   "blockType": "io_pin_digi",
    //   "fields": {"PIN": "2"}
    // }
    // 
    // **必须提供完整的参数结构，空参数会导致工具执行失败。**`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             blockId: {
    //                 type: 'string',
    //                 description: '要配置的块ID（blockId 和 blockType 至少提供一个）'
    //             },
    //             blockType: {
    //                 type: 'string',
    //                 description: '块类型，当未提供 blockId 时使用（会找到第一个匹配类型的块）'
    //             },
    //             fields: {
    //                 type: 'object',
    //                 description: '要更新的字段值对象。格式：{"字段名": "字段值"}。字段名需要参考对应库的文档。',
    //                 additionalProperties: {
    //                     oneOf: [
    //                         { type: 'string' },
    //                         { type: 'number' },
    //                         { type: 'boolean' }
    //                     ]
    //                 }
    //             },
    //             extraState: {
    //                 type: 'object',
    //                 description: '动态块结构配置对象。用于修改支持动态输入的块结构，如 controls_if 的分支数量。',
    //                 properties: {
    //                     elseIfCount: {
    //                         type: 'number',
    //                         description: 'else if 分支数量（适用于 controls_if, controls_ifelse）',
    //                         minimum: 0,
    //                         maximum: 20
    //                     },
    //                     hasElse: {
    //                         type: 'boolean',
    //                         description: '是否包含 else 分支（适用于 controls_if）'
    //                     },
    //                     itemCount: {
    //                         type: 'number',
    //                         description: '项目数量（适用于 text_join, lists_create_with 等）',
    //                         minimum: 1,
    //                         maximum: 50
    //                     }
    //                 },
    //                 additionalProperties: true
    //             }
    //         },
    //         anyOf: [
    //             { 
    //                 allOf: [
    //                     { anyOf: [{ required: ['blockId'] }, { required: ['blockType'] }] },
    //                     { anyOf: [{ required: ['fields'] }, { required: ['extraState'] }] }
    //                 ]
    //             }
    //         ]
    //     }
    // },
    // {
    //     name: "delete_block_tool",
    //     description: `块删除工具，支持删除单个或多个块。
    // **注意**：严禁直接进行删除操作，避免删除后重新创建相同代码块的操作，确保每次删除都是经过深思熟虑的决定。
    // **注意**：优先使用块创建工具及连接工具修复代码结构。
    // 
    // **功能特点**：
    // - 支持单个块ID或多个块ID数组输入
    // - 智能删除：只删除指定块，保留连接的块并自动重连
    // - 删除后自动重连前后块（如果可能）
    // 
    // **示例**：
    // \`\`\`json
    // // 删除单个块
    // {"blockIds": "block_id_123"}
    // 
    // // 删除多个块
    // {"blockIds": ["block_id_1", "block_id_2", "block_id_3"]}
    // \`\`\`
    // 
    // **注意**：被删除块的前后块会尝试自动重连，连接的子块会保留。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             blockIds: {
    //                 oneOf: [
    //                     { type: 'string', description: '单个要删除的块ID' },
    //                     { type: 'array', items: { type: 'string' }, description: '要删除的块ID数组' }
    //                 ],
    //                 description: '要删除的块ID，支持单个字符串或字符串数组'
    //             }
    //         },
    //         required: ['blockIds']
    //     }
    // },
    // =============================================================================
    // ABS 工具（Aily Block Syntax - 主要块操作方式）
    // =============================================================================
    {
        name: "sync_abs_file",
        description: `🔄 ABS 文件同步工具 - 在 Blockly 工作区和 ABS 文件之间同步。

**项目中的 ABS 文件（Aily Block Syntax）：**
每个项目目录下会有一个 \`project.abs\` 文件，以人类可读的 ABS 格式保存代码结构。

**操作类型：**
1. \`export\` - 将当前 Blockly 工作区导出为 ABS 文件
2. \`import\` - 从 ABS 文件导入并替换当前工作区
3. \`status\` - 获取 ABS 文件状态和内容预览

**推荐工作流：**
1. 首先使用 \`status\` 或 \`export\` 获取/生成 ABS 文件
2. 使用 \`read_file\` 读取 \`project.abs\` 了解当前代码结构
3. 使用 \`edit_file\` 修改 ABS 文件（像编辑普通代码一样！）
4. 使用 \`import\` 将修改应用到 Blockly 工作区

**这种方式的优势：**
- 📖 直接看到完整的代码结构
- ✏️ 用熟悉的文件编辑方式修改代码
- 🔄 支持撤销和版本控制
- 🎯 避免复杂的位置计算`,
        input_schema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['export', 'import', 'status'],
                    description: '操作类型：export=导出到ABS文件，import=从ABS文件导入，status=查看状态'
                },
                includeHeader: {
                    type: 'boolean',
                    description: '导出时是否包含文件头注释（默认 true）',
                    default: true
                }
            },
            required: ['operation']
        }
    },
//     {
//         name: "abs_version_control",
//         description: `🕐 ABS 版本控制工具 - 管理 Blockly 代码的版本历史。

// **操作类型：**
// 1. \`list\` - 列出所有版本历史
// 2. \`get\` - 获取指定版本的内容
// 3. \`rollback\` - 回滚到指定版本
// 4. \`save\` - 手动保存当前版本（带描述）

// **使用场景：**
// - 修改代码前先保存版本，方便回滚
// - 查看历史版本对比差异
// - 恢复到之前的代码状态`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 operation: {
//                     type: 'string',
//                     enum: ['list', 'get', 'rollback', 'save'],
//                     description: '操作类型：list=列出版本，get=获取内容，rollback=回滚，save=保存新版本'
//                 },
//                 versionId: {
//                     type: 'string',
//                     description: '版本 ID（get 和 rollback 操作时必需）'
//                 },
//                 description: {
//                     type: 'string',
//                     description: '版本描述（save 操作时使用）'
//                 }
//             },
//             required: ['operation']
//         }
//     },
    // {
    //     name: "variable_manager_tool",
    //     description: `变量管理工具。创建、删除、重命名工作区中的变量。支持不同类型的变量和作用域管理。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             operation: {
    //                 type: 'string',
    //                 enum: ['create', 'delete', 'rename', 'list'],
    //                 description: '操作类型：create=创建，delete=删除，rename=重命名，list=列出所有变量'
    //             },
    //             variableName: {
    //                 type: 'string',
    //                 description: '变量名（create、delete、rename时必需）'
    //             },
    //             newName: {
    //                 type: 'string',
    //                 description: '新变量名（rename时必需）'
    //             },
    //             variableType: {
    //                 type: 'string',
    //                 description: '变量类型，如String、Number、Boolean等',
    //                 default: 'String'
    //             }
    //         },
    //         required: ['operation']
    //     }
    // },
    // {
    //     name: "find_block_tool",
    //     description: `块查找工具。在工作区中查找特定的块，支持多种查找条件：块类型、字段值、位置等。返回匹配的块信息。`,
    //     input_schema: {
    //         type: 'object', 
    //         properties: {
    //             criteria: {
    //                 type: 'object',
    //                 properties: {
    //                     type: { type: 'string', description: '块类型' },
    //                     fields: { type: 'object', description: '字段值匹配' },
    //                     position: { 
    //                         type: 'object',
    //                         properties: {
    //                             x: { type: 'number' },
    //                             y: { type: 'number' },
    //                             tolerance: { type: 'number', description: '位置容差' }
    //                         },
    //                         description: '位置匹配'
    //                     },
    //                     connected: { type: 'boolean', description: '是否已连接' }
    //                 },
    //                 description: '查找条件'
    //             },
    //             limit: {
    //                 type: 'number',
    //                 description: '返回结果数量限制',
    //                 default: 10
    //             },
    //             includeMetadata: {
    //                 type: 'boolean',
    //                 description: '是否包含详细元数据',
    //                 default: false
    //             }
    //         },
    //         required: ['criteria']
    //     }
    // },
    // 🔇 delete_block_tool 已被 DSL 工具替代（删除 DSL 中的行即可）
    // {
    //     name: "delete_block_tool",
    //     description: `块删除工具，支持删除单个或多个块。
    // **注意**：严禁直接进行删除操作，避免删除后重新创建相同代码块的操作，确保每次删除都是经过深思熟虑的决定。
    // **注意**：优先使用块创建工具及连接工具修复代码结构。
    // 
    // **功能特点**：
    // - 支持单个块ID或多个块ID数组输入
    // - 智能删除：只删除指定块，保留连接的块并自动重连
    // - 删除后自动重连前后块（如果可能）
    // 
    // **示例**：
    // \`\`\`json
    // // 删除单个块
    // {"blockIds": "block_id_123"}
    // 
    // // 删除多个块
    // {"blockIds": ["block_id_1", "block_id_2", "block_id_3"]}
    // \`\`\`
    // 
    // **注意**：被删除块的前后块会尝试自动重连，连接的子块会保留。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             blockIds: {
    //                 oneOf: [
    //                     { type: 'string', description: '单个要删除的块ID' },
    //                     { type: 'array', items: { type: 'string' }, description: '要删除的块ID数组' }
    //                 ],
    //                 description: '要删除的块ID，支持单个字符串或字符串数组'
    //             }
    //         },
    //         required: ['blockIds']
    //     }
    // },
    {
        name: "get_workspace_overview_tool",
        description: `工作区全览分析工具。提供工作区的完整分析，包括结构分析、代码生成、复杂度评估、连接关系和树状结构展示。支持多种输出格式：JSON、Markdown、详细报告和控制台输出。`,
        input_schema: {
            type: 'object',
            properties: {
                outputFormat: {
                    type: 'string',
                    enum: ['json', 'markdown', 'detailed', 'console'],
                    description: '输出格式',
                    default: 'console'
                },
                includeCode: {
                    type: 'boolean',
                    description: '是否包含生成的C++代码',
                    default: true
                },
                includeStructure: {
                    type: 'boolean',
                    description: '是否包含结构分析',
                    default: true
                },
                includeConnections: {
                    type: 'boolean',
                    description: '是否包含连接关系分析',
                    default: true
                },
                includeComplexity: {
                    type: 'boolean',
                    description: '是否包含复杂度分析',
                    default: true
                },
                maxDepth: {
                    type: 'number',
                    description: '树状结构的最大深度',
                    default: 10
                },
                showDetails: {
                    type: 'boolean',
                    description: '是否显示详细信息',
                    default: false
                }
            },
            required: []
        }
    },
//     {
//         name: "queryBlockDefinitionTool",
//         description: `查询项目中所有库的块定义信息。
        
// ## 功能特点
// - **动态扫描**: 自动扫描当前项目的 node_modules/@aily-project/lib-* 目录中的 block.json 文件
// - **缓存优化**: 内置缓存机制，避免重复文件读取
// - **灵活查询**: 支持按块类型、块ID或关键词进行过滤查询
// - **兼容性分析**: 可查询特定块的连接类型和兼容性信息

// ## 使用场景
// - 查找可用的块类型和定义
// - 分析块之间的连接兼容性
// - 获取块的输入输出配置信息
// - 调试块连接问题

// ## 查询选项
// - **blockType**: 按特定块类型筛选
// - **searchKeyword**: 按关键词搜索块ID或描述
// - **includeInputs**: 是否包含输入配置详情
// - **includeOutputs**: 是否包含输出配置详情
// - **compatibilityCheck**: 检查与指定块的兼容性`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockType: {
//                     type: 'string',
//                     description: '要查询的特定块类型（可选，用于筛选）'
//                 },
//                 library: {
//                     type: 'string',
//                     description: '要查询的特定库名（可选，用于筛选）'
//                 },
//                 connectionType: {
//                     type: 'string',
//                     enum: ['input_statement', 'input_value', 'previousStatement', 'nextStatement', 'output'],
//                     description: '要查询的连接类型（可选）'
//                 },
//                 refresh: {
//                     type: 'boolean',
//                     description: '是否强制刷新缓存',
//                     default: false
//                 },
//                 useRealData: {
//                     type: 'boolean',
//                     description: '是否使用真实数据（需要文件读取）',
//                     default: false
//                 },
//                 scanFiles: {
//                     type: 'boolean',
//                     description: '是否扫描实际文件系统',
//                     default: true
//                 }
//             },
//             required: []
//         }
//     },
//     {
//         name: "getBlockConnectionCompatibilityTool",
//         description: `分析块之间的连接兼容性，帮助解决块连接问题。

// ## 功能特点
// - **连接类型分析**: 详细分析输入输出的连接类型（value、statement等）
// - **兼容性检查**: 检查两个块之间是否可以连接
// - **连接建议**: 为连接失败提供解决方案和替代连接方式
// - **类型映射**: 显示Blockly连接类型的详细信息

// ## 使用场景
// - 调试块连接失败问题
// - 查找可连接的块类型
// - 分析连接类型不匹配的原因
// - 获取连接建议和替代方案

// ## 分析维度
// - **输入类型分析**: 分析目标块可接受的输入类型
// - **输出类型分析**: 分析源块的输出类型
// - **类型兼容性**: 检查类型是否匹配
// - **连接建议**: 提供连接方案`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 sourceBlockType: {
//                     type: 'string',
//                     description: '源块类型（要连接出去的块）'
//                 },
//                 targetBlockType: {
//                     type: 'string',
//                     description: '目标块类型（要连接到的块）'
//                 },
//                 library: {
//                     type: 'string',
//                     description: '库名（可选，用于筛选特定库）'
//                 }
//             },
//             required: ['sourceBlockType', 'targetBlockType']
//         }
//     },
    {
        name: "todo_write_tool",
        description: `Manage a structured todo list to track progress and plan tasks.

Task states: not-started | in-progress (limit ONE) | completed

Workflow: plan todos → mark in-progress → do work → mark completed → next

Operations:
- **update**: 全量替换todo列表（传入完整的todos数组，替换当前所有任务）
- **add**: 追加任务（传todos数组追加，或传content追加单个任务）
- **toggle**: 切换任务状态（需id）
- **list**: 查看当前任务列表
- **delete**: 删除指定任务（需id）
- **clear**: 清空所有任务

IMPORTANT: update是全量替换，必须包含所有任务。只想添加新任务时用add。Mark todos completed as soon as they are done.`,
        input_schema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['update', 'add', 'toggle', 'list', 'delete', 'clear'],
                    description: '操作类型'
                },
                sessionId: {
                    type: 'string',
                    description: '会话ID',
                    default: 'default'
                },
                content: {
                    type: 'string',
                    description: '任务内容（add单项时使用，也接受title字段）'
                },
                status: {
                    type: 'string',
                    enum: ['not-started', 'in-progress', 'completed'],
                    description: '任务状态'
                },
                priority: {
                    type: 'string',
                    enum: ['high', 'medium', 'low'],
                    description: '任务优先级',
                    default: 'medium'
                },
                id: {
                    type: 'number',
                    description: '任务ID（delete时必需）'
                },
                todos: {
                    type: 'array',
                    description: '任务数组（update时全量替换，add时追加）',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'number', description: '任务ID' },
                            content: { type: 'string', description: '任务内容（也接受title）' },
                            status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'] },
                            priority: { type: 'string', enum: ['high', 'medium', 'low'] }
                        },
                        required: ['content']
                    }
                }
            },
            required: ['operation']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'analyze_library_blocks',
        description: `分析指定库的块定义，生成 ABS (Aily Block Syntax) 格式的块定义文档。优先使用read_file工具读取库readme，当库对应的 readme 不存在或描述不准确时，使用此工具补充和完善库的文档说明。`,
        input_schema: {
            type: 'object',
            properties: {
                libraryNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要分析的库名称列表，如 ["@aily-project/lib-blinker", "@aily-project/lib-sensor"]'
                }
            },
            required: ['libraryNames']
        },
        agents: ["mainAgent"]
    },
    // {
    //     name: 'get_abs_syntax',
    //     description: `Get the ABS (Aily Block Syntax) syntax specification. Returns a concise but complete reference for writing ABS code. Use this tool when you need to understand ABS syntax rules, block connection types, parameter mapping, or control flow structures before generating ABS code.`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {},
    //         required: []
    //     },
    //     agents: ["mainAgent"]
    // },
    // =============================================================================
    // 硬件接线图工具 (Schematic / Wiring Diagram)
    // =============================================================================
    {
        name: 'generate_schematic',
        description: `生成硬件接线图的核心工具。分析开发板与外设的引脚映射，返回引脚摘要和生成规则。你需要根据返回内容编写 AWS (Aily Wiring Syntax) 连线，再调用 validate_schematic 完成验证、保存与刷新。

**完整工作流：**
1. （可选）不知道有哪些组件可用时，先调用 get_project_context 获取项目上下文和 pinmapId
2. 调用本工具，传入 pinmapIds
3. 工具返回引脚摘要，你根据此编写 AWS 连线内容
4. 调用 validate_schematic(aws: "...") 验证 + 保存 + 刷新（最终步骤）

**触发时机：** 用户说"帮我接线"、"怎么接 DHT20"、"生成接线图"、"连接传感器"等

**组件类型：**
- **硬件组件**（传感器、显示屏、执行器）：有物理引脚，需分配引脚并生成连线
- **软件组件**（WiFi/MQTT/HTTP）：无物理引脚，以信息卡片形式展示

**多实例（同型号多个）：** 使用对象格式指定别名
\`{ "id": "lib-dht:dht20:asair", "alias": "dht_indoor", "label": "室内" }\`

**软件组件 JSON 格式：**
\`\`\`json
{
  "refId": "wifi", "componentId": "WiFi", "componentName": "WiFi 连接",
  "pinmapId": "lib-wifi:default:default", "componentType": "software",
  "softwareConfig": { "libraryType": "wifi", "icon": "wifi", "properties": { "ssid": "MyNetwork" } }
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                pinmapIds: {
                    type: 'array',
                    description: `组件的 pinmapId 列表。支持两种格式：
- 字符串：\`"lib-dht:dht20:asair"\`
- 对象（多实例/自定义别名）：\`{ "id": "lib-dht:dht20:asair", "alias": "dht_indoor", "label": "室内温湿度" }\``,
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: 'pinmapId 完整标识符' },
                                    alias: { type: 'string', description: '别名，用作 refId，如 "dht_indoor"' },
                                    label: { type: 'string', description: '显示名称，如 "室内温湿度"' }
                                },
                                required: ['id']
                            }
                        ]
                    }
                },
                components: {
                    type: 'array',
                    description: '（旧版兼容）组件简称列表，优先使用 pinmapIds。',
                    items: { type: 'string' }
                },
                requirements: {
                    type: 'string',
                    description: '特殊连接需求，如"DHT20 用 3.3V 供电"、"舵机接 D0"等'
                }
            },
            required: []
        },
        agents: ["schematicAgent"]
    },
    {
        name: 'get_pinmap_summary',
        description: `**已废弃** — generate_schematic 内部已包含完整引脚摘要，通常无需单独调用此工具。`,
        input_schema: {
            type: 'object',
            properties: {
                pinmapIds: {
                    type: 'array',
                    description: '要查询的组件 pinmapId 列表（如 ["lib-dht:dht20:asair"]）。如果为空则返回当前开发板的引脚摘要。',
                    items: { type: 'string' }
                }
            },
            required: []
        },
        agents: ["schematicAgent"]
    },
    {
        name: 'get_component_catalog',
        description: `获取当前项目的组件目录：开发板 + 已安装的传感器/外设库 + 软件库，列出所有可用型号和 pinmapId。

**⭐ 连线流程第一步：** 在生成接线图前，先调用本工具了解项目中有哪些组件可用。

**在以下情况调用：**
- 开始连线任务时，获取项目的完整组件列表
- 用户没有指定具体型号，需要先看看有哪些可用
- 不确定某个组件的 pinmapId 格式

**返回数据：**
1. **currentBoard**（当前开发板）：开发板的 pinmap 状态和 pinmapId
   - \`catalogStatus: "available"\`：有 pinmap_catalog.json，包含 models/variants
   - \`catalogStatus: "legacy_pinmap"\`：使用旧版 pinmap.json，可直接使用
   - \`catalogStatus: "missing"\`：缺少 pinmap 配置，需用 generate_pinmap 生成
2. **catalogs**（传感器/外设库）：型号列表 + 变体 + pinmapId。状态 \`available\` 可直接用于 generate_schematic
3. **softwareLibraries**（软件库）：WiFi/MQTT/HTTP 等，无物理引脚，用 \`{packageSlug}:default:default\` 作为 pinmapId
4. **librariesMissingCatalog**（缺少配置的库）：需用 generate_pinmap 生成配置`,
        input_schema: {
            type: 'object',
            properties: {
                libraryFilter: {
                    type: 'string',
                    description: '可选，只返回指定库的目录（库的 packageSlug，如 "lib-dht"、"lib-u8g2"）'
                },
                includeNeedsGeneration: {
                    type: 'boolean',
                    description: '是否包含需要生成 pinmap 的项目（status=needs_generation）',
                    default: true
                },
                includeBoards: {
                    type: 'boolean',
                    description: '是否包含当前项目开发板的 pinmap catalog 信息（推荐设为 true）',
                    default: true
                }
            },
            required: []
        },
        agents: ["schematicAgent"]
    },
    {
        name: 'get_project_context',
        description: `一次获取项目上下文 + 组件目录，合并了 get_context 和 get_component_catalog 的功能。

**⭐ 连线流程第一步：** 替代原先需要依次调用 get_context + get_component_catalog 的两步操作。

**返回数据：**
1. **project**：项目路径、名称、开发板、已安装库列表
2. **cppCode**：当前 Blockly 生成的 C++ 代码（用于推断硬件外设需求）
3. **currentBoard**：开发板的 pinmap 状态和 pinmapId
4. **catalogs**：传感器/外设库的型号列表 + pinmapId
5. **softwareLibraries**：软件库（WiFi/MQTT 等，无物理引脚）
6. **librariesMissingCatalog**：缺少 catalog 的库（需用 generate_pinmap 生成）`,
        input_schema: {
            type: 'object',
            properties: {
                includeNeedsGeneration: {
                    type: 'boolean',
                    description: '是否包含需要生成 pinmap 的项目（status=needs_generation）',
                    default: true
                }
            },
            required: []
        },
        agents: ["schematicAgent"]
    },
    {
        name: 'validate_schematic',
        description: `验证 AWS 接线图并保存。这是连线工作流的**最终步骤**，集验证 + 保存 + 刷新为一体。

**功能：**
- 解析 AWS 语法，检查引脚、冲突、电压等安全问题
- 验证通过后自动保存 connection.aws 和 connection_output.json
- 自动通知接线图界面刷新

**调用时机：** generate_schematic 返回引脚摘要后，你编写 AWS 连线后调用本工具作为最终步骤。

**推荐流程：**
1. **get_project_context()**：获取项目上下文 + 组件目录
2. **generate_schematic(pinmapIds: [...])**：获取引脚摘要
3. **你编写 AWS 连线**
4. **validate_schematic(aws: "...")**：验证 + 保存 + 刷新（最终步骤）`,
        input_schema: {
            type: 'object',
            properties: {
                aws: {
                    type: 'string',
                    description: 'AWS (Aily Wiring Syntax) 格式的接线描述。'
                }
            },
            required: []
        },
//         description: `验证并保存接线图。支持 JSON 和 AWS 两种格式输入。

// **JSON 格式：** 通过 connection_data 参数传入完整 JSON
// **AWS 格式：** 通过 aws 参数传入 AWS (Aily Wiring Syntax) 语法

// **调用时机：** generate_schematic 返回引脚摘要后，你生成连线后调用本工具。

// **推荐流程：**
// 1. **get_context()**：获取当前项目和库的上下文信息，了解当前项目实际使用的开发板和组件
// 2. **get_component_catalog(includeBoards: true)**：获取开发板 + 组件的 pinmapId 列表
// 3. **generate_schematic(pinmapIds: [...])**：获取引脚摘要和连线规则
// 4. **你生成连线**：输出 AWS 格式或 JSON 格式
// 5. **validate_schematic**：验证并保存`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 connection_data: {
//                     type: 'object',
//                     description: 'JSON 格式的接线图数据（符合 connection_output.json 格式）。与 aws 参数二选一。'
//                 },
//                 aws: {
//                     type: 'string',
//                     description: 'AWS (Aily Wiring Syntax) 格式的接线描述。与 connection_data 参数二选一。'
//                 }
//             },
//             required: []
//         },
        agents: ["schematicAgent"]
    },
    // {
    //     name: 'apply_schematic',
    //     description: `**已废弃** — 请直接使用 validate_schematic，它已包含验证 + 保存 + 刷新的完整功能。调用本工具会自动转发到 validate_schematic。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             aws: {
    //                 type: 'string',
    //                 description: '可选。直接传入 AWS 内容（首次生成时使用）。不传则从项目中的 connection.aws 文件读取。'
    //             }
    //         },
    //         required: []
    //     },
    //     agents: ["schematicAgent"]
    // },
    {
        name: 'get_current_schematic',
        description: `读取当前项目已保存的连线图完整内容。

**用于编辑流程：** 用户想修改/添加/删除连线时，先调用本工具获取当前状态，然后编写新的 AWS 内容，调用 validate_schematic 验证并保存。

**典型编辑场景：**
- “删除 DHT20 的 VCC 连线”
- “把舍口改接到 D3 引脚”
- “再添加一个 LED”

**编辑流程：**
1. **get_current_schematic()**：获取当前连线图数据
2. **修改连线**：基于当前连线信息编写新的 AWS 格式内容
   - 新增组件时：先调用 generate_schematic 获取新组件引脚信息
3. **validate_schematic(aws: "修改后的AWS内容")**：验证 + 保存 + 刷新（最终步骤）`,
        input_schema: {
            type: 'object',
            properties: {},
            required: []
        },
        agents: ["mainAgent", "schematicAgent"]
    },
    {
        name: 'generate_pinmap',
        description: `为缺少引脚配置的组件（开发板、传感器、模块等任意类型）准备生成素材。返回 README、示例代码和 pinmap 模板，供你生成 pinmap JSON，再调用 save_pinmap 保存。

**适用范围：** 开发板、传感器、执行器、显示屏、模块——任何需要 pinmap 的组件均可使用本工具。

**触发条件（满足其一即可）：**
- get_component_catalog 返回变体 \`status: "needs_generation"\`
- get_component_catalog 返回库 \`catalogStatus: "missing_catalog"\`
- 用户明确要求为某个开发板或组件生成 / 更新 pinmap

**流程：** get_component_catalog（可选）→ 本工具（获取素材）→ 你生成 pinmap JSON → save_pinmap`,
        input_schema: {
            type: 'object',
            properties: {
                pinmapId: {
                    type: 'string',
                    description: '目标组件的 fullId。传感器/模块示例：`"lib-servo:sg90:default"`；开发板示例：`"board-xiao_esp32s3:xiao_esp32s3:default"`'
                },
                referenceSource: {
                    type: 'string',
                    enum: ['readme', 'example', 'auto'],
                    description: '参考信息来源，默认 auto（自动收集所有可用信息）',
                    default: 'auto'
                }
            },
            required: ['pinmapId']
        },
        agents: ["schematicAgent"]
    },
    {
        name: 'save_pinmap',
        description: `保存你生成的 pinmap JSON 到库目录，并自动创建/更新 pinmap_catalog.json，将状态置为 "available"。配合 generate_pinmap 使用，是该流程的最后一步。`,
        input_schema: {
            type: 'object',
            properties: {
                pinmapId: {
                    type: 'string',
                    description: '目标组件的 fullId（如 "lib-servo:sg90:default"）'
                },
                pinmapConfig: {
                    type: 'object',
                    description: '完整的 pinmap 配置 JSON（ComponentConfig 格式，包含 id, name, width, height, images, pins, functionTypes 字段）'
                }
            },
            required: ['pinmapId', 'pinmapConfig']
        },
        agents: ["schematicAgent"]
    },
    // =============================================================================
    // 编译工具
    // =============================================================================
    {
        name: 'build_project',
        description: `编译当前项目，检测代码是否能正常编译通过。用于代码编写完成后验证语法和链接是否正确。编译耗时较长（可能数十秒到数分钟），请仅在需要验证时调用。

如果编译出现异常（如缓存损坏、切换开发板后残留旧缓存），可设置 clear_cache=true 在编译前清除缓存。`,
        input_schema: {
            type: 'object',
            properties: {
                preprocess_only: {
                    type: 'boolean',
                    description: '是否仅做预编译检查（更快但不生成完整产物，且为异步操作不会返回编译结果）',
                    default: false
                },
                clear_cache: {
                    type: 'boolean',
                    description: '编译前是否清除编译缓存（解决缓存损坏或切换开发板后的残留问题）',
                    default: false
                }
            },
            required: []
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 重新加载工具
    // =============================================================================
    {
        name: 'reload_project',
        description: `重新加载当前项目。在修改了库相关的JS文件（如块定义、生成器等）后调用，使修改生效。会先保存项目再重新加载。`,
        input_schema: {
            type: 'object',
            properties: {},
            required: []
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 切换开发板工具
    // =============================================================================
    {
        name: 'switch_board',
        description: `在当前项目中切换开发板。需要提供新的开发板包名称（如 "@aily-project/board-esp32_devkitc"）。
切换过程会自动卸载当前开发板包、安装新开发板包、更新项目配置并重新加载项目。

注意：
- 切换开发板会重置编译缓存
- 项目中非开发板相关的依赖库会被保留
- 如果不确定开发板名称，可先使用 search_boards_libraries 工具搜索`,
        input_schema: {
            type: 'object',
            properties: {
                board_name: {
                    type: 'string',
                    description: '开发板包名称，如 "@aily-project/board-esp32_devkitc"、"@aily-project/board-arduino_uno"'
                },
                board_version: {
                    type: 'string',
                    description: '开发板包版本号（可选，不指定则使用最新版）'
                }
            },
            required: ['board_name']
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 获取开发板编译/烧录配置
    // =============================================================================
    {
        name: 'get_board_config',
        description: `获取当前开发板的编译/烧录配置选项及其当前值。

返回信息包括：
- 当前开发板名称和类型
- 所有可配置项及其可选值（如上传速度、Flash模式、Flash大小、分区方案等）
- 每个配置项的当前选中值

支持的开发板配置：
- **ESP32**: 上传速度(UploadSpeed)、上传模式(UploadMode)、Flash模式(FlashMode)、Flash大小(FlashSize)、分区方案(PartitionScheme)、CDC启动(CDCOnBoot)、PSRAM
- **STM32**: 开发板型号(pnum)、USB配置(usb)
- **nRF5**: SoftDevice

如果当前开发板没有额外配置选项（如 Arduino UNO），会返回空列表。`,
        input_schema: {
            type: 'object',
            properties: {},
            required: []
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 设置开发板编译/烧录配置
    // =============================================================================
    {
        name: 'set_board_config',
        description: `修改当前开发板的编译/烧录配置项。需先通过 get_board_config 工具获取可用的配置项和可选值。

使用方式：
1. 先调用 get_board_config 获取当前配置和可选值
2. 根据返回的 config_key 和 options 中的 value，调用此工具设置

示例：
- 设置ESP32上传速度: set_board_config({ config_key: "UploadSpeed", config_value: "921600" })
- 设置Flash大小: set_board_config({ config_key: "FlashSize", config_value: "16M" })
- 设置分区方案: set_board_config({ config_key: "PartitionScheme", config_value: "default" })

注意：配置变更后会自动触发预编译检查。`,
        input_schema: {
            type: 'object',
            properties: {
                config_key: {
                    type: 'string',
                    description: '配置项键名（从 get_board_config 返回的 config_key），如 UploadSpeed, FlashMode, FlashSize, PartitionScheme 等'
                },
                config_value: {
                    type: 'string',
                    description: '配置项的值（从 get_board_config 返回的 options 中的 value），如 "921600", "qio", "16M"'
                }
            },
            required: ['config_key', 'config_value']
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 记忆工具 — 持久化笔记存储（参考 Copilot memory 工具）
    // =============================================================================
    {
        name: 'memory',
        description: `持久化记忆工具 — 跨会话保存和读取笔记、偏好、项目约定等信息。

两层作用域：
- **project**: 项目记忆，存储在项目根目录的 aily.md 中。记录项目特定的约定、架构决策、常见问题等。
- **global**: 全局记忆，跨项目持久化。记录用户偏好、通用模式、经验教训等。

**何时使用：**
- 用户明确要求"记住"某些偏好或约定时
- 发现重要的项目模式/约定需要记录时
- 遇到反复出现的问题，记录解决方案
- 读取之前保存的上下文以提供连续的协助体验

**不要滥用：** 不要每次对话都写入，只记录真正有价值的持久化知识。`,
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    enum: ['read', 'write', 'append', 'replace', 'clear'],
                    description: '操作命令: read=读取, write=覆写, append=追加, replace=精确替换, clear=清空'
                },
                scope: {
                    type: 'string',
                    enum: ['project', 'global'],
                    description: '作用域: project=项目级(aily.md), global=全局级(跨项目)'
                },
                content: {
                    type: 'string',
                    description: 'write/append 时的内容'
                },
                old_text: {
                    type: 'string',
                    description: 'replace 时要替换的旧文本'
                },
                new_text: {
                    type: 'string',
                    description: 'replace 时的新文本'
                }
            },
            required: ['command', 'scope']
        },
        agents: ["mainAgent"]
    },
    // =============================================================================
    // 错误诊断工具（参考 Copilot get_errors）
    // =============================================================================
    {
        name: 'get_errors',
        description: `获取当前项目或指定文件的错误诊断信息。整合 lint 错误和编译错误，一次性返回所有已知问题。

数据来源：
1. **Lint 错误**: JSON/JS 文件的语法检查
2. **编译错误**: 上次 build_project 的编译结果

适合场景：
- 编辑文件后快速检查是否引入错误
- 编译失败后分析具体错误原因
- 修复错误前先了解全部问题再一次性修复

注意：编译错误来自上次 build_project 的缓存结果，如果代码已修改建议重新编译。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要检查的文件路径（可选，不指定则检查整个项目关键文件）'
                },
                include_lint: {
                    type: 'boolean',
                    description: '是否包含 lint 错误',
                    default: true
                },
                include_build: {
                    type: 'boolean',
                    description: '是否包含上次编译错误',
                    default: true
                }
            },
            required: []
        },
        agents: ["mainAgent"]
    },
    // {
    //     name: 'verify_block_existence',
    //     description: `验证指定块是否存在于指定库中。快速检查块的可用性，避免使用不存在的块类型。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             blockTypes: {
    //                 type: 'array',
    //                 items: { type: 'string' },
    //                 description: '要验证的块类型列表，如 ["blinker_run", "sensor_read_temperature"]'
    //             },
    //             libraryNames: {
    //                 type: 'array',
    //                 items: { type: 'string' },
    //                 description: '要搜索的库名称列表，如 ["@aily-project/lib-blinker"]'
    //             },
    //             includeAlternatives: {
    //                 type: 'boolean',
    //                 default: true,
    //                 description: '如果块不存在，是否建议替代方案'
    //             }
    //         },
    //         required: ['blockTypes', 'libraryNames']
    //     }
    // }
    // =============================================================================
    // 扁平化块创建工具（推荐）
    // =============================================================================
//     {
//         name: "flat_create_blocks",
//         description: `【推荐】扁平化批量创建 Blockly 块 - 支持智能拆分嵌套结构
// <system-reminder>使用工具前必须确保已经读取了将要使用的block所属库的Readme。
// **注意事项**：
// - 一个block(id)包含的块(type)严禁超过5个，超过请分多次创建。
// - 严禁一次性生成全部代码块，建议分多次调用，每次创建少量块。
// - 创建代码步骤：全局变量 → 初始化（arduino_setup）→ 主循环（arduino_loop）→ 回调函数</system-reminder>

// 🧠 **智能拆分功能**：
// - 工具会自动检测嵌套结构（如 controls_ifelse 中的 inputs.IF0.block）
// - 自动将嵌套块提取为独立块并生成连接规则
// - 即使 JSON 结构有轻微错误也能正确处理

// **块定义格式**（与 smart_block_tool 相同）:
// \`\`\`json
// {
//   "id": "b1",
//   "type": "io_digitalwrite",
//   "inputs": {
//     "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
//     "STATE": { "shadow": { "type": "io_state", "fields": {"STATE": "HIGH"}}}
//   }
// }
// \`\`\`

// **连接格式**:
// - \`"b1 -> arduino_setup"\` - 语句块放入容器（自动检测 input_statement）
// - \`"b1 -> b2:next"\` - 顺序连接（b1 接在 b2 后面）
// - \`"b3 -> b2:VALUE"\` - 值输入连接（b3 连接到 b2 的 VALUE 输入）
// - \`"b1 -> if_block:DO0"\` - 语句输入连接（b1 放入 if 块的第一个执行分支）
// - 不提供连接规则的块将成为工作区中的独立块

// ⚠️ **重要：输入名称是扁平的，不支持嵌套路径！**
// - ✅ 正确: \`"b1 -> if_block:DO0"\`, \`"b2 -> if_block:DO1"\`, \`"b3 -> if_block:ELSE"\`
// - ❌ 错误: \`"b1 -> if_block:ELSE:IF0:DO0"\`（不支持嵌套路径）

// **controls_ifelse 输入名称规则**（extraState: {elseIfCount: N}）:
// - IF0/DO0: 第一个 if 条件和执行体
// - IF1/DO1, IF2/DO2...: else if 分支（按 elseIfCount 数量）
// - ELSE: else 分支执行体

// **示例 - 温度读取+串口打印**:
// \`\`\`json
// {
//   "blocks": [
//     {"id": "b1", "type": "dht_begin", "fields": {"VAR": "dht", "PIN": "2", "TYPE": "DHT11"}},
//     {"id": "b2", "type": "serial_begin", "fields": {"SERIAL": "Serial", "SPEED": "9600"}},
//     {"id": "b3", "type": "dht_read_temperature", "fields": {"VAR": "dht"}},
//     {"id": "b4", "type": "serial_println", "fields": {"SERIAL": "Serial"}}},
//     {"id": "b5", "type": "delay_ms", "inputs": {"TIME": {"shadow": {"type": "math_number", "fields": {"NUM": "2000"}}}}}
//   ],
//   "connections": [
//     "b1 -> arduino_setup",
//     "b2 -> b1:next",
//     "b3 -> arduino_loop",
//     "b3 -> b4:VAR",
//     "b4 -> b3:next",
//     "b5 -> b4:next"
//   ]
// }
// \`\`\`

// **动态块 extra**: \`controls_if\`: {"elseIfCount": N, "hasElse": true}, \`text_join/lists_create_with\`: {"itemCount": N}`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blocks: {
//                     type: 'array',
//                     description: '块定义数组，格式与 smart_block_tool 完全相同',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             id: { type: 'string', description: '临时ID（如 "b1", "b2"）' },
//                             type: { type: 'string', description: '块类型' },
//                             fields: { type: 'object', description: '字段值' },
//                             inputs: { type: 'object', description: '输入配置，与 smart_block_tool 格式相同' },
//                             extra: { type: 'object', description: '动态块配置: itemCount, elseIfCount, hasElse' }
//                         },
//                         required: ['id', 'type']
//                     }
//                 },
//                 connections: {
//                     type: 'array',
//                     description: '连接规则: "源ID -> 目标ID" 或 "源ID -> 目标ID:输入名"。不提供连接规则的块将成为独立块',
//                     items: { type: 'string' }
//                 }
//             },
//             required: ['blocks']
//         }
//     }
    // =============================================================================
    // DSL 块创建工具
    // =============================================================================
//     {
//         name: 'dsl_create_blocks',
//         description: `使用 YAML-Like DSL 语法创建 Blockly 块 - 最简洁的块创建方式

// **语法格式**：
// \`\`\`yaml
// setup:
//   - 块类型 参数1 参数2 ...
//   - 变量 = 块类型 参数...

// loop:
//   - 块类型 参数...
//   - if 条件:
//       - 块类型 参数...
//     else:
//       - 块类型 参数...
// \`\`\`

// **核心规则**：
// 1. \`setup:\` 和 \`loop:\` 定义代码区域
// 2. \`-\` 开头表示一个块
// 3. 参数按顺序自动映射到字段
// 4. \`变量 = 块类型\` 用于赋值/引用
// 5. 缩进表示嵌套（语句输入）

// **示例1 - 基础串口**：
// \`\`\`yaml
// setup:
//   - serial_begin Serial 9600

// loop:
//   - serial_println Serial "Hello"
//   - time_delay 1000
// \`\`\`

// **示例2 - DHT 温度传感器**：
// \`\`\`yaml
// setup:
//   - serial_begin Serial 9600
//   - dht_init dht DHT22 2

// loop:
//   - temp = dht_read_temperature dht
//   - serial_println Serial temp
//   - time_delay 2000
// \`\`\`

// **示例3 - 条件判断**：
// \`\`\`yaml
// setup:
//   - dht_init dht DHT22 2

// loop:
//   - temp = dht_read_temperature dht
//   - if temp > 30:
//       - io_digitalwrite 13 HIGH
//     else:
//       - io_digitalwrite 13 LOW
//   - time_delay 1000
// \`\`\`

// **示例4 - 带回调的块**：
// \`\`\`yaml
// setup:
//   - mqtt_connect broker="192.168.1.1" port=1883:
//       on_connect:
//         - mqtt_subscribe "sensor/data"
//       on_message:
//         - serial_println Serial $payload

// loop:
//   - mqtt_loop
//   - time_delay 100
// \`\`\`

// **常用块类型**：
// | 块类型 | 参数 | 说明 |
// |--------|------|------|
// | serial_begin | Serial 波特率 | 初始化串口 |
// | serial_println | Serial 内容 | 串口打印 |
// | dht_init | 变量名 类型 引脚 | 初始化 DHT |
// | dht_read_temperature | 变量名 | 读取温度 |
// | io_digitalwrite | 引脚 状态 | 数字输出 |
// | io_digitalread | 引脚 | 数字输入 |
// | time_delay | 毫秒 | 延时 |

// **操作符**：
// - 比较: \`==\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`
// - 逻辑: \`&&\`, \`||\`, \`and\`, \`or\`

// **优势**：
// - 📉 体积比 JSON 减少 75%
// - ✅ 无需管理 ID 和连接
// - ✅ 顺序书写 = 顺序执行
// - ✅ 接近自然语言`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 code: {
//                     type: 'string',
//                     description: 'YAML-Like DSL 代码'
//                 }
//             },
//             required: ['code']
//         }
    // },
    // {
    //     name: 'arduino_syntax_check',
    //     description: `检查Arduino代码的语法正确性。用于验证生成的Arduino代码是否有语法错误，特别是检测未声明的变量。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             code: {
    //                 type: 'string',
    //                 description: 'Arduino C++代码内容'
    //             },
    //             timeout: {
    //                 type: 'number',
    //                 default: 3000,
    //                 description: '检查超时时间（毫秒）'
    //             },
    //             enableWarnings: {
    //                 type: 'boolean',
    //                 default: true,
    //                 description: '是否启用警告检查'
    //             }
    //         },
    //         required: ['code']
    //     }
    // }
    // =============================================================================
    // 框架图工具
    // =============================================================================
    {
        name: 'save_arch',
        description: `保存/覆盖框架图到项目目录下的 arch.md 文件。当你生成了 mermaid 框架图后，调用此工具将其持久化保存，无需用户手动点击保存按钮。

传入 mermaid 图表代码（不含 \`\`\`mermaid 包裹），工具会自动包裹并写入 arch.md。

**框架图内容**：
根据项目实际代码结构和用户需求，在一个图表中必须包含以下内容：
1.代码执行流程图：展示从 setup 到 loop 的主要执行流程，包含关键函数调用和事件触发关系
2.项目架构/模块设计：硬件层（开发板、传感器、外设）和软件层（库、模块）的关系图（核心库可以不展示具体块，只展示库和模块关系）
3.必要的注释说明：图表中可以包含必要的文本说明，帮助理解架构设计和执行流程

**使用时机**：
- 生成框架图后，直接调用此工具保存，勿等待用户手动操作。
- 用户要求更新/重新生成框架图时，同样调用此工具覆盖保存。

**重要**：保存成功后框架图会自动在对话中渲染展示，请勿再次输出 mermaid 代码。`,
        input_schema: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: 'Mermaid 图表代码（不含 \`\`\`mermaid 代码块包裹，工具会自动添加）'
                }
            },
            required: ['code']
        },
        agents: ["mainAgent"]
    },
]
