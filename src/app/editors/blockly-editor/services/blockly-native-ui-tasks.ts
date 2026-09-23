import type * as Blockly from 'blockly';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { serializeRuntimeFieldContract } from './blockly-runtime-block-metadata';

/** Candidate-local, virtual one-shot tasks. No event loop, waiting or arbitrary
 * async completion. Tasks are admitted by their observed semantic effects,
 * never by a library name or by guessing that setTimeout means UI work. */
export class NativeUiTasks {
  private readonly pending = new Map<number, { due: number; callback: () => unknown }>();
  private sequence = 0;
  private now = 0;
  private delayBudget = 0;
  private forbidden = false;
  private failure?: Error;

  get hasPending(): boolean { return this.pending.size > 0; }
  assertClean(): void { if (this.failure) throw this.failure; }
  private reject(message: string): never {
    this.failure ??= new Error(message); this.pending.clear(); throw this.failure;
  }
  set(callback: () => unknown, delay = 0): number {
    this.assertClean();
    if (this.forbidden) return this.reject('Native candidate does not support timers during generation.');
    if (typeof callback !== 'function' || typeof delay !== 'number' || !Number.isFinite(delay)
      || delay < 0 || delay > 2000 || ++this.sequence > 128 || (this.delayBudget += delay) > 5000) {
      return this.reject('Native UI tasks exceed the finite callback/delay budget.');
    }
    const id = -this.sequence;
    this.pending.set(id, { due: this.now + delay, callback });
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
    while (this.pending.size) {
      // Stable Map order breaks ties; nested tasks use virtual due time.
      const [id, task] = [...this.pending].sort((a, b) => a[1].due - b[1].due)[0];
      const before = this.withoutScheduling(snapshot);
      this.pending.delete(id); this.now = task.due;
      try {
        const value: any = task.callback(); this.assertClean();
        if (value && typeof value.then === 'function') this.reject('Native candidate does not support asynchronous UI callbacks.');
        const after = this.withoutScheduling(snapshot);
        if (after !== before) this.reject('Native deferred UI task changed persisted state, structure or field constraints' + semanticDifferencePath(before, after) + '.');
      } catch (error) { this.reject(String(error)); }
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
  return absJson({ state: native.serialization.workspaces.save(workspace),
    shapes: workspace.getAllBlocks(false).map(block => ({ id: block.id,
      connections: [block.outputConnection, block.previousConnection, block.nextConnection].map(value => value && [value.type, value.getCheck()]),
      inputs: block.inputList.map(input => ({ name: input.name, connection: input.connection && [input.connection.type, input.connection.getCheck()],
        fields: input.fieldRow.filter(field => field.name && field.SERIALIZABLE !== false).map(field => {
          const contract = serializeRuntimeFieldContract(field, field.saveState());
          return { name: field.name, ...contract,
            ...(contract.options ? { options: contract.options.map(option => option[1]) } : {}) };
        }) })),
    })).sort((a, b) => a.id.localeCompare(b.id)) });
}
