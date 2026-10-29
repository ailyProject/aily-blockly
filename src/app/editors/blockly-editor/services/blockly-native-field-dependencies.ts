import type * as Blockly from 'blockly';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { NativeUiTasks, nativeUiSemanticSnapshot } from './blockly-native-ui-tasks';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';
import { nativeSemanticChange } from './blockly-native-semantic-diagnostic';

const active = new WeakMap<Blockly.Workspace, NativeFieldDependencies>();
const initializers = new Set<{ workspace: () => Blockly.Workspace | null; initialize: (workspace: Blockly.Workspace) => void }>();
export const nativeFieldDependencies = (workspace: Blockly.Workspace) => active.get(workspace);

/** The live host notifies library listeners only, never save/code-generation UI
 * listeners while fields are incomplete. Candidate workspaces have no host UI. */
export function registerNativeFieldInitializer(workspace: () => Blockly.Workspace | null,
  initialize: (workspace: Blockly.Workspace) => void): () => void {
  const entry = { workspace, initialize };
  initializers.add(entry);
  return () => { initializers.delete(entry); };
}

/** Construction-only dependency boundary. A missing dropdown option is not a
 * missing variable. Keep the requested value outside Blockly until native
 * initialization supplies it; never insert a guessed option or accept a fallback.
 * Library one-shot tasks use the existing bounded virtual queue, not wall time. */
export class NativeFieldDependencies {
  private readonly pending = new Map<Blockly.Block, Map<string, () => void>>();
  private readonly timers = new Map<number, { callback: () => void; delay: number; cancel: () => void; release: () => void; virtual?: number }>();
  private sequence = 0;
  private loadingNotified = false;
  private settling = false;
  private readonly tasks: NativeUiTasks;
  private readonly initializationQueue: boolean;
  constructor(private readonly native: typeof Blockly, private readonly workspace: Blockly.Workspace,
    tasks?: NativeUiTasks, private readonly initializationPhase: 'before-ui' | 'settled' = 'settled',
    private readonly completeTopology = true) {
    // Only disposable candidates hand in their complete construction queue.
    // An ordinary live host keeps unrelated timers on its normal event loop.
    this.initializationQueue = tasks !== undefined;
    this.tasks = tasks ?? new NativeUiTasks();
  }

  get blocks(): ReadonlySet<Blockly.Block> { return new Set(this.pending.keys()); }
  defer(block: Blockly.Block, name: string, apply: () => void): void {
    let fields = this.pending.get(block);
    if (!fields) this.pending.set(block, fields = new Map());
    fields.set(name, apply);
  }
  /** Host timers still run normally when no dependency needs preparation. Only
   * timers scheduled inside this loading scope can be claimed for virtual work. */
  trackTimer(callback: () => void, delay: number, cancel: () => void, release: () => void): number {
    const id = ++this.sequence;
    const timer = { callback, delay, cancel, release, virtual: undefined as number | undefined };
    this.timers.set(id, timer);
    if (this.settling) { cancel(); timer.virtual = this.tasks.set(callback, delay); }
    return id;
  }
  cancelTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer?.virtual !== undefined) this.tasks.clear(timer.virtual);
    this.timers.delete(id);
  }

  private retry(): unknown {
    let failure: unknown;
    for (const [block, fields] of this.pending) {
      for (const [name, apply] of fields) {
        const before = this.snapshot();
        try {
          apply();
          const after = this.snapshot();
          if (after !== before) throw nativeSemanticChange(before, after, 'initialization', 'Native deferred field changed other persisted state or structure');
          fields.delete(name);
        } catch (error) {
          const after = this.snapshot();
          if (after !== before) throw nativeSemanticChange(before, after, 'initialization', 'Native rejected field changed persisted state or structure');
          if (!(error instanceof AbsSyncError) || error.code !== 'ABS_FIELD_OPTION_INVALID') throw error;
          failure = error;
        }
      }
      if (!fields.size) this.pending.delete(block);
    }
    return failure;
  }
  private snapshot(): string {
    const value = JSON.parse(nativeUiSemanticSnapshot(this.native, this.workspace));
    const states = new Map(collectProjectBlocks(value.state).map(({ state }) => [state['id'], state]));
    // Option discovery is allowed only during construction. All other shape,
    // model, topology and already-bound field state remains immutable.
    for (const shape of value.shapes) for (const input of shape.inputs) for (const field of input.fields) {
      if (field.type !== 'field_dropdown') continue;
      const pending = this.pending.get(this.workspace.getBlockById(shape.id)!);
      const fields = states.get(shape.id)?.['fields'] as Record<string, unknown> | undefined;
      const selected = fields?.[field.name];
      // Discovery may expand/reorder candidates, never invalidate an already
      // bound selection. Retaining options in that case exposes the change to
      // the same per-callback semantic comparison instead of hiding it.
      if (field.preservedValue || pending?.has(field.name) || field.options?.includes(selected)) delete field.options;
    }
    for (const { state } of collectProjectBlocks(value.state)) {
      const pending = this.pending.get(this.workspace.getBlockById(state['id'] as string)!);
      for (const name of pending?.keys() ?? []) if (state['fields']) delete state['fields'][name];
    }
    return absJson(value);
  }
  settle(required = true): void {
    if (!this.pending.size && (!this.initializationQueue || !required)) return;
    if (!this.pending.size && this.loadingNotified && !this.tasks.hasPending && !this.timers.size) return;
    this.settling = true;
    try {
      for (const timer of this.timers.values()) {
        timer.cancel();
        if (timer.virtual === undefined) timer.virtual = this.tasks.set(timer.callback, timer.delay);
      }
      if (!this.loadingNotified && this.completeTopology) {
        this.loadingNotified = true;
        // Events are disabled during candidate loading. Deliver the normal
        // completed-topology notification directly, without undo/UI event queues.
        this.tasks.set(() => {
          const initializer = [...initializers].find(entry => entry.workspace() === this.workspace);
          if (initializer) initializer.initialize(this.workspace);
          else this.workspace.fireChangeListener(new this.native.Events.FinishedLoading(this.workspace));
        });
      }
      // A complete bound document can generate before initialization in the
      // first fresh realm. Keep the queued notification as deferred evidence:
      // the independent settled realm must reproduce its code/artifacts/macros.
      // Missing requested options still require the original recovery worklist.
      if (!this.pending.size && this.initializationPhase === 'before-ui') return;
      this.tasks.drain(() => this.snapshot(), 'initialization');
      const failure = this.retry();
      if (required && this.pending.size) throw failure;
    } finally { this.settling = false; }
  }
  dispose(): void {
    for (const timer of this.timers.values()) if (timer.virtual !== undefined) {
      this.tasks.clear(timer.virtual); timer.release();
    }
    this.pending.clear(); this.timers.clear();
  }
}

export function withNativeFieldDependencies<T>(native: typeof Blockly, workspace: Blockly.Workspace,
  action: () => T, tasks?: NativeUiTasks, phase: 'before-ui' | 'settled' = 'settled', completeTopology = true): T {
  const scope = beginNativeFieldDependencies(native, workspace, tasks, phase, completeTopology);
  try { const result = action(); scope.finish(); return result; }
  finally { scope.dispose(); }
}

/** A chunked load owns one scope across every fragment, not one per block. */
export function beginNativeFieldDependencies(native: typeof Blockly, workspace: Blockly.Workspace, tasks?: NativeUiTasks,
  phase: 'before-ui' | 'settled' = 'settled', completeTopology = true) {
  if (active.has(workspace)) return { prepare() {}, finish() {}, dispose() {} };
  const scope = new NativeFieldDependencies(native, workspace, tasks, phase, completeTopology);
  active.set(workspace, scope);
  return { prepare: () => scope.settle(false), finish: () => scope.settle(),
    dispose: () => { active.delete(workspace); scope.dispose(); } };
}
