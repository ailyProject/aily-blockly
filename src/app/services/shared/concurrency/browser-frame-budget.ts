export interface BrowserFrameBudgetOptions {
  budgetMs?: number;
  maxContinuousMs?: number;
  now?: () => number;
  yield?: () => Promise<void>;
  onYield?: (info: { label?: string; elapsedMs: number; continuousMs: number; checkpointCount: number }) => void;
}

/** Recovered from the legacy browserTaskScheduler; one clock and no second queue.
 * Task yielding also works for background/hidden renderers where RAF can pause.
 */
export function createBrowserFrameBudget(options: BrowserFrameBudgetOptions = {}) {
  const limit = Math.min(options.budgetMs ?? 8, options.maxContinuousMs ?? 24);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('Browser frame budget must be finite and positive.');
  const now = options.now ?? (() => performance.now());
  let lastTimerYield = now();
  const yieldTask = options.yield ?? (async () => {
    // Unlike nested setTimeout(0), scheduler.yield does not accumulate timer
    // clamping/precision delays between hundreds of native loading fragments.
    // It still returns to the browser task queue for input and rendering.
    const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler?.yield && now() - lastTimerYield < 50) {
      await scheduler.yield();
    } else {
      // Yield continuations have boosted priority. Periodically join the normal
      // timer queue too, so cancellation and library timers cannot be starved.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      lastTimerYield = now();
    }
  });
  let started = now(), count = 0;
  return {
    get checkpointCount() { return count; },
    reset() { started = now(); lastTimerYield = started; count = 0; },
    async checkpoint(label?: string) {
      count++;
      const elapsedMs = now() - started;
      if (elapsedMs < limit) return;
      options.onYield?.({ label, elapsedMs, continuousMs: elapsedMs, checkpointCount: count });
      await yieldTask(); started = now();
    },
  };
}
