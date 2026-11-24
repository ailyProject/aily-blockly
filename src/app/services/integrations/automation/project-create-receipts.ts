import type { ProjectStorageAttachment } from '../../shared/project-sync-storage-bridge';

const MAX_DEADLINE_MS = 310_000;
const RETENTION_MS = 600_000;
const MAX_RECEIPTS = 512;
const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface ProjectCreateRequest {
  version: 1;
  requestId: string;
  rendererGeneration: number;
  deadlineAt: number;
}

export interface ProjectCreateGuard {
  readonly requestId: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  markCreated(project: string): void;
  beginHandoff(): void;
  recordActivation?(): Promise<boolean>;
  markActivated(): void;
}

type CreateResult = Record<string, any> & { ok: boolean };
type RecordCreateActivation = (project: string, attachment: ProjectStorageAttachment) => Promise<boolean>;
type State = 'pending' | 'completed' | 'failed' | 'cancelled' | 'unknown';

interface Entry {
  request: ProjectCreateRequest;
  abort: AbortController;
  createdProject?: string;
  createdAttachment?: ProjectStorageAttachment;
  operationKey?: string;
  handingOff: boolean;
  activationCommitted: boolean;
  activationRetained?: boolean;
  result?: CreateResult;
  state: State;
}

export function readProjectCreateRequest(value: unknown): ProjectCreateRequest | undefined {
  const input = value as Partial<ProjectCreateRequest> | undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['version', 'requestId', 'rendererGeneration', 'deadlineAt'].includes(key)) ||
      input.version !== 1 || typeof input.requestId !== 'string' || !requestIdPattern.test(input.requestId) ||
      !Number.isSafeInteger(input.rendererGeneration) || input.rendererGeneration! <= 0 ||
      !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt! > Date.now() + MAX_DEADLINE_MS) return undefined;
  return input as ProjectCreateRequest;
}

const cancelled = () => Object.assign(new Error('The original project creation expired or was cancelled.'),
  { code: 'PROJECT_CREATE_CANCELLED' });

/** Original request state belongs to one renderer generation and is independent of view admission. */
export class ProjectCreateReceipts {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly captureAttachment?: (project: string) => ProjectStorageAttachment | undefined) {}

  observe(request: ProjectCreateRequest) {
    return this.view(request, this.exact(request));
  }

  isActivationCurrent(request: ProjectCreateRequest, active: string, sameProject: (a: string, b: string) => boolean): boolean {
    const entry = this.exact(request);
    if (!entry?.activationCommitted || !entry.createdProject || !sameProject(active, entry.createdProject)) return false;
    if (!this.captureAttachment) return true; // Legacy preload has no physical identity observation.
    const original = entry.createdAttachment;
    if (!original) return false;
    try {
      const current = this.captureAttachment(entry.createdProject);
      return !!current && current.version === original.version && sameProject(current.root, original.root)
        && (['dev', 'ino', 'birthtimeNs'] as const).every(key => current.identity[key] === original.identity[key]);
    } catch { return false; }
  }

  cancel(request: ProjectCreateRequest) {
    let entry = this.exact(request);
    // Cancellation may arrive ahead of the original mutation.
    if (!entry && !this.entries.has(request.requestId)) entry = this.register(request);
    if (entry?.state === 'pending' && !entry.handingOff && !entry.activationCommitted) {
      entry.state = 'cancelled';
      entry.abort.abort(cancelled());
    }
    return this.view(request, entry);
  }

  async run(request: ProjectCreateRequest, operation: (guard: ProjectCreateGuard) => Promise<CreateResult>, operationKey?: string,
    recordActivation?: RecordCreateActivation) {
    const existing = this.exact(request);
    if (this.entries.has(request.requestId)) {
      return existing?.operationKey === undefined || existing.operationKey === operationKey
        ? this.observe(request)
        : { ...this.view(request), ok: false, code: 'PROJECT_CREATE_REQUEST_REUSED' };
    }
    const entry = this.register(request);
    if (!entry) return this.view(request);
    entry.operationKey = operationKey;
    const guard: ProjectCreateGuard = {
      requestId: request.requestId,
      signal: entry.abort.signal,
      assertCurrent: () => {
        if (!entry.handingOff && !entry.activationCommitted && (entry.abort.signal.aborted || Date.now() >= request.deadlineAt)) {
          this.cancel(request);
          throw cancelled();
        }
      },
      markCreated: project => {
        if (entry.createdProject !== undefined) return;
        entry.createdProject = project;
        try { entry.createdAttachment = this.captureAttachment?.(project); }
        catch { /* Keep the fact of creation even if its physical attachment is unavailable. */ }
      },
      beginHandoff: () => { guard.assertCurrent(); entry.handingOff = true; },
      ...(recordActivation ? { recordActivation: async () => {
        guard.assertCurrent();
        entry.activationRetained = false;
        if (entry.createdProject && entry.createdAttachment)
          entry.activationRetained = await recordActivation(entry.createdProject, entry.createdAttachment);
        return entry.activationRetained;
      } } : {}),
      markActivated: () => { guard.assertCurrent(); entry.activationCommitted = true; },
    };
    let onAbort!: () => void;
    const interrupted = new Promise<void>(resolve => {
      onAbort = resolve;
      entry.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    const expiry = setTimeout(() => this.cancel(request), Math.max(0, request.deadlineAt - Date.now()));
    const complete = async () => {
      try { guard.assertCurrent(); entry.result = await operation(guard); }
      catch (error) {
        entry.result = { ok: false, code: (error as { code?: string })?.code ?? 'PROJECT_CREATE_FAILED',
          message: error instanceof Error ? error.message : String(error) };
      }
      if (entry.state === 'pending') entry.state = entry.result.ok ? 'completed' : 'failed';
    };
    try {
      await Promise.race([complete(), interrupted]);
      return this.view(request, entry);
    } finally {
      clearTimeout(expiry);
      entry.abort.signal.removeEventListener('abort', onAbort);
    }
  }

  private exact(request: ProjectCreateRequest) {
    const entry = this.entries.get(request.requestId);
    return entry?.request.rendererGeneration === request.rendererGeneration && entry.request.deadlineAt === request.deadlineAt
      ? entry : undefined;
  }

  private register(request: ProjectCreateRequest): Entry | undefined {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, entry] of this.entries) {
      if (entry.state !== 'pending' && entry.request.deadlineAt < cutoff) this.entries.delete(id);
    }
    if (this.entries.size >= MAX_RECEIPTS) return undefined;
    const entry: Entry = { request: { ...request }, abort: new AbortController(), handingOff: false, activationCommitted: false, state: 'pending' };
    this.entries.set(request.requestId, entry);
    return entry;
  }

  private view(request: ProjectCreateRequest, entry?: Entry) {
    const state = entry?.state ?? 'unknown';
    const result = state === 'cancelled' ? { ok: false, code: 'PROJECT_CREATE_CANCELLED', message: cancelled().message }
      : entry?.result;
    return { ...(result ?? { ok: false }), createReceipt: { version: 1 as const,
      requestId: request.requestId, rendererGeneration: request.rendererGeneration, deadlineAt: request.deadlineAt, state,
      activationCommitted: entry?.activationCommitted ?? false,
      ...(entry?.activationRetained !== undefined ? { activationRetained: entry.activationRetained } : {}),
      ...(entry?.createdAttachment ? { createdAttachment: entry.createdAttachment } : {}),
      ...(entry?.createdProject ? { createdProject: entry.createdProject } : {}) } };
  }
}
