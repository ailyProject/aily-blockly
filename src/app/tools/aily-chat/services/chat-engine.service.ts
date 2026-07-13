/**
 * ChatEngineService — aily-chat 核心业务逻辑引擎
 *
 * 从 AilyChatComponent 中提取的全部业务逻辑、副作用和共享状态。
 * Component 仅保留 Angular 生命周期、模板绑定和 UI 事件处理器。
 *
 * 职责：
 * - 会话生命周期管理（start / stop / close / new / history）
 * - 消息发送与工具调用循环（stateless turn loop）
 * - SSE 流处理与事件分发
 * - 订阅管理（项目路径、登录状态、配置变更等）
 */

import { Injectable, ElementRef, NgZone, inject } from '@angular/core';
import { Subscription, skip, distinctUntilChanged, combineLatest } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';

import { ChatService, ChatTextOptions, ModelConfig } from './chat.service';
import { McpService } from './mcp.service';
import { AilyChatConfigService } from './aily-chat-config.service';
import { AilyChatLanguageModelsService } from './aily-chat-language-models.service';
import { ChatHistoryService } from './chat-history.service';
import { MAIN_AGENT_TYPE } from '../core/agent-identifiers';
import {
  createChatAgentRuntimeConfigKey,
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  resolveChatAgentRuntimeModeForProject,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeResolution,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import { RepetitionDetectionService } from './repetition-detection.service';
import { ContextBudgetService } from './context-budget.service';
import { ContextBudgetViewService } from './context-budget-view.service';
import { ChatViewService } from './chat-view.service';
import { ChatSetupSuggestionService } from './chat-setup-suggestion.service';
import {
  ChatRuntimeInteractionHostService,
  type RuntimePlanReviewAction,
  type RuntimePlanReviewDecision,
} from './chat-runtime-interaction-host.service';
import {
  readSessionModelTurnResponses,
} from './chat-session-model-turn-responses';
import { ChatRuntimeViewMirrorProjectionService } from './chat-runtime-view-mirror-projection.service';
import { ChatPendingFollowupQueueService } from './chat-pending-followup-queue.service';
import type {
  ChatRuntimeHost,
  ChatRuntimeHostEvent,
  ChatRuntimeHostEventSubscription,
  ChatRuntimeHostInteractionRequest,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHostRerunReadiness,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostSessionStatus,
  ChatRuntimeHostSubmitReadiness,
  ChatRuntimeHostSubmitRequest,
  ChatRuntimeHostProtocolTruncation,
  ChatRuntimeHostViewRequest,
  ChatRuntimeHostViewId,
  ChatRuntimeHostModelSelectionSnapshot,
  ChatRuntimeHostPartTranscriptEvent,
  ChatRuntimeOwnerExecutorEvent,
} from '../core/chat-runtime-host-contract';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';
import { AuthQuotaStateService, readAuthQuotaStateSnapshot, type AuthQuotaInfo } from './auth-quota-state.service';
import { ChatInputNoticeStateService } from './chat-input-notice-state.service';
import type { ChatInputNotice } from './chat-input-notice';
import { createLexContextBudgetSnapshot, type LexContextBudgetSnapshotExtra } from './context-budget-lex-event';
import type { ContextBudgetSnapshot } from './context-budget-snapshot';
import { createChatContextUsageSnapshot, findLatestUsageTurn, type ChatContextUsageSnapshot } from './context-usage-snapshot';
import { createInteractionBudgetSnapshot, type InteractionBudgetSnapshot } from './interaction-budget-snapshot';
import {
  createRequestQuotaInputNotice,
  createRequestQuotaSnapshot,
  createRequestQuotaSnapshotFromServiceState,
  createRequestRateLimitInputNotice,
  type RequestQuotaSnapshot,
} from './request-quota-snapshot';
import {
  RequestQuotaStateService,
  readRequestQuotaStateTurnSidecar,
  type RequestQuotaServiceState,
  type RequestQuotaUsageSnapshot,
} from './request-quota-state.service';
import { ChatSessionEntryStateService } from './chat-session-entry-state.service';
import { ConfigService } from '../../../services/config.service';
import { UiService } from '../../../services/ui.service';
import { isDefaultAutoPresetSelected } from '../helpers/model-billing-label';
import { buildTodoListSemanticDataFromTodos } from './todoUpdate.service';
import { setTodos, type TodoItem as BlocklyTodoItem } from '../utils/todoStorage';
import {
  createTurnRequestModeInfoFromResolvedMode,
  normalizeChatSelectedMode,
  resolveChatCurrentMode,
  resolveChatSurfaceModeId,
  type ChatResolvedMode,
  type ChatResolvedModeHandoff,
  type ChatSelectedMode,
  type ChatSurfaceModeId,
  PLAN_CHAT_MODE_START_IMPLEMENTATION_PROMPT,
} from '../core/chat-mode';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import {
  normalizeChatSessionTitleCandidate,
  normalizeChatSessionTitleText,
} from '../core/chat-session-title';
import {
  liveTranscriptProjection,
  runtimeChangeOptionsFromTranscriptProjection,
  terminalTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';

import { AbsAutoSyncService } from './abs-auto-sync.service';
import type { EditsSummary, RequestCheckpointMetadata } from './edit-checkpoint.service';
import { EditCheckpointService } from './edit-checkpoint.service';
import { AiCoderDiffBridgeService } from '../../../services/ai-coder-diff-bridge.service';
import { GitWorkspaceCheckpointProviderService } from './git-workspace-checkpoint-provider.service';
import { ScrollManagerService } from './scroll-manager.service';
import { ResourceManagerService } from './resource-manager.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import {
  ChatSessionModelStoreService,
  type ChatSessionModel,
  type ChatSessionModelMetadataPatch,
  type ChatSessionRequestListTransactionResult,
  type ChatSessionTurnOwnerPolicyOptions,
} from './chat-session-model-store.service';
import {
  ChatSessionRuntimeStoreService,
  resolveChatSessionRuntimeCapabilities,
  resolveChatSessionRuntimeConcurrencyScope,
  type ChatSessionRuntimeChangeOptions,
  type ChatSessionRuntimeQuotaOverlay,
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeViewOverlay,
} from './chat-session-runtime-store.service';
import { ChatSessionViewModelStoreService } from './chat-session-view-model-store.service';
import { MenuManagerService } from './menu-manager.service';

import { ChatMessage, ToolCallState, ResourceItem } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { mkdir as mkdirAsync, writeFile as writeFileAsync } from '../core/async-fs';
import type { MetricsSnapshot, RenderEvent, TurnRequest, TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import { MessageDisplayHelper } from '../helpers/message-display.helper';
import { SessionLifecycleHelper } from '../helpers/session-lifecycle.helper';
import { SchematicIframeProgressProjector } from '../helpers/schematic-iframe-progress-projector';
import { createSessionLifecycleHostSessionSaveBridge } from '../helpers/session-lifecycle-save-bridge';
import { getUserSelectedToolsForRequest } from '../helpers/lex-agent-bootstrap';
import type {
  LexOwnerFacade,
  LexTurnResponsesHydrationVisibility,
} from '../helpers/lex-stream.helper';
import {
  buildTurnResponseAssistantMessageProjection,
  buildTurnResponseUserMessageProjection,
} from '../core/turn-response-stream-contract';
import { ChatSendCoordinator } from '../helpers/chat-send-coordinator';
import { ChatStopCoordinator } from '../helpers/chat-stop-coordinator';
import { ChatConversationActionCoordinator } from '../helpers/chat-conversation-action-coordinator';
import { ChatAiNoticeCoordinator } from '../helpers/chat-ai-notice-coordinator';
import { ChatExternalInputCoordinator } from '../helpers/chat-external-input-coordinator';
import { ChatSessionBoundaryController } from '../helpers/chat-session-boundary-controller';
import type {
  ChatPendingRequestKind,
  PendingFollowupUserSelectedTools,
  PendingFollowupRequest,
  PreparedPendingFollowupRequest,
} from '../helpers/chat-pending-request';
import { createChatSessionActionState, type ChatSessionActionState } from '../helpers/chat-request-controller';
import { ChatSwitchCoordinator } from '../helpers/chat-switch-coordinator';

const AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY = '__AILY_CHAT_AGENT_LOOP_PENDING_COUNT__';
let chatRuntimeViewIdSeed = 0;

function updateAilyChatAgentLoopPendingCount(delta: number): void {
  const global = globalThis as Record<string, unknown>;
  const current = typeof global[AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY] === 'number'
    ? global[AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY] as number
    : 0;
  global[AILY_CHAT_AGENT_LOOP_PENDING_COUNT_KEY] = Math.max(0, current + delta);
}

function createRuntimeViewId(scope: string): ChatRuntimeHostViewId {
  const normalizedScope = typeof scope === 'string' && scope.trim().length > 0
    ? scope.trim()
    : 'view';
  chatRuntimeViewIdSeed += 1;
  return `${normalizedScope}:${Date.now().toString(36)}:${chatRuntimeViewIdSeed.toString(36)}`;
}

function createRuntimeHostShellStateKey(
  state: ChatRuntimeHostSessionState | null | undefined,
  runtimeViewId: ChatRuntimeHostViewId,
): string {
  if (!state) {
    return '';
  }

  return JSON.stringify({
    status: state.status,
    requestInProgress: state.requestInProgress,
    activeTurnId: state.activeTurnId ?? null,
    attachedView: Array.isArray(state.attachedViewIds)
      && state.attachedViewIds.includes(runtimeViewId),
    selectedMode: state.selectedMode ?? null,
    providerOptions: state.providerOptions ?? null,
    currentModel: state.currentModel ?? null,
  });
}

function createRuntimeHostRequestStateKey(
  state: ChatRuntimeHostSessionState | null | undefined,
  runtimeViewId: ChatRuntimeHostViewId,
): string {
  if (!state) {
    return '';
  }
  return JSON.stringify({
    status: state.status,
    requestInProgress: state.requestInProgress,
    activeTurnId: state.activeTurnId ?? null,
    attachedView: Array.isArray(state.attachedViewIds)
      && state.attachedViewIds.includes(runtimeViewId),
  });
}

function createRuntimeHostConfigurationStateKey(
  state: ChatRuntimeHostSessionState | null | undefined,
): string {
  if (!state) {
    return '';
  }
  return JSON.stringify({
    selectedMode: state.selectedMode ?? null,
    providerOptions: state.providerOptions ?? null,
    currentModel: state.currentModel ?? null,
  });
}

type VisibleSessionProjectionResetOptions = {
  readonly clearResolvedActiveModel?: boolean;
  readonly clearTurns?: boolean;
  readonly resetContextBudget?: boolean;
  readonly clearEditSummary?: boolean;
  readonly resetToolCallingIteration?: boolean;
  readonly detectChanges?: boolean;
};

type HostSubmitExecutionSnapshot = {
  readonly selectedMode: ChatSelectedMode;
  readonly providerOptions: HostSessionProviderOptions;
};

type SubmitUserTextOptions = {
  readonly clearInput?: boolean;
  readonly sessionId?: string | null;
  readonly executionSnapshot?: HostSubmitExecutionSnapshot | null;
};

function clonePendingFollowupRequestMetadata(
  requestMetadata?: TurnRequest['metadata'],
): TurnRequest['metadata'] | undefined {
  if (!requestMetadata) {
    return undefined;
  }

  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(requestMetadata);
  }

  return JSON.parse(JSON.stringify(requestMetadata)) as TurnRequest['metadata'];
}

function readRequestMetadataRequestId(
  requestMetadata?: Record<string, unknown> | null,
): string | null {
  const requestId = typeof requestMetadata?.['requestId'] === 'string'
    ? requestMetadata['requestId'].trim()
    : '';
  return requestId || null;
}

function readPreparedPendingFollowupRequestId(
  prepared?: PreparedPendingFollowupRequest | null,
): string | null {
  return readRequestMetadataRequestId((prepared?.requestMetadata ?? null) as Record<string, unknown> | null);
}

function clonePreparedPendingFollowupRequest(
  prepared: PreparedPendingFollowupRequest,
): PreparedPendingFollowupRequest {
  const resourceItems = Array.isArray(prepared.resourceItems) && prepared.resourceItems.length > 0
    ? prepared.resourceItems.map((item) => ({ ...item }))
    : undefined;
  const sessionAllowedPaths = Array.isArray(prepared.sessionAllowedPaths) && prepared.sessionAllowedPaths.length > 0
    ? [...prepared.sessionAllowedPaths]
    : undefined;
  const userSelectedTools = prepared.userSelectedTools
    ? { ...prepared.userSelectedTools }
    : undefined;

  return {
    ...prepared,
    ...(prepared.requestMetadata
      ? { requestMetadata: clonePendingFollowupRequestMetadata(prepared.requestMetadata) }
      : {}),
    ...(resourceItems ? { resourceItems } : {}),
    ...(sessionAllowedPaths ? { sessionAllowedPaths } : {}),
    ...(userSelectedTools ? { userSelectedTools } : {}),
  };
}

function clonePendingFollowupRequest(request: PendingFollowupRequest): PendingFollowupRequest {
  return {
    ...request,
    prepared: clonePreparedPendingFollowupRequest(request.prepared),
  };
}

function mergePreparedPendingFollowupRequests(
  requests: readonly PendingFollowupRequest[],
): PreparedPendingFollowupRequest {
  if (requests.length === 1) {
    return clonePreparedPendingFollowupRequest(requests[0].prepared);
  }

  const [firstRequest] = requests;
  const mergedPrepared = firstRequest
    ? clonePreparedPendingFollowupRequest(firstRequest.prepared)
    : undefined;
  const resourceItems = dedupePendingResourceItems(requests.flatMap((request) => request.prepared.resourceItems ?? []));
  const sessionAllowedPaths = dedupePendingAllowedPaths(requests.flatMap((request) => request.prepared.sessionAllowedPaths ?? []));
  const userSelectedTools = mergePendingUserSelectedTools(requests.map((request) => request.prepared.userSelectedTools));

  return {
    ...mergedPrepared,
    text: requests.map((request) => request.prepared.text).join('\n\n'),
    llmText: requests.map((request) => request.prepared.llmText).join('\n\n'),
    displayText: requests.map((request) => request.prepared.displayText).join('\n\n'),
    ...(resourceItems ? { resourceItems } : {}),
    ...(sessionAllowedPaths ? { sessionAllowedPaths } : {}),
    ...(userSelectedTools ? { userSelectedTools } : {}),
  };
}

function dedupePendingResourceItems(resourceItems: readonly ResourceItem[]): ResourceItem[] | undefined {
  if (resourceItems.length === 0) {
    return undefined;
  }

  const seen = new Set<string>();
  const deduped: ResourceItem[] = [];
  for (const item of resourceItems) {
    const key = [
      item.type,
      item.path ?? '',
      item.url ?? '',
      item.name,
      item.blockId ?? '',
      item.blockContext ?? '',
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...item });
  }

  return deduped.length > 0 ? deduped : undefined;
}

function dedupePendingAllowedPaths(paths: readonly string[]): string[] | undefined {
  if (paths.length === 0) {
    return undefined;
  }

  const deduped = Array.from(new Set(paths.filter((path): path is string => typeof path === 'string' && path.length > 0)));
  return deduped.length > 0 ? deduped : undefined;
}

function mergePendingUserSelectedTools(
  selectedToolsSnapshots: readonly (PendingFollowupUserSelectedTools | undefined)[],
): PendingFollowupUserSelectedTools | undefined {
  const merged: Record<string, boolean> = {};

  for (const snapshot of selectedToolsSnapshots) {
    if (!snapshot) {
      continue;
    }

    for (const [toolName, selected] of Object.entries(snapshot)) {
      merged[toolName] = merged[toolName] === true || selected === true;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

import { ChatSubscriptionCoordinator } from '../helpers/chat-subscription-coordinator';
import {
  ChatTaskActionCoordinator,
  type ChatTaskActionDetail,
  type ChatTaskActionEvent,
} from '../helpers/chat-task-action-coordinator';
import { HostSessionRestoreBridge } from '../helpers/host-session-restore-bridge';
import type { HostSessionSaveTarget } from '../helpers/host-session-save-bridge';
import {
  buildHostSessionCurrentPickerInputState,
  createHostSessionProviderOptionsKey,
  normalizeHostSessionProviderOptions,
  resolveHostSessionSelectedModeFromMetadata,
  type HostSessionProviderOptions,
} from '../helpers/host-session-input-state';
import { buildHostSessionCurrentPickerRoutingSummary } from '../helpers/host-session-request-routing';
import { buildHostSessionTurnRuntimeTruth } from '../helpers/host-session-runtime-truth';
import { ChatViewAdapter } from './chat-view-adapter';
import { ChatPartStore } from '../core/chat-part-store';
import {
  ChatVisibleTranscriptModel,
  type ChatVisibleTranscriptChange,
} from '../core/chat-visible-transcript-model';
import type { IChatContext } from '../core/chat-context';
import type { DialogTurnContext } from '../core/user-turn-action-target';
import { EditActionsHelper, type RestoreCheckpointConfirmation } from '../helpers/edit-actions.helper';
import {
  buildCheckpointRestoreSurface,
  type CheckpointRestoreSurface,
} from '../helpers/checkpoint-restore-visibility';
import {
  canRedoSessionCheckpointTimeline,
  createSessionCheckpointTimelineState,
  getSessionCheckpointHiddenTurnResponses,
  getSessionCheckpointVisibleTurnResponses,
  type SessionCheckpointTimelineState,
} from '../helpers/session-checkpoint-timeline-model';
import {
  buildPlanReviewInteractionAction,
  buildPlanReviewResumeContent,
  readPendingPlanReview,
} from '../helpers/host-session-restore-bridge';
import { UserInteractionHelper } from '../helpers/user-interaction.helper';
import { buildChatDialogViewItems, type ChatDialogViewItem } from '../helpers/chat-dialog-view-items';
import type {
  ChatVisibleTranscriptDialogItem,
  ChatVisibleTranscriptDialogItemPatch,
} from '../core/chat-visible-transcript-model';
import { getTurnResponseResolvedModelName } from '../helpers/turn-response-response-model';
import { UnsaveDialogComponent, type UnsaveDialogData } from '../../../main-window/components/unsave-dialog/unsave-dialog.component';
import {
  applyHostResponseVoteToState,
  buildHostRequestModel,
  buildHostResponseStateFromCanonical,
  buildHostProjectionStateFromPersistedRecord,
  LiveHostRequestGraphCache,
  type HostItemLifecycleSnapshot,
  type HostRequestModel,
  type HostResponseProjection,
  type HostResponseVoteDirection,
  type HostTurnResponseState,
} from '../helpers/host-turn-response-state';
import { ChatPerformanceTracer } from './chat-perf-tracer';

const INTERACTIVE_PLAN_REVIEW_ACTION_ID = 'interactive';
const EXIT_ONLY_PLAN_REVIEW_ACTION_ID = 'exit_only';
const START_IMPLEMENTATION_PLAN_REVIEW_ACTION_ID = 'start_implementation';

interface VisibleTranscriptAttachment {
  readonly sessionId: string;
  readonly model: ChatVisibleTranscriptModel;
  readonly generation: number;
}

interface VisibleTranscriptProjectionSnapshot {
  readonly sessionResource: string;
  readonly projectionSource: 'model' | 'runtime' | 'empty';
  readonly generation: number;
  readonly itemCount: number;
  readonly changedItemCount: number;
  readonly changedItemIds: readonly string[];
  readonly changedKinds: Readonly<Record<string, number>>;
  readonly runningItemIds: readonly string[];
}
const START_IMPLEMENTATION_LABEL = 'start implementation';
const START_IMPLEMENTATION_PROMPT = 'start implementation';
const AUTO_PLAN_REVIEW_PERMISSION_LEVEL = 'autopilot';
const AUTO_PLAN_REVIEW_ACTION_ORDER = ['autopilot', 'autopilot_fleet', 'interactive', 'exit_only'] as const;
const TEST_SETUP_CONFIRMATION_PRIMARY_LABEL = '先设置测试';
const TEST_SETUP_CONFIRMATION_PRIMARY_TOOLTIP = '先补齐当前项目的最小测试环境，再继续后续测试工作';
const TEST_SETUP_CONFIRMATION_REJECT_LABEL = '继续当前请求';
const TEST_SETUP_CONFIRMATION_REJECT_TOOLTIP = '跳过这一步，直接继续当前测试生成请求';
const REQUEST_QUOTA_INPUT_NOTICE_THRESHOLDS = [50, 75, 90, 95];
const BACKGROUND_SESSION_TRACE_FLAG = 'aily.chat.traceBackgroundSession';
const BACKGROUND_SESSION_TRACE_GLOBAL_KEYS = [
  '__AILY_CHAT_TRACE_BACKGROUND_SESSION__',
  'AILY_CHAT_TRACE_BACKGROUND_SESSION',
] as const;

function parseBackgroundSessionTraceFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function isBackgroundSessionTraceEnabled(): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of BACKGROUND_SESSION_TRACE_GLOBAL_KEYS) {
      if (parseBackgroundSessionTraceFlag(runtime[key])) {
        return true;
      }
    }
    const localStorageValue = globalThis.localStorage?.getItem?.(BACKGROUND_SESSION_TRACE_FLAG);
    return parseBackgroundSessionTraceFlag(localStorageValue);
  } catch {
    return false;
  }
}

function traceBackgroundSessionExecution(event: string, details: Record<string, unknown>): void {
  if (!isBackgroundSessionTraceEnabled()) {
    return;
  }
  // console.info('[AilyChat][bg-session][execution]', event, details);
}

function isRequestStateTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceRequestState', [
    '__AILY_CHAT_TRACE_REQUEST_STATE__',
    'AILY_CHAT_TRACE_REQUEST_STATE',
  ]);
}

function isSendDebugTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceSendDebug', [
    '__AILY_CHAT_TRACE_SEND_DEBUG__',
    'AILY_CHAT_TRACE_SEND_DEBUG',
  ]);
}

function isSendTitleTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceSendTitle', [
    '__AILY_CHAT_TRACE_SEND_TITLE__',
    'AILY_CHAT_TRACE_SEND_TITLE',
  ]);
}

function isAgentRuntimeModeTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceAgentRuntimeMode', [
    '__AILY_CHAT_TRACE_AGENT_RUNTIME_MODE__',
    'AILY_CHAT_TRACE_AGENT_RUNTIME_MODE',
  ]);
}

function isRuntimeInteractionProjectionTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceRuntimeInteraction', [
    '__AILY_CHAT_TRACE_RUNTIME_INTERACTION__',
    'AILY_CHAT_TRACE_RUNTIME_INTERACTION',
  ]);
}

function isActiveTurnDurabilityTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceActiveTurnDurability', [
    '__AILY_CHAT_TRACE_ACTIVE_TURN_DURABILITY__',
    'AILY_CHAT_TRACE_ACTIVE_TURN_DURABILITY',
  ]);
}

function traceActiveTurnDurability(phase: string, details: Record<string, unknown>): void {
  if (!isActiveTurnDurabilityTraceEnabled()) {
    return;
  }
  console.info('[AilyChat][ActiveTurnDurability]', {
    phase,
    ...details,
  });
}

type PendingPlanReview = NonNullable<ReturnType<typeof readPendingPlanReview>>;

function buildRuntimeQuotaOverlayFromTurnResponses(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): ChatSessionRuntimeQuotaOverlay | null {
  const requestQuotaState = readRequestQuotaStateTurnSidecar(turnResponses);
  const requestQuotaSnapshot = (requestQuotaState
    ? createRequestQuotaSnapshotFromServiceState(requestQuotaState)
    : null) ?? createRequestQuotaSnapshot(turnResponses);
  const requestInputNotice = createRuntimeRequestQuotaNotice(requestQuotaState, requestQuotaSnapshot);
  const authQuotaInfo = createAuthQuotaInfoFromRequestQuotaState(requestQuotaState);
  if (!requestQuotaState && !requestQuotaSnapshot && !requestInputNotice && !authQuotaInfo) {
    return null;
  }

  return {
    ...(requestQuotaState ? { requestQuotaState } : {}),
    ...(requestQuotaSnapshot ? { requestQuotaSnapshot } : {}),
    ...(requestInputNotice ? { requestInputNotice } : {}),
    ...(authQuotaInfo ? { authQuotaInfo } : {}),
    updatedAt: Date.now(),
  };
}

function createRuntimeRequestQuotaNotice(
  requestQuotaState: RequestQuotaServiceState | null,
  requestQuotaSnapshot: RequestQuotaSnapshot | null,
) {
  const activeFailureNotice = createRequestQuotaInputNotice(requestQuotaSnapshot);
  if (activeFailureNotice) {
    return activeFailureNotice;
  }

  return createRuntimeRateLimitThresholdNotice(
    requestQuotaState?.rateLimitSnapshots?.['session'],
    'session',
  ) ?? createRuntimeRateLimitThresholdNotice(
    requestQuotaState?.rateLimitSnapshots?.['weekly'],
    'weekly',
  );
}

function createRuntimeRateLimitThresholdNotice(
  snapshot: RequestQuotaUsageSnapshot | undefined,
  type: 'session' | 'weekly',
) {
  if (!snapshot || snapshot.unlimited) {
    return null;
  }

  const percentUsed = 100 - snapshot.percentRemaining;
  if (percentUsed < REQUEST_QUOTA_INPUT_NOTICE_THRESHOLDS[0]) {
    return null;
  }

  return createRequestRateLimitInputNotice(type, Math.round(percentUsed), snapshot.resetAt);
}

function createAuthQuotaInfoFromRequestQuotaState(
  requestQuotaState: RequestQuotaServiceState | null | undefined,
): AuthQuotaInfo | null {
  const premiumInteractions = requestQuotaState?.quotaSnapshots?.['premium_interactions'];
  if (!premiumInteractions) {
    return null;
  }

  return {
    source: 'token',
    usageUnit: 'interactions',
    quota: premiumInteractions.entitlement,
    used: premiumInteractions.entitlement >= 0
      ? Math.max(0, premiumInteractions.entitlement - premiumInteractions.remaining)
      : 0,
    remaining: premiumInteractions.remaining,
    percentRemaining: Math.max(0, Math.min(100, premiumInteractions.percentRemaining)),
    ...(premiumInteractions.unlimited === true || premiumInteractions.entitlement < 0
      ? { unlimited: true }
      : {}),
    ...(typeof premiumInteractions.overageCount === 'number'
      ? { overageCount: premiumInteractions.overageCount }
      : {}),
    ...(typeof premiumInteractions.overagePermitted === 'boolean'
      ? { overagePermitted: premiumInteractions.overagePermitted }
      : {}),
    ...(typeof premiumInteractions.resetAt === 'string'
      ? { resetTime: premiumInteractions.resetAt }
      : {}),
  };
}

function findRuntimePlanReviewAction(
  actions: readonly RuntimePlanReviewAction[],
  actionId: string | undefined,
): RuntimePlanReviewAction | undefined {
  const normalizedActionId = typeof actionId === 'string' ? actionId.trim() : '';
  if (!normalizedActionId) {
    return undefined;
  }

  return actions.find((action) => action.id === normalizedActionId);
}

function resolveOptionalUiSessionOwner(
  owner: unknown,
  sessionId?: string | null,
): string {
  const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (explicitSessionId) {
    return explicitSessionId;
  }

  const viewResource = (owner as {
    chatSessionViewModelStore?: Pick<ChatSessionViewModelStoreService, 'currentSessionResource'>;
  } | null | undefined)?.chatSessionViewModelStore?.currentSessionResource;
  return typeof viewResource === 'string'
    ? viewResource.trim()
    : '';
}

interface SharedHostProjectionStateOptions {
  readonly sessionId: string | null;
  readonly attachedView?: boolean;
}

function buildRuntimeHostProjectionState(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): HostTurnResponseState | null {
  if (!Array.isArray(turnResponses)) {
    return null;
  }

  return buildHostProjectionStateFromPersistedRecord({ turnResponses });
}

function readRuntimeProjectionStateFromEngine(
  engine: object,
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): HostTurnResponseState | null {
  const getHostResponseState = (engine as Record<string, unknown>)['getHostResponseState'];
  if (typeof getHostResponseState === 'function') {
    return getHostResponseState.call(engine) as HostTurnResponseState | null;
  }

  return buildRuntimeHostProjectionState(turnResponses);
}

function resolveEngineRuntimeSessionType(
  engine: Record<string, unknown>,
  sessionId: string,
): string {
  const normalizedSessionId = typeof sessionId === 'string'
    ? sessionId.trim()
    : '';
  const model = readEngineRuntimeSessionModel(engine, normalizedSessionId);
  if (typeof model?.sessionType === 'string' && model.sessionType.trim()) {
    return model.sessionType;
  }

  const chatService = (engine['chatService'] ?? {}) as {
    readonly currentSessionId?: unknown;
    readonly currentSessionType?: unknown;
  };
  const currentSessionId = typeof chatService.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId) {
    return typeof chatService.currentSessionType === 'string'
      ? chatService.currentSessionType
      : '';
  }

  const getCurrentProjectPath = engine['getCurrentProjectPath'];
  const projectPathHint = typeof getCurrentProjectPath === 'function'
    ? getCurrentProjectPath.call(engine)
    : undefined;
  const sessionItemController = (engine['chatSessionItemsService'] as {
    readonly sessionItemController?: {
      getChatSessionType?: (sessionId?: string, projectPathHint?: string | null) => string;
    };
  } | undefined)?.sessionItemController;

  const durableSessionType = sessionItemController?.getChatSessionType?.(normalizedSessionId, projectPathHint) ?? '';
  if (durableSessionType) {
    return durableSessionType;
  }

  return normalizedSessionId === currentSessionId && typeof chatService.currentSessionType === 'string'
    ? chatService.currentSessionType
    : '';
}

function resolveEngineRuntimeSessionCapabilities(
  engine: Record<string, unknown>,
  sessionId: string,
) {
  return resolveChatSessionRuntimeCapabilities(resolveEngineRuntimeCapabilityOwner(engine, sessionId));
}

function resolveEngineRuntimeSessionConcurrencyScope(
  engine: Record<string, unknown>,
  sessionId: string,
): string | undefined {
  return resolveChatSessionRuntimeConcurrencyScope(resolveEngineRuntimeCapabilityOwner(engine, sessionId));
}

function resolveEngineRuntimeCapabilityOwner(
  engine: Record<string, unknown>,
  sessionId: string,
) {
  const sessionType = resolveEngineRuntimeSessionType(engine, sessionId);
  const providerOptions = resolveEngineRuntimeSessionProviderOptions(engine, sessionId);
  const requestRouting = resolveEngineRuntimeSessionRequestRouting(engine, sessionId);
  const customizationProvider = resolveEngineRuntimeSessionCustomizationProvider(engine, sessionId);
  return {
    sessionType,
    providerTarget: providerOptions?.folderPath,
    remoteProviderHandle: providerOptions?.remoteProviderHandle,
    customAgentTarget: requestRouting?.customAgentTarget,
    customModeSource: customizationProvider?.customModeSource,
    sessionCustomizationProviderLabel: customizationProvider?.providerLabel,
    sessionCustomizationProviderIconId: customizationProvider?.providerIconId,
  };
}

function resolveEngineRuntimeSessionProviderOptions(
  engine: Record<string, unknown>,
  sessionId: string,
): { readonly folderPath?: string | null; readonly remoteProviderHandle?: string | null } | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const model = readEngineRuntimeSessionModel(engine, normalizedSessionId);
  if (model) {
    const providerOptions = model.inputState?.providerOptions;
    return {
      folderPath: providerOptions?.folderPath ?? model.projectPath ?? null,
      remoteProviderHandle: null,
    };
  }

  const chatService = engine['chatService'] as {
    readonly currentSessionId?: string;
    readonly currentSessionPath?: string;
    readonly currentRemoteProviderHandle?: string;
  } | undefined;
  const currentSessionId = typeof chatService?.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId) {
    return {
      folderPath: chatService?.currentSessionPath ?? null,
      remoteProviderHandle: chatService?.currentRemoteProviderHandle ?? null,
    };
  }

  const getCurrentProjectPath = engine['getCurrentProjectPath'];
  const projectPathHint = typeof getCurrentProjectPath === 'function'
    ? getCurrentProjectPath.call(engine)
    : undefined;
  const sessionItemController = (engine['chatSessionItemsService'] as {
    readonly sessionItemController?: {
      getChatSessionProviderOptions?: (
        sessionId?: string,
        projectPathHint?: string | null,
      ) => { readonly folderPath?: string | null; readonly remoteProviderHandle?: string | null };
    };
  } | undefined)?.sessionItemController;

  const durableProviderOptions = sessionItemController?.getChatSessionProviderOptions?.(normalizedSessionId, projectPathHint) ?? null;
  if (durableProviderOptions) {
    return durableProviderOptions;
  }

  return normalizedSessionId === currentSessionId
    ? {
        folderPath: chatService?.currentSessionPath ?? null,
        remoteProviderHandle: chatService?.currentRemoteProviderHandle ?? null,
      }
    : null;
}

function resolveEngineRuntimeSessionRequestRouting(
  engine: Record<string, unknown>,
  sessionId: string,
): { readonly customAgentTarget?: string | null } | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const model = readEngineRuntimeSessionModel(engine, normalizedSessionId);
  if (model) {
    return {
      customAgentTarget: model.inputState?.selectedMode?.customAgentTarget ?? null,
    };
  }

  const chatService = engine['chatService'] as {
    readonly currentSessionId?: string;
    readonly currentResolvedMode?: { readonly customAgentTarget?: string | null };
    readonly selectedMode?: { readonly customAgentTarget?: string | null };
  } | undefined;
  const currentSessionId = typeof chatService?.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId) {
    return {
      customAgentTarget: chatService?.selectedMode?.customAgentTarget
        ?? chatService?.currentResolvedMode?.customAgentTarget
        ?? null,
    };
  }

  const getCurrentProjectPath = engine['getCurrentProjectPath'];
  const projectPathHint = typeof getCurrentProjectPath === 'function'
    ? getCurrentProjectPath.call(engine)
    : undefined;
  const sessionItemController = (engine['chatSessionItemsService'] as {
    readonly sessionItemController?: {
      getChatSessionRequestRouting?: (
        sessionId?: string,
        projectPathHint?: string | null,
      ) => { readonly customAgentTarget?: string | null } | undefined;
    };
  } | undefined)?.sessionItemController;

  const durableRequestRouting = sessionItemController?.getChatSessionRequestRouting?.(normalizedSessionId, projectPathHint) ?? null;
  if (durableRequestRouting) {
    return durableRequestRouting;
  }

  return normalizedSessionId === currentSessionId
    ? {
        customAgentTarget: chatService?.selectedMode?.customAgentTarget
          ?? chatService?.currentResolvedMode?.customAgentTarget
          ?? null,
      }
    : null;
}

function resolveEngineRuntimeSessionCustomizationProvider(
  engine: Record<string, unknown>,
  sessionId: string,
): {
  readonly customModeSource?: string | null;
  readonly providerLabel?: string | null;
  readonly providerIconId?: string | null;
} | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const model = readEngineRuntimeSessionModel(engine, normalizedSessionId);
  const chatService = engine['chatService'] as {
    readonly currentSessionId?: string;
    readonly activeCustomModeSource?: string;
    readonly activeSessionCustomizationProviderMetadata?: {
      readonly label?: string;
      readonly iconId?: string;
    };
  } | undefined;
  const currentSessionId = typeof chatService?.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId) {
    return {
      customModeSource: chatService?.activeCustomModeSource ?? null,
      providerLabel: chatService?.activeSessionCustomizationProviderMetadata?.label ?? null,
      providerIconId: chatService?.activeSessionCustomizationProviderMetadata?.iconId ?? null,
    };
  }

  const getCurrentProjectPath = engine['getCurrentProjectPath'];
  const projectPathHint = typeof getCurrentProjectPath === 'function'
    ? getCurrentProjectPath.call(engine)
    : undefined;
  const sessionItemController = (engine['chatSessionItemsService'] as {
    readonly sessionItemController?: {
      getChatSessionCustomizationProviderMetadata?: (
        sessionId?: string,
        projectPathHint?: string | null,
      ) => {
        readonly customModeSource?: string | null;
        readonly providerLabel?: string | null;
        readonly providerIconId?: string | null;
      } | undefined;
    };
  } | undefined)?.sessionItemController;

  const durableCustomizationProvider = sessionItemController?.getChatSessionCustomizationProviderMetadata?.(normalizedSessionId, projectPathHint) ?? null;
  if (durableCustomizationProvider) {
    return durableCustomizationProvider;
  }

  if (model) {
    return null;
  }

  return normalizedSessionId === currentSessionId
    ? {
        customModeSource: chatService?.activeCustomModeSource ?? null,
        providerLabel: chatService?.activeSessionCustomizationProviderMetadata?.label ?? null,
        providerIconId: chatService?.activeSessionCustomizationProviderMetadata?.iconId ?? null,
      }
    : null;
}

function readEngineRuntimeSessionModel(
  engine: Record<string, unknown>,
  sessionId: string,
): ChatSessionModel | undefined {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) {
    return undefined;
  }

  const modelStore = engine['chatSessionModelStore'] as {
    get?: (sessionResource: string) => ChatSessionModel | undefined;
  } | undefined;
  return modelStore?.get?.(normalizedSessionId);
}

function resolvePlanReviewPermissionLevel(
  pendingReview: PendingPlanReview,
  result: RuntimePlanReviewDecision,
  currentRequestPermissionLevel?: string,
): string | undefined {
  if (!result.approved) {
    return undefined;
  }

  if (currentRequestPermissionLevel === AUTO_PLAN_REVIEW_PERMISSION_LEVEL) {
    return AUTO_PLAN_REVIEW_PERMISSION_LEVEL;
  }

  const permissionLevel = findRuntimePlanReviewAction(pendingReview.actions, result.actionId)?.permissionLevel;
  return typeof permissionLevel === 'string' && permissionLevel.trim()
    ? permissionLevel.trim()
    : undefined;
}

function resolvePlanReviewAutopilotDecision(
  pendingReview: PendingPlanReview,
): RuntimePlanReviewDecision {
  const defaultActionId = pendingReview.actions.find((action) => action.default)?.id;
  if (typeof defaultActionId === 'string' && defaultActionId.trim().length > 0) {
    return {
      approved: true,
      actionId: defaultActionId.trim(),
    };
  }

  for (const actionId of AUTO_PLAN_REVIEW_ACTION_ORDER) {
    if (pendingReview.actions.some((action) => action.id === actionId)) {
      return {
        approved: true,
        actionId,
      };
    }
  }

  return { approved: true };
}

function areProjectionTurnResponsesEquivalent(
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

    if (buildProjectionTurnSignature(leftTurn) !== buildProjectionTurnSignature(rightTurn)) {
      return false;
    }
  }

  return true;
}

function isProjectionStateAlignedWithTurnResponses(
  projectionState: HostTurnResponseState | null | undefined,
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): projectionState is HostTurnResponseState {
  if (!projectionState || !Array.isArray(turnResponses)) {
    return false;
  }

  const projectionTurns = projectionState.turnResponses;
  if (!Array.isArray(projectionTurns) || projectionTurns.length !== turnResponses.length) {
    return false;
  }

  for (let index = 0; index < turnResponses.length; index += 1) {
    const projectionTurn = projectionTurns[index];
    const canonicalTurn = turnResponses[index];
    if (projectionTurn.turnId !== canonicalTurn.turnId) {
      return false;
    }
    if ((projectionTurn.request?.content ?? '') !== (canonicalTurn.request?.content ?? '')
      || (projectionTurn.request?.displayContent ?? '') !== (canonicalTurn.request?.displayContent ?? '')) {
      return false;
    }

    const projectionUpdatedAt = projectionTurn.updatedAt ?? projectionTurn.response?.updatedAt ?? -1;
    const canonicalUpdatedAt = canonicalTurn.updatedAt ?? canonicalTurn.response?.updatedAt ?? -1;
    if (projectionUpdatedAt !== canonicalUpdatedAt) {
      return false;
    }

    const projectionResponse = projectionTurn.response;
    const canonicalResponse = canonicalTurn.response;
    if ((projectionResponse?.status ?? null) !== (canonicalResponse?.status ?? null)
      || (projectionResponse?.resultText ?? '') !== (canonicalResponse?.resultText ?? '')
      || (projectionResponse?.parts?.length ?? 0) !== (canonicalResponse?.parts?.length ?? 0)
      || (projectionResponse?.progressMessages?.length ?? 0) !== (canonicalResponse?.progressMessages?.length ?? 0)) {
      return false;
    }
  }

  return true;
}

function buildProjectionTurnSignature(turn: TurnResponseTurn): string {
  try {
    return JSON.stringify({
      turnId: turn.turnId,
      updatedAt: turn.updatedAt,
      request: turn.request,
      response: turn.response,
      rounds: turn.rounds,
      responseModel: turn.responseModel,
      usage: turn.usage,
    });
  } catch {
    return `${turn.turnId}|${turn.updatedAt ?? ''}`;
  }
}

function readLatestPlanReviewRequestPermissionLevel(
  turnResponses: readonly TurnResponseTurn[] | undefined,
): string | undefined {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return undefined;
  }

  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const metadata = asRecord(turnResponses[index]?.request?.metadata);
    if (!metadata) {
      continue;
    }

    const modeInfo = asRecord(metadata['modeInfo']);
    const requestRouting = asRecord(metadata['requestRouting']);
    const permissionLevel = normalizePlanReviewPermissionLevel(modeInfo?.['permissionLevel'])
      ?? normalizePlanReviewPermissionLevel(requestRouting?.['permissionLevel']);
    if (permissionLevel) {
      return permissionLevel;
    }
  }

  return undefined;
}
function normalizePlanReviewPermissionLevel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function shouldStartImplementationAfterPlanReview(
  result: RuntimePlanReviewDecision,
): boolean {
  if (!result.approved) {
    return false;
  }

  return result.actionId === START_IMPLEMENTATION_PLAN_REVIEW_ACTION_ID
    || result.actionId === INTERACTIVE_PLAN_REVIEW_ACTION_ID;
}

function resolveStartImplementationHandoff(
  mode: Pick<ChatResolvedMode, 'handOffs'> | null | undefined,
): ChatResolvedModeHandoff | undefined {
  const handOffs = mode?.handOffs ?? [];
  return handOffs.find((handoff) => handoff.prompt.trim().toLowerCase() === START_IMPLEMENTATION_PROMPT)
    ?? handOffs.find((handoff) => handoff.label.trim().toLowerCase() === START_IMPLEMENTATION_LABEL);
}

export interface ChatPaneSessionCommandHandlers {
  readonly requestNewChat?: () => Promise<void> | void;
}

@Injectable()
export class ChatEngineService implements IChatContext {
  private readonly chatViewState = inject(ChatViewService);
  private readonly modal = inject(NzModalService);
  private readonly chatSessionEntryStateService = inject(ChatSessionEntryStateService);
  private readonly chatSessionItemsService = inject(ChatSessionItemsService);
  private readonly chatSessionModelStore = inject(ChatSessionModelStoreService);
  private readonly chatSessionRuntimeStore = inject(ChatSessionRuntimeStoreService);
  private readonly chatRuntimeViewMirrorProjection = inject(ChatRuntimeViewMirrorProjectionService);
  private readonly pendingFollowupQueue = inject(ChatPendingFollowupQueueService);
  private readonly chatSessionViewModelStore = inject(ChatSessionViewModelStoreService);
  private readonly uiService = inject(UiService);
  private readonly electronRuntimeHost = createElectronChatRuntimeHostTransport();
  private readonly runtimeViewId = createRuntimeViewId('aily-chat-visible-transcript');
  private schematicIframeProgressProjector: SchematicIframeProgressProjector | null = null;

  private readonly entryPartStore = new ChatPartStore();
  // ==================== Part-based 消息模型（Phase 1） ====================
  /** Part 存储 facade：实际读写按当前 ChatViewModel.sessionResource 路由到 ChatSessionModel.partStore。 */
  readonly partStore: ChatPartStore = this.createSessionRoutedPartStore();
  private readonly liveHostRequestGraphCache = new LiveHostRequestGraphCache();
  private readonly pendingProtocolTruncations = new Map<string, ChatRuntimeHostProtocolTruncation>();
  private readonly pendingFollowupFlushAfterSettleSessionIds = new Set<string>();
  private readonly stoppingRuntimeSessionIds = new Set<string>();
  private readonly hostItemLifecyclePerfSnapshotHandle = ChatPerformanceTracer.registerExternalSnapshotProvider(
    'hostItemLifecycle',
    (): HostItemLifecycleSnapshot => this.liveHostRequestGraphCache.getItemLifecycleSnapshot(),
  );
  private readonly visibleTranscriptPerfSnapshotHandle = ChatPerformanceTracer.registerExternalSnapshotProvider(
    'visible_transcript',
    (): VisibleTranscriptProjectionSnapshot | null => this.readVisibleTranscriptProjectionSnapshot(),
  );
  private restoreCheckpointDialogOpen = false;
  private readonly messageDisplayContext = this.createMessageDisplayContext();
  private readonly userInteractionContext = this.createUserInteractionContext();
  private readonly editActionsContext = this.createEditActionsContext();
  private readonly hostSessionRestoreContext = this.createHostSessionRestoreContext();
  private readonly hostSessionRestoreBridge = new HostSessionRestoreBridge(this.hostSessionRestoreContext);
  private readonly sessionLifecycleContext = this.createSessionLifecycleContext();
  private readonly stopCoordinatorContext = this.createStopCoordinatorContext();
  private readonly switchCoordinatorContext = this.createSwitchCoordinatorContext();
  private readonly conversationActionCoordinatorContext = this.createConversationActionCoordinatorContext();
  private readonly externalInputCoordinatorContext = this.createExternalInputCoordinatorContext();
  private paneSessionCommandHandlers: ChatPaneSessionCommandHandlers = {};

  // ==================== 辅助类 ====================
  readonly msg = new MessageDisplayHelper(this.messageDisplayContext);

  readHostItemLifecycleSnapshot(): HostItemLifecycleSnapshot {
    return this.liveHostRequestGraphCache.getItemLifecycleSnapshot();
  }

  readVisibleTranscriptProjectionSnapshot(): VisibleTranscriptProjectionSnapshot | null {
    return this.visibleTranscriptProjectionSnapshot
      ? {
          ...this.visibleTranscriptProjectionSnapshot,
          changedItemIds: [...this.visibleTranscriptProjectionSnapshot.changedItemIds],
          runningItemIds: [...this.visibleTranscriptProjectionSnapshot.runningItemIds],
          changedKinds: { ...this.visibleTranscriptProjectionSnapshot.changedKinds },
        }
      : null;
  }
  readonly session = new SessionLifecycleHelper(this.sessionLifecycleContext);
  readonly lexStream = this.createLexRuntimeFacade();
  readonly editActions = new EditActionsHelper(this.editActionsContext);
  readonly sessionBoundary = new ChatSessionBoundaryController(this.editActions, {
    isBoundaryRewriteInProgress: () => this.isWaiting,
    warnBoundaryRewriteBlocked: () => this.message.warning('当前会话正在处理中，请先停止或等待完成后再操作检查点'),
    readCurrentSessionResource: () => this.resolveCurrentViewSessionResource(),
    readSessionCheckpointTimelineState: (sessionResource) => {
      const normalizedSessionResource = typeof sessionResource === 'string' ? sessionResource.trim() : '';
      return normalizedSessionResource
        ? this.chatSessionModelStore.get(normalizedSessionResource)?.getCheckpointTimelineState() ?? null
        : null;
    },
    readSessionTurnResponses: (sessionResource) => this.readSessionTurnResponses(sessionResource),
    getWorkspaceCheckpointPresentationMode: () => this.workspaceCheckpointPresentationMode,
    ensureWorkspaceCheckpointPresentationMode: () => (
      this.workspaceCheckpointProvider.ensurePresentationMode?.() ?? this.workspaceCheckpointPresentationMode
    ),
    getWorkspaceCheckpointAvailabilityDetail: () => (
      this.workspaceCheckpointProvider.getAvailabilityDetail?.() ?? { mode: this.workspaceCheckpointPresentationMode }
    ),
    logBoundaryDiagnostic: (message) => {
      AilyHost.get().log?.warn?.(`[AilyChat][GitCheckpoint] boundary ${message}`);
    },
    warnBoundaryActionUnavailable: (reason) => {
      switch (reason.reason) {
        case 'workspace-checkpoint-unavailable': {
          const detail = reason.workspaceCheckpointDetail;
          if (detail?.reason === 'git-not-found') {
            this.message.warning('当前 Blockly 环境未找到 Git。请安装 Git，并确保 git 命令位于 Blockly 可见路径中。');
            return;
          }
          if (detail?.reason === 'not-git-repository') {
            this.promptGitRepositoryInitialization();
            return;
          }
          if (detail?.reason === 'git-safe-directory') {
            this.message.warning('Git 拒绝访问当前仓库，原因是 safe.directory / 仓库所有权检查未通过。请在系统 Git 中信任该项目目录后重试。');
            return;
          }
          if (detail?.reason === 'git-probe-failed') {
            this.message.warning(`Git checkpoint 探测失败，不能安全执行该历史边界操作: ${detail.message ?? '未知错误'}`);
            return;
          }
          this.message.warning('当前工作区 checkpoint 尚未就绪，不能安全执行该历史边界操作');
          return;
        }
        case 'checkpoint-session-mismatch':
          this.message.warning('该检查点不属于当前会话，已阻止历史边界操作');
          return;
        case 'checkpoint-unavailable':
          this.message.warning('未找到该消息对应的检查点');
          return;
        case 'session-unavailable':
        default:
          this.message.warning('当前没有可操作的会话');
      }
    },
  });
  readonly interaction = new UserInteractionHelper(this.userInteractionContext);

  private promptGitRepositoryInitialization(): void {
    const workspaceRoot = AilyHost.get().project?.currentProjectPath
      ?? AilyHost.get().project?.projectRootPath
      ?? '';
    this.modal.confirm({
      nzTitle: '初始化 Git 仓库以启用检查点？',
      nzContent: workspaceRoot
        ? `当前项目不是 Git 仓库，无法安全执行检查点还原、重做或分叉。是否在当前项目目录初始化 Git 仓库？\n\n${workspaceRoot}`
        : '当前项目不是 Git 仓库，无法安全执行检查点还原、重做或分叉。是否初始化 Git 仓库？',
      nzOkText: '初始化 Git 仓库',
      nzCancelText: '取消',
      nzOnOk: async () => {
        const mode = await this.workspaceCheckpointProvider.initializeRepository();
        if (mode === 'git') {
          this.message.success('已初始化 Git 仓库，git-backed checkpoint 已启用。');
          this._syncDetectChanges?.();
          return;
        }
        const detail = this.workspaceCheckpointProvider.getAvailabilityDetail?.();
        this.message.warning(`Git 仓库初始化后仍未启用 checkpoint: ${detail?.message ?? '未知原因'}`);
      },
    });
  }
  private readonly sendCoordinator = new ChatSendCoordinator(
    this,
    () => this.resourceManager.getResourcesText(),
    (requestAgentId) => getUserSelectedToolsForRequest(
      {
        ailyChatConfigService: this.ailyChatConfigService,
        mcpService: this.mcpService,
      },
      requestAgentId,
      this.prjPath || this.prjRootPath || '',
    ),
    () => this.resourceManager.items,
    () => this.sessionAllowedPaths,
    (sessionId) => {
      const runtimeOwnerSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
      if (!runtimeOwnerSessionId) {
        return {};
      }
      const providerOptions = this.resolveVisibleSessionProviderOptionsSnapshot(runtimeOwnerSessionId);
      const selectedMode = this.resolveVisibleSelectedModeSnapshot(runtimeOwnerSessionId);

      return {
        runtimeOwnerSessionId,
        providerOptionsKey: createChatAgentRuntimeConfigKey(createHostSessionProviderOptionsKey(
          providerOptions,
        ), this.currentAgentRuntimeMode ?? this.chatService?.currentAgentRuntimeMode, this.resolveVisibleCurrentModelSnapshot(runtimeOwnerSessionId)),
        selectedMode,
        currentMode: selectedMode.modeId,
        currentResolvedMode: this.resolveVisibleResolvedModeSnapshot(runtimeOwnerSessionId),
        ...(providerOptions.permissionLevel ? { currentSessionPermissionLevel: providerOptions.permissionLevel } : {}),
        ...(providerOptions.approvalsReviewer ? { currentSessionApprovalsReviewer: providerOptions.approvalsReviewer } : {}),
        ...(providerOptions.approvalPolicy ? { currentSessionApprovalPolicy: providerOptions.approvalPolicy } : {}),
      };
    },
  );
  private readonly stopCoordinator = new ChatStopCoordinator(this.stopCoordinatorContext);
  private readonly conversationActionCoordinator = new ChatConversationActionCoordinator(this.conversationActionCoordinatorContext, {
    submitText: (text, sessionId) => this.submitUserText(text, { clearInput: false, sessionId }),
    rerunLastRequest: () => this.sessionBoundary.regenerateTurn(),
  });
  private readonly aiNoticeCoordinator = new ChatAiNoticeCoordinator({
    stop: (sessionId) => this.stop(sessionId),
    updateNotice: (config) => {
      AilyHost.get().notice?.update(config);
    },
    clearNotice: () => {
      AilyHost.get().notice?.clear();
    },
  });
  private readonly switchCoordinator = new ChatSwitchCoordinator(this.switchCoordinatorContext);
  private readonly subscriptionCoordinator = new ChatSubscriptionCoordinator(this, {
    receiveTextFromExternal: (text, options) => this.receiveTextFromExternal(text, options),
    showAiWritingNotice: (isWaiting) => this.showAiWritingNotice(isWaiting),
    handleTaskAction: (event) => this.handleTaskAction(event),
    flushPendingAutoSend: () => this.flushPendingAutoSend(),
    syncAuthQuotaState: () => this.authQuotaStateService.syncAuthSnapshotFromHost(),
    refreshRequestQuotaState: () => this.refreshRequestQuotaState(),
    refreshSessionProviderOptionsSources: () => this.refreshSessionProviderOptionsSources(),
    clearAuthQuotaState: () => this.authQuotaStateService.clear(),
    clearRequestQuotaState: () => this.requestQuotaStateService.clear(),
  });
  private readonly externalInputCoordinator = new ChatExternalInputCoordinator(this.externalInputCoordinatorContext, {
    retryLastAction: () => this.retryLastAction(),
    regenerateTurn: () => this.sessionBoundary.regenerateTurn(),
    undoLastEdits: () => this.editActions.undoLastEdits(),
    newChat: () => this.requestNewChatFromPane(),
    ensureSessionReadyForSubmit: () => this.ensureSessionReadyForSubmit(),
      submitText: (text, clearInput, sessionId) => this.submitUserText(text, { clearInput, sessionId }),
    focusInput: () => this.scheduleComposerInputFocus(),
    schedulePostInputWork: (work) => {
      setTimeout(work, 100);
    },
  });
  private readonly taskActionCoordinator = new ChatTaskActionCoordinator(this.sessionBoundary, this.editActions, {
    continueConversation: () => this.continueConversation(),
    retryLastAction: () => this.retryLastAction(),
    newChat: () => this.requestNewChatFromPane(),
    voteResponse: (target, vote) => this.voteResponse(target, vote),
    warnUnknownAction: (action) => {
      console.warn('未知的任务操作:', action);
    },
  });

  // ==================== rAF 批处理 UI 适配器 ====================
  /** 流式文本走 rAF 合并，每帧只触发一次 Angular CD（参考 Copilot FetchStreamSource pause/unpause） */
  readonly viewAdapter: ChatViewAdapter = null!; // 由 constructor 初始化

  // ==================== 公共状态（模板绑定） ====================
  list: ChatMessage[] = [];
  private legacyInputValue = '';
  get inputValue(): string {
    return this.readSessionInputValue(this.resolveCurrentViewSessionResource()) ?? this.legacyInputValue;
  }
  set inputValue(value: string) {
    this.setSessionInputValue(this.resolveCurrentViewSessionResource(), value);
  }
  prjRootPath = '';
  prjPath = '';
  currentUserGroup: string[] = [];
  isCompleted = false;
  isLoggedIn = false;
  debug = false;

  // ==================== 半公共状态 ====================
  sessionAllowedPaths: string[] = [];
  currentMessageSource: string = MAIN_AGENT_TYPE;
  toolCallStates: { [key: string]: string } = {};

  // ==================== 内部状态（helper 可访问） ====================
  isSessionStarting = false;
  hasInitializedForThisLogin = false;
  isCancelled = false;
  /**
   * @deprecated Visible projection owner stamp for the current view adapter only.
   * Model truth must live on ChatSessionModel.hostProjectionState/turnResponses,
   * keyed by ChatSessionViewModel.sessionResource.
   */
  private visibleProjectionSessionId: string | null = null;
  private currentViewHostProjectionCache: {
    sessionResource: string;
    turnResponses: readonly TurnResponseTurn[];
    turnCount: number;
    lastTurnId: string;
    lastUpdatedAt: number;
    hostProjectionState: HostTurnResponseState | null;
    projection: HostTurnResponseState | null;
  } | null = null;
  private readonly visibleTranscriptModel = new ChatVisibleTranscriptModel();
  private visibleTranscriptAttachmentGeneration = 0;
  private visibleTranscriptAttachment: VisibleTranscriptAttachment | null = null;
  private visibleTranscriptProjectionSnapshot: VisibleTranscriptProjectionSnapshot | null = null;
  private readonly runtimeHostVisibleTranscriptProjectionFrames = new Map<string, {
    readonly handle: number;
    turnResponses: readonly TurnResponseTurn[] | null;
  }>();
  private readonly runtimeHostVisibleTurnProjectionFrames = new Map<string, {
    readonly handle: number;
    turnsById: Map<string, TurnResponseTurn>;
  }>();
  private readonly runtimeHostVisiblePartProjectionFrames = new Map<string, {
    readonly handle: number;
    eventsByTurnId: Map<string, ChatRuntimeHostPartTranscriptEvent>;
  }>();
  private readonly runtimeHostVisibleTurnProjectionLastFlushAt = new Map<string, number>();
  private readonly runtimeHostVisiblePartProjectionLastFlushAt = new Map<string, number>();
  private readonly runtimeHostVisibleTranscriptProjectionCooldown = new Set<string>();
  private dialogItemsCache: {
    sessionResource: string;
    projectionSource: 'model' | 'runtime';
    turnResponses: readonly TurnResponseTurn[];
    turnCount: number;
    lastTurnId: string;
    lastUpdatedAt: number;
    modelRevision: number;
    items: ChatVisibleTranscriptDialogItem[];
  } | null = null;
  /** 只读视图：从 lex TurnManager 派生的消息数组（lex 为唯一 source of truth） */
  get conversationMessages(): any[] {
      return this.lexStream.conversation.messages();
  }

  get dialogItems(): ChatVisibleTranscriptDialogItem[] {
    const model = this.getCurrentViewSessionModel();
    if (!model) {
      this.dialogItemsCache = null;
      return [];
    }

    const turnResponses = model.peekTurnResponsesForProjection();
    const projectionSource = 'model';
    const lastTurn = turnResponses[turnResponses.length - 1];
    const lastTurnId = lastTurn?.turnId ?? '';
    const lastUpdatedAt = lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1;
    const modelRevision = model.requestListRevision;
    if (this.dialogItemsCache
      && this.dialogItemsCache.sessionResource === model.sessionResource
      && this.dialogItemsCache.projectionSource === projectionSource
      && this.dialogItemsCache.turnResponses === turnResponses
      && this.dialogItemsCache.turnCount === turnResponses.length
      && this.dialogItemsCache.lastTurnId === lastTurnId
      && this.dialogItemsCache.lastUpdatedAt === lastUpdatedAt
      && this.dialogItemsCache.modelRevision === modelRevision) {
      return this.dialogItemsCache.items;
    }

    this.visibleTranscriptModel.replaceFromSessionModel(turnResponses);
    const changes = this.visibleTranscriptModel.drainChanges();
    const items = [
      ...this.visibleTranscriptModel.toDialogItemsAfterChanges(
        this.dialogItemsCache?.sessionResource === model.sessionResource
          ? this.dialogItemsCache.items
          : null,
        changes,
      ),
    ];
    this.recordVisibleTranscriptProjection({
      sessionResource: model.sessionResource,
      projectionSource,
      changes,
      items,
    });
    this.dialogItemsCache = {
      sessionResource: model.sessionResource,
      projectionSource,
      turnResponses,
      turnCount: turnResponses.length,
      lastTurnId,
      lastUpdatedAt,
      modelRevision,
      items,
    };
    return items;
  }

  get checkpointRestoreSurface(): CheckpointRestoreSurface | null {
    if (this.isWaiting) {
      return null;
    }

    return buildCheckpointRestoreSurface(
      this.editActions.hasCheckpointTimelineRedo(),
      this.workspaceCheckpointPresentationMode,
    );
  }

  get workspaceCheckpointPresentationMode() {
    const mode = this.workspaceCheckpointProvider.getPresentationMode?.() ?? 'unknown';
    return mode === 'unknown' && this.currentViewHasSessionCheckpointTimeline()
      ? 'timeline'
      : mode;
  }

  private currentViewHasSessionCheckpointTimeline(): boolean {
    const currentProjectPath = AilyHost.get().project?.currentProjectPath;
    if (typeof currentProjectPath === 'string' && currentProjectPath.trim().length > 0) {
      return false;
    }

    const sessionResource = this.resolveCurrentViewSessionResource();
    if (!sessionResource) {
      return false;
    }

    const model = this.chatSessionModelStore?.get?.(sessionResource);
    const getCheckpointTimelineState = (model as unknown as {
      getCheckpointTimelineState?: ChatSessionModel['getCheckpointTimelineState'];
    } | undefined)?.getCheckpointTimelineState;
    const checkpointTimelineState = model && typeof getCheckpointTimelineState === 'function'
      ? getCheckpointTimelineState.call(model)
      : null;
    return checkpointTimelineState?.sessionResource === sessionResource
      && checkpointTimelineState.checkpoints.length > 0;
  }

  get hostResponseProjection(): HostResponseProjection | null {
    return this.getHostResponseState();
  }

  private getHostResponseState(): HostTurnResponseState | null {
    const modelProjectionState = this.getCurrentViewHostProjectionState();
    if (!this.hasVisibleSessionProjectionTarget()) {
      if (modelProjectionState && this.currentViewModelHasRenderableProjection(modelProjectionState)) {
        this.markCurrentViewVisibleProjectionOwner();
        return modelProjectionState;
      }
      return null;
    }

    if (modelProjectionState) {
      return modelProjectionState;
    }

    return null;
  }

  get hostRequestModel(): HostRequestModel | null {
    const modelProjectionState = this.getCurrentViewHostProjectionState();
    if (!this.hasVisibleSessionProjectionTarget()) {
      if (modelProjectionState && this.currentViewModelHasRenderableProjection(modelProjectionState)) {
        this.markCurrentViewVisibleProjectionOwner();
        return buildHostRequestModel(modelProjectionState.turnResponses);
      }
      return null;
    }

    if (modelProjectionState) {
      return buildHostRequestModel(modelProjectionState.turnResponses);
    }

    return null;
  }

  private resolveCurrentViewSessionResource(): string {
    const viewModelStore = (this as unknown as {
      chatSessionViewModelStore?: Pick<ChatSessionViewModelStoreService, 'currentSessionResource'>;
    }).chatSessionViewModelStore;
    if (viewModelStore) {
      const viewResource = typeof viewModelStore.currentSessionResource === 'string'
        ? viewModelStore.currentSessionResource.trim()
        : '';
      if (viewResource) {
        return viewResource;
      }
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    return currentSessionId;
  }

  private getCurrentViewSessionModel(): Pick<ChatSessionModel, 'sessionResource' | 'hostProjectionState' | 'turnResponses' | 'requestListRevision' | 'peekTurnResponsesForProjection' | 'applyProjection' | 'partStore' | 'getDisabledCheckpointTurnIds'> | undefined {
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (!currentViewSessionResource) {
      return undefined;
    }

    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get'>;
    }).chatSessionModelStore;
    return modelStore?.get?.(currentViewSessionResource);
  }

  private applyProjectionToSessionModel(
    model: Pick<ChatSessionModel, 'sessionResource' | 'applyProjection'>,
    projectionState: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'applyProjection'>;
    }).chatSessionModelStore;
    if (typeof modelStore?.applyProjection === 'function') {
      modelStore.applyProjection(model.sessionResource, projectionState, options);
      return;
    }

    model.applyProjection(projectionState, options);
  }

  private getCurrentViewPartStore(): ChatPartStore {
    return this.getCurrentViewSessionModel()?.partStore ?? this.entryPartStore;
  }

  private createSessionRoutedPartStore(): ChatPartStore {
    const resolveStore = () => this.getCurrentViewPartStore();

    return new Proxy(this.entryPartStore, {
      get(_target, property) {
        const store = resolveStore();
        const value = Reflect.get(store, property, store);
        return typeof value === 'function' ? value.bind(store) : value;
      },
      set(_target, property, value) {
        const store = resolveStore();
        return Reflect.set(store, property, value, store);
      },
      has(_target, property) {
        return property in resolveStore();
      },
    });
  }

  private getCurrentViewHostProjectionState(): HostTurnResponseState | null {
    const model = this.getCurrentViewSessionModel();
    if (!model) {
      this.currentViewHostProjectionCache = null;
      return null;
    }

    const projectionTurnResponses = typeof model.peekTurnResponsesForProjection === 'function'
      ? model.peekTurnResponsesForProjection()
      : model.turnResponses;
    const turnResponses = Array.isArray(projectionTurnResponses) ? projectionTurnResponses : [];
    if (this.currentViewModelHasRenderableProjection(model.hostProjectionState)
      && isProjectionStateAlignedWithTurnResponses(model.hostProjectionState, turnResponses)) {
      const projectionTurns = model.hostProjectionState.turnResponses;
      const lastProjectionTurn = projectionTurns[projectionTurns.length - 1];
      this.currentViewHostProjectionCache = {
        sessionResource: model.sessionResource,
        turnResponses: projectionTurns,
        turnCount: projectionTurns.length,
        lastTurnId: lastProjectionTurn?.turnId ?? '',
        lastUpdatedAt: lastProjectionTurn?.updatedAt ?? lastProjectionTurn?.response?.updatedAt ?? -1,
        hostProjectionState: model.hostProjectionState,
        projection: model.hostProjectionState,
      };
      return model.hostProjectionState;
    }

    const lastTurn = turnResponses[turnResponses.length - 1];
    const lastTurnId = lastTurn?.turnId ?? '';
    const lastUpdatedAt = lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1;
    const cached = this.currentViewHostProjectionCache;
    if (cached
      && cached.sessionResource === model.sessionResource
      && cached.turnResponses === turnResponses
      && cached.turnCount === turnResponses.length
      && cached.lastTurnId === lastTurnId
      && cached.lastUpdatedAt === lastUpdatedAt
      && cached.hostProjectionState === model.hostProjectionState) {
      return cached.projection;
    }

    let projectionState: HostTurnResponseState | null = null;
    if (isProjectionStateAlignedWithTurnResponses(model.hostProjectionState, turnResponses)) {
      projectionState = model.hostProjectionState;
    } else if (turnResponses.length > 0) {
      projectionState = buildHostResponseStateFromCanonical(null, turnResponses);
      if (!projectionState) {
        projectionState = buildRuntimeHostProjectionState(turnResponses);
      }
    } else if (model.hostProjectionState) {
      projectionState = model.hostProjectionState;
    }

    this.currentViewHostProjectionCache = {
      sessionResource: model.sessionResource,
      turnResponses,
      turnCount: turnResponses.length,
      lastTurnId,
      lastUpdatedAt,
      hostProjectionState: model.hostProjectionState,
      projection: projectionState,
    };
    return projectionState;
  }

  private readSessionInputValue(sessionId?: string | null): string | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return null;
    }

    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get'>;
    }).chatSessionModelStore;
    const model = modelStore?.get?.(targetSessionId);
    if (model) {
      const draftText = model.inputState?.draftText;
      return typeof draftText === 'string' ? draftText : '';
    }

    const legacyDraftText = Object.prototype.hasOwnProperty.call(this, 'inputValue')
      ? (this as unknown as { inputValue?: unknown }).inputValue
      : (this as unknown as { legacyInputValue?: unknown }).legacyInputValue;
    return typeof legacyDraftText === 'string' ? legacyDraftText : '';
  }

  private setSessionInputValue(sessionId: string | null | undefined, value: unknown): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const draftText = typeof value === 'string' ? value : '';
    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get' | 'updateMetadata'>;
    }).chatSessionModelStore;
    const model = targetSessionId ? modelStore?.get?.(targetSessionId) : undefined;
    if (targetSessionId && model) {
      if (typeof modelStore?.updateMetadata === 'function') {
        modelStore.updateMetadata(targetSessionId, {
          inputState: {
            ...model.inputState,
            draftText,
          },
        });
        return true;
      }

      if (typeof (model as unknown as { updateMetadata?: unknown }).updateMetadata === 'function') {
        (model as unknown as { updateMetadata: (patch: ChatSessionModelMetadataPatch) => void }).updateMetadata({
          inputState: {
            ...model.inputState,
            draftText,
          },
        });
        return true;
      } else {
        // Prototype-style test doubles may expose read-only model slices. Treat
        // them as no-model legacy seams rather than writing a parallel truth.
      }
    }

    if (Object.prototype.hasOwnProperty.call(this, 'inputValue')) {
      (this as unknown as { inputValue: string }).inputValue = draftText;
    } else {
      (this as unknown as { legacyInputValue?: string }).legacyInputValue = draftText;
    }
    return false;
  }

  private hasVisibleSessionProjectionTarget(): boolean {
    const currentSessionId = this.resolveCurrentViewSessionResource();
    const serviceSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const visibleProjectionSessionId = (this as unknown as { visibleProjectionSessionId?: string | null }).visibleProjectionSessionId;
    return currentSessionId.length > 0
      && serviceSessionId === currentSessionId
      && typeof visibleProjectionSessionId === 'string'
      && visibleProjectionSessionId.trim() === currentSessionId;
  }

  private currentViewModelHasRenderableProjection(state: HostTurnResponseState | null | undefined): boolean {
    return Array.isArray(state?.turnResponses) && state.turnResponses.length > 0
      || Array.isArray(state?.chatList) && state.chatList.length > 0
      || Array.isArray(state?.dialogItems) && state.dialogItems.length > 0;
  }

  private markVisibleSessionProjectionOwner(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    this.visibleProjectionSessionId = targetSessionId || null;
  }

  private attachVisibleTranscript(sessionId?: string | null): VisibleTranscriptAttachment | null {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      this.detachVisibleTranscript();
      return null;
    }

    const currentGeneration = Number.isFinite(this.visibleTranscriptAttachmentGeneration)
      ? this.visibleTranscriptAttachmentGeneration
      : 0;
    const nextGeneration = currentGeneration + 1;
    this.visibleTranscriptAttachmentGeneration = nextGeneration;
    const attachment: VisibleTranscriptAttachment = {
      sessionId: targetSessionId,
      model: this.visibleTranscriptModel,
      generation: nextGeneration,
    };
    this.visibleTranscriptAttachment = attachment;
    this.visibleProjectionSessionId = targetSessionId;
    return attachment;
  }

  private recordVisibleTranscriptProjection(options: {
    readonly sessionResource: string;
    readonly projectionSource: 'model' | 'runtime' | 'empty';
    readonly changes: readonly ChatVisibleTranscriptChange[];
    readonly items: readonly ChatVisibleTranscriptDialogItem[];
  }): void {
    const changedKinds: Record<string, number> = {};
    for (const change of options.changes) {
      changedKinds[change.kind] = (changedKinds[change.kind] ?? 0) + 1;
    }
    const runningItemIds = options.items
      .filter(item => item.doing)
      .map(item => item.id);
    const snapshot: VisibleTranscriptProjectionSnapshot = {
      sessionResource: options.sessionResource,
      projectionSource: options.projectionSource,
      generation: this.visibleTranscriptAttachmentGeneration,
      itemCount: options.items.length,
      changedItemCount: options.changes.length,
      changedItemIds: options.changes.map(change => change.itemId),
      changedKinds,
      runningItemIds,
    };
    this.visibleTranscriptProjectionSnapshot = snapshot;

    ChatPerformanceTracer.recordRenderEvent('visible_transcript_projection', {
      sessionResource: snapshot.sessionResource,
      projectionSource: snapshot.projectionSource,
      visibleAttachmentGeneration: snapshot.generation,
      itemCount: snapshot.itemCount,
      changedItemCount: snapshot.changedItemCount,
      changedItemIds: snapshot.changedItemIds,
      runningItemIds: snapshot.runningItemIds,
    });
  }

  private recordVisibleTranscriptPatchProjection(
    sessionResource: string,
    changes: readonly ChatVisibleTranscriptChange[],
    patches: readonly ChatVisibleTranscriptDialogItemPatch[],
    itemCount: number,
  ): void {
    const changedKinds: Record<string, number> = {};
    for (const change of changes) {
      changedKinds[change.kind] = (changedKinds[change.kind] ?? 0) + 1;
    }

    const runningItemIds = new Set(
      this.visibleTranscriptProjectionSnapshot?.sessionResource === sessionResource
        ? this.visibleTranscriptProjectionSnapshot.runningItemIds
        : [],
    );
    for (const patch of patches) {
      if (patch.item.doing) {
        runningItemIds.add(patch.itemId);
      } else {
        runningItemIds.delete(patch.itemId);
      }
    }

    this.visibleTranscriptProjectionSnapshot = {
      sessionResource,
      projectionSource: 'runtime',
      generation: this.visibleTranscriptAttachmentGeneration,
      itemCount,
      changedItemCount: changes.length,
      changedItemIds: changes.map(change => change.itemId),
      changedKinds,
      runningItemIds: [...runningItemIds],
    };
  }

  private detachVisibleTranscript(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (targetSessionId
      && this.visibleTranscriptAttachment
      && this.visibleTranscriptAttachment.sessionId !== targetSessionId) {
      return;
    }

    const currentGeneration = Number.isFinite(this.visibleTranscriptAttachmentGeneration)
      ? this.visibleTranscriptAttachmentGeneration
      : 0;
    this.visibleTranscriptAttachmentGeneration = currentGeneration + 1;
    this.visibleTranscriptAttachment = null;
    if (!targetSessionId || this.visibleProjectionSessionId === targetSessionId) {
      this.visibleProjectionSessionId = null;
    }
  }

  private isVisibleTranscriptAttachmentCurrent(attachment?: VisibleTranscriptAttachment | null): boolean {
    return !!attachment
      && this.visibleTranscriptAttachment === attachment
      && attachment.model === this.visibleTranscriptModel
      && attachment.generation === this.visibleTranscriptAttachmentGeneration
      && this.visibleProjectionSessionId === attachment.sessionId;
  }

  private isVisibleSessionAttachedForSubmit(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || this.resolveCurrentViewSessionResource() !== targetSessionId) {
      return false;
    }

    const currentAttachment = this.visibleTranscriptAttachment;
    return (this.chatSessionViewModelStore?.currentSessionResource ?? targetSessionId) === targetSessionId
      && currentAttachment?.sessionId === targetSessionId
      && this.isVisibleTranscriptAttachmentCurrent(currentAttachment);
  }

  readVisibleTranscriptAttachmentGeneration(sessionId?: string | null): number | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const attachment = this.visibleTranscriptAttachment;
    if (!attachment || !targetSessionId || attachment.sessionId !== targetSessionId) {
      return null;
    }

    return this.isVisibleTranscriptAttachmentCurrent(attachment) ? attachment.generation : null;
  }

  markCurrentViewVisibleProjectionOwner(): void {
    this.markVisibleSessionProjectionOwner(this.resolveCurrentViewSessionResource());
  }

  markHistoryDirty(sessionId: string): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }
    this.chatHistoryService.markDirty(targetSessionId);
  }

  private markRuntimeHostRecoverySnapshotDirty(
    sessionId: string,
    options?: { readonly flush?: 'immediate' | 'scheduled' },
  ): void {
    this.markHistoryDirty(sessionId);
    traceActiveTurnDurability(options?.flush === 'immediate' ? 'part-delta-immediate' : 'part-delta', {
      sessionId,
      flush: options?.flush ?? 'scheduled',
    });
    if (options?.flush === 'immediate') {
      void this.chatHistoryService.flushSessionAsync(sessionId);
      return;
    }
    this.chatHistoryService.scheduleRecoverySnapshotFlush(sessionId);
  }

  private setCurrentViewVisibleProjectionList(list: ChatMessage[]): void {
    this.markCurrentViewVisibleProjectionOwner();
    this.list = list;
    this.syncCurrentVisibleProjectionListToSessionModel(list);
  }

  private syncCurrentVisibleProjectionListToSessionModel(list: readonly ChatMessage[]): void {
    const model = this.getCurrentViewSessionModel();
    if (!model) {
      return;
    }

    const currentProjection = model.hostProjectionState
      ?? (model.turnResponses.length > 0 ? buildRuntimeHostProjectionState(model.turnResponses) : null);
    if (!currentProjection) {
      return;
    }

    const visibleChatList = list.map(message => ({ ...message })) as HostTurnResponseState['chatList'];
    const dialogItems = buildChatDialogViewItems(
      visibleChatList as readonly ChatMessage[],
      currentProjection.turnResponses,
      {
        disabledRequestTurnIds: model.getDisabledCheckpointTurnIds(),
      },
    );
    this.applyProjectionToSessionModel(model, {
      ...currentProjection,
      chatList: visibleChatList,
      dialogItems,
    }, {
      reason: 'view',
    });
  }

  private hasVisibleChatViewProjectionForSession(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    const visibleProjectionSessionId = (this as unknown as { visibleProjectionSessionId?: string | null }).visibleProjectionSessionId;
    const visibleProjectionOwner = typeof visibleProjectionSessionId === 'string'
      ? visibleProjectionSessionId.trim()
      : '';
    if (currentViewSessionResource !== targetSessionId || visibleProjectionOwner !== targetSessionId) {
      return false;
    }

    return this.chatService?.hasBlankSessionShell === true
      || (Array.isArray(this.list) && this.list.length > 0);
  }

  clearSharedHostRequestGraph(): void {
    this.liveHostRequestGraphCache.clear();
  }

  replaceSharedHostProjectionState(state: HostTurnResponseState | null, options: SharedHostProjectionStateOptions): void {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(options.sessionId);
    if (targetSessionId && !this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)) {
      this.projectSharedHostProjectionStateToRuntimeOwner(targetSessionId, state, {
        attachedView: options.attachedView === true,
      });
      return;
    }

    this.visibleProjectionSessionId = targetSessionId || null;
    if (targetSessionId) {
      this.projectViewProjectionToModelProjection(targetSessionId, state, {
        attachedView: options.attachedView !== false,
      });
    }
    this.liveHostRequestGraphCache.replaceState(state);
    this.acceptLiveRequestQuotaState(targetSessionId || undefined);
  }

  restoreSharedHostProjectionState(state: HostTurnResponseState | null, options: SharedHostProjectionStateOptions): void {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(options.sessionId);
    if (targetSessionId && !this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)) {
      this.projectSharedHostProjectionStateToRuntimeOwner(targetSessionId, state, {
        attachedView: options.attachedView === true,
      });
      return;
    }

    this.visibleProjectionSessionId = targetSessionId || null;
    if (targetSessionId) {
      this.projectViewProjectionToModelProjection(targetSessionId, state, {
        attachedView: options.attachedView !== false,
      });
    }
    this.liveHostRequestGraphCache.replaceState(state);
  }

  private voteResponse(target: DialogTurnContext | null | undefined, vote: HostResponseVoteDirection): void {
    const turnId = target?.turnId;
    if (!turnId) {
      return;
    }

    const currentState = this.getHostResponseState();
    const nextState = applyHostResponseVoteToState(currentState, turnId, vote);
    if (nextState === currentState) {
      return;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    this.replaceSharedHostProjectionState(nextState, { sessionId: currentViewSessionResource || null });
    if (currentViewSessionResource) {
      this.markHistoryDirty(currentViewSessionResource);
    }
    this.triggerSyncDetectChanges();
  }

  toolCallingIteration = 0;
  activeToolExecutions = 0;
  currentStatelessMode = false;

  /** 缓存的编辑反馈（用户保留/撤销变更后，在下次发送时注入上下文） */
  pendingEditFeedback: string | null = null;

  pendingUserInput = false;
  private _isWaiting = false;
  private _waitingSessionId: string | null = null;
  private runtimeSessionOwnerOverride: string | null = null;
  mcpInitialized = false;
  lastStopReason = '';
  /** 旧聊天链路会话级：已激活的 deferred 工具名称集合（通过 search_available_tools 加载） */
  legacyActivatedDeferredTools = new Set<string>();

  /** 延迟切换：活跃请求期间暂存待切换的模型/模式，完成后自动应用 */
  _pendingModelSwitch: ModelConfig | null = null;
  _pendingModeSwitch: ChatSurfaceModeId | null = null;
  _pendingSwitchSessionId: string | null = null;

  /** autoSend 消息在 sessionId 未就绪时的暂存区，startSession 完成后自动冲刷 */
  private _pendingAutoSendText: string | null = null;

  // ==================== 订阅 ====================
  messageSubscription: any;
  private requestQuotaStateSubscription: Subscription | null = null;
  private contextBudgetStateSubscription: Subscription | null = null;
  private runtimeModeCollectionSubscription: Subscription | null = null;
  private runtimeHostEventSubscription: ChatRuntimeHostEventSubscription | null = null;
  private runtimeHostEventZoneBoundaryReported = false;
  private editDiffPreviewRequestSubscription: Subscription | null = null;
  private readonly runtimeHostSessionStates = new Map<string, ChatRuntimeHostSessionState>();
  private readonly runtimeHostStopActions = new Map<
    string,
    { readonly turnId: string | null; readonly action: () => void }
  >();
  private readonly visibleResponseCompletionBoundaries = new Map<string, number>();
  private readonly visibleResponseLastSourceEventAt = new Map<string, number>();
  private runtimeHostRouteTraceBudget = 0;

  // ==================== 外部引用 ====================
  private chatTextareaRef: ElementRef | null = null;

  // ==================== Getters / Setters ====================

  /**
   * @deprecated Adapter for the currently attached chat view selection.
   * Do not use this as session/model truth; resolve the current
   * ChatSessionViewModel.sessionResource or pass an explicit sessionId.
   */
  get sessionId() { return this.chatService.currentSessionId; }
  set sessionId(value: string) { this.chatService.currentSessionId = value; }

  get sessionTitle() { return this.chatService.currentSessionTitle; }

  get currentMode() { return this.resolveVisibleSelectedModeSnapshot().modeId; }

  get currentAgentRuntimeMode() { return this.chatService.currentAgentRuntimeMode; }

  get currentAgentRuntimeModeSource() { return this.chatService.currentAgentRuntimeModeSource; }

  selectAgentRuntimeMode(
    mode: ChatAgentRuntimeMode | string | null | undefined,
    source: ChatAgentRuntimeModeSource | string | null | undefined = 'user_selected',
    reason?: string | null,
  ): ChatAgentRuntimeMode {
    const normalizedMode = normalizeChatAgentRuntimeMode(mode, this.currentAgentRuntimeMode);
    const normalizedSource = normalizeChatAgentRuntimeModeSource(source, 'user_selected');
    const previousMode = this.chatService.currentAgentRuntimeMode;
    const previousSource = this.chatService.currentAgentRuntimeModeSource;
    this.chatService.setCurrentAgentRuntimeMode(normalizedMode, normalizedSource);
    const currentViewSessionResource = resolveOptionalUiSessionOwner(this, null);
    this.syncCurrentSessionEntryTargetRuntimeMode(currentViewSessionResource || null);
    if (isAgentRuntimeModeTraceEnabled()) {
      console.info('[AilyChat] agent runtime mode selected', {
        previousMode,
        previousSource,
        mode: normalizedMode,
        source: normalizedSource,
        reason: typeof reason === 'string' ? reason : undefined,
        sessionId: currentViewSessionResource || null,
      });
    }
    return normalizedMode;
  }

  private syncCurrentSessionEntryTargetRuntimeMode(sessionId?: string | null): void {
    const currentSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!currentSessionId) {
      return;
    }

    const providerOptions = this.resolveVisibleSessionProviderOptionsSnapshot(currentSessionId);
    const selectedMode = this.resolveVisibleSelectedModeSnapshot(currentSessionId);
    const projectPath = providerOptions.folderPath ?? null;

    this.chatSessionEntryStateService?.setSessionEntryTarget({
      sessionId: currentSessionId,
      projectPath,
      providerOptions,
      inputState: buildHostSessionCurrentPickerInputState(selectedMode, providerOptions),
      mode: selectedMode.modeId,
      agentRuntimeMode: this.chatService.currentAgentRuntimeMode,
      agentRuntimeModeSource: this.chatService.currentAgentRuntimeModeSource,
      requestRouting: buildHostSessionCurrentPickerRoutingSummary(
        selectedMode,
        undefined,
        providerOptions.permissionLevel,
        providerOptions.approvalsReviewer,
        providerOptions.approvalPolicy,
      ),
    }, projectPath);
  }

  get currentSessionPermissionMode() {
    return this.resolveVisibleSessionProviderOptionsSnapshot()?.permissionMode
      ?? this.chatService.currentSessionPermissionMode;
  }

  get currentSessionPermissionProfile() {
    return this.resolveVisibleSessionProviderOptionsSnapshot()?.permissionProfile
      ?? this.chatService.currentSessionPermissionProfile;
  }

  get currentSessionPermissionLevel() {
    return this.resolveVisibleSessionProviderOptionsSnapshot()?.permissionLevel
      ?? this.chatService.currentSessionPermissionLevel;
  }

  get currentSessionApprovalsReviewer() {
    return this.resolveVisibleSessionProviderOptionsSnapshot()?.approvalsReviewer
      ?? this.chatService.currentSessionApprovalsReviewer;
  }

  get currentSessionApprovalPolicy() {
    return this.resolveVisibleSessionProviderOptionsSnapshot()?.approvalPolicy
      ?? this.chatService.currentSessionApprovalPolicy;
  }

  applyComposerPermissionPreset(action: string, sessionId?: string | null): void {
    const normalizedAction = typeof action === 'string' ? action.trim() : '';
    if (!normalizedAction) {
      return;
    }

    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const currentProviderOptions = this.resolveVisibleSessionProviderOptionsSnapshot(targetSessionId);
    let nextProviderOptions: HostSessionProviderOptions | null = null;

    if (normalizedAction === 'permission-default') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'default',
        permissionProfile: 'workspace-write',
        permissionLevel: undefined,
        approvalsReviewer: 'user',
        approvalPolicy: 'on_request',
      });
    } else if (normalizedAction === 'permission-auto-review') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'default',
        permissionProfile: currentProviderOptions.permissionProfile,
        permissionLevel: undefined,
        approvalsReviewer: 'auto_review',
        approvalPolicy: 'on_request',
      });
    } else if (normalizedAction === 'permission-full-access') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'default',
        permissionProfile: 'danger-full-access',
        permissionLevel: undefined,
        approvalsReviewer: 'user',
        approvalPolicy: 'never',
      });
    }

    if (!nextProviderOptions) {
      return;
    }

    this.rememberRuntimeSessionProviderOptions(targetSessionId, nextProviderOptions);
    this.chatService.applySessionProviderOptions(nextProviderOptions);
    this.syncExecutionModeGuidanceNotice(
      nextProviderOptions.permissionLevel,
      nextProviderOptions.approvalsReviewer,
      nextProviderOptions.approvalPolicy,
    );
    this.syncCurrentSessionEntryTargetRuntimeMode(targetSessionId);
  }

  get currentCustomAgentTarget() { return this.resolveVisibleSelectedModeSnapshot().customAgentTarget; }

  get selectedMode(): ChatSelectedMode {
    return this.resolveVisibleSelectedModeSnapshot();
  }

  get currentResolvedMode(): ChatResolvedMode {
    return this.resolveVisibleResolvedModeSnapshot();
  }

  get currentModel() { return this.chatService.currentModel; }

  get currentModelName() { return this.getSelectedDisplayModel()?.name; }

  get currentReasoningEffort() { return this.chatService.currentModel?.reasoningEffort; }

  get currentReasoningEffortLabel(): string {
    return this.ailyChatConfigService.getReasoningEffortLabel(this.currentReasoningEffort);
  }

  get currentReasoningEffortDisplayLabel(): string {
    return this.ailyChatConfigService.getReasoningEffortDisplayLabel(
      this.ailyChatConfigService.resolveModelReasoningEffort(this.chatService.currentModel, this.currentReasoningEffort),
    );
  }

  get currentModelReasoningEfforts() {
    return this.ailyChatConfigService.getSupportedReasoningEfforts(this.chatService.currentModel);
  }

  get currentModelChipLabel(): string {
    const modelName = this.getCurrentModelChipBaseLabel();
    if (!modelName) {
      return '';
    }

    const navigationConfigurationSummary = this.getNavigationConfigurationSummary(this.chatService.currentModel);
    if (navigationConfigurationSummary) {
      return `${modelName} · ${navigationConfigurationSummary}`;
    }

    return modelName;
  }

  private getCurrentModelChipBaseLabel(): string {
    return this.getActiveDisplayModel()?.name ?? this.currentModelName ?? '';
  }

  private getNavigationConfigurationSummary(model: { presetId?: string; model?: string } | null | undefined): string | undefined {
    const modelId = this.getModelConfigurationId(model);
    if (!modelId) {
      return undefined;
    }

    const labels = this.languageModelsService.getModelConfigurationActions(modelId, { group: 'navigation' })
      .map((group) => group.actions.find((action) => action.checked)?.label?.trim())
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
      .map((label) => this.normalizeModelConfigurationLabel(label));

    return labels.length > 0 ? labels.join(', ') : undefined;
  }

  private getModelConfigurationId(model: { presetId?: string; model?: string } | null | undefined): string {
    return typeof model?.presetId === 'string' && model.presetId.trim()
      ? model.presetId.trim()
      : typeof model?.model === 'string'
        ? model.model.trim()
        : '';
  }

  private normalizeModelConfigurationLabel(label: string): string {
    return label.replace(/\s*\(default\)$/i, '');
  }

  get currentModelTooltip(): string {
    return this.ailyChatConfigService.buildModelTooltip(this.getActiveDisplayModel(), {
      maxContextTokens: this.contextBudgetSnapshot?.maxContextTokens,
    });
  }

  get currentModelBillingLabel(): string | undefined {
    return this.chatService.resolvedActiveModelBillingLabel
      ?? this.ailyChatConfigService.getModelBillingLabel(this.getActiveDisplayModel());
  }

  private getSelectedDisplayModel(): ModelConfig | null {
    const selectedModel = this.chatService.currentModel ?? null;
    if (!selectedModel) {
      return null;
    }

    if (typeof selectedModel.presetId === 'string' && selectedModel.presetId.trim()) {
      return this.ailyChatConfigService.resolvePresetDisplayModel(selectedModel.presetId.trim())
        ?? selectedModel;
    }

    return selectedModel;
  }

  private getActiveDisplayModel(): ModelConfig | null {
    return this.chatService.getActiveDisplayModel?.()
      ?? this.getSelectedDisplayModel();
  }

  syncRegisteredAgentNames(agentNames: readonly string[]): void {
    this.chatViewState.setAvailableAgents(agentNames);
  }

  syncCustomAgentProviderSource(agentModeSource: unknown): void {
    void this.chatService.bindCustomAgentProviderSource(agentModeSource as any);
  }

  syncSessionCustomizationProvider(providerBinding: unknown): void {
    void this.chatService.bindSessionCustomizationProvider(providerBinding as any);
  }

  syncSessionCustomizationProviders(providerBindings: readonly unknown[]): void {
    void this.chatService.bindSessionCustomizationProviders(providerBindings as any);
  }

  syncSessionCustomizationContentProvider(contentProvider: unknown): void {
    void this.chatService.bindSessionCustomizationContentProvider(contentProvider as any);
  }

  syncSessionProviderOptionsSource(sourceBinding: unknown): void {
    void this.chatService.bindSessionProviderOptionsSource(sourceBinding as any);
  }

  syncSessionProviderOptionsSources(sourceBindings: readonly unknown[]): void {
    void this.chatService.bindSessionProviderOptionsSources(sourceBindings as any);
  }

  refreshSessionProviderOptionsSources(): void {
    void this.chatService.refreshSessionProviderOptionsSources();
  }

  syncCustomAgentProviderModes(agentModes: readonly unknown[]): void {
    void this.chatService.setCustomAgentProviderModes(agentModes);
  }

  get isWaiting() {
    return this.readVisibleSessionRequestInProgress();
  }
  set isWaiting(value: boolean) {
    const waitingOwnerSessionId = value
      ? this.resolveActiveRuntimeSessionId() || this._waitingSessionId || null
      : this._waitingSessionId;

    this._isWaiting = value;
    this._waitingSessionId = value ? waitingOwnerSessionId : null;
    this.chatService.isWaiting = value;
    AilyHost.get().blockly.aiWaiting = value;
    if (!value) {
      this.aiWriting = false;
      AilyHost.get().blockly.aiWaitWriting = false;
      void this.refreshRequestQuotaState();
    }
  }

  set aiWriting(value: boolean) {
    AilyHost.get().blockly.aiWriting = value;
  }

  get contextBudget$() { return this.contextBudgetViewService?.budget$; }

  get authQuotaSnapshot$() { return this.authQuotaStateService.authQuotaSnapshot$; }

  get chatInputNotice$() { return this.chatInputNoticeStateService.inputNotice$; }

  get authQuotaExhausted() { return this.authQuotaStateService.quotaExhausted; }

  get requestQuotaSnapshot$() { return this.requestQuotaStateService.requestQuotaSnapshot$; }

  get contextBudgetSnapshot(): ContextBudgetSnapshot | null {
    return this.contextBudgetViewService?.getSnapshot() ?? null;
  }

  get contextUsageSnapshot(): ChatContextUsageSnapshot | null {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner();
    const turnResponses = this.readSessionTurnResponses(targetSessionId);
    const usageTurn = findLatestUsageTurn(turnResponses);
    const requestScopedModel = this.ailyChatConfigService.resolveRuntimeModelFromServerModelName(
      getTurnResponseResolvedModelName(usageTurn),
    );

    return createChatContextUsageSnapshot({
      turnResponses,
      maxContextTokens: requestScopedModel?.contextWindowTokens
        ?? this.currentModel?.contextWindowTokens
        ?? this.contextBudgetSnapshot?.maxContextTokens,
      contextBudgetSnapshot: this.contextBudgetSnapshot,
    });
  }

  get interactionBudgetSnapshot(): InteractionBudgetSnapshot | null {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner();
    const turnResponses = this.readSessionTurnResponses(targetSessionId);
    return createInteractionBudgetSnapshot(turnResponses);
  }

  get contextCompactionMetricsSnapshot(): MetricsSnapshot | null {
    return this.lexStream.compactionMetricsSnapshot;
  }

  async compactConversation(): Promise<boolean> {
    return await this.lexStream.agent.getHandle?.()?.compactIfNeededForFinalize()
      ?? await this.lexStream.agent.getAgent?.()?.compactIfNeededForFinalize?.()
      ?? false;
  }

  async continueCurrentExecution(sessionId?: string | null): Promise<void> {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetSessionId = explicitSessionId || this.resolveCurrentViewSessionResource();
    if (!targetSessionId) {
      throw new Error('continueCurrentExecution requires a current view sessionResource.');
    }
    const continuation = this.readLatestInteractionContinuation(targetSessionId);
    const pendingState = continuation?.pendingState && typeof continuation.pendingState === 'object'
      ? continuation.pendingState as Record<string, unknown>
      : null;
    if ((typeof pendingState?.['kind'] === 'string' ? pendingState['kind'] : undefined) !== 'continue') {
      return;
    }

    await this.submitSessionInteractionActionRequest(targetSessionId, '继续', { kind: 'continue' });
  }

  async submitInteractionActionRequest(
    content: string,
    interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
    requestMetadata?: TurnRequest['metadata'],
    sessionId?: string | null,
    executionSnapshot?: HostSubmitExecutionSnapshot | null,
  ): Promise<void> {
    await this.submitSessionInteractionActionRequest(
      sessionId,
      content,
      interactionAction,
      requestMetadata,
      executionSnapshot,
    );
  }

  get requestQuotaSnapshot(): RequestQuotaSnapshot | null {
    return this.requestQuotaStateService.getRequestQuotaSnapshot();
  }

  private createMessageDisplayContext(): ConstructorParameters<typeof MessageDisplayHelper>[0] {
    const thisEngine = this;

    return {
      get viewAdapter() { return thisEngine.viewAdapter; },
      get toolCallStates() { return thisEngine.toolCallStates; },
    };
  }

  private createUserInteractionContext(): ConstructorParameters<typeof UserInteractionHelper>[0] {
    const thisEngine = this;

    return {
      get lexStream() { return thisEngine.lexStream; },
      get isLoggedIn() { return thisEngine.isLoggedIn; },
      getCurrentProjectPath: () => thisEngine.getCurrentProjectPath(),
      get sessionId() { return thisEngine.sessionId; },
      resolveActiveRuntimeSessionId: () => thisEngine.resolveActiveRuntimeSessionId(),
      readCurrentViewSessionResource: () => thisEngine.chatSessionViewModelStore.currentSessionResource,
      get toolApprovalPolicy() { return thisEngine.ailyChatConfigService; },
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
    };
  }

  private createEditActionsContext(): ConstructorParameters<typeof EditActionsHelper>[0] {
    const thisEngine = this;

    return {
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.setCurrentViewVisibleProjectionList(value); },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      get inputValue() { return thisEngine.inputValue; },
      set inputValue(value) { thisEngine.inputValue = value; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      markCurrentViewVisibleProjectionOwner: () => thisEngine.markCurrentViewVisibleProjectionOwner(),
      markHistoryDirty: (sessionId) => thisEngine.markHistoryDirty(sessionId),
      get sessionId() { return thisEngine.sessionId; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMessageSource() { return thisEngine.currentMessageSource; },
      get ngZone() { return thisEngine.ngZone; },
      get isWaiting() { return thisEngine.isWaiting; },
      get isCompleted() { return thisEngine.isCompleted; },
      set isCompleted(value) { thisEngine.isCompleted = value; },
      get isCancelled() { return thisEngine.isCancelled; },
      set isCancelled(value) { thisEngine.isCancelled = value; },
      get pendingEditFeedback() { return thisEngine.pendingEditFeedback; },
      set pendingEditFeedback(value) { thisEngine.pendingEditFeedback = value; },
      get sessionAllowedPaths() { return thisEngine.sessionAllowedPaths; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      getCurrentProjectPath: () => this.getCurrentProjectPath(),
      get absAutoSyncService() { return thisEngine.absAutoSyncService; },
      get editCheckpointService() { return thisEngine.editCheckpointService; },
      get workspaceCheckpointProvider() { return thisEngine.workspaceCheckpointProvider; },
      get resourceManager() { return thisEngine.resourceManager; },
      get message() { return thisEngine.message; },
      get lexStream() { return thisEngine.lexStream; },
      get session() { return thisEngine.session; },
      buildExecutionSaveTarget: (sessionId) => thisEngine.buildExecutionSaveTarget(sessionId),
      readCurrentViewSessionResource: () => thisEngine.chatSessionViewModelStore.currentSessionResource,
      readSessionTurnResponses: (sessionId) => {
        const readSessionTurnResponses = (
          (thisEngine as unknown as { readSessionTurnResponses?: ChatEngineService['readSessionTurnResponses'] })
            .readSessionTurnResponses
          ?? ChatEngineService.prototype['readSessionTurnResponses']
        );
        return readSessionTurnResponses.call(thisEngine, typeof sessionId === 'string' ? sessionId : '');
      },
      replaceSessionModelTurnResponses: (sessionId, turnResponses, ownerPolicy) => {
        const replaceSessionModelTurnResponses = (
          (thisEngine as unknown as { replaceSessionModelTurnResponses?: ChatEngineService['replaceSessionModelTurnResponses'] })
            .replaceSessionModelTurnResponses
          ?? ChatEngineService.prototype['replaceSessionModelTurnResponses']
        );
        return replaceSessionModelTurnResponses.call(thisEngine, sessionId, turnResponses, ownerPolicy);
      },
      prepareProtocolTruncationForResend: (sessionId, turnId) =>
        thisEngine.prepareProtocolTruncationForResend(sessionId, turnId),
      submitRegeneratedUserTurn: async (sessionId, request) => {
        const requestText = request.requestText.trim();
        if (!sessionId || !requestText) {
          return;
        }

        const prepared: PreparedPendingFollowupRequest = {
          text: requestText,
          llmText: requestText,
          displayText: request.displayText ?? requestText,
          ...(request.requestMetadata
            ? { requestMetadata: clonePendingFollowupRequestMetadata(request.requestMetadata) }
            : {}),
        };
        await thisEngine.executePreparedUserSend(sessionId, prepared, {
          clearInput: false,
          resetPreparedUserTurnState: true,
        });
      },
      cancelCurrentRequestForSession: (sessionResource, source) => thisEngine.cancelCurrentRequestForSession(sessionResource, source),
      confirmRestoreCheckpoint: (confirmation) => thisEngine.confirmRestoreCheckpoint(confirmation),
      get hostResponseProjection() { return thisEngine.hostResponseProjection; },
      restoreSharedHostProjectionState: (state, options) => thisEngine.restoreSharedHostProjectionState(state, options),
      replaceSharedHostProjectionState: (state, options) => thisEngine.replaceSharedHostProjectionState(state, options),
      projectRestoredHostProjection: (sessionId, turnResponses, hostProjectionState, options) => {
        thisEngine.projectRestoredHostProjection(sessionId, turnResponses, hostProjectionState, {
          attachedView: options?.attachedView !== false,
        });
      },
      readSessionCheckpointTimelineState: (sessionId) => {
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        return normalizedSessionId
          ? thisEngine.chatSessionModelStore.get(normalizedSessionId)?.getCheckpointTimelineState() ?? null
          : null;
      },
      commitCheckpointRestoreRequestListTransaction: (sessionId, checkpointId) =>
        thisEngine.chatSessionModelStore.commitCheckpointRestoreTransaction(sessionId, checkpointId),
      rollbackCheckpointRestoreRequestListTransaction: (sessionId, committed) =>
        thisEngine.chatSessionModelStore.rollbackCheckpointRestoreTransaction(sessionId, committed as any),
      prepareCheckpointRedoRequestListTransaction: (sessionId) =>
        thisEngine.chatSessionModelStore.prepareCheckpointRedoTransaction(sessionId),
      commitCheckpointRedoRequestListTransaction: (sessionId, prepared) =>
        thisEngine.chatSessionModelStore.commitCheckpointRedoTransaction(sessionId, prepared as any),
      rollbackCheckpointRedoRequestListTransaction: (sessionId, prepared) =>
        thisEngine.chatSessionModelStore.rollbackCheckpointRedoTransaction(sessionId, prepared as any),
      applyRequestListTransactionEffects: (sessionId, transaction) =>
        thisEngine.applyRequestListTransactionEffects(sessionId, transaction as ChatSessionRequestListTransactionResult),
      send: (sender, content, clear, sessionId) => thisEngine.sendFromCoordinationContext(sender, content, clear, sessionId),
    };
  }

  private async confirmRestoreCheckpoint(confirmation: RestoreCheckpointConfirmation): Promise<boolean> {
    if (this.restoreCheckpointDialogOpen) {
      return false;
    }

    const dialogData = this.buildRestoreCheckpointConfirmationDialogData(confirmation);

    return new Promise<boolean>((resolve) => {
      this.restoreCheckpointDialogOpen = true;

      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '350px',
        nzContent: UnsaveDialogComponent,
        nzData: dialogData,
      });

      modalRef.afterClose.subscribe(result => {
        this.restoreCheckpointDialogOpen = false;
        resolve(result?.result === 'confirm');
      });
    });
  }

  private buildRestoreCheckpointConfirmationDialogData(
    confirmation: RestoreCheckpointConfirmation,
  ): UnsaveDialogData {
    return {
      title: confirmation.requestCount === 1
        ? this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.TITLE_SINGLE',
          'Do you want to undo your last edit?',
        )
        : this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.TITLE_MULTIPLE',
          'Do you want to undo {{count}} edits?',
          { count: confirmation.requestCount },
        ),
      text: this.buildRestoreCheckpointConfirmationMessage(confirmation),
      buttons: [
        {
          text: this.translateRestoreCheckpointDialogText('UNSAVE_DIALOG.CANCEL', 'Cancel'),
          type: 'default',
          action: 'cancel',
        },
        {
          text: this.translateRestoreCheckpointDialogText('CHECKPOINT_RESTORE_DIALOG.CONFIRM', 'Yes'),
          type: 'primary',
          danger: true,
          action: 'confirm',
        },
      ],
    };
  }

  private buildRestoreCheckpointConfirmationMessage(
    confirmation: RestoreCheckpointConfirmation,
  ): string {
    const isLastRequest = confirmation.requestCount === 1;

    if (confirmation.fileCount === 1 && confirmation.fileLabel) {
      return isLastRequest
        ? this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.MESSAGE_LAST_SINGLE_FILE',
          'This will remove your last request and undo the edits made to {{file}}. Do you want to proceed?',
          { file: confirmation.fileLabel },
        )
        : this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.MESSAGE_MULTI_SINGLE_FILE',
          'This will remove all subsequent requests and undo edits made to {{file}}. Do you want to proceed?',
          { file: confirmation.fileLabel },
        );
    }

    if (confirmation.fileCount > 0) {
      return isLastRequest
        ? this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.MESSAGE_LAST_MULTI_FILE',
          'This will remove your last request and undo edits made to {{count}} files in your working set. Do you want to proceed?',
          { count: confirmation.fileCount },
        )
        : this.translateRestoreCheckpointDialogText(
          'CHECKPOINT_RESTORE_DIALOG.MESSAGE_MULTI_FILE',
          'This will remove all subsequent requests and undo edits made to {{count}} files in your working set. Do you want to proceed?',
          { count: confirmation.fileCount },
        );
    }

    return isLastRequest
      ? this.translateRestoreCheckpointDialogText(
        'CHECKPOINT_RESTORE_DIALOG.MESSAGE_LAST_NO_FILE',
        'This will remove your last request and restore the chat to that point. Do you want to proceed?',
      )
      : this.translateRestoreCheckpointDialogText(
        'CHECKPOINT_RESTORE_DIALOG.MESSAGE_MULTI_NO_FILE',
        'This will remove all subsequent requests and restore the chat to that point. Do you want to proceed?',
      );
  }

  private translateRestoreCheckpointDialogText(
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ): string {
    const translated = this.translate?.instant?.(key, params);
    if (typeof translated === 'string' && translated !== key) {
      return translated;
    }

    return this.interpolateRestoreCheckpointDialogText(fallback, params);
  }

  private interpolateRestoreCheckpointDialogText(
    template: string,
    params?: Record<string, string | number>,
  ): string {
    if (!params) {
      return template;
    }

    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, token: string) => {
      const value = params[token];
      return typeof value === 'undefined' ? '' : String(value);
    });
  }

  private createSessionLifecycleContext(): ConstructorParameters<typeof SessionLifecycleHelper>[0] {
    const thisEngine = this;

    return {
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.setCurrentViewVisibleProjectionList(value); },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      markCurrentViewVisibleProjectionOwner: () => thisEngine.markCurrentViewVisibleProjectionOwner(),
      markHistoryDirty: (sessionId) => thisEngine.markHistoryDirty(sessionId),
      get chatSessionItemsService() { return thisEngine.chatSessionItemsService; },
      readSessionTurnResponses: (sessionId) => {
        const readSessionTurnResponses = (
          (thisEngine as unknown as { readSessionTurnResponses?: ChatEngineService['readSessionTurnResponses'] })
            .readSessionTurnResponses
          ?? ChatEngineService.prototype['readSessionTurnResponses']
        );
        return readSessionTurnResponses.call(thisEngine, typeof sessionId === 'string' ? sessionId : '');
      },
      prepareForkPrefixRequestListTransaction: (sessionId, turnId) =>
        thisEngine.chatSessionModelStore.prepareForkPrefixBeforeTurn(sessionId, turnId) as any,
      readSessionRuntimeState: (sessionId) => thisEngine.chatSessionRuntimeStore.read(sessionId),
      readSessionCheckpointTimelineState: (sessionId) => {
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        return normalizedSessionId
          ? thisEngine.chatSessionModelStore.get(normalizedSessionId)?.getCheckpointTimelineState() ?? null
          : null;
      },
      acquireExistingSessionModel: (sessionId) => thisEngine.chatSessionModelStore.acquireExisting(sessionId),
      acquireSessionModel: (props) => thisEngine.chatSessionModelStore.acquireOrCreate(props),
      acquireProvisionalSessionModel: (props) => thisEngine.chatSessionModelStore.acquireOrCreate(
        props,
        { suppressCreatedEvent: true },
      ),
      attachSessionViewModel: (sessionId) => thisEngine.chatSessionViewModelStore.attach(sessionId),
      detachSessionViewModel: (sessionId) => thisEngine.chatSessionViewModelStore.detach(sessionId),
      readCurrentViewSessionResource: () => thisEngine.chatSessionViewModelStore.currentSessionResource,
      get hostResponseProjection() { return thisEngine.hostResponseProjection; },
      createSessionSaveBridge: (ctx) => createSessionLifecycleHostSessionSaveBridge(ctx),
      requestHostResourceOperation: (request) => thisEngine.runtimeHostForView().requestResourceOperation(request),
      clearEntryInputState: () => {
        thisEngine.legacyInputValue = '';
      },
      buildExecutionSaveTarget: (sessionId) => thisEngine.buildExecutionSaveTarget(sessionId),
      hasSessionRuntimeHandle: (sessionId) => !!thisEngine.lexStream.agent.getHandle?.(sessionId),
      prewarmRuntimeExecutor: (request) => thisEngine.runtimeHostForView().prewarmRuntime(request),
      projectRestoredRuntimeAuxiliary: (sessionId, auxiliary) => thisEngine.projectRestoredRuntimeAuxiliary(sessionId, auxiliary),
      detachSessionRuntimeView: (sessionId) => thisEngine.detachSessionRuntimeView(sessionId),
      attachSessionView: (sessionId) => thisEngine.attachSessionView(sessionId),
      attachCurrentSessionView: () => thisEngine.attachCurrentSessionView(),
      markVisibleSessionProjectionOwner: (sessionId) => thisEngine.markVisibleSessionProjectionOwner(sessionId),
      ensureBackgroundSessionCanRerun: (sessionId) => thisEngine.ensureBackgroundSessionCanRerun(sessionId),
      resetVisibleSessionProjection: (options) => thisEngine.resetVisibleSessionProjection(options),
      buildRuntimeRestoreHostRecord: (request) => thisEngine.hostSessionRestoreBridge.buildRuntimeRestoreHostRecord(request),
      restoreSessionHostRecord: (hostRecord, options) => thisEngine.hostSessionRestoreBridge.restore(hostRecord, options),
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get sessionId() { return thisEngine.sessionId; },
      set sessionId(value) { thisEngine.sessionId = value; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get chatSessionEntryStateService() { return thisEngine.chatSessionEntryStateService; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMessageSource() { return thisEngine.currentMessageSource; },
      get ngZone() { return thisEngine.ngZone; },
      get isWaiting() { return thisEngine.isWaiting; },
      set isWaiting(value) { thisEngine.isWaiting = value; },
      get isSessionStarting() { return thisEngine.isSessionStarting; },
      set isSessionStarting(value) { thisEngine.isSessionStarting = value; },
      get isCancelled() { return thisEngine.isCancelled; },
      set isCancelled(value) { thisEngine.isCancelled = value; },
      get toolCallingIteration() { return thisEngine.toolCallingIteration; },
      set toolCallingIteration(value) { thisEngine.toolCallingIteration = value; },
      get mcpInitialized() { return thisEngine.mcpInitialized; },
      set mcpInitialized(value) { thisEngine.mcpInitialized = value; },
      get isCompleted() { return thisEngine.isCompleted; },
      set isCompleted(value) { thisEngine.isCompleted = value; },
      get messageSubscription() { return thisEngine.messageSubscription; },
      set messageSubscription(value) { thisEngine.messageSubscription = value; },
      get activeToolExecutions() { return thisEngine.activeToolExecutions; },
      set activeToolExecutions(value) { thisEngine.activeToolExecutions = value; },
      get hasInitializedForThisLogin() { return thisEngine.hasInitializedForThisLogin; },
      set hasInitializedForThisLogin(value) { thisEngine.hasInitializedForThisLogin = value; },
      get legacyActivatedDeferredTools() { return thisEngine.legacyActivatedDeferredTools; },
      get sessionTitle() { return thisEngine.sessionTitle; },
      get sessionAllowedPaths() { return thisEngine.sessionAllowedPaths; },
      set sessionAllowedPaths(value) { thisEngine.sessionAllowedPaths = value; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get chatService() { return thisEngine.chatService; },
      get currentMode() { return thisEngine.currentMode; },
      get currentAgentRuntimeMode() { return thisEngine.currentAgentRuntimeMode; },
      get currentAgentRuntimeModeSource() { return thisEngine.currentAgentRuntimeModeSource; },
      get currentModel() { return thisEngine.currentModel; },
      get isLoggedIn() { return thisEngine.isLoggedIn; },
      get prjPath() { return thisEngine.prjPath; },
      get prjRootPath() { return thisEngine.prjRootPath; },
      get contextBudgetService() { return thisEngine.contextBudgetService; },
      get repetitionDetectionService() { return thisEngine.repetitionDetectionService; },
      get mcpService() { return thisEngine.mcpService; },
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
      getDevelopmentModePreferenceRuntimeMode: () => thisEngine.configService?.getPreferredChatAgentRuntimeMode?.(),
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
      get resourceManager() { return thisEngine.resourceManager; },
      get message() { return thisEngine.message; },
      get translate() { return thisEngine.translate; },
      get interaction() { return thisEngine.interaction; },
      get lexStream() { return thisEngine.lexStream; },
      resumeRestoredInteraction: (content, interactionAction, options) => (
        thisEngine.submitInteractionActionRequest(
          content,
          interactionAction,
          options?.requestMetadata,
          options?.sessionId,
        )
      ),
      send: (sender, content, clear, sessionId) => thisEngine.sendFromCoordinationContext(sender, content, clear, sessionId),
      get session() { return thisEngine.session; },
      restoreSharedHostProjectionState: (state, options) => this.restoreSharedHostProjectionState(state, options),
      replaceSharedHostProjectionState: (state, options) => this.replaceSharedHostProjectionState(state, options),
    };
  }

  private createHostSessionRestoreContext(): ConstructorParameters<typeof HostSessionRestoreBridge>[0] {
    const thisEngine = this;

    return {
      get scrollManager() { return thisEngine.scrollManager; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get sessionId() { return thisEngine.sessionId; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMode() { return thisEngine.currentMode; },
      readSessionRuntimeState: (sessionId) => thisEngine.chatSessionRuntimeStore.read(sessionId),
      get toolCallingIteration() { return thisEngine.toolCallingIteration; },
      set toolCallingIteration(value) { thisEngine.toolCallingIteration = value; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get chatService() { return thisEngine.chatService; },
      get contextBudgetService() { return thisEngine.createRuntimeScopedContextBudgetService(); },
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
      get lexStream() { return thisEngine.lexStream; },
      requestHostResourceOperation: (request) => thisEngine.runtimeHostForView().requestResourceOperation(request),
      projectRestoredHostProjection: (sessionId, turnResponses, hostProjectionState, options) => {
        thisEngine.projectRestoredHostProjection(sessionId, turnResponses, hostProjectionState, options);
      },
      replaceSessionModelTurnResponses: (sessionId, turnResponses, ownerPolicy) => {
        const replaceSessionModelTurnResponses = (
          (thisEngine as unknown as { replaceSessionModelTurnResponses?: ChatEngineService['replaceSessionModelTurnResponses'] })
            .replaceSessionModelTurnResponses
          ?? ChatEngineService.prototype['replaceSessionModelTurnResponses']
        );
        return replaceSessionModelTurnResponses.call(thisEngine, sessionId, turnResponses, ownerPolicy);
      },
      resumeRestoredInteraction: (content, interactionAction, options) => (
        thisEngine.submitInteractionActionRequest(
          content,
          interactionAction,
          options?.requestMetadata,
          options?.sessionId,
        )
      ),
      restoreSharedHostProjectionState: (state, options) => thisEngine.restoreSharedHostProjectionState(state, options),
    };
  }

  private projectViewProjectionToModelProjection(
    sessionId: string | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options: {
      readonly attachedView: boolean;
    },
  ): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const capabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get' | 'acquireOrCreate' | 'applyRuntimeState'>;
    }).chatSessionModelStore;
    if (!modelStore) {
      return false;
    }

    const existingModel = modelStore.get?.(targetSessionId);
    const modelReference = existingModel
      ? undefined
      : modelStore.acquireOrCreate?.({ sessionResource: targetSessionId });
    const model = existingModel ?? modelReference?.object;
    if (!model) {
      modelReference?.dispose();
      return false;
    }

    const runtimeStatePatch = {
      hostProjectionState,
      attachedView: options.attachedView,
      capabilities,
    };
    const projected = typeof modelStore.applyRuntimeState === 'function'
      ? modelStore.applyRuntimeState(targetSessionId, runtimeStatePatch, { reason: 'projection' })
      : (model.applyRuntimeState(runtimeStatePatch, { reason: 'projection' }), true);
    if (!projected) {
      modelReference?.dispose();
      return false;
    }
    modelReference?.dispose();
    return true;
  }

  private projectModelTranscriptToRuntimeMirror(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options: {
      readonly attachedView: boolean;
      readonly projection: ChatRuntimeTurnResponseSyncOptions;
    },
  ): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return false;
    }

    const capabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get' | 'acquireOrCreate' | 'applyRuntimeState'>;
    }).chatSessionModelStore;
    if (!modelStore) {
      return false;
    }

    const existingModel = modelStore.get?.(targetSessionId);
    const modelReference = existingModel
      ? undefined
      : modelStore.acquireOrCreate?.({ sessionResource: targetSessionId });
    const model = existingModel ?? modelReference?.object;
    if (!model) {
      modelReference?.dispose();
      return false;
    }

    const runtimeStatePatch = {
      turnResponses,
      hostProjectionState,
      attachedView: options.attachedView,
      capabilities,
    };
    const projection = options.projection;
    const runtimeChangeOptions = runtimeChangeOptionsFromTranscriptProjection(projection);
    const projected = typeof modelStore.applyRuntimeState === 'function'
      ? modelStore.applyRuntimeState(targetSessionId, runtimeStatePatch, runtimeChangeOptions)
      : (typeof model.applyRuntimeState === 'function'
        ? (model.applyRuntimeState(runtimeStatePatch, runtimeChangeOptions), true)
        : false);
    if (!projected) {
      modelReference?.dispose();
      return false;
    }
    modelReference?.dispose();
    return true;
  }

  private replaceSessionModelTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return null;
    }

    const existingModel = this.chatSessionModelStore.get(targetSessionId);
    const modelReference = existingModel
      ? { object: existingModel, dispose: () => undefined }
      : this.chatSessionModelStore.acquireOrCreate({ sessionResource: targetSessionId });
    if (!modelReference) {
      return null;
    }

    try {
      return this.chatSessionModelStore.replaceAllTurnResponsesTransaction(
        targetSessionId,
        turnResponses,
        ownerPolicy,
      )?.turnResponses ?? null;
    } finally {
      modelReference.dispose();
    }
  }

  private mergeSessionModelTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return null;
    }

    const model = this.chatSessionModelStore.get(targetSessionId);
    if (!model) {
      return null;
    }

    if (turnResponses.length === 0) {
      return model.turnResponses;
    }

    let committedTurnResponses: readonly TurnResponseTurn[] | null = model.turnResponses;
    for (const turnResponse of turnResponses) {
      committedTurnResponses = this.appendSessionModelTurnResponse(
        targetSessionId,
        turnResponse,
        ownerPolicy,
      );
      if (committedTurnResponses === null) {
        return null;
      }
    }

    return committedTurnResponses ?? model.turnResponses;
  }

  private appendSessionModelTurnResponse(
    sessionId: string | null | undefined,
    turnResponse: TurnResponseTurn,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return null;
    }

    const existingModel = this.chatSessionModelStore.get(targetSessionId);
    const modelReference = existingModel
      ? { object: existingModel, dispose: () => undefined }
      : this.chatSessionModelStore.acquireOrCreate({ sessionResource: targetSessionId });
    if (!modelReference) {
      return null;
    }

    try {
      const status = turnResponse.response?.status;
      const transaction = typeof status === 'string' && status !== 'streaming'
        ? this.chatSessionModelStore.appendCompletedTurnTransaction(targetSessionId, turnResponse)
        : this.chatSessionModelStore.appendTransientTurnTransaction(targetSessionId, turnResponse);
      return transaction?.turnResponses ?? null;
    } finally {
      modelReference.dispose();
    }
  }

  private projectSharedHostProjectionStateToRuntimeOwner(
    sessionId: string | null | undefined,
    hostProjectionState: HostTurnResponseState | null,
    options: { readonly attachedView: boolean },
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const projectViewProjectionToModelProjection = (
      (this as unknown as {
        projectViewProjectionToModelProjection?: ChatEngineService['projectViewProjectionToModelProjection'];
      }).projectViewProjectionToModelProjection
      ?? ChatEngineService.prototype['projectViewProjectionToModelProjection']
    );
    if (projectViewProjectionToModelProjection.call(this, targetSessionId, hostProjectionState, options)) {
      return;
    }

    const capabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const concurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    ) ?? null;

    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch: {
        hostProjectionState,
        attachedView: options.attachedView,
        capabilities,
        concurrencyScope,
      },
      options: {
        reason: 'projection',
      },
    });
  }

  private projectRestoredHostProjection(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[],
    hostProjectionState: HostTurnResponseState,
    options: { readonly attachedView: boolean },
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const capabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const concurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    ) ?? null;
    const projection = terminalTranscriptProjection('restore');
    const runtimeChangeOptions = runtimeChangeOptionsFromTranscriptProjection(projection);
    if (this.projectModelTranscriptToRuntimeMirror(targetSessionId, turnResponses, hostProjectionState, {
      attachedView: options.attachedView,
      projection,
    })) {
      return;
    }

    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch: {
        turnResponses,
        hostProjectionState,
        attachedView: options.attachedView,
        capabilities,
        concurrencyScope,
      },
      options: runtimeChangeOptions,
    });
  }

  private createLexRuntimeFacade(): LexOwnerFacade {
    return this.createHostViewLexRuntimeFacade();
  }

  private createHostViewLexRuntimeFacade(): LexOwnerFacade {
    const engine = this;
    const ownerOnly = (capability: string): never => {
      throw new Error(`[AilyChat][RuntimeHost] ${capability} is owned by the host runtime. Renderer views must use ChatRuntimeHost.`);
    };
    const normalizeSessionId = (sessionId?: string | null): string => (
      typeof sessionId === 'string' ? sessionId.trim() : ''
    );
    const resolveTargetSessionId = (sessionId?: string | null): string => (
      normalizeSessionId(sessionId)
      || engine.resolveCurrentViewSessionResource()
      || engine.resolveActiveRuntimeSessionId()
    );
    const readTurnResponses = (sessionId?: string | null): readonly TurnResponseTurn[] => {
      const targetSessionId = resolveTargetSessionId(sessionId);
      if (!targetSessionId) {
        return [];
      }
      const modelTurns = engine.readSessionTurnResponses(targetSessionId);
      if (modelTurns.length > 0) {
        return modelTurns;
      }
      return [];
    };
    const hydrateTurnResponses = (
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[],
      options: { readonly visibility?: LexTurnResponsesHydrationVisibility } = {},
    ): void => {
      const targetSessionId = resolveTargetSessionId(sessionId);
      if (!targetSessionId || !Array.isArray(turnResponses)) {
        return;
      }

      const committedTurnResponses = engine.replaceSessionModelTurnResponses(
        targetSessionId,
        turnResponses,
        { source: 'runtime-host-view-hydrate' },
      ) ?? turnResponses;
      const visibility = options.visibility ?? (
        targetSessionId === engine.resolveCurrentViewSessionResource() ? 'visibleAttach' : 'detached'
      );
      engine.syncExecutionRuntimeTurnResponses(
        targetSessionId,
        committedTurnResponses,
        visibility === 'detached'
          ? terminalTranscriptProjection('restore')
          : liveTranscriptProjection('execution'),
      );

      if (visibility !== 'visibleAttach' || targetSessionId !== engine.resolveCurrentViewSessionResource()) {
        return;
      }

      engine.visibleTranscriptModel.replaceFromSessionModel(committedTurnResponses);
      engine.dialogItemsCache = null;
      engine.visibleProjectionSessionId = targetSessionId;
      const projectionState = buildRuntimeHostProjectionState(committedTurnResponses);
      if (projectionState) {
        engine.liveHostRequestGraphCache.replaceState(projectionState);
      }
    };
    const findTurnById = (turnId: string | null | undefined): TurnResponseTurn | undefined => {
      const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
      if (!normalizedTurnId) {
        return undefined;
      }
      return readTurnResponses().find(turn => turn.turnId === normalizedTurnId);
    };
    const readonlyConversation = {
      messages: (): ChatMessage[] => readTurnResponses().flatMap((turn): ChatMessage[] => {
        const user = buildTurnResponseUserMessageProjection(turn);
        const assistant = buildTurnResponseAssistantMessageProjection(turn);
        return [
          {
            role: user.role,
            content: user.content,
            state: user.state,
            source: user.source,
            modelName: user.modelName,
            modelBillingLabel: user.modelBillingLabel,
            turnId: turn.turnId,
          },
          {
            role: assistant.role,
            content: assistant.content,
            state: assistant.state,
            source: assistant.source,
            modelName: assistant.modelName,
            modelBillingLabel: assistant.modelBillingLabel,
            turnId: turn.turnId,
          },
        ];
      }),
    };
    const readonlyTurns = {
      currentId: (): string | undefined => readTurnResponses().at(-1)?.turnId,
      turnIdByRound: (roundId: string): string | undefined => {
        const normalizedRoundId = typeof roundId === 'string' ? roundId.trim() : '';
        if (!normalizedRoundId) {
          return undefined;
        }
        return readTurnResponses().find(turn => (
          Array.isArray(turn.rounds) && turn.rounds.some(round => round?.id === normalizedRoundId)
        ))?.turnId;
      },
      requestContent: (turnId: string): string | undefined => findTurnById(turnId)?.request?.content,
      lastRoundId: (turnId: string): string | undefined => findTurnById(turnId)?.rounds?.at(-1)?.id,
      currentRequestMetadata: (): TurnRequest['metadata'] | undefined => readTurnResponses().at(-1)?.request?.metadata,
      complete: () => ownerOnly('turns.complete'),
      discardIncomplete: () => ownerOnly('turns.discardIncomplete'),
      removeFrom: () => ownerOnly('turns.removeFrom'),
      removeFromIndex: () => ownerOnly('turns.removeFromIndex'),
      restartFrom: () => ownerOnly('turns.restartFrom'),
      clear: (): void => undefined,
    };
    const facade = {
      get agent() {
        return {
          ensureAgent: () => ownerOnly('agent.ensureAgent'),
          activateSession: () => ownerOnly('agent.activateSession'),
          isConfiguredFor: () => false,
          loadModule: () => ownerOnly('agent.loadModule'),
          stop: () => ownerOnly('agent.stop'),
          dispose: () => ownerOnly('agent.dispose'),
          disposeAll: () => ownerOnly('agent.disposeAll'),
          getAgent: () => undefined,
          getHandle: () => undefined,
          getSessionIds: () => [],
        };
      },
      get turns() { return readonlyTurns; },
      get turn() {
        return {
          begin: () => ownerOnly('turn.begin'),
          run: () => ownerOnly('turn.run'),
          draft: () => '',
          ensureMessage: () => ownerOnly('turn.ensureMessage'),
          appendError: () => ownerOnly('turn.appendError'),
        };
      },
      get conversation() { return readonlyConversation; },
      get ui() {
        return {
          presentQuestion: () => ownerOnly('ui.presentQuestion'),
          updateQuestionAnswers: () => ownerOnly('ui.updateQuestionAnswers'),
          presentConfirmation: () => ownerOnly('ui.presentConfirmation'),
          resolveConfirmation: () => ownerOnly('ui.resolveConfirmation'),
          presentToolCallApproval: () => ownerOnly('ui.presentToolCallApproval'),
          resolveToolCallApproval: () => ownerOnly('ui.resolveToolCallApproval'),
          processEvent: () => ownerOnly('ui.processEvent'),
        };
      },
      get runtime() {
        return {
          tools: () => [],
          llmConfig: () => null,
        };
      },
      get session() {
        return {
          save: () => ownerOnly('session.save'),
          snapshot: () => null,
          forkSnapshot: () => null,
          resolveRestorePlan: () => ownerOnly('session.resolveRestorePlan'),
          restoreResolvedSnapshot: () => ownerOnly('session.restoreResolvedSnapshot'),
          restore: () => ownerOnly('session.restore'),
        };
      },
      get compactionMetricsSnapshot() {
        return null;
      },
      get turnResponses() {
        return readTurnResponses();
      },
      getTurnResponses: (sessionId: string) => readTurnResponses(sessionId),
      hydrateTurnResponses,
      finalizeCurrentTurnResponse: (_status: TurnResponseStatus = 'completed') => false,
      setHostStreamListener: () => undefined,
      setHostItemTextDeltaDeliveryPolicy: () => undefined,
      resetSessionState: () => {
        engine.invalidateHostRequestGraph();
      },
      flushPendingEvents: () => undefined,
      drainPendingEvents: () => [],
    };

    return facade as unknown as LexOwnerFacade;
  }

  private createStopCoordinatorContext(): ConstructorParameters<typeof ChatStopCoordinator>[0] {
    const thisEngine = this;

    return {
      get isCancelled() { return thisEngine.isCancelled; },
      set isCancelled(value) { thisEngine.isCancelled = value; },
      get messageSubscription() { return thisEngine.messageSubscription; },
      set messageSubscription(value) { thisEngine.messageSubscription = value; },
      get pendingUserInput() { return thisEngine.pendingUserInput; },
      set pendingUserInput(value) { thisEngine.pendingUserInput = value; },
      get activeToolExecutions() { return thisEngine.activeToolExecutions; },
      set activeToolExecutions(value) { thisEngine.activeToolExecutions = value; },
      get currentStatelessMode() { return thisEngine.currentStatelessMode; },
      set currentStatelessMode(value) { thisEngine.currentStatelessMode = value; },
      get isWaiting() { return thisEngine.isWaiting; },
      set isWaiting(value) { thisEngine.isWaiting = value; },
      get isCompleted() { return thisEngine.isCompleted; },
      set isCompleted(value) { thisEngine.isCompleted = value; },
      get lexStream() { return thisEngine.lexStream; },
      get session() { return thisEngine.session; },
      applyPendingSwitch: (sessionId) => this.applyPendingSwitch(sessionId),
      get contextBudgetService() { return thisEngine.contextBudgetService; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get sessionId() { return thisEngine.sessionId; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      dismissPendingInteractions: (sessionId) => {
        const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
          ? sessionId.trim()
          : thisEngine.resolveActiveRuntimeSessionId();
        if (!targetSessionId) {
          return;
        }

        thisEngine.interaction.resetApprovalState();
        thisEngine.runtimeInteractionHost.clearQuestion(targetSessionId);
        thisEngine.runtimeInteractionHost.clearConfirmations(targetSessionId);
      },
      markExplicitInterrupt: (sessionId) => {
        const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
          ? sessionId.trim()
          : thisEngine.resolveActiveRuntimeSessionId();
        if (!targetSessionId) {
          return;
        }

        const runtimeStatePatch = {
          status: null,
          requestInProgress: false,
          yieldRequested: false,
          supportsInterruption: false,
          activeResponseHandle: null,
          stopSession: null,
          debugSummary: {
            lastExplicitInterruptAt: Date.now(),
          },
        };
        thisEngine.chatRuntimeViewMirrorProjection.projectRuntimeState({
          sessionId: targetSessionId,
          patch: runtimeStatePatch,
          options: {
            reason: 'status',
          },
        });
      },
      awaitPendingLexRequestCompleted: async (sessionId) => {
        const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
          ? sessionId.trim()
          : thisEngine.resolveActiveRuntimeSessionId();
        if (!targetSessionId) {
          return;
        }

        const waitForSessionRequestSettle = (
          (thisEngine as unknown as { waitForSessionRequestSettle?: ChatEngineService['waitForSessionRequestSettle'] })
            .waitForSessionRequestSettle
          ?? ChatEngineService.prototype['waitForSessionRequestSettle']
        );
        await waitForSessionRequestSettle.call(thisEngine, targetSessionId);
      },
      stopSettleTimeoutMs: 1000,
      requestStop: (sessionId) => thisEngine.stopRuntimeSessionWithBarrier(sessionId),
    };
  }

  private createSwitchCoordinatorContext(): ConstructorParameters<typeof ChatSwitchCoordinator>[0] {
    const thisEngine = this;

    return {
      get isWaiting() { return thisEngine.isWaiting; },
      get _pendingModelSwitch() { return thisEngine._pendingModelSwitch; },
      set _pendingModelSwitch(value) { thisEngine._pendingModelSwitch = value; },
      get _pendingModeSwitch() { return thisEngine._pendingModeSwitch; },
      set _pendingModeSwitch(value) { thisEngine._pendingModeSwitch = value; },
      get _pendingSwitchSessionId() { return thisEngine._pendingSwitchSessionId; },
      set _pendingSwitchSessionId(value) { thisEngine._pendingSwitchSessionId = value; },
      get currentModel() { return thisEngine.currentModel; },
      get currentMode() { return thisEngine.currentMode; },
      get sessionId() { return thisEngine.sessionId; },
      get chatService() { return thisEngine.chatService; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get contextBudgetService() { return thisEngine.contextBudgetService; },
      get languageModelsService() { return thisEngine.languageModelsService; },
      get message() { return thisEngine.message; },
    };
  }

  private createConversationActionCoordinatorContext(): ConstructorParameters<typeof ChatConversationActionCoordinator>[0] {
    const thisEngine = this;

    return {
      get isWaiting() { return thisEngine.isWaiting; },
      get sessionId() { return thisEngine.resolveCurrentViewSessionResource(); },
      get message() { return thisEngine.message; },
      get scrollManager() { return thisEngine.scrollManager; },
    };
  }

  private createExternalInputCoordinatorContext(): ConstructorParameters<typeof ChatExternalInputCoordinator>[0] {
    const thisEngine = this;

    return {
      get inputValue() { return thisEngine.inputValue; },
      set inputValue(value) { thisEngine.inputValue = value; },
      get isWaiting() { return thisEngine.isWaiting; },
      get sessionId() { return thisEngine.resolveCurrentViewSessionResource(); },
      get message() { return thisEngine.message; },
      get scrollManager() { return thisEngine.scrollManager; },
      triggerSyncDetectChanges: () => thisEngine.triggerSyncDetectChanges(),
    };
  }

  // ==================== 构造函数 ====================

  constructor(
    public chatService: ChatService,
    public mcpService: McpService,
    public ailyChatConfigService: AilyChatConfigService,
    public languageModelsService: AilyChatLanguageModelsService,
    public chatHistoryService: ChatHistoryService,
    public repetitionDetectionService: RepetitionDetectionService,
    public contextBudgetService: ContextBudgetService,
    public configService: ConfigService,
    private contextBudgetViewService: ContextBudgetViewService,
    public authQuotaStateService: AuthQuotaStateService,
    public chatInputNoticeStateService: ChatInputNoticeStateService,
    private chatSetupSuggestionService: ChatSetupSuggestionService,
    public ngZone: NgZone,
    public absAutoSyncService: AbsAutoSyncService,
    public editCheckpointService: EditCheckpointService,
    private aiCoderDiffBridge: AiCoderDiffBridgeService,
    public workspaceCheckpointProvider: GitWorkspaceCheckpointProviderService,
    public translate: TranslateService,
    public message: NzMessageService,
    public scrollManager: ScrollManagerService,
    public resourceManager: ResourceManagerService,
    public menuManager: MenuManagerService,
    public runtimeInteractionHost: ChatRuntimeInteractionHostService,
    public requestQuotaStateService: RequestQuotaStateService,
  ) {
    this.editCheckpointService.setWorkspaceCheckpointProvider(this.workspaceCheckpointProvider);

    // 初始化 viewAdapter（需要 ngZone 已注入）
    (this as any).viewAdapter = new ChatViewAdapter(
      () => this.list,
      (msg) => {
        this.markCurrentViewVisibleProjectionOwner();
        this.list.push(msg);
      },
      () => this.currentMessageSource,
      () => this.currentModelName || undefined,
      () => this.currentModelBillingLabel || undefined,
      () => this.isWaiting,
      () => {
        const currentViewSessionResource = this.resolveCurrentViewSessionResource();
        if (currentViewSessionResource) {
          this.markHistoryDirty(currentViewSessionResource);
        }
      },
      this.ngZone,
      undefined, // cdCallback — 由 component 通过 setCdCallback 注入
      () => this.scrollManager.captureAutoScrollState(),
      (shouldFollow) => this.scrollManager.scrollToBottomIfNeeded(shouldFollow, 'auto'),
    );

    this.chatHistoryService.setLiveSessionProvider((sessionId) => this.session.buildLiveHostSessionRecord({
      target: this.buildExecutionSaveTarget(sessionId),
    }));
    this.chatHistoryService.setAutoSaveSessionActiveProvider((sessionId) => this.readVisibleSessionRequestInProgress(sessionId));

    // H1: wire the cache as the host stream listener for incremental turn events.
    this.lexStream.setHostStreamListener(this.liveHostRequestGraphCache);

    this.syncExecutionModeGuidanceNotice(
      this.chatService.currentSessionPermissionLevel,
      this.chatService.currentSessionApprovalsReviewer,
      this.chatService.currentSessionApprovalPolicy,
    );
  }

  /** 注册 OnPush CD 回调（由 component 调用 cdr.markForCheck） */
  setCdCallback(cb: () => void): void {
    this.viewAdapter.setCdCallback(cb);
  }

  /** Project schematic subagent progress into the connection-graph iframe notice channel. */
  setSchematicIframeProgressTarget(target: { emitNotice?: (opts: {
    title?: string;
    text?: string;
    state?: string;
    showProgress?: boolean;
    setTimeout?: number;
    sendToLog?: boolean;
  }) => void } | null | undefined): void {
    this.schematicIframeProgressProjector = target
      ? new SchematicIframeProgressProjector(target)
      : null;
  }

  projectExecutionRenderEvent(
    sessionId: string | null | undefined,
    event: RenderEvent,
    request?: {
      readonly sessionId: string;
      readonly requestText: string;
      readonly displayText?: string;
      readonly metadata?: TurnRequest['metadata'] | null;
      readonly activeResponseHandle?: unknown;
    } | null,
  ): void {
    this.schematicIframeProgressProjector?.process(sessionId, event, request);
  }

  /** AI 编辑完成后在内嵌 Coder 打开 DiffEditor 预览（与 autoSaveEdits / 摘要 UI 解耦） */
  triggerAiEditDiffPreview(summary: EditsSummary | null): void {
    const workspaceRoot = this.prjPath || this.prjRootPath;
    if (workspaceRoot) {
      this.aiCoderDiffBridge.setWorkspaceRoot(workspaceRoot);
    }
    if (!summary?.files?.length) {
      return;
    }
    this.aiCoderDiffBridge.openFromSummary(
      summary,
      (filePath) => this.editCheckpointService.getInitialContent(filePath),
    );
  }

  /**
   * View refresh callback for runOutsideAngular paths.
   * Streaming/tool events are coalesced before entering Angular's zone.
   */
  private _syncDetectChanges: (() => void) | null = null;
  private _syncDetectChangesFrame: number | null = null;
  private _visibleTranscriptItemPatch: ((patch: {
    readonly sessionId: string;
    readonly patches: readonly ChatVisibleTranscriptDialogItemPatch[];
  }) => boolean) | null = null;
  private _visibleResponseRevisionObserved: ((event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly sourceEventType: string;
    readonly sourceGapMs?: number;
  }) => void) | null = null;
  private _submittedRequestPaintObserved: ((event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly checkpointMs: number;
    readonly projectionMs: number;
    readonly projectionToPaintMs: number;
    readonly executionToPaintMs: number;
  }) => void) | null = null;
  private _runtimeRequestStatePatch: ((patch: {
    readonly sessionId: string;
    readonly requestInProgress: boolean;
    readonly activeTurnId: string | null;
    readonly previousActiveTurnId: string | null;
  }) => void) | null = null;

  setSyncDetectChanges(cb: () => void): void {
    this.cancelPendingSyncDetectChanges();
    this._syncDetectChanges = cb;
  }

  setVisibleTranscriptItemPatchCallback(cb: ((patch: {
    readonly sessionId: string;
    readonly patches: readonly ChatVisibleTranscriptDialogItemPatch[];
  }) => boolean) | null): void {
    this._visibleTranscriptItemPatch = cb;
  }

  setVisibleResponseRevisionObservedCallback(cb: ((event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly sourceEventType: string;
    readonly sourceGapMs?: number;
  }) => void) | null): void {
    this._visibleResponseRevisionObserved = cb;
  }

  setSubmittedRequestPaintObservedCallback(cb: ((event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly checkpointMs: number;
    readonly projectionMs: number;
    readonly projectionToPaintMs: number;
    readonly executionToPaintMs: number;
  }) => void) | null): void {
    this._submittedRequestPaintObserved = cb;
  }

  setRuntimeRequestStatePatchCallback(cb: ((patch: {
    readonly sessionId: string;
    readonly requestInProgress: boolean;
    readonly activeTurnId: string | null;
    readonly previousActiveTurnId: string | null;
  }) => void) | null): void {
    this._runtimeRequestStatePatch = cb;
  }

  /**
   * 仅解绑当前 view 关联的引用，不销毁 session runtime。
   * 真正的 runtime dispose 仍由显式 owner 调用 `destroy()`。
   */
  detachView(): void {
    const attachedSessionId = this.resolveCurrentViewSessionResource();
    this.detachSessionRuntimeView(attachedSessionId);
    this.detachVisibleTranscript(attachedSessionId);
    this.chatTextareaRef = null;
    this.viewAdapter.setCdCallback(undefined);
    this.cancelPendingSyncDetectChanges();
    this._syncDetectChanges = null;
    this._submittedRequestPaintObserved = null;
    this._runtimeRequestStatePatch = null;
    this.paneSessionCommandHandlers = {};
  }

  resetVisibleSessionProjection(options: VisibleSessionProjectionResetOptions = {}): void {
    this.interaction.resetApprovalState();
    if (options.clearResolvedActiveModel === true) {
      this.chatService.clearResolvedActiveModel?.();
    }

    const visibleProjectionSessionId = typeof this.visibleProjectionSessionId === 'string'
      ? this.visibleProjectionSessionId.trim()
      : '';
    const resolveCurrentViewSessionResource = (
      (this as unknown as { resolveCurrentViewSessionResource?: ChatEngineService['resolveCurrentViewSessionResource'] }).resolveCurrentViewSessionResource
      ?? ChatEngineService.prototype['resolveCurrentViewSessionResource']
    );
    const resolveActiveRuntimeSessionId = (
      (this as unknown as { resolveActiveRuntimeSessionId?: ChatEngineService['resolveActiveRuntimeSessionId'] }).resolveActiveRuntimeSessionId
      ?? ChatEngineService.prototype['resolveActiveRuntimeSessionId']
    );
    const resetTurnsSessionId = resolveCurrentViewSessionResource.call(this)
      || visibleProjectionSessionId
      || resolveActiveRuntimeSessionId.call(this);
    const detachVisibleTranscript = (
      (this as unknown as { detachVisibleTranscript?: ChatEngineService['detachVisibleTranscript'] }).detachVisibleTranscript
      ?? ChatEngineService.prototype['detachVisibleTranscript']
    );
    detachVisibleTranscript.call(this);
    this.visibleProjectionSessionId = null;
    this.lexStream.resetSessionState();
    this.clearVisibleChatView({ detectChanges: options.detectChanges });

    if (options.clearTurns === true) {
      const replaceSessionModelTurnResponses = (this as unknown as {
        replaceSessionModelTurnResponses?: (
          sessionId: string | null | undefined,
          turnResponses: readonly TurnResponseTurn[] | null | undefined,
          ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
        ) => readonly TurnResponseTurn[] | null;
      }).replaceSessionModelTurnResponses;
      if (resetTurnsSessionId && typeof replaceSessionModelTurnResponses === 'function') {
        replaceSessionModelTurnResponses.call(this, resetTurnsSessionId, [], {
          source: 'visible-session-projection-reset',
        });
      }
      this.lexStream.turns.clear();
    }
    if (options.resetToolCallingIteration === true) {
      this.toolCallingIteration = 0;
    }
    if (options.resetContextBudget === true) {
      this.contextBudgetService?.reset();
    }

    this.scrollManager.setScrollLock(true);
    this.isCompleted = false;
    this.isCancelled = true;

    if (options.clearEditSummary === true) {
      const clearSessionId = typeof this.sessionId === 'string' ? this.sessionId.trim() : '';
      if (clearSessionId) {
        void this.requestHostEditTrackingClearSessionState(clearSessionId).catch((error: unknown) => {
          console.warn('[AilyChat][RuntimeHost] clear edit tracking session state failed:', error);
        });
      }
    }

    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
      this.messageSubscription = null;
    }

    this.activeToolExecutions = 0;
  }

  invalidateHostRequestGraph(): void {
    this.liveHostRequestGraphCache.markDirty();
  }

  private clearVisibleChatView(options: { detectChanges?: boolean } = {}): void {
    this.invalidateHostRequestGraph();
    this.visibleProjectionSessionId = null;
    this.viewAdapter.reset?.();
    this.list = [];
    this.partStore.reset();

    if (options.detectChanges !== false) {
      this.triggerSyncDetectChanges();
    }
  }

  private resolveRuntimeSessionIdForOwner(sessionId?: string | null): string {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (explicitSessionId) {
      return explicitSessionId;
    }

    const resolveActiveRuntimeSessionId = (
      this as unknown as { resolveActiveRuntimeSessionId?: () => string }
    ).resolveActiveRuntimeSessionId;
    if (typeof resolveActiveRuntimeSessionId === 'function') {
      return resolveActiveRuntimeSessionId.call(this);
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : typeof this.sessionId === 'string'
        ? this.sessionId.trim()
        : '';
    if (currentSessionId) {
      return currentSessionId;
    }

    return typeof this.sessionId === 'string'
      ? this.sessionId.trim()
      : '';
  }

  private resolveRuntimeSessionProviderOptions(sessionId?: string | null): HostSessionProviderOptions {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const runtimeProviderOptions = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)?.providerOptions
      : undefined;
    return normalizeHostSessionProviderOptions(runtimeProviderOptions);
  }

  private rememberRuntimeSessionProviderOptions(
    sessionId: string | null | undefined,
    providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
  ): HostSessionProviderOptions | null {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    if (!targetSessionId) {
      return null;
    }

    const normalized = normalizeHostSessionProviderOptions(
      providerOptions,
      this.resolveRuntimeSessionProviderOptions(targetSessionId),
    );
    const patch = {
      providerOptions: normalized,
      debugSummary: {
        providerOptionsPresent: true,
      },
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch,
    });
    return normalized;
  }

  private resolveRuntimeSelectedMode(sessionId?: string | null): ChatSelectedMode {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const runtimeSelectedMode = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)?.selectedMode
      : undefined;
    return normalizeChatSelectedMode(runtimeSelectedMode);
  }

  private rememberRuntimeSelectedMode(
    sessionId: string | null | undefined,
    selectedMode: ChatSelectedMode | null | undefined,
  ): ChatSelectedMode | null {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    if (!targetSessionId || !selectedMode) {
      return null;
    }

    const normalized = normalizeChatSelectedMode(selectedMode);
    const patch = {
      selectedMode: normalized,
      debugSummary: {
        selectedModePresent: true,
      },
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch,
    });
    return normalized;
  }

  private syncVisibleSelectedModeToRuntimeOwner(): void {
    const currentViewSessionId = this.resolveCurrentViewSessionResource();
    if (!currentViewSessionId) {
      return;
    }

    this.rememberRuntimeSelectedMode(
      currentViewSessionId,
      this.chatService.selectedMode ?? { modeId: this.chatService.currentMode },
    );
  }

  private resolveRuntimeResolvedMode(sessionId?: string | null): ChatResolvedMode {
    const selectedMode = this.resolveRuntimeSelectedMode(sessionId);
    const currentResolvedMode = this.chatService.currentResolvedMode;
    if (selectedMode.modeId === currentResolvedMode.kind
      && selectedMode.customAgentTarget === currentResolvedMode.customAgentTarget) {
      return currentResolvedMode;
    }

    return (selectedMode.customAgentTarget
      ? this.chatService.findResolvedModeById?.(selectedMode.customAgentTarget)
      : undefined)
      ?? this.chatService.findResolvedModeById?.(selectedMode.modeId)
      ?? resolveChatCurrentMode(selectedMode);
  }

  private resolveVisibleSessionProviderOptionsSnapshot(sessionId?: string | null): HostSessionProviderOptions {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const runtimeProviderOptions = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)?.providerOptions
      : undefined;
    if (runtimeProviderOptions) {
      return normalizeHostSessionProviderOptions(runtimeProviderOptions);
    }

    const canUseCurrentVisibleSnapshot = !targetSessionId || this.isCurrentVisibleSessionOwner(targetSessionId);
    const currentProviderOptions = canUseCurrentVisibleSnapshot
      ? this.chatService.getCurrentSessionProviderOptions?.()
        ?? {
          folderPath: this.chatService.currentSessionPath || null,
          permissionMode: this.chatService.currentSessionPermissionMode,
          permissionProfile: this.chatService.currentSessionPermissionProfile,
          ...(this.chatService.currentSessionPermissionLevel
            ? { permissionLevel: this.chatService.currentSessionPermissionLevel }
            : {}),
          ...(this.chatService.currentSessionApprovalsReviewer
            ? { approvalsReviewer: this.chatService.currentSessionApprovalsReviewer }
            : {}),
          ...(this.chatService.currentSessionApprovalPolicy
            ? { approvalPolicy: this.chatService.currentSessionApprovalPolicy }
            : {}),
        }
      : null;
    const sessionProviderOptions = targetSessionId
      ? this.chatSessionItemsService?.sessionItemController?.getChatSessionProviderOptions?.(targetSessionId)
      : this.chatSessionItemsService?.sessionItemController?.getChatSessionProviderOptions?.();
    return normalizeHostSessionProviderOptions(sessionProviderOptions, currentProviderOptions);
  }

  private isCurrentVisibleSessionOwner(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId || this.chatService?.hasBlankSessionShell === true) {
      return false;
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (currentSessionId !== targetSessionId) {
      return false;
    }

    return this.resolveCurrentViewSessionResource() === targetSessionId;
  }

  private resolveVisibleSelectedModeSnapshot(sessionId?: string | null): ChatSelectedMode {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const runtimeSelectedMode = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)?.selectedMode
      : undefined;
    if (runtimeSelectedMode) {
      return normalizeChatSelectedMode(runtimeSelectedMode);
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!targetSessionId || targetSessionId === currentSessionId) {
      return normalizeChatSelectedMode(this.chatService.selectedMode ?? { modeId: this.chatService.currentMode });
    }

    const inputState = this.chatSessionItemsService?.sessionItemController?.getChatSessionInputState?.(targetSessionId);
    if (inputState) {
      return resolveHostSessionSelectedModeFromMetadata({
        inputState,
      }, {
        resolveModeById: (modeId) => this.chatService.findResolvedModeById?.(modeId),
        resolveModeByName: (modeName) => this.chatService.findResolvedModeByName?.(modeName),
      });
    }

    return normalizeChatSelectedMode(undefined);
  }

  private resolveVisibleCurrentModelSnapshot(sessionId?: string | null): ChatRuntimeHostModelSelectionSnapshot | null {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const currentServiceSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const resolveCurrentViewSessionResource = (this as unknown as {
      resolveCurrentViewSessionResource?: () => string;
    }).resolveCurrentViewSessionResource;
    const currentViewSessionResource = typeof resolveCurrentViewSessionResource === 'function'
      ? resolveCurrentViewSessionResource.call(this)
      : currentServiceSessionId;
    const currentViewSessionId = typeof currentViewSessionResource === 'string'
      ? currentViewSessionResource.trim()
      : '';
    const isCurrentVisibleRequest = !targetSessionId
      || (!!currentServiceSessionId && targetSessionId === currentServiceSessionId)
      || (!!currentViewSessionId && targetSessionId === currentViewSessionId);
    if (isCurrentVisibleRequest) {
      const currentModel = this.chatService.currentModel;
      return currentModel
        ? { ...(currentModel as unknown as Record<string, unknown>) } as ChatRuntimeHostModelSelectionSnapshot
        : null;
    }

    const runtimeCurrentModel = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)?.currentModel
      : undefined;
    if (runtimeCurrentModel && typeof runtimeCurrentModel === 'object') {
      return { ...(runtimeCurrentModel as Record<string, unknown>) } as ChatRuntimeHostModelSelectionSnapshot;
    }

    return null;
  }

  private resolveVisibleResolvedModeSnapshot(sessionId?: string | null): ChatResolvedMode {
    const selectedMode = this.resolveVisibleSelectedModeSnapshot(sessionId);
    const currentResolvedMode = this.chatService.currentResolvedMode;
    if (selectedMode.modeId === currentResolvedMode.kind
      && selectedMode.customAgentTarget === currentResolvedMode.customAgentTarget) {
      return currentResolvedMode;
    }

    return (selectedMode.customAgentTarget
      ? this.chatService.findResolvedModeById?.(selectedMode.customAgentTarget)
      : undefined)
      ?? this.chatService.findResolvedModeById?.(selectedMode.modeId)
      ?? resolveChatCurrentMode(selectedMode);
  }

  private resolveExecutionSnapshotResolvedMode(snapshot: HostSubmitExecutionSnapshot): ChatResolvedMode {
    const selectedMode = snapshot.selectedMode;
    const currentResolvedMode = this.chatService.currentResolvedMode;
    if (selectedMode.modeId === currentResolvedMode.kind
      && selectedMode.customAgentTarget === currentResolvedMode.customAgentTarget) {
      return currentResolvedMode;
    }

    return (selectedMode.customAgentTarget
      ? this.chatService.findResolvedModeById?.(selectedMode.customAgentTarget)
      : undefined)
      ?? this.chatService.findResolvedModeById?.(selectedMode.modeId)
      ?? resolveChatCurrentMode(selectedMode);
  }

  private withSubmitExecutionSnapshotMetadata(
    metadata: TurnRequest['metadata'] | null | undefined,
    snapshot?: HostSubmitExecutionSnapshot | null,
  ): TurnRequest['metadata'] | undefined {
    if (!snapshot) {
      return metadata ?? undefined;
    }

    const selectedMode = snapshot.selectedMode;
    const providerOptions = snapshot.providerOptions;
    const resolvedMode = this.resolveExecutionSnapshotResolvedMode(snapshot);
    const modeInfo = createTurnRequestModeInfoFromResolvedMode(resolvedMode);
    const requestRouting = buildHostSessionCurrentPickerRoutingSummary(
      selectedMode,
      undefined,
      providerOptions.permissionLevel,
      providerOptions.approvalsReviewer,
      providerOptions.approvalPolicy,
    );

    return {
      ...(metadata ?? {}),
      modeId: selectedMode.modeId,
      modeInfo: {
        ...modeInfo,
        ...(providerOptions.permissionLevel ? { permissionLevel: providerOptions.permissionLevel } : {}),
        ...(providerOptions.approvalsReviewer ? { approvalsReviewer: providerOptions.approvalsReviewer } : {}),
        ...(providerOptions.approvalPolicy ? { approvalPolicy: providerOptions.approvalPolicy } : {}),
      },
      requestRouting: {
        ...requestRouting,
        modeId: selectedMode.modeId,
        ...(selectedMode.customAgentTarget ? { customAgentTarget: selectedMode.customAgentTarget } : {}),
      },
    } as TurnRequest['metadata'];
  }

  private buildExecutionSaveTarget(sessionId?: string | null): HostSessionSaveTarget | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return null;
    }

    const providerOptions = this.resolveVisibleSessionProviderOptionsSnapshot(targetSessionId);
    const selectedMode = this.resolveVisibleSelectedModeSnapshot(targetSessionId);
    const resolvedMode = this.resolveVisibleResolvedModeSnapshot(targetSessionId);
    const projectPathHint = providerOptions.folderPath ?? null;
    const sessionEntry = (this.chatHistoryService as unknown as {
      findEntry?: (sessionId: string, projectPathHint?: string | null) => { title?: string } | null | undefined;
    }).findEntry?.(targetSessionId, projectPathHint)
      ?? (this.chatHistoryService as unknown as {
        findEntry?: (sessionId: string, projectPathHint?: string | null) => { title?: string } | null | undefined;
      }).findEntry?.(targetSessionId);

    const persistedTitle = normalizeChatSessionTitleText(sessionEntry?.title);
    const isCurrentVisibleSession = this.isCurrentVisibleSessionOwner(targetSessionId);
    const fallbackTitle = isCurrentVisibleSession
      ? normalizeChatSessionTitleText(this.sessionTitle || this.chatService.currentSessionTitle || '')
      : '';
    const currentTitleCandidate = isCurrentVisibleSession
      ? (typeof this.chatService.readCurrentSessionTitleCandidate === 'function'
        ? this.chatService.readCurrentSessionTitleCandidate()
        : normalizeChatSessionTitleCandidate({
          text: this.chatService.currentSessionTitle,
          source: this.chatService.currentSessionTitleSource,
          revision: this.chatService.currentSessionTitleRevision,
        }))
      : normalizeChatSessionTitleCandidate(undefined);
    const sessionTitleCandidate = normalizeChatSessionTitleCandidate({
      text: persistedTitle || fallbackTitle,
      source: persistedTitle ? 'restored-custom' : currentTitleCandidate.source,
      revision: currentTitleCandidate.revision,
    });
    const sessionType = this.chatSessionItemsService.sessionItemController.getChatSessionType?.(targetSessionId, projectPathHint)
      ?? this.chatService.currentSessionType;

    return {
      sessionId: targetSessionId,
      sessionTitleCandidate,
      sessionType,
      providerOptions,
      selectedMode,
      resolvedMode,
      model: this.resolveVisibleCurrentModelSnapshot(targetSessionId),
    };
  }

  private withHostRuntimeSessionInventoryMetadata(
    sessionId: string | null | undefined,
    metadata: TurnRequest['metadata'] | null | undefined,
    runtimeResolution?: ChatAgentRuntimeModeResolution | null,
    executionSnapshot?: HostSubmitExecutionSnapshot | null,
  ): TurnRequest['metadata'] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const baseMetadata = metadata && typeof metadata === 'object'
      ? { ...metadata }
      : {};
    if (!normalizedSessionId) {
      return baseMetadata;
    }

    const saveTarget = this.buildExecutionSaveTarget(normalizedSessionId);
    if (!saveTarget) {
      return baseMetadata;
    }
    const selectedMode = executionSnapshot?.selectedMode ?? saveTarget.selectedMode;
    const providerOptions = executionSnapshot?.providerOptions ?? saveTarget.providerOptions;

    const title = normalizeChatSessionTitleText(
      saveTarget.sessionTitleCandidate?.text
      || saveTarget.sessionTitle
      || '',
    );
    const runtimeTruth = buildHostSessionTurnRuntimeTruth({
      chatMode: selectedMode.modeId,
      runtimeMode: runtimeResolution?.mode ?? this.chatService.currentAgentRuntimeMode,
      runtimeSource: runtimeResolution?.source ?? this.chatService.currentAgentRuntimeModeSource,
      agentRole: 'main',
      permissionMode: selectedMode.modeId === 'plan' ? 'plan' : providerOptions.permissionMode,
      projectPath: providerOptions.folderPath ?? null,
    });
    if (runtimeTruth) {
      console.info(
        '[AilyChat][HostSubmitRuntimeTruth]',
        [
          `session=${normalizedSessionId}`,
          `chatMode=${runtimeTruth.chatMode ?? ''}`,
          `runtimeMode=${runtimeTruth.runtimeMode ?? ''}`,
          `runtimeSource=${runtimeTruth.runtimeSource ?? ''}`,
          `agentRole=${runtimeTruth.agentRole ?? ''}`,
          `permissionMode=${runtimeTruth.permissionMode ?? ''}`,
          `permissionLevel=${providerOptions.permissionLevel ?? ''}`,
          `approvalsReviewer=${providerOptions.approvalsReviewer ?? ''}`,
          `approvalPolicy=${providerOptions.approvalPolicy ?? ''}`,
          `projectPath=${runtimeTruth.projectPath ?? ''}`,
        ].join(' '),
      );
    }
    return {
      ...baseMetadata,
      ...(runtimeTruth ? { runtimeTruth } : {}),
      hostSessionInventory: {
        ...(baseMetadata['hostSessionInventory'] && typeof baseMetadata['hostSessionInventory'] === 'object'
          ? baseMetadata['hostSessionInventory'] as Record<string, unknown>
          : {}),
        ...(title ? { title } : {}),
        ...(saveTarget.sessionTitleCandidate?.source ? { titleSource: saveTarget.sessionTitleCandidate.source } : {}),
        titleDurable: saveTarget.sessionTitleCandidate?.source !== 'empty',
        sessionType: saveTarget.sessionType,
        projectPath: providerOptions.folderPath ?? null,
        mode: selectedMode.modeId,
      },
    } as TurnRequest['metadata'];
  }

  private resolveSubmitRuntimeMode(
    sessionId: string | null | undefined,
    providerOptions: HostSessionProviderOptions,
    metadata: TurnRequest['metadata'] | null | undefined,
  ): ChatAgentRuntimeModeResolution {
    const projectPath = providerOptions.folderPath ?? null;
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeState = targetSessionId
      ? this.chatSessionRuntimeStore?.read?.(targetSessionId)
      : undefined;
    const storedRuntimeMode = normalizeChatAgentRuntimeMode(runtimeState?.agentRuntimeMode, 'unbound');
    const visibleSessionId = this.resolveCurrentViewSessionResource();
    const visibleRuntimeMode = targetSessionId && targetSessionId === visibleSessionId
      ? normalizeChatAgentRuntimeMode(this.chatService.currentAgentRuntimeMode, 'unbound')
      : 'unbound';
    const resolvedSnapshotMode = storedRuntimeMode !== 'unbound'
      ? storedRuntimeMode
      : visibleRuntimeMode;
    const resolution: ChatAgentRuntimeModeResolution = resolvedSnapshotMode !== 'unbound'
      ? {
          mode: resolvedSnapshotMode,
          source: storedRuntimeMode !== 'unbound'
            ? normalizeChatAgentRuntimeModeSource(runtimeState?.agentRuntimeModeSource, 'restored')
            : normalizeChatAgentRuntimeModeSource(this.chatService.currentAgentRuntimeModeSource, 'restored'),
          reason: 'session runtime snapshot',
          projectPath,
        }
      : resolveChatAgentRuntimeModeForProject({
          projectPath,
          metadata: metadata as any,
          userPreferenceMode: this.configService?.getPreferredChatAgentRuntimeMode?.(),
          fallback: projectPath ? 'coder' : 'unbound',
          requireExistingProjectPath: false,
        });
    if (
      this.chatService.currentAgentRuntimeMode !== resolution.mode
      || this.chatService.currentAgentRuntimeModeSource !== resolution.source
    ) {
      if (typeof this.chatService.setCurrentAgentRuntimeMode === 'function') {
        this.chatService.setCurrentAgentRuntimeMode(resolution.mode, resolution.source);
      } else {
        this.chatService.currentAgentRuntimeMode = resolution.mode;
        this.chatService.currentAgentRuntimeModeSource = resolution.source;
      }
      this.syncCurrentSessionEntryTargetRuntimeMode(sessionId);
    }
    console.info('[AilyChat][HostSubmitRuntimeResolve]', {
      sessionId: typeof sessionId === 'string' ? sessionId.trim() : null,
      mode: resolution.mode,
      source: resolution.source,
      reason: resolution.reason,
      projectPath: resolution.projectPath,
    });
    return resolution;
  }

  private readSessionTurnResponses(
    sessionId: string,
  ): readonly TurnResponseTurn[] {
    return readSessionModelTurnResponses(this.chatSessionModelStore, sessionId);
  }

  private resolveActiveRuntimeSessionId(): string {
    if (this.runtimeSessionOwnerOverride) {
      return this.runtimeSessionOwnerOverride;
    }

    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (currentSessionId) {
      return currentSessionId;
    }

    return typeof this.sessionId === 'string'
      ? this.sessionId.trim()
      : '';
  }

  private createRuntimeScopedContextBudgetService(): ContextBudgetService {
    const engine = this;
    const scoped = {
      getSnapshot(): ContextBudgetSnapshot {
        const sessionId = engine.resolveActiveRuntimeSessionId();
        return engine.chatSessionRuntimeStore.read(sessionId)?.viewOverlay?.contextBudgetSnapshot
          ?? engine.contextBudgetService.getSnapshot();
      },
      get budget$() {
        return engine.contextBudgetService.budget$;
      },
      get maxContextTokens() {
        return engine.contextBudgetService.maxContextTokens;
      },
      set maxContextTokens(value: number) {
        engine.contextBudgetService.maxContextTokens = value;
      },
      get compressionThreshold() {
        return engine.contextBudgetService.compressionThreshold;
      },
      get summarizationThreshold() {
        return engine.contextBudgetService.summarizationThreshold;
      },
      updateModelContextSize(model: Parameters<ContextBudgetService['updateModelContextSize']>[0]): void {
        const sessionId = engine.resolveActiveRuntimeSessionId();
        if (engine.shouldProjectRuntimeViewStateToVisibleOwner(sessionId)) {
          engine.contextBudgetService.updateModelContextSize(model);
          engine.syncRuntimeViewOverlayFromVisibleServices(sessionId);
        }
      },
      refreshLocalEstimate(
        messages: Parameters<ContextBudgetService['refreshLocalEstimate']>[0],
        tools?: Parameters<ContextBudgetService['refreshLocalEstimate']>[1],
      ): void {
        const sessionId = engine.resolveActiveRuntimeSessionId();
        if (engine.shouldProjectRuntimeViewStateToVisibleOwner(sessionId)) {
          engine.contextBudgetService.refreshLocalEstimate(messages, tools);
          engine.syncRuntimeViewOverlayFromVisibleServices(sessionId);
        }
      },
      applyLexBudgetEvent(
        maxTokens: number,
        usedTokens: number,
        extra?: LexContextBudgetSnapshotExtra,
      ): void {
        const sessionId = engine.resolveActiveRuntimeSessionId();
        const snapshot = createLexContextBudgetSnapshot({
          maxTokens,
          usedTokens,
          fallbackCompressionThreshold: engine.contextBudgetService.compressionThreshold,
          fallbackSummarizationThreshold: engine.contextBudgetService.summarizationThreshold,
          extra,
        });
        engine.syncRuntimeViewOverlay(sessionId, {
          contextBudgetSnapshot: snapshot,
          chatInputNotice: engine.chatInputNoticeStateService.getInputNotice(),
          updatedAt: Date.now(),
        });

        if (engine.shouldProjectRuntimeViewStateToVisibleOwner(sessionId)) {
          engine.contextBudgetService.applyLexBudgetEvent(maxTokens, usedTokens, extra);
          engine.syncRuntimeViewOverlayFromVisibleServices(sessionId);
        }
      },
      reset(): void {
        const sessionId = engine.resolveActiveRuntimeSessionId();
        if (engine.shouldProjectRuntimeViewStateToVisibleOwner(sessionId)) {
          engine.contextBudgetService.reset();
          engine.syncRuntimeViewOverlayFromVisibleServices(sessionId);
          return;
        }

        engine.syncRuntimeViewOverlay(sessionId, null);
      },
    };

    return scoped as unknown as ContextBudgetService;
  }

  private readVisibleSessionRequestInProgress(sessionId?: string | null): boolean {
    const explicitSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const targetSessionId = explicitSessionId || currentSessionId;
    if (!targetSessionId) {
      return false;
    }

    return this.stoppingRuntimeSessionIds.has(targetSessionId)
      || this.readRuntimeHostSessionState(targetSessionId)?.requestInProgress === true;
  }

  private readPendingFollowupYieldRequested(sessionId?: string | null): boolean {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!targetSessionId) {
      return false;
    }

    const hasSteeringPending = this.getPendingFollowupRequests(targetSessionId)
      .some(request => request.kind === 'steering');
    if (!hasSteeringPending) {
      return false;
    }

    return this.readVisibleSessionRequestInProgress(targetSessionId);
  }

  getPendingFollowupRequests(sessionId?: string | null): readonly PendingFollowupRequest[] {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!targetSessionId) {
      return [];
    }

    return this.readPendingFollowupQueue(targetSessionId);
  }

  private readPendingFollowupQueue(sessionId: string): readonly PendingFollowupRequest[] {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return targetSessionId ? this.pendingFollowupQueue.read(targetSessionId) : [];
  }

  private replacePendingFollowupQueue(
    sessionId: string,
    requests: readonly PendingFollowupRequest[] | null | undefined,
  ): readonly PendingFollowupRequest[] {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return targetSessionId ? this.pendingFollowupQueue.replace(targetSessionId, requests) : [];
  }

  private enqueuePendingFollowupQueue(
    sessionId: string,
    request: PendingFollowupRequest,
  ): readonly PendingFollowupRequest[] {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return targetSessionId ? this.pendingFollowupQueue.enqueue(targetSessionId, request) : [];
  }

  private removePendingFollowupQueueRequest(sessionId: string, requestId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    return targetSessionId && normalizedRequestId
      ? this.pendingFollowupQueue.remove(targetSessionId, normalizedRequestId)
      : false;
  }

  private getPendingFollowupQueueSessionIds(): readonly string[] {
    return this.pendingFollowupQueue.sessionIds();
  }

  hasPendingFollowupRequests(sessionId?: string | null): boolean {
    return this.getPendingFollowupRequests(sessionId).length > 0;
  }

  getSessionActionState(sessionId?: string | null): ChatSessionActionState {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetSessionId = explicitSessionId || this.resolveCurrentViewSessionResource();
    const draftTextValue = targetSessionId
      ? this.readSessionInputValue(targetSessionId)
      : this.legacyInputValue;
    const draftText = (draftTextValue ?? '').trim();
    const draftState = draftText.length > 0 ? 'hasDraft' as const : 'empty' as const;
    const pendingRequests = targetSessionId ? this.getPendingFollowupRequests(targetSessionId) : [];
    const steeringCount = pendingRequests.filter(request => request.kind === 'steering').length;
    const runtimeState = targetSessionId ? this.readRuntimeHostSessionState(targetSessionId) : null;
    const hasActiveRequest = targetSessionId ? this.readVisibleSessionRequestInProgress(targetSessionId) : false;

    let activeState: ChatSessionActionState['activeState'] = 'idle';
    if (runtimeState?.status === 'needs_input') {
      activeState = 'needsInput';
    } else if (hasActiveRequest) {
      activeState = this.isCancelled && targetSessionId === this.resolveActiveRuntimeSessionId()
        ? 'stopping'
        : 'running';
    }

    const canStop = activeState === 'running' || activeState === 'stopping';
    const canSend = draftState === 'hasDraft' && activeState === 'idle';
    const canQueue = draftState === 'hasDraft' && (activeState === 'running' || activeState === 'stopping');
    const primaryIcon = canStop ? 'stop' : 'send';

    return createChatSessionActionState({
      activeState,
      draftState,
      pendingCount: pendingRequests.length,
      steeringCount,
      canSend,
      canQueue,
      canStop,
      canSteer: canQueue,
      primaryIcon,
      secondaryIcon: null,
      tooltip: canStop
        ? 'Stop session'
        : canSend
          ? 'Send message'
          : 'Type a message to send',
    });
  }

  setPendingFollowupRequests(
    sessionId: string | null | undefined,
    requests: readonly { requestId: string; kind: ChatPendingRequestKind }[],
  ): readonly PendingFollowupRequest[] {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!targetSessionId) {
      return [];
    }

    const existingQueue = this.readPendingFollowupQueue(targetSessionId);
    const existingMap = new Map<string, PendingFollowupRequest>(
      existingQueue.map(request => [request.id, request]),
    );
    const nextQueue: PendingFollowupRequest[] = [];

    for (const request of requests) {
      const requestId = typeof request?.requestId === 'string' ? request.requestId.trim() : '';
      if (!requestId) {
        continue;
      }

      const existing = existingMap.get(requestId);
      if (!existing) {
        continue;
      }

      const nextRequest = existing.kind === request.kind
        ? existing
        : { ...existing, kind: request.kind };
      nextQueue.push(clonePendingFollowupRequest(nextRequest));
    }

    const replacedQueue = this.replacePendingFollowupQueue(targetSessionId, nextQueue);
    this.syncPendingFollowupRuntimeState(targetSessionId);

    return replacedQueue.map(request => clonePendingFollowupRequest(request));
  }

  removePendingFollowupRequest(sessionId: string | null | undefined, requestId: string): boolean {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!targetSessionId || !normalizedRequestId) {
      return false;
    }

    const removed = this.removePendingFollowupQueueRequest(targetSessionId, normalizedRequestId);
    if (!removed) {
      return false;
    }

    this.syncPendingFollowupRuntimeState(targetSessionId);

    return true;
  }

  clearPendingFollowupRequests(sessionId?: string | null): void {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!targetSessionId) {
      return;
    }

    this.replacePendingFollowupQueue(targetSessionId, []);
    this.syncPendingFollowupRuntimeState(targetSessionId);
  }

  async sendPendingFollowupImmediately(sessionId: string | null | undefined, requestId: string): Promise<boolean> {
    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!targetSessionId || !normalizedRequestId) {
      return false;
    }

    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    const pendingRequests = this.getPendingFollowupRequests(targetSessionId);
    const targetIndex = pendingRequests.findIndex(request => request.id === normalizedRequestId);
    if (targetIndex === -1) {
      return false;
    }

    const targetRequest = pendingRequests[targetIndex];
    this.setPendingFollowupRequests(targetSessionId, [
      { requestId: targetRequest.id, kind: targetRequest.kind },
      ...pendingRequests.filter((_, index) => index !== targetIndex).map(request => ({
        requestId: request.id,
        kind: request.kind,
      })),
    ]);

    const requestInProgress = this.readVisibleSessionRequestInProgress(targetSessionId);
    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RequestStateTrace]', {
        phase: 'runNext',
        action: 'run-next',
        sessionId: targetSessionId,
        requestId: targetRequest.id,
        state: runtimeState?.status ?? (requestInProgress ? 'running' : 'idle'),
        pendingCount: pendingRequests.length,
        queueKind: targetRequest.kind,
        interruptingActiveRequest: requestInProgress,
      });
    }

    if (requestInProgress) {
      const schedulePendingFollowupFlushAfterSettle = (
        (this as unknown as { schedulePendingFollowupFlushAfterSettle?: ChatEngineService['schedulePendingFollowupFlushAfterSettle'] })
          .schedulePendingFollowupFlushAfterSettle
        ?? ChatEngineService.prototype['schedulePendingFollowupFlushAfterSettle']
      );
      const clearPendingFollowupFlushAfterSettle = (
        (this as unknown as { clearPendingFollowupFlushAfterSettle?: ChatEngineService['clearPendingFollowupFlushAfterSettle'] })
          .clearPendingFollowupFlushAfterSettle
        ?? ChatEngineService.prototype['clearPendingFollowupFlushAfterSettle']
      );
      schedulePendingFollowupFlushAfterSettle.call(this, targetSessionId);
      const stopped = this.requestStopRuntimeTurn(targetSessionId);
      if (!stopped) {
        clearPendingFollowupFlushAfterSettle.call(this, targetSessionId);
      }
      return stopped;
    }

    return this.processPendingFollowupRequests(targetSessionId);
  }

  private schedulePendingFollowupFlushAfterSettle(sessionId: string | null | undefined): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const flushAfterSettleSessionIds = (this as unknown as {
      pendingFollowupFlushAfterSettleSessionIds?: Set<string>;
    }).pendingFollowupFlushAfterSettleSessionIds;
    if (flushAfterSettleSessionIds) {
      flushAfterSettleSessionIds.add(targetSessionId);
    }
  }

  private clearPendingFollowupFlushAfterSettle(sessionId: string | null | undefined): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    (this as unknown as {
      pendingFollowupFlushAfterSettleSessionIds?: Set<string>;
    }).pendingFollowupFlushAfterSettleSessionIds?.delete(targetSessionId);
  }

  private maybeFlushPendingFollowupAfterSettle(
    sessionId: string,
    state: ChatRuntimeHostSessionState,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || state.requestInProgress === true) {
      return;
    }

    const flushAfterSettleSessionIds = (this as unknown as {
      pendingFollowupFlushAfterSettleSessionIds?: Set<string>;
    }).pendingFollowupFlushAfterSettleSessionIds;
    if (!flushAfterSettleSessionIds?.delete(targetSessionId)) {
      return;
    }

    if (this.getPendingFollowupRequests(targetSessionId).length === 0) {
      return;
    }

    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RequestStateTrace]', {
        phase: 'runNext',
        action: 'flush-after-settle',
        sessionId: targetSessionId,
        state: state.status ?? 'idle',
      });
    }

    queueMicrotask(() => {
      void this.processPendingFollowupRequests(targetSessionId);
    });
  }

  queueFollowupMessage(
    content: string,
    sessionId?: string | null,
    options?: { kind?: ChatPendingRequestKind },
  ): boolean {
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    if (!normalizedContent) {
      return false;
    }

    const targetSessionId = resolveOptionalUiSessionOwner(this, sessionId);
    if (!targetSessionId) {
      return false;
    }

    const kind: ChatPendingRequestKind = options?.kind === 'steering' ? 'steering' : 'queued';
    const prepared = this.sendCoordinator.capturePendingSend(normalizedContent, targetSessionId);
    if (!prepared) {
      return false;
    }

    const pendingRequest: PendingFollowupRequest = {
      id: `pending-followup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: normalizedContent,
      kind,
      prepared: clonePreparedPendingFollowupRequest(prepared),
    };
    const queue = this.enqueuePendingFollowupQueue(targetSessionId, pendingRequest);
    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RequestStateTrace]', {
        phase: 'queue',
        action: 'queue',
        sessionId: targetSessionId,
        requestId: readPreparedPendingFollowupRequestId(prepared),
        state: runtimeState?.status
          ?? (this.readVisibleSessionRequestInProgress(targetSessionId) ? 'running' : 'idle'),
        queueKind: kind,
        pendingCount: queue.length,
        textLength: normalizedContent.length,
      });
    }
    this.syncPendingFollowupRuntimeState(targetSessionId);
    this.pendingEditFeedback = null;

    const currentViewSessionId = resolveOptionalUiSessionOwner(this, null);
    if (currentViewSessionId === targetSessionId) {
      this.setSessionInputValue(targetSessionId, '');
      this.triggerSyncDetectChanges();
    }

    return true;
  }

  private async processPendingFollowupRequests(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    if (!targetSessionId) {
      return false;
    }

    if (this.readVisibleSessionRequestInProgress(targetSessionId)) {
      return false;
    }

    if (runtimeState?.status === 'needs_input') {
      return false;
    }

    const readiness = await this.readRuntimeHostSubmitReadiness(targetSessionId);
    if (!readiness.canSubmit) {
      return false;
    }

    const queue = [...this.readPendingFollowupQueue(targetSessionId)];
    if (!queue?.length) {
      return false;
    }

    const pendingCountBeforeDequeue = queue.length;
    const nextRequests: PendingFollowupRequest[] = [];
    if (queue[0].kind === 'steering') {
      for (const request of queue) {
        if (request.kind !== 'steering') {
          break;
        }
        nextRequests.push(request);
      }
    } else {
      nextRequests.push(queue[0]);
    }
    if (!nextRequests.length) {
      return false;
    }

    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RequestStateTrace]', {
        phase: 'processingQueued',
        action: 'flush',
        sessionId: targetSessionId,
        requestId: nextRequests.length === 1 ? readPreparedPendingFollowupRequestId(nextRequests[0].prepared) : null,
        state: runtimeState?.status ?? 'idle',
        pendingCount: pendingCountBeforeDequeue,
        nextRequestCount: nextRequests.length,
        nextRequestKinds: nextRequests.map(request => request.kind),
        nextRequestIds: nextRequests.map(request => readPreparedPendingFollowupRequestId(request.prepared)),
      });
    }

    queue.splice(0, nextRequests.length);
    this.replacePendingFollowupQueue(targetSessionId, queue);
    this.syncPendingFollowupRuntimeState(targetSessionId);

    try {
      await this.sendPendingFollowupRequest(targetSessionId, nextRequests);
    } catch (error) {
      console.warn('[AilyChat][Queue] follow-up flush failed:', error);
      return false;
    }

    return true;
  }

  private async processRunnablePendingFollowupRequests(excludeSessionId?: string | null): Promise<boolean> {
    const queuedSessionIds = this.getPendingFollowupQueueSessionIds();
    if (queuedSessionIds.length === 0) {
      return false;
    }

    const excludedSessionId = typeof excludeSessionId === 'string' ? excludeSessionId.trim() : '';
    let processed = false;
    for (const sessionId of queuedSessionIds) {
      const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!targetSessionId || targetSessionId === excludedSessionId) {
        continue;
      }

      if (this.readVisibleSessionRequestInProgress(targetSessionId)) {
        continue;
      }

      const readiness = await this.readRuntimeHostSubmitReadiness(targetSessionId);
      if (!readiness.canSubmit) {
        continue;
      }

      processed = (await this.processPendingFollowupRequests(targetSessionId)) || processed;
    }

    return processed;
  }

  private syncPendingFollowupRuntimeState(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    this.pendingFollowupQueue.projectRuntimeState(targetSessionId, {
      yieldRequested: this.readPendingFollowupYieldRequested(targetSessionId),
    });
  }

  private projectRestoredRuntimeAuxiliary(
    sessionId: string,
    auxiliary: {
      pendingFollowupRequests?: readonly PendingFollowupRequest[];
      yieldRequested?: boolean;
    } | null | undefined,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const pendingFollowupRequests = Array.isArray(auxiliary?.pendingFollowupRequests)
      && auxiliary.pendingFollowupRequests.length > 0
      ? (globalThis.structuredClone
        ? globalThis.structuredClone(auxiliary.pendingFollowupRequests)
        : JSON.parse(JSON.stringify(auxiliary.pendingFollowupRequests))) as readonly PendingFollowupRequest[]
      : null;
    this.pendingFollowupQueue.replace(targetSessionId, pendingFollowupRequests ?? []);
    this.pendingFollowupQueue.projectRuntimeState(targetSessionId, {
      yieldRequested: auxiliary?.yieldRequested === true,
    });
  }

  private async sendPendingFollowupRequest(
    sessionId: string,
    requests: readonly PendingFollowupRequest[],
  ): Promise<void> {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId || requests.length === 0) {
      return;
    }

    const prepared = mergePreparedPendingFollowupRequests(requests);
    const runtimeOwnerSessionId = typeof prepared.runtimeOwnerSessionId === 'string' && prepared.runtimeOwnerSessionId.trim().length > 0
      ? prepared.runtimeOwnerSessionId.trim()
      : normalizedSessionId;

    await this.runWithRuntimeSessionOwner(runtimeOwnerSessionId, async () => {
      await this.executePreparedUserSend(runtimeOwnerSessionId, prepared, {
        clearInput: false,
        resetPreparedUserTurnState: true,
      });
    });
  }

  private syncRuntimeViewOverlayFromVisibleServices(sessionId?: string | null): ChatSessionRuntimeViewOverlay | null {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return null;
    }

    const contextBudgetSnapshot = this.contextBudgetViewService?.getSnapshot() ?? null;
    const chatInputNotice = this.chatInputNoticeStateService?.getInputNotice() ?? null;
    const isMeaningfulContextBudgetSnapshot = (
      this as unknown as { isMeaningfulContextBudgetSnapshot?: (snapshot: ContextBudgetSnapshot | null | undefined) => snapshot is ContextBudgetSnapshot }
    ).isMeaningfulContextBudgetSnapshot
      ?? ChatEngineService.prototype['isMeaningfulContextBudgetSnapshot'];
    const hasContextBudget = isMeaningfulContextBudgetSnapshot.call(this, contextBudgetSnapshot);
    const overlay = hasContextBudget || !!chatInputNotice
      ? {
          ...(hasContextBudget ? { contextBudgetSnapshot } : {}),
          ...(chatInputNotice ? { chatInputNotice } : {}),
          updatedAt: Date.now(),
        } satisfies ChatSessionRuntimeViewOverlay
      : null;
    const syncRuntimeViewOverlay = (
      this as unknown as {
        syncRuntimeViewOverlay?: (
          sessionId: string | null | undefined,
          overlay: ChatSessionRuntimeViewOverlay | null,
        ) => ChatSessionRuntimeViewOverlay | null;
      }
    ).syncRuntimeViewOverlay
      ?? ChatEngineService.prototype['syncRuntimeViewOverlay'];
    return syncRuntimeViewOverlay.call(this, targetSessionId, overlay);
  }

  private syncRuntimeViewOverlay(
    sessionId: string | null | undefined,
    overlay: ChatSessionRuntimeViewOverlay | null,
  ): ChatSessionRuntimeViewOverlay | null {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return null;
    }

    const patch = {
      viewOverlay: overlay,
      debugSummary: {
        contextBudgetOverlayPresent: !!overlay?.contextBudgetSnapshot,
        inputNoticeOverlayPresent: !!overlay?.chatInputNotice,
      },
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch,
    });
    return overlay;
  }

  private projectRuntimeViewOverlayToVisibleServices(
    runtimeState: ChatSessionRuntimeState | null | undefined,
  ): void {
    if (!runtimeState?.viewOverlay) {
      this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(null);
      return;
    }

    const contextBudgetSnapshot = runtimeState.viewOverlay.contextBudgetSnapshot;
    if (contextBudgetSnapshot) {
      this.contextBudgetViewService.applySnapshot(contextBudgetSnapshot);
    }

    this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(
      runtimeState.viewOverlay.chatInputNotice ?? null,
    );
  }

  private shouldProjectRuntimeViewStateToVisibleOwner(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return true;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (!currentViewSessionResource || currentViewSessionResource !== targetSessionId) {
      return false;
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!currentSessionId || currentSessionId !== targetSessionId) {
      return false;
    }

    const visibleProjectionSessionId = (this as unknown as { visibleProjectionSessionId?: string | null }).visibleProjectionSessionId;
    if (typeof visibleProjectionSessionId === 'string' && visibleProjectionSessionId.trim() !== targetSessionId) {
      return false;
    }

    const runtimeState = this.chatSessionRuntimeStore?.read?.(targetSessionId);
    return runtimeState?.attachedView !== false;
  }

  private async readRuntimeHostSubmitReadiness(sessionId: string): Promise<ChatRuntimeHostSubmitReadiness> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      throw new Error('[AilyChat][RuntimeHost] Submit readiness requires a session id.');
    }

    return this.runtimeHostForView().readSubmitReadiness(targetSessionId);
  }

  private isMeaningfulContextBudgetSnapshot(snapshot: ContextBudgetSnapshot | null | undefined): snapshot is ContextBudgetSnapshot {
    return !!snapshot
      && (
        snapshot.currentTokens > 0
        || snapshot.messageCount > 0
        || snapshot.systemTokens > 0
        || snapshot.toolsTokens > 0
        || snapshot.messagesTokens > 0
        || snapshot.toolResultsTokens > 0
      );
  }

  private syncExecutionRuntimeState(saveTarget?: HostSessionSaveTarget | null): void {
    const sessionId = typeof saveTarget?.sessionId === 'string'
      ? saveTarget.sessionId.trim()
      : '';
    if (!sessionId) {
      return;
    }

    const runtimeCapabilities = resolveEngineRuntimeSessionCapabilities(this as unknown as Record<string, unknown>, sessionId);
    const runtimeConcurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      sessionId,
    );
    const titleCandidate = normalizeChatSessionTitleCandidate(
      saveTarget?.sessionTitleCandidate ?? {
        text: saveTarget?.sessionTitle,
        source: saveTarget?.sessionTitleSource,
        revision: saveTarget?.sessionTitleRevision,
      },
    );

    const runtimeStatePatch = {
      turnResponses: Array.isArray(saveTarget?.turnResponses)
        ? saveTarget.turnResponses
        : undefined,
      hostProjectionState: buildRuntimeHostProjectionState(saveTarget?.turnResponses),
      status: null,
      requestInProgress: false,
      yieldRequested: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      capabilities: runtimeCapabilities,
      ...(runtimeConcurrencyScope ? { concurrencyScope: runtimeConcurrencyScope } : {}),
      debugSummary: {
        liveRuntimeOverlayPresent: Array.isArray(saveTarget?.turnResponses) && saveTarget.turnResponses.length > 0,
        pendingRequest: false,
        needsInput: false,
        attachedView: false,
        ...(titleCandidate.text ? { title: titleCandidate.text } : {}),
        ...(titleCandidate.text && titleCandidate.source !== 'empty' ? { titleSource: titleCandidate.source } : {}),
        ...(titleCandidate.text ? { titleRevision: titleCandidate.revision } : {}),
      },
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId,
      patch: runtimeStatePatch,
    });
  }

  private syncExecutionRuntimeTurnResponses(
    sessionId?: string | null,
    turnResponses?: readonly TurnResponseTurn[] | null,
    options?: ChatRuntimeTurnResponseSyncOptions,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return;
    }

    let hostProjectionState: HostTurnResponseState | null = null;
    try {
      hostProjectionState = buildRuntimeHostProjectionState(turnResponses);
    } catch (error) {
      console.warn('[AilyChat][Send] Failed to derive runtime projection from canonical turn responses:', error);
    }
    const runtimeCapabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const runtimeConcurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (!options) {
      console.warn('[AilyChat][SyncRuntime][missing-projection-options]', { targetSessionId });
      return;
    }

    const projectionOptions = options;
    this.projectModelTranscriptToRuntimeMirror(targetSessionId, turnResponses, hostProjectionState, {
      attachedView: currentViewSessionResource === targetSessionId,
      projection: projectionOptions,
    });

    this.chatRuntimeViewMirrorProjection.syncTurnResponses({
      sessionId: targetSessionId,
      turnResponses,
      hostProjectionState,
      capabilities: runtimeCapabilities,
      concurrencyScope: runtimeConcurrencyScope ?? null,
      projection: projectionOptions,
    });
  }

  private buildRuntimeProjectionForVisibleAttach(
    runtimeState: Readonly<ChatSessionRuntimeState> | null | undefined,
  ): HostTurnResponseState | null {
    return runtimeState?.hostProjectionState ?? null;
  }

  private projectSessionModelToVisibleAttach(
    sessionId: string | null | undefined,
    runtimeState?: Readonly<ChatSessionRuntimeState> | null,
  ): boolean {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const model = this.chatSessionModelStore?.get?.(targetSessionId);
    if (!model) {
      return false;
    }

    const buildRuntimeProjectionForVisibleAttach = (
      (this as unknown as { buildRuntimeProjectionForVisibleAttach?: ChatEngineService['buildRuntimeProjectionForVisibleAttach'] })
        .buildRuntimeProjectionForVisibleAttach
      ?? ChatEngineService.prototype['buildRuntimeProjectionForVisibleAttach']
    );
    const getCheckpointTimelineState = (model as unknown as {
      getCheckpointTimelineState?: ChatSessionModel['getCheckpointTimelineState'];
    }).getCheckpointTimelineState;
    const checkpointTimelineState = typeof getCheckpointTimelineState === 'function'
      ? getCheckpointTimelineState.call(model)
      : null;
    const checkpointVisibleTurnResponses = checkpointTimelineState
      ? getSessionCheckpointVisibleTurnResponses(checkpointTimelineState)
      : null;
    const modelTurnResponses = model.turnResponses.length > 0
      ? model.turnResponses
      : [];
    const canonicalTurnResponses = checkpointVisibleTurnResponses
      ?? (modelTurnResponses.length > 0
      ? modelTurnResponses
      : []);
    const canonicalProjectionState = checkpointTimelineState
      ? buildHostProjectionStateFromPersistedRecord({ turnResponses: canonicalTurnResponses })
      : canonicalTurnResponses.length > 0
      ? buildRuntimeHostProjectionState(canonicalTurnResponses)
      : null;
    const runtimeProjectionState = buildRuntimeProjectionForVisibleAttach.call(this, runtimeState);
    const modelProjectionState = model.hostProjectionState ?? null;
    const projectionState = checkpointTimelineState
      ? canonicalProjectionState
      : canonicalProjectionState ?? runtimeProjectionState ?? modelProjectionState;
    if (!projectionState) {
      return false;
    }

    const turnResponses = canonicalTurnResponses.length > 0
      ? canonicalTurnResponses
      : projectionState.turnResponses;
    if (turnResponses.length > 0) {
      this.lexStream.hydrateTurnResponses(targetSessionId, turnResponses, {
        visibility: 'visibleAttach',
      });
    }
    this.visibleProjectionSessionId = targetSessionId;
    this.liveHostRequestGraphCache.replaceState(projectionState);
    this.triggerSyncDetectChanges();
    return true;
  }

  private async commitRestoredCheckpointForwardBranchBeforeUserTurn(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const model = this.chatSessionModelStore?.get?.(targetSessionId);
    const getCheckpointTimelineState = (model as unknown as {
      getCheckpointTimelineState?: ChatSessionModel['getCheckpointTimelineState'];
    } | undefined)?.getCheckpointTimelineState;
    const checkpointTimelineState = model && typeof getCheckpointTimelineState === 'function'
      ? getCheckpointTimelineState.call(model)
      : null;
    const transaction = this.chatSessionModelStore?.commitRestoredCheckpointForwardBranch?.(targetSessionId) ?? null;
    if (!model || !transaction) {
      console.info('[AilyChat][CheckpointRestoreTrace]', {
        phase: 'commit-forward-branch-skip',
        sessionId: targetSessionId,
        hasModel: !!model,
        hasRequestListTransaction: !!transaction,
        timeline: this.summarizeCheckpointTimelineForTrace(checkpointTimelineState),
      });
      return false;
    }

    const turnResponses = transaction.effects.executionHost.hydrateTurnResponses;
    const protocolTruncation = transaction.effects.executionHost.protocolTruncation;
    console.info('[AilyChat][CheckpointRestoreTrace]', {
      phase: 'commit-forward-branch',
      sessionId: targetSessionId,
      beforeTimeline: this.summarizeCheckpointTimelineForTrace(checkpointTimelineState),
      afterTimeline: this.summarizeCheckpointTimelineForTrace(transaction.checkpointTimelineState),
      retainedTurnIds: transaction.retainedTurnIds,
      discardedTurnIds: transaction.discardedTurnIds,
      protocolTruncation,
      transactionKind: transaction.kind,
      transactionRevision: transaction.revision,
    });

    await this.requestHostEditTrackingRestore(targetSessionId, turnResponses);

    this.applyRequestListTransactionEffects(targetSessionId, transaction);
    this.triggerSyncDetectChanges?.();
    return true;
  }

  private applyRequestListTransactionEffects(
    sessionId: string,
    transaction: ChatSessionRequestListTransactionResult,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const protocolTruncation = transaction.effects.executionHost.protocolTruncation;
    if (protocolTruncation) {
      this.pendingProtocolTruncations.set(targetSessionId, protocolTruncation);
    } else {
      this.pendingProtocolTruncations.delete(targetSessionId);
    }

    const executionTurnResponses = transaction.effects.executionHost.hydrateTurnResponses;
    this.lexStream?.hydrateTurnResponses?.(targetSessionId, executionTurnResponses, {
      visibility: 'visibleAttach',
    });

    const projectionTurnResponses = transaction.effects.hostProjection.turnResponses;
    const hostProjectionState = buildRuntimeHostProjectionState(projectionTurnResponses);
    if (hostProjectionState) {
      const currentViewSessionResource = this.resolveCurrentViewSessionResource();
      this.projectRestoredHostProjection(targetSessionId, projectionTurnResponses, hostProjectionState, {
        attachedView: currentViewSessionResource === targetSessionId,
      });
      if (currentViewSessionResource === targetSessionId) {
        this.visibleProjectionSessionId = targetSessionId;
        this.liveHostRequestGraphCache?.replaceState?.(hostProjectionState);
      }
    }

    const persistenceTurnResponses = transaction.effects.persistence.turnResponses;
    const persistenceProjectionState = persistenceTurnResponses === projectionTurnResponses
      ? hostProjectionState
      : buildRuntimeHostProjectionState(persistenceTurnResponses);
    const saveTarget = this.buildExecutionSaveTarget(targetSessionId);
    if (saveTarget) {
      this.session?.saveCurrentSession?.({
        ...(persistenceProjectionState ? {
          hostProjection: persistenceProjectionState,
          visibleChatList: persistenceProjectionState.chatList,
        } : {}),
        target: saveTarget,
      });
    }
  }

  private prepareProtocolTruncationForResend(
    sessionId: string | null | undefined,
    turnId: string | null | undefined,
  ): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (!targetSessionId || !targetTurnId) {
      return false;
    }

    const transaction = this.chatSessionModelStore?.removeFromTurnTransaction?.(targetSessionId, targetTurnId) ?? null;
    if (!transaction) {
      return false;
    }

    this.applyRequestListTransactionEffects(targetSessionId, transaction);
    this.triggerSyncDetectChanges?.();
    return true;
  }

  private peekPendingProtocolTruncation(sessionId: string | null | undefined): ChatRuntimeHostProtocolTruncation | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return targetSessionId ? this.pendingProtocolTruncations.get(targetSessionId) ?? null : null;
  }

  private summarizeTurnResponseIdsForTrace(turnResponses: readonly TurnResponseTurn[] | null | undefined): string[] {
    return (turnResponses ?? []).map(turn => {
      const turnId = typeof turn.turnId === 'string' ? turn.turnId.trim() : '';
      return turnId || '<missing-turn-id>';
    });
  }

  private summarizeCheckpointTimelineForTrace(state: SessionCheckpointTimelineState | null | undefined): Record<string, unknown> | null {
    if (!state) {
      return null;
    }
    return {
      sessionResource: state.sessionResource,
      currentCheckpointIndex: state.currentCheckpointIndex,
      currentTurnResponseCount: state.currentTurnResponseCount,
      checkpoints: state.checkpoints.map(checkpoint => ({
        checkpointId: checkpoint.checkpointId,
        requestId: checkpoint.requestId,
        turnId: checkpoint.turnId ?? null,
        turnIndex: checkpoint.turnIndex,
      })),
      turnIds: this.summarizeTurnResponseIdsForTrace(state.turnResponses),
    };
  }

  private clearPendingProtocolTruncation(sessionId: string | null | undefined): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (targetSessionId) {
      this.pendingProtocolTruncations.delete(targetSessionId);
    }
  }

  private hasRestoredCheckpointForwardBranch(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const model = this.chatSessionModelStore?.get?.(targetSessionId);
    const getCheckpointTimelineState = (model as unknown as {
      getCheckpointTimelineState?: ChatSessionModel['getCheckpointTimelineState'];
    } | undefined)?.getCheckpointTimelineState;
    const checkpointTimelineState = model && typeof getCheckpointTimelineState === 'function'
      ? getCheckpointTimelineState.call(model)
      : null;
    return canRedoSessionCheckpointTimeline(checkpointTimelineState);
  }

  private runtimeHostForView(): ChatRuntimeHost {
    if (this.electronRuntimeHost) {
      return this.electronRuntimeHost;
    }

    throw new Error('[AilyChat][RuntimeHost] Visible chat views require Electron runtime host transport.');
  }

  private async requestHostEditTrackingRestore(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      throw new Error('[AilyChat][RuntimeHost] edit tracking restore requires a host session id.');
    }
    await this.runtimeHostForView().requestResourceOperation({
      sessionId: targetSessionId,
      kind: 'edit-tracking',
      label: 'Restoring edit tracking from checkpoint branch',
      detail: 'Host edit tracking resource is rebuilding checkpoint state from committed turn responses.',
      payload: {
        adapter: 'editTracking',
        action: 'restoreFromTurnResponses',
        workspaceRoot: this.getCurrentProjectPath(),
        turnResponses,
        autoSaveEdits: this.ailyChatConfigService.autoSaveEdits === true,
      },
    });
  }

  private async requestHostEditTrackingClearSessionState(sessionId: string | null | undefined): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      throw new Error('[AilyChat][RuntimeHost] clear edit tracking state requires a host session id.');
    }
    await this.runtimeHostForView().requestResourceOperation({
      sessionId: targetSessionId,
      kind: 'edit-tracking',
      label: 'Clearing edit tracking session state',
      detail: 'Host edit tracking resource is clearing stale visible session edit state.',
      payload: {
        adapter: 'editTracking',
        action: 'clearSessionState',
        dismissSummary: true,
      },
    });
  }

  private setupRuntimeHostEventSubscription(): void {
    this.runtimeHostEventSubscription?.dispose();
    // Runtime-host revisions are model events. Register their IPC listener
    // outside Angular so each token/part event cannot schedule an application
    // tick. Visible list-item patches and explicit interaction/completion
    // refreshes are the only renderer entry points.
    this.ngZone.runOutsideAngular(() => {
      this.runtimeHostEventSubscription = this.runtimeHostForView().onEvent((event) => {
        if (!this.runtimeHostEventZoneBoundaryReported) {
          this.runtimeHostEventZoneBoundaryReported = true;
          console.info(
            '[AilyChat][RuntimeHostEventZoneScalar]',
            `inAngularZone=${NgZone.isInAngularZone()} kind=${event.kind}`,
          );
        }
        this.handleRuntimeHostEvent(event);
      });
    });
    this.traceRuntimeHostRoute('subscribe-view', null, {
      currentSessionId: this.chatService.currentSessionId || null,
      currentViewSessionResource: this.resolveCurrentViewSessionResource() || null,
    });
  }

  private handleRuntimeHostEvent(event: ChatRuntimeHostEvent | ChatRuntimeOwnerExecutorEvent): void {
    const targetSessionId = typeof event.sessionId === 'string' ? event.sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    this.traceRuntimeHostEvent('received', targetSessionId, event as ChatRuntimeHostEvent);
    this.traceRuntimeHostRoute('event', targetSessionId, {
      kind: event.kind,
      currentSessionId: this.chatService.currentSessionId || null,
      currentViewSessionResource: this.resolveCurrentViewSessionResource() || null,
      stateAttached: this.isRuntimeHostViewAttached(this.readRuntimeHostSessionState(targetSessionId)),
      eventAttached: event.kind === 'session-state' || event.kind === 'runtime-status'
        ? this.isRuntimeHostViewAttached(event.state)
        : null,
      status: event.kind === 'session-state' || event.kind === 'runtime-status'
        ? event.state.status
        : null,
      requestInProgress: event.kind === 'session-state' || event.kind === 'runtime-status'
        ? event.state.requestInProgress
        : null,
      transcriptTurns: event.kind === 'transcript'
        ? event.transcript.turnResponses.length
        : event.kind === 'turn-transcript'
          ? 1
          : event.kind === 'part-transcript'
            ? 1
          : null,
      transcriptLastTurn: event.kind === 'transcript'
        ? event.transcript.turnResponses[event.transcript.turnResponses.length - 1]?.turnId ?? null
        : event.kind === 'turn-transcript'
          ? event.turnId
          : event.kind === 'part-transcript'
            ? event.turnId
        : null,
      transcriptLastParts: event.kind === 'transcript'
        ? event.transcript.turnResponses[event.transcript.turnResponses.length - 1]?.response?.parts?.length ?? 0
        : event.kind === 'turn-transcript'
          ? event.turn.response?.parts?.length ?? 0
          : event.kind === 'part-transcript'
            ? event.parts.length
        : null,
      transcriptLastTextLength: event.kind === 'transcript'
        ? event.transcript.turnResponses[event.transcript.turnResponses.length - 1]?.response?.resultText?.length ?? 0
        : event.kind === 'turn-transcript'
          ? event.turn.response?.resultText?.length ?? 0
          : event.kind === 'part-transcript'
            ? null
        : null,
      error: event.kind === 'error'
        ? {
            code: event.error.code ?? null,
            message: event.error.message,
            retryable: event.error.retryable ?? null,
          }
        : null,
    });

    switch (event.kind) {
      case 'runtimeProjectPathUpdated':
        this.applyRuntimeProjectPathUpdatedEvent(targetSessionId, event);
        return;
      case 'turnProgress':
        if (event.renderEvent) {
          this.projectExecutionRenderEvent(targetSessionId, event.renderEvent, event.request
            ? {
                sessionId: event.request.sessionId,
                requestText: event.request.requestText,
                displayText: event.request.displayText,
                metadata: event.request.metadata ?? null,
                activeResponseHandle: event.request.activeResponseHandle,
              }
            : null);
        }
        if (event.turn) {
          this.applyRuntimeHostTurnTranscriptEvent(targetSessionId, event.turn, {
            visibleProjection: this.shouldProjectRuntimeHostTranscriptEvent(targetSessionId),
            revision: event.revision,
          });
        }
        if (event.event) {
          this.handleRuntimeHostEvent(event.event);
        }
        return;
      case 'turnCompleted':
        if (event.turn) {
          this.applyRuntimeHostTurnTranscriptEvent(targetSessionId, event.turn, {
            visibleProjection: this.shouldProjectRuntimeHostTranscriptEvent(targetSessionId),
            revision: event.revision,
          });
        }
        if (event.state) {
          this.applyRuntimeHostSessionStateEvent(targetSessionId, event.state);
        }
        if (event.interaction && this.shouldProjectRuntimeHostInteractionEvent(targetSessionId, event.interaction)) {
          this.applyRuntimeHostInteractionEvent(targetSessionId, event.interaction);
          this.triggerSyncDetectChanges();
        }
        return;
      case 'turnError':
        if (!this.shouldProjectRuntimeHostVisibleEvent(targetSessionId)) {
          this.traceRuntimeHostEvent('ignored-detached-view', targetSessionId, event as unknown as ChatRuntimeHostEvent);
          return;
        }
        this.applyRuntimeHostErrorEvent(targetSessionId, event.error);
        return;
      case 'transcript':
        this.applyRuntimeHostTranscriptEvent(targetSessionId, event.transcript.turnResponses, {
          visibleProjection: this.shouldProjectRuntimeHostTranscriptEvent(targetSessionId),
          // Runtime-host live transcript events are progress deltas over the service-owned model.
          authoritativeSnapshot: false,
          revision: event.revision,
        });
        return;
      case 'turn-transcript':
        this.applyRuntimeHostTurnTranscriptEvent(targetSessionId, event.turn, {
          visibleProjection: this.shouldProjectRuntimeHostTranscriptEvent(targetSessionId),
          revision: event.revision,
          sourceEventType: event.sourceEventType,
          sourceEventTimestamp: event.sourceEventTimestamp,
          hostPublishedAt: event.hostPublishedAt,
        });
        return;
      case 'part-transcript':
        this.applyRuntimeHostPartTranscriptEvent(targetSessionId, event, {
          visibleProjection: this.shouldProjectRuntimeHostTranscriptEvent(targetSessionId),
          revision: event.revision,
        });
        return;
      case 'session-state':
      case 'runtime-status':
        this.applyRuntimeHostSessionStateEvent(targetSessionId, event.state);
        return;
      case 'error':
        if (!this.shouldProjectRuntimeHostVisibleEvent(targetSessionId)) {
          this.traceRuntimeHostEvent('ignored-detached-view', targetSessionId, event);
          return;
        }
        this.applyRuntimeHostErrorEvent(targetSessionId, event.error);
        return;
      case 'interaction':
        if (!this.shouldProjectRuntimeHostInteractionEvent(targetSessionId, event.interaction)) {
          return;
        }
        this.applyRuntimeHostInteractionEvent(targetSessionId, event.interaction);
        this.triggerSyncDetectChanges();
        return;
      case 'view-request':
        if (!this.shouldProjectRuntimeHostVisibleEvent(targetSessionId)) {
          this.traceRuntimeHostEvent('ignored-detached-view', targetSessionId, event);
          return;
        }
        this.applyRuntimeHostViewRequestEvent(targetSessionId, event.request);
        return;
    }
  }

  private applyRuntimeProjectPathUpdatedEvent(
    targetSessionId: string,
    event: Extract<ChatRuntimeOwnerExecutorEvent, { readonly kind: 'runtimeProjectPathUpdated' }>,
  ): void {
    const projectPath = typeof event.projectPath === 'string' ? event.projectPath.trim() : '';
    if (!projectPath) {
      return;
    }

    const currentProviderOptions = this.resolveVisibleSessionProviderOptionsSnapshot(targetSessionId);
    const providerOptions = normalizeHostSessionProviderOptions({
      ...currentProviderOptions,
      ...(event.providerOptions && typeof event.providerOptions === 'object' ? event.providerOptions : {}),
      folderPath: projectPath,
    });
    this.rememberRuntimeSessionProviderOptions(targetSessionId, providerOptions);

    const shouldProjectToVisibleOwner = this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (shouldProjectToVisibleOwner) {
      this.chatService.applySessionProviderOptions?.(providerOptions);
    }
    this.syncCurrentSessionEntryTargetRuntimeMode(targetSessionId);
  }

  private shouldProjectRuntimeHostVisibleEvent(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    if (this.resolveCurrentViewSessionResource() !== targetSessionId) {
      return false;
    }

    const state = this.readRuntimeHostSessionState(targetSessionId);
    return !state || this.isRuntimeHostViewAttached(state);
  }

  private shouldProjectRuntimeHostTranscriptEvent(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    if (this.resolveCurrentViewSessionResource() === targetSessionId) {
      return true;
    }

    return this.ensureRuntimeEventSessionViewAttached(targetSessionId);
  }

  private shouldProjectRuntimeHostInteractionEvent(
    sessionId: string,
    snapshot: ChatRuntimeHostInteractionSnapshot,
  ): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (currentViewSessionResource !== targetSessionId) {
      if (!this.ensureRuntimeEventSessionViewAttached(targetSessionId)) {
        this.traceRuntimeHostInteractionProjection('ignored-detached-view', targetSessionId, snapshot, {
          currentViewSessionResource,
        });
        return false;
      }
    }

    const visibleAttachmentGeneration = this.readVisibleAttachmentGenerationForSession(targetSessionId);
    if (typeof visibleAttachmentGeneration !== 'number' || !Number.isFinite(visibleAttachmentGeneration)) {
      this.traceRuntimeHostInteractionProjection('defer-missing-visible-attachment', targetSessionId, snapshot, {
        currentViewSessionResource: this.resolveCurrentViewSessionResource(),
      });
      void this.attachSessionView(targetSessionId).then(() => {
        const attachedGeneration = this.readVisibleAttachmentGenerationForSession(targetSessionId);
        if (typeof attachedGeneration !== 'number' || !Number.isFinite(attachedGeneration)) {
          this.traceRuntimeHostInteractionProjection('ignored-missing-visible-attachment-after-attach', targetSessionId, snapshot, {
            currentViewSessionResource: this.resolveCurrentViewSessionResource(),
          });
          return;
        }
        this.traceRuntimeHostInteractionProjection('project-visible-after-attach', targetSessionId, snapshot, {
          visibleAttachmentGeneration: attachedGeneration,
        });
        this.applyRuntimeHostInteractionEvent(targetSessionId, snapshot);
        this.triggerSyncDetectChanges();
      }).catch((error) => {
        this.traceRuntimeHostInteractionProjection('attach-failed', targetSessionId, snapshot, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return false;
    }

    this.traceRuntimeHostInteractionProjection('project-visible', targetSessionId, snapshot, {
      visibleAttachmentGeneration,
    });
    return true;
  }

  private applyRuntimeHostViewRequestEvent(
    sessionId: string,
    request: ChatRuntimeHostViewRequest,
  ): void {
    if (this.resolveCurrentViewSessionResource() !== sessionId) {
      return;
    }

    switch (request.kind) {
      case 'notification':
        this.applyRuntimeHostNotificationViewRequest(request);
        return;
      case 'todo-state':
        this.applyRuntimeHostTodoStateViewRequest(sessionId, request);
        return;
      case 'handoff':
        this.applyRuntimeHostHandoffViewRequest(request);
        return;
    }
  }

  private applyRuntimeHostNotificationViewRequest(request: ChatRuntimeHostViewRequest): void {
    if (!request.notification) {
      return;
    }

    const { severity, message } = request.notification;
    switch (severity) {
      case 'success':
        this.message.success(message);
        return;
      case 'error':
        this.message.error(message);
        return;
      case 'warning':
        this.message.warning(message);
        return;
      case 'info':
        this.message.info(message);
        return;
    }
  }

  private applyRuntimeHostTodoStateViewRequest(sessionId: string, request: ChatRuntimeHostViewRequest): void {
    const items = request.todoState?.items;
    if (!Array.isArray(items)) {
      return;
    }

    const blocklyTodos: BlocklyTodoItem[] = items.map(item => ({
      id: item.id,
      content: item.content,
      status: item.status,
      priority: item.priority,
      updatedAt: item.updatedAt,
    }));

    try {
      setTodos(blocklyTodos, sessionId);
    } catch {
      // Keep view-side todo persistence failures isolated from the host runtime.
    }

    this.ngZone.run(() => {
      try {
        const svc = (window as unknown as {
          todoUpdateService?: {
            updateTodoListSemanticData?: (
              sessionId: string,
              semanticData: unknown,
              todos: readonly BlocklyTodoItem[],
            ) => void;
          };
        }).todoUpdateService;
        svc?.updateTodoListSemanticData?.(
          sessionId,
          buildTodoListSemanticDataFromTodos(blocklyTodos),
          blocklyTodos,
        );
      } catch {
        // The view may be detached or the todo UI service may be absent.
      }
    });
  }

  private applyRuntimeHostHandoffViewRequest(request: ChatRuntimeHostViewRequest): void {
    const handoff = request.handoff;
    if (!handoff) {
      return;
    }

    this.ngZone.run(() => {
      if (handoff.targetModeId) {
        void this.switchToMode(handoff.targetModeId).catch((error) => {
          console.error('应用 handoff 模式切换失败:', error);
        });
        this.message.info(handoff.message);
        return;
      }

      const suggestedInput = typeof handoff.suggestedInput === 'string'
        ? handoff.suggestedInput
        : '';
      let prefilled = false;
      if (suggestedInput && (this.inputValue || '').trim().length === 0) {
        this.inputValue = suggestedInput;
        this.triggerSyncDetectChanges();
        prefilled = true;
      }

      this.message.info(
        prefilled
          ? `${handoff.message}。已在输入框中预填 ${suggestedInput.trim()}，等待你确认发送。`
          : handoff.message,
      );
    });
  }

  private applyRuntimeHostInteractionEvent(
    sessionId: string,
    snapshot: ChatRuntimeHostInteractionSnapshot,
  ): void {
    const visibleAttachmentGeneration = this.readVisibleAttachmentGenerationForSession(sessionId);
    if (isRuntimeInteractionProjectionTraceEnabled()) {
      console.info('[AilyChat][RuntimeHostInteractionProjection]', {
        phase: 'apply-host-snapshot',
        sessionId,
        snapshotSessionId: snapshot.sessionId,
        revision: snapshot.revision,
        visibleAttachmentGeneration,
        hasQuestion: !!snapshot.question,
        confirmationCount: Array.isArray(snapshot.confirmationQueue)
          ? snapshot.confirmationQueue.length
          : 0,
        activeConfirmationIndex: snapshot.activeConfirmationIndex ?? null,
        hasPlanReview: !!snapshot.activePlanReview,
      });
    }
    this.runtimeInteractionHost.applyHostSnapshot(
      snapshot,
      request => this.dispatchRuntimeHostInteraction(request, visibleAttachmentGeneration),
    );
  }

  private traceRuntimeHostInteractionProjection(
    phase: string,
    sessionId: string,
    snapshot: ChatRuntimeHostInteractionSnapshot,
    extra?: Record<string, unknown>,
  ): void {
    if (!isRuntimeInteractionProjectionTraceEnabled()) {
      return;
    }
    console.info('[AilyChat][RuntimeHostInteractionProjection]', {
      phase,
      sessionId,
      snapshotSessionId: snapshot.sessionId,
      revision: snapshot.revision,
      hasQuestion: !!snapshot.question,
      confirmationCount: Array.isArray(snapshot.confirmationQueue)
        ? snapshot.confirmationQueue.length
        : 0,
      activeConfirmationIndex: snapshot.activeConfirmationIndex ?? null,
      hasPlanReview: !!snapshot.activePlanReview,
      ...extra,
    });
  }

  private async dispatchRuntimeHostInteraction(
    request: Omit<ChatRuntimeHostInteractionRequest, 'viewId' | 'visibleAttachmentGeneration'>,
    visibleAttachmentGeneration: number | null,
  ): Promise<ChatRuntimeHostInteractionSnapshot | null> {
    if (typeof visibleAttachmentGeneration !== 'number' || !Number.isFinite(visibleAttachmentGeneration)) {
      throw new Error('[AilyChat][RuntimeHost] Interaction decision requires an attached visible transcript generation.');
    }
    return this.runtimeHostForView().resolveInteraction({
      ...request,
      viewId: this.runtimeViewId,
      visibleAttachmentGeneration,
    });
  }

  private readVisibleAttachmentGenerationForSession(sessionId: string | null | undefined): number | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const attachment = this.visibleTranscriptAttachment;
    if (!targetSessionId
      || !attachment
      || attachment.sessionId !== targetSessionId
      || !this.isVisibleTranscriptAttachmentCurrent(attachment)) {
      return null;
    }
    return typeof attachment.generation === 'number' && Number.isFinite(attachment.generation)
      ? attachment.generation
      : null;
  }

  private applyRuntimeHostTranscriptEvent(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    options?: {
      readonly visibleProjection?: boolean;
      readonly authoritativeSnapshot?: boolean;
      readonly revision?: number;
    },
  ): void {
    this.dialogItemsCache = null;
    const commitSessionModelTurnResponses = options?.authoritativeSnapshot === false
      ? (
        (this as unknown as { mergeSessionModelTurnResponses?: ChatEngineService['mergeSessionModelTurnResponses'] })
          .mergeSessionModelTurnResponses
        ?? ChatEngineService.prototype['mergeSessionModelTurnResponses']
      )
      : (
        (this as unknown as { replaceSessionModelTurnResponses?: ChatEngineService['replaceSessionModelTurnResponses'] })
          .replaceSessionModelTurnResponses
        ?? ChatEngineService.prototype['replaceSessionModelTurnResponses']
      );
    const committedTurnResponses = commitSessionModelTurnResponses.call(this, sessionId, turnResponses, {
      source: 'runtime-host-transcript',
    }) ?? turnResponses;
    // The Electron host owns submitted/terminal durability. Full transcript
    // events only update the renderer-side response model; part deltas retain
    // the throttled recovery-snapshot fallback below.
    const shouldRefreshCheckpointTimeline = (
      (this as unknown as {
        shouldRefreshRuntimeTranscriptCheckpointTimeline?: ChatEngineService['shouldRefreshRuntimeTranscriptCheckpointTimeline'];
      }).shouldRefreshRuntimeTranscriptCheckpointTimeline
      ?? ChatEngineService.prototype['shouldRefreshRuntimeTranscriptCheckpointTimeline']
    );
    if (shouldRefreshCheckpointTimeline.call(this, turnResponses, committedTurnResponses, options)) {
      this.refreshSessionCheckpointTimelineFromRuntimeTranscript(sessionId, committedTurnResponses);
    }

    const visibleCurrentSession = options?.visibleProjection === true
      && this.ensureRuntimeEventSessionViewAttached(sessionId);
    this.traceRuntimeHostTranscriptProjection(sessionId, turnResponses, committedTurnResponses, visibleCurrentSession);
    this.syncResolvedActiveModelFromCommittedTranscript(sessionId, committedTurnResponses);

    if (visibleCurrentSession) {
      const projectVisibleTranscript = (
        (this as unknown as {
          projectRuntimeHostVisibleTranscript?: ChatEngineService['projectRuntimeHostVisibleTranscript'];
        }).projectRuntimeHostVisibleTranscript
        ?? ChatEngineService.prototype['projectRuntimeHostVisibleTranscript']
      );
      projectVisibleTranscript.call(this, sessionId, committedTurnResponses);
    }
  }

  private applyRuntimeHostTurnTranscriptEvent(
    sessionId: string,
    turnResponse: TurnResponseTurn,
    options?: {
      readonly visibleProjection?: boolean;
      readonly revision?: number;
      readonly sourceEventType?: string;
      readonly sourceEventTimestamp?: number;
      readonly hostPublishedAt?: number;
    },
  ): void {
    const committedTurnResponses = this.mergeSessionModelTurnResponses(sessionId, [turnResponse], {
      source: 'runtime-host-turn-transcript',
    }) ?? null;
    if (!committedTurnResponses) {
      return;
    }
    if (this.shouldRefreshRuntimeTranscriptCheckpointTimeline([turnResponse], committedTurnResponses, {
      authoritativeSnapshot: false,
    })) {
      this.refreshSessionCheckpointTimelineFromRuntimeTranscript(sessionId, committedTurnResponses);
    }

    const visibleCurrentSession = options?.visibleProjection === true
      && this.ensureRuntimeEventSessionViewAttached(sessionId);
    this.traceRuntimeHostTranscriptProjection(sessionId, [turnResponse], committedTurnResponses, visibleCurrentSession);
    this.syncResolvedActiveModelFromCommittedTranscript(sessionId, committedTurnResponses);

    if (visibleCurrentSession) {
      this.recordVisibleSourceEventTimestamp(
        sessionId,
        turnResponse.turnId,
        options?.sourceEventType,
        options?.sourceEventTimestamp,
      );
      if (this.isRuntimeHostTerminalTurnResponse(turnResponse)) {
        this.recordVisibleResponseCompletionBoundary(sessionId, turnResponse.turnId, {
          sourceEventType: options?.sourceEventType,
          sourceEventTimestamp: options?.sourceEventTimestamp,
          hostPublishedAt: options?.hostPublishedAt,
        });
      }
      this.projectRuntimeHostVisibleTurnTranscript(sessionId, turnResponse);
      if (options?.sourceEventType === 'response_complete'
        && this.isRuntimeHostTerminalTurnResponse(turnResponse)) {
        this.completeVisibleRequestStateAtResponseBoundary(sessionId, turnResponse.turnId);
      }
    }
  }

  private applyRuntimeHostPartTranscriptEvent(
    sessionId: string,
    event: ChatRuntimeHostPartTranscriptEvent,
    options?: {
      readonly visibleProjection?: boolean;
      readonly revision?: number;
    },
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const turnId = typeof event.turnId === 'string' ? event.turnId.trim() : '';
    if (!targetSessionId || !turnId || !Array.isArray(event.parts) || event.parts.length === 0) {
      return;
    }

    let committedTurnResponses: readonly TurnResponseTurn[] | null = null;
    if (event.turn) {
      committedTurnResponses = this.chatSessionModelStore.appendOrReplaceTurnResponseDelta(
        targetSessionId,
        event.turn,
        event.parts,
        { source: 'runtime-host-part-transcript' },
      ) ?? null;
      if (committedTurnResponses) {
        this.syncResolvedActiveModelFromCommittedTranscript(targetSessionId, committedTurnResponses);
        this.markRuntimeHostRecoverySnapshotDirty(targetSessionId, { flush: 'scheduled' });
      }
    } else {
      const model = this.chatSessionModelStore.get(targetSessionId);
      if (model?.upsertTurnResponseParts(turnId, event.parts)) {
        committedTurnResponses = model.turnResponses;
        this.markRuntimeHostRecoverySnapshotDirty(targetSessionId, { flush: 'scheduled' });
      }
    }

    const visibleCurrentSession = options?.visibleProjection === true
      && this.ensureRuntimeEventSessionViewAttached(targetSessionId);
    if (visibleCurrentSession) {
      this.recordVisibleSourceEventTimestamp(
        targetSessionId,
        turnId,
        event.sourceEventType,
        event.sourceEventTimestamp,
      );
      // `turn_end` is materialized by the host transcript builder as a
      // terminal turn carried on the final part delta. Commit that terminal
      // revision to the same visible response item immediately. Waiting for
      // the later execution-host `turnCompleted` acknowledgement would couple
      // response completion to iterator/resource cleanup and leave the row in
      // its streaming state after the canonical response model is complete.
      if (event.turn && this.isRuntimeHostTerminalTurnResponse(event.turn)) {
        this.recordVisibleResponseCompletionBoundary(targetSessionId, turnId, {
          sourceEventType: event.sourceEventType,
          sourceEventTimestamp: event.sourceEventTimestamp,
          hostPublishedAt: event.hostPublishedAt,
        });
        this.projectRuntimeHostVisibleTurnTranscript(targetSessionId, event.turn);
        if (event.sourceEventType === 'response_complete') {
          this.completeVisibleRequestStateAtResponseBoundary(targetSessionId, turnId);
        }
      } else {
        this.projectRuntimeHostVisiblePartTranscript(targetSessionId, event);
      }
    }
  }

  private completeVisibleRequestStateAtResponseBoundary(sessionId: string, turnId: string): void {
    this._runtimeRequestStatePatch?.({
      sessionId,
      requestInProgress: false,
      activeTurnId: null,
      previousActiveTurnId: turnId,
    });
    console.info(
      '[AilyChat][VisibleRequestCompletionScalar]',
      `sessionId=${sessionId} turnId=${turnId} wallAt=${Date.now()}`,
    );
  }

  private recordVisibleResponseCompletionBoundary(
    sessionId: string,
    turnId: string,
    timing?: {
      readonly sourceEventType?: string;
      readonly sourceEventTimestamp?: number;
      readonly hostPublishedAt?: number;
    },
  ): void {
    const source = typeof timing?.sourceEventType === 'string' ? timing.sourceEventType.trim() : '';
    if (source !== 'response_complete' && source !== 'turn_end') {
      return;
    }
    const key = `${sessionId}:${turnId}`;
    const now = performance.now();
    const wallNow = Date.now();
    const visibleCompletedAt = this.visibleResponseCompletionBoundaries.get(key);
    if (source === 'response_complete') {
      if (visibleCompletedAt === undefined) {
        this.visibleResponseCompletionBoundaries.set(key, now);
        const sourceEventTimestamp = Number(timing?.sourceEventTimestamp);
        const hostPublishedAt = Number(timing?.hostPublishedAt);
        const lastSourceEventAt = this.visibleResponseLastSourceEventAt.get(key);
        this.visibleResponseLastSourceEventAt.delete(key);
        const sourceGapMs = Number.isFinite(sourceEventTimestamp) && lastSourceEventAt !== undefined
          ? Math.max(0, sourceEventTimestamp - lastSourceEventAt)
          : null;
        const sourceToHostMs = Number.isFinite(sourceEventTimestamp) && Number.isFinite(hostPublishedAt)
          ? Math.max(0, hostPublishedAt - sourceEventTimestamp)
          : null;
        const hostToRendererMs = Number.isFinite(hostPublishedAt)
          ? Math.max(0, wallNow - hostPublishedAt)
          : null;
        this._visibleResponseRevisionObserved?.({
          sessionId,
          turnId,
          sourceEventType: source,
          ...(sourceGapMs === null ? {} : { sourceGapMs }),
        });
        console.info(
          '[AilyChat][ResponseCompletionBoundaryScalar]',
          [
            'source=response_complete',
            `sourceGapMs=${sourceGapMs === null ? '<unknown>' : sourceGapMs.toFixed(1)}`,
            `sourceToHostMs=${sourceToHostMs === null ? '<unknown>' : sourceToHostMs.toFixed(1)}`,
            `hostToRendererMs=${hostToRendererMs === null ? '<unknown>' : hostToRendererMs.toFixed(1)}`,
            `wallAt=${wallNow}`,
            `sessionId=${sessionId}`,
            `turnId=${turnId}`,
          ].join(' '),
        );
      }
      return;
    }

    this.visibleResponseCompletionBoundaries.delete(key);
    this.visibleResponseLastSourceEventAt.delete(key);
    console.info(
      '[AilyChat][ResponseCompletionBoundaryScalar]',
      visibleCompletedAt === undefined
        ? `source=turn_end responseCompleteMissing=true sessionId=${sessionId} turnId=${turnId}`
        : `source=turn_end durableAfterVisibleMs=${(now - visibleCompletedAt).toFixed(1)} sessionId=${sessionId} turnId=${turnId}`,
    );
  }

  private recordVisibleSourceEventTimestamp(
    sessionId: string,
    turnId: string,
    sourceEventType?: string,
    sourceEventTimestamp?: number,
  ): void {
    const source = typeof sourceEventType === 'string' ? sourceEventType.trim() : '';
    const timestamp = Number(sourceEventTimestamp);
    if (!source || source === 'response_complete' || source === 'turn_end' || !Number.isFinite(timestamp)) {
      return;
    }
    this.visibleResponseLastSourceEventAt.set(`${sessionId}:${turnId}`, timestamp);
    this._visibleResponseRevisionObserved?.({
      sessionId,
      turnId,
      sourceEventType: source,
    });
  }

  private projectRuntimeHostVisibleTranscript(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const cooldown = (this as unknown as {
      runtimeHostVisibleTranscriptProjectionCooldown?: Set<string>;
    }).runtimeHostVisibleTranscriptProjectionCooldown;
    if (!cooldown || !cooldown.has(targetSessionId)) {
      const projectNow = (
        (this as unknown as {
          projectRuntimeHostVisibleTranscriptNow?: ChatEngineService['projectRuntimeHostVisibleTranscriptNow'];
        }).projectRuntimeHostVisibleTranscriptNow
        ?? ChatEngineService.prototype['projectRuntimeHostVisibleTranscriptNow']
      );
      projectNow.call(this, targetSessionId, turnResponses);
      if (!cooldown) {
        return;
      }
      cooldown.add(targetSessionId);
      const scheduleProjection = (
        (this as unknown as {
          scheduleRuntimeHostVisibleTranscriptProjection?: ChatEngineService['scheduleRuntimeHostVisibleTranscriptProjection'];
        }).scheduleRuntimeHostVisibleTranscriptProjection
        ?? ChatEngineService.prototype['scheduleRuntimeHostVisibleTranscriptProjection']
      );
      scheduleProjection.call(this, targetSessionId, null);
      return;
    }

    const scheduleProjection = (
      (this as unknown as {
        scheduleRuntimeHostVisibleTranscriptProjection?: ChatEngineService['scheduleRuntimeHostVisibleTranscriptProjection'];
      }).scheduleRuntimeHostVisibleTranscriptProjection
      ?? ChatEngineService.prototype['scheduleRuntimeHostVisibleTranscriptProjection']
    );
    scheduleProjection.call(this, targetSessionId, turnResponses);
  }

  private projectRuntimeHostVisibleTurnTranscript(
    sessionId: string,
    turnResponse: TurnResponseTurn,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const turnId = typeof turnResponse?.turnId === 'string' ? turnResponse.turnId.trim() : '';
    if (!targetSessionId || !turnId) {
      return;
    }

    if (!this.shouldProjectRuntimeHostVisibleTurnSnapshot(turnResponse)) {
      return;
    }

    const frames = (this as unknown as {
      runtimeHostVisibleTurnProjectionFrames?: Map<string, {
        readonly handle: number;
        turnsById: Map<string, TurnResponseTurn>;
      }>;
    }).runtimeHostVisibleTurnProjectionFrames;
    const partFrames = (this as unknown as {
      runtimeHostVisiblePartProjectionFrames?: Map<string, {
        readonly handle: number;
        eventsByTurnId: Map<string, ChatRuntimeHostPartTranscriptEvent>;
      }>;
    }).runtimeHostVisiblePartProjectionFrames;

    if (this.isRuntimeHostTerminalTurnResponse(turnResponse)) {
      const existingTurnFrame = frames?.get(targetSessionId);
      if (existingTurnFrame) {
        this.cancelRuntimeHostProjectionHandle(existingTurnFrame.handle);
        frames?.delete(targetSessionId);
        existingTurnFrame.turnsById.set(turnId, turnResponse);
      }
      const existingPartFrame = partFrames?.get(targetSessionId);
      if (existingPartFrame) {
        this.cancelRuntimeHostProjectionHandle(existingPartFrame.handle);
        partFrames?.delete(targetSessionId);
      }
      this.runtimeHostVisibleTurnProjectionLastFlushAt?.set(targetSessionId, this.readRuntimeHostProjectionNow());
      this.projectRuntimeHostVisibleTurnsNow(
        targetSessionId,
        existingTurnFrame ? [...existingTurnFrame.turnsById.values()] : [turnResponse],
      );
      return;
    }

    if (!frames) {
      this.projectRuntimeHostVisibleTurnsNow(targetSessionId, [turnResponse]);
      return;
    }

    const existing = frames.get(targetSessionId);
    if (existing) {
      existing.turnsById.set(turnId, turnResponse);
      return;
    }

    const turnsById = new Map<string, TurnResponseTurn>([[turnId, turnResponse]]);
    const minIntervalMs = 50;
    const now = this.readRuntimeHostProjectionNow();
    const lastFlushAt = this.runtimeHostVisibleTurnProjectionLastFlushAt.get(targetSessionId) ?? 0;
    const delayMs = Math.max(0, minIntervalMs - (now - lastFlushAt));
    const flush = () => {
      const entry = frames.get(targetSessionId);
      frames.delete(targetSessionId);
      if (!entry) {
        return;
      }
      this.runtimeHostVisibleTurnProjectionLastFlushAt.set(targetSessionId, this.readRuntimeHostProjectionNow());
      this.projectRuntimeHostVisibleTurnsNow(targetSessionId, [...entry.turnsById.values()]);
    };
    const handle = delayMs <= 8 && typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(() => flush())
      : globalThis.setTimeout(flush, delayMs) as unknown as number;
    frames.set(targetSessionId, { handle, turnsById });
  }

  private isRuntimeHostTerminalTurnResponse(turnResponse: TurnResponseTurn): boolean {
    const status = turnResponse?.response?.status;
    return status === 'completed' || status === 'cancelled' || status === 'error';
  }

  private shouldProjectRuntimeHostVisibleTurnSnapshot(turnResponse: TurnResponseTurn): boolean {
    if (this.isRuntimeHostTerminalTurnResponse(turnResponse)) {
      return true;
    }

    const turnId = typeof turnResponse?.turnId === 'string' ? turnResponse.turnId.trim() : '';
    if (!turnId) {
      return false;
    }

    // VS Code's chat renderer keeps a stable response item and consumes
    // streaming changes through part-level diffs. Once the visible response
    // item exists, repeated streaming turn snapshots are only model/recovery
    // truth and should not rebuild the visible item tree.
    return !this.visibleTranscriptModel.getResponseItem(turnId);
  }

  private projectRuntimeHostVisiblePartTranscript(
    sessionId: string,
    event: ChatRuntimeHostPartTranscriptEvent,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const turnId = typeof event.turnId === 'string' ? event.turnId.trim() : '';
    if (!targetSessionId || !turnId || !Array.isArray(event.parts) || event.parts.length === 0) {
      return;
    }

    const frames = (this as unknown as {
      runtimeHostVisiblePartProjectionFrames?: Map<string, {
        readonly handle: number;
        eventsByTurnId: Map<string, ChatRuntimeHostPartTranscriptEvent>;
      }>;
    }).runtimeHostVisiblePartProjectionFrames;
    if (!frames) {
      this.projectRuntimeHostVisiblePartsNow(targetSessionId, [event]);
      return;
    }

    const existing = frames.get(targetSessionId);
    if (existing) {
      const previous = existing.eventsByTurnId.get(turnId);
      existing.eventsByTurnId.set(turnId, previous
        ? this.mergeRuntimeHostPartTranscriptEvent(previous, event)
        : event);
      return;
    }

    const eventsByTurnId = new Map<string, ChatRuntimeHostPartTranscriptEvent>([[turnId, event]]);
    const minIntervalMs = 50;
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const lastFlushAt = this.runtimeHostVisiblePartProjectionLastFlushAt.get(targetSessionId) ?? 0;
    const delayMs = Math.max(0, minIntervalMs - (now - lastFlushAt));
    const flush = () => {
      const entry = frames.get(targetSessionId);
      frames.delete(targetSessionId);
      if (!entry) {
        return;
      }
      this.runtimeHostVisiblePartProjectionLastFlushAt.set(targetSessionId, typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now());
      this.projectRuntimeHostVisiblePartsNow(targetSessionId, [...entry.eventsByTurnId.values()]);
    };
    const handle = delayMs <= 8 && typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame(() => flush())
      : globalThis.setTimeout(flush, delayMs) as unknown as number;
    frames.set(targetSessionId, { handle, eventsByTurnId });
  }

  private readRuntimeHostProjectionNow(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  private cancelRuntimeHostProjectionHandle(handle: number): void {
    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(handle);
    }
    globalThis.clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  }

  private mergeRuntimeHostPartTranscriptEvent(
    previous: ChatRuntimeHostPartTranscriptEvent,
    event: ChatRuntimeHostPartTranscriptEvent,
  ): ChatRuntimeHostPartTranscriptEvent {
    const mergedParts: TurnResponsePart[] = [];
    const indexByStableKey = new Map<string, number>();

    const appendOrReplace = (part: TurnResponsePart, index: number): void => {
      const key = this.buildRuntimeHostStablePartKey(part, index);
      const existingIndex = key ? indexByStableKey.get(key) : undefined;
      if (typeof existingIndex === 'number') {
        mergedParts[existingIndex] = part;
        return;
      }
      if (key) {
        indexByStableKey.set(key, mergedParts.length);
      }
      mergedParts.push(part);
    };

    previous.parts.forEach(appendOrReplace);
    event.parts.forEach(appendOrReplace);

    return {
      ...event,
      parts: mergedParts,
      turn: event.turn ?? previous.turn,
      status: event.status ?? previous.status,
    };
  }

  private buildRuntimeHostStablePartKey(part: TurnResponsePart, index: number): string {
    const record = part as TurnResponsePart & Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
    const stableValueKeys = [
      'partId',
      'toolCallId',
      'askId',
      'contentRef',
      'processId',
      'outputSessionId',
      'terminalId',
    ];
    for (const key of stableValueKeys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return `${type}:${key}:${value.trim()}`;
      }
    }

    const sourceAgentRole = typeof record['sourceAgentRole'] === 'string' ? record['sourceAgentRole'] : '';
    const subAgentInvocationId = typeof record['subAgentInvocationId'] === 'string' ? record['subAgentInvocationId'] : '';
    const sequence = typeof record['sequence'] === 'number' && Number.isFinite(record['sequence'])
      ? record['sequence']
      : null;
    if (sourceAgentRole || subAgentInvocationId || sequence !== null) {
      return `${type}:scope:${sourceAgentRole}:${subAgentInvocationId}:${sequence ?? index}`;
    }

    return `${type}:index:${index}`;
  }

  private scheduleRuntimeHostVisibleTranscriptProjection(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[] | null,
  ): void {
    const frames = (this as unknown as {
      runtimeHostVisibleTranscriptProjectionFrames?: Map<string, {
        readonly handle: number;
        turnResponses: readonly TurnResponseTurn[] | null;
      }>;
    }).runtimeHostVisibleTranscriptProjectionFrames;
    const cooldown = (this as unknown as {
      runtimeHostVisibleTranscriptProjectionCooldown?: Set<string>;
    }).runtimeHostVisibleTranscriptProjectionCooldown;
    if (!frames || !cooldown) {
      const projectNow = (
        (this as unknown as {
          projectRuntimeHostVisibleTranscriptNow?: ChatEngineService['projectRuntimeHostVisibleTranscriptNow'];
        }).projectRuntimeHostVisibleTranscriptNow
        ?? ChatEngineService.prototype['projectRuntimeHostVisibleTranscriptNow']
      );
      projectNow.call(this, sessionId, turnResponses);
      return;
    }

    const existing = frames.get(sessionId);
    if (existing) {
      if (turnResponses) {
        existing.turnResponses = turnResponses;
      }
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
    const handle = schedule(() => {
      const entry = frames.get(sessionId);
      frames.delete(sessionId);
      cooldown.delete(sessionId);
      if (!entry || !entry.turnResponses) {
        return;
      }
      const projectNow = (
        (this as unknown as {
          projectRuntimeHostVisibleTranscriptNow?: ChatEngineService['projectRuntimeHostVisibleTranscriptNow'];
        }).projectRuntimeHostVisibleTranscriptNow
        ?? ChatEngineService.prototype['projectRuntimeHostVisibleTranscriptNow']
      );
      projectNow.call(this, sessionId, entry.turnResponses);
    });
    frames.set(sessionId, { handle, turnResponses });
  }

  private projectRuntimeHostVisibleTurnsNow(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || turnResponses.length === 0) {
      return;
    }

    const shouldFollow = this.captureRuntimeHostProjectionShouldFollow(targetSessionId);
    for (const turn of turnResponses) {
      this.visibleTranscriptModel.upsertTurnRequest(turn);
      this.visibleTranscriptModel.upsertTurnResponse(turn);
    }
    const changes = this.visibleTranscriptModel.drainChanges();
    if (changes.length === 0) {
      return;
    }
    const patches = this.visibleTranscriptModel.toDialogItemPatches(changes);
    const previousItems = this.dialogItemsCache?.sessionResource === targetSessionId
      ? this.dialogItemsCache.items
      : null;
    const patchedItems = applyVisibleDialogItemPatches(previousItems, patches);
    const items = patchedItems ?? [...this.visibleTranscriptModel.toDialogItems()];
    this.recordVisibleTranscriptPatchProjection(targetSessionId, changes, patches, items.length);

    const model = this.chatSessionModelStore.get(targetSessionId);
    const modelTurnResponses = model?.peekTurnResponsesForProjection() ?? turnResponses;
    const lastTurn = modelTurnResponses[modelTurnResponses.length - 1];
    this.dialogItemsCache = {
      sessionResource: targetSessionId,
      projectionSource: 'model',
      turnResponses: modelTurnResponses,
      turnCount: modelTurnResponses.length,
      lastTurnId: lastTurn?.turnId ?? '',
      lastUpdatedAt: lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1,
      modelRevision: model?.requestListRevision ?? -1,
      items,
    };
    this.visibleProjectionSessionId = targetSessionId;
    if (!this.tryPatchVisibleTranscriptItems(targetSessionId, patches, changes)) {
      this.triggerSyncDetectChanges();
    }
    this.followRuntimeHostVisibleProjection(shouldFollow);
  }

  private projectRuntimeHostVisiblePartsNow(
    sessionId: string,
    events: readonly ChatRuntimeHostPartTranscriptEvent[],
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || events.length === 0) {
      return;
    }

    const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    for (const event of events) {
      const turnId = typeof event.turnId === 'string' ? event.turnId.trim() : '';
      if (!turnId) {
        continue;
      }
      if (event.turn && !this.visibleTranscriptModel.getResponseItem(turnId)) {
        this.visibleTranscriptModel.upsertTurnRequest(event.turn);
        this.visibleTranscriptModel.upsertTurnResponse(event.turn);
        continue;
      }
      this.visibleTranscriptModel.upsertResponseParts(turnId, event.parts);
    }

    const changes = this.visibleTranscriptModel.drainChanges();
    if (changes.length === 0) {
      return;
    }
    const patches = this.visibleTranscriptModel.toDialogItemPatches(changes);
    const previousItems = this.dialogItemsCache?.sessionResource === targetSessionId
      ? this.dialogItemsCache.items
      : null;
    const patchedItems = applyVisibleDialogItemPatches(previousItems, patches);
    const items = patchedItems ?? [...this.visibleTranscriptModel.toDialogItems()];
    this.recordVisibleTranscriptPatchProjection(targetSessionId, changes, patches, items.length);

    const model = this.chatSessionModelStore.get(targetSessionId);
    const modelTurnResponses = model?.peekTurnResponsesForProjection() ?? [];
    const lastTurn = modelTurnResponses[modelTurnResponses.length - 1];
    this.dialogItemsCache = {
      sessionResource: targetSessionId,
      projectionSource: 'model',
      turnResponses: modelTurnResponses,
      turnCount: modelTurnResponses.length,
      lastTurnId: lastTurn?.turnId ?? '',
      lastUpdatedAt: lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1,
      modelRevision: model?.requestListRevision ?? -1,
      items,
    };
    this.visibleProjectionSessionId = targetSessionId;
    if (!this.tryPatchVisibleTranscriptItems(targetSessionId, patches, changes)) {
      this.triggerSyncDetectChanges();
    }
    const elapsedMs = (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()) - startedAt;
    if (elapsedMs >= 32) {
      console.info('[AilyChat][VisiblePartProjectionPerf]', {
        sessionId: targetSessionId,
        eventCount: events.length,
        partCount: events.reduce((count, event) => count + event.parts.length, 0),
        elapsedMs: Math.round(elapsedMs),
      });
    }
  }

  private tryPatchVisibleTranscriptItems(
    sessionId: string,
    patches: readonly ChatVisibleTranscriptDialogItemPatch[],
    changes: readonly ChatVisibleTranscriptChange[],
  ): boolean {
    if (!this._visibleTranscriptItemPatch
      || patches.length === 0
      || changes.length === 0
      || changes.some(change => change.kind === 'removed')) {
      return false;
    }

    return this._visibleTranscriptItemPatch({ sessionId, patches }) === true;
  }

  private captureRuntimeHostProjectionShouldFollow(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }
    const hasVisibleProjection = this.visibleProjectionSessionId === targetSessionId
      && this.dialogItemsCache?.sessionResource === targetSessionId;
    return this.scrollManager.captureAutoScrollState() || !hasVisibleProjection;
  }

  private followRuntimeHostVisibleProjection(shouldFollow: boolean): void {
    if (!shouldFollow) {
      return;
    }
    this.scrollManager.scrollToBottomIfNeeded(true, 'auto');
  }

  handleStreamingMarkdownHeightChange(): void {
    this.scrollManager.handleContentHeightChange();
  }

  private projectRuntimeHostVisibleTranscriptNow(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): void {
    this.lexStream.hydrateTurnResponses?.(sessionId, turnResponses, {
      visibility: 'visibleAttach',
    });
    this.visibleTranscriptModel.replaceFromSessionModel(turnResponses);
    this.dialogItemsCache = null;
    this.visibleProjectionSessionId = sessionId;
    this.triggerSyncDetectChanges();
  }

  private refreshSessionCheckpointTimelineFromRuntimeTranscript(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[] | null,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !turnResponses || turnResponses.length === 0) {
      return;
    }
    const model = this.chatSessionModelStore?.get?.(targetSessionId);
    if (!model) {
      return;
    }
    const getCheckpointTimelineState = (model as unknown as {
      getCheckpointTimelineState?: ChatSessionModel['getCheckpointTimelineState'];
    }).getCheckpointTimelineState;
    const previousTimeline = typeof getCheckpointTimelineState === 'function'
      ? getCheckpointTimelineState.call(model)
      : null;
    if (canRedoSessionCheckpointTimeline(previousTimeline)
      && this.isRuntimeTranscriptStaleCheckpointReplay(previousTimeline, turnResponses)) {
      return;
    }
    this.chatSessionModelStore.settleCheckpointMetadataTransaction(
      targetSessionId,
      turnResponses,
      this.createRuntimeTranscriptCheckpointTimelineState(
        targetSessionId,
        turnResponses,
        previousTimeline,
      ),
    );
  }

  private shouldRefreshRuntimeTranscriptCheckpointTimeline(
    incomingTurnResponses: readonly TurnResponseTurn[] | null | undefined,
    committedTurnResponses: readonly TurnResponseTurn[] | null | undefined,
    options?: {
      readonly authoritativeSnapshot?: boolean;
    },
  ): boolean {
    if (options?.authoritativeSnapshot !== false) {
      return true;
    }

    const turns = Array.isArray(incomingTurnResponses) && incomingTurnResponses.length > 0
      ? incomingTurnResponses
      : Array.isArray(committedTurnResponses)
        ? committedTurnResponses
        : [];
    for (const turn of turns) {
      const status = typeof turn?.response?.status === 'string'
        ? turn.response.status
        : '';
      if (status === 'completed' || status === 'cancelled' || status === 'error') {
        return true;
      }
    }

    return false;
  }

  private createRuntimeTranscriptCheckpointTimelineState(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
    previousTimeline: SessionCheckpointTimelineState | null,
  ): SessionCheckpointTimelineState {
    const metadataByCheckpointId = new Map<string, RequestCheckpointMetadata>();
    const metadataByRequestId = new Map<string, RequestCheckpointMetadata>();
    const metadataByTurnId = new Map<string, RequestCheckpointMetadata>();

    previousTimeline?.checkpoints.forEach(checkpoint => {
      this.rememberRuntimeTranscriptCheckpointMetadata(checkpoint.metadata, {
        metadataByCheckpointId,
        metadataByRequestId,
        metadataByTurnId,
      });
      this.rememberRuntimeTranscriptCheckpointMetadata(
        this.editCheckpointService.getRequestCheckpointMetadataByCheckpointId?.(checkpoint.checkpointId),
        { metadataByCheckpointId, metadataByRequestId, metadataByTurnId },
      );
      this.rememberRuntimeTranscriptCheckpointMetadata(
        this.editCheckpointService.getRequestCheckpointMetadataByRequestId?.(checkpoint.requestId),
        { metadataByCheckpointId, metadataByRequestId, metadataByTurnId },
      );
    });

    turnResponses.forEach((turn, index) => {
      const inlineMetadata = this.readRuntimeTranscriptCheckpointMetadataFromTurn(sessionId, turn, index);
      this.rememberRuntimeTranscriptCheckpointMetadata(inlineMetadata, {
        metadataByCheckpointId,
        metadataByRequestId,
        metadataByTurnId,
      });
      this.rememberRuntimeTranscriptCheckpointMetadata(
        this.editCheckpointService.getRequestCheckpointMetadataByCheckpointId?.(inlineMetadata?.checkpointId),
        { metadataByCheckpointId, metadataByRequestId, metadataByTurnId },
      );
      this.rememberRuntimeTranscriptCheckpointMetadata(
        this.editCheckpointService.getRequestCheckpointMetadataByRequestId?.(inlineMetadata?.requestId),
        { metadataByCheckpointId, metadataByRequestId, metadataByTurnId },
      );
    });

    return createSessionCheckpointTimelineState({
      sessionResource: sessionId,
      turnResponses,
      metadataByCheckpointId,
      metadataByRequestId,
      metadataByTurnId,
    });
  }

  private rememberRuntimeTranscriptCheckpointMetadata(
    metadata: RequestCheckpointMetadata | null | undefined,
    maps: {
      readonly metadataByCheckpointId: Map<string, RequestCheckpointMetadata>;
      readonly metadataByRequestId: Map<string, RequestCheckpointMetadata>;
      readonly metadataByTurnId: Map<string, RequestCheckpointMetadata>;
    },
  ): void {
    if (!metadata) {
      return;
    }
    const checkpointId = this.normalizeRuntimeTranscriptMetadataString(metadata.checkpointId);
    const requestId = this.normalizeRuntimeTranscriptMetadataString(metadata.requestId);
    const turnId = this.normalizeRuntimeTranscriptMetadataString(metadata.turnId);
    if (checkpointId) {
      maps.metadataByCheckpointId.set(checkpointId, metadata);
    }
    if (requestId) {
      maps.metadataByRequestId.set(requestId, metadata);
    }
    if (turnId) {
      maps.metadataByTurnId.set(turnId, metadata);
    }
  }

  private readRuntimeTranscriptCheckpointMetadataFromTurn(
    sessionId: string,
    turn: TurnResponseTurn,
    turnIndex: number,
  ): RequestCheckpointMetadata | null {
    const metadata = turn.request?.metadata;
    const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata as Record<string, unknown>
      : null;
    if (!record) {
      return null;
    }

    const checkpointId = this.normalizeRuntimeTranscriptMetadataString(record['checkpointId']);
    if (!checkpointId) {
      return null;
    }
    const requestId = this.normalizeRuntimeTranscriptMetadataString(record['requestId'])
      || this.normalizeRuntimeTranscriptMetadataString(turn.turnId)
      || checkpointId;
    const checkpointNamespace = this.normalizeRuntimeTranscriptMetadataString(record['checkpointNamespace'])
      || `refs/sessions/${sessionId}`;
    const checkpointTurnIndex = this.normalizeRuntimeTranscriptMetadataIndex(record['checkpointTurnIndex'])
      ?? turnIndex + 1;
    const checkpointRef = this.normalizeRuntimeTranscriptMetadataString(record['checkpointRef']);
    const startCheckpointRef = this.normalizeRuntimeTranscriptMetadataString(record['startCheckpointRef']);
    const additionalCheckpointRefs = this.readRuntimeTranscriptMetadataStringRecord(record['checkpointRefs']);
    const additionalStartCheckpointRefs = this.readRuntimeTranscriptMetadataStringRecord(record['startCheckpointRefs']);

    return {
      source: 'request-metadata',
      checkpointId,
      sessionResource: sessionId,
      requestId,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      checkpointNamespace,
      turnIndex: checkpointTurnIndex,
      ...(startCheckpointRef ? { startCheckpointRef } : {}),
      ...(checkpointRef ? { checkpointRef } : {}),
      ...(additionalStartCheckpointRefs ? { additionalStartCheckpointRefs } : {}),
      ...(additionalCheckpointRefs ? { additionalCheckpointRefs } : {}),
    };
  }

  private normalizeRuntimeTranscriptMetadataString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeRuntimeTranscriptMetadataIndex(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.trunc(value))
      : null;
  }

  private readRuntimeTranscriptMetadataStringRecord(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, this.normalizeRuntimeTranscriptMetadataString(item)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1].length > 0);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  private isRuntimeTranscriptStaleCheckpointReplay(
    timeline: SessionCheckpointTimelineState | null,
    turnResponses: readonly TurnResponseTurn[],
  ): boolean {
    if (!timeline) {
      return false;
    }
    const incomingTurnIds = new Set(
      turnResponses
        .map(turn => typeof turn.turnId === 'string' ? turn.turnId.trim() : '')
        .filter((turnId): turnId is string => turnId.length > 0),
    );
    const timelineTurnIds = new Set(
      timeline.turnResponses
        .map(turn => typeof turn.turnId === 'string' ? turn.turnId.trim() : '')
        .filter((turnId): turnId is string => turnId.length > 0),
    );
    const hiddenTurnIds = getSessionCheckpointHiddenTurnResponses(timeline)
      .map(turn => typeof turn.turnId === 'string' ? turn.turnId.trim() : '')
      .filter((turnId): turnId is string => turnId.length > 0);
    if (hiddenTurnIds.length === 0) {
      return false;
    }
    const incomingHasNewBranchTurn = Array.from(incomingTurnIds).some(turnId => !timelineTurnIds.has(turnId));
    if (incomingHasNewBranchTurn) {
      return false;
    }
    return hiddenTurnIds.every(turnId => incomingTurnIds.has(turnId));
  }

  private syncResolvedActiveModelFromCommittedTranscript(
    sessionId: string,
    committedTurnResponses: readonly TurnResponseTurn[] | null,
  ): void {
    if (!committedTurnResponses || !this.shouldProjectResolvedActiveModelToVisibleOwner(sessionId)) {
      return;
    }

    const syncResolvedActiveModelAfterSuccessfulTurn = this.chatService.syncResolvedActiveModelAfterSuccessfulTurn;
    if (typeof syncResolvedActiveModelAfterSuccessfulTurn !== 'function') {
      return;
    }

    void syncResolvedActiveModelAfterSuccessfulTurn.call(
      this.chatService,
      sessionId,
      committedTurnResponses,
    );
  }

  private applyRuntimeHostSessionStateEvent(
    sessionId: string,
    state: ChatRuntimeHostSessionState,
  ): void {
    const previousState = this.readRuntimeHostSessionState(sessionId);
    const shellStateChanged = createRuntimeHostShellStateKey(previousState, this.runtimeViewId)
      !== createRuntimeHostShellStateKey(state, this.runtimeViewId);
    const requestStateChanged = createRuntimeHostRequestStateKey(previousState, this.runtimeViewId)
      !== createRuntimeHostRequestStateKey(state, this.runtimeViewId);
    const configurationStateChanged = createRuntimeHostConfigurationStateKey(previousState)
      !== createRuntimeHostConfigurationStateKey(state);
    this.rememberRuntimeHostSessionState(state);
    const attachedView = Array.isArray(state.attachedViewIds)
      ? state.attachedViewIds.includes(this.runtimeViewId)
      : false;

    const visibleCurrentSession = attachedView && state.requestInProgress
      ? this.ensureRuntimeEventSessionViewAttached(sessionId)
      : this.resolveCurrentViewSessionResource() === sessionId;
    const status = this.mapRuntimeHostStatusToRuntimeStatus(state.status);
    const stopSession = state.requestInProgress
      ? this.resolveRuntimeHostStopAction(sessionId, state.activeTurnId ?? null)
      : null;
    if (!state.requestInProgress) {
      this.runtimeHostStopActions.delete(sessionId);
    }
    const patch = {
      status,
      requestInProgress: state.requestInProgress,
      attachedView,
      supportsInterruption: state.requestInProgress,
      activeResponseHandle: state.requestInProgress
        ? state.activeTurnId ?? sessionId
        : null,
      stopSession,
      selectedMode: state.selectedMode ?? undefined,
      providerOptions: state.providerOptions ?? undefined,
      currentModel: state.currentModel ?? undefined,
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId,
      patch,
      options: {
        reason: 'state',
        highFrequency: !shellStateChanged,
        listAffecting: shellStateChanged,
      },
    });

    this.traceRuntimeHostStateProjection(sessionId, state, visibleCurrentSession);
    const maybeFlushPendingFollowupAfterSettle = (
      (this as unknown as { maybeFlushPendingFollowupAfterSettle?: ChatEngineService['maybeFlushPendingFollowupAfterSettle'] })
        .maybeFlushPendingFollowupAfterSettle
      ?? ChatEngineService.prototype['maybeFlushPendingFollowupAfterSettle']
    );
    maybeFlushPendingFollowupAfterSettle.call(this, sessionId, state);

    if (visibleCurrentSession && requestStateChanged) {
      this._runtimeRequestStatePatch?.({
        sessionId,
        requestInProgress: state.requestInProgress,
        activeTurnId: state.activeTurnId ?? null,
        previousActiveTurnId: previousState?.activeTurnId ?? null,
      });
    }
    if (visibleCurrentSession && configurationStateChanged) {
      this.triggerSyncDetectChanges();
    }
  }

  private resolveRuntimeHostStopAction(sessionId: string, turnId: string | null): () => void {
    const existing = this.runtimeHostStopActions.get(sessionId);
    if (existing && existing.turnId === turnId) {
      return existing.action;
    }

    const action = () => this.dispatchRuntimeHostCommand('stop runtime turn', (host) => host.stopTurn({
      sessionId,
      turnId,
    }));
    this.runtimeHostStopActions.set(sessionId, { turnId, action });
    return action;
  }

  private ensureRuntimeEventSessionViewAttached(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    if (currentViewSessionResource === targetSessionId) {
      return true;
    }

    const liveSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (liveSessionId !== targetSessionId) {
      return false;
    }

    const viewModel = this.chatSessionViewModelStore.attach(targetSessionId);
    const attached = viewModel?.sessionResource === targetSessionId;
    if (attached) {
      this.dialogItemsCache = null;
      this.triggerSyncDetectChanges();
    }
    if (attached && isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RuntimeHostView]', {
        phase: 'reattach-current-session-view',
        sessionId: targetSessionId,
        previousViewSessionResource: currentViewSessionResource || null,
      });
    }
    return attached;
  }

  private traceRuntimeHostRoute(
    phase: string,
    sessionId: string | null,
    detail: Record<string, unknown>,
  ): void {
    if (this.runtimeHostRouteTraceBudget <= 0 && !isRequestStateTraceEnabled()) {
      return;
    }
    if (!isRequestStateTraceEnabled()) {
      this.runtimeHostRouteTraceBudget -= 1;
    }

    console.info('[AilyChat][RuntimeHostRoute]', {
      phase,
      sessionId,
      viewId: this.runtimeViewId,
      ...detail,
    });

    const scalar = [
      `phase=${phase}`,
      `sessionId=${sessionId || '<none>'}`,
      `viewId=${this.runtimeViewId}`,
      `kind=${typeof detail['kind'] === 'string' ? detail['kind'] : '<none>'}`,
      `currentSessionId=${typeof detail['currentSessionId'] === 'string' && detail['currentSessionId'] ? detail['currentSessionId'] : '<none>'}`,
      `currentViewSessionResource=${typeof detail['currentViewSessionResource'] === 'string' && detail['currentViewSessionResource'] ? detail['currentViewSessionResource'] : '<none>'}`,
      `eventAttached=${String(detail['eventAttached'] ?? '<none>')}`,
      `stateAttached=${String(detail['stateAttached'] ?? '<none>')}`,
      `status=${String(detail['status'] ?? '<none>')}`,
      `requestInProgress=${String(detail['requestInProgress'] ?? '<none>')}`,
      `transcriptTurns=${String(detail['transcriptTurns'] ?? '<none>')}`,
      `transcriptLastTurn=${typeof detail['transcriptLastTurn'] === 'string' && detail['transcriptLastTurn'] ? detail['transcriptLastTurn'] : '<none>'}`,
      `transcriptLastParts=${String(detail['transcriptLastParts'] ?? '<none>')}`,
      `transcriptLastTextLength=${String(detail['transcriptLastTextLength'] ?? '<none>')}`,
    ].join(' ');
    console.info('[AilyChat][RuntimeHostRouteScalar]', scalar);
  }

  private traceRuntimeHostEvent(
    phase: string,
    sessionId: string,
    event: ChatRuntimeHostEvent,
  ): void {
    if (!isRequestStateTraceEnabled()) {
      return;
    }

    console.info('[AilyChat][RuntimeHostEvent]', {
      phase,
      kind: event.kind,
      sessionId,
      revision: event.revision ?? null,
      currentSessionId: this.chatService.currentSessionId || null,
      currentViewSessionResource: this.resolveCurrentViewSessionResource() || null,
      transcriptTurns: event.kind === 'transcript'
        ? event.transcript.turnResponses.length
        : null,
      status: event.kind === 'session-state' || event.kind === 'runtime-status'
        ? event.state.status
        : null,
      requestInProgress: event.kind === 'session-state' || event.kind === 'runtime-status'
        ? event.state.requestInProgress
        : null,
      resourceKind: event.kind === 'resource-request'
        ? event.request.kind
        : null,
      resourcePhase: event.kind === 'resource-request'
        ? event.request.phase
        : null,
      resourceId: event.kind === 'resource-request'
        ? event.request.id
        : null,
      resourceLabel: event.kind === 'resource-request'
        ? event.request.label ?? null
        : null,
    });
  }

  private traceRuntimeHostTranscriptProjection(
    sessionId: string,
    incomingTurnResponses: readonly TurnResponseTurn[],
    committedTurnResponses: readonly TurnResponseTurn[] | null,
    visibleCurrentSession: boolean,
  ): void {
    if (!isRequestStateTraceEnabled()) {
      return;
    }

    console.info('[AilyChat][RuntimeHostTranscript]', {
      sessionId,
      incomingTurns: incomingTurnResponses.length,
      committedTurns: committedTurnResponses?.length ?? null,
      visibleCurrentSession,
      currentSessionId: this.chatService.currentSessionId || null,
      currentViewSessionResource: this.resolveCurrentViewSessionResource() || null,
    });
  }

  private traceRuntimeHostStateProjection(
    sessionId: string,
    state: ChatRuntimeHostSessionState,
    visibleCurrentSession: boolean,
  ): void {
    if (!isRequestStateTraceEnabled()) {
      return;
    }

    console.info('[AilyChat][RuntimeHostState]', {
      sessionId,
      status: state.status,
      requestInProgress: state.requestInProgress,
      activeTurnId: state.activeTurnId ?? null,
      attachedViewIds: state.attachedViewIds,
      visibleCurrentSession,
      currentSessionId: this.chatService.currentSessionId || null,
      currentViewSessionResource: this.resolveCurrentViewSessionResource() || null,
    });
  }

  private applyRuntimeHostErrorEvent(
    sessionId: string,
    _error: { readonly code?: string; readonly message: string; readonly retryable?: boolean },
  ): void {
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId,
      patch: {
        status: 'failed',
        requestInProgress: false,
        supportsInterruption: false,
        activeResponseHandle: null,
        stopSession: null,
      },
      options: { reason: 'state', highFrequency: false },
    });
    this.triggerSyncDetectChanges();
  }

  private mapRuntimeHostStatusToRuntimeStatus(
    status: ChatRuntimeHostSessionStatus,
  ): ChatSessionRuntimeState['status'] {
    switch (status) {
      case 'running':
        return 'in_progress';
      case 'needs_input':
      case 'completed':
      case 'cancelled':
      case 'failed':
        return status;
      case 'idle':
      default:
        return null;
    }
  }

  private isRuntimeHostTerminalStatus(status: ChatRuntimeHostSessionStatus): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  }

  private rememberRuntimeHostSessionState(state: ChatRuntimeHostSessionState | null | undefined): void {
    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId.trim() : '';
    if (!sessionId) {
      return;
    }
    this.runtimeHostSessionStates.set(sessionId, state);
  }

  private readRuntimeHostSessionState(sessionId?: string | null): ChatRuntimeHostSessionState | null {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const targetSessionId = explicitSessionId || currentSessionId;
    return targetSessionId ? this.runtimeHostSessionStates.get(targetSessionId) ?? null : null;
  }

  private isRuntimeHostViewAttached(state: ChatRuntimeHostSessionState | null | undefined): boolean {
    return Array.isArray(state?.attachedViewIds) && state.attachedViewIds.includes(this.runtimeViewId);
  }

  private dispatchRuntimeHostCommand(
    operation: string,
    command: (host: ChatRuntimeHost) => Promise<unknown>,
  ): void {
    try {
      void command(this.runtimeHostForView()).catch((error) => {
        console.warn(`[AilyChat][RuntimeHost] Failed to ${operation}:`, error);
      });
    } catch (error) {
      console.warn(`[AilyChat][RuntimeHost] Failed to ${operation}:`, error);
    }
  }

  private async dispatchRuntimeHostCommandAsync(
    operation: string,
    command: (host: ChatRuntimeHost) => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await command(this.runtimeHostForView());
    } catch (error) {
      console.warn(`[AilyChat][RuntimeHost] Failed to ${operation}:`, error);
      throw error;
    }
  }

  private async bindRuntimeViewToHost(
    sessionId: string,
    visibleAttachmentGeneration?: number | null,
  ): Promise<ChatRuntimeHostSessionState> {
    const runtimeHost = this.runtimeHostForView();
    const attachedState = await runtimeHost.attachView(this.runtimeViewId, sessionId, {
      visibleAttachmentGeneration: typeof visibleAttachmentGeneration === 'number'
        ? visibleAttachmentGeneration
        : null,
    });
    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RuntimeHostView]', {
        phase: 'attach-view',
        sessionId,
        viewId: this.runtimeViewId,
        visibleAttachmentGeneration: visibleAttachmentGeneration ?? null,
        status: attachedState.status,
        requestInProgress: attachedState.requestInProgress,
        transcriptRevision: attachedState.transcriptRevision,
        attachedViewIds: attachedState.attachedViewIds,
      });
    }
    this.applyRuntimeHostSessionStateEvent(sessionId, attachedState);
    return attachedState;
  }

  private async attachRuntimeViewToHost(sessionId: string, visibleAttachmentGeneration?: number | null): Promise<void> {
    const runtimeHost = this.runtimeHostForView();
    await this.bindRuntimeViewToHost(sessionId, visibleAttachmentGeneration);

    const transcript = await runtimeHost.readTranscript(sessionId);
    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RuntimeHostView]', {
        phase: 'read-transcript-after-attach',
        sessionId,
        viewId: this.runtimeViewId,
        turns: transcript?.turnResponses?.length ?? 0,
        revision: transcript?.revision ?? null,
      });
    }
    if (transcript?.turnResponses?.length) {
      this.applyRuntimeHostTranscriptEvent(sessionId, transcript.turnResponses, {
        visibleProjection: true,
        authoritativeSnapshot: true,
        revision: transcript.revision,
      });
    }

    const snapshot = await runtimeHost.readInteractionSnapshot(sessionId);
    if (snapshot) {
      const interactionVisibleAttachmentGeneration = typeof visibleAttachmentGeneration === 'number'
        && Number.isFinite(visibleAttachmentGeneration)
        ? visibleAttachmentGeneration
        : this.readVisibleAttachmentGenerationForSession(sessionId);
      this.runtimeInteractionHost.applyHostSnapshot(
        snapshot,
        request => this.dispatchRuntimeHostInteraction(request, interactionVisibleAttachmentGeneration),
      );
    }
  }

  private detachSessionRuntimeView(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    this.dispatchRuntimeHostCommand('detach runtime view', (host) => host.detachView(this.runtimeViewId));
    return true;
  }

  private interruptSessionRuntime(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    void this.interruptSessionRuntimeAsync(targetSessionId);
    return true;
  }

  private async stopRuntimeSessionWithBarrier(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    this.stoppingRuntimeSessionIds.add(targetSessionId);
    try {
      const interrupted = await this.interruptSessionRuntimeAsync(targetSessionId);
      await this.waitForSessionRequestSettle(targetSessionId);
      return interrupted;
    } finally {
      this.stoppingRuntimeSessionIds.delete(targetSessionId);
    }
  }

  private async interruptSessionRuntimeAsync(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    await this.dispatchRuntimeHostCommandAsync('stop runtime turn', (host) => host.stopTurn({
      sessionId: targetSessionId,
      turnId: runtimeState?.activeTurnId ?? null,
    }));
    return true;
  }

  private async waitForSessionRequestSettle(sessionId: string, timeoutMs = 1000): Promise<void> {
    const settlePromise = Promise.resolve(this.awaitRuntimeHostRequestCompletion(sessionId)).then(
      () => undefined,
      () => undefined,
    );

    await Promise.race([
      settlePromise,
      new Promise<void>(resolve => {
        const timerHandle = globalThis.setTimeout(() => resolve(), timeoutMs);
        void settlePromise.finally(() => globalThis.clearTimeout(timerHandle));
      }),
    ]);
  }

  async runE2eWorkspaceFinalizeBoundaryProbe(): Promise<void> {
    const sessionId = await this.ensureSessionReadyForSubmit() ?? this.sessionId;
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      throw new Error('Aily chat E2E terminal boundary probe requires a session.');
    }

    await this.runtimeHostForView().runWorkspaceFinalizeBoundaryProbe(normalizedSessionId);
  }

  private async awaitRuntimeHostRequestCompletion(sessionId: string): Promise<void> {
    await this.runtimeHostForView().awaitRequestCompletion(sessionId);
  }

  private async cancelCurrentRequestForSession(
    sessionResource?: string | null,
    _source?: 'regenerate',
  ): Promise<boolean> {
    const targetSessionId = typeof sessionResource === 'string' && sessionResource.trim().length > 0
      ? sessionResource.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    const requestInProgress = this.readVisibleSessionRequestInProgress(targetSessionId);
    if (!requestInProgress) {
      return true;
    }

    const isVisibleCurrentSession = targetSessionId === this.resolveActiveRuntimeSessionId()
      && this.isWaiting
      && (this.isRuntimeHostViewAttached(runtimeState) || !!this.chatTextareaRef);

    if (isVisibleCurrentSession) {
      await this.stopCoordinator.stopVisibleSession(targetSessionId, {
        applyPendingSwitch: false,
      });
      return true;
    }

    const cancelled = this.interruptSessionRuntime(targetSessionId);
    if (!cancelled) {
      return false;
    }

    await this.waitForSessionRequestSettle(targetSessionId);
    return true;
  }

  private requestStopRuntimeTurn(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const runtimeState = this.readRuntimeHostSessionState(targetSessionId);
    const isVisibleCurrentSession = targetSessionId === this.resolveActiveRuntimeSessionId()
      && this.isWaiting
      && (this.isRuntimeHostViewAttached(runtimeState) || !!this.chatTextareaRef);

    if (isVisibleCurrentSession) {
      this.stoppingRuntimeSessionIds.add(targetSessionId);
      if (isRequestStateTraceEnabled()) {
        console.info('[AilyChat][RequestStateTrace]', {
          phase: 'stop-dispatch',
          action: 'stop',
          sessionId: targetSessionId,
          requestId: runtimeState?.activeTurnId ?? null,
          state: runtimeState?.status ?? 'running',
          interrupted: true,
        });
      }
      void this.stopCoordinator.stopVisibleSession(targetSessionId).finally(() => {
        this.stoppingRuntimeSessionIds.delete(targetSessionId);
      });
      return true;
    }

    this.stoppingRuntimeSessionIds.add(targetSessionId);
    const interrupted = this.interruptSessionRuntime(targetSessionId);
    void this.waitForSessionRequestSettle(targetSessionId).finally(() => {
      this.stoppingRuntimeSessionIds.delete(targetSessionId);
    });
    if (isRequestStateTraceEnabled()) {
      console.info('[AilyChat][RequestStateTrace]', {
        phase: 'stop-dispatch',
        action: 'stop',
        sessionId: targetSessionId,
        requestId: runtimeState?.activeTurnId ?? null,
        state: runtimeState?.status ?? 'running',
        interrupted,
      });
    }
    return interrupted;
  }

  private teardownSessionRuntime(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    this.replacePendingFollowupQueue(targetSessionId, []);
    this.syncPendingFollowupRuntimeState(targetSessionId);
    this.dispatchRuntimeHostCommand('dispose runtime session', (host) => host.disposeSession(targetSessionId));
    return true;
  }

  private disposeRuntimeSessionAction(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    return this.teardownSessionRuntime(targetSessionId);
  }

  disposeSessionRuntime(sessionId?: string | null): boolean {
    return this.disposeRuntimeSessionAction(sessionId);
  }

  deleteSessionAction(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    this.disposeRuntimeSessionAction(targetSessionId);
    this.session.releaseSessionModelReference(targetSessionId);
    this.chatSessionViewModelStore.detach(targetSessionId);
    this.chatSessionModelStore.disposeSession(targetSessionId);
    this.chatSessionItemsService.sessionItemController.deleteChatSessionItem(targetSessionId);
    return true;
  }

  private async attachCurrentSessionView(): Promise<void> {
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    const activeRuntimeSessionId = this.resolveActiveRuntimeSessionId();
    await this.attachSessionView(currentViewSessionResource || activeRuntimeSessionId);
  }

  private attachLocalSessionViewForSubmit(sessionId: string): VisibleTranscriptAttachment | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return null;
    }

    const currentAttachment = this.visibleTranscriptAttachment;
    const attachment = currentAttachment?.sessionId === targetSessionId
      && this.isVisibleTranscriptAttachmentCurrent(currentAttachment)
      ? currentAttachment
      : this.attachVisibleTranscript(targetSessionId);
    if (!attachment) {
      return null;
    }

    const viewModel = this.chatSessionViewModelStore?.attach?.(targetSessionId);
    if (viewModel?.sessionResource !== targetSessionId) {
      return null;
    }
    return attachment;
  }

  private async attachSessionView(sessionId?: string | null): Promise<void> {
    const targetSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return;
    }

    const attachment = this.attachVisibleTranscript(targetSessionId);
    if (!attachment) {
      return;
    }
    const viewModel = this.chatSessionViewModelStore?.attach?.(targetSessionId);
    if (viewModel?.sessionResource !== targetSessionId) {
      console.warn('[AilyChat][RuntimeHostView]', {
        phase: 'attach-view-model-missing',
        sessionId: targetSessionId,
        viewId: this.runtimeViewId,
      });
      return;
    }

    let hostViewAttached = false;
    const attachHostView = async (reason: string): Promise<void> => {
      if (hostViewAttached) {
        return;
      }
      await this.attachRuntimeViewToHost(targetSessionId, attachment.generation);
      hostViewAttached = true;
      traceBackgroundSessionExecution('attach-current-session-view-host-attached', {
        sessionId: targetSessionId,
        reason,
        visibleAttachmentGeneration: attachment.generation,
      });
    };

    await attachHostView('initial-host-snapshot');
    if (!this.isVisibleTranscriptAttachmentCurrent(attachment)) {
      traceBackgroundSessionExecution('attach-current-session-view-stale-after-host-attach', {
        sessionId: targetSessionId,
        visibleAttachmentGeneration: attachment.generation,
      });
      return;
    }

    const hostSessionState = this.readRuntimeHostSessionState(targetSessionId);
    const runtimeState = this.chatSessionRuntimeStore.read(targetSessionId);
    this.projectRuntimeViewOverlayToVisibleServices(runtimeState);
    this.projectRuntimeQuotaOverlayToVisibleServices(runtimeState, targetSessionId);
    await this.syncResolvedActiveModelForSession(targetSessionId);
    if (!this.isVisibleTranscriptAttachmentCurrent(attachment)) {
      traceBackgroundSessionExecution('attach-current-session-view-stale-after-model-sync', {
        sessionId: targetSessionId,
        visibleAttachmentGeneration: attachment.generation,
      });
      return;
    }
    const persistedEntry = this.chatHistoryService.findEntry(targetSessionId);
    const modelTurnResponsesAfterHostAttach = this.chatSessionModelStore?.get?.(targetSessionId)?.turnResponses ?? [];
    const hasActiveRequest = this.readVisibleSessionRequestInProgress(targetSessionId)
      || hostSessionState?.requestInProgress === true;
    const runtimeHasLiveProjection = modelTurnResponsesAfterHostAttach.length > 0;
    const shouldAttachDetachedRuntimeView = !!hostSessionState
      && !this.isRuntimeHostViewAttached(hostSessionState)
      && hasActiveRequest;
    const shouldAttachRunningRuntimeView = !!hostSessionState
      && hasActiveRequest
      && (shouldAttachDetachedRuntimeView || runtimeHasLiveProjection);
    const projectSessionModelToVisibleAttach = (
      (this as unknown as { projectSessionModelToVisibleAttach?: ChatEngineService['projectSessionModelToVisibleAttach'] })
        .projectSessionModelToVisibleAttach
      ?? ChatEngineService.prototype['projectSessionModelToVisibleAttach']
    );
    const projectedSessionModelToVisibleAttach = shouldAttachRunningRuntimeView
      ? false
      : projectSessionModelToVisibleAttach.call(this, targetSessionId, runtimeState);
    const hasVisibleChatViewProjectionForSession = (
      this as unknown as { hasVisibleChatViewProjectionForSession?: (sessionId?: string | null) => boolean }
    ).hasVisibleChatViewProjectionForSession
      ?? ChatEngineService.prototype['hasVisibleChatViewProjectionForSession'];
    const hasVisibleProjection = projectedSessionModelToVisibleAttach
      || hasVisibleChatViewProjectionForSession.call(this, targetSessionId);
    const runtimeProjectionMismatch = !!runtimeState?.hostProjectionState
      && !areProjectionTurnResponsesEquivalent(
        this.hostResponseProjection?.turnResponses,
        runtimeState.hostProjectionState.turnResponses,
      );
    const canRestoreProjection = !!runtimeState || !!hostSessionState || !!persistedEntry;
    const runtimeHostViewAttached = hostSessionState ? this.isRuntimeHostViewAttached(hostSessionState) : false;
    const shouldRestoreProjection = !this.chatService.hasBlankSessionShell
      && !projectedSessionModelToVisibleAttach
      && canRestoreProjection
      && !shouldAttachRunningRuntimeView
      && (!hostSessionState
        || !runtimeHostViewAttached
        || !hasVisibleProjection
        || runtimeProjectionMismatch);

    traceBackgroundSessionExecution('attach-current-session-view', {
      sessionId: targetSessionId,
      hasRuntimeState: !!runtimeState,
      runtimeAttachedView: hostSessionState ? runtimeHostViewAttached : null,
      runtimeRequestInProgress: hostSessionState?.requestInProgress ?? false,
      activeRequestInProgress: hasActiveRequest,
      hasPersistedEntry: !!persistedEntry,
      hasVisibleProjection,
      runtimeProjectionMismatch,
      visibleAttachmentGeneration: attachment.generation,
      shouldAttachDetachedRuntimeView,
      shouldAttachRunningRuntimeView,
      shouldRestoreProjection,
      projectedSessionModelToVisibleAttach,
    });

    if (shouldAttachRunningRuntimeView) {
      const modelTurnResponses = this.chatSessionModelStore?.get?.(targetSessionId)?.turnResponses ?? [];
      const runtimeProjectionState = modelTurnResponses.length > 0
        ? buildRuntimeHostProjectionState(modelTurnResponses)
        : null;
      const runtimeTurnResponses = modelTurnResponses;
      traceBackgroundSessionExecution('attach-current-session-view-reattach-running-runtime', {
        sessionId: targetSessionId,
        requestInProgress: hasActiveRequest,
        runtimeRequestInProgress: hostSessionState?.requestInProgress ?? false,
        runtimeAttachedView: hostSessionState ? runtimeHostViewAttached : null,
        hasRuntimeProjection: runtimeHasLiveProjection,
        modelTurnResponses: modelTurnResponses.length,
        liveRuntimeTurnResponses: 0,
        selectedTurnResponses: runtimeTurnResponses.length,
      });
      const shouldRehydrateRunningRuntimeProjection = runtimeTurnResponses.length > 0;
      if (runtimeProjectionState
        && (shouldRehydrateRunningRuntimeProjection || !hasVisibleProjection || runtimeProjectionMismatch)
        && this.liveHostRequestGraphCache
        && typeof this.triggerSyncDetectChanges === 'function') {
        if (!this.isVisibleTranscriptAttachmentCurrent(attachment)) {
          traceBackgroundSessionExecution('attach-current-session-view-stale-before-runtime-hydrate', {
            sessionId: targetSessionId,
            visibleAttachmentGeneration: attachment.generation,
          });
          return;
        }
        // Go Back can clear or replace the visible lexStream adapter while the runtime keeps
        // streaming. Reattach must rebind live runtime turns to fresh visible message handles so
        // subsequent deltas do not fall back to stale lifecycle handles from the previous view.
        if (runtimeTurnResponses.length > 0) {
          this.lexStream.hydrateTurnResponses(targetSessionId, runtimeTurnResponses, {
            visibility: 'visibleAttach',
          });
        }
        this.visibleProjectionSessionId = targetSessionId;
        this.liveHostRequestGraphCache.replaceState(runtimeProjectionState);
        this.triggerSyncDetectChanges();
      }
      await attachHostView('running-runtime-reattach');
      this.ensureBackgroundSessionCanRerun(targetSessionId);
      this.chatSessionItemsService.scheduleSessionItemRefresh(targetSessionId, 'attach-running-runtime');
      return;
    }

    if (shouldRestoreProjection) {
      traceBackgroundSessionExecution('attach-current-session-view-restore-start', {
        sessionId: targetSessionId,
        reason: {
          runtimeMissing: !runtimeState,
          detachedView: runtimeState?.attachedView === false,
          visibleProjectionMissing: !hasVisibleProjection,
          runtimeProjectionMismatch,
        },
      });
      const restored = await this.hostSessionRestoreBridge.restoreSessionProjection(
        targetSessionId,
        this.getCurrentProjectPath(),
        {
          isCurrent: () => this.isVisibleTranscriptAttachmentCurrent(attachment),
        },
      );
      if (!this.isVisibleTranscriptAttachmentCurrent(attachment)) {
        traceBackgroundSessionExecution('attach-current-session-view-restore-stale-finished', {
          sessionId: targetSessionId,
          visibleAttachmentGeneration: attachment.generation,
          restored,
        });
        return;
      }
      traceBackgroundSessionExecution('attach-current-session-view-restore-finished', {
        sessionId: targetSessionId,
        restored,
      });
      if (restored) {
        this.chatSessionItemsService.scheduleSessionItemRefresh(targetSessionId, 'attach-restore');
      }
      return;
    }

    if (hasVisibleProjection) {
      if (hostSessionState && !runtimeHostViewAttached) {
        traceBackgroundSessionExecution('attach-current-session-view-reattach-runtime-view', {
          sessionId: targetSessionId,
          requestInProgress: hostSessionState.requestInProgress,
        });
        await attachHostView('visible-projection-reattach');
        this.ensureBackgroundSessionCanRerun(targetSessionId);
        this.chatSessionItemsService.scheduleSessionItemRefresh(targetSessionId, 'attach-runtime-view');
      }
      return;
    }

    if (!runtimeState && !persistedEntry) {
      return;
    }

    const restored = await this.hostSessionRestoreBridge.restoreSessionProjection(
      targetSessionId,
      this.getCurrentProjectPath(),
      {
        isCurrent: () => this.isVisibleTranscriptAttachmentCurrent(attachment),
      },
    );
    if (!this.isVisibleTranscriptAttachmentCurrent(attachment)) {
      traceBackgroundSessionExecution('attach-current-session-view-fallback-restore-stale-finished', {
        sessionId: targetSessionId,
        visibleAttachmentGeneration: attachment.generation,
        restored,
      });
      return;
    }
    traceBackgroundSessionExecution('attach-current-session-view-fallback-restore-finished', {
      sessionId: targetSessionId,
      restored,
    });
    if (restored) {
      this.chatSessionItemsService.scheduleSessionItemRefresh(targetSessionId, 'attach-fallback-restore');
    }
  }

  private ensureBackgroundSessionCanRerun(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    this.dispatchRuntimeHostCommand('ensure session can rerun', async (host) => {
      const result = await host.ensureSessionCanRerun(targetSessionId);
      this.traceRuntimeHostRerunReadiness(result);
      if (result.state) {
        this.applyRuntimeHostSessionStateEvent(targetSessionId, result.state);
      }
    });
  }

  private traceRuntimeHostRerunReadiness(result: ChatRuntimeHostRerunReadiness): void {
    if (result.activeRequestInProgress) {
      traceBackgroundSessionExecution('reattach-rerun-check-active', {
        sessionId: result.sessionId,
        requestInProgress: result.state?.requestInProgress ?? true,
        status: result.state?.status ?? null,
        detail: 'host runtime state reports an active request; keep the gate',
      });
      return;
    }

    traceBackgroundSessionExecution(result.staleGateCleared
      ? 'reattach-rerun-check-clear-stale-request-flag'
      : 'reattach-rerun-check-skip-idle', {
      sessionId: result.sessionId,
      requestInProgress: result.state?.requestInProgress ?? false,
      status: result.state?.status ?? null,
      detail: result.staleGateCleared
        ? 'host runtime state cleared stale request gate so session can rerun'
        : 'host runtime state has no active request gate for this session',
    });
  }

  /** Request a frame-coalesced view refresh from zone-external paths. */
  triggerSyncDetectChanges(): void {
    if (!this._syncDetectChanges || this._syncDetectChangesFrame !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;

    this.ngZone.runOutsideAngular(() => {
      this._syncDetectChangesFrame = schedule(() => {
        this._syncDetectChangesFrame = null;
        const callback = this._syncDetectChanges;
        if (!callback) {
          return;
        }
        callback();
      });
    });
  }

  private cancelPendingSyncDetectChanges(): void {
    if (this._syncDetectChangesFrame === null) {
      return;
    }

    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this._syncDetectChangesFrame);
    } else {
      clearTimeout(this._syncDetectChangesFrame as unknown as ReturnType<typeof setTimeout>);
    }
    this._syncDetectChangesFrame = null;
  }

  openSettings(): void {
    this.chatViewState.openSettings();
    this.triggerSyncDetectChanges();
  }

  // ==================== 初始化 / 销毁 ====================

  /**
   * 引擎初始化 — 由 Component 的 ngOnInit 调用
   * @param chatTextareaRef 输入框 ElementRef（用于自动聚焦）
   */
  init(chatTextareaRef: ElementRef | null): void {
    this.chatTextareaRef = chatTextareaRef;
    this.chatService.isWaiting = this.readVisibleSessionRequestInProgress();
    this.prjPath = AilyHost.get().project.currentProjectPath === AilyHost.get().project.projectRootPath
      ? '' : AilyHost.get().project.currentProjectPath;
    this.prjRootPath = AilyHost.get().project.projectRootPath;
    this.refreshSessionProviderOptionsSources();

    this.cleanupSubscriptions();
    this.setupSubscriptions();

    void this.refreshRequestQuotaState();
    void this.attachCurrentSessionView().catch((error) => {
      console.warn('[ChatEngine] Failed to attach current session view on init:', error);
    });

  }

  bindChatTextareaRef(chatTextareaRef: ElementRef | null): void {
    this.chatTextareaRef = chatTextareaRef;
    if (chatTextareaRef) {
      void this.attachCurrentSessionView().catch((error) => {
        console.warn('[ChatEngine] Failed to attach current session view after textarea bind:', error);
      });
    }
  }

  scheduleComposerInputFocus(): void {
    const focusInput = () => {
      if (!this.chatTextareaRef?.nativeElement) {
        return;
      }

      const textarea = this.chatTextareaRef.nativeElement;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    };

    this.triggerSyncDetectChanges();

    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => focusInput());
      return;
    }

    setTimeout(focusInput, 0);
  }

  /**
   * 引擎销毁 — 只清理当前 view/controller 绑定。
   * Runtime/session ownership belongs to ChatRuntimeHost; explicit stop/delete
   * commands are the only paths that may stop or dispose a running session.
   */
  destroy(): void {
    this.cancelPendingSyncDetectChanges();
    this.detachView();
    this.disposeVisibleProjection();
    this.cleanupViewControllerLifecycle();
    this.hostItemLifecyclePerfSnapshotHandle?.dispose?.();
  }

  disposeVisibleProjection(): void {
    this.liveHostRequestGraphCache.clear();
    this.viewAdapter.destroy();
    this.entryPartStore.destroy();
    this.chatService.isWaiting = false;
  }

  private cleanupViewControllerLifecycle(): void {
    const currentSessionId = this.resolveCurrentViewSessionResource();
    const currentSessionActive = this.readVisibleSessionRequestInProgress(currentSessionId);
    if (!currentSessionActive) {
      this.session.saveCurrentSession();
    }
    this.chatHistoryService.flushAll();
    this.chatHistoryService.setLiveSessionProvider(null);
    this.chatHistoryService.setAutoSaveSessionActiveProvider(null);

    this.interaction.destroy();

    this.cleanupSubscriptions();
    this.session.dispose();

    this.viewAdapter.markLastMessageDone();
  }

  // ==================== 订阅管理 ====================

  private setupSubscriptions(): void {
    this.subscriptionCoordinator.setup();
    this.setupRuntimeHostEventSubscription();
    this.chatViewState.setAvailableAgentModes(this.chatService.availableResolvedCustomModes);
    this.runtimeModeCollectionSubscription = this.chatService.runtimeModeCollection.onDidChange
      .subscribe(() => {
        this.chatViewState.setAvailableAgentModes(this.chatService.availableResolvedCustomModes);
        this.triggerSyncDetectChanges();
      });
    this.contextBudgetStateSubscription = this.contextBudgetViewService.budget$
      .pipe(distinctUntilChanged())
      .subscribe(() => this.triggerSyncDetectChanges());
    this.requestQuotaStateSubscription = this.requestQuotaStateService.requestQuotaSnapshot$
      .pipe(distinctUntilChanged())
      .subscribe(() => this.triggerSyncDetectChanges());
    this.editDiffPreviewRequestSubscription = this.editCheckpointService.diffPreviewRequested$
      .subscribe((summary) => this.triggerAiEditDiffPreview(summary));
  }

  private cleanupSubscriptions(): void {
    this.runtimeHostEventSubscription?.dispose();
    this.runtimeHostEventSubscription = null;
    this.runtimeModeCollectionSubscription?.unsubscribe();
    this.runtimeModeCollectionSubscription = null;
    this.contextBudgetStateSubscription?.unsubscribe();
    this.contextBudgetStateSubscription = null;
    this.requestQuotaStateSubscription?.unsubscribe();
    this.requestQuotaStateSubscription = null;
    this.editDiffPreviewRequestSubscription?.unsubscribe();
    this.editDiffPreviewRequestSubscription = null;
    this.subscriptionCoordinator.cleanup();
  }

  private async flushPendingAutoSend(): Promise<void> {
    if (!this._pendingAutoSendText) {
      return;
    }

    const text = this._pendingAutoSendText;
    this._pendingAutoSendText = null;
    this.inputValue = text;
    setTimeout(() => {
      void (async () => {
        const sessionId = await this.ensureSessionReadyForSubmit();
        if (!sessionId) {
          this.message.warning('无法创建会话，请稍后重试');
          return;
        }
        await this.submitUserText(text, { clearInput: true, sessionId });
      })();
    }, 50);
  }

  async submitUserText(content: string, options?: SubmitUserTextOptions): Promise<void> {
    await this.send('user', content, options?.clearInput ?? true, options?.sessionId, options?.executionSnapshot ?? null);
  }

  async startImplementationFromPlanPart(sessionId?: string | null, planText?: string | null): Promise<void> {
    const targetSessionId = this.resolvePlanHandoffTargetSessionId(sessionId);
    if (!this.canRunPlanHandoff(targetSessionId)) {
      return;
    }

    const normalizedPlanText = this.resolvePlanImplementationText(targetSessionId, planText);
    if (!normalizedPlanText) {
      this.message?.warning?.('没有可实施的计划内容');
      return;
    }

    const executionSnapshot = await this.applyPlanImplementationHandoffTransition(targetSessionId);
    const actionText = this.resolveLocalizedPlanActionText(
      'AILY_CHAT.PLAN_ACTION_START_IMPLEMENTATION',
      PLAN_CHAT_MODE_START_IMPLEMENTATION_PROMPT,
    );
    await this.submitUserText(buildStartImplementationPrompt(actionText), {
      clearInput: false,
      sessionId: targetSessionId,
      executionSnapshot,
    });
  }

  async clearContextAndImplementPlanPart(planText: string, sessionId?: string | null): Promise<void> {
    const sourceSessionId = this.resolvePlanHandoffTargetSessionId(sessionId);
    if (!this.canRunPlanHandoff(sourceSessionId)) {
      return;
    }

    const normalizedPlanText = normalizePlanHandoffText(planText);
    if (!normalizedPlanText) {
      this.message?.warning?.('没有可实施的计划内容');
      return;
    }

    await this.newChat();
    const targetSessionId = await this.ensureSessionReadyForSubmit();
    if (!targetSessionId) {
      this.message?.warning?.('无法创建新会话，请稍后重试');
      return;
    }

    const executionSnapshot = await this.applyPlanImplementationHandoffTransition(targetSessionId);
    await this.submitUserText(buildClearContextImplementationPrompt(normalizedPlanText), {
      clearInput: false,
      sessionId: targetSessionId,
      executionSnapshot,
    });
  }

  async stayInPlanFromPlanPart(sessionId?: string | null): Promise<void> {
    const targetSessionId = this.resolvePlanHandoffTargetSessionId(sessionId);
    if (!this.canRunPlanHandoff(targetSessionId)) {
      return;
    }

    await this.applyRuntimeSelectedModeTransition(targetSessionId, { modeId: 'plan' });
    this.message?.info?.('已保持 Plan 模式，可以继续细化计划');
  }

  async openPlanPartInEditor(planText: string, sessionId?: string | null): Promise<void> {
    const targetSessionId = this.resolvePlanHandoffTargetSessionId(sessionId);
    if (!targetSessionId) {
      this.message?.warning?.('会话不存在，请开始新对话');
      return;
    }

    const normalizedPlanText = normalizePlanHandoffText(planText);
    if (!normalizedPlanText) {
      this.message?.warning?.('没有可打开的计划内容');
      return;
    }

    const host = AilyHost.get();
    if (!host.editor?.showTextDocument) {
      this.message?.warning?.('当前宿主不支持打开计划文件');
      return;
    }

    try {
      const planPath = await this.writePlanPartEditorArtifact(targetSessionId, normalizedPlanText);
      const projectPath = host.project?.currentProjectPath || host.project?.projectRootPath || undefined;
      await Promise.resolve(host.editor.showTextDocument(planPath, { projectPath }));
    } catch (error) {
      console.warn('[AilyChat][Plan] open plan in editor failed', error);
      this.message?.warning?.('打开计划文件失败，请稍后重试');
    }
  }

  private resolvePlanHandoffTargetSessionId(sessionId?: string | null): string {
    return this.resolveRuntimeSessionIdForOwner(sessionId);
  }

  private canRunPlanHandoff(targetSessionId: string): targetSessionId is string {
    if (!targetSessionId) {
      this.message?.warning?.('会话不存在，请开始新对话');
      return false;
    }

    if (this.readVisibleSessionRequestInProgress(targetSessionId)) {
      this.message?.info?.('当前轮次仍在运行，完成后再操作计划');
      return false;
    }

    return true;
  }

  private resolvePlanImplementationText(sessionId: string, planText?: string | null): string {
    const directPlanText = normalizePlanHandoffText(planText);
    if (directPlanText) {
      return directPlanText;
    }

    const turnResponses = this.readSessionTurnResponses(sessionId);
    for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
      const turn = turnResponses[index];
      const topLevelPlanText = extractCompletedPlanPartText((turn as unknown as Record<string, unknown>)['planPart']);
      if (topLevelPlanText) {
        return topLevelPlanText;
      }

      const parts = Array.isArray(turn.response?.parts) ? turn.response.parts : [];
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
        const partPlanText = extractCompletedPlanPartText(parts[partIndex]);
        if (partPlanText) {
          return partPlanText;
        }
      }
    }

    return '';
  }

  private async writePlanPartEditorArtifact(sessionId: string, planText: string): Promise<string> {
    const host = AilyHost.get();
    const dir = host.path.join(host.path.getAppDataPath(), 'chat-plans');
    await mkdirAsync(dir, { recursive: true });
    const fileName = `${sanitizePlanArtifactName(sessionId)}.plan.md`;
    const filePath = host.path.join(dir, fileName);
    await writeFileAsync(filePath, buildPlanEditorArtifactContent(planText), 'utf-8');
    return filePath;
  }

  private sendFromCoordinationContext(sender: string, content: string, clear: boolean = true, sessionId?: string | null): Promise<void> {
    if (sender === 'user') {
      return this.submitUserText(content, { clearInput: clear, sessionId });
    }

    return this.send(sender, content, clear, sessionId);
  }

  // ==================== 辅助方法 ====================

  getCurrentProjectPath(): string {
    return AilyHost.get().project.currentProjectPath !== AilyHost.get().project.projectRootPath
      ? AilyHost.get().project.currentProjectPath : '';
  }

  getKeyInfo = async () => {
    const shell = await AilyHost.get().terminal.getShell();
    return `
<keyinfo>
项目存放根路径(**rootFolder**): ${AilyHost.get().project.projectRootPath || '无'}
当前项目路径(**path**): ${this.getCurrentProjectPath() || '无'}
当前项目库存放路径(**librariesPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() + '/node_modules/@aily-project' : '无'}
appDataPath(**appDataPath**): ${AilyHost.get().path.getAppDataPath() || '无'}
 - 包含SDK文件、编译器工具等，boards.json-开发板列表 libraries.json-库列表 等缓存到此路径
转换库存放路径(**libraryConversionPath**): ${this.getCurrentProjectPath() ? this.getCurrentProjectPath() : (AilyHost.get().path.join(AilyHost.get().path.getAppDataPath(), 'libraries') || '无')}
当前使用的语言(**lang**)： ${AilyHost.get().config.data?.lang || 'zh-cn'}
操作系统(**os**): ${AilyHost.get().platform.type || 'unknown'}
当前命令行终端(**terminal**): ${shell || 'unknown'}
</keyinfo>
<keyinfo>
uses get_hardware_categories tool to get hardware categories before searching boards and libraries.
uses search_boards_libraries tool to search for boards and libraries based on user needs.
Do not create non-existent boards and libraries.
</keyinfo>
`;
  }

  showAiWritingNotice(isWaiting: boolean): void {
    const currentSessionId = typeof this.chatService.currentSessionId === 'string' && this.chatService.currentSessionId.trim().length > 0
      ? this.chatService.currentSessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    this.aiNoticeCoordinator.update(isWaiting, currentSessionId);
  }

  setPaneSessionCommandHandlers(handlers: ChatPaneSessionCommandHandlers | null | undefined): void {
    this.paneSessionCommandHandlers = handlers ? { ...handlers } : {};
  }

  receiveTextFromExternal(text: string, options?: ChatTextOptions): void {
    this.externalInputCoordinator.receiveText(text, options);
  }

  // ==================== 外观方法（转发到 helper） ====================

  saveCurrentSession(): void { this.session.saveCurrentSession(); }
  refreshHistoryList(): void { this.session.refreshHistoryList(); }
  requestSessionListRefresh(input: {
    reason: 'open' | 'entry' | 'reopen' | 'filter' | 'state' | 'runtime' | 'manual' | 'project' | 'service-created' | 'shell';
    scope: 'summary' | 'visible-details' | 'full';
    priority: 'after-paint' | 'normal' | 'idle';
  }): void { this.session.requestSessionListRefresh(input); }
  async switchToSession(
    sessionId: string,
    options?: {
      readonly fallbackProjectPath?: string | null;
    },
  ): Promise<boolean> {
    const switched = await this.session.switchToSession(sessionId, options);
    if (switched) {
      this.scheduleComposerInputFocus();
    }
    return switched;
  }
  preloadSessionModel(
    sessionId: string,
    options?: {
      readonly fallbackProjectPath?: string | null;
    },
  ): Promise<boolean> {
    return this.session.preloadSessionModel(sessionId, options);
  }
  async newChat(): Promise<void> {
    await this.session.newChat();
    this.scheduleComposerInputFocus();
  }
  initializeEntryInventory(): Promise<boolean> { return this.session.initializeEntryInventory(); }
  returnToEntryInventory(options?: { resetInitialization?: boolean; sessionId?: string | null }): Promise<void> {
    return this.session.returnToEntryInventory(options);
  }

  ensureSessionReadyForSubmit(): Promise<string | null> { return this.session.ensureSessionReadyForSubmit(); }
  enterEntryState(options?: { resetInitialization?: boolean; sessionId?: string | null }): void {
    this.session.enterEntryState(options);
  }
  getHistory(): Promise<void> { return this.session.getHistory(); }
  getCurrentTools(): any[] { return this.lexStream.runtime.tools(); }
  getCurrentLLMConfig(): any { return this.lexStream.runtime.llmConfig(); }
  setTurnHostTextDeltaVisibility(turnId: string | null | undefined, visible: boolean): void {
    const targetTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (!targetTurnId) {
      return;
    }
    this.lexStream.setHostItemTextDeltaDeliveryPolicy(
      targetTurnId,
      visible ? null : { delivery: 'suppressed' },
    );
  }

  private resolveLocalizedPlanActionText(key: string, fallback: string): string {
    const translated = this.translate?.instant?.(key);
    if (typeof translated === 'string' && translated !== key && translated.trim().length > 0) {
      return translated.trim();
    }
    return fallback;
  }

  // ==================== 消息发送 ====================

  private async runWithRuntimeSessionOwner<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previousOwner = this.runtimeSessionOwnerOverride;
    this.runtimeSessionOwnerOverride = sessionId;
    try {
      return await action();
    } finally {
      this.runtimeSessionOwnerOverride = previousOwner;
    }
  }

  private resetPreparedUserTurnState(): void {
    if (this.isCompleted) {
      this.isCancelled = false;
      this.isCompleted = false;
    }

    if (this.isCancelled) {
      this.isCancelled = false;
      this.pendingUserInput = false;
      this.activeToolExecutions = 0;
    }
  }

  private projectPreparedUserRequestBeforeHostSubmit(
    sessionId: string,
    prepared: PreparedPendingFollowupRequest,
  ): { readonly turnId: string; readonly visible: boolean } | null {
    const turnId = readPreparedPendingFollowupRequestId(prepared);
    if (!turnId) {
      return null;
    }

    const timestamp = Date.now();
    const requestContent = prepared.llmText.trim();
    const displayContent = prepared.displayText.trim();
    const turn: TurnResponseTurn = {
      turnId,
      request: {
        content: requestContent,
        ...(displayContent && displayContent !== requestContent
          ? { displayContent }
          : {}),
        ...(prepared.requestMetadata
          ? { metadata: clonePendingFollowupRequestMetadata(prepared.requestMetadata) }
          : {}),
      },
      rounds: [],
      response: {
        id: turnId,
        participant: 'main',
        contentReferences: [],
        codeCitations: [],
        progressMessages: [],
        status: 'streaming',
        parts: [],
        resultText: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (!this.appendSessionModelTurnResponse(sessionId, turn)) {
      return null;
    }

    const visible = this.resolveCurrentViewSessionResource() === sessionId;
    if (visible) {
      this.projectRuntimeHostVisibleTurnsNow(sessionId, [turn]);
      this._runtimeRequestStatePatch?.({
        sessionId,
        requestInProgress: true,
        activeTurnId: turnId,
        previousActiveTurnId: this.readRuntimeHostSessionState(sessionId)?.activeTurnId ?? null,
      });
      // The stable response-model insertion is also the execution-active edge.
      // Keep editor background scheduling and visible pending state on this one
      // lifecycle boundary.
      this.isWaiting = true;
    }
    return { turnId, visible };
  }

  private async waitForSubmittedRequestPaint(): Promise<void> {
    await new Promise<void>((resolve) => {
      const schedule = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 16) as unknown as number;
      this.ngZone.runOutsideAngular(() => schedule(() => resolve()));
    });
  }

  private async prepareSubmittedRequestRuntimeDispatch(
    sessionId: string,
    turnId: string,
    visible: boolean,
    viewBindingGeneration: number | null,
    timing: {
      readonly executionStartedAt: number;
      readonly checkpointMs: number;
      readonly projectionStartedAt: number;
      readonly projectionCompletedAt: number;
    },
  ): Promise<void> {
    if (visible) {
      await this.waitForSubmittedRequestPaint();
      const paintObservedAt = performance.now();
      this._submittedRequestPaintObserved?.({
        sessionId,
        turnId,
        checkpointMs: timing.checkpointMs,
        projectionMs: timing.projectionCompletedAt - timing.projectionStartedAt,
        projectionToPaintMs: paintObservedAt - timing.projectionCompletedAt,
        executionToPaintMs: paintObservedAt - timing.executionStartedAt,
      });
    }
    if (viewBindingGeneration === null) {
      return;
    }

    const bindRuntimeViewToHost = (
      (this as unknown as { bindRuntimeViewToHost?: ChatEngineService['bindRuntimeViewToHost'] })
        .bindRuntimeViewToHost
      ?? ChatEngineService.prototype['bindRuntimeViewToHost']
    );
    await bindRuntimeViewToHost.call(this, sessionId, viewBindingGeneration);
  }

  private async executePreparedUserSend(
    runtimeSessionId: string | null | undefined,
    prepared: PreparedPendingFollowupRequest,
    options?: {
      clearInput?: boolean;
      resetPreparedUserTurnState?: boolean;
      executionSnapshot?: HostSubmitExecutionSnapshot | null;
      finalizeRuntimeMetadataAfterPaint?: boolean;
      preparationStartedAt?: number;
    },
  ): Promise<void> {
    const clearInput = options?.clearInput !== false;
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    const targetSessionId = runtimeSessionId || currentViewSessionResource;
    if (!targetSessionId) {
      throw new Error('executePreparedUserSend requires a sessionResource owner.');
    }

    updateAilyChatAgentLoopPendingCount(1);
    try {
      const executionStartedAt = performance.now();
      let submitViewBindingGeneration: number | null = null;
      const isVisibleSessionAttachedForSubmit = (
        (this as unknown as { isVisibleSessionAttachedForSubmit?: ChatEngineService['isVisibleSessionAttachedForSubmit'] })
          .isVisibleSessionAttachedForSubmit
        ?? ChatEngineService.prototype['isVisibleSessionAttachedForSubmit']
      );
      const alreadyAttached = isVisibleSessionAttachedForSubmit.call(this, targetSessionId);
      if (!alreadyAttached) {
        const attachLocalSessionViewForSubmit = (
          (this as unknown as { attachLocalSessionViewForSubmit?: ChatEngineService['attachLocalSessionViewForSubmit'] })
            .attachLocalSessionViewForSubmit
          ?? ChatEngineService.prototype['attachLocalSessionViewForSubmit']
        );
        const attachment = attachLocalSessionViewForSubmit.call(this, targetSessionId);
        if (!attachment) {
          throw new Error('executePreparedUserSend could not attach the local response model.');
        }
        submitViewBindingGeneration = attachment.generation;
      }
      const attachedVisibleSessionId = this.resolveCurrentViewSessionResource();
      if (attachedVisibleSessionId !== targetSessionId) {
        throw new Error('executePreparedUserSend requires the target session to be attached before submit.');
      }

      const checkpointStartedAt = performance.now();
      await this.commitRestoredCheckpointForwardBranchBeforeUserTurn(targetSessionId);
      const checkpointMs = performance.now() - checkpointStartedAt;
      this.markVisibleSessionProjectionOwner(targetSessionId);

      if (options?.resetPreparedUserTurnState) {
        this.resetPreparedUserTurnState();
      }

      if (isRequestStateTraceEnabled()) {
        console.info('[AilyChat][RequestStateTrace]', {
          phase: 'sending',
          action: 'send',
          sessionId: targetSessionId || null,
          requestId: readPreparedPendingFollowupRequestId(prepared),
          state: this.chatSessionRuntimeStore?.read?.(targetSessionId || null)?.status
            ?? 'idle',
          sender: 'user',
          displayTextLength: (prepared.displayText || prepared.text).trim().length,
          requestTextLength: prepared.text.trim().length,
        });
      }
      const projectionStartedAt = performance.now();
      const submittedRequestProjection = this.projectPreparedUserRequestBeforeHostSubmit(targetSessionId, prepared);
      const projectionCompletedAt = performance.now();
      traceBackgroundSessionExecution('send-turn-begin', {
        runtimeSessionId,
        sender: 'user',
      });
      if (clearInput) {
        this.setSessionInputValue(targetSessionId, '');
        const textarea = this.chatTextareaRef?.nativeElement as HTMLTextAreaElement | undefined;
        if (textarea && textarea.value) {
          textarea.value = '';
        }
      }
      // VS Code inserts and paints the request/response list items before the
      // extension host invocation. Bind the worker view after that first paint,
      // but before submitTurn, so deltas cannot race an unbound renderer.
      const prepareSubmittedRequestRuntimeDispatch = (
        (this as unknown as { prepareSubmittedRequestRuntimeDispatch?: ChatEngineService['prepareSubmittedRequestRuntimeDispatch'] })
          .prepareSubmittedRequestRuntimeDispatch
        ?? ChatEngineService.prototype['prepareSubmittedRequestRuntimeDispatch']
      );
      await prepareSubmittedRequestRuntimeDispatch.call(
        this,
        targetSessionId,
        submittedRequestProjection?.turnId ?? readPreparedPendingFollowupRequestId(prepared),
        submittedRequestProjection?.visible === true,
        submitViewBindingGeneration,
        {
          executionStartedAt,
          checkpointMs,
          projectionStartedAt,
          projectionCompletedAt,
        },
      );

      this.session.completeFreshSessionShellBootstrap(targetSessionId);

      const runtimeMetadataStartedAt = performance.now();
      const runtimePrepared = options?.finalizeRuntimeMetadataAfterPaint
        ? this.sendCoordinator.finalizeVisibleSend(prepared, targetSessionId)
        : prepared;
      const runtimeMetadataCompletedAt = performance.now();
      if (options?.finalizeRuntimeMetadataAfterPaint) {
        console.info(
          '[AilyChat][SessionPreparationScalar]',
          [
            `sessionId=${targetSessionId}`,
            `turnId=${readPreparedPendingFollowupRequestId(runtimePrepared) ?? '<none>'}`,
            `submitToRequestPaintMs=${(runtimeMetadataStartedAt - (options.preparationStartedAt ?? executionStartedAt)).toFixed(1)}`,
            `runtimeMetadataMs=${(runtimeMetadataCompletedAt - runtimeMetadataStartedAt).toFixed(1)}`,
            `submitToHostDispatchMs=${(runtimeMetadataCompletedAt - (options.preparationStartedAt ?? executionStartedAt)).toFixed(1)}`,
          ].join(' '),
        );
      }

      traceBackgroundSessionExecution('send-turn-run-start', {
        runtimeSessionId,
      });
      const turnRunStartedAt = Date.now();
      if (isSendDebugTraceEnabled()) {
        console.info('[AilyChat][SendDebug] before turn.run', {
          runtimeSessionId: runtimeSessionId || null,
          requestTextLength: runtimePrepared.text.trim().length,
          displayTextLength: (runtimePrepared.displayText || runtimePrepared.text).trim().length,
        });
      }
      const currentModelSnapshot = this.resolveVisibleCurrentModelSnapshot(targetSessionId);
      const currentServiceSessionId = typeof this.chatService?.currentSessionId === 'string'
        ? this.chatService.currentSessionId.trim()
        : '';
      console.info(
        `[AilyChat][HostSubmitModel] session=${targetSessionId || ''} currentSession=${currentServiceSessionId} model=${currentModelSnapshot?.model ?? ''} preset=${currentModelSnapshot?.presetId ?? ''} name=${currentModelSnapshot?.name ?? ''}`,
      );
      const protocolTruncation = this.peekPendingProtocolTruncation(targetSessionId);
      const selectedModeSnapshot = options?.executionSnapshot?.selectedMode
        ?? this.resolveVisibleSelectedModeSnapshot(targetSessionId);
      const providerOptionsSnapshot = options?.executionSnapshot?.providerOptions
        ?? this.resolveVisibleSessionProviderOptionsSnapshot(targetSessionId);
      const requestMetadata = this.withSubmitExecutionSnapshotMetadata(
        runtimePrepared.requestMetadata ?? null,
        options?.executionSnapshot ?? null,
      );
      const runtimeResolution = this.resolveSubmitRuntimeMode(targetSessionId, providerOptionsSnapshot, requestMetadata ?? null);
      let submittedState: ChatRuntimeHostSessionState;
      try {
        submittedState = await this.runtimeHostForView().submitTurn({
          sessionId: targetSessionId,
          requestText: runtimePrepared.llmText,
          displayText: runtimePrepared.displayText,
          selectedMode: selectedModeSnapshot,
          providerOptions: providerOptionsSnapshot,
          agentRuntimeMode: runtimeResolution.mode,
          agentRuntimeModeSource: runtimeResolution.source,
          currentModel: currentModelSnapshot,
          metadata: this.withHostRuntimeSessionInventoryMetadata(
            targetSessionId,
            requestMetadata ?? null,
            runtimeResolution,
            options?.executionSnapshot ?? null,
          ),
          activeResponseHandle: submittedRequestProjection?.turnId ?? null,
          ...(protocolTruncation ? { protocolTruncation } : {}),
        });
      } catch (error) {
        if (submittedRequestProjection?.visible) {
          this.isWaiting = false;
        }
        throw error;
      }
      this.applyRuntimeHostSessionStateEvent(targetSessionId, submittedState);
      if (protocolTruncation) {
        this.clearPendingProtocolTruncation(targetSessionId);
      }
      if (isSendDebugTraceEnabled()) {
        console.info('[AilyChat][SendDebug] after turn.run', {
          runtimeSessionId: runtimeSessionId || null,
          durationMs: Date.now() - turnRunStartedAt,
        });
      }
    } finally {
      updateAilyChatAgentLoopPendingCount(-1);
    }
  }

  async send(
    sender: string,
    content: string,
    clear: boolean = true,
    sessionId?: string | null,
    executionSnapshot?: HostSubmitExecutionSnapshot | null,
  ): Promise<void> {
    const preparationStartedAt = performance.now();
    await maybeAutoSwitchToDefaultModelAfterRateLimit(this);
    const autoModelCompletedAt = performance.now();

    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeOwnerOverride = typeof this.runtimeSessionOwnerOverride === 'string'
      ? this.runtimeSessionOwnerOverride.trim()
      : '';
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    const currentServiceSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const runtimeSessionId = explicitSessionId
      || runtimeOwnerOverride
      || currentViewSessionResource
      || currentServiceSessionId;
    if (sender === 'user' && !runtimeSessionId) {
      this.message?.warning?.('会话不存在，请开始新对话');
      return;
    }
    if (runtimeSessionId) {
      if (sender === 'user' && this.readVisibleSessionRequestInProgress(runtimeSessionId)) {
        this.queueFollowupMessage(content, runtimeSessionId, { kind: 'queued' });
        traceBackgroundSessionExecution('send-gated-by-runtime-model-before-readiness', {
          runtimeSessionId,
          activeRequestInProgress: true,
        });
        return;
      }
      traceBackgroundSessionExecution('send-gate-check', {
        runtimeSessionId,
        canStartRequest: true,
      });
    }

    const executeSend = async () => {
      const setupStartedAt = performance.now();
      const setupSuggestionService = (this as unknown as {
        chatSetupSuggestionService?: Pick<ChatSetupSuggestionService, 'inspectRequest' | 'markSuggestionPresented'>;
      }).chatSetupSuggestionService;
      const runtimeInteractionHost = (this as unknown as {
        runtimeInteractionHost?: Pick<ChatRuntimeInteractionHostService, 'presentConfirmation'>;
      }).runtimeInteractionHost;
      const shouldCheckTestSetup = sender === 'user'
        && !!runtimeSessionId
        && !this.isWaiting
        && !!setupSuggestionService?.inspectRequest
        && !!setupSuggestionService?.markSuggestionPresented
        && !!runtimeInteractionHost?.presentConfirmation;
      const effectiveContent = shouldCheckTestSetup
        ? await this.maybeRewriteContentForTestSetup(sender, content, runtimeSessionId)
        : content;
      const setupCompletedAt = performance.now();

      const prepared = this.sendCoordinator.prepareVisibleSend(sender, effectiveContent, {
        sessionId: runtimeSessionId,
      });
      const visibleEnvelopeCompletedAt = performance.now();
      if (!prepared) return;

      if (isRequestStateTraceEnabled()) {
        console.info(
          '[AilyChat][SendExecuteScalar]',
          [
            'phase=prepared',
            `sessionId=${runtimeSessionId || '<none>'}`,
            `sender=${sender}`,
            `requestId=${readPreparedPendingFollowupRequestId(prepared) ?? '<none>'}`,
            `hasInteractionAction=${String(!!prepared.requestMetadata?.['interactionAction'])}`,
            `displayTextLength=${String((prepared.displayText || prepared.text).trim().length)}`,
            `requestTextLength=${String(prepared.text.trim().length)}`,
          ].join(' '),
        );
      }

      const implicitContinueResult = this.trySubmitImplicitContinueInteraction(sender, content, clear, runtimeSessionId, prepared);
      if (implicitContinueResult !== false && await implicitContinueResult) {
        if (isRequestStateTraceEnabled()) {
          console.info(
            '[AilyChat][SendExecuteScalar]',
            [
              'phase=implicit-continue-consumed',
              `sessionId=${runtimeSessionId || '<none>'}`,
              `sender=${sender}`,
            ].join(' '),
          );
        }
        return;
      }
      const implicitContinueCompletedAt = performance.now();

      console.info(
        '[AilyChat][SessionPreparationScalar]',
        [
          `sessionId=${runtimeSessionId || '<none>'}`,
          `turnId=${readPreparedPendingFollowupRequestId(prepared) ?? '<none>'}`,
          `autoModelMs=${(autoModelCompletedAt - preparationStartedAt).toFixed(1)}`,
          `setupMs=${(setupCompletedAt - setupStartedAt).toFixed(1)}`,
          `visibleEnvelopeMs=${(visibleEnvelopeCompletedAt - setupCompletedAt).toFixed(1)}`,
          `implicitContinueMs=${(implicitContinueCompletedAt - visibleEnvelopeCompletedAt).toFixed(1)}`,
          `preExecutionTotalMs=${(implicitContinueCompletedAt - preparationStartedAt).toFixed(1)}`,
        ].join(' '),
      );

      if (sender === 'user') {
        this.configService?.scheduleHardwareIndexRefreshForAI?.('chat-send-latest');
      }

      await this.executePreparedUserSend(runtimeSessionId, prepared, {
        clearInput: clear,
        executionSnapshot,
        finalizeRuntimeMetadataAfterPaint: true,
        preparationStartedAt,
      });
      if (isRequestStateTraceEnabled()) {
        console.info(
          '[AilyChat][SendExecuteScalar]',
          [
            'phase=submit-dispatched',
            `sessionId=${runtimeSessionId || '<none>'}`,
            `sender=${sender}`,
            `requestId=${readPreparedPendingFollowupRequestId(prepared) ?? '<none>'}`,
          ].join(' '),
        );
      }
    };

    if (runtimeSessionId) {
      await this.runWithRuntimeSessionOwner(runtimeSessionId, executeSend);
      return;
    }

    await executeSend();
  }

  private applyDefaultSessionTitleIfNeeded(content: string, sessionId?: string | null): void {
    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    const modelStore = (this as unknown as {
      chatSessionModelStore?: Pick<ChatSessionModelStoreService, 'get' | 'updateMetadata'>;
    }).chatSessionModelStore;
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : currentViewSessionResource;
    const targetModel = targetSessionId ? modelStore?.get?.(targetSessionId) : undefined;
    const modelTitle = targetModel?.title;
    const currentTitle = modelTitle
      ? modelTitle.text
      : typeof this.chatService.currentSessionTitle === 'string'
        ? this.chatService.currentSessionTitle
        : '';
    const currentTitleSource = modelTitle?.source ?? this.chatService.currentSessionTitleSource;
    if (isMeaningfulRuntimeSessionTitle(currentTitle)
      && currentTitleSource !== 'default-first-request') {
      if (isSendTitleTraceEnabled()) {
        console.info('[AilyChat][SendTitle]', {
          event: 'skip-default-title-existing-meaningful',
          sessionId: targetSessionId || null,
          currentTitle,
          currentSource: currentTitleSource,
        });
      }
      return;
    }

    const firstUserMessageContent = readFirstUserMessageContentFromTurnResponses(targetModel?.turnResponses)
      ?? (targetSessionId === currentViewSessionResource
        ? readFirstUserMessageContent(this.conversationMessages)
        : undefined);
    const defaultTitle = deriveDefaultSessionTitle(firstUserMessageContent ?? content);
    if (!defaultTitle) {
      if (isSendTitleTraceEnabled()) {
        console.info('[AilyChat][SendTitle]', {
          event: 'skip-default-title-empty',
          sessionId: targetSessionId || null,
          contentLength: typeof content === 'string' ? content.trim().length : 0,
        });
      }
      return;
    }

    if (targetSessionId) {
      modelStore?.updateMetadata?.(targetSessionId, {
        title: {
          text: defaultTitle,
          source: 'default-first-request',
        },
      });
    }

    if (!targetSessionId || targetSessionId === currentViewSessionResource) {
      if (typeof this.chatService.setCurrentSessionTitle === 'function') {
        this.chatService.setCurrentSessionTitle({
          text: defaultTitle,
          source: 'default-first-request',
        });
      } else {
        this.chatService.currentSessionTitle = defaultTitle;
      }
    }
    if (targetSessionId) {
      this.chatSessionItemsService?.sessionItemController?.updateManagedChatSessionItemTitle?.(targetSessionId, {
        text: defaultTitle,
        source: 'default-first-request',
        revision: (!targetSessionId || targetSessionId === currentViewSessionResource) && typeof this.chatService.currentSessionTitleRevision === 'number'
          ? this.chatService.currentSessionTitleRevision
          : undefined,
      });
    }
    if (isSendTitleTraceEnabled()) {
      console.info('[AilyChat][SendTitle]', {
        event: 'apply-default-title',
        sessionId: targetSessionId || null,
        title: defaultTitle,
        source: firstUserMessageContent ? 'first-user-message' : 'current-content',
      });
    }
  }

  private async maybeRewriteContentForTestSetup(
    sender: string,
    content: string,
    sessionId?: string | null,
  ): Promise<string> {
    const setupSuggestionService = (this as unknown as {
      chatSetupSuggestionService?: Pick<ChatSetupSuggestionService, 'inspectRequest' | 'markSuggestionPresented'>;
    }).chatSetupSuggestionService;
    const runtimeInteractionHost = (this as unknown as {
      runtimeInteractionHost?: Pick<ChatRuntimeInteractionHostService, 'presentConfirmation'>;
    }).runtimeInteractionHost;

    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    if (sender !== 'user'
      || !targetSessionId
      || this.isWaiting
      || !setupSuggestionService?.inspectRequest
      || !setupSuggestionService?.markSuggestionPresented
      || !runtimeInteractionHost?.presentConfirmation) {
      return content;
    }

    const suggestion = setupSuggestionService.inspectRequest(content);
    if (!suggestion) {
      return content;
    }

    setupSuggestionService.markSuggestionPresented(suggestion.projectKey);
    const decision = await runtimeInteractionHost.presentConfirmation(targetSessionId, {
      askId: `setup-tests:${suggestion.projectKey}`,
      partId: `setup-tests:${suggestion.projectKey}`,
      toolName: 'setup_tests',
      title: suggestion.title,
      subtitle: suggestion.subtitle,
      message: suggestion.message,
      actions: [],
      primaryScope: 'once',
      primaryLabel: TEST_SETUP_CONFIRMATION_PRIMARY_LABEL,
      primaryTooltip: TEST_SETUP_CONFIRMATION_PRIMARY_TOOLTIP,
      rejectLabel: TEST_SETUP_CONFIRMATION_REJECT_LABEL,
      rejectTooltip: TEST_SETUP_CONFIRMATION_REJECT_TOOLTIP,
    });

    return decision.approved ? suggestion.prompt : content;
  }

  private async resumeRestoredInteraction(
    content: string,
    interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
    requestMetadata?: TurnRequest['metadata'],
    sessionId?: string | null,
    executionSnapshot?: HostSubmitExecutionSnapshot | null,
  ): Promise<void> {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeSessionId = explicitSessionId
      || this.resolveActiveRuntimeSessionId();
    const requestInProgress = this.readVisibleSessionRequestInProgress(runtimeSessionId);
    if (!runtimeSessionId || requestInProgress) {
      return;
    }

    const resumeRequestMetadata = {
      ...(requestMetadata ?? {}),
      interactionAction,
    };
    const appliedRequestMetadata = this.sendCoordinator?.applyRuntimeRequestMetadata?.(resumeRequestMetadata, runtimeSessionId)
      ?? this.sendCoordinator?.applyRuntimePromptContext?.(resumeRequestMetadata)
      ?? resumeRequestMetadata;

    updateAilyChatAgentLoopPendingCount(1);
    try {
      const runtimeHost = this.runtimeHostForView();
      const currentModelSnapshot = this.resolveVisibleCurrentModelSnapshot(runtimeSessionId);
      const currentServiceSessionId = typeof this.chatService?.currentSessionId === 'string'
        ? this.chatService.currentSessionId.trim()
        : '';
      console.info(
        `[AilyChat][HostSubmitModel] session=${runtimeSessionId || ''} currentSession=${currentServiceSessionId} model=${currentModelSnapshot?.model ?? ''} preset=${currentModelSnapshot?.presetId ?? ''} name=${currentModelSnapshot?.name ?? ''}`,
      );
      const selectedModeSnapshot = executionSnapshot?.selectedMode
        ?? this.resolveVisibleSelectedModeSnapshot(runtimeSessionId);
      const providerOptionsSnapshot = executionSnapshot?.providerOptions
        ?? this.resolveVisibleSessionProviderOptionsSnapshot(runtimeSessionId);
      const requestMetadata = this.withSubmitExecutionSnapshotMetadata(
        appliedRequestMetadata,
        executionSnapshot ?? null,
      );
      const runtimeResolution = this.resolveSubmitRuntimeMode(runtimeSessionId, providerOptionsSnapshot, requestMetadata ?? null);
      const submittedState = await runtimeHost.submitTurn({
        sessionId: runtimeSessionId,
        requestText: content,
        displayText: content,
        selectedMode: selectedModeSnapshot,
        providerOptions: providerOptionsSnapshot,
        agentRuntimeMode: runtimeResolution.mode,
        agentRuntimeModeSource: runtimeResolution.source,
        currentModel: currentModelSnapshot,
        metadata: this.withHostRuntimeSessionInventoryMetadata(
          runtimeSessionId,
          requestMetadata,
          runtimeResolution,
          executionSnapshot ?? null,
        ),
        activeResponseHandle: null,
      });
      this.applyRuntimeHostSessionStateEvent(runtimeSessionId, submittedState);
    } finally {
      updateAilyChatAgentLoopPendingCount(-1);
    }
  }

  private async submitSessionInteractionActionRequest(
    sessionId: string | null | undefined,
    content: string,
    interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
    requestMetadata?: TurnRequest['metadata'],
    executionSnapshot?: HostSubmitExecutionSnapshot | null,
  ): Promise<void> {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const targetSessionId = explicitSessionId || this.resolveCurrentViewSessionResource();
    if (!targetSessionId) {
      throw new Error('submitSessionInteractionActionRequest requires a sessionResource owner.');
    }

    await this.runWithRuntimeSessionOwner(targetSessionId, async () => {
      await this.resumeRestoredInteraction(
        content,
        interactionAction,
        requestMetadata,
        targetSessionId,
        executionSnapshot,
      );
    });
  }

  private trySubmitImplicitContinueInteraction(
    sender: string,
    content: string,
    clear: boolean,
    sessionId?: string | null,
    preparedRequest?: PreparedPendingFollowupRequest,
  ): false | Promise<boolean> {
    if (sender !== 'user' || !isImplicitContinueInput(content)) {
      return false;
    }
    if (preparedRequest?.requestMetadata?.['interactionAction']) {
      return false;
    }

    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const readLatestInteractionContinuation = (
      this as unknown as {
        readLatestInteractionContinuation?: (sessionId: string) => TurnResponseTurn['response']['continuation'] | undefined;
      }
    ).readLatestInteractionContinuation
      ?? ChatEngineService.prototype['readLatestInteractionContinuation'];
    let continuation: TurnResponseTurn['response']['continuation'] | undefined;
    try {
      continuation = readLatestInteractionContinuation.call(this, targetSessionId);
    } catch {
      return false;
    }
    if (!isContinuableInteractionContinuation(continuation)) {
      return false;
    }

    return this.submitSessionInteractionActionRequest(targetSessionId, '继续', { kind: 'continue' })
      .then(() => {
        if (clear) {
          this.inputValue = '';
          this.triggerSyncDetectChanges();
        }
        return true;
      });
  }

  private readLatestInteractionContinuation(sessionId: string): TurnResponseTurn['response']['continuation'] | undefined {
    const turns = (
      (this as unknown as { readSessionTurnResponses?: (sessionId: string) => readonly TurnResponseTurn[] })
        .readSessionTurnResponses
      ?? ChatEngineService.prototype['readSessionTurnResponses']
    ).call(this, sessionId);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const continuation = turns[index]?.response?.continuation;
      if (continuation) {
        return continuation;
      }
    }

    return undefined;
  }

  private capturePlanReviewTransitionState(sessionId?: string | null): {
    readonly sessionId: string;
    readonly selectedMode: ChatSelectedMode;
    readonly providerOptions: HostSessionProviderOptions;
  } {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const providerOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    return {
      sessionId: targetSessionId,
      selectedMode: this.resolveRuntimeSelectedMode(targetSessionId),
      providerOptions,
    };
  }

  private async restorePlanReviewTransitionState(
    state: {
      readonly sessionId: string;
      readonly selectedMode: ChatSelectedMode;
      readonly providerOptions: HostSessionProviderOptions;
    },
  ): Promise<void> {
    this.rememberRuntimeSessionProviderOptions(state.sessionId, state.providerOptions);
    this.rememberRuntimeSelectedMode(state.sessionId, state.selectedMode);

    const shouldProjectToVisibleOwner = this.shouldProjectRuntimeViewStateToVisibleOwner(state.sessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (!shouldProjectToVisibleOwner) {
      return;
    }

    this.chatService.setCurrentSessionPermissionMode(state.providerOptions.permissionMode);
    this.chatService.setCurrentSessionPermissionProfile?.(state.providerOptions.permissionProfile);
    this.chatService.setCurrentSessionPermissionLevel(state.providerOptions.permissionLevel);
    this.chatService.setCurrentSessionApprovalsReviewer?.(state.providerOptions.approvalsReviewer);
    this.chatService.setCurrentSessionApprovalPolicy?.(state.providerOptions.approvalPolicy);
    this.syncExecutionModeGuidanceNotice(
      state.providerOptions.permissionLevel,
      state.providerOptions.approvalsReviewer,
      state.providerOptions.approvalPolicy,
    );

    if (state.selectedMode.customAgentTarget) {
      await this.switchToCustomAgent(state.selectedMode);
      return;
    }

    await this.switchToMode(state.selectedMode.modeId);
  }

  private async applyPlanImplementationHandoffTransition(
    sessionId: string | null | undefined,
    selectedModeInput?: ChatSelectedMode | null,
    permissionLevelInput?: string | null,
  ): Promise<HostSubmitExecutionSnapshot> {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const selectedMode = normalizeChatSelectedMode(selectedModeInput ?? { modeId: 'agent' });
    const currentProviderOptions = this.resolveVisibleSessionProviderOptionsSnapshot(targetSessionId);
    const permissionLevel = typeof permissionLevelInput === 'string' && permissionLevelInput.trim().length > 0
      ? permissionLevelInput.trim()
      : undefined;
    const providerOptions = normalizeHostSessionProviderOptions({
      ...currentProviderOptions,
      permissionMode: 'default',
      permissionProfile: currentProviderOptions.permissionProfile,
      permissionLevel,
      approvalsReviewer: currentProviderOptions.approvalsReviewer,
      approvalPolicy: currentProviderOptions.approvalPolicy,
    });

    this.rememberRuntimeSessionProviderOptions(targetSessionId, providerOptions);
    await this.applyRuntimeSelectedModeTransition(targetSessionId, selectedMode);

    const shouldProjectToVisibleOwner = this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (shouldProjectToVisibleOwner) {
      this.chatService.setCurrentSessionPermissionMode(providerOptions.permissionMode);
      this.chatService.setCurrentSessionPermissionProfile?.(providerOptions.permissionProfile);
      this.chatService.setCurrentSessionPermissionLevel(providerOptions.permissionLevel);
      this.chatService.setCurrentSessionApprovalsReviewer?.(providerOptions.approvalsReviewer);
      this.chatService.setCurrentSessionApprovalPolicy?.(providerOptions.approvalPolicy);
      this.syncExecutionModeGuidanceNotice(
        providerOptions.permissionLevel,
        providerOptions.approvalsReviewer,
        providerOptions.approvalPolicy,
      );
    }
    this.syncCurrentSessionEntryTargetRuntimeMode(targetSessionId);

    return {
      selectedMode,
      providerOptions,
    };
  }

  private async applyRuntimeSelectedModeTransition(
    sessionId: string | null | undefined,
    selectedMode: ChatSelectedMode,
  ): Promise<void> {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const normalizedMode = this.rememberRuntimeSelectedMode(targetSessionId, selectedMode)
      ?? normalizeChatSelectedMode(selectedMode);

    const shouldProjectToVisibleOwner = this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (!shouldProjectToVisibleOwner) {
      return;
    }

    if (normalizedMode.customAgentTarget) {
      await this.switchToCustomAgent(normalizedMode);
      return;
    }

    await this.switchToMode(normalizedMode.modeId);
  }

  private async applyPlanReviewTransitionBeforeResume(
    sessionId: string | null | undefined,
    pendingReview: PendingPlanReview,
    result: RuntimePlanReviewDecision,
    currentRequestPermissionLevel?: string,
  ): Promise<HostSubmitExecutionSnapshot | null> {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const permissionLevel = resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel);
    const baseProviderOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    const nextProviderOptions = this.rememberRuntimeSessionProviderOptions(targetSessionId, {
      ...baseProviderOptions,
      permissionLevel,
    });

    const shouldProjectToVisibleOwner = this.shouldProjectRuntimeViewStateToVisibleOwner(targetSessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (shouldProjectToVisibleOwner) {
      this.chatService.setCurrentSessionPermissionLevel(permissionLevel);
      this.chatService.setCurrentSessionApprovalsReviewer?.(nextProviderOptions?.approvalsReviewer);
      this.chatService.setCurrentSessionApprovalPolicy?.(nextProviderOptions?.approvalPolicy);
      this.syncExecutionModeGuidanceNotice(
        permissionLevel,
        nextProviderOptions?.approvalsReviewer,
        nextProviderOptions?.approvalPolicy,
      );
    }

    if (!shouldStartImplementationAfterPlanReview(result)) {
      return null;
    }

    const handoff = resolveStartImplementationHandoff(this.resolveRuntimeResolvedMode(targetSessionId));
    if (!handoff) {
      return this.applyPlanImplementationHandoffTransition(targetSessionId, { modeId: 'agent' }, permissionLevel);
    }

    const targetMode = resolveChatSurfaceModeId(handoff.agent);
    if (targetMode) {
      return this.applyPlanImplementationHandoffTransition(targetSessionId, { modeId: targetMode }, permissionLevel);
    }

    return this.applyPlanImplementationHandoffTransition(targetSessionId, {
      modeId: 'agent',
      customAgentTarget: handoff.agent,
    }, permissionLevel);
  }

  private buildLocalizedPlanReviewResumeContent(
    pendingReview: PendingPlanReview,
    result: RuntimePlanReviewDecision,
  ): string {
    const translate = (this as unknown as {
      translate?: Pick<TranslateService, 'instant'>;
    }).translate;
    if (!translate || typeof translate.instant !== 'function') {
      return buildPlanReviewResumeContent(pendingReview, result);
    }

    const actionLabel = this.resolveLocalizedPlanReviewActionLabel(pendingReview, result);
    const feedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';
    const key = feedback.length > 0
      ? actionLabel
        ? 'AILY_CHAT.PLAN_REVIEW_RESUME_FEEDBACK_WITH_ACTION'
        : 'AILY_CHAT.PLAN_REVIEW_RESUME_FEEDBACK'
      : result.approved
        ? actionLabel
          ? 'AILY_CHAT.PLAN_REVIEW_RESUME_APPROVED_WITH_ACTION'
          : 'AILY_CHAT.PLAN_REVIEW_RESUME_APPROVED'
        : actionLabel
          ? 'AILY_CHAT.PLAN_REVIEW_RESUME_REJECTED_WITH_ACTION'
          : 'AILY_CHAT.PLAN_REVIEW_RESUME_REJECTED';
    const translated = translate.instant(key, { action: actionLabel ?? '' });
    return typeof translated === 'string' && translated !== key
      ? translated
      : buildPlanReviewResumeContent(pendingReview, result);
  }

  private resolveLocalizedPlanReviewActionLabel(
    pendingReview: PendingPlanReview,
    result: RuntimePlanReviewDecision,
  ): string | undefined {
    const actionId = typeof result.actionId === 'string' ? result.actionId.trim() : '';
    if (!actionId) {
      return undefined;
    }

    const actionLabelKey = (() => {
      switch (actionId) {
        case START_IMPLEMENTATION_PLAN_REVIEW_ACTION_ID:
        case INTERACTIVE_PLAN_REVIEW_ACTION_ID:
          return 'AILY_CHAT.PLAN_ACTION_START_IMPLEMENTATION';
        case 'autopilot':
          return 'AILY_CHAT.PLAN_REVIEW_ACTION_AUTOPILOT';
        case 'autopilot_fleet':
          return 'AILY_CHAT.PLAN_REVIEW_ACTION_AUTOPILOT_FLEET';
        case EXIT_ONLY_PLAN_REVIEW_ACTION_ID:
          return 'AILY_CHAT.PLAN_REVIEW_ACTION_EXIT_ONLY';
        default:
          return '';
      }
    })();

    if (actionLabelKey) {
      const translated = this.translate?.instant?.(actionLabelKey);
      if (typeof translated === 'string' && translated !== actionLabelKey && translated.trim().length > 0) {
        return translated.trim();
      }
    }

    return pendingReview.actions.find(action => action.id === actionId)?.label ?? actionId;
  }

  private async presentPendingPlanReviewFromLatestContinuation(sessionId?: string | null): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return;
    }

    const turnResponses = this.readSessionTurnResponses(targetSessionId);
    const continuation = this.readLatestInteractionContinuation(targetSessionId);
    const pendingReview = readPendingPlanReview(continuation);
    const currentRequestPermissionLevel = readLatestPlanReviewRequestPermissionLevel(turnResponses);
    if (!continuation || !pendingReview) {
      return;
    }

    const activeReview = this.runtimeInteractionHost.getActivePlanReview(targetSessionId);
    if (activeReview?.id === pendingReview.id) {
      return;
    }

    try {
      const result = currentRequestPermissionLevel === AUTO_PLAN_REVIEW_PERMISSION_LEVEL
        ? resolvePlanReviewAutopilotDecision(pendingReview)
        : await this.runtimeInteractionHost.presentPlanReview(targetSessionId, pendingReview);
      const previousState = this.capturePlanReviewTransitionState(targetSessionId);
      try {
        const executionSnapshot = await this.applyPlanReviewTransitionBeforeResume(
          targetSessionId,
          pendingReview,
          result,
          currentRequestPermissionLevel,
        );
        this.scrollManager?.setScrollLock?.(true);
        this.scrollManager?.resumeFollowBottom?.('auto');
        await this.submitInteractionActionRequest(
          this.buildLocalizedPlanReviewResumeContent(pendingReview, result),
          buildPlanReviewInteractionAction(continuation, result),
          resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel)
            ? {
                modeInfo: {
                  permissionLevel: resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel),
                },
              }
            : undefined,
          targetSessionId,
          executionSnapshot,
        );
      } catch (error) {
        try {
          await this.restorePlanReviewTransitionState(previousState);
        } catch {
          // Best effort: preserve the original interaction failure as the surfaced error.
        }
        throw error;
      }
    } catch {
      return;
    }
  }

  private syncExecutionModeGuidanceNotice(
    permissionLevel: unknown,
    approvalsReviewer: unknown,
    approvalPolicy: unknown,
  ): void {
    this.chatInputNoticeStateService?.syncExecutionModeNotice?.({
      permissionLevel: typeof permissionLevel === 'string' ? permissionLevel : null,
      approvalsReviewer: typeof approvalsReviewer === 'string' ? approvalsReviewer : null,
      approvalPolicy: typeof approvalPolicy === 'string' ? approvalPolicy : null,
    });
  }

  private refreshAuthQuotaStateAfterSuccessfulTurn(sessionId?: string | null): void {
    if (!this.shouldProjectQuotaStateToVisibleOwner(sessionId)) {
      return;
    }
    // Successful turn responses already carry premium_interactions quota data.
    // Avoid a second auth/me quota fetch on every send; user center refreshes on demand.
  }

  private refreshAuthQuotaStateFromHost(): void {
    this.authQuotaStateService.syncAuthSnapshotFromHost();
  }

  private async refreshRequestQuotaState(): Promise<void> {
    await this.requestQuotaStateService.refresh();
  }

  private async syncResolvedActiveModelForSession(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    if (!targetSessionId) {
      return false;
    }

    if (!this.shouldProjectResolvedActiveModelToVisibleOwner(targetSessionId)) {
      return false;
    }

    const runtimeTurnResponses = this.readSessionTurnResponses(targetSessionId);
    if (typeof this.chatService.syncResolvedActiveModelAfterSuccessfulTurn !== 'function') {
      return false;
    }
    await this.chatService.syncResolvedActiveModelAfterSuccessfulTurn(
      targetSessionId,
      runtimeTurnResponses,
    );
    return true;
  }

  private shouldProjectResolvedActiveModelToVisibleOwner(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    const currentViewSessionResource = this.resolveCurrentViewSessionResource();
    return !!currentViewSessionResource && currentViewSessionResource === targetSessionId;
  }

  private acceptLiveRequestQuotaState(sessionId?: string | null): void {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const runtimeTurnResponses = this.readSessionTurnResponses(targetSessionId);
    this.syncRuntimeQuotaOverlayFromTurnResponses(targetSessionId || undefined, runtimeTurnResponses);

    if (!this.shouldProjectQuotaStateToVisibleOwner(targetSessionId || undefined)) {
      return;
    }

    this.requestQuotaStateService.acceptTurnResponseQuotaSnapshot(runtimeTurnResponses);
    this.projectAuthQuotaStateFromRequestQuota();
  }

  private shouldProjectQuotaStateToVisibleOwner(sessionId?: string | null): boolean {
    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    if (!targetSessionId) {
      return false;
    }

    const currentSessionId = this.resolveCurrentViewSessionResource();
    return !!currentSessionId && currentSessionId === targetSessionId;
  }

  private syncRuntimeQuotaOverlayFromTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): ChatSessionRuntimeQuotaOverlay | null {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return null;
    }

    const quotaOverlay = buildRuntimeQuotaOverlayFromTurnResponses(turnResponses);
    if (!quotaOverlay) {
      return null;
    }

    const runtimeStatePatch = {
      quotaOverlay,
      debugSummary: {
        quotaOverlayPresent: true,
        requestQuotaNotice: !!quotaOverlay.requestInputNotice,
        authQuotaProjected: !!quotaOverlay.authQuotaInfo,
      },
    };
    this.chatRuntimeViewMirrorProjection.projectRuntimeState({
      sessionId: targetSessionId,
      patch: runtimeStatePatch,
    });
    return quotaOverlay;
  }

  private projectRuntimeQuotaOverlayToVisibleServices(
    runtimeState: ChatSessionRuntimeState | null | undefined,
    sessionId?: string | null,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (targetSessionId) {
      if (!this.shouldProjectQuotaStateToVisibleOwner(targetSessionId)) {
        return;
      }
    }

    const turnResponses = runtimeState?.turnResponses ?? [];
    const quotaOverlay = runtimeState?.quotaOverlay ?? buildRuntimeQuotaOverlayFromTurnResponses(turnResponses);
    if (!quotaOverlay) {
      this.requestQuotaStateService.clear();
      this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(null);
      return;
    }

    if (turnResponses.length > 0) {
      this.requestQuotaStateService.acceptTurnResponseQuotaSnapshot(turnResponses);
    } else if (quotaOverlay.requestQuotaState) {
      this.requestQuotaStateService.replaceProjectedState(quotaOverlay.requestQuotaState);
    } else {
      this.requestQuotaStateService.clear();
    }
    this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(
      quotaOverlay.requestInputNotice ?? null,
    );
    this.projectAuthQuotaStateFromRequestQuota(
      quotaOverlay.requestQuotaState ?? this.requestQuotaStateService.getSnapshot(),
    );
  }

  private projectAuthQuotaStateFromRequestQuota(
    requestQuotaState: RequestQuotaServiceState | null | undefined = this.requestQuotaStateService.getSnapshot(),
  ): void {
    const quotaInfo = createAuthQuotaInfoFromRequestQuotaState(requestQuotaState);
    if (!quotaInfo) {
      return;
    }

    const hostMetadata = readAuthQuotaStateSnapshot(AilyHost.get().auth.getSnapshot?.() ?? null);
    this.authQuotaStateService.acceptProjectedQuotaInfo(quotaInfo, {
      ...(typeof hostMetadata.plan === 'string' ? { plan: hostMetadata.plan } : {}),
      ...(typeof hostMetadata.serviceTier === 'string' ? { serviceTier: hostMetadata.serviceTier } : {}),
      ...(typeof hostMetadata.subscriptionStatus === 'string'
        ? { subscriptionStatus: hostMetadata.subscriptionStatus }
        : {}),
      ...(typeof hostMetadata.subscriptionEndDate === 'string'
        ? { subscriptionEndDate: hostMetadata.subscriptionEndDate }
        : {}),
    });
  }

  resetChat(): Promise<void> { return this.newChat(); }

  private async requestNewChatFromPane(): Promise<void> {
    const requestNewChat = this.paneSessionCommandHandlers.requestNewChat;
    if (typeof requestNewChat === 'function') {
      await requestNewChat();
      return;
    }

    console.warn('[AilyChat][RuntimeOwner] Missing pane new-chat handler; refusing renderer-local newChat path.');
  }

  // ==================== 停止 ====================

  stop(sessionId?: string | null): boolean {
    return this.requestStopRuntimeTurn(sessionId);
  }

  async stopAndWait(sessionId?: string | null): Promise<boolean> {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    const stopped = this.requestStopRuntimeTurn(targetSessionId);
    if (stopped) {
      await this.waitForSessionRequestSettle(targetSessionId);
    }
    return stopped;
  }

  // ==================== 模式 / 模型切换 ====================

  async switchToModel(model: ModelConfig): Promise<void> {
    await this.switchCoordinator.switchToModel(model);
    this.triggerSyncDetectChanges();
  }

  async switchToMode(mode: string): Promise<void> {
    const wasWaiting = this.isWaiting;
    await this.switchCoordinator.switchToMode(mode);
    if (!wasWaiting) {
      this.syncVisibleSelectedModeToRuntimeOwner();
    }
    this.triggerSyncDetectChanges();
  }

  async switchToCustomAgent(selection: { readonly modeId?: string; readonly customAgentTarget?: string }): Promise<void> {
    const wasWaiting = this.isWaiting;
    await this.switchCoordinator.switchToCustomAgent(selection);
    if (!wasWaiting) {
      this.syncVisibleSelectedModeToRuntimeOwner();
    }
    this.triggerSyncDetectChanges();
  }

  async switchToReasoningEffort(reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>): Promise<void> {
    await this.switchCoordinator.switchToReasoningEffort(reasoningEffort);
    this.triggerSyncDetectChanges();
  }

  async switchToModelConfiguration(
    model: ModelConfig,
    update: { key: string; value: unknown },
  ): Promise<void> {
    await this.switchCoordinator.switchToModelConfiguration(model, update);
  }

  /**
   * 应用延迟的模型/模式切换。
   * 在 turn 完成（finalizeStatelessTurn / stream complete / stop）后调用。
   */
  async applyPendingSwitch(sessionId?: string | null): Promise<void> {
    await this.switchCoordinator.applyPendingSwitch(sessionId);
  }

  // ==================== 任务操作 ====================

  handleTaskActionDetail(detail?: ChatTaskActionDetail): void {
    this.taskActionCoordinator.handle(detail);
  }

  private handleTaskAction(event: ChatTaskActionEvent): void {
    this.handleTaskActionDetail(event.detail);
  }

  async continueConversation(): Promise<void> {
    await this.conversationActionCoordinator.continueConversation();
  }

  async retryLastAction(): Promise<void> {
    await this.conversationActionCoordinator.retryLastAction();
  }

  // ==================== 委托到 EditActionsHelper ====================

  editAndResendFromTurn(target: DialogTurnContext, newText: string, resources: ResourceItem[]): Promise<void> {
    return this.editActions.editAndResendFromTurn(target, newText, resources);
  }

  // ==================== 委托到 UserInteractionHelper ====================

  handleToolApproval(
    request: import('../helpers/tool-approval-ui').ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    return this.interaction.handleToolApproval(request);
  }

  checkToolApprovalPreflight(
    request: import('../helpers/tool-approval-ui').ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    return this.interaction.checkToolApprovalPreflight(request);
  }

  resolveAskUserResponse(answer: string, wasFreeform: boolean, sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : this.resolveCurrentViewSessionResource();
    this.interaction.resolveAskUserResponse(answer, wasFreeform, targetSessionId);
  }

  skipAskUserResponse(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : this.resolveCurrentViewSessionResource();
    this.interaction.skipAskUserResponse(targetSessionId);
  }

  approveToolExecution(
    toolCallId: string,
    scope: 'once' | 'session' | 'workspace' | 'session-all-terminal' | 'session-safe' = 'once',
    actionId?: string,
  ): void {
    this.interaction.approveToolExecution(toolCallId, scope, actionId);
  }

  rejectToolExecution(toolCallId: string, reason?: string): void {
    this.interaction.rejectToolExecution(toolCallId, reason);
  }
}

function deriveDefaultSessionTitle(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }

  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return '';
  }

  const firstLine = normalizedContent.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return '';
  }

  return firstLine.substring(0, 200);
}

function normalizePlanHandoffText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function buildStartImplementationPrompt(actionText: string): string {
  return actionText || PLAN_CHAT_MODE_START_IMPLEMENTATION_PROMPT;
}

function buildClearContextImplementationPrompt(planText: string): string {
  return [
    'A previous agent produced the plan below to accomplish the user\'s task.',
    'Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.',
    '',
    planText,
  ].join('\n');
}

function extractCompletedPlanPartText(value: unknown): string {
  const part = asRecord(value);
  if (!part || part['type'] !== 'plan' || part['status'] !== 'completed') {
    return '';
  }

  const metadata = asRecord(part['metadata']);
  if (
    part['sourceAgentRole'] === 'subagent'
    || typeof part['subAgentInvocationId'] === 'string'
    || typeof part['parentToolCallId'] === 'string'
    || metadata?.['sourceAgentRole'] === 'subagent'
    || typeof metadata?.['subAgentInvocationId'] === 'string'
    || typeof metadata?.['parentToolCallId'] === 'string'
  ) {
    return '';
  }

  return normalizePlanHandoffText(part['text']);
}

function buildPlanEditorArtifactContent(planText: string): string {
  return [
    '# Plan',
    '',
    planText,
    '',
  ].join('\n');
}

function sanitizePlanArtifactName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || `plan-${Date.now()}`;
}

function readFirstUserMessageContent(messages: unknown): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }

  for (const message of messages) {
    const role = typeof (message as { role?: unknown })?.role === 'string'
      ? ((message as { role?: string }).role ?? '').trim().toLowerCase()
      : '';
    if (role !== 'user') {
      continue;
    }

    const content = (message as { content?: unknown })?.content;
    if (typeof content === 'string' && content.trim().length > 0) {
      return content;
    }
  }

  return undefined;
}
function readFirstUserMessageContentFromTurnResponses(turnResponses: readonly unknown[] | null | undefined): string | undefined {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return undefined;
  }

  for (const turnResponse of turnResponses) {
    const request = (turnResponse as { request?: unknown })?.request;
    const direct = readRequestTextContent(request);
    if (direct) {
      return direct;
    }
    if (request && typeof request === 'object') {
      const nested = readRequestTextContent((request as { message?: unknown }).message);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function readRequestTextContent(candidate: unknown): string | undefined {
  const text = typeof candidate === 'string'
    ? candidate
    : candidate && typeof candidate === 'object'
      ? ((candidate as { messageText?: unknown }).messageText
        ?? (candidate as { prompt?: unknown }).prompt
        ?? (candidate as { text?: unknown }).text
        ?? (candidate as { content?: unknown }).content)
      : undefined;

  return typeof text === 'string' && text.trim().length > 0
    ? text
    : undefined;
}

function isMeaningfulRuntimeSessionTitle(title: unknown): boolean {
  if (typeof title !== 'string') {
    return false;
  }

  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return false;
  }

  const loweredTitle = normalizedTitle.toLowerCase();
  if (loweredTitle === 'new chat'
    || loweredTitle === 'new session'
    || loweredTitle === 'current session'
    || loweredTitle === '新对话'
    || loweredTitle === '新会话') {
    return false;
  }

  if (/^untitled(?:\s+chat)?(?:\s*\d+)?$/i.test(normalizedTitle)) {
    return false;
  }

  return !/^lex-\d{6,}$/i.test(normalizedTitle);
}

function isImplicitContinueInput(content: unknown): boolean {
  if (typeof content !== 'string') {
    return false;
  }

  const normalized = content.trim().toLowerCase();
  return normalized === '继续'
    || normalized === '繼續'
    || normalized === 'continue'
    || normalized === 'keep going'
    || normalized === 'go on';
}

function isContinuableInteractionContinuation(
  continuation: TurnResponseTurn['response']['continuation'] | null | undefined,
): boolean {
  if (!continuation || typeof continuation !== 'object') {
    return false;
  }

  const interactionId = typeof continuation.interactionId === 'string'
    ? continuation.interactionId.trim()
    : '';
  const lease = typeof continuation.lease === 'string'
    ? continuation.lease.trim()
    : '';
  if (!interactionId || !lease || !Number.isFinite(continuation.stepIndex)) {
    return false;
  }

  const pendingState = continuation.pendingState && typeof continuation.pendingState === 'object'
    ? continuation.pendingState as Record<string, unknown>
    : undefined;
  const pendingKind = typeof pendingState?.['kind'] === 'string'
    ? pendingState['kind']
    : undefined;
  if (pendingKind && pendingKind !== 'none') {
    return pendingKind === 'continue';
  }

  return false;
}

async function maybeAutoSwitchToDefaultModelAfterRateLimit(engine: {
  chatService?: {
    currentModel?: ModelConfig | null;
    getRateLimitAutoSwitchToAutoEnabled?: () => boolean;
  };
  hostResponseProjection?: HostResponseProjection | null;
  ailyChatConfigService?: {
    getDefaultModelPresetId: () => string;
    resolveSelectablePresetModel: (presetId: string) => ModelConfig | null;
  };
  switchToModel?: (model: ModelConfig) => Promise<void>;
}): Promise<void> {
  if (!engine.chatService?.getRateLimitAutoSwitchToAutoEnabled?.()) {
    return;
  }

  if (isDefaultAutoPresetSelected(engine.chatService.currentModel)) {
    return;
  }

  const latestErrorCode = readLatestErrorCode(engine.hostResponseProjection);
  if (!latestErrorCode?.startsWith('user_model_rate_limited')) {
    return;
  }

  const configService = engine.ailyChatConfigService;
  if (!configService) {
    return;
  }

  const autoModel = configService.resolveSelectablePresetModel(configService.getDefaultModelPresetId());
  if (!autoModel || typeof engine.switchToModel !== 'function') {
    return;
  }

  await engine.switchToModel(autoModel);
}

function readLatestErrorCode(hostProjection: HostResponseProjection | null | undefined): string | undefined {
  const turns = hostProjection?.turnResponses;
  if (!Array.isArray(turns) || turns.length === 0) {
    return undefined;
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const parts = turns[turnIndex]?.response?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }

    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex] as {
        type?: string;
        metadata?: { errorDetails?: { code?: unknown } };
      };
      if (part?.type !== 'error') {
        continue;
      }

      const errorCode = part.metadata?.errorDetails?.code;
      if (typeof errorCode === 'string' && errorCode.trim().length > 0) {
        return errorCode;
      }
    }
  }

  return undefined;
}

function applyVisibleDialogItemPatches(
  previousItems: readonly ChatVisibleTranscriptDialogItem[] | null | undefined,
  patches: readonly ChatVisibleTranscriptDialogItemPatch[],
): ChatVisibleTranscriptDialogItem[] | null {
  if (!previousItems || patches.length === 0) {
    return null;
  }

  const nextItems = [...previousItems];
  for (const patch of patches) {
    if (patch.kind === 'added') {
      const existingIndex = nextItems.findIndex(item => item.id === patch.itemId);
      if (existingIndex >= 0) {
        nextItems[existingIndex] = patch.item;
        continue;
      }
      if (patch.index < 0 || patch.index > nextItems.length) {
        return null;
      }
      nextItems.splice(patch.index, 0, patch.item);
      continue;
    }

    if (patch.kind === 'removed'
      || patch.index < 0
      || patch.index >= nextItems.length
      || nextItems[patch.index]?.id !== patch.itemId) {
      return null;
    }
    nextItems[patch.index] = patch.item;
  }
  return nextItems;
}
