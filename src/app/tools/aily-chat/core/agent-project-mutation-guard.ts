export interface AgentProjectMutationBaseline {
  readonly projectPath: string;
  readonly workspaceUserEditRevision: number;
}

export class AgentProjectMutationConflictError extends Error {
  readonly code = 'agent-project-user-edit-conflict';

  constructor() {
    super(
      'The Blockly Project was edited by the user while the main Agent was applying Scene changes. '
      + 'Review the current workspace, then run Sync Scene to Code & Build again.',
    );
    this.name = 'AgentProjectMutationConflictError';
  }
}

export function createAgentProjectMutationBaseline(
  projectPath: unknown,
  workspaceUserEditRevision: unknown,
): AgentProjectMutationBaseline {
  return Object.freeze({
    projectPath: normalizeProjectPath(projectPath),
    workspaceUserEditRevision: normalizeRevision(workspaceUserEditRevision),
  });
}

export function assertAgentProjectMutationBaselineCurrent(
  baseline: AgentProjectMutationBaseline,
  projectPath: unknown,
  workspaceUserEditRevision: unknown,
): void {
  if (
    normalizeProjectPath(projectPath) !== baseline.projectPath
    || normalizeRevision(workspaceUserEditRevision)
      !== baseline.workspaceUserEditRevision
  ) {
    throw new AgentProjectMutationConflictError();
  }
}

function normalizeProjectPath(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/gu, '/').replace(/\/+$/gu, '').toLowerCase()
    : '';
}

function normalizeRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('workspaceUserEditRevision must be a non-negative safe integer.');
  }
  return value as number;
}
