type TimerHandle = ReturnType<typeof setTimeout>;
type IdleDeadlineLike = {
  readonly didTimeout: boolean;
  timeRemaining(): number;
};
type RequestIdleCallbackLike = (
  callback: (deadline: IdleDeadlineLike) => void,
  options?: { readonly timeout?: number },
) => number;

function getUnpatchedFunction<T extends (...args: any[]) => any>(name: string, fallback: T | undefined): T | undefined {
  const global = globalThis as Record<string, unknown>;
  const zoneSymbolName = `__zone_symbol__${name}`;
  const unpatched = global[zoneSymbolName];
  return (typeof unpatched === 'function' ? unpatched : fallback) as T | undefined;
}

export function scheduleBrowserTask(callback: () => void, delay = 0): TimerHandle {
  const global = globalThis as typeof globalThis & { setTimeout?: typeof setTimeout };
  const timer = getUnpatchedFunction<typeof setTimeout>('setTimeout', global.setTimeout);
  if (typeof timer !== 'function') {
    callback();
    return 0 as unknown as TimerHandle;
  }
  return timer.call(globalThis, callback, delay) as TimerHandle;
}

export function yieldToBrowserTask(delay = 0): Promise<void> {
  return new Promise(resolve => {
    scheduleBrowserTask(resolve, delay);
  });
}

export function yieldToBrowserIdle(timeout = 500): Promise<void> {
  const global = globalThis as typeof globalThis & {
    requestIdleCallback?: RequestIdleCallbackLike;
  };
  const requestIdleCallback = getUnpatchedFunction<RequestIdleCallbackLike>(
    'requestIdleCallback',
    global.requestIdleCallback,
  );
  if (typeof requestIdleCallback !== 'function') {
    return yieldToBrowserTask(Math.min(Math.max(timeout, 0), 50));
  }

  return new Promise(resolve => {
    requestIdleCallback.call(globalThis, () => resolve(), { timeout });
  });
}

export function yieldToBrowserFrame(): Promise<void> {
  const global = globalThis as typeof globalThis & {
    requestAnimationFrame?: typeof requestAnimationFrame;
  };
  const raf = getUnpatchedFunction<typeof requestAnimationFrame>('requestAnimationFrame', global.requestAnimationFrame);
  if (typeof raf !== 'function') {
    return yieldToBrowserTask();
  }

  return new Promise(resolve => {
    raf.call(globalThis, () => {
      scheduleBrowserTask(resolve, 0);
    });
  });
}

export interface BrowserFrameBudgetOptions {
  readonly budgetMs?: number;
  readonly maxContinuousMs?: number;
  readonly yield?: () => Promise<void>;
  readonly now?: () => number;
  readonly onYield?: (info: BrowserFrameBudgetYieldInfo) => void;
}

export interface BrowserFrameBudgetYieldInfo {
  readonly label?: string;
  readonly elapsedMs: number;
  readonly continuousMs: number;
  readonly checkpointCount: number;
}

export interface BrowserFrameBudgetController {
  readonly checkpointCount: number;
  reset(): void;
  checkpoint(label?: string): Promise<void>;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function createBrowserFrameBudget(
  options: BrowserFrameBudgetOptions = {},
): BrowserFrameBudgetController {
  const budgetMs = Math.max(1, options.budgetMs ?? 8);
  const maxContinuousMs = Math.max(1, options.maxContinuousMs ?? 24);
  const yieldFrame = options.yield ?? yieldToBrowserFrame;
  const now = options.now ?? defaultNow;
  let lastYieldAt = now();
  let operationStartedAt = lastYieldAt;
  let checkpointCount = 0;

  return {
    get checkpointCount() {
      return checkpointCount;
    },
    reset() {
      lastYieldAt = now();
      operationStartedAt = lastYieldAt;
      checkpointCount = 0;
    },
    async checkpoint(label?: string): Promise<void> {
      checkpointCount++;
      const current = now();
      const elapsedMs = current - lastYieldAt;
      const continuousMs = current - operationStartedAt;
      if (elapsedMs < budgetMs && continuousMs < maxContinuousMs) {
        return;
      }

      options.onYield?.({
        label,
        elapsedMs,
        continuousMs,
        checkpointCount,
      });
      await yieldFrame();
      lastYieldAt = now();
      operationStartedAt = lastYieldAt;
    },
  };
}
