import type {
  SimulatorEditorHostProviderAdapterOptions,
  SimulatorProjectHostProviderAdapterOptions,
} from '@aily-project/simulator-host-sdk';
import type { SubappRegisteredAgentContext } from '../../services/integrations/subapps/models/subapp-registered-agent';

/** Borrowed from one original project scope, never supplied by the child View. */
export interface SimulatorWebDebuggerCallbacks {
  readonly readConfiguration: NonNullable<SimulatorProjectHostProviderAdapterOptions['readDebugConfiguration']>;
  readonly editorCallbacks: Pick<SimulatorEditorHostProviderAdapterOptions, 'publishDebugLocation' | 'revealSourceLocation'>;
}

/** Framework-free product boundary. The independently released startup module
 * validates its own versioned options; this host forwards the original ports. */
export interface SimulatorWebStartupInput {
  readonly identity: Readonly<{ runtimeId: string; version: string; ownerKey: string;
    projectIdentity: string; sceneId: string; artifactRevision: string | null; subjectHash: string }>;
  readonly resources: Readonly<{ trustedOrigin: string; releaseBaseURL: string; artifactBaseURL: string | null }>;
  readonly owner: { requireCurrent(): void };
  readonly project: object;
  readonly artifact: object;
  readonly authorization: object;
  readonly instanceAuthority: unknown;
  readonly catalog: object;
  readonly workspace: string | null;
  readonly runtime?: object;
  readonly instruments?: boolean;
  readonly debugger?: SimulatorWebDebuggerCallbacks;
  readonly ownedProviders?: { close(): Promise<void> };
  readonly operationWaitMs?: number;
  readonly cleanupWaitMs?: number;
  /** Trusted technical compositions can defer the normal display intent. */
  readonly deferPresentation?: boolean;
  readonly technicalControls?: boolean;
  /** Local, same-document presentation capability; never a child/provider DTO. */
  readonly shellPresentation?: SimulatorWebShellPresentation;
}

/** Public release/document binding only. No project, account or execution owner. */
export interface SimulatorWebProductPresentation {
  readonly activation: AbortSignal;
  readonly identity: Readonly<{ runtimeId: string; version: string }>;
  readonly resources: Readonly<{ trustedOrigin: string; releaseBaseURL: string }>;
  requireCurrent(): void;
}

export interface SimulatorWebShellPresentation {
  readonly descriptor: Readonly<{ window: Window; document: Document; container: HTMLElement;
    identity: Readonly<{ runtimeId: string; version: string }>; releaseBase: string; shellURL: string }>;
  present(): Promise<unknown>;
  close(): Promise<unknown>;
  revokeDocument(): void;
  snapshot(): unknown;
}

export interface SimulatorWebPresentationModule {
  createWebShellPresentation(options: Readonly<{ window: Window; document: Document; container: HTMLElement;
    identity: Readonly<{ runtimeId: string; version: string }>; releaseBase: URL; shellURL: URL }>): SimulatorWebShellPresentation;
}
export type SimulatorWebPresentationLoader = (moduleURL: string) => Promise<SimulatorWebPresentationModule>;

export interface SimulatorWebProductComposition {
  /** The original host project/account activation; navigation revokes it. */
  readonly activation: AbortSignal;
  /** Host-local Agent binding, never a startup option or child-page field. */
  readonly agentWorkspaceRoot?: string;
  readonly startupOptions: SimulatorWebStartupInput;
}

export interface SimulatorWebProductSource {
  readPresentation?(signal: AbortSignal): Promise<SimulatorWebProductPresentation>;
  readComposition(signal: AbortSignal): Promise<SimulatorWebProductComposition>;
}

export interface SimulatorWebStartupHandle {
  close(): Promise<void>;
  snapshot(): unknown;
  open(): Promise<unknown>;
  mountView(): Promise<unknown>;
  semanticRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
}

export interface SimulatorWebStartupModule {
  createWebSimulatorStartup(options: SimulatorWebStartupInput & SimulatorWebProductSurface): SimulatorWebStartupHandle;
}

export interface SimulatorWebProductSurface {
  readonly window: Window;
  readonly document: Document;
  readonly controls: HTMLElement;
  readonly container: HTMLElement;
}

export type SimulatorWebStartupLoader = (moduleURL: string) => Promise<SimulatorWebStartupModule>;

export class SimulatorWebProductError extends Error {
  constructor(readonly code: 'web-product-unavailable' | 'invalid-web-composition' | 'web-product-closed' | 'cleanup-unconfirmed') {
    super(code); this.name = 'SimulatorWebProductError';
  }
}

export const loadSimulatorWebStartup: SimulatorWebStartupLoader = moduleURL => import(/* @vite-ignore */ moduleURL);
export const loadSimulatorWebPresentation: SimulatorWebPresentationLoader = moduleURL => import(/* @vite-ignore */ moduleURL);

function releaseBase(resources: Readonly<{ trustedOrigin: string; releaseBaseURL: string }>, origin: string): URL {
  const base = new URL(resources.releaseBaseURL);
  if (base.href !== resources.releaseBaseURL || base.origin !== origin || resources.trustedOrigin !== origin
    || base.username || base.password || base.search || base.hash || !/^\/releases\/[a-f0-9]{64}\/$/u.test(base.pathname)
    || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new SimulatorWebProductError('invalid-web-composition');
  }
  return base;
}
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && Object.keys(descriptors).length === keys.length
    && keys.every(key => {
      const descriptor = descriptors[key];
      return Object.hasOwn(descriptors, key) && descriptor !== undefined && Object.hasOwn(descriptor, 'value');
    });
}

/** One normal view lifetime, not a project or Session registry. The original
 * startup owns execution/ports/ACKs and any explicitly transferred providers. */
export class SimulatorWebProductService {
  private readonly source: SimulatorWebProductSource | null;
  private readonly load: SimulatorWebStartupLoader;
  private readonly loadPresentation: SimulatorWebPresentationLoader;
  private readonly lifetime = new AbortController();
  private state: 'new' | 'loading' | 'mounted' | 'closing' | 'unconfirmed' | 'closed' = 'new';
  private setup: Promise<void> | null = null;
  private compositionRead: Promise<SimulatorWebProductComposition> | null = null;
  private shellSetup: Promise<void> | null = null;
  private shell: SimulatorWebShellPresentation | null = null;
  private shellTransferred = false;
  private shellVisible = false;
  private presentationBinding: SimulatorWebProductPresentation | null = null;
  private startup: SimulatorWebStartupHandle | null = null;
  private unclaimedProviders: SimulatorWebStartupInput['ownedProviders'] | null = null;
  private requireOwner: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private activation: AbortSignal | null = null;
  private cleanupWaitMs = 3000;
  private agentWorkspaceRoot: string | null = null;
  private presentationDeferred = false;
  private presentation: Promise<void> | null = null;
  private readonly revoke = () => {
    this.lifetime.abort(new SimulatorWebProductError('web-product-closed'));
    void this.close().catch(() => { /* Failed cleanup remains owned for retry. */ });
  };

  constructor(source: SimulatorWebProductSource | null, load: SimulatorWebStartupLoader = loadSimulatorWebStartup,
    loadPresentation: SimulatorWebPresentationLoader = loadSimulatorWebPresentation) {
    this.source = source; this.load = load; this.loadPresentation = loadPresentation;
  }

  mount(surface: SimulatorWebProductSurface, presented?: () => void): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new SimulatorWebProductError('web-product-closed'));
    if (!this.source) return Promise.reject(new SimulatorWebProductError('web-product-unavailable'));
    this.state = 'loading';
    const task = Promise.resolve().then(async () => {
      this.lifetime.signal.throwIfAborted();
      const { window, document, controls, container } = surface;
      if (window.document !== document || document.defaultView !== window
        || controls.ownerDocument !== document || container.ownerDocument !== document) {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      // Reading the public descriptor never waits for project generation. Both
      // original tasks remain owned even if one fails or ignores cancellation.
      this.shellSetup = this.source!.readPresentation ? this.mountPublicShell(surface, presented) : Promise.resolve();
      const reading = Promise.resolve().then(() => this.source!.readComposition(this.lifetime.signal)).then(composition => {
        this.unclaimedProviders = composition?.startupOptions?.ownedProviders ?? null;
        this.lifetime.signal.throwIfAborted(); return composition;
      });
      this.compositionRead = reading;
      const [composition] = await Promise.all([reading, this.shellSetup]);
      const options = composition?.startupOptions;
      this.lifetime.signal.throwIfAborted();
      if (!composition?.activation || typeof composition.activation.addEventListener !== 'function') {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      this.activation = composition.activation;
      this.activation.addEventListener('abort', this.revoke, { once: true });
      if (!options?.owner || typeof options.owner.requireCurrent !== 'function') throw new SimulatorWebProductError('invalid-web-composition');
      this.requireOwner = options.owner.requireCurrent.bind(options.owner);
      this.requireCurrent();
      const identity = structuredClone(options.identity);
      const resources = structuredClone(options.resources);
      const base = releaseBase(resources, window.location.origin);
      if (options.shellPresentation !== undefined) throw new SimulatorWebProductError('invalid-web-composition');
      if (this.shell) this.requirePresentation(surface, identity, resources);
      const cleanupWaitMs = options.cleanupWaitMs ?? 3000;
      if (!Number.isSafeInteger(cleanupWaitMs) || cleanupWaitMs < 1 || cleanupWaitMs > 3000) {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      this.cleanupWaitMs = cleanupWaitMs;
      if (options.workspace !== null && typeof options.workspace !== 'string'
        || options.deferPresentation !== undefined && typeof options.deferPresentation !== 'boolean'
        || options.technicalControls !== undefined && typeof options.technicalControls !== 'boolean') {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      if (composition.agentWorkspaceRoot !== undefined
        && (typeof composition.agentWorkspaceRoot !== 'string' || !composition.agentWorkspaceRoot.trim())) {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      this.agentWorkspaceRoot = composition.agentWorkspaceRoot ?? null;
      this.presentationDeferred = options.deferPresentation === true;
      const { deferPresentation: _deferPresentation, ...startupOptions } = options;
      const capturedOptions = { ...startupOptions, identity, resources,
        instanceAuthority: structuredClone(options.instanceAuthority),
        owner: { requireCurrent: () => this.requireCurrent() } };
      const module = await this.load(new URL('startup.mjs', base).href);
      this.requireCurrent();
      if (typeof module?.createWebSimulatorStartup !== 'function') throw new SimulatorWebProductError('invalid-web-composition');
      // Capture the late result before checking revocation, so its own close()
      // retains ownership if the host activation changed during the factory.
      this.startup = module.createWebSimulatorStartup({ ...capturedOptions, ...surface,
        ...(this.shell ? { shellPresentation: this.shell } : {}) });
      if (!this.startup || typeof this.startup.close !== 'function' || typeof this.startup.snapshot !== 'function') {
        throw new SimulatorWebProductError('invalid-web-composition');
      }
      this.unclaimedProviders = null; // The original startup now owns this close.
      this.shellTransferred = this.shell !== null;
      this.requireCurrent();
      this.state = 'mounted';
    });
    this.setup = task;
    void task.catch(() => { if (this.state !== 'closing' && this.state !== 'closed') this.state = 'unconfirmed'; });
    return task;
  }

  private requireCurrent(): void {
    this.lifetime.signal.throwIfAborted(); this.activation!.throwIfAborted();
    this.presentationBinding?.requireCurrent(); this.presentationBinding?.activation.throwIfAborted();
    this.requireOwner!();
  }

  private requirePresentation(surface: SimulatorWebProductSurface,
    identity: Readonly<{ runtimeId: string; version: string }>, resources: Readonly<{ trustedOrigin: string; releaseBaseURL: string }>): void {
    this.lifetime.signal.throwIfAborted();
    const binding = this.presentationBinding, descriptor = this.shell?.descriptor;
    binding?.activation.throwIfAborted(); binding?.requireCurrent();
    if (!binding || !descriptor || surface.window.document !== surface.document || surface.document.defaultView !== surface.window
      || descriptor.window !== surface.window || descriptor.document !== surface.document || descriptor.container !== surface.container
      || descriptor.identity.runtimeId !== identity.runtimeId || descriptor.identity.version !== identity.version
      || binding.identity.runtimeId !== identity.runtimeId || binding.identity.version !== identity.version
      || binding.resources.trustedOrigin !== resources.trustedOrigin || binding.resources.releaseBaseURL !== resources.releaseBaseURL
      || descriptor.releaseBase !== resources.releaseBaseURL || descriptor.shellURL !== new URL('shell.html', resources.releaseBaseURL).href) {
      throw new SimulatorWebProductError('invalid-web-composition');
    }
  }

  private async mountPublicShell(surface: SimulatorWebProductSurface, presented?: () => void): Promise<void> {
    const selected = await this.source!.readPresentation!(this.lifetime.signal);
    this.lifetime.signal.throwIfAborted();
    if (!exactKeys(selected, ['activation', 'identity', 'resources', 'requireCurrent'])
      || !exactKeys(selected.identity, ['runtimeId', 'version'])
      || !exactKeys(selected.resources, ['trustedOrigin', 'releaseBaseURL'])
      || typeof selected.activation?.throwIfAborted !== 'function' || typeof selected.activation?.addEventListener !== 'function'
      || typeof selected.activation?.removeEventListener !== 'function' || typeof selected.requireCurrent !== 'function'
      || typeof selected.identity.runtimeId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(selected.identity.runtimeId)
      || typeof selected.identity.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(selected.identity.version)) {
      throw new SimulatorWebProductError('invalid-web-composition');
    }
    const requireOriginal = selected.requireCurrent.bind(selected);
    const binding = Object.freeze({ activation: selected.activation,
      identity: Object.freeze(structuredClone(selected.identity)), resources: Object.freeze(structuredClone(selected.resources)),
      requireCurrent: () => { this.lifetime.signal.throwIfAborted(); selected.activation.throwIfAborted(); requireOriginal(); } });
    this.presentationBinding = binding;
    binding.activation.addEventListener('abort', this.revoke, { once: true });
    const base = releaseBase(binding.resources, surface.window.location.origin);
    binding.requireCurrent();
    const module = await this.loadPresentation(new URL('presentation.mjs', base).href);
    binding.requireCurrent();
    if (typeof module?.createWebShellPresentation !== 'function') throw new SimulatorWebProductError('invalid-web-composition');
    // Capture the original local capability before checking a reentrant revoke.
    this.shell = module.createWebShellPresentation({ window: surface.window, document: surface.document,
      container: surface.container, identity: binding.identity, releaseBase: base, shellURL: new URL('shell.html', base) });
    if (!this.shell || typeof this.shell.present !== 'function' || typeof this.shell.close !== 'function'
      || typeof this.shell.revokeDocument !== 'function' || typeof this.shell.snapshot !== 'function') {
      throw new SimulatorWebProductError('invalid-web-composition');
    }
    this.requirePresentation(surface, binding.identity, binding.resources);
    await this.shell.present();
    this.requirePresentation(surface, binding.identity, binding.resources);
    this.shellVisible = true; presented?.();
  }

  /** The normal tool-open intent presents the existing project and Shell.
   * It is outside setup so close can revoke pending authorization immediately. */
  present(): Promise<void> {
    if (this.presentationDeferred) return Promise.resolve();
    if (!this.presentation) {
      const task = Promise.resolve().then(async () => {
        await this.setup; this.requireCurrent();
        if (this.state !== 'mounted' || !this.startup) throw new SimulatorWebProductError('web-product-closed');
        await this.startup.open(); this.requireCurrent();
        await this.startup.mountView(); this.requireCurrent();
      });
      this.presentation = task;
      void task.catch(() => { if (this.presentation === task) this.presentation = null; });
    }
    return this.presentation;
  }

  /** Borrow the exact mounted product. Agent conversation leases never become
   * simulation Session IDs, and releasing them does not close the UI owner. */
  async agentRequest(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined,
    timeoutMs: number, context: SubappRegisteredAgentContext): Promise<unknown> {
    if (this.state !== 'mounted') throw new SimulatorWebProductError('web-product-closed');
    this.requireCurrent();
    const startup = this.startup;
    const workspace = (value: string) => {
      const normalized = value.replaceAll('\\', '/').replace(/\/$/u, '');
      return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized;
    };
    if (this.state !== 'mounted' || !startup || typeof startup.semanticRequest !== 'function'
      || !context.ownerSessionId || context.ownerLeaseId !== context.ownerSessionId || !context.sessionId
      || !context.toolCallId || this.agentWorkspaceRoot === null || typeof context.workspaceRoot !== 'string'
      || workspace(context.workspaceRoot) !== workspace(this.agentWorkspaceRoot)) {
      throw new SimulatorWebProductError('invalid-web-composition');
    }
    const current = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    current.throwIfAborted();
    const result = await startup.semanticRequest(method, params, current, timeoutMs);
    current.throwIfAborted(); this.requireCurrent();
    if (this.startup !== startup || this.state !== 'mounted') throw new SimulatorWebProductError('web-product-closed');
    return result;
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    if (this.closing) return this.closing;
    this.state = 'closing';
    this.lifetime.abort(new SimulatorWebProductError('web-product-closed'));
    let timer: ReturnType<typeof setTimeout>;
    if (!this.cleanup) {
      // The original close synchronously fences late admission, then waits for
      // its real layout receipt. A navigation revoke would suppress that ACK.
      const earlyShell = this.shell && !this.shellTransferred ? this.shell : null;
      let earlyClose: Promise<unknown>;
      try { earlyClose = earlyShell ? Promise.resolve(earlyShell.close()) : Promise.resolve(); }
      catch (error) { earlyClose = Promise.reject(error); }
      void earlyClose.catch(() => { /* The original cleanup below joins this exact task. */ });
      const original = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        const attempt = async (operation: () => Promise<unknown>) => {
          try { await operation(); } catch (error) { failures.push(error); }
        };
        await this.compositionRead?.catch(() => undefined);
        await this.setup?.catch(() => undefined);
        if (this.startup) await attempt(() => this.startup!.close());
        await this.shellSetup?.catch(() => undefined);
        await attempt(() => earlyClose);
        if (this.shell && !this.shellTransferred && this.shell !== earlyShell) await attempt(() => this.shell!.close());
        await this.presentation?.catch(() => undefined);
        if (this.unclaimedProviders) await attempt(async () => { await this.unclaimedProviders!.close(); this.unclaimedProviders = null; });
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Web product cleanup remains unconfirmed.');
        this.activation?.removeEventListener('abort', this.revoke);
        this.presentationBinding?.activation.removeEventListener('abort', this.revoke);
        this.state = 'closed';
      }).catch(error => { if (this.cleanup === original) this.cleanup = null; throw error; });
      this.cleanup = original;
    }
    const task = Promise.race([this.cleanup, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SimulatorWebProductError('cleanup-unconfirmed')), this.cleanupWaitMs);
    })]).catch(error => { if (this.state !== 'closed') this.state = 'unconfirmed'; throw error; })
      .finally(() => { clearTimeout(timer); if (this.closing === task) this.closing = null; });
    this.closing = task;
    return task;
  }

  snapshot() {
    const shell = this.shell?.snapshot() as { state?: unknown; generation?: unknown; pending?: unknown;
      current?: { presented?: unknown; admissionStarted?: unknown; handedOff?: unknown } | null;
      lastClosed?: { presentationCleanupAcknowledged?: unknown } | null } | null;
    return { state: this.state, configured: this.source !== null, startup: this.startup?.snapshot() ?? null,
      publicPresentation: this.shell ? { visible: this.shellVisible, transferred: this.shellTransferred,
        startupOwnsPresentation: this.shellTransferred && this.startup !== null,
        state: typeof shell?.state === 'string' ? shell.state : null,
        generation: typeof shell?.generation === 'number' && Number.isSafeInteger(shell.generation) ? shell.generation : null,
        pending: typeof shell?.pending === 'number' && Number.isSafeInteger(shell.pending) ? shell.pending : null,
        presented: shell?.current?.presented === true, admissionStarted: shell?.current?.admissionStarted === true,
        handedOff: shell?.current?.handedOff === true,
        layoutCloseAcknowledged: shell?.lastClosed?.presentationCleanupAcknowledged === true } : null,
      retainedCleanupResponsibility: this.state !== 'new' && this.state !== 'closed',
      WorkerPhysicalExitConfirmed: false, NodeBusinessACK: false, MainBusinessACK: false };
  }
}
