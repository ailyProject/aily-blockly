export type ChatSessionRuntimeCompletionPhase = 'workspace_finalize' | 'session_end_hooks';

export interface ChatSessionLexRequestCompletedInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly reason: string;
  readonly runWorkspaceFinalize: () => Promise<void>;
  readonly runSessionEndHooks: () => Promise<void>;
}

export interface ChatSessionRuntimeCompletionQueueHooks {
  readonly onPendingCountDelta?: (delta: number) => void;
  readonly beforePhase?: (
    sessionId: string,
    turnId: string,
    phase: ChatSessionRuntimeCompletionPhase,
  ) => Promise<void> | void;
  readonly runPhase?: (
    sessionId: string,
    turnId: string,
    phase: ChatSessionRuntimeCompletionPhase,
    runPhase: () => Promise<void>,
  ) => Promise<void>;
}

export class ChatSessionRuntimeCompletionQueueCore {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly hooks: ChatSessionRuntimeCompletionQueueHooks = {}) {}

  getSessionIds(): readonly string[] {
    return [...this.pending.keys()];
  }

  schedule(input: ChatSessionLexRequestCompletedInput): boolean {
    const normalizedSessionId = this.normalizeSessionId(input.sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const runCompletion = async (): Promise<void> => {
      this.hooks.onPendingCountDelta?.(1);
      try {
        await this.runQueuedPhase(
          normalizedSessionId,
          input.turnId,
          'workspace_finalize',
          input.runWorkspaceFinalize,
        );
        await this.runQueuedPhase(
          normalizedSessionId,
          input.turnId,
          'session_end_hooks',
          input.runSessionEndHooks,
        );
      } finally {
        this.hooks.onPendingCountDelta?.(-1);
      }
    };

    const previous = this.pending.get(normalizedSessionId) ?? Promise.resolve();
    const next = previous.then(runCompletion, runCompletion).finally(() => {
      if (this.pending.get(normalizedSessionId) === next) {
        this.pending.delete(normalizedSessionId);
      }
    });
    this.pending.set(normalizedSessionId, next);
    return true;
  }

  async awaitPending(sessionId?: string | null): Promise<void> {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (normalizedSessionId) {
      await (this.pending.get(normalizedSessionId) ?? Promise.resolve());
      return;
    }

    await Promise.all([...this.pending.values()]);
  }

  clearSession(sessionId: string | null | undefined): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (normalizedSessionId) {
      this.pending.delete(normalizedSessionId);
    }
  }

  clearAll(): void {
    this.pending.clear();
  }

  private async runQueuedPhase(
    sessionId: string,
    turnId: string,
    phase: ChatSessionRuntimeCompletionPhase,
    runPhase: () => Promise<void>,
  ): Promise<void> {
    await this.hooks.beforePhase?.(sessionId, turnId, phase);
    const phaseRunner = this.hooks.runPhase ?? ((_sessionId, _turnId, _phase, execute) => execute());
    await phaseRunner(sessionId, turnId, phase, runPhase);
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }
}
