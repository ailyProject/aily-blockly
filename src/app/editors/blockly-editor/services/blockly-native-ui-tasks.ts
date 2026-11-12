import type * as Blockly from 'blockly';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { absProgramWorkspace } from '../../../integrations/blockly/abs/abs-program-state';
import { serializeRuntimeFieldContract } from './blockly-runtime-block-metadata';
import { createBlocklyBlockActivity } from './blockly-block-activity';
import { captureCustomFunctionRegistration } from './blockly-custom-function-contract';
import type { AbsNativeUiTiming } from '../../../integrations/blockly/abs/abs-diagnostics';
import { nativeSemanticChange } from './blockly-native-semantic-diagnostic';
import { NativeUiTaskBudget, type NativeUiTaskKind } from './blockly-native-ui-budget';

/** Candidate-local, virtual one-shot tasks. No event loop, waiting or arbitrary
 * async completion. Tasks are admitted by their observed semantic effects,
 * never by a library name or by guessing that setTimeout means UI work. */
export class NativeUiTasks {
  private readonly pending = new Map<number, { due: number; callback: () => unknown; kind: NativeUiTaskKind }>();
  private readonly budget = new NativeUiTaskBudget();
  private sequence = 0;
  private now = 0;
  private forbidden = false;
  private disposed = false;
  private failure?: Error;
  private readonly timing: Omit<AbsNativeUiTiming, 'pending'> = { callbacks: 0, snapshots: 0, callbackMs: 0, snapshotMs: 0 };
  private reportedCallbacks = 0;
  private reportedAt = 0;

  constructor(private readonly observe?: (timing: AbsNativeUiTiming) => void, private readonly clock = performance.now.bind(performance)) {}

  private report(force = false): void {
    if (!this.observe) return;
    const now = this.clock();
    // Either bound can publish progress: a slow queue shorter than 64 tasks
    // must not stay silent until its final callback finishes.
    if (!force && this.timing.callbacks - this.reportedCallbacks < 64 && now - this.reportedAt < 50) return;
    this.reportedAt = now; this.reportedCallbacks = this.timing.callbacks;
    this.observe({ ...this.timing, ...this.budget.counts(), pending: this.pending.size });
  }
  private snapshot(read: () => string): string {
    const started = this.observe ? this.clock() : 0;
    this.timing.snapshots++;
    try { return this.withoutScheduling(read); }
    finally { if (this.observe) this.timing.snapshotMs += Math.max(0, this.clock() - started); }
  }

  get hasPending(): boolean { return this.pending.size > 0; }
  assertClean(): void {
    if (this.failure) throw this.failure;
    if (this.disposed) throw new Error('Native UI tasks are disposed.');
  }
  private reject(error: string | Error): never {
    this.failure ??= typeof error === 'string' ? new Error(error) : error;
    this.pending.clear();
    try { this.report(true); } catch { /* Diagnostics never replace the original rejection. */ }
    throw this.failure;
  }
  set(callback: () => unknown, delay = 0): number {
    return this.add(callback, delay, 'timer');
  }
  frame(callback: () => unknown): number {
    return this.add(callback, 0, 'frame');
  }
  private add(callback: () => unknown, delay: number, kind: NativeUiTaskKind): number {
    this.assertClean();
    if (this.forbidden) return this.reject('Native candidate does not support timers during generation.');
    if (typeof callback !== 'function' || typeof delay !== 'number' || !Number.isFinite(delay)
      || delay < 0) {
      return this.reject('Native UI tasks require a function and finite non-negative delay.');
    }
    // Parallel initialization timers share a due time. Only nested/serial work
    // advances virtual elapsed time; a large workspace is not a long timer chain.
    const due = this.now + delay;
    try { this.budget.delay(delay, due); this.budget.register(this.pending.size + 1, kind); }
    catch (error) { return this.reject(error instanceof Error ? error : String(error)); }
    const id = -++this.sequence;
    this.pending.set(id, { due, callback, kind });
    return id;
  }
  clear(id: number): void {
    // Disposal may invoke native cancellation while unwinding an earlier failure.
    if (!this.failure && !this.disposed) {
      try { this.budget.cancel(this.pending.get(id)?.kind); }
      catch (error) { return this.reject(error instanceof Error ? error : String(error)); }
    }
    this.pending.delete(id);
  }
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
  drain(snapshot: () => string, phase: 'initialization' | 'ui' = 'ui'): void {
    this.assertClean();
    if (!this.pending.size) return;
    this.report(true);

    try {
      const before = this.snapshot(snapshot);
      while (this.pending.size) this.drainNext();
      this.assertClean();
      this.verifyPhase(snapshot, before, phase);
    } catch (error) { this.reject(error instanceof Error ? error : String(error)); }
    finally { this.report(true); }
  }

  /** A disposable candidate is checked at complete phase boundaries. Host turns
   * retain lightweight scope/cancellation checks; intermediate callback state
   * may settle before the final full semantic readback. */
  async drainCooperatively(snapshot: () => string, yieldToHost: () => Promise<void>,
    assertCurrent: () => void, phase: 'initialization' | 'ui' = 'ui'): Promise<void> {
    this.assertClean(); assertCurrent();
    if (!this.pending.size) return;
    this.report(true);

    try {
      const before = this.snapshot(snapshot);
      let sliceStarted = this.clock(), count = 0;

      while (this.pending.size) {
        this.drainNext();
        if (this.pending.size && (++count >= 8 || this.clock() - sliceStarted >= 8)) {
          this.report(true);
          this.assertClean(); assertCurrent();
          await yieldToHost();
          this.assertClean(); assertCurrent();
          sliceStarted = this.clock(); count = 0;
        }
      }

      this.assertClean(); assertCurrent();
      this.verifyPhase(snapshot, before, phase);
    } catch (error) { this.reject(error instanceof Error ? error : String(error)); }
    finally { this.report(true); }
  }

  private verifyPhase(snapshot: () => string, before: string, phase: 'initialization' | 'ui'): void {
    const after = this.snapshot(snapshot);
    if (after !== before) this.reject(nativeSemanticChange(before, after, phase));
  }

  private drainNext(): void {
    // Equal due times retain insertion order, including nested work.
    let selected: [number, { due: number; callback: () => unknown; kind: NativeUiTaskKind }] | undefined;
    for (const entry of this.pending) if (!selected || entry[1].due < selected[1].due) selected = entry;
    const [id, task] = selected!;
    this.pending.delete(id); this.now = task.due;
    try {
      this.budget.execute(task.kind);
      const started = this.observe ? this.clock() : 0;
      this.timing.callbacks++;
      let value: any;
      try { value = task.callback(); }
      finally { if (this.observe) this.timing.callbackMs += Math.max(0, this.clock() - started); }
      this.assertClean();
      if (value && typeof value.then === 'function') this.reject('Native candidate does not support asynchronous UI callbacks.');
      this.report();
    } catch (error) { return this.reject(error instanceof Error ? error : String(error)); }
  }
  dispose(): void { this.disposed = true; this.pending.clear(); }
}

/** Exclude display labels/tooltips, but include empty sockets, option keys,
 * checks, and all serializers. Empty inputs are not necessarily present in ABI. */
export function nativeUiSemanticSnapshot(native: typeof Blockly, workspace: Blockly.Workspace): string {
  captureCustomFunctionRegistration(native.Blocks)?.prepareSerialization(workspace);
  const active = createBlocklyBlockActivity();
  const state = absProgramWorkspace(native.serialization.workspaces.save(workspace));
  // The built-in variable table is keyed by ID, just as in complete ABI
  // readback. Canonicalize the detached snapshot, retaining complete records
  // and duplicates. Never sort roots, connections or arbitrary extraState.
  if (Array.isArray(state['variables']) && state['variables'].every(value => value
    && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string')) {
    state['variables'] = [...state['variables']].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  return absJson({ state,
    shapes: workspace.getAllBlocks(false).map(block => ({ id: block.id, type: block.type,
      connections: [block.outputConnection, block.previousConnection, block.nextConnection].map(value => value && [value.type, value.getCheck()]),
      inputs: block.inputList.map(input => ({ name: input.name, connection: input.connection && [input.connection.type, input.connection.getCheck()],
        fields: input.fieldRow.filter(field => field.name && field.SERIALIZABLE !== false).map(field => {
          const contract = serializeRuntimeFieldContract(field, field.saveState(), { preserveDropdownValue: !active(block) });
          return { name: field.name, ...contract,
            ...(contract.options ? { options: contract.options.map(option => option[1]) } : {}) };
        }) })),
    })).sort((a, b) => a.id.localeCompare(b.id)) });
}
