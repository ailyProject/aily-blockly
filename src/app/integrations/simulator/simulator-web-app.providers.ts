import { DestroyRef, InjectionToken, inject, type EnvironmentProviders } from '@angular/core';
import type { SimulatorWebProductComposition, SimulatorWebProductSource } from './simulator-web-product.service';
import { provideSimulatorWebProduct } from './simulator-web-product.providers';
import { createSimulatorWebProductSource } from './simulator-web-product.source';
import {
  createSimulatorWebProjectActivationReader, type SimulatorProjectActivationPort, type SimulatorWebProjectPublicationPort,
} from './simulator-web-project-activation';
import { SIMULATOR_WEB_PROJECT_ACTIVATION } from './simulator-web-project-activation.providers';

/** Production configuration is supplied by the actual owning application.
 * No route, fixture, ordinary login token or default endpoint fills this port. */
export const SIMULATOR_WEB_PROJECT_PUBLICATION = new InjectionToken<SimulatorWebProjectPublicationPort | null>(
  'SIMULATOR_WEB_PROJECT_PUBLICATION', { providedIn: 'root', factory: () => null });

interface CallerCleanup {
  close(): Promise<void>;
  snapshot(): object;
}

/** The owning application supplies its original project activation port, not a
 * second project registry. Each view gets its own read/cleanup lifetime, so
 * retiring one view cannot permanently close another caller's providers. */
export function provideSimulatorWebApplication(): EnvironmentProviders {
  return provideSimulatorWebProduct((project: SimulatorProjectActivationPort | null, publication: SimulatorWebProjectPublicationPort | null) => {
    if (!project || !publication) return null;
    const destroy = inject(DestroyRef);
    const retained = new Set<CallerCleanup>();
    let closed = false;

    const source: SimulatorWebProductSource & { close(): Promise<void>; snapshot(): object } = {
      async readComposition(signal: AbortSignal): Promise<SimulatorWebProductComposition> {
        if (closed) throw new Error('The owning Web application has closed.');
        const reader = createSimulatorWebProjectActivationReader({ project, publication });
        const original = createSimulatorWebProductSource({ readActivation: reader.readActivation });
        let owned: { close(): Promise<void> } | null = null, closing: Promise<void> | null = null;
        const cleanup: CallerCleanup = {
          close(): Promise<void> {
            if (closing) return closing;
            const task = Promise.resolve().then(async () => {
              const results = await Promise.allSettled([reader.close(), original.close()]);
              if (owned) results.push(await Promise.resolve().then(() => owned!.close())
                .then(() => ({ status: 'fulfilled' as const, value: undefined }), reason => ({ status: 'rejected' as const, reason })));
              const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
              if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Web application caller cleanup remains unconfirmed.');
              retained.delete(cleanup);
            }).finally(() => { if (closing === task) closing = null; });
            closing = task; void task.catch(() => { /* Preserve this exact caller for retry. */ }); return task;
          },
          snapshot: () => ({ activation: reader.snapshot(), source: original.snapshot(), cleanupPending: closing !== null }),
        };
        retained.add(cleanup);
        try {
          const composition = await original.readComposition(signal);
          owned = composition.startupOptions.ownedProviders ?? null;
          signal.throwIfAborted();
          if (closed) throw new Error('The owning Web application closed during composition.');
          return { ...composition, startupOptions: { ...composition.startupOptions, ownedProviders: cleanup } };
        } catch (error) {
          try { await cleanup.close(); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Web application composition and cleanup failed.'); }
          throw error;
        }
      },
      async close(): Promise<void> {
        closed = true;
        const results = await Promise.allSettled([...retained].map(caller => caller.close()));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Web application cleanup remains unconfirmed.');
      },
      snapshot() {
        return { closed, retainedCallers: retained.size, callers: [...retained].map(caller => caller.snapshot()),
          retainedCleanupResponsibility: retained.size !== 0,
          WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
      },
    };
    destroy.onDestroy(() => { void source.close().catch(() => { /* Retain unconfirmed caller cleanup. */ }); });
    return Object.freeze(source);
  }, [SIMULATOR_WEB_PROJECT_ACTIVATION, SIMULATOR_WEB_PROJECT_PUBLICATION]);
}
