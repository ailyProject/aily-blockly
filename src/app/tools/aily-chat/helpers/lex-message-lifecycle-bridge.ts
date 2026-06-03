import type { IAgentLifecycle, IChatCoordination, IChatServiceAccess } from '../core/chat-context';
import type { ChatPart } from '../core/chat-parts';
import type { TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import { AilyHost } from '../core/host';
import type { ChatListItem } from '../services/chat-history.service';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import { ChatViewWriteBridge } from './chat-view-write-bridge';
import type { ChatMessageHandle } from './chat-message-handle';
import { findChatMessageHandleByMessage } from './chat-message-handle';

type LexMessageLifecycleViewWriteContext = ConstructorParameters<typeof ChatViewWriteBridge>[0];

import type { EditsSummary } from '../services/edit-checkpoint.service';

type LexMessageLifecycleContext = LexMessageLifecycleViewWriteContext
  & Pick<IAgentLifecycle, 'isWaiting' | 'isCompleted' | 'isCancelled'>
  & Pick<IChatServiceAccess, 'editCheckpointService' | 'ailyChatConfigService'>
  & Pick<IChatCoordination, 'session' | 'applyPendingSwitch'>
  & {
    syncExecutionRuntimeState?(saveTarget?: HostSessionSaveTarget | null): void;
    triggerAiEditDiffPreview?(summary: EditsSummary | null): void;
  };

type LexMessageLifecycleViewWriteAccess = Pick<
  ChatViewWriteBridge,
  'ensureTrailingAilyPartsMessageHandle'
>;

export interface LexTurnDraft {
  assistantText: string;
  toolCallCount: number;
  partCount: number;
}

/**
 * Handles assistant message lifecycle concerns for the lex stream path.
 *
 * Keeps message creation, native thinking state, Parts -> content rebuild,
 * and finalize side effects out of LexOwnerFacade.
 */
export class LexMessageLifecycleBridge {
  /** 原生 thinking 事件是否已开启（已输出 <think> 标签，等待闭合） */
  private _nativeThinkStarted = false;
  /** 当前 aily 消息引用；msgIndex 仅在需要写回 partStore 时即时解析 */
  private _currentMessage: ChatListItem | null = null;
  private readonly viewWriteBridge: LexMessageLifecycleViewWriteAccess;

  constructor(
    private readonly ctx: LexMessageLifecycleContext,
    private readonly partProcessor: { reset(): void; finalize?(): void },
    private readonly runFinalizeCompaction?: () => Promise<boolean> | boolean,
    private readonly finalizeCurrentTurnResponse?: (fallbackStatus?: TurnResponseStatus) => boolean,
    private readonly readCurrentTurnResponses?: () => readonly TurnResponseTurn[] | null | undefined,
  ) {
    const viewWriteContext: LexMessageLifecycleViewWriteContext = {
      get list() {
        return ctx.list;
      },
      set list(list) {
        ctx.list = list;
      },
      get partStore() {
        return ctx.partStore;
      },
      get viewAdapter() {
        return ctx.viewAdapter;
      },
      get scrollManager() {
        return ctx.scrollManager;
      },
      get invalidateHostRequestGraph() {
        return ctx.invalidateHostRequestGraph;
      },
      get triggerSyncDetectChanges() {
        return ctx.triggerSyncDetectChanges;
      },
      get sessionId() {
        return ctx.sessionId;
      },
      get chatHistoryService() {
        return ctx.chatHistoryService;
      },
      get currentModelName() {
        return ctx.currentModelName;
      },
      get currentMessageSource() {
        return ctx.currentMessageSource;
      },
      get ngZone() {
        return ctx.ngZone;
      },
    };
    this.viewWriteBridge = new ChatViewWriteBridge(viewWriteContext);
  }

  get currentMessageHandle(): ChatMessageHandle<ChatListItem> | null {
    return this._currentMessage
      ? findChatMessageHandleByMessage(this.ctx.list, this._currentMessage, { role: 'aily' })
      : null;
  }

  startNativeThinking(): void {
    if (!this._nativeThinkStarted) {
      this._nativeThinkStarted = true;
    }
  }

  closeNativeThinking(): void {
    if (this._nativeThinkStarted) {
      this._nativeThinkStarted = false;
    }
  }

  resetTurnState(): void {
    this.closeNativeThinking();
    this._currentMessage = null;
    this.partProcessor.reset();
  }

  getCurrentTurnDraft(): LexTurnDraft {
    const handle = this.currentMessageHandle;
    if (!handle) {
      return { assistantText: '', toolCallCount: 0, partCount: 0 };
    }

    const parts = this.ctx.partStore.getPartsForHandle(handle);
    let assistantText = '';
    let toolCallCount = 0;

    for (const part of parts) {
      if (part.type === 'markdown') {
        assistantText += part.content;
        continue;
      }

      if (this.isToolBearingPart(part)) {
        toolCallCount++;
      }
    }

    return { assistantText, toolCallCount, partCount: parts.length };
  }

  /**
   * ★ Phase 4: 预创建 aily 消息条目
    * 不再依赖 legacy appendMessage/appendStreaming 自动创建，而是在 turn 开始时显式推入空消息。
   * 同时处理 source 切换（subagent）— 自动为新 source 创建消息。
   *
    * ★ Phase 2: 所有 aily 消息统一走 Part-based 渲染，无需 useParts 标记。
    * 主发送路径和 regenerate 都统一走 ensureAilyMessage()。
   */
  ensureAilyMessage(turnId?: string): void {
    const handle = this.viewWriteBridge.ensureTrailingAilyPartsMessageHandle({
      source: this.ctx.currentMessageSource,
      state: 'doing',
      scrollOnCreate: true,
      turnId,
    });
    this._currentMessage = handle.message;
  }

  async finalize(saveTarget?: HostSessionSaveTarget | null): Promise<void> {
    const resolvedSaveTarget = saveTarget ? { ...saveTarget } : null;
    this.closeNativeThinking();
    await this.partProcessor.finalize?.();

    this.ctx.editCheckpointService.commitCurrentTurn();
    if (this.ctx.editCheckpointService.hasEditsInCurrentTurn()) {
      const summary = await this.ctx.editCheckpointService.getEditsSummary();
      const autoSave = this.ctx.ailyChatConfigService.autoSaveEdits;
      this.ctx.triggerAiEditDiffPreview?.(summary);
      if (autoSave) {
        this.ctx.editCheckpointService.acceptAllAsBaseline();
        this.ctx.editCheckpointService.dismissSummary();
      } else {
        this.ctx.editCheckpointService.publishSummary(summary);
      }
    }

    this.ctx.viewAdapter.markLastMessageDone();

    try {
      await this.runFinalizeCompaction?.();
    } catch (error) {
      console.warn('[LexStream] finalize-time compaction failed:', error);
    }

    try {
      this.finalizeCurrentTurnResponse?.('completed');
    } catch (error) {
      console.warn('[LexStream] finalize current turn response failed:', error);
    }

    if (resolvedSaveTarget) {
      // Execution-owned save targets already carry the authoritative session-scoped
      // turnResponses. Do not let visible-bridge snapshots overwrite detached owner truth.
      const candidateTurnResponses = Array.isArray(resolvedSaveTarget.turnResponses)
        ? resolvedSaveTarget.turnResponses
        : this.readCurrentTurnResponses?.();
      if (Array.isArray(candidateTurnResponses)) {
        resolvedSaveTarget.turnResponses = this.normalizeTerminalTurnResponses(candidateTurnResponses);
      }
    }

    this.ctx.session.saveCurrentSession(resolvedSaveTarget ? { target: resolvedSaveTarget } : undefined);
    this.ctx.syncExecutionRuntimeState?.(resolvedSaveTarget);

    if (!AilyHost.get().electron?.isWindowFocused()) {
      AilyHost.get().electron?.notify('Aily', '对话已完成');
    }

    await this.ctx.applyPendingSwitch(resolvedSaveTarget?.sessionId);
    this.ctx.ngZone.run(() => {
      this.ctx.isWaiting = false;
      this.ctx.isCompleted = true;
    });
  }

  private normalizeTerminalTurnResponses(turnResponses: readonly TurnResponseTurn[]): TurnResponseTurn[] {
    const fallbackStatus: TurnResponseStatus = this.ctx.isCancelled ? 'cancelled' : 'completed';
    let hasStreaming = false;
    for (const turn of turnResponses) {
      if (turn?.response?.status === 'streaming') {
        hasStreaming = true;
        break;
      }
    }

    if (!hasStreaming) {
      return [...turnResponses];
    }

    const now = Date.now();
    return turnResponses.map((turn) => {
      if (turn?.response?.status !== 'streaming') {
        return turn;
      }

      return {
        ...turn,
        updatedAt: now,
        response: {
          ...turn.response,
          status: fallbackStatus,
          updatedAt: now,
        },
      };
    });
  }

  private isToolBearingPart(part: ChatPart): boolean {
    return part.type === 'tool_call';
  }
}