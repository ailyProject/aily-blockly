import type {
  SceneArtifactRebuildRequest,
} from '@aily-project/simulator-host-sdk';

const DEFAULT_MAX_PENDING_REQUESTS = 8;
const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

export interface SimulatorSceneCodeReconciliationRequest {
  readonly schemaVersion: 1;
  readonly kind: 'aily-simulator-scene-code-reconciliation-request';
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly graphSemanticRevision: string;
  readonly sceneDocument: SceneArtifactRebuildRequest['sceneDocument'];
}

export interface SimulatorSceneCodeReconciliationResult {
  readonly schemaVersion: 1;
  readonly kind: 'aily-simulator-scene-code-reconciliation-result';
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly sceneId: string;
  readonly graphSemanticRevision: string;
  readonly decision: 'approved' | 'rejected';
  readonly outcome: 'applied' | 'already-aligned' | 'rejected';
  readonly approvalId: string;
  readonly agentRunId: string | null;
}

export interface SimulatorSceneCodeReconciliationPort {
  reconcile(
    request: SimulatorSceneCodeReconciliationRequest,
    signal: AbortSignal,
  ): Promise<SimulatorSceneCodeReconciliationResult>;
}

export interface SimulatorSceneCodeReconciliationCoordinatorOptions {
  present(
    request: SimulatorSceneCodeReconciliationRequest,
    signal: AbortSignal,
  ): void | Promise<void>;
  maxPendingRequests?: number;
}

interface PendingReconciliation {
  readonly request: SimulatorSceneCodeReconciliationRequest;
  readonly digest: string;
  readonly signal: AbortSignal;
  readonly promise: Promise<SimulatorSceneCodeReconciliationResult>;
  readonly resolve: (result: SimulatorSceneCodeReconciliationResult) => void;
  readonly reject: (error: Error) => void;
  readonly abort: () => void;
  settled: boolean;
}

/**
 * Awaitable product boundary between a Build request and the Host's Agent/UI.
 *
 * `present` may open a product UI, but that action never counts as approval.
 * The request remains pending until the product calls `complete` with an
 * exact-scope, explicit decision or calls `fail`.
 */
export class SimulatorSceneCodeReconciliationCoordinator
implements SimulatorSceneCodeReconciliationPort {
  private readonly present: SimulatorSceneCodeReconciliationCoordinatorOptions['present'];
  private readonly maxPendingRequests: number;
  private readonly pending = new Map<string, PendingReconciliation>();
  private closed = false;

  constructor(options: SimulatorSceneCodeReconciliationCoordinatorOptions) {
    if (!options || typeof options.present !== 'function') {
      throw new TypeError('Scene code reconciliation presenter is required.');
    }
    this.present = options.present;
    this.maxPendingRequests = requireIntegerInRange(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      1,
      64,
      'maxPendingRequests',
    );
  }

  snapshot(): Readonly<{
    closed: boolean;
    pendingRequestIds: readonly string[];
  }> {
    return Object.freeze({
      closed: this.closed,
      pendingRequestIds: Object.freeze([...this.pending.keys()]),
    });
  }

  async reconcile(
    request: SimulatorSceneCodeReconciliationRequest,
    signal: AbortSignal,
  ): Promise<SimulatorSceneCodeReconciliationResult> {
    if (this.closed) {
      throw new Error('Scene code reconciliation coordinator is closed.');
    }
    throwIfAborted(signal);
    const normalized = validateRequest(request);
    const digest = stableJson(normalized);
    const remembered = this.pending.get(normalized.requestId);
    if (remembered) {
      if (remembered.digest !== digest) {
        throw new Error('Scene code reconciliation requestId is already in use.');
      }
      return remembered.promise;
    }
    if (this.pending.size >= this.maxPendingRequests) {
      throw new Error('Scene code reconciliation capacity is exhausted.');
    }

    let resolvePromise!: (
      result: SimulatorSceneCodeReconciliationResult,
    ) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<SimulatorSceneCodeReconciliationResult>(
      (resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      },
    );
    void promise.catch(() => undefined);
    const pending: PendingReconciliation = {
      request: normalized,
      digest,
      signal,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      abort: () => this.rejectPending(
        pending,
        abortReason(signal),
      ),
      settled: false,
    };
    this.pending.set(normalized.requestId, pending);
    signal.addEventListener('abort', pending.abort, { once: true });

    try {
      await this.present(structuredClone(normalized), signal);
    } catch (error) {
      this.rejectPending(pending, normalizeError(error));
    }
    return promise;
  }

  complete(result: SimulatorSceneCodeReconciliationResult): void {
    const normalized = validateResult(result);
    const pending = this.pending.get(normalized.requestId);
    if (!pending || pending.settled) {
      throw new Error('No matching Scene code reconciliation request is active.');
    }
    if (
      normalized.projectIdentity !== pending.request.projectIdentity
      || normalized.sceneId !== pending.request.sceneId
      || normalized.graphSemanticRevision
        !== pending.request.graphSemanticRevision
    ) {
      throw new Error('Scene code reconciliation result scope does not match.');
    }
    this.settlePending(
      pending,
      () => pending.resolve(structuredClone(normalized)),
    );
  }

  fail(requestId: unknown, reason: unknown): void {
    const normalizedRequestId = requirePortableIdentifier(
      requestId,
      'requestId',
    );
    const pending = this.pending.get(normalizedRequestId);
    if (!pending || pending.settled) {
      throw new Error('No matching Scene code reconciliation request is active.');
    }
    this.rejectPending(pending, normalizeError(reason));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(
        pending,
        new Error('Scene code reconciliation coordinator is closed.'),
      );
    }
  }

  private rejectPending(
    pending: PendingReconciliation,
    error: Error,
  ): void {
    this.settlePending(pending, () => pending.reject(error));
  }

  private settlePending(
    pending: PendingReconciliation,
    settle: () => void,
  ): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.signal.removeEventListener('abort', pending.abort);
    if (this.pending.get(pending.request.requestId) === pending) {
      this.pending.delete(pending.request.requestId);
    }
    settle();
  }
}

function validateRequest(
  value: SimulatorSceneCodeReconciliationRequest,
): SimulatorSceneCodeReconciliationRequest {
  const request = requireRecord(value, 'Scene code reconciliation request');
  requireExactKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'graphSemanticRevision',
    'sceneDocument',
  ], 'Scene code reconciliation request');
  if (
    request['schemaVersion'] !== 1
    || request['kind']
      !== 'aily-simulator-scene-code-reconciliation-request'
  ) {
    throw new TypeError('Scene code reconciliation request is invalid.');
  }
  const graphSemanticRevision = requireSha256(
    request['graphSemanticRevision'],
    'graphSemanticRevision',
  );
  const sceneDocument = requireRecord(
    request['sceneDocument'],
    'sceneDocument',
  ) as unknown as SceneArtifactRebuildRequest['sceneDocument'];
  if (
    sceneDocument.sceneId !== request['sceneId']
    || sceneDocument.graphSemanticRevision !== graphSemanticRevision
  ) {
    throw new TypeError('Scene code reconciliation document scope is invalid.');
  }
  return structuredClone({
    schemaVersion: 1,
    kind: 'aily-simulator-scene-code-reconciliation-request',
    requestId: requirePortableIdentifier(request['requestId'], 'requestId'),
    projectIdentity: requirePortableIdentifier(
      request['projectIdentity'],
      'projectIdentity',
    ),
    sceneId: requirePortableIdentifier(request['sceneId'], 'sceneId'),
    graphSemanticRevision,
    sceneDocument,
  });
}

function validateResult(
  value: SimulatorSceneCodeReconciliationResult,
): SimulatorSceneCodeReconciliationResult {
  const result = requireRecord(value, 'Scene code reconciliation result');
  requireExactKeys(result, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'graphSemanticRevision',
    'decision',
    'outcome',
    'approvalId',
    'agentRunId',
  ], 'Scene code reconciliation result');
  if (
    result['schemaVersion'] !== 1
    || result['kind'] !== 'aily-simulator-scene-code-reconciliation-result'
  ) {
    throw new TypeError('Scene code reconciliation result is invalid.');
  }
  const decision = result['decision'];
  const outcome = result['outcome'];
  if (
    (decision !== 'approved' && decision !== 'rejected')
    || (
      outcome !== 'applied'
      && outcome !== 'already-aligned'
      && outcome !== 'rejected'
    )
    || (decision === 'rejected') !== (outcome === 'rejected')
  ) {
    throw new TypeError(
      'Scene code reconciliation decision and outcome are inconsistent.',
    );
  }
  const agentRunId = result['agentRunId'] === null
    ? null
    : requirePortableIdentifier(result['agentRunId'], 'agentRunId');
  if (decision === 'approved' && agentRunId === null) {
    throw new TypeError(
      'Approved Scene code reconciliation requires an Agent run.',
    );
  }
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-scene-code-reconciliation-result',
    requestId: requirePortableIdentifier(result['requestId'], 'requestId'),
    projectIdentity: requirePortableIdentifier(
      result['projectIdentity'],
      'projectIdentity',
    ),
    sceneId: requirePortableIdentifier(result['sceneId'], 'sceneId'),
    graphSemanticRevision: requireSha256(
      result['graphSemanticRevision'],
      'graphSemanticRevision',
    ),
    decision,
    outcome,
    approvalId: requirePortableIdentifier(
      result['approvalId'],
      'approvalId',
    ),
    agentRunId,
  };
}

function requireRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label} contains unsupported fields.`);
  }
}

function requirePortableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !PORTABLE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier.`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 value.`);
  }
  return value;
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Scene code reconciliation was cancelled.');
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
