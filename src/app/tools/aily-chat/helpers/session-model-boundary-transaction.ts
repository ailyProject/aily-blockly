import type { TurnResponseTurn } from 'aily-lex/browser';
import type { HostSessionRecord } from '../services/chat-history.service';
import {
  buildHostProjectionStateFromPersistedRecord,
  type HostTurnResponseState,
} from './host-turn-response-state';
import { buildSessionTurnOwnerDiagnostics } from './session-turn-owner-diagnostics';

type LexRestorePlan = {
  readonly snapshot?: unknown | null;
  readonly turnResponses?: readonly TurnResponseTurn[] | null;
} | null;

export interface SessionModelBoundaryTurnOwnerPolicyOptions {
  readonly allowForkedTurns?: boolean;
  readonly source?: string;
}

export interface SessionModelBoundaryTransactionContext {
  readonly lexStream: {
    readonly session?: {
      restoreResolvedSnapshot?(snapshot: unknown, sessionId?: string | null): boolean;
    };
    hydrateTurnResponses?(
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      options?: { readonly visibility?: 'visibleAttach' | 'detached' },
    ): void;
  };
  projectRestoredHostProjection?(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    hostProjectionState: HostTurnResponseState,
    options?: { readonly attachedView?: boolean },
  ): void;
  replaceSessionModelTurnResponses?(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    ownerPolicy?: SessionModelBoundaryTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null | undefined;
  replaceSharedHostProjectionState?(
    state: HostTurnResponseState | null,
    options: { readonly sessionId: string | null; readonly attachedView?: boolean },
  ): void;
  invalidateHostRequestGraph?(): void;
  triggerSyncDetectChanges?(): void;
}

export interface RestoreSessionBoundaryTransactionInput {
  readonly sessionId: string;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly restorePlan?: LexRestorePlan;
  readonly hostProjectionState?: HostTurnResponseState | null;
  readonly hostRecord?: HostSessionRecord | null;
  readonly attachedView?: boolean;
  readonly hydrateVisibleTurnResponses?: boolean;
  readonly requireLexSnapshotRestore?: boolean;
  readonly acceptRestorePlanTurnResponses?: boolean;
}

export interface RestoreSessionBoundaryTransactionResult {
  readonly sessionId: string;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly hostProjectionState: HostTurnResponseState;
  readonly restoredLexSnapshot: boolean;
}

export async function restoreSessionBoundaryTransaction(
  ctx: SessionModelBoundaryTransactionContext,
  input: RestoreSessionBoundaryTransactionInput,
): Promise<RestoreSessionBoundaryTransactionResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('Session boundary transaction requires a sessionResource');
  }

  let turnResponses = [...input.turnResponses];
  let restoredLexSnapshot = false;
  const acceptRestorePlanTurnResponses = input.acceptRestorePlanTurnResponses !== false;
  const restoreResolvedSnapshot = ctx.lexStream.session?.restoreResolvedSnapshot?.bind(ctx.lexStream.session);

  if (input.restorePlan && restoreResolvedSnapshot) {
    const restorePlan = input.restorePlan;
    if (!restorePlan) {
      if (input.requireLexSnapshotRestore) {
        throw new Error(`Session boundary transaction failed to resolve lex restore plan for ${sessionId}`);
      }
    } else if (restorePlan.snapshot) {
      const restored = restoreResolvedSnapshot(restorePlan.snapshot, sessionId);
      if (!restored) {
        throw new Error(`Session boundary transaction failed to restore lex snapshot for ${sessionId}`);
      }
      restoredLexSnapshot = true;
      if (acceptRestorePlanTurnResponses) {
        turnResponses = [...(restorePlan.turnResponses ?? turnResponses)];
      }
    } else if (input.requireLexSnapshotRestore) {
      throw new Error(`Session boundary transaction resolved no lex snapshot for ${sessionId}`);
    }
  }

  const modelTurnResponses = ctx.replaceSessionModelTurnResponses?.(
    sessionId,
    turnResponses,
    {
      allowForkedTurns: isForkedHostRecord(input.hostRecord),
      source: 'session-boundary-restore',
    },
  );
  if (modelTurnResponses === null) {
    const diagnostics = buildSessionTurnOwnerDiagnostics(sessionId, turnResponses);
    throw new Error(
      `Session boundary transaction rejected turn owner mismatch for ${sessionId}`
      + ` (${diagnostics.mismatchCount} mismatched turns).`,
    );
  }
  if (Array.isArray(modelTurnResponses)) {
    turnResponses = [...modelTurnResponses];
  }

  const hostProjectionState = input.hostProjectionState?.turnResponses?.length === turnResponses.length
    ? input.hostProjectionState
    : buildHostProjectionStateFromPersistedRecord({ turnResponses });

  if (input.hydrateVisibleTurnResponses) {
    ctx.lexStream.hydrateTurnResponses?.(sessionId, turnResponses, { visibility: 'visibleAttach' });
  }

  if (ctx.projectRestoredHostProjection) {
    ctx.projectRestoredHostProjection(sessionId, turnResponses, hostProjectionState, {
      attachedView: input.attachedView !== false,
    });
  } else {
    ctx.replaceSharedHostProjectionState?.(hostProjectionState, {
      sessionId,
      attachedView: input.attachedView !== false,
    });
  }

  ctx.invalidateHostRequestGraph?.();
  ctx.triggerSyncDetectChanges?.();

  return {
    sessionId,
    turnResponses,
    hostProjectionState,
    restoredLexSnapshot,
  };
}

function isForkedHostRecord(hostRecord: HostSessionRecord | null | undefined): boolean {
  const metadata = hostRecord?.metadata as unknown as Record<string, unknown> | undefined;
  return typeof metadata?.['forkedFromSessionId'] === 'string'
    || typeof metadata?.['forkKind'] === 'string';
}
