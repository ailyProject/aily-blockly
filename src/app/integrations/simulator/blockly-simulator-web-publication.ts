import type { SimulatorWebProductActivation, SimulatorWebSelectedProjectContext } from './simulator-web-product.source';
import type { SimulatorWebProjectPublicationPort, SimulatorCapturedProjectActivation } from './simulator-web-project-activation';
import type { SimulatorWebDebuggerCallbacks } from './simulator-web-product.service';

/** Borrowed callbacks from the same product composition used by Native. */
export interface BlocklySimulatorProjectScope {
  readonly activation: SimulatorCapturedProjectActivation;
  readonly projectIdentity: string;
  readonly workspaceIdentity: string;
  readonly callbacks: {
    readContext(request: { projectIdentity: string }, signal: AbortSignal): unknown;
    readonly readDebugConfiguration?: SimulatorWebDebuggerCallbacks['readConfiguration'];
  };
  readonly editorCallbacks?: SimulatorWebDebuggerCallbacks['editorCallbacks'];
  readonly project: {
    handleInvocation(value: unknown, signal?: AbortSignal): Promise<unknown>;
    handleArtifactChunk(value: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  requireCurrent(): void;
  close(): void | Promise<void>;
}

export interface BlocklySimulatorProjectSourceModule {
  createHostCallbackProjectSource(options: {
    adapter: BlocklySimulatorProjectScope['project'];
    context: SimulatorWebSelectedProjectContext;
    owner: { requireCurrent(): void };
    activation: AbortSignal;
    signal: AbortSignal;
  }): Promise<{
    context: SimulatorWebSelectedProjectContext;
    store: object;
    artifact: object | null;
    close(): Promise<void>;
  }>;
}

/** Supplied only by the owning application's trusted composition. It supplies
 * release/account/instance inputs, never a project selected by a child page. */
export interface BlocklySimulatorWebDeployment {
  readStartup(input: {
    activation: SimulatorCapturedProjectActivation;
    context: SimulatorWebSelectedProjectContext;
    signal: AbortSignal;
  }): Promise<Omit<SimulatorWebProductActivation['startupOptions'], 'owner'>>;
}

export interface BlocklySimulatorWebPublicationOptions {
  openCurrentProjectScope(signal: AbortSignal): Promise<BlocklySimulatorProjectScope | null>;
  readonly deployment: BlocklySimulatorWebDeployment;
  /** The actual SDK project context reader; retained as a narrow callback so
   * this publication seam need not import the complete desktop DI graph. */
  readContext(scope: BlocklySimulatorProjectScope, signal: AbortSignal): Promise<SimulatorWebSelectedProjectContext>;
  loadSource?(url: string): Promise<BlocklySimulatorProjectSourceModule>;
}

const loadSource = (url: string): Promise<BlocklySimulatorProjectSourceModule> => import(/* @vite-ignore */ url);

/** One publication per view, with its own original callback scope. Scene and
 * Artifact authorities stay in that scope; no IDB seed, second registry or
 * compiler is introduced. Failed cleanup remains attached to this caller. */
export function createBlocklySimulatorWebPublication(options: BlocklySimulatorWebPublicationOptions) {
  const openScope = options.openCurrentProjectScope.bind(options);
  const readContext = options.readContext.bind(options);
  const readStartup = options.deployment.readStartup.bind(options.deployment);
  const load = options.loadSource?.bind(options) ?? loadSource;
  const lifetime = new AbortController();
  const retained = new Set<{ close(): Promise<void> }>();
  const pendingReads = new Set<Promise<unknown>>();
  let closed = false;

  async function readOne(projectPath: string, signal: AbortSignal) {
    if (closed) throw new Error('The Blockly Browser publication is closed.');
    const request = AbortSignal.any([signal, lifetime.signal]);
    request.throwIfAborted();
    const scope = await openScope(request);
    if (!scope) throw Object.assign(new Error('No active Blockly project scope.'), { code: 'project-unavailable' });
    let source: Awaited<ReturnType<BlocklySimulatorProjectSourceModule['createHostCallbackProjectSource']>> | null = null;
    let pending: Promise<unknown> | null = null, closing: Promise<void> | null = null;
    const pendingDebuggerCalls = new Set<Promise<unknown>>();
    let scopeClosed = false, sourceClosed = false;
    const callerLifetime = new AbortController();
    const activation = AbortSignal.any([request, scope.activation.signal, callerLifetime.signal]);
    const requireCurrent = () => { activation.throwIfAborted(); scope.requireCurrent(); };
    const revoke = () => { void cleanup.close().catch(() => { /* Retained for exact caller retry. */ }); };
    const cleanup = {
      close(): Promise<void> {
        if (closing) return closing;
        const task = Promise.resolve().then(async () => {
          // A factory's late result is captured before this join completes.
          await pending?.catch(() => undefined);
          // Cancellation fences admission; original callbacks still own their
          // actual outcome, including a late result that ignores its signal.
          await Promise.allSettled([...pendingDebuggerCalls]);
          const failures: unknown[] = [];
          if (source && !sourceClosed) {
            try { await source.close(); sourceClosed = true; } catch (error) { failures.push(error); }
          }
          // Retiring the original Host is still required when a private lane
          // reports uncertainty; otherwise its references would be stranded.
          if (!scopeClosed) {
            try { await scope.close(); scopeClosed = true; } catch (error) { failures.push(error); }
          }
          if (failures.length) throw new AggregateError(failures, 'Original Blockly publication cleanup remains unconfirmed.');
          activation.removeEventListener('abort', revoke);
          retained.delete(cleanup);
        }).finally(() => { if (closing === task) closing = null; });
        closing = task;
        callerLifetime.abort(new DOMException('The owning Blockly publication caller closed.', 'AbortError'));
        void task.catch(() => { /* Never replace a failed original close with an ACK. */ });
        return task;
      },
    };
    retained.add(cleanup);
    activation.addEventListener('abort', revoke, { once: true });
    function debuggerCall<T>(operation: () => T | Promise<T>): Promise<T> {
      const task = Promise.resolve().then(operation).finally(() => { pendingDebuggerCalls.delete(task); });
      pendingDebuggerCalls.add(task);
      void task.catch(() => { /* Cleanup joins the actual callback settlement. */ });
      return task;
    }
    const readConfiguration = scope.callbacks.readDebugConfiguration?.bind(scope.callbacks);
    const editor = scope.editorCallbacks;
    const debuggerCallbacks: SimulatorWebDebuggerCallbacks | undefined = readConfiguration && editor
      ? Object.freeze<SimulatorWebDebuggerCallbacks>({
        readConfiguration: (input, signal) => debuggerCall(async () => {
          const current = AbortSignal.any([activation, signal]);
          requireCurrent(); current.throwIfAborted();
          const value = await readConfiguration(input, current);
          current.throwIfAborted(); requireCurrent();
          return value;
        }),
        editorCallbacks: Object.freeze<SimulatorWebDebuggerCallbacks['editorCallbacks']>({
          publishDebugLocation: event => {
            const clearing = event.status === 'clear';
            return debuggerCall(async () => {
              // The original Authority owns exact marker retirement. An ended
              // business admission must not prevent its original clear.
              if (!clearing) requireCurrent();
              const value = await editor.publishDebugLocation(event);
              if (!clearing) requireCurrent();
              return value;
            });
          },
          revealSourceLocation: input => debuggerCall(async () => {
            requireCurrent();
            const value = await editor.revealSourceLocation(input);
            requireCurrent(); return value;
          }),
        }),
      }) : undefined;
    const work = Promise.resolve().then(async () => {
      requireCurrent();
      if (scope.activation.path !== projectPath) throw new Error('Blockly publication selected a different project.');
      const context = await readContext(scope, activation);
      requireCurrent();
      if (context.projectIdentity !== scope.projectIdentity || context.workspaceIdentity !== scope.workspaceIdentity
        || context.activeSceneId !== 'main') throw new Error('Blockly callback context is outside the captured project.');
      const startup = await readStartup({ activation: scope.activation, context: structuredClone(context), signal: activation });
      requireCurrent();
      const base = new URL(startup.resources.releaseBaseURL);
      const origin = globalThis.location.origin;
      if (base.href !== startup.resources.releaseBaseURL || base.origin !== origin || startup.resources.trustedOrigin !== origin
        || base.username || base.password || base.search || base.hash || !/^\/releases\/[a-f0-9]{64}\/$/u.test(base.pathname)
        || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
        || startup.identity.projectIdentity !== context.projectIdentity || startup.identity.sceneId !== context.activeSceneId
        || startup.identity.artifactRevision !== context.activeArtifactRevision || startup.resources.artifactBaseURL !== null) {
        throw new TypeError('Blockly Browser startup must bind the exact project, sealed Artifact and trusted release.');
      }
      const module = await load(new URL('host-project-source.mjs', base).href);
      requireCurrent();
      if (typeof module?.createHostCallbackProjectSource !== 'function') throw new TypeError('The release lacks its Host callback adapter.');
      source = await module.createHostCallbackProjectSource({ adapter: scope.project, context,
        owner: { requireCurrent }, activation, signal: activation });
      requireCurrent();
      const startupOptions = { ...startup, owner: { requireCurrent } };
      // Resource/deployment inputs cannot substitute another Editor authority.
      delete startupOptions.debugger;
      if (debuggerCallbacks) startupOptions.debugger = debuggerCallbacks;
      return { projectPath, activation: { activation,
        startupOptions,
        project: { context: source.context, store: source.store, artifact: source.artifact, ownedStore: cleanup },
      } satisfies SimulatorWebProductActivation };
    });
    pending = work;
    try { return await work; }
    catch (error) {
      // Clear the self-join before joining cleanup from the failing read.
      pending = null;
      try { await cleanup.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Blockly publication and original scope cleanup failed.'); }
      throw error;
    } finally { pending = null; }
  }

  const publication: SimulatorWebProjectPublicationPort & { close(): Promise<void>; snapshot(): object } = {
    readPublication(projectPath, signal) {
      const task = readOne(projectPath, signal).finally(() => { pendingReads.delete(task); });
      pendingReads.add(task);
      void task.catch(() => { /* The original read and close share its actual outcome. */ });
      return task;
    },
    async close() {
      closed = true;
      lifetime.abort(new DOMException('The owning Blockly Browser publication closed.', 'AbortError'));
      await Promise.allSettled([...pendingReads]);
      const results = await Promise.allSettled([...retained].map(caller => caller.close()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Blockly callback scope cleanup remains unconfirmed.');
    },
    snapshot: () => ({ closed, pendingReads: pendingReads.size, retainedCallers: retained.size,
      retainedCleanupResponsibility: retained.size !== 0 || pendingReads.size !== 0,
      NodeBusinessACK: false, MainBusinessACK: false, WorkerPhysicalExitConfirmed: false }),
  };
  return Object.freeze(publication);
}
