import {
  forkSessionSnapshot,
  type ForkSessionSnapshotOptions,
  type SessionSnapshot,
} from 'aily-lex/browser';
import type { HostSessionRecord } from '../services/chat-history.service';

import type { LexSessionPersistenceBridge } from './lex-session-persistence-bridge';
import type { LexSessionRestoreBridge } from './lex-session-restore-bridge';
import type { ResolvedLexSessionRestorePlan } from './host-session-restore-resolver';

/**
 * Public session-facing owner that groups persistence and persisted restore
 * behind a single owner surface on the lex facade.
 */
export class LexSessionFacade {
  constructor(
    private readonly persistenceBridge: LexSessionPersistenceBridge,
    private readonly restoreBridge: LexSessionRestoreBridge,
  ) {}

  save(sessionId?: string | null): SessionSnapshot | null {
    return this.persistenceBridge.saveSession(sessionId);
  }

  snapshot(sessionId?: string | null): SessionSnapshot | null {
    return this.persistenceBridge.getSessionSnapshot(sessionId);
  }

  forkSnapshot(
    sourceSnapshot: SessionSnapshot,
    options: ForkSessionSnapshotOptions,
  ): SessionSnapshot {
    return forkSessionSnapshot(sourceSnapshot, options);
  }

  resolveRestorePlan(
    sessionId: string,
    turnResponses?: readonly import('aily-lex/browser').TurnResponseTurn[],
    hostRecord?: HostSessionRecord | null,
  ): Promise<ResolvedLexSessionRestorePlan | null> {
    return this.restoreBridge.resolvePersistedRestorePlan(sessionId, turnResponses, hostRecord ?? null);
  }

  restoreResolvedSnapshot(snapshot: SessionSnapshot, sessionId?: string | null): boolean {
    return this.restoreBridge.restoreResolvedSnapshot(snapshot, sessionId);
  }

  async restore(
    sessionId: string,
    turnResponses?: readonly import('aily-lex/browser').TurnResponseTurn[],
    hostRecord?: HostSessionRecord | null,
  ): Promise<boolean> {
    const restorePlan = await this.resolveRestorePlan(sessionId, turnResponses, hostRecord ?? null);
    return restorePlan?.snapshot ? this.restoreResolvedSnapshot(restorePlan.snapshot, sessionId) : false;
  }
}
