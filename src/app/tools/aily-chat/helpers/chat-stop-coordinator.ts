import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  ISessionAccess,
} from '../core/chat-context';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';

type ChatStopCoordinatorContext = Pick<
  IAgentLifecycle,
  'isCancelled' | 'messageSubscription' | 'pendingUserInput' | 'activeToolExecutions' | 'currentStatelessMode' | 'isWaiting' | 'isCompleted'
> & Pick<IChatCoordination, 'lexStream' | 'session' | 'applyPendingSwitch'>
  & Pick<IChatServiceAccess, 'contextBudgetService'>
  & Pick<ISessionAccess, 'conversationMessages' | 'sessionId'>
  & Pick<IChatViewAccess, 'viewAdapter'>
  & {
    dismissPendingInteractions?(sessionId?: string | null): void;
    markExplicitInterrupt?(sessionId?: string | null): void;
    awaitPendingLexRequestCompleted?(sessionId?: string | null): Promise<void>;
    stopSettleTimeoutMs?: number;
    requestStop?(sessionId?: string | null): boolean | Promise<boolean>;
  };

const DEFAULT_STOP_SETTLE_TIMEOUT_MS = 1000;
const REQUEST_STATE_TRACE_PREFIX = '[AilyChat][RequestStateTrace]';

export interface ChatStopVisibleSessionOptions {
  readonly applyPendingSwitch?: boolean;
}

/**
 * Coordinates host-side cleanup when the visible current turn is stopped.
 *
 * Detached runtime interruption is handled by the engine-owned session action
 * owner so this coordinator can stay focused on the visible finalize path.
 */
export class ChatStopCoordinator {
  constructor(private readonly ctx: ChatStopCoordinatorContext) {}

  private async waitForAbortSettle(sessionId?: string): Promise<void> {
    if (typeof this.ctx.awaitPendingLexRequestCompleted !== 'function') {
      return;
    }

    const settlePromise = Promise.resolve(this.ctx.awaitPendingLexRequestCompleted(sessionId)).then(
      () => undefined,
      () => undefined,
    );
    const timeoutMs = typeof this.ctx.stopSettleTimeoutMs === 'number'
      && Number.isFinite(this.ctx.stopSettleTimeoutMs)
      && this.ctx.stopSettleTimeoutMs > 0
      ? Math.floor(this.ctx.stopSettleTimeoutMs)
      : DEFAULT_STOP_SETTLE_TIMEOUT_MS;

    await Promise.race([
      settlePromise,
      new Promise<void>(resolve => {
        if (typeof globalThis.setTimeout !== 'function') {
          resolve();
          return;
        }

        const timerHandle = globalThis.setTimeout(() => {
          resolve();
        }, timeoutMs);

        void settlePromise.finally(() => {
          if (typeof globalThis.clearTimeout === 'function') {
            globalThis.clearTimeout(timerHandle);
          }
        });
      }),
    ]);
  }

  private shouldRefreshLocalEstimate(): boolean {
    const snapshot = this.ctx.contextBudgetService.getSnapshot();
    return snapshot.currentTokens <= 0 || snapshot.maxContextTokens <= 0;
  }

  async stopVisibleSession(sessionId?: string, options: ChatStopVisibleSessionOptions = {}): Promise<void> {
    const pendingUserInputBeforeStop = this.ctx.pendingUserInput === true;
    const activeToolExecutionsBeforeStop = this.ctx.activeToolExecutions;
    this.ctx.isCancelled = true;
    let requestStopPromise: Promise<boolean> | null = null;
    if (typeof this.ctx.requestStop === 'function') {
      requestStopPromise = Promise.resolve(this.ctx.requestStop(sessionId));
    } else {
      this.ctx.lexStream.agent.stop(sessionId);
    }

    if (this.ctx.messageSubscription) {
      this.ctx.messageSubscription.unsubscribe();
      this.ctx.messageSubscription = null;
    }

    this.ctx.pendingUserInput = false;
    this.ctx.activeToolExecutions = 0;
    this.ctx.currentStatelessMode = false;
    this.ctx.dismissPendingInteractions?.(sessionId);

    console.info(REQUEST_STATE_TRACE_PREFIX, {
      phase: 'stop',
      action: 'stop',
      sessionId: sessionId ?? null,
      requestId: null,
      state: 'running',
      pendingUserInput: pendingUserInputBeforeStop,
      activeToolExecutions: activeToolExecutionsBeforeStop,
      owner: 'runtime-host',
    });

    if (this.shouldRefreshLocalEstimate()) {
      this.ctx.contextBudgetService.refreshLocalEstimate(
        this.ctx.conversationMessages,
        this.ctx.lexStream.runtime.tools(),
      );
    }

    const checkpointPromise = this.commitCurrentTurnCheckpoint(sessionId ?? this.ctx.sessionId)
      .catch((error) => {
        console.warn('[AilyChat][RuntimeHost] stopped turn checkpoint commit failed:', error);
      });

    await requestStopPromise?.catch((error) => {
      console.warn('[AilyChat][RuntimeHost] stop request failed before settle:', error);
      return false;
    });
    await this.waitForAbortSettle(sessionId);
    this.ctx.markExplicitInterrupt?.(sessionId);
    this.ctx.viewAdapter.markLastMessageDone();
    this.ctx.isWaiting = false;
    this.ctx.isCompleted = true;
    this.ctx.session.saveCurrentSession();
    void checkpointPromise;
    if (options.applyPendingSwitch !== false) {
      await this.ctx.applyPendingSwitch(sessionId);
    }
  }

  private async commitCurrentTurnCheckpoint(sessionId: string | null | undefined): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      throw new Error('[AilyChat][RuntimeHost] checkpoint commit requires a host session id.');
    }
    const runtimeHost = createElectronChatRuntimeHostTransport();
    if (!runtimeHost) {
      throw new Error('[AilyChat][RuntimeHost] checkpoint commit requires the host transport.');
    }
    await runtimeHost.requestResourceOperation({
      sessionId: targetSessionId,
      kind: 'checkpoint-commit',
      label: 'Committing workspace checkpoint',
      detail: 'Host workspace checkpoint resource is committing a stopped turn.',
      payload: {
        adapter: 'editCheckpoint',
        action: 'commitCurrentTurn',
      },
    });
  }
}
