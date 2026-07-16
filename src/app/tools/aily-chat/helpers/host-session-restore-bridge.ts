import type { TurnRequest, TurnResponseTurn, SessionSnapshot } from 'aily-lex/browser';
import { DEFAULT_CHAT_SESSION_TYPE, normalizeChatSelectedMode, normalizeChatSessionType, normalizeChatSurfaceModeId } from '../core/chat-mode';
import {
  resolveChatAgentRuntimeModeForProject,
  readChatAgentRuntimeModeSourceFromMetadata,
  readChatAgentRuntimeModeFromMetadata,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';

import type {
  IAgentLifecycle,
  IChatCoordination,
  IChatServiceAccess,
  IChatViewAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import {
  buildHostProjectionStateFromPersistedRecord,
  type HostTurnResponseState,
} from './host-turn-response-state';
import { normalizeTurnResponseSummaryPreview } from './turn-response-response-model';
import {
  resolveHostSessionModeDescriptorFromMetadata,
  resolveHostSessionProviderOptions,
  resolveHostSessionSelectedModeFromMetadata,
} from './host-session-input-state';
import { cloneHostSessionRuntimeAuxiliary } from './host-session-runtime-auxiliary';
import { HostSessionContentProvider } from './host-session-content-provider';
import type { HostSessionContent } from './host-session-content-provider';
import { type ChatSessionTitleSource } from '../core/chat-session-title';
import { resolveHostSessionRequestRoutingSummary } from './host-session-request-routing';
import { normalizeHostSessionRequestRoutingSummary } from './host-session-request-routing';
import type { LexSessionStoredSnapshotState, ResolvedLexSessionRestorePlan } from './host-session-restore-resolver';
import {
  restoreSessionBoundaryTransaction,
  type SessionModelBoundaryTurnOwnerPolicyOptions,
} from './session-model-boundary-transaction';

import type { HostSessionRecord } from '../services/chat-history.service';
import type { ChatSessionRuntimeState } from '../services/chat-session-runtime-store.service';
import type { RequestCheckpointMetadata } from '../services/edit-checkpoint.service';
import type { AskUserAnswer, AskUserQuestion } from '../core/ask-user';
import type { ConfirmationPart, QuestionPart } from '../core/chat-parts';
import type { RuntimePlanReviewAction, RuntimePlanReviewDecision } from '../services/chat-runtime-interaction-host.service';
import type {
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
} from '../core/chat-runtime-host-contract';
import {
  createSessionCheckpointTimelineState,
  type SessionCheckpointTimelineState,
} from './session-checkpoint-timeline-model';

type LexInteractionAction = NonNullable<TurnRequest['metadata']>['interactionAction'];
type LexTurnContinuation = NonNullable<TurnResponseTurn['response']['continuation']>;
type LexSessionInteractionContinuation = NonNullable<
  NonNullable<SessionSnapshot['requestContext']>['interactionContinuation']
>;

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

const KNOWN_PLAN_REVIEW_ACTIONS: Readonly<Record<string, {
  readonly label: string;
  readonly description: string;
  readonly permissionLevel?: 'autopilot';
}>> = {
  autopilot: {
    label: 'Implement with Autopilot',
    description: 'Auto-approve all tool calls and continue until the task is done.',
    permissionLevel: 'autopilot',
  },
  autopilot_fleet: {
    label: 'Implement with Autopilot Fleet',
    description: 'Auto-approve all tool calls, including fleet management actions, and continue until the task is done.',
    permissionLevel: 'autopilot',
  },
  interactive: {
    label: 'Implement Plan',
    description: 'Implement the plan, asking for input and approval for each action.',
  },
  exit_only: {
    label: 'Approve Plan Only',
    description: 'Approve the plan without executing it. I will implement it myself.',
  },
};

function readInteractionPendingRecord(
  continuation: LexSessionInteractionContinuation | LexTurnContinuation | undefined,
): Record<string, unknown> | undefined {
  const pending = continuation?.pendingState;
  return pending && typeof pending === 'object' ? pending : undefined;
}

function resolveRestoredSessionTitle(sessionContent?: HostSessionContent | null): { text: string; source: ChatSessionTitleSource } {
  const persistedTitle = typeof sessionContent?.title === 'string'
    ? sessionContent.title.trim()
    : '';
  if (isMeaningfulRestoredSessionTitle(persistedTitle)) {
    return {
      text: persistedTitle,
      source: 'restored-custom',
    };
  }

  const fallbackDefaultTitle = deriveDefaultTitleFromTurnResponses(sessionContent?.hostRecord?.turnResponses);
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

function deriveDefaultTitleFromTurnResponses(turnResponses: readonly unknown[] | null | undefined): string {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return '';
  }

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
    && normalizedTitle !== '新会话'
    && normalizedTitle !== '新对话'
    && normalizedTitle !== '无标题会话';
}
type HostSessionRestoreContext = Pick<IChatViewAccess, 'scrollManager' | 'invalidateHostRequestGraph' | 'triggerSyncDetectChanges'>
  & Pick<IAgentLifecycle, 'toolCallingIteration'>
  & Pick<IProjectContext, 'currentMode' | 'currentModelName'>
  & Pick<ISessionAccess, 'sessionId' | 'conversationMessages' | 'chatService' | 'chatHistoryService'>
  & Pick<IChatServiceAccess, 'contextBudgetService' | 'ailyChatConfigService' | 'runtimeInteractionHost'>
  & Pick<IChatCoordination, 'lexStream'>
  & {
    getDevelopmentModePreferenceRuntimeMode?(): ChatAgentRuntimeMode | undefined;
    readSessionRuntimeState?(sessionId?: string | null): Readonly<ChatSessionRuntimeState> | undefined;
    projectRestoredRuntimeAuxiliary?(
      sessionId: string,
      auxiliary: HostSessionRecord['auxiliary'] | null | undefined,
    ): void;
    replaceSessionCheckpointTimelineState?(
      sessionId: string,
      state: SessionCheckpointTimelineState | null | undefined,
    ): void;
    readCurrentViewSessionResource?(): string | null;
    projectRestoredHostProjection?(
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      hostProjectionState: HostTurnResponseState,
      options: { readonly attachedView: boolean },
    ): void;
    replaceSessionModelTurnResponses?(
      sessionId: string,
      turnResponses: readonly TurnResponseTurn[],
      ownerPolicy?: SessionModelBoundaryTurnOwnerPolicyOptions,
    ): readonly TurnResponseTurn[] | null | undefined;
    resumeRestoredInteraction?(
      content: string,
      interactionAction: LexInteractionAction,
      options?: {
        readonly sessionId?: string | null;
        readonly requestMetadata?: TurnRequest['metadata'];
      },
    ): Promise<void>;
    restoreSharedHostProjectionState?(
      state: HostTurnResponseState | null,
      options: { readonly sessionId: string | null; readonly attachedView?: boolean },
    ): void;
    requestHostResourceOperation?(
      request: ChatRuntimeHostResourceOperationRequest,
    ): Promise<ChatRuntimeHostResourceOperationResult>;
  };

export interface RuntimeRestoreHostRecordRequest {
  readonly target: {
    readonly sessionId: string;
    readonly sessionType: string;
    readonly projectPath: string | null;
    readonly agentRuntimeMode?: ChatAgentRuntimeMode;
    readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
    readonly inputState?: HostSessionContent['inputState'];
  };
  readonly sessionContent: HostSessionContent;
  readonly hostRecord: HostSessionRecord | null;
}

export type HostSessionRestoreFailureKind =
  | 'host-record-session-mismatch'
  | 'restore-plan-apply-failed';

export interface HostSessionRestoreFailureDetails {
  readonly kind: HostSessionRestoreFailureKind;
  readonly sessionId: string;
  readonly hostRecordSessionId?: string;
  readonly storedSnapshotState?: LexSessionStoredSnapshotState;
}

export interface HostSessionRestoreOptions {
  readonly isCurrent?: () => boolean;
  readonly sessionId?: string | null;
  readonly preserveActiveResponseState?: boolean;
}

export interface HostSessionProjectionRestoreOptions {
  readonly isCurrent?: () => boolean;
}

export class HostSessionRestoreError extends Error {
  readonly details: HostSessionRestoreFailureDetails;

  constructor(message: string, details: HostSessionRestoreFailureDetails, cause?: unknown) {
    super(message);
    this.name = 'HostSessionRestoreError';
    this.details = details;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export function readHostSessionRestoreFailureDetails(error: unknown): HostSessionRestoreFailureDetails | null {
  return error instanceof HostSessionRestoreError ? error.details : null;
}

function buildSessionCheckpointTimelineStateFromHostRecord(
  hostRecord: HostSessionRecord,
  targetSessionId: string,
): SessionCheckpointTimelineState | null {
  const sidecar = hostRecord.sidecar?.checkpointRedoBranch;
  const marker = hostRecord.sidecar?.checkpointMarker;
  const targetResource = typeof targetSessionId === 'string' ? targetSessionId.trim() : '';
  const sidecarResource = typeof sidecar?.sessionResource === 'string'
    ? sidecar.sessionResource.trim()
    : '';
  const markerResource = typeof marker?.sessionResource === 'string'
    ? marker.sessionResource.trim()
    : '';
  const hasRedoBranch = sidecarResource === targetResource && Array.isArray(sidecar?.turnResponses);
  const hasCanonicalMarker = markerResource === targetResource && Array.isArray(hostRecord.turnResponses);
  if (!targetResource || (!hasRedoBranch && !hasCanonicalMarker)) {
    return null;
  }

  const checkpointMetadataMaps = hasRedoBranch
    ? buildCheckpointMetadataMapsFromSidecar(sidecar?.checkpoints, targetResource)
    : null;
  return createSessionCheckpointTimelineState({
    sessionResource: targetResource,
    turnResponses: (hasRedoBranch ? sidecar?.turnResponses : hostRecord.turnResponses) as unknown as readonly TurnResponseTurn[],
    currentCheckpointIndex: hasRedoBranch ? sidecar?.currentCheckpointIndex : marker?.currentCheckpointIndex,
    currentTurnResponseCount: hasRedoBranch ? sidecar?.currentTurnResponseCount : marker?.currentTurnResponseCount,
    ...(checkpointMetadataMaps ? {
      metadataByCheckpointId: checkpointMetadataMaps.metadataByCheckpointId,
      metadataByRequestId: checkpointMetadataMaps.metadataByRequestId,
      metadataByTurnId: checkpointMetadataMaps.metadataByTurnId,
    } : {}),
  });
}

function buildCheckpointMetadataMapsFromSidecar(
  checkpoints: unknown,
  targetSessionResource: string,
): {
  readonly metadataByCheckpointId: ReadonlyMap<string, RequestCheckpointMetadata>;
  readonly metadataByRequestId: ReadonlyMap<string, RequestCheckpointMetadata>;
  readonly metadataByTurnId: ReadonlyMap<string, RequestCheckpointMetadata>;
} | null {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return null;
  }

  const metadataByCheckpointId = new Map<string, RequestCheckpointMetadata>();
  const metadataByRequestId = new Map<string, RequestCheckpointMetadata>();
  const metadataByTurnId = new Map<string, RequestCheckpointMetadata>();
  for (const checkpoint of checkpoints) {
    if (!checkpoint || typeof checkpoint !== 'object') {
      return null;
    }
    const metadata = (checkpoint as { metadata?: unknown }).metadata;
    if (!isCompleteCheckpointMetadata(metadata, targetSessionResource)) {
      return null;
    }
    metadataByCheckpointId.set(metadata.checkpointId, metadata);
    metadataByRequestId.set(metadata.requestId, metadata);
    if (metadata.turnId) {
      metadataByTurnId.set(metadata.turnId, metadata);
    }
  }

  return {
    metadataByCheckpointId,
    metadataByRequestId,
    metadataByTurnId,
  };
}

function isCompleteCheckpointMetadata(
  metadata: unknown,
  targetSessionResource: string,
): metadata is RequestCheckpointMetadata {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  return record['source'] === 'request-metadata'
    && readStringProperty(record, 'checkpointId').length > 0
    && readStringProperty(record, 'requestId').length > 0
    && readStringProperty(record, 'sessionResource') === targetSessionResource
    && readStringProperty(record, 'checkpointNamespace') === `refs/sessions/${targetSessionResource}`
    && readStringProperty(record, 'checkpointRef').length > 0
    && typeof record['turnIndex'] === 'number'
    && Number.isFinite(record['turnIndex'])
    && hasCompleteAdditionalCheckpointRefs(record);
}

function readStringProperty(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function hasCompleteAdditionalCheckpointRefs(metadata: Record<string, unknown> | null): boolean {
  const additionalStartRefs = readStringRecord(metadata?.['additionalStartCheckpointRefs']);
  const additionalRefs = readStringRecord(metadata?.['additionalCheckpointRefs']);
  if (!additionalStartRefs) {
    return true;
  }

  if (!additionalRefs) {
    return false;
  }

  return Object.keys(additionalStartRefs).every(key => !!additionalRefs[key]);
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key.trim(), typeof item === 'string' ? item.trim() : ''] as const)
    .filter(([key, item]) => key.length > 0 && item.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Restores host-side persisted chat history back into the active UI/session state.
 *
 * Keeps host record application, Part reconstruction, lex restore handoff,
 * and post-restore host sync out of SessionLifecycleHelper.
 */
export class HostSessionRestoreBridge {
  private readonly hostSessionContentProvider: HostSessionContentProvider;

  constructor(private readonly ctx: HostSessionRestoreContext) {
    this.hostSessionContentProvider = new HostSessionContentProvider({
      get sessionId() {
        return ctx.sessionId;
      },
      get chatService() {
        return ctx.chatService as any;
      },
      get chatHistoryService() {
        return ctx.chatHistoryService as any;
      },
    });
  }

  async restore(
    hostRecord: HostSessionRecord,
    options: HostSessionRestoreOptions = {},
  ): Promise<void> {
    const isCurrent = options.isCurrent ?? (() => true);
    const targetSessionId = this.resolveRestoreTargetSessionId(hostRecord, options.sessionId);
    const sanitizedHostRecord = options.preserveActiveResponseState === true
      ? hostRecord
      : sanitizeHostRecordForRestore(hostRecord);
    this.assertHostRecordMatchesTargetSession(sanitizedHostRecord, targetSessionId);
    if (sanitizedHostRecord !== hostRecord) {
      this.persistRecoveredCancelledHostRecord(targetSessionId, sanitizedHostRecord);
    }

    const restorePlan: ResolvedLexSessionRestorePlan = {
      snapshot: null,
      turnResponses: [...(sanitizedHostRecord.turnResponses ?? [])],
      diagnostics: {
        sessionId: targetSessionId,
        storedSnapshotState: 'missing',
      },
    };

    try {
      const persistedTurnResponses = [...(restorePlan.turnResponses ?? sanitizedHostRecord.turnResponses ?? [])];
      const runtimeHostResponseState = this.resolveRuntimeHostProjectionState(targetSessionId, persistedTurnResponses);
      const initialTurnResponses = runtimeHostResponseState?.turnResponses
        ? [...runtimeHostResponseState.turnResponses]
        : persistedTurnResponses;
      const hostResponseState = runtimeHostResponseState
        ?? buildHostProjectionStateFromPersistedRecord({
          turnResponses: initialTurnResponses,
        });

      const shouldAttachVisibleProjection = isCurrent() && this.isVisibleRestoreTarget(targetSessionId);
      const transactionResult = await restoreSessionBoundaryTransaction(this.ctx, {
        sessionId: targetSessionId,
        turnResponses: initialTurnResponses,
        restorePlan,
        hostProjectionState: hostResponseState,
        hostRecord: sanitizedHostRecord,
        attachedView: shouldAttachVisibleProjection,
        hydrateVisibleTurnResponses: shouldAttachVisibleProjection,
      });
      const turnResponses = transactionResult.turnResponses;
      const restoredSnapshot = transactionResult.restoredLexSnapshot
        ? this.ctx.lexStream.session.snapshot?.(targetSessionId) ?? restorePlan?.snapshot ?? null
        : null;
      const restoredHostResponseState = transactionResult.hostProjectionState;
      this.ctx.projectRestoredRuntimeAuxiliary?.(targetSessionId, sanitizedHostRecord.auxiliary);
      this.ctx.replaceSessionCheckpointTimelineState?.(
        targetSessionId,
        buildSessionCheckpointTimelineStateFromHostRecord(sanitizedHostRecord, targetSessionId),
      );

      if (!shouldAttachVisibleProjection) {
        return;
      }

      this.restoreSessionMetadata(sanitizedHostRecord, targetSessionId);
      if (this.ctx.restoreSharedHostProjectionState) {
        this.ctx.restoreSharedHostProjectionState(restoredHostResponseState, {
          sessionId: targetSessionId,
          attachedView: true,
        });
      }
      await this.ctx.chatService.syncResolvedActiveModelAfterSuccessfulTurn?.(
        targetSessionId,
        restoredHostResponseState.turnResponses,
      );
      this.restorePendingRuntimeInteraction(targetSessionId, restoredHostResponseState.turnResponses);

      // Restore context budget: prefer persisted lex-derived values over local estimate
      const savedBudget = hostRecord.metadata?.contextBudget;
      if (savedBudget && savedBudget.maxContextTokens > 0 && savedBudget.currentTokens > 0) {
        this.ctx.contextBudgetService?.applyLexBudgetEvent(
          savedBudget.maxContextTokens,
          savedBudget.currentTokens,
          {
            usagePercent: savedBudget.usagePercent,
            systemTokens: savedBudget.systemTokens,
            baseSystemTokens: savedBudget.baseSystemTokens,
            instructionTokens: savedBudget.instructionTokens,
            skillTokens: savedBudget.skillTokens,
            toolsTokens: savedBudget.toolsTokens,
            toolSourceTokens: savedBudget.toolSourceTokens,
            messagesTokens: savedBudget.messagesTokens,
            toolResultsTokens: savedBudget.toolResultsTokens,
            messageCount: savedBudget.messageCount,
          },
        );
      } else {
        this.ctx.contextBudgetService?.refreshLocalEstimate(
          restoredSnapshot ? this.ctx.conversationMessages : [],
          this.ctx.lexStream.runtime.tools(),
        );
      }

      await this.restoreEditCheckpoints(
        targetSessionId,
        this.resolveRestoreWorkspaceRoot(sanitizedHostRecord, targetSessionId),
        restoredHostResponseState.turnResponses,
      );
      if (!isCurrent()) {
        return;
      }
      this.finalizeRestoreUi(Boolean(restoredSnapshot));
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      throw this.createRestoreFailure('restore-plan-apply-failed', targetSessionId, restorePlan, error);
    }
  }

  buildRuntimeRestoreHostRecord(request: RuntimeRestoreHostRecordRequest): HostSessionRecord | null {
    const runtimeState = this.ctx.readSessionRuntimeState?.(request.target.sessionId);
    if (!runtimeState) {
      return null;
    }

    const baseHostRecord = request.hostRecord;
    const baseMetadata = baseHostRecord?.metadata;
    const providerOptions = request.sessionContent.providerOptions;
    const projectPath = request.sessionContent.projectPathHint
      ?? providerOptions.folderPath
      ?? request.target.projectPath
      ?? baseMetadata?.projectPath
      ?? null;
    const mode = typeof request.sessionContent.metadata?.mode === 'string'
      ? normalizeChatSurfaceModeId(request.sessionContent.metadata.mode)
      : baseMetadata?.mode ?? this.ctx.currentMode;
    const requestRouting = request.sessionContent.metadata?.requestRouting
      ? normalizeHostSessionRequestRoutingSummary(
          request.sessionContent.metadata.requestRouting,
          request.sessionContent.metadata.mode ?? this.ctx.currentMode,
        )
      : baseMetadata?.requestRouting;
    const inputState = request.sessionContent.inputState
      ?? baseMetadata?.inputState
      ?? request.target.inputState;
    const now = Date.now();

    const durableTurnResponses = stableDurableTurnResponsesForRuntimeRestore(baseHostRecord?.turnResponses ?? []);
    const runtimeTurnResponses = Array.isArray(runtimeState.turnResponses)
      ? runtimeState.turnResponses
      : [];
    const fallbackTurnResponses = runtimeTurnResponses.length > 0
      ? runtimeTurnResponses
      : durableTurnResponses;
    const runtimeAuxiliary = cloneHostSessionRuntimeAuxiliary({
      ...(baseHostRecord?.auxiliary ?? {}),
      pendingFollowupRequests: runtimeState.pendingFollowupRequests,
      yieldRequested: runtimeState.yieldRequested === true,
    });

    return {
      ...(baseHostRecord?.sidecar ? { sidecar: baseHostRecord.sidecar } : {}),
      ...(runtimeAuxiliary ? { auxiliary: runtimeAuxiliary } : {}),
      turnResponses: [...fallbackTurnResponses],
      metadata: {
        sessionId: request.target.sessionId,
        title: request.sessionContent.title ?? baseMetadata?.title ?? '',
        sessionType: normalizeChatSessionType(
          request.sessionContent.sessionType ?? baseMetadata?.sessionType ?? request.target.sessionType,
          DEFAULT_CHAT_SESSION_TYPE,
        ),
        projectPath,
        createdAt: baseMetadata?.createdAt ?? now,
        updatedAt: now,
        mode,
        agentRuntimeMode: request.target.agentRuntimeMode
          ?? baseMetadata?.agentRuntimeMode
          ?? baseMetadata?.runtimeMode,
        agentRuntimeModeSource: request.target.agentRuntimeModeSource
          ?? baseMetadata?.agentRuntimeModeSource
          ?? baseMetadata?.runtimeModeSource,
        ...(baseMetadata?.modeDescriptor ? { modeDescriptor: baseMetadata.modeDescriptor } : {}),
        ...(inputState ? { inputState } : {}),
        ...(requestRouting ? { requestRouting } : {}),
        ...(baseMetadata?.interactionActionSummary
          ? { interactionActionSummary: baseMetadata.interactionActionSummary }
          : {}),
        model: baseMetadata?.model ?? this.ctx.currentModelName,
        ...(baseMetadata?.contextBudget ? { contextBudget: baseMetadata.contextBudget } : {}),
        ...(baseMetadata?.requestContext ? { requestContext: baseMetadata.requestContext } : {}),
        ...(baseMetadata?.activeSkillNames ? { activeSkillNames: baseMetadata.activeSkillNames } : {}),
        toolCallingIteration: baseMetadata?.toolCallingIteration ?? this.ctx.toolCallingIteration ?? 0,
      },
    };
  }

  async restoreSessionProjection(
    sessionId: string | null | undefined,
    projectPathHint?: string | null,
    options: HostSessionProjectionRestoreOptions = {},
  ): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const indexEntry = this.ctx.chatHistoryService.findEntry(targetSessionId) ?? null;
    const sessionContent = this.hostSessionContentProvider.provideChatSessionContent(targetSessionId, projectPathHint, {
      metadataFallback: indexEntry,
    });
    const runtimeHostRecord = this.buildRuntimeRestoreHostRecord({
      target: {
        sessionId: targetSessionId,
        sessionType: sessionContent.sessionType,
        projectPath: sessionContent.projectPathHint
          ?? sessionContent.providerOptions.folderPath
          ?? indexEntry?.projectPath
          ?? null,
        agentRuntimeMode: readChatAgentRuntimeModeFromMetadata(sessionContent.metadata)
          ?? indexEntry?.agentRuntimeMode,
        agentRuntimeModeSource: readChatAgentRuntimeModeSourceFromMetadata(sessionContent.metadata)
          ?? indexEntry?.agentRuntimeModeSource,
        inputState: sessionContent.inputState,
      },
      sessionContent,
      hostRecord: sessionContent.hostRecord,
    });
    const hostRecord = runtimeHostRecord ?? sessionContent.hostRecord;
    if (!hostRecord) {
      return false;
    }

    await this.restore(hostRecord, {
      sessionId: targetSessionId,
      isCurrent: options.isCurrent,
      preserveActiveResponseState: !!runtimeHostRecord,
    });
    return true;
  }

  private persistRecoveredCancelledHostRecord(
    sessionId: string,
    hostRecord: HostSessionRecord,
  ): void {
    try {
      this.ctx.chatHistoryService.saveHostRecord?.({
        sessionId,
        metadata: hostRecord.metadata,
        ...(hostRecord.turnResponses ? { turnResponses: hostRecord.turnResponses } : {}),
        ...(hostRecord.sidecar ? { sidecar: hostRecord.sidecar } : {}),
        ...(hostRecord.auxiliary ? { auxiliary: hostRecord.auxiliary } : {}),
      });
      console.info('[AilyChat][ActiveTurnDurability]', {
        phase: 'recovered-cancelled',
        sessionId,
        turnCount: hostRecord.turnResponses?.length ?? 0,
      });
    } catch (error) {
      console.warn('[AilyChat][ActiveTurnDurability] recovered-cancelled persistence failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveRestoreTargetSessionId(hostRecord: HostSessionRecord, requestedSessionId?: string | null): string {
    const explicitSessionId = typeof requestedSessionId === 'string' ? requestedSessionId.trim() : '';
    const hostRecordSessionId = typeof hostRecord.metadata?.sessionId === 'string'
      ? hostRecord.metadata.sessionId.trim()
      : '';
    return explicitSessionId || hostRecordSessionId;
  }

  private assertHostRecordMatchesTargetSession(hostRecord: HostSessionRecord, targetSessionId: string): void {
    const hostRecordSessionId = typeof hostRecord.metadata?.sessionId === 'string'
      ? hostRecord.metadata.sessionId.trim()
      : '';
    if (!targetSessionId || !hostRecordSessionId || targetSessionId === hostRecordSessionId) {
      return;
    }

    const details: HostSessionRestoreFailureDetails = {
      kind: 'host-record-session-mismatch',
      sessionId: targetSessionId,
      hostRecordSessionId,
    };
    throw new HostSessionRestoreError(
      `[HostSessionRestoreBridge] Restore target mismatch (${formatHostSessionRestoreFailureDetails(details)})`,
      details,
    );
  }

  private createRestoreFailure(
    kind: HostSessionRestoreFailureKind,
    sessionId: string,
    restorePlan: ResolvedLexSessionRestorePlan | null,
    cause: unknown,
  ): HostSessionRestoreError {
    const details: HostSessionRestoreFailureDetails = {
      kind,
      sessionId,
      ...(restorePlan?.diagnostics?.storedSnapshotState
        ? { storedSnapshotState: restorePlan.diagnostics.storedSnapshotState }
        : {}),
    };
    return new HostSessionRestoreError(
      `[HostSessionRestoreBridge] Restore failed (${formatHostSessionRestoreFailureDetails(details)}): ${toHostSessionRestoreErrorMessage(cause)}`,
      details,
      cause,
    );
  }

  private resolveRuntimeHostProjectionState(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): HostTurnResponseState | null {
    const runtimeState = this.ctx.readSessionRuntimeState?.(sessionId);
    const hostProjectionState = runtimeState?.hostProjectionState;
    if (!hostProjectionState) {
      return null;
    }

    return areHostProjectionTurnResponsesEquivalent(hostProjectionState.turnResponses, turnResponses)
      ? hostProjectionState
      : null;
  }

  private restoreSessionMetadata(hostRecord: HostSessionRecord, sessionId: string): void {
    const indexEntry = this.ctx.chatHistoryService.findEntry(sessionId);
    const sessionContent = this.hostSessionContentProvider.provideChatSessionContent(sessionId, undefined, {
      hostRecordOverride: hostRecord,
      metadataFallback: indexEntry,
    });
    const sessionMetadata = {
      mode: hostRecord.metadata?.mode ?? indexEntry?.mode,
      agentRuntimeMode: hostRecord.metadata?.agentRuntimeMode ?? indexEntry?.agentRuntimeMode,
      runtimeMode: hostRecord.metadata?.runtimeMode ?? indexEntry?.runtimeMode,
      agentRuntimeModeSource: hostRecord.metadata?.agentRuntimeModeSource ?? indexEntry?.agentRuntimeModeSource,
      runtimeModeSource: hostRecord.metadata?.runtimeModeSource ?? indexEntry?.runtimeModeSource,
      modeDescriptor: hostRecord.metadata?.modeDescriptor ?? indexEntry?.modeDescriptor,
      inputState: hostRecord.metadata?.inputState ?? indexEntry?.inputState,
      requestRouting: hostRecord.metadata?.requestRouting ?? indexEntry?.requestRouting,
      interactionActionSummary: hostRecord.metadata?.interactionActionSummary,
      sessionType: hostRecord.metadata?.sessionType ?? indexEntry?.sessionType,
      projectPath: hostRecord.metadata?.projectPath ?? indexEntry?.projectPath,
    };

    applyCurrentSessionTitle(this.ctx.chatService, resolveRestoredSessionTitle(sessionContent));

    const sessionType = normalizeChatSessionType(
      sessionContent?.sessionType ?? sessionMetadata?.sessionType,
      DEFAULT_CHAT_SESSION_TYPE,
    );
    const providerOptions = sessionContent?.providerOptions ?? resolveHostSessionProviderOptions(hostRecord);
    this.ctx.chatService.applySessionIdentity({
      sessionType,
      providerOptions,
      inputState: sessionContent?.inputState ?? sessionMetadata?.inputState,
    });
    const runtimeResolution = resolveChatAgentRuntimeModeForProject({
      projectPath: providerOptions.folderPath ?? sessionMetadata.projectPath ?? null,
      metadata: sessionMetadata,
      userPreferenceMode: this.ctx.getDevelopmentModePreferenceRuntimeMode?.(),
      fallback: providerOptions.folderPath ? 'coder' : 'unbound',
      requireExistingProjectPath: Boolean(providerOptions.folderPath),
    });
    if (typeof this.ctx.chatService.setCurrentAgentRuntimeMode === 'function') {
      this.ctx.chatService.setCurrentAgentRuntimeMode(runtimeResolution.mode, runtimeResolution.source);
    } else {
      this.ctx.chatService.currentAgentRuntimeMode = runtimeResolution.mode;
      this.ctx.chatService.currentAgentRuntimeModeSource = runtimeResolution.source;
    }

    const resolveModeById = (modeId: string) => typeof this.ctx.chatService.findResolvedModeById === 'function'
      ? this.ctx.chatService.findResolvedModeById(modeId)
      : undefined;
    const resolveModeByName = (modeName: string) => typeof this.ctx.chatService.findResolvedModeByName === 'function'
      ? this.ctx.chatService.findResolvedModeByName(modeName)
      : undefined;
    const hasSessionPickerMetadata = !!sessionMetadata?.modeDescriptor
      || !!sessionMetadata?.inputState
      || !!sessionMetadata?.requestRouting;
    const mergedSelectedMode = hasSessionPickerMetadata
      ? resolveHostSessionSelectedModeFromMetadata({
          mode: sessionMetadata?.mode,
          modeDescriptor: sessionMetadata?.modeDescriptor,
          inputState: sessionMetadata?.inputState,
          requestRouting: sessionMetadata?.requestRouting,
        }, { resolveModeById, resolveModeByName })
      : normalizeChatSelectedMode({
          modeId: resolveHostSessionRequestRoutingSummary(hostRecord).selectedModeId,
          customAgentTarget: resolveHostSessionRequestRoutingSummary(hostRecord).customAgentTarget,
        });
    const storedModeDescriptor = hasSessionPickerMetadata
      ? resolveHostSessionModeDescriptorFromMetadata({
          mode: sessionMetadata?.mode,
          modeDescriptor: sessionMetadata?.modeDescriptor,
          inputState: sessionMetadata?.inputState,
          requestRouting: sessionMetadata?.requestRouting,
        }, { resolveModeById, resolveModeByName })
      : undefined;
    const storedModeId = typeof storedModeDescriptor?.id === 'string' && storedModeDescriptor.id.trim().length > 0
      ? storedModeDescriptor.id.trim()
      : typeof sessionMetadata?.inputState?.mode?.id === 'string'
        ? sessionMetadata.inputState.mode.id.trim()
      : '';
    if (mergedSelectedMode.modeId === 'plan') {
      if (typeof this.ctx.chatService.setSelectedMode === 'function') {
        this.ctx.chatService.setSelectedMode({ modeId: 'plan' }, { persist: false });
      } else if (typeof this.ctx.chatService.setChatMode === 'function') {
        this.ctx.chatService.setChatMode('plan', false);
      } else {
        this.ctx.chatService.currentMode = 'plan';
        this.ctx.chatService.currentCustomAgentTarget = undefined;
      }
    } else if (storedModeId && typeof this.ctx.chatService.setChatMode === 'function') {
      this.ctx.chatService.setChatMode(storedModeId, false);
      if (mergedSelectedMode.modeId === 'agent'
        && mergedSelectedMode.customAgentTarget
        && this.ctx.chatService.currentCustomAgentTarget !== mergedSelectedMode.customAgentTarget
        && typeof this.ctx.chatService.setSelectedMode === 'function') {
        this.ctx.chatService.setSelectedMode(
          {
            modeId: mergedSelectedMode.modeId,
            customAgentTarget: mergedSelectedMode.customAgentTarget,
          },
          { persist: false },
        );
      }
    } else if (typeof this.ctx.chatService.setSelectedMode === 'function') {
      this.ctx.chatService.setSelectedMode(
        {
          modeId: mergedSelectedMode.modeId,
          customAgentTarget: mergedSelectedMode.customAgentTarget,
        },
        { persist: false },
      );
    } else {
      this.ctx.chatService.currentMode = mergedSelectedMode.modeId;
      this.ctx.chatService.currentCustomAgentTarget = mergedSelectedMode.modeId === 'agent'
        ? mergedSelectedMode.customAgentTarget
        : undefined;
    }

    this.ctx.toolCallingIteration = hostRecord.metadata?.toolCallingIteration || 0;
  }

  private resolveRestoreWorkspaceRoot(hostRecord: HostSessionRecord, sessionId: string): string | null {
    const metadataProjectPath = typeof hostRecord.metadata?.projectPath === 'string'
      ? hostRecord.metadata.projectPath.trim()
      : '';
    if (metadataProjectPath) {
      return metadataProjectPath;
    }

    const indexProjectPath = this.ctx.chatHistoryService.findEntry(sessionId)?.projectPath;
    return typeof indexProjectPath === 'string' && indexProjectPath.trim()
      ? indexProjectPath.trim()
      : null;
  }

  private async restoreEditCheckpoints(
    sessionId: string,
    workspaceRoot: string | null,
    turnResponses: readonly TurnResponseTurn[],
  ): Promise<void> {
    const requestHostResourceOperation = this.ctx.requestHostResourceOperation;
    if (typeof requestHostResourceOperation !== 'function') {
      throw new Error('[AilyChat][Restore] Runtime host resource operation bridge is required to restore edit tracking state.');
    }
    await requestHostResourceOperation({
      sessionId,
      kind: 'edit-tracking',
      label: 'Restoring edit tracking timeline',
      resource: {
        workspaceRoot,
      },
      payload: {
        adapter: 'editTracking',
        action: 'restoreFromTurnResponses',
        workspaceRoot,
        turnResponses,
        autoSaveEdits: this.ctx.ailyChatConfigService.autoSaveEdits === true,
      },
    });
  }

  private finalizeRestoreUi(_restoredLexSession: boolean): void {
    this.ctx.scrollManager.scrollToBottom('auto');
  }

  private restorePendingRuntimeInteraction(sessionId: string, turnResponses: readonly TurnResponseTurn[]): void {
    const interactionContinuation = this.ctx.lexStream.session.snapshot(sessionId)?.requestContext?.interactionContinuation
      ?? findPendingInteractionContinuation(turnResponses);
    const pending = readInteractionPendingRecord(interactionContinuation);
    if (!pending || pending['kind'] === 'none') {
      return;
    }
    if (!hasRestoredActiveInteractionResponse(turnResponses)) {
      return;
    }

    if (pending['kind'] === 'question') {
      this.restorePendingQuestion(sessionId, turnResponses);
      return;
    }

    if (pending['kind'] === 'confirmation') {
      this.restorePendingConfirmation(sessionId, turnResponses, interactionContinuation!);
      return;
    }

    if (pending['kind'] === 'plan_review') {
      this.restorePendingPlanReview(sessionId, interactionContinuation!);
    }
  }

  private isVisibleRestoreTarget(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = typeof this.ctx.readCurrentViewSessionResource === 'function'
      ? this.ctx.readCurrentViewSessionResource()
      : null;
    const currentViewSessionId = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    if (currentViewSessionId) {
      return currentViewSessionId === targetSessionId;
    }

    return false;
  }

  private restorePendingQuestion(sessionId: string, turnResponses: readonly TurnResponseTurn[]): void {
    const questionPart = findPendingQuestionPart(turnResponses);
    if (!questionPart?.partId) {
      return;
    }

    const questions = questionPart.questions.map<AskUserQuestion>((question) => ({
      question: question.question,
      options: question.options?.map(option => ({
        label: option.label,
        description: option.description,
        recommended: option.recommended,
      })),
      allow_freeform: question.allow_freeform,
      multi_select: question.multi_select,
    }));

    void this.ctx.runtimeInteractionHost.presentQuestion(sessionId, questionPart.partId, questions)
      .then(async (result) => {
        if (!result?.answers) {
          return;
        }

        this.ctx.lexStream.ui.updateQuestionAnswers(result.answers, questionPart.partId!);
        await this.ctx.resumeRestoredInteraction?.(
          buildQuestionAnswerResumeContent(result.answers),
          {
            kind: 'question_answer',
            payload: { answers: result.answers },
          },
          {
            sessionId,
          },
        );
      })
      .catch(() => undefined);
  }

  private restorePendingConfirmation(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    continuation: LexTurnContinuation,
  ): void {
    const confirmationPart = findPendingConfirmationPart(turnResponses, continuation);
    if (!confirmationPart?.partId) {
      return;
    }

    void this.ctx.runtimeInteractionHost.presentConfirmation(sessionId, {
      askId: confirmationPart.askId,
      partId: confirmationPart.partId,
      toolName: confirmationPart.toolName,
      title: confirmationPart.title,
      subtitle: confirmationPart.subtitle,
      message: confirmationPart.message,
      args: isRecord(confirmationPart.args) ? confirmationPart.args : undefined,
      actions: Array.isArray(confirmationPart.actions) ? confirmationPart.actions : [],
      primaryScope: confirmationPart.primaryScope ?? 'once',
    })
      .then(async (result) => {
        this.ctx.lexStream.ui.resolveConfirmation(
          confirmationPart.partId!,
          confirmationPart.askId,
          result.approved,
          result.scope,
        );
        await this.ctx.resumeRestoredInteraction?.(
          buildConfirmationResumeContent(confirmationPart, result.approved),
          buildConfirmationInteractionAction(continuation, confirmationPart, result),
          {
            sessionId,
          },
        );
      })
      .catch(() => undefined);
  }

  private restorePendingPlanReview(
    sessionId: string,
    continuation: LexTurnContinuation,
  ): void {
    const pendingReview = readPendingPlanReview(continuation);
    if (!pendingReview) {
      return;
    }

    void this.ctx.runtimeInteractionHost.presentPlanReview(sessionId, pendingReview)
      .then(async (result) => {
        await this.ctx.resumeRestoredInteraction?.(
          buildPlanReviewResumeContent(pendingReview, result),
          buildPlanReviewInteractionAction(continuation, result),
          {
            sessionId,
          },
        );
      })
      .catch(() => undefined);
  }
}

function areHostProjectionTurnResponsesEquivalent(
  left: readonly TurnResponseTurn[] | null | undefined,
  right: readonly TurnResponseTurn[] | null | undefined,
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftTurn = left[index];
    const rightTurn = right[index];
    if (leftTurn.turnId !== rightTurn.turnId || leftTurn.updatedAt !== rightTurn.updatedAt) {
      return false;
    }
  }

  return true;
}

function formatHostSessionRestoreFailureDetails(details: HostSessionRestoreFailureDetails): string {
  return [
    `kind=${details.kind}`,
    `sessionId=${details.sessionId || 'unknown'}`,
    ...(details.hostRecordSessionId ? [`hostRecordSessionId=${details.hostRecordSessionId}`] : []),
    ...(details.storedSnapshotState ? [`storedSnapshotState=${details.storedSnapshotState}`] : []),
  ].join(', ');
}

function toHostSessionRestoreErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'unknown error';
}

function sanitizeHostRecordForRestore(hostRecord: HostSessionRecord): HostSessionRecord {
  if (!hostRecord.turnResponses?.length) {
    return hostRecord;
  }

  const hasTransientRestoreState = hostRecord.turnResponses.some(turn =>
    isTransientTurnResponseStatus(turn.response.status)
    || turn.response.parts.some(part => isTransientRuntimeStatePart(part))
    || hasTerminalPlanReviewContinuation(turn),
  );
  if (!hasTransientRestoreState) {
    return hostRecord;
  }

  return {
    ...hostRecord,
    turnResponses: hostRecord.turnResponses.map(turn => {
      const hasTransientRuntimeState = turn.response.parts.some(part => isTransientRuntimeStatePart(part));
      if (!isTransientTurnResponseStatus(turn.response.status)
        && !hasTransientRuntimeState
        && !hasTerminalPlanReviewContinuation(turn)) {
        return turn;
      }

      return sanitizeTurnResponseForRestore(turn);
    }),
  };
}

function stableDurableTurnResponsesForRuntimeRestore(
  turnResponses: readonly TurnResponseTurn[],
): readonly TurnResponseTurn[] {
  return turnResponses.filter(turn =>
    !isTransientTurnResponseStatus(turn.response.status)
    && !isPendingInteractionContinuation(turn.response.continuation)
  );
}

function isTransientTurnResponseStatus(status: unknown): boolean {
  switch (typeof status === 'string' ? status.trim().toLowerCase() : '') {
    case 'streaming':
    case 'in_progress':
    case 'pending':
    case 'needs_input':
    case 'waiting_question':
    case 'waiting_confirmation':
    case 'waiting_tool_results':
    case 'waiting_plan_review':
      return true;
    default:
      return false;
  }
}

function sanitizeTurnResponseForRestore(turn: TurnResponseTurn): TurnResponseTurn {
  const clonedTurn = cloneJsonLikeValue(turn);
  const timestamp = Date.now();
  const responseStatus = isTransientTurnResponseStatus(clonedTurn.response.status)
    || isPendingInteractionContinuation(clonedTurn.response.continuation)
    ? 'cancelled'
    : clonedTurn.response.status;
  const continuation = sanitizeTerminalPlanReviewContinuation(
    responseStatus,
    clonedTurn.response.parts,
    clonedTurn.response.continuation,
  );
  const nextParts = clonedTurn.response.parts
    .filter(part => !isTransientRuntimeStatePart(part))
    .map(part => cancelOpenResponsePartForRestore(part, timestamp));
  const updatedAt = Math.max(
    typeof clonedTurn.updatedAt === 'number' ? clonedTurn.updatedAt : 0,
    typeof clonedTurn.response.updatedAt === 'number' ? clonedTurn.response.updatedAt : 0,
    timestamp,
  );

  return {
    ...clonedTurn,
    updatedAt,
    response: {
      ...clonedTurn.response,
      status: responseStatus,
      updatedAt,
      ...(responseStatus === 'cancelled' ? { modelState: { value: 2, completedAt: updatedAt } } : {}),
      ...(continuation && responseStatus !== 'cancelled' ? { continuation } : { continuation: undefined }),
      parts: nextParts,
    },
  };
}

function cancelOpenResponsePartForRestore(
  part: TurnResponseTurn['response']['parts'][number],
  timestamp: number,
): TurnResponseTurn['response']['parts'][number] {
  const record = part as unknown as Record<string, unknown>;
  switch (part.type) {
    case 'tool_call': {
      if (!isOpenRuntimeState(record['state'] ?? record['status'])) {
        return part;
      }
      return {
        ...part,
        state: 'error',
        metadata: {
          ...(record['metadata'] && typeof record['metadata'] === 'object'
            ? record['metadata'] as Record<string, unknown>
            : {}),
          phase: 'cancelled',
          cancelledAt: timestamp,
        },
      } as TurnResponseTurn['response']['parts'][number];
    }
    case 'terminal': {
      if (record['isRunning'] !== true && !isOpenRuntimeState(record['status'])) {
        return part;
      }
      return {
        ...part,
        isRunning: false,
        status: 'cancelled',
        metadata: {
          ...(record['metadata'] && typeof record['metadata'] === 'object'
            ? record['metadata'] as Record<string, unknown>
            : {}),
          cancelledAt: timestamp,
        },
      } as TurnResponseTurn['response']['parts'][number];
    }
    case 'confirmation': {
      if (record['resolved'] === true) {
        return part;
      }
      return {
        ...part,
        resolved: true,
        result: 'rejected',
        metadata: {
          ...(record['metadata'] && typeof record['metadata'] === 'object'
            ? record['metadata'] as Record<string, unknown>
            : {}),
          cancelledAt: timestamp,
        },
      } as TurnResponseTurn['response']['parts'][number];
    }
    case 'question': {
      if (record['answers'] && typeof record['answers'] === 'object') {
        return part;
      }
      return {
        ...part,
        metadata: {
          ...(record['metadata'] && typeof record['metadata'] === 'object'
            ? record['metadata'] as Record<string, unknown>
            : {}),
          cancelledAt: timestamp,
        },
      } as TurnResponseTurn['response']['parts'][number];
    }
    case 'thinking': {
      if (record['isComplete'] === true) {
        return part;
      }
      return {
        ...part,
        isComplete: true,
      } as TurnResponseTurn['response']['parts'][number];
    }
    case 'plan': {
      if (record['status'] !== 'streaming') {
        return part;
      }
      return {
        ...part,
        status: 'failed',
      } as TurnResponseTurn['response']['parts'][number];
    }
    default:
      return part;
  }
}

function isOpenRuntimeState(value: unknown): boolean {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case '':
    case 'pending':
    case 'running':
    case 'doing':
    case 'reviewing':
    case 'in_progress':
    case 'waiting':
    case 'waiting_confirmation':
    case 'waiting_question':
    case 'waiting_tool_results':
    case 'waiting_plan_review':
      return true;
    default:
      return false;
  }
}

function hasTerminalPlanReviewContinuation(turn: TurnResponseTurn): boolean {
  return isTerminalTurnResponseStatus(turn.response.status)
    && turn.response.parts.some(part => part.type === 'plan')
    && isPlanReviewContinuation(turn.response.continuation);
}

function sanitizeTerminalPlanReviewContinuation(
  responseStatus: unknown,
  parts: readonly TurnResponseTurn['response']['parts'][number][],
  continuation: TurnResponseTurn['response']['continuation'] | undefined,
): TurnResponseTurn['response']['continuation'] | undefined {
  if (!isTerminalTurnResponseStatus(responseStatus)
    || !parts.some(part => part.type === 'plan')
    || !isPlanReviewContinuation(continuation)) {
    return continuation;
  }

  const sanitized = cloneJsonLikeValue(continuation) as unknown as Record<string, unknown>;
  delete sanitized['status'];
  delete sanitized['pendingState'];
  return Object.keys(sanitized).length > 0
    ? sanitized as unknown as TurnResponseTurn['response']['continuation']
    : undefined;
}

function isTerminalTurnResponseStatus(status: unknown): boolean {
  switch (typeof status === 'string' ? status.trim().toLowerCase() : '') {
    case 'completed':
    case 'cancelled':
    case 'canceled':
    case 'failed':
    case 'error':
      return true;
    default:
      return false;
  }
}

function isPlanReviewContinuation(continuation: unknown): boolean {
  if (!continuation || typeof continuation !== 'object') {
    return false;
  }

  const record = continuation as Record<string, unknown>;
  const status = typeof record['status'] === 'string' ? record['status'].trim().toLowerCase() : '';
  if (status === 'waiting_plan_review' || status === 'plan_review') {
    return true;
  }

  const pendingState = record['pendingState'];
  return !!pendingState
    && typeof pendingState === 'object'
    && typeof (pendingState as Record<string, unknown>)['kind'] === 'string'
    && ((pendingState as Record<string, unknown>)['kind'] as string).trim().toLowerCase() === 'plan_review';
}

function isPendingInteractionContinuation(continuation: unknown): boolean {
  if (!continuation || typeof continuation !== 'object') {
    return false;
  }

  const record = continuation as Record<string, unknown>;
  const status = typeof record['status'] === 'string' ? record['status'].trim().toLowerCase() : '';
  if (
    status === 'waiting_plan_review'
    || status === 'plan_review'
    || status === 'waiting_confirmation'
    || status === 'waiting_question'
    || status === 'waiting_tool_results'
  ) {
    return true;
  }

  const pendingState = record['pendingState'];
  return !!pendingState && typeof pendingState === 'object';
}

function hasRestoredActiveInteractionResponse(turnResponses: readonly TurnResponseTurn[]): boolean {
  return turnResponses.some(turn =>
    isTransientTurnResponseStatus(turn.response.status)
    || isPendingInteractionContinuation(turn.response.continuation)
    || hasPendingInteractionPart(turn.response.parts)
  );
}

function findPendingInteractionContinuation(turnResponses: readonly TurnResponseTurn[]): LexTurnContinuation | undefined {
  for (let turnIndex = turnResponses.length - 1; turnIndex >= 0; turnIndex--) {
    const continuation = turnResponses[turnIndex]?.response?.continuation;
    if (isPendingInteractionContinuation(continuation)) {
      return continuation;
    }
  }

  return undefined;
}

function hasPendingInteractionPart(parts: readonly TurnResponseTurn['response']['parts'][number][] | null | undefined): boolean {
  if (!Array.isArray(parts)) {
    return false;
  }

  return parts.some(part => {
    if (!part || typeof part !== 'object') {
      return false;
    }
    if (part.type === 'question') {
      return !('answers' in part) || part.answers == null;
    }
    if (part.type === 'confirmation') {
      return part.resolved !== true;
    }
    if (part.type === 'plan_review') {
      return part.resolved !== true;
    }
    return false;
  });
}

function cloneJsonLikeValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneJsonLikeValue(item)) as T;
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, cloneJsonLikeValue(entryValue)]),
    ) as T;
  }

  return value;
}

function isTransientRuntimeStatePart(
  part: TurnResponseTurn['response']['parts'][number],
): boolean {
  return part.type === 'state'
    && (part.kind === 'compaction' || part.kind === 'provider_context_management');
}

function cloneSessionSnapshotRounds(
  snapshotRounds: readonly NonNullable<SessionSnapshot['turns']>[number]['rounds'][number][],
  fallbackRounds: TurnResponseTurn['rounds'],
): TurnResponseTurn['rounds'] {
  if (snapshotRounds.length === 0) {
    return [...fallbackRounds];
  }

  return snapshotRounds.map((round) => {
    const summary = normalizeTurnResponseSummaryPreview(round.summary);

    return {
      ...round,
      toolCalls: (round.toolCalls ?? []).map(toolCall => ({ ...toolCall })),
      ...(summary ? { summary } : {}),
    };
  });
}

function findPendingQuestionPart(turnResponses: readonly TurnResponseTurn[]): QuestionPart | null {
  for (let turnIndex = turnResponses.length - 1; turnIndex >= 0; turnIndex--) {
    const parts = turnResponses[turnIndex]?.response?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex] as Partial<QuestionPart> | undefined;
      if (part?.type !== 'question' || !Array.isArray(part.questions) || part.answers) {
        continue;
      }
      return part as QuestionPart;
    }
  }

  return null;
}

function findPendingConfirmationPart(
  turnResponses: readonly TurnResponseTurn[],
  continuation: LexTurnContinuation,
): ConfirmationPart | null {
  const pendingRecord = readInteractionPendingRecord(continuation);
  const pendingRequestId = typeof pendingRecord?.['requestId'] === 'string'
    ? pendingRecord['requestId']
    : undefined;

  for (let turnIndex = turnResponses.length - 1; turnIndex >= 0; turnIndex--) {
    const parts = turnResponses[turnIndex]?.response?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
      const part = parts[partIndex] as Partial<ConfirmationPart> | undefined;
      if (part?.type !== 'confirmation' || part.resolved === true || typeof part.askId !== 'string') {
        continue;
      }

      if (pendingRequestId && part.askId !== pendingRequestId) {
        continue;
      }

      return part as ConfirmationPart;
    }
  }

  return null;
}

function buildQuestionAnswerResumeContent(answers: Record<string, AskUserAnswer>): string {
  const summary = Object.entries(answers)
    .map(([question, answer]) => {
      const parts = [
        ...answer.selected,
        ...(typeof answer.freeText === 'string' && answer.freeText.trim().length > 0 ? [answer.freeText.trim()] : []),
      ];
      const answerText = answer.skipped ? '已跳过' : (parts.join('，') || '已回答');
      return `${question}: ${answerText}`;
    })
    .filter(text => text.length > 0)
    .join('；');

  return summary.length > 0 ? `已回答问题：${summary}` : '已回答问题。';
}

function buildConfirmationResumeContent(part: ConfirmationPart, approved: boolean): string {
  const action = approved ? '已确认' : '已拒绝';
  const target = typeof part.toolName === 'string' && part.toolName.length > 0
    ? `${action}执行 ${part.toolName}。`
    : `${action}继续当前确认。`;
  return target;
}

function buildConfirmationInteractionAction(
  continuation: LexTurnContinuation,
  part: ConfirmationPart,
  result: { approved: boolean; scope?: string; reason?: string; actionId?: string },
): LexInteractionAction {
  const pendingRecord = readInteractionPendingRecord(continuation);
  const payload: Record<string, unknown> = {
    result: result.approved ? 'approved' : 'rejected',
    source: pendingRecord?.['sourceEvent'] === 'approval_request' ? 'approval' : 'confirmation',
    ...(typeof part.toolName === 'string' && part.toolName.length > 0 ? { toolName: part.toolName } : {}),
    ...(typeof pendingRecord?.['toolCallId'] === 'string' ? { toolCallId: pendingRecord['toolCallId'] } : {}),
    ...(typeof result.scope === 'string' ? { scope: result.scope } : {}),
    ...(typeof result.reason === 'string' && result.reason.length > 0 ? { reason: result.reason } : {}),
    ...(typeof result.actionId === 'string' && result.actionId.length > 0 ? { actionId: result.actionId } : {}),
  };

  return {
    kind: 'confirmation',
    payload,
  };
}

export function readPendingPlanReview(
  continuation: LexSessionInteractionContinuation | LexTurnContinuation | undefined,
): {
  id: string;
  title: string;
  planUri?: string;
  content: string;
  actions: readonly RuntimePlanReviewAction[];
  canProvideFeedback: boolean;
} | null {
  const pendingRecord = readInteractionPendingRecord(continuation);
  if (pendingRecord?.['kind'] !== 'plan_review') {
    return null;
  }

  const id = readNonEmptyString(pendingRecord['requestId']) ?? readNonEmptyString(pendingRecord['id']);
  const content = readNonEmptyString(pendingRecord['content']);
  const actions = Array.isArray(pendingRecord['actions'])
    ? pendingRecord['actions'].map(toRuntimePlanReviewAction).filter((action): action is RuntimePlanReviewAction => !!action)
    : [];

  if (!id || !content || actions.length === 0) {
    return null;
  }

  return {
    id,
    title: readNonEmptyString(pendingRecord['title']) ?? 'Review Plan',
    ...(readNonEmptyString(pendingRecord['plan']) ?? readNonEmptyString(pendingRecord['planUri'])
      ? { planUri: readNonEmptyString(pendingRecord['plan']) ?? readNonEmptyString(pendingRecord['planUri']) }
      : {}),
    content,
    actions,
    canProvideFeedback: pendingRecord['canProvideFeedback'] !== false,
  };
}

function toRuntimePlanReviewAction(value: unknown): RuntimePlanReviewAction | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readNonEmptyString(value['id']);
  const knownAction = id ? KNOWN_PLAN_REVIEW_ACTIONS[id] : undefined;
  const label = knownAction?.label ?? readNonEmptyString(value['label']);
  if (!id || !label) {
    return null;
  }

  return {
    id,
    label,
    ...((knownAction?.description ?? readNonEmptyString(value['description']))
      ? { description: knownAction?.description ?? readNonEmptyString(value['description']) }
      : {}),
    ...(value['default'] === true ? { default: true } : {}),
    ...((knownAction?.permissionLevel === 'autopilot' || value['permissionLevel'] === 'autopilot')
      ? { permissionLevel: 'autopilot' as const }
      : {}),
  };
}

export function buildPlanReviewResumeContent(
  review: { actions: readonly RuntimePlanReviewAction[] },
  result: RuntimePlanReviewDecision,
): string {
  const actionLabel = typeof result.actionId === 'string' && result.actionId.length > 0
    ? review.actions.find(action => action.id === result.actionId)?.label ?? result.actionId
    : undefined;
  const feedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';

  if (feedback.length > 0) {
    return actionLabel
      ? `已对计划提供反馈，并选择动作：${actionLabel}。`
      : '已对计划提供反馈。';
  }

  if (result.approved) {
    return actionLabel
      ? `已批准计划并选择动作：${actionLabel}。`
      : '已批准当前计划。';
  }

  return actionLabel
    ? `已拒绝当前计划，原选择动作为：${actionLabel}。`
    : '已拒绝当前计划。';
}

export function buildPlanReviewInteractionAction(
  continuation: LexSessionInteractionContinuation | LexTurnContinuation,
  result: RuntimePlanReviewDecision,
): LexInteractionAction {
  const pendingRecord = readInteractionPendingRecord(continuation);
  const feedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';

  return {
    kind: 'plan_review',
    payload: {
      result: result.approved ? 'approved' : 'rejected',
      ...(typeof result.actionId === 'string' && result.actionId.length > 0 ? { actionId: result.actionId } : {}),
      ...(feedback.length > 0 ? { feedback } : {}),
      ...(readNonEmptyString(pendingRecord?.['sourceEvent']) ? { sourceEvent: readNonEmptyString(pendingRecord?.['sourceEvent']) } : {}),
    },
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
