interface LoggerLike {
  log: (...args: unknown[]) => void;
}

/**
 * Handles non-UI session/diagnostic events so the main event bridge can stay
 * focused on runtime/state orchestration.
 */
export class LexSessionDiagnosticsEventBridge {
  constructor(private readonly logger: LoggerLike = console) {}

  processEvent(event: any): boolean {
    switch (event.type) {
      case 'approval_request':
        return true;

      case 'user_input_request':
        this.logger.log('[LexStream] 用户输入请求:', event.prompt, event.requestId);
        return true;

      case 'session_saved':
        this.logger.log('[LexStream] 会话已保存:', event.sessionId);
        return true;

      case 'session_restored':
        this.logger.log('[LexStream] 会话已恢复:', event.sessionId, `turns=${event.turnCount}`);
        return true;

      default:
        return false;
    }
  }
}