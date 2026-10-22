import type {
  SimulatorWebProductComposition, SimulatorWebProductSource, SimulatorWebStartupInput,
} from './simulator-web-product.service';

/** Structural host boundary: the independently delivered provider retains the
 * original Project Scene validation, persistence, CAS and Artifact reader. */
export interface SimulatorWebSelectedProjectContext {
  readonly schemaVersion: 1;
  readonly kind: 'aily-simulator-host-project-context-snapshot';
  readonly projectIdentity: string;
  readonly workspaceIdentity: string;
  readonly activeSceneId: string;
  readonly activeArtifactRevision: string | null;
  readonly workspaceSourceSha256: string | null;
}

export interface SimulatorWebProductActivation {
  readonly activation: AbortSignal;
  /** Captured by the original Host activation; it is not sent to the Shell. */
  readonly agentWorkspaceRoot?: string;
  readonly startupOptions: Omit<SimulatorWebStartupInput, 'project' | 'artifact' | 'ownedProviders'>;
  readonly project: {
    readonly context: SimulatorWebSelectedProjectContext;
    readonly artifact: object | null;
  } & ({ readonly storage: SimulatorWebProjectStorage; readonly store?: never; readonly ownedStore?: never }
    | { readonly store: object; readonly storage?: never; readonly ownedStore?: { close(): Promise<void> } });
}

export interface SimulatorWebProjectStorage {
  readonly databaseName: string;
  readonly maxBytes?: number;
}

export interface SimulatorWebOwnedProjectProviders {
  readonly project: object;
  readonly artifact: object;
  close(): Promise<void>;
}

export interface SimulatorWebProjectProvidersModule {
  /** Borrow the owning application's original Scene Store. Its Gateway
   * validator retains the concrete Store/CAS contract; no clone or IDB seed. */
  createWebProjectProviders?(options: {
    selection: { context: SimulatorWebSelectedProjectContext; store: object };
    artifact: object | null;
    owner: { requireCurrent(): void };
    ownedStore?: { close(): Promise<void> };
  }): SimulatorWebOwnedProjectProviders;
  createIndexedDbWebProjectProviders(options: {
    context: SimulatorWebSelectedProjectContext;
    storage: SimulatorWebProjectStorage;
    artifact: object | null;
    owner: { requireCurrent(): void };
  }): SimulatorWebOwnedProjectProviders;
}

export interface SimulatorWebProductSourceOptions {
  /** Reads the application's actual selected generation, not a page request. */
  readActivation(signal: AbortSignal): Promise<SimulatorWebProductActivation>;
  loadProviders?(moduleURL: string): Promise<SimulatorWebProjectProvidersModule>;
}

const loadProjectProviders = (moduleURL: string): Promise<SimulatorWebProjectProvidersModule> =>
  import(/* @vite-ignore */ moduleURL);

/** Capture only a trusted same-document provider result. A sealed source is an
 * original capability, never a wire DTO reconstructed from function strings.
 * The delivered Gateway retains all scope/schema/hash and admission checks. */
export function captureSimulatorWebArtifactInput(value: object | null): object | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A normal HTTP binding or original sealed Artifact source is required.');
  }
  const source = value as Record<string, unknown>;
  if ('kind' in source) {
    if (source['kind'] !== 'sealed-port'
      || Object.keys(source).sort().join(',') !== 'artifactId,close,kind,open,scope'
      || typeof source['open'] !== 'function' || typeof source['close'] !== 'function') {
      throw new TypeError('A sealed Artifact source must retain its exact original open and close capabilities.');
    }
    const data = structuredClone({ scope: source['scope'], artifactId: source['artifactId'] });
    return Object.freeze({ kind: 'sealed-port', ...data,
      open: source['open'].bind(value), close: source['close'].bind(value) });
  }
  const keys = Object.keys(source).filter(key => key !== 'requestTimeoutMs').sort().join(',');
  if (keys !== 'artifactId,baseURL,manifest,members,scope,trustedOrigin') {
    throw new TypeError('The HTTP Artifact input must be a normal source binding.');
  }
  return structuredClone(value);
}

/** A caller-owned composition seam, not another project or Session manager.
 * Before transfer this source retains each provider until its original close
 * succeeds. The original startup owns it after readComposition succeeds. */
export function createSimulatorWebProductSource(options: SimulatorWebProductSourceOptions) {
  const readActivation = options.readActivation.bind(options);
  const loadProviders = options.loadProviders?.bind(options) ?? loadProjectProviders;
  const lifetime = new AbortController();
  let activeRead: Promise<SimulatorWebProductComposition> | null = null;
  let retainedProviders: SimulatorWebOwnedProjectProviders | null = null;
  let providerCleanup: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  let cleanupFailed = false;
  let closed = false;

  function closeRetainedProviders(): Promise<void> {
    if (providerCleanup) return providerCleanup;
    const providers = retainedProviders;
    if (!providers) return Promise.resolve();
    const task = Promise.resolve().then(() => providers.close()).then(() => {
      if (retainedProviders === providers) retainedProviders = null;
      cleanupFailed = false;
    }, error => { cleanupFailed = true; throw error; }).finally(() => {
      if (providerCleanup === task) providerCleanup = null;
    });
    providerCleanup = task;
    void task.catch(() => { /* Retain the original provider for explicit retry. */ });
    return task;
  }

  function readComposition(signal: AbortSignal): Promise<SimulatorWebProductComposition> {
    if (closed || lifetime.signal.aborted) return Promise.reject(new Error('Web product source is closed.'));
    if (activeRead || retainedProviders) return Promise.reject(new Error('Web product source still owns a pending read or cleanup.'));
    const requested = AbortSignal.any([signal, lifetime.signal]);
    const task = Promise.resolve().then(async () => {
      requested.throwIfAborted();
      const selected = await readActivation(requested);
      requested.throwIfAborted();
      if (!selected?.activation || typeof selected.activation.throwIfAborted !== 'function') {
        throw new TypeError('The Web product requires its original project activation.');
      }
      const activation = AbortSignal.any([requested, selected.activation]);
      const agentWorkspaceRoot = selected.agentWorkspaceRoot;
      const originalOptions = selected.startupOptions;
      const requireOwner = originalOptions.owner.requireCurrent.bind(originalOptions.owner);
      const requireCurrent = () => { activation.throwIfAborted(); requireOwner(); };
      requireCurrent();
      const startupOptions = { ...originalOptions,
        identity: structuredClone(originalOptions.identity),
        resources: structuredClone(originalOptions.resources),
        instanceAuthority: structuredClone(originalOptions.instanceAuthority),
        owner: { requireCurrent },
      };
      const context = structuredClone(selected.project.context);
      const artifact = captureSimulatorWebArtifactInput(selected.project.artifact);
      const originalStore = selected.project.store;
      const ownedStore = selected.project.ownedStore;
      const usesOriginalStore = originalStore !== undefined;
      if (usesOriginalStore) {
        const store = originalStore as Record<string, unknown>;
        if (!store || typeof store !== 'object' || typeof store['load'] !== 'function'
          || typeof store['commit'] !== 'function' || 'storage' in selected.project
          || ownedStore !== undefined && (!ownedStore || typeof ownedStore.close !== 'function')) {
          throw new TypeError('Use the original Scene Store capability without a second storage namespace.');
        }
      } else if ('store' in selected.project || !selected.project.storage || 'ownedStore' in selected.project) {
        throw new TypeError('An explicit original Scene Store or Browser storage binding is required.');
      }
      const storage = usesOriginalStore ? undefined : structuredClone(selected.project.storage!);
      const capturedOwnedStore = ownedStore ? { close: ownedStore.close.bind(ownedStore) } : undefined;
      const base = new URL(startupOptions.resources.releaseBaseURL);
      const origin = globalThis.location.origin;
      if (base.href !== startupOptions.resources.releaseBaseURL || base.origin !== origin
        || startupOptions.resources.trustedOrigin !== origin || base.username || base.password || base.search || base.hash
        || !/^\/releases\/[a-f0-9]{64}\/$/u.test(base.pathname)
        || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
        throw new TypeError('Web project providers must identify the exact trusted startup release.');
      }
      if (context.projectIdentity !== startupOptions.identity.projectIdentity
        || context.activeSceneId !== startupOptions.identity.sceneId
        || context.activeArtifactRevision !== startupOptions.identity.artifactRevision) {
        throw new TypeError('Selected Web project and startup identity must identify the same generation.');
      }
      requireCurrent();
      const module = await loadProviders(new URL('project-providers.mjs', base).href);
      requireCurrent();
      if (!module || (usesOriginalStore ? typeof module.createWebProjectProviders !== 'function'
        : typeof module.createIndexedDbWebProjectProviders !== 'function')) {
        throw new TypeError('The release does not provide its normal Browser project provider factory.');
      }
      const providers = usesOriginalStore
        ? module.createWebProjectProviders!({ selection: { context, store: originalStore }, artifact,
          owner: startupOptions.owner,
          ...(capturedOwnedStore ? { ownedStore: capturedOwnedStore } : {}) })
        : module.createIndexedDbWebProjectProviders({ context, artifact,
          storage: storage!, owner: startupOptions.owner });
      // Capture before the final owner/cancellation check. A late factory result
      // must never disappear merely because its activation was revoked.
      retainedProviders = providers;
      if (!providers || typeof providers.close !== 'function' || !providers.project || !providers.artifact) {
        throw new TypeError('The Browser project factory did not return its original owned providers.');
      }
      requireCurrent();
      const composition: SimulatorWebProductComposition = {
        activation,
        ...(agentWorkspaceRoot === undefined ? {} : { agentWorkspaceRoot }),
        startupOptions: { ...startupOptions, project: providers.project,
          artifact: providers.artifact, ownedProviders: providers },
      };
      retainedProviders = null; // Transfer only this source's newly created providers.
      return composition;
    }).catch(async error => {
      try { await closeRetainedProviders(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Web source failed and provider cleanup remains unconfirmed.');
      }
      throw error;
    }).finally(() => { if (activeRead === task) activeRead = null; });
    activeRead = task;
    void task.catch(() => { /* The normal product caller retains the read result. */ });
    return task;
  }

  const source: SimulatorWebProductSource & { close(): Promise<void>; snapshot(): object } = Object.freeze({
    readComposition,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      lifetime.abort(new Error('Web product source was closed by its owning caller.'));
      const task = Promise.resolve().then(async () => {
        await activeRead?.catch(() => undefined);
        await closeRetainedProviders();
      }).finally(() => { if (closing === task) closing = null; });
      closing = task;
      void task.catch(() => { /* Snapshot and the retained provider preserve responsibility. */ });
      return task;
    },
    snapshot() {
      return { closed, pendingRead: activeRead !== null, providerCleanupPending: providerCleanup !== null,
        cleanupFailed, retainedCleanupResponsibility: activeRead !== null || retainedProviders !== null,
        WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
    },
  });
  return source;
}
