export interface ProjectViewOpenFailure {
  version: 1;
  project: string;
  code: string;
  sourceViewPreserved: true;
  ownership: { state: 'active' | 'unknown' | 'busy'; reason?: string };
  holder?: { pid: number };
}

interface ProjectViewLockFailure {
  code?: string;
  error?: string;
  ownership?: { state?: string; reason?: string };
  holder?: { pid?: number };
}

/** A noninteractive open reports ownership, never requests a force takeover. */
export function projectViewOpenError(project: string, result: ProjectViewLockFailure): Error {
  const state = result.ownership?.state === 'active' ? 'active'
    : result.code === 'PROJECT_VIEW_BUSY' ? 'busy' : 'unknown';
  const failure: ProjectViewOpenFailure = { version: 1, project,
    code: typeof result.code === 'string' ? result.code : 'PROJECT_VIEW_ACQUIRE_FAILED', sourceViewPreserved: true,
    ownership: { state, ...(typeof result.ownership?.reason === 'string' ? { reason: result.ownership.reason } : {}) },
    ...(Number.isSafeInteger(result.holder?.pid) && result.holder.pid > 0 ? { holder: { pid: result.holder.pid } } : {}) };
  return Object.assign(new Error(result.error || 'Project view acquisition was not confirmed; no owner was replaced.'),
    { code: failure.code, projectView: failure });
}

export function readProjectViewOpenFailure(error: unknown, project: string): ProjectViewOpenFailure | undefined {
  const value = (error as { projectView?: ProjectViewOpenFailure })?.projectView;
  return value?.version === 1 && value.project === project && value.sourceViewPreserved === true
    && ['active', 'unknown', 'busy'].includes(value.ownership?.state) ? value : undefined;
}
