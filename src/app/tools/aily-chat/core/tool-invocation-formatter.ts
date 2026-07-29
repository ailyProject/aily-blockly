import { normalizeReadSideToolName, toRuntimeGovernanceToolName } from './tool-name-normalizer';
import { readToolApprovalCommand } from './tool-approval-input';

export interface ToolInvocationDisplaySummary {
  label: string;
  subtitle?: string;
}

export function buildToolInvocationDisplaySummary(input: {
  toolName: string;
  args?: any;
  metadata?: Record<string, unknown> | null;
  result?: any;
  state?: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval';
}): ToolInvocationDisplaySummary | undefined {
  const cleanToolName = normalizeFormatterToolName(input.toolName);
  const args = inferToolArgs(input.args, cleanToolName, input.metadata);

  switch (cleanToolName) {
    case 'load_skill':
      return buildLoadSkillSummary(args, input.metadata, input.state);
    case 'read_file':
      return buildReadFileSummary(args, input.metadata);
    case 'grep_search':
    case 'grep_tool':
      return buildSearchSummary(args, 'Searched');
    case 'glob_search':
    case 'glob_tool':
    case 'file_search':
      return buildFileSearchSummary(args);
    case 'semantic_search':
      return buildSemanticSearchSummary(args);
    case 'create_file':
      return buildPathLifecycleSummary(args, input.state, {
        active: 'Creating', completed: 'Created', failed: 'Failed to create',
      });
    case 'write_file':
      return buildPathLifecycleSummary(args, input.state, {
        active: 'Updating', completed: 'Updated', failed: 'Failed to update',
      });
    case 'create_folder':
    case 'create_directory':
      return buildPathLifecycleSummary(args, input.state, {
        active: 'Creating', completed: 'Created', failed: 'Failed to create',
      }, 'folder');
    case 'edit_file':
      return buildPathSummary('Edited', args);
    case 'replace_string_in_file':
    case 'multi_replace_string_in_file':
      return buildPathSummary('Updated', args);
    case 'delete_file':
      return buildPathSummary('Deleted', args);
    case 'delete_folder':
      return buildPathSummary('Deleted', args, 'folder');
    case 'list_dir':
    case 'list_directory':
      return { label: `Listed ${formatPathScope(getPrimaryPath(args))}` };
    case 'get_directory_tree':
      return { label: `Mapped ${formatPathScope(getPrimaryPath(args))}` };
    case 'check_exists':
      return { label: `Checked ${formatPathLeaf(getPrimaryPath(args), args?.type === 'folder' ? 'folder' : 'path')}` };
    case 'run_in_terminal':
    case 'command_exec':
    case 'execute_command':
      return buildCommandSummary('Ran', args);
    case 'send_to_terminal':
    case 'command_write_stdin':
      return buildSendToTerminalSummary(args);
    case 'get_terminal_output':
    case 'command_status':
      return buildTerminalOutputSummary(args);
    case 'command_resize':
      return { label: 'Resized command terminal', subtitle: asString(args?.processId) };
    case 'command_stop':
      return { label: 'Stopped command', subtitle: asString(args?.processId) };
    case 'command_read':
      return { label: 'Read command output', subtitle: asString(args?.outputSessionId) || asString(args?.processId) };
    case 'command_tail':
      return { label: 'Read command tail', subtitle: asString(args?.outputSessionId) || asString(args?.processId) };
    case 'command_search':
      return { label: 'Searched command output', subtitle: asString(args?.query) || asString(args?.regex) };
    case 'fetch':
    case 'fetch_webpage':
      return buildFetchSummary(args);
    case 'web_search':
      return buildWebSearchSummary(args);
    case 'open_browser_page':
      return buildOpenBrowserSummary(args);
    case 'get_changed_files':
      return { label: 'Checked changed files' };
    case 'get_errors':
      return buildGetErrorsSummary(args);
    case 'renderMermaidDiagram':
      return { label: args?.title ? `Rendered ${String(args.title)}` : 'Rendered Mermaid diagram' };
    case 'create_new_workspace':
      return { label: 'Created workspace', subtitle: asString(args?.query) };
    case 'create_new_jupyter_notebook':
      return { label: 'Created notebook', subtitle: asString(args?.query) };
    case 'create_project':
      return buildCreateProjectSummary(args);
    case 'buildProject':
      return buildBuildProjectSummary(args);
    case 'reload_project':
      return buildReloadProjectSummary();
    case 'get_context':
      return buildGetContextSummary(args);
    case 'get_project_info':
      return buildProjectInfoSummary(args);
    case 'get_board_config':
      return buildBoardConfigSummary();
    case 'install_extension':
      return { label: `Installed ${truncateDisplayText(asString(args?.name) || asString(args?.id) || 'extension', 48)}` };
    case 'run_editor_command':
      return { label: `Ran ${truncateDisplayText(asString(args?.name) || asString(args?.commandId) || 'editor command', 56)}` };
    case 'resolve_memory_file_uri':
      return { label: `Resolved ${truncateDisplayText(asString(args?.path) || 'memory file', 56)}` };
    case 'memory':
      return buildMemorySummary(args);
    case 'syncAbs':
      return buildSyncAbsSummary(args, input.metadata, input.state);
    case 'lint':
      return {
        label: 'Checked generated code',
        subtitle: 'for syntax issues',
      };
    case 'todo_write_tool':
    case 'manage_todo_list':
      return buildTodoWriteSummary(args, input.metadata, input.result);
    case 'get_board_parameters':
      return buildBoardParametersSummary(args);
    case 'save_arch':
      return buildSaveArchSummary(args, input.metadata, input.result);
    case 'search_boards_libraries':
      return buildBoardsLibrariesSummary(args);
    case 'get_hardware_categories':
      return buildHardwareCategoriesSummary(args);
    case 'switch_board':
      return buildSwitchBoardSummary(args);
    case 'set_board_config':
      return buildSetBoardConfigSummary(args);
    case 'clone_repository':
      return buildCloneRepositorySummary(args);
    case 'ask_user':
      return { label: 'Asked a question' };
    case 'ask_approval':
      return { label: 'Requested approval' };
    case 'runSubagent':
    case 'agent':
      return buildSubagentSummary(args);
    default:
      return buildGenericToolSummary(cleanToolName, args);
  }
}

export function flattenToolInvocationDisplaySummary(
  summary?: ToolInvocationDisplaySummary,
): string | undefined {
  if (!summary) {
    return undefined;
  }

  return summary.subtitle ? `${summary.label}, ${summary.subtitle}` : summary.label;
}

export function generateAilyToolStartText(toolName: string, args?: any): string | undefined {
  return flattenToolInvocationDisplaySummary(buildToolInvocationDisplaySummary({ toolName, args }));
}

export function generateAilyToolResultText(toolName: string, args?: any, result?: any): string | undefined {
  const cleanToolName = cleanToolNamePrefix(toolName);
  const summary = buildToolInvocationDisplaySummary({ toolName, args, result });
  const base = flattenToolInvocationDisplaySummary(summary);
  if (!base) {
    return undefined;
  }

  if (result?.is_error || result?.isError) {
    return `Failed: ${base}`;
  }

  const stats = buildResultStats(cleanToolName, args, result);
  return stats ? `${base} (${stats})` : base;
}

function buildReadFileSummary(args: any, metadata?: Record<string, unknown> | null): ToolInvocationDisplaySummary | undefined {
  const readFileMetadata = asRecord(metadata?.['readFile']);
  const path = asString(args?.filePath)
    || asString(args?.path)
    || asString(readFileMetadata?.['filePath'])
    || asString(metadata?.['argsSummary']);
  if (!path) {
    return undefined;
  }

  return {
    label: `Read ${formatPathLeaf(path, 'file')}`,
  };
}

function buildSearchSummary(args: any, verb: string): ToolInvocationDisplaySummary | undefined {
  const query = asString(args?.query) || asString(args?.pattern);
  if (!query) {
    return undefined;
  }

  return {
    label: `${verb} ${formatSearchScope(args)}`,
    subtitle: `for ${truncateDisplayText(query, 56)}`,
  };
}

function buildFileSearchSummary(args: any): ToolInvocationDisplaySummary | undefined {
  const query = asString(args?.query) || asString(args?.pattern);
  const scope = formatSearchScope(args);
  return {
    label: `Found files in ${scope}`,
    subtitle: query ? `for ${truncateDisplayText(query, 56)}` : undefined,
  };
}

function buildSemanticSearchSummary(args: any): ToolInvocationDisplaySummary | undefined {
  const query = asString(args?.query);
  return {
    label: 'Searched workspace semantically',
    subtitle: query ? `for ${truncateDisplayText(query, 56)}` : undefined,
  };
}

function buildCreateProjectSummary(args: any): ToolInvocationDisplaySummary {
  const projectName = asString(args?.name) || asString(args?.projectName);
  const boardName = formatBoardDisplayName(asString(args?.board));
  return {
    label: 'Created project',
    subtitle: joinSummaryParts(
      projectName ? truncateDisplayText(projectName, 40) : undefined,
      boardName ? `for ${truncateDisplayText(boardName, 40)}` : undefined,
    ),
  };
}

function buildBuildProjectSummary(args: any): ToolInvocationDisplaySummary {
  if (args?.preprocess_only) {
    return {
      label: 'Preprocessed project',
      subtitle: args?.clear_cache ? 'after clearing cache' : undefined,
    };
  }

  return {
    label: 'Built project',
    subtitle: args?.clear_cache ? 'after clearing cache' : undefined,
  };
}

function buildReloadProjectSummary(): ToolInvocationDisplaySummary {
  return {
    label: 'Reloaded project',
  };
}

function buildGetContextSummary(args: any): ToolInvocationDisplaySummary {
  const infoType = asString(args?.info_type)?.toLowerCase();
  switch (infoType) {
    case 'project':
      return { label: 'Checked project context' };
    case 'platform':
      return { label: 'Checked platform context' };
    case 'system':
      return { label: 'Checked system context' };
    default:
      return { label: 'Checked workspace context' };
  }
}

function buildProjectInfoSummary(args: any): ToolInvocationDisplaySummary {
  return {
    label: 'Checked project info',
    subtitle: args?.include_readme === false ? undefined : 'including readme paths',
  };
}

function buildBoardConfigSummary(): ToolInvocationDisplaySummary {
  return {
    label: 'Checked board configuration',
  };
}

function buildPathSummary(verb: string, args: any, fallbackKind: 'file' | 'folder' | 'path' = 'file'): ToolInvocationDisplaySummary {
  return {
    label: `${verb} ${formatPathLeaf(getPrimaryPath(args), fallbackKind)}`,
  };
}

function buildPathLifecycleSummary(
  args: any,
  state: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval' | undefined,
  verbs: { readonly active: string; readonly completed: string; readonly failed: string },
  fallbackKind: 'file' | 'folder' | 'path' = 'file',
): ToolInvocationDisplaySummary {
  const verb = state === 'error'
    ? verbs.failed
    : state === 'doing' || state === 'pending_approval'
      ? verbs.active
      : verbs.completed;
  return buildPathSummary(verb, args, fallbackKind);
}

function buildCommandSummary(verb: string, args: any): ToolInvocationDisplaySummary {
  const command = readToolApprovalCommand('command_exec', args);
  return {
    label: `${verb} ${truncateDisplayText(command || 'command', 64)}`,
    subtitle: asString(args?.cwd) ? `in ${truncateDisplayText(String(args.cwd), 56)}` : undefined,
  };
}

function buildSendToTerminalSummary(args: any): ToolInvocationDisplaySummary {
  const command = asString(args?.input) || asString(args?.command);
  const terminalId = asString(args?.processId) || asString(args?.id) || asString(args?.terminalId);
  return {
    label: command ? `Sent ${truncateDisplayText(command, 56)}` : 'Sent terminal input',
    subtitle: terminalId ? `to process ${terminalId}` : undefined,
  };
}

function buildTerminalOutputSummary(args: any): ToolInvocationDisplaySummary {
  const terminalId = asString(args?.processId) || asString(args?.outputSessionId) || asString(args?.id) || asString(args?.terminalId);
  return {
    label: 'Read command output',
    subtitle: terminalId ? `from process ${terminalId}` : undefined,
  };
}

function buildFetchSummary(args: any): ToolInvocationDisplaySummary {
  const url = firstUrl(args);
  return {
    label: `Fetched ${formatUrlDisplay(url)}`,
  };
}

function buildWebSearchSummary(args: any): ToolInvocationDisplaySummary {
  const query = asString(args?.query);
  return {
    label: 'Searched the web',
    subtitle: query ? `for ${truncateDisplayText(query, 56)}` : undefined,
  };
}

function buildOpenBrowserSummary(args: any): ToolInvocationDisplaySummary {
  return {
    label: `Opened ${formatUrlDisplay(asString(args?.url))}`,
  };
}

function buildGetErrorsSummary(args: any): ToolInvocationDisplaySummary {
  const filePaths = Array.isArray(args?.filePaths) ? args.filePaths.filter((item: unknown) => typeof item === 'string') : [];
  if (filePaths.length === 1) {
    return { label: `Checked problems in ${formatPathLeaf(filePaths[0], 'file')}` };
  }
  return { label: filePaths.length > 1 ? 'Checked problems in selected files' : 'Checked workspace problems' };
}

function buildMemorySummary(args: any): ToolInvocationDisplaySummary {
  const command = asString(args?.command) || 'view';
  const path = asString(args?.path) || asString(args?.old_path) || asString(args?.new_path);
  const actionMap: Record<string, string> = {
    view: 'Viewed',
    create: 'Created',
    str_replace: 'Updated',
    insert: 'Inserted into',
    delete: 'Deleted',
    rename: 'Renamed',
  };
  const label = actionMap[command] || 'Updated';
  return {
    label: `${label} ${truncateDisplayText(path || 'memory', 56)}`,
  };
}

function buildSubagentSummary(args: any): ToolInvocationDisplaySummary {
  const agentName = asString(args?.agentName) || 'subagent';
  const description = asString(args?.description) || asString(args?.prompt);
  return {
    label: `Ran ${truncateDisplayText(agentName, 48)}`,
    subtitle: description ? truncateDisplayText(description, 64) : undefined,
  };
}

function buildLoadSkillSummary(
  args: any,
  metadata?: Record<string, unknown> | null,
  state?: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval',
): ToolInvocationDisplaySummary {
  const action = asString(args?.action)?.toLowerCase() || 'load';
  const query = asString(args?.query);
  const skillLabel = resolveSkillDisplayLabel(args, metadata);

  switch (action) {
    case 'search':
      return {
        label: 'Searched skills',
        subtitle: query ? `for ${truncateDisplayText(query, 56)}` : undefined,
      };
    case 'list':
      return { label: 'Listed session skills' };
    case 'unload':
      return {
        label: skillLabel ? `Removed session skill ${truncateDisplayText(skillLabel, 48)}` : 'Removed session skill',
      };
    case 'load':
    default: {
      const mode = resolveLoadSkillMode(args, metadata);
      const scope = resolveLoadSkillScope(metadata);
      const activeVerb = mode === 'fork' ? 'Running' : 'Loading';
      const completedVerb = mode === 'fork' ? 'Ran' : 'Loaded';
      const verb = state === 'doing' || state === 'pending_approval' ? activeVerb : completedVerb;
      const suffix = mode === 'fork'
        ? ''
        : scope === 'session'
          ? ' for the session'
          : ' for this turn';
      return {
        label: skillLabel ? `${verb} skill ${truncateDisplayText(skillLabel, 48)}${suffix}` : `${verb} skill${suffix}`,
      };
    }
  }
}

function buildSyncAbsSummary(
  args: any,
  metadata?: Record<string, unknown> | null,
  state?: 'doing' | 'done' | 'warn' | 'error' | 'pending_approval',
): ToolInvocationDisplaySummary {
  const action = asString(args?.action).toLowerCase()
    || asString(metadata?.['operation']).toLowerCase();
  switch (action) {
    case 'import':
      return { label: state === 'error' ? 'Failed to load Blockly from ABS' : state === 'doing' || state === 'pending_approval' ? 'Loading Blockly from ABS' : 'Loaded Blockly from ABS' };
    case 'export':
      return { label: state === 'error' ? 'Failed to export Blockly to ABS' : state === 'doing' || state === 'pending_approval' ? 'Exporting Blockly to ABS' : 'Exported Blockly to ABS' };
    case 'status':
      return { label: 'Checked ABS sync status' };
    default:
      return { label: state === 'error' ? 'Failed to synchronize Blockly and ABS' : 'Synchronized Blockly and ABS' };
  }
}

function buildTodoWriteSummary(
  args: any,
  metadata?: Record<string, unknown> | null,
  result?: any,
): ToolInvocationDisplaySummary {
  const todoSemanticData = resolveTodoSemanticData(args, metadata, result);
  const semanticSubtitle = buildTodoSemanticSubtitle(todoSemanticData);

  switch (asString(args?.operation)?.toLowerCase()) {
    case 'list':
    case 'query':
    case 'stats':
      return { label: 'Checked todo list', subtitle: semanticSubtitle };
    case 'clear':
    case 'delete_all':
      return { label: 'Cleared todo list', subtitle: semanticSubtitle };
    default:
      return { label: 'Updated todo list', subtitle: semanticSubtitle };
  }
}

function resolveTodoSemanticData(
  args: any,
  metadata?: Record<string, unknown> | null,
  result?: any,
): Record<string, unknown> | undefined {
  const metadataSemanticData = asRecord(metadata?.['toolSpecificData']);
  if (metadataSemanticData?.['kind'] === 'todoList') {
    return metadataSemanticData;
  }

  const resultSemanticData = asRecord(asRecord(result?.metadata)?.['toolSpecificData']);
  if (resultSemanticData?.['kind'] === 'todoList') {
    return resultSemanticData;
  }

  const argsTodoList = Array.isArray(args?.todoList) ? args.todoList : undefined;
  if (argsTodoList && argsTodoList.length > 0) {
    const completedCount = argsTodoList.filter((item: unknown) => asRecord(item)?.['status'] === 'completed').length;
    const currentTodo = argsTodoList.find((item: unknown) => asRecord(item)?.['status'] === 'in-progress')
      ?? argsTodoList.find((item: unknown) => asRecord(item)?.['status'] === 'not-started');
    const currentTask = asString(asRecord(currentTodo)?.['title']);
    return {
      kind: 'todoList',
      currentTask,
      currentStep: currentTask ? Math.min(argsTodoList.length, completedCount + 1) : argsTodoList.length,
      totalCount: argsTodoList.length,
      completedCount,
    };
  }

  const argTitle = asString(args?.title) || asString(args?.content);
  if (argTitle) {
    return {
      kind: 'todoList',
      currentTask: argTitle,
    };
  }

  return undefined;
}

function buildTodoSemanticSubtitle(todoSemanticData?: Record<string, unknown>): string | undefined {
  if (!todoSemanticData) {
    return undefined;
  }

  const currentTask = asString(todoSemanticData['currentTask']);
  const currentStep = asNumber(todoSemanticData['currentStep']);
  const totalCount = asNumber(todoSemanticData['totalCount']);
  const summary = asString(todoSemanticData['summary']);
  const progress = currentStep && totalCount ? `${currentStep}/${totalCount}` : undefined;

  if (currentTask && progress) {
    return `${truncateDisplayText(currentTask, 48)} (${progress})`;
  }

  if (currentTask) {
    return truncateDisplayText(currentTask, 56);
  }

  if (progress) {
    return progress;
  }

  return summary ? truncateDisplayText(summary, 56) : undefined;
}

function buildBoardParametersSummary(args: any): ToolInvocationDisplaySummary {
  const parameters = Array.isArray(args?.parameters)
    ? args.parameters.filter((value: unknown) => typeof value === 'string' && value.trim().length > 0)
    : typeof args?.parameters === 'string' && args.parameters.trim().length > 0
      ? args.parameters.split(',').map((value: string) => value.trim()).filter(Boolean)
      : [];

  return {
    label: 'Checked board parameters',
    subtitle: parameters.length > 0 ? `for ${truncateDisplayText(parameters.join(', '), 56)}` : undefined,
  };
}

function buildSaveArchSummary(
  args: any,
  metadata?: Record<string, unknown> | null,
  result?: any,
): ToolInvocationDisplaySummary {
  const resultMetadata = asRecord(result?.metadata);
  const path = asString(args?.path)
    || asString(metadata?.['path'])
    || asString(metadata?.['filePath'])
    || asString(resultMetadata?.['path'])
    || asString(resultMetadata?.['filePath']);
  return {
    label: 'Saved architecture diagram',
    subtitle: path ? `to ${truncateDisplayText(path, 56)}` : undefined,
  };
}

function buildBoardsLibrariesSummary(args: any): ToolInvocationDisplaySummary {
  const scope = describeBoardLibraryScope(args?.type);
  const filterSummary = formatBoardsLibrariesFilterSummary(args?.filters) || asString(args?.query);
  return {
    label: `Searched ${scope}`,
    subtitle: filterSummary ? `for ${truncateDisplayText(filterSummary, 56)}` : undefined,
  };
}

function buildHardwareCategoriesSummary(args: any): ToolInvocationDisplaySummary {
  return {
    label: `Checked ${describeHardwareCategoryScope(args?.type)} categories`,
  };
}

function buildSwitchBoardSummary(args: any): ToolInvocationDisplaySummary {
  const boardName = formatBoardDisplayName(
    asString(args?.board)
      || asString(args?.boardId)
      || asString(args?.board_name),
  );
  const boardVersion = asString(args?.board_version);
  return {
    label: `Switched board to ${boardName || 'selected board'}`,
    subtitle: boardVersion ? `version ${truncateDisplayText(boardVersion, 32)}` : undefined,
  };
}

function buildSetBoardConfigSummary(args: any): ToolInvocationDisplaySummary {
  const configEntry = extractBoardConfigEntry(args);
  if (!configEntry) {
    return { label: 'Updated board configuration' };
  }

  return {
    label: `Set board config ${truncateDisplayText(configEntry.key, 32)}`,
    subtitle: `to ${truncateDisplayText(configEntry.value, 48)}`,
  };
}

function buildCloneRepositorySummary(args: any): ToolInvocationDisplaySummary {
  const url = asString(args?.url) || asString(args?.repoUrl);
  const repoDisplay = formatRepositoryDisplayName(url);
  const branch = asString(args?.branch);
  const targetDir = asString(args?.target_dir);
  return {
    label: `Cloned ${truncateDisplayText(repoDisplay || 'repository', 56)}`,
    subtitle: joinSummaryParts(
      branch ? `branch ${truncateDisplayText(branch, 24)}` : undefined,
      targetDir ? `to ${truncateDisplayText(targetDir, 40)}` : undefined,
    ),
  };
}

function buildGenericToolSummary(toolName: string, args: any): ToolInvocationDisplaySummary {
  const tokens = splitToolName(toolName);
  const verb = pastTenseVerb(tokens[0] || 'used');
  const nounPhrase = humanizeTokens(tokens.slice(1).filter(token => token !== 'tool')) || humanizeTokens(tokens);
  const target = extractGenericTarget(args);
  return {
    label: `${verb} ${truncateDisplayText(target || nounPhrase || toolName, 56)}`,
  };
}

function buildResultStats(toolName: string, args: any, result: any): string | undefined {
  const metadata = asRecord(result?.metadata);
  if (!metadata) {
    return undefined;
  }

  if (toolName === 'grep_search' || toolName === 'grep_tool') {
    const numMatches = asNumber(metadata['numMatches']);
    const numFiles = asNumber(metadata['numFiles']);
    if (numMatches === 0) {
      return 'no matches';
    }
    if (typeof numMatches === 'number') {
      return `${numMatches} matches`;
    }
    if (typeof numFiles === 'number') {
      return `${numFiles} files`;
    }
  }

  if (toolName === 'glob_search' || toolName === 'glob_tool' || toolName === 'file_search') {
    const numFiles = asNumber(metadata['numFiles']);
    if (numFiles === 0) {
      return 'no files';
    }
    if (typeof numFiles === 'number') {
      return `${numFiles} files`;
    }
  }

  if (toolName === 'get_errors') {
    const count = asNumber(metadata['count']) || asNumber(metadata['numErrors']);
    if (typeof count === 'number') {
      return `${count} issues`;
    }
  }

  if (toolName === 'search_boards_libraries') {
    const totalMatches = asNumber(metadata['totalMatches']) || asNumber(metadata['numMatches']);
    if (totalMatches === 0) {
      return 'no matches';
    }
    if (typeof totalMatches === 'number') {
      return `${totalMatches} matches`;
    }
  }

  if (toolName === 'get_hardware_categories') {
    const categories = Array.isArray(metadata['categories']) ? metadata['categories'].length : undefined;
    const count = asNumber(metadata['count']) ?? categories;
    if (typeof count === 'number') {
      return `${count} categories`;
    }
  }

  if (toolName === 'clone_repository') {
    const fileCount = asNumber(metadata['fileCount']) || asNumber(metadata['numFiles']);
    if (typeof fileCount === 'number') {
      return `${fileCount} files`;
    }
  }

  if (toolName === 'get_terminal_output') {
    const status = asString(metadata['status']);
    if (status) {
      return status;
    }
  }

  return undefined;
}

function inferToolArgs(
  args: any,
  toolName: string,
  metadata?: Record<string, unknown> | null,
): any {
  if (args && Object.keys(args).length > 0) {
    return args;
  }

  const argsSummary = asString(metadata?.['argsSummary']);
  if (!argsSummary) {
    return {};
  }

  const parsedSummary = parseArgsSummary(argsSummary);
  if (parsedSummary) {
    return parsedSummary;
  }

  switch (toolName) {
    case 'read_file':
    case 'write_file':
      return { filePath: argsSummary };
    case 'grep_search':
    case 'grep_tool':
    case 'semantic_search':
    case 'glob_search':
    case 'glob_tool':
    case 'file_search':
      return { query: argsSummary };
    case 'fetch':
    case 'fetch_webpage':
    case 'open_browser_page':
      return { url: argsSummary };
    case 'list_dir':
    case 'list_directory':
    case 'create_directory':
    case 'create_folder':
      return { path: argsSummary };
    case 'run_in_terminal':
    case 'execute_command':
      return { command: argsSummary };
    default:
      return {};
  }
}

function parseArgsSummary(argsSummary: string): Record<string, unknown> | undefined {
  const trimmed = argsSummary.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function getPrimaryPath(args: any): string | undefined {
  return asString(args?.filePath)
    || asString(args?.path)
    || asString(args?.dirPath)
    || asString(args?.cwd)
    || asString(args?.includePattern);
}

function extractGenericTarget(args: any): string | undefined {
  const path = getPrimaryPath(args);
  if (path) {
    return formatPathLeaf(path, 'path');
  }

  const command = asString(args?.command);
  if (command) {
    return truncateDisplayText(command, 56);
  }

  const query = asString(args?.query) || asString(args?.pattern);
  if (query) {
    return truncateDisplayText(query, 56);
  }

  const url = firstUrl(args);
  if (url) {
    return formatUrlDisplay(url);
  }

  const label = asString(args?.name) || asString(args?.title) || asString(args?.id);
  return label ? truncateDisplayText(label, 56) : undefined;
}

function describeBoardLibraryScope(type: unknown): string {
  switch (asString(type)?.toLowerCase()) {
    case 'boards':
      return 'boards';
    case 'libraries':
      return 'libraries';
    default:
      return 'boards and libraries';
  }
}

function describeHardwareCategoryScope(type: unknown): string {
  return asString(type)?.toLowerCase() === 'boards' ? 'board' : 'library';
}

function formatBoardDisplayName(boardName: string | undefined): string | undefined {
  if (!boardName) {
    return undefined;
  }

  return boardName.replace(/^@aily-project\/board-/, '');
}

function extractBoardConfigEntry(args: any): { key: string; value: string } | undefined {
  const directKey = asString(args?.config_key) || asString(args?.key);
  const directValue = asString(args?.config_value) || asString(args?.value);
  if (directKey && directValue !== undefined) {
    return { key: directKey, value: directValue };
  }

  const configRecord = asRecord(args?.config);
  if (!configRecord) {
    return undefined;
  }

  const entries = Object.entries(configRecord).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) {
    return undefined;
  }

  const [key, value] = entries[0];
  return { key, value: String(value) };
}

function formatRepositoryDisplayName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  const normalized = url.replace(/\.git\/?$/, '').trim();
  if (!normalized) {
    return undefined;
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return normalized;
}

function formatBoardsLibrariesFilterSummary(filters: unknown): string | undefined {
  const parsedFilters = parseFilterRecord(filters);
  if (!parsedFilters) {
    return undefined;
  }

  const parts: string[] = [];
  const keywords = extractFilterKeywords(parsedFilters['keywords']);
  if (keywords.length > 0) {
    parts.push(keywords.slice(0, 3).join(', '));
  }

  const otherFilters = Object.keys(parsedFilters)
    .filter(key => key !== 'keywords')
    .slice(0, 2)
    .map(key => `${key}: ${formatFilterValue(parsedFilters[key])}`)
    .filter(Boolean);

  if (otherFilters.length > 0) {
    parts.push(otherFilters.join('; '));
  }

  return parts.length > 0 ? parts.join('; ') : undefined;
}

function parseFilterRecord(filters: unknown): Record<string, unknown> | undefined {
  if (typeof filters === 'string') {
    const trimmed = filters.trim();
    if (!trimmed || trimmed === '{}') {
      return undefined;
    }

    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }

  return asRecord(filters);
}

function extractFilterKeywords(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item: unknown) => typeof item === 'string').map((item: string) => item.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(/\s+/).map(part => part.trim()).filter(Boolean);
  }

  return [];
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => String(item)).slice(0, 3).join(', ');
  }

  return truncateDisplayText(String(value), 32);
}

function cleanToolNamePrefix(toolName: string): string {
  return toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;
}

function normalizeFormatterToolName(toolName: string): string {
  const cleanToolName = cleanToolNamePrefix(toolName);
  if (cleanToolName === 'manage_todo_list' || cleanToolName === 'todo_write_tool') {
    return cleanToolName;
  }
  const runtimeToolName = toRuntimeGovernanceToolName(cleanToolName) || cleanToolName;
  return normalizeReadSideToolName(runtimeToolName) === 'run_in_terminal'
    ? 'run_in_terminal'
    : runtimeToolName;
}

function splitToolName(toolName: string): string[] {
  return toolName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
}

function humanizeTokens(tokens: string[]): string {
  return tokens.join(' ').trim();
}

function pastTenseVerb(token: string): string {
  switch (token) {
    case 'read':
      return 'Read';
    case 'get':
      return 'Checked';
    case 'set':
      return 'Set';
    case 'run':
      return 'Ran';
    case 'send':
      return 'Sent';
    case 'build':
      return 'Built';
    case 'create':
    case 'new':
      return 'Created';
    case 'generate':
      return 'Generated';
    case 'render':
      return 'Rendered';
    case 'search':
    case 'grep':
      return 'Searched';
    case 'list':
      return 'Listed';
    case 'fetch':
      return 'Fetched';
    case 'clone':
      return 'Cloned';
    case 'open':
      return 'Opened';
    case 'delete':
      return 'Deleted';
    case 'edit':
      return 'Edited';
    case 'replace':
    case 'update':
      return 'Updated';
    case 'validate':
      return 'Validated';
    case 'verify':
      return 'Verified';
    case 'analyze':
      return 'Analyzed';
    case 'query':
      return 'Queried';
    case 'reload':
      return 'Reloaded';
    case 'save':
      return 'Saved';
    case 'apply':
      return 'Applied';
    case 'switch':
      return 'Switched';
    case 'configure':
      return 'Configured';
    case 'install':
      return 'Installed';
    case 'resolve':
      return 'Resolved';
    case 'rename':
      return 'Renamed';
    case 'register':
      return 'Registered';
    case 'ask':
      return 'Asked';
    default:
      return capitalize(token || 'Used');
  }
}

function formatPathLeaf(path: string | undefined, fallback: 'file' | 'folder' | 'path'): string {
  if (!path) {
    return fallback;
  }
  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.includes('*')) {
    return truncateDisplayText(normalized, 56);
  }
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = trimmed.split('/').filter(Boolean);
  return truncateDisplayText(parts.length > 0 ? parts[parts.length - 1] : trimmed, 56);
}

function formatPathScope(path: string | undefined): string {
  if (!path) {
    return 'workspace';
  }
  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return 'workspace';
  }
  if (normalized.includes('*')) {
    return truncateDisplayText(normalized, 56);
  }
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return truncateDisplayText(parts.slice(-2).join('/'), 56);
  }
  return truncateDisplayText(trimmed, 56);
}

function formatSearchScope(args: any): string {
  return formatPathScope(asString(args?.includePattern) || getPrimaryPath(args));
}

function joinSummaryParts(...parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return filtered.length > 0 ? filtered.join(', ') : undefined;
}

function firstUrl(args: any): string | undefined {
  if (Array.isArray(args?.urls)) {
    const first = args.urls.find((item: unknown) => typeof item === 'string' && item.trim().length > 0);
    if (typeof first === 'string') {
      return first;
    }
  }
  return asString(args?.url);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatUrlDisplay(url: string | undefined): string {
  if (!url) {
    return 'resource';
  }
  try {
    const parsed = new URL(url);
    const leaf = parsed.pathname.split('/').filter(Boolean).at(-1);
    return truncateDisplayText(leaf || parsed.host || url, 56);
  } catch {
    return truncateDisplayText(url, 56);
  }
}

function truncateDisplayText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveSkillDisplayLabel(args: any, metadata?: Record<string, unknown> | null): string | undefined {
  const skillMetadata = asRecord(metadata?.['skill']);
  return asString(skillMetadata?.['displayName'])
    || asString(skillMetadata?.['name'])
    || asString(args?.name)
    || asString(args?.skill);
}

function resolveLoadSkillMode(
  args: any,
  metadata?: Record<string, unknown> | null,
): 'inline' | 'fork' {
  const invocation = asRecord(metadata?.['invocation']);
  const skillMetadata = asRecord(metadata?.['skill']);
  const mode = asString(invocation?.['mode']) || asString(skillMetadata?.['mode']);
  if (mode === 'fork') {
    return 'fork';
  }
  if (mode === 'inline') {
    return 'inline';
  }
  return asString(args?.task)?.trim() ? 'fork' : 'inline';
}

function resolveLoadSkillScope(
  metadata?: Record<string, unknown> | null,
): 'request' | 'session' {
  const invocation = asRecord(metadata?.['invocation']);
  const skillMetadata = asRecord(metadata?.['skill']);
  const scope = asString(invocation?.['scope']) || asString(skillMetadata?.['scope']);
  return scope === 'session' ? 'session' : 'request';
}
