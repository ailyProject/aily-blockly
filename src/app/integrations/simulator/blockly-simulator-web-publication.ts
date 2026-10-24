import type { SimulatorWebProductActivation, SimulatorWebSelectedProjectContext } from './simulator-web-product.source';
import type { SimulatorWebProjectPublicationPort, SimulatorCapturedProjectActivation } from './simulator-web-project-activation';
import type { SimulatorWebDebuggerCallbacks, SimulatorWebProductPresentation } from './simulator-web-product.service';
import type { SimulatorProjectReadAuthority, SimulatorProjectReadAuthorityCapture } from './simulator-current-project-scope';
import type { SimulatorSubappHostProjectContextSnapshotV1 } from '@aily-project/simulator-protocol/host';

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
  captureArtifactReadAuthority?(input: SimulatorProjectReadAuthorityCapture): SimulatorProjectReadAuthority;
  close(): void | Promise<void>;
}

export interface BlocklySimulatorProjectSourceModule {
  createHostCallbackProjectSource(options: {
    adapter: BlocklySimulatorProjectScope['project'];
    context: SimulatorWebSelectedProjectContext;
    owner: { requireCurrent(): void };
    activation: AbortSignal;
    signal: AbortSignal;
    capturePreparationAuthority?(input: SimulatorProjectReadAuthorityCapture): SimulatorProjectReadAuthority;
  }): Promise<{
    context: SimulatorWebSelectedProjectContext;
    store: object;
    artifact: object | null;
    readonly preparation?: null | {
      readonly authority: SimulatorProjectReadAuthority;
      readonly capturedContext: SimulatorWebSelectedProjectContext;
      readonly artifact: object;
      readonly prepared: object;
    };
    prepareArtifact?(signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    snapshot?(): unknown;
  }>;
}

const ARTIFACT_TIMING_OPERATIONS = [
  'sealed.read', 'sealed.allocate', 'sealed.copy', 'sealed.hash', 'sealed.return-copy', 'sealed.open',
  'retained.open', 'retained.read', 'retained.hash', 'retained.queue',
  'file.identity', 'file.open', 'file.stat', 'file.read', 'file.allocate', 'provider.wait', 'provider.decode',
  'sender.read', 'sender.copy', 'sender.hash', 'sender.base64', 'sender.begin-wait', 'sender.chunk-wait',
  'sender.commit-wait', 'sender.abort-wait', 'receiver.hash', 'receiver.begin', 'receiver.chunk', 'receiver.commit', 'receiver.abort',
] as const;
const TIMING_INTEGER_FIELDS = ['count', 'pending', 'succeeded', 'failed', 'bytes'] as const;
interface ArtifactTimingRow {
  readonly operation: string;
  readonly count: number; readonly pending: number; readonly succeeded: number; readonly failed: number;
  readonly totalMs: number; readonly maxMs: number; readonly bytes: number;
}
interface ArtifactTimingSnapshot {
  readonly rows: readonly ArtifactTimingRow[];
  readonly overflow: number; readonly clockFailures: number;
}
const HANDSHAKE_TIMING_PHASES = ['caller.context-before', 'caller.descriptor', 'caller.context-after',
  'open.context-before', 'open.descriptor-refresh', 'open.context-after', 'caller.close-join'] as const;
interface HandshakeTimingSnapshot {
  readonly rows: readonly {
    readonly phase: string;
    readonly count: number; readonly pending: number; readonly succeeded: number; readonly failed: number;
    readonly totalMs: number; readonly maxMs: number;
  }[];
  readonly overflow: number; readonly clockFailures: number;
}
interface PublicationCallerTiming {
  readonly readTiming: ArtifactTimingSnapshot | null;
  readonly handshakeTiming: HandshakeTimingSnapshot | null;
}
interface PublicationArtifactReadTiming {
  readonly callersObserved: number;
  readonly callersTruncated: boolean;
  readonly callers: readonly PublicationCallerTiming[];
}
const boundedTimingNumber = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function projectTiming(value: unknown): ArtifactTimingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate['rows']) || candidate['rows'].length !== ARTIFACT_TIMING_OPERATIONS.length
    || !Number.isSafeInteger(candidate['overflow']) || (candidate['overflow'] as number) < 0
    || !Number.isSafeInteger(candidate['clockFailures']) || (candidate['clockFailures'] as number) < 0) return null;
  const rows: ArtifactTimingRow[] = [];
  for (const [index, operation] of ARTIFACT_TIMING_OPERATIONS.entries()) {
    const row = candidate['rows'][index] as Record<string, unknown> | undefined;
    if (!row || row['operation'] !== operation || !TIMING_INTEGER_FIELDS.every(key => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0)
      || !boundedTimingNumber(row['totalMs']) || !boundedTimingNumber(row['maxMs'])) return null;
    rows.push(Object.freeze({ operation, count: row['count'] as number, pending: row['pending'] as number,
      succeeded: row['succeeded'] as number, failed: row['failed'] as number, totalMs: row['totalMs'],
      maxMs: row['maxMs'], bytes: row['bytes'] as number }));
  }
  return Object.freeze({ rows: Object.freeze(rows), overflow: candidate['overflow'] as number,
    clockFailures: candidate['clockFailures'] as number });
}
function projectHandshakeTiming(value: unknown): HandshakeTimingSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate['rows']) || candidate['rows'].length !== HANDSHAKE_TIMING_PHASES.length
    || !Number.isSafeInteger(candidate['overflow']) || (candidate['overflow'] as number) < 0
    || !Number.isSafeInteger(candidate['clockFailures']) || (candidate['clockFailures'] as number) < 0) return null;
  const rows: HandshakeTimingSnapshot['rows'][number][] = [];
  for (const [index, phase] of HANDSHAKE_TIMING_PHASES.entries()) {
    const row = candidate['rows'][index] as Record<string, unknown> | undefined;
    if (!row || row['phase'] !== phase
      || !['count', 'pending', 'succeeded', 'failed'].every(key => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0)
      || !boundedTimingNumber(row['totalMs']) || !boundedTimingNumber(row['maxMs'])) return null;
    rows.push(Object.freeze({ phase, count: row['count'] as number, pending: row['pending'] as number,
      succeeded: row['succeeded'] as number, failed: row['failed'] as number,
      totalMs: row['totalMs'], maxMs: row['maxMs'] }));
  }
  return Object.freeze({ rows: Object.freeze(rows), overflow: candidate['overflow'] as number,
    clockFailures: candidate['clockFailures'] as number });
}

/** Diagnostics only: fixed numeric rows per original caller, never a raw
 * source snapshot. Callers remain separate so shared counters are not summed. */
export function projectBlocklyArtifactReadTiming(value: unknown): PublicationArtifactReadTiming | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>, callers = candidate['callers'];
    if (!Array.isArray(callers) || callers.length > 4 || candidate['callersObserved'] !== callers.length
      || typeof candidate['callersTruncated'] !== 'boolean') return null;
    return Object.freeze({ callersObserved: callers.length, callersTruncated: candidate['callersTruncated'],
      callers: Object.freeze(callers.map(caller => Object.freeze({ readTiming: projectTiming(caller?.readTiming),
        handshakeTiming: projectHandshakeTiming(caller?.handshakeTiming) }))) });
  } catch { return null; }
}

/** Supplied only by the owning application's trusted composition. It supplies
 * release/account/instance inputs, never a project selected by a child page. */
export interface BlocklySimulatorWebDeployment {
  readPresentation?(signal: AbortSignal): Promise<SimulatorWebProductPresentation>;
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
type PublicationResult = Awaited<ReturnType<SimulatorWebProjectPublicationPort['readPublication']>>;
interface PublicationCallerOwner {
  close(): Promise<void>;
  snapshot(): PublicationCallerTiming;
  requirePrepared(): void;
  verifyPrepared(signal: AbortSignal): Promise<void>;
}
const prewarmFailure = (code: 'prewarm-unsupported' | 'prewarm-unavailable') => Object.assign(new Error(code), { code });
const sameProjectContext = (left: SimulatorSubappHostProjectContextSnapshotV1, right: SimulatorWebSelectedProjectContext) => (
  ['schemaVersion', 'kind', 'projectIdentity', 'workspaceIdentity', 'activeSceneId',
    'activeArtifactRevision', 'workspaceSourceSha256'] as const
).every(key => left?.[key] === right[key]);

/** One publication per view, with its own original callback scope. Scene and
 * Artifact authorities stay in that scope; no IDB seed, second registry or
 * compiler is introduced. Failed cleanup remains attached to this caller. */
export function createBlocklySimulatorWebPublication(options: BlocklySimulatorWebPublicationOptions) {
  const openScope = options.openCurrentProjectScope.bind(options);
  const readContext = options.readContext.bind(options);
  const readStartup = options.deployment.readStartup.bind(options.deployment);
  const load = options.loadSource?.bind(options) ?? loadSource;
  const lifetime = new AbortController();
  const retained = new Set<{ close(): Promise<void>; snapshot(): PublicationCallerTiming }>();
  const pendingReads = new Set<Promise<unknown>>();
  let closed = false;
  const artifactReadTiming = () => {
    const callers: PublicationCallerTiming[] = [];
    for (const caller of retained) { if (callers.length === 4) break; callers.push(caller.snapshot()); }
    return { callersObserved: callers.length, callersTruncated: retained.size > callers.length, callers };
  };

  async function readOne(projectPath: string, signal: AbortSignal, captured?: SimulatorCapturedProjectActivation,
    adoptOwner?: (owner: PublicationCallerOwner) => void, retireOwner?: () => void) {
    if (closed) throw new Error('The Blockly Browser publication is closed.');
    const request = AbortSignal.any([signal, lifetime.signal, ...(captured ? [captured.signal] : [])]);
    request.throwIfAborted();
    captured?.requireCurrent();
    const scope = await openScope(request);
    if (!scope) throw Object.assign(new Error('No active Blockly project scope.'), { code: 'project-unavailable' });
    let source: Awaited<ReturnType<BlocklySimulatorProjectSourceModule['createHostCallbackProjectSource']>> | null = null;
    let pending: Promise<unknown> | null = null, closing: Promise<void> | null = null;
    const pendingDebuggerCalls = new Set<Promise<unknown>>();
    let scopeClosed = false, sourceClosed = false;
    const callerLifetime = new AbortController();
    const activation = AbortSignal.any([request, scope.activation.signal, callerLifetime.signal]);
    const requireCurrent = () => {
      activation.throwIfAborted(); scope.requireCurrent(); captured?.requireCurrent();
      if (captured && (scope.activation.path !== captured.path || scope.activation.projectSessionId !== captured.projectSessionId)) {
        throw prewarmFailure('prewarm-unavailable');
      }
    };
    const revoke = () => { void cleanup.close().catch(() => { /* Retained for exact caller retry. */ }); };
    const cleanup = {
      requirePrepared() {
        requireCurrent();
        if (!source?.preparation || typeof source.prepareArtifact !== 'function') throw prewarmFailure('prewarm-unsupported');
        if (source.preparation.artifact !== source.artifact || source.preparation.authority.artifact !== source.artifact) {
          throw prewarmFailure('prewarm-unavailable');
        }
        source.preparation.authority.requireCurrent();
      },
      async verifyPrepared(signal: AbortSignal) {
        cleanup.requirePrepared(); signal.throwIfAborted();
        const preparation = source!.preparation!;
        const value = await preparation.authority.readCurrentContext(AbortSignal.any([activation, signal]));
        cleanup.requirePrepared(); signal.throwIfAborted();
        if (!sameProjectContext(value, source!.context)) throw prewarmFailure('prewarm-unavailable');
      },
      snapshot() {
        try {
          const value = source?.snapshot?.();
          const snapshot = value && typeof value === 'object' ? value as Record<string, unknown> : null;
          return { readTiming: projectTiming(snapshot?.['readTiming']), handshakeTiming: projectHandshakeTiming(snapshot?.['handshakeTiming']) };
        } catch { return { readTiming: null, handshakeTiming: null }; }
      },
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
          retireOwner?.();
        }).finally(() => { if (closing === task) closing = null; });
        closing = task;
        callerLifetime.abort(new DOMException('The owning Blockly publication caller closed.', 'AbortError'));
        void task.catch(() => { /* Never replace a failed original close with an ACK. */ });
        return task;
      },
    };
    retained.add(cleanup);
    adoptOwner?.(cleanup);
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
        owner: { requireCurrent }, activation, signal: activation,
        ...(scope.captureArtifactReadAuthority
          ? { capturePreparationAuthority: scope.captureArtifactReadAuthority.bind(scope) } : {}),
      });
      requireCurrent();
      // This owner is already the original project-read scope. Preparation
      // grants no execution owner, Session, Worker, debugger or authorization.
      const legacySealedSource = source.preparation === undefined && source.prepareArtifact === undefined;
      if (scope.captureArtifactReadAuthority && source.artifact !== null && !legacySealedSource) {
        if (!source.preparation || typeof source.prepareArtifact !== 'function'
          || source.preparation.artifact !== source.artifact || source.preparation.authority.artifact !== source.artifact) {
          throw new TypeError('The release lacks its exact original project-read preparation capability.');
        }
        await source.prepareArtifact(activation); requireCurrent();
      }
      const preparedArtifact = source.preparation ? Object.freeze({ binding: source.preparation,
        authority: source.preparation.authority, context: source.preparation.capturedContext }) : undefined;
      const startupOptions = { ...startup, owner: { requireCurrent } };
      // Resource/deployment inputs cannot substitute another Editor authority.
      delete startupOptions.debugger;
      if (debuggerCallbacks) startupOptions.debugger = debuggerCallbacks;
      return { projectPath, activation: { activation,
        startupOptions,
        project: { context: source.context, store: source.store, artifact: source.artifact, ownedStore: cleanup,
          ...(preparedArtifact ? { preparedArtifact } : {}),
        },
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

  function trackedRead(projectPath: string, signal: AbortSignal, captured?: SimulatorCapturedProjectActivation,
    adoptOwner?: (owner: PublicationCallerOwner) => void, retireOwner?: () => void) {
    const task = readOne(projectPath, signal, captured, adoptOwner, retireOwner).finally(() => { pendingReads.delete(task); });
    pendingReads.add(task); void task.catch(() => { /* Retain the original read outcome. */ }); return task;
  }

  /** One caller, prepared under the original project-read scope. The trigger
   * owns only this unclaimed handle, never an execution owner or shared cache. */
  function preparePublication(captured: SimulatorCapturedProjectActivation, signal: AbortSignal) {
    const controller = new AbortController();
    let owner: PublicationCallerOwner | null = null, result: PublicationResult | null = null;
    let state: 'preparing' | 'ready' | 'claiming' | 'adopted' | 'closing' | 'closed' | 'failed' | 'unconfirmed' = 'preparing';
    let claimed = false, closeRequested = false, closing: Promise<void> | null = null;
    let checking: Promise<void> | null = null;
    const detachTrigger = new Set<() => void>(), detachConsumer = new Set<() => void>();
    const removeTrigger = () => { for (const remove of detachTrigger) remove(); detachTrigger.clear(); };
    const removeSignals = () => { removeTrigger(); for (const remove of detachConsumer) remove(); detachConsumer.clear(); };
    const current = (external?: AbortSignal) => {
      controller.signal.throwIfAborted(); lifetime.signal.throwIfAborted(); captured.signal.throwIfAborted();
      external?.throwIfAborted(); captured.requireCurrent();
      if (closed || closeRequested) throw prewarmFailure('prewarm-unavailable');
    };
    if (signal.aborted) controller.abort(signal.reason);
    const ready = trackedRead(captured.path, controller.signal, captured, value => { owner = value; }, removeSignals)
      .then(async value => {
        result = value; // Adopt the original result before any post-await fence.
        try { current(); owner!.requirePrepared(); state = 'ready'; }
        catch (error) {
          controller.abort(error);
          try { await owner!.close(); }
          catch (cleanup) { state = 'unconfirmed'; throw new AggregateError([error, cleanup], 'Prepared publication cleanup remains unconfirmed.'); }
          state = 'failed'; throw error;
        }
      }, error => { state = 'failed'; throw error; });
    void ready.catch(() => { /* The trigger retains this same handle until close confirms cleanup. */ });
    function close(): Promise<void> {
      if (state === 'adopted' || state === 'closed') return Promise.resolve();
      closeRequested = true; removeSignals(); controller.abort(new DOMException('The pending publication was cancelled.', 'AbortError'));
      if (closing) return closing;
      state = 'closing';
      const task = Promise.resolve().then(async () => {
        await ready.catch(() => undefined); await checking?.catch(() => undefined);
        await owner?.close(); state = 'closed'; result = null;
      }).catch(error => { state = 'unconfirmed'; throw error; })
        .finally(() => { if (closing === task) closing = null; });
      closing = task; void task.catch(() => { /* Keep this same cleanup owner for retry. */ }); return task;
    }
    function forward(external: AbortSignal, consumer = false) {
      const abort = () => {
        if (state === 'adopted' && consumer) {
          controller.abort(external.reason);
          void owner?.close().catch(() => { /* The original UI owner retains this same failed cleanup. */ });
        } else if (state !== 'adopted') void close().catch(() => { /* Retain failed cleanup. */ });
      };
      external.addEventListener('abort', abort, { once: true });
      (consumer ? detachConsumer : detachTrigger).add(() => external.removeEventListener('abort', abort));
      if (external.aborted) abort();
    }
    forward(signal);
    return Object.freeze({ ready,
      async readPublication(projectPath: string, external: AbortSignal): Promise<PublicationResult> {
        if (claimed || closeRequested || state === 'adopted') throw prewarmFailure('prewarm-unavailable');
        claimed = true; forward(external, true);
        try {
          current(external);
          if (projectPath !== captured.path) throw prewarmFailure('prewarm-unavailable');
          await ready; current(external); state = 'claiming';
          const check = owner!.verifyPrepared(external); checking = check;
          try { await check; } finally { if (checking === check) checking = null; }
          current(external);
          state = 'adopted'; removeTrigger(); return result!;
        } catch (error) {
          try { await close(); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Prepared publication claim and cleanup remain unconfirmed.'); }
          throw error;
        }
      },
      close,
      snapshot: () => ({ state, claimed, cleanupPending: closing !== null, originalCallerAdopted: state === 'adopted',
        triggerSignals: detachTrigger.size, consumerSignals: detachConsumer.size,
        retainedCleanupResponsibility: state === 'unconfirmed' || state !== 'adopted' && state !== 'closed',
        NodeBusinessACK: false, MainBusinessACK: false, WorkerPhysicalExitConfirmed: false }),
    });
  }

  const publication: SimulatorWebProjectPublicationPort & { preparePublication: typeof preparePublication; close(): Promise<void>; snapshot(): object } = {
    preparePublication,
    ...(options.deployment.readPresentation ? { async readPresentation(signal: AbortSignal) {
      if (closed) throw new Error('The Blockly Browser publication is closed.');
      const request = AbortSignal.any([signal, lifetime.signal]); request.throwIfAborted();
      const selected = await options.deployment.readPresentation!(request); request.throwIfAborted();
      const requireOriginal = selected.requireCurrent.bind(selected);
      return Object.freeze({ activation: AbortSignal.any([request, selected.activation]),
        identity: Object.freeze(structuredClone(selected.identity)), resources: Object.freeze(structuredClone(selected.resources)),
        requireCurrent() { request.throwIfAborted(); selected.activation.throwIfAborted(); requireOriginal(); } });
    } } : {}),
    readPublication(projectPath, signal) {
      return trackedRead(projectPath, signal);
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
      artifactReadTiming: artifactReadTiming(),
      retainedCleanupResponsibility: retained.size !== 0 || pendingReads.size !== 0,
      NodeBusinessACK: false, MainBusinessACK: false, WorkerPhysicalExitConfirmed: false }),
  };
  return Object.freeze(publication);
}
