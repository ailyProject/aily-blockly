import { toModelFacingToolName, toRuntimeToolName } from 'aily-lex/browser';

const READ_SIDE_TOOL_NAME_ALIASES = new Map<string, string>([
  ['build_project', 'buildProject'],
  ['fetch', 'fetch_webpage'],
  ['glob_tool', 'file_search'],
  ['grep_tool', 'grep_search'],
]);

const GOVERNANCE_RUNTIME_TOOL_NAME_ALIASES = new Map<string, string>([
  ['fetch_webpage', 'fetch'],
]);

const TERMINAL_SESSION_TOOL_NAMES = new Set([
  'command_exec',
  'command_write_stdin',
  'command_status',
  'command_resize',
  'command_stop',
  'command_read',
  'command_tail',
  'command_search',
  'get_terminal_output',
  'kill_terminal',
  'run_in_terminal',
  'send_to_terminal',
]);

const TERMINAL_COMMAND_TOOL_NAMES = new Set([
  'command_exec',
  'run_in_terminal',
]);

const TODO_TOOL_NAMES = new Set([
  'manage_todo_list',
  'todo_write_tool',
]);

const INTERNAL_DISCOVERY_TOOL_NAMES = new Set([
  'tool_search',
  'search_available_tools',
]);

const SEARCH_SUMMARY_TOOL_NAMES = new Set([
  'file_search',
  'grep_search',
  'semantic_search',
  'web_search',
]);

const EDIT_SUMMARY_TOOL_NAMES = new Set([
  'create_file',
  'delete_file',
  'multi_replace_string_in_file',
  'replace_string_in_file',
  'write_file',
]);

export function normalizeReadSideToolName(toolName: string | undefined): string {
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) {
    return '';
  }

  const withoutMcpPrefix = trimmed.startsWith('mcp_') ? trimmed.substring(4) : trimmed;
  return normalizeGovernanceToolName(withoutMcpPrefix);
}

export function normalizeGovernanceToolName(toolName: string | undefined): string {
  const trimmed = typeof toolName === 'string' ? toolName.trim() : '';
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('mcp_')) {
    return trimmed;
  }

  const modelFacingName = toModelFacingToolName(trimmed);
  return READ_SIDE_TOOL_NAME_ALIASES.get(modelFacingName) ?? modelFacingName;
}

export function toRuntimeGovernanceToolName(toolName: string | undefined): string {
  const normalizedToolName = normalizeGovernanceToolName(toolName);
  if (!normalizedToolName) {
    return '';
  }

  if (normalizedToolName.startsWith('mcp_')) {
    return normalizedToolName;
  }

  const runtimeToolName = toRuntimeToolName(normalizedToolName);
  return GOVERNANCE_RUNTIME_TOOL_NAME_ALIASES.get(runtimeToolName) ?? runtimeToolName;
}

export function isChangedFilesToolName(toolName: string | undefined): boolean {
  return normalizeReadSideToolName(toolName) === 'get_changed_files';
}

export function isEditSummaryToolName(toolName: string | undefined): boolean {
  return EDIT_SUMMARY_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}

export function isReadFileToolName(toolName: string | undefined): boolean {
  if (normalizeReadSideToolName(toolName) === 'read_file') {
    return true;
  }

  return (toolName || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase() === 'readfile';
}

export function isSearchSummaryToolName(toolName: string | undefined): boolean {
  return SEARCH_SUMMARY_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}

export function isTerminalSessionToolName(toolName: string | undefined): boolean {
  return TERMINAL_SESSION_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}

export function isTerminalCommandToolName(toolName: string | undefined): boolean {
  return TERMINAL_COMMAND_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}

export function isTodoToolName(toolName: string | undefined): boolean {
  return TODO_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}

export function isInternalDiscoveryToolName(toolName: string | undefined): boolean {
  return INTERNAL_DISCOVERY_TOOL_NAMES.has(normalizeReadSideToolName(toolName));
}
