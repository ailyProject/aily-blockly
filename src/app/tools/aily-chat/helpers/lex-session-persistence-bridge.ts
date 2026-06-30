import type { AgentHandle, SessionSnapshot } from 'aily-lex/browser';

interface SessionPersistenceAgentLike {
  getSessionSnapshot?(): SessionSnapshot | null;
  saveSession?(): SessionSnapshot | null;
  drainPendingEvents?(): readonly any[];
  restoreSession?(snapshot: SessionSnapshot): void;
}

export class LexSessionPersistenceBridge {
  constructor(
    private readonly deps: {
      getHandle?: (sessionId?: string | null) => AgentHandle | null;
      getAgent: (sessionId?: string | null) => SessionPersistenceAgentLike | null;
      flushPendingEvents: (events: readonly any[]) => void;
    },
  ) {}

  saveSession(sessionId?: string | null): SessionSnapshot | null {
    const snapshot = this.deps.getHandle?.(sessionId)?.saveSession?.()
      ?? this.deps.getAgent(sessionId)?.saveSession?.()
      ?? null;
    this.flushPendingEvents();
    return snapshot;
  }

  getSessionSnapshot(sessionId?: string | null): SessionSnapshot | null {
    const handle = this.deps.getHandle?.(sessionId) ?? null;
    return handle?.getSessionSnapshot()
      ?? this.deps.getAgent(sessionId)?.getSessionSnapshot?.()
      ?? null;
  }

  drainPendingEvents(): readonly any[] {
    return this.deps.getHandle?.()?.drainPendingEvents?.()
      ?? this.deps.getAgent()?.drainPendingEvents?.()
      ?? [];
  }

  restoreSession(snapshot: SessionSnapshot, sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : snapshot.sessionId;
    const handle = this.deps.getHandle?.(targetSessionId) ?? null;
    if (handle?.restoreSession) {
      handle.restoreSession(snapshot);
      this.flushPendingEvents();
      return true;
    }

    const agent = this.deps.getAgent(targetSessionId);
    if (agent?.restoreSession) {
      agent.restoreSession(snapshot);
      this.flushPendingEvents();
      return true;
    }

    return false;
  }

  private flushPendingEvents(): void {
    this.deps.flushPendingEvents(this.drainPendingEvents());
  }
}
