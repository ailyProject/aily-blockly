import type * as Blockly from 'blockly';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { NativeUiTasks, nativeUiSemanticSnapshot } from './blockly-native-ui-tasks';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import { collectProjectBlocks } from '@domain/project/project-data/public-api';

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
  constructor(private readonly native: typeof Blockly, private readonly workspace: Blockly.Workspace,
    private readonly tasks = new NativeUiTasks()) {}

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
          if (this.snapshot() !== before) throw new Error('Native deferred field changed other persisted state or structure.');
          fields.delete(name);
        } catch (error) {
          if (this.snapshot() !== before) throw new Error('Native rejected field changed persisted state or structure.');
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
    // Option discovery is allowed only during construction. All other shape,
    // model, topology and already-bound field state remains immutable.
    for (const shape of value.shapes) for (const input of shape.inputs) for (const field of input.fields) {
      if (field.type === 'field_dropdown') delete field.options;
    }
    for (const { state } of collectProjectBlocks(value.state)) {
      const pending = this.pending.get(this.workspace.getBlockById(state['id'] as string)!);
      for (const name of pending?.keys() ?? []) if (state['fields']) delete state['fields'][name];
    }
    return absJson(value);
  }
  settle(required = true): void {
    if (!this.pending.size) return;
    this.settling = true;
    try {
      for (const timer of this.timers.values()) {
        timer.cancel();
        if (timer.virtual === undefined) timer.virtual = this.tasks.set(timer.callback, timer.delay);
      }
      if (!this.loadingNotified) {
        this.loadingNotified = true;
        // Events are disabled during candidate loading. Deliver the normal
        // completed-topology notification directly, without undo/UI event queues.
        this.tasks.set(() => {
          const initializer = [...initializers].find(entry => entry.workspace() === this.workspace);
          if (initializer) initializer.initialize(this.workspace);
          else this.workspace.fireChangeListener(new this.native.Events.FinishedLoading(this.workspace));
        });
      }
      this.tasks.drain(() => this.snapshot());
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
  action: () => T, tasks?: NativeUiTasks): T {
  const scope = beginNativeFieldDependencies(native, workspace, tasks);
  try { const result = action(); scope.finish(); return result; }
  finally { scope.dispose(); }
}

/** A chunked load owns one scope across every fragment, not one per block. */
export function beginNativeFieldDependencies(native: typeof Blockly, workspace: Blockly.Workspace, tasks?: NativeUiTasks) {
  if (active.has(workspace)) return { finish() {}, dispose() {} };
  const scope = new NativeFieldDependencies(native, workspace, tasks);
  active.set(workspace, scope);
  return { finish: () => scope.settle(), dispose: () => { active.delete(workspace); scope.dispose(); } };
}
