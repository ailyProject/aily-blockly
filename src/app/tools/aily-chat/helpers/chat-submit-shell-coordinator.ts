import type { ChatPendingRequestKind } from './chat-pending-request';

interface ScrollManagerLike {
  startNewExchange(): void;
  scrollToBottom(): void;
}

interface ResourceManagerLike {
  items: unknown[];
  mergePathsTo(sessionAllowedPaths: string[]): void;
}

interface AuthQuotaLike {
  quotaExhausted: boolean;
}

interface InputNoticeLike {
  handleMessageSubmitted?(): void;
}

interface QueueSendLike {
  (text: string, sessionId?: string | null, options?: { kind?: ChatPendingRequestKind }): Promise<boolean> | boolean;
}

interface SubmitInputOptionsLike {
  queueKind?: ChatPendingRequestKind;
}

type ConfirmPendingRequestsResult = 'keep' | 'remove' | false;

const REQUEST_STATE_TRACE_PREFIX = '[AilyChat][RequestStateTrace]';

export class ChatSubmitShellCoordinator {
  private readonly inFlightSubmitSessionIds = new Set<string>();
  private readonly locallyStoppingSessionIds = new Set<string>();

  constructor(
    private readonly deps: {
      scrollManager: ScrollManagerLike;
      resourceManager: ResourceManagerLike;
      authQuota: AuthQuotaLike;
      inputNotice: InputNoticeLike;
      getSessionAllowedPaths: () => string[];
      getSessionId: () => string;
      getInputValue: () => string;
      isWaiting: (sessionId?: string | null) => boolean;
      ensureSession?: () => Promise<string | null>;
      hasPendingRequests?: (sessionId?: string | null) => boolean;
      confirmPendingRequestsBeforeSend?: (sessionId?: string | null) => Promise<ConfirmPendingRequestsResult>;
      clearPendingRequests?: (sessionId?: string | null) => void;
      queueSend?: QueueSendLike;
      stop: (sessionId?: string | null) => unknown;
      send: (text: string, sessionId?: string | null) => Promise<unknown>;
    },
  ) {}

  async handlePrimaryAction(): Promise<boolean> {
    return this.sendOrQueueDraft();
  }

  private traceRequestAction(
    action: 'send' | 'queue' | 'stop',
    state: 'idle' | 'running',
    extra?: Record<string, unknown>,
  ): void {
    const sessionId = this.deps.getSessionId() || null;
    const payload = {
      phase: 'submit-dispatch',
      action,
      sessionId,
      requestId: null,
      state,
      ...(extra ?? {}),
    };
    console.info(REQUEST_STATE_TRACE_PREFIX, payload);
    console.info(
      '[AilyChat][RequestStateTraceScalar]',
      [
        'phase=submit-dispatch',
        `action=${action}`,
        `sessionId=${String(payload.sessionId ?? '<none>')}`,
        `state=${state}`,
        `queueKind=${String(payload['queueKind'] ?? '<none>')}`,
        `hasPendingRequests=${String(payload['hasPendingRequests'] ?? '<none>')}`,
        `pendingCount=${String(payload['pendingCount'] ?? '<none>')}`,
        `textLength=${String(payload['textLength'] ?? '<none>')}`,
      ].join(' '),
    );
  }

  async sendOrQueueDraft(options?: SubmitInputOptionsLike): Promise<boolean> {
    this.prepareForSubmit();
    return this.submitPreparedInput(options);
  }

  stopActiveRequest(): boolean {
    const sessionId = this.deps.getSessionId();
    if (!this.deps.isWaiting(sessionId)) {
      return false;
    }

    if (sessionId && this.locallyStoppingSessionIds.has(sessionId)) {
      return false;
    }

    if (sessionId) {
      this.locallyStoppingSessionIds.add(sessionId);
    }
    this.traceRequestAction('stop', 'running', { sessionId: sessionId || null });
    const stopResult = this.deps.stop(sessionId);
    if (sessionId && stopResult && typeof (stopResult as Promise<unknown>).finally === 'function') {
      void (stopResult as Promise<unknown>).finally(() => {
        this.locallyStoppingSessionIds.delete(sessionId);
      });
    }
    return true;
  }

  async submitCurrentInput(options?: SubmitInputOptionsLike): Promise<boolean> {
    return this.sendOrQueueDraft(options);
  }

  private async submitPreparedInput(options?: SubmitInputOptionsLike): Promise<boolean> {
    const text = this.deps.getInputValue().trim();
    if (!text || this.deps.authQuota.quotaExhausted) {
      return false;
    }

    let targetSessionId = this.deps.getSessionId();
    if (!targetSessionId) {
      targetSessionId = (await this.deps.ensureSession?.()) ?? '';
      if (!targetSessionId) {
        return false;
      }
    }

    if (this.isSessionWaitingOrStopping(targetSessionId)) {
      return this.queuePreparedInput(text, targetSessionId, options?.queueKind ?? 'queued', 'running');
    }

    if (this.inFlightSubmitSessionIds.has(targetSessionId)) {
      return false;
    }

    if (this.deps.hasPendingRequests?.(targetSessionId)) {
      const pendingDecision = await this.deps.confirmPendingRequestsBeforeSend?.(targetSessionId) ?? 'keep';
      if (!pendingDecision) {
        return false;
      }

      if (pendingDecision === 'remove') {
        this.deps.clearPendingRequests?.(targetSessionId);
      }
    }

    this.traceRequestAction('send', 'idle', {
      sessionId: targetSessionId,
      textLength: text.length,
      hasPendingRequests: this.deps.hasPendingRequests?.(targetSessionId) === true,
    });
    this.inFlightSubmitSessionIds.add(targetSessionId);
    try {
      await this.deps.send(text, targetSessionId);
      this.deps.inputNotice.handleMessageSubmitted?.();
      this.deps.resourceManager.mergePathsTo(this.deps.getSessionAllowedPaths());
      this.deps.resourceManager.items = [];
      return true;
    } finally {
      this.inFlightSubmitSessionIds.delete(targetSessionId);
    }
  }

  private async queuePreparedInput(
    text: string,
    sessionId: string,
    kind: ChatPendingRequestKind,
    state: 'idle' | 'running',
  ): Promise<boolean> {
    if (!sessionId || typeof this.deps.queueSend !== 'function') {
      return false;
    }

    this.traceRequestAction('queue', state, {
      sessionId,
      queueKind: kind,
      textLength: text.length,
    });
    const queued = await this.deps.queueSend(text, sessionId, { kind });
    if (!queued) {
      return false;
    }

    this.deps.inputNotice.handleMessageSubmitted?.();
    this.deps.resourceManager.mergePathsTo(this.deps.getSessionAllowedPaths());
    this.deps.resourceManager.items = [];
    return true;
  }

  private isSessionWaitingOrStopping(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return (!!targetSessionId && this.locallyStoppingSessionIds.has(targetSessionId))
      || this.deps.isWaiting(sessionId);
  }

  private prepareForSubmit(): void {
    this.deps.scrollManager.startNewExchange();
  }
}
