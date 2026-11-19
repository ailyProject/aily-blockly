/** A build owns its Promise; a caller only owns a bounded observation of it. */
export interface ProjectBuildRequest {
  version: 1;
  requestId: string;
  waitMs?: number;
}

export interface ProjectBuildReceiptResponse {
  ok: true;
  operation: 'project_build' | 'project_build_status';
  buildReceipt: { version: 1; requestId: string; project: string; state: 'running' | 'completed' | 'unknown' };
  result?: Record<string, any>;
}

interface BuildEntry {
  project: string;
  signature: string;
  completedAt?: number;
  result?: Record<string, any>;
  waiters: Set<() => void>;
}

type PersistedBuild = { state: ProjectBuildReceiptResponse['buildReceipt']['state']; result?: Record<string, any> };

function fault(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'BUILD_RECEIPT_CONFLICT' });
}

function projectKey(project: string): string {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
}

export function readProjectBuildRequest(value: unknown): ProjectBuildRequest {
  const request = value as ProjectBuildRequest;
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.version !== 1
    || typeof request.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.requestId)
    || request.waitMs !== undefined && (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 10_000)) {
    throw Object.assign(new Error('Invalid build receipt request.'), { code: 'BUILD_RECEIPT_INVALID' });
  }
  return { version: 1, requestId: request.requestId, waitMs: request.waitMs ?? 0 };
}

/** Live replies retain the full result; original disk evidence survives renderer replacement. */
export class ProjectBuildReceipts {
  private readonly entries = new Map<string, BuildEntry>();

  constructor(private readonly retentionMs = 10 * 60_000, private readonly completedLimit = 32,
    private readonly readPersisted?: (project: string, requestId: string) => PersistedBuild | undefined) {}

  start(project: string, request: ProjectBuildRequest, signature: string,
    run: () => Promise<Record<string, any>>): Promise<ProjectBuildReceiptResponse> {
    this.prune();
    let entry = this.find(project, request.requestId);
    if (entry && entry.signature !== signature) throw fault('Build request ID already belongs to different compile options.');
    if (!entry) {
      const original = this.readPersisted?.(project, request.requestId);
      if (original) return Promise.resolve(this.response('project_build', project, request, original));
      entry = { project, signature, waiters: new Set() };
      this.entries.set(request.requestId, entry);
      const owned = entry;
      void Promise.resolve().then(run).then(
        result => { owned.result = result; },
        error => { owned.result = { ok: false, operation: 'project_build', project,
          code: error?.code, buildOutcome: error?.buildOutcome,
          ...(error?.buildLog ? { buildLog: error.buildLog } : {}),
          ...(error?.buildSnapshot ? { buildSnapshot: error.buildSnapshot } : {}),
          message: error instanceof Error ? error.message : String(error) }; },
      ).then(() => {
        owned.completedAt = Date.now();
        for (const finish of [...owned.waiters]) finish();
        this.prune();
      });
    }
    return this.observe('project_build', project, request, entry);
  }

  status(project: string, request: ProjectBuildRequest): Promise<ProjectBuildReceiptResponse> {
    this.prune();
    return this.observe('project_build_status', project, request, this.find(project, request.requestId));
  }

  private find(project: string, requestId: string): BuildEntry | undefined {
    const entry = this.entries.get(requestId);
    if (entry && projectKey(entry.project) !== projectKey(project)) throw fault('Build request ID belongs to another project.');
    return entry;
  }

  private async observe(operation: ProjectBuildReceiptResponse['operation'], project: string,
    request: ProjectBuildRequest, entry?: BuildEntry): Promise<ProjectBuildReceiptResponse> {
    if (entry && entry.completedAt === undefined && request.waitMs) {
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); entry.waiters.delete(finish); resolve(); };
        const timer = setTimeout(finish, request.waitMs);
        entry.waiters.add(finish);
      });
    }
    const recovered = !entry || entry.result?.['buildOutcome'] === 'unknown'
      ? this.readPersisted?.(project, request.requestId) : undefined;
    const observed = recovered ?? (entry
      ? entry.completedAt === undefined ? { state: 'running' as const } : { state: 'completed' as const, result: entry.result }
      : { state: 'unknown' as const });
    return this.response(operation, entry?.project ?? project, request, observed);
  }

  private response(operation: ProjectBuildReceiptResponse['operation'], project: string, request: ProjectBuildRequest,
    observed: PersistedBuild): ProjectBuildReceiptResponse {
    return { ok: true, operation, buildReceipt: { version: 1, requestId: request.requestId, project, state: observed.state },
      ...(observed.result ? { result: observed.result } : {}) };
  }

  private prune(): void {
    const completed = [...this.entries].filter(([, entry]) => entry.completedAt !== undefined)
      .sort(([, a], [, b]) => a.completedAt! - b.completedAt!);
    const cutoff = Date.now() - this.retentionMs;
    let excess = completed.length - this.completedLimit;
    for (const [id, entry] of completed) {
      if (entry.completedAt! < cutoff || excess > 0) { this.entries.delete(id); excess--; }
    }
  }
}

/** Project routing is checked by the caller. Native inspection binds the execution and current artifact separately. */
export function readNativeBuildReceipt(project: string, requestId: string): PersistedBuild | undefined {
  const value = window['builder']?.inspectBuildExecution?.(project, requestId);
  if (value?.version !== 1 || value.buildRequestId !== requestId) return undefined;
  if (value.status === 'running' && value.ownerState === 'live') return { state: 'running' };
  if (!['completed', 'failed', 'cancelled'].includes(value.status)) return { state: 'unknown' };
  return { state: 'completed', result: { project, operation: 'project_build', ok: value.status === 'completed',
    ...(value.status === 'completed' && value.result && value.buildInput ? { buildInput: value.buildInput } : {}),
    ...(value.buildSnapshot ? { buildSnapshot: value.buildSnapshot } : {}),
    ...(value.buildHistory ? { buildHistory: value.buildHistory } : {}),
    ...(value.buildLog ? { buildLog: value.buildLog } : {}),
    ...(value.status === 'failed' ? { buildOutcome: 'failed', message: '原编译失败。' } : {}),
    ...(value.status === 'cancelled' ? { buildOutcome: 'cancelled', code: 'BUILD_CANCELLED', message: '原编译已取消。' } : {}) } };
}
