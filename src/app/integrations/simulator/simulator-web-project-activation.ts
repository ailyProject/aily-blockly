import type { SimulatorWebProductActivation } from './simulator-web-product.source';
import type { SimulatorWebProductPresentation } from './simulator-web-product.service';

export interface SimulatorCapturedProjectActivation {
  readonly path: string;
  readonly projectSessionId: string;
  readonly signal: AbortSignal;
  requireCurrent(): void;
}

export interface SimulatorProjectActivationPort {
  captureCurrentProjectActivation(): SimulatorCapturedProjectActivation | null;
  readonly projectActivation$: { subscribe(listener: (event: unknown) => void): { unsubscribe(): void } };
  readonly currentProjectPath$: { subscribe(listener: (path: string) => void): { unsubscribe(): void } };
}

export interface SimulatorWebProjectPublicationPort {
  /** Public original tool/document input; never captures a project activation. */
  readPresentation?(signal: AbortSignal): Promise<SimulatorWebProductPresentation>;
  /** A trusted application implementation supplies publication and account
   * settings for this already selected path. This is not a Shell/Agent API. */
  readPublication(projectPath: string, signal: AbortSignal): Promise<{
    readonly projectPath: string;
    readonly activation: SimulatorWebProductActivation;
  }>;
  /** Trusted local handoff of one original prewarmed caller, never a lookup by
   * a page-selected path. null alone chooses the ordinary new-caller path. */
  readPreparedPublication?(captured: SimulatorCapturedProjectActivation, signal: AbortSignal): Promise<{
    readonly projectPath: string;
    readonly activation: SimulatorWebProductActivation;
  } | null>;
}

export interface SimulatorWebProjectActivationReaderOptions {
  readonly project: SimulatorProjectActivationPort;
  readonly publication: SimulatorWebProjectPublicationPort;
}

interface ActivationBinding {
  readonly revoke: AbortController;
  readonly cleanup: Set<() => void>;
  closePublication?: () => Promise<void>;
  publicationClosing?: Promise<void>;
}

/** Translate the application's original selected generation into the existing
 * Web composition. Only subscriptions and outstanding reads belong here; the
 * original ProjectService, Scene Store and Session retain their state owners. */
export function createSimulatorWebProjectActivationReader(options: SimulatorWebProjectActivationReaderOptions) {
  const capture = options.project.captureCurrentProjectActivation.bind(options.project);
  const readPublication = options.publication.readPublication.bind(options.publication);
  const readPrepared = options.publication.readPreparedPublication?.bind(options.publication);
  const lifetime = new AbortController();
  const bindings = new Set<ActivationBinding>();
  const pending = new Set<Promise<SimulatorWebProductActivation>>();
  let closed = false, closing: Promise<void> | null = null;

  function dispose(binding: ActivationBinding): void {
    const failures: unknown[] = [];
    for (const cleanup of binding.cleanup) {
      try { cleanup(); binding.cleanup.delete(cleanup); } catch (error) { failures.push(error); }
    }
    if (binding.cleanup.size === 0 && !binding.closePublication) bindings.delete(binding);
    if (failures.length) throw new AggregateError(failures, 'Project activation subscription cleanup remains unconfirmed.');
  }

  function closeOriginalPublication(binding: ActivationBinding): Promise<void> {
    if (binding.publicationClosing) return binding.publicationClosing;
    if (!binding.closePublication) return Promise.resolve();
    const close = binding.closePublication;
    const actual = Promise.resolve().then(close).then(() => {
      if (binding.closePublication === close) binding.closePublication = undefined;
    }).finally(() => { if (binding.publicationClosing === actual) binding.publicationClosing = undefined; });
    binding.publicationClosing = actual; void actual.catch(() => { /* Keep the same original owner for retry. */ });
    return actual;
  }

  function readActivation(signal: AbortSignal): Promise<SimulatorWebProductActivation> {
    if (closed) return Promise.reject(new Error('The Web project activation reader is closed.'));
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted(); lifetime.signal.throwIfAborted();
      const captured = capture();
      if (!captured) throw Object.assign(new Error('No normally opened project activation is available.'), { code: 'project-unavailable' });
      const requireCaptured = captured.requireCurrent.bind(captured);
      const binding: ActivationBinding = { revoke: new AbortController(), cleanup: new Set() };
      bindings.add(binding);
      const current = AbortSignal.any([signal, lifetime.signal, captured.signal, binding.revoke.signal]);
      const release = () => { try { dispose(binding); } catch { /* Retain failed subscriptions for close(). */ } };
      const revoke = () => { binding.revoke.abort(new DOMException('The selected project generation changed.', 'AbortError')); release(); };
      current.addEventListener('abort', release, { once: true });
      binding.cleanup.add(() => current.removeEventListener('abort', release));
      const requireCurrent = () => { current.throwIfAborted(); requireCaptured(); };
      try {
        requireCurrent();
        const pathSubscription = options.project.currentProjectPath$.subscribe(path => {
          if (path !== captured.path) revoke();
        });
        binding.cleanup.add(() => pathSubscription.unsubscribe());
        // Even a same-path reload is a new selection event. Do not keep a
        // caller alive merely because its filesystem path can be reused.
        const activationSubscription = options.project.projectActivation$.subscribe(revoke);
        binding.cleanup.add(() => activationSubscription.unsubscribe());
        requireCurrent();
        let publication = readPrepared ? await readPrepared(captured, current) : null;
        if (publication === null) publication = await readPublication(captured.path, current);
        // Adopt a returned owner before the first post-await cancellation fence.
        // A transferred prewarm may no longer be controlled by its old trigger.
        const returnedStore = publication?.activation?.project?.ownedStore;
        if (returnedStore && typeof returnedStore.close === 'function') {
          binding.closePublication = returnedStore.close.bind(returnedStore);
          bindings.add(binding);
        }
        requireCurrent();
        if (!publication || publication.projectPath !== captured.path
          || !publication.activation?.activation || typeof publication.activation.activation.throwIfAborted !== 'function') {
          throw new TypeError('Project publication must bind the exact captured application activation.');
        }
        const selected = publication.activation;
        const activation = AbortSignal.any([current, selected.activation]);
        const requireOwner = selected.startupOptions.owner.requireCurrent.bind(selected.startupOptions.owner);
        const requireSelected = () => { activation.throwIfAborted(); requireCaptured(); requireOwner(); };
        activation.addEventListener('abort', release, { once: true });
        binding.cleanup.add(() => activation.removeEventListener('abort', release));
        requireSelected();
        binding.closePublication = undefined; // The returned activation now owns this Store.
        return { ...selected, activation,
          startupOptions: { ...selected.startupOptions, owner: { requireCurrent: requireSelected } },
          agentWorkspaceRoot: captured.path };
      } catch (error) {
        binding.revoke.abort(error);
        const failures: unknown[] = [];
        try { await closeOriginalPublication(binding); } catch (cleanupError) { failures.push(cleanupError); }
        try { dispose(binding); } catch (cleanupError) { failures.push(cleanupError); }
        if (failures.length) throw new AggregateError([error, ...failures], 'Project publication or original owner cleanup remains unconfirmed.');
        throw error;
      }
    }).finally(() => { pending.delete(task); });
    pending.add(task);
    void task.catch(() => { /* The caller and close retain the original read outcome. */ });
    return task;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new DOMException('The owning Web project caller closed.', 'AbortError'));
    const task = Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      const failures: unknown[] = [];
      for (const binding of [...bindings]) {
        binding.revoke.abort(lifetime.signal.reason);
        try { await closeOriginalPublication(binding); } catch (error) { failures.push(error); }
        try { dispose(binding); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Project activation cleanup remains unconfirmed.');
    }).finally(() => { if (closing === task) closing = null; });
    closing = task;
    void task.catch(() => { /* Failed subscriptions remain retained for retry. */ });
    return task;
  }

  return Object.freeze({ readActivation, close,
    snapshot() {
      return { closed, pendingReads: pending.size, activeBindings: bindings.size,
        retainedPublicationOwners: [...bindings].filter(binding => binding.closePublication !== undefined).length,
        subscriptions: [...bindings].reduce((total, binding) => total + binding.cleanup.size, 0),
        retainedCleanupResponsibility: pending.size !== 0 || bindings.size !== 0,
        WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
    },
  });
}
