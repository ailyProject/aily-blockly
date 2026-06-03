import type { TurnRequest } from 'aily-lex/browser';
import { readTurnRequestModeInfo, resolveTurnRequestModeCustomAgentTarget } from 'aily-lex/browser';
import type { IAgentLifecycle, IChatCoordination, IChatServiceAccess, IChatViewAccess, ISessionAccess } from '../core/chat-context';
import type { IProjectContext } from '../core/chat-context';
import { MAIN_AGENT_TYPE, normalizeAgentIdentifier } from '../core/agent-identifiers';

type LexTurnStartupContext = Pick<
  IAgentLifecycle,
  'isCompleted' | 'isCancelled' | 'isWaiting' | 'currentMessageSource' | 'toolCallingIteration'
> & Pick<IChatViewAccess, 'list' | 'scrollManager'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IProjectContext, 'currentModel' | 'prjPath' | 'prjRootPath'>
  & Pick<IChatServiceAccess, 'repetitionDetectionService' | 'editCheckpointService' | 'ailyChatConfigService' | 'contextBudgetService'>
  & Pick<IChatCoordination, 'editActions'>
  & {
    resolveActiveRuntimeSessionId?(): string | null | undefined;
  };

/**
 * Handles host-side main-agent turn startup orchestration.
 *
 * Keeps waiting/source/checkpoint/budget side effects out of ChatEngineService
 * and trims LexOwnerFacade down to runtime delegation.
 */
export class LexTurnStartupBridge {
  constructor(
    private readonly ctx: LexTurnStartupContext,
    private readonly startTurn: (userMessage: string, displayContent?: string, metadata?: TurnRequest['metadata']) => string | undefined,
    private readonly seedPendingTurn: (turnId: string, userMessage: string, displayContent?: string, metadata?: TurnRequest['metadata']) => void,
    private readonly ensureAilyMessage: () => void,
    private readonly getConversationMessages: () => any[],
    private readonly getCurrentTools: () => any[],
  ) {}

  private createCheckpointId(): string {
    return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private shouldRefreshLocalEstimate(): boolean {
    const snapshot = this.ctx.contextBudgetService.getSnapshot();
    return snapshot.currentTokens <= 0 || snapshot.maxContextTokens <= 0;
  }

  private shouldKeepEmptyBudgetSnapshot(conversationMessages: any[]): boolean {
    if (!Array.isArray(conversationMessages) || conversationMessages.length !== 1) {
      return false;
    }

    const [firstMessage] = conversationMessages;
    return firstMessage?.role === 'user';
  }

  private resolveInitialMessageSource(requestMetadata?: TurnRequest['metadata']): string {
    if (requestMetadata?.['explicitAgentInvocation']) {
      return MAIN_AGENT_TYPE;
    }
    const modeInfo = readTurnRequestModeInfo(requestMetadata);
    const requestRouting = requestMetadata?.['requestRouting'] && typeof requestMetadata['requestRouting'] === 'object' && !Array.isArray(requestMetadata['requestRouting'])
      ? requestMetadata['requestRouting'] as { readonly customAgentTarget?: unknown }
      : undefined;
    const agentId = typeof requestRouting?.customAgentTarget === 'string'
      ? normalizeAgentIdentifier(requestRouting.customAgentTarget)
      : resolveTurnRequestModeCustomAgentTarget(modeInfo)
        ?? '';
    return agentId || MAIN_AGENT_TYPE;
  }

  private buildTurnModelDisplayMetadata(): TurnRequest['metadata'] {
    const selectedModel = this.ctx.currentModel;
    const modelDisplayName = typeof selectedModel?.name === 'string' && selectedModel.name.trim()
      ? selectedModel.name.trim()
      : undefined;
    const modelDisplayBillingLabel = typeof this.ctx.ailyChatConfigService.getModelBillingLabel === 'function'
      ? this.ctx.ailyChatConfigService.getModelBillingLabel(selectedModel)
      : undefined;
    const modelPresetId = typeof selectedModel?.presetId === 'string' && selectedModel.presetId.trim()
      ? selectedModel.presetId.trim()
      : undefined;

    return {
      ...(modelDisplayName ? { modelDisplayName } : {}),
      ...(modelDisplayBillingLabel ? { modelDisplayBillingLabel } : {}),
      ...(modelPresetId ? { modelPresetId } : {}),
    };
  }

  beginMainAgentTurn(
    userMessage: string,
    displayContent?: string,
    requestMetadata?: TurnRequest['metadata'],
  ): string | undefined {
    const nextRequestMetadata: TurnRequest['metadata'] = {
      checkpointId: this.createCheckpointId(),
      ...this.buildTurnModelDisplayMetadata(),
      ...(requestMetadata ?? {}),
    };
    const turnId = this.startTurn(userMessage, displayContent, nextRequestMetadata);
    const activeRuntimeSessionId = typeof this.ctx.resolveActiveRuntimeSessionId === 'function'
      ? this.ctx.resolveActiveRuntimeSessionId()?.trim()
      : '';
    const visibleSessionId = typeof this.ctx.sessionId === 'string'
      ? this.ctx.sessionId.trim()
      : '';
    const isDetachedRuntimeOwner = !!activeRuntimeSessionId
      && !!visibleSessionId
      && activeRuntimeSessionId !== visibleSessionId;

    if (turnId && !isDetachedRuntimeOwner) {
      this.attachTurnIdToLatestUserMessage(turnId);
    }

    this.ctx.isCompleted = false;
    this.ctx.isCancelled = false;
    this.ctx.isWaiting = true;
    this.ctx.currentMessageSource = this.resolveInitialMessageSource(nextRequestMetadata);
    this.ctx.toolCallingIteration = 0;
    this.ctx.repetitionDetectionService.resetStreamTokens();

    if (turnId && !isDetachedRuntimeOwner) {
      this.seedPendingTurn(turnId, userMessage, displayContent, nextRequestMetadata);
    }

    if (!isDetachedRuntimeOwner) {
      this.ensureAilyMessage();
    }

    this.ctx.editActions.ensureAbsExport();
    this.ctx.editCheckpointService.autoSaveEdits = this.ctx.ailyChatConfigService.autoSaveEdits;
    this.ctx.editActions.saveCheckpointToDisk();

    const conversationMessages = this.getConversationMessages();
    const workspaceRoot = this.ctx.prjPath || this.ctx.prjRootPath || null;
    this.ctx.editCheckpointService.setTimelineContext(
      this.ctx.sessionId || null,
      workspaceRoot,
    );

    if (!isDetachedRuntimeOwner) {
      const responseStartListIndex = this.ctx.list.length - 1;
      const turnStartListIndex = responseStartListIndex > 0
        ? responseStartListIndex - 1
        : responseStartListIndex;
      this.ctx.editCheckpointService.startTurn(
        0,
        turnStartListIndex,
        responseStartListIndex,
        turnId,
        userMessage,
        displayContent,
        nextRequestMetadata.checkpointId,
      );
    }
    if (this.shouldRefreshLocalEstimate()) {
      if (this.shouldKeepEmptyBudgetSnapshot(conversationMessages)) {
        this.ctx.contextBudgetService.reset();
      } else {
        this.ctx.contextBudgetService.refreshLocalEstimate(
          conversationMessages,
          this.getCurrentTools(),
        );
      }
    }
    if (!isDetachedRuntimeOwner) {
      this.ctx.scrollManager.setScrollLock(true);
    }

    return turnId;
  }

  private attachTurnIdToLatestUserMessage(turnId: string): void {
    for (let index = this.ctx.list.length - 1; index >= 0; index--) {
      const message = this.ctx.list[index];
      if (message.role === 'user') {
        message.turnId = turnId;
        return;
      }
    }
  }
}
