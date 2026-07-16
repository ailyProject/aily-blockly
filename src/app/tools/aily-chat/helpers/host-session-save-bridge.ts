import type {
  IAgentLifecycle,
  IChatCoordination,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import type { SessionSnapshot, TurnResponseCommand, TurnResponseFollowup, TurnResponseTurn } from 'aily-lex/browser';
import type {
  LiveHostSessionRecord,
  HostSessionRecord,
  HostSessionSidecar,
  HostSessionSkillInvocationTraceEntry,
  ChatListItem,
  PersistedHostResponseData,
  PersistedHostTurnResponse,
} from '../services/chat-history.service';
import { AilyHost } from '../core/host';
import { normalizeChatSessionType, type ChatResolvedMode, type ChatSelectedMode, type ChatSessionType } from '../core/chat-mode';
import type { ChatRuntimeHostModelSelectionSnapshot } from '../core/chat-runtime-host-contract';
import {
  getChatSessionTitleSourcePriority,
  isCustomSessionTitleSource,
  normalizeChatSessionTitleCandidate,
  normalizeChatSessionTitleSource,
  normalizeChatSessionTitleText,
  normalizePersistedChatSessionTitleSource,
  type ChatSessionTitleCandidate,
  type ChatSessionTitleSource,
  type PersistedChatSessionTitleSource,
} from '../core/chat-session-title';
import {
  buildHostProjectionStateFromPersistedRecord,
  buildHostRequestModelFromCanonical,
  type HostRequestModel,
  type HostResponseProjection,
  type HostTurnResponseState,
  hasHostResponseConversationContent,
} from './host-turn-response-state';
import {
  cloneTurnResponseModelSidecar,
  normalizeTurnResponseSummaryPreview,
} from './turn-response-response-model';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import {
  buildHostSessionCurrentModeDescriptor,
  buildHostSessionCurrentModeDescriptorFromResolvedMode,
  buildHostSessionCurrentPickerInputState,
  buildHostSessionCurrentPickerInputStateFromResolvedMode,
  type HostSessionProviderOptions,
} from './host-session-input-state';
import {
  buildHostSessionCurrentPickerRoutingSummary,
  resolveHostSessionRequestRoutingSummary,
} from './host-session-request-routing';
import { resolveHostSessionInteractionActionSummary } from './host-session-interaction-action';
import { cloneHostSessionRuntimeAuxiliary } from './host-session-runtime-auxiliary';
import { cloneSessionRequestContextSnapshot } from './turn-request-prompt-context';
import type { ChatSessionRuntimeState } from '../services/chat-session-runtime-store.service';
import type {
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
} from '../core/chat-runtime-host-contract';
import {
  canRedoSessionCheckpointTimeline,
  type SessionCheckpointTimelineEntry,
  type SessionCheckpointTimelineState,
} from './session-checkpoint-timeline-model';
import {
  buildSessionTurnOwnerDiagnostics,
  formatSessionTurnOwnerDiagnosticsFields,
  hasBlockingSessionTurnOwnerMismatch,
} from './session-turn-owner-diagnostics';

export interface HostSessionPersistenceAccess {
  loadHostRecord?(sessionId: string, projectPathHint?: string | null): HostSessionRecord | null;
  saveHostRecord?(record: LiveHostSessionRecord): void;
}

export type HostSessionSaveContext = Pick<IAgentLifecycle, 'toolCallingIteration'>
  & Pick<IProjectContext, 'currentMode' | 'currentAgentRuntimeMode' | 'currentAgentRuntimeModeSource'>
  & Pick<ISessionAccess, 'sessionId' | 'sessionTitle'>
  & Partial<Pick<ISessionAccess, 'chatService'>>
  & Pick<IChatCoordination, 'lexStream'>
  & {
    readonly chatHistoryService?: HostSessionPersistenceAccess;
    readonly contextBudgetService?: { getSnapshot(): ReturnType<import('../services/context-budget-facade').ContextBudgetFacade['getSnapshot']> } | null;
    readonly hostResponseProjection?: HostResponseProjection | null;
    readCurrentViewSessionResource?(): string | null | undefined;
    readPersistedHostRecord?(sessionId: string, projectPath?: string | null): HostSessionRecord | null;
    readSessionTurnResponses?(sessionId?: string | null): readonly TurnResponseTurn[];
    readSessionRuntimeState?(sessionId?: string | null): Readonly<ChatSessionRuntimeState> | undefined;
    readSessionCheckpointTimelineState?(sessionId?: string | null): SessionCheckpointTimelineState | null;
    requestHostResourceOperation?(
      request: ChatRuntimeHostResourceOperationRequest,
    ): Promise<ChatRuntimeHostResourceOperationResult>;
    invalidateHostRequestGraph?(): void;
    readonly currentModel: ChatRuntimeHostModelSelectionSnapshot | null;
  };

function isHostSessionSaveTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceHostSessionSave', [
    '__AILY_CHAT_TRACE_HOST_SESSION_SAVE__',
    'AILY_CHAT_TRACE_HOST_SESSION_SAVE',
  ]);
}

export interface HostSessionSaveTarget {
  readonly sessionId: string;
  readonly sessionTitleCandidate?: ChatSessionTitleCandidate;
  readonly sessionTitle?: string;
  readonly sessionTitleSource?: ChatSessionTitleSource;
  readonly sessionTitleRevision?: number;
  readonly sessionType: ChatSessionType;
  readonly providerOptions: HostSessionProviderOptions;
  readonly selectedMode: ChatSelectedMode;
  readonly resolvedMode?: Pick<ChatResolvedMode, 'id' | 'kind' | 'isBuiltin' | 'name' | 'modeInstructions' | 'uri'> | null;
  readonly model: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly sessionSnapshot?: SessionSnapshot | null;
  readonly turnResponses?: readonly TurnResponseTurn[];
  readonly toolCallingIteration?: number;
}

/**
 * Host-side save bridge for session lifecycle.
 *
 * Keeps host record building and save flow out of SessionLifecycleHelper.
 */
export class HostSessionSaveBridge {
  constructor(private readonly ctx: HostSessionSaveContext) {}

  buildHostSessionRecord(options: {
    previousHostProjection?: HostResponseProjection | null;
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    turnResponsesOverride?: readonly TurnResponseTurn[];
    sessionSnapshotOverride?: SessionSnapshot | null;
    hostRequestModel?: HostRequestModel | null;
    target: HostSessionSaveTarget | null;
    allowPersistedLookup?: boolean;
  }): LiveHostSessionRecord | null {
    const saveTarget = normalizeHostSessionSaveTarget(options?.target);
    if (!saveTarget) {
      return null;
    }

    const sessionId = saveTarget.sessionId;
    const projectPath = saveTarget.providerOptions.folderPath;
    const budgetSnapshot = this.ctx.contextBudgetService?.getSnapshot();
    const allowPersistedLookup = options?.allowPersistedLookup !== false;
    const persistedRecord = allowPersistedLookup
      ? this.resolvePersistedRecord(saveTarget)
      : null;
    const previousHostProjection = options?.previousHostProjection
      ?? this.buildPersistedProjection(persistedRecord)
      ?? null;
    const sessionSnapshot = options?.sessionSnapshotOverride
      ?? saveTarget.sessionSnapshot
      ?? this.resolveVisibleSessionSnapshot(sessionId);
    const currentTurnResponses = this.resolveCurrentTurnResponses(
      saveTarget,
      options?.turnResponsesOverride,
    );
    const currentHostProjection = options?.hostProjection
      ?? this.buildTargetProjection(currentTurnResponses);
    const turnResponses = applySessionSnapshotRoundsToTurnResponses(
      resolveTurnResponsesForSave(
        currentTurnResponses,
        currentHostProjection,
        previousHostProjection,
      ),
      sessionSnapshot,
    );
    if (!hasHostResponseConversationContent(currentHostProjection ?? previousHostProjection ?? null) && turnResponses.length === 0) {
      return null;
    }

    const visibleChatList = options?.visibleChatList
      ? options.visibleChatList.map(message => ({ ...message })) as ChatListItem[]
      : buildVisibleChatListForSave(
          previousHostProjection?.chatList ?? [],
          currentHostProjection?.chatList ?? [],
        );
    const canonicalTurnResponses = applyRuntimeStateSummariesToTurnResponses(applyVisibleRequestDisplayContentToTurnResponses(
      visibleChatList,
      turnResponses,
    ));
    const persistedTurnResponses = persistResponseDataOnTurnResponses(
      canonicalTurnResponses,
      currentHostProjection,
      previousHostProjection ?? null,
      options?.hostRequestModel ?? buildHostRequestModelFromCanonical(
        sessionSnapshot,
        canonicalTurnResponses,
        canonicalTurnResponses[canonicalTurnResponses.length - 1]?.turnId ?? null,
      ),
    );
    const selectedMode = saveTarget.selectedMode;
    const resolvedMode = saveTarget.resolvedMode ?? null;
    const providerOptions = saveTarget.providerOptions;
    const inputState = resolvedMode
      ? buildHostSessionCurrentPickerInputStateFromResolvedMode(resolvedMode, providerOptions)
      : buildHostSessionCurrentPickerInputState(selectedMode, providerOptions);
    const modeDescriptor = resolvedMode
      ? buildHostSessionCurrentModeDescriptorFromResolvedMode(resolvedMode)
      : buildHostSessionCurrentModeDescriptor(selectedMode);
    const requestRouting = buildHostSessionCurrentPickerRoutingSummary(
      selectedMode,
      undefined,
      providerOptions.permissionLevel,
      providerOptions.approvalsReviewer,
      providerOptions.approvalPolicy,
    );
    const persistedTitle = normalizeChatSessionTitleText(persistedRecord?.metadata?.title);
    const persistedTitleSource = normalizePersistedChatSessionTitleSource(persistedRecord?.metadata?.titleSource);
    const persistedDefaultTitle = normalizeChatSessionTitleText(persistedRecord?.metadata?.defaultTitle);
    const saveTargetTitleCandidate = normalizeChatSessionTitleCandidate(saveTarget.sessionTitleCandidate);
    const saveTargetTitle = saveTargetTitleCandidate.text;
    const saveTargetTitleSource = saveTargetTitleCandidate.source;
    const liveTitle = '';
    const liveTitleSourceKnown = false;
    const liveTitleSource = 'empty';
    const durableTitle = resolveDurableSessionTitle({
      persistedTitle,
      persistedTitleSource,
      saveTargetTitle,
      saveTargetTitleSource,
      liveTitle,
      liveTitleSource,
      liveTitleSourceKnown,
    });
    const defaultTitle = resolveDefaultSessionTitle({
      persistedTurnResponses,
      persistedDefaultTitle,
      saveTargetTitle,
      saveTargetTitleSource,
      liveTitle,
      liveTitleSource,
    });
    const runtimeState = this.ctx.readSessionRuntimeState?.(sessionId);
    const skillInvocationTrace = deriveSkillInvocationTrace(currentTurnResponses);
    const runtimeAuxiliary = cloneHostSessionRuntimeAuxiliary({
      requestContext: cloneSessionRequestContextSnapshot(runtimeState?.requestContext),
      activeSkillNames: Array.isArray(runtimeState?.activeSkillNames) ? runtimeState.activeSkillNames : undefined,
      skillInvocationTrace,
      pendingFollowupRequests: runtimeState?.pendingFollowupRequests,
      yieldRequested: runtimeState?.yieldRequested === true,
    });
    const checkpointSidecars = buildCheckpointSidecars(
      this.ctx.readSessionCheckpointTimelineState?.(sessionId) ?? null,
      persistedTurnResponses as readonly TurnResponseTurn[],
    );
    const record: LiveHostSessionRecord = {
      sessionId,
      turnResponses: persistedTurnResponses,
      ...(checkpointSidecars ? { sidecar: checkpointSidecars } : {}),
      ...(runtimeAuxiliary ? { auxiliary: runtimeAuxiliary } : {}),
      metadata: {
        sessionId,
        title: durableTitle.text,
        ...(durableTitle.source ? { titleSource: durableTitle.source } : {}),
        ...(defaultTitle ? { defaultTitle } : {}),
        sessionType: normalizeChatSessionType(saveTarget.sessionType),
        projectPath,
        mode: selectedMode.modeId,
        agentRuntimeMode: this.ctx.currentAgentRuntimeMode ?? this.ctx.chatService?.currentAgentRuntimeMode,
        agentRuntimeModeSource: this.ctx.currentAgentRuntimeModeSource ?? this.ctx.chatService?.currentAgentRuntimeModeSource,
        modeDescriptor,
        inputState,
        requestRouting,
        model: saveTarget.model?.model ?? null,
        contextBudget: budgetSnapshot ? {
          currentTokens: budgetSnapshot.currentTokens,
          maxContextTokens: budgetSnapshot.maxContextTokens,
          usagePercent: budgetSnapshot.usagePercent,
          systemTokens: budgetSnapshot.systemTokens,
          baseSystemTokens: budgetSnapshot.baseSystemTokens,
          instructionTokens: budgetSnapshot.instructionTokens,
          skillTokens: budgetSnapshot.skillTokens,
          toolsTokens: budgetSnapshot.toolsTokens,
          toolSourceTokens: budgetSnapshot.toolSourceTokens,
          messagesTokens: budgetSnapshot.messagesTokens,
          toolResultsTokens: budgetSnapshot.toolResultsTokens,
          messageCount: budgetSnapshot.messageCount,
        } : undefined,
        toolCallingIteration: saveTarget.toolCallingIteration ?? 0,
      },
    };

    const resolvedRequestRouting = resolveHostSessionRequestRoutingSummary(
      record as unknown as Pick<import('../services/chat-history.service').HostSessionRecord, 'metadata' | 'turnResponses'>,
    );
    const resolvedInteractionActionSummary = resolveHostSessionInteractionActionSummary(
      record as unknown as Pick<import('../services/chat-history.service').HostSessionRecord, 'metadata' | 'turnResponses'>,
    );
    record.metadata.mode = resolvedRequestRouting.selectedModeId;
    record.metadata.requestRouting = resolvedRequestRouting;
    record.metadata.interactionActionSummary = resolvedInteractionActionSummary;

    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(sessionId, persistedTurnResponses as readonly TurnResponseTurn[]);
    if (ownerDiagnostics.mismatchCount > 0) {
      console.warn('[HostSessionSave][owner-mismatch]', {
        sessionId,
        mismatchCount: ownerDiagnostics.mismatchCount,
        mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
        forkKind: record.metadata.forkKind ?? null,
        forkedFromSessionId: record.metadata.forkedFromSessionId ?? null,
      });
      if (hasBlockingSessionTurnOwnerMismatch(ownerDiagnostics, {
        allowForkedTurns: !!record.metadata.forkedFromSessionId || !!record.metadata.forkKind,
      })) {
        console.warn('[HostSessionSave][blocked-cross-session-record]', {
          sessionId,
          expectedSessionId: sessionId,
          mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        });
        return null;
      }
    }

    return record;
  }

  buildLiveHostSessionRecord(options?: {
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    turnResponsesOverride?: readonly TurnResponseTurn[];
    sessionSnapshotOverride?: SessionSnapshot | null;
    hostRequestModel?: HostRequestModel | null;
    target?: HostSessionSaveTarget | null;
  }): LiveHostSessionRecord | null {
    const rawTarget = options?.target ?? null;
    const targetSessionId = typeof rawTarget?.sessionId === 'string' && rawTarget.sessionId.trim().length > 0
      ? rawTarget.sessionId.trim()
      : this.ctx.sessionId;
    const targetTurnResponses = options?.turnResponsesOverride
      ?? (Array.isArray(rawTarget?.turnResponses) ? rawTarget.turnResponses : undefined)
      ?? this.resolveTargetTurnResponses(targetSessionId);
    const visibleTarget = this.isVisibleSaveTarget(targetSessionId);
    const currentTurnResponses = targetTurnResponses;
    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(targetSessionId, currentTurnResponses);
    if (isHostSessionSaveTraceEnabled()) {
      console.info('[HostSessionSave][owner]', [
        `phase=build-live`,
        `targetSessionId=${targetSessionId || '<empty>'}`,
        `visibleTarget=${visibleTarget}`,
        `currentViewSession=${this.ctx.readCurrentViewSessionResource?.() ?? '<unknown>'}`,
        ...formatSessionTurnOwnerDiagnosticsFields('target', ownerDiagnostics),
      ].join(' '));
    }
    const target = rawTarget ?? this.buildVisibleFallbackSaveTarget(targetSessionId, currentTurnResponses);
    return this.buildHostSessionRecord({
      ...options,
      allowPersistedLookup: false,
      turnResponsesOverride: currentTurnResponses,
      target,
    });
  }

  saveCurrentSession(options: {
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    hostRequestModel?: HostRequestModel | null;
    target: HostSessionSaveTarget | null;
  }): boolean {
    try {
      const saveTarget = normalizeHostSessionSaveTarget(options?.target);
      if (!saveTarget) {
        return false;
      }
      const visibleTarget = this.isVisibleSaveTarget(saveTarget.sessionId);
      const sessionSnapshot = saveTarget.sessionSnapshot ?? null;
      const previousHostProjection = options?.hostProjection
        ?? this.buildPersistedProjection(this.resolvePersistedRecord(saveTarget));
      let currentHostProjection = options?.hostProjection ?? null;
      if (visibleTarget) {
        this.ctx.invalidateHostRequestGraph?.();
        currentHostProjection = this.ctx.hostResponseProjection ?? currentHostProjection;
      }
      const record = this.buildHostSessionRecord({
        previousHostProjection,
        hostProjection: currentHostProjection,
        visibleChatList: options?.visibleChatList,
        hostRequestModel: options?.hostRequestModel,
        sessionSnapshotOverride: sessionSnapshot,
        target: saveTarget
          ? {
              ...saveTarget,
              sessionSnapshot,
            }
          : null,
      });
      if (!record) {
        return false;
      }

      if (typeof this.ctx.requestHostResourceOperation !== 'function') {
        return false;
      }
      void this.ctx.requestHostResourceOperation({
        sessionId: saveTarget.sessionId,
        kind: 'save-current-session',
        label: 'Saving chat session',
        resource: {
          targetSessionId: saveTarget.sessionId,
          sessionType: saveTarget.sessionType,
          projectPath: saveTarget.providerOptions.folderPath ?? null,
        },
        payload: {
          adapter: 'chatHistory',
          record,
        },
      }).catch(error => {
        console.warn('保存会话失败:', error);
      });
      return true;
    } catch (error) {
      console.warn('保存会话失败:', error);
      return false;
    }
  }

  private resolveProjectPath(): string | null {
    const cachedPath = this.ctx.chatService?.currentSessionPath;
    let currentPath: string | null = null;
    let rootPath: string | null = null;

    try {
      const project = AilyHost.get().project;
      currentPath = project.currentProjectPath;
      rootPath = project.projectRootPath;
    } catch {
      return cachedPath || null;
    }

    if (cachedPath && !this.isSameAsRoot(cachedPath, rootPath)) {
      return cachedPath;
    }
    if (currentPath && !this.isSameAsRoot(currentPath, rootPath)) {
      return currentPath;
    }
    return null;
  }

  private buildVisibleFallbackSaveTarget(
    targetSessionId: string,
    currentTurnResponses: readonly TurnResponseTurn[],
  ): HostSessionSaveTarget | null {
    const chatService = this.ctx.chatService;
    if (!chatService) {
      return null;
    }

    return {
      sessionId: targetSessionId,
      sessionTitle: this.ctx.sessionTitle,
      sessionTitleSource: chatService.currentSessionTitleSource,
      sessionTitleRevision: chatService.currentSessionTitleRevision,
      sessionType: chatService.currentSessionType,
      providerOptions: {
        folderPath: this.resolveProjectPath(),
        permissionMode: chatService.currentSessionPermissionMode,
        permissionProfile: chatService.currentSessionPermissionProfile,
        ...(chatService.currentSessionPermissionLevel
          ? { permissionLevel: chatService.currentSessionPermissionLevel }
          : {}),
      },
      selectedMode: chatService.selectedMode ?? {
        modeId: this.ctx.currentMode,
        customAgentTarget: chatService.currentCustomAgentTarget,
      },
      model: this.ctx.currentModel,
      turnResponses: currentTurnResponses,
    };
  }

  private isSameAsRoot(path: string | null, rootPath: string | null): boolean {
    if (!path || !rootPath) {
      return false;
    }
    return this.normalizePath(path) === this.normalizePath(rootPath);
  }

  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private resolvePersistedRecord(target: HostSessionSaveTarget | null): HostSessionRecord | null {
    if (!target?.sessionId) {
      return null;
    }

    return this.ctx.readPersistedHostRecord?.(target.sessionId, target.providerOptions.folderPath)
      ?? this.ctx.chatHistoryService?.loadHostRecord?.(
        target.sessionId,
        target.providerOptions.folderPath,
      )
      ?? null;
  }

  private loadPersistedRecord(sessionId: string, projectPath: string | null): HostSessionRecord | null {
    return this.ctx.readPersistedHostRecord?.(sessionId, projectPath)
      ?? this.ctx.chatHistoryService?.loadHostRecord?.(sessionId, projectPath ?? undefined)
      ?? null;
  }

  private buildPersistedProjection(record: HostSessionRecord | null): HostResponseProjection | null {
    if (!record?.turnResponses?.length) {
      return null;
    }

    return buildHostProjectionStateFromPersistedRecord({
      turnResponses: record.turnResponses,
    });
  }

  private buildTargetProjection(turnResponses: readonly TurnResponseTurn[] | undefined): HostResponseProjection | null {
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      return null;
    }

    return buildHostProjectionStateFromPersistedRecord({
      turnResponses,
    });
  }

  private resolveCurrentTurnResponses(
    saveTarget: HostSessionSaveTarget,
    turnResponsesOverride?: readonly TurnResponseTurn[],
  ): readonly TurnResponseTurn[] {
    if (Array.isArray(turnResponsesOverride)) {
      return turnResponsesOverride;
    }

    if (Array.isArray(saveTarget.turnResponses)) {
      return saveTarget.turnResponses;
    }

    const modelTurnResponses = this.resolveTargetTurnResponses(saveTarget.sessionId);
    if (modelTurnResponses.length > 0) {
      return modelTurnResponses;
    }

    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(saveTarget.sessionId)?.turnResponses;
    if (Array.isArray(runtimeTurnResponses) && runtimeTurnResponses.length > 0) {
      return runtimeTurnResponses;
    }

    if (this.isVisibleSaveTarget(saveTarget.sessionId)
      && Array.isArray(this.ctx.lexStream.turnResponses)
      && this.ctx.lexStream.turnResponses.length > 0) {
      return this.ctx.lexStream.turnResponses;
    }

    return [];
  }

  private resolveVisibleSessionSnapshot(sessionId: string): SessionSnapshot | null {
    if (!this.isVisibleSaveTarget(sessionId)) {
      return null;
    }

    const sessionAccess = this.ctx.lexStream?.session as {
      snapshot?: () => SessionSnapshot | null | undefined;
    } | undefined;
    try {
      return sessionAccess?.snapshot?.() ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (message.includes('owned by the host runtime')) {
        if (isHostSessionSaveTraceEnabled()) {
          console.info('[HostSessionSave][skip-renderer-session-snapshot]', {
            sessionId,
            reason: 'host-owned-runtime',
          });
        }
        return null;
      }
      throw error;
    }
  }

  private resolveTargetTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return [];
    }

    const turnResponses = this.ctx.readSessionTurnResponses?.(normalizedSessionId);
    if (Array.isArray(turnResponses) && turnResponses.length > 0) {
      return turnResponses;
    }

    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(normalizedSessionId)?.turnResponses;
    if (Array.isArray(runtimeTurnResponses) && runtimeTurnResponses.length > 0) {
      return runtimeTurnResponses;
    }

    if (this.isVisibleSaveTarget(normalizedSessionId)
      && Array.isArray(this.ctx.lexStream.turnResponses)
      && this.ctx.lexStream.turnResponses.length > 0) {
      return this.ctx.lexStream.turnResponses;
    }

    return [];
  }

  private isVisibleSaveTarget(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const currentSessionId = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    return !!currentSessionId && currentSessionId === targetSessionId;
  }
}

function normalizeHostSessionSaveTarget(target: HostSessionSaveTarget | null | undefined): HostSessionSaveTarget | null {
  const sessionId = typeof target?.sessionId === 'string'
    ? target.sessionId.trim()
    : '';
  if (!sessionId) {
    return null;
  }

  return {
    sessionId,
    sessionTitleCandidate: normalizeChatSessionTitleCandidate(
      target?.sessionTitleCandidate ?? {
        text: target?.sessionTitle,
        source: target?.sessionTitleSource,
        revision: target?.sessionTitleRevision,
      },
    ),
    sessionType: normalizeChatSessionType(target?.sessionType),
    providerOptions: {
      folderPath: target?.providerOptions?.folderPath ?? null,
      permissionMode: target?.providerOptions?.permissionMode ?? 'default',
      permissionProfile: target?.providerOptions?.permissionProfile ?? 'workspace-write',
      ...(typeof target?.providerOptions?.permissionLevel === 'string' && target.providerOptions.permissionLevel.trim().length > 0
        ? { permissionLevel: target.providerOptions.permissionLevel.trim() }
        : {}),
    },
    selectedMode: target?.selectedMode ?? { modeId: 'agent' },
    ...(target?.resolvedMode
      ? {
          resolvedMode: {
            ...target.resolvedMode,
            ...(target.resolvedMode.modeInstructions
              ? { modeInstructions: { ...target.resolvedMode.modeInstructions } }
              : {}),
          },
        }
      : {}),
    model: target?.model ? { ...target.model } : null,
    ...(target?.sessionSnapshot !== undefined ? { sessionSnapshot: target.sessionSnapshot } : {}),
    ...(Array.isArray(target?.turnResponses) ? { turnResponses: target.turnResponses.map(turn => cloneTurnResponse(turn)) } : {}),
    ...(typeof target?.toolCallingIteration === 'number' ? { toolCallingIteration: target.toolCallingIteration } : {}),
  };
}

function resolveDurableSessionTitle(input: {
  persistedTitle: string;
  persistedTitleSource?: PersistedChatSessionTitleSource;
  saveTargetTitle: string;
  saveTargetTitleSource: ChatSessionTitleSource;
  liveTitle: string;
  liveTitleSource: ChatSessionTitleSource;
  liveTitleSourceKnown: boolean;
}): { text: string; source?: PersistedChatSessionTitleSource } {
  const {
    persistedTitle,
    persistedTitleSource,
    saveTargetTitle,
    saveTargetTitleSource,
    liveTitle,
    liveTitleSource,
    liveTitleSourceKnown,
  } = input;

  const persistedEffectiveSource = persistedTitleSource ?? 'legacy-custom';

  if (saveTargetTitle && isCustomSessionTitleSource(saveTargetTitleSource)) {
    const normalizedSaveTargetSource = normalizePersistedChatSessionTitleSource(saveTargetTitleSource) ?? 'legacy-custom';
    if (!persistedTitle || getChatSessionTitleSourcePriority(normalizedSaveTargetSource) >= getChatSessionTitleSourcePriority(persistedEffectiveSource)) {
      return {
        text: saveTargetTitle,
        source: normalizedSaveTargetSource,
      };
    }
  }

  if (persistedTitle) {
    return {
      text: persistedTitle,
      source: persistedEffectiveSource,
    };
  }

  if (liveTitle && isCustomSessionTitleSource(liveTitleSource)) {
    return {
      text: liveTitle,
      source: normalizePersistedChatSessionTitleSource(liveTitleSource) ?? 'legacy-custom',
    };
  }

  return { text: '' };
}

function resolveDefaultSessionTitle(input: {
  persistedTurnResponses: readonly PersistedHostTurnResponse[];
  persistedDefaultTitle: string;
  saveTargetTitle: string;
  saveTargetTitleSource: ChatSessionTitleSource;
  liveTitle: string;
  liveTitleSource: ChatSessionTitleSource;
}): string {
  const derivedDefaultTitle = deriveDefaultTitleFromTurnResponses(input.persistedTurnResponses);
  if (derivedDefaultTitle) {
    return derivedDefaultTitle;
  }

  if (input.saveTargetTitle && input.saveTargetTitleSource === 'default-first-request') {
    return input.saveTargetTitle;
  }

  if (input.liveTitle && input.liveTitleSource === 'default-first-request') {
    return input.liveTitle;
  }

  return input.persistedDefaultTitle;
}

function deriveDefaultTitleFromTurnResponses(turnResponses: readonly PersistedHostTurnResponse[]): string {
  for (const turnResponse of turnResponses) {
    const request = (turnResponse as { request?: unknown })?.request;
    const title = deriveDefaultTitleFromRequest(request);
    if (title) {
      return title;
    }
  }

  return '';
}

function deriveDefaultTitleFromRequest(request: unknown): string {
  const direct = readRequestTextCandidate(request);
  if (direct) {
    return direct;
  }

  if (request && typeof request === 'object') {
    const nested = readRequestTextCandidate((request as { message?: unknown }).message);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function readRequestTextCandidate(candidate: unknown): string {
  const text = typeof candidate === 'string'
    ? candidate
    : candidate && typeof candidate === 'object'
      ? ((candidate as { messageText?: unknown }).messageText
        ?? (candidate as { prompt?: unknown }).prompt
        ?? (candidate as { text?: unknown }).text
        ?? (candidate as { content?: unknown }).content)
      : undefined;

  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  return normalized.split('\n')[0]?.trim().substring(0, 200) ?? '';
}

function applyVisibleRequestDisplayContentToTurnResponses(
  visibleChatList: readonly ChatListItem[],
  turnResponses: readonly TurnResponseTurn[],
) : TurnResponseTurn[] {
  if (visibleChatList.length === 0 || turnResponses.length === 0) {
    return [...turnResponses];
  }

  const visibleContentByTurnId = new Map<string, string>();
  for (const message of visibleChatList) {
    if (message.role !== 'user' || typeof message.turnId !== 'string' || message.content.length === 0) {
      continue;
    }

    visibleContentByTurnId.set(message.turnId, message.content);
  }

  if (visibleContentByTurnId.size === 0) {
    return [...turnResponses];
  }

  return turnResponses.map((turn) => {
    const visibleDisplayContent = visibleContentByTurnId.get(turn.turnId);
    if (!visibleDisplayContent) {
      return turn;
    }

    if (typeof turn.request.displayContent === 'string' && turn.request.displayContent.length > 0) {
      return turn;
    }

    if (visibleDisplayContent === turn.request.content) {
      return turn;
    }

    return {
      ...turn,
      request: {
        ...turn.request,
        displayContent: visibleDisplayContent,
      },
    };
  });
}

function buildVisibleChatListForSave(
  previousProjectedChatList: HostResponseProjection['chatList'],
  currentProjectedChatList: HostResponseProjection['chatList'],
): ChatListItem[] {
  const projectedChatList = mergeProjectedChatListsForSave(
    previousProjectedChatList,
    currentProjectedChatList,
  );

  return projectedChatList.map(message => ({ ...message }));
}

function mergeProjectedChatListsForSave(
  previousProjectedChatList: HostResponseProjection['chatList'],
  currentProjectedChatList: HostResponseProjection['chatList'],
): HostResponseProjection['chatList'] {
  if (previousProjectedChatList.length === 0) {
    return currentProjectedChatList.map(message => ({ ...message }));
  }

  if (currentProjectedChatList.length === 0) {
    return previousProjectedChatList.map(message => ({ ...message }));
  }

  const consumedCurrentIndexes = new Set<number>();
  const mergedChatList = previousProjectedChatList.map((previousMessage) => {
    const matchedCurrentIndex = currentProjectedChatList.findIndex((currentMessage, currentIndex) => {
      if (consumedCurrentIndexes.has(currentIndex)) {
        return false;
      }

      if (typeof previousMessage.turnId === 'string' && previousMessage.turnId.length > 0) {
        return currentMessage.turnId === previousMessage.turnId && currentMessage.role === previousMessage.role;
      }

      return currentMessage.turnId === previousMessage.turnId
        && currentMessage.role === previousMessage.role
        && currentMessage.content === previousMessage.content
        && currentMessage.state === previousMessage.state;
    });

    if (matchedCurrentIndex === -1) {
      return { ...previousMessage };
    }

    consumedCurrentIndexes.add(matchedCurrentIndex);
    return { ...currentProjectedChatList[matchedCurrentIndex] };
  });

  currentProjectedChatList.forEach((currentMessage, currentIndex) => {
    if (consumedCurrentIndexes.has(currentIndex)) {
      return;
    }

    mergedChatList.push({ ...currentMessage });
  });

  return mergedChatList;
}

function resolveTurnResponsesForSave(
  liveTurnResponses: readonly TurnResponseTurn[] | undefined,
  hostProjection: HostResponseProjection | null,
  previousHostProjection: HostResponseProjection | null,
): TurnResponseTurn[] {
  const baseTurnResponses = (liveTurnResponses?.length
    ? liveTurnResponses
    : hostProjection?.turnResponses ?? []).map(turn => cloneTurnResponse(turn, { preserveTransientRuntimeStateParts: true }));

  return mergeStableTurnResponsesForSave(
    previousHostProjection?.turnResponses ?? [],
    baseTurnResponses,
  );
}

function applySessionSnapshotRoundsToTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
  sessionSnapshot: SessionSnapshot | null,
): TurnResponseTurn[] {
  if (turnResponses.length === 0 || !sessionSnapshot?.turns?.length) {
    return [...turnResponses];
  }

  const snapshotTurnsById = new Map(sessionSnapshot.turns.map(turn => [turn.id, turn] as const));

  return turnResponses.map((turn) => {
    const snapshotTurn = snapshotTurnsById.get(turn.turnId);
    if (!snapshotTurn) {
      return turn;
    }
    const snapshotRounds = cloneSessionSnapshotRounds(snapshotTurn.rounds ?? []);
    if (snapshotRounds.length === 0) {
      return turn;
    }
    if (Array.isArray(turn.rounds) && turn.rounds.length > 0) {
      const snapshotRoundsById = new Map(snapshotRounds.map(round => [round.id, round] as const));
      const mergedRounds = turn.rounds.map((round) => {
        const currentSummary = normalizeTurnResponseSummaryPreview(round.summary);
        if (currentSummary) {
          return round;
        }

        const snapshotSummary = normalizeTurnResponseSummaryPreview(snapshotRoundsById.get(round.id)?.summary);
        return snapshotSummary ? { ...round, summary: snapshotSummary } : round;
      });
      return {
        ...turn,
        rounds: mergedRounds,
      };
    }

    return {
      ...turn,
      rounds: snapshotRounds,
    };
  });
}

function applyRuntimeStateSummariesToTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
): TurnResponseTurn[] {
  return turnResponses.map((turn) => {
    if (!Array.isArray(turn.rounds) || turn.rounds.length === 0) {
      return turn;
    }

    const summaries = collectRuntimeStateRoundSummaries(turn);
    if (summaries.byId.size === 0 && summaries.byIndex.size === 0) {
      return turn;
    }

    let changed = false;
    const rounds = turn.rounds.map((round, index) => {
      if (normalizeTurnResponseSummaryPreview(round.summary)) {
        return round;
      }

      const summary = normalizeTurnResponseSummaryPreview(summaries.byId.get(round.id))
        ?? normalizeTurnResponseSummaryPreview(summaries.byIndex.get(index));
      if (!summary) {
        return round;
      }

      changed = true;
      return {
        ...round,
        summary,
      };
    });

    return changed ? { ...turn, rounds } : turn;
  });
}

function collectRuntimeStateRoundSummaries(
  turn: TurnResponseTurn,
): { readonly byId: Map<string, string>; readonly byIndex: Map<number, string> } {
  const byId = new Map<string, string>();
  const byIndex = new Map<number, string>();
  for (const part of turn.response.parts ?? []) {
    if (!isTransientRuntimeStatePart(part)) {
      continue;
    }

    const metadata = readRecordLike((part as { readonly metadata?: unknown }).metadata);
    const boundary = readRecordLike(metadata?.['boundary']);
    const metadataSummary = metadata?.['summary'];
    const summary = normalizeTurnResponseSummaryPreview(typeof metadataSummary === 'string' ? metadataSummary : undefined)
      ?? normalizeTurnResponseSummaryPreview((part as { readonly text?: unknown }).text as string | undefined);
    if (!summary) {
      continue;
    }

    const anchorRoundId = typeof boundary?.['anchorRoundId'] === 'string'
      ? boundary['anchorRoundId'].trim()
      : '';
    if (anchorRoundId) {
      byId.set(anchorRoundId, summary);
    }

    const roundIndex = boundary?.['roundIndex'];
    if (typeof roundIndex === 'number' && Number.isInteger(roundIndex) && roundIndex >= 0) {
      byIndex.set(roundIndex, summary);
    }
  }

  return { byId, byIndex };
}

function readRecordLike(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cloneSessionSnapshotRounds(
  rounds: readonly NonNullable<SessionSnapshot['turns']>[number]['rounds'][number][],
): TurnResponseTurn['rounds'] {
  return rounds.map((round) => {
    const { summary: _summary, ...roundWithoutSummary } = round;
    const summary = normalizeTurnResponseSummaryPreview(round.summary);

    return {
      ...roundWithoutSummary,
      toolCalls: (round.toolCalls ?? []).map(toolCall => ({ ...toolCall })),
      ...(summary ? { summary } : {}),
    };
  });
}

function mergeStableTurnResponsesForSave(
  previousTurnResponses: readonly TurnResponseTurn[],
  currentTurnResponses: readonly TurnResponseTurn[],
): TurnResponseTurn[] {
  if (previousTurnResponses.length === 0) {
    return currentTurnResponses.map(turn => cloneTurnResponse(turn, { preserveTransientRuntimeStateParts: true }));
  }

  if (currentTurnResponses.length === 0) {
    return previousTurnResponses
      .filter(isStablePersistableTurnResponse)
      .map(turn => cloneTurnResponse(turn));
  }

  if (isExplicitTurnTailTruncation(previousTurnResponses, currentTurnResponses)) {
    return currentTurnResponses.map(turn => cloneTurnResponse(turn, { preserveTransientRuntimeStateParts: true }));
  }

  const currentTurnsById = new Map(currentTurnResponses.map(turn => [turn.turnId, cloneTurnResponse(turn, { preserveTransientRuntimeStateParts: true })] as const));
  const currentRequestIds = new Set(currentTurnResponses.map(readTurnResponseRequestId).filter(Boolean));
  const missingStableTurnIds = previousTurnResponses
    .filter(turn => !currentTurnsById.has(turn.turnId)
      && !currentRequestIds.has(readTurnResponseRequestId(turn) ?? '')
      && isStablePersistableTurnResponse(turn))
    .map(turn => turn.turnId);

  if (missingStableTurnIds.length === 0) {
    return [...currentTurnsById.values()];
  }

  const mergedTurnResponses: TurnResponseTurn[] = [];
  const seenTurnIds = new Set<string>();

  for (const turn of previousTurnResponses) {
    const replacement = currentTurnsById.get(turn.turnId);
    if (replacement) {
      mergedTurnResponses.push(replacement);
      currentTurnsById.delete(turn.turnId);
      seenTurnIds.add(turn.turnId);
      continue;
    }

    if (!isStablePersistableTurnResponse(turn)) {
      continue;
    }

    if (currentRequestIds.has(readTurnResponseRequestId(turn) ?? '')) {
      continue;
    }

    mergedTurnResponses.push(cloneTurnResponse(turn));
    seenTurnIds.add(turn.turnId);
  }

  for (const turn of currentTurnResponses) {
    if (seenTurnIds.has(turn.turnId)) {
      continue;
    }

    mergedTurnResponses.push(cloneTurnResponse(turn, { preserveTransientRuntimeStateParts: true }));
    seenTurnIds.add(turn.turnId);
  }

  return mergedTurnResponses;
}

function isExplicitTurnTailTruncation(
  previousTurnResponses: readonly TurnResponseTurn[],
  currentTurnResponses: readonly TurnResponseTurn[],
): boolean {
  if (currentTurnResponses.length === 0 || currentTurnResponses.length >= previousTurnResponses.length) {
    return false;
  }

  for (let index = 0; index < currentTurnResponses.length; index += 1) {
    if (previousTurnResponses[index]?.turnId !== currentTurnResponses[index]?.turnId) {
      return false;
    }
  }

  return true;
}

function normalizePersistedSlashCommand(
  slashCommand: TurnResponseCommand | null | undefined,
): TurnResponseCommand | undefined {
  if (!slashCommand || typeof slashCommand.name !== 'string') {
    return undefined;
  }

  const normalizedName = slashCommand.name.trim();
  if (!normalizedName) {
    return undefined;
  }

  return { ...slashCommand, name: normalizedName };
}

interface CloneTurnResponseOptions {
  readonly preserveTransientRuntimeStateParts?: boolean;
}

function cloneTurnResponse(
  turn: TurnResponseTurn,
  options?: CloneTurnResponseOptions,
): TurnResponseTurn {
  const responseModel = cloneTurnResponseModelSidecar(turn.responseModel);
  if (!turn.response) {
    return {
      ...turn,
      request: { ...turn.request },
      rounds: cloneSessionSnapshotRounds(turn.rounds ?? []),
      ...(turn.usage ? { usage: { ...turn.usage } } : {}),
      ...(responseModel ? { responseModel } : {}),
    } as TurnResponseTurn;
  }
  const {
    slashCommand: _slashCommand,
    responseId: _responseId,
    responseMarkdownInfo: _responseMarkdownInfo,
    modelState: _modelState,
    vote: _vote,
    timestamp: _timestamp,
    elapsedMs: _elapsedMs,
    timeSpentWaiting: _timeSpentWaiting,
    completionTokens: _completionTokens,
    ...responseWithoutPersistedData
  } = turn.response as TurnResponseTurn['response'] & PersistedHostResponseData;

  return {
    ...turn,
    request: { ...turn.request },
    rounds: cloneSessionSnapshotRounds(turn.rounds ?? []),
    ...(turn.usage ? { usage: { ...turn.usage } } : {}),
    response: {
      ...sanitizeTransientPersistedResponseStatus(responseWithoutPersistedData),
      ...(turn.response.usedContext
        ? {
          usedContext: {
            ...turn.response.usedContext,
            documents: turn.response.usedContext.documents.map(document => ({
              ...document,
              ranges: document.ranges.map(range => ({ ...range })),
            })),
          },
        }
        : {}),
      contentReferences: (turn.response.contentReferences ?? []).map(reference => ({
        ...reference,
        ...(reference.options
          ? {
            options: {
              ...reference.options,
              ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
              ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
            },
          }
          : {}),
      })),
      codeCitations: (turn.response.codeCitations ?? []).map(citation => ({ ...citation })),
      progressMessages: (turn.response.progressMessages ?? []).map(message => ({ ...message })),
      parts: options?.preserveTransientRuntimeStateParts === true
        ? cloneResponseParts(turn.response.parts)
        : clonePersistableResponseParts(turn.response.parts),
    },
    ...(responseModel ? { responseModel } : {}),
  };
}

function cloneResponseParts(
  parts: TurnResponseTurn['response']['parts'],
): TurnResponseTurn['response']['parts'] {
  return parts.map(part => ({ ...part }));
}

function buildCheckpointSidecars(
  state: SessionCheckpointTimelineState | null | undefined,
  canonicalTurnResponses: readonly TurnResponseTurn[] = [],
): Pick<HostSessionSidecar, 'checkpointMarker' | 'checkpointRedoBranch'> | undefined {
  const sidecarState = reconcileCheckpointTimelineForSave(state, canonicalTurnResponses);
  const sessionResource = typeof sidecarState?.sessionResource === 'string'
    ? sidecarState.sessionResource.trim()
    : '';
  if (!sessionResource
    || typeof sidecarState?.currentCheckpointIndex !== 'number'
    || !Number.isFinite(sidecarState.currentCheckpointIndex)) {
    return undefined;
  }

  const turnResponseCount = Array.isArray(sidecarState.turnResponses) ? sidecarState.turnResponses.length : 0;
  const checkpointCount = Array.isArray(sidecarState.checkpoints) ? sidecarState.checkpoints.length : 0;
  const currentCheckpointIndex = normalizeCheckpointSidecarIndex(sidecarState.currentCheckpointIndex, checkpointCount);
  const currentTurnResponseCount = normalizeCheckpointSidecarTurnResponseCount(
    sidecarState.currentTurnResponseCount,
    turnResponseCount,
  );

  const checkpointMarker = {
    sessionResource,
    currentCheckpointIndex,
    currentTurnResponseCount,
  };

  if (!checkpointCount || !turnResponseCount || !canRedoSessionCheckpointTimeline(sidecarState)) {
    return {
      checkpointMarker,
    };
  }

  return {
    checkpointMarker,
    checkpointRedoBranch: {
      sessionResource,
      currentCheckpointIndex,
      currentTurnResponseCount,
      checkpoints: sidecarState.checkpoints.map(checkpoint => cloneCheckpointTimelineEntry(checkpoint)),
      turnResponses: sidecarState.turnResponses.map(turn => cloneTurnResponse(turn) as PersistedHostTurnResponse),
    },
  };
}

function reconcileCheckpointTimelineForSave(
  state: SessionCheckpointTimelineState | null | undefined,
  canonicalTurnResponses: readonly TurnResponseTurn[],
): SessionCheckpointTimelineState | null {
  const sessionResource = typeof state?.sessionResource === 'string'
    ? state.sessionResource.trim()
    : '';
  if (!sessionResource
    || typeof state?.currentCheckpointIndex !== 'number'
    || !Number.isFinite(state.currentCheckpointIndex)) {
    return null;
  }

  if (canRedoSessionCheckpointTimeline(state) || canonicalTurnResponses.length === 0) {
    return state;
  }

  const checkpointsByTurnId = new Map<string, SessionCheckpointTimelineEntry>();
  const checkpointsByCheckpointId = new Map<string, SessionCheckpointTimelineEntry>();
  const checkpointsByRequestId = new Map<string, SessionCheckpointTimelineEntry>();
  for (const checkpoint of state.checkpoints ?? []) {
    const turnId = normalizeCheckpointSidecarString(checkpoint.turnId);
    if (turnId && !checkpointsByTurnId.has(turnId)) {
      checkpointsByTurnId.set(turnId, checkpoint);
    }
    const checkpointId = normalizeCheckpointSidecarString(checkpoint.checkpointId);
    if (checkpointId && !checkpointsByCheckpointId.has(checkpointId)) {
      checkpointsByCheckpointId.set(checkpointId, checkpoint);
    }
    const requestId = normalizeCheckpointSidecarString(checkpoint.requestId);
    if (requestId && !checkpointsByRequestId.has(requestId)) {
      checkpointsByRequestId.set(requestId, checkpoint);
    }
  }

  const turnResponses = canonicalTurnResponses.map(turn => cloneTurnResponse(turn) as TurnResponseTurn);
  const checkpoints: SessionCheckpointTimelineEntry[] = [];
  turnResponses.forEach((turn, turnIndex) => {
    const requestMetadata = readCheckpointSidecarRequestMetadata(turn);
    const turnId = normalizeCheckpointSidecarString(turn.turnId);
    const metadataCheckpointId = normalizeCheckpointSidecarString(requestMetadata?.['checkpointId']);
    const metadataRequestId = normalizeCheckpointSidecarString(requestMetadata?.['requestId']);
    const existing = (turnId ? checkpointsByTurnId.get(turnId) : undefined)
      ?? (metadataCheckpointId ? checkpointsByCheckpointId.get(metadataCheckpointId) : undefined)
      ?? (metadataRequestId ? checkpointsByRequestId.get(metadataRequestId) : undefined);
    const checkpointId = metadataCheckpointId
      || normalizeCheckpointSidecarString(existing?.checkpointId);
    if (!checkpointId) {
      return;
    }

    const requestId = metadataRequestId
      || normalizeCheckpointSidecarString(existing?.requestId)
      || turnId
      || checkpointId;
    const metadata = existing?.metadata ? cloneCheckpointMetadata(existing.metadata) : undefined;
    if (metadata) {
      metadata.turnIndex = turnIndex;
      if (turnId) {
        metadata.turnId = turnId;
      }
    }
    checkpoints.push({
      checkpointId,
      requestId,
      ...(turnId ? { turnId } : {}),
      turnIndex,
      ...(metadata ? { metadata } : {}),
    });
  });

  return {
    sessionResource,
    turnResponses,
    checkpoints,
    currentCheckpointIndex: checkpoints.length - 1,
    currentTurnResponseCount: turnResponses.length,
  };
}

function readCheckpointSidecarRequestMetadata(turn: TurnResponseTurn): Record<string, unknown> | null {
  const metadata = turn.request?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
}

function normalizeCheckpointSidecarString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCheckpointSidecarIndex(value: number, checkpointCount: number): number {
  if (checkpointCount <= 0) {
    return -1;
  }
  return Math.max(-1, Math.min(Math.trunc(value), checkpointCount - 1));
}

function normalizeCheckpointSidecarTurnResponseCount(value: number, turnResponseCount: number): number {
  return Math.max(0, Math.min(Math.trunc(value), turnResponseCount));
}

function cloneCheckpointTimelineEntry(checkpoint: SessionCheckpointTimelineEntry): SessionCheckpointTimelineEntry {
  return {
    ...checkpoint,
    ...(checkpoint.metadata ? { metadata: cloneCheckpointMetadata(checkpoint.metadata) } : {}),
  };
}

function cloneCheckpointMetadata<T>(metadata: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(metadata) as T;
  }
  return JSON.parse(JSON.stringify(metadata)) as T;
}

function isStablePersistableTurnResponse(turn: TurnResponseTurn): boolean {
  if (turn.response.status === 'streaming') {
    return false;
  }

  const parts = Array.isArray(turn.response.parts) ? turn.response.parts : [];
  const resultText = typeof turn.response.resultText === 'string' ? turn.response.resultText : '';
  return !!turn.response.status
    || parts.length > 0
    || resultText.length > 0
    || !!turn.response.continuation;
}

function readTurnResponseRequestId(turn: TurnResponseTurn | null | undefined): string | null {
  const requestId = turn?.request?.metadata?.['requestId'];
  return typeof requestId === 'string' && requestId.trim().length > 0
    ? requestId.trim()
    : null;
}

function sanitizeTransientPersistedResponseStatus(
  response: TurnResponseTurn['response'],
): TurnResponseTurn['response'] {
  const nextResponse = { ...response } as TurnResponseTurn['response'] & {
    continuation?: Record<string, unknown>;
  };
  const mutableResponse = nextResponse as unknown as Record<string, unknown>;
  const responseStatus = normalizeResponseStatus(mutableResponse['status']);
  if (isTransientResponseStatus(responseStatus)) {
    delete mutableResponse['status'];
  }
  if (nextResponse.continuation) {
    const continuation = { ...nextResponse.continuation };
    const continuationStatus = normalizeResponseStatus(continuation['status']);
    const isTerminalPlanTurn = isTerminalResponseStatus(responseStatus)
      && nextResponse.parts.some(part => part.type === 'plan');
    if (isTransientResponseStatus(continuationStatus)
      || (isTerminalPlanTurn && isPlanReviewContinuation(continuation))) {
      delete continuation['status'];
    }
    if (isTerminalPlanTurn && isPlanReviewContinuation(continuation)) {
      delete continuation['pendingState'];
    }
    if (Object.keys(continuation).length > 0) {
      nextResponse.continuation = continuation;
    } else {
      delete nextResponse.continuation;
    }
  }
  return nextResponse;
}

function normalizeResponseStatus(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isTransientResponseStatus(status: string): boolean {
  return status === 'in_progress'
    || status === 'running'
    || status === 'streaming'
    || status === 'pending';
}

function isTerminalResponseStatus(status: string): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'canceled'
    || status === 'failed'
    || status === 'error';
}

function isPlanReviewContinuation(continuation: Record<string, unknown>): boolean {
  const status = normalizeResponseStatus(continuation['status']);
  if (status === 'waiting_plan_review' || status === 'plan_review') {
    return true;
  }

  const pendingState = continuation['pendingState'];
  return !!pendingState
    && typeof pendingState === 'object'
    && normalizeResponseStatus((pendingState as Record<string, unknown>)['kind']) === 'plan_review';
}

function clonePersistableResponseParts(
  parts: TurnResponseTurn['response']['parts'],
): TurnResponseTurn['response']['parts'] {
  return parts
    .filter(part => !isTransientRuntimeStatePart(part))
    .map(part => ({ ...part }));
}

function isTransientRuntimeStatePart(
  part: TurnResponseTurn['response']['parts'][number],
): boolean {
  return part.type === 'state'
    && (part.kind === 'compaction' || part.kind === 'provider_context_management');
}

function persistResponseDataOnTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
  hostProjection: HostResponseProjection | null,
  previousHostProjection: HostResponseProjection | null,
  hostRequestModel: HostRequestModel | null,
): PersistedHostTurnResponse[] {
  const responseDataByTurnId = new Map<string, PersistedHostResponseData>();

  collectResponseSidecarFromProjection(responseDataByTurnId, previousHostProjection);
  collectResponseSidecarFromProjection(responseDataByTurnId, hostProjection);

  if (hostRequestModel?.turnId && hostRequestModel.response) {
    const response = hostRequestModel.response;
    responseDataByTurnId.set(
      hostRequestModel.turnId,
      {
        ...(normalizePersistedSlashCommand(response.slashCommand) ? { slashCommand: normalizePersistedSlashCommand(response.slashCommand) } : {}),
        ...(typeof response.id === 'string' && response.id.length > 0 ? { responseId: response.id } : {}),
        ...(Array.isArray(response.responseMarkdownInfo) && response.responseMarkdownInfo.length > 0
          ? { responseMarkdownInfo: response.responseMarkdownInfo.map(info => ({ ...info })) }
          : {}),
        ...(response.followups.length > 0
          ? { followups: response.followups.map(followup => ({ ...followup })) }
          : {}),
        ...(response.modelState ? { modelState: { ...response.modelState } } : {}),
        ...(response.vote === 0 || response.vote === 1 ? { vote: response.vote } : {}),
        ...(typeof response.timestamp === 'number' ? { timestamp: response.timestamp } : {}),
        ...(typeof response.elapsedMs === 'number' ? { elapsedMs: response.elapsedMs } : {}),
        ...(typeof response.confirmationAdjustedTimestamp === 'number' && typeof response.timestamp === 'number'
          ? { timeSpentWaiting: Math.max(0, response.confirmationAdjustedTimestamp - response.timestamp) }
          : {}),
        ...(typeof response.completionTokenCount === 'number' ? { completionTokens: response.completionTokenCount } : {}),
      },
    );
  }

  return turnResponses.map((turn) => {
    const persistedResponseData = responseDataByTurnId.get(turn.turnId);
    const clonedTurn = cloneTurnResponse(turn);
    if (!persistedResponseData) {
      return clonedTurn as PersistedHostTurnResponse;
    }

    return {
      ...clonedTurn,
      response: {
        ...clonedTurn.response,
        ...persistedResponseData,
      },
    } satisfies PersistedHostTurnResponse;
  });
}

function deriveSkillInvocationTrace(
  turnResponses: readonly Pick<TurnResponseTurn, 'response'>[] | undefined,
): HostSessionSkillInvocationTraceEntry[] {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return [];
  }

  const entries = new Map<string, HostSessionSkillInvocationTraceEntry>();

  for (const turn of turnResponses) {
    for (const part of turn.response.parts ?? []) {
      if (part.type !== 'tool_call' || part.toolName !== 'load_skill') {
        continue;
      }

      const entry = deriveSkillInvocationTraceEntry(part.toolCallId, part.metadata);
      if (entry) {
        entries.set(entry.toolCallId, entry);
      }
    }
  }

  return [...entries.values()];
}

function deriveSkillInvocationTraceEntry(
  toolCallId: string,
  metadata: Record<string, unknown> | undefined,
): HostSessionSkillInvocationTraceEntry | null {
  if (!metadata || metadata['kind'] !== 'skill') {
    return null;
  }

  const skill = metadata['skill'];
  const relatedFiles = metadata['relatedFiles'];
  if (!skill || typeof skill !== 'object') {
    return null;
  }

  const skillRecord = skill as {
    name?: unknown;
    skillUri?: unknown;
    skillMdPath?: unknown;
    mode?: unknown;
    scope?: unknown;
  };
  const invocationRecord = metadata['invocation'] && typeof metadata['invocation'] === 'object'
    ? metadata['invocation'] as { scope?: unknown }
    : undefined;
  const normalizedToolCallId = typeof toolCallId === 'string' ? toolCallId.trim() : '';
  const name = typeof skillRecord.name === 'string' ? skillRecord.name.trim() : '';
  const skillUri = typeof skillRecord.skillUri === 'string'
    ? skillRecord.skillUri.trim()
    : (typeof skillRecord.skillMdPath === 'string' ? skillRecord.skillMdPath.trim() : '');
  if (!normalizedToolCallId || !name || !skillUri) {
    return null;
  }

  return {
    toolCallId: normalizedToolCallId,
    name,
    skillUri,
    mode: skillRecord.mode === 'fork' ? 'fork' : 'inline',
    scope: skillRecord.scope === 'session' || invocationRecord?.scope === 'session' ? 'session' : 'request',
    relatedFiles: Array.isArray(relatedFiles)
      ? relatedFiles
        .map(file => {
          if (!file || typeof file !== 'object') {
            return null;
          }

          const fileRecord = file as { path?: unknown; uri?: unknown; category?: unknown };
          const path = typeof fileRecord.path === 'string' ? fileRecord.path.trim() : '';
          const uri = typeof fileRecord.uri === 'string' ? fileRecord.uri.trim() : '';
          if (!path || !uri) {
            return null;
          }

          return {
            path,
            uri,
            ...(typeof fileRecord.category === 'string' && fileRecord.category.trim().length > 0
              ? { category: fileRecord.category.trim() }
              : {}),
          };
        })
        .filter((file): file is HostSessionSkillInvocationTraceEntry['relatedFiles'][number] => !!file)
      : [],
  };
}

function collectResponseSidecarFromProjection(
  target: Map<string, PersistedHostResponseData>,
  hostProjection: HostResponseProjection | null,
): void {
  const state = isHostTurnResponseState(hostProjection) ? hostProjection : null;
  if (!state) {
    return;
  }

  for (const entry of state.entries) {
    const responseSidecar = entry.runtimeState?.responseSidecar;
    if (!responseSidecar) {
      continue;
    }

    target.set(entry.turnId, {
      ...(normalizePersistedSlashCommand(responseSidecar.slashCommand) ? { slashCommand: normalizePersistedSlashCommand(responseSidecar.slashCommand) } : {}),
      ...(typeof responseSidecar.responseId === 'string' && responseSidecar.responseId.length > 0
        ? { responseId: responseSidecar.responseId }
        : (typeof entry.turnResponse?.response.id === 'string' && entry.turnResponse.response.id.length > 0
          ? { responseId: entry.turnResponse.response.id }
          : {})),
      ...(Array.isArray(responseSidecar.responseMarkdownInfo) && responseSidecar.responseMarkdownInfo.length > 0
        ? { responseMarkdownInfo: responseSidecar.responseMarkdownInfo.map(info => ({ ...info })) }
        : {}),
      ...(responseSidecar.followups ? { followups: responseSidecar.followups.map(followup => ({ ...followup })) } : {}),
      ...(responseSidecar.modelState ? { modelState: { ...responseSidecar.modelState } } : {}),
      ...(responseSidecar.vote === 0 || responseSidecar.vote === 1 ? { vote: responseSidecar.vote } : {}),
      ...(typeof responseSidecar.timestamp === 'number' ? { timestamp: responseSidecar.timestamp } : {}),
      ...(typeof responseSidecar.elapsedMs === 'number' ? { elapsedMs: responseSidecar.elapsedMs } : {}),
      ...(typeof responseSidecar.timeSpentWaiting === 'number' ? { timeSpentWaiting: responseSidecar.timeSpentWaiting } : {}),
      ...(typeof responseSidecar.completionTokens === 'number' ? { completionTokens: responseSidecar.completionTokens } : {}),
    });
  }
}

function stripFollowupsFromTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
): TurnResponseTurn[] {
  return turnResponses.map(turn => cloneTurnResponse(turn));
}

function isHostTurnResponseState(
  value: HostResponseProjection | null,
): value is HostTurnResponseState {
  return Array.isArray((value as HostTurnResponseState | null)?.entries);
}
