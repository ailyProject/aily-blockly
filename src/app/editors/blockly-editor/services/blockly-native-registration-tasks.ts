/** Own only finite, one-shot registration timers. Configuration and generation
 * stay synchronous; this is not a general library async scheduler. */
export class NativeRegistrationTasks {
  private readonly pending = new Set<number>();
  private count = 0;
  private delayBudget = 0;
  private running = false;
  private closed = false;
  private disposed = false;
  private failed = false;
  private failure: unknown;
  private wake?: () => void;

  constructor(private readonly schedule: (callback: () => void, delay: number) => number,
    private readonly cancel: (id: number) => void) {}

  assertClean(): void {
    if (this.failed) throw this.failure;
    if (this.disposed) throw new Error('Native registration tasks are disposed.');
  }

  set(callback: () => unknown, delay = 0): number {
    this.assertClean();
    if (this.closed || typeof callback !== 'function' || typeof delay !== 'number' || !Number.isFinite(delay)
      || delay < 0 || delay > 2000 || ++this.count > 128 || (this.delayBudget += delay) > 5000) {
      const error = new Error('Native candidate does not support registration tasks outside the finite callback/delay budget or after registration.');
      this.fail(error); throw error;
    }
    const id = this.schedule(() => {
      this.pending.delete(id); this.running = true;
      try {
        this.assertClean();
        const result = callback();
        if (result && typeof (result as any).then === 'function') {
          throw new Error('Native candidate does not support asynchronous registration callbacks.');
        }
      } catch (error) { this.fail(error); }
      finally { this.running = false; this.wake?.(); }
    }, delay);
    this.pending.add(id);
    return id;
  }

  clear(id: number): void {
    if (this.pending.delete(id)) { this.cancel(id); this.wake?.(); }
  }

  async drain(): Promise<void> {
    try {
      this.assertClean();
      while (this.pending.size || this.running) {
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.assertClean();
      }
    } finally { this.closed = true; this.wake = undefined; }
  }

  fail(error: unknown): void {
    if (!this.failed) { this.failed = true; this.failure = error; }
    this.dispose();
  }

  dispose(): void {
    this.disposed = this.closed = true;
    for (const id of [...this.pending]) this.clear(id);
    this.wake?.();
  }
}
