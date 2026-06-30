import type { HostSessionRecord, PersistedHostTurnResponse } from '../services/chat-history.service';

export interface HostSessionInteractionActionSummary {
  readonly kind: string;
  readonly result?: string;
  readonly actionId?: string;
  readonly feedback?: string;
  readonly sourceEvent?: string;
}

interface HostSessionInteractionActionSnapshot {
  readonly kind: string;
  readonly result?: string;
  readonly actionId?: string;
  readonly feedback?: string;
  readonly sourceEvent?: string;
}

export function normalizeHostSessionInteractionActionSummary(
  value: {
    readonly kind?: unknown;
    readonly result?: unknown;
    readonly actionId?: unknown;
    readonly feedback?: unknown;
    readonly sourceEvent?: unknown;
  } | undefined,
): HostSessionInteractionActionSummary | undefined {
  const kind = readNonEmptyString(value?.kind);
  if (!kind) {
    return undefined;
  }

  const result = readNonEmptyString(value?.result);
  const actionId = readNonEmptyString(value?.actionId);
  const feedback = readNonEmptyString(value?.feedback);
  const sourceEvent = readNonEmptyString(value?.sourceEvent);

  return {
    kind,
    ...(result ? { result } : {}),
    ...(actionId ? { actionId } : {}),
    ...(feedback ? { feedback } : {}),
    ...(sourceEvent ? { sourceEvent } : {}),
  };
}

export function resolveHostSessionInteractionActionSummary(
  record: Pick<HostSessionRecord, 'metadata' | 'turnResponses'>,
): HostSessionInteractionActionSummary | undefined {
  const metadataSnapshot = readMetadataInteractionAction(record);
  const turnSnapshot = resolveLatestTurnInteractionAction(record.turnResponses);

  if (!turnSnapshot) {
    return metadataSnapshot;
  }

  return normalizeHostSessionInteractionActionSummary({
    kind: turnSnapshot.kind,
    result: turnSnapshot.result ?? metadataSnapshot?.result,
    actionId: turnSnapshot.actionId ?? metadataSnapshot?.actionId,
    feedback: turnSnapshot.feedback ?? metadataSnapshot?.feedback,
    sourceEvent: turnSnapshot.sourceEvent ?? metadataSnapshot?.sourceEvent,
  });
}

function resolveLatestTurnInteractionAction(
  turnResponses: readonly PersistedHostTurnResponse[] | undefined,
): HostSessionInteractionActionSnapshot | undefined {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return undefined;
  }

  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const snapshot = readTurnInteractionAction(turnResponses[index]);
    if (snapshot) {
      return snapshot;
    }
  }

  return undefined;
}

function readTurnInteractionAction(
  turnResponse: PersistedHostTurnResponse | undefined,
): HostSessionInteractionActionSnapshot | undefined {
  const topLevelAction = normalizeHostSessionInteractionActionSummary(turnResponse?.handoffAction);
  if (topLevelAction) {
    return topLevelAction;
  }

  const metadata = asRecord(turnResponse?.request?.metadata);
  const interactionAction = asRecord(metadata?.['interactionAction']);
  if (!interactionAction) {
    return undefined;
  }

  return toSnapshot(interactionAction);
}

function readMetadataInteractionAction(
  record: Pick<HostSessionRecord, 'metadata'>,
): HostSessionInteractionActionSummary | undefined {
  return normalizeHostSessionInteractionActionSummary(asRecord(record.metadata.interactionActionSummary));
}

function toSnapshot(action: Record<string, unknown>): HostSessionInteractionActionSnapshot | undefined {
  const payload = asRecord(action['payload']);
  return normalizeHostSessionInteractionActionSummary({
    kind: action['kind'],
    result: payload?.['result'] ?? action['result'],
    actionId: payload?.['actionId'] ?? action['actionId'],
    feedback: payload?.['feedback'] ?? action['feedback'],
    sourceEvent: payload?.['sourceEvent'] ?? action['sourceEvent'],
  });
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
