import type { SimulatorCapturedProjectActivation, SimulatorWebProjectPublicationPort } from './simulator-web-project-activation';

type PublicationResult = Awaited<ReturnType<SimulatorWebProjectPublicationPort['readPublication']>>;
export interface BlocklySimulatorPrewarmHandle {
  readonly ready: Promise<void>;
  readPublication(projectPath: string, signal: AbortSignal): Promise<PublicationResult>;
  close(): Promise<void>;
}
export interface BlocklySimulatorPrewarmSelection {
  readonly captured: SimulatorCapturedProjectActivation;
  readonly revision: number;
  readonly code: string;
}
interface Preparation {
  readonly selection: BlocklySimulatorPrewarmSelection;
  readonly handle: BlocklySimulatorPrewarmHandle;
  readonly intent: AbortController;
  ready: boolean;
  claiming: boolean;
  retiring: boolean;
  cleanup: Promise<void> | null;
}

export interface BlocklySimulatorPrewarmSnapshot {
  readonly closed: boolean; readonly scheduled: boolean; readonly reconciling: boolean;
  readonly retainedPreparation: boolean; readonly ready: boolean; readonly claiming: boolean;
  readonly cleanupPending: boolean; readonly retainedCleanupResponsibility: boolean;
  readonly attempts: number; readonly prepared: number; readonly failed: number;
  readonly claimed: number; readonly cancelled: number; readonly claimCount: number;
  readonly lastClaimReadiness: 'none' | 'pending' | 'ready';
}

/** Diagnostics only. Missing or invalid observations remain unknown; no
 * original handle, code, activation, source or caller identity is published. */
export function projectBlocklySimulatorPrewarmSnapshot(value: unknown): BlocklySimulatorPrewarmSnapshot | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const booleanKeys = ['closed', 'scheduled', 'reconciling', 'retainedPreparation', 'ready', 'claiming',
      'cleanupPending', 'retainedCleanupResponsibility'] as const;
    const integerKeys = ['attempts', 'prepared', 'failed', 'claimed', 'cancelled', 'claimCount'] as const;
    if (booleanKeys.some(key => typeof row[key] !== 'boolean')
      || integerKeys.some(key => !Number.isSafeInteger(row[key]) || (row[key] as number) < 0)
      || row['claimCount'] !== row['claimed']
      || !['none', 'pending', 'ready'].includes(row['lastClaimReadiness'] as string)) return null;
    return Object.freeze({ closed: row['closed'] as boolean, scheduled: row['scheduled'] as boolean,
      reconciling: row['reconciling'] as boolean, retainedPreparation: row['retainedPreparation'] as boolean,
      ready: row['ready'] as boolean, claiming: row['claiming'] as boolean, cleanupPending: row['cleanupPending'] as boolean,
      retainedCleanupResponsibility: row['retainedCleanupResponsibility'] as boolean,
      attempts: row['attempts'] as number, prepared: row['prepared'] as number, failed: row['failed'] as number,
      claimed: row['claimed'] as number, cancelled: row['cancelled'] as number, claimCount: row['claimCount'] as number,
      lastClaimReadiness: row['lastClaimReadiness'] as BlocklySimulatorPrewarmSnapshot['lastClaimReadiness'] });
  } catch { return null; }
}

/** Only one unclaimed publication handle. Contents, reference TTL and actual
 * source cleanup stay in the original publication/read authority. */
export function createBlocklySimulatorPrewarmTrigger(options: {
  readSelection(): BlocklySimulatorPrewarmSelection | null;
  prepare(captured: SimulatorCapturedProjectActivation, signal: AbortSignal): BlocklySimulatorPrewarmHandle;
  schedule?(work: () => void): () => void;
}) {
  const schedule = options.schedule ?? (work => { const timer = setTimeout(work, 0); return () => clearTimeout(timer); });
  let record: Preparation | null = null, scheduled: (() => void) | null = null;
  let reconciling: Promise<void> | null = null, rerun = false, closed = false, generation = 0;
  let attempts = 0, prepared = 0, failed = 0, claimed = 0, cancelled = 0;
  let lastClaimReadiness: BlocklySimulatorPrewarmSnapshot['lastClaimReadiness'] = 'none';
  const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  function check(captured: SimulatorCapturedProjectActivation, signal?: AbortSignal): void {
    signal?.throwIfAborted(); captured.signal.throwIfAborted(); captured.requireCurrent();
  }
  const sameActivation = (left: SimulatorCapturedProjectActivation, right: SimulatorCapturedProjectActivation) =>
    left.signal === right.signal && left.path === right.path && left.projectSessionId === right.projectSessionId;
  const sameSelection = (left: BlocklySimulatorPrewarmSelection, right: BlocklySimulatorPrewarmSelection) =>
    sameActivation(left.captured, right.captured) && left.revision === right.revision && left.code === right.code;
  function retire(selected: Preparation): Promise<void> {
    if (!selected.retiring) { selected.retiring = true; cancelled = increment(cancelled); selected.intent.abort(); }
    if (!selected.cleanup) {
      const task = Promise.resolve().then(() => selected.handle.close()).then(() => {
        if (record === selected) record = null;
      }).finally(() => { if (selected.cleanup === task) selected.cleanup = null; });
      selected.cleanup = task; void task.catch(() => { /* The exact failed handle remains in record for retry. */ });
    }
    return selected.cleanup;
  }
  function cancelScheduled(): void { scheduled?.(); scheduled = null; }
  function invalidate(): Promise<void> {
    ++generation; cancelScheduled(); rerun = false;
    return record ? retire(record) : Promise.resolve();
  }
  async function reconcile(): Promise<void> {
    const expected = generation, selected = options.readSelection();
    if (closed) return;
    if (!selected) { if (record) await retire(record); return; }
    check(selected.captured);
    if (record && !record.retiring && sameSelection(record.selection, selected)) return;
    if (record) await retire(record);
    if (closed || expected !== generation) return;
    const current = options.readSelection();
    if (!current || !sameSelection(current, selected)) return;
    check(current.captured);
    const intent = new AbortController();
    const handle = options.prepare(current.captured, intent.signal);
    attempts = increment(attempts);
    const next: Preparation = { selection: current, handle, intent, ready: false, claiming: false, retiring: false, cleanup: null };
    record = next;
    void handle.ready.then(() => { next.ready = true; prepared = increment(prepared); }, () => {
      failed = increment(failed);
      return retire(next).catch(() => { /* Unconfirmed original cleanup blocks fallback. */ });
    });
  }
  function notify(): void {
    if (closed) return;
    ++generation;
    if (scheduled) return;
    scheduled = schedule(() => {
      scheduled = null;
      if (reconciling) { rerun = true; return; }
      const task = reconcile().catch(() => { failed = increment(failed); }).finally(() => {
        if (reconciling === task) reconciling = null;
        if (rerun && !closed) { rerun = false; notify(); }
      });
      reconciling = task;
    });
  }
  return Object.freeze({
    notify,
    invalidate,
    async readPreparedPublication(captured: SimulatorCapturedProjectActivation, signal: AbortSignal): Promise<PublicationResult | null> {
      if (closed) throw new Error('The Blockly prewarm trigger is closed.');
      ++generation; cancelScheduled(); rerun = false; check(captured, signal);
      const selected = record;
      if (!selected) return null;
      if (selected.claiming) throw new Error('The prepared publication is already being claimed.');
      if (selected.retiring || !sameActivation(selected.selection.captured, captured)) {
        await retire(selected); check(captured, signal); return null;
      }
      check(selected.selection.captured, signal); check(captured, signal);
      const readiness = selected.ready ? 'ready' : 'pending';
      selected.claiming = true;
      try {
        const result = await selected.handle.readPublication(captured.path, signal);
        // The handle has transferred its original caller. The existing reader
        // adopts late results before checking its cancellation/current fence.
        if (record === selected) record = null;
        claimed = increment(claimed);
        lastClaimReadiness = readiness;
        return result;
      } catch (error) {
        try { await retire(selected); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Prepared publication cleanup remains unconfirmed.'); }
        check(captured, signal);
        return null; // Only after actual original handle cleanup succeeded.
      } finally { selected.claiming = false; }
    },
    async close(): Promise<void> {
      closed = true; await invalidate(); await reconciling;
      if (record) await retire(record);
    },
    snapshot() { return { closed, scheduled: scheduled !== null, reconciling: reconciling !== null,
      retainedPreparation: record !== null, ready: record?.ready ?? false, claiming: record?.claiming ?? false,
      cleanupPending: Boolean(record?.cleanup), retainedCleanupResponsibility: record !== null || reconciling !== null,
      attempts, prepared, failed, claimed, cancelled, claimCount: claimed, lastClaimReadiness }; },
  });
}
