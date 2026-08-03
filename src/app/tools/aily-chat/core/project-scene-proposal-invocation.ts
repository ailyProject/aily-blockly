export interface ProjectSceneProposalInvocationInput {
  readonly request: Record<string, unknown>;
  readonly hardwareIntent: Record<string, unknown>;
}

export interface ProjectSceneProposalInvocationHandle {
  readonly requestId: string;
  readonly proposal: Promise<Record<string, unknown>>;
  reject(reason: unknown): void;
  dispose(): void;
}

interface PendingInvocation {
  readonly requestId: string;
  readonly context: ProjectSceneProposalInvocationInput;
  readonly resolve: (proposal: Record<string, unknown>) => void;
  readonly reject: (reason: Error) => void;
  settled: boolean;
  contextRead: boolean;
  removeAbortListener?: () => void;
}

const pendingInvocations = new Map<string, PendingInvocation>();

export function beginProjectSceneProposalInvocation(
  input: ProjectSceneProposalInvocationInput,
  signal?: AbortSignal,
): ProjectSceneProposalInvocationHandle {
  const context = validateInvocationInput(input);
  const requestId = String(context.request['requestId']);
  if (pendingInvocations.has(requestId)) {
    throw new Error(`Project Scene proposal invocation is already active: ${requestId}`);
  }
  let resolvePromise!: (proposal: Record<string, unknown>) => void;
  let rejectPromise!: (reason: Error) => void;
  const proposal = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A provider may reject before its caller starts awaiting the proposal.
  // Keep the rejection observed while preserving the original promise result.
  void proposal.catch(() => undefined);
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
      signal.reason ?? new Error('Project Scene proposal invocation was cancelled.'),
    );
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      pending.removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
  }
  if (!pending.settled) pendingInvocations.set(requestId, pending);
  return Object.freeze({
    requestId,
    proposal,
    reject: (reason) => rejectInvocation(pending, reason),
    dispose: () => disposeInvocation(pending),
  });
}

export function readProjectSceneProposalInvocation(
  requestId: unknown,
): ProjectSceneProposalInvocationInput {
  const normalizedRequestId = portableIdentifier(requestId, 'requestId');
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error('No matching Project Scene proposal invocation is active.');
  }
  return structuredClone(pending.context);
}

export function consumeProjectSceneProposalInvocationContext(
  requestId: unknown,
): ProjectSceneProposalInvocationInput {
  const normalizedRequestId = portableIdentifier(requestId, 'requestId');
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error('No matching Project Scene proposal invocation is active.');
  }
  if (pending.contextRead) {
    throw new Error('Project Scene proposal generation context was already read.');
  }
  pending.contextRead = true;
  return structuredClone(pending.context);
}

export function submitProjectSceneProposalInvocation(
  requestId: unknown,
  proposal: Record<string, unknown>,
): void {
  const normalizedRequestId = portableIdentifier(requestId, 'requestId');
  const pending = pendingInvocations.get(normalizedRequestId);
  if (!pending || pending.settled) {
    throw new Error('No matching Project Scene proposal invocation is active.');
  }
  if (!pending.contextRead) {
    throw new Error('Project Scene proposal generation context must be read before submission.');
  }
  const proposalRecord = record(proposal, 'proposal');
  const target = record(proposalRecord['target'], 'proposal.target');
  if (
    proposalRecord['schemaVersion'] !== 1
    || proposalRecord['kind'] !== 'aily-agent-scene-change-proposal'
    || target['projectIdentity'] !== pending.context.request['projectIdentity']
    || target['sceneId'] !== pending.context.request['sceneId']
  ) {
    throw new Error('Project Scene proposal does not match its active invocation.');
  }
  settleInvocation(pending, () => pending.resolve(structuredClone(proposalRecord)));
}

export function resetProjectSceneProposalInvocationsForTest(): void {
  for (const pending of [...pendingInvocations.values()]) {
    rejectInvocation(pending, new Error('Project Scene proposal invocation registry reset.'));
  }
  pendingInvocations.clear();
}

function validateInvocationInput(
  value: ProjectSceneProposalInvocationInput,
): ProjectSceneProposalInvocationInput {
  const input = record(value, 'Project Scene proposal invocation');
  exactKeys(input, ['request', 'hardwareIntent'], 'Project Scene proposal invocation');
  const request = record(input['request'], 'request');
  const hardwareIntent = record(input['hardwareIntent'], 'hardwareIntent');
  exactKeys(request, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'sceneId',
    'reason',
    'base',
    'legacySource',
    'expiresAtUnixMs',
  ], 'request');
  exactKeys(hardwareIntent, [
    'schemaVersion',
    'kind',
    'requestId',
    'projectIdentity',
    'board',
    'source',
    'libraries',
    'hardwareHints',
    'userIntent',
  ], 'hardwareIntent');
  const requestId = portableIdentifier(request['requestId'], 'request.requestId');
  const projectIdentity = portableIdentifier(
    request['projectIdentity'],
    'request.projectIdentity',
  );
  if (
    request['schemaVersion'] !== 1
    || request['kind'] !== 'aily-project-scene-generation-request'
    || hardwareIntent['schemaVersion'] !== 1
    || hardwareIntent['kind'] !== 'aily-project-hardware-intent-snapshot'
    || hardwareIntent['requestId'] !== requestId
    || hardwareIntent['projectIdentity'] !== projectIdentity
  ) {
    throw new Error('Project Scene proposal invocation identities do not match.');
  }
  portableIdentifier(request['sceneId'], 'request.sceneId');
  if (!['missing-scene', 'legacy-detected', 'user-regenerate'].includes(String(request['reason']))) {
    throw new Error('Project Scene proposal invocation reason is unsupported.');
  }
  if (!Array.isArray(hardwareIntent['libraries']) || !Array.isArray(hardwareIntent['hardwareHints'])) {
    throw new Error('Project Scene hardware intent collections are invalid.');
  }
  return structuredClone({ request, hardwareIntent });
}

function rejectInvocation(pending: PendingInvocation, reason: unknown): void {
  settleInvocation(pending, () => pending.reject(
    reason instanceof Error ? reason : new Error(String(reason)),
  ));
}

function disposeInvocation(pending: PendingInvocation): void {
  if (!pending.settled) {
    rejectInvocation(pending, new Error('Project Scene proposal invocation ended without a proposal.'));
  }
  if (pendingInvocations.get(pending.requestId) === pending) {
    pendingInvocations.delete(pending.requestId);
  }
}

function settleInvocation(pending: PendingInvocation, settle: () => void): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.removeAbortListener?.();
  if (pendingInvocations.get(pending.requestId) === pending) {
    pendingInvocations.delete(pending.requestId);
  }
  settle();
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function portableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} must be a portable identifier.`);
  }
  return value;
}
