import type { SessionSnapshot, TurnResponseTurn } from 'aily-lex/browser';

import type { HostSessionRecord } from '../services/chat-history.service';
import { resolveHostSessionActiveSkillNames, resolveHostSessionRequestContext } from './host-session-runtime-auxiliary';

export type LexSessionStoredSnapshotState = 'loaded' | 'missing' | 'load-failed';

export interface ResolvedLexSessionRestoreDiagnostics {
  readonly sessionId: string;
  readonly storedSnapshotState: LexSessionStoredSnapshotState;
  readonly storedSnapshotError?: string;
}

export interface ResolvedLexSessionRestorePlan {
  readonly snapshot: SessionSnapshot | null;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly diagnostics: ResolvedLexSessionRestoreDiagnostics;
}

interface HostAuthoritativeLexRestoreSnapshotOptions {
  readonly sessionId: string;
  readonly turnResponses?: readonly TurnResponseTurn[];
  readonly hostRecord?: HostSessionRecord | null;
  readonly storedSnapshot?: SessionSnapshot | null;
  readonly storedSnapshotState?: LexSessionStoredSnapshotState;
  readonly storedSnapshotError?: string;
  readonly buildTurnResponseSnapshot: (
    turnResponses: readonly TurnResponseTurn[] | undefined,
    sessionId: string,
    hostRecord?: HostSessionRecord | null,
  ) => SessionSnapshot | null;
}

export function sanitizeStoredLexRestoreSnapshot(
  snapshot: SessionSnapshot | null | undefined,
): SessionSnapshot | null {
  if (!snapshot) {
    return null;
  }

  const { compaction: _legacyCompaction, ...snapshotWithoutLegacyCompaction } = snapshot as SessionSnapshot & {
    compaction?: unknown;
  };
  return snapshotWithoutLegacyCompaction as SessionSnapshot;
}

export function resolveHostAuthoritativeLexRestoreSnapshot(
  options: HostAuthoritativeLexRestoreSnapshotOptions,
): SessionSnapshot | null {
  const storedSnapshot = sanitizeStoredLexRestoreSnapshot(options.storedSnapshot);
  const hostSnapshot = options.buildTurnResponseSnapshot(
    options.turnResponses,
    options.sessionId,
    options.hostRecord ?? null,
  );

  if (!hostSnapshot) {
    return storedSnapshot;
  }

  if (!storedSnapshot) {
    return hostSnapshot;
  }

  const hostRequestContext = options.hostRecord ? resolveHostSessionRequestContext(options.hostRecord) : undefined;
  const hostActiveSkillNames = options.hostRecord ? resolveHostSessionActiveSkillNames(options.hostRecord) : undefined;
  const mergedRequestContext = hostRequestContext ?? hostSnapshot.requestContext ?? storedSnapshot.requestContext;
  const mergedActiveSkillNames = hostActiveSkillNames !== undefined
    ? hostActiveSkillNames
    : (hostSnapshot.activeSkillNames?.length ? hostSnapshot.activeSkillNames : storedSnapshot.activeSkillNames);
  const retainedTurnIds = new Set(
    Array.isArray(hostSnapshot.turns)
      ? hostSnapshot.turns
        .map(turn => typeof turn?.id === 'string' ? turn.id.trim() : '')
        .filter((turnId): turnId is string => turnId.length > 0)
      : [],
  );
  const sanitizedExecutionNarrative = sanitizeExecutionNarrativeForRetainedTurns(
    storedSnapshot.executionNarrative,
    retainedTurnIds,
  );

  return {
    ...hostSnapshot,
    ...(mergedRequestContext ? { requestContext: mergedRequestContext } : {}),
    ...(mergedActiveSkillNames?.length ? { activeSkillNames: [...mergedActiveSkillNames] } : {}),
    ...(storedSnapshot.todos?.length ? { todos: storedSnapshot.todos } : {}),
    ...(sanitizedExecutionNarrative.length ? { executionNarrative: sanitizedExecutionNarrative } : {}),
    revision: typeof storedSnapshot.revision === 'number'
      ? storedSnapshot.revision
      : hostSnapshot.revision,
    updatedAt: typeof storedSnapshot.updatedAt === 'number'
      ? Math.max(hostSnapshot.updatedAt, storedSnapshot.updatedAt)
      : hostSnapshot.updatedAt,
  };
}

export function buildHostAuthoritativeLexRestorePlan(
  options: HostAuthoritativeLexRestoreSnapshotOptions,
): ResolvedLexSessionRestorePlan {
  const snapshot = resolveHostAuthoritativeLexRestoreSnapshot(options);
  const storedSnapshotState = options.storedSnapshotState
    ?? (options.storedSnapshot ? 'loaded' : 'missing');

  return {
    snapshot,
    turnResponses: applySessionSnapshotRoundsToTurnResponses(options.turnResponses ?? [], snapshot),
    diagnostics: {
      sessionId: options.sessionId,
      storedSnapshotState,
      ...(options.storedSnapshotError ? { storedSnapshotError: options.storedSnapshotError } : {}),
    },
  };
}

function applySessionSnapshotRoundsToTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
  sessionSnapshot: SessionSnapshot | null,
): TurnResponseTurn[] {
  if (turnResponses.length === 0 || !sessionSnapshot?.turns?.length) {
    return [...turnResponses];
  }

  const snapshotTurnsById = new Map(sessionSnapshot.turns.map(turn => [turn.id, turn] as const));

  return turnResponses.map((turn) => {
    const snapshotTurn = snapshotTurnsById.get(turn.turnId);
    if (!snapshotTurn) {
      return turn;
    }

    return {
      ...turn,
      rounds: snapshotTurn.rounds?.length ? structuredClone(snapshotTurn.rounds) : (turn.rounds ?? []),
    };
  });
}

function sanitizeExecutionNarrativeForRetainedTurns(
  executionNarrative: SessionSnapshot['executionNarrative'] | undefined,
  retainedTurnIds: ReadonlySet<string>,
): NonNullable<SessionSnapshot['executionNarrative']> {
  if (!Array.isArray(executionNarrative) || executionNarrative.length === 0) {
    return [];
  }

  return executionNarrative.filter((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }

    const payload = 'payload' in entry && entry.payload && typeof entry.payload === 'object'
      ? entry.payload as Record<string, unknown>
      : null;
    const turnId = typeof payload?.['turnId'] === 'string'
      ? payload['turnId'].trim()
      : '';

    return !turnId || retainedTurnIds.has(turnId);
  });
}
