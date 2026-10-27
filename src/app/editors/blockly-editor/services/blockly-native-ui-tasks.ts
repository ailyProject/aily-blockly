import type * as Blockly from 'blockly';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { absProgramWorkspace } from '../../../integrations/blockly/abs/abs-program-state';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { serializeRuntimeFieldContract } from './blockly-runtime-block-metadata';
import { createBlocklyBlockActivity } from './blockly-block-activity';
import { captureCustomFunctionRegistration } from './blockly-custom-function-contract';
import type { AbsNativeUiTiming } from '../../../integrations/blockly/abs/abs-diagnostics';

/** Candidate-local, virtual one-shot tasks. No event loop, waiting or arbitrary
 * async completion. Tasks are admitted by their observed semantic effects,
 * never by a library name or by guessing that setTimeout means UI work. */
export class NativeUiTasks {
  private readonly pending = new Map<number, { due: number; callback: () => unknown }>();
  private sequence = 0;
  private now = 0;
  private forbidden = false;
  private failure?: Error;
  private readonly timing: Omit<AbsNativeUiTiming, 'pending'> = { callbacks: 0, snapshots: 0, callbackMs: 0, snapshotMs: 0 };
  private reportedCallbacks = 0;
  private reportedAt = 0;

  constructor(private readonly observe?: (timing: AbsNativeUiTiming) => void, private readonly clock = () => performance.now()) {}

  private report(force = false): void {
    if (!this.observe) return;
    const now = this.clock();
    if (!force && (this.timing.callbacks - this.reportedCallbacks < 64 || now - this.reportedAt < 50)) return;
    this.reportedAt = now; this.reportedCallbacks = this.timing.callbacks;
    this.observe({ ...this.timing, pending: this.pending.size });
  }
  private snapshot(read: () => string): string {
    const started = this.observe ? this.clock() : 0;
    this.timing.snapshots++;
    try { return this.withoutScheduling(read); }
    finally { if (this.observe) this.timing.snapshotMs += Math.max(0, this.clock() - started); }
  }

  get hasPending(): boolean { return this.pending.size > 0; }
  assertClean(): void { if (this.failure) throw this.failure; }
  private reject(error: string | Error): never {
    this.failure ??= typeof error === 'string' ? new Error(error) : error;
    this.pending.clear(); throw this.failure;
  }
  private limit(resource: string, actual: number, limit: number): never {
    return this.reject(new AbsSyncError('ABS_LIMIT',
      `Native UI tasks exceed the finite callback/delay budget (${resource}: ${actual}, limit: ${limit}).`, undefined, [], {
        reason: 'native-ui-capacity', capacity: { phase: 'ui', resource, actual: Math.ceil(actual), limit },
        hint: 'Deterministic virtual UI capacity failure. Retain ABS and repair the host; waiting or retrying unchanged ABS cannot help.',
      }));
  }
  set(callback: () => unknown, delay = 0): number {
    this.assertClean();
    if (this.forbidden) return this.reject('Native candidate does not support timers during generation.');
    if (typeof callback !== 'function' || typeof delay !== 'number' || !Number.isFinite(delay)
      || delay < 0) {
      return this.reject('Native UI tasks require a function and finite non-negative delay.');
    }
    if (delay > 2000) return this.limit('singleDelay', delay, 2000);
    if (++this.sequence > 512) return this.limit('callbacks', this.sequence, 512);
    // Parallel initialization timers share a due time. Only nested/serial work
    // advances virtual elapsed time; a large workspace is not a long timer chain.
    const due = this.now + delay;
    if (due > 5000) return this.limit('virtualDelay', due, 5000);
    const id = -this.sequence;
    this.pending.set(id, { due, callback });
    return id;
  }
  clear(id: number): void { this.pending.delete(id); }
  /** Only the captured Blockly core queueRender implementation uses this scope.
   * Scheduled work still passes the finite queue and semantic readback checks. */
  coreRender<T>(action: () => T): T {
    const previous = this.forbidden; this.forbidden = false;
    try { return action(); } finally { this.forbidden = previous; }
  }
  withoutScheduling<T>(action: () => T): T {
    const previous = this.forbidden; this.forbidden = true;
    try { const value = action(); this.assertClean(); return value; }
    finally { this.forbidden = previous; }
  }
  drain(snapshot: () => string): void {
    this.assertClean();
    if (!this.pending.size) return;
    this.report(true);
    try { this.drainPending(snapshot); }
    finally { this.report(true); }
  }
  private drainPending(snapshot: () => string): void {
    // No event can interleave this synchronous queue. Reuse each verified
    // post-callback snapshot as the next precondition, without skipping a task.
    let before = this.snapshot(snapshot);
    while (this.pending.size) {
      // Stable Map order breaks ties; nested tasks use virtual due time.
      // Select the minimum without allocating and sorting the entire queue for
      // every callback. Equal due times retain insertion order, including nested work.
      let selected: [number, { due: number; callback: () => unknown }] | undefined;
      for (const entry of this.pending) if (!selected || entry[1].due < selected[1].due) selected = entry;
      const [id, task] = selected!;
      this.pending.delete(id); this.now = task.due;
      try {
        const started = this.observe ? this.clock() : 0;
        this.timing.callbacks++;
        let value: any;
        try { value = task.callback(); }
        finally { if (this.observe) this.timing.callbackMs += Math.max(0, this.clock() - started); }
        this.assertClean();
        if (value && typeof value.then === 'function') this.reject('Native candidate does not support asynchronous UI callbacks.');
        const after = this.snapshot(snapshot);
        if (after !== before) this.reject('Native deferred UI task changed persisted state, structure or field constraints' + semanticDifferencePath(before, after) + '.');
        before = after;
        this.report();
      } catch (error) { this.reject(error instanceof Error ? error : String(error)); }
    }
    this.assertClean();
  }
  dispose(): void { this.pending.clear(); }
}

/** Report location only, never serialized field/resource contents. */
function semanticDifferencePath(before: string, after: string): string {
  const difference = (left: any, right: any, path: string): string | undefined => {
    if (Object.is(left, right)) return undefined;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return path;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const found = difference(left[key], right[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  try { return ` at ${difference(JSON.parse(before), JSON.parse(after), '') || '/'}`; }
  catch { return ''; }
}

/** Exclude display labels/tooltips, but include empty sockets, option keys,
 * checks, and all serializers. Empty inputs are not necessarily present in ABI. */
export function nativeUiSemanticSnapshot(native: typeof Blockly, workspace: Blockly.Workspace): string {
  captureCustomFunctionRegistration(native.Blocks)?.prepareSerialization(workspace);
  const active = createBlocklyBlockActivity();
  return absJson({ state: absProgramWorkspace(native.serialization.workspaces.save(workspace)),
    shapes: workspace.getAllBlocks(false).map(block => ({ id: block.id,
      connections: [block.outputConnection, block.previousConnection, block.nextConnection].map(value => value && [value.type, value.getCheck()]),
      inputs: block.inputList.map(input => ({ name: input.name, connection: input.connection && [input.connection.type, input.connection.getCheck()],
        fields: input.fieldRow.filter(field => field.name && field.SERIALIZABLE !== false).map(field => {
          const contract = serializeRuntimeFieldContract(field, field.saveState(), { preserveDropdownValue: !active(block) });
          return { name: field.name, ...contract,
            ...(contract.options ? { options: contract.options.map(option => option[1]) } : {}) };
        }) })),
    })).sort((a, b) => a.id.localeCompare(b.id)) });
}
