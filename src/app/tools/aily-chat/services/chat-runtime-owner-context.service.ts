import { Injectable, inject, type OnDestroy } from '@angular/core';

import type { LexOwnerContext } from '../helpers/lex-stream.helper';
import { ChatPartStore } from '../core/chat-part-store';
import type { ChatMessage } from '../core/chat-types';
import { AilyChatConfigService } from './aily-chat-config.service';
import { McpService } from './mcp.service';
import { RepetitionDetectionService } from './repetition-detection.service';
import {
  ChatRuntimeOwnerContextCore,
  createChatRuntimeOwnerContext,
  normalizeRuntimeOwnerSessionId,
  resolveRuntimeOwnerDefaultSessionId,
  type ChatRuntimeOwnerContextAdapter,
} from './chat-runtime-owner-context-core';
import {
  CHAT_RUNTIME_OWNER_CONTEXT_BUDGET,
  type ChatRuntimeOwnerContextBudgetPort,
  CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  type ChatRuntimeOwnerInteractionHostPort,
  CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER,
  type ChatRuntimeOwnerContextMaterializerPort,
  type ChatRuntimeOwnerRuntimeControllerPort,
  CHAT_RUNTIME_OWNER_SCHEDULER,
  type ChatRuntimeOwnerSchedulerPort,
  CHAT_RUNTIME_OWNER_SAVE_TARGET,
  type ChatRuntimeOwnerSaveTargetPort,
  CHAT_RUNTIME_OWNER_SESSION_CONTEXT,
  type ChatRuntimeOwnerSessionContextPort,
  CHAT_RUNTIME_OWNER_SESSION_MODEL,
  type ChatRuntimeOwnerSessionModelPort,
  CHAT_RUNTIME_OWNER_STATE,
  type ChatRuntimeOwnerStatePort,
  CHAT_RUNTIME_OWNER_TOOL_APPROVAL,
  type ChatRuntimeOwnerToolApprovalPort,
  CHAT_RUNTIME_OWNER_TURN_STARTUP_EDIT_LIFECYCLE,
  type ChatRuntimeOwnerTurnStartupEditLifecyclePort,
} from './chat-runtime-owner-ports';
import {
  buildRuntimeOwnerHostProjectionState,
  projectExecutionRuntimeStateToRuntimeController,
  syncHandleStateToRuntimeController,
  syncTurnResponsesToRuntimeController,
} from '../helpers/chat-runtime-owner-projection';

export type { ChatRuntimeOwnerContextAdapter } from './chat-runtime-owner-context-core';

@Injectable()
export class ChatRuntimeOwnerContextService implements ChatRuntimeOwnerContextMaterializerPort, OnDestroy {
  private readonly ailyChatConfigService = inject(AilyChatConfigService);
  private readonly mcpService = inject(McpService);
  private readonly runtimeInteractionHost = inject<ChatRuntimeOwnerInteractionHostPort>(
    CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  );
  private readonly ownerScheduler = inject<ChatRuntimeOwnerSchedulerPort>(CHAT_RUNTIME_OWNER_SCHEDULER);
  private readonly contextBudgetService = inject<ChatRuntimeOwnerContextBudgetPort>(
    CHAT_RUNTIME_OWNER_CONTEXT_BUDGET,
  );
  private readonly repetitionDetectionService = inject(RepetitionDetectionService);
  private readonly runtimeController = inject<ChatRuntimeOwnerRuntimeControllerPort>(CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER);
  private readonly ownerState = inject<ChatRuntimeOwnerStatePort>(CHAT_RUNTIME_OWNER_STATE);
  private readonly ownerSessionModel = inject<ChatRuntimeOwnerSessionModelPort>(CHAT_RUNTIME_OWNER_SESSION_MODEL);
  private readonly ownerSaveTarget = inject<ChatRuntimeOwnerSaveTargetPort>(CHAT_RUNTIME_OWNER_SAVE_TARGET);
  private readonly ownerSessionContext = inject<ChatRuntimeOwnerSessionContextPort>(CHAT_RUNTIME_OWNER_SESSION_CONTEXT);
  private readonly ownerToolApproval = inject<ChatRuntimeOwnerToolApprovalPort>(CHAT_RUNTIME_OWNER_TOOL_APPROVAL);
  private readonly turnStartupEditLifecycle = inject<ChatRuntimeOwnerTurnStartupEditLifecyclePort>(
    CHAT_RUNTIME_OWNER_TURN_STARTUP_EDIT_LIFECYCLE,
  );
  private readonly viewRequests = createUnboundViewRequestDispatcher();
  private readonly contextCore = new ChatRuntimeOwnerContextCore();
  private readonly headlessPartStore = new ChatPartStore();
  private headlessList: ChatMessage[] = [];
  private readonly headlessViewAdapter = {
    appendStreaming: () => {},
    appendImmediate: () => {},
    displayToolCallState: () => {},
    markLastMessageDone: () => {},
    checkAndTruncateAilyButtonBlock: () => false,
    getClosingTagsForOpenBlocks: () => '',
    reset: () => {
      this.headlessList = [];
    },
    requestChangeDetection: () => {},
  };
  private readonly headlessScrollManager = {
    scrollLock: false,
    setScrollLock: (value: boolean) => {
      this.headlessScrollManager.scrollLock = value;
    },
    startNewExchange: () => {},
    scrollToBottom: () => {},
    scrollToBottomIfNeeded: () => {},
    resumeFollowBottom: () => {},
    captureAutoScrollState: () => false,
  };

  ngOnDestroy(): void {
    this.headlessPartStore.destroy();
    this.headlessList = [];
  }

  bindAdapter(adapter: ChatRuntimeOwnerContextAdapter): LexOwnerContext {
    return this.contextCore.bindAdapter(adapter, boundAdapter => this.createContext(boundAdapter));
  }

  private createContext(adapter: ChatRuntimeOwnerContextAdapter): LexOwnerContext {
    const service = this;

    return createChatRuntimeOwnerContext(
      adapter,
      {
        get prjPath() { return service.ownerSessionContext.prjPath; },
        get prjRootPath() { return service.ownerSessionContext.prjRootPath; },
        get currentModel() { return service.ownerSessionContext.currentModel; },
        get currentAgentRuntimeMode() { return service.ownerSessionContext.currentAgentRuntimeMode; },
        get currentAgentRuntimeModeSource() { return service.ownerSessionContext.currentAgentRuntimeModeSource; },
        selectAgentRuntimeMode: (mode, source, reason, sessionId) =>
          service.ownerSessionContext.selectAgentRuntimeMode(mode, source, reason, sessionId),
        updateRuntimeProjectPath: (projectPath, sessionId) =>
          service.ownerSessionContext.updateRuntimeProjectPath(projectPath, sessionId),
        get sessionTitle() { return service.ownerSessionContext.sessionTitle; },
        currentSessionPath: sessionId => service.ownerSessionContext.currentSessionPath(sessionId),
        currentSessionPermissionMode: sessionId => service.ownerSessionContext.currentSessionPermissionMode(sessionId),
        currentSessionPermissionProfile: sessionId => service.ownerSessionContext.currentSessionPermissionProfile(sessionId),
        currentSessionApprovalsReviewer: sessionId => service.ownerSessionContext.currentSessionApprovalsReviewer(sessionId),
        currentSessionApprovalPolicy: sessionId => service.ownerSessionContext.currentSessionApprovalPolicy(sessionId),
        get ailyChatConfigService() { return service.ailyChatConfigService; },
        get mcpService() { return service.mcpService; },
        buildExecutionSaveTarget: sessionId => service.ownerSaveTarget.buildExecutionSaveTarget(sessionId),
        resolveActiveRuntimeSessionId: defaultSessionId => service.ownerState.resolveActiveRuntimeSessionId(defaultSessionId),
        runWithRuntimeSessionOwner: (sessionId, action) => service.ownerState.runWithRuntimeSessionOwner(sessionId, action),
        get runtimeInteractionHost() { return service.runtimeInteractionHost; },
        handleToolApproval: request => service.ownerToolApproval.handleToolApproval({
          lexStream: adapter.lexStream,
          sessionId: adapter.sessionId,
          defaultSessionId: service.resolveDefaultRuntimeSessionId(adapter),
          request: request as never,
        }),
        checkToolApprovalPreflight: request => service.ownerToolApproval.checkToolApprovalPreflight({
          lexStream: adapter.lexStream,
          sessionId: adapter.sessionId,
          defaultSessionId: service.resolveDefaultRuntimeSessionId(adapter),
          request: request as never,
        }),
        get ownerScheduler() { return service.ownerScheduler; },
        get viewRequests() { return service.viewRequests; },
        get list() { return service.headlessList; },
        setList: value => { service.headlessList = Array.isArray(value) ? value as never : []; },
        get partStore() { return service.headlessPartStore; },
        get viewAdapter() { return service.headlessViewAdapter; },
        get scrollManager() { return service.headlessScrollManager; },
        invalidateHostRequestGraph: () => {},
        triggerSyncDetectChanges: () => {},
        get currentMessageSource() { return service.ownerState.currentMessageSource; },
        setCurrentMessageSource: value => { service.ownerState.currentMessageSource = value as never; },
        get toolCallingIteration() { return service.ownerState.toolCallingIteration; },
        setToolCallingIteration: value => { service.ownerState.toolCallingIteration = value as never; },
        get contextBudgetService() { return service.contextBudgetService; },
        get isWaiting() { return service.ownerState.isWaiting; },
        setIsWaiting: value => { service.ownerState.isWaiting = value as never; },
        get isCompleted() { return service.ownerState.isCompleted; },
        setIsCompleted: value => { service.ownerState.isCompleted = value as never; },
        readSessionRuntimeState: sessionId => service.readRuntimeState(sessionId),
        readSessionTurnResponses: sessionId => service.ownerSessionModel.readTurnResponses(sessionId),
        appendSessionModelTurnResponse: (sessionId, turnResponse, ownerPolicy) =>
          service.ownerSessionModel.appendOrReplaceTurnResponse(sessionId, turnResponse as never, ownerPolicy as never),
        syncRuntimeHostSubmitReadiness: sessionId => service.syncRuntimeHostSubmitReadiness(sessionId),
        syncRuntimeAgentEntryReady: (sessionId, disposeSession) =>
          service.syncRuntimeAgentEntryReady(sessionId, disposeSession),
        releaseRuntimeHandle: sessionId => service.releaseRuntimeHandle(sessionId),
        setRuntimeAbortController: (sessionId, controller) =>
          service.setRuntimeAbortController(sessionId, controller),
        scheduleLexRequestCompleted: input => service.runtimeController.scheduleLexRequestCompleted(input as never),
        isRuntimeViewAttached: () => false,
        readRuntimeViewAttachmentGeneration: () => null,
        isRuntimeViewAttachmentCurrent: () => false,
        syncExecutionRuntimeState: saveTarget =>
          projectExecutionRuntimeStateToRuntimeController(service.runtimeController, { saveTarget: saveTarget as never }),
        syncExecutionRuntimeTurnResponses: (sessionId, turnResponses, options) => {
          const handleMetadata = service.readHandleProjectionMetadata(sessionId);
          syncTurnResponsesToRuntimeController(service.runtimeController, {
            sessionId,
            turnResponses: turnResponses as never,
            hostProjectionState: buildRuntimeOwnerHostProjectionState(turnResponses as never),
            capabilities: handleMetadata.capabilities,
            concurrencyScope: handleMetadata.concurrencyScope,
            projection: options as never,
          });
        },
        get repetitionDetectionService() { return service.repetitionDetectionService; },
        get turnStartupEditLifecycle() { return service.turnStartupEditLifecycle; },
        get isCancelled() { return service.ownerState.isCancelled; },
        setIsCancelled: value => { service.ownerState.isCancelled = value as never; },
        get activeToolExecutions() { return service.ownerState.activeToolExecutions; },
        setActiveToolExecutions: value => { service.ownerState.activeToolExecutions = value as never; },
        get currentStatelessMode() { return service.ownerState.currentStatelessMode; },
        setCurrentStatelessMode: value => { service.ownerState.currentStatelessMode = value as never; },
      },
      () => service.resolveDefaultRuntimeSessionId(adapter),
    );
  }

  private resolveDefaultRuntimeSessionId(adapter: ChatRuntimeOwnerContextAdapter): string {
    return resolveRuntimeOwnerDefaultSessionId(adapter);
  }

  private normalizeSessionId(sessionId: unknown): string {
    return normalizeRuntimeOwnerSessionId(sessionId);
  }

  private readRuntimeState(sessionId: unknown) {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId ? this.runtimeController.readRuntimeState(targetSessionId) ?? undefined : undefined;
  }

  private readHandleProjectionMetadata(sessionId: unknown) {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId
      ? this.runtimeController.readHandleProjectionMetadata(targetSessionId)
      : { capabilities: undefined, concurrencyScope: null };
  }

  private syncRuntimeHostSubmitReadiness(sessionId: unknown): void {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return;
    }

    syncHandleStateToRuntimeController(this.runtimeController, {
      sessionId: targetSessionId,
      patch: {
        capabilities: this.ownerSessionContext.resolveRuntimeCapabilities(targetSessionId),
        concurrencyScope: this.ownerSessionContext.resolveRuntimeConcurrencyScope(targetSessionId) ?? null,
      },
    });
  }

  private syncRuntimeAgentEntryReady(sessionId: unknown, disposeSession: () => void): void {
    const targetSessionId = this.normalizeSessionId(sessionId);
    if (!targetSessionId) {
      return;
    }

    this.runtimeController.syncAgentEntryReady({
      sessionId: targetSessionId,
      disposeSession,
    });
  }

  private releaseRuntimeHandle(sessionId: unknown): boolean {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId ? this.runtimeController.releaseRuntimeHandle(targetSessionId) : false;
  }

  private setRuntimeAbortController(sessionId: unknown, controller: AbortController | null): boolean {
    const targetSessionId = this.normalizeSessionId(sessionId);
    return targetSessionId
      ? this.runtimeController.setRuntimeAbortController(targetSessionId, controller)
      : false;
  }

}

function createUnboundViewRequestDispatcher() {
  const failClosed = (): never => {
    throw new Error('[AilyChat][RuntimeOwnerContext] View requests must be emitted through the runtime-owner host event boundary.');
  };
  return {
    notify: failClosed,
    syncTodoState: failClosed,
    requestHandoff: failClosed,
  };
}
