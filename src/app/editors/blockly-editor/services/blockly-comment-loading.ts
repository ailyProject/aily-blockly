import type * as Blockly from 'blockly';

/** Join the actual bundled comment lifecycle during a workspace load. Hooks are
 * intercepted only while the synchronous loader runs, never across an await.
 * In particular, initSvg's updateEditable closes and reopens a pinned bubble;
 * finishQueuedRenders alone does not await that operation. */
export class BlocklyCommentLoading {
  private readonly pending = new Set<Promise<unknown>>();
  private failure?: Error;

  constructor(private readonly native: typeof Blockly, private readonly workspace: Blockly.Workspace) {}

  run<T>(load: () => T): T {
    const prototype = this.native.icons.CommentIcon.prototype;
    const restore: Array<() => void> = [];
    const loading = this;
    try {
      for (const name of ['setBubbleVisible', 'updateEditable'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const original = prototype[name];
        Object.defineProperty(prototype, name, { configurable: true, writable: true, value: function(...args: unknown[]) {
          const result = Reflect.apply(original, this, args);
          if (this.sourceBlock.workspace === loading.workspace && result && typeof result.then === 'function') {
            const promise = Promise.resolve(result);
            loading.pending.add(promise);
            promise.then(() => loading.pending.delete(promise), error => {
              loading.pending.delete(promise);
              loading.failure ??= error instanceof Error ? error : new Error(String(error));
            });
          }
          return result;
        } });
        restore.push(() => { if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete prototype[name]; });
      }
      return load();
    } finally { for (const undo of restore.reverse()) undo(); }
  }

  async finish(assertCurrent: () => void): Promise<void> {
    for (let turn = 0; this.pending.size && turn < 64; turn++) {
      assertCurrent();
      if (this.failure) throw this.failure;
      this.native.renderManagement.triggerQueuedRenders(this.workspace as Blockly.WorkspaceSvg);
      await Promise.resolve();
    }
    assertCurrent();
    if (this.failure) throw this.failure;
    if (this.pending.size) throw new Error('Blockly comment loading did not finish within its render continuation budget.');
  }
}
