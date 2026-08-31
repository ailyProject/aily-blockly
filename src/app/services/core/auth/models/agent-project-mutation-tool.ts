const FILE_MUTATION_TOOL_NAMES = new Set([
  'apply_patch',
  'create_file',
  'delete_file',
  'edit_file',
  'multi_replace_string_in_file',
  'replace_string_in_file',
  'write_file',
]);

const PROJECT_MUTATION_ACTIONS = new Set([
  'create',
  'reload',
  'set_board_config',
  'switch_board',
]);

const NPM_PROJECT_MUTATION_PATTERN =
  /(?:^|[;&|]\s*|\s)(?:npm|npm\.cmd)\s+(?:ci|i|install|uninstall|remove|rm|update)(?:\s|$)/iu;

/**
 * Identifies Agent tools that can mutate the active project or Blockly
 * workspace. Lex uses `readOnly: false` to serialize these tools; Blockly uses
 * this narrower predicate only to expose the existing AI-writing guard while
 * one of those operations is executing.
 */
export function isAgentProjectMutationToolCall(
  toolName: string | undefined,
  input: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  if (FILE_MUTATION_TOOL_NAMES.has(normalizedToolName)) {
    return true;
  }
  if (normalizedToolName === 'project') {
    return PROJECT_MUTATION_ACTIONS.has(normalizeString(input?.['action']));
  }
  if (normalizedToolName === 'syncAbs') {
    const action = normalizeString(input?.['action']);
    return action === 'export' || action === 'import';
  }
  if (normalizedToolName === 'run_in_terminal') {
    return NPM_PROJECT_MUTATION_PATTERN.test(normalizeString(input?.['command']));
  }
  return false;
}

export interface WorkspaceRevisionQuiescenceOptions {
  readonly requiredStablePasses?: number;
  readonly maxPasses?: number;
  readonly yieldTurn?: () => Promise<void>;
}

/** Wait until Blockly's deferred mutation events reach revision tracking. */
export async function waitForWorkspaceRevisionQuiescence(
  readRevision: () => number,
  options: WorkspaceRevisionQuiescenceOptions = {},
): Promise<void> {
  const requiredStablePasses = Math.max(1, options.requiredStablePasses ?? 2);
  const maxPasses = Math.max(requiredStablePasses, options.maxPasses ?? 12);
  const yieldTurn = options.yieldTurn ?? yieldBrowserRevisionTurn;
  let previousRevision = readRevision();
  let stablePasses = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    await yieldTurn();
    const currentRevision = readRevision();
    if (currentRevision === previousRevision) {
      stablePasses += 1;
      if (stablePasses >= requiredStablePasses) return;
    } else {
      previousRevision = currentRevision;
      stablePasses = 0;
    }
  }
}

async function yieldBrowserRevisionTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    const finishAfterBrowserTask = () => setTimeout(resolve, 0);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(finishAfterBrowserTask);
    } else {
      finishAfterBrowserTask();
    }
  });
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToolName(value: unknown): string {
  const normalized = normalizeString(value);
  if (normalized === 'run_terminal') return 'run_in_terminal';
  return normalized.startsWith('mcp_') ? normalized.slice(4) : normalized;
}
