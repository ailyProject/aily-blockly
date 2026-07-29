/**
 * Legacy deferred tool metadata and lightweight discovery helpers.
 *
 * This file only serves the legacy blockly chat path built around
 * search_available_tools. The lex runtime uses BLOCKLY_LEX_DEFERRED_GROUPS
 * plus contributed-tool deferred metadata instead.
 *
 * Keeping these helpers isolated avoids pulling the large legacy TOOLS catalog
 * into unrelated bootstrap code.
 */

export interface DeferredToolGroup {
  name: string;
  brief: string;
  tools: string[];
}

export const LEGACY_DEFERRED_TOOL_GROUPS: DeferredToolGroup[] = [
  {
    name: '硬件/库搜索',
    brief: '搜索开发板和库、获取硬件分类、查询开发板参数',
    tools: ['search_boards_libraries', 'get_hardware_categories', 'get_board_parameters'],
  },
  {
    name: '项目管理',
    brief: '创建项目、重新加载项目、切换开发板、开发板配置',
    tools: ['create_project', 'reload_project', 'switch_board', 'get_board_config', 'set_board_config'],
  },
  {
    name: '终端工具',
    brief: '命令执行、轮询、停止、长输出读取/检索',
    tools: ['command_exec', 'command_write_stdin', 'command_status', 'command_resize', 'command_stop', 'command_read', 'command_tail', 'command_search'],
  },
];

const LEGACY_DEFERRED_TOOL_NAMES = new Set(
  LEGACY_DEFERRED_TOOL_GROUPS.flatMap(group => group.tools),
);

export function getLegacyCoreTools(allTools: any[]): any[] {
  return allTools.filter(tool => !LEGACY_DEFERRED_TOOL_NAMES.has(tool.name));
}

export function getLegacyDeferredTools(allTools: any[]): any[] {
  return allTools.filter(tool => LEGACY_DEFERRED_TOOL_NAMES.has(tool.name));
}

export function isLegacyDeferredTool(name: string): boolean {
  return LEGACY_DEFERRED_TOOL_NAMES.has(name);
}

// Backward-compatible aliases for the remaining legacy call sites.
export const DEFERRED_TOOL_GROUPS = LEGACY_DEFERRED_TOOL_GROUPS;

export function getCoreTools(allTools: any[]): any[] {
  return getLegacyCoreTools(allTools);
}

export function getDeferredTools(allTools: any[]): any[] {
  return getLegacyDeferredTools(allTools);
}

export function isDeferredTool(name: string): boolean {
  return isLegacyDeferredTool(name);
}
