import type { Tool } from '../core/chat-types';
import { MAIN_AGENT_TYPE } from '../core/agent-identifiers';
import { HOST_EXTERNAL_TOOLS } from './architecture-tool-definition';

export type ToolSettingsCatalogEntry = Pick<Tool, 'name' | 'description' | 'agents'>;

const CORE_TOOL_SETTINGS: ToolSettingsCatalogEntry[] = [
  { name: 'ask_user', description: '向用户提问并等待回答；当前 lex 路径由 lex core 内建实现。', agents: [MAIN_AGENT_TYPE] },
  { name: 'search_available_tools', description: '旧 blockly 聊天链路中搜索并加载按需延迟注册工具的入口。', agents: [MAIN_AGENT_TYPE] },
  { name: 'load_skill', description: '加载或卸载领域技能；当前 lex 路径由 lex core + blockly skill provider 协同实现。', agents: [MAIN_AGENT_TYPE] },
  { name: 'register_agent', description: '兼容入口：动态注册新的子代理定义，当前 lex 主链路默认不暴露。', agents: [MAIN_AGENT_TYPE] },
];

const PROJECT_TOOL_SETTINGS: ToolSettingsCatalogEntry[] = [
  { name: 'create_project', description: '创建新项目并初始化开发板。', agents: [MAIN_AGENT_TYPE] },
  { name: 'execute_command', description: '在 PowerShell 中执行系统命令。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_exec', description: '执行命令，长耗时任务返回可轮询的进程 ID。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_write_stdin', description: '向命令进程写入 stdin，空输入用于轮询。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_status', description: '读取命令进程状态。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_resize', description: '调整 PTY 命令进程尺寸。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_stop', description: '停止命令进程。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_read', description: '按范围读取命令长输出。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_tail', description: '读取命令长输出尾部。', agents: [MAIN_AGENT_TYPE] },
  { name: 'command_search', description: '检索命令长输出。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_context', description: '获取项目、平台和系统上下文。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_project_info', description: '读取当前项目开发板和库信息。', agents: [MAIN_AGENT_TYPE] },
  { name: 'build_project', description: '编译当前项目。', agents: [MAIN_AGENT_TYPE] },
  { name: 'reload_project', description: '重新加载当前项目。', agents: [MAIN_AGENT_TYPE] },
  { name: 'switch_board', description: '切换项目开发板。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_board_config', description: '读取开发板配置。', agents: [MAIN_AGENT_TYPE] },
  { name: 'set_board_config', description: '修改开发板配置。', agents: [MAIN_AGENT_TYPE] },
  { name: 'search_boards_libraries', description: '搜索开发板和库。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_hardware_categories', description: '获取开发板或库的分类信息。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_board_parameters', description: '获取当前开发板参数。', agents: [MAIN_AGENT_TYPE] },
  { name: 'fetch', description: '获取网页或 HTTP API 内容。', agents: [MAIN_AGENT_TYPE] },
  { name: 'clone_repository', description: '下载远程 Git 仓库源码。', agents: [MAIN_AGENT_TYPE] },
  { name: 'web_search', description: '执行联网搜索。', agents: [MAIN_AGENT_TYPE] },
  { name: 'todo_write_tool', description: '管理任务清单。', agents: [MAIN_AGENT_TYPE] },
  { name: 'memory', description: '读写 /memories 下的 user、session、repo 记忆文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'resolve_memory_file_uri', description: '把 /memories 逻辑路径解析为真实文件 URI。', agents: [MAIN_AGENT_TYPE] },
  { name: 'get_errors', description: '收集项目中的诊断错误。', agents: [MAIN_AGENT_TYPE] },
  { name: 'log_tool', description: '按来源、时间段和级别查询项目 .log 日志；支持 head/tail/sed。maxFiles 按 source 分别生效；查最近日志时优先用 maxFiles=1 + tail 20 行，且不要退回到 find/read_file/终端方式。', agents: [MAIN_AGENT_TYPE] },
];

const FILE_TOOL_SETTINGS: ToolSettingsCatalogEntry[] = [
  { name: 'read_file', description: '读取文件内容。', agents: [MAIN_AGENT_TYPE] },
  { name: 'create_file', description: '创建新文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'create_folder', description: '创建文件夹。', agents: [MAIN_AGENT_TYPE] },
  { name: 'edit_file', description: '编辑现有文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'replace_string_in_file', description: '精确替换文件中的字符串。', agents: [MAIN_AGENT_TYPE] },
  { name: 'multi_replace_string_in_file', description: '批量精确替换多个文件内容。', agents: [MAIN_AGENT_TYPE] },
  { name: 'delete_file', description: '删除文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'grep_tool', description: '按内容搜索文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'glob_tool', description: '按文件名模式搜索文件。', agents: [MAIN_AGENT_TYPE] },
  { name: 'assets_tool', description: '按项目 .assets 目录渐进式列目录或读取资产文件；查询关联内容时优先从根目录开始，检查链接时读取 RELATED_URLS.txt，不要扩展到 memory 或普通项目文件。', agents: [MAIN_AGENT_TYPE] },
];

const BLOCKLY_TOOL_SETTINGS: ToolSettingsCatalogEntry[] = [
  { name: 'syncAbs', description: '同步 ABS 文件和图形化工作区。', agents: [MAIN_AGENT_TYPE] },
  { name: 'lint', description: '检查当前 Blockly 生成代码的语法问题。', agents: [MAIN_AGENT_TYPE] },
  { name: 'analyzeLibrary', description: '按库 ID 分析可用块定义和 readme_ai.md 参考。', agents: [MAIN_AGENT_TYPE] },
];

export const TOOL_SETTINGS_CATALOG: ToolSettingsCatalogEntry[] = [
  ...CORE_TOOL_SETTINGS,
  ...PROJECT_TOOL_SETTINGS,
  ...FILE_TOOL_SETTINGS,
  ...BLOCKLY_TOOL_SETTINGS,
  ...HOST_EXTERNAL_TOOLS,
];
