import type {
  IAgentLifecycle,
  IChatServiceAccess,
  IChatViewAccess,
  ISessionAccess,
} from '../core/chat-context';

type ChatConversationActionContext = Pick<IAgentLifecycle, 'isWaiting'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatServiceAccess, 'message'>
  & Pick<IChatViewAccess, 'scrollManager'>;

interface ChatConversationActionCallbacks {
  submitText: (text: string, sessionId: string) => Promise<void> | void;
  rerunLastRequest: (sessionId: string) => Promise<void> | void;
}

/**
 * Coordinates canned main-conversation follow-up actions.
 *
 * Keeps continue/retry host-shell behavior out of ChatEngineService while
 * preserving the existing user-visible prompts and scroll semantics.
 */
export class ChatConversationActionCoordinator {
  constructor(
    private readonly ctx: ChatConversationActionContext,
    private readonly callbacks: ChatConversationActionCallbacks,
  ) {}

  async continueConversation(): Promise<void> {
    if (this.ctx.isWaiting) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return;
    }
    const sessionId = this.resolveCurrentSessionId();
    if (!sessionId) {
      this.ctx.message.warning('会话不存在，请开始新对话');
      return;
    }

    this.ctx.scrollManager.startNewExchange?.();
    await this.callbacks.submitText('请继续完成之前的任务。', sessionId);
  }

  async retryLastAction(): Promise<void> {
    if (this.ctx.isWaiting) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return;
    }
    const sessionId = this.resolveCurrentSessionId();
    if (!sessionId) {
      this.ctx.message.warning('会话不存在，请开始新对话');
      return;
    }

    this.ctx.scrollManager.startNewExchange?.();
    await this.callbacks.rerunLastRequest(sessionId);
  }

  private resolveCurrentSessionId(): string {
    return typeof this.ctx.sessionId === 'string' ? this.ctx.sessionId.trim() : '';
  }
}
