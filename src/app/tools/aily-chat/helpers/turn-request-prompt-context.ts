import type {
  SessionSnapshot,
  TurnRequest,
} from 'aily-lex/browser';

type SessionRequestContextSnapshot = NonNullable<SessionSnapshot['requestContext']>;

export const REQUEST_CONTEXT_SNAPSHOT_METADATA_KEY = 'requestContextSnapshot';

export interface TurnRequestPromptContextSnapshot {
  readonly requestContext?: SessionRequestContextSnapshot;
}

export interface PromptContextSnapshotSource {
  readonly getSessionSnapshot?: () => SessionSnapshot | null;
}

export function captureTurnRequestPromptContextSnapshot(
  source: PromptContextSnapshotSource,
): TurnRequestPromptContextSnapshot | undefined {
  const sessionSnapshot = source.getSessionSnapshot?.() ?? null;
  const requestContext = cloneSessionRequestContextSnapshot(sessionSnapshot?.requestContext);

  if (!requestContext) {
    return undefined;
  }

  return {
    ...(requestContext ? { requestContext } : {}),
  };
}

export function applyTurnRequestPromptContextSnapshot(
  metadata: TurnRequest['metadata'] | undefined,
  snapshot: TurnRequestPromptContextSnapshot | undefined,
): TurnRequest['metadata'] | undefined {
  if (!snapshot) {
    return metadata;
  }

  const requestContext = cloneSessionRequestContextSnapshot(snapshot.requestContext);

  return {
    ...(metadata ?? {}),
    ...(requestContext ? { [REQUEST_CONTEXT_SNAPSHOT_METADATA_KEY]: requestContext } : {}),
  };
}

export function readTurnRequestPromptContextSnapshot(
  metadata: TurnRequest['metadata'] | Record<string, unknown> | undefined,
): TurnRequestPromptContextSnapshot | undefined {
  const record = asRecord(metadata);
  if (!record) {
    return undefined;
  }

  const requestContext = cloneSessionRequestContextSnapshot(
    asSessionRequestContextSnapshot(record[REQUEST_CONTEXT_SNAPSHOT_METADATA_KEY]),
  );

  if (!requestContext) {
    return undefined;
  }

  return {
    ...(requestContext ? { requestContext } : {}),
  };
}

export function cloneSessionRequestContextSnapshot(
  snapshot: SessionRequestContextSnapshot | undefined,
): SessionRequestContextSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  const directToolReferences = Array.isArray(snapshot.directToolReferences) && snapshot.directToolReferences.length > 0
    ? snapshot.directToolReferences
      .filter(reference => typeof reference?.toolName === 'string' && reference.toolName.trim().length > 0)
      .map(reference => ({
        toolName: reference.toolName.trim(),
        source: reference.source,
        ...(typeof reference.query === 'string' && reference.query.trim().length > 0
          ? { query: reference.query.trim() }
          : {}),
      }))
    : undefined;
  const interactionContinuation = cloneInteractionContinuation(snapshot.interactionContinuation);
  const requestId = typeof snapshot.requestId === 'string' && snapshot.requestId.trim().length > 0
    ? snapshot.requestId.trim()
    : undefined;
  const requestedSkillNames = normalizeSkillNames(snapshot.requestedSkillNames ?? []);

  if (!directToolReferences && !interactionContinuation && !requestId && requestedSkillNames.length === 0) {
    return undefined;
  }

  return {
    ...(directToolReferences ? { directToolReferences } : {}),
    ...(interactionContinuation ? { interactionContinuation } : {}),
    ...(requestId ? { requestId } : {}),
    ...(requestedSkillNames.length > 0 ? { requestedSkillNames } : {}),
  };
}

function asSessionRequestContextSnapshot(value: unknown): SessionRequestContextSnapshot | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SessionRequestContextSnapshot
    : undefined;
}

function cloneInteractionContinuation(
  continuation: SessionRequestContextSnapshot['interactionContinuation'],
): SessionRequestContextSnapshot['interactionContinuation'] {
  if (!continuation) {
    return undefined;
  }
  const pendingState = continuation.pendingState
    ? { ...continuation.pendingState }
    : undefined;

  if (isTerminalCompletedContinuation(continuation, pendingState)) {
    return undefined;
  }

  return {
    interactionId: continuation.interactionId,
    stepIndex: continuation.stepIndex,
    lease: continuation.lease,
    ...(continuation.status ? { status: continuation.status } : {}),
    ...(continuation.stopReason ? { stopReason: continuation.stopReason } : {}),
    ...(continuation.hardStopReason !== undefined ? { hardStopReason: continuation.hardStopReason } : {}),
    ...(pendingState ? { pendingState } : {}),
    ...(continuation.budgets && typeof continuation.budgets === 'object'
      ? { budgets: { ...continuation.budgets } }
      : {}),
    ...(continuation.diagnostics && typeof continuation.diagnostics === 'object'
      ? { diagnostics: cloneUnknownRecord(continuation.diagnostics as Record<string, unknown>) }
      : {}),
  };
}

function isTerminalCompletedContinuation(
  continuation: NonNullable<SessionRequestContextSnapshot['interactionContinuation']>,
  pendingState: Record<string, unknown> | undefined,
): boolean {
  const stopReason = typeof continuation.stopReason === 'string'
    ? continuation.stopReason
    : undefined;
  const status = typeof continuation.status === 'string'
    ? continuation.status
    : undefined;
  const pendingKind = typeof pendingState?.['kind'] === 'string'
    ? pendingState['kind']
    : undefined;

  if (pendingKind && pendingKind !== 'none') {
    return false;
  }

  if (typeof continuation.hardStopReason === 'string' && continuation.hardStopReason.startsWith('interaction_')) {
    return true;
  }

  return stopReason === 'COMPLETED'
    || status === 'completed'
    || status === 'complete';
}

function normalizeSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      names.add(entry.trim());
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function cloneUnknownRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, cloneUnknownValue(entryValue)]),
  );
}

function cloneUnknownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => cloneUnknownValue(item));
  }

  if (value && typeof value === 'object') {
    return cloneUnknownRecord(value as Record<string, unknown>);
  }

  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
