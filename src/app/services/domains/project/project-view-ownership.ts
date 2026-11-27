export interface ProjectViewOpenFailure {
  version: 1;
  project: string;
  code: string;
  sourceViewPreserved: true;
  ownership: { state: 'active' | 'unknown' | 'busy'; reason?: string };
  holder?: { pid: number };
}

export interface ProjectViewLockFailure {
  conflict?: boolean;
  code?: string;
  error?: string;
  ownership?: { state?: string; reason?: string };
  holder?: { pid?: number };
  focus?: { viewToken?: string };
}

export function isProjectViewConflict(result: ProjectViewLockFailure): boolean {
  return result.code === 'PROJECT_VIEW_OCCUPIED' || result.code === 'PROJECT_VIEW_OWNER_UNKNOWN'
    || !result.code && result.conflict === true;
}

/** A noninteractive open reports ownership, never requests a force takeover. */
export function projectViewOpenError(project: string, result: ProjectViewLockFailure): Error {
  const state = result.ownership?.state === 'active' || result.code === 'PROJECT_VIEW_OCCUPIED' ? 'active'
    : result.code === 'PROJECT_VIEW_BUSY' ? 'busy' : 'unknown';
  const pid = result.holder?.pid;
  const failure: ProjectViewOpenFailure = { version: 1, project,
    code: typeof result.code === 'string' ? result.code : 'PROJECT_VIEW_ACQUIRE_FAILED', sourceViewPreserved: true,
    ownership: { state, ...(typeof result.ownership?.reason === 'string' ? { reason: result.ownership.reason } : {}) },
    ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { holder: { pid } } : {}) };
  return Object.assign(new Error(result.error || 'Project view acquisition was not confirmed; no owner was replaced.'),
    { code: failure.code, projectView: failure });
}

export function readProjectViewOpenFailure(error: unknown, project: string): ProjectViewOpenFailure | undefined {
  const value = (error as { projectView?: ProjectViewOpenFailure })?.projectView;
  return value?.version === 1 && value.project === project && value.sourceViewPreserved === true
    && ['active', 'unknown', 'busy'].includes(value.ownership?.state) ? value : undefined;
}
