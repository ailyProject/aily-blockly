interface AiNoticeCallbacks {
  stop: (sessionId?: string | null) => void;
  updateNotice: (config: {
    title: string;
    state: 'doing';
    showProgress: boolean;
    setTimeout: number;
    stop: () => void;
  }) => void;
  clearNotice: () => void;
}

/**
 * Coordinates the transient host-side AI activity notice.
 */
export class ChatAiNoticeCoordinator {
  private aiNoticeShown = false;

  constructor(private readonly callbacks: AiNoticeCallbacks) {}

  update(isWaiting: boolean, sessionId?: string | null): void {
    if (isWaiting) {
      this.aiNoticeShown = true;
      const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
        ? sessionId.trim()
        : undefined;
      this.callbacks.updateNotice({
        title: 'AI正在操作',
        state: 'doing',
        showProgress: false,
        setTimeout: 0,
        stop: () => {
          this.callbacks.stop(targetSessionId);
        },
      });
      return;
    }

    if (!this.aiNoticeShown) {
      return;
    }

    this.aiNoticeShown = false;
    this.callbacks.clearNotice();
  }
}