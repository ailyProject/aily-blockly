import type * as Blockly from 'blockly';

export interface GeneratorMacroEffect { name: string; value: string | null }
const scopes = new WeakMap<object, GeneratorProjectEffects>();

/** Legacy generator chains are finite, already-settled computations, not I/O.
 * Execute them in the owning block call and capture project writes as data.
 * No native Promise, timer or asynchronous executor is adopted by this bridge. */
export class GeneratorProjectEffects {
  private owner?: string;
  private active = false;
  private failure?: Error;
  private steps = 0;
  private readonly effects = new Map<string, Map<string, GeneratorMacroEffect>>();
  private readonly wrapped = new WeakSet<Function>();

  constructor(private readonly realm: any) {}

  private fail(reason: string): never {
    this.failure ??= Object.assign(new Error(`Generator project effects: ${reason}`), {
      code: 'ABS_NATIVE_EFFECT_UNSUPPORTED', diagnostic: { reason,
        hint: 'The host supports synchronous generation and settled project macro chains only. This is a generator/host capability mismatch, not a missing library or board mismatch. Do not upgrade libraries, change chunk mode or request manual block insertion without evidence of a fix.' },
    });
    throw this.failure;
  }

  private tick(): void {
    if (!this.active || !this.owner) this.fail('effect outside its owning generator call');
    if (++this.steps > 4096) this.fail('settled chain budget exceeded');
    if (this.failure) throw this.failure;
  }

  private macro(value: unknown, remove: boolean): void {
    this.tick();
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) this.fail('invalid project macro');
    // Some existing generators remove an empty previous driver on first use.
    if (remove && value === '') return;
    const name = remove ? value : value.split('=')[0];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) this.fail('invalid project macro name');
    let entries = this.effects.get(this.owner!);
    if (!entries) this.effects.set(this.owner!, entries = new Map());
    entries.set(name, { name, value: remove ? null : value });
    if (entries.size > 512) this.fail('project macro budget exceeded');
  }

  run<T>(owner: string, action: () => T): T {
    const previousOwner = this.owner;
    if (this.active) {
      this.owner = owner;
      try { return action(); } finally { this.owner = previousOwner; }
    }
    this.active = true; this.owner = owner; this.steps = 0; this.failure = undefined;
    const checkpoint = new Map([...this.effects].map(([id, entries]) => [id, new Map(entries)]));
    const previousPromise = this.realm.Promise, previousService = this.realm.projectService;
    const scope = this;
    class Settled {
      constructor(readonly value: unknown) {}
      then(callback?: (value: any) => unknown): Settled {
        scope.tick();
        return settle(callback ? callback(this.value) : this.value);
      }
      catch(): Settled { scope.tick(); return this; }
      finally(callback: () => unknown): Settled { scope.tick(); settle(callback()); return this; }
    }
    const settle = (value?: unknown): Settled => {
      scope.tick();
      if (value instanceof Settled) return value;
      if (value && typeof (value as any).then === 'function') return scope.fail('pending or foreign Promise');
      return new Settled(value);
    };
    const promise = new Proxy(function () {}, {
      construct: () => scope.fail('Promise executors'),
      apply: () => scope.fail('Promise executors'),
      get: (_target, name) => name === 'resolve' ? settle : scope.fail(`Promise.${String(name)}`),
    });
    this.realm.Promise = promise;
    this.realm.projectService = new Proxy(Object.create(null), { get: (_target, name) => {
      if (name === 'addMacro' || name === 'removeMacro') return (value: unknown) => {
        scope.macro(value, name === 'removeMacro'); return settle();
      };
      return scope.fail(`projectService.${String(name)}`);
    } });
    try {
      const result = action();
      if (this.failure) throw this.failure;
      if (result && typeof (result as any).then === 'function') this.fail('asynchronous generator return');
      return result;
    } catch (error) {
      this.effects.clear();
      for (const [id, entries] of checkpoint) this.effects.set(id, entries);
      throw error;
    } finally {
      this.realm.Promise = previousPromise; this.realm.projectService = previousService;
      this.active = false; this.owner = previousOwner;
    }
  }

  wrap(generator: Blockly.Generator): void {
    scopes.set(generator, this);
    for (const [type, callback] of Object.entries(generator.forBlock)) {
      if (this.wrapped.has(callback)) continue;
      const scope = this;
      const wrapper: typeof callback = function (block, current) {
        return scope.run(block.id, () => callback.call(this, block, current));
      };
      this.wrapped.add(wrapper); generator.forBlock[type] = wrapper;
    }
  }

  capture(workspace: Blockly.Workspace): readonly GeneratorMacroEffect[] {
    const merged = new Map<string, GeneratorMacroEffect>();
    for (const block of workspace.getAllBlocks(false)) {
      let enabled = true;
      for (let current: Blockly.Block | null = block; current; current = current.getParent?.() ?? null) {
        if (!current.isEnabled()) enabled = false;
      }
      if (!enabled) continue;
      for (const [name, effect] of this.effects.get(block.id) ?? []) merged.set(name, effect);
    }
    return Object.freeze([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)).map(value => Object.freeze({ ...value })));
  }
}

export function captureGeneratorProjectEffects(generator: Blockly.Generator, workspace: Blockly.Workspace) {
  return scopes.get(generator)?.capture(workspace) ?? [];
}
