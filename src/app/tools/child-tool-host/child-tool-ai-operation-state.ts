export type ChildAiRunPhase = 'running' | 'reconnecting' | 'stopping' | 'settling';

export interface ChildAiRun {
  readonly sessionId: string;
  readonly turnId: string;
  readonly running: true;
  readonly active: boolean;
  readonly phase: ChildAiRunPhase;
}

export interface ChildAiRunOwner {
  readonly version: 2;
  readonly bridgeInstanceId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const phases = new Set(['running', 'reconnecting', 'stopping', 'settling']);
const key = (run: Pick<ChildAiRun, 'sessionId' | 'turnId'>) => JSON.stringify([run.sessionId, run.turnId]);

/** One child connection owns one ordered, complete run snapshot. A visible
 * session is only a presentation preference, never an execution identity. */
export class ChildAiOperationState {
  private bridgeInstanceId = '';
  private revision = 0;
  private visibleSessionId: string | null = null;
  private runs: readonly ChildAiRun[] = [];
  private snapshotKey = '';
  private readonly stopping = new Set<string>();

  constructor(private scope: string) {}

  reset(scope: string, preserveRuns = false): void {
    this.scope = scope;
    this.bridgeInstanceId = '';
    this.revision = 0;
    this.visibleSessionId = null;
    if (!preserveRuns) this.runs = [];
    this.snapshotKey = '';
    this.stopping.clear();
  }

  apply(value: unknown): Record<string, unknown> {
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (input['scope'] !== this.scope) return { ok: false, code: 'AI_OPERATION_SCOPE_CHANGED' };
    if (input['version'] !== 2 || !text(input['bridgeInstanceId'])
      || !Number.isSafeInteger(input['revision']) || Number(input['revision']) < 1
      || !(input['visibleSessionId'] === null || text(input['visibleSessionId']))
      || !Array.isArray(input['runs']) || input['runs'].length > 128) {
      return { ok: false, code: 'AI_OPERATION_STATE_INVALID' };
    }
    const runs: ChildAiRun[] = [], owners = new Set<string>();
    for (const item of input['runs']) {
      if (!item || typeof item !== 'object' || !text(item.sessionId) || !text(item.turnId)
        || item.running !== true || typeof item.active !== 'boolean' || !phases.has(item.phase)
        || owners.has(item.sessionId)) return { ok: false, code: 'AI_OPERATION_STATE_INVALID' };
      owners.add(item.sessionId);
      runs.push(Object.freeze({ sessionId: item.sessionId, turnId: item.turnId,
        running: true, active: item.active, phase: item.phase }));
    }
    if (this.bridgeInstanceId && input['bridgeInstanceId'] !== this.bridgeInstanceId) {
      return { ok: false, code: 'AI_OPERATION_BRIDGE_CHANGED' };
    }
    const acknowledgement = { ok: true, version: 2, scope: this.scope,
      bridgeInstanceId: input['bridgeInstanceId'], revision: input['revision'] };
    const snapshotKey = JSON.stringify([input['visibleSessionId'], runs]);
    if (Number(input['revision']) === this.revision) {
      return snapshotKey === this.snapshotKey ? { ...acknowledgement, applied: true }
        : { ...acknowledgement, ok: false, applied: false, code: 'AI_OPERATION_REVISION_CONFLICT' };
    }
    if (Number(input['revision']) <= this.revision) {
      return { ...acknowledgement, applied: false, currentRevision: this.revision };
    }
    this.bridgeInstanceId = input['bridgeInstanceId'];
    this.revision = Number(input['revision']);
    this.visibleSessionId = input['visibleSessionId'] as string | null;
    this.runs = runs;
    this.snapshotKey = snapshotKey;
    const currentKeys = new Set(runs.map(key));
    for (const owner of this.stopping) if (!currentKeys.has(owner)) this.stopping.delete(owner);
    return { ...acknowledgement, applied: true };
  }

  get hasRunning(): boolean { return this.runs.length > 0; }
  get hasActive(): boolean { return this.runs.some(run => run.active); }
  get awaitingSnapshot(): boolean { return this.hasRunning && !this.bridgeInstanceId; }

  get selected(): { run: ChildAiRun; owner: ChildAiRunOwner; stopping: boolean } | undefined {
    const run = this.runs.find(item => item.active && item.sessionId === this.visibleSessionId)
      ?? this.runs.find(item => item.active)
      ?? this.runs.find(item => item.sessionId === this.visibleSessionId) ?? this.runs[0];
    return run ? { run, owner: { version: 2, bridgeInstanceId: this.bridgeInstanceId,
      sessionId: run.sessionId, turnId: run.turnId },
      stopping: run.phase === 'stopping' || this.stopping.has(key(run)) } : undefined;
  }

  beginStop(owner: ChildAiRunOwner): boolean {
    if (!this.owns(owner) || this.stopping.has(key(owner))
      || this.runs.some(run => key(run) === key(owner) && run.phase === 'stopping')) return false;
    this.stopping.add(key(owner));
    return true;
  }

  stopRejected(owner: ChildAiRunOwner): void {
    if (this.owns(owner)) this.stopping.delete(key(owner));
  }

  private owns(owner: ChildAiRunOwner): boolean {
    return !!this.bridgeInstanceId && owner.bridgeInstanceId === this.bridgeInstanceId
      && this.runs.some(run => key(run) === key(owner));
  }
}
