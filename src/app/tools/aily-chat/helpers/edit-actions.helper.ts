/**
 * EditActionsHelper �?编辑操作辅助�?
 *
 * 封装所有与文件编辑检查点相关的操作：
 * - undo / redo / accept / reject 单文件操�?
 * - restoreToCheckpoint（还原到指定对话检查点�?
 * - editAndResendFromTurn（编辑并重发�?
 * - regenerateTurn（重新生成）
 * - reloadAbsWorkspace（内部辅助）
 *
 * �?ChatEngineService 中提取（Phase 4），减轻后者的体积�?
 */

import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import { AilyHost } from '../core/host';
import { ChatViewWriteBridge, type ChatViewWriteBridgeContext } from './chat-view-write-bridge';
import type { TurnRequest, TurnResponseTurn } from 'aily-lex/browser';
import type { ResourceItem } from '../core/chat-types';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import {
  buildDialogTurnContext,
  getInteractionDisplayContent,
  getInteractionLastRoundId,
  getInteractionRequestContent,
  getInteractionRoundCount,
  getInteractionRounds,
  getInteractionToolCallCount,
  toDialogTurnContext,
  type DialogTurnContext,
  type LegacyTurnInteractionMetadata,
} from '../core/user-turn-action-target';
import { extractUserTurnResources, mergeUserTurnResources } from './chat-user-turn-context';
import type { ChatTaskActionDetail } from './chat-task-action-coordinator';
import type { TurnSnapshot } from '../services/edit-checkpoint.service';
import type { IWorkspaceCheckpointProvider } from '../services/edit-checkpoint.service';
import type {
  ChatSessionRequestListTransactionResult,
} from '../services/chat-session-model-store.service';
import {
  type HostResponseProjection,
  type HostTurnResponseState,
} from './host-turn-response-state';
import {
  CheckpointReplayCoordinator,
  type CheckpointRedoExecutionResult,
} from './checkpoint-replay-coordinator';
import {
  canRedoSessionCheckpointTimeline,
  type SessionCheckpointTimelineState,
} from './session-checkpoint-timeline-model';

export interface EditActionTurnTarget extends Partial<LegacyTurnInteractionMetadata>, Partial<DialogTurnContext> {}

export interface RestoreCheckpointConfirmation {
  requestCount: number;
  fileCount: number;
  fileLabel?: string;
}

type WorkspaceCheckpointAccess = Partial<Pick<
  IWorkspaceCheckpointProvider,
  'buildRestorePlan' | 'buildRedoPlan' | 'applyRestorePlan' | 'getPresentationMode'
>>;

type EditActionsContext = ChatViewWriteBridgeContext
  & Pick<IChatViewAccess, 'inputValue'>
  & Pick<IAgentLifecycle, 'isWaiting' | 'isCompleted' | 'isCancelled' | 'pendingEditFeedback'>
  & Pick<ISessionAccess, 'sessionAllowedPaths' | 'conversationMessages'>
  & Pick<IProjectContext, 'getCurrentProjectPath'>
  & Pick<IChatServiceAccess, 'absAutoSyncService' | 'editCheckpointService' | 'resourceManager' | 'message'>
  & Pick<IChatCoordination, 'lexStream' | 'send' | 'session'>
  & {
    workspaceCheckpointAccess?: WorkspaceCheckpointAccess;
    confirmRestoreCheckpoint?(confirmation: RestoreCheckpointConfirmation): Promise<boolean> | boolean;
    syncWorkspaceState?(): Promise<void> | void;
    buildExecutionSaveTarget?(sessionId: string | null | undefined): HostSessionSaveTarget | null;
    readCurrentViewSessionResource?(): string | null | undefined;
    readSessionTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[];
    replaceSessionModelTurnResponses?(
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[],
      ownerPolicy?: { readonly allowForkedTurns?: boolean; readonly source?: string },
    ): readonly TurnResponseTurn[] | null | undefined;
    submitRegeneratedUserTurn?(
      sessionId: string,
      request: {
        readonly requestText: string;
        readonly displayText?: string;
        readonly requestMetadata?: TurnRequest['metadata'];
      },
    ): Promise<void> | void;
    prepareProtocolTruncationForResend?(
      sessionId: string,
      turnId: string,
    ): Promise<boolean> | boolean;
    cancelCurrentRequestForSession?(
      sessionResource: string,
      source: 'regenerate',
    ): Promise<boolean> | boolean;
    readonly hostResponseProjection?: HostResponseProjection | null;
    restoreSharedHostProjectionState?(
      state: HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    replaceSharedHostProjectionState?(
      state: HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    projectRestoredHostProjection?(
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      hostProjectionState: HostTurnResponseState,
      options?: { readonly attachedView?: boolean },
    ): void;
    readSessionCheckpointTimelineState?(sessionId: string | null | undefined): SessionCheckpointTimelineState | null;
    commitCheckpointRestoreRequestListTransaction?(
      sessionId: string | null | undefined,
      checkpointId: string | null | undefined,
    ): Promise<ChatSessionRequestListTransactionResult | null | undefined> | ChatSessionRequestListTransactionResult | null | undefined;
    commitCheckpointRestoreByIdentity?(
      sessionId: string | null | undefined,
      checkpointId: string,
    ): Promise<unknown | null | undefined> | unknown | null | undefined;
    rollbackCheckpointRestoreRequestListTransaction?(
      sessionId: string | null | undefined,
      committed: ChatSessionRequestListTransactionResult | null | undefined,
    ): ChatSessionRequestListTransactionResult | null | undefined;
    commitCheckpointRedo?(
      sessionId: string | null | undefined,
      checkpointId?: string | null,
    ): Promise<unknown | null | undefined> | unknown | null | undefined;
    operateEditingSessionEntry?(
      sessionId: string,
      uri: string,
      action: 'accept' | 'reject',
    ): Promise<void>;
    acceptEditingSession?(sessionId: string): Promise<void>;
    undoEditingSessionInteraction?(sessionId: string): Promise<void>;
    redoEditingSessionInteraction?(sessionId: string): Promise<void>;
    applyRequestListTransactionEffects?(
      sessionId: string,
      transaction: ChatSessionRequestListTransactionResult,
      options?: { readonly persist?: boolean },
    ): void;
  };

type EditActionsViewWriteContext = ConstructorParameters<typeof ChatViewWriteBridge>[0];

type EditActionsViewWriteAccess = Pick<
  ChatViewWriteBridge,
  'appendAilyPartsMessageHandle' | 'truncateFromTurnId' | 'truncateFrom' | 'restoreLegacyHistoryList' | 'restoreTurnNativeHistoryList'
>;

export class EditActionsHelper {
  private readonly viewWriteBridge: EditActionsViewWriteAccess;
  private readonly checkpointReplayCoordinator: CheckpointReplayCoordinator;

  constructor(private ctx: EditActionsContext) {
    this.ctx.syncWorkspaceState = this.reloadAbsWorkspace.bind(this);

    const viewWriteContext: EditActionsViewWriteContext = {
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
      markHistoryDirty: (sessionId) => ctx.markHistoryDirty(sessionId),
      get currentModelName() {
        return ctx.currentModelName;
      },
      get currentMessageSource() {
        return ctx.currentMessageSource;
      },
      get ngZone() {
        return ctx.ngZone;
      },
      markCurrentViewVisibleProjectionOwner: () => ctx.markCurrentViewVisibleProjectionOwner(),
      legacyListProjectionBoundary: 'edit-action-result',
    };
    this.viewWriteBridge = new ChatViewWriteBridge(viewWriteContext);
    this.checkpointReplayCoordinator = new CheckpointReplayCoordinator(this.ctx, this.viewWriteBridge);
  }

  hasCheckpointTimelineRedo(): boolean {
    return canRedoSessionCheckpointTimeline(this.readCurrentSessionCheckpointTimelineState());
  }

  // ==================== 内部辅助 ====================

  /**
   * 回滚/还原后重新同�?ABS �?Blockly 工作区�?
   */
  private async reloadAbsWorkspace(): Promise<void> {
    const projectPath = this.ctx.getCurrentProjectPath()
      || AilyHost.get().project.currentProjectPath
      || AilyHost.get().project.projectRootPath;
    if (projectPath) {
      this.ctx.absAutoSyncService.initialize(projectPath);
    }
    try {
      const imported = await this.ctx.ngZone.runOutsideAngular(
        () => this.ctx.absAutoSyncService.forceImportFromAbs(),
      );
      if (!imported) {
        console.warn('[reloadAbsWorkspace] ABS workspace presentation was not reloaded.');
      }
    } catch (error) {
      console.warn('[reloadAbsWorkspace] ABS workspace presentation reload failed:', error);
    }
  }

  private async restoreCheckpointSnapshot(
    snapshot: TurnSnapshot,
    options: {
      sessionResource?: string;
      turnId?: string;
      listIndex?: number;
      emitResultMessage?: boolean;
      captureRedoTurns?: boolean;
      truncateLiveTurnResponses?: boolean;
    } = {},
  ): Promise<boolean> {
    const {
      sessionResource: explicitSessionResource,
      turnId,
      listIndex,
      emitResultMessage = true,
      captureRedoTurns = true,
      truncateLiveTurnResponses = true,
    } = options;
    const sessionResource = this.resolveCurrentSessionResource(explicitSessionResource);
    const truncatedTurnId = turnId ?? snapshot.turnId;
    const liveTurnResponses = this.readCurrentSessionTurnResponses(sessionResource);
    console.info('[AilyChat][CheckpointRestoreTrace]', {
      phase: 'ui-restore-submit',
      sessionId: sessionResource,
      checkpointId: snapshot.checkpointId,
      snapshotTurnId: snapshot.turnId ?? null,
      optionTurnId: turnId ?? null,
      truncatedTurnId: truncatedTurnId ?? null,
      listIndex: typeof listIndex === 'number' ? listIndex : null,
      captureRedoTurns,
      truncateLiveTurnResponses,
      liveTurnIds: liveTurnResponses.map(turn => turn.turnId ?? null),
      liveCheckpointIds: liveTurnResponses.map(turn => turn.request?.metadata?.checkpointId ?? null),
    });
    const restoreResult = await this.checkpointReplayCoordinator.restoreCheckpointByIdentity(
      snapshot.checkpointId,
      async () => {
        const committed = await this.ctx.commitCheckpointRestoreByIdentity?.(sessionResource, snapshot.checkpointId);
        if (!committed) {
          throw new Error('Checkpoint restore host commit did not return a result');
        }
        return committed;
      },
    );

    if (restoreResult.ok === false) {
      console.warn('[restoreToCheckpoint] 回滚文件部分失败:', restoreResult.detailErrors);

      if (emitResultMessage) {
        this.checkpointReplayCoordinator.projectRestoreExecutionResult(restoreResult);
      }
      return false;
    }

    if (!emitResultMessage) {
      return true;
    }

    this.checkpointReplayCoordinator.projectRestoreExecutionResult(restoreResult);

    return true;
  }

  private restoreCheckpointRequestToInput(resolved: {
    listIndex: number | undefined;
    requestContent: string | undefined;
    displayContent: string | undefined;
  }): void {
    if (this.isFirstVisibleUserTurnIndex(resolved.listIndex)) {
      return;
    }

    const inputText = resolved.displayContent ?? resolved.requestContent ?? '';
    if (!inputText.trim()) {
      return;
    }

    this.ctx.inputValue = inputText;
    this.ctx.triggerSyncDetectChanges?.();
  }

  private isFirstVisibleUserTurnIndex(listIndex: number | undefined): boolean {
    if (typeof listIndex !== 'number' || listIndex < 0) {
      return false;
    }

    const firstUserIndex = this.ctx.list.findIndex(message => message.role === 'user' && !!message.turnId);
    return firstUserIndex >= 0 && firstUserIndex === listIndex;
  }

  private toCanonicalTurnContext(target: EditActionTurnTarget | null | undefined): DialogTurnContext | null {
    if (!target) {
      return null;
    }

    const turnResponse = target.turnResponse ?? null;
    const request = target.request ?? turnResponse?.request ?? undefined;
    const canonical = buildDialogTurnContext({
      turnId: turnResponse?.turnId ?? target.turnId,
      turnResponse,
      request,
      response: target.response ?? turnResponse?.response ?? undefined,
      rounds: target.rounds ?? turnResponse?.rounds,
      requestContent: request?.content ?? target.requestContent,
      displayContent: request?.displayContent ?? target.displayContent ?? request?.content ?? target.requestContent,
    });

    if (!canonical) {
      return null;
    }

    return {
      ...canonical,
      lastRoundId: canonical.rounds.at(-1)?.id ?? target.lastRoundId ?? canonical.lastRoundId,
    };
  }

  private withResolvedTurnTarget(
    target: EditActionTurnTarget | null | undefined,
    overrides: {
      turnId?: string;
      requestContent?: string;
      displayContent?: string;
      lastRoundId?: string;
    },
  ): EditActionTurnTarget {
    const canonical = this.toCanonicalTurnContext(target);
    const rebuilt = buildDialogTurnContext({
      turnId: overrides.turnId ?? canonical?.turnId ?? target?.turnId,
      turnResponse: canonical?.turnResponse ?? target?.turnResponse ?? null,
      request: canonical?.request,
      response: canonical?.response,
      rounds: canonical?.rounds,
      requestContent: overrides.requestContent ?? canonical?.requestContent ?? target?.requestContent,
      displayContent: overrides.displayContent ?? canonical?.displayContent ?? target?.displayContent,
    });

    if (rebuilt) {
      return {
        ...rebuilt,
        lastRoundId: overrides.lastRoundId ?? canonical?.lastRoundId ?? rebuilt.lastRoundId,
      };
    }

    return {
      ...(target ?? {}),
      turnId: overrides.turnId ?? target?.turnId,
      requestContent: overrides.requestContent ?? target?.requestContent,
      displayContent: overrides.displayContent ?? target?.displayContent,
      lastRoundId: overrides.lastRoundId ?? target?.lastRoundId,
    };
  }

  private resolveTurnTarget(
    target: EditActionTurnTarget | null | undefined,
    explicitSessionResource?: string,
    explicitCheckpointId?: string,
  ): {
    snapshot: TurnSnapshot | undefined;
    listIndex: number | undefined;
    turnId: string | undefined;
    requestContent: string | undefined;
    displayContent: string | undefined;
    lastRoundId: string | undefined;
  } {
    const normalized = target ?? {};
    const liveTurnResponses = this.readCurrentSessionTurnResponses(explicitSessionResource);
    const isLiveTurnId = (turnId: string | undefined): turnId is string => !!turnId && (
      liveTurnResponses.some(turn => turn.turnId === turnId)
      || this.findTurnMessageIndex(turnId) !== undefined
    );
    const interactionContext = this.toCanonicalTurnContext(normalized);
    const targetRoundId = interactionContext?.lastRoundId
      ?? normalized.lastRoundId
      ?? getInteractionLastRoundId(normalized);
    const directTurnId = interactionContext?.turnId ?? normalized.turnId;
    const roundSnapshot = targetRoundId
      ? this.ctx.editCheckpointService.getSnapshotByRoundId?.(targetRoundId)
      : undefined;
    const roundTurnId = targetRoundId
      ? (roundSnapshot?.turnId ?? this.ctx.lexStream.turns.turnIdByRound(targetRoundId))
      : undefined;

    const directSnapshot = explicitCheckpointId
      ? this.ctx.editCheckpointService.getSnapshotByCheckpointId(explicitCheckpointId)
      : (directTurnId
          ? this.ctx.editCheckpointService.getSnapshotByTurnId(directTurnId)
          : undefined);
    const resolvedRoundSnapshot = directSnapshot ? undefined : (roundSnapshot ?? (roundTurnId
      ? this.ctx.editCheckpointService.getSnapshotByTurnId(roundTurnId)
      : undefined));
    const resolvedSnapshotCandidate = directSnapshot ?? resolvedRoundSnapshot;
    const resolvedSnapshot = !explicitCheckpointId
      && this.ctx.editCheckpointService.isSnapshotActive?.(resolvedSnapshotCandidate) === false
      ? undefined
      : resolvedSnapshotCandidate;
    const resolvedSnapshotTurnId = isLiveTurnId(directTurnId)
      ? directTurnId
      : (isLiveTurnId(roundTurnId) ? roundTurnId : resolvedSnapshot?.turnId);
    const snapshotContext = this.ctx.editCheckpointService.getTurnContextForSnapshot(
      resolvedSnapshot,
      resolvedSnapshotTurnId,
    );
    const resolvedTurnId = resolvedSnapshotTurnId ?? snapshotContext?.turnId;
    const listIndex = this.findTurnMessageIndex(resolvedTurnId)
      ?? (this.ctx.editCheckpointService.getTurnStartListIndexForSnapshot(resolvedSnapshot) ?? undefined);
    const requestContent = interactionContext?.requestContent
      ?? getInteractionRequestContent(normalized)
      ?? snapshotContext?.requestContent
      ?? (resolvedTurnId ? this.getSessionTurnRequestContent(resolvedTurnId, explicitSessionResource) : undefined);
    const displayContent = interactionContext?.displayContent
      ?? getInteractionDisplayContent(normalized)
      ?? snapshotContext?.displayContent
      ?? (resolvedTurnId ? this.getSessionTurnDisplayContent(resolvedTurnId, explicitSessionResource) : undefined);
    const lastRoundId = targetRoundId
      ?? snapshotContext?.lastRoundId
      ?? (resolvedTurnId ? this.getSessionTurnLastRoundId(resolvedTurnId, explicitSessionResource) : undefined);

    return {
      snapshot: resolvedSnapshot,
      listIndex,
      turnId: resolvedTurnId,
      requestContent,
      displayContent,
      lastRoundId,
    };
  }

  private async resolveTurnTargetWithCheckpointSync(
    target: EditActionTurnTarget | null | undefined,
    explicitSessionResource?: string,
    explicitCheckpointId?: string,
  ): Promise<{
    snapshot: TurnSnapshot | undefined;
    listIndex: number | undefined;
    turnId: string | undefined;
    requestContent: string | undefined;
    displayContent: string | undefined;
    lastRoundId: string | undefined;
  }> {
    let resolved = this.resolveTurnTarget(target, explicitSessionResource, explicitCheckpointId);
    if (resolved.snapshot || !this.ctx.editCheckpointService.rebuildFromTurnResponses) {
      return resolved;
    }

    const liveTurnResponses = this.readCurrentSessionTurnResponses(explicitSessionResource);
    if (liveTurnResponses.length === 0) {
      return resolved;
    }

    const sessionResource = this.resolveCurrentSessionResource(explicitSessionResource);
    this.ctx.editCheckpointService.setTimelineContext?.(
      sessionResource || null,
      this.ctx.getCurrentProjectPath?.()
        || AilyHost.get().project.currentProjectPath
        || AilyHost.get().project.projectRootPath
        || null,
    );
    await this.ctx.editCheckpointService.rebuildFromTurnResponses(liveTurnResponses);
    resolved = this.resolveTurnTarget(target, explicitSessionResource, explicitCheckpointId);
    return resolved;
  }

  private findTurnMessageIndex(turnId: string | undefined): number | undefined {
    if (!turnId) {
      return undefined;
    }

    const userIndex = this.ctx.list.findIndex(message => message.role === 'user' && message.turnId === turnId);
    if (userIndex >= 0) {
      return userIndex;
    }

    const assistantIndex = this.ctx.list.findIndex(message => message.turnId === turnId);
    return assistantIndex >= 0 ? assistantIndex : undefined;
  }

  private readCurrentSessionTurnResponses(explicitSessionResource?: string): readonly TurnResponseTurn[] {
    const sessionId = this.resolveCurrentSessionResource(explicitSessionResource);
    return sessionId ? this.ctx.readSessionTurnResponses(sessionId) : [];
  }

  private findSessionTurnResponse(
    turnId: string | null | undefined,
    explicitSessionResource?: string,
  ): TurnResponseTurn | undefined {
    const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (!normalizedTurnId) {
      return undefined;
    }

    return this.readCurrentSessionTurnResponses(explicitSessionResource).find(turn => turn.turnId === normalizedTurnId);
  }

  private getLatestRegenerableTurnContext(): DialogTurnContext | null {
    const turns = this.readCurrentSessionTurnResponses();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const content = typeof turn?.request?.content === 'string' ? turn.request.content.trim() : '';
      if (!content) {
        continue;
      }
      return buildDialogTurnContext({ turnResponse: turn });
    }
    return null;
  }

  private getSessionTurnRequestContent(
    turnId: string | null | undefined,
    explicitSessionResource?: string,
  ): string | undefined {
    const turn = this.findSessionTurnResponse(turnId, explicitSessionResource);
    return typeof turn?.request?.content === 'string'
      ? turn.request.content
      : undefined;
  }

  private getSessionTurnDisplayContent(
    turnId: string | null | undefined,
    explicitSessionResource?: string,
  ): string | undefined {
    const turn = this.findSessionTurnResponse(turnId, explicitSessionResource);
    return typeof turn?.request?.displayContent === 'string'
      ? turn.request.displayContent
      : this.getSessionTurnRequestContent(turnId, explicitSessionResource);
  }

  private getSessionTurnLastRoundId(
    turnId: string | null | undefined,
    explicitSessionResource?: string,
  ): string | undefined {
    const turn = this.findSessionTurnResponse(turnId, explicitSessionResource);
    return turn?.rounds?.at(-1)?.id;
  }

  private getTurnRoundExecutionContext(rounds: EditActionTurnTarget['rounds'] | undefined): {
    toolBearingRoundCount: number;
    lastRoundId: string | null;
    lastAssistantPreview: string | null;
  } {
    const resolvedRounds = rounds ?? [];
    const toolBearingRoundCount = resolvedRounds.reduce(
      (count, round) => count + (round.toolCalls.length > 0 ? 1 : 0),
      0,
    );

    let lastAssistantPreview: string | null = null;
    for (let index = resolvedRounds.length - 1; index >= 0; index--) {
      const normalized = resolvedRounds[index].assistantText.replace(/\s+/g, ' ').trim();
      if (normalized) {
        lastAssistantPreview = normalized.length > 96
          ? `${normalized.slice(0, 96).trimEnd()}...`
          : normalized;
        break;
      }
    }

    return {
      toolBearingRoundCount,
      lastRoundId: resolvedRounds.at(-1)?.id ?? null,
      lastAssistantPreview,
    };
  }

  private describeTurnExecution(target: EditActionTurnTarget): {
    segments: string[];
    detailText: string;
  } | null {
    const rounds = getInteractionRounds(target);
    const roundCount = getInteractionRoundCount(target);
    const toolCallCount = getInteractionToolCallCount(target);
    const roundContext = this.getTurnRoundExecutionContext(rounds);
    const lastRoundId = getInteractionLastRoundId(target) ?? roundContext.lastRoundId;

    if (roundCount <= 0 && toolCallCount <= 0 && !lastRoundId && !roundContext.lastAssistantPreview) {
      return null;
    }

    const segments: string[] = [];
    if (roundCount > 0) {
      segments.push(`${roundCount} 轮执行`);
    }
    if (roundContext.toolBearingRoundCount > 0) {
      segments.push(`${roundContext.toolBearingRoundCount} 个工具轮次`);
    }
    if (toolCallCount > 0) {
      segments.push(`${toolCallCount} 次工具调用`);
    }
    if (segments.length === 0) {
      segments.push('历史执行');
    }

    const details: string[] = [];
    if (lastRoundId) {
      details.push(`最后执行锚点为 ${lastRoundId}`);
    }
    if (roundContext.lastAssistantPreview) {
      details.push(`上一轮 assistant 已执行到“${roundContext.lastAssistantPreview}”`);
    }

    return {
      segments,
      detailText: details.length > 0 ? `${details.join('；')}。` : '',
    };
  }

  private buildEditResendFeedback(target: EditActionTurnTarget): string | null {
    const execution = this.describeTurnExecution(target);
    if (!execution) {
      return null;
    }

    return `[用户正在重写一个已执行 ${execution.segments.join(' / ')} 的历史请求，之前该轮的执行结果已回滚。${execution.detailText}后续回复请仅基于当前工作区状态、本轮附加资源和新的用户输入继续。]`;
  }

  private buildRegenerateRequest(requestContent: string, target: EditActionTurnTarget): string {
    const execution = this.describeTurnExecution(target);
    if (!execution) {
      return requestContent;
    }

    return `[用户要求重新生成一个已执行 ${execution.segments.join(' / ')} 的历史请求，相关执行结果和文件变更已回滚。${execution.detailText}请沿用该轮原始请求上下文重新继续，不要引用已回滚的旧结果。]\n${requestContent}`;
  }

  private buildUserVisibleRequestPreview(content: string | undefined): string | null {
    const normalized = (content ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    return normalized.length > 48
      ? `${normalized.slice(0, 48).trimEnd()}...`
      : normalized;
  }

  // ==================== 编辑检查点操作 ====================

  /**
   * 用户保留文件变更 �?将当前状态设为新基线，保存反馈状�?
   */
  async onKeepEdits(detail?: ChatTaskActionDetail): Promise<void> {
    const { fileCount, totalAdded, totalRemoved } = detail || {};
    const displayContent = this.buildUserVisibleRequestPreview(getInteractionDisplayContent(detail?.target));
    const requestHint = displayContent ? `与“${displayContent}”关联的` : '上一轮的';
    this.ctx.pendingEditFeedback = `[用户已确认保留${requestHint}文件变更：${fileCount || 0} 个文件，+${totalAdded || 0} / -${totalRemoved || 0} 行]`;
    const sessionId = this.resolveCurrentSessionResource();
    if (!sessionId || !this.ctx.acceptEditingSession) {
      throw new Error('Editing-session owner is unavailable.');
    }
    await this.ctx.acceptEditingSession(sessionId);
  }

  async undoLastEdit(options: { sessionResource?: string } = {}): Promise<void> {
    if (this.ctx.isWaiting) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return;
    }
    const sessionId = this.resolveCurrentSessionResource(options.sessionResource);
    if (!sessionId || !this.ctx.undoEditingSessionInteraction) {
      throw new Error('Editing-session undo requires the execution host.');
    }
    await this.ctx.undoEditingSessionInteraction(sessionId);
    await this.reloadAbsWorkspace();
  }

  async redoLastEdit(options: { sessionResource?: string } = {}): Promise<void> {
    if (this.ctx.isWaiting) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return;
    }
    const sessionId = this.resolveCurrentSessionResource(options.sessionResource);
    if (!sessionId || !this.ctx.redoEditingSessionInteraction) {
      throw new Error('Editing-session redo requires the execution host.');
    }
    await this.ctx.redoEditingSessionInteraction(sessionId);
    await this.reloadAbsWorkspace();
  }

  /**
   * 重做文件变更（Redo，恢复被撤销的文件状态）
   */
  async redoEdits(options: { sessionResource?: string } = {}): Promise<void> {
    if (this.ctx.isWaiting) { this.ctx.message.warning('正在处理中，请稍候...'); return; }

    const checkpointRedoResult = await this.checkpointReplayCoordinator.redoCheckpoint(
      async () => {
        const sessionId = this.resolveCurrentSessionResource(options.sessionResource);
        const committed = await this.ctx.commitCheckpointRedo?.(sessionId);
        if (!committed) {
          throw new Error('Checkpoint redo host commit did not return a result');
        }
        return committed;
      },
    );
    if (checkpointRedoResult.ok === false) {
      this.checkpointReplayCoordinator.projectRedoExecutionResult(checkpointRedoResult);
      return;
    }

    this.checkpointReplayCoordinator.projectRedoExecutionResult(checkpointRedoResult);
  }

  private readCurrentSessionCheckpointTimelineState(): SessionCheckpointTimelineState | null {
    const sessionId = this.resolveCurrentSessionResource();
    return sessionId ? this.ctx.readSessionCheckpointTimelineState?.(sessionId) ?? null : null;
  }


  /**
   * 接受单个文件�?AI 编辑
   */
  async onAcceptFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const sessionId = this.resolveCurrentSessionResource();
    if (!sessionId || !this.ctx.operateEditingSessionEntry) {
      throw new Error('Editing-session entry owner is unavailable.');
    }
    await this.ctx.operateEditingSessionEntry(sessionId, filePath, 'accept');
  }

  /**
   * 拒绝单个文件�?AI 编辑（恢复到初始内容�?
   */
  async onRejectFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const sessionId = this.resolveCurrentSessionResource();
    if (!sessionId || !this.ctx.operateEditingSessionEntry) {
      throw new Error('Editing-session entry owner is unavailable.');
    }
    await this.ctx.operateEditingSessionEntry(sessionId, filePath, 'reject');
    await this.reloadAbsWorkspace();
  }

  async restoreToCheckpoint(
    target: EditActionTurnTarget | null | undefined,
    options: { emitResultMessage?: boolean; sessionResource?: string; checkpointId?: string } = {},
  ): Promise<boolean> {
    if (this.ctx.isWaiting) { this.ctx.message.warning('正在处理中，请稍候...'); return false; }
    const { emitResultMessage = true, sessionResource, checkpointId } = options;

    const resolved = await this.resolveTurnTargetWithCheckpointSync(target, sessionResource, checkpointId);
    if (!resolved.snapshot) {
      this.ctx.message.info('未找到该消息对应的检查点');
      return false;
    }

    const confirmed = await this.confirmRestoreCheckpoint(resolved.snapshot, resolved.turnId, sessionResource);
    if (!confirmed) {
      return false;
    }

    this.restoreCheckpointRequestToInput(resolved);

    return this.restoreCheckpointSnapshot(resolved.snapshot, {
      sessionResource,
      turnId: resolved.turnId,
      listIndex: resolved.listIndex,
      emitResultMessage,
    });
  }

  async forkSessionFromTurn(
    target: EditActionTurnTarget | null | undefined,
    options: { sessionResource?: string } = {},
  ): Promise<boolean> {
    if (this.ctx.isWaiting) { this.ctx.message.warning('正在处理中，请稍候...'); return false; }

    const normalized = target ?? {};
    const resolved = this.resolveTurnTarget(target, options.sessionResource);
    if (!resolved.turnId) {
      this.ctx.message.info('未找到该消息对应的会话边界');
      return false;
    }

    const requestContent = resolved.requestContent ?? getInteractionRequestContent(normalized);
    const displayContent = resolved.displayContent
      ?? getInteractionDisplayContent(normalized)
      ?? requestContent;
    if (!displayContent) {
      this.ctx.message.info('未找到该请求的可见内容');
      return false;
    }

    const requestResources = extractUserTurnResources(requestContent);
    return this.ctx.session.forkFromTurn({
      sourceSessionId: this.resolveCurrentSessionResource(options.sessionResource),
      turnId: resolved.turnId,
      requestContent: requestContent ?? displayContent,
      displayContent,
      resources: mergeUserTurnResources([], requestResources),
    });
  }

  private async confirmRestoreCheckpoint(
    snapshot: TurnSnapshot,
    turnId: string | undefined,
    explicitSessionResource?: string,
  ): Promise<boolean> {
    const confirmRestoreCheckpoint = this.ctx.confirmRestoreCheckpoint;
    if (!confirmRestoreCheckpoint) {
      return true;
    }

    const fileSummary = await this.getRestoreCheckpointFileSummary(snapshot.checkpointId);

    return await confirmRestoreCheckpoint({
      requestCount: this.getRestoreCheckpointRequestCount(turnId ?? snapshot.turnId, explicitSessionResource),
      fileCount: fileSummary.fileCount,
      fileLabel: fileSummary.fileLabel,
    });
  }

  private getRestoreCheckpointRequestCount(
    turnId: string | undefined,
    explicitSessionResource?: string,
  ): number {
    const liveTurnResponses = this.readCurrentSessionTurnResponses(explicitSessionResource);

    if (!turnId) {
      return 1;
    }

    const turnIndex = liveTurnResponses.findIndex(turn => turn.turnId === turnId);
    if (turnIndex < 0) {
      return 1;
    }

    return Math.max(1, liveTurnResponses.length - turnIndex);
  }

  private async getRestoreCheckpointFileSummary(checkpointId: string): Promise<{ fileCount: number; fileLabel?: string; }> {
    try {
      const restorePlan = await this.ctx.workspaceCheckpointAccess?.buildRestorePlan?.(checkpointId);
      if (Array.isArray(restorePlan?.files)) {
        return {
          fileCount: restorePlan.files.length,
          fileLabel: restorePlan.files.length === 1
            ? AilyHost.get().path.basename(restorePlan.files[0].uri)
            : undefined,
        };
      }
    } catch (error) {
      console.warn('[restoreToCheckpoint] failed to inspect restore plan for confirmation:', error);
    }

    try {
      const editsSummary = await this.ctx.editCheckpointService.getEditsSummary?.(checkpointId);
      if (typeof editsSummary?.fileCount === 'number') {
        return { fileCount: editsSummary.fileCount };
      }
    } catch (error) {
      console.warn('[restoreToCheckpoint] failed to inspect edits summary for confirmation:', error);
    }

    return { fileCount: 0 };
  }

  private resolveCurrentSessionResource(explicitSessionResource?: string | null): string {
    const normalizedExplicitResource = typeof explicitSessionResource === 'string'
      ? explicitSessionResource.trim()
      : '';
    if (normalizedExplicitResource) {
      return normalizedExplicitResource;
    }

    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : undefined;
    const normalizedCurrentViewResource = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    if (normalizedCurrentViewResource) {
      return normalizedCurrentViewResource;
    }

    return typeof this.ctx.sessionId === 'string'
      ? this.ctx.sessionId.trim()
      : '';
  }

  private async cancelPendingRequestBeforeRegenerate(): Promise<boolean> {
    if (!this.ctx.isWaiting) {
      return true;
    }

    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource || typeof this.ctx.cancelCurrentRequestForSession !== 'function') {
      this.ctx.message.warning('正在处理中，请稍候...');
      return false;
    }

    const cancelled = await Promise.resolve(
      this.ctx.cancelCurrentRequestForSession(sessionResource, 'regenerate'),
    );
    if (!cancelled) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return false;
    }

    return true;
  }

  /**
   * 编辑并重新发�?�?回滚到指定消息的检查点 + 用新内容重新发�?
   */
  async editAndResendFromTurn(target: EditActionTurnTarget | null | undefined, newText: string, resources: ResourceItem[]): Promise<void> {
    if (this.ctx.isWaiting) { this.ctx.message.warning('正在处理中，请稍候...'); return; }
    const resolved = this.resolveTurnTarget(target);
    const restored = await this.restoreToCheckpoint(target, { emitResultMessage: false });
    if (!restored) {
      return;
    }

    const normalized = target ?? {};
    const requestResources = extractUserTurnResources(resolved.requestContent ?? getInteractionRequestContent(normalized));
    this.ctx.resourceManager.items = mergeUserTurnResources(resources, requestResources);
    const editFeedback = this.buildEditResendFeedback(this.withResolvedTurnTarget(normalized, {
      turnId: resolved.turnId,
      requestContent: resolved.requestContent,
      displayContent: resolved.displayContent,
      lastRoundId: resolved.lastRoundId,
    }));
    if (editFeedback) {
      this.ctx.pendingEditFeedback = editFeedback;
    }
    this.ctx.scrollManager.startNewExchange?.();
    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource) {
      this.ctx.message.warning('会话不存在，请开始新对话');
      return;
    }
    await this.ctx.send('user', newText, false, sessionResource);
    this.ctx.resourceManager.mergePathsTo(this.ctx.sessionAllowedPaths);
    this.ctx.resourceManager.items = [];
  }

  /**
   * 重新生成 �?回滚文件变更 + 截断对话历史 + 重新发送�?
   * 不传 target 时，默认重试最新一轮�?
   */
  async regenerateTurn(target?: EditActionTurnTarget | null): Promise<void> {
    if (!this.ctx.sessionId) { this.ctx.message.warning('会话不存在，请开始新对话'); return; }
    const cancelledPendingRequest = await this.cancelPendingRequestBeforeRegenerate();
    if (!cancelledPendingRequest) {
      return;
    }

    // 1. 找到目标快照
    const normalizedTarget = target ?? undefined;
    const resolvedTarget = normalizedTarget
      ? await this.resolveTurnTargetWithCheckpointSync(normalizedTarget)
      : undefined;
    const canonicalTarget = this.toCanonicalTurnContext(normalizedTarget);
    const snapshot = resolvedTarget?.snapshot ?? this.ctx.editCheckpointService.getLatestSnapshot();

    if (!snapshot) {
      const sessionResource = this.resolveCurrentSessionResource();
      const resendTarget = canonicalTarget
        ?? (resolvedTarget?.turnId
          ? this.toCanonicalTurnContext({
              turnId: resolvedTarget.turnId,
              requestContent: resolvedTarget.requestContent,
              displayContent: resolvedTarget.displayContent,
              lastRoundId: resolvedTarget.lastRoundId,
              turnResponse: this.findSessionTurnResponse(resolvedTarget.turnId) ?? null,
            })
          : null)
        ?? this.getLatestRegenerableTurnContext();
      const requestContent = resendTarget?.requestContent
        ?? resendTarget?.request?.content
        ?? '';
      if (!sessionResource || !resendTarget?.turnId || !requestContent.trim()) {
        this.ctx.message.warning('Unable to retry because no previous request can be resolved.');
        return;
      }
      const prepared = await Promise.resolve(
        this.ctx.prepareProtocolTruncationForResend?.(sessionResource, resendTarget.turnId) ?? false,
      );
      if (!prepared) {
        this.ctx.message.warning('Unable to retry the previous request because the session history boundary could not be prepared.');
        return;
      }
      await this.ctx.submitRegeneratedUserTurn?.(sessionResource, {
        requestText: requestContent,
        ...(resendTarget.displayContent ? { displayText: resendTarget.displayContent } : {}),
        ...(resendTarget.request?.metadata ? { requestMetadata: resendTarget.request.metadata } : {}),
      });
      return;
    }

    const snapshotTurnId = resolvedTarget?.turnId ?? canonicalTarget?.turnId ?? snapshot.turnId;
    const snapshotContext = this.ctx.editCheckpointService.getTurnContextForSnapshot(snapshot, snapshotTurnId);
    const requestContent = resolvedTarget?.requestContent
      ?? canonicalTarget?.requestContent
      ?? snapshotContext?.requestContent
      ?? (snapshotTurnId ? this.getSessionTurnRequestContent(snapshotTurnId) : undefined);
    const displayContent = resolvedTarget?.displayContent
      ?? canonicalTarget?.displayContent
      ?? snapshotContext?.displayContent
      ?? (normalizedTarget ? getInteractionDisplayContent(normalizedTarget) : undefined)
      ?? requestContent;
    const requestMetadata = canonicalTarget?.request?.metadata
      ?? snapshotContext?.request?.metadata
      ?? normalizedTarget?.request?.metadata
      ?? normalizedTarget?.turnResponse?.request?.metadata;
    const lastRoundId = resolvedTarget?.lastRoundId
      ?? canonicalTarget?.lastRoundId
      ?? snapshotContext?.lastRoundId
      ?? (normalizedTarget ? getInteractionLastRoundId(normalizedTarget) : undefined)
      ?? (snapshotTurnId ? this.getSessionTurnLastRoundId(snapshotTurnId) : undefined);
    const regenerateTarget = this.withResolvedTurnTarget(normalizedTarget, {
      turnId: snapshotTurnId,
      requestContent,
      displayContent,
      lastRoundId,
    });

    // 2. 复用 restore checkpoint 的 model transaction；它负责截断并恢复 lex/model/runtime owner。
    const restored = await this.restoreCheckpointSnapshot(snapshot, {
      turnId: snapshotTurnId,
      listIndex: this.ctx.editCheckpointService.getResponseStartListIndexForSnapshot(snapshot) ?? undefined,
      emitResultMessage: false,
      captureRedoTurns: false,
      truncateLiveTurnResponses: true,
    });
    if (!restored) {
      return;
    }

    // 3. 重新发起 turn
    const msgs = this.ctx.conversationMessages;
    const fallbackUserMsg = displayContent ?? (
      msgs.length > 0 && msgs[msgs.length - 1].role === 'user'
        ? msgs[msgs.length - 1].content
        : '请重试上次的操作。'
    );
    
    const nextRequest = this.buildRegenerateRequest(
      requestContent ?? fallbackUserMsg,
      regenerateTarget,
    );
    const sessionResource = this.resolveCurrentSessionResource();
    if (!sessionResource || typeof this.ctx.submitRegeneratedUserTurn !== 'function') {
      this.ctx.message.warning('会话不存在，请开始新对话');
      return;
    }

    await this.ctx.submitRegeneratedUserTurn(sessionResource, {
      requestText: nextRequest,
      ...(displayContent ? { displayText: displayContent } : {}),
      ...(requestMetadata ? { requestMetadata } : {}),
    });
  }
}

function summarizeTurnResponseIds(turnResponses: readonly TurnResponseTurn[] | null | undefined): readonly string[] {
  return (Array.isArray(turnResponses) ? turnResponses : [])
    .map(turn => typeof turn?.turnId === 'string' ? turn.turnId.trim() : '')
    .filter(Boolean);
}
