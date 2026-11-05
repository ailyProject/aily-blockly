export type ProjectSaveOperation = 'project_save' | 'blocks_tidy';
export interface ProjectSaveRequest {
  version: 1;
  requestId: string;
  operation: ProjectSaveOperation;
  waitMs?: number;
}
export interface ProjectSaveReceipt {
  version: 1;
  requestId: string;
  project: string;
  operation: ProjectSaveOperation;
  state: 'queued' | 'running' | 'completed' | 'unknown';
}
export interface ProjectSaveReceiptResponse {
  ok: true;
  operation: ProjectSaveOperation | 'project_save_status';
  saveReceipt: ProjectSaveReceipt;
  result?: Record<string, any>;
  code?: string;
}
interface SaveEntry {
  project: string;
  operation: ProjectSaveOperation;
  context: readonly unknown[];
  state: 'queued' | 'running' | 'completed';
  completion: Promise<void>;
  waiters: Set<() => void>;
  completedAt?: number;
  result?: Record<string, any>;
}
interface SaveIdentity { project: string; operation: ProjectSaveOperation; }

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const projectKey = (project: string): string => {
  if (typeof project !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(project))
    throw fail('PROJECT_SAVE_RECEIPT_INVALID', 'A save receipt requires an explicit absolute project path.');
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
};

export function readProjectSaveRequest(value: unknown): ProjectSaveRequest {
  const request = value as ProjectSaveRequest;
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['version', 'requestId', 'operation', 'waitMs'].includes(key))
    || request.version !== 1 || typeof request.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || !['project_save', 'blocks_tidy'].includes(request.operation)
    || request.waitMs !== undefined && (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 10000))
    throw fail('PROJECT_SAVE_RECEIPT_INVALID', 'Invalid save receipt request.');
  return { version: 1, requestId: request.requestId, operation: request.operation, waitMs: request.waitMs ?? 0 };
}

/** A renderer owns a save task; callers own only observations. Expired results
 * retain consumed identities, so pruning can never turn a late ID into a write.
 * A new renderer has no proof of old work and reports unknown, not success. */
export class ProjectSaveReceipts {
  private readonly entries = new Map<string, SaveEntry>();
  private readonly expired = new Map<string, SaveIdentity>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly completedLimit: number;
  private readonly identityLimit: number;

  constructor(options: { now?: () => number; retentionMs?: number; completedLimit?: number; identityLimit?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.completedLimit = options.completedLimit ?? 32;
    this.identityLimit = options.identityLimit ?? 8192;
  }

  start(project: string, input: ProjectSaveRequest, context: readonly unknown[], run: () => Promise<Record<string, any>>): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input), entry = this.admit(project, request, context, run);
    return this.observe(request.operation, project, request, entry);
  }

  /** UI/exit keep this original Promise, independent of any feedback timer. */
  async execute(project: string, input: ProjectSaveRequest, context: readonly unknown[], run: () => Promise<Record<string, any>>): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input), entry = this.admit(project, request, context, run);
    await entry.completion;
    return this.response(request.operation, project, request, entry);
  }

  status(project: string, input: ProjectSaveRequest): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input);
    this.prune();
    const entry = this.find(project, request);
    return this.observe('project_save_status', project, request, entry);
  }

  private admit(project: string, request: ProjectSaveRequest, context: readonly unknown[], run: () => Promise<Record<string, any>>): SaveEntry {
    this.prune();
    const existing = this.find(project, request);
    if (existing) {
      if (existing.context.length !== context.length || existing.context.some((value, i) => value !== context[i]))
        throw fail('PROJECT_SAVE_RECEIPT_CONTEXT_STALE', 'This save ID belongs to an earlier project session. Observe its original receipt; do not submit it again.');
      return existing;
    }
    if (this.expired.has(request.requestId))
      throw fail('PROJECT_SAVE_RECEIPT_EXPIRED', 'This original save result expired. Its consumed ID cannot start another save.');
    if (this.entries.size + this.expired.size >= this.identityLimit)
      throw fail('PROJECT_SAVE_RECEIPT_CAPACITY', 'Save receipt admission reached its finite host limit. Existing requests remain observable; no new save was started.');
    let finish!: () => void;
    const entry: SaveEntry = { project, operation: request.operation, context: [...context], state: 'queued',
      completion: new Promise<void>(resolve => { finish = resolve; }), waiters: new Set() };
    this.entries.set(request.requestId, entry);
    void Promise.resolve().then(async () => {
      entry.state = 'running';
      try { entry.result = clone(await run()); }
      catch (error) {
        const facts = error as { code?: unknown; projectSaved?: unknown; generatedCodePublished?: unknown; partial?: unknown };
        entry.result = { ok: false, operation: request.operation, project,
          message: error instanceof Error ? error.message : String(error),
          ...(typeof facts?.code === 'string' ? { code: facts.code } : {}),
          ...(typeof facts?.projectSaved === 'boolean' ? { projectSaved: facts.projectSaved,
            generatedCodePublished: facts.generatedCodePublished === true, partial: facts.partial === true } : {}) };
      }
      entry.state = 'completed'; entry.completedAt = this.now();
      finish(); for (const waiter of [...entry.waiters]) waiter();
      this.prune();
    });
    return entry;
  }

  private find(project: string, request: ProjectSaveRequest): SaveEntry | undefined {
    const normalized = projectKey(project), entry = this.entries.get(request.requestId);
    const identity = entry ?? this.expired.get(request.requestId);
    if (identity && (projectKey(identity.project) !== normalized || identity.operation !== request.operation))
      throw fail('PROJECT_SAVE_RECEIPT_CONFLICT', 'This save ID belongs to another project or operation.');
    return entry;
  }

  private async observe(operation: ProjectSaveReceiptResponse['operation'], project: string, request: ProjectSaveRequest,
    entry?: SaveEntry): Promise<ProjectSaveReceiptResponse> {
    if (entry && entry.state !== 'completed' && request.waitMs) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); entry.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, request.waitMs);
      entry.waiters.add(finish);
    });
    return this.response(operation, project, request, entry);
  }

  private response(operation: ProjectSaveReceiptResponse['operation'], project: string, request: ProjectSaveRequest,
    entry?: SaveEntry): ProjectSaveReceiptResponse {
    return { ok: true, operation, saveReceipt: { version: 1, requestId: request.requestId,
      project: entry?.project ?? project, operation: request.operation, state: entry?.state ?? 'unknown' },
      ...(entry?.state === 'completed' ? { result: clone(entry.result) }
        : !entry ? { code: this.expired.has(request.requestId) ? 'PROJECT_SAVE_RECEIPT_EXPIRED' : 'PROJECT_SAVE_RECEIPT_UNKNOWN' } : {}) };
  }

  private prune(): void {
    const completed = [...this.entries].filter(([, entry]) => entry.state === 'completed')
      .sort(([, a], [, b]) => a.completedAt! - b.completedAt!);
    let excess = completed.length - this.completedLimit;
    for (const [id, entry] of completed) if (entry.completedAt! < this.now() - this.retentionMs || excess > 0) {
      this.expired.set(id, { project: entry.project, operation: entry.operation });
      this.entries.delete(id); excess--;
    }
  }
}
