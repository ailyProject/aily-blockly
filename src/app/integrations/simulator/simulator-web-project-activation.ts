import type { SimulatorWebProductActivation } from './simulator-web-product.source';

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
  /** A trusted application implementation supplies publication and account
   * settings for this already selected path. This is not a Shell/Agent API. */
  readPublication(projectPath: string, signal: AbortSignal): Promise<{
    readonly projectPath: string;
    readonly activation: SimulatorWebProductActivation;
  }>;
}

export interface SimulatorWebProjectActivationReaderOptions {
  readonly project: SimulatorProjectActivationPort;
  readonly publication: SimulatorWebProjectPublicationPort;
}

interface ActivationBinding {
  readonly revoke: AbortController;
  readonly cleanup: Set<() => void>;
}

/** Translate the application's original selected generation into the existing
 * Web composition. Only subscriptions and outstanding reads belong here; the
 * original ProjectService, Scene Store and Session retain their state owners. */
export function createSimulatorWebProjectActivationReader(options: SimulatorWebProjectActivationReaderOptions) {
  const capture = options.project.captureCurrentProjectActivation.bind(options.project);
  const readPublication = options.publication.readPublication.bind(options.publication);
  const lifetime = new AbortController();
  const bindings = new Set<ActivationBinding>();
  const pending = new Set<Promise<SimulatorWebProductActivation>>();
  let closed = false, closing: Promise<void> | null = null;

  function dispose(binding: ActivationBinding): void {
    const failures: unknown[] = [];
    for (const cleanup of binding.cleanup) {
      try { cleanup(); binding.cleanup.delete(cleanup); } catch (error) { failures.push(error); }
    }
    if (binding.cleanup.size === 0) bindings.delete(binding);
    if (failures.length) throw new AggregateError(failures, 'Project activation subscription cleanup remains unconfirmed.');
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
        const publication = await readPublication(captured.path, current);
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
        return { ...selected, activation,
          startupOptions: { ...selected.startupOptions, owner: { requireCurrent: requireSelected } },
          agentWorkspaceRoot: captured.path };
      } catch (error) {
        binding.revoke.abort(error);
        try { dispose(binding); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Project publication failed and subscriptions remain unconfirmed.'); }
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
      for (const binding of bindings) {
        binding.revoke.abort(lifetime.signal.reason);
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
        subscriptions: [...bindings].reduce((total, binding) => total + binding.cleanup.size, 0),
        retainedCleanupResponsibility: pending.size !== 0 || bindings.size !== 0,
        WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
    },
  });
}
