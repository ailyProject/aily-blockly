import type { RenderEvent, SessionSnapshot, TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import type {
  ChatAgentRuntimeMode,
  ChatAgentRuntimeModeSource,
} from './chat-agent-runtime-mode';
import type { ChatModeId, ChatSelectedMode } from './chat-mode';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';

export type ChatRuntimeHostViewId = string;
export type ChatRuntimeHostSessionId = string;

export type ChatRuntimeHostEventKind =
  | 'session-state'
  | 'transcript'
  | 'turn-transcript'
  | 'part-transcript'
  | 'runtime-status'
  | 'interaction'
  | 'view-request'
  | 'resource-request'
  | 'error';

export type ChatRuntimeHostSessionStatus =
  | 'idle'
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'disposed';

export interface ChatRuntimeHostModelSelectionSnapshot {
  readonly model?: string;
  readonly name?: string;
  readonly family?: string;
  readonly presetId?: string;
  readonly contextWindowTokens?: number;
  readonly reasoningEffort?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly providerContextManagementSupport?: unknown;
}

export interface ChatRuntimeHostSubmitRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly requestText: string;
  readonly displayText?: string;
  readonly selectedMode?: ChatSelectedMode | null;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly activeResponseHandle?: unknown | null;
  readonly protocolTruncation?: ChatRuntimeHostProtocolTruncation | null;
}

export type ChatRuntimeHostProtocolTruncation =
  | {
      readonly kind: 'clear';
      readonly retainedTurnIds?: readonly string[];
      readonly discardedTurnIds?: readonly string[];
    }
  | {
      readonly kind: 'removeFrom';
      readonly turnId: string;
      readonly retainedTurnIds?: readonly string[];
      readonly discardedTurnIds?: readonly string[];
    };

export interface ChatRuntimeHostTranscriptSnapshot {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly revision: number;
}

export interface ChatRuntimeHostTurnPageRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly sessionScopeKey: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection?: 'ascending' | 'descending';
  readonly itemsView?: 'notLoaded' | 'summary' | 'full';
}

export type ChatRuntimeHostPagedTurn = TurnResponseTurn & {
  readonly itemsView: 'notLoaded' | 'summary' | 'full';
};

export interface ChatRuntimeHostTurnPage {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly data: readonly ChatRuntimeHostPagedTurn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
  readonly revision: number;
}

export interface ChatRuntimeHostRequestListMutationRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly expectedRevision: number;
  readonly operation: {
    readonly kind: 'removeFromTurn';
    readonly turnId: string;
  };
  readonly pageLimit?: number;
}

export interface ChatRuntimeHostRequestListMutationResult {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly revision: number;
  readonly operation: ChatRuntimeHostRequestListMutationRequest['operation'];
  readonly retainedTurnIds: readonly string[];
  readonly discardedTurnIds: readonly string[];
  readonly protocolTruncation: ChatRuntimeHostProtocolTruncation;
  readonly page: ChatRuntimeHostTurnPage;
}

export interface ChatRuntimeHostCheckpointMutationRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly expectedRevision: number;
  readonly checkpointId?: string;
  readonly pageLimit?: number;
}

export interface ChatRuntimeHostCheckpointNavigationRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly checkpointId?: string;
  readonly turnId?: string;
}

export interface ChatRuntimeHostCheckpointNavigationEntry {
  readonly checkpointId: string;
  readonly requestId: string;
  readonly turnId?: string;
  readonly turnIndex: number;
}

export interface ChatRuntimeHostCheckpointNavigationState {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly revision: number;
  readonly checkpointCount: number;
  readonly currentCheckpointIndex: number;
  readonly currentTurnResponseCount: number;
  readonly canRedo: boolean;
  readonly currentCheckpoint: ChatRuntimeHostCheckpointNavigationEntry | null;
  readonly nextCheckpoint: ChatRuntimeHostCheckpointNavigationEntry | null;
  readonly requestedCheckpoint: ChatRuntimeHostCheckpointNavigationEntry | null;
}

export interface ChatRuntimeHostCheckpointMutationResult {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly checkpointId: string;
  readonly direction: 'restore' | 'redo';
  readonly revision: number;
  readonly retainedTurnIds: readonly string[];
  readonly restoredTurnIds: readonly string[];
  readonly canRedo: boolean;
  readonly page: ChatRuntimeHostTurnPage;
}

export interface ChatRuntimeHostForkSessionRequest {
  readonly sourceSessionId: ChatRuntimeHostSessionId;
  readonly targetSessionId: ChatRuntimeHostSessionId;
  readonly beforeTurnId: string;
  readonly expectedRevision: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly selectedMode?: ChatSelectedMode | null;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly pageLimit?: number;
}

export interface ChatRuntimeHostForkSessionResult {
  readonly sourceSessionId: ChatRuntimeHostSessionId;
  readonly targetSessionId: ChatRuntimeHostSessionId;
  readonly sourceRevision: number;
  readonly targetRevision: number;
  readonly retainedTurnIds: readonly string[];
  readonly forkKind: 'protocol';
  readonly page: ChatRuntimeHostTurnPage;
}

export interface ChatRuntimeHostSessionState {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly status: ChatRuntimeHostSessionStatus;
  readonly requestInProgress: boolean;
  readonly attachedViewIds: readonly ChatRuntimeHostViewId[];
  readonly activeTurnId?: string | null;
  readonly transcriptRevision: number;
  readonly selectedMode?: ChatSelectedMode | null;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
}

export interface ChatRuntimeHostSessionInventoryMetadata {
  readonly title?: string;
  readonly titleSource?: string;
  readonly titleDurable?: boolean;
  readonly sessionType?: string;
  readonly projectPath?: string | null;
  readonly mode?: string;
}

export interface ChatRuntimeHostSessionInventoryItem extends ChatRuntimeHostSessionState, ChatRuntimeHostSessionInventoryMetadata {}

export interface ChatRuntimeHostSessionInventorySnapshot {
  readonly revision: number;
  readonly sessions: readonly ChatRuntimeHostSessionInventoryItem[];
}

export interface ChatRuntimeHostSubmitReadiness {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly canSubmit: boolean;
  readonly requestInProgress: boolean;
}

export interface ChatRuntimeHostRerunReadiness {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly activeRequestInProgress: boolean;
  readonly staleGateCleared: boolean;
  readonly state: ChatRuntimeHostSessionState | null;
}

export interface ChatRuntimeHostPrewarmRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
}

export interface ChatRuntimeHostPrewarmResult {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly ensured: boolean;
}

export interface ChatRuntimeHostRestoreRuntimeSessionRequest extends ChatRuntimeHostPrewarmRequest {
  readonly snapshot: SessionSnapshot;
  /**
   * The complete host-owned request list represented by `snapshot`.
   *
   * Restoring only the execution snapshot leaves the Electron response model
   * empty, so the next submitted request would incorrectly become the whole
   * transcript. Keep the host ChatModel analogue and the worker request list
   * on the same atomic restore boundary.
   */
  readonly turnResponses: readonly TurnResponseTurn[];
}

export interface ChatRuntimeHostRestoreRuntimeSessionResult {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly restored: boolean;
  readonly turnCount: number;
  readonly transcriptRevision: number;
}

export interface ChatRuntimeHostSessionExecutionState {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly exists: boolean;
  readonly requestInProgress: boolean;
  readonly activeTurnId: string | null;
  readonly responseCompleted?: boolean;
  readonly revision?: number;
}

export interface ChatRuntimeHostInteractionSnapshot {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly revision: number;
  readonly question: Readonly<Record<string, unknown>> | null;
  readonly confirmationQueue: readonly Readonly<Record<string, unknown>>[];
  readonly activeConfirmationIndex: number;
  readonly activePlanReview: Readonly<Record<string, unknown>> | null;
  readonly backgroundCommandSessionKeys: readonly string[];
  readonly backgroundProcessIds?: readonly string[];
  readonly processInventoryRevision?: number;
  readonly processes?: readonly ChatRuntimeHostSessionProcessSummary[];
}

export interface ChatRuntimeHostSessionProcessSummary {
  readonly processId: string;
  readonly sessionId: string;
  readonly outputSessionId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: string;
  readonly running: boolean;
  readonly exitCode?: number;
  readonly pid?: number;
  readonly startedAt: number;
  readonly lastOutputAt?: number;
  readonly completedAt?: number;
  readonly elapsedMs: number;
  readonly bytesTotal: number;
  readonly background?: boolean;
  readonly subappName?: string;
  readonly outputFilePath?: string;
  readonly removed?: boolean;
  readonly removedAt?: number;
}

export type ChatRuntimeHostInteractionRequestKind =
  | 'question.complete'
  | 'question.skip'
  | 'confirmation.navigate'
  | 'confirmation.resolve'
  | 'confirmation.action'
  | 'planReview.resolve'
  | 'commandSession.action';

export interface ChatRuntimeHostInteractionRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly viewId: ChatRuntimeHostViewId;
  readonly visibleAttachmentGeneration: number;
  readonly kind: ChatRuntimeHostInteractionRequestKind;
  readonly id?: string;
  readonly delta?: number;
  readonly payload?: unknown;
}

export type ChatRuntimeHostViewRequestKind =
  | 'notification'
  | 'todo-state'
  | 'handoff';

export type ChatRuntimeHostNotificationSeverity =
  | 'success'
  | 'error'
  | 'warning'
  | 'info';

export interface ChatRuntimeHostViewRequest {
  readonly id: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly kind: ChatRuntimeHostViewRequestKind;
  readonly notification?: {
    readonly severity: ChatRuntimeHostNotificationSeverity;
    readonly message: string;
  };
  readonly todoState?: {
    readonly items: readonly ChatRuntimeHostTodoItem[];
  };
  readonly handoff?: {
    readonly targetAgent?: string;
    readonly targetModeId?: ChatModeId;
    readonly message: string;
    readonly suggestedInput?: string;
  };
}

export interface ChatRuntimeHostTodoItem {
  readonly id: number;
  readonly content: string;
  readonly status: 'not-started' | 'in-progress' | 'completed';
  readonly priority: 'low' | 'medium' | 'high';
  readonly updatedAt: number;
}

export interface ChatRuntimeHostEventBase {
  readonly kind: ChatRuntimeHostEventKind;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly revision: number;
}

export interface ChatRuntimeHostTranscriptEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'transcript';
  readonly transcript: ChatRuntimeHostTranscriptSnapshot;
}

export interface ChatRuntimeHostTurnTranscriptEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'turn-transcript';
  readonly turnId: string;
  readonly turn: TurnResponseTurn;
  readonly sourceEventType?: string;
  readonly sourceEventTimestamp?: number;
  readonly hostPublishedAt?: number;
}

export interface ChatRuntimeHostPartTranscriptEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'part-transcript';
  readonly turnId: string;
  readonly parts: readonly TurnResponsePart[];
  readonly turn?: TurnResponseTurn;
  readonly status?: TurnResponseStatus;
  readonly sourceEventType?: string;
  readonly sourceEventTimestamp?: number;
  readonly hostPublishedAt?: number;
}

export interface ChatRuntimeHostSessionStateEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'session-state' | 'runtime-status';
  readonly state: ChatRuntimeHostSessionState;
}

export interface ChatRuntimeHostInteractionEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'interaction';
  readonly interaction: ChatRuntimeHostInteractionSnapshot;
}

export interface ChatRuntimeHostViewRequestEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'view-request';
  readonly request: ChatRuntimeHostViewRequest;
}

export type ChatRuntimeHostResourceRequestKind =
  | 'abs-workspace-export'
  | 'checkpoint-commit'
  | 'checkpoint-settle'
  | 'file-read'
  | 'file-write'
  | 'file-edit'
  | 'workspace-mutation'
  | 'project-info'
  | 'project-build'
  | 'project-lint'
  | 'tool-approval'
  | 'board-search'
  | 'library-analysis'
  | 'diagnostics'
  | 'blockly-workspace'
  | 'connection-graph'
  | 'edit-tracking'
  | 'session-title'
  | 'save-current-session'
  | 'history-persistence';

export type ChatRuntimeHostResourceRequestPhase =
  | 'started'
  | 'completed'
  | 'failed';

export interface ChatRuntimeHostResourceRequest {
  readonly id: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly kind: ChatRuntimeHostResourceRequestKind;
  readonly phase: ChatRuntimeHostResourceRequestPhase;
  readonly label?: string;
  readonly detail?: string;
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly error?: {
    readonly code?: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

export interface ChatRuntimeHostResourceRequestEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'resource-request';
  readonly request: ChatRuntimeHostResourceRequest;
}

export interface ChatRuntimeHostAbsWorkspaceExportPayload {
  readonly adapter: 'absAutoSync';
  readonly action: 'ensureWorkspaceExport';
  readonly projectPath: string;
}

export interface ChatRuntimeHostEditCheckpointCommitPayload {
  readonly adapter: 'editCheckpoint';
  readonly action: 'commitCurrentTurn';
}

export interface ChatRuntimeHostEditCheckpointSettlePayload {
  readonly adapter: 'editCheckpoint';
  readonly action: 'settleMetadata';
}

export interface ChatRuntimeHostEditTrackingSetAutoSavePayload {
  readonly adapter: 'editTracking';
  readonly action: 'setAutoSaveEdits';
  readonly autoSaveEdits: boolean;
}

export interface ChatRuntimeHostEditTrackingSetTimelineContextPayload {
  readonly adapter: 'editTracking';
  readonly action: 'setTimelineContext';
  readonly workspaceRoot?: string | null;
}

export interface ChatRuntimeHostEditTrackingStartTurnPayload {
  readonly adapter: 'editTracking';
  readonly action: 'startTurn';
  readonly turnIndex: number;
  readonly turnStartListIndex: number | null;
  readonly responseStartListIndex: number | null;
  readonly turnId?: string;
  readonly requestContent?: string;
  readonly displayContent?: string;
  readonly checkpointId?: string;
  readonly requestMetadata?: unknown;
  readonly autoSaveEdits?: boolean;
}

export interface ChatRuntimeHostEditTrackingRecordRootCandidatesPayload {
  readonly adapter: 'editTracking';
  readonly action: 'recordAdditionalRepositoryRootCandidates';
  readonly paths: readonly string[];
}

export interface ChatRuntimeHostEditTrackingRecordEditPayload {
  readonly adapter: 'editTracking';
  readonly action: 'recordEdit';
  readonly filePath: string;
  readonly editType: 'create' | 'modify' | 'delete';
}

export interface ChatRuntimeHostEditTrackingPublishSummaryPayload {
  readonly adapter: 'editTracking';
  readonly action: 'publishCurrentSummary';
}

export interface ChatRuntimeHostEditTrackingFinalizeCurrentTurnPayload {
  readonly adapter: 'editTracking';
  readonly action: 'finalizeCurrentTurn';
  readonly checkpointId?: string;
  readonly requestId?: string;
  readonly autoSaveEdits?: boolean;
  readonly requestDiffPreview?: boolean;
}

export interface ChatRuntimeHostEditTrackingReadFinalizedCheckpointMetadataPayload {
  readonly adapter: 'editTracking';
  readonly action: 'readFinalizedCheckpointMetadata';
  readonly checkpointId?: string;
  readonly requestId?: string;
}

export interface ChatRuntimeHostEditTrackingRestorePayload {
  readonly adapter: 'editTracking';
  readonly action: 'restoreFromTurnResponses';
  readonly workspaceRoot?: string | null;
  readonly turnResponses: readonly unknown[];
  readonly autoSaveEdits?: boolean;
}

export interface ChatRuntimeHostEditTrackingForkRequestMetadataPayload {
  readonly adapter: 'editTracking';
  readonly action: 'forkRequestCheckpointMetadata';
  readonly sourceSessionResource: string;
  readonly targetSessionResource: string;
  readonly retainedTurnResponses: readonly unknown[];
}

export interface ChatRuntimeHostEditTrackingClearSessionStatePayload {
  readonly adapter: 'editTracking';
  readonly action: 'clearSessionState';
  readonly dismissSummary?: boolean;
}

export type ChatRuntimeHostEditTrackingPayload =
  | ChatRuntimeHostEditTrackingSetAutoSavePayload
  | ChatRuntimeHostEditTrackingSetTimelineContextPayload
  | ChatRuntimeHostEditTrackingStartTurnPayload
  | ChatRuntimeHostEditTrackingRecordRootCandidatesPayload
  | ChatRuntimeHostEditTrackingRecordEditPayload
  | ChatRuntimeHostEditTrackingPublishSummaryPayload
  | ChatRuntimeHostEditTrackingFinalizeCurrentTurnPayload
  | ChatRuntimeHostEditTrackingReadFinalizedCheckpointMetadataPayload
  | ChatRuntimeHostEditTrackingRestorePayload
  | ChatRuntimeHostEditTrackingForkRequestMetadataPayload
  | ChatRuntimeHostEditTrackingClearSessionStatePayload;

export interface ChatRuntimeHostSyncAbsPayload {
  readonly adapter: 'syncAbs';
  readonly args: {
    readonly operation: 'export' | 'import' | 'status';
    readonly includeHeader?: boolean;
    readonly pendingAbsContent?: string;
  };
}

export interface ChatRuntimeHostSessionPersistencePayload {
  readonly adapter: 'chatHistory';
  readonly record?: unknown;
  readonly hostRecord?: unknown;
  readonly liveHostSessionRecord?: unknown;
}

export interface ChatRuntimeHostProjectInfoPayload {
  readonly adapter: 'project';
  readonly action:
    | 'getProjectInfo'
    | 'createProject'
    | 'getPackageJson'
    | 'getBoardJson'
    | 'getBoardModule'
    | 'getBoardPackageJson'
    | 'reloadProject'
    | 'switchBoard'
    | 'setBoardConfig';
  readonly name?: string;
  readonly path?: string;
  readonly board?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly configKey?: string;
  readonly configValue?: string;
}

export interface ChatRuntimeHostProjectBuildPayload {
  readonly adapter: 'builder';
  readonly action: 'build' | 'upload';
  readonly projectPath: string;
  readonly port?: string;
}

export interface ChatRuntimeHostProjectLintPayload {
  readonly adapter: 'arduinoLint';
  readonly action: 'checkSyntax';
  readonly code: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ChatRuntimeHostBlocklyWorkspacePayload {
  readonly adapter: 'blockly';
  readonly action:
    | 'getWorkspaceXml'
    | 'loadWorkspace'
    | 'getGeneratedCode'
    | 'reloadAbiJson'
    | 'getBlockDefinitions';
  readonly xml?: string;
}

export interface ChatRuntimeHostConnectionGraphPayload {
  readonly adapter: 'connectionGraph';
  readonly action:
    | 'generateConnectionGraph'
    | 'getPinmapSummary'
    | 'validateConnectionGraph'
    | 'getSensorPinmapCatalog'
    | 'generatePinmap'
    | 'savePinmap'
    | 'getCurrentSchematic'
    | 'applySchematic';
  readonly args?: unknown;
}

export interface ChatRuntimeHostBoardSearchPayload {
  readonly adapter: 'boardSearch';
  readonly action: 'search' | 'getCategories';
  readonly query?: string;
  readonly searchType?: 'boards' | 'libraries' | 'both';
  readonly categoryType?: 'boards' | 'libraries';
  readonly dimension?: string;
  readonly args?: unknown;
}

export interface ChatRuntimeHostLibraryAnalysisPayload {
  readonly adapter: 'libraryAnalysis';
  readonly action: 'analyzeLibrary';
  readonly libraryId?: string;
  readonly libraryIds?: readonly string[];
  readonly mode?: 'auto' | 'readme_ref' | 'analysis';
}

export interface ChatRuntimeHostDiagnosticsPayload {
  readonly adapter: 'diagnostics';
  readonly action: 'getErrors';
  readonly filePaths?: readonly string[];
  readonly ranges?: readonly unknown[];
}

export interface ChatRuntimeHostToolApprovalPayload {
  readonly adapter: 'toolApproval';
  readonly action: 'preflight';
  readonly approvalTraceId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly message?: string;
  readonly source?: string;
  readonly actions?: readonly unknown[];
  readonly primaryScope?: string;
  readonly allowAutoConfirm?: boolean;
  readonly approveCombination?: unknown;
  readonly args?: unknown;
}

export type ChatRuntimeHostResourceOperationPayload =
  | ChatRuntimeHostAbsWorkspaceExportPayload
  | ChatRuntimeHostEditCheckpointCommitPayload
  | ChatRuntimeHostEditCheckpointSettlePayload
  | ChatRuntimeHostEditTrackingPayload
  | ChatRuntimeHostSyncAbsPayload
  | ChatRuntimeHostSessionPersistencePayload
  | ChatRuntimeHostProjectInfoPayload
  | ChatRuntimeHostProjectBuildPayload
  | ChatRuntimeHostProjectLintPayload
  | ChatRuntimeHostBlocklyWorkspacePayload
  | ChatRuntimeHostConnectionGraphPayload
  | ChatRuntimeHostBoardSearchPayload
  | ChatRuntimeHostLibraryAnalysisPayload
  | ChatRuntimeHostDiagnosticsPayload
  | ChatRuntimeHostToolApprovalPayload;

export interface ChatRuntimeHostResourceOperationRequest {
  readonly id?: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly kind: ChatRuntimeHostResourceRequestKind;
  readonly label?: string;
  readonly detail?: string;
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly payload?: ChatRuntimeHostResourceOperationPayload;
}

export interface ChatRuntimeHostResourceOperationResult {
  readonly id: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly kind: ChatRuntimeHostResourceRequestKind;
  readonly ok: true;
  readonly result?: unknown;
}

export interface ChatRuntimeHostErrorEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'error';
  readonly error: {
    readonly code?: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

export type ChatRuntimeHostEvent =
  | ChatRuntimeHostTranscriptEvent
  | ChatRuntimeHostTurnTranscriptEvent
  | ChatRuntimeHostPartTranscriptEvent
  | ChatRuntimeHostSessionStateEvent
  | ChatRuntimeHostInteractionEvent
  | ChatRuntimeHostViewRequestEvent
  | ChatRuntimeHostResourceRequestEvent
  | ChatRuntimeHostErrorEvent;

export interface ChatRuntimeOwnerExecutorRenderEventProgress {
  readonly kind: 'render-event';
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId?: string | null;
  readonly request?: ChatRuntimeHostSubmitRequest;
  readonly revision?: number;
  readonly renderEvent: RenderEvent;
}

export interface ChatRuntimeHostEventSubscription {
  dispose(): void;
}

export type ChatRuntimeOwnerExecutorCommandMethod =
  | 'prewarmRuntime'
  | 'restoreRuntimeSession'
  | 'forkSession'
  | 'startTurn'
  | 'stopTurn'
  | 'disposeSessionResources'
  | 'resolveInteraction';

export interface ChatRuntimeOwnerExecutorPrewarmRuntimeCommand extends ChatRuntimeHostPrewarmRequest {}

export interface ChatRuntimeOwnerExecutorRestoreRuntimeSessionCommand extends ChatRuntimeHostPrewarmRequest {
  readonly snapshot: SessionSnapshot;
}

export interface ChatRuntimeOwnerExecutorRestoreRuntimeSessionResult {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly restored: boolean;
  readonly turnCount: number;
}

export interface ChatRuntimeOwnerExecutorForkSessionCommand {
  readonly sourceSessionId: ChatRuntimeHostSessionId;
  readonly targetSessionId: ChatRuntimeHostSessionId;
  readonly beforeTurnId: string;
  readonly retainedTurnIds: readonly string[];
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
}

export interface ChatRuntimeOwnerExecutorStartTurnExecutionContext {
  readonly selectedMode?: ChatSelectedMode | null;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly transcriptRevision?: number;
  readonly protocolTruncation?: ChatRuntimeHostProtocolTruncation | null;
}

export interface ChatRuntimeOwnerExecutorStartTurnCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId: string;
  readonly request: ChatRuntimeHostSubmitRequest;
  readonly executionContext?: ChatRuntimeOwnerExecutorStartTurnExecutionContext | null;
}

export interface ChatRuntimeOwnerExecutorStopTurnCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId?: string | null;
}

export interface ChatRuntimeHostStopTurnRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId?: string | null;
}

export interface ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
}

export interface ChatRuntimeOwnerExecutorResolveInteractionCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly interactionId?: string;
  readonly request: ChatRuntimeHostInteractionRequest;
}

export type ChatRuntimeOwnerExecutorCommand =
  | {
      readonly method: 'prewarmRuntime';
      readonly payload: ChatRuntimeOwnerExecutorPrewarmRuntimeCommand;
    }
  | {
      readonly method: 'restoreRuntimeSession';
      readonly payload: ChatRuntimeOwnerExecutorRestoreRuntimeSessionCommand;
    }
  | {
      readonly method: 'forkSession';
      readonly payload: ChatRuntimeOwnerExecutorForkSessionCommand;
    }
  | {
      readonly method: 'startTurn';
      readonly payload: ChatRuntimeOwnerExecutorStartTurnCommand;
    }
  | {
      readonly method: 'stopTurn';
      readonly payload: ChatRuntimeOwnerExecutorStopTurnCommand;
    }
  | {
      readonly method: 'disposeSessionResources';
      readonly payload: ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand;
    }
  | {
      readonly method: 'resolveInteraction';
      readonly payload: ChatRuntimeOwnerExecutorResolveInteractionCommand;
    };

export type ChatRuntimeOwnerExecutorEventKind =
  | 'turnProgress'
  | 'runtimeProjectPathUpdated'
  | 'turnInteractionRequested'
  | 'turnError'
  | 'turnCompleted';

export interface ChatRuntimeOwnerExecutorEventBase {
  readonly kind: ChatRuntimeOwnerExecutorEventKind;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId: string;
  readonly revision?: number;
}

export interface ChatRuntimeOwnerExecutorTurnProgressEvent extends ChatRuntimeOwnerExecutorEventBase {
  readonly kind: 'turnProgress';
  readonly turn?: TurnResponseTurn;
  readonly request?: ChatRuntimeHostSubmitRequest;
  readonly renderEvent?: RenderEvent;
  readonly event?: ChatRuntimeHostSessionStateEvent
    | ChatRuntimeHostViewRequestEvent
    | ChatRuntimeHostResourceRequestEvent;
}

export interface ChatRuntimeOwnerExecutorTurnInteractionRequestedEvent extends ChatRuntimeOwnerExecutorEventBase {
  readonly kind: 'turnInteractionRequested';
  readonly interaction: ChatRuntimeHostInteractionSnapshot;
}

export interface ChatRuntimeOwnerExecutorProjectPathUpdatedEvent extends ChatRuntimeOwnerExecutorEventBase {
  readonly kind: 'runtimeProjectPathUpdated';
  readonly projectPath: string;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly projectInfo?: unknown;
}

export interface ChatRuntimeOwnerExecutorTurnErrorEvent extends ChatRuntimeOwnerExecutorEventBase {
  readonly kind: 'turnError';
  readonly error: {
    readonly code?: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
}

export interface ChatRuntimeOwnerExecutorTurnCompletedEvent extends ChatRuntimeOwnerExecutorEventBase {
  readonly kind: 'turnCompleted';
  readonly turn?: TurnResponseTurn;
  readonly state?: ChatRuntimeHostSessionState;
  readonly interaction?: ChatRuntimeHostInteractionSnapshot;
}

export type ChatRuntimeOwnerExecutorEvent =
  | ChatRuntimeOwnerExecutorTurnProgressEvent
  | ChatRuntimeOwnerExecutorProjectPathUpdatedEvent
  | ChatRuntimeOwnerExecutorTurnInteractionRequestedEvent
  | ChatRuntimeOwnerExecutorTurnErrorEvent
  | ChatRuntimeOwnerExecutorTurnCompletedEvent;

export interface ChatRuntimeOwnerExecutor {
  prewarmRuntime(command: ChatRuntimeOwnerExecutorPrewarmRuntimeCommand): Promise<ChatRuntimeHostPrewarmResult>;
  restoreRuntimeSession(command: ChatRuntimeOwnerExecutorRestoreRuntimeSessionCommand): Promise<ChatRuntimeOwnerExecutorRestoreRuntimeSessionResult>;
  forkSession?(command: ChatRuntimeOwnerExecutorForkSessionCommand): Promise<ChatRuntimeHostPrewarmResult>;
  startTurn(command: ChatRuntimeOwnerExecutorStartTurnCommand): Promise<ChatRuntimeHostSessionState>;
  stopTurn(command: ChatRuntimeOwnerExecutorStopTurnCommand): Promise<void>;
  disposeSessionResources(command: ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand): Promise<void>;
  resolveInteraction(command: ChatRuntimeOwnerExecutorResolveInteractionCommand): Promise<ChatRuntimeHostInteractionSnapshot | null>;
  onEvent(listener: (event: ChatRuntimeHostEvent | ChatRuntimeOwnerExecutorRenderEventProgress | ChatRuntimeOwnerExecutorEvent) => void): ChatRuntimeHostEventSubscription;
}

export interface ChatRuntimeHostAttachViewOptions {
  readonly visibleAttachmentGeneration?: number | null;
  readonly sessionScopeKey: string;
}

export interface ChatRuntimeHost {
  attachView(
    viewId: ChatRuntimeHostViewId,
    sessionId: ChatRuntimeHostSessionId,
    options: ChatRuntimeHostAttachViewOptions,
  ): Promise<ChatRuntimeHostSessionState>;
  detachView(viewId: ChatRuntimeHostViewId): Promise<void>;
  prewarmRuntime(request: ChatRuntimeHostPrewarmRequest): Promise<ChatRuntimeHostPrewarmResult>;
  restoreRuntimeSession(request: ChatRuntimeHostRestoreRuntimeSessionRequest): Promise<ChatRuntimeHostRestoreRuntimeSessionResult>;
  readSessionExecutionState(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostSessionExecutionState>;
  submitTurn(request: ChatRuntimeHostSubmitRequest): Promise<ChatRuntimeHostSessionState>;
  readSubmitReadiness(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostSubmitReadiness>;
  ensureSessionCanRerun(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostRerunReadiness>;
  stopTurn(request: ChatRuntimeHostSessionId | ChatRuntimeHostStopTurnRequest): Promise<void>;
  disposeSession(sessionId: ChatRuntimeHostSessionId): Promise<void>;
  readSessionState(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostSessionState | null>;
  readSessionInventory(): Promise<ChatRuntimeHostSessionInventorySnapshot>;
  readTranscript(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostTranscriptSnapshot | null>;
  readSessionTurnPage(request: ChatRuntimeHostTurnPageRequest): Promise<ChatRuntimeHostTurnPage | null>;
  readCheckpointNavigationState(
    request: ChatRuntimeHostCheckpointNavigationRequest,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null>;
  mutateSessionRequestList(
    request: ChatRuntimeHostRequestListMutationRequest,
  ): Promise<ChatRuntimeHostRequestListMutationResult>;
  restoreSessionCheckpoint(
    request: ChatRuntimeHostCheckpointMutationRequest & { readonly checkpointId: string },
  ): Promise<ChatRuntimeHostCheckpointMutationResult>;
  redoSessionCheckpoint(
    request: ChatRuntimeHostCheckpointMutationRequest,
  ): Promise<ChatRuntimeHostCheckpointMutationResult>;
  forkSession(request: ChatRuntimeHostForkSessionRequest): Promise<ChatRuntimeHostForkSessionResult>;
  awaitRequestCompletion(sessionId: ChatRuntimeHostSessionId): Promise<void>;
  runWorkspaceFinalizeBoundaryProbe(sessionId: ChatRuntimeHostSessionId): Promise<void>;
  readInteractionSnapshot(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostInteractionSnapshot | null>;
  resolveInteraction(request: ChatRuntimeHostInteractionRequest): Promise<ChatRuntimeHostInteractionSnapshot | null>;
  recordResourceRequest(request: ChatRuntimeHostResourceRequest): Promise<ChatRuntimeHostResourceRequestEvent | null>;
  requestResourceOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<ChatRuntimeHostResourceOperationResult>;
  onEvent(listener: (event: ChatRuntimeHostEvent) => void): ChatRuntimeHostEventSubscription;
}
