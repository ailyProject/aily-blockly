import type { ChatRuntimeOwnerScheduler } from './chat-runtime-owner-scheduler';

export interface RuntimeOwnerBackgroundTaskOptions {
  readonly coldStart?: boolean;
}

export type RuntimeOwnerBackgroundScheduler = Pick<
  ChatRuntimeOwnerScheduler,
  'runOutsideOwner' | 'yieldToIdle' | 'yieldToTask'
>;

export function scheduleRuntimeOwnerBackgroundTask(
  scheduler: RuntimeOwnerBackgroundScheduler | null | undefined,
  callback: () => void,
  options: RuntimeOwnerBackgroundTaskOptions = {},
): void {
  const run = async (): Promise<void> => {
    if (options.coldStart) {
      await yieldColdStart(scheduler);
    } else {
      await yieldTask(scheduler, 0);
    }
    callback();
  };

  const scheduled = scheduler?.runOutsideOwner
    ? scheduler.runOutsideOwner(run)
    : run();
  void Promise.resolve(scheduled).catch(error => {
    const scheduleThrow = typeof globalThis.setTimeout === 'function'
      ? globalThis.setTimeout.bind(globalThis)
      : null;
    if (scheduleThrow) {
      scheduleThrow(() => {
        throw error;
      }, 0);
      return;
    }
    throw error;
  });
}

async function yieldColdStart(
  scheduler: RuntimeOwnerBackgroundScheduler | null | undefined,
): Promise<void> {
  if (scheduler) {
    await scheduler.yieldToIdle(800);
    await scheduler.yieldToTask(0);
    return;
  }

  await yieldBrowserIdle(800);
  await yieldBrowserTask(0);
}

async function yieldTask(
  scheduler: RuntimeOwnerBackgroundScheduler | null | undefined,
  delayMs: number,
): Promise<void> {
  if (scheduler) {
    await scheduler.yieldToTask(delayMs);
    return;
  }
  await yieldBrowserTask(delayMs);
}

function yieldBrowserIdle(timeoutMs: number): Promise<void> {
  if (typeof globalThis.requestIdleCallback === 'function') {
    return new Promise(resolve => {
      globalThis.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    });
  }
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return new Promise(resolve => {
      globalThis.requestAnimationFrame(() => {
        globalThis.requestAnimationFrame(() => {
          yieldBrowserTask(120).then(resolve);
        });
      });
    });
  }
  return yieldBrowserTask(0);
}

function yieldBrowserTask(delayMs: number): Promise<void> {
  if (typeof globalThis.setTimeout !== 'function') {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    globalThis.setTimeout(() => resolve(), delayMs);
  });
}
