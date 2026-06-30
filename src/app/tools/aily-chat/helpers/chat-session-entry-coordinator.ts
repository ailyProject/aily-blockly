import { ChatPerformanceTracer } from '../services/chat-perf-tracer';

interface ChatSessionEntryCoordinatorContext {
  readonly isLoggedIn: boolean;
  readonly hasCurrentSession: boolean;
  enterEntryState(options?: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null }): void;
  enterBlankSessionShell(options?: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null }): void;
  startSession(): Promise<string | null>;
  restorePersistedSessionTarget(): Promise<boolean>;
  requestSessionListRefresh(input: { reason: 'entry' | 'reopen'; scope: 'summary' | 'full'; priority: 'after-paint' | 'normal' }): void;
}

export class ChatSessionEntryCoordinator {
  constructor(private readonly ctx: ChatSessionEntryCoordinatorContext) {}

  async initializeEntryInventory(options?: { readonly restorePersistedTarget?: boolean }): Promise<boolean> {
    const shouldRestorePersistedTarget = options?.restorePersistedTarget !== false;
    if (this.ctx.hasCurrentSession) {
      if (shouldRestorePersistedTarget) {
        const restoredCurrent = await this.ctx.restorePersistedSessionTarget().catch((error: unknown) => {
          console.warn('恢复持久化 session target 失败:', error);
          return false;
        });
        if (restoredCurrent) {
          return true;
        }
      }
      return true;
    }

    this.ctx.enterEntryState();
    ChatPerformanceTracer.increment('entry_open.entry_shell_visible');
    ChatPerformanceTracer.mark('entry_open.entry_shell_visible');

    const restored = shouldRestorePersistedTarget
      ? await this.ctx.restorePersistedSessionTarget().catch((error: unknown) => {
          console.warn('恢复持久化 session target 失败:', error);
          return false;
        })
      : false;

    if (!restored) {
      this.ctx.requestSessionListRefresh({ reason: 'entry', scope: 'summary', priority: 'after-paint' });
    }

    return restored;
  }

  async returnToEntryInventory(options: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null } = {}): Promise<void> {
    this.ctx.enterEntryState(options);
    ChatPerformanceTracer.increment('entry_open.entry_shell_visible');
    ChatPerformanceTracer.mark('entry_open.entry_shell_visible', 'return-to-entry');

    if (this.ctx.isLoggedIn) {
      this.ctx.requestSessionListRefresh({ reason: 'entry', scope: 'summary', priority: 'after-paint' });
    }
  }

  async bootstrapNewSession(options: { resetInitialization?: boolean } = {}): Promise<string | null> {
    this.ctx.enterBlankSessionShell(options);
    ChatPerformanceTracer.increment('entry_open.blank_shell_visible');
    ChatPerformanceTracer.mark('entry_open.blank_shell_visible');
    return this.ctx.startSession();
  }
}
