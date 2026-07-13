import type {
  IAgentLifecycle,
  IChatServiceAccess,
  IChatViewAccess,
  ISessionAccess,
} from '../core/chat-context';
import type { ChatTextOptions } from '../services/chat.service';

type ChatExternalInputContext = Pick<IAgentLifecycle, 'isWaiting'>
  & Pick<IChatViewAccess, 'inputValue' | 'scrollManager' | 'triggerSyncDetectChanges'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatServiceAccess, 'message'>;

interface ExternalInputCallbacks {
  retryLastAction: () => Promise<void> | void;
  regenerateTurn: () => Promise<void> | void;
  undoLastEdits: () => Promise<void> | void;
  newChat: () => Promise<void> | void;
  ensureSessionReadyForSubmit: () => Promise<string | null>;
  submitText: (text: string, clearInput: boolean, sessionId?: string | null) => Promise<void> | void;
  focusInput: () => void;
  schedulePostInputWork: (work: () => void) => void;
}

/**
 * Coordinates externally injected chat text and button actions.
 *
 * This keeps button routing, auto-send gating, and input staging out of the
 * ChatEngineService shell.
 */
export class ChatExternalInputCoordinator {
  private pendingAutoSendText: string | undefined;
  private pendingAutoSendOptions: ChatTextOptions | undefined;

  constructor(
    private readonly ctx: ChatExternalInputContext,
    private readonly callbacks: ExternalInputCallbacks,
  ) {}

  receiveText(text: string, options?: ChatTextOptions): void {
    if (options?.type === 'button') {
      this.handleButtonText(text);
      return;
    }

    if (options?.autoSend && this.ctx.isWaiting) {
      this.ctx.message.warning('当前对话正在执行中，请等待完成后再试');
      return;
    }

    if (options?.cover === false) {
      this.ctx.inputValue = this.ctx.inputValue ? this.ctx.inputValue + '\n' + text : text;
    } else {
      this.ctx.inputValue = text;
    }
    this.ctx.triggerSyncDetectChanges();

    this.callbacks.schedulePostInputWork(() => {
      this.callbacks.focusInput();

      if (!options?.autoSend) {
        return;
      }

      this.pendingAutoSendText = this.ctx.inputValue;
      this.pendingAutoSendOptions = options;
      void this.autoSendExternalInput();
    });
  }

  private async autoSendExternalInput(): Promise<void> {
    // External UI affordances, such as project-side quick actions, can request
    // a fresh chat before submitting. Keep that decision here so all external
    // auto-send paths still converge on the same host-owned submit pipeline.
    // The option is read from the staged input path instead of the call-site
    // opening sessions directly.
    const text = this.pendingAutoSendText ?? this.ctx.inputValue;
    const options = this.pendingAutoSendOptions;
    this.pendingAutoSendText = undefined;
    this.pendingAutoSendOptions = undefined;
    const shouldStartFreshSession = options?.newChatFirst === true;
    if (options?.newChatFirst) {
      await this.callbacks.newChat();
      this.ctx.inputValue = text;
      this.ctx.triggerSyncDetectChanges();
    }

    let targetSessionId = shouldStartFreshSession ? '' : this.ctx.sessionId;
    if (!targetSessionId) {
      targetSessionId = await this.callbacks.ensureSessionReadyForSubmit();
      if (!targetSessionId) {
        this.ctx.message.warning('无法创建会话，请稍后重试');
        return;
      }
    }

    this.ctx.scrollManager.startNewExchange();
    await this.callbacks.submitText(text, true, targetSessionId);
    this.ctx.triggerSyncDetectChanges();
  }

  private handleButtonText(text: string): void {
    switch (text) {
      case '重试':
        void this.callbacks.retryLastAction();
        return;
      case '重新生成':
        void this.callbacks.regenerateTurn();
        return;
      case '撤销变更':
        void this.callbacks.undoLastEdits();
        return;
      case '新建会话':
        void this.callbacks.newChat();
        return;
      default:
        void this.submitExternalButtonText(text);
    }
  }

  private async submitExternalButtonText(text: string): Promise<void> {
    let targetSessionId = typeof this.ctx.sessionId === 'string' ? this.ctx.sessionId.trim() : '';
    if (!targetSessionId) {
      targetSessionId = await this.callbacks.ensureSessionReadyForSubmit() ?? '';
      if (!targetSessionId) {
        this.ctx.message.warning('无法创建会话，请稍后重试');
        return;
      }
    }

    this.ctx.scrollManager.startNewExchange();
    await this.callbacks.submitText(text, false, targetSessionId);
  }
}
