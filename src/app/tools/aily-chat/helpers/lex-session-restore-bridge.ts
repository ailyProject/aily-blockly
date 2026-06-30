import {
  resolvePersistedLexSessionRestorePlan,
  resolvePersistedLexSessionSnapshot,
} from './lex-agent-bootstrap';

import type { AilyLexModule } from './lex-agent-bootstrap';
import type { HostSessionRecord } from '../services/chat-history.service';
import type { ResolvedLexSessionRestorePlan } from './host-session-restore-resolver';

type LexSessionSnapshot = import('aily-lex/browser').SessionSnapshot;

export class LexSessionRestoreBridge {
  constructor(
    private readonly deps: {
      ensureAgent: (sessionId?: string, options?: { readonly activate?: boolean }) => Promise<boolean>;
      getLex: () => AilyLexModule | null;
      getCwd: () => string;
      restoreSnapshot: (snapshot: LexSessionSnapshot, sessionId?: string | null) => boolean;
      resolveSnapshot?: typeof resolvePersistedLexSessionSnapshot;
      resolveRestorePlan?: typeof resolvePersistedLexSessionRestorePlan;
    },
  ) {}

  async resolvePersistedRestorePlan(
    sessionId: string,
    turnResponses?: readonly import('aily-lex/browser').TurnResponseTurn[],
    hostRecord?: HostSessionRecord | null,
  ): Promise<ResolvedLexSessionRestorePlan | null> {
    if (!await this.deps.ensureAgent(sessionId, { activate: false })) {
      return null;
    }

    const lex = this.deps.getLex();
    if (!lex) {
      return null;
    }

    const resolveRestorePlan = this.deps.resolveRestorePlan;
    if (resolveRestorePlan) {
      return await resolveRestorePlan({
        lex,
        sessionId,
        cwd: this.deps.getCwd(),
        turnResponses,
        hostRecord: hostRecord ?? undefined,
      });
    }

    const resolveSnapshot = this.deps.resolveSnapshot ?? resolvePersistedLexSessionSnapshot;
    const snapshot = await resolveSnapshot({
      lex,
      sessionId,
      cwd: this.deps.getCwd(),
      turnResponses,
      hostRecord: hostRecord ?? undefined,
    });

    return {
      snapshot,
      turnResponses: [...(turnResponses ?? [])],
      diagnostics: {
        sessionId,
        storedSnapshotState: snapshot ? 'loaded' : 'missing',
      },
    };
  }

  restoreResolvedSnapshot(snapshot: LexSessionSnapshot, sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : snapshot.sessionId;
    if (snapshot.sessionId !== targetSessionId) {
      throw new Error(`[LexSessionRestoreBridge] Snapshot session mismatch: target=${targetSessionId}, snapshot=${snapshot.sessionId}`);
    }

    return this.deps.restoreSnapshot(snapshot, targetSessionId);
  }

  async restorePersistedSession(
    sessionId: string,
    turnResponses?: readonly import('aily-lex/browser').TurnResponseTurn[],
    hostRecord?: HostSessionRecord | null,
  ): Promise<boolean> {
    const restorePlan = await this.resolvePersistedRestorePlan(sessionId, turnResponses, hostRecord ?? null);
    return restorePlan?.snapshot ? this.restoreResolvedSnapshot(restorePlan.snapshot, sessionId) : false;
  }
}
