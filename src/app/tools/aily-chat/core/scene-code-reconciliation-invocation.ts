const PORTABLE_IDENTIFIER_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ABS_CONTENT_LENGTH = 1_000_000;
const MAX_SCENE_CONTEXT_LENGTH = 2_000_000;
const MAX_SUMMARY_LENGTH = 512;

export interface SceneCodeReconciliationInvocationInput {
  readonly request: Record<string, unknown>;
  readonly currentAbs: string;
}

export interface SceneCodeReconciliationCandidate {
  readonly schemaVersion: 1;
  readonly kind: 'aily-scene-code-reconciliation-agent-candidate';
  readonly requestId: string;
  readonly outcome: 'applied' | 'already-aligned';
  readonly summary: string;
  readonly candidateAbs: string | null;
  readonly agentRunId: string;
}

export interface SceneCodeReconciliationInvocationHandle {
  readonly requestId: string;
  readonly candidate: Promise<SceneCodeReconciliationCandidate>;
  reject(reason: unknown): void;
  dispose(): void;
}

interface PendingInvocation {
  readonly requestId: string;
  readonly context: SceneCodeReconciliationInvocationInput;
  readonly resolve: (candidate: SceneCodeReconciliationCandidate) => void;
  readonly reject: (reason: Error) => void;
  settled: boolean;
  contextRead: boolean;
  removeAbortListener?: () => void;
}

const pendingInvocations = new Map<string, PendingInvocation>();

export function beginSceneCodeReconciliationInvocation(
  input: SceneCodeReconciliationInvocationInput,
  signal?: AbortSignal,
): SceneCodeReconciliationInvocationHandle {
  const context = validateInvocationInput(input);
  const requestId = String(context.request['requestId']);
  if (pendingInvocations.has(requestId)) {
    throw new Error(
      `Scene code reconciliation invocation is already active: ${requestId}`,
    );
  }

  let resolvePromise!: (candidate: SceneCodeReconciliationCandidate) => void;
  let rejectPromise!: (reason: Error) => void;
  const candidate = new Promise<SceneCodeReconciliationCandidate>(
    (resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    },
  );
  void candidate.catch(() => undefined);
  const pending: PendingInvocation = {
    requestId,
    context,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
    contextRead: false,
  };
  if (signal) {
    const onAbort = () => rejectInvocation(
      pending,
      signal.reason
        ?? new Error('Scene code reconciliation invocation was cancelled.'),
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
      pending.removeAbortListener =
        () => signal.removeEventListener('abort', onAbort);
    }
  }
  if (!pending.settled) {
    pendingInvocations.set(requestId, pending);
  }
  return Object.freeze({
    requestId,
    candidate,
    reject: reason => rejectInvocation(pending, reason),
    dispose: () => disposeInvocation(pending),
  });
}

export function consumeSceneCodeReconciliationInvocationContext(
  requestId: unknown,
): SceneCodeReconciliationInvocationInput {
  const normalizedRequestId = requirePortableIdentifier(
    requestId,
    'requestId',
  );
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error(
      'No matching Scene code reconciliation invocation is active.',
    );
  }
  if (pending.contextRead) {
    throw new Error(
      'Scene code reconciliation context was already read.',
    );
  }
  pending.contextRead = true;
  return structuredClone(pending.context);
}

export function readSceneCodeReconciliationInvocation(
  requestId: unknown,
): SceneCodeReconciliationInvocationInput {
  const normalizedRequestId = requirePortableIdentifier(
    requestId,
    'requestId',
  );
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error(
      'No matching Scene code reconciliation invocation is active.',
    );
  }
  return structuredClone(pending.context);
}

export function submitSceneCodeReconciliationInvocation(
  requestId: unknown,
  candidate: SceneCodeReconciliationCandidate,
): void {
  const normalizedRequestId = requirePortableIdentifier(
    requestId,
    'requestId',
  );
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error(
      'No matching Scene code reconciliation invocation is active.',
    );
  }
  if (!pending.contextRead) {
    throw new Error(
      'Scene code reconciliation context must be read before submission.',
    );
  }
  const normalized = validateCandidate(candidate);
  if (normalized.requestId !== pending.requestId) {
    throw new Error(
      'Scene code reconciliation candidate does not match its invocation.',
    );
  }
  if (
    normalized.outcome === 'already-aligned'
    && normalized.candidateAbs !== null
  ) {
    throw new Error(
      'An already-aligned candidate cannot replace the current ABS.',
    );
  }
  if (
    normalized.outcome === 'applied'
    && (
      normalized.candidateAbs === null
      || normalizeAbs(normalized.candidateAbs)
        === normalizeAbs(pending.context.currentAbs)
    )
  ) {
    throw new Error(
      'An applied candidate must contain a changed ABS program.',
    );
  }
  settleInvocation(
    pending,
    () => pending.resolve(structuredClone(normalized)),
  );
}

export function resetSceneCodeReconciliationInvocationsForTest(): void {
  for (const pending of [...pendingInvocations.values()]) {
    rejectInvocation(
      pending,
      new Error('Scene code reconciliation invocation registry reset.'),
    );
  }
  pendingInvocations.clear();
}

function validateInvocationInput(
  value: SceneCodeReconciliationInvocationInput,
): SceneCodeReconciliationInvocationInput {
  const input = requireRecord(value, 'Scene code reconciliation invocation');
  requireExactKeys(
    input,
    ['request', 'currentAbs'],
    'Scene code reconciliation invocation',
  );
  const request = requireRecord(input['request'], 'request');
  requireExactKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'graphSemanticRevision',
    'sceneDocument',
  ], 'request');
  if (
    request['schemaVersion'] !== 1
    || request['kind']
      !== 'aily-simulator-scene-code-reconciliation-request'
  ) {
    throw new TypeError('Scene code reconciliation request is invalid.');
  }
  const requestId = requirePortableIdentifier(
    request['requestId'],
    'request.requestId',
  );
  const sceneId = requirePortableIdentifier(
    request['sceneId'],
    'request.sceneId',
  );
  requirePortableIdentifier(
    request['projectIdentity'],
    'request.projectIdentity',
  );
  const graphSemanticRevision = requireSha256(
    request['graphSemanticRevision'],
    'request.graphSemanticRevision',
  );
  const sceneDocument = requireRecord(
    request['sceneDocument'],
    'request.sceneDocument',
  );
  if (
    sceneDocument['sceneId'] !== sceneId
    || sceneDocument['graphSemanticRevision'] !== graphSemanticRevision
  ) {
    throw new TypeError(
      'Scene code reconciliation document scope is invalid.',
    );
  }
  const sceneContext = JSON.stringify(sceneDocument);
  if (sceneContext.length > MAX_SCENE_CONTEXT_LENGTH) {
    throw new TypeError('Scene code reconciliation document is too large.');
  }
  const currentAbs = requireAbsContent(input['currentAbs'], 'currentAbs');
  return structuredClone({
    request: {
      ...request,
      requestId,
      sceneId,
      graphSemanticRevision,
      sceneDocument,
    },
    currentAbs,
  });
}

function validateCandidate(
  value: SceneCodeReconciliationCandidate,
): SceneCodeReconciliationCandidate {
  const candidate = requireRecord(
    value,
    'Scene code reconciliation candidate',
  );
  requireExactKeys(candidate, [
    'schemaVersion',
    'kind',
    'requestId',
    'outcome',
    'summary',
    'candidateAbs',
    'agentRunId',
  ], 'Scene code reconciliation candidate');
  if (
    candidate['schemaVersion'] !== 1
    || candidate['kind']
      !== 'aily-scene-code-reconciliation-agent-candidate'
  ) {
    throw new TypeError('Scene code reconciliation candidate is invalid.');
  }
  const outcome = candidate['outcome'];
  if (outcome !== 'applied' && outcome !== 'already-aligned') {
    throw new TypeError(
      'Scene code reconciliation candidate outcome is invalid.',
    );
  }
  const candidateAbs = candidate['candidateAbs'] === null
    ? null
    : requireAbsContent(candidate['candidateAbs'], 'candidateAbs');
  return {
    schemaVersion: 1,
    kind: 'aily-scene-code-reconciliation-agent-candidate',
    requestId: requirePortableIdentifier(
      candidate['requestId'],
      'requestId',
    ),
    outcome,
    summary: requireText(
      candidate['summary'],
      MAX_SUMMARY_LENGTH,
      'summary',
    ),
    candidateAbs,
    agentRunId: requirePortableIdentifier(
      candidate['agentRunId'],
      'agentRunId',
    ),
  };
}

function rejectInvocation(
  pending: PendingInvocation,
  reason: unknown,
): void {
  settleInvocation(
    pending,
    () => pending.reject(
      reason instanceof Error ? reason : new Error(String(reason)),
    ),
  );
}

function disposeInvocation(pending: PendingInvocation): void {
  if (!pending.settled) {
    rejectInvocation(
      pending,
      new Error(
        'Scene code reconciliation invocation ended without a candidate.',
      ),
    );
  }
  if (pendingInvocations.get(pending.requestId) === pending) {
    pendingInvocations.delete(pending.requestId);
  }
}

function settleInvocation(
  pending: PendingInvocation,
  settle: () => void,
): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.removeAbortListener?.();
  if (pendingInvocations.get(pending.requestId) === pending) {
    pendingInvocations.delete(pending.requestId);
  }
  settle();
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

function requireText(
  value: unknown,
  maximumLength: number,
  label: string,
): string {
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || value.length > maximumLength
  ) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.trim();
}

function requireAbsContent(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || value.length > MAX_ABS_CONTENT_LENGTH
  ) {
    throw new TypeError(`${label} must contain a bounded ABS program.`);
  }
  return value;
}

function normalizeAbs(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trimEnd();
}
