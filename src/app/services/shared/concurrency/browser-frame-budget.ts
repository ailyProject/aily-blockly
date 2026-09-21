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
  const yieldTask = options.yield ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  let started = now(), count = 0;
  return {
    get checkpointCount() { return count; },
    reset() { started = now(); count = 0; },
    async checkpoint(label?: string) {
      count++;
      const elapsedMs = now() - started;
      if (elapsedMs < limit) return;
      options.onYield?.({ label, elapsedMs, continuousMs: elapsedMs, checkpointCount: count });
      await yieldTask(); started = now();
    },
  };
}
