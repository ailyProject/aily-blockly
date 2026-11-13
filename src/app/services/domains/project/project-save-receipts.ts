import type { ProjectStorageAttachment, ProjectStorageExecutor } from '../../shared/project-sync-storage-bridge';
import { readProjectSaveInput, type ProjectSaveInput } from '../../shared/project-save-input';
export { readProjectSaveInput, type ProjectSaveInput } from '../../shared/project-save-input';

export type ProjectSaveOperation = 'project_save' | 'blocks_tidy';
export type ProjectPublicationOperation = ProjectSaveOperation | 'blocks_set_state' | 'history_restore';
export interface ProjectSaveRequest {
  version: 1 | 2;
  requestId: string;
  operation: ProjectSaveOperation;
  waitMs?: number;
  input?: ProjectSaveInput;
}
export interface ProjectSaveReceipt {
  version: 1 | 2;
  requestId: string;
  project: string;
  operation: ProjectPublicationOperation;
  state: 'queued' | 'running' | 'completed' | 'unknown';
  input?: ProjectSaveInput;
}
export interface ProjectSaveReceiptResponse {
  ok: true;
  operation: ProjectSaveOperation | 'project_save_status';
  saveReceipt: ProjectSaveReceipt;
  result?: Record<string, any>;
  code?: string;
  publicationObservation?: {
    version: 1; durable: boolean; requestId: string; operation: ProjectPublicationOperation; operationId: string;
    attachment: ProjectStorageAttachment; executor: ProjectStorageExecutor; observer: { hostPid: number | null }; current: boolean;
  };
}
/** Reads the existing publication journal; never admits or repeats a writer.
 * null means no v2 admission record, not that a legacy request never ran. */
export type ProjectSaveDurableLookup = (
  project: string, request: ProjectSaveRequest,
) => Promise<ProjectSaveReceiptResponse | null>;
interface SaveEntry {
  project: string;
  operation: ProjectSaveOperation;
  input?: ProjectSaveInput;
  context: readonly unknown[];
  state: 'queued' | 'running' | 'completed';
  completion: Promise<void>;
  waiters: Set<() => void>;
  completedAt?: number;
  result?: Record<string, any>;
}
interface SaveIdentity { project: string; operation: ProjectSaveOperation; input?: ProjectSaveInput; }

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
    || Object.keys(request).some(key => !['version', 'requestId', 'operation', 'waitMs', 'input'].includes(key))
    || ![1, 2].includes(request.version) || typeof request.requestId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || !['project_save', 'blocks_tidy'].includes(request.operation)
    || request.version === 2 && !/^pub2-[a-f0-9-]{36}$/.test(request.requestId)
    || request.version === 1 && request.requestId.startsWith('pub2-')
    || request.waitMs !== undefined && (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 10000))
    throw fail('PROJECT_SAVE_RECEIPT_INVALID', 'Invalid save receipt request.');
  const input = readProjectSaveInput(request.input);
  if (input && (request.version !== 2 || request.operation !== 'project_save'))
    throw fail('PROJECT_SAVE_RECEIPT_INVALID', 'Board inputs require the original durable project-save request.');
  return { version: request.version, requestId: request.requestId, operation: request.operation, waitMs: request.waitMs ?? 0,
    ...(input ? { input } : {}) };
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
  private readonly durableLookup?: ProjectSaveDurableLookup;
  private readonly durableOnly: boolean | ((project: string) => boolean);

  constructor(options: { now?: () => number; retentionMs?: number; completedLimit?: number; identityLimit?: number;
    durableLookup?: ProjectSaveDurableLookup; durableOnly?: boolean | ((project: string) => boolean) } = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.completedLimit = options.completedLimit ?? 32;
    this.identityLimit = options.identityLimit ?? 8192;
    this.durableLookup = options.durableLookup;
    this.durableOnly = typeof options.durableOnly === 'function' ? options.durableOnly : options.durableOnly === true;
  }

  async start(project: string, input: ProjectSaveRequest, context: readonly unknown[], run: () => Promise<Record<string, any>>): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input);
    this.assertAdmissionProtocol(project, request);
    const original = await this.priorResult(project, request);
    if (original) return original;
    const entry = this.admit(project, request, context, run);
    return this.observe(request.operation, project, request, entry);
  }

  /** UI/exit keep this original Promise, independent of any feedback timer. */
  async execute(project: string, input: ProjectSaveRequest, context: readonly unknown[], run: () => Promise<Record<string, any>>): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input);
    this.assertAdmissionProtocol(project, request);
    const original = await this.priorResult(project, request);
    if (original) return original;
    const entry = this.admit(project, request, context, run);
    await entry.completion;
    if (request.version === 2) return await this.durable(project, request)
      ?? this.response(request.operation, project, request, entry);
    return this.response(request.operation, project, request, entry);
  }

  private assertAdmissionProtocol(project: string, request: ProjectSaveRequest): void {
    const required = typeof this.durableOnly === 'function' ? this.durableOnly(project) : this.durableOnly;
    if (required && request.version !== 2) throw fail('PROJECT_SAVE_PROTOCOL_UPGRADE_REQUIRED',
      'This host requires the matching durable save protocol. Legacy unknown requests cannot start another save.');
  }

  async status(project: string, input: ProjectSaveRequest, lookup?: ProjectSaveDurableLookup): Promise<ProjectSaveReceiptResponse> {
    const request = readProjectSaveRequest(input);
    this.prune();
    const entry = this.find(project, request);
    if (entry) await this.wait(entry, request.waitMs);
    if (entry && entry.state !== 'completed') return this.response('project_save_status', project, request, entry);
    const identity = this.find(project, request) ?? this.expired.get(request.requestId);
    const original = await this.durable(project, request, lookup);
    const current = this.find(project, request);
    // A lookup may overlap a newly admitted task. Observe that exact task's
    // lifetime before using a snapshot obtained before its final result.
    const currentIdentity = current ?? this.expired.get(request.requestId);
    if (currentIdentity && currentIdentity !== identity) return this.status(project, request, lookup);
    return original ?? this.response('project_save_status', project, request, current);
  }

  private async priorResult(project: string, request: ProjectSaveRequest): Promise<ProjectSaveReceiptResponse | null> {
    const entry = this.find(project, request);
    if (entry && entry.state !== 'completed') return null;
    const identity = entry ?? this.expired.get(request.requestId);
    const original = await this.durable(project, request);
    const current = this.find(project, request);
    if (current && current.state !== 'completed') return null;
    const currentIdentity = current ?? this.expired.get(request.requestId);
    return currentIdentity && currentIdentity !== identity ? this.durable(project, request) : original;
  }

  private async durable(project: string, request: ProjectSaveRequest,
    lookup: ProjectSaveDurableLookup | undefined = this.durableLookup): Promise<ProjectSaveReceiptResponse | null> {
    if (request.version !== 2) return null;
    if (!lookup) throw fail('PROJECT_SAVE_DURABILITY_UNAVAILABLE', 'This host cannot admit a durable save request. No save was started.');
    const response = await lookup(project, request);
    if (!response) return null;
    const receipt = response.saveReceipt;
    let sameInput = false;
    try { sameInput = JSON.stringify(readProjectSaveInput(receipt.input)) === JSON.stringify(request.input); } catch { /* Invalid observations grant no original-input authority. */ }
    if (response.ok !== true || receipt.version !== 2 || receipt.requestId !== request.requestId
      || receipt.operation !== request.operation || projectKey(receipt.project) !== projectKey(project) || !sameInput) {
      throw fail('PROJECT_SAVE_RECEIPT_CONFLICT', 'The durable observation does not identify this exact original request.');
    }
    return response;
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
    const entry: SaveEntry = { project, operation: request.operation, ...(request.input ? { input: request.input } : {}), context: [...context], state: 'queued',
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
    if (identity && (projectKey(identity.project) !== normalized || identity.operation !== request.operation
      || JSON.stringify(identity.input ?? null) !== JSON.stringify(request.input ?? null)))
      throw fail('PROJECT_SAVE_RECEIPT_CONFLICT', 'This save ID belongs to another project or operation.');
    return entry;
  }

  private async observe(operation: ProjectSaveReceiptResponse['operation'], project: string, request: ProjectSaveRequest,
    entry?: SaveEntry): Promise<ProjectSaveReceiptResponse> {
    if (entry) await this.wait(entry, request.waitMs);
    if (entry && entry.state !== 'completed') return this.response(operation, project, request, entry);
    if (request.version === 2) {
      const original = await this.durable(project, request);
      if (original) return original;
    }
    return this.response(operation, project, request, entry);
  }

  private async wait(entry: SaveEntry, waitMs = 0): Promise<void> {
    if (entry.state !== 'completed' && waitMs) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); entry.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, waitMs);
      entry.waiters.add(finish);
    });
  }

  private response(operation: ProjectSaveReceiptResponse['operation'], project: string, request: ProjectSaveRequest,
    entry?: SaveEntry): ProjectSaveReceiptResponse {
    // RAM cannot prove a v2 publication, including after this same path is
    // replaced by an empty root. A completed writer must have a durable result.
    if (request.version === 2 && entry?.state === 'completed') return { ok: true, operation,
      saveReceipt: { version: 2, requestId: request.requestId, project, operation: request.operation, state: 'unknown',
        ...(request.input ? { input: clone(request.input) } : {}) },
      code: 'PROJECT_SAVE_PUBLICATION_UNKNOWN' };
    return { ok: true, operation, saveReceipt: { version: request.version, requestId: request.requestId,
      project: entry?.project ?? project, operation: request.operation, state: entry?.state ?? 'unknown',
      ...(request.input ? { input: clone(request.input) } : {}) },
      ...(entry?.state === 'completed' ? { result: clone(entry.result) }
        : !entry ? { code: this.expired.has(request.requestId) ? 'PROJECT_SAVE_RECEIPT_EXPIRED' : 'PROJECT_SAVE_RECEIPT_UNKNOWN' } : {}) };
  }

  private prune(): void {
    const completed = [...this.entries].filter(([, entry]) => entry.state === 'completed')
      .sort(([, a], [, b]) => a.completedAt! - b.completedAt!);
    let excess = completed.length - this.completedLimit;
    for (const [id, entry] of completed) if (entry.completedAt! < this.now() - this.retentionMs || excess > 0) {
      this.expired.set(id, { project: entry.project, operation: entry.operation, ...(entry.input ? { input: entry.input } : {}) });
      this.entries.delete(id); excess--;
    }
  }
}
