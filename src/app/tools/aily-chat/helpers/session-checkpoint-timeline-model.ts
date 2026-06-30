import type { TurnResponseTurn } from 'aily-lex/browser';
import type { RequestCheckpointMetadata } from '../services/edit-checkpoint.service';

export interface SessionCheckpointTimelineEntry {
  readonly checkpointId: string;
  readonly requestId: string;
  readonly turnId?: string;
  readonly turnIndex: number;
  readonly metadata?: RequestCheckpointMetadata;
}

export interface SessionCheckpointTimelineState {
  readonly sessionResource: string;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly checkpoints: readonly SessionCheckpointTimelineEntry[];
  readonly currentCheckpointIndex: number;
  readonly currentTurnResponseCount: number;
}

export interface SessionCheckpointTimelineCreateOptions {
  readonly sessionResource: string;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly currentCheckpointIndex?: number;
  readonly currentTurnResponseCount?: number;
  readonly metadataByCheckpointId?: ReadonlyMap<string, RequestCheckpointMetadata> | null;
  readonly metadataByRequestId?: ReadonlyMap<string, RequestCheckpointMetadata> | null;
  readonly metadataByTurnId?: ReadonlyMap<string, RequestCheckpointMetadata> | null;
}

export function createSessionCheckpointTimelineState(
  options: SessionCheckpointTimelineCreateOptions,
): SessionCheckpointTimelineState {
  const sessionResource = normalizeSessionResource(options.sessionResource);
  const turnResponses = cloneTurnResponses(options.turnResponses);
  const checkpoints = turnResponses.flatMap((turn, turnIndex) => {
    const requestMetadata = readTurnRequestMetadata(turn);
    const metadata = resolveTurnCheckpointMetadata(turn, requestMetadata, options);
    const checkpointId = normalizeSessionResource(readMetadataString(requestMetadata, 'checkpointId'))
      || normalizeSessionResource(metadata?.checkpointId);
    if (!checkpointId) {
      return [];
    }

    const resolvedMetadata = metadata ?? options.metadataByCheckpointId?.get(checkpointId);
    const requestId = normalizeSessionResource(resolvedMetadata?.requestId)
      || normalizeSessionResource(readMetadataString(requestMetadata, 'requestId'))
      || normalizeSessionResource(turn.turnId)
      || checkpointId;

    return [{
      checkpointId,
      requestId,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      turnIndex,
      ...(resolvedMetadata ? { metadata: cloneRequestCheckpointMetadata(resolvedMetadata) } : {}),
    }];
  });

  const lastIndex = checkpoints.length - 1;
  const currentCheckpointIndex = normalizeCheckpointIndex(
    options.currentCheckpointIndex,
    lastIndex,
  );
  const currentTurnResponseCount = normalizeVisibleTurnResponseCount(
    options.currentTurnResponseCount,
    turnResponses.length,
    resolveVisibleTurnResponseCountFromCheckpointIndex(checkpoints, currentCheckpointIndex),
  );

  return {
    sessionResource,
    turnResponses,
    checkpoints,
    currentCheckpointIndex,
    currentTurnResponseCount,
  };
}

export function cloneSessionCheckpointTimelineState(
  state: SessionCheckpointTimelineState | null | undefined,
): SessionCheckpointTimelineState | null {
  if (!state) {
    return null;
  }

  return {
    sessionResource: state.sessionResource,
    turnResponses: cloneTurnResponses(state.turnResponses),
    checkpoints: state.checkpoints.map(checkpoint => ({
      ...checkpoint,
      ...(checkpoint.metadata ? { metadata: cloneRequestCheckpointMetadata(checkpoint.metadata) } : {}),
    })),
    currentCheckpointIndex: state.currentCheckpointIndex,
    currentTurnResponseCount: normalizeVisibleTurnResponseCount(
      state.currentTurnResponseCount,
      state.turnResponses.length,
      resolveVisibleTurnResponseCountFromCheckpointIndex(state.checkpoints, state.currentCheckpointIndex),
    ),
  };
}

export function restoreSessionCheckpointTimelineToCheckpoint(
  state: SessionCheckpointTimelineState,
  checkpointId: string,
): SessionCheckpointTimelineState | null {
  const normalizedCheckpointId = normalizeSessionResource(checkpointId);
  if (!normalizedCheckpointId) {
    return null;
  }

  const checkpointIndex = state.checkpoints.findIndex(checkpoint => checkpoint.checkpointId === normalizedCheckpointId);
  if (checkpointIndex < 0) {
    return null;
  }

  return {
    ...cloneSessionCheckpointTimelineState(state)!,
    currentCheckpointIndex: checkpointIndex - 1,
    currentTurnResponseCount: state.checkpoints[checkpointIndex].turnIndex,
  };
}

export function redoSessionCheckpointTimeline(
  state: SessionCheckpointTimelineState,
): SessionCheckpointTimelineState {
  const cloned = cloneSessionCheckpointTimelineState(state)!;
  const nextCheckpointIndex = Math.min(
    cloned.currentCheckpointIndex + 1,
    cloned.checkpoints.length - 1,
  );
  const nextCheckpoint = cloned.checkpoints[nextCheckpointIndex];
  return {
    ...cloned,
    currentCheckpointIndex: nextCheckpointIndex,
    currentTurnResponseCount: nextCheckpoint
      ? nextCheckpoint.turnIndex + 1
      : cloned.currentTurnResponseCount,
  };
}

export function spliceSessionCheckpointTimelineForwardBranch(
  state: SessionCheckpointTimelineState,
): SessionCheckpointTimelineState {
  const visibleTurnResponses = getSessionCheckpointVisibleTurnResponses(state);
  const visibleTurnResponseCount = visibleTurnResponses.length;
  const visibleTurnIndexByTurnId = new Map<string, number>();
  visibleTurnResponses.forEach((turn, index) => {
    const turnId = normalizeSessionResource(turn.turnId);
    if (turnId) {
      visibleTurnIndexByTurnId.set(turnId, index);
    }
  });
  const checkpoints = state.checkpoints
    .map(checkpoint => {
      const checkpointTurnId = normalizeSessionResource(checkpoint.turnId);
      const turnIndex = checkpointTurnId && visibleTurnIndexByTurnId.has(checkpointTurnId)
        ? visibleTurnIndexByTurnId.get(checkpointTurnId)!
        : checkpoint.turnIndex;
      if (turnIndex < 0 || turnIndex >= visibleTurnResponseCount) {
        return null;
      }
      const metadata = checkpoint.metadata ? cloneRequestCheckpointMetadata(checkpoint.metadata) : undefined;
      if (metadata) {
        metadata.turnIndex = turnIndex;
      }
      return {
        ...checkpoint,
        turnIndex,
        ...(metadata ? { metadata } : {}),
      };
    })
    .filter((checkpoint): checkpoint is SessionCheckpointTimelineEntry => !!checkpoint);

  return {
    sessionResource: state.sessionResource,
    turnResponses: visibleTurnResponses,
    checkpoints,
    currentCheckpointIndex: checkpoints.length - 1,
    currentTurnResponseCount: visibleTurnResponseCount,
  };
}

export function canRedoSessionCheckpointTimeline(
  state: SessionCheckpointTimelineState | null | undefined,
): boolean {
  return !!state && state.currentCheckpointIndex < state.checkpoints.length - 1;
}

export function getSessionCheckpointVisibleTurnResponses(
  state: SessionCheckpointTimelineState | null | undefined,
): readonly TurnResponseTurn[] {
  if (!state) {
    return [];
  }

  const visibleTurnResponseCount = resolveStateVisibleTurnResponseCount(state);
  return cloneTurnResponses(state.turnResponses.slice(0, visibleTurnResponseCount));
}

export function getSessionCheckpointHiddenTurnResponses(
  state: SessionCheckpointTimelineState | null | undefined,
): readonly TurnResponseTurn[] {
  if (!state) {
    return [];
  }

  const startIndex = resolveStateVisibleTurnResponseCount(state);
  return cloneTurnResponses(state.turnResponses.slice(startIndex));
}

function normalizeCheckpointIndex(value: number | undefined, lastIndex: number): number {
  if (lastIndex < 0) {
    return -1;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return lastIndex;
  }

  return Math.max(-1, Math.min(Math.trunc(value), lastIndex));
}

function resolveVisibleTurnResponseCountFromCheckpointIndex(
  checkpoints: readonly SessionCheckpointTimelineEntry[],
  currentCheckpointIndex: number,
): number {
  if (currentCheckpointIndex < 0) {
    return 0;
  }

  const checkpoint = checkpoints[currentCheckpointIndex];
  return checkpoint ? checkpoint.turnIndex + 1 : 0;
}

function normalizeVisibleTurnResponseCount(
  value: number | undefined,
  turnResponseCount: number,
  fallback: number,
): number {
  const candidate = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
  return Math.max(0, Math.min(candidate, turnResponseCount));
}

function resolveStateVisibleTurnResponseCount(state: SessionCheckpointTimelineState): number {
  return normalizeVisibleTurnResponseCount(
    state.currentTurnResponseCount,
    state.turnResponses.length,
    resolveVisibleTurnResponseCountFromCheckpointIndex(state.checkpoints, state.currentCheckpointIndex),
  );
}

function normalizeSessionResource(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readTurnRequestMetadata(turn: TurnResponseTurn): Record<string, unknown> | null {
  const metadata = turn.request?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

function resolveTurnCheckpointMetadata(
  turn: TurnResponseTurn,
  requestMetadata: Record<string, unknown> | null,
  options: SessionCheckpointTimelineCreateOptions,
): RequestCheckpointMetadata | undefined {
  const checkpointId = normalizeSessionResource(readMetadataString(requestMetadata, 'checkpointId'));
  if (checkpointId) {
    const metadata = options.metadataByCheckpointId?.get(checkpointId);
    if (metadata) {
      return metadata;
    }
  }

  const requestId = normalizeSessionResource(readMetadataString(requestMetadata, 'requestId'));
  if (requestId) {
    const metadata = options.metadataByRequestId?.get(requestId);
    if (metadata) {
      return metadata;
    }
  }

  const turnId = normalizeSessionResource(turn.turnId);
  if (turnId) {
    return options.metadataByTurnId?.get(turnId);
  }

  return undefined;
}

function readMetadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function cloneRequestCheckpointMetadata(metadata: RequestCheckpointMetadata): RequestCheckpointMetadata {
  return cloneJson(metadata);
}

function cloneTurnResponses(turnResponses: readonly TurnResponseTurn[]): TurnResponseTurn[] {
  return turnResponses.map(turn => cloneJson(turn));
}

function cloneJson<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value) as T;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
