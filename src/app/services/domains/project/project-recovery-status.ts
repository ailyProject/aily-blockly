export interface CurrentProjectRecoveryRuntime {
  version: 1;
  project: string;
  sameProject: boolean;
  ready: boolean;
  projectSessionId: string | null;
  rendererGeneration?: number;
  loadStatus: { project: string; ready: boolean; state: string; error?: string };
}

/** The journal owns the immutable operation result. Only this response describes
 * the current runtime; it is never written back as the old operation's result. */
export function withCurrentProjectRecoveryStatus(
  result: Record<string, any>,
  currentProjectRuntime: CurrentProjectRecoveryRuntime,
): Record<string, any> {
  const terminal = result['recoveryState'] === 'completed' || result['recoveryState'] === 'failed';
  if (!terminal) return { ...result, currentProjectRuntime };
  const originalRecovery = {
    ok: result['ok'] === true,
    ready: result['ready'] === true,
    recoveryState: result['recoveryState'],
  };
  const current = currentProjectRuntime.sameProject && currentProjectRuntime.ready;
  const response = {
    ...result,
    ready: current,
    loadStatus: currentProjectRuntime.loadStatus,
    originalRecovery,
    currentProjectRuntime,
  };
  if (!originalRecovery.ok || current) return response;
  return {
    ...response,
    ok: false,
    code: currentProjectRuntime.sameProject ? 'PROJECT_RECOVERY_CURRENT_NOT_READY' : 'PROJECT_RECOVERY_CONTEXT_STALE',
    message: currentProjectRuntime.sameProject
      ? 'The original recovery completed; the current project runtime is not ready.'
      : 'The original recovery completed for a project that is no longer current.',
    nextAction: currentProjectRuntime.sameProject ? {
      tool: 'project_recover',
      input: {
        project: currentProjectRuntime.project,
        action: currentProjectRuntime.loadStatus.error ? 'recover_project' : 'inspect',
      },
    } : undefined,
  };
}
