import type * as Blockly from 'blockly';
import type { NativeUiTasks } from './blockly-native-ui-tasks';

/** Only the captured core comment hooks may finish their render continuations.
 * Library callbacks never acquire a general Promise/microtask capability. */
export class NativeCommentPreparation {
  private readonly then = Promise.prototype.then;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly steps = new WeakMap<object, number>();
  private readonly hooks = new Map<string, Function>();
  private owner?: Blockly.icons.CommentIcon;
  private failure?: Error;
  private sealed = false;
  private readonly render: () => void;

  constructor(native: typeof Blockly, private readonly tasks: NativeUiTasks) {
    this.render = native.renderManagement.triggerQueuedRenders;
    const prototype = native.icons.CommentIcon.prototype;
    // The asynchronous hooks call other comment/icon methods after awaiting.
    // A replaced helper must not execute with the core continuation privilege.
    for (let current = prototype; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
        if (name !== 'constructor' && typeof descriptor.value === 'function' && !this.hooks.has(name)) this.hooks.set(name, descriptor.value);
      }
    }
    // Deserialization loads pinned state before initSvg calls updateEditable.
    // The latter closes/reopens the bubble and must settle as well as loadState.
    for (const name of ['loadState', 'setBubbleVisible', 'updateEditable'] as const) {
      const original = prototype[name];
      const preparation = this;
      const wrapped = function(this: Blockly.icons.CommentIcon, ...args: unknown[]) {
        return preparation.run(this, () => {
          const value = Reflect.apply(original, this, args);
          if (value instanceof Promise) preparation.observe(value);
          return value;
        });
      };
      this.hooks.set(name, wrapped);
      (prototype as any)[name] = wrapped;
    }
  }

  get ownsContinuation(): boolean { return !!this.owner; }
  assertClean(): void { if (this.failure) throw this.failure; }

  private fail(message: string): never {
    this.failure ??= Object.assign(new Error(message), { code: 'ABS_NATIVE_EFFECT_UNSUPPORTED', diagnostic: { reason: 'native-comment-preparation' } });
    throw this.failure;
  }

  private run<T>(owner: Blockly.icons.CommentIcon, action: () => T): T {
    if (this.failure) throw this.failure;
    if (this.sealed) this.fail('Native comment continuations are only supported during workspace loading.');
    for (const [name, hook] of this.hooks) {
      if ((owner as any)[name] !== hook) this.fail('Native comment preparation requires the original bundled comment hooks.');
    }
    const count = (this.steps.get(owner) ?? 0) + 1;
    if (count > 64) this.fail('Native comment preparation exceeded its finite render continuation budget.');
    this.steps.set(owner, count);
    const previous = this.owner;
    this.owner = owner;
    try { return action(); } finally { this.owner = previous; }
  }

  continue(promise: Promise<unknown>, fulfilled?: (value: unknown) => unknown, rejected?: (reason: unknown) => unknown): Promise<unknown> {
    const owner = this.owner!;
    // These closures come from the captured core hook (including Closure's
    // compiled await). Recheck hook ownership when each continuation executes.
    const wrap = (callback: ((value: unknown) => unknown) | undefined) =>
      typeof callback === 'function' ? (value: unknown) => this.run(owner, () => callback(value)) : undefined;
    const result = this.then.call(promise, wrap(fulfilled), wrap(rejected));
    this.observe(result);
    return result;
  }

  private observe(promise: Promise<unknown>): void {
    if (this.pending.has(promise)) return;
    this.pending.add(promise);
    this.then.call(promise, () => this.pending.delete(promise), error => {
      this.pending.delete(promise);
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    });
  }

  async drain(): Promise<void> {
    // Flush only actual core renders and bounded microtask turns for the owned
    // hooks. Never drain arbitrary library timers or wait for I/O readiness.
    for (let turn = 0; this.pending.size && turn < 64; turn++) {
      if (this.failure) throw this.failure;
      this.tasks.coreRender(this.render);
      await Promise.resolve();
    }
    if (this.failure) throw this.failure;
    if (this.pending.size) this.fail('Native comment preparation did not finish within its render continuation budget.');
    this.sealed = true;
  }
}
