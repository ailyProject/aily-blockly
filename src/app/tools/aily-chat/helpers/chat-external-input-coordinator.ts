import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  ISessionAccess,
} from '../core/chat-context';
import type { ChatTextOptions } from '../services/chat.service';

type ChatExternalInputContext = Pick<IAgentLifecycle, 'isWaiting'>
  & Pick<IChatViewAccess, 'inputValue' | 'scrollManager' | 'triggerSyncDetectChanges'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IChatCoordination, 'send'>
  & Pick<IChatServiceAccess, 'message'>;

interface ExternalInputCallbacks {
  retryLastAction: () => Promise<void> | void;
  regenerateTurn: () => Promise<void> | void;
  undoLastEdits: () => Promise<void> | void;
  newChat: () => Promise<void> | void;
  ensureSessionReadyForSubmit: () => Promise<boolean>;
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

      void this.autoSendExternalInput();
    });
  }

  private async autoSendExternalInput(): Promise<void> {
    if (!this.ctx.sessionId) {
      const ready = await this.callbacks.ensureSessionReadyForSubmit();
      if (!ready || !this.ctx.sessionId) {
        this.ctx.message.warning('无法创建会话，请稍后重试');
        return;
      }
    }

    this.ctx.scrollManager.startNewExchange();
    await this.ctx.send('user', this.ctx.inputValue, true);
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
        this.ctx.scrollManager.startNewExchange();
        void this.ctx.send('user', text, false);
    }
  }
}