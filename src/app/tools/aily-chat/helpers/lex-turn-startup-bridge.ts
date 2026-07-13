import type { TurnRequest } from 'aily-lex/browser';
import { readTurnRequestModeInfo, resolveTurnRequestModeCustomAgentTarget } from 'aily-lex/browser';
import type { IAgentLifecycle, IChatServiceAccess, IChatViewAccess, ISessionAccess } from '../core/chat-context';
import type { IProjectContext } from '../core/chat-context';
import { MAIN_AGENT_TYPE, normalizeAgentIdentifier } from '../core/agent-identifiers';

type LexTurnStartupContext = Pick<
  IAgentLifecycle,
  'isCompleted' | 'isCancelled' | 'isWaiting' | 'currentMessageSource' | 'toolCallingIteration'
> & Pick<IChatViewAccess, 'list' | 'scrollManager'>
  & Pick<ISessionAccess, 'sessionId'>
  & Pick<IProjectContext, 'currentModel' | 'prjPath' | 'prjRootPath'>
  & Pick<IChatServiceAccess, 'repetitionDetectionService' | 'ailyChatConfigService' | 'contextBudgetService'>
  & {
    readonly editTracking: {
      autoSaveEdits: boolean;
      setTimelineContext(sessionId: string | null | undefined, workspaceRoot: string | null | undefined): void;
      startTurn(
        turnIndex: number,
        turnStartListIndex: number | null,
        responseStartListIndex: number | null,
        turnId?: string,
        requestContent?: string,
        displayContent?: string,
        checkpointId?: string,
        requestMetadata?: unknown,
      ): void;
    };
    readonly turnStartupEditLifecycle: {
      ensureAbsExport(sessionId: string | null | undefined): void;
      saveCheckpointToDisk(sessionId: string | null | undefined): void;
    };
    resolveActiveRuntimeSessionId?(): string | null | undefined;
    readCurrentViewSessionResource?(): string | null;
    suppressVisibleTurnStartupProjection?: boolean;
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
    private readonly startTurn: (
      userMessage: string,
      displayContent?: string,
      metadata?: TurnRequest['metadata'],
      options?: { readonly turnId?: string },
    ) => string | undefined,
    private readonly seedPendingTurn: (turnId: string, userMessage: string, displayContent?: string, metadata?: TurnRequest['metadata']) => void,
    private readonly ensureResponseItem: (turnId?: string) => void,
    private readonly getConversationMessages: () => any[],
    private readonly getCurrentTools: () => any[],
    private readonly getCurrentTurnIndex: () => number | undefined,
  ) {}

  private createCheckpointId(): string {
    return `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeCheckpointId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
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

  private buildFreshTurnMetadata(requestMetadata?: TurnRequest['metadata']): TurnRequest['metadata'] {
    const metadata: Record<string, unknown> = {
      ...this.buildTurnModelDisplayMetadata(),
      ...(requestMetadata ?? {}),
    };
    delete metadata['checkpointNamespace'];
    delete metadata['checkpointTurnIndex'];
    delete metadata['startCheckpointRef'];
    delete metadata['checkpointRef'];
    delete metadata['checkpointRefs'];
    delete metadata['additionalStartCheckpointRefs'];
    delete metadata['additionalCheckpointRefs'];
    metadata['checkpointId'] = this.normalizeCheckpointId(metadata['checkpointId']) || this.createCheckpointId();
    return metadata as TurnRequest['metadata'];
  }

  private resolveCurrentTurnIndex(): number {
    const index = this.getCurrentTurnIndex();
    return typeof index === 'number' && Number.isFinite(index) && index >= 0 ? index : 0;
  }

  beginMainAgentTurn(
    userMessage: string,
    displayContent?: string,
    requestMetadata?: TurnRequest['metadata'],
    options?: { readonly turnId?: string },
  ): string | undefined {
    const nextRequestMetadata = this.buildFreshTurnMetadata(requestMetadata);
    const turnId = this.startTurn(userMessage, displayContent, nextRequestMetadata, options);
    const turnIndex = this.resolveCurrentTurnIndex();
    (nextRequestMetadata as Record<string, unknown>)['checkpointTurnIndex'] = turnIndex + 1;
    const activeRuntimeSessionId = typeof this.ctx.resolveActiveRuntimeSessionId === 'function'
      ? this.ctx.resolveActiveRuntimeSessionId()?.trim()
      : '';
    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const visibleSessionId = typeof currentViewSessionResource === 'string' && currentViewSessionResource.trim().length > 0
      ? currentViewSessionResource.trim()
      : typeof this.ctx.sessionId === 'string'
        ? this.ctx.sessionId.trim()
        : '';
    const resourceSessionId = activeRuntimeSessionId || visibleSessionId;
    const isDetachedRuntimeOwner = !!activeRuntimeSessionId
      && !!visibleSessionId
      && activeRuntimeSessionId !== visibleSessionId;
    const shouldProjectVisibleStartup = !isDetachedRuntimeOwner
      && this.ctx.suppressVisibleTurnStartupProjection !== true;

    if (turnId && shouldProjectVisibleStartup) {
      this.attachTurnIdToLatestUserMessage(turnId);
    }

    this.ctx.isCompleted = false;
    this.ctx.isCancelled = false;
    this.ctx.isWaiting = true;
    this.ctx.currentMessageSource = this.resolveInitialMessageSource(nextRequestMetadata);
    this.ctx.toolCallingIteration = 0;
    this.ctx.repetitionDetectionService.resetStreamTokens();

    if (turnId && shouldProjectVisibleStartup) {
      this.seedPendingTurn(turnId, userMessage, displayContent, nextRequestMetadata);
    }

    if (shouldProjectVisibleStartup) {
      this.ensureResponseItem(turnId);
    }

    this.ctx.turnStartupEditLifecycle.ensureAbsExport(resourceSessionId);
    this.ctx.editTracking.autoSaveEdits = this.ctx.ailyChatConfigService.autoSaveEdits;
    this.ctx.turnStartupEditLifecycle.saveCheckpointToDisk(resourceSessionId);

    const conversationMessages = this.getConversationMessages();
    const workspaceRoot = this.ctx.prjPath || this.ctx.prjRootPath || null;
    this.ctx.editTracking.setTimelineContext(
      resourceSessionId || null,
      workspaceRoot,
    );

    const responseStartListIndex = shouldProjectVisibleStartup
      ? this.ctx.list.length - 1
      : null;
    const turnStartListIndex = responseStartListIndex !== null
      ? responseStartListIndex > 0
        ? responseStartListIndex - 1
        : responseStartListIndex
      : null;
    this.ctx.editTracking.startTurn(
      turnIndex,
      turnStartListIndex,
      responseStartListIndex,
      turnId,
      userMessage,
      displayContent,
      nextRequestMetadata.checkpointId,
      nextRequestMetadata,
    );
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
    if (shouldProjectVisibleStartup) {
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
