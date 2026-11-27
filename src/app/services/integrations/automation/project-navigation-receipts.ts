import type { ProjectStorageAttachment } from '../../shared/project-sync-storage-bridge';
import { ProjectNavigationTransition } from '../../domains/project/project-navigation-transition';

const MAX_DEADLINE_MS = 310_000;
const RETENTION_MS = 600_000;
const MAX_RECEIPTS = 512;
const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface ProjectNavigationRequest {
  version: 1;
  requestId: string;
  rendererGeneration: number;
  deadlineAt: number;
  operation: 'project_open' | 'project_close';
  sourceProject: string | null;
  targetProject: string | null;
}

type NavigationResult = Record<string, any>;
type View = { project: string | null; revision: number };
type Activation = { state: 'open' | 'closed'; project: string | null; attachment?: ProjectStorageAttachment };
type Entry = {
  request: ProjectNavigationRequest;
  sourceAttachment?: ProjectStorageAttachment;
  activation?: Activation;
  revision?: number;
  result?: NavigationResult;
  transition: ProjectNavigationTransition;
};

export function readProjectNavigationRequest(value: unknown, isAbsolute: (path: string) => boolean): ProjectNavigationRequest | undefined {
  const input = value as Partial<ProjectNavigationRequest> | undefined;
  const absolute = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['version', 'requestId', 'rendererGeneration', 'deadlineAt', 'operation', 'sourceProject', 'targetProject'].includes(key))
    || input.version !== 1 || typeof input.requestId !== 'string' || !requestIdPattern.test(input.requestId)
    || !Number.isSafeInteger(input.rendererGeneration) || input.rendererGeneration! <= 0
    || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt! > Date.now() + MAX_DEADLINE_MS
    || input.sourceProject !== null && !absolute(input.sourceProject)
    || !(input.operation === 'project_open' && absolute(input.targetProject)
      || input.operation === 'project_close' && input.targetProject === null)) return undefined;
  return { version: 1, requestId: input.requestId, rendererGeneration: input.rendererGeneration!, deadlineAt: input.deadlineAt!,
    operation: input.operation, sourceProject: input.sourceProject, targetProject: input.targetProject };
}

/** One renderer owns its navigation receipts. Observation never calls a writer. */
export class ProjectNavigationReceipts {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly currentView: () => View,
    private readonly captureAttachment: (project: string) => ProjectStorageAttachment | undefined,
    private readonly sameProject: (a: string, b: string) => boolean) {}

  observe(request: ProjectNavigationRequest) {
    const entry = this.exact(request);
    return { ok: true, operation: 'project_navigation_status', ...this.receipt(request, entry),
      ...(entry?.result ? { result: entry.result } : {}) };
  }

  canReopenFrom(closed: ProjectNavigationRequest, project: string): boolean {
    const entry = this.exact(closed);
    return !!(closed.operation === 'project_close' && closed.sourceProject && this.sameProject(closed.sourceProject, project)
      && entry?.activation?.state === 'closed' && this.isActivationCurrent(entry));
  }

  stop(request: ProjectNavigationRequest): void {
    const entry = this.exact(request);
    if (entry && !entry.result) entry.transition.stop();
  }

  async start(request: ProjectNavigationRequest,
    execute: (activate: (view: View) => void, transition: ProjectNavigationTransition) => Promise<NavigationResult>) {
    const existing = this.entries.get(request.requestId);
    if (existing) {
      const original = this.exact(request);
      if (!original) return { ok: false, code: 'PROJECT_NAVIGATION_REQUEST_REUSED', commandDispatched: false };
      return { ...(original.result ?? { ok: false, operation: request.operation, code: 'PROJECT_NAVIGATION_PENDING' }),
        ...this.receipt(request, original) };
    }
    if (request.deadlineAt <= Date.now()) return { ok: false, operation: request.operation,
      code: 'PROJECT_NAVIGATION_EXPIRED', commandDispatched: false };
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, entry] of this.entries) {
      // An exact close can authorize reopening for as long as its empty view survives.
      if (entry.result && entry.request.deadlineAt < cutoff && entry.revision !== this.currentView().revision) this.entries.delete(id);
    }
    if (this.entries.size >= MAX_RECEIPTS) return { ok: false, operation: request.operation,
      code: 'PROJECT_NAVIGATION_CAPACITY_REACHED', commandDispatched: false };
    const entry: Entry = { request, transition: new ProjectNavigationTransition() };
    this.entries.set(request.requestId, entry);
    try {
      entry.result = await execute(view => {
        if (entry.activation || !this.matchesCurrent(view)) return;
        if (request.operation === 'project_open' && view.project && request.targetProject
          && this.sameProject(view.project, request.targetProject)) {
          const attachment = this.attachment(view.project);
          entry.activation = { state: 'open', project: view.project, ...(attachment ? { attachment } : {}) };
        } else if (request.operation === 'project_close' && view.project === null && request.sourceProject) {
          entry.activation = { state: 'closed', project: null };
        } else return;
        entry.revision = view.revision;
      }, entry.transition);
    } catch (error) {
      const original = error as { code?: string; commandDispatched?: boolean } | undefined;
      entry.result = { ok: false, operation: request.operation, code: original?.code ?? 'PROJECT_NAVIGATION_FAILED',
        ...(original?.commandDispatched === false ? { commandDispatched: false } : {}),
        message: error instanceof Error ? error.message : String(error) };
    }
    return { ...entry.result, ...this.receipt(request, entry) };
  }

  captureSource(request: ProjectNavigationRequest): void {
    const entry = this.exact(request);
    if (entry && request.operation === 'project_close' && request.sourceProject
      && this.sameNullableProject(request.sourceProject, this.currentView().project)) {
      entry.sourceAttachment = this.attachment(request.sourceProject);
    }
  }

  private exact(request: ProjectNavigationRequest): Entry | undefined {
    const entry = this.entries.get(request.requestId);
    const original = entry?.request;
    return original?.rendererGeneration === request.rendererGeneration && original.deadlineAt === request.deadlineAt
      && original.operation === request.operation && original.sourceProject === request.sourceProject
      && original.targetProject === request.targetProject ? entry : undefined;
  }

  private attachment(project: string): ProjectStorageAttachment | undefined {
    try { return this.captureAttachment(project); } catch { return undefined; }
  }

  private sameNullableProject(a: string | null, b: string | null): boolean {
    return a === null || b === null ? a === b : this.sameProject(a, b);
  }

  private matchesCurrent(view: View): boolean {
    const current = this.currentView();
    return current.revision === view.revision && this.sameNullableProject(current.project, view.project);
  }

  private isActivationCurrent(entry: Entry): boolean {
    const { activation, revision, request } = entry;
    if (!activation || revision === undefined || !this.matchesCurrent({ project: activation.project, revision })) return false;
    const original = activation.state === 'open' ? activation.attachment : entry.sourceAttachment;
    const project = activation.state === 'open' ? activation.project : request.sourceProject;
    if (!original || !project) return false;
    const current = this.attachment(project);
    return !!current && this.sameProject(current.root, original.root)
      && current.identity.dev === original.identity.dev && current.identity.ino === original.identity.ino
      && current.identity.birthtimeNs === original.identity.birthtimeNs;
  }

  private receipt(request: ProjectNavigationRequest, entry: Entry | undefined) {
    return { navigationReceipt: { ...request, state: !entry ? 'unknown' : !entry.result ? 'pending'
      : entry.result['ok'] === true ? 'completed' : 'failed',
      ...(entry?.activation ? { activation: entry.activation } : {}),
      ...(entry?.sourceAttachment ? { sourceAttachment: entry.sourceAttachment } : {}) },
      activationCurrent: !!entry && this.isActivationCurrent(entry) };
  }
}
