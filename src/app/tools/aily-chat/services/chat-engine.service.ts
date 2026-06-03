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
import { applyAutoDiscountToBillingLabel, isDefaultAutoPresetSelected } from '../helpers/model-billing-label';
import {
  normalizeChatSelectedMode,
  resolveChatCurrentMode,
  resolveChatSurfaceModeId,
  type ChatResolvedMode,
  type ChatResolvedModeHandoff,
  type ChatSelectedMode,
  type ChatSessionPermissionMode,
  type ChatSurfaceModeId,
} from '../core/chat-mode';
import {
  normalizeChatSessionTitleCandidate,
  normalizeChatSessionTitleText,
} from '../core/chat-session-title';

import { AbsAutoSyncService } from './abs-auto-sync.service';
import { EditCheckpointService } from './edit-checkpoint.service';
import { GitWorkspaceCheckpointProviderService } from './git-workspace-checkpoint-provider.service';
import { ScrollManagerService } from './scroll-manager.service';
import { ResourceManagerService } from './resource-manager.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import {
  ChatSessionRuntimeStoreService,
  resolveChatSessionRuntimeCapabilities,
  resolveChatSessionRuntimeConcurrencyScope,
  type ChatSessionRuntimeQuotaOverlay,
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeViewOverlay,
} from './chat-session-runtime-store.service';
import { ChatSessionRuntimeRegistryService } from './chat-session-runtime-registry.service';
import { MenuManagerService } from './menu-manager.service';

import { ChatMessage, ToolCallState, ResourceItem } from '../core/chat-types';
import { AilyHost } from '../core/host';
import { registerAskUserCallback, unregisterAskUserCallback } from '../core/ask-user';
import type { MetricsSnapshot, TurnRequest, TurnResponseTurn } from 'aily-lex/browser';

import { ChatTitleCoordinator } from '../helpers/chat-title-coordinator';
import { ChatTitleRequestService } from '../helpers/chat-title-request.service';
import { MessageDisplayHelper } from '../helpers/message-display.helper';
import { SessionLifecycleHelper } from '../helpers/session-lifecycle.helper';
import { getUserSelectedToolsForRequest } from '../helpers/lex-agent-bootstrap';
import { LexOwnerFacade } from '../helpers/lex-stream.helper';
import { ChatSendCoordinator } from '../helpers/chat-send-coordinator';
import { ChatStopCoordinator } from '../helpers/chat-stop-coordinator';
import { ChatConversationActionCoordinator } from '../helpers/chat-conversation-action-coordinator';
import { ChatAiNoticeCoordinator } from '../helpers/chat-ai-notice-coordinator';
import { ChatExternalInputCoordinator } from '../helpers/chat-external-input-coordinator';
import { ChatSwitchCoordinator } from '../helpers/chat-switch-coordinator';

type VisibleSessionProjectionResetOptions = {
  readonly clearResolvedActiveModel?: boolean;
  readonly clearTurns?: boolean;
  readonly resetContextBudget?: boolean;
  readonly clearEditSummary?: boolean;
  readonly resetToolCallingIteration?: boolean;
  readonly detectChanges?: boolean;
};
import { ChatSubscriptionCoordinator } from '../helpers/chat-subscription-coordinator';
import { ChatTaskActionCoordinator, type ChatTaskActionEvent } from '../helpers/chat-task-action-coordinator';
import { HostSessionRestoreBridge } from '../helpers/host-session-restore-bridge';
import type { HostSessionSaveTarget } from '../helpers/host-session-save-bridge';
import {
  createHostSessionProviderOptionsKey,
  normalizeHostSessionProviderOptions,
  type HostSessionProviderOptions,
} from '../helpers/host-session-input-state';
import { ChatViewAdapter } from './chat-view-adapter';
import { ChatPartStore } from '../core/chat-part-store';
import type { IChatContext } from '../core/chat-context';
import type { DialogTurnContext } from '../core/user-turn-action-target';
import { EditActionsHelper, type RestoreCheckpointConfirmation } from '../helpers/edit-actions.helper';
import { applyCheckpointRestoreVisibility } from '../helpers/checkpoint-restore-visibility';
import {
  buildPlanReviewInteractionAction,
  buildPlanReviewResumeContent,
  readPendingPlanReview,
} from '../helpers/host-session-restore-bridge';
import { UserInteractionHelper } from '../helpers/user-interaction.helper';
import { type ChatDialogViewItem } from '../helpers/chat-dialog-view-items';
import { getTurnResponseResolvedModelName } from '../helpers/turn-response-response-model';
import { UnsaveDialogComponent, type UnsaveDialogData } from '../../../main-window/components/unsave-dialog/unsave-dialog.component';
import {
  applyHostResponseVoteToState,
  buildHostProjectionStateFromPersistedRecord,
  createLiveHostRequestGraphSource,
  LiveHostRequestGraphCache,
  type HostRequestModel,
  type HostResponseProjection,
  type HostResponseVoteDirection,
  type HostTurnResponseState,
} from '../helpers/host-turn-response-state';

const INTERACTIVE_PLAN_REVIEW_ACTION_ID = 'interactive';
const EXIT_ONLY_PLAN_REVIEW_ACTION_ID = 'exit_only';
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

function resolvePlanReviewPermissionMode(
  pendingReview: PendingPlanReview,
  result: RuntimePlanReviewDecision,
): ChatSessionPermissionMode | undefined {
  if (!result.approved) {
    return undefined;
  }

  const selectedAction = findRuntimePlanReviewAction(pendingReview.actions, result.actionId);
  if (selectedAction?.permissionLevel === 'autopilot') {
    return 'default';
  }

  return result.actionId === INTERACTIVE_PLAN_REVIEW_ACTION_ID
    ? 'default'
    : undefined;
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
  const chatService = (engine['chatService'] ?? {}) as {
    readonly currentSessionId?: unknown;
    readonly currentSessionType?: unknown;
  };
  const currentSessionId = typeof chatService.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId || normalizedSessionId === currentSessionId) {
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

  return sessionItemController?.getChatSessionType?.(normalizedSessionId, projectPathHint) ?? '';
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
  const chatService = engine['chatService'] as {
    readonly currentSessionId?: string;
    readonly currentSessionPath?: string;
    readonly currentRemoteProviderHandle?: string;
  } | undefined;
  const currentSessionId = typeof chatService?.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId || normalizedSessionId === currentSessionId) {
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

  return sessionItemController?.getChatSessionProviderOptions?.(normalizedSessionId, projectPathHint) ?? null;
}

function resolveEngineRuntimeSessionRequestRouting(
  engine: Record<string, unknown>,
  sessionId: string,
): { readonly customAgentTarget?: string | null } | null {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  const chatService = engine['chatService'] as {
    readonly currentSessionId?: string;
    readonly currentResolvedMode?: { readonly customAgentTarget?: string | null };
    readonly selectedMode?: { readonly customAgentTarget?: string | null };
  } | undefined;
  const currentSessionId = typeof chatService?.currentSessionId === 'string'
    ? chatService.currentSessionId.trim()
    : '';
  if (!normalizedSessionId || normalizedSessionId === currentSessionId) {
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

  return sessionItemController?.getChatSessionRequestRouting?.(normalizedSessionId, projectPathHint) ?? null;
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
  if (!normalizedSessionId || normalizedSessionId === currentSessionId) {
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

  return sessionItemController?.getChatSessionCustomizationProviderMetadata?.(normalizedSessionId, projectPathHint) ?? null;
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
  pendingReview: PendingPlanReview,
  result: RuntimePlanReviewDecision,
): boolean {
  if (!result.approved) {
    return false;
  }

  if (result.actionId === EXIT_ONLY_PLAN_REVIEW_ACTION_ID) {
    return false;
  }

  if (result.actionId === INTERACTIVE_PLAN_REVIEW_ACTION_ID) {
    return true;
  }

  return findRuntimePlanReviewAction(pendingReview.actions, result.actionId)?.permissionLevel === 'autopilot';
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
  private readonly chatSessionRuntimeStore = inject(ChatSessionRuntimeStoreService);
  private readonly chatSessionRuntimeRegistry = inject(ChatSessionRuntimeRegistryService);

  // ==================== Part-based 消息模型（Phase 1） ====================
  /** Part 存储：与 string-based list[] 并行工作，供 lex-stream 路径使用 */
  readonly partStore = new ChatPartStore();
  private readonly liveHostRequestGraphCache = new LiveHostRequestGraphCache();
  private restoreCheckpointDialogOpen = false;
  private readonly messageDisplayContext = this.createMessageDisplayContext();
  private readonly userInteractionContext = this.createUserInteractionContext();
  private readonly editActionsContext = this.createEditActionsContext();
  private readonly hostSessionRestoreContext = this.createHostSessionRestoreContext();
  private readonly hostSessionRestoreBridge = new HostSessionRestoreBridge(this.hostSessionRestoreContext);
  private readonly sessionLifecycleContext = this.createSessionLifecycleContext();
  private readonly lexOwnerContext = this.createLexOwnerContext();
  private readonly titleCoordinatorContext = this.createTitleCoordinatorContext();
  private readonly stopCoordinatorContext = this.createStopCoordinatorContext();
  private readonly switchCoordinatorContext = this.createSwitchCoordinatorContext();
  private readonly conversationActionCoordinatorContext = this.createConversationActionCoordinatorContext();
  private paneSessionCommandHandlers: ChatPaneSessionCommandHandlers = {};

  // ==================== 辅助类 ====================
  readonly msg = new MessageDisplayHelper(this.messageDisplayContext);
  readonly session = new SessionLifecycleHelper(this.sessionLifecycleContext);
  readonly lexStream = new LexOwnerFacade(this.lexOwnerContext);
  readonly editActions = new EditActionsHelper(this.editActionsContext);
  readonly interaction = new UserInteractionHelper(this.userInteractionContext);
  private readonly titleRequestService = new ChatTitleRequestService(() => {
    const currentModel = this.chatService.currentModel as { isCustom?: boolean; apiKey?: string; baseUrl?: string } | null;
    if (!currentModel?.isCustom) {
      return null;
    }

    const apiKey = typeof currentModel.apiKey === 'string' ? currentModel.apiKey.trim() : '';
    const baseUrl = typeof currentModel.baseUrl === 'string' ? currentModel.baseUrl.trim() : '';
    if (!apiKey || !baseUrl) {
      return null;
    }

    return { apiKey, baseUrl };
  });
  private readonly titleCoordinator = new ChatTitleCoordinator(
    this.titleCoordinatorContext,
    this.titleRequestService,
    (sessionId, title) => this.chatSessionItemsService.sessionItemController.updateManagedChatSessionItemTitle(sessionId, title),
  );
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
  );
  private readonly stopCoordinator = new ChatStopCoordinator(this.stopCoordinatorContext);
  private readonly conversationActionCoordinator = new ChatConversationActionCoordinator(this.conversationActionCoordinatorContext);
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
  private readonly externalInputCoordinator = new ChatExternalInputCoordinator(this, {
    retryLastAction: () => this.retryLastAction(),
    regenerateTurn: () => this.editActions.regenerateTurn(),
    undoLastEdits: () => this.editActions.undoLastEdits(),
    newChat: () => this.requestNewChatFromPane(),
    ensureSessionReadyForSubmit: () => this.ensureSessionReadyForSubmit(),
    focusInput: () => {
      if (this.chatTextareaRef?.nativeElement) {
        const textarea = this.chatTextareaRef.nativeElement;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    },
    schedulePostInputWork: (work) => {
      setTimeout(work, 100);
    },
  });
  private readonly taskActionCoordinator = new ChatTaskActionCoordinator(this.editActions, {
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
  inputValue = '';
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
  /** 只读视图：从 lex TurnManager 派生的消息数组（lex 为唯一 source of truth） */
  get conversationMessages(): any[] {
      return this.lexStream.conversation.messages();
  }

  get dialogItems(): ChatDialogViewItem[] {
    const dialogItems = this.hostResponseProjection
      ? [...this.hostResponseProjection.dialogItems]
      : [];
    const canShowCheckpointRestore = this.editCheckpointService.hasRecoverableCheckpointRestoreRedoTurnResponses?.()
      ?? (this.editCheckpointService.getCheckpointRestoreRedoTurnResponses?.() ?? []).length > 0;
    return applyCheckpointRestoreVisibility(dialogItems, canShowCheckpointRestore);
  }

  get workspaceCheckpointPresentationMode() {
    return this.workspaceCheckpointProvider.getPresentationMode?.() ?? 'compatibility';
  }

  get hostResponseProjection(): HostResponseProjection | null {
    return this.getHostResponseState();
  }

  private getHostResponseState(): HostTurnResponseState | null {
    if (!this.hasVisibleSessionProjectionTarget()) {
      return null;
    }

    const snapshot = this.lexStream.session.snapshot();
    const liveSource = createLiveHostRequestGraphSource(
      () => snapshot,
      this.lexStream.turnResponses,
      this.lexStream.turns.currentId() ?? null,
      this.editCheckpointService.getDisabledRequestBoundaries().map(snapshot => snapshot.turnId),
    );

    return this.liveHostRequestGraphCache.getState(liveSource);
  }

  get hostRequestModel(): HostRequestModel | null {
    if (!this.hasVisibleSessionProjectionTarget()) {
      return null;
    }

    const snapshot = this.lexStream.session.snapshot();
    const liveSource = createLiveHostRequestGraphSource(
      () => snapshot,
      this.lexStream.turnResponses,
      this.lexStream.turns.currentId() ?? null,
      this.editCheckpointService.getDisabledRequestBoundaries().map(snapshot => snapshot.turnId),
    );

    return this.liveHostRequestGraphCache.getRequestModel(liveSource);
  }

  private hasVisibleSessionProjectionTarget(): boolean {
    return typeof this.chatService.currentSessionId === 'string'
      && this.chatService.currentSessionId.trim().length > 0;
  }

  clearSharedHostRequestGraph(): void {
    this.liveHostRequestGraphCache.clear();
  }

  replaceSharedHostProjectionState(state: HostTurnResponseState | null): void {
    this.liveHostRequestGraphCache.replaceState(state);
    this.captureActiveSessionRuntimeState();
    this.acceptLiveRequestQuotaState();
  }

  restoreSharedHostProjectionState(state: HostTurnResponseState | null): void {
    this.liveHostRequestGraphCache.replaceState(state);
    this.captureActiveSessionRuntimeState();
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

    this.replaceSharedHostProjectionState(nextState);
    if (this.sessionId) {
      this.chatHistoryService.markDirty(this.sessionId);
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
  private readonly runtimeSessionProviderOptionOverrides = new Map<string, HostSessionProviderOptions>();
  private readonly runtimeSessionSelectedModeOverrides = new Map<string, ChatSelectedMode>();
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

  // ==================== 外部引用 ====================
  private chatTextareaRef: ElementRef | null = null;

  // ==================== Getters / Setters ====================

  get sessionId() { return this.chatService.currentSessionId; }
  set sessionId(value: string) { this.chatService.currentSessionId = value; }

  get sessionTitle() { return this.chatService.currentSessionTitle; }

  get currentMode() { return this.chatService.currentMode; }

  get currentSessionPermissionMode() {
    return this.resolveRuntimeSessionProviderOptions()?.permissionMode
      ?? this.chatService.currentSessionPermissionMode;
  }

  get currentSessionPermissionLevel() {
    return this.resolveRuntimeSessionProviderOptions()?.permissionLevel
      ?? this.chatService.currentSessionPermissionLevel;
  }

  get currentSessionApprovalsReviewer() {
    return this.resolveRuntimeSessionProviderOptions()?.approvalsReviewer
      ?? this.chatService.currentSessionApprovalsReviewer;
  }

  get currentSessionApprovalPolicy() {
    return this.resolveRuntimeSessionProviderOptions()?.approvalPolicy
      ?? this.chatService.currentSessionApprovalPolicy;
  }

  applyComposerPermissionPreset(action: string, sessionId?: string | null): void {
    const normalizedAction = typeof action === 'string' ? action.trim() : '';
    if (!normalizedAction) {
      return;
    }

    const targetSessionId = this.resolveRuntimeSessionIdForOwner(sessionId);
    const currentProviderOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    let nextProviderOptions: HostSessionProviderOptions | null = null;

    if (normalizedAction === 'permission-default') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'default',
        permissionLevel: undefined,
        approvalsReviewer: 'user',
        approvalPolicy: 'on_request',
      });
    } else if (normalizedAction === 'permission-auto-review') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'default',
        permissionLevel: undefined,
        approvalsReviewer: 'auto_review',
        approvalPolicy: 'on_request',
      });
    } else if (normalizedAction === 'permission-full-access') {
      nextProviderOptions = normalizeHostSessionProviderOptions({
        ...currentProviderOptions,
        permissionMode: 'bypassPermissions',
        permissionLevel: undefined,
        approvalsReviewer: 'user',
        approvalPolicy: 'on_request',
      });
    }

    if (!nextProviderOptions) {
      return;
    }

    this.rememberRuntimeSessionProviderOptions(targetSessionId, nextProviderOptions);
    this.chatService.setCurrentSessionPermissionMode(nextProviderOptions.permissionMode);
    this.chatService.setCurrentSessionPermissionLevel(nextProviderOptions.permissionLevel);
    this.chatService.setCurrentSessionApprovalsReviewer?.(nextProviderOptions.approvalsReviewer);
    this.chatService.setCurrentSessionApprovalPolicy?.(nextProviderOptions.approvalPolicy);
    this.syncExecutionModeGuidanceNotice(
      nextProviderOptions.permissionLevel,
      nextProviderOptions.approvalsReviewer,
      nextProviderOptions.approvalPolicy,
    );
  }

  get currentCustomAgentTarget() { return this.chatService.currentCustomAgentTarget; }

  get selectedMode(): ChatSelectedMode {
    return this.resolveRuntimeSelectedMode();
  }

  get currentResolvedMode(): ChatResolvedMode {
    return this.resolveRuntimeResolvedMode();
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
    return this.currentModelName ?? '';
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
    return this.ailyChatConfigService.buildModelTooltip(this.getSelectedDisplayModel(), {
      maxContextTokens: this.contextBudgetSnapshot?.maxContextTokens,
    });
  }

  get currentModelBillingLabel(): string | undefined {
    const resolvedBillingLabel = this.chatService.resolvedActiveModelBillingLabel;
    if (resolvedBillingLabel) {
      return isDefaultAutoPresetSelected(this.chatService.currentModel)
        ? applyAutoDiscountToBillingLabel(resolvedBillingLabel)
        : resolvedBillingLabel;
    }

    return this.ailyChatConfigService.getModelBillingLabel(this.getSelectedDisplayModel());
  }

  private getSelectedDisplayModel(): ModelConfig | null {
    const activeDisplayModel = this.chatService.getActiveDisplayModel() ?? null;
    if (!activeDisplayModel) {
      return null;
    }

    if (!isDefaultAutoPresetSelected(this.chatService.currentModel)) {
      return activeDisplayModel;
    }

    return {
      ...activeDisplayModel,
      presetId: this.ailyChatConfigService.getDefaultModelPresetId(),
    };
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
    if (value) {
      this.captureActiveSessionRuntimeState();
    } else if (waitingOwnerSessionId) {
      if (this.chatSessionRuntimeRegistry) {
        this.chatSessionRuntimeRegistry.projectRuntimeState(waitingOwnerSessionId, {
          requestInProgress: false,
          supportsInterruption: false,
          activeResponseHandle: null,
          stopSession: null,
          debugSummary: {
            pendingRequest: false,
          },
        });
      } else {
        this.chatSessionRuntimeStore.replaceRuntimeState(waitingOwnerSessionId, {
        requestInProgress: false,
        supportsInterruption: false,
        activeResponseHandle: null,
        stopSession: null,
        debugSummary: {
          pendingRequest: false,
        },
        });
      }
    }
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
    const turnResponses = (
      (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
        .readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
    ).call(this);
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
    const turnResponses = (
      (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
        .readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
    ).call(this);
    return createInteractionBudgetSnapshot(turnResponses);
  }

  get contextCompactionMetricsSnapshot(): MetricsSnapshot | null {
    return this.lexStream.compactionMetricsSnapshot;
  }

  async continueCurrentExecution(): Promise<void> {
    const targetSessionId = (
      (this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string })
        .resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner']
    ).call(this);
    const continuation = this.readLatestInteractionContinuation(targetSessionId);
    const pendingState = continuation?.pendingState && typeof continuation.pendingState === 'object'
      ? continuation.pendingState as Record<string, unknown>
      : null;
    if ((typeof pendingState?.['kind'] === 'string' ? pendingState['kind'] : undefined) !== 'continue') {
      return;
    }

    const submitSessionInteractionActionRequest = (
      this as unknown as {
        submitSessionInteractionActionRequest?: (
          sessionId: string | null | undefined,
          content: string,
          interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
        ) => Promise<void>;
      }
    ).submitSessionInteractionActionRequest
      ?? ChatEngineService.prototype['submitSessionInteractionActionRequest'];
    await submitSessionInteractionActionRequest.call(this, targetSessionId, '继续', { kind: 'continue' });
  }

  async submitInteractionActionRequest(
    content: string,
    interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
    requestMetadata?: TurnRequest['metadata'],
    sessionId?: string | null,
  ): Promise<void> {
    await this.submitSessionInteractionActionRequest(sessionId, content, interactionAction, requestMetadata);
  }

  get requestQuotaSnapshot(): RequestQuotaSnapshot | null {
    return this.requestQuotaStateService.getRequestQuotaSnapshot();
  }

  private createMessageDisplayContext(): ConstructorParameters<typeof MessageDisplayHelper>[0] {
    const thisEngine = this;

    return {
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.list = value; },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get sessionId() { return thisEngine.sessionId; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMessageSource() { return thisEngine.currentMessageSource; },
      get ngZone() { return thisEngine.ngZone; },
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
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
    };
  }

  private createEditActionsContext(): ConstructorParameters<typeof EditActionsHelper>[0] {
    const thisEngine = this;

    return {
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.list = value; },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get sessionId() { return thisEngine.sessionId; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
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
      confirmRestoreCheckpoint: (confirmation) => thisEngine.confirmRestoreCheckpoint(confirmation),
      get hostResponseProjection() { return thisEngine.hostResponseProjection; },
      restoreSharedHostProjectionState: (state) => thisEngine.restoreSharedHostProjectionState(state),
      replaceSharedHostProjectionState: (state) => thisEngine.replaceSharedHostProjectionState(state),
      send: (sender, content, clear) => this.send(sender, content, clear),
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
      set list(value) { thisEngine.list = value; },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      get chatSessionItemsService() { return thisEngine.chatSessionItemsService; },
      captureActiveSessionRuntimeState: () => thisEngine.captureActiveSessionRuntimeState(),
      clearSessionRuntimeState: (sessionId) => thisEngine.clearSessionRuntimeState(sessionId),
      readSessionRuntimeState: (sessionId) => thisEngine.chatSessionRuntimeStore.read(sessionId),
      detachSessionRuntimeView: (sessionId) => thisEngine.detachSessionRuntimeView(sessionId),
      attachCurrentSessionView: () => thisEngine.attachCurrentSessionView(),
      ensureBackgroundSessionCanRerun: (sessionId) => thisEngine.ensureBackgroundSessionCanRerun(sessionId),
      resetVisibleSessionProjection: (options) => thisEngine.resetVisibleSessionProjection(options),
      stopSessionAction: (sessionId) => thisEngine.stopSessionAction(sessionId),
      disposeSessionAction: (sessionId) => thisEngine.disposeSessionAction(sessionId),
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
      get currentModel() { return thisEngine.currentModel; },
      get isLoggedIn() { return thisEngine.isLoggedIn; },
      get prjPath() { return thisEngine.prjPath; },
      get prjRootPath() { return thisEngine.prjRootPath; },
      get contextBudgetService() { return thisEngine.contextBudgetService; },
      get repetitionDetectionService() { return thisEngine.repetitionDetectionService; },
      get editCheckpointService() { return thisEngine.editCheckpointService; },
      get mcpService() { return thisEngine.mcpService; },
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
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
      send: (sender, content, clear) => this.send(sender, content, clear),
      get session() { return thisEngine.session; },
      get hostRequestModel() { return thisEngine.hostRequestModel; },
      get hostResponseProjection() { return thisEngine.hostResponseProjection; },
      restoreSharedHostProjectionState: (state) => this.restoreSharedHostProjectionState(state),
      replaceSharedHostProjectionState: (state) => this.replaceSharedHostProjectionState(state),
    };
  }

  private createHostSessionRestoreContext(): ConstructorParameters<typeof HostSessionRestoreBridge>[0] {
    const thisEngine = this;

    return {
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.list = value; },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get sessionId() { return thisEngine.sessionId; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMessageSource() { return thisEngine.currentMessageSource; },
      get currentMode() { return thisEngine.currentMode; },
      get ngZone() { return thisEngine.ngZone; },
      readSessionRuntimeState: (sessionId) => thisEngine.chatSessionRuntimeStore.read(sessionId),
      get toolCallingIteration() { return thisEngine.toolCallingIteration; },
      set toolCallingIteration(value) { thisEngine.toolCallingIteration = value; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get chatService() { return thisEngine.chatService; },
      get contextBudgetService() { return thisEngine.createRuntimeScopedContextBudgetService(); },
      get editCheckpointService() { return thisEngine.editCheckpointService; },
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
      get lexStream() { return thisEngine.lexStream; },
      resumeRestoredInteraction: (content, interactionAction, options) => (
        thisEngine.submitInteractionActionRequest(
          content,
          interactionAction,
          options?.requestMetadata,
          options?.sessionId,
        )
      ),
      restoreSharedHostProjectionState: (state) => thisEngine.restoreSharedHostProjectionState(state),
      replaceSharedHostProjectionState: (state) => thisEngine.replaceSharedHostProjectionState(state),
    };
  }

  private createLexOwnerContext(): ConstructorParameters<typeof LexOwnerFacade>[0] {
    const thisEngine = this;

    return {
      get prjPath() { return thisEngine.prjPath; },
      get prjRootPath() { return thisEngine.prjRootPath; },
      get currentModel() { return thisEngine.currentModel; },
      get sessionId() { return thisEngine.sessionId; },
      get sessionTitle() { return thisEngine.sessionTitle; },
      get chatService() { return thisEngine.chatService; },
      get currentSessionPath() { return thisEngine.resolveRuntimeSessionProviderOptions()?.folderPath ?? thisEngine.chatService.currentSessionPath; },
      get currentSessionPermissionMode() { return thisEngine.resolveRuntimeSessionProviderOptions()?.permissionMode ?? thisEngine.chatService.currentSessionPermissionMode; },
      get currentSessionApprovalsReviewer() { return thisEngine.resolveRuntimeSessionProviderOptions()?.approvalsReviewer ?? thisEngine.chatService.currentSessionApprovalsReviewer; },
      get currentSessionApprovalPolicy() { return thisEngine.resolveRuntimeSessionProviderOptions()?.approvalPolicy ?? thisEngine.chatService.currentSessionApprovalPolicy; },
      get ailyChatConfigService() { return thisEngine.ailyChatConfigService; },
      get mcpService() { return thisEngine.mcpService; },
      buildExecutionSaveTarget: (sessionId) => thisEngine.buildExecutionSaveTarget(sessionId),
      resolveActiveRuntimeSessionId: () => thisEngine.resolveActiveRuntimeSessionId(),
      get runtimeInteractionHost() { return thisEngine.runtimeInteractionHost; },
      handleToolApproval: request => this.handleToolApproval(request),
      get lexStream() { return thisEngine.lexStream; },
      openSettings: () => this.openSettings(),
      get editCheckpointService() { return thisEngine.editCheckpointService; },
      get ngZone() { return thisEngine.ngZone; },
      get message() { return thisEngine.message; },
      get list() { return thisEngine.list; },
      set list(value) { thisEngine.list = value; },
      get partStore() { return thisEngine.partStore; },
      get viewAdapter() { return thisEngine.viewAdapter; },
      get scrollManager() { return thisEngine.scrollManager; },
      invalidateHostRequestGraph: () => this.invalidateHostRequestGraph(),
      get inputValue() { return thisEngine.inputValue; },
      set inputValue(value) { thisEngine.inputValue = value; },
      switchToMode: (mode) => this.switchToMode(mode),
      triggerSyncDetectChanges: () => this.triggerSyncDetectChanges(),
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get currentModelName() { return thisEngine.currentModelName; },
      get currentMessageSource() { return thisEngine.currentMessageSource; },
      set currentMessageSource(value) { thisEngine.currentMessageSource = value; },
      get toolCallingIteration() { return thisEngine.toolCallingIteration; },
      set toolCallingIteration(value) { thisEngine.toolCallingIteration = value; },
      get contextBudgetService() { return thisEngine.contextBudgetService; },
      get isWaiting() { return thisEngine.isWaiting; },
      set isWaiting(value) { thisEngine.isWaiting = value; },
      get isCompleted() { return thisEngine.isCompleted; },
      set isCompleted(value) { thisEngine.isCompleted = value; },
      get session() { return thisEngine.session; },
      readSessionRuntimeState: (sessionId) => thisEngine.chatSessionRuntimeStore.read(sessionId),
      syncExecutionRuntimeState: (saveTarget) => thisEngine.syncExecutionRuntimeState(saveTarget),
      syncExecutionRuntimeTurnResponses: (sessionId, turnResponses) => thisEngine.syncExecutionRuntimeTurnResponses(sessionId, turnResponses),
      applyPendingSwitch: (sessionId) => this.applyPendingSwitch(sessionId),
      get repetitionDetectionService() { return thisEngine.repetitionDetectionService; },
      get editActions() { return thisEngine.editActions; },
      get isCancelled() { return thisEngine.isCancelled; },
      set isCancelled(value) { thisEngine.isCancelled = value; },
      get activeToolExecutions() { return thisEngine.activeToolExecutions; },
      set activeToolExecutions(value) { thisEngine.activeToolExecutions = value; },
      get currentStatelessMode() { return thisEngine.currentStatelessMode; },
      set currentStatelessMode(value) { thisEngine.currentStatelessMode = value; },
    };
  }

  private createTitleCoordinatorContext(): ConstructorParameters<typeof ChatTitleCoordinator>[0] {
    const thisEngine = this;

    return {
      get sessionId() { return thisEngine.sessionId; },
      get sessionTitle() { return thisEngine.sessionTitle; },
      get chatService() { return thisEngine.chatService; },
      get chatHistoryService() { return thisEngine.chatHistoryService; },
      get session() { return thisEngine.session; },
      get lexStream() { return thisEngine.lexStream; },
    };
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
      get editCheckpointService() { return thisEngine.editCheckpointService; },
      get conversationMessages() { return thisEngine.conversationMessages; },
      get viewAdapter() { return thisEngine.viewAdapter; },
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
      get lexStream() { return thisEngine.lexStream; },
    };
  }

  private createConversationActionCoordinatorContext(): ConstructorParameters<typeof ChatConversationActionCoordinator>[0] {
    const thisEngine = this;

    return {
      get isWaiting() { return thisEngine.isWaiting; },
      get sessionId() { return thisEngine.sessionId; },
      send: (sender, content, clear) => this.send(sender, content, clear),
      get message() { return thisEngine.message; },
      get scrollManager() { return thisEngine.scrollManager; },
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
      (msg) => this.list.push(msg),
      () => this.currentMessageSource,
      () => this.currentModelName || undefined,
      () => this.currentModelBillingLabel || undefined,
      () => this.isWaiting,
      () => { if (this.sessionId) { this.chatHistoryService.markDirty(this.sessionId); } },
      this.ngZone,
      undefined, // cdCallback — 由 component 通过 setCdCallback 注入
      () => this.scrollManager.captureAutoScrollState(),
      (shouldFollow) => this.scrollManager.scrollToBottomIfNeeded(shouldFollow, 'auto'),
    );

    this.chatHistoryService.setLiveSessionProvider(() => this.session.buildLiveHostSessionRecord());

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

  /**
   * 同步 detectChanges 回调 — 在 runOutsideAngular 场景中使用。
   * markForCheck 在 zone 外不会触发实际 CD，此回调直接同步执行 detectChanges。
   */
  private _syncDetectChanges: (() => void) | null = null;

  setSyncDetectChanges(cb: () => void): void {
    this._syncDetectChanges = cb;
  }

  /**
   * 仅解绑当前 view 关联的引用，不销毁 session runtime。
   * 真正的 runtime dispose 仍由显式 owner 调用 `destroy()`。
   */
  detachView(): void {
    this.chatTextareaRef = null;
    this.viewAdapter.setCdCallback(undefined);
    this._syncDetectChanges = null;
    this.paneSessionCommandHandlers = {};
    this.captureActiveSessionRuntimeState();
  }

  resetVisibleSessionProjection(options: VisibleSessionProjectionResetOptions = {}): void {
    this.interaction.resetApprovalState();
    if (options.clearResolvedActiveModel === true) {
      this.chatService.clearResolvedActiveModel?.();
    }

    this.lexStream.resetSessionState();
    this.clearVisibleChatView({ detectChanges: options.detectChanges });

    if (options.clearTurns === true) {
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
      this.editCheckpointService.clear();
      this.editCheckpointService.dismissSummary();
    }

    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
      this.messageSubscription = null;
    }

    this.activeToolExecutions = 0;
  }

  invalidateHostRequestGraph(): void {
    this.liveHostRequestGraphCache.markDirty();
    this.captureActiveSessionRuntimeState();
  }

  private clearVisibleChatView(options: { detectChanges?: boolean } = {}): void {
    this.invalidateHostRequestGraph();
    this.viewAdapter.reset?.();
    this.list = [];
    this.partStore.reset();

    if (options.detectChanges !== false) {
      this.triggerSyncDetectChanges();
    }
  }

  private readActiveSessionRuntimeTurnResponses(): readonly TurnResponseTurn[] {
    return this.hostResponseProjection?.turnResponses ?? this.lexStream.turnResponses ?? [];
  }

  private readRuntimeTurnResponsesForOwner(sessionId?: string | null): readonly TurnResponseTurn[] {
    const readSessionRuntimeTurnResponses = (
      this as unknown as {
        readSessionRuntimeTurnResponses?: (sessionId?: string | null) => readonly TurnResponseTurn[];
      }
    ).readSessionRuntimeTurnResponses
      ?? ChatEngineService.prototype['readSessionRuntimeTurnResponses'];
    return readSessionRuntimeTurnResponses.call(this, sessionId);
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
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    const override = targetSessionId
      ? this.runtimeSessionProviderOptionOverrides?.get?.(targetSessionId)
      : undefined;
    if (override) {
      return { ...override };
    }

    const fallback = this.chatService.getCurrentSessionProviderOptions?.()
      ?? {
        folderPath: this.chatService.currentSessionPath || null,
        permissionMode: this.chatService.currentSessionPermissionMode,
        ...(this.chatService.currentSessionPermissionLevel
          ? { permissionLevel: this.chatService.currentSessionPermissionLevel }
          : {}),
        ...(this.chatService.currentSessionApprovalsReviewer
          ? { approvalsReviewer: this.chatService.currentSessionApprovalsReviewer }
          : {}),
        ...(this.chatService.currentSessionApprovalPolicy
          ? { approvalPolicy: this.chatService.currentSessionApprovalPolicy }
          : {}),
      };
    const rawProviderOptions = targetSessionId
      ? this.chatSessionItemsService?.sessionItemController?.getChatSessionProviderOptions?.(targetSessionId)
      : this.chatSessionItemsService?.sessionItemController?.getChatSessionProviderOptions?.();
    return normalizeHostSessionProviderOptions(rawProviderOptions, fallback);
  }

  private rememberRuntimeSessionProviderOptions(
    sessionId: string | null | undefined,
    providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
  ): HostSessionProviderOptions | null {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    if (!targetSessionId) {
      return null;
    }

    const resolveRuntimeSessionProviderOptions = (
      this as unknown as { resolveRuntimeSessionProviderOptions?: (sessionId?: string | null) => HostSessionProviderOptions }
    ).resolveRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['resolveRuntimeSessionProviderOptions'];
    const normalized = normalizeHostSessionProviderOptions(
      providerOptions,
      resolveRuntimeSessionProviderOptions.call(this, targetSessionId),
    );
    this.runtimeSessionProviderOptionOverrides?.set?.(targetSessionId, normalized);
    return normalized;
  }

  private resolveRuntimeSelectedMode(sessionId?: string | null): ChatSelectedMode {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    return targetSessionId && this.runtimeSessionSelectedModeOverrides?.has?.(targetSessionId)
      ? normalizeChatSelectedMode(this.runtimeSessionSelectedModeOverrides.get(targetSessionId))
      : normalizeChatSelectedMode(this.chatService.selectedMode ?? { modeId: this.chatService.currentMode });
  }

  private rememberRuntimeSelectedMode(
    sessionId: string | null | undefined,
    selectedMode: ChatSelectedMode | null | undefined,
  ): ChatSelectedMode | null {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    if (!targetSessionId || !selectedMode) {
      return null;
    }

    const normalized = normalizeChatSelectedMode(selectedMode);
    this.runtimeSessionSelectedModeOverrides?.set?.(targetSessionId, normalized);
    return normalized;
  }

  private resolveRuntimeResolvedMode(sessionId?: string | null): ChatResolvedMode {
    const resolveRuntimeSelectedMode = (
      this as unknown as { resolveRuntimeSelectedMode?: (sessionId?: string | null) => ChatSelectedMode }
    ).resolveRuntimeSelectedMode
      ?? ChatEngineService.prototype['resolveRuntimeSelectedMode'];
    const selectedMode = resolveRuntimeSelectedMode.call(this, sessionId);
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

  private buildExecutionSaveTarget(sessionId?: string | null): HostSessionSaveTarget | null {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return null;
    }

    const providerOptions = this.resolveRuntimeSessionProviderOptions(targetSessionId);
    const selectedMode = this.resolveRuntimeSelectedMode(targetSessionId);
    const resolvedMode = this.resolveRuntimeResolvedMode(targetSessionId);
    const projectPathHint = providerOptions.folderPath ?? null;
    const sessionEntry = (this.chatHistoryService as unknown as {
      findEntry?: (sessionId: string, projectPathHint?: string | null) => { title?: string } | null | undefined;
    }).findEntry?.(targetSessionId, projectPathHint)
      ?? (this.chatHistoryService as unknown as {
        findEntry?: (sessionId: string, projectPathHint?: string | null) => { title?: string } | null | undefined;
      }).findEntry?.(targetSessionId);

    const persistedTitle = normalizeChatSessionTitleText(sessionEntry?.title);
    const isCurrentSession = targetSessionId === (this.chatService.currentSessionId ?? '').trim();
    const fallbackTitle = isCurrentSession
      ? normalizeChatSessionTitleText(this.sessionTitle || this.chatService.currentSessionTitle || '')
      : '';
    const currentTitleCandidate = isCurrentSession
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
      model: this.currentModel ? { ...this.currentModel } : null,
    };
  }

  private readSessionRuntimeTurnResponses(sessionId?: string | null): readonly TurnResponseTurn[] {
    const targetSessionId = (
      (this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string })
        .resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner']
    ).call(this, sessionId);
    if (targetSessionId) {
      const runtimeTurnResponses = this.chatSessionRuntimeStore?.read?.(targetSessionId)?.turnResponses;
      if (Array.isArray(runtimeTurnResponses) && runtimeTurnResponses.length > 0) {
        return runtimeTurnResponses;
      }
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (targetSessionId
      && currentSessionId
      && targetSessionId !== currentSessionId
      && this.runtimeSessionOwnerOverride !== targetSessionId) {
      return [];
    }

    return this.hostResponseProjection?.turnResponses ?? this.lexStream.turnResponses ?? [];
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
    const targetSessionId = explicitSessionId || this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    if (targetSessionId === this._waitingSessionId && this._isWaiting) {
      return true;
    }

    return this.chatSessionRuntimeStore.read(targetSessionId)?.requestInProgress === true;
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
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.projectRuntimeState(targetSessionId, patch);
    } else {
      this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, patch);
    }
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

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!currentSessionId || currentSessionId !== targetSessionId) {
      return false;
    }

    const runtimeState = this.chatSessionRuntimeStore?.read?.(targetSessionId);
    return runtimeState?.attachedView !== false;
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

  private captureActiveSessionRuntimeState(): void {
    const sessionId = this.resolveActiveRuntimeSessionId();
    if (!sessionId) {
      return;
    }

    const supportsInterruption = this._isWaiting;
    const turnResponses = this.readActiveSessionRuntimeTurnResponses();
    const syncRuntimeViewOverlayFromVisibleServices = (
      this as unknown as {
        syncRuntimeViewOverlayFromVisibleServices?: (sessionId?: string | null) => ChatSessionRuntimeViewOverlay | null;
      }
    ).syncRuntimeViewOverlayFromVisibleServices
      ?? ChatEngineService.prototype['syncRuntimeViewOverlayFromVisibleServices'];
    const viewOverlay = syncRuntimeViewOverlayFromVisibleServices.call(this, sessionId);
    const runtimeCapabilities = resolveEngineRuntimeSessionCapabilities(this as unknown as Record<string, unknown>, sessionId);
    const runtimeConcurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      sessionId,
    );

    const runtimeStatePatch = {
      turnResponses,
      hostProjectionState: readRuntimeProjectionStateFromEngine(this, turnResponses),
      status: supportsInterruption ? 'in_progress' as const : null,
      requestInProgress: this._isWaiting,
      attachedView: !!this.chatTextareaRef,
      supportsInterruption,
      activeResponseHandle: supportsInterruption ? sessionId : null,
      stopSession: supportsInterruption
        ? (this.chatSessionRuntimeRegistry
            ? () => this.lexStream.agent.stop(sessionId)
            : () => this.stopSessionAction(sessionId))
        : null,
      disposeSession: this.chatSessionRuntimeRegistry
        ? () => this.lexStream.agent.dispose(sessionId)
        : () => this.disposeSessionAction(sessionId),
      capabilities: runtimeCapabilities,
      viewOverlay,
      ...(runtimeConcurrencyScope ? { concurrencyScope: runtimeConcurrencyScope } : {}),
      debugSummary: {
        liveRuntimeOverlayPresent: this._isWaiting || turnResponses.length > 0,
        pendingRequest: this._isWaiting,
        needsInput: false,
        attachedView: !!this.chatTextareaRef,
        ...(typeof this.chatService?.currentSessionTitle === 'string'
          ? { title: this.chatService.currentSessionTitle }
          : {}),
        ...(typeof this.chatService?.currentSessionTitleSource === 'string'
          ? { titleSource: this.chatService.currentSessionTitleSource }
          : {}),
        ...(typeof this.chatService?.currentSessionTitleRevision === 'number' && Number.isFinite(this.chatService.currentSessionTitleRevision)
          ? { titleRevision: Math.floor(this.chatService.currentSessionTitleRevision) }
          : {}),
        contextBudgetOverlayPresent: !!viewOverlay?.contextBudgetSnapshot,
        inputNoticeOverlayPresent: !!viewOverlay?.chatInputNotice,
      },
    };
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.projectRuntimeState(sessionId, runtimeStatePatch);
    } else {
      this.chatSessionRuntimeStore.replaceRuntimeState(sessionId, runtimeStatePatch);
    }
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
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.projectRuntimeState(sessionId, runtimeStatePatch);
    } else {
      this.chatSessionRuntimeStore.replaceRuntimeState(sessionId, runtimeStatePatch);
    }
  }

  private syncExecutionRuntimeTurnResponses(
    sessionId?: string | null,
    turnResponses?: readonly TurnResponseTurn[] | null,
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId || !Array.isArray(turnResponses)) {
      return;
    }

    const hostProjectionState = buildRuntimeHostProjectionState(turnResponses);
    const runtimeCapabilities = resolveEngineRuntimeSessionCapabilities(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    const runtimeConcurrencyScope = resolveEngineRuntimeSessionConcurrencyScope(
      this as unknown as Record<string, unknown>,
      targetSessionId,
    );
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.syncHandleState(targetSessionId, {
        capabilities: runtimeCapabilities,
        concurrencyScope: runtimeConcurrencyScope ?? null,
      });
      this.chatSessionRuntimeRegistry.syncTurnResponses(
        targetSessionId,
        turnResponses,
        hostProjectionState,
      );
      return;
    }

    this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, {
      turnResponses,
      hostProjectionState,
      capabilities: runtimeCapabilities,
    });
  }

  private clearSessionRuntimeState(sessionId?: string | null): void {
    const targetSessionId = sessionId ?? this.resolveActiveRuntimeSessionId();
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.clearSession(targetSessionId);
      return;
    }

    this.chatSessionRuntimeStore.clearSession(targetSessionId);
  }

  private detachSessionRuntimeView(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId || !this.chatSessionRuntimeStore.read(targetSessionId)) {
      return false;
    }

    if (this.chatSessionRuntimeRegistry) {
      return this.chatSessionRuntimeRegistry.detachView(targetSessionId);
    }

    this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, {
      attachedView: false,
      debugSummary: {
        lastViewDetachAt: Date.now(),
      },
    });
    return true;
  }

  private interruptSessionRuntime(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.resolveActiveRuntimeSessionId();
    if (!targetSessionId) {
      return false;
    }

    const runtimeState = this.chatSessionRuntimeStore.read(targetSessionId);
    if (!runtimeState?.supportsInterruption) {
      return false;
    }

    if (this.chatSessionRuntimeRegistry) {
      return this.chatSessionRuntimeRegistry.stopSession(targetSessionId);
    }

    this.lexStream.agent.stop(targetSessionId);
    this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, {
      status: null,
      requestInProgress: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
      debugSummary: {
        lastExplicitInterruptAt: Date.now(),
      },
    });

    return true;
  }

  private stopSessionAction(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : '';
    if (!targetSessionId) {
      return false;
    }

    const runtimeState = this.chatSessionRuntimeStore.read(targetSessionId);
    const isVisibleCurrentSession = targetSessionId === this.resolveActiveRuntimeSessionId()
      && this.isWaiting
      && (runtimeState?.attachedView === true || !!this.chatTextareaRef);

    if (isVisibleCurrentSession) {
      this.stopCoordinator.stopVisibleSession(targetSessionId);
      this.captureActiveSessionRuntimeState();
      return true;
    }

    return this.interruptSessionRuntime(targetSessionId);
  }

  private teardownSessionRuntime(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    if (this.chatSessionRuntimeRegistry) {
      return this.chatSessionRuntimeRegistry.disposeSession(targetSessionId);
    }

    this.lexStream.agent.dispose(targetSessionId);
    const runtimeState = this.chatSessionRuntimeStore.read(targetSessionId);
    if (runtimeState) {
      this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, {
        requestInProgress: false,
        supportsInterruption: false,
        stopSession: null,
        disposeSession: null,
        activeResponseHandle: null,
        debugSummary: {
          lastExplicitDisposeAt: Date.now(),
        },
      });
    }
    this.clearSessionRuntimeState(targetSessionId);
    return true;
  }

  private disposeSessionAction(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }

    return this.teardownSessionRuntime(targetSessionId);
  }

  private async attachCurrentSessionView(): Promise<void> {
    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!currentSessionId) {
      return;
    }

    const runtimeState = this.chatSessionRuntimeStore.read(currentSessionId);
    this.projectRuntimeViewOverlayToVisibleServices(runtimeState);
    this.projectRuntimeQuotaOverlayToVisibleServices(runtimeState);
    const persistedEntry = this.chatHistoryService.findEntry(currentSessionId);
    const hasVisibleProjection = this.chatService.hasBlankSessionShell
      || (Array.isArray(this.list) && this.list.length > 0);
    const runtimeHasLiveProjection = (Array.isArray(runtimeState?.turnResponses)
      && runtimeState.turnResponses.length > 0)
      || ((runtimeState?.hostProjectionState?.turnResponses?.length ?? 0) > 0);
    const shouldAttachDetachedRuntimeView = !!runtimeState
      && runtimeState.attachedView === false
      && runtimeState.requestInProgress === true;
    const runtimeProjectionMismatch = !!runtimeState?.hostProjectionState
      && !areProjectionTurnResponsesEquivalent(
        this.hostResponseProjection?.turnResponses,
        runtimeState.hostProjectionState.turnResponses,
      );
    const canRestoreProjection = !!runtimeState || !!persistedEntry;
    const shouldRestoreProjection = !this.chatService.hasBlankSessionShell
      && canRestoreProjection
      && !shouldAttachDetachedRuntimeView
      && (!runtimeState
        || runtimeState.attachedView === false
        || !hasVisibleProjection
        || runtimeProjectionMismatch);

    traceBackgroundSessionExecution('attach-current-session-view', {
      sessionId: currentSessionId,
      hasRuntimeState: !!runtimeState,
      runtimeAttachedView: runtimeState?.attachedView ?? null,
      runtimeRequestInProgress: runtimeState?.requestInProgress ?? false,
      hasPersistedEntry: !!persistedEntry,
      hasVisibleProjection,
      runtimeProjectionMismatch,
      shouldAttachDetachedRuntimeView,
      shouldRestoreProjection,
    });

    if (shouldAttachDetachedRuntimeView) {
      traceBackgroundSessionExecution('attach-current-session-view-reattach-running-runtime', {
        sessionId: currentSessionId,
        requestInProgress: runtimeState?.requestInProgress ?? false,
        hasRuntimeProjection: runtimeHasLiveProjection,
      });
      if (this.chatSessionRuntimeRegistry) {
        this.chatSessionRuntimeRegistry.attachView(currentSessionId);
      } else {
        this.chatSessionRuntimeStore.replaceRuntimeState(currentSessionId, {
          attachedView: true,
        });
      }
      this.ensureBackgroundSessionCanRerun(currentSessionId);
      this.chatSessionItemsService.scheduleSessionItemRefresh(currentSessionId, 'attach-running-runtime');
      return;
    }

    if (shouldRestoreProjection) {
      traceBackgroundSessionExecution('attach-current-session-view-restore-start', {
        sessionId: currentSessionId,
        reason: {
          runtimeMissing: !runtimeState,
          detachedView: runtimeState?.attachedView === false,
          visibleProjectionMissing: !hasVisibleProjection,
          runtimeProjectionMismatch,
        },
      });
      const restored = await this.hostSessionRestoreBridge.restoreCurrentSessionProjection(this.getCurrentProjectPath());
      traceBackgroundSessionExecution('attach-current-session-view-restore-finished', {
        sessionId: currentSessionId,
        restored,
      });
      if (restored) {
        this.chatSessionItemsService.scheduleSessionItemRefresh(currentSessionId, 'attach-restore');
      }
      return;
    }

    if (hasVisibleProjection) {
      if (runtimeState && !runtimeState.attachedView) {
        traceBackgroundSessionExecution('attach-current-session-view-reattach-runtime-view', {
          sessionId: currentSessionId,
          requestInProgress: runtimeState.requestInProgress,
        });
        if (this.chatSessionRuntimeRegistry) {
          this.chatSessionRuntimeRegistry.attachView(currentSessionId);
        } else {
          this.chatSessionRuntimeStore.replaceRuntimeState(currentSessionId, {
            attachedView: true,
          });
        }
        this.ensureBackgroundSessionCanRerun(currentSessionId);
        this.chatSessionItemsService.scheduleSessionItemRefresh(currentSessionId, 'attach-runtime-view');
      }
      return;
    }

    if (!runtimeState && !persistedEntry) {
      return;
    }

    const restored = await this.hostSessionRestoreBridge.restoreCurrentSessionProjection(this.getCurrentProjectPath());
    traceBackgroundSessionExecution('attach-current-session-view-fallback-restore-finished', {
      sessionId: currentSessionId,
      restored,
    });
    if (restored) {
      this.chatSessionItemsService.scheduleSessionItemRefresh(currentSessionId, 'attach-fallback-restore');
    }
  }

  private ensureBackgroundSessionCanRerun(sessionId?: string | null): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return;
    }

    const runtimeState = this.chatSessionRuntimeStore.read(targetSessionId);
    if (!runtimeState?.requestInProgress) {
      traceBackgroundSessionExecution('reattach-rerun-check-skip-idle', {
        sessionId: targetSessionId,
      });
      return;
    }

    const hasActiveExecutionHandle = runtimeState.supportsInterruption === true
      || typeof runtimeState.stopSession === 'function'
      || runtimeState.activeResponseHandle !== undefined;
    if (hasActiveExecutionHandle) {
      traceBackgroundSessionExecution('reattach-rerun-check-active', {
        sessionId: targetSessionId,
        supportsInterruption: runtimeState.supportsInterruption,
        hasStopSession: typeof runtimeState.stopSession === 'function',
        hasActiveResponseHandle: runtimeState.activeResponseHandle !== undefined,
      });
      return;
    }

    traceBackgroundSessionExecution('reattach-rerun-check-clear-stale-request-flag', {
      sessionId: targetSessionId,
      requestInProgress: runtimeState.requestInProgress,
      status: runtimeState.status ?? null,
      detail: 'requestInProgress without active runtime handle; clear stale gate so session can rerun',
    });

    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.syncHandleState(targetSessionId, {
        requestInProgress: false,
        supportsInterruption: false,
        activeResponseHandle: null,
        stopSession: null,
      });
      return;
    }

    this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, {
      requestInProgress: false,
      supportsInterruption: false,
      activeResponseHandle: null,
      stopSession: null,
    });
  }

  /** 同步触发变更检测（zone 安全） */
  triggerSyncDetectChanges(): void {
    if (this._syncDetectChanges) {
      this.ngZone.run(() => this._syncDetectChanges!());
    }
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
    this.chatService.isWaiting = this._isWaiting;
    this.captureActiveSessionRuntimeState();
    void this.refreshRequestQuotaState();
    void this.attachCurrentSessionView().catch((error) => {
      console.warn('[ChatEngine] Failed to attach current session view on init:', error);
    });

    this.prjPath = AilyHost.get().project.currentProjectPath === AilyHost.get().project.projectRootPath
      ? '' : AilyHost.get().project.currentProjectPath;
    this.prjRootPath = AilyHost.get().project.projectRootPath;
    this.refreshSessionProviderOptionsSources();

    // 初始化时：如果项目已打开，立即执行孤儿领养（订阅的 skip(1) 会跳过初始值）
    if (this.prjPath) {
      const adopted = this.chatHistoryService.adoptOrphanSessions(this.prjPath, this.prjRootPath);
      if (adopted > 0) {
        console.log(`[ChatEngine] 初始化时领养 ${adopted} 个孤儿会话到: ${this.prjPath}`);
      }
    }

    // 注册 ask_user 回调：在聊天界面显示全部问题并等待用户回答
    registerAskUserCallback((questions) => this.interaction.handleAskUser(questions));

    // 预加载 aily-lex 模块
    this.lexStream.agent.loadModule().then(ok => {
      if (ok) { console.log('[ChatEngine] aily-lex 模块预加载成功'); }
      else { console.error('[ChatEngine] aily-lex 模块加载失败，聊天功能不可用'); }
    });

    this.cleanupSubscriptions();
    this.setupSubscriptions();
  }

  /**
    * 引擎销毁 — 由显式 runtime owner 调用
   */
  destroy(): void {
    this.disposeAllSessionRuntimes();
    this.disposeVisibleProjection();
    this.disposeOwnerLifecycle();
  }

  disposeVisibleProjection(): void {
    this.liveHostRequestGraphCache.clear();
    this.viewAdapter.destroy();
    this.partStore.destroy();
    this.chatService.isWaiting = false;
  }

  private disposeAllSessionRuntimes(): void {
    const sessionIds = new Set<string>([
      ...(this.chatSessionRuntimeRegistry?.getSessionIds() ?? this.chatSessionRuntimeStore.getSessionIds()),
      ...this.lexStream.agent.getSessionIds(),
    ]);

    for (const sessionId of sessionIds) {
      this.teardownSessionRuntime(sessionId);
    }
  }

  private disposeOwnerLifecycle(): void {
    this.session.saveCurrentSession();
    this.session.enterEntryState({ resetInitialization: true });
    this.chatHistoryService.flushAll();
    this.chatHistoryService.setLiveSessionProvider(null);
    this.editCheckpointService.clear();

    unregisterAskUserCallback();
    this.interaction.destroy();

    this.cleanupSubscriptions();
    this.session.dispose();

    this.viewAdapter.markLastMessageDone();
  }

  // ==================== 订阅管理 ====================

  private setupSubscriptions(): void {
    this.subscriptionCoordinator.setup();
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
  }

  private cleanupSubscriptions(): void {
    this.runtimeModeCollectionSubscription?.unsubscribe();
    this.runtimeModeCollectionSubscription = null;
    this.contextBudgetStateSubscription?.unsubscribe();
    this.contextBudgetStateSubscription = null;
    this.requestQuotaStateSubscription?.unsubscribe();
    this.requestQuotaStateSubscription = null;
    this.subscriptionCoordinator.cleanup();
  }

  private flushPendingAutoSend(): void {
    if (!this._pendingAutoSendText) {
      return;
    }

    const text = this._pendingAutoSendText;
    this._pendingAutoSendText = null;
    this.inputValue = text;
    setTimeout(() => this.send('user', text, true), 50);
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

  generateTitle(content: string): void {
    void this.titleCoordinator.generate(content);
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
  switchToSession(
    sessionId: string,
    options?: {
      readonly fallbackProjectPath?: string | null;
    },
  ): Promise<boolean> {
    return this.session.switchToSession(sessionId, options);
  }
  newChat(): Promise<void> { return this.session.newChat(); }
  initializeEntryInventory(): Promise<boolean> { return this.session.initializeEntryInventory(); }
  returnToEntryInventory(options?: { resetInitialization?: boolean; sessionId?: string | null; disposeRuntime?: boolean }): Promise<void> {
    return this.session.returnToEntryInventory(options);
  }

  ensureSessionReadyForSubmit(): Promise<boolean> { return this.session.ensureSessionReadyForSubmit(); }
  enterEntryState(options?: { resetInitialization?: boolean; sessionId?: string | null; disposeRuntime?: boolean }): void {
    this.session.enterEntryState(options);
  }
  getHistory(): Promise<void> { return this.session.getHistory(); }
  getCurrentTools(): any[] { return this.lexStream.runtime.tools(); }
  getCurrentLLMConfig(): any { return this.lexStream.runtime.llmConfig(); }

  async compactConversation(): Promise<boolean> {
    const changed = await this.lexStream.compactConversation();
    if (changed) {
      this.invalidateHostRequestGraph();
      this.triggerSyncDetectChanges();
    }
    return changed;
  }

  // ==================== 消息发送 ====================

  private async ensureBlankSessionRuntimeProviderOptions(sessionId?: string | null): Promise<void> {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    if (!targetSessionId) {
      return;
    }

    const readRuntimeTurnResponsesForOwner = (
      this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] }
    ).readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner'];
    if (readRuntimeTurnResponsesForOwner.call(this, targetSessionId).length > 0) {
      return;
    }

    const rememberRuntimeSessionProviderOptions = (
      this as unknown as {
        rememberRuntimeSessionProviderOptions?: (
          sessionId: string | null | undefined,
          providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
        ) => HostSessionProviderOptions | null;
      }
    ).rememberRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['rememberRuntimeSessionProviderOptions'];
    const resolveRuntimeSessionProviderOptions = (
      this as unknown as {
        resolveRuntimeSessionProviderOptions?: (sessionId?: string | null) => HostSessionProviderOptions;
      }
    ).resolveRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['resolveRuntimeSessionProviderOptions'];
    const normalizedProviderOptions = rememberRuntimeSessionProviderOptions.call(
      this,
      targetSessionId,
      resolveRuntimeSessionProviderOptions.call(this, targetSessionId),
    ) ?? resolveRuntimeSessionProviderOptions.call(this, targetSessionId);
    const providerOptionsKey = createHostSessionProviderOptionsKey(normalizedProviderOptions);
    if (this.lexStream.agent.isConfiguredFor?.(targetSessionId, providerOptionsKey)) {
      return;
    }

    await this.lexStream.agent.ensureAgent(targetSessionId, providerOptionsKey);
  }

  private async ensureRuntimeAgentForSession(sessionId: string): Promise<void> {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    if (!targetSessionId) {
      return;
    }

    const rememberRuntimeSessionProviderOptions = (
      this as unknown as {
        rememberRuntimeSessionProviderOptions?: (
          sessionId: string | null | undefined,
          providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
        ) => HostSessionProviderOptions | null;
      }
    ).rememberRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['rememberRuntimeSessionProviderOptions'];
    const resolveRuntimeSessionProviderOptions = (
      this as unknown as {
        resolveRuntimeSessionProviderOptions?: (sessionId?: string | null) => HostSessionProviderOptions;
      }
    ).resolveRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['resolveRuntimeSessionProviderOptions'];
    const normalizedProviderOptions = rememberRuntimeSessionProviderOptions.call(
      this,
      targetSessionId,
      resolveRuntimeSessionProviderOptions.call(this, targetSessionId),
    ) ?? resolveRuntimeSessionProviderOptions.call(this, targetSessionId);
    const providerOptionsKey = createHostSessionProviderOptionsKey(normalizedProviderOptions);
    if (this.lexStream.agent.isConfiguredFor?.(targetSessionId, providerOptionsKey)) {
      await this.lexStream.agent.ensureAgent(targetSessionId, providerOptionsKey);
      return;
    }

    await this.lexStream.agent.ensureAgent(targetSessionId, providerOptionsKey);
  }

  private async runWithRuntimeSessionOwner<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previousOwner = this.runtimeSessionOwnerOverride;
    this.runtimeSessionOwnerOverride = sessionId;
    try {
      return await action();
    } finally {
      this.runtimeSessionOwnerOverride = previousOwner;
    }
  }

  async send(sender: string, content: string, clear: boolean = true): Promise<void> {
    await maybeAutoSwitchToDefaultModelAfterRateLimit(this);

    const runtimeSessionId = typeof this.resolveActiveRuntimeSessionId === 'function'
      ? this.resolveActiveRuntimeSessionId()
      : (typeof this.chatService?.currentSessionId === 'string' && this.chatService.currentSessionId.trim().length > 0
          ? this.chatService.currentSessionId.trim()
          : (typeof this.sessionId === 'string' ? this.sessionId.trim() : ''));
    if (runtimeSessionId && this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.syncHandleState(runtimeSessionId, {
        capabilities: resolveEngineRuntimeSessionCapabilities(this as unknown as Record<string, unknown>, runtimeSessionId),
        concurrencyScope: resolveEngineRuntimeSessionConcurrencyScope(
          this as unknown as Record<string, unknown>,
          runtimeSessionId,
        ) ?? null,
      });
      const canStartRequest = this.chatSessionRuntimeRegistry.canStartRequest(runtimeSessionId);
      traceBackgroundSessionExecution('send-gate-check', {
        runtimeSessionId,
        canStartRequest,
      });
      if (!canStartRequest) {
        traceBackgroundSessionExecution('send-gated-before-run', {
          runtimeSessionId,
        });
        return;
      }
    }

    const executeSend = async () => {
      const setupSuggestionService = (this as unknown as {
        chatSetupSuggestionService?: Pick<ChatSetupSuggestionService, 'inspectRequest' | 'markSuggestionPresented'>;
      }).chatSetupSuggestionService;
      const runtimeInteractionHost = (this as unknown as {
        runtimeInteractionHost?: Pick<ChatRuntimeInteractionHostService, 'presentConfirmation'>;
      }).runtimeInteractionHost;
      const maybeRewriteContentForTestSetup = (
        this as unknown as { maybeRewriteContentForTestSetup?: (sender: string, content: string, sessionId?: string | null) => Promise<string> }
      ).maybeRewriteContentForTestSetup
        ?? ChatEngineService.prototype['maybeRewriteContentForTestSetup'];
      const shouldCheckTestSetup = sender === 'user'
        && !!runtimeSessionId
        && !this.isWaiting
        && !!setupSuggestionService?.inspectRequest
        && !!setupSuggestionService?.markSuggestionPresented
        && !!runtimeInteractionHost?.presentConfirmation;
      const effectiveContent = shouldCheckTestSetup && typeof maybeRewriteContentForTestSetup === 'function'
        ? await maybeRewriteContentForTestSetup.call(this, sender, content, runtimeSessionId)
        : content;

      const prepared = this.sendCoordinator.prepareSend(sender, effectiveContent);
      if (!prepared) return;

      const ensureBlankSessionRuntimeProviderOptions = (
        this as unknown as { ensureBlankSessionRuntimeProviderOptions?: (sessionId?: string | null) => Promise<void> }
      ).ensureBlankSessionRuntimeProviderOptions;
      if (typeof ensureBlankSessionRuntimeProviderOptions === 'function') {
        await ensureBlankSessionRuntimeProviderOptions.call(this, runtimeSessionId);
      }

        if (sender === 'user') {
          const currentModel = this.chatService.currentModel as { model?: string; presetId?: string; name?: string } | null;
          const requestModelRouting = prepared.requestMetadata?.['modelRouting'] as Record<string, unknown> | undefined;
          console.info('[AilyChat][Send] request model routing:', {
            currentModel: currentModel
              ? {
                  model: currentModel.model,
                  presetId: currentModel.presetId,
                  name: currentModel.name,
                }
              : null,
            modelRouting: requestModelRouting
              ? { ...requestModelRouting }
              : undefined,
          });
          console.info(
            `[AilyChat][Send] request model routing scalar currentModel=${currentModel?.model ?? ''}/${currentModel?.presetId ?? ''}/${currentModel?.name ?? ''} requestedModel=${typeof requestModelRouting?.['requestedModel'] === 'string' ? requestModelRouting['requestedModel'] : ''} requestedPresetId=${typeof requestModelRouting?.['requestedPresetId'] === 'string' ? requestModelRouting['requestedPresetId'] : ''}`,
          );
        }

      this.lexStream.turn.begin(prepared.llmText, prepared.displayText, prepared.requestMetadata);
      if (sender === 'user') {
        const currentModel = this.chatService.currentModel as { model?: string; isCustom?: boolean; apiKey?: string; baseUrl?: string } | null;
        const hasCustomCredentials = !!(
          currentModel?.isCustom
          && typeof currentModel.apiKey === 'string'
          && currentModel.apiKey.trim().length > 0
          && typeof currentModel.baseUrl === 'string'
          && currentModel.baseUrl.trim().length > 0
        );
        console.info('[AilyChat][SendTitle]', {
          event: 'before-title-flow',
          sessionId: runtimeSessionId || this.chatService.currentSessionId,
          displayTextLength: (prepared.displayText || prepared.text).trim().length,
          requestTextLength: prepared.text.trim().length,
          requestTextPreview: prepared.text.trim().slice(0, 120),
          currentTitleBeforeSend: this.chatService.currentSessionTitle,
          currentModelId: currentModel?.model ?? '',
          currentModelIsCustom: currentModel?.isCustom === true,
          titleRequestUsesCustomLlmPath: hasCustomCredentials,
        });
        this.applyDefaultSessionTitleIfNeeded(prepared.displayText || prepared.text);
        void this.titleCoordinator.generate(prepared.text);
      }
      traceBackgroundSessionExecution('send-turn-begin', {
        runtimeSessionId,
        sender,
      });
      if (clear) {
        this.inputValue = '';
        this.triggerSyncDetectChanges();
      }

      traceBackgroundSessionExecution('send-turn-run-start', {
        runtimeSessionId,
      });
      await this.lexStream.turn.run(prepared.llmText, prepared.displayText);
      traceBackgroundSessionExecution('send-turn-run-finished', {
        runtimeSessionId,
      });
      this.acceptLiveRequestQuotaState(runtimeSessionId);
      this.refreshAuthQuotaStateAfterSuccessfulTurn(runtimeSessionId);

      const syncSessionId = runtimeSessionId
        || (typeof this.chatService.currentSessionId === 'string' ? this.chatService.currentSessionId.trim() : '');
      if (syncSessionId) {
        const runtimeTurnResponses = (
          (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
            .readRuntimeTurnResponsesForOwner
          ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
        ).call(this, syncSessionId);
        await this.chatService.syncResolvedActiveModelAfterSuccessfulTurn(
          syncSessionId,
          runtimeTurnResponses.length > 0
            ? runtimeTurnResponses
            : this.hostResponseProjection?.turnResponses ?? this.lexStream.turnResponses ?? [],
        );
        this.triggerSyncDetectChanges();
      }

      const presentPendingPlanReviewFromLatestContinuation = (
        this as unknown as { presentPendingPlanReviewFromLatestContinuation?: (sessionId?: string | null) => Promise<void> }
      ).presentPendingPlanReviewFromLatestContinuation;
      void presentPendingPlanReviewFromLatestContinuation?.call(this, runtimeSessionId);
    };

    const runWithRuntimeSessionOwner = (
      this as unknown as { runWithRuntimeSessionOwner?: <T>(sessionId: string, action: () => Promise<T>) => Promise<T> }
    ).runWithRuntimeSessionOwner;
    if (runtimeSessionId && typeof runWithRuntimeSessionOwner === 'function') {
      await runWithRuntimeSessionOwner.call(this, runtimeSessionId, executeSend);
      return;
    }

    await executeSend();
  }

  private applyDefaultSessionTitleIfNeeded(content: string): void {
    const currentTitle = typeof this.chatService.currentSessionTitle === 'string'
      ? this.chatService.currentSessionTitle
      : '';
    if (isMeaningfulRuntimeSessionTitle(currentTitle)
      && this.chatService.currentSessionTitleSource !== 'default-first-request') {
      console.info('[AilyChat][SendTitle]', {
        event: 'skip-default-title-existing-meaningful',
        currentTitle,
        currentSource: this.chatService.currentSessionTitleSource,
      });
      return;
    }

    const firstUserMessageContent = readFirstUserMessageContent(this.conversationMessages);
    const defaultTitle = deriveDefaultSessionTitle(firstUserMessageContent ?? content);
    if (!defaultTitle) {
      console.info('[AilyChat][SendTitle]', {
        event: 'skip-default-title-empty',
        contentLength: typeof content === 'string' ? content.trim().length : 0,
      });
      return;
    }

    if (typeof this.chatService.setCurrentSessionTitle === 'function') {
      this.chatService.setCurrentSessionTitle({
        text: defaultTitle,
        source: 'default-first-request',
      });
    } else {
      this.chatService.currentSessionTitle = defaultTitle;
    }
    console.info('[AilyChat][SendTitle]', {
      event: 'apply-default-title',
      title: defaultTitle,
      source: firstUserMessageContent ? 'first-user-message' : 'current-content',
    });
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

    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
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
  ): Promise<void> {
    const explicitSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeSessionId = explicitSessionId
      || (typeof (this as unknown as { resolveActiveRuntimeSessionId?: () => string }).resolveActiveRuntimeSessionId === 'function'
      ? this.resolveActiveRuntimeSessionId()
      : (typeof this.sessionId === 'string' ? this.sessionId.trim() : ''));
    const requestInProgress = typeof (this as unknown as { readVisibleSessionRequestInProgress?: (sessionId?: string | null) => boolean }).readVisibleSessionRequestInProgress === 'function'
      ? this.readVisibleSessionRequestInProgress(runtimeSessionId)
      : this.isWaiting;
    if (!runtimeSessionId || requestInProgress) {
      return;
    }

    const resumeRequestMetadata = {
      ...(requestMetadata ?? {}),
      interactionAction,
    };
    this.lexStream.turn.begin(
      content,
      content,
      this.sendCoordinator?.applyRuntimeRequestMetadata?.(resumeRequestMetadata)
        ?? this.sendCoordinator?.applyRuntimePromptContext?.(resumeRequestMetadata)
        ?? resumeRequestMetadata,
    );
    await this.lexStream.turn.run(content, content);
    this.acceptLiveRequestQuotaState(runtimeSessionId);
    this.refreshAuthQuotaStateAfterSuccessfulTurn(runtimeSessionId);

    if (runtimeSessionId) {
      const runtimeTurnResponses = (
        (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
          .readRuntimeTurnResponsesForOwner
        ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
      ).call(this, runtimeSessionId);
      await this.chatService.syncResolvedActiveModelAfterSuccessfulTurn(
        runtimeSessionId,
        runtimeTurnResponses.length > 0
          ? runtimeTurnResponses
          : this.hostResponseProjection?.turnResponses ?? this.lexStream.turnResponses ?? [],
      );
      this.triggerSyncDetectChanges();
    }

    const presentPendingPlanReviewFromLatestContinuation = (
      this as unknown as { presentPendingPlanReviewFromLatestContinuation?: (sessionId?: string | null) => Promise<void> }
    ).presentPendingPlanReviewFromLatestContinuation;
    void presentPendingPlanReviewFromLatestContinuation?.call(this, runtimeSessionId);
  }

  private async submitSessionInteractionActionRequest(
    sessionId: string | null | undefined,
    content: string,
    interactionAction: NonNullable<TurnRequest['metadata']>['interactionAction'],
    requestMetadata?: TurnRequest['metadata'],
  ): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      await this.resumeRestoredInteraction(content, interactionAction, requestMetadata);
      return;
    }

    await this.runWithRuntimeSessionOwner(targetSessionId, async () => {
      await this.ensureRuntimeAgentForSession(targetSessionId);
      await this.resumeRestoredInteraction(content, interactionAction, requestMetadata, targetSessionId);
    });
  }

  private readLatestInteractionContinuation(sessionId?: string | null): TurnResponseTurn['response']['continuation'] | undefined {
    const turns = (
      (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
        .readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
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
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const resolveRuntimeSessionProviderOptions = (
      this as unknown as { resolveRuntimeSessionProviderOptions?: (sessionId?: string | null) => HostSessionProviderOptions }
    ).resolveRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['resolveRuntimeSessionProviderOptions'];
    const resolveRuntimeSelectedMode = (
      this as unknown as { resolveRuntimeSelectedMode?: (sessionId?: string | null) => ChatSelectedMode }
    ).resolveRuntimeSelectedMode
      ?? ChatEngineService.prototype['resolveRuntimeSelectedMode'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    const providerOptions = resolveRuntimeSessionProviderOptions.call(this, targetSessionId);
    return {
      sessionId: targetSessionId,
      selectedMode: resolveRuntimeSelectedMode.call(this, targetSessionId),
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
    const rememberRuntimeSessionProviderOptions = (
      this as unknown as {
        rememberRuntimeSessionProviderOptions?: (
          sessionId: string | null | undefined,
          providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
        ) => HostSessionProviderOptions | null;
      }
    ).rememberRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['rememberRuntimeSessionProviderOptions'];
    const rememberRuntimeSelectedMode = (
      this as unknown as {
        rememberRuntimeSelectedMode?: (
          sessionId: string | null | undefined,
          selectedMode: ChatSelectedMode | null | undefined,
        ) => ChatSelectedMode | null;
      }
    ).rememberRuntimeSelectedMode
      ?? ChatEngineService.prototype['rememberRuntimeSelectedMode'];
    const shouldProjectRuntimeViewStateToVisibleOwner = (
      this as unknown as { shouldProjectRuntimeViewStateToVisibleOwner?: (sessionId?: string | null) => boolean }
    ).shouldProjectRuntimeViewStateToVisibleOwner
      ?? ChatEngineService.prototype['shouldProjectRuntimeViewStateToVisibleOwner'];
    rememberRuntimeSessionProviderOptions.call(this, state.sessionId, state.providerOptions);
    rememberRuntimeSelectedMode.call(this, state.sessionId, state.selectedMode);

    const shouldProjectToVisibleOwner = shouldProjectRuntimeViewStateToVisibleOwner.call(this, state.sessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (!shouldProjectToVisibleOwner) {
      return;
    }

    this.chatService.setCurrentSessionPermissionMode(state.providerOptions.permissionMode);
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

  private async applyRuntimeSelectedModeTransition(
    sessionId: string | null | undefined,
    selectedMode: ChatSelectedMode,
  ): Promise<void> {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const rememberRuntimeSelectedMode = (
      this as unknown as {
        rememberRuntimeSelectedMode?: (
          sessionId: string | null | undefined,
          selectedMode: ChatSelectedMode | null | undefined,
        ) => ChatSelectedMode | null;
      }
    ).rememberRuntimeSelectedMode
      ?? ChatEngineService.prototype['rememberRuntimeSelectedMode'];
    const shouldProjectRuntimeViewStateToVisibleOwner = (
      this as unknown as { shouldProjectRuntimeViewStateToVisibleOwner?: (sessionId?: string | null) => boolean }
    ).shouldProjectRuntimeViewStateToVisibleOwner
      ?? ChatEngineService.prototype['shouldProjectRuntimeViewStateToVisibleOwner'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    const normalizedMode = rememberRuntimeSelectedMode.call(this, targetSessionId, selectedMode)
      ?? normalizeChatSelectedMode(selectedMode);

    const shouldProjectToVisibleOwner = shouldProjectRuntimeViewStateToVisibleOwner.call(this, targetSessionId)
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
  ): Promise<void> {
    const resolveRuntimeSessionIdForOwner = (
      this as unknown as { resolveRuntimeSessionIdForOwner?: (sessionId?: string | null) => string }
    ).resolveRuntimeSessionIdForOwner
      ?? ChatEngineService.prototype['resolveRuntimeSessionIdForOwner'];
    const resolveRuntimeSessionProviderOptions = (
      this as unknown as { resolveRuntimeSessionProviderOptions?: (sessionId?: string | null) => HostSessionProviderOptions }
    ).resolveRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['resolveRuntimeSessionProviderOptions'];
    const rememberRuntimeSessionProviderOptions = (
      this as unknown as {
        rememberRuntimeSessionProviderOptions?: (
          sessionId: string | null | undefined,
          providerOptions: Partial<HostSessionProviderOptions> | null | undefined,
        ) => HostSessionProviderOptions | null;
      }
    ).rememberRuntimeSessionProviderOptions
      ?? ChatEngineService.prototype['rememberRuntimeSessionProviderOptions'];
    const shouldProjectRuntimeViewStateToVisibleOwner = (
      this as unknown as { shouldProjectRuntimeViewStateToVisibleOwner?: (sessionId?: string | null) => boolean }
    ).shouldProjectRuntimeViewStateToVisibleOwner
      ?? ChatEngineService.prototype['shouldProjectRuntimeViewStateToVisibleOwner'];
    const resolveRuntimeResolvedMode = (
      this as unknown as { resolveRuntimeResolvedMode?: (sessionId?: string | null) => ChatResolvedMode }
    ).resolveRuntimeResolvedMode
      ?? ChatEngineService.prototype['resolveRuntimeResolvedMode'];
    const applyRuntimeSelectedModeTransition = (
      this as unknown as {
        applyRuntimeSelectedModeTransition?: (
          sessionId: string | null | undefined,
          selectedMode: ChatSelectedMode,
        ) => Promise<void>;
      }
    ).applyRuntimeSelectedModeTransition
      ?? ChatEngineService.prototype['applyRuntimeSelectedModeTransition'];
    const targetSessionId = resolveRuntimeSessionIdForOwner.call(this, sessionId);
    const permissionMode = resolvePlanReviewPermissionMode(pendingReview, result);
    const permissionLevel = resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel);
    const baseProviderOptions = resolveRuntimeSessionProviderOptions.call(this, targetSessionId);
    const nextProviderOptions = rememberRuntimeSessionProviderOptions.call(this, targetSessionId, {
      ...baseProviderOptions,
      ...(permissionMode ? { permissionMode } : {}),
      permissionLevel,
    });

    const shouldProjectToVisibleOwner = shouldProjectRuntimeViewStateToVisibleOwner.call(this, targetSessionId)
      || !(this as unknown as { chatSessionRuntimeStore?: unknown }).chatSessionRuntimeStore;
    if (shouldProjectToVisibleOwner && permissionMode) {
      this.chatService.setCurrentSessionPermissionMode(permissionMode);
    }
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

    if (!shouldStartImplementationAfterPlanReview(pendingReview, result)) {
      return;
    }

    const handoff = resolveStartImplementationHandoff(resolveRuntimeResolvedMode.call(this, targetSessionId));
    if (!handoff) {
      await applyRuntimeSelectedModeTransition.call(this, targetSessionId, { modeId: 'agent' });
      return;
    }

    const targetMode = resolveChatSurfaceModeId(handoff.agent);
    if (targetMode) {
      await applyRuntimeSelectedModeTransition.call(this, targetSessionId, { modeId: targetMode });
      return;
    }

    await applyRuntimeSelectedModeTransition.call(this, targetSessionId, {
      modeId: 'agent',
      customAgentTarget: handoff.agent,
    });
    if (nextProviderOptions) {
      rememberRuntimeSessionProviderOptions.call(this, targetSessionId, nextProviderOptions);
    }
  }

  private async presentPendingPlanReviewFromLatestContinuation(sessionId?: string | null): Promise<void> {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : typeof (this as unknown as { resolveActiveRuntimeSessionId?: () => string }).resolveActiveRuntimeSessionId === 'function'
      ? this.resolveActiveRuntimeSessionId()
      : (typeof this.sessionId === 'string' ? this.sessionId.trim() : '');
    if (!targetSessionId) {
      return;
    }

    const turnResponses = (
      (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
        .readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
    ).call(this, targetSessionId);
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
        await this.applyPlanReviewTransitionBeforeResume(targetSessionId, pendingReview, result, currentRequestPermissionLevel);
        await this.submitInteractionActionRequest(
          buildPlanReviewResumeContent(pendingReview, result),
          buildPlanReviewInteractionAction(continuation, result),
          resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel)
            ? {
                modeInfo: {
                  permissionLevel: resolvePlanReviewPermissionLevel(pendingReview, result, currentRequestPermissionLevel),
                },
              }
            : undefined,
          targetSessionId,
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
    const shouldProjectQuotaStateToVisibleOwner = (
      this as unknown as { shouldProjectQuotaStateToVisibleOwner?: (sessionId?: string | null) => boolean }
    ).shouldProjectQuotaStateToVisibleOwner
      ?? ChatEngineService.prototype['shouldProjectQuotaStateToVisibleOwner'];
    if (!shouldProjectQuotaStateToVisibleOwner.call(this, sessionId)) {
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

  private acceptLiveRequestQuotaState(sessionId?: string | null): void {
    const runtimeTurnResponses = (
      (this as unknown as { readRuntimeTurnResponsesForOwner?: (sessionId?: string | null) => readonly TurnResponseTurn[] })
        .readRuntimeTurnResponsesForOwner
      ?? ChatEngineService.prototype['readRuntimeTurnResponsesForOwner']
    ).call(this, sessionId);
    const turnResponses = runtimeTurnResponses.length > 0
      ? runtimeTurnResponses
      : this.hostResponseProjection?.turnResponses ?? this.lexStream.turnResponses ?? [];
    const syncRuntimeQuotaOverlayFromTurnResponses = (
      this as unknown as {
        syncRuntimeQuotaOverlayFromTurnResponses?: (
          sessionId: string | null | undefined,
          turnResponses: readonly TurnResponseTurn[] | null | undefined,
        ) => ChatSessionRuntimeQuotaOverlay | null;
      }
    ).syncRuntimeQuotaOverlayFromTurnResponses
      ?? ChatEngineService.prototype['syncRuntimeQuotaOverlayFromTurnResponses'];
    syncRuntimeQuotaOverlayFromTurnResponses.call(this, sessionId, turnResponses);

    const shouldProjectQuotaStateToVisibleOwner = (
      this as unknown as { shouldProjectQuotaStateToVisibleOwner?: (sessionId?: string | null) => boolean }
    ).shouldProjectQuotaStateToVisibleOwner
      ?? ChatEngineService.prototype['shouldProjectQuotaStateToVisibleOwner'];
    if (!shouldProjectQuotaStateToVisibleOwner.call(this, sessionId)) {
      return;
    }

    this.requestQuotaStateService.acceptTurnResponseQuotaSnapshot(turnResponses);
    this.projectAuthQuotaStateFromRequestQuota();
  }

  private shouldProjectQuotaStateToVisibleOwner(sessionId?: string | null): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return true;
    }

    const currentSessionId = typeof this.chatService?.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : typeof this.sessionId === 'string'
        ? this.sessionId.trim()
        : '';
    return !!currentSessionId && currentSessionId === targetSessionId;
  }

  private syncRuntimeQuotaOverlayFromTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): ChatSessionRuntimeQuotaOverlay | null {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : (typeof (this as unknown as { resolveActiveRuntimeSessionId?: () => string }).resolveActiveRuntimeSessionId === 'function'
          ? this.resolveActiveRuntimeSessionId()
          : '');
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
    if (this.chatSessionRuntimeRegistry) {
      this.chatSessionRuntimeRegistry.projectRuntimeState(targetSessionId, runtimeStatePatch);
    } else if (this.chatSessionRuntimeStore) {
      this.chatSessionRuntimeStore.replaceRuntimeState(targetSessionId, runtimeStatePatch);
    }
    return quotaOverlay;
  }

  private projectRuntimeQuotaOverlayToVisibleServices(
    runtimeState: ChatSessionRuntimeState | null | undefined,
  ): void {
    if (!runtimeState?.quotaOverlay && (!runtimeState?.turnResponses || runtimeState.turnResponses.length === 0)) {
      this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(null);
      return;
    }

    this.requestQuotaStateService.acceptTurnResponseQuotaSnapshot(runtimeState.turnResponses ?? []);
    this.chatInputNoticeStateService.acceptProjectedRuntimeNotice(
      runtimeState.quotaOverlay?.requestInputNotice ?? null,
    );
    this.projectAuthQuotaStateFromRequestQuota(
      runtimeState.quotaOverlay?.requestQuotaState ?? this.requestQuotaStateService.getSnapshot(),
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

  resetChat(): Promise<void> { return this.session.newChat(); }

  private async requestNewChatFromPane(): Promise<void> {
    const requestNewChat = this.paneSessionCommandHandlers.requestNewChat;
    if (typeof requestNewChat === 'function') {
      await requestNewChat();
      return;
    }

    await this.newChat();
  }

  // ==================== 停止 ====================

  stop(sessionId?: string | null): boolean {
    return this.stopSessionAction(sessionId);
  }

  // ==================== 模式 / 模型切换 ====================

  async switchToModel(model: ModelConfig): Promise<void> {
    await this.switchCoordinator.switchToModel(model);
  }

  async switchToMode(mode: string): Promise<void> {
    await this.switchCoordinator.switchToMode(mode);
  }

  async switchToCustomAgent(selection: { readonly modeId?: string; readonly customAgentTarget?: string }): Promise<void> {
    await this.switchCoordinator.switchToCustomAgent(selection);
  }

  async switchToReasoningEffort(reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>): Promise<void> {
    await this.switchCoordinator.switchToReasoningEffort(reasoningEffort);
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

  private handleTaskAction(event: ChatTaskActionEvent): void {
    this.taskActionCoordinator.handle(event.detail);
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

  resolveAskUserResponse(answer: string, wasFreeform: boolean): void {
    this.interaction.resolveAskUserResponse(answer, wasFreeform);
  }

  skipAskUserResponse(): void {
    this.interaction.skipAskUserResponse();
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
