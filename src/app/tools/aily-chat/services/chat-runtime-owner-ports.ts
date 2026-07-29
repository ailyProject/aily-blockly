import { InjectionToken } from '@angular/core';
import type { TurnResponseTurn } from 'aily-lex/browser';

import type {
  ChatAgentRuntimeMode,
  ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import type {
  ChatSelectedMode,
} from '../core/chat-mode';
import type { ChatRuntimeOwnerScheduler } from '../core/chat-runtime-owner-scheduler';
import type { PersistedChatSessionTitleSource } from '../core/chat-session-title';
import type { AskUserFullResponse, AskUserPresentationContext, AskUserQuestion } from '../core/ask-user';
import type {
  ChatRuntimeHostInteractionRequest,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHost,
  ChatRuntimeOwnerExecutor,
  ChatRuntimeHostSessionId,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostSubmitReadiness,
  ChatRuntimeHostSubmitRequest,
  ChatRuntimeHostTranscriptSnapshot,
  ChatRuntimeHostViewId,
} from '../core/chat-runtime-host-contract';
import type { HostSessionSaveTarget } from '../helpers/host-session-save-bridge';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { ToolApprovalAction, ToolApprovalRequest, ToolApprovalScope } from '../helpers/tool-approval-ui';
import type {
  RuntimeCommandSessionActionRequest,
  RuntimeCommandSessionActionResult,
  RuntimeConfirmationDecision,
  RuntimePlanReviewAction,
  RuntimePlanReviewDecision,
  RuntimePlanReviewWidgetState,
} from './chat-runtime-interaction-host.service';
import type {
  HostTurnResponseState,
  HostRequestModel,
  HostResponseProjection,
} from '../helpers/host-turn-response-state';
import type { LexOwnerContext, LexOwnerFacade } from '../helpers/lex-stream.helper';
import type { UserInteractionToolApprovalPolicy } from '../helpers/user-interaction.helper';
import type { ChatSessionLexRequestCompletedInput } from './chat-session-runtime-completion-queue-core';
import type { ChatListItem, LiveHostSessionRecord } from './chat-history.service';
import type { ChatSessionRuntimeHandlePatch } from './chat-session-runtime-registry-core';
import type { ChatSessionRuntimeProjectionPatch } from './chat-session-runtime-projection-core';
import type {
  ChatSessionRuntimeCapabilities,
  ChatSessionRuntimeChangeOptions,
  ChatSessionRuntimeState,
} from './chat-session-runtime-store.service';
import type { ChatRuntimeOwnerContextAdapter } from './chat-runtime-owner-context.service';
import type {
  ChatRuntimeOwnerContextBudgetPort,
} from './chat-runtime-owner-context-capabilities';
import type { ChatSessionTurnOwnerPolicyOptions } from './chat-session-model-store.service';

export type {
  ChatRuntimeOwnerContextBudgetPort,
} from './chat-runtime-owner-context-capabilities';

export interface ChatRuntimeOwnerContextMaterializerPort {
  bindAdapter(adapter: ChatRuntimeOwnerContextAdapter): LexOwnerContext;
}

export interface ChatRuntimeOwnerContextBinderPort {
  bindContext(context: LexOwnerContext): LexOwnerFacade;
}

export interface ChatRuntimeOwnerHostAdapterPort {
  ensureBound(): LexOwnerFacade;
}

export type ChatRuntimeOwnerHostPort = ChatRuntimeOwnerExecutor;

export interface ChatRuntimeOwnerEndpointPort {
  startElectronHostRuntimeOwner(runtimeOwnerId?: string): Promise<void>;
}

export interface ChatRuntimeOwnerInteractionHostPort {
  onSnapshot(listener: (snapshot: ChatRuntimeHostInteractionSnapshot) => void): { dispose(): void };
  readSnapshot(sessionId: string): ChatRuntimeHostInteractionSnapshot;
  applyHostSnapshot(
    snapshot: ChatRuntimeHostInteractionSnapshot,
    remoteResolver: (
      request: Omit<ChatRuntimeHostInteractionRequest, 'viewId' | 'visibleAttachmentGeneration'>,
    ) => Promise<ChatRuntimeHostInteractionSnapshot | null>,
  ): void;
  presentQuestion(
    sessionId: string,
    partId: string,
    questions: AskUserQuestion[],
    context?: AskUserPresentationContext,
  ): Promise<AskUserFullResponse | undefined>;
  completeQuestion(sessionId: string, result: AskUserFullResponse | undefined): void;
  resolveQuestionCompat(sessionId: string, answer: string, wasFreeform: boolean): void;
  skipQuestion(sessionId: string): void;
  clearQuestion(sessionId: string): void;
  presentToolApproval(sessionId: string, request: ToolApprovalRequest): Promise<RuntimeConfirmationDecision>;
  presentConfirmation(
    sessionId: string,
    confirmation: {
      askId: string;
      partId: string;
      toolName?: string;
      title: string;
      subtitle?: string;
      message: string;
      args?: Record<string, unknown>;
      actions: readonly ToolApprovalAction[];
      primaryScope: ToolApprovalScope;
      primaryLabel?: string;
      primaryTooltip?: string;
      rejectLabel?: string;
      rejectTooltip?: string;
      onAction?: (actionId: string) => void;
    },
  ): Promise<RuntimeConfirmationDecision>;
  navigateConfirmation(sessionId: string, delta: number): void;
  resolveConfirmation(sessionId: string, id: string, result: RuntimeConfirmationDecision): void;
  triggerConfirmationAction(sessionId: string, id: string, actionId: string): void;
  resolveToolApproval(sessionId: string, toolCallId: string, result: RuntimeConfirmationDecision): void;
  clearConfirmations(sessionId: string): void;
  presentPlanReview(
    sessionId: string,
    review: {
      id: string;
      title: string;
      planUri?: string;
      content: string;
      actions: readonly RuntimePlanReviewAction[];
      canProvideFeedback: boolean;
    },
  ): Promise<RuntimePlanReviewDecision>;
  getActivePlanReview(sessionId: string): RuntimePlanReviewWidgetState | null;
  resolvePlanReview(sessionId: string, id: string, result: RuntimePlanReviewDecision): void;
  requestCommandSessionAction(
    sessionId: string,
    request: RuntimeCommandSessionActionRequest,
  ): Promise<RuntimeCommandSessionActionResult>;
}

export interface ChatRuntimeOwnerToolApprovalInput {
  readonly lexStream: LexOwnerFacade | null | undefined;
  readonly sessionId: string | null | undefined;
  readonly defaultSessionId: string;
  readonly request: ToolApprovalRequest;
}

export interface ChatRuntimeOwnerToolApprovalPort {
  handleToolApproval(input: ChatRuntimeOwnerToolApprovalInput): Promise<{ approved: true } | { approved: false; reason?: string }>;
  checkToolApprovalPreflight(input: ChatRuntimeOwnerToolApprovalInput): Promise<{ approved: true } | { approved: false; reason?: string }>;
}

export type ChatRuntimeOwnerToolApprovalPolicyPort = UserInteractionToolApprovalPolicy;

export interface ChatRuntimeOwnerSubmittedTurnLifecyclePort {
  bindOwner(owner: LexOwnerFacade): void;
  prepareSubmittedTurn(request: ChatRuntimeHostSubmitRequest, owner: LexOwnerFacade): Promise<void>;
  completeSubmittedTurn(sessionId?: string | null): Promise<void>;
}

export interface ChatRuntimeOwnerGeneratedTitleInput {
  readonly sessionId: string;
  readonly title: string;
  readonly source: PersistedChatSessionTitleSource;
}

export interface ChatRuntimeOwnerSubmittedTurnTitlePort {
  applyGeneratedTitle(input: ChatRuntimeOwnerGeneratedTitleInput): boolean;
}

export interface ChatRuntimeOwnerSaveCurrentSessionInput {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly lexStream: LexOwnerFacade;
  readonly hostProjection?: HostResponseProjection | null;
  readonly visibleChatList?: readonly ChatListItem[];
  readonly hostRequestModel?: HostRequestModel | null;
  readonly target?: HostSessionSaveTarget | null;
}

export interface ChatRuntimeOwnerSessionSaveBridgeOptions {
  readonly hostProjection?: HostResponseProjection | null;
  readonly visibleChatList?: readonly ChatListItem[];
  readonly hostRequestModel?: HostRequestModel | null;
  readonly target: HostSessionSaveTarget | null;
}

export interface ChatRuntimeOwnerSessionSaveBridgePort {
  buildLiveHostSessionRecord(options: ChatRuntimeOwnerSessionSaveBridgeOptions): LiveHostSessionRecord | null;
}

export interface ChatRuntimeOwnerSaveBridgePort {
  saveCurrentSession(input: ChatRuntimeOwnerSaveCurrentSessionInput): void;
}

export interface ChatRuntimeOwnerSaveTargetPort {
  buildExecutionSaveTarget(sessionId?: string | null): HostSessionSaveTarget | null;
}

export interface ChatRuntimeOwnerSessionContextPort {
  readonly prjPath: string;
  readonly prjRootPath: string;
  readonly currentModel: unknown;
  readonly currentAgentRuntimeMode: ChatAgentRuntimeMode;
  readonly currentAgentRuntimeModeSource: ChatAgentRuntimeModeSource;
  readonly sessionTitle: string;
  readonly currentSessionId: string;
  currentSessionPath(sessionId?: string | null): string | null;
  currentSessionPermissionMode(sessionId?: string | null): HostSessionProviderOptions['permissionMode'];
  currentSessionPermissionProfile(sessionId?: string | null): HostSessionProviderOptions['permissionProfile'];
  currentSessionApprovalsReviewer(sessionId?: string | null): HostSessionProviderOptions['approvalsReviewer'];
  currentSessionApprovalPolicy(sessionId?: string | null): HostSessionProviderOptions['approvalPolicy'];
  selectAgentRuntimeMode(
    mode: ChatAgentRuntimeMode | string | null | undefined,
    source?: ChatAgentRuntimeModeSource | string | null | undefined,
    reason?: string | null,
    sessionId?: string | null,
  ): void;
  updateRuntimeProjectPath(
    projectPath: string | null | undefined,
    sessionId?: string | null,
  ): void;
  resolveRuntimeSessionProviderOptions(sessionId?: string | null): HostSessionProviderOptions;
  resolveRuntimeSelectedMode(sessionId?: string | null): ChatSelectedMode;
  resolveRuntimeCapabilities(sessionId?: string | null): ChatSessionRuntimeCapabilities;
  resolveRuntimeConcurrencyScope(sessionId?: string | null): string | undefined;
}

export interface ChatRuntimeOwnerStatePort {
  currentMessageSource: string;
  toolCallingIteration: number;
  isWaiting: boolean;
  isCompleted: boolean;
  isCancelled: boolean;
  activeToolExecutions: number;
  currentStatelessMode: boolean;
  resetForCancellation(): void;
  resolveActiveRuntimeSessionId(defaultSessionId?: string | null): string;
  runWithRuntimeSessionOwner<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  beginRuntimeSessionOwnerScope(sessionId: string): () => void;
}

export interface ChatRuntimeOwnerSessionModelPort {
  readTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[];
  replaceTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null;
  appendOrReplaceTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null;
}

export type ChatRuntimeOwnerSchedulerPort = ChatRuntimeOwnerScheduler;

export interface ChatRuntimeOwnerTurnStartupEditLifecyclePort {
  ensureAbsExport(
    sessionId: string | null | undefined,
    runtimeMode: ChatAgentRuntimeMode | null | undefined,
  ): Promise<void>;
}

export interface ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort {
  ensureWorkspaceAbsExport(sessionId: string | null | undefined, projectPath: string | null | undefined): Promise<void>;
}

export interface ChatRuntimeOwnerRerunGateState {
  readonly activeRequestInProgress: boolean;
  readonly staleGateCleared: boolean;
}

export interface ChatRuntimeOwnerBeginRequestInput {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly activeResponseHandle: unknown;
  readonly attachedView: boolean;
  readonly stopSession: () => void;
  readonly disposeSession: () => void;
}

export interface ChatRuntimeOwnerAgentEntryReadyInput {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly disposeSession: () => void;
}

export interface ChatRuntimeOwnerSessionSnapshotInput {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly attachedViewIds: readonly ChatRuntimeHostViewId[];
  readonly transcriptRevision: number;
}

export interface ChatRuntimeOwnerHandleProjectionMetadata {
  readonly capabilities?: ChatSessionRuntimeCapabilities;
  readonly concurrencyScope: string | null;
}

export interface ChatRuntimeOwnerRuntimeControllerPort {
  attachSessionView(sessionId: ChatRuntimeHostSessionId): void;
  detachSessionView(sessionId: ChatRuntimeHostSessionId): void;
  readSubmitReadiness(sessionId: ChatRuntimeHostSessionId): ChatRuntimeHostSubmitReadiness;
  ensureSessionCanRerun(sessionId: ChatRuntimeHostSessionId): ChatRuntimeOwnerRerunGateState;
  syncAgentEntryReady(input: ChatRuntimeOwnerAgentEntryReadyInput): void;
  releaseRuntimeHandle(sessionId: ChatRuntimeHostSessionId): boolean;
  setRuntimeAbortController(
    sessionId: ChatRuntimeHostSessionId,
    controller: AbortController | null,
  ): boolean;
  scheduleLexRequestCompleted(input: ChatSessionLexRequestCompletedInput): void;
  beginSubmittedRequestState(input: ChatRuntimeOwnerBeginRequestInput): void;
  completeSubmittedRequestState(sessionId: ChatRuntimeHostSessionId, activeResponseHandle: unknown): void;
  stopSession(sessionId: ChatRuntimeHostSessionId): void;
  disposeSession(sessionId: ChatRuntimeHostSessionId): void;
  getSessionIds(): readonly ChatRuntimeHostSessionId[];
  readRuntimeState(sessionId: ChatRuntimeHostSessionId): ChatSessionRuntimeState | null;
  readHandleProjectionMetadata(sessionId: ChatRuntimeHostSessionId): ChatRuntimeOwnerHandleProjectionMetadata;
  projectRuntimeState(
    sessionId: ChatRuntimeHostSessionId,
    patch: ChatSessionRuntimeProjectionPatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  syncRuntimeHandleState(
    sessionId: ChatRuntimeHostSessionId,
    patch: ChatSessionRuntimeHandlePatch,
  ): void;
  syncRuntimeTurnResponses(
    sessionId: ChatRuntimeHostSessionId,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  syncRuntimeTurnResponse(
    sessionId: ChatRuntimeHostSessionId,
    turnResponse: TurnResponseTurn | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void;
  readSessionState(input: ChatRuntimeOwnerSessionSnapshotInput): ChatRuntimeHostSessionState | null;
  buildSessionState(
    input: ChatRuntimeOwnerSessionSnapshotInput,
    runtimeState?: ChatSessionRuntimeState | null,
  ): ChatRuntimeHostSessionState;
  readTranscript(input: ChatRuntimeOwnerSessionSnapshotInput): ChatRuntimeHostTranscriptSnapshot | null;
  buildTranscriptSnapshot(
    input: ChatRuntimeOwnerSessionSnapshotInput,
    runtimeState?: ChatSessionRuntimeState | null,
  ): ChatRuntimeHostTranscriptSnapshot;
  awaitRequestCompletion(sessionId: ChatRuntimeHostSessionId): Promise<void>;
  runWorkspaceFinalizeBoundaryProbe(sessionId: ChatRuntimeHostSessionId): Promise<void>;
}

export const CHAT_RUNTIME_OWNER_CONTEXT_MATERIALIZER = new InjectionToken<ChatRuntimeOwnerContextMaterializerPort>(
  'AILY_CHAT_RUNTIME_OWNER_CONTEXT_MATERIALIZER',
);

export const CHAT_RUNTIME_OWNER_CONTEXT_BINDER = new InjectionToken<ChatRuntimeOwnerContextBinderPort>(
  'AILY_CHAT_RUNTIME_OWNER_CONTEXT_BINDER',
);

export const CHAT_RUNTIME_OWNER_HOST_ADAPTER = new InjectionToken<ChatRuntimeOwnerHostAdapterPort>(
  'AILY_CHAT_RUNTIME_OWNER_HOST_ADAPTER',
);

export const CHAT_RUNTIME_OWNER_HOST = new InjectionToken<ChatRuntimeOwnerHostPort>(
  'AILY_CHAT_RUNTIME_OWNER_HOST',
);

export const CHAT_RUNTIME_OWNER_ENDPOINT = new InjectionToken<ChatRuntimeOwnerEndpointPort>(
  'AILY_CHAT_RUNTIME_OWNER_ENDPOINT',
);

export const CHAT_RUNTIME_OWNER_INTERACTION_HOST = new InjectionToken<ChatRuntimeOwnerInteractionHostPort>(
  'AILY_CHAT_RUNTIME_OWNER_INTERACTION_HOST',
);

export const CHAT_RUNTIME_OWNER_TOOL_APPROVAL = new InjectionToken<ChatRuntimeOwnerToolApprovalPort>(
  'AILY_CHAT_RUNTIME_OWNER_TOOL_APPROVAL',
);

export const CHAT_RUNTIME_OWNER_TOOL_APPROVAL_POLICY = new InjectionToken<ChatRuntimeOwnerToolApprovalPolicyPort>(
  'AILY_CHAT_RUNTIME_OWNER_TOOL_APPROVAL_POLICY',
);

export const CHAT_RUNTIME_OWNER_SUBMITTED_TURN_LIFECYCLE = new InjectionToken<ChatRuntimeOwnerSubmittedTurnLifecyclePort>(
  'AILY_CHAT_RUNTIME_OWNER_SUBMITTED_TURN_LIFECYCLE',
);

export const CHAT_RUNTIME_OWNER_SUBMITTED_TURN_TITLE = new InjectionToken<ChatRuntimeOwnerSubmittedTurnTitlePort>(
  'AILY_CHAT_RUNTIME_OWNER_SUBMITTED_TURN_TITLE',
);

export const CHAT_RUNTIME_OWNER_SAVE_BRIDGE = new InjectionToken<ChatRuntimeOwnerSaveBridgePort>(
  'AILY_CHAT_RUNTIME_OWNER_SAVE_BRIDGE',
);

export const CHAT_RUNTIME_OWNER_SAVE_TARGET = new InjectionToken<ChatRuntimeOwnerSaveTargetPort>(
  'AILY_CHAT_RUNTIME_OWNER_SAVE_TARGET',
);

export const CHAT_RUNTIME_OWNER_SESSION_CONTEXT = new InjectionToken<ChatRuntimeOwnerSessionContextPort>(
  'AILY_CHAT_RUNTIME_OWNER_SESSION_CONTEXT',
);

export const CHAT_RUNTIME_OWNER_STATE = new InjectionToken<ChatRuntimeOwnerStatePort>(
  'AILY_CHAT_RUNTIME_OWNER_STATE',
);

export const CHAT_RUNTIME_OWNER_SESSION_MODEL = new InjectionToken<ChatRuntimeOwnerSessionModelPort>(
  'AILY_CHAT_RUNTIME_OWNER_SESSION_MODEL',
);

export const CHAT_RUNTIME_OWNER_SCHEDULER = new InjectionToken<ChatRuntimeOwnerSchedulerPort>(
  'AILY_CHAT_RUNTIME_OWNER_SCHEDULER',
);

export const CHAT_RUNTIME_OWNER_CONTEXT_BUDGET = new InjectionToken<ChatRuntimeOwnerContextBudgetPort>(
  'AILY_CHAT_RUNTIME_OWNER_CONTEXT_BUDGET',
);

export const CHAT_RUNTIME_OWNER_TURN_STARTUP_EDIT_LIFECYCLE = new InjectionToken<ChatRuntimeOwnerTurnStartupEditLifecyclePort>(
  'AILY_CHAT_RUNTIME_OWNER_TURN_STARTUP_EDIT_LIFECYCLE',
);

export const CHAT_RUNTIME_OWNER_WORKSPACE_EDIT_LIFECYCLE_RESOURCE = new InjectionToken<ChatRuntimeOwnerWorkspaceEditLifecycleResourcePort>(
  'AILY_CHAT_RUNTIME_OWNER_WORKSPACE_EDIT_LIFECYCLE_RESOURCE',
);

export const CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER = new InjectionToken<ChatRuntimeOwnerRuntimeControllerPort>(
  'AILY_CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER',
);



