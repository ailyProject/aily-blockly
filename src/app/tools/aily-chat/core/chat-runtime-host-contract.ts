import type { RenderEvent, SessionSnapshot, TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import type {
  ChatAgentRuntimeMode,
  ChatAgentRuntimeModeSource,
} from './chat-agent-runtime-mode';
import type { ChatModeId, ChatSelectedMode } from './chat-mode';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { ChatImageAttachmentDraft } from './chat-image-attachment';

export type ChatRuntimeHostViewId = string;
export type ChatRuntimeHostSessionId = string;

export type ChatRuntimeHostEventKind =
  | 'session-state'
  | 'transcript'
  | 'turn-transcript'
  | 'part-transcript'
  | 'editing-session'
  | 'turn-diff'
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
  readonly isCustom?: boolean;
  readonly providerContextManagementSupport?: unknown;
  readonly inputModalities?: readonly ('text' | 'image')[];
  readonly maxInputImages?: number;
}

export interface ChatRuntimeHostSubmitRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly requestText: string;
  readonly displayText?: string;
  readonly imageAttachments?: readonly ChatImageAttachmentDraft[];
  readonly selectedMode?: ChatSelectedMode | null;
  readonly providerOptions?: HostSessionProviderOptions | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource | null;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly summarizerModel?: ChatRuntimeHostModelSelectionSnapshot | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
  readonly activeResponseHandle?: unknown | null;
  readonly protocolTruncation?: ChatRuntimeHostProtocolTruncation | null;
}

export interface ChatRuntimeHostImageMediaRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly attachmentId?: string;
  readonly mediaRef: string;
  readonly mimeType?: string;
}

export interface ChatRuntimeHostImageMedia {
  readonly mediaRef: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly content: string;
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
  readonly expectedRevision?: number;
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
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ChatRuntimeHostCheckpointTimelineState {
  readonly sessionResource: ChatRuntimeHostSessionId;
  readonly currentCheckpointIndex: number;
  readonly currentTurnResponseCount: number;
  readonly checkpoints: readonly ChatRuntimeHostCheckpointNavigationEntry[];
  readonly turnResponses: readonly TurnResponseTurn[];
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
  readonly appliedFiles: number;
  readonly retainedTurnIds: readonly string[];
  readonly restoredTurnIds: readonly string[];
  readonly canRedo: boolean;
  readonly checkpointTimeline: ChatRuntimeHostCheckpointTimelineState;
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
  readonly summarizerModel?: ChatRuntimeHostModelSelectionSnapshot | null;
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
  readonly summarizerModel?: ChatRuntimeHostModelSelectionSnapshot | null;
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
  /**
   * VS Code keeps disabled forward requests in the ChatModel while the editing
   * timeline cursor controls their visibility. The execution owner still
   * receives only `turnResponses`; this host-owned timeline restores that
   * forward branch and cursor after process restart.
   */
  readonly checkpointTimeline?: ChatRuntimeHostCheckpointTimelineState;
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

export interface ChatRuntimeHostEditingSessionContentRef {
  readonly hash: string;
  readonly encoding: 'utf8' | 'base64';
  readonly byteLength: number;
}

export interface ChatRuntimeHostEditingSessionCheckpoint {
  readonly checkpointId: string;
  readonly requestId: string;
  readonly turnId?: string;
  readonly stopId?: string;
  readonly label: string;
  readonly description?: string;
  readonly epoch: number;
  readonly createdAt: number;
}

export interface ChatRuntimeHostEditingSessionBaseline {
  readonly baselineId: string;
  readonly requestId: string;
  readonly uri: string;
  readonly epoch: number;
  readonly contentRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly existed: boolean;
  readonly createdAt: number;
}

export interface ChatRuntimeHostEditingSessionTextEdit {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly newText: string;
}

export interface ChatRuntimeHostEditingSessionOperation {
  readonly operationId: string;
  readonly requestId: string;
  readonly checkpointId?: string;
  readonly epoch: number;
  readonly uri: string;
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly createdAt: number;
  readonly type: 'create' | 'delete' | 'rename' | 'replace' | 'text-edit' | 'notebook-edit';
  readonly beforeRef?: ChatRuntimeHostEditingSessionContentRef | null;
  readonly afterRef?: ChatRuntimeHostEditingSessionContentRef | null;
  readonly fromUri?: string;
  readonly toUri?: string;
  readonly edits?: readonly ChatRuntimeHostEditingSessionTextEdit[];
}

export interface ChatRuntimeHostEditingSessionRequestScope {
  readonly requestId: string;
  readonly turnId?: string;
  readonly responseId?: string;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly status: 'open' | 'completed' | 'restored' | 'discarded';
  readonly outcome?: 'completed' | 'cancelled' | 'error' | 'disposed';
  readonly firstEpoch?: number;
  readonly lastEpoch?: number;
  readonly checkpointIds: readonly string[];
  readonly touchedUris: readonly string[];
}

export interface ChatRuntimeHostEditingSessionRequestSummary {
  readonly requestId: string;
  readonly turnId?: string;
  readonly status: ChatRuntimeHostEditingSessionRequestScope['status'];
  readonly outcome?: NonNullable<ChatRuntimeHostEditingSessionRequestScope['outcome']>;
  readonly firstEpoch?: number;
  readonly lastEpoch?: number;
  readonly operationCount: number;
  readonly checkpointIds: readonly string[];
  readonly touchedUris: readonly string[];
  readonly entries: readonly ChatRuntimeHostEditingSessionRequestEntry[];
}

export interface ChatRuntimeHostEditingSessionRequestEntry {
  readonly uri: string;
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly originalRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly currentRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly existedAtStart: boolean;
  readonly deleted: boolean;
  readonly firstEpoch: number;
  readonly lastEpoch: number;
}

export interface ChatRuntimeHostEditingSessionEntry {
  readonly uri: string;
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly originalRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly currentRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly existedAtBaseline: boolean;
  readonly deleted: boolean;
  readonly firstEpoch: number;
  readonly lastEpoch: number;
  readonly requestIds: readonly string[];
  readonly state: 'modified' | 'accepted' | 'rejected';
}

export interface ChatRuntimeHostEditingSessionState {
  readonly version: 4;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly workspaceIdentity: string;
  readonly workspaceRoot: string;
  readonly revision: number;
  readonly checkpoints: readonly ChatRuntimeHostEditingSessionCheckpoint[];
  readonly baselines: readonly ChatRuntimeHostEditingSessionBaseline[];
  readonly operations: readonly ChatRuntimeHostEditingSessionOperation[];
  readonly requestScopes: readonly ChatRuntimeHostEditingSessionRequestScope[];
  readonly currentPointer: {
    readonly epoch: number;
    readonly checkpointId?: string;
    readonly requestId?: string;
    readonly stopId?: string;
  };
  readonly epochCounter: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly entries: readonly ChatRuntimeHostEditingSessionEntry[];
  readonly requestSummaries: readonly ChatRuntimeHostEditingSessionRequestSummary[];
  readonly summary: {
    readonly checkpointCount: number;
    readonly requestCount: number;
    readonly entryCount: number;
    readonly operationCount: number;
    readonly modifiedEntryCount: number;
  };
}

export interface ChatRuntimeHostEditingSessionEntryOperationRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly uri: string;
  readonly action: 'accept' | 'reject';
}

export interface ChatRuntimeHostEditingSessionAcceptRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
}

export interface ChatRuntimeHostEditingSessionInteractionRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
}

export interface ChatRuntimeHostEditingSessionContentRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly contentRef: ChatRuntimeHostEditingSessionContentRef;
}

export interface ChatRuntimeHostEditingSessionNavigationRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly checkpointId: string;
  readonly direction: 'restore' | 'redo';
}

export interface ChatRuntimeHostEditingSessionNavigationFileState {
  readonly uri: string;
  readonly exists: boolean;
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly contentRef: ChatRuntimeHostEditingSessionContentRef | null;
  readonly sourceEpoch: number;
}

export interface ChatRuntimeHostEditingSessionNavigationPlan {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly workspaceIdentity: string;
  readonly workspaceRoot: string;
  readonly checkpointId: string;
  readonly requestId: string;
  readonly direction: 'restore' | 'redo';
  readonly expectedRevision: number;
  readonly fromEpoch: number;
  readonly restoreToEpoch: number;
  readonly navigateToEpoch: number;
  readonly files: readonly ChatRuntimeHostEditingSessionNavigationFileState[];
}

export interface ChatRuntimeHostEditingSessionContent {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly workspaceIdentity: string;
  readonly revision: number;
  readonly contentRef: ChatRuntimeHostEditingSessionContentRef;
  readonly dataBase64: string;
}

export interface ChatRuntimeHostEditingSessionEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'editing-session';
}

export interface ChatRuntimeHostTurnDiffEvent extends ChatRuntimeHostEventBase {
  readonly kind: 'turn-diff';
  readonly turnId: string;
  readonly diff: string;
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
  /** Canonical response content indices aligned one-to-one with `parts`. */
  readonly partIndices: readonly number[];
  /** Present only when the response structure/status needs authoritative replacement. */
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
  | 'subapp-agent'
  | 'project-scene-proposal'
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
  readonly projectPath?: string;
}

export interface ChatRuntimeHostSyncAbsPayload {
  readonly adapter: 'syncAbs';
  readonly args: {
    readonly operation: 'export' | 'import' | 'status';
    readonly includeHeader?: boolean;
    readonly pendingAbsContent?: string;
  };
}

export interface ChatRuntimeHostWorkspaceMutationControlPayload {
  readonly adapter: 'workspaceMutation';
  readonly action: 'commit' | 'rollback';
  readonly transactionId: string;
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

export type ChatRuntimeHostProjectBuildPayload =
  | {
    readonly adapter: 'builder';
    readonly action: 'listSerialPorts';
  }
  | {
    readonly adapter: 'builder';
    readonly action: 'build';
    readonly projectPath: string;
  }
  | {
    readonly adapter: 'builder';
    readonly action: 'upload';
    readonly projectPath: string;
    readonly port: string;
  };

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

export interface ChatRuntimeHostSubappAgentPayload {
  readonly adapter: 'subappAgent';
  readonly action: 'execute' | 'releaseSession';
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface ChatRuntimeHostProjectSceneProposalToolPayload {
  readonly adapter: 'projectSceneProposal';
  readonly action: 'readContext' | 'submitProposal';
  readonly input: Readonly<Record<string, unknown>>;
}

export type ChatRuntimeHostResourceOperationPayload =
  | ChatRuntimeHostAbsWorkspaceExportPayload
  | ChatRuntimeHostSyncAbsPayload
  | ChatRuntimeHostWorkspaceMutationControlPayload
  | ChatRuntimeHostSessionPersistencePayload
  | ChatRuntimeHostProjectInfoPayload
  | ChatRuntimeHostProjectBuildPayload
  | ChatRuntimeHostProjectLintPayload
  | ChatRuntimeHostBlocklyWorkspacePayload
  | ChatRuntimeHostBoardSearchPayload
  | ChatRuntimeHostLibraryAnalysisPayload
  | ChatRuntimeHostDiagnosticsPayload
  | ChatRuntimeHostToolApprovalPayload
  | ChatRuntimeHostSubappAgentPayload
  | ChatRuntimeHostProjectSceneProposalToolPayload;

export interface ChatRuntimeHostResourceOperationRequest {
  readonly id?: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly kind: ChatRuntimeHostResourceRequestKind;
  readonly label?: string;
  readonly detail?: string;
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly payload?: ChatRuntimeHostResourceOperationPayload;
}

export type ChatRuntimeHostWorkspaceMutationOperationKind =
  | 'create'
  | 'delete'
  | 'rename'
  | 'replace'
  | 'text-edit'
  | 'notebook-edit';

export interface ChatRuntimeHostWorkspaceMutationTextEdit {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly newText: string;
}

export interface ChatRuntimeHostWorkspaceMutationReceipt {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly operationKind: ChatRuntimeHostWorkspaceMutationOperationKind;
  readonly filePath: string;
  readonly existedBefore: boolean;
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly edits?: readonly ChatRuntimeHostWorkspaceMutationTextEdit[];
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly beforeContent?: string | null;
  readonly afterContent?: string | null;
  readonly beforeBytes?: Uint8Array | null;
  readonly afterBytes?: Uint8Array | null;
}

export interface ChatRuntimeHostWorkspaceMutationReceiptInput {
  readonly filePath: string;
  readonly existedBefore: boolean;
  readonly operationKind?: ChatRuntimeHostWorkspaceMutationOperationKind;
  readonly fromPath?: string;
  readonly toPath?: string;
  readonly edits?: readonly ChatRuntimeHostWorkspaceMutationTextEdit[];
  readonly contentKind: 'text' | 'binary' | 'notebook';
  readonly beforeContent?: string | null;
  readonly afterContent?: string | null;
  readonly beforeBytes?: Uint8Array | null;
  readonly afterBytes?: Uint8Array | null;
}

export interface ChatRuntimeHostWorkspaceMutationBatch {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly transactionId: string;
  readonly status: 'prepared' | 'committed';
  readonly receipts: readonly ChatRuntimeHostWorkspaceMutationReceipt[];
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
  | ChatRuntimeHostEditingSessionEvent
  | ChatRuntimeHostTurnDiffEvent
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
  | 'readEditingSessionState'
  | 'readEditingSessionContent'
  | 'operateEditingSessionEntry'
  | 'acceptEditingSession'
  | 'buildEditingSessionNavigationPlan'
  | 'applyEditingSessionNavigation'
  | 'commitEditingSessionNavigation'
  | 'rollbackEditingSessionNavigation'
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

export interface ChatRuntimeOwnerExecutorReadEditingSessionStateCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly projectPath?: string | null;
}

export interface ChatRuntimeOwnerExecutorReadEditingSessionContentCommand
  extends ChatRuntimeHostEditingSessionContentRequest {
  readonly projectPath?: string | null;
}

export interface ChatRuntimeOwnerExecutorBuildEditingSessionNavigationPlanCommand
  extends ChatRuntimeHostEditingSessionNavigationRequest {
  readonly projectPath?: string | null;
}

export interface ChatRuntimeOwnerExecutorApplyEditingSessionNavigationCommand
  extends ChatRuntimeHostEditingSessionNavigationRequest {
  readonly projectPath?: string | null;
}

export interface ChatRuntimeOwnerExecutorApplyEditingSessionNavigationResult {
  readonly transactionId: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly checkpointId: string;
  readonly direction: 'restore' | 'redo';
  readonly expectedRevision: number;
  readonly appliedFiles: number;
}

export interface ChatRuntimeOwnerExecutorCommitEditingSessionNavigationCommand {
  readonly transactionId: string;
}

export interface ChatRuntimeOwnerExecutorCommitEditingSessionNavigationResult {
  readonly transactionId: string;
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly checkpointId: string;
  readonly direction: 'restore' | 'redo';
  readonly revision: number;
  readonly appliedFiles: number;
}

export interface ChatRuntimeOwnerExecutorRollbackEditingSessionNavigationCommand {
  readonly transactionId: string;
}

export interface ChatRuntimeOwnerExecutorRollbackEditingSessionNavigationResult {
  readonly transactionId: string;
  readonly rolledBackFiles: number;
  readonly errors: readonly string[];
  readonly rolledBackOnError: boolean;
}

export interface ChatRuntimeHostStopTurnRequest {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId?: string | null;
}

export interface ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly deleteStorage?: boolean;
  readonly projectPath?: string | null;
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
      readonly method: 'readEditingSessionState';
      readonly payload: ChatRuntimeOwnerExecutorReadEditingSessionStateCommand;
    }
  | {
      readonly method: 'readEditingSessionContent';
      readonly payload: ChatRuntimeOwnerExecutorReadEditingSessionContentCommand;
    }
  | {
      readonly method: 'operateEditingSessionEntry';
      readonly payload: ChatRuntimeHostEditingSessionEntryOperationRequest;
    }
  | {
      readonly method: 'acceptEditingSession';
      readonly payload: ChatRuntimeHostEditingSessionAcceptRequest;
    }
  | {
      readonly method: 'buildEditingSessionNavigationPlan';
      readonly payload: ChatRuntimeOwnerExecutorBuildEditingSessionNavigationPlanCommand;
    }
  | {
      readonly method: 'applyEditingSessionNavigation';
      readonly payload: ChatRuntimeOwnerExecutorApplyEditingSessionNavigationCommand;
    }
  | {
      readonly method: 'commitEditingSessionNavigation';
      readonly payload: ChatRuntimeOwnerExecutorCommitEditingSessionNavigationCommand;
    }
  | {
      readonly method: 'rollbackEditingSessionNavigation';
      readonly payload: ChatRuntimeOwnerExecutorRollbackEditingSessionNavigationCommand;
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
  | 'editingSessionChanged'
  | 'turnDiffUpdated'
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

export interface ChatRuntimeOwnerExecutorEditingSessionChangedEvent {
  readonly kind: 'editingSessionChanged';
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly revision: number;
}

export interface ChatRuntimeOwnerExecutorTurnDiffUpdatedEvent {
  readonly kind: 'turnDiffUpdated';
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly turnId: string;
  readonly revision: number;
  readonly diff: string;
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
  | ChatRuntimeOwnerExecutorEditingSessionChangedEvent
  | ChatRuntimeOwnerExecutorTurnDiffUpdatedEvent
  | ChatRuntimeOwnerExecutorProjectPathUpdatedEvent
  | ChatRuntimeOwnerExecutorTurnInteractionRequestedEvent
  | ChatRuntimeOwnerExecutorTurnErrorEvent
  | ChatRuntimeOwnerExecutorTurnCompletedEvent;

export interface ChatRuntimeOwnerExecutor {
  prewarmRuntime(command: ChatRuntimeOwnerExecutorPrewarmRuntimeCommand): Promise<ChatRuntimeHostPrewarmResult>;
  restoreRuntimeSession(command: ChatRuntimeOwnerExecutorRestoreRuntimeSessionCommand): Promise<ChatRuntimeOwnerExecutorRestoreRuntimeSessionResult>;
  forkSession?(command: ChatRuntimeOwnerExecutorForkSessionCommand): Promise<ChatRuntimeHostPrewarmResult>;
  readEditingSessionState?(
    command: ChatRuntimeOwnerExecutorReadEditingSessionStateCommand,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  readEditingSessionContent?(
    command: ChatRuntimeOwnerExecutorReadEditingSessionContentCommand,
  ): Promise<ChatRuntimeHostEditingSessionContent>;
  operateEditingSessionEntry?(
    command: ChatRuntimeHostEditingSessionEntryOperationRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  acceptEditingSession?(
    command: ChatRuntimeHostEditingSessionAcceptRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  buildEditingSessionNavigationPlan?(
    command: ChatRuntimeOwnerExecutorBuildEditingSessionNavigationPlanCommand,
  ): Promise<ChatRuntimeHostEditingSessionNavigationPlan>;
  applyEditingSessionNavigation?(
    command: ChatRuntimeOwnerExecutorApplyEditingSessionNavigationCommand,
  ): Promise<ChatRuntimeOwnerExecutorApplyEditingSessionNavigationResult>;
  commitEditingSessionNavigation?(
    command: ChatRuntimeOwnerExecutorCommitEditingSessionNavigationCommand,
  ): Promise<ChatRuntimeOwnerExecutorCommitEditingSessionNavigationResult>;
  rollbackEditingSessionNavigation?(
    command: ChatRuntimeOwnerExecutorRollbackEditingSessionNavigationCommand,
  ): Promise<ChatRuntimeOwnerExecutorRollbackEditingSessionNavigationResult>;
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
  readEditingSessionState(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostEditingSessionState>;
  readEditingSessionContent(
    request: ChatRuntimeHostEditingSessionContentRequest,
  ): Promise<ChatRuntimeHostEditingSessionContent>;
  operateEditingSessionEntry(
    request: ChatRuntimeHostEditingSessionEntryOperationRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  acceptEditingSession(
    request: ChatRuntimeHostEditingSessionAcceptRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  undoEditingSessionInteraction(
    request: ChatRuntimeHostEditingSessionInteractionRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  redoEditingSessionInteraction(
    request: ChatRuntimeHostEditingSessionInteractionRequest,
  ): Promise<ChatRuntimeHostEditingSessionState>;
  buildEditingSessionNavigationPlan(
    request: ChatRuntimeHostEditingSessionNavigationRequest,
  ): Promise<ChatRuntimeHostEditingSessionNavigationPlan>;
  submitTurn(request: ChatRuntimeHostSubmitRequest): Promise<ChatRuntimeHostSessionState>;
  readSubmitReadiness(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostSubmitReadiness>;
  ensureSessionCanRerun(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostRerunReadiness>;
  stopTurn(request: ChatRuntimeHostSessionId | ChatRuntimeHostStopTurnRequest): Promise<void>;
  disposeSession(sessionId: ChatRuntimeHostSessionId): Promise<void>;
  readSessionState(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostSessionState | null>;
  readSessionInventory(): Promise<ChatRuntimeHostSessionInventorySnapshot>;
  readTranscript(sessionId: ChatRuntimeHostSessionId): Promise<ChatRuntimeHostTranscriptSnapshot | null>;
  readChatImageMedia(request: ChatRuntimeHostImageMediaRequest): Promise<ChatRuntimeHostImageMedia>;
  readSessionTurnPage(request: ChatRuntimeHostTurnPageRequest): Promise<ChatRuntimeHostTurnPage | null>;
  readCheckpointNavigationState(
    request: ChatRuntimeHostCheckpointNavigationRequest,
  ): Promise<ChatRuntimeHostCheckpointNavigationState | null>;
  mutateSessionRequestList(
    request: ChatRuntimeHostRequestListMutationRequest,
  ): Promise<ChatRuntimeHostRequestListMutationResult>;
  restoreSessionCheckpoint(
    request: ChatRuntimeHostCheckpointMutationRequest & {
      readonly checkpointId: string;
      readonly expectedRevision: number;
    },
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
