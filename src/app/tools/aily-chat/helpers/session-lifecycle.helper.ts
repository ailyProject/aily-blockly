/**
 * SessionLifecycleHelper — 会话生命周期辅助类
 *
 * 负责会话的创建、关闭、保存、历史加载等逻辑。
 * 负责本地 session/projection/restore 协调；interaction 的 authoritative state
 * 仍由 services 返回的 continuation / pendingState 决定，不在这里本地判定 lease 或 pending 合法性。
 */

import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import type { LiveHostSessionRecord } from '../services/chat-history.service';
import { countHostRecordMessages } from '../services/chat-history.service';
import type {
  HostSessionRecord,
  ImportedDebugSessionRecord,
} from '../services/chat-history.service';
import type {
  ChatSessionModelCreateProps,
  ChatSessionModelReference,
} from '../services/chat-session-model-store.service';
import type { ChatSessionViewModel } from '../services/chat-session-view-model-store.service';
import type { ChatSessionRuntimeState } from '../services/chat-session-runtime-store.service';
import type {
  ChatSessionEntryStateService,
  PersistedChatSessionEntryTarget,
} from '../services/chat-session-entry-state.service';
import { AilyHost } from '../core/host';
import { SkillRegistry } from '../core/skill-registry';
import {
  readHostSessionRestoreFailureDetails,
  sanitizeHostRecordForRestore,
  type RuntimeRestoreHostRecordRequest,
  type HostSessionRestoreFailureDetails,
  type HostSessionRestoreOptions,
} from './host-session-restore-bridge';
import type { HostSessionSaveContext, HostSessionSaveTarget } from './host-session-save-bridge';
import type { SessionLifecycleSaveBridgePort } from './session-lifecycle-save-bridge';
import {
  buildSessionTurnOwnerDiagnostics,
  formatSessionTurnOwnerDiagnosticsFields,
} from './session-turn-owner-diagnostics';
import type { ChatViewWriteBridgeContext } from './chat-view-write-bridge';
import type { ResourceItem } from '../core/chat-types';
import {
  hasHostResponseConversationContent,
  type HostResponseProjection,
} from './host-turn-response-state';
import type { ChatListItem } from '../services/chat-history.service';
import type { ChatSelectedMode } from '../core/chat-mode';
import { DEFAULT_CHAT_SESSION_TYPE, normalizeChatSelectedMode, normalizeChatSessionType, normalizeChatSurfaceModeId } from '../core/chat-mode';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import {
  chatSessionScopeProjectPath,
  resolveChatSessionScopeFromProject,
} from '../core/chat-session-scope';
import {
  buildHostSessionCurrentPickerInputState,
  createHostSessionProviderOptionsKey,
  normalizeHostSessionProviderOptions,
  resolveHostSessionProviderOptions,
  resolveHostSessionSelectedMode,
  type HostSessionProviderOptions,
} from './host-session-input-state';
import {
  buildHostSessionCurrentPickerRoutingSummary,
  normalizeHostSessionRequestRoutingSummary,
} from './host-session-request-routing';
import {
  resolveChatAgentRuntimeModeForProject,
  type ChatAgentRuntimeMode,
} from '../core/chat-agent-runtime-mode';
import { type ChatSessionTitleSource } from '../core/chat-session-title';
import { HostSessionItemController } from './host-session-item-controller';
import type { HostSessionSwitchRestoreDiagnostics } from './host-session-item-controller';
import {
  HostSessionContentProvider,
  resolveHostSessionProjectPathHint,
  type HostSessionContent,
  type HostSessionContentMetadataSource,
} from './host-session-content-provider';
import type { TurnResponseTurn } from 'aily-lex/browser';
import { buildTurnResponseLexSessionSnapshot } from './lex-agent-bootstrap';
import type { ChatSessionItemsService } from '../services/chat-session-items.service';
import { ChatSessionEntryCoordinator } from './chat-session-entry-coordinator';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import { createRequiredSessionResourceModel } from './required-session-resource-model';
import type {
  ChatRuntimeHostEditTrackingPayload,
  ChatRuntimeHostForkSessionRequest,
  ChatRuntimeHostForkSessionResult,
  ChatRuntimeHostPrewarmRequest,
  ChatRuntimeHostPrewarmResult,
  ChatRuntimeHostRestoreRuntimeSessionRequest,
  ChatRuntimeHostRestoreRuntimeSessionResult,
  ChatRuntimeHostSessionExecutionState,
} from '../core/chat-runtime-host-contract';

type LexInteractionAction = NonNullable<import('aily-lex/browser').TurnRequest['metadata']>['interactionAction'];

function applyCurrentSessionTitle(
  chatService: {
    currentSessionTitle?: string;
    setCurrentSessionTitle?: (candidate: { text: string; source: ChatSessionTitleSource }) => void;
  },
  candidate: { text: string; source: ChatSessionTitleSource },
): void {
  if (typeof chatService.setCurrentSessionTitle === 'function') {
    chatService.setCurrentSessionTitle(candidate);
    return;
  }

  chatService.currentSessionTitle = candidate.text;
}

type SessionLifecycleContext = ChatViewWriteBridgeContext
  & Pick<
    IAgentLifecycle,
    | 'isWaiting'
    | 'isSessionStarting'
    | 'isCancelled'
    | 'toolCallingIteration'
    | 'mcpInitialized'
    | 'isCompleted'
    | 'messageSubscription'
    | 'activeToolExecutions'
    | 'hasInitializedForThisLogin'
    | 'legacyActivatedDeferredTools'
  >
  & Pick<ISessionAccess, 'sessionTitle' | 'sessionAllowedPaths' | 'conversationMessages' | 'chatService' | 'chatHistoryService'>
  & Pick<IProjectContext, 'currentMode' | 'currentAgentRuntimeMode' | 'currentAgentRuntimeModeSource' | 'currentModel' | 'prjPath' | 'prjRootPath' | 'isLoggedIn'>
  & Pick<
    IChatServiceAccess,
    | 'contextBudgetService'
    | 'repetitionDetectionService'
    | 'mcpService'
    | 'ailyChatConfigService'
    | 'runtimeInteractionHost'
    | 'resourceManager'
    | 'message'
    | 'translate'
  >
  & Pick<IChatCoordination, 'interaction' | 'lexStream' | 'send' | 'session'>
  & {
    readonly chatSessionItemsService?: Pick<ChatSessionItemsService, 'sessionItemController' | 'refreshHistoryList' | 'requestSessionListRefresh' | 'loadInitialSummaries' | 'sessionListItems'>;
    readonly chatSessionEntryStateService?: Pick<
      ChatSessionEntryStateService,
      'readSessionEntryTarget' | 'setSessionEntryTarget' | 'clearSessionEntryTarget' | 'readEntryProviderOptions' | 'setEntryProviderOptions'
    >;
    readonly hostResponseProjection?: HostSessionSaveContext['hostResponseProjection'];
    acquireExistingSessionModel?(sessionId?: string | null): ChatSessionModelReference | undefined;
    acquireSessionModel?(props: ChatSessionModelCreateProps): ChatSessionModelReference;
    acquireProvisionalSessionModel?(props: ChatSessionModelCreateProps): ChatSessionModelReference;
    attachSessionViewModel?(sessionId?: string | null): ChatSessionViewModel | null;
    detachSessionViewModel?(sessionId?: string | null): void;
    readCurrentViewSessionResource?(): string | null;
    requestHostResourceOperation?: HostSessionSaveContext['requestHostResourceOperation'];
    createSessionSaveBridge(ctx: HostSessionSaveContext): SessionLifecycleSaveBridgePort;
    clearEntryInputState?(): void;
    buildExecutionSaveTarget?(sessionId: string | null | undefined): HostSessionSaveTarget | null;
    getDevelopmentModePreferenceRuntimeMode?(): ChatAgentRuntimeMode | undefined;
    readSessionTurnResponses?(sessionId?: string | null): readonly TurnResponseTurn[];
    forkSessionThroughHost?(
      request: Omit<ChatRuntimeHostForkSessionRequest, 'expectedRevision'>,
    ): Promise<ChatRuntimeHostForkSessionResult>;
    readSessionRuntimeState?(sessionId?: string | null): Readonly<ChatSessionRuntimeState> | undefined;
    readSessionCheckpointTimelineState?(sessionId?: string | null): import('./session-checkpoint-timeline-model').SessionCheckpointTimelineState | null;
    hasSessionRuntimeHandle?(sessionId?: string | null): boolean;
    prewarmRuntimeExecutor?(request: ChatRuntimeHostPrewarmRequest): Promise<ChatRuntimeHostPrewarmResult>;
    restoreRuntimeSessionExecutor?(
      request: ChatRuntimeHostRestoreRuntimeSessionRequest,
    ): Promise<ChatRuntimeHostRestoreRuntimeSessionResult>;
    readExecutionRuntimeSessionState?(
      sessionId: string,
    ): Promise<ChatRuntimeHostSessionExecutionState>;
    projectRestoredRuntimeAuxiliary?(sessionId: string, auxiliary: HostSessionRecord['auxiliary'] | null | undefined): void;
    detachSessionRuntimeView?(sessionId?: string | null): boolean;
    attachSessionView?(sessionId?: string | null): Promise<void>;
    attachCurrentSessionView?(): Promise<void>;
    markVisibleSessionProjectionOwner?(sessionId?: string | null): void;
    ensureBackgroundSessionCanRerun?(sessionId?: string | null): void;
    resetVisibleSessionProjection(options?: {
      readonly clearResolvedActiveModel?: boolean;
      readonly clearTurns?: boolean;
      readonly resetContextBudget?: boolean;
      readonly clearEditSummary?: boolean;
      readonly resetToolCallingIteration?: boolean;
      readonly detectChanges?: boolean;
    }): void;
    buildRuntimeRestoreHostRecord?(request: RuntimeRestoreHostRecordRequest): HostSessionRecord | null;
    restoreSessionHostRecord(hostRecord: HostSessionRecord, options?: HostSessionRestoreOptions): Promise<void>;
    resumeRestoredInteraction?(
      content: string,
      interactionAction: LexInteractionAction,
      options?: {
        readonly sessionId?: string | null;
        readonly requestMetadata?: import('aily-lex/browser').TurnRequest['metadata'];
      },
    ): Promise<void>;
    restoreSharedHostProjectionState?(
      state: import('./host-turn-response-state').HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    replaceSharedHostProjectionState?(
      state: import('./host-turn-response-state').HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
  };

type SessionSwitchRestoreStage = 'session-start' | 'host-restore' | 'missing-record';
function isSessionLifecycleTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceSessionLifecycle', [
    '__AILY_CHAT_TRACE_SESSION_LIFECYCLE__',
    'AILY_CHAT_TRACE_SESSION_LIFECYCLE',
  ]) || isAilyCategoryDebugEnabled('aily.chat.traceRequestState', [
    '__AILY_CHAT_TRACE_REQUEST_STATE__',
    'AILY_CHAT_TRACE_REQUEST_STATE',
  ]);
}

export interface SessionLifecycleRestoreErrorDetails {
  readonly stage: SessionSwitchRestoreStage;
  readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
  readonly restoreFailure: HostSessionRestoreFailureDetails | null;
}

export interface SessionLifecycleSwitchOptions {
  readonly fallbackProjectPath?: string | null;
  readonly hostRecordOverride?: HostSessionRecord | null;
}

export class SessionLifecycleSupersededError extends Error {
  constructor(message = '[SessionLifecycle] Session activation superseded by a newer request') {
    super(message);
    this.name = 'SessionLifecycleSupersededError';
  }
}

export class SessionLifecycleRestoreError extends Error {
  readonly details: SessionLifecycleRestoreErrorDetails;

  constructor(
    message: string,
    details: SessionLifecycleRestoreErrorDetails,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'SessionLifecycleRestoreError';
    this.details = details;
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export function readSessionLifecycleRestoreErrorDetails(value: unknown): SessionLifecycleRestoreErrorDetails | null {
  return value instanceof SessionLifecycleRestoreError
    ? value.details
    : null;
}

export function isSessionLifecycleSupersededError(value: unknown): value is SessionLifecycleSupersededError {
  return value instanceof SessionLifecycleSupersededError;
}

export class SessionLifecycleHelper {
  private readonly _sessionSaveBridge: SessionLifecycleSaveBridgePort;
  private readonly _hostSessionContentProvider: HostSessionContentProvider;
  private _localHostSessionItemController: HostSessionItemController | null = null;
  private readonly _entryCoordinator: ChatSessionEntryCoordinator;
  private readonly sessionModelReferences = new Map<string, ChatSessionModelReference>();
  private readonly sessionModelPreloadPromises = new Map<string, Promise<boolean>>();
  private readonly pendingFreshSessionShellFinalizers = new Map<string, () => void>();
  private provisionalSessionBootstrapHandle: number | null = null;
  private sessionActivationRequestId = 0;

  constructor(private ctx: SessionLifecycleContext) {
    this._sessionSaveBridge = this.ctx.createSessionSaveBridge(this.ctx);
    this._hostSessionContentProvider = new HostSessionContentProvider(this.ctx);
    this._entryCoordinator = new ChatSessionEntryCoordinator({
      get isLoggedIn() {
        return ctx.isLoggedIn;
      },
      get hasCurrentSession() {
        const currentViewSessionResource = typeof ctx.readCurrentViewSessionResource === 'function'
          ? ctx.readCurrentViewSessionResource()
          : null;
        if (typeof currentViewSessionResource === 'string'
          && currentViewSessionResource.trim().length > 0) {
          return true;
        }

        const liveSessionId = typeof ctx.chatService.currentSessionId === 'string'
          ? ctx.chatService.currentSessionId.trim()
          : '';
        if (!liveSessionId) {
          return false;
        }

        const runtimeState = typeof ctx.readSessionRuntimeState === 'function'
          ? ctx.readSessionRuntimeState(liveSessionId)
          : undefined;
        return runtimeState?.requestInProgress === true
          || (runtimeState?.turnResponses?.length ?? 0) > 0
          || ctx.hasSessionRuntimeHandle?.(liveSessionId) === true;
      },
      enterEntryState: (options) => this.enterEntryState(options),
      enterBlankSessionShell: (options) => this.enterBlankSessionShell(options),
      startSession: (options) => this.startSession(options),
      restorePersistedSessionTarget: () => this.restorePersistedSessionTarget(),
      requestSessionListRefresh: (input) => this.requestSessionListRefresh(input),
    });
  }

  private get hostSessionItemController(): HostSessionItemController {
    const sessionItemsService = this.ctx.chatSessionItemsService;
    if (sessionItemsService?.sessionItemController) {
      return sessionItemsService.sessionItemController;
    }

    if (!this._localHostSessionItemController) {
      this._localHostSessionItemController = new HostSessionItemController(this.ctx);
    }

    return this._localHostSessionItemController;
  }

  buildHostSessionRecord(options?: {
    previousHostProjection?: HostResponseProjection | null;
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    turnResponsesOverride?: readonly import('aily-lex/browser').TurnResponseTurn[];
    hostRequestModel?: import('./host-turn-response-state').HostRequestModel | null;
    target: HostSessionSaveTarget | null;
  }): LiveHostSessionRecord | null {
    return options ? this._sessionSaveBridge.buildHostSessionRecord(options) : null;
  }

  buildLiveHostSessionRecord(options?: {
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    turnResponsesOverride?: readonly import('aily-lex/browser').TurnResponseTurn[];
    sessionSnapshotOverride?: import('aily-lex/browser').SessionSnapshot | null;
    target?: HostSessionSaveTarget | null;
  }): LiveHostSessionRecord | null {
    return this._sessionSaveBridge.buildLiveHostSessionRecord(options);
  }

  async importDebugSnapshot(data: Uint8Array): Promise<ImportedDebugSessionRecord | null> {
    return this.ctx.chatHistoryService.importDebugSnapshot?.(data) ?? null;
  }

  async openImportedDebugSnapshot(sessionId: string): Promise<boolean> {
    const imported = this.ctx.chatHistoryService.getImportedDebugSnapshot?.(sessionId) ?? null;
    return !!imported;
  }

  async restorePersistedSessionTarget(): Promise<boolean> {
    const entryStateService = this.ctx.chatSessionEntryStateService;
    if (!entryStateService) {
      return false;
    }

    const currentProjectPathHint = this.resolveCurrentProjectPath();
    const target = entryStateService.readSessionEntryTarget(currentProjectPathHint);
    if (!target?.sessionId) {
      return false;
    }

    if (this.ctx.chatHistoryService.findEntry(target.sessionId)) {
      await this.switchToSession(target.sessionId);
      return true;
    }

    const projectPathHint = target.projectPath ?? this.resolveCurrentProjectPath();
    if (!this.ctx.readSessionRuntimeState?.(target.sessionId)) {
      entryStateService.clearSessionEntryTarget(target.sessionId, projectPathHint);
      return false;
    }

    const restored = await this.restoreManagedSessionTarget(target);
    if (!restored) {
      entryStateService.clearSessionEntryTarget(target.sessionId, projectPathHint);
    }

    return restored;
  }

  async initializeEntryInventory(options?: { readonly restorePersistedTarget?: boolean }): Promise<boolean> {
    const restored = await this._entryCoordinator.initializeEntryInventory(options);
    if (!restored && !this.resolveCurrentViewSessionResource()) {
      this.scheduleProvisionalSessionBootstrap();
    }
    return restored;
  }

  async forkFromTurn(options: {
    sourceSessionId?: string;
    turnId: string;
    requestContent: string;
    displayContent: string;
    resources: ResourceItem[];
  }): Promise<boolean> {
    if (this.ctx.isWaiting) {
      this.ctx.message.warning('正在处理中，请稍候...');
      return false;
    }

    const sourceSessionId = options.sourceSessionId?.trim() || this.resolveCurrentViewSessionResource();
    if (!sourceSessionId) {
      this.ctx.message.warning('当前没有可分叉的会话');
      return false;
    }

    const forkedSessionId = `lex-${Date.now()}-fork`;
    const selectedMode = normalizeChatSelectedMode(this.ctx.chatService.selectedMode ?? {
      modeId: this.ctx.currentMode,
      customAgentTarget: this.ctx.chatService.currentCustomAgentTarget,
    });
    const forkedProviderOptions = this.resolveCurrentSessionProviderOptions();
    const forkedInputState = buildHostSessionCurrentPickerInputState(selectedMode, forkedProviderOptions);
    const forkedRequestRouting = buildHostSessionCurrentPickerRoutingSummary(
      selectedMode,
      undefined,
      forkedProviderOptions.permissionLevel,
      forkedProviderOptions.approvalsReviewer,
      forkedProviderOptions.approvalPolicy,
    );
    const forkedItemSeed = {
      sessionId: forkedSessionId,
      title: this.buildForkedSessionTitle(
        this.ctx.chatHistoryService.findEntry(sourceSessionId)?.title
        || this.ctx.chatService.currentSessionTitle
        || options.displayContent,
      ),
      projectPath: forkedProviderOptions.folderPath,
      createdAt: Date.now(),
      inputState: forkedInputState,
      mode: selectedMode.modeId,
      requestRouting: forkedRequestRouting,
    };
    const forkedMetadata = {
      sessionId: forkedSessionId,
      title: forkedItemSeed.title,
      projectPath: forkedItemSeed.projectPath,
      createdAt: forkedItemSeed.createdAt,
      updatedAt: forkedItemSeed.createdAt,
      mode: forkedItemSeed.mode,
      inputState: forkedItemSeed.inputState,
      requestRouting: forkedItemSeed.requestRouting,
      model: this.resolveCurrentModelName(),
      toolCallingIteration: 0,
      forkKind: 'protocol' as const,
      forkedFromSessionId: sourceSessionId,
      forkedBeforeTurnId: options.turnId,
      forkedRetainedTurnCount: 0,
    };
    try {
      if (typeof this.ctx.forkSessionThroughHost !== 'function') {
        throw new Error('[SessionLifecycle][Fork] host fork transaction is unavailable.');
      }
      const result = await this.ctx.forkSessionThroughHost({
        sourceSessionId,
        targetSessionId: forkedSessionId,
        beforeTurnId: options.turnId,
        metadata: forkedMetadata,
        selectedMode,
        providerOptions: forkedProviderOptions,
        agentRuntimeMode: this.ctx.currentAgentRuntimeMode,
        currentModel: this.ctx.currentModel ?? null,
        pageLimit: 30,
      });
      forkedMetadata.forkedRetainedTurnCount = result.retainedTurnIds.length;
      console.info('[AilyChat][RequestListBranchTrace]', {
        phase: 'fork-host-commit',
        sourceSessionId,
        targetSessionId: forkedSessionId,
        sourceRevision: result.sourceRevision,
        targetRevision: result.targetRevision,
        retainedTurnIds: result.retainedTurnIds,
      });
    } catch (error) {
      console.warn('[SessionLifecycle][Fork] host fork transaction failed', error);
      this.ctx.message.warning('Failed to persist the forked session. Please try again.');
      return false;
    }

    this.hostSessionItemController.createForkedChatSessionItem(forkedItemSeed);
    await this.switchToSession(forkedSessionId);
    this.ctx.scrollManager.setScrollLock(true);
    this.ctx.scrollManager.scrollToBottom();

    return true;
  }

  // ==================== 会话持久化 ====================

  saveCurrentSession(options?: {
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    hostRequestModel?: import('./host-turn-response-state').HostRequestModel | null;
    target?: HostSessionSaveTarget | null;
  }): void {
    const saveTarget = options?.target ?? this.resolveCurrentSessionSaveTarget();
    const currentSessionId = saveTarget?.sessionId || this.resolveCurrentViewSessionResource();
    if (this._sessionSaveBridge.saveCurrentSession({
      ...options,
      target: saveTarget,
    })) {
      this.refreshHistoryList();
      return;
    }

    if (currentSessionId) {
      this.hostSessionItemController.discardChatSessionItem(currentSessionId);
      this.clearPersistedSessionEntryTarget(currentSessionId);
      this.refreshHistoryList();
    }
  }

  refreshHistoryList(): void {
    const currentScope = resolveChatSessionScopeFromProject(AilyHost.get().project);
    const currentProjectPath = chatSessionScopeProjectPath(currentScope);
    const projectRootPath = AilyHost.get().project.projectRootPath;
    const sessionItemsService = this.ctx.chatSessionItemsService as {
      refreshHistoryList?: (projectPath?: string | null, projectRootPath?: string | null) => void;
    } | undefined;

    if (typeof sessionItemsService?.refreshHistoryList !== 'function') {
      throw new Error('[SessionLifecycleHelper] ChatSessionItemsService.refreshHistoryList is required for shared session read-side');
    }

    ChatPerformanceTracer.increment('session_list.sync_refresh_history');
    ChatPerformanceTracer.mark('session_list.sync_refresh_history');
    sessionItemsService.refreshHistoryList(currentProjectPath, projectRootPath);
  }

  requestSessionListRefresh(input: {
    reason: 'open' | 'entry' | 'reopen' | 'filter' | 'state' | 'runtime' | 'manual' | 'project' | 'service-created' | 'shell';
    scope: 'summary' | 'visible-details' | 'full';
    priority: 'after-paint' | 'normal' | 'idle';
  }): void {
    const currentScope = resolveChatSessionScopeFromProject(AilyHost.get().project);
    const currentProjectPath = chatSessionScopeProjectPath(currentScope);
    const projectRootPath = AilyHost.get().project.projectRootPath;
    const sessionItemsService = this.ctx.chatSessionItemsService as {
      requestSessionListRefresh?: (request: {
        reason: 'open' | 'entry' | 'reopen' | 'filter' | 'state' | 'runtime' | 'manual' | 'project' | 'service-created' | 'shell';
        scope: 'summary' | 'visible-details' | 'full';
        priority: 'after-paint' | 'normal' | 'idle';
        projectPath?: string | null;
        projectRootPath?: string | null;
      }) => void;
      loadInitialSummaries?: (limit?: number, projectPath?: string | null, projectRootPath?: string | null) => void;
      refreshHistoryList?: (projectPath?: string | null, projectRootPath?: string | null) => void;
    } | undefined;

    if (typeof sessionItemsService?.requestSessionListRefresh === 'function') {
      ChatPerformanceTracer.increment(`session_list.request.${input.scope}`);
      ChatPerformanceTracer.mark('session_list.request_scheduled', `${input.reason}:${input.scope}:${input.priority}`);
      sessionItemsService.requestSessionListRefresh({
        ...input,
        projectPath: currentProjectPath,
        projectRootPath,
      });
      return;
    }

    if (input.scope === 'summary' && typeof sessionItemsService?.loadInitialSummaries === 'function') {
      sessionItemsService.loadInitialSummaries(undefined, currentProjectPath, projectRootPath);
      return;
    }

    if (typeof sessionItemsService?.refreshHistoryList === 'function') {
      sessionItemsService.refreshHistoryList(currentProjectPath, projectRootPath);
      return;
    }

    throw new Error('[SessionLifecycleHelper] ChatSessionItemsService session list refresh API is required for shared session read-side');
  }

  private isSamePath(leftPath: string | null | undefined, rightPath: string | null | undefined): boolean {
    const normalize = (value: string | null | undefined) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(leftPath) === normalize(rightPath);
  }

  private getPersistableProjectPath(projectPath: string | null | undefined): string | null {
    const rootPath = AilyHost.get().project.projectRootPath;
    return projectPath && !this.isSamePath(projectPath, rootPath) ? projectPath : null;
  }

  private getCurrentSessionPersistPath(previousProjectPath?: string | null): string | null {
    const cachedPath = this.ctx.chatService.currentSessionPath;
    return this.getPersistableProjectPath(cachedPath) || this.getPersistableProjectPath(previousProjectPath);
  }

  private getLatestProjectSessionEntry(projectPath: string): { sessionId: string; title?: string } | null {
    const rootPath = AilyHost.get().project.projectRootPath;
    const entries = this.ctx.chatHistoryService.getHistoryList('current-project', projectPath, rootPath);
    return entries[0] || null;
  }

  private getLatestGlobalSessionEntry(): { sessionId: string; title?: string } | null {
    const rootPath = AilyHost.get().project.projectRootPath;
    const entries = this.ctx.chatHistoryService.getHistoryList('current-project', null, rootPath);
    return entries[0] || null;
  }

  private clearClientSessionStateForProjectSwitch(): void {
    this.ctx.resetVisibleSessionProjection?.({
      clearResolvedActiveModel: true,
      clearTurns: true,
      resetContextBudget: true,
      clearEditSummary: true,
      resetToolCallingIteration: true,
    });
    this.ctx.isWaiting = false;
  }

  private async activateFreshScopeSession(projectPath: string | null): Promise<void> {
    const persistableProjectPath = this.getPersistableProjectPath(projectPath);

    this.resetForSessionActivation();
    this.ctx.chatService.currentSessionPath = persistableProjectPath || '';
    this.ctx.hasInitializedForThisLogin = false;

    if (this.ctx.isLoggedIn) {
      await this.startSession();
    }

    this.refreshHistoryList();
    this.ctx.triggerSyncDetectChanges();
  }

  private async activateBlankScopeShell(projectPath: string | null): Promise<void> {
    const persistableProjectPath = this.getPersistableProjectPath(projectPath);

    this.resetForSessionActivation();
    this.enterBlankSessionShell({ projectPath: persistableProjectPath });
    this.refreshHistoryList();
    this.ctx.triggerSyncDetectChanges();
  }

  async startNewProjectSession(
    projectPath: string,
    previousProjectPath?: string | null,
    currentAlreadySaved = false,
  ): Promise<void> {
    if (!projectPath || this.ctx.isSessionStarting) {
      return;
    }

    if (!currentAlreadySaved) {
      const persistPath = this.getCurrentSessionPersistPath(previousProjectPath);
      if (persistPath) {
        this.ctx.chatService.currentSessionPath = persistPath;
      }
      this.saveCurrentSession();
    }

    await this.activateFreshScopeSession(projectPath);
  }

  async loadLatestProjectSession(projectPath: string, previousProjectPath?: string | null): Promise<boolean> {
    if (!projectPath || this.ctx.isSessionStarting) {
      return false;
    }

    const persistPath = this.getCurrentSessionPersistPath(previousProjectPath);
    if (persistPath) {
      this.ctx.chatService.currentSessionPath = persistPath;
    }
    this.saveCurrentSession();
    this.ctx.chatHistoryService.reloadProjectIndex(projectPath);

    const latestEntry = this.getLatestProjectSessionEntry(projectPath);
    if (!latestEntry) {
      await this.startNewProjectSession(projectPath, previousProjectPath, true);
      return false;
    }

    await this.switchToSession(latestEntry.sessionId, {
      fallbackProjectPath: this.getPersistableProjectPath(projectPath),
    });
    this.refreshHistoryList();
    this.ctx.triggerSyncDetectChanges();
    return true;
  }

  async loadLatestGlobalSession(): Promise<boolean> {
    if (this.ctx.isSessionStarting) {
      return false;
    }

    this.saveCurrentSession();

    const latestEntry = this.getLatestGlobalSessionEntry();
    if (!latestEntry) {
      await this.activateBlankScopeShell(null);
      return false;
    }

    await this.switchToSession(latestEntry.sessionId, {
      fallbackProjectPath: null,
    });
    this.refreshHistoryList();
    this.ctx.triggerSyncDetectChanges();
    return true;
  }

  adoptActiveGlobalSessionToProject(
    projectPath: string,
    reason = 'chat-tool-create',
    eventSessionResource?: string | null,
  ): boolean {
    const sessionId = this.resolveCurrentViewSessionResource();
    const normalizedEventSessionResource = typeof eventSessionResource === 'string'
      ? eventSessionResource.trim()
      : '';
    const targetProjectPath = this.getPersistableProjectPath(projectPath);
    if (!sessionId || !targetProjectPath) {
      this.logSessionScopeAdoption({
        event: 'adopt-global-to-project',
        reason,
        sessionResource: normalizedEventSessionResource || sessionId || null,
        projectPath: targetProjectPath,
        adopted: false,
        failureReason: !sessionId ? 'missing-session-resource' : 'missing-project-path',
      });
      return false;
    }

    if (normalizedEventSessionResource && normalizedEventSessionResource !== sessionId) {
      this.logSessionScopeAdoption({
        event: 'adopt-global-to-project',
        reason,
        sessionResource: normalizedEventSessionResource,
        projectPath: targetProjectPath,
        adopted: false,
        failureReason: 'session-resource-mismatch',
      });
      return false;
    }

    if (this.getPersistableProjectPath(this.ctx.chatService.currentSessionPath)) {
      this.logSessionScopeAdoption({
        event: 'adopt-global-to-project',
        reason,
        sessionResource: sessionId,
        projectPath: targetProjectPath,
        adopted: false,
        failureReason: 'current-session-already-project-scoped',
      });
      return false;
    }

    this.saveCurrentSession();
    const adopted = this.ctx.chatHistoryService.adoptGlobalSessionToProject(
      sessionId,
      targetProjectPath,
      AilyHost.get().project.projectRootPath,
      reason,
    );
    if (!adopted) {
      this.logSessionScopeAdoption({
        event: 'adopt-global-to-project',
        reason,
        sessionResource: sessionId,
        projectPath: targetProjectPath,
        adopted: false,
        failureReason: 'history-adoption-failed',
      });
      return false;
    }

    this.ctx.chatService.currentSessionPath = targetProjectPath;
    const requiredResource = createRequiredSessionResourceModel({
      sessionResource: sessionId,
      projectPath: targetProjectPath,
      projectRootPath: AilyHost.get().project.projectRootPath,
      selectedMode: this.ctx.chatService.selectedMode ?? { modeId: this.ctx.currentMode },
      runtimeMode: this.ctx.chatService.currentAgentRuntimeMode,
      runtimeModeSource: this.ctx.chatService.currentAgentRuntimeModeSource,
      providerOptions: this.resolveCurrentProjectProviderOptions(),
    });
    this.acquireSessionModel({
      sessionResource: requiredResource.sessionResource,
      title: {
        text: this.ctx.chatService.currentSessionTitle ?? '',
        source: this.ctx.chatService.currentSessionTitleSource ?? 'empty',
        revision: this.ctx.chatService.currentSessionTitleRevision,
      },
      projectPath: requiredResource.projectPath,
      sessionType: this.ctx.chatService.currentSessionType ?? DEFAULT_CHAT_SESSION_TYPE,
      inputState: {
        providerOptions: requiredResource.providerOptions,
        selectedMode: requiredResource.selectedMode,
      },
    });
    this.applySessionProviderOptions(requiredResource.providerOptions);
    if (typeof this.ctx.chatService.setCurrentAgentRuntimeMode === 'function') {
      this.ctx.chatService.setCurrentAgentRuntimeMode(requiredResource.runtimeMode, requiredResource.runtimeModeSource);
    } else {
      this.ctx.chatService.currentAgentRuntimeMode = requiredResource.runtimeMode;
      this.ctx.chatService.currentAgentRuntimeModeSource = requiredResource.runtimeModeSource;
    }
    this.persistSessionEntryTarget(this.buildFreshSessionEntryTarget(sessionId));
    this.refreshHistoryList();
    this.ctx.triggerSyncDetectChanges();
    this.logSessionScopeAdoption({
      event: 'adopt-global-to-project',
      reason,
      sessionResource: sessionId,
      projectPath: targetProjectPath,
      adopted: true,
    });
    return true;
  }

  private logSessionScopeAdoption(input: {
    event: string;
    reason: string;
    sessionResource: string | null;
    projectPath: string | null;
    adopted: boolean;
    failureReason?: string;
  }): void {
    console.info('[AilyChat][SessionScopeAdoption]', {
      ...input,
      fromScope: 'global',
      toScope: input.projectPath ? `project:${input.projectPath}` : 'project:<missing>',
      currentViewResource: this.resolveCurrentViewSessionResource() || null,
      hasBlankSessionShell: this.ctx.chatService.hasBlankSessionShell === true,
    });
  }

  async initializeSessionForCurrentProject(): Promise<void> {
    const currentProjectPath = AilyHost.get().project.currentProjectPath;
    const persistableProjectPath = this.getPersistableProjectPath(currentProjectPath);

    if (persistableProjectPath) {
      this.ctx.chatHistoryService.reloadProjectIndex(persistableProjectPath);
      const latestEntry = this.getLatestProjectSessionEntry(persistableProjectPath);
      if (latestEntry) {
        this.clearClientSessionStateForProjectSwitch();
        this.ctx.chatService.currentSessionPath = persistableProjectPath;
        await this.switchToSession(latestEntry.sessionId, {
          fallbackProjectPath: persistableProjectPath,
        });
        this.ctx.isCompleted = true;
        this.refreshHistoryList();
        this.ctx.triggerSyncDetectChanges();
        return;
      }
    }

    await this.startSession();
    await this.getHistory();
    this.ctx.triggerSyncDetectChanges();
  }

  // ==================== 会话启动 ====================

  async startSession(options: { readonly deferShellFinalization?: boolean } = {}): Promise<string | null> {
    if (this.ctx.isSessionStarting) {
      return Promise.resolve(this.resolveCurrentViewSessionResource() || null);
    }
    const bootstrapStartedAt = performance.now();
    this.ctx.isSessionStarting = true;
    this.ctx.isCancelled = false;

    this.ctx.interaction.resetApprovalState();
    this.ctx.chatService.clearResolvedActiveModel?.();
    this.ctx.lexStream.resetSessionState();

    this.ctx.lexStream.turns.clear();
    this.ctx.toolCallingIteration = 0;
    this.ctx.contextBudgetService.reset();
    this.ctx.sessionAllowedPaths = [];
    this.ctx.repetitionDetectionService.resetAll();
    this.ctx.legacyActivatedDeferredTools.clear();
    SkillRegistry.clearSessionState('startSession');
    const resetCompletedAt = performance.now();

    this.ctx.isCompleted = false;

    // VS Code creates the ChatModel/sessionResource synchronously, then activates the default agent in the background.
    // Keep our owner session id stable before any awaited provider/tool initialization so detach/save can target it.
    const pendingSessionId = this.createSessionId();
    const sessionIdCreatedAt = performance.now();
    const providerOptions = this.resolveCurrentProjectProviderOptions();
    const providerOptionsResolvedAt = performance.now();
    const agentRuntimeMode = this.applyAgentRuntimeMode(providerOptions);
    const runtimeModeResolvedAt = performance.now();
    const canonicalProviderOptions = this.ctx.chatService.applySessionProviderOptions(providerOptions);
    const providerOptionsAppliedAt = performance.now();
    const freshSelectedMode = this.resolveCurrentSelectedModeForFreshSession();
    const selectedModeResolvedAt = performance.now();
    this.setActiveSessionId(pendingSessionId);
    const sessionIdentitySetAt = performance.now();
    this.acquireSessionModel({
      sessionResource: pendingSessionId,
      title: { text: '', source: 'empty' },
      projectPath: this.ctx.chatService.currentSessionPath || null,
      sessionType: DEFAULT_CHAT_SESSION_TYPE,
      inputState: { providerOptions: canonicalProviderOptions, selectedMode: freshSelectedMode },
    }, { provisional: true });
    const modelCreatedAt = performance.now();
    this.ctx.attachSessionViewModel?.(pendingSessionId);
    this.ctx.markVisibleSessionProjectionOwner?.(pendingSessionId);
    applyCurrentSessionTitle(this.ctx.chatService, { text: '', source: 'empty' });
    this.applySessionType(DEFAULT_CHAT_SESSION_TYPE);
    this.applySessionProviderOptions(canonicalProviderOptions);
    const viewAttachedAt = performance.now();
    const finalizeShell = () => {
      this.hostSessionItemController.createNewChatSessionItem(pendingSessionId, {
        projectPath: this.ctx.chatService.currentSessionPath || null,
        agentRuntimeMode,
        agentRuntimeModeSource: this.ctx.chatService.currentAgentRuntimeModeSource,
      });
      this.persistSessionEntryTarget(this.buildFreshSessionEntryTarget(pendingSessionId, freshSelectedMode));
      this.requestSessionListRefresh({
        reason: 'state',
        scope: 'summary',
        priority: 'after-paint',
      });
    };
    if (options.deferShellFinalization) {
      this.pendingFreshSessionShellFinalizers.set(pendingSessionId, finalizeShell);
      // A provisionally bound model is the blank composer owner, not a history
      // session. Keep that boundary explicit until the first request mutation
      // finalizes the shell and makes it listable.
      this.ctx.chatService.hasBlankSessionShell = true;
    } else {
      finalizeShell();
    }
    const shellScheduledAt = performance.now();

    this.ctx.isSessionStarting = false;
    this.scheduleRuntimeBackgroundActivation(
      pendingSessionId,
      canonicalProviderOptions,
      agentRuntimeMode,
    );
    console.info(
      '[AilyChat][SessionBootstrapScalar]',
      [
        `sessionId=${pendingSessionId}`,
        `resetMs=${(resetCompletedAt - bootstrapStartedAt).toFixed(1)}`,
        `sessionIdMs=${(sessionIdCreatedAt - resetCompletedAt).toFixed(1)}`,
        `providerOptionsMs=${(providerOptionsResolvedAt - sessionIdCreatedAt).toFixed(1)}`,
        `runtimeModeMs=${(runtimeModeResolvedAt - providerOptionsResolvedAt).toFixed(1)}`,
        `providerApplyMs=${(providerOptionsAppliedAt - runtimeModeResolvedAt).toFixed(1)}`,
        `selectedModeMs=${(selectedModeResolvedAt - providerOptionsAppliedAt).toFixed(1)}`,
        `sessionIdentityMs=${(sessionIdentitySetAt - selectedModeResolvedAt).toFixed(1)}`,
        `modelAcquireMs=${(modelCreatedAt - sessionIdentitySetAt).toFixed(1)}`,
        `modelMs=${(modelCreatedAt - resetCompletedAt).toFixed(1)}`,
        `viewMs=${(viewAttachedAt - modelCreatedAt).toFixed(1)}`,
        `shellScheduleMs=${(shellScheduledAt - viewAttachedAt).toFixed(1)}`,
        `deferred=${String(options.deferShellFinalization === true)}`,
        `totalMs=${(performance.now() - bootstrapStartedAt).toFixed(1)}`,
      ].join(' '),
    );
    return pendingSessionId;
  }

  completeFreshSessionShellBootstrap(sessionId: string | null | undefined): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }
    const finalize = this.pendingFreshSessionShellFinalizers.get(targetSessionId);
    if (!finalize) {
      return;
    }
    this.pendingFreshSessionShellFinalizers.delete(targetSessionId);
    const startedAt = performance.now();
    finalize();
    this.ctx.chatService.hasBlankSessionShell = false;
    console.info(
      '[AilyChat][SessionBootstrapScalar]',
      `sessionId=${targetSessionId} shellFinalizationMs=${(performance.now() - startedAt).toFixed(1)} phase=after-request-paint`,
    );
  }

  private scheduleRuntimeBackgroundActivation(
    sessionId: string,
    providerOptions: HostSessionProviderOptions,
    agentRuntimeMode: ChatAgentRuntimeMode,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || this.ctx.hasSessionRuntimeHandle?.(targetSessionId) === true) {
      return;
    }

    const startActivation = async () => {
      try {
        if (this.isVisibleSessionStartupOwner(targetSessionId)) {
          await this.ctx.chatService.syncResolvedActiveModelFromContextInfo?.(targetSessionId);
        }
      } catch (error) {
        ChatPerformanceTracer.increment('runtime_executor.model_resolution.failed');
        if (isAilyCategoryDebugEnabled('aily.chat.traceRuntimeExecutorPrewarm', [
          '__AILY_CHAT_TRACE_RUNTIME_EXECUTOR_PREWARM__',
          'AILY_CHAT_TRACE_RUNTIME_EXECUTOR_PREWARM',
        ])) {
          console.warn('[AilyChat][RuntimeExecutorPrewarm] model resolution failed', {
            sessionId: targetSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const startedAt = performance.now();
      ChatPerformanceTracer.increment('runtime_executor.prewarm.started');
      const prewarmRuntime = this.ctx.prewarmRuntimeExecutor;
      if (typeof prewarmRuntime !== 'function') {
        ChatPerformanceTracer.increment('runtime_executor.prewarm.unavailable');
        return;
      }
      void prewarmRuntime({
        sessionId: targetSessionId,
        providerOptions,
        agentRuntimeMode,
        currentModel: this.ctx.currentModel ?? null,
      })
        .then(result => {
          const ensured = result?.ensured === true;
          ChatPerformanceTracer.increment(ensured
            ? 'runtime_executor.prewarm.ensured'
            : 'runtime_executor.prewarm.unavailable');
          ChatPerformanceTracer.recordDuration(
            'runtime_executor_prewarm',
            performance.now() - startedAt,
            `session=${targetSessionId},ensured=${ensured}`,
            { slowThresholdMs: 24, counterPrefix: 'runtime_executor.prewarm.duration' },
          );
        })
        .catch(error => {
          ChatPerformanceTracer.increment('runtime_executor.prewarm.failed');
          ChatPerformanceTracer.recordDuration(
            'runtime_executor_prewarm',
            performance.now() - startedAt,
            `session=${targetSessionId},error=${error instanceof Error ? error.message : String(error)}`,
            { slowThresholdMs: 24, counterPrefix: 'runtime_executor.prewarm.duration' },
          );
          if (isAilyCategoryDebugEnabled('aily.chat.traceRuntimeExecutorPrewarm', [
            '__AILY_CHAT_TRACE_RUNTIME_EXECUTOR_PREWARM__',
            'AILY_CHAT_TRACE_RUNTIME_EXECUTOR_PREWARM',
          ])) {
            console.warn('[AilyChat][RuntimeExecutorPrewarm] failed', {
              sessionId: targetSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
    };

    const runtimeGlobal = globalThis as typeof globalThis & {
      requestAnimationFrame?: (callback: FrameRequestCallback) => number;
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    };
    const scheduleWhenIdle = typeof runtimeGlobal.requestIdleCallback === 'function'
      ? runtimeGlobal.requestIdleCallback.bind(runtimeGlobal)
      : null;
    this.ctx.ngZone.runOutsideAngular(() => {
      if (scheduleWhenIdle) {
        scheduleWhenIdle(() => {
          setTimeout(() => void startActivation(), 0);
        }, { timeout: 1200 });
        return;
      }
      const scheduleAfterPaint = typeof runtimeGlobal.requestAnimationFrame === 'function'
        ? runtimeGlobal.requestAnimationFrame.bind(runtimeGlobal)
        : null;
      if (scheduleAfterPaint) {
        scheduleAfterPaint(() => {
          setTimeout(() => void startActivation(), 0);
        });
        return;
      }

      setTimeout(() => void startActivation(), 0);
    });
  }

  private isVisibleSessionStartupOwner(sessionId: string): boolean {
    return this.resolveCurrentViewSessionResource() === sessionId;
  }

  /** 清理当前会话的本地 agent 资源 */
  dispose(): void {
    for (const reference of this.sessionModelReferences.values()) {
      reference.dispose();
    }
    this.sessionModelReferences.clear();
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (currentViewSessionResource) {
      this.ctx.detachSessionRuntimeView?.(currentViewSessionResource);
    }
  }

  releaseSessionModelReference(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const reference = this.sessionModelReferences.get(targetSessionId);
    if (!reference) {
      return false;
    }

    reference.dispose();
    this.sessionModelReferences.delete(targetSessionId);
    return true;
  }

  enterEntryState(options: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null } = {}): void {
    const explicitSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const currentSessionId = explicitSessionId || this.resolveCurrentViewSessionResource();
    const liveSessionId = typeof this.ctx.chatService.currentSessionId === 'string'
      ? this.ctx.chatService.currentSessionId.trim()
      : '';
    const liveRuntimeState = liveSessionId && typeof this.ctx.readSessionRuntimeState === 'function'
      ? this.ctx.readSessionRuntimeState(liveSessionId)
      : undefined;
    const hasLiveCurrentSession = !!liveSessionId
      && (liveRuntimeState?.requestInProgress === true
        || (liveRuntimeState?.turnResponses?.length ?? 0) > 0
        || this.ctx.hasSessionRuntimeHandle?.(liveSessionId) === true);
    const explicitProjectPath = typeof options.projectPath === 'string' && options.projectPath.trim().length > 0
      ? options.projectPath.trim()
      : null;
    if (isSessionLifecycleTraceEnabled()) {
      console.info('[AilyChat][SessionLifecycle]', {
        phase: 'enter-entry-state',
        explicitSessionId: explicitSessionId || null,
        currentSessionId: currentSessionId || null,
        liveCurrentSessionId: this.ctx.chatService.currentSessionId || null,
        resetInitialization: options.resetInitialization === true,
        projectPath: explicitProjectPath,
        hasBlankSessionShell: this.ctx.chatService.hasBlankSessionShell === true,
        liveSessionId: liveSessionId || null,
        hasLiveCurrentSession,
      });
    }

    if (!explicitSessionId && !currentSessionId && hasLiveCurrentSession) {
      if (isSessionLifecycleTraceEnabled()) {
        console.info('[AilyChat][SessionLifecycle]', {
          phase: 'skip-entry-state-for-live-current-session',
          liveSessionId,
          liveRequestInProgress: liveRuntimeState?.requestInProgress === true,
          liveTurnResponses: liveRuntimeState?.turnResponses?.length ?? 0,
        });
      }
      return;
    }

    this.ctx.resetVisibleSessionProjection({
      clearResolvedActiveModel: true,
      clearTurns: true,
      resetContextBudget: true,
      clearEditSummary: true,
      resetToolCallingIteration: true,
    });

    this.setActiveSessionId('');
    this.ctx.detachSessionViewModel?.(currentSessionId);
    this.ctx.chatService.hasBlankSessionShell = false;
    applyCurrentSessionTitle(this.ctx.chatService, { text: '', source: 'empty' });
    this.applySessionType(DEFAULT_CHAT_SESSION_TYPE);
    this.ctx.chatService.currentSessionPath = explicitProjectPath ?? '';
    this.ctx.chatService.clearResolvedActiveModel?.();
    this.ctx.chatService.resetChatModeToPersistedSelection?.();
    this.applyPersistedEntryProviderOptions(explicitProjectPath ?? this.resolveCurrentProjectPath());
    this.ctx.clearEntryInputState?.();
    this.ctx.isSessionStarting = false;

    if (options.resetInitialization === true) {
      this.ctx.hasInitializedForThisLogin = false;
    }
  }

  enterBlankSessionShell(options: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null } = {}): void {
    this.enterEntryState(options);
    this.ctx.chatService.hasBlankSessionShell = true;
    this.scheduleProvisionalSessionBootstrap();
  }

  async returnToEntryInventory(options: { resetInitialization?: boolean; sessionId?: string | null; projectPath?: string | null } = {}): Promise<void> {
    const targetSessionId = typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : this.resolveCurrentViewSessionResource();

    if (targetSessionId) {
      this.ctx.detachSessionRuntimeView?.(targetSessionId);
    }

    await this._entryCoordinator.returnToEntryInventory({
      ...options,
    });

    if (targetSessionId) {
      this.clearPersistedSessionEntryTarget(targetSessionId);
    }
    this.scheduleProvisionalSessionBootstrap();
  }

  /** Detach the visible session surface without cancelling the host-owned runtime turn. */
  async detachCurrentSessionSurface(skipSave: boolean = false): Promise<void> {
    const currentSessionId = this.resolveCurrentViewSessionResource();
    if (!skipSave) { this.saveCurrentSession(); }
    if (currentSessionId) {
      this.ctx.detachSessionRuntimeView?.(currentSessionId);
    }
    this.ctx.chatService.clearResolvedActiveModel?.();
    this.ctx.isWaiting = false;
  }

  // ==================== 新建 / 历史 ====================

  async newChat(): Promise<void> {
    if (this.ctx.isSessionStarting) return;
    const currentSessionId = this.resolveCurrentViewSessionResource();
    const currentScope = resolveChatSessionScopeFromProject(AilyHost.get().project);
    const nextProjectPath = chatSessionScopeProjectPath(currentScope);
    this.saveCurrentSession();
    if (currentSessionId && !this.hasSessionRuntimeOwner(currentSessionId)) {
      this.hostSessionItemController.discardChatSessionItem(currentSessionId);
      this.clearPersistedSessionEntryTarget(currentSessionId);
      this.pendingFreshSessionShellFinalizers.delete(currentSessionId);
      this.releaseSessionModelReference(currentSessionId);
    }
    if (currentSessionId) {
      this.ctx.detachSessionRuntimeView?.(currentSessionId);
    }
    this.enterEntryState({
      sessionId: currentSessionId,
      projectPath: nextProjectPath,
    });
    this.requestSessionListRefresh({
      reason: 'entry',
      scope: 'summary',
      priority: 'after-paint',
    });
    // Match VS Code's ChatViewPane: once the blank input surface is visible,
    // bind its real (but still empty/unpersisted) session model before submit.
    this.scheduleProvisionalSessionBootstrap();
  }

  async ensureSessionReadyForSubmit(): Promise<string | null> {
    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const normalizedViewSessionResource = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    if (normalizedViewSessionResource) {
      return normalizedViewSessionResource;
    }

    if (!this.ctx.isLoggedIn) {
      return null;
    }

    this.cancelProvisionalSessionBootstrap();
    return this._entryCoordinator.bootstrapNewSession();
  }

  private scheduleProvisionalSessionBootstrap(): void {
    if (this.provisionalSessionBootstrapHandle !== null
      || !this.ctx.isLoggedIn
      || this.ctx.isSessionStarting
      || this.resolveCurrentViewSessionResource()) {
      return;
    }

    const bootstrap = () => {
      this.provisionalSessionBootstrapHandle = null;
      if (!this.ctx.isLoggedIn || this.ctx.isSessionStarting || this.resolveCurrentViewSessionResource()) {
        return;
      }
      void this.startSession({ deferShellFinalization: true });
    };
    const scheduleAfterPaint = () => {
      this.provisionalSessionBootstrapHandle = setTimeout(bootstrap, 0) as unknown as number;
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.provisionalSessionBootstrapHandle = globalThis.requestAnimationFrame(scheduleAfterPaint);
    } else {
      this.provisionalSessionBootstrapHandle = setTimeout(bootstrap, 16) as unknown as number;
    }
  }

  private cancelProvisionalSessionBootstrap(): void {
    if (this.provisionalSessionBootstrapHandle === null) {
      return;
    }
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.provisionalSessionBootstrapHandle);
    }
    clearTimeout(this.provisionalSessionBootstrapHandle as unknown as ReturnType<typeof setTimeout>);
    this.provisionalSessionBootstrapHandle = null;
  }

  async getHistory(): Promise<void> {
    const sessionId = this.resolveCurrentViewSessionResource();
    if (!sessionId) return;
    this.persistSessionEntryTarget(this.buildCurrentSessionEntryTarget(sessionId));
    this.ctx.resetVisibleSessionProjection({
      clearResolvedActiveModel: true,
      clearTurns: true,
      resetToolCallingIteration: true,
      resetContextBudget: true,
    });
    const sessionContent = this._hostSessionContentProvider.provideChatSessionContent(
      sessionId,
      this.resolveCurrentSessionProjectPath(),
    );
    const hostRecord = sessionContent?.hostRecord ?? null;
    if (hostRecord) {
      try {
        await this.ctx.restoreSessionHostRecord(hostRecord, { sessionId });
      } catch (error) {
        console.warn('[SessionLifecycle] session history restore failed:', error);
        this.ctx.message.warning('会话历史加载失败，已继续打开当前会话');
      }
    } else {
      await this.clearHostEditTrackingSessionState(sessionId);
    }
    this.ctx.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
  }

  private async clearHostEditTrackingSessionState(sessionId: string | null | undefined): Promise<void> {
    await this.requestHostEditTrackingOperation({
      sessionId,
      label: 'Clearing edit tracking session state',
      detail: 'Host edit tracking resource is clearing stale session edit state.',
      payload: {
        adapter: 'editTracking',
        action: 'clearSessionState',
        dismissSummary: true,
      },
    });
  }

  private async restoreHostEditTrackingSessionState(
    sessionId: string | null | undefined,
    workspaceRoot: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): Promise<void> {
    const canonicalTurnResponses = Array.isArray(turnResponses) ? turnResponses : [];
    await this.requestHostEditTrackingOperation({
      sessionId,
      label: 'Restoring edit tracking timeline',
      detail: 'Host edit tracking resource is restoring session edit state from the response model.',
      payload: {
        adapter: 'editTracking',
        action: 'restoreFromTurnResponses',
        workspaceRoot: workspaceRoot ?? null,
        turnResponses: canonicalTurnResponses,
        autoSaveEdits: this.ctx.ailyChatConfigService.autoSaveEdits === true,
      },
    });
  }

  private async requestHostEditTrackingOperation(input: {
    readonly sessionId: string | null | undefined;
    readonly label: string;
    readonly detail: string;
    readonly payload: ChatRuntimeHostEditTrackingPayload;
  }): Promise<Awaited<ReturnType<NonNullable<SessionLifecycleContext['requestHostResourceOperation']>>>> {
    const targetSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!targetSessionId) {
      throw new Error('[AilyChat][RuntimeHost] edit tracking session operation requires a host session id.');
    }
    if (typeof this.ctx.requestHostResourceOperation !== 'function') {
      throw new Error('[AilyChat][RuntimeHost] edit tracking session operation requires the host resource operation bridge.');
    }
    return this.ctx.requestHostResourceOperation({
      sessionId: targetSessionId,
      kind: 'edit-tracking',
      label: input.label,
      detail: input.detail,
      payload: input.payload,
    });
  }

  private createSessionId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) {
      return `lex-${uuid}`;
    }

    return `lex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private setActiveSessionId(sessionId: string): void {
    this.ctx.sessionId = sessionId;
    this.ctx.chatService.currentSessionId = sessionId;
  }

  private hasSessionRuntimeOwner(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return !!normalizedSessionId
      && (!!this.ctx.readSessionRuntimeState?.(normalizedSessionId)
        || this.ctx.hasSessionRuntimeHandle?.(normalizedSessionId) === true);
  }

  private resolveCurrentProjectPath(): string | null {
    return chatSessionScopeProjectPath(resolveChatSessionScopeFromProject(AilyHost.get().project));
  }

  private resolveCurrentSessionProjectPath(): string | null {
    return this.resolveSessionContentProjectPath();
  }

  private resolveSessionContentProjectPath(hostRecord?: HostSessionRecord | null): string | null {
    const recordProjectPath = typeof hostRecord?.metadata?.projectPath === 'string'
      ? hostRecord.metadata.projectPath
      : null;

    return resolveHostSessionProjectPathHint(
      { currentSessionPath: recordProjectPath || this.ctx.chatService.currentSessionPath },
      this.resolveCurrentProjectPath(),
    );
  }

  private resolveCurrentModelName(): string | null {
    const currentModel = this.ctx.currentModel as { name?: string; model?: string } | null | undefined;
    return currentModel?.model ?? currentModel?.name ?? null;
  }

  private buildForkedSessionTitle(sourceTitle: string): string {
    const normalized = sourceTitle.trim() || 'New Chat';
    return normalized.startsWith('Forked: ')
      ? normalized
      : `Forked: ${normalized}`;
  }

  async switchToSession(
    sessionId: string,
    optionsOrHostRecordOverride?: SessionLifecycleSwitchOptions | HostSessionRecord | null,
  ): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionId = this.resolveCurrentViewSessionResource();
    if (currentViewSessionId === targetSessionId) {
      await this.ctx.attachSessionView?.(targetSessionId);
      this.ctx.markVisibleSessionProjectionOwner?.(targetSessionId);
      return true;
    }

    const switchOptions = this.normalizeSwitchOptions(optionsOrHostRecordOverride);
    const entryProjectPath = this.ctx.chatHistoryService.findEntry(targetSessionId)?.projectPath ?? null;
    const restoreRequest = this.hostSessionItemController.resolveSessionSwitchRestoreRequest(targetSessionId, {
      fallbackProjectPath: switchOptions.fallbackProjectPath ?? entryProjectPath ?? this.resolveCurrentProjectPath(),
      hostRecordOverride: switchOptions.hostRecordOverride,
    });

    return this.activateSessionFromRestoreRequest(restoreRequest, {
      preferDetachedRuntimeAttach: true,
    });
  }

  async preloadSessionModel(
    sessionId: string,
    options: { readonly fallbackProjectPath?: string | null } = {},
  ): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    if (this.sessionModelReferences.has(targetSessionId)) {
      return true;
    }

    const pending = this.sessionModelPreloadPromises.get(targetSessionId);
    if (pending) {
      return pending;
    }

    const preloadPromise = this.loadSessionModelForPreload(targetSessionId, options)
      .finally(() => {
        if (this.sessionModelPreloadPromises.get(targetSessionId) === preloadPromise) {
          this.sessionModelPreloadPromises.delete(targetSessionId);
        }
      });
    this.sessionModelPreloadPromises.set(targetSessionId, preloadPromise);
    return preloadPromise;
  }

  private async loadSessionModelForPreload(
    sessionId: string,
    options: { readonly fallbackProjectPath?: string | null },
  ): Promise<boolean> {
    const entryProjectPath = this.ctx.chatHistoryService.findEntry(sessionId)?.projectPath ?? null;
    const restoreRequest = this.hostSessionItemController.resolveSessionSwitchRestoreRequest(sessionId, {
      fallbackProjectPath: options.fallbackProjectPath ?? entryProjectPath ?? this.resolveCurrentProjectPath(),
    });
    const hostRecord = restoreRequest.hostRecord ?? restoreRequest.sessionContent.hostRecord ?? null;

    const existingReference = this.ctx.acquireExistingSessionModel?.(sessionId);
    if (existingReference) {
      if (this.existingSessionModelCanSatisfyRestore(existingReference.object, restoreRequest)) {
        this.sessionModelReferences.get(sessionId)?.dispose();
        this.sessionModelReferences.set(sessionId, existingReference);
        return true;
      }
      existingReference.dispose();
    }

    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const restoredTitle = resolveRestoredSessionTitle(restoreRequest.sessionContent, runtimeTurnResponses);
    this.acquireSessionModel({
      sessionResource: sessionId,
      title: restoredTitle.text
        ? restoredTitle
        : {
            text: restoreRequest.sessionContent.title ?? '',
            source: restoreRequest.sessionContent.title ? 'restored-custom' : 'empty',
          },
      projectPath: restoreRequest.sessionContent.projectPathHint
        ?? restoreRequest.sessionContent.providerOptions.folderPath
        ?? options.fallbackProjectPath
        ?? null,
      sessionType: restoreRequest.sessionContent.sessionType,
      inputState: { providerOptions: restoreRequest.sessionContent.providerOptions },
      turnResponses: hostRecord?.turnResponses ?? [],
    });
    return true;
  }

  private normalizeSwitchOptions(
    optionsOrHostRecordOverride?: SessionLifecycleSwitchOptions | HostSessionRecord | null,
  ): SessionLifecycleSwitchOptions {
    if (!optionsOrHostRecordOverride) {
      return {};
    }

    if (this.isHostSessionRecord(optionsOrHostRecordOverride)) {
      return {
        hostRecordOverride: optionsOrHostRecordOverride,
      };
    }

    return optionsOrHostRecordOverride;
  }

  private isHostSessionRecord(value: unknown): value is HostSessionRecord {
    return !!value && typeof value === 'object' && 'metadata' in value;
  }

  private async activateSessionFromRestoreRequest(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
        readonly sessionType: string;
        readonly projectPath: string | null;
        readonly inputState?: import('../core/chat-mode').ChatSessionInputState;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    options: {
      readonly ensureManagedItem?: boolean;
      readonly preferDetachedRuntimeAttach?: boolean;
    } = {},
  ): Promise<boolean> {
    const activationRequestId = ++this.sessionActivationRequestId;
    this.logSessionActivationScalar('activation-start', restoreRequest);

    this.resetForSessionActivation({ clearVisibleProjection: false });

    if (options.ensureManagedItem) {
      this.hostSessionItemController.createNewChatSessionItem(restoreRequest.target.sessionId, {
        title: restoreRequest.sessionContent.title,
        sessionType: restoreRequest.sessionContent.sessionType,
        projectPath: restoreRequest.sessionContent.projectPathHint
          ?? restoreRequest.sessionContent.providerOptions.folderPath
          ?? restoreRequest.target.projectPath,
        inputState: restoreRequest.sessionContent.inputState ?? restoreRequest.target.inputState,
        mode: typeof restoreRequest.sessionContent.metadata?.mode === 'string'
          ? normalizeChatSurfaceModeId(restoreRequest.sessionContent.metadata.mode)
          : undefined,
        requestRouting: restoreRequest.sessionContent.metadata?.requestRouting
          ? normalizeHostSessionRequestRoutingSummary(
              restoreRequest.sessionContent.metadata.requestRouting,
              restoreRequest.sessionContent.metadata.mode ?? this.ctx.currentMode,
            )
          : undefined,
      });
    }

    if (await this.attachExistingSessionModelFromRestoreRequest(restoreRequest, activationRequestId)) {
      return true;
    }

    if (options.preferDetachedRuntimeAttach === true
      && this.shouldReattachDetachedRuntimeSession(restoreRequest.target.sessionId, {
        allowIdleContent: !restoreRequest.hostRecord,
      })) {
      await this.reattachDetachedRuntimeSession(restoreRequest, activationRequestId);
      return true;
    }

    if (this.shouldRejectMissingRestoreRecord(restoreRequest)) {
      console.warn('[SessionLifecycle][recoverable-missing-record]', {
        sessionId: restoreRequest.target.sessionId,
        projectPath: restoreRequest.diagnostics.projectPath ?? null,
        requestSource: restoreRequest.diagnostics.requestSource,
        hostRecordSource: restoreRequest.diagnostics.hostRecordSource,
        metadataSource: restoreRequest.diagnostics.metadataSource,
      });
      this.discardMissingRestoreTarget(restoreRequest);
      return false;
    }

    const runtimeRestoreHostRecord = this.shouldUseRuntimeRestoreHostRecord(
      restoreRequest.target.sessionId,
      restoreRequest.hostRecord,
    )
      ? this.ctx.buildRuntimeRestoreHostRecord?.(restoreRequest) ?? null
      : null;
    const hostRecordToRestore = runtimeRestoreHostRecord ?? restoreRequest.hostRecord;
    if (hostRecordToRestore) {
      await this.restoreDurableSessionModelFromRestoreRequest(
        restoreRequest,
        hostRecordToRestore,
        activationRequestId,
        { preserveActiveResponseState: !!runtimeRestoreHostRecord },
      );
      return true;
    }

    await this.attachBlankSessionModelFromRestoreRequest(restoreRequest, activationRequestId);
    return true;
  }

  private async restoreDurableSessionModelFromRestoreRequest(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
      };
      readonly sessionContent: HostSessionContent;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    hostRecordToRestore: HostSessionRecord,
    activationRequestId: number,
    options: { readonly preserveActiveResponseState?: boolean } = {},
  ): Promise<void> {
    const sessionId = typeof restoreRequest.target.sessionId === 'string'
      ? restoreRequest.target.sessionId.trim()
      : '';
    if (!sessionId) {
      return;
    }

    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const resolvedTitle = resolveRestoredSessionTitle(restoreRequest.sessionContent, runtimeTurnResponses);
    const restoredTitle = resolvedTitle.text
      ? resolvedTitle
      : {
          text: restoreRequest.sessionContent.title,
          source: restoreRequest.sessionContent.title ? 'restored' as ChatSessionTitleSource : resolvedTitle.source,
        };
    const providerOptions = restoreRequest.sessionContent.providerOptions;
    this.acquireSessionModel({
      sessionResource: sessionId,
      title: restoredTitle,
      projectPath: this.resolveSessionContentProjectPath(restoreRequest.sessionContent.hostRecord),
      sessionType: restoreRequest.sessionContent.sessionType,
      inputState: { providerOptions },
    });
    this.ctx.attachSessionViewModel?.(sessionId);
    this.persistSessionEntryTarget(this.buildSessionEntryTarget(sessionId, restoreRequest.sessionContent));

    await Promise.resolve();
    this.throwIfSessionActivationSuperseded(activationRequestId);

    try {
      await this.ctx.restoreSessionHostRecord(hostRecordToRestore, {
        sessionId,
        isCurrent: () => this.isCurrentSessionActivationRequest(activationRequestId),
        preserveActiveResponseState: options.preserveActiveResponseState === true,
      });
      this.throwIfSessionActivationSuperseded(activationRequestId);
    } catch (error) {
      if (isSessionLifecycleSupersededError(error)) {
        throw error;
      }
      throw this.createSessionRestoreError('host-restore', restoreRequest.diagnostics, error);
    }

    if (options.preserveActiveResponseState !== true) {
      await this.restoreExecutionRuntimeSession(
        sessionId,
        sanitizeHostRecordForRestore(hostRecordToRestore),
        providerOptions,
        restoreRequest.sessionContent.metadata,
      );
      this.throwIfSessionActivationSuperseded(activationRequestId);
    }

    await this.ctx.attachSessionView?.(sessionId);
    this.throwIfSessionActivationSuperseded(activationRequestId);
    this.commitVisibleSessionShell({
      sessionId,
      title: restoredTitle,
      sessionType: restoreRequest.sessionContent.sessionType,
      providerOptions,
      metadata: restoreRequest.sessionContent.metadata,
    });
    this.ctx.ensureBackgroundSessionCanRerun?.(sessionId);
    this.ctx.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
    this.logSessionActivationScalar('durable-restore-committed', restoreRequest, {
      modelTurns: this.countReferencedModelTurns(sessionId),
      modelProjectionTurns: this.countReferencedModelProjectionTurns(sessionId),
    });
    this.requestSessionListRefresh({
      reason: 'reopen',
      scope: 'summary',
      priority: 'after-paint',
    });
  }

  private shouldUseRuntimeRestoreHostRecord(
    sessionId: string | null | undefined,
    durableHostRecord: HostSessionRecord | null | undefined,
  ): boolean {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!normalizedSessionId) {
      return false;
    }

    const runtimeState = this.ctx.readSessionRuntimeState?.(normalizedSessionId);
    if (!runtimeState) {
      return false;
    }

    if (runtimeState.requestInProgress === true || runtimeState.attachedView === true) {
      return true;
    }

    if (!durableHostRecord) {
      return Array.isArray(runtimeState.turnResponses) && runtimeState.turnResponses.length > 0;
    }

    return false;
  }

  private async attachExistingSessionModelFromRestoreRequest(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
        readonly projectPath?: string | null;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    activationRequestId: number,
  ): Promise<boolean> {
    const sessionId = typeof restoreRequest.target.sessionId === 'string'
      ? restoreRequest.target.sessionId.trim()
      : '';
    if (!sessionId || !this.ctx.acquireExistingSessionModel) {
      return false;
    }

    const modelReference = this.ctx.acquireExistingSessionModel(sessionId);
    if (!modelReference) {
      this.logSessionActivationScalar('existing-model-missing', restoreRequest);
      return false;
    }

    if (!this.existingSessionModelCanSatisfyRestore(modelReference.object, restoreRequest)) {
      this.logSessionActivationScalar('existing-model-rejected', restoreRequest, {
        modelTurns: this.countModelTurns(modelReference.object),
        modelProjectionTurns: this.countModelProjectionTurns(modelReference.object),
      });
      modelReference.dispose();
      return false;
    }
    this.logSessionActivationScalar('existing-model-accepted', restoreRequest, {
      modelTurns: this.countModelTurns(modelReference.object),
      modelProjectionTurns: this.countModelProjectionTurns(modelReference.object),
    });

    this.sessionModelReferences.get(sessionId)?.dispose();
    this.sessionModelReferences.set(sessionId, modelReference);
    this.throwIfSessionActivationSuperseded(activationRequestId);

    this.setActiveSessionId(sessionId);
    const viewModel = this.ctx.attachSessionViewModel?.(sessionId);
    if (!viewModel) {
      this.sessionModelReferences.get(sessionId)?.dispose();
      this.sessionModelReferences.delete(sessionId);
      return false;
    }

    const model = modelReference.object;
    const modelTitle = model.title;
    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const restoredTitle = modelTitle.text
      ? { text: modelTitle.text, source: modelTitle.source }
      : resolveRestoredSessionTitle(restoreRequest.sessionContent, runtimeTurnResponses);
    const providerOptions = model.inputState.providerOptions
      ?? restoreRequest.sessionContent.providerOptions;

    this.persistSessionEntryTarget(this.buildSessionEntryTarget(sessionId, restoreRequest.sessionContent));
    await this.restoreHostEditTrackingSessionState(
      sessionId,
      providerOptions.folderPath
        ?? restoreRequest.sessionContent.projectPathHint
        ?? restoreRequest.target.projectPath
        ?? null,
      restoreRequest.hostRecord?.turnResponses
        ?? restoreRequest.sessionContent.hostRecord?.turnResponses
        ?? model.turnResponses,
    );

    const durableHostRecord = restoreRequest.hostRecord
      ?? restoreRequest.sessionContent.hostRecord
      ?? null;
    if (durableHostRecord) {
      const executionState = await this.readExecutionRuntimeSessionState(sessionId);
      this.throwIfSessionActivationSuperseded(activationRequestId);
      if (!executionState.requestInProgress) {
        await this.restoreExecutionRuntimeSession(
          sessionId,
          sanitizeHostRecordForRestore(durableHostRecord),
          providerOptions,
          restoreRequest.sessionContent.metadata,
        );
        this.throwIfSessionActivationSuperseded(activationRequestId);
      }
    }

    await this.ctx.attachSessionView?.(sessionId);
    this.throwIfSessionActivationSuperseded(activationRequestId);
    this.commitVisibleSessionShell({
      sessionId,
      title: restoredTitle,
      sessionType: model.sessionType ?? restoreRequest.sessionContent.sessionType,
      providerOptions,
      metadata: restoreRequest.sessionContent.metadata,
    });
    this.ctx.ensureBackgroundSessionCanRerun?.(sessionId);
    this.ctx.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
    this.logSessionActivationScalar('existing-model-attached', restoreRequest, {
      modelTurns: this.countModelTurns(model),
      modelProjectionTurns: this.countModelProjectionTurns(model),
    });
    this.requestSessionListRefresh({
      reason: 'reopen',
      scope: 'summary',
      priority: 'after-paint',
    });
    return true;
  }

  private async restoreExecutionRuntimeSession(
    sessionId: string,
    hostRecord: HostSessionRecord,
    providerOptions: HostSessionProviderOptions,
    metadata?: HostSessionContentMetadataSource | null,
  ): Promise<void> {
    const turnResponses = Array.isArray(hostRecord.turnResponses)
      ? hostRecord.turnResponses
      : [];
    if (turnResponses.length === 0) {
      return;
    }
    const restoreRuntimeSession = this.ctx.restoreRuntimeSessionExecutor;
    if (typeof restoreRuntimeSession !== 'function') {
      throw new Error('[SessionLifecycle] Execution owner does not support canonical session restore.');
    }
    const snapshot = buildTurnResponseLexSessionSnapshot(turnResponses, sessionId, hostRecord);
    if (!snapshot) {
      throw new Error(`[SessionLifecycle] Unable to build the canonical runtime snapshot for ${sessionId}.`);
    }
    const agentRuntimeMode = this.resolveAgentRuntimeMode(providerOptions, metadata).mode;
    const result = await restoreRuntimeSession({
      sessionId,
      snapshot,
      turnResponses,
      providerOptions,
      agentRuntimeMode,
      currentModel: this.ctx.currentModel ?? null,
    });
    if (result.sessionId !== sessionId || result.turnCount !== turnResponses.length) {
      throw new Error(
        `[SessionLifecycle] Execution owner restored an invalid request list for ${sessionId}: expected ${turnResponses.length}, got ${result.turnCount}.`,
      );
    }
  }

  private async readExecutionRuntimeSessionState(
    sessionId: string,
  ): Promise<ChatRuntimeHostSessionExecutionState> {
    const readState = this.ctx.readExecutionRuntimeSessionState;
    if (typeof readState !== 'function') {
      throw new Error('[SessionLifecycle] Execution owner does not expose canonical session state.');
    }
    const state = await readState(sessionId);
    if (!state || state.sessionId !== sessionId) {
      throw new Error(`[SessionLifecycle] Execution owner returned invalid session state for ${sessionId}.`);
    }
    return state;
  }

  private existingSessionModelCanSatisfyRestore(
    model: ChatSessionModelReference['object'],
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
    },
  ): boolean {
    const durableTurnResponses = restoreRequest.hostRecord?.turnResponses
      ?? restoreRequest.sessionContent.hostRecord?.turnResponses
      ?? [];
    const hasDurableTurnResponses = Array.isArray(durableTurnResponses) && durableTurnResponses.length > 0;

    if (!hasDurableTurnResponses) {
      const hasExplicitDurableRecord = !!restoreRequest.hostRecord
        || !!restoreRequest.sessionContent.hostRecord;
      if (hasExplicitDurableRecord) {
        return Array.isArray(model.turnResponses) && model.turnResponses.length === 0;
      }

      const modelTurns = model.turnResponses;
      if (Array.isArray(modelTurns) && modelTurns.length > 0) {
        return true;
      }

      const runtimeState = this.ctx.readSessionRuntimeState?.(restoreRequest.target.sessionId);
      if (Array.isArray(runtimeState?.turnResponses) && runtimeState.turnResponses.length > 0) {
        return true;
      }

      return false;
    }

    if (this.turnResponsesExactlyMatchDurableSession(model.turnResponses, durableTurnResponses)) {
      return true;
    }

    const runtimeState = this.ctx.readSessionRuntimeState?.(restoreRequest.target.sessionId);
    if (this.turnResponsesExactlyMatchDurableSession(runtimeState?.turnResponses, durableTurnResponses)) {
      return true;
    }

    return false;
  }

  private turnResponsesExactlyMatchDurableSession(
    candidateTurnResponses: readonly TurnResponseTurn[] | null | undefined,
    durableTurnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): boolean {
    if (!Array.isArray(candidateTurnResponses)
      || !Array.isArray(durableTurnResponses)
      || candidateTurnResponses.length === 0
      || durableTurnResponses.length === 0
      || candidateTurnResponses.length !== durableTurnResponses.length) {
      return false;
    }

    return candidateTurnResponses.every((candidateTurn, index) => {
      const candidateTurnId = typeof candidateTurn?.turnId === 'string'
        ? candidateTurn.turnId.trim()
        : '';
      const durableTurnId = typeof durableTurnResponses[index]?.turnId === 'string'
        ? durableTurnResponses[index].turnId.trim()
        : '';
      return !!candidateTurnId && candidateTurnId === durableTurnId;
    });
  }

  private shouldRejectMissingRestoreRecord(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
  ): boolean {
    const sessionId = typeof restoreRequest.target.sessionId === 'string'
      ? restoreRequest.target.sessionId.trim()
      : '';
    if (!sessionId || restoreRequest.hostRecord || restoreRequest.sessionContent.hostRecord) {
      return false;
    }

    if (restoreRequest.diagnostics.hostRecordSource !== 'missing'
      || !this.isRealMetadataOnlyRestoreCarrier(restoreRequest.diagnostics.metadataSource)) {
      return false;
    }

    if (this.restoreRequestHasLiveRuntimeContent(sessionId)) {
      return false;
    }

    return !this.restoreRequestHasDurableConversationContent(restoreRequest);
  }

  private discardMissingRestoreTarget(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
        readonly projectPath?: string | null;
      };
      readonly sessionContent: HostSessionContent;
    },
  ): void {
    const sessionId = typeof restoreRequest.target.sessionId === 'string'
      ? restoreRequest.target.sessionId.trim()
      : '';
    if (!sessionId) {
      return;
    }

    this.sessionModelReferences.get(sessionId)?.dispose();
    this.sessionModelReferences.delete(sessionId);
    this.hostSessionItemController.discardChatSessionItem(sessionId);
    this.clearPersistedSessionEntryTarget(sessionId);
    this.ctx.detachSessionRuntimeView?.(sessionId);
    this.ctx.detachSessionViewModel?.(sessionId);

    const currentSessionId = this.resolveCurrentViewSessionResource();
    const liveSessionId = typeof this.ctx.chatService.currentSessionId === 'string'
      ? this.ctx.chatService.currentSessionId.trim()
      : '';
    if (currentSessionId === sessionId || liveSessionId === sessionId) {
      this.enterEntryState({
        projectPath: restoreRequest.sessionContent.projectPathHint
          ?? restoreRequest.sessionContent.providerOptions.folderPath
          ?? restoreRequest.target.projectPath
          ?? this.resolveCurrentProjectPath(),
      });
    }

    this.requestSessionListRefresh({
      reason: 'entry',
      scope: 'summary',
      priority: 'after-paint',
    });
    this.scheduleProvisionalSessionBootstrap();
  }

  private logSessionActivationScalar(
    phase: string,
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    extra: {
      readonly modelTurns?: number;
      readonly modelProjectionTurns?: number;
    } = {},
  ): void {
    const sessionId = restoreRequest.target.sessionId;
    const runtimeState = this.ctx.readSessionRuntimeState?.(sessionId);
    const runtimeProjection = runtimeState?.hostProjectionState ?? null;
    const hostRecord = restoreRequest.hostRecord ?? restoreRequest.sessionContent.hostRecord ?? null;
    const hostRecordTurns = Array.isArray(hostRecord?.turnResponses)
      ? hostRecord.turnResponses.length
      : 0;
    const runtimeTurns = Array.isArray(runtimeState?.turnResponses)
      ? runtimeState.turnResponses.length
      : 0;
    const runtimeProjectionTurns = Array.isArray(runtimeProjection?.turnResponses)
      ? runtimeProjection.turnResponses.length
      : 0;
    const runtimeProjectionChatList = Array.isArray(runtimeProjection?.chatList)
      ? runtimeProjection.chatList.length
      : 0;
    const runtimeProjectionDialogs = Array.isArray(runtimeProjection?.dialogItems)
      ? runtimeProjection.dialogItems.length
      : 0;
    const summaryBoundaries = this.countSummaryBoundaries(hostRecord?.turnResponses);
    const checkpointSidecars = this.countCheckpointSidecars(hostRecord?.turnResponses);
    const model = this.sessionModelReferences.get(sessionId)?.object;
    const hostOwner = buildSessionTurnOwnerDiagnostics(sessionId, hostRecord?.turnResponses as readonly TurnResponseTurn[] | undefined);
    const runtimeOwner = buildSessionTurnOwnerDiagnostics(sessionId, runtimeState?.turnResponses);
    const runtimeProjectionOwner = buildSessionTurnOwnerDiagnostics(sessionId, runtimeProjection?.turnResponses as readonly TurnResponseTurn[] | undefined);
    const modelOwner = buildSessionTurnOwnerDiagnostics(sessionId, model?.turnResponses);
    const modelProjectionOwner = buildSessionTurnOwnerDiagnostics(sessionId, model?.hostProjectionState?.turnResponses as readonly TurnResponseTurn[] | undefined);
    console.info(
      '[SessionLifecycle][SwitchScalar]',
      [
        `phase=${phase}`,
        `sessionId=${sessionId || '<empty>'}`,
        `hostRecordSource=${restoreRequest.diagnostics.hostRecordSource}`,
        `metadataSource=${restoreRequest.diagnostics.metadataSource}`,
        `hostRecordTurns=${hostRecordTurns}`,
        `runtimeAttached=${runtimeState?.attachedView ?? '<none>'}`,
        `runtimeInProgress=${runtimeState?.requestInProgress === true}`,
        `runtimeTurns=${runtimeTurns}`,
        `runtimeProjectionTurns=${runtimeProjectionTurns}`,
        `runtimeProjectionChatList=${runtimeProjectionChatList}`,
        `runtimeProjectionDialogs=${runtimeProjectionDialogs}`,
        `summaryBoundaries=${summaryBoundaries}`,
        `checkpointSidecars=${checkpointSidecars}`,
        `modelTurns=${extra.modelTurns ?? '<unknown>'}`,
        `modelProjectionTurns=${extra.modelProjectionTurns ?? '<unknown>'}`,
        ...formatSessionTurnOwnerDiagnosticsFields('host', hostOwner),
        ...formatSessionTurnOwnerDiagnosticsFields('runtime', runtimeOwner),
        ...formatSessionTurnOwnerDiagnosticsFields('runtimeProjection', runtimeProjectionOwner),
        ...formatSessionTurnOwnerDiagnosticsFields('model', modelOwner),
        ...formatSessionTurnOwnerDiagnosticsFields('modelProjection', modelProjectionOwner),
      ].join(' '),
    );
    if (hostOwner.mismatchCount > 0
      || runtimeOwner.mismatchCount > 0
      || runtimeProjectionOwner.mismatchCount > 0
      || modelOwner.mismatchCount > 0
      || modelProjectionOwner.mismatchCount > 0) {
      console.warn('[SessionLifecycle][owner-mismatch]', {
        phase,
        sessionId,
        host: hostOwner,
        runtime: runtimeOwner,
        runtimeProjection: runtimeProjectionOwner,
        model: modelOwner,
        modelProjection: modelProjectionOwner,
      });
    }
  }

  private countModelTurns(model: ChatSessionModelReference['object']): number {
    const turnResponses = model.turnResponses;
    return Array.isArray(turnResponses) ? turnResponses.length : 0;
  }

  private countModelProjectionTurns(model: ChatSessionModelReference['object']): number {
    const projection = model.hostProjectionState ?? null;
    return Array.isArray(projection?.turnResponses) ? projection.turnResponses.length : 0;
  }

  private countReferencedModelTurns(sessionId: string): number {
    const model = this.sessionModelReferences.get(sessionId)?.object;
    return model ? this.countModelTurns(model) : 0;
  }

  private countReferencedModelProjectionTurns(sessionId: string): number {
    const model = this.sessionModelReferences.get(sessionId)?.object;
    return model ? this.countModelProjectionTurns(model) : 0;
  }

  private countSummaryBoundaries(turnResponses: HostSessionRecord['turnResponses'] | null | undefined): number {
    if (!Array.isArray(turnResponses)) {
      return 0;
    }

    return turnResponses.reduce((total, turn) => {
      const roundCount = Array.isArray(turn?.rounds)
        ? turn.rounds.filter(round => typeof round?.summary === 'string' && round.summary.trim().length > 0).length
        : 0;
      const responseModel = turn?.responseModel;
      const sidecarCount = Array.isArray(responseModel?.summaries)
        ? responseModel.summaries.filter(summary => typeof summary?.text === 'string' && summary.text.trim().length > 0).length
        : (typeof responseModel?.summary?.text === 'string' && responseModel.summary.text.trim().length > 0 ? 1 : 0);
      return total + roundCount + sidecarCount;
    }, 0);
  }

  private countCheckpointSidecars(turnResponses: HostSessionRecord['turnResponses'] | null | undefined): number {
    if (!Array.isArray(turnResponses)) {
      return 0;
    }

    return turnResponses.reduce((total, turn) => {
      const metadata = turn?.request?.metadata as Record<string, unknown> | undefined;
      if (!metadata || typeof metadata !== 'object') {
        return total;
      }
      return total + (
        typeof metadata['checkpointId'] === 'string'
        || typeof metadata['checkpointRef'] === 'string'
        || metadata['additionalCheckpointRefs'] !== undefined
        || metadata['checkpointRefs'] !== undefined
          ? 1
          : 0
      );
    }, 0);
  }

  private isRealMetadataOnlyRestoreCarrier(metadataSource: HostSessionSwitchRestoreDiagnostics['metadataSource'] | string): boolean {
    return metadataSource === 'index-entry' || metadataSource === 'entry-target';
  }

  private restoreRequestHasLiveRuntimeContent(sessionId: string): boolean {
    const runtimeState = this.ctx.readSessionRuntimeState?.(sessionId);
    if (!runtimeState) {
      return false;
    }

    return runtimeState.requestInProgress === true
      || !!runtimeState.activeResponseHandle
      || (Array.isArray(runtimeState.turnResponses) && runtimeState.turnResponses.length > 0)
      || hasHostResponseConversationContent(runtimeState.hostProjectionState ?? null);
  }

  private restoreRequestHasDurableConversationContent(
    restoreRequest: {
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
    },
  ): boolean {
    const hostRecord = restoreRequest.hostRecord ?? restoreRequest.sessionContent.hostRecord ?? null;
    return !!hostRecord && countHostRecordMessages(hostRecord) > 0;
  }

  private shouldReattachDetachedRuntimeSession(
    sessionId: string,
    options: { readonly allowIdleContent?: boolean } = {},
  ): boolean {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return false;
    }

    if (this.ctx.hasSessionRuntimeHandle?.(normalizedSessionId) === true) {
      return true;
    }

    const runtimeState = this.ctx.readSessionRuntimeState?.(normalizedSessionId);
    if (!runtimeState) {
      return false;
    }

    const runtimeHasConversationContent = hasHostResponseConversationContent(runtimeState.hostProjectionState ?? null)
      || (Array.isArray(runtimeState.turnResponses) && runtimeState.turnResponses.length > 0);
    const runtimeStillOwnsActiveTurn = runtimeState.requestInProgress === true
      || runtimeState.status === 'in_progress'
      || runtimeState.status === 'needs_input'
      || !!runtimeState.activeResponseHandle;
    if (!runtimeStillOwnsActiveTurn && (options.allowIdleContent !== true || !runtimeHasConversationContent)) {
      return false;
    }

    return runtimeState.attachedView === false
      || runtimeHasConversationContent;
  }

  private async reattachDetachedRuntimeSession(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
        readonly projectPath?: string | null;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    activationRequestId: number,
  ): Promise<void> {
    const sessionId = restoreRequest.target.sessionId;
    const providerOptions = restoreRequest.sessionContent.providerOptions;

    this.throwIfSessionActivationSuperseded(activationRequestId);
    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const restoredTitle = resolveRestoredSessionTitle(restoreRequest.sessionContent, runtimeTurnResponses);
    this.acquireSessionModel({
      sessionResource: sessionId,
      title: restoredTitle,
      projectPath: restoreRequest.sessionContent.projectPathHint
        ?? providerOptions.folderPath
        ?? restoreRequest.target.projectPath
        ?? this.resolveSessionContentProjectPath(restoreRequest.sessionContent.hostRecord),
      sessionType: restoreRequest.sessionContent.sessionType,
      inputState: { providerOptions },
    });
    this.ctx.attachSessionViewModel?.(sessionId);
    this.persistSessionEntryTarget(this.buildSessionEntryTarget(sessionId, restoreRequest.sessionContent));

    if (typeof this.ctx.attachSessionView === 'function') {
      await this.ctx.attachSessionView(sessionId);
      this.ctx.ensureBackgroundSessionCanRerun?.(sessionId);
      this.throwIfSessionActivationSuperseded(activationRequestId);
    } else if (typeof this.ctx.attachCurrentSessionView === 'function') {
      await this.ctx.attachCurrentSessionView();
      this.ctx.ensureBackgroundSessionCanRerun?.(sessionId);
      this.throwIfSessionActivationSuperseded(activationRequestId);
    }
    this.commitVisibleSessionShell({
      sessionId,
      title: restoredTitle,
      sessionType: restoreRequest.sessionContent.sessionType,
      providerOptions,
      metadata: restoreRequest.sessionContent.metadata,
      applyAgentRuntimeMode: false,
    });

    this.ctx.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
    this.logSessionActivationScalar('runtime-reattached', restoreRequest, {
      modelTurns: this.countReferencedModelTurns(sessionId),
      modelProjectionTurns: this.countReferencedModelProjectionTurns(sessionId),
    });
    this.requestSessionListRefresh({
      reason: 'reopen',
      scope: 'summary',
      priority: 'after-paint',
    });
  }

  private async attachBlankSessionModelFromRestoreRequest(
    restoreRequest: {
      readonly target: {
        readonly sessionId: string;
        readonly projectPath?: string | null;
      };
      readonly sessionContent: HostSessionContent;
      readonly hostRecord?: HostSessionRecord | null;
      readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
    },
    activationRequestId: number,
  ): Promise<void> {
    const sessionId = typeof restoreRequest.target.sessionId === 'string'
      ? restoreRequest.target.sessionId.trim()
      : '';
    if (!sessionId) {
      return;
    }

    this.throwIfSessionActivationSuperseded(activationRequestId);
    const providerOptions = restoreRequest.sessionContent.providerOptions;
    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const restoredTitle = resolveRestoredSessionTitle(restoreRequest.sessionContent, runtimeTurnResponses);
    this.resetForSessionActivation({ clearVisibleProjection: true });
    this.acquireSessionModel({
      sessionResource: sessionId,
      title: restoredTitle,
      projectPath: restoreRequest.sessionContent.projectPathHint
        ?? providerOptions.folderPath
        ?? restoreRequest.target.projectPath
        ?? this.resolveSessionContentProjectPath(restoreRequest.sessionContent.hostRecord),
      sessionType: restoreRequest.sessionContent.sessionType,
      inputState: { providerOptions },
    });
    this.ctx.attachSessionViewModel?.(sessionId);
    this.persistSessionEntryTarget(this.buildSessionEntryTarget(sessionId, restoreRequest.sessionContent));
    this.ctx.markVisibleSessionProjectionOwner?.(sessionId);

    await this.ctx.attachSessionView?.(sessionId);
    this.throwIfSessionActivationSuperseded(activationRequestId);
    this.commitVisibleSessionShell({
      sessionId,
      title: restoredTitle,
      sessionType: restoreRequest.sessionContent.sessionType,
      providerOptions,
      metadata: restoreRequest.sessionContent.metadata,
    });
    this.ctx.ensureBackgroundSessionCanRerun?.(sessionId);
    this.ctx.chatHistoryService.clearRecordedRestoreFailure?.(sessionId);
    this.logSessionActivationScalar('blank-model-attached', restoreRequest, {
      modelTurns: this.countReferencedModelTurns(sessionId),
      modelProjectionTurns: this.countReferencedModelProjectionTurns(sessionId),
    });
    this.requestSessionListRefresh({
      reason: 'reopen',
      scope: 'summary',
      priority: 'after-paint',
    });
  }

  private isCurrentSessionActivationRequest(activationRequestId: number): boolean {
    return activationRequestId === this.sessionActivationRequestId;
  }

  private throwIfSessionActivationSuperseded(activationRequestId: number): void {
    if (!this.isCurrentSessionActivationRequest(activationRequestId)) {
      throw new SessionLifecycleSupersededError();
    }
  }

  private resolveCurrentSessionSaveTarget(): HostSessionSaveTarget | null {
    const sessionId = this.resolveCurrentViewSessionResource();
    if (!sessionId) {
      return null;
    }
    return this.ctx.buildExecutionSaveTarget?.(sessionId) ?? null;
  }

  private resolveCurrentViewSessionResource(): string {
    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    return typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
  }

  private acquireSessionModel(
    props: ChatSessionModelCreateProps,
    options: { readonly provisional?: boolean } = {},
  ): void {
    const sessionId = typeof props.sessionResource === 'string'
      ? props.sessionResource.trim()
      : '';
    if (!sessionId || !this.ctx.acquireSessionModel) {
      return;
    }

    this.sessionModelReferences.get(sessionId)?.dispose();
    const acquire = options.provisional && this.ctx.acquireProvisionalSessionModel
      ? this.ctx.acquireProvisionalSessionModel
      : this.ctx.acquireSessionModel;
    this.sessionModelReferences.set(sessionId, acquire({
      ...props,
      sessionResource: sessionId,
    }));
  }

  private commitVisibleSessionShell(options: {
    readonly sessionId: string;
    readonly title: { readonly text: string; readonly source: ChatSessionTitleSource };
    readonly sessionType?: unknown;
    readonly providerOptions: HostSessionProviderOptions;
    readonly metadata?: HostSessionContent['metadata'];
    readonly applyAgentRuntimeMode?: boolean;
  }): void {
    this.setActiveSessionId(options.sessionId);
    applyCurrentSessionTitle(this.ctx.chatService, options.title);
    this.applySessionType(options.sessionType);
    if (options.applyAgentRuntimeMode !== false) {
      this.applyAgentRuntimeMode(options.providerOptions, options.metadata);
    }
    this.applySessionProviderOptions(options.providerOptions);
    this.ctx.isSessionStarting = false;
    this.ctx.isCancelled = false;
  }

  private resetForSessionActivation(options: { readonly clearVisibleProjection?: boolean } = {}): void {
    const targetSessionId = this.resolveCurrentViewSessionResource();

    if (targetSessionId) {
      this.ctx.detachSessionRuntimeView?.(targetSessionId);
    }

    if (options.clearVisibleProjection !== false) {
      this.ctx.resetVisibleSessionProjection({
        clearEditSummary: true,
      });
    }

    this.ctx.isSessionStarting = false;
  }

  private createSessionRestoreError(
    stage: SessionSwitchRestoreStage,
    diagnostics: HostSessionSwitchRestoreDiagnostics,
    cause: unknown,
  ): SessionLifecycleRestoreError {
    const restoreFailureDetails = readHostSessionRestoreFailureDetails(cause);
    const causeMessage = cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : 'unknown error';
    const detail = [
      `stage=${stage}`,
      `sessionId=${diagnostics.sessionId}`,
      `projectPath=${diagnostics.projectPath ?? 'unknown'}`,
      `requestSource=${diagnostics.requestSource}`,
      `hostRecordSource=${diagnostics.hostRecordSource}`,
      `metadataSource=${diagnostics.metadataSource}`,
      ...(restoreFailureDetails ? [`restoreKind=${restoreFailureDetails.kind}`] : []),
      ...(restoreFailureDetails?.hostRecordSessionId ? [`hostRecordSessionId=${restoreFailureDetails.hostRecordSessionId}`] : []),
      ...(restoreFailureDetails?.storedSnapshotState ? [`storedSnapshotState=${restoreFailureDetails.storedSnapshotState}`] : []),
    ].join(', ');
    return new SessionLifecycleRestoreError(
      `[SessionLifecycle] Session restore failed (${detail}): ${causeMessage}`,
      {
        stage,
        diagnostics,
        restoreFailure: restoreFailureDetails,
      },
      cause,
    );
  }

  private async startSessionWithId(
    sessionId: string,
    sessionContent?: HostSessionContent | null,
    activationRequestId?: number,
  ): Promise<void> {
    this.ctx.isSessionStarting = true;
    this.ctx.isCancelled = false;

    const hostRecord = sessionContent?.hostRecord ?? null;
    const providerOptions = sessionContent?.providerOptions
      ?? (hostRecord
        ? resolveHostSessionProviderOptions(hostRecord)
        : this.resolveCurrentProjectProviderOptions());
    const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
    const restoredTitle = resolveRestoredSessionTitle(sessionContent, runtimeTurnResponses);

    this.setActiveSessionId(sessionId);
    this.acquireSessionModel({
      sessionResource: sessionId,
      title: restoredTitle,
      projectPath: this.resolveSessionContentProjectPath(sessionContent?.hostRecord),
      sessionType: sessionContent?.sessionType,
      inputState: { providerOptions },
    });
    this.ctx.attachSessionViewModel?.(sessionId);
    applyCurrentSessionTitle(this.ctx.chatService, restoredTitle);
    this.applySessionType(sessionContent?.sessionType);
    this.applyAgentRuntimeMode(providerOptions, sessionContent?.metadata);
    this.applySessionProviderOptions(providerOptions);
    this.persistSessionEntryTarget(this.buildSessionEntryTarget(sessionId, sessionContent));

    this.ctx.interaction.resetApprovalState();
    this.ctx.lexStream.resetSessionState();
    this.ctx.markVisibleSessionProjectionOwner?.(sessionId);

    this.ctx.lexStream.turns.clear();
    this.ctx.toolCallingIteration = 0;
    this.ctx.contextBudgetService.reset();
    this.ctx.sessionAllowedPaths = [];
    this.ctx.repetitionDetectionService.resetAll();
    this.ctx.legacyActivatedDeferredTools.clear();
    SkillRegistry.clearSessionState(`startSessionWithId:${sessionId}`);

    if (activationRequestId !== undefined) {
      this.throwIfSessionActivationSuperseded(activationRequestId);
    }

    this.ctx.isCompleted = false;

    this.ctx.isSessionStarting = false;
  }

  private async restoreManagedSessionTarget(target: PersistedChatSessionEntryTarget): Promise<boolean> {
    if (!target.sessionId) {
      return false;
    }
    const restoreRequest = this.hostSessionItemController.resolveSessionEntryRestoreRequest(target, {
      fallbackProjectPath: target.projectPath ?? this.resolveCurrentProjectPath(),
    });

    return this.activateSessionFromRestoreRequest(restoreRequest, {
      ensureManagedItem: true,
      preferDetachedRuntimeAttach: true,
    });
  }

  private buildFreshSessionEntryTarget(
    sessionId: string,
    selectedModeInput?: ChatSelectedMode,
  ): PersistedChatSessionEntryTarget {
    const providerOptions = this.resolveCurrentSessionProviderOptions();
    const selectedMode = normalizeChatSelectedMode(
      selectedModeInput ?? this.ctx.chatService.selectedMode ?? { modeId: this.ctx.currentMode },
    );
    const requiredResource = createRequiredSessionResourceModel({
      sessionResource: sessionId,
      projectPath: providerOptions.folderPath,
      projectRootPath: AilyHost.get().project.projectRootPath,
      selectedMode,
      runtimeMode: this.ctx.chatService.currentAgentRuntimeMode,
      runtimeModeSource: this.ctx.chatService.currentAgentRuntimeModeSource,
      providerOptions,
    });

    return {
      sessionId,
      projectPath: requiredResource.projectPath,
      providerOptions: requiredResource.providerOptions,
      inputState: buildHostSessionCurrentPickerInputState(requiredResource.selectedMode, requiredResource.providerOptions),
      mode: requiredResource.selectedMode.modeId,
      agentRuntimeMode: requiredResource.runtimeMode,
      agentRuntimeModeSource: requiredResource.runtimeModeSource,
      requestRouting: buildHostSessionCurrentPickerRoutingSummary(
        requiredResource.selectedMode,
        undefined,
        requiredResource.providerOptions.permissionLevel,
        requiredResource.providerOptions.approvalsReviewer,
        requiredResource.providerOptions.approvalPolicy,
      ),
    };
  }

  private resolveCurrentSelectedModeForFreshSession(): ChatSelectedMode {
    return normalizeChatSelectedMode(this.ctx.chatService.selectedMode ?? {
      modeId: this.ctx.currentMode,
      customAgentTarget: this.ctx.chatService.currentCustomAgentTarget,
    });
  }

  private buildCurrentSessionEntryTarget(sessionId: string): PersistedChatSessionEntryTarget | null {
    const sessionContent = this._hostSessionContentProvider.provideChatSessionContent(
      sessionId,
      this.resolveCurrentSessionProjectPath(),
      {
        metadataFallback: this.ctx.chatHistoryService.findEntry(sessionId) ?? null,
        fallbackProviderOptions: this.resolveCurrentSessionProviderOptions(),
      },
    );

    return this.buildSessionEntryTarget(sessionId, sessionContent);
  }

  private buildSessionEntryTarget(
    sessionId: string,
    sessionContent?: HostSessionContent | null,
  ): PersistedChatSessionEntryTarget | null {
    if (!sessionId) {
      return null;
    }

    const providerOptions = sessionContent?.providerOptions ?? this.resolveCurrentSessionProviderOptions();
    const metadata = sessionContent?.metadata;

    return {
      sessionId,
      projectPath: sessionContent?.projectPathHint ?? providerOptions.folderPath ?? null,
      providerOptions,
      inputState: sessionContent?.inputState,
      mode: typeof metadata?.mode === 'string' ? normalizeChatSurfaceModeId(metadata.mode) : undefined,
      agentRuntimeMode: this.ctx.chatService.currentAgentRuntimeMode,
      agentRuntimeModeSource: this.ctx.chatService.currentAgentRuntimeModeSource,
      requestRouting: metadata?.requestRouting
        ? normalizeHostSessionRequestRoutingSummary(metadata.requestRouting, metadata?.mode ?? this.ctx.currentMode)
        : undefined,
    };
  }

  private persistSessionEntryTarget(target: PersistedChatSessionEntryTarget | null): void {
    if (!target) {
      return;
    }

    const projectPathHint = target.projectPath ?? target.providerOptions?.folderPath ?? this.resolveCurrentProjectPath();
    this.ctx.chatSessionEntryStateService?.setSessionEntryTarget(target, projectPathHint);
  }

  private clearPersistedSessionEntryTarget(sessionId: string): void {
    if (!sessionId) {
      return;
    }

    const projectPathHint = this.resolveCurrentProjectPath();
    this.ctx.chatSessionEntryStateService?.clearSessionEntryTarget(sessionId, projectPathHint);
  }

  private resolveCurrentProjectProviderOptions(): HostSessionProviderOptions {
    const persistedEntryProviderOptions = this.ctx.chatSessionEntryStateService?.readEntryProviderOptions?.(
      this.resolveCurrentProjectPath(),
    );
    if (persistedEntryProviderOptions) {
      return normalizeHostSessionProviderOptions(persistedEntryProviderOptions, {
        folderPath: chatSessionScopeProjectPath(resolveChatSessionScopeFromProject(AilyHost.get().project)),
        permissionMode: this.ctx.chatService.currentSessionPermissionMode,
        ...(this.ctx.chatService.currentSessionPermissionLevel
          ? { permissionLevel: this.ctx.chatService.currentSessionPermissionLevel }
          : {}),
        ...(this.ctx.chatService.currentSessionApprovalsReviewer
          ? { approvalsReviewer: this.ctx.chatService.currentSessionApprovalsReviewer }
          : {}),
        ...(this.ctx.chatService.currentSessionApprovalPolicy
          ? { approvalPolicy: this.ctx.chatService.currentSessionApprovalPolicy }
          : {}),
      });
    }

    const scope = resolveChatSessionScopeFromProject(AilyHost.get().project);
    return {
      folderPath: chatSessionScopeProjectPath(scope),
      permissionMode: this.ctx.chatService.currentSessionPermissionMode,
      permissionProfile: this.ctx.chatService.currentSessionPermissionProfile,
      ...(this.ctx.chatService.currentSessionPermissionLevel
        ? { permissionLevel: this.ctx.chatService.currentSessionPermissionLevel }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalsReviewer
        ? { approvalsReviewer: this.ctx.chatService.currentSessionApprovalsReviewer }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalPolicy
        ? { approvalPolicy: this.ctx.chatService.currentSessionApprovalPolicy }
        : {}),
    };
  }

  private applyPersistedEntryProviderOptions(projectPathHint?: string | null): void {
    const persistedEntryProviderOptions = this.ctx.chatSessionEntryStateService?.readEntryProviderOptions?.(projectPathHint);
    if (!persistedEntryProviderOptions) {
      return;
    }

    this.applySessionProviderOptions(persistedEntryProviderOptions);
  }

  private resolveCurrentSessionProviderOptions(): HostSessionProviderOptions {
    return {
      folderPath: this.ctx.chatService.currentSessionPath || null,
      permissionMode: this.ctx.chatService.currentSessionPermissionMode,
      permissionProfile: this.ctx.chatService.currentSessionPermissionProfile,
      ...(this.ctx.chatService.currentSessionPermissionLevel
        ? { permissionLevel: this.ctx.chatService.currentSessionPermissionLevel }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalsReviewer
        ? { approvalsReviewer: this.ctx.chatService.currentSessionApprovalsReviewer }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalPolicy
        ? { approvalPolicy: this.ctx.chatService.currentSessionApprovalPolicy }
        : {}),
    };
  }

  private applySessionProviderOptions(providerOptions: HostSessionProviderOptions): string {
    const normalizedProviderOptions = this.ctx.chatService.applySessionProviderOptions(providerOptions);
    return createHostSessionProviderOptionsKey(normalizedProviderOptions);
  }

  private applyAgentRuntimeMode(
    providerOptions: HostSessionProviderOptions,
    metadata?: HostSessionContentMetadataSource | null,
  ): ChatAgentRuntimeMode {
    const resolution = this.resolveAgentRuntimeMode(providerOptions, metadata);
    if (typeof this.ctx.chatService.setCurrentAgentRuntimeMode === 'function') {
      this.ctx.chatService.setCurrentAgentRuntimeMode(resolution.mode, resolution.source);
    } else {
      this.ctx.chatService.currentAgentRuntimeMode = resolution.mode;
      this.ctx.chatService.currentAgentRuntimeModeSource = resolution.source;
    }
    console.info('[SessionLifecycle] agent runtime mode resolved', {
      mode: resolution.mode,
      source: resolution.source,
      reason: resolution.reason,
      projectPath: resolution.projectPath,
    });
    return resolution.mode;
  }

  private resolveAgentRuntimeMode(
    providerOptions: HostSessionProviderOptions,
    metadata?: HostSessionContentMetadataSource | null,
  ): ReturnType<typeof resolveChatAgentRuntimeModeForProject> {
    return resolveChatAgentRuntimeModeForProject({
      projectPath: providerOptions.folderPath ?? this.resolveCurrentProjectPath(),
      metadata,
      userPreferenceMode: this.ctx.getDevelopmentModePreferenceRuntimeMode?.(),
      fallback: providerOptions.folderPath ? 'coder' : 'unbound',
      requireExistingProjectPath: Boolean(metadata && providerOptions.folderPath),
    });
  }

  private applySessionType(sessionType: unknown): void {
    const normalizedSessionType = normalizeChatSessionType(sessionType, DEFAULT_CHAT_SESSION_TYPE);
    if (typeof this.ctx.chatService.setCurrentSessionType === 'function') {
      this.ctx.chatService.setCurrentSessionType(normalizedSessionType);
    } else {
      this.ctx.chatService.currentSessionType = normalizedSessionType;
    }
  }

  resetChat(): Promise<void> { return this.newChat(); }
}

function resolveRestoredSessionTitle(
  sessionContent?: HostSessionContent | null,
  runtimeTurnResponses?: readonly unknown[] | null,
): { text: string; source: ChatSessionTitleSource } {
  const persistedTitle = typeof sessionContent?.title === 'string'
    ? sessionContent.title.trim()
    : '';
  if (isMeaningfulRestoredSessionTitle(persistedTitle)) {
    return {
      text: persistedTitle,
      source: 'restored-custom',
    };
  }

  const fallbackDefaultTitle = deriveDefaultTitleFromTurnResponses(
    sessionContent?.hostRecord?.turnResponses,
    runtimeTurnResponses,
  );
  return isMeaningfulRestoredSessionTitle(fallbackDefaultTitle)
    ? {
      text: fallbackDefaultTitle,
      source: 'default-first-request',
    }
    : {
      text: '',
      source: 'empty',
    };
}

function deriveDefaultTitleFromTurnResponses(
  turnResponses: readonly unknown[] | null | undefined,
  runtimeTurnResponses?: readonly unknown[] | null,
): string {
  const candidates = Array.isArray(turnResponses) && turnResponses.length > 0
    ? turnResponses
    : (Array.isArray(runtimeTurnResponses) ? runtimeTurnResponses : []);
  if (candidates.length === 0) {
    return '';
  }

  for (const turnResponse of candidates) {
    const request = (turnResponse as { request?: unknown })?.request;
    const title = deriveDefaultTitleFromRequest(request);
    if (title) {
      return title;
    }
  }

  return '';
}

function summarizeTurnResponseIds(turnResponses: readonly TurnResponseTurn[] | null | undefined): readonly string[] {
  return (Array.isArray(turnResponses) ? turnResponses : [])
    .map(turn => typeof turn?.turnId === 'string' ? turn.turnId.trim() : '')
    .filter(Boolean);
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

function isMeaningfulRestoredSessionTitle(title: unknown): boolean {
  if (typeof title !== 'string') {
    return false;
  }

  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return false;
  }

  const normalizedLower = normalizedTitle.toLowerCase();
  if (/^lex-\d{6,}$/i.test(normalizedTitle)) {
    return false;
  }
  if (/^untitled(?:\s+chat)?(?:\s*\d+)?$/i.test(normalizedTitle)) {
    return false;
  }

  return normalizedLower !== 'new session'
    && normalizedLower !== 'new chat'
    && normalizedLower !== 'current session'
    && normalizedLower !== 'chat'
    && normalizedTitle !== '新会话'
    && normalizedTitle !== '新对话'
    && normalizedTitle !== '无标题会话';
}
