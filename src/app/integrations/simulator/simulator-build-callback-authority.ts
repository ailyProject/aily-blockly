import {
  SimulatorHostProviderOperationError,
  validateSimulatorSubappHostArtifactDescriptorV1,
  type SceneArtifactRebuildAck,
  type SceneArtifactRebuildRequest,
  type SimulatorBuildHostProviderAdapterOptions,
  type SimulatorBuildProgressSubscription,
  type SimulatorSubappHostArtifactDescriptorV1,
  type SimulatorSubappHostBuildProgressErrorCode,
  type SimulatorSubappHostBuildProgressStage,
  type SimulatorSubappHostBuildProgressSubscribeV1,
  type SimulatorSubappHostBuildProgressV1,
} from '@aily-project/simulator-host-sdk';

const TERMINAL_STAGES = new Set<SimulatorSubappHostBuildProgressStage>([
  'completed',
  'failed',
  'cancelled',
]);
const ALLOWED_TRANSITIONS = new Map<
  SimulatorSubappHostBuildProgressStage,
  ReadonlySet<SimulatorSubappHostBuildProgressStage>
>([
  ['queued', new Set(['resolving', 'generating', 'compiling', 'failed', 'cancelled'])],
  ['resolving', new Set(['generating', 'compiling', 'failed', 'cancelled'])],
  ['generating', new Set(['compiling', 'failed', 'cancelled'])],
  ['compiling', new Set(['linking', 'staging', 'failed', 'cancelled'])],
  ['linking', new Set(['staging', 'failed', 'cancelled'])],
  ['staging', new Set(['completed', 'failed', 'cancelled'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['cancelled', new Set()],
]);
const DEFAULT_MAX_JOBS = 32;

export interface SimulatorBuildExecutionObserver {
  report(
    stage: Exclude<
      SimulatorSubappHostBuildProgressStage,
      'completed' | 'failed' | 'cancelled'
    >,
    progressPermille: number,
  ): void;
}

/**
 * Product-owned build port. Its implementation may reconcile source through
 * the Host Agent and call BuilderService, but it cannot control Simulator
 * sessions, QEMU, GDB, Scene Runtime, or iframe lifecycle.
 */
export interface SimulatorBuildExecutionPort {
  reconcileAndBuild(
    request: SceneArtifactRebuildRequest,
    observer: SimulatorBuildExecutionObserver,
    signal: AbortSignal,
  ): Promise<SimulatorSubappHostArtifactDescriptorV1>;
}

export interface SimulatorBuildCallbackAuthorityOptions {
  projectIdentity: string;
  sceneId?: string;
  execution: SimulatorBuildExecutionPort;
  maxJobs?: number;
}

interface ProgressEntry {
  sequence: number;
  payload: SimulatorSubappHostBuildProgressV1;
}

interface ProgressListener {
  publish(progress: SimulatorSubappHostBuildProgressV1): void;
  signal: AbortSignal;
  abort: () => void;
}

interface BuildJob {
  request: SceneArtifactRebuildRequest;
  requestDigest: string;
  controller: AbortController;
  progress: ProgressEntry[];
  listeners: Set<ProgressListener>;
  terminal: boolean;
}

/**
 * Bounded Project-scoped build job authority used behind the Host SDK. An
 * accepted acknowledgement only records the job; completion is delivered
 * through the exact Build progress subscription.
 */
export class SimulatorBuildCallbackAuthority {
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly callbacks: Pick<
    SimulatorBuildHostProviderAdapterOptions,
    'requestArtifact' | 'subscribeProgress'
  >;

  private readonly execution: SimulatorBuildExecutionPort;
  private readonly maxJobs: number;
  private readonly jobs = new Map<string, BuildJob>();
  private activeRequestId: string | null = null;
  private closed = false;

  constructor(options: SimulatorBuildCallbackAuthorityOptions) {
    this.projectIdentity = requirePortableIdentifier(
      options.projectIdentity,
      'projectIdentity',
    );
    this.sceneId = requirePortableIdentifier(options.sceneId ?? 'main', 'sceneId');
    if (
      !options.execution
      || typeof options.execution.reconcileAndBuild !== 'function'
    ) {
      throw new TypeError('Build execution port is invalid.');
    }
    this.execution = options.execution;
    this.maxJobs = requireIntegerInRange(
      options.maxJobs ?? DEFAULT_MAX_JOBS,
      1,
      128,
      'maxJobs',
    );
    this.callbacks = Object.freeze({
      requestArtifact: (
        request: SceneArtifactRebuildRequest,
        signal: AbortSignal,
      ) => this.requestArtifact(request, signal),
      subscribeProgress: (
        request: SimulatorSubappHostBuildProgressSubscribeV1,
        publish: (progress: SimulatorSubappHostBuildProgressV1) => void,
        signal: AbortSignal,
      ) => this.subscribeProgress(request, publish, signal),
    });
  }

  snapshot(): Readonly<{
    closed: boolean;
    jobs: number;
    activeRequestId: string | null;
    activeSubscriptions: number;
  }> {
    let activeSubscriptions = 0;
    for (const job of this.jobs.values()) {
      activeSubscriptions += job.listeners.size;
    }
    return Object.freeze({
      closed: this.closed,
      jobs: this.jobs.size,
      activeRequestId: this.activeRequestId,
      activeSubscriptions,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) {
      if (!job.terminal) {
        job.controller.abort();
        this.publishTerminal(job, 'cancelled', 0, 'cancelled');
      }
      this.releaseListeners(job);
    }
    this.activeRequestId = null;
  }

  private requestArtifact(
    request: SceneArtifactRebuildRequest,
    signal: AbortSignal,
  ): SceneArtifactRebuildAck {
    if (this.closed || signal.aborted) {
      throw new SimulatorHostProviderOperationError('cancelled');
    }
    if (!this.isExactScope(request)) {
      return rebuildAck(request, 'rejected', 'project-not-active');
    }
    if (
      request.action !== 'reconcile-and-build'
      || request.sceneDocument.sceneId !== request.sceneId
      || request.sceneDocument.graphSemanticRevision !== request.sceneRevision
    ) {
      return rebuildAck(request, 'rejected', 'invalid-request');
    }
    const requestDigest = stableJson(request);
    const remembered = this.jobs.get(request.requestId);
    if (remembered) {
      if (remembered.requestDigest !== requestDigest) {
        return rebuildAck(request, 'conflict', 'request-superseded');
      }
      if (!remembered.terminal || currentStage(remembered) === 'completed') {
        return rebuildAck(request, 'accepted', null);
      }
      // A failed or cancelled immutable build may be retried with the same
      // request identity. Replace only its terminal job; completed results
      // remain idempotent and conflicting payloads remain rejected above.
      this.jobs.delete(request.requestId);
    }
    if (this.activeRequestId) {
      const active = this.jobs.get(this.activeRequestId);
      if (active && !active.terminal) {
        active.controller.abort();
        this.publishTerminal(active, 'cancelled', 0, 'cancelled');
      }
    }
    this.pruneJobs();
    const job: BuildJob = {
      request: structuredClone(request),
      requestDigest,
      controller: new AbortController(),
      progress: [],
      listeners: new Set(),
      terminal: false,
    };
    this.jobs.set(request.requestId, job);
    this.activeRequestId = request.requestId;
    this.publishProgress(job, 'queued', 0, null, null);
    void this.runJob(job);
    return rebuildAck(request, 'accepted', null);
  }

  private subscribeProgress(
    request: SimulatorSubappHostBuildProgressSubscribeV1,
    publish: (progress: SimulatorSubappHostBuildProgressV1) => void,
    signal: AbortSignal,
  ): SimulatorBuildProgressSubscription {
    if (this.closed || signal.aborted) {
      throw new SimulatorHostProviderOperationError('cancelled');
    }
    if (
      request.projectIdentity !== this.projectIdentity
      || request.sceneId !== this.sceneId
    ) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
    const job = this.jobs.get(request.requestId);
    if (!job || !sameProgressScope(job.request, request)) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    const acceptedFromSequence = request.afterSequence ?? 0;
    const listener: ProgressListener = {
      publish,
      signal,
      abort: () => this.releaseListener(job, listener),
    };
    job.listeners.add(listener);
    signal.addEventListener('abort', listener.abort, { once: true });
    for (const entry of job.progress) {
      if (entry.sequence > acceptedFromSequence && !signal.aborted) {
        publish(structuredClone(entry.payload));
      }
    }
    if (job.terminal) {
      queueMicrotask(() => this.releaseListener(job, listener));
    }
    return {
      acceptedFromSequence,
      close: () => this.releaseListener(job, listener),
    };
  }

  private async runJob(job: BuildJob): Promise<void> {
    try {
      const artifact = await this.execution.reconcileAndBuild(
        structuredClone(job.request),
        {
          report: (stage, progressPermille) => {
            if (job.controller.signal.aborted || job.terminal) return;
            this.publishProgress(
              job,
              stage,
              progressPermille,
              null,
              null,
            );
          },
        },
        job.controller.signal,
      );
      if (job.controller.signal.aborted || this.closed) {
        this.publishTerminal(job, 'cancelled', 0, 'cancelled');
        return;
      }
      const descriptor = validateSimulatorSubappHostArtifactDescriptorV1(
        artifact,
      );
      const graph = descriptor.artifact.build.graph;
      if (
        descriptor.projectIdentity !== this.projectIdentity
        || graph?.graphSemanticRevision !== job.request.sceneRevision
        || graph.sourceDocumentSchemaVersion !== job.request.sceneDocument.schemaVersion
      ) {
        this.publishTerminal(
          job,
          'failed',
          0,
          'artifact-staging-failed',
        );
        return;
      }
      if (currentStage(job) !== 'staging') {
        this.publishProgress(job, 'staging', 950, null, null);
      }
      this.publishProgress(job, 'completed', 1_000, descriptor, null);
    } catch (error) {
      if (job.terminal) return;
      if (job.controller.signal.aborted || this.closed) {
        this.publishTerminal(job, 'cancelled', 0, 'cancelled');
        return;
      }
      const errorCode = mapBuildFailure(error);
      this.publishTerminal(
        job,
        'failed',
        Math.min(currentProgress(job), 999),
        errorCode,
      );
    } finally {
      if (
        this.activeRequestId === job.request.requestId
        && this.jobs.get(job.request.requestId) === job
      ) {
        this.activeRequestId = null;
      }
    }
  }

  private publishTerminal(
    job: BuildJob,
    stage: 'failed' | 'cancelled',
    progressPermille: number,
    errorCode: SimulatorSubappHostBuildProgressErrorCode,
  ): void {
    if (job.terminal) return;
    this.publishProgress(job, stage, progressPermille, null, errorCode);
  }

  private publishProgress(
    job: BuildJob,
    stage: SimulatorSubappHostBuildProgressStage,
    progressPermille: number,
    artifact: SimulatorSubappHostArtifactDescriptorV1 | null,
    errorCode: SimulatorSubappHostBuildProgressErrorCode | null,
  ): void {
    if (job.terminal) return;
    requireProgress(stage, progressPermille, artifact, errorCode);
    const previousStage = currentStage(job);
    if (
      previousStage
      && previousStage !== stage
      && !ALLOWED_TRANSITIONS.get(previousStage)?.has(stage)
    ) {
      throw new SimulatorHostProviderOperationError(
        'operation-failed',
        `Invalid Build progress transition ${previousStage} -> ${stage}.`,
      );
    }
    if (progressPermille < currentProgress(job) && stage !== 'cancelled') {
      throw new SimulatorHostProviderOperationError(
        'operation-failed',
        'Build progress cannot move backwards.',
      );
    }
    const payload: SimulatorSubappHostBuildProgressV1 = {
      schemaVersion: 1,
      kind: 'aily-simulator-host-build-progress',
      requestId: job.request.requestId,
      projectIdentity: job.request.projectIdentity,
      sessionId: job.request.sessionId,
      sceneId: job.request.sceneId,
      sceneRevision: job.request.sceneRevision,
      baseArtifactRevision: job.request.baseArtifactRevision,
      stage,
      progressPermille,
      artifact: artifact ? structuredClone(artifact) : null,
      errorCode,
    };
    const entry = {
      sequence: job.progress.length + 1,
      payload,
    };
    job.progress.push(entry);
    if (TERMINAL_STAGES.has(stage)) job.terminal = true;
    for (const listener of [...job.listeners]) {
      if (listener.signal.aborted) {
        this.releaseListener(job, listener);
        continue;
      }
      listener.publish(structuredClone(payload));
    }
    if (job.terminal) {
      queueMicrotask(() => this.releaseListeners(job));
    }
  }

  private isExactScope(request: SceneArtifactRebuildRequest): boolean {
    return request.projectIdentity === this.projectIdentity
      && request.sceneId === this.sceneId;
  }

  private releaseListener(job: BuildJob, listener: ProgressListener): void {
    if (!job.listeners.delete(listener)) return;
    listener.signal.removeEventListener('abort', listener.abort);
  }

  private releaseListeners(job: BuildJob): void {
    for (const listener of [...job.listeners]) {
      this.releaseListener(job, listener);
    }
  }

  private pruneJobs(): void {
    while (this.jobs.size >= this.maxJobs) {
      const removable = [...this.jobs.entries()]
        .find(([, job]) => job.terminal && job.listeners.size === 0);
      if (!removable) {
        throw new SimulatorHostProviderOperationError('operation-failed');
      }
      this.jobs.delete(removable[0]);
    }
  }
}

function rebuildAck(
  request: SceneArtifactRebuildRequest,
  status: 'accepted' | 'rejected' | 'conflict',
  errorCode:
    | 'host-unavailable'
    | 'project-not-active'
    | 'request-superseded'
    | 'invalid-request'
    | null,
): SceneArtifactRebuildAck {
  return {
    schemaVersion: 1,
    kind: 'aily-scene-artifact-rebuild-ack',
    requestId: request.requestId,
    projectIdentity: request.projectIdentity,
    sessionId: request.sessionId,
    sceneId: request.sceneId,
    status,
    errorCode,
  };
}

function sameProgressScope(
  request: SceneArtifactRebuildRequest,
  subscription: SimulatorSubappHostBuildProgressSubscribeV1,
): boolean {
  return request.requestId === subscription.requestId
    && request.projectIdentity === subscription.projectIdentity
    && request.sessionId === subscription.sessionId
    && request.sceneId === subscription.sceneId
    && request.sceneRevision === subscription.sceneRevision
    && request.baseArtifactRevision === subscription.baseArtifactRevision;
}

function currentStage(
  job: BuildJob,
): SimulatorSubappHostBuildProgressStage | null {
  return job.progress.at(-1)?.payload.stage ?? null;
}

function currentProgress(job: BuildJob): number {
  return job.progress.at(-1)?.payload.progressPermille ?? 0;
}

function requireProgress(
  stage: SimulatorSubappHostBuildProgressStage,
  progressPermille: number,
  artifact: SimulatorSubappHostArtifactDescriptorV1 | null,
  errorCode: SimulatorSubappHostBuildProgressErrorCode | null,
): void {
  if (
    !Number.isSafeInteger(progressPermille)
    || progressPermille < 0
    || progressPermille > 1_000
  ) {
    throw new SimulatorHostProviderOperationError('operation-failed');
  }
  if (stage === 'completed') {
    if (progressPermille !== 1_000 || artifact === null || errorCode !== null) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    return;
  }
  if (stage === 'failed' || stage === 'cancelled') {
    if (artifact !== null || errorCode === null) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    return;
  }
  if (artifact !== null || errorCode !== null || progressPermille >= 1_000) {
    throw new SimulatorHostProviderOperationError('operation-failed');
  }
}

function mapBuildFailure(
  error: unknown,
): SimulatorSubappHostBuildProgressErrorCode {
  if (
    error
    && typeof error === 'object'
    && 'simulatorBuildErrorCode' in error
  ) {
    const code = (error as { simulatorBuildErrorCode?: unknown })
      .simulatorBuildErrorCode;
    if (
      code === 'request-rejected'
      || code === 'project-unavailable'
      || code === 'dependency-resolution-failed'
      || code === 'generation-failed'
      || code === 'compile-failed'
      || code === 'link-failed'
      || code === 'artifact-staging-failed'
      || code === 'cancelled'
      || code === 'host-failed'
    ) {
      return code;
    }
  }
  return 'host-failed';
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be in ${minimum}..${maximum}.`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Value is not serializable.');
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
