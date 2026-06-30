import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import type { SessionSnapshot, TurnResponseTurn } from 'aily-lex/browser';
import type {
  ChatAgentRuntimeMode,
  ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import {
  DEFAULT_CHAT_SESSION_TYPE,
  LOCAL_CHAT_SESSION_TYPE,
  normalizeChatSessionType,
  type ChatSelectedMode,
} from '../core/chat-mode';
import type { ChatSessionTitleSource } from '../core/chat-session-title';
import {
  buildHostProjectionStateFromPersistedRecord,
  type HostTurnResponseState,
} from '../helpers/host-turn-response-state';
import type { PendingFollowupRequest } from '../helpers/chat-pending-request';
import type { HostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { AuthQuotaInfo } from './auth-quota-state.service';
import type { ChatRuntimeHostModelSelectionSnapshot } from '../core/chat-runtime-host-contract';
import type { ChatInputNotice } from './chat-input-notice';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';
import type { RequestQuotaSnapshot } from './request-quota-snapshot';
import type { RequestQuotaServiceState } from './request-quota-state.service';
import { buildSessionTurnOwnerDiagnostics } from '../helpers/session-turn-owner-diagnostics';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { ChatPerformanceTracer } from './chat-perf-tracer';
import { cloneSessionRequestContextSnapshot } from '../helpers/turn-request-prompt-context';

export type ChatSessionRuntimeStatus = 'in_progress' | 'needs_input' | 'completed' | 'cancelled' | 'failed';

type ChatSessionRuntimeTracePhase = 'idle' | 'running' | 'needs_input' | 'completed' | 'cancelled' | 'failed';

const REQUEST_STATE_TRACE_PREFIX = '[AilyChat][RequestStateTrace]';

function isRequestStateTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceRequestState', [
    '__AILY_CHAT_TRACE_REQUEST_STATE__',
    'AILY_CHAT_TRACE_REQUEST_STATE',
  ]);
}

export type ChatSessionRuntimeChangeReason =
  | 'transcript'
  | 'live_transcript'
  | 'terminal_transcript'
  | 'live_metadata'
  | 'terminal_metadata'
  | 'history_snapshot'
  | 'projection'
  | 'status'
  | 'description'
  | 'view'
  | 'quota'
  | 'debug'
  | 'handle'
  | 'state'
  | 'clear'
  | 'clearAll';

export interface ChatSessionRuntimeChangedEvent {
  readonly sessionId: string | null;
  readonly reason: ChatSessionRuntimeChangeReason;
  readonly listAffecting: boolean;
  readonly highFrequency?: boolean;
}

export interface ChatSessionRuntimeCapabilities {
  readonly canRunConcurrently: boolean;
  readonly canContinueInPlace: boolean;
  readonly supportsBackgroundPersistence: boolean;
}

export interface ChatSessionRuntimeDebugSummary {
  readonly durableHostRecordPresent?: boolean;
  readonly liveRuntimeOverlayPresent: boolean;
  readonly pendingRequest: boolean;
  readonly needsInput: boolean;
  readonly attachedView: boolean;
  readonly title?: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly quotaOverlayPresent?: boolean;
  readonly requestQuotaNotice?: boolean;
  readonly authQuotaProjected?: boolean;
  readonly contextBudgetOverlayPresent?: boolean;
  readonly inputNoticeOverlayPresent?: boolean;
  readonly providerOptionsPresent?: boolean;
  readonly selectedModePresent?: boolean;
  readonly agentRuntimeModePresent?: boolean;
  readonly currentModelPresent?: boolean;
  readonly lastExplicitInterruptAt?: number;
  readonly lastExplicitDisposeAt?: number;
  readonly lastViewDetachAt?: number;
}

export interface ChatSessionRuntimeQuotaOverlay {
  readonly requestQuotaState?: RequestQuotaServiceState | null;
  readonly requestQuotaSnapshot?: RequestQuotaSnapshot | null;
  readonly requestInputNotice?: ChatInputNotice | null;
  readonly authQuotaInfo?: AuthQuotaInfo | null;
  readonly updatedAt: number;
}

export interface ChatSessionRuntimeViewOverlay {
  readonly contextBudgetSnapshot?: ContextBudgetSnapshot | null;
  readonly chatInputNotice?: ChatInputNotice | null;
  readonly updatedAt: number;
}

export interface ChatSessionRuntimeLiveMetadata {
  readonly turnCount: number;
  readonly latestTurnId?: string;
  readonly requestInProgress: boolean;
  readonly needsInput: boolean;
  readonly status?: ChatSessionRuntimeStatus;
  readonly description?: string;
  readonly supportsInterruption: boolean;
  readonly title?: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly selectedModeKey?: string;
}

export interface ChatSessionRuntimeState {
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly hostProjectionState: HostTurnResponseState | null;
  readonly liveMetadata?: ChatSessionRuntimeLiveMetadata;
  readonly requestContext?: NonNullable<SessionSnapshot['requestContext']>;
  readonly activeSkillNames?: readonly string[];
  readonly pendingFollowupRequests?: readonly PendingFollowupRequest[];
  readonly yieldRequested?: boolean;
  readonly status?: ChatSessionRuntimeStatus;
  readonly description?: string;
  readonly requestInProgress: boolean;
  readonly attachedView: boolean;
  readonly supportsInterruption: boolean;
  readonly activeResponseHandle?: unknown;
  readonly stopSession?: () => void;
  readonly disposeSession?: () => void;
  readonly capabilities?: ChatSessionRuntimeCapabilities;
  readonly debugSummary?: ChatSessionRuntimeDebugSummary;
  readonly quotaOverlay?: ChatSessionRuntimeQuotaOverlay;
  readonly viewOverlay?: ChatSessionRuntimeViewOverlay;
  readonly providerOptions?: HostSessionProviderOptions;
  readonly selectedMode?: ChatSelectedMode;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null;
}

function resolveRuntimeTracePhase(
  state: ChatSessionRuntimeState | undefined,
): ChatSessionRuntimeTracePhase {
  if (state?.requestInProgress === true) {
    return 'running';
  }

  switch (state?.status) {
    case 'needs_input':
      return 'needs_input';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

function isTerminalRuntimeStatus(
  status: ChatSessionRuntimeStatus | undefined,
): status is Extract<ChatSessionRuntimeStatus, 'completed' | 'cancelled' | 'failed'> {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

export const DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES: ChatSessionRuntimeCapabilities = {
  canRunConcurrently: true,
  canContinueInPlace: false,
  supportsBackgroundPersistence: true,
};

export interface ChatSessionRuntimeCapabilityOwner {
  readonly sessionType?: unknown;
  readonly providerTarget?: unknown;
  readonly customAgentTarget?: unknown;
  readonly remoteProviderHandle?: unknown;
  readonly customModeSource?: unknown;
  readonly sessionCustomizationProviderLabel?: unknown;
  readonly sessionCustomizationProviderIconId?: unknown;
}

export function resolveChatSessionRuntimeCapabilities(
  owner?: ChatSessionRuntimeCapabilityOwner | null,
): ChatSessionRuntimeCapabilities {
  const sessionType = normalizeChatSessionType(owner?.sessionType, DEFAULT_CHAT_SESSION_TYPE);
  if (sessionType === LOCAL_CHAT_SESSION_TYPE) {
    return { ...DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES };
  }

  return {
    canRunConcurrently: false,
    canContinueInPlace: false,
    supportsBackgroundPersistence: true,
  };
}

export function resolveChatSessionRuntimeConcurrencyScope(
  owner?: ChatSessionRuntimeCapabilityOwner | null,
): string | undefined {
  const capabilities = resolveChatSessionRuntimeCapabilities(owner);
  if (capabilities.canRunConcurrently) {
    return undefined;
  }

  const sessionType = normalizeChatSessionType(owner?.sessionType, DEFAULT_CHAT_SESSION_TYPE);
  const remoteProviderHandle = normalizeRuntimeConcurrencyScopeSegment(owner?.remoteProviderHandle);
  const providerTarget = normalizeRuntimeConcurrencyScopeSegment(owner?.providerTarget);
  const customAgentTarget = normalizeRuntimeConcurrencyScopeSegment(owner?.customAgentTarget);
  const customModeSource = normalizeRuntimeConcurrencyScopeSegment(owner?.customModeSource);
  const sessionCustomizationProviderLabel = normalizeRuntimeConcurrencyScopeSegment(owner?.sessionCustomizationProviderLabel);
  const sessionCustomizationProviderIconId = normalizeRuntimeConcurrencyScopeSegment(owner?.sessionCustomizationProviderIconId);
  return [
    `session-type:${sessionType}`,
    ...(remoteProviderHandle ? [`remote:${remoteProviderHandle}`] : []),
    ...(!remoteProviderHandle && providerTarget ? [`target:${providerTarget}`] : []),
    ...(customAgentTarget ? [`agent:${customAgentTarget}`] : []),
    ...(customModeSource ? [`mode-source:${customModeSource}`] : []),
    ...(sessionCustomizationProviderLabel ? [`customization:${sessionCustomizationProviderLabel}`] : []),
    ...(sessionCustomizationProviderIconId ? [`customization-icon:${sessionCustomizationProviderIconId}`] : []),
  ].join('|');
}

function normalizeRuntimeConcurrencyScopeSegment(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().replace(/[\\]+/g, '/').replace(/\s+/g, ' ');
  return normalized.length > 0 ? normalized.toLowerCase() : undefined;
}

export type ChatSessionRuntimeStatePatch = Omit<
  Partial<ChatSessionRuntimeState>,
  | 'turnResponses'
  | 'hostProjectionState'
  | 'status'
  | 'description'
  | 'activeResponseHandle'
  | 'stopSession'
  | 'disposeSession'
  | 'capabilities'
  | 'debugSummary'
  | 'quotaOverlay'
  | 'viewOverlay'
  | 'providerOptions'
  | 'selectedMode'
  | 'agentRuntimeMode'
  | 'agentRuntimeModeSource'
  | 'currentModel'
> & {
  readonly turnResponses?: readonly TurnResponseTurn[] | null | undefined;
  readonly hostProjectionState?: HostTurnResponseState | null | undefined;
  readonly requestContext?: NonNullable<SessionSnapshot['requestContext']> | null | undefined;
  readonly activeSkillNames?: readonly string[] | null | undefined;
  readonly pendingFollowupRequests?: readonly PendingFollowupRequest[] | null | undefined;
  readonly yieldRequested?: boolean | null | undefined;
  readonly status?: ChatSessionRuntimeStatus | null | undefined;
  readonly description?: string | null | undefined;
  readonly activeResponseHandle?: unknown | null | undefined;
  readonly stopSession?: (() => void) | null;
  readonly disposeSession?: (() => void) | null;
  readonly capabilities?: Partial<ChatSessionRuntimeCapabilities> | null | undefined;
  readonly debugSummary?: Partial<ChatSessionRuntimeDebugSummary> | null | undefined;
  readonly quotaOverlay?: ChatSessionRuntimeQuotaOverlay | null | undefined;
  readonly viewOverlay?: ChatSessionRuntimeViewOverlay | null | undefined;
  readonly providerOptions?: HostSessionProviderOptions | null | undefined;
  readonly selectedMode?: ChatSelectedMode | null | undefined;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode | null | undefined;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource | null | undefined;
  readonly currentModel?: ChatRuntimeHostModelSelectionSnapshot | null | undefined;
};

export interface ChatSessionRuntimeChangeOptions {
  readonly reason?: ChatSessionRuntimeChangeReason;
  readonly listAffecting?: boolean;
  readonly highFrequency?: boolean;
}

interface ChatSessionListFingerprint {
  readonly requestInProgress: boolean;
  readonly status?: ChatSessionRuntimeStatus;
  readonly description?: string;
  readonly attachedView: boolean;
  readonly supportsInterruption: boolean;
  readonly hasActiveResponseHandle: boolean;
  readonly titleKey?: string;
  readonly selectedModeKey?: string;
}

@Injectable()
export class ChatSessionRuntimeStoreService {
  private readonly runtimeStates = new Map<string, ChatSessionRuntimeState>();
  private readonly runtimeChangedSubject = new Subject<ChatSessionRuntimeChangedEvent>();

  readonly runtimeChanged$ = this.runtimeChangedSubject.asObservable();

  read(sessionId: string | null | undefined): ChatSessionRuntimeState | undefined {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId
      ? this.runtimeStates.get(normalizedSessionId)
      : undefined;
  }

  readTurnResponses(sessionId: string | null | undefined): readonly TurnResponseTurn[] | undefined {
    return this.read(sessionId)?.turnResponses;
  }

  readHostProjectionState(sessionId: string | null | undefined): HostTurnResponseState | null | undefined {
    return this.read(sessionId)?.hostProjectionState;
  }

  getSessionIds(): readonly string[] {
    return [...this.runtimeStates.keys()];
  }

  replaceRuntimeState(
    sessionId: string | null | undefined,
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const previousState = this.runtimeStates.get(normalizedSessionId);
    const nextTurnResponses = Array.isArray(state.turnResponses)
      ? [...state.turnResponses]
      : previousState?.turnResponses ?? [];
    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(normalizedSessionId, nextTurnResponses);
    if (ownerDiagnostics.mismatchCount > 0) {
      console.warn('[ChatSessionRuntimeStore][owner-mismatch]', {
        sessionId: normalizedSessionId,
        mismatchCount: ownerDiagnostics.mismatchCount,
        mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
        reason: options?.reason ?? null,
      });
    }
    const nextHostProjectionState = state.hostProjectionState !== undefined
      ? state.hostProjectionState ?? null
      : previousState?.hostProjectionState ?? null;
    const nextPendingFollowupRequests = state.pendingFollowupRequests !== undefined
      ? this.clonePendingFollowupRequests(state.pendingFollowupRequests ?? undefined)
      : previousState?.pendingFollowupRequests;
    const nextRequestContext = state.requestContext !== undefined
      ? cloneSessionRequestContextSnapshot(state.requestContext ?? undefined)
      : previousState?.requestContext;
    const nextActiveSkillNames = state.activeSkillNames !== undefined
      ? this.cloneActiveSkillNames(state.activeSkillNames ?? undefined)
      : previousState?.activeSkillNames;
    const nextYieldRequested = state.yieldRequested !== undefined
      ? state.yieldRequested === true
      : previousState?.yieldRequested === true;
    const resolvedNextStatus = this.resolveNextStatus(state.status, previousState, nextTurnResponses);
    const nextRequestInProgress = typeof state.requestInProgress === 'boolean'
      ? state.requestInProgress
      : isTerminalRuntimeStatus(resolvedNextStatus)
        ? false
        : previousState?.requestInProgress ?? false;
    const nextStatus = !nextRequestInProgress && resolvedNextStatus === 'in_progress'
      ? undefined
      : resolvedNextStatus;
    const nextDescription = this.resolveNextDescription(state.description, previousState);
    const nextActiveResponseHandle = state.activeResponseHandle !== undefined
      ? state.activeResponseHandle ?? undefined
      : nextRequestInProgress
        ? previousState?.activeResponseHandle
        : undefined;
    const nextSupportsInterruption = typeof state.supportsInterruption === 'boolean'
      ? state.supportsInterruption
      : nextRequestInProgress
        ? previousState?.supportsInterruption ?? false
        : false;
    const nextCapabilities = this.resolveNextCapabilities(state.capabilities, previousState);
    const nextQuotaOverlay = state.quotaOverlay !== undefined
      ? state.quotaOverlay ?? undefined
      : previousState?.quotaOverlay;
    const nextViewOverlay = state.viewOverlay !== undefined
      ? state.viewOverlay ?? undefined
      : previousState?.viewOverlay;
    const nextProviderOptions = state.providerOptions !== undefined
      ? state.providerOptions ?? undefined
      : previousState?.providerOptions;
    const nextSelectedMode = state.selectedMode !== undefined
      ? state.selectedMode ?? undefined
      : previousState?.selectedMode;
    const nextAgentRuntimeMode = state.agentRuntimeMode !== undefined
      ? state.agentRuntimeMode ?? undefined
      : previousState?.agentRuntimeMode;
    const nextAgentRuntimeModeSource = state.agentRuntimeModeSource !== undefined
      ? state.agentRuntimeModeSource ?? undefined
      : previousState?.agentRuntimeModeSource;
    const nextCurrentModel = state.currentModel !== undefined
      ? state.currentModel ? this.cloneCurrentModel(state.currentModel) : undefined
      : previousState?.currentModel ? this.cloneCurrentModel(previousState.currentModel) : undefined;
    const nextAttachedView = typeof state.attachedView === 'boolean'
      ? state.attachedView
      : previousState?.attachedView ?? false;
    const nextDebugSummary = this.resolveNextDebugSummary(state.debugSummary, previousState, {
      requestInProgress: nextRequestInProgress,
      attachedView: nextAttachedView,
      status: nextStatus,
      hasLiveOverlay: nextRequestInProgress
        || nextTurnResponses.length > 0
        || !!nextHostProjectionState
        || !!nextStatus
        || !!nextDescription
        || !!nextQuotaOverlay
        || !!nextViewOverlay
        || !!nextProviderOptions
        || !!nextSelectedMode
        || !!nextAgentRuntimeMode
        || !!nextCurrentModel,
      quotaOverlayPresent: !!nextQuotaOverlay,
      requestQuotaNotice: !!nextQuotaOverlay?.requestInputNotice,
      authQuotaProjected: !!nextQuotaOverlay?.authQuotaInfo,
      contextBudgetOverlayPresent: !!nextViewOverlay?.contextBudgetSnapshot,
      inputNoticeOverlayPresent: !!nextViewOverlay?.chatInputNotice,
      providerOptionsPresent: !!nextProviderOptions,
      selectedModePresent: !!nextSelectedMode,
      agentRuntimeModePresent: !!nextAgentRuntimeMode,
      currentModelPresent: !!nextCurrentModel,
    });
    const nextState: ChatSessionRuntimeState = {
      turnResponses: nextTurnResponses,
      hostProjectionState: nextHostProjectionState,
      liveMetadata: this.buildLiveMetadata({
        turnResponses: nextTurnResponses,
        requestInProgress: nextRequestInProgress,
        status: nextStatus,
        description: nextDescription,
        supportsInterruption: nextSupportsInterruption,
        debugSummary: nextDebugSummary,
        selectedMode: nextSelectedMode,
      }),
      ...(nextRequestContext ? { requestContext: nextRequestContext } : {}),
      ...(nextActiveSkillNames ? { activeSkillNames: nextActiveSkillNames } : {}),
      ...(nextPendingFollowupRequests?.length ? { pendingFollowupRequests: nextPendingFollowupRequests } : {}),
      ...(nextYieldRequested ? { yieldRequested: true } : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(nextDescription ? { description: nextDescription } : {}),
      requestInProgress: nextRequestInProgress,
      attachedView: nextAttachedView,
      supportsInterruption: nextSupportsInterruption,
      ...(nextActiveResponseHandle !== undefined ? { activeResponseHandle: nextActiveResponseHandle } : {}),
      ...(nextQuotaOverlay ? { quotaOverlay: this.cloneQuotaOverlay(nextQuotaOverlay) } : {}),
      ...(nextViewOverlay ? { viewOverlay: this.cloneViewOverlay(nextViewOverlay) } : {}),
      ...(nextProviderOptions ? { providerOptions: this.cloneProviderOptions(nextProviderOptions) } : {}),
      ...(nextSelectedMode ? { selectedMode: this.cloneSelectedMode(nextSelectedMode) } : {}),
      ...(nextAgentRuntimeMode ? { agentRuntimeMode: nextAgentRuntimeMode } : {}),
      ...(nextAgentRuntimeModeSource ? { agentRuntimeModeSource: nextAgentRuntimeModeSource } : {}),
      ...(nextCurrentModel ? { currentModel: this.cloneCurrentModel(nextCurrentModel) } : {}),
      ...(typeof state.stopSession === 'function'
        ? { stopSession: state.stopSession }
        : state.stopSession === null
          ? {}
        : nextSupportsInterruption && previousState?.stopSession
          ? { stopSession: previousState.stopSession }
          : {}),
      ...(typeof state.disposeSession === 'function'
        ? { disposeSession: state.disposeSession }
        : state.disposeSession === null
          ? {}
        : previousState?.disposeSession
          ? { disposeSession: previousState.disposeSession }
          : {}),
      capabilities: nextCapabilities,
      debugSummary: nextDebugSummary,
    };

    if (!nextState.requestInProgress
      && nextState.turnResponses.length === 0
      && !nextState.hostProjectionState
      && (!nextState.pendingFollowupRequests || nextState.pendingFollowupRequests.length === 0)
      && !nextState.attachedView
      && !nextState.status
      && !nextState.description
      && nextState.activeResponseHandle === undefined
      && !nextState.quotaOverlay
      && !nextState.viewOverlay
      && !nextState.providerOptions
      && !nextState.selectedMode
      && !nextState.agentRuntimeMode
      && !nextState.currentModel) {
      this.clearSession(normalizedSessionId, {
        reason: options?.reason ?? 'clear',
        listAffecting: options?.listAffecting,
        highFrequency: options?.highFrequency,
      });
      return;
    }

    this.runtimeStates.set(normalizedSessionId, nextState);
    this.emitRuntimeChanged(normalizedSessionId, previousState, nextState, options);
  }

  replaceTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): void {
    this.replaceRuntimeState(sessionId, { turnResponses }, {
      reason: 'transcript',
      highFrequency: true,
    });
  }

  appendOrReplaceTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    const normalizedTurnId = typeof turnResponse?.turnId === 'string'
      ? turnResponse.turnId.trim()
      : '';
    if (!normalizedSessionId || !turnResponse || !normalizedTurnId) {
      return;
    }

    const previousTurnResponses = this.runtimeStates.get(normalizedSessionId)?.turnResponses ?? [];
    const nextTurnResponses = this.appendOrReplaceTurnResponseInList(previousTurnResponses, turnResponse);
    const nextHostProjectionState = nextTurnResponses.length > 0
      ? buildHostProjectionStateFromPersistedRecord({ turnResponses: nextTurnResponses })
      : hostProjectionState;
    this.replaceRuntimeState(normalizedSessionId, {
      turnResponses: nextTurnResponses,
      hostProjectionState: nextHostProjectionState,
    }, options ?? {
      reason: 'live_transcript',
      highFrequency: true,
      listAffecting: false,
    });
  }

  stopSession(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const runtimeState = this.runtimeStates.get(normalizedSessionId);
    if (!runtimeState?.supportsInterruption || typeof runtimeState.stopSession !== 'function') {
      return false;
    }

    runtimeState.stopSession();
    return true;
  }

  disposeSession(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }

    const runtimeState = this.runtimeStates.get(normalizedSessionId);
    if (typeof runtimeState?.disposeSession !== 'function') {
      return false;
    }

    runtimeState.disposeSession();
    return true;
  }

  clearSession(
    sessionId: string | null | undefined,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const previousState = this.runtimeStates.get(normalizedSessionId);
    if (!this.runtimeStates.delete(normalizedSessionId)) {
      return;
    }

    this.emitRuntimeChanged(normalizedSessionId, previousState, undefined, {
      reason: options?.reason ?? 'clear',
      listAffecting: options?.listAffecting,
      highFrequency: options?.highFrequency,
    });
  }

  clearAll(): void {
    if (this.runtimeStates.size === 0) {
      return;
    }

    this.runtimeStates.clear();
    this.runtimeChangedSubject.next({
      sessionId: null,
      reason: 'clearAll',
      listAffecting: true,
    });
  }

  private emitRuntimeChanged(
    sessionId: string,
    previousState: ChatSessionRuntimeState | undefined,
    nextState: ChatSessionRuntimeState | undefined,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const reason = this.resolveChangeReason(options?.reason, previousState, nextState);
    const liveTranscript = reason === 'live_transcript';
    const listAffecting = options?.listAffecting ?? (
      liveTranscript
        ? false
        : this.didListFingerprintChange(previousState, nextState)
    );
    const highFrequency = options?.highFrequency === true
      || reason === 'transcript'
      || reason === 'live_transcript';
    if (reason === 'live_transcript' || reason === 'terminal_transcript') {
      ChatPerformanceTracer.increment(`runtime.${reason}`);
    }
    const event = {
      sessionId,
      reason,
      listAffecting,
      ...(highFrequency ? { highFrequency: true } : {}),
    };
    ChatPerformanceTracer.runWithSurface(this.resolveRuntimeChangeSurface(reason), () => {
      this.runtimeChangedSubject.next(event);
      this.traceRequestStateTransition(sessionId, previousState, nextState, reason);
    }, `session=${sessionId},listAffecting=${listAffecting ? '1' : '0'}`);
  }

  private resolveRuntimeChangeSurface(reason: ChatSessionRuntimeChangeReason): string {
    switch (reason) {
      case 'live_transcript':
        return 'live_transcript';
      case 'terminal_transcript':
        return 'terminal_transcript';
      case 'live_metadata':
      case 'terminal_metadata':
      case 'history_snapshot':
      case 'status':
      case 'description':
      case 'view':
      case 'quota':
      case 'debug':
      case 'handle':
      case 'state':
        return 'runtime_metadata';
      default:
        return 'unknown';
    }
  }

  private appendOrReplaceTurnResponseInList(
    turnResponses: readonly TurnResponseTurn[],
    turnResponse: TurnResponseTurn,
  ): readonly TurnResponseTurn[] {
    const normalizedTurnId = typeof turnResponse.turnId === 'string'
      ? turnResponse.turnId.trim()
      : '';
    if (!normalizedTurnId) {
      return turnResponses;
    }

    const nextTurnResponses = [...turnResponses];
    const existingIndex = nextTurnResponses.findIndex(turn => turn.turnId === normalizedTurnId);
    if (existingIndex >= 0) {
      nextTurnResponses[existingIndex] = turnResponse;
      return nextTurnResponses;
    }

    nextTurnResponses.push(turnResponse);
    return nextTurnResponses;
  }

  private traceRequestStateTransition(
    sessionId: string,
    previousState: ChatSessionRuntimeState | undefined,
    nextState: ChatSessionRuntimeState | undefined,
    reason: ChatSessionRuntimeChangeReason,
  ): void {
    const from = resolveRuntimeTracePhase(previousState);
    const to = resolveRuntimeTracePhase(nextState);
    const previousStatus = previousState?.status ?? null;
    const nextStatus = nextState?.status ?? null;
    const previousRequestInProgress = previousState?.requestInProgress === true;
    const nextRequestInProgress = nextState?.requestInProgress === true;

    if (from === to
      && previousStatus === nextStatus
      && previousRequestInProgress === nextRequestInProgress) {
      return;
    }

    if (isRequestStateTraceEnabled()) {
      console.info(REQUEST_STATE_TRACE_PREFIX, {
        sessionId,
        from,
        to,
        reason,
        previousStatus,
        nextStatus,
        previousRequestInProgress,
        nextRequestInProgress,
        pendingCount: nextState?.pendingFollowupRequests?.length ?? 0,
        attachedView: nextState?.attachedView === true,
      });
    }
  }

  private resolveChangeReason(
    explicitReason: ChatSessionRuntimeChangeReason | undefined,
    previousState: ChatSessionRuntimeState | undefined,
    nextState: ChatSessionRuntimeState | undefined,
  ): ChatSessionRuntimeChangeReason {
    if (explicitReason) {
      return explicitReason;
    }

    if (!nextState) {
      return 'clear';
    }

    const previousStatus = previousState?.status;
    const nextStatus = nextState.status;
    if (previousStatus !== nextStatus) {
      return 'status';
    }

    const previousDescription = this.normalizeDescription(previousState?.description);
    const nextDescription = this.normalizeDescription(nextState.description);
    if (previousDescription !== nextDescription) {
      return 'description';
    }

    if (previousState?.attachedView !== nextState.attachedView) {
      return 'view';
    }

    if (previousState?.requestInProgress !== nextState.requestInProgress
      || previousState?.supportsInterruption !== nextState.supportsInterruption
      || !!previousState?.activeResponseHandle !== !!nextState.activeResponseHandle) {
      return 'handle';
    }

    if (!!previousState?.quotaOverlay !== !!nextState.quotaOverlay) {
      return 'quota';
    }

    if (!!previousState?.viewOverlay !== !!nextState.viewOverlay) {
      return 'view';
    }

    if (!!previousState?.debugSummary !== !!nextState.debugSummary) {
      return 'debug';
    }

    return 'state';
  }

  private didListFingerprintChange(
    previousState: ChatSessionRuntimeState | undefined,
    nextState: ChatSessionRuntimeState | undefined,
  ): boolean {
    const previous = this.buildListFingerprint(previousState);
    const next = this.buildListFingerprint(nextState);

    return previous.requestInProgress !== next.requestInProgress
      || previous.status !== next.status
      || previous.description !== next.description
      || previous.attachedView !== next.attachedView
      || previous.supportsInterruption !== next.supportsInterruption
      || previous.hasActiveResponseHandle !== next.hasActiveResponseHandle
      || previous.titleKey !== next.titleKey
      || previous.selectedModeKey !== next.selectedModeKey;
  }

  private buildListFingerprint(state: ChatSessionRuntimeState | undefined): ChatSessionListFingerprint {
    const liveMetadata = state?.liveMetadata;
    return {
      requestInProgress: liveMetadata?.requestInProgress ?? state?.requestInProgress === true,
      status: liveMetadata?.status ?? state?.status,
      description: this.normalizeDescription(liveMetadata?.description ?? state?.description),
      attachedView: state?.attachedView === true,
      supportsInterruption: liveMetadata?.supportsInterruption ?? state?.supportsInterruption === true,
      hasActiveResponseHandle: state?.activeResponseHandle !== undefined,
      titleKey: this.buildTitleKey(liveMetadata),
      selectedModeKey: liveMetadata?.selectedModeKey,
    };
  }

  private buildLiveMetadata(input: {
    readonly turnResponses: readonly TurnResponseTurn[];
    readonly requestInProgress: boolean;
    readonly status?: ChatSessionRuntimeStatus;
    readonly description?: string;
    readonly supportsInterruption: boolean;
    readonly debugSummary?: ChatSessionRuntimeDebugSummary;
    readonly selectedMode?: ChatSelectedMode;
  }): ChatSessionRuntimeLiveMetadata {
    const latestTurn = input.turnResponses[input.turnResponses.length - 1];
    const latestTurnId = this.readNonEmptyString(latestTurn?.turnId);
    const status = input.status ?? this.resolveStatusFromTurnResponses(
      latestTurn ? [latestTurn] as readonly TurnResponseTurn[] : undefined,
    );
    const description = this.normalizeDescription(input.description)
      ?? this.resolveDescriptionFromTurnResponses(latestTurn ? [latestTurn] as readonly TurnResponseTurn[] : undefined);

    return {
      turnCount: input.turnResponses.length,
      ...(latestTurnId ? { latestTurnId } : {}),
      requestInProgress: input.requestInProgress,
      needsInput: status === 'needs_input',
      ...(status ? { status } : {}),
      ...(description ? { description } : {}),
      supportsInterruption: input.supportsInterruption,
      ...(input.debugSummary?.title ? { title: input.debugSummary.title } : {}),
      ...(input.debugSummary?.titleSource ? { titleSource: input.debugSummary.titleSource } : {}),
      ...(typeof input.debugSummary?.titleRevision === 'number' ? { titleRevision: input.debugSummary.titleRevision } : {}),
      ...(input.selectedMode ? { selectedModeKey: this.buildSelectedModeKey(input.selectedMode) } : {}),
    };
  }

  private buildTitleKey(liveMetadata: ChatSessionRuntimeLiveMetadata | undefined): string | undefined {
    if (!liveMetadata?.title) {
      return undefined;
    }

    return [
      liveMetadata.title,
      liveMetadata.titleSource ?? '',
      typeof liveMetadata.titleRevision === 'number' ? String(liveMetadata.titleRevision) : '',
    ].join('|');
  }

  private buildSelectedModeKey(selectedMode: ChatSelectedMode | undefined): string | undefined {
    if (!selectedMode) {
      return undefined;
    }

    const record = selectedMode as unknown as Record<string, unknown>;
    const modeId = this.readNonEmptyString(record['modeId']);
    const customAgentTarget = this.readNonEmptyString(record['customAgentTarget']);
    const customModeSource = this.readNonEmptyString(record['customModeSource']);
    const permissionMode = this.readNonEmptyString(record['permissionMode']);
    const key = [
      modeId ? `mode:${modeId}` : '',
      customAgentTarget ? `agent:${customAgentTarget}` : '',
      customModeSource ? `source:${customModeSource}` : '',
      permissionMode ? `permission:${permissionMode}` : '',
    ].filter(Boolean).join('|');

    return key || undefined;
  }

  private resolveStatusFromTurnResponses(
    turnResponses: readonly TurnResponseTurn[] | undefined,
  ): ChatSessionRuntimeStatus | undefined {
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      return undefined;
    }

    const latest = turnResponses[turnResponses.length - 1];
    const continuationStatus = this.readNonEmptyString(latest?.response?.continuation?.status);
    const responseStatus = this.readNonEmptyString(latest?.response?.status);
    const candidate = continuationStatus ?? responseStatus;

    switch (candidate) {
      case 'running':
      case 'streaming':
      case 'in_progress':
        return 'in_progress';
      case 'waiting_question':
      case 'waiting_confirmation':
      case 'waiting_tool_results':
      case 'waiting_plan_review':
      case 'plan_review':
      case 'continue':
      case 'needs_input':
        return 'needs_input';
      case 'hard_stopped':
      case 'failed':
      case 'error':
        return 'failed';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      case 'completed':
        return 'completed';
      default:
        return undefined;
    }
  }

  private resolveDescriptionFromTurnResponses(
    turnResponses: readonly TurnResponseTurn[] | undefined,
  ): string | undefined {
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      return undefined;
    }

    const latest = turnResponses[turnResponses.length - 1];
    const continuationStatus = this.readNonEmptyString(latest?.response?.continuation?.status);
    if (continuationStatus === 'waiting_confirmation') {
      const title = this.readWaitingPartTitle(latest, 'confirmation');
      return title ? `Waiting for confirmation: ${title}` : 'Waiting for confirmation';
    }
    if (continuationStatus === 'waiting_question') {
      const title = this.readWaitingPartTitle(latest, 'question');
      return title ? `Waiting for answer: ${title}` : 'Waiting for answer';
    }

    return undefined;
  }

  private readWaitingPartTitle(
    turn: TurnResponseTurn | undefined,
    expectedType: 'confirmation' | 'question',
  ): string | undefined {
    const parts = Array.isArray(turn?.response?.parts)
      ? turn.response.parts
      : [];
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index] as { type?: unknown; title?: unknown; message?: unknown };
      if (part?.type !== expectedType) {
        continue;
      }

      const title = this.readNonEmptyString(part.title) ?? this.readNonEmptyString(part.message);
      if (title) {
        return title;
      }
    }

    return undefined;
  }

  private normalizeDescription(description: string | undefined): string | undefined {
    return typeof description === 'string'
      ? description.replace(/\s+/g, ' ').trim() || undefined
      : undefined;
  }

  private readNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
  }

  private resolveNextStatus(
    status: ChatSessionRuntimeStatus | null | undefined,
    previousState: ChatSessionRuntimeState | undefined,
    turnResponses?: readonly TurnResponseTurn[] | undefined,
  ): ChatSessionRuntimeStatus | undefined {
    const derivedStatus = this.resolveStatusFromTurnResponses(turnResponses ?? previousState?.turnResponses);

    if (status === null) {
      return derivedStatus;
    }

    if (status) {
      return status;
    }

    return derivedStatus ?? previousState?.status;
  }

  private resolveNextDescription(
    description: string | null | undefined,
    previousState: ChatSessionRuntimeState | undefined,
  ): string | undefined {
    if (description === null) {
      return undefined;
    }

    if (typeof description === 'string') {
      const normalized = description.replace(/\s+/g, ' ').trim();
      return normalized || undefined;
    }

    return previousState?.description;
  }

  private resolveNextCapabilities(
    capabilities: Partial<ChatSessionRuntimeCapabilities> | null | undefined,
    previousState: ChatSessionRuntimeState | undefined,
  ): ChatSessionRuntimeCapabilities {
    if (capabilities === null) {
      return { ...DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES };
    }

    return {
      ...DEFAULT_CHAT_SESSION_RUNTIME_CAPABILITIES,
      ...(previousState?.capabilities ?? {}),
      ...(capabilities ?? {}),
    };
  }

  private resolveNextDebugSummary(
    debugSummary: Partial<ChatSessionRuntimeDebugSummary> | null | undefined,
    previousState: ChatSessionRuntimeState | undefined,
    liveState: {
      readonly requestInProgress: boolean;
      readonly attachedView: boolean;
      readonly status?: ChatSessionRuntimeStatus;
      readonly hasLiveOverlay: boolean;
      readonly quotaOverlayPresent: boolean;
      readonly requestQuotaNotice: boolean;
      readonly authQuotaProjected: boolean;
      readonly contextBudgetOverlayPresent: boolean;
      readonly inputNoticeOverlayPresent: boolean;
      readonly providerOptionsPresent: boolean;
      readonly selectedModePresent: boolean;
      readonly agentRuntimeModePresent: boolean;
      readonly currentModelPresent: boolean;
    },
  ): ChatSessionRuntimeDebugSummary {
    const previousSummary = previousState?.debugSummary;
    return {
      ...(previousSummary ?? {}),
      ...(debugSummary ?? {}),
      liveRuntimeOverlayPresent: liveState.hasLiveOverlay,
      pendingRequest: liveState.requestInProgress,
      needsInput: liveState.status === 'needs_input',
      attachedView: liveState.attachedView,
      quotaOverlayPresent: liveState.quotaOverlayPresent,
      requestQuotaNotice: liveState.requestQuotaNotice,
      authQuotaProjected: liveState.authQuotaProjected,
      contextBudgetOverlayPresent: liveState.contextBudgetOverlayPresent,
      inputNoticeOverlayPresent: liveState.inputNoticeOverlayPresent,
      providerOptionsPresent: liveState.providerOptionsPresent,
      selectedModePresent: liveState.selectedModePresent,
      agentRuntimeModePresent: liveState.agentRuntimeModePresent,
      currentModelPresent: liveState.currentModelPresent,
    };
  }

  private cloneQuotaOverlay(overlay: ChatSessionRuntimeQuotaOverlay): ChatSessionRuntimeQuotaOverlay {
    return {
      ...(overlay.requestQuotaState ? { requestQuotaState: clonePlainObject(overlay.requestQuotaState) } : {}),
      ...(overlay.requestQuotaSnapshot ? { requestQuotaSnapshot: clonePlainObject(overlay.requestQuotaSnapshot) } : {}),
      ...(overlay.requestInputNotice ? { requestInputNotice: clonePlainObject(overlay.requestInputNotice) } : {}),
      ...(overlay.authQuotaInfo ? { authQuotaInfo: clonePlainObject(overlay.authQuotaInfo) } : {}),
      updatedAt: overlay.updatedAt,
    };
  }

  private cloneViewOverlay(overlay: ChatSessionRuntimeViewOverlay): ChatSessionRuntimeViewOverlay {
    return {
      ...(overlay.contextBudgetSnapshot ? { contextBudgetSnapshot: clonePlainObject(overlay.contextBudgetSnapshot) } : {}),
      ...(overlay.chatInputNotice ? { chatInputNotice: clonePlainObject(overlay.chatInputNotice) } : {}),
      updatedAt: overlay.updatedAt,
    };
  }

  private cloneProviderOptions(providerOptions: HostSessionProviderOptions): HostSessionProviderOptions {
    return { ...providerOptions };
  }

  private cloneSelectedMode(selectedMode: ChatSelectedMode): ChatSelectedMode {
    return { ...selectedMode };
  }

  private cloneCurrentModel(currentModel: ChatRuntimeHostModelSelectionSnapshot): ChatRuntimeHostModelSelectionSnapshot {
    return { ...(currentModel as Record<string, unknown>) } as ChatRuntimeHostModelSelectionSnapshot;
  }

  private cloneActiveSkillNames(names: readonly string[] | undefined): readonly string[] | undefined {
    if (!Array.isArray(names)) {
      return undefined;
    }

    return names
      .filter((name): name is string => typeof name === 'string')
      .map(name => name.trim())
      .filter(name => name.length > 0);
  }

  private clonePendingFollowupRequests(
    requests: readonly PendingFollowupRequest[] | undefined,
  ): readonly PendingFollowupRequest[] | undefined {
    if (!Array.isArray(requests) || requests.length === 0) {
      return undefined;
    }

    if (typeof globalThis.structuredClone === 'function') {
      return globalThis.structuredClone(requests) as readonly PendingFollowupRequest[];
    }

    return JSON.parse(JSON.stringify(requests)) as readonly PendingFollowupRequest[];
  }
}

function clonePlainObject<T>(value: T): T {
  if (!value || typeof value !== 'object') {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
