export interface ProjectForkRequest { version: 1; requestId: string }

interface ForkRecord {
  project: string;
  requestId: string;
  sourceAbiHash: string | null;
  targetAbiHash?: string | null;
  state: 'running' | 'completed';
  result?: Record<string, any>;
  created?: boolean;
}

export interface ProjectForkReceiptStore {
  begin(project: string, requestId: string, signature: string, sourceAbiHash: string | null): ForkRecord;
  complete(project: string, requestId: string, signature: string, result: Record<string, any>, targetAbiHash: string | null): ForkRecord;
  status(project: string, requestId: string): ForkRecord | null;
  abiHash(project: string): string | null;
}

export function readProjectForkRequest(value: unknown): ProjectForkRequest {
  const request = value as ProjectForkRequest;
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== 1
    || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(request.requestId)
    || Object.keys(request).some(key => !['version', 'requestId'].includes(key)))
    throw Object.assign(new Error('Invalid fork receipt request.'), { code: 'PROJECT_FORK_RECEIPT_INVALID' });
  return { version: 1, requestId: request.requestId };
}

/** A caller observes an owned fork; losing a response never starts a second copy.
 * Durable native records survive renderer reload. Unknown owners remain unknown,
 * rather than being treated as cancelled or permission to repeat publication. */
export class ProjectForkReceipts {
  private readonly running = new Map<string, Promise<Record<string, any>>>();

  constructor(private readonly store: ProjectForkReceiptStore,
    private readonly refresh: (result: Record<string, any>) => Record<string, any> = result => result) {}

  async start(project: string, request: ProjectForkRequest, signature: string,
    run: () => Promise<Record<string, any>>): Promise<Record<string, any>> {
    const record = this.store.begin(project, request.requestId, signature, this.store.abiHash(project));
    if (!record.created) {
      if (this.running.has(request.requestId)) return this.running.get(request.requestId)!;
      return this.response(project, request, record, false);
    }
    const task = (async () => {
      let result: Record<string, any>;
      try { result = await run(); }
      catch (error) { result = { ok: false, operation: 'project_fork', sourceProject: project, projectSaved: false,
        code: (error as any)?.code ?? 'PROJECT_FORK_FAILED', message: error instanceof Error ? error.message : String(error) }; }
      const targetHash = result['projectSaved'] === true && typeof result['project'] === 'string'
        ? this.store.abiHash(result['project']) : null;
      const completed = this.store.complete(project, request.requestId, signature, result, targetHash);
      return this.response(project, request, completed, false);
    })();
    this.running.set(request.requestId, task);
    try { return await task; }
    finally { this.running.delete(request.requestId); }
  }

  status(project: string, request: ProjectForkRequest): Record<string, any> {
    return this.response(project, request, this.store.status(project, request.requestId), true);
  }

  private response(project: string, request: ProjectForkRequest, record: ForkRecord | null, observation: boolean) {
    const state = record?.state === 'completed' ? 'completed'
      : this.running.has(request.requestId) ? 'running' : 'unknown';
    const forkReceipt = { version: 1, requestId: request.requestId, project, state,
      ...(record ? { sourceAbiHash: record.sourceAbiHash, targetAbiHash: record.targetAbiHash ?? null } : {}) };
    if (state === 'completed') {
      const result = this.refresh(record!.result!);
      return observation ? { ok: true, operation: 'project_fork_status', forkReceipt, result }
        : { ...result, forkReceipt };
    }
    return { ok: observation, operation: observation ? 'project_fork_status' : 'project_fork', forkReceipt,
      code: state === 'running' ? 'PROJECT_FORK_RUNNING' : 'PROJECT_FORK_OUTCOME_UNKNOWN',
      observation: { resultKnown: false, operationCancelled: false },
      message: state === 'running' ? 'The original fork still owns its operation; observe this request instead of copying again.'
        : 'No completed fork receipt is available. Preserve source and any target; this does not authorize another copy or release a guard.' };
  }
}
