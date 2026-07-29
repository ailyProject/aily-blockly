import {
  type SessionSnapshot,
  type TurnRequest,
  type TurnResponseCommand,
  type TurnResponseFollowup,
  type TurnResponsePart,
  type TurnResponseToolCallPart,
  type TurnResponseTurn,
} from 'aily-lex/browser';

import type { ChatPartStore, ChatPartStoreReadableHandle } from '../core/chat-part-store';
import type { ChatPart } from '../core/chat-parts';
import { upsertTurnResponseProgress } from '../core/turn-response-progress';
import type {
  CanonicalRenderItemKind,
  CanonicalRenderItemStatus,
  CanonicalRenderItemScope,
  CanonicalRenderLifecycleEvent,
} from '../core/render-event-item-lifecycle';
import {
  collectMainTurnResponseText,
  isSubagentScopedTurnResponsePart,
  projectTurnResponseDisplayParts,
  turnResponsePartsToDisplayChatParts,
} from '../core/turn-response-part-mapper';
import {
  buildDialogTurnContext,
  type DialogTurnContext,
} from '../core/user-turn-action-target';
import {
  buildTurnResponseAssistantMessageProjection,
  getTurnResponseAssistantText,
  getTurnResponseParticipant,
  buildTurnResponseUserMessageProjection,
  type TurnResponseAssistantEntryProjection,
  type TurnResponseUserEntryProjection,
} from '../core/turn-response-stream-contract';
import {
  cloneTurnResponseModelSidecar,
  normalizeTurnResponseSummaryPreview,
} from './turn-response-response-model';
import { isTerminalSessionToolName } from '../core/tool-name-normalizer';

function applyHostStreamResponseProgressUpdate(
  baseTurn: TurnResponseTurn,
  event: HostStreamResponseReferenceEvent | HostStreamResponseCodeCitationEvent | HostStreamResponseProgressMessageEvent,
): TurnResponseTurn {
  const nextResponse = {
    ...baseTurn.response,
    updatedAt: event.updatedAt,
  };

  switch (event.itemType) {
    case 'response_reference':
      if (event.value == null || event.value.kind === 'usedContext') {
        const usedContext = event.value == null
          ? null
          : event.value as TurnResponseTurn['response']['usedContext'];
        nextResponse.usedContext = cloneHostStreamUsedContext(usedContext) ?? undefined;
        break;
      }

      nextResponse.contentReferences = [
        ...(nextResponse.contentReferences ?? []),
        cloneHostStreamContentReference(event.value),
      ];
      break;
    case 'response_code_citation':
      nextResponse.codeCitations = [
        ...(nextResponse.codeCitations ?? []),
        cloneHostStreamCodeCitation(event.value),
      ];
      break;
    case 'response_progress_message':
      nextResponse.progressMessages = upsertTurnResponseProgress(
        nextResponse.progressMessages,
        cloneHostStreamProgressMessage(event.value),
      );
      break;
  }

  return {
    ...baseTurn,
    updatedAt: event.updatedAt,
    response: nextResponse,
  };
}
import {
  type ChatDialogViewMessageProjection,
  type ChatDialogViewItem,
} from './chat-dialog-view-items';
import { projectToolCallApprovalDisplayData } from '../core/tool-call-approval';
import type {
  ChatListItem,
  PersistedHostResponseData,
  PersistedHostTurnResponse,
} from '../services/chat-history.service';

type HostResponsePartStore = {
  hasPartsForHandle(handle: ChatPartStoreReadableHandle | null): boolean;
  getPartsForHandle(handle: ChatPartStoreReadableHandle | null): ChatPart[];
  serializeToContentHandle(handle: ChatPartStoreReadableHandle | null): string;
}
  & Partial<Pick<ChatPartStore, 'revision'>>;

const EMPTY_HOST_RESPONSE_PART_STORE: HostResponsePartStore = {
  hasPartsForHandle: () => false,
  getPartsForHandle: () => [],
  serializeToContentHandle: () => '',
};

export type HostTurnEntryUserProjection = TurnResponseUserEntryProjection;

export type HostTurnEntryAssistantProjection = TurnResponseAssistantEntryProjection;

export interface HostRequestModel {
  readonly id: string;
  readonly turnId: string;
  readonly timestamp: number;
  readonly message: TurnRequest;
  readonly response: HostResponseModel | null;
}

export interface HostTurnResponseEntry {
  kind: 'turn';
  turnId: string;
  turnResponse: TurnResponseTurn | null;
  user: HostTurnEntryUserProjection | null;
  assistant: HostTurnEntryAssistantProjection | null;
  runtimeState?: HostTurnRuntimeState;
}

export type HostResponseEntry = HostTurnResponseEntry;

export const enum HostResponseModelStateValue {
  Pending,
  Complete,
  Cancelled,
  Failed,
  NeedsInput,
}

export type HostResponseModelState =
  | { value: HostResponseModelStateValue.Pending }
  | { value: HostResponseModelStateValue.NeedsInput }
  | { value: HostResponseModelStateValue.Complete | HostResponseModelStateValue.Cancelled | HostResponseModelStateValue.Failed; completedAt: number };

export type HostResponseVoteDirection = 0 | 1;

export interface HostResponseMarkdownInfo {
  readonly suggestionId: string;
}

export interface HostResponseModel {
  readonly requestId: string | null;
  readonly request: HostRequestModel | null;
  readonly id: string | null;
  readonly state: TurnResponseTurn['response']['status'] | null;
  readonly slashCommand: TurnResponseCommand | null;
  readonly summaryPreview: string | null;
  readonly agentOrSlashCommandDetected: boolean;
  readonly usedContext: TurnResponseTurn['response']['usedContext'] | null;
  readonly contentReferences: readonly NonNullable<TurnResponseTurn['response']['contentReferences']>[number][];
  readonly codeCitations: readonly NonNullable<TurnResponseTurn['response']['codeCitations']>[number][];
  readonly progressMessages: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][];
  readonly followups: readonly TurnResponseFollowup[];
  readonly completedAt: number | null;
  readonly terminationReason: TurnResponseTurn['response']['terminationReason'] | null;
  readonly isComplete: boolean;
  readonly isCanceled: boolean;
  readonly isIncomplete: boolean;
  readonly isStale: boolean;
  readonly response: HostResponseView | null;
  readonly entireResponse: HostResponseView | null;
  readonly isPendingConfirmation: HostPendingConfirmationState | null;
  readonly responseMarkdownInfo: readonly HostResponseMarkdownInfo[];
  readonly modelState: HostResponseModelState;
  readonly vote: HostResponseVoteDirection | undefined;
  readonly timestamp: number | null;
  readonly elapsedMs: number | null;
  readonly confirmationAdjustedTimestamp: number | null;
  readonly usage: TurnResponseTurn['usage'] | null;
  readonly completionTokenCount: number | null;
}

export interface HostResponseProjection {
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly chatList: readonly ChatListItem[];
  readonly dialogItems: readonly ChatDialogViewItem[];
}

export function applyHostResponseVoteToState(
  state: HostTurnResponseState | null,
  turnId: string,
  vote: HostResponseVoteDirection,
): HostTurnResponseState | null {
  if (!state || !turnId) {
    return state;
  }

  let changed = false;
  const nextEntries = state.entries.map(entry => {
    if (entry.kind !== 'turn' || entry.turnId !== turnId) {
      return entry;
    }

    if (entry.runtimeState?.responseSidecar?.vote === vote) {
      return entry;
    }

    changed = true;
    const nextEntry = cloneHostTurnResponseEntry(entry);
    nextEntry.runtimeState = compactHostTurnRuntimeState({
      ...nextEntry.runtimeState,
      responseSidecar: compactHostResponseSidecarRuntimeState({
        ...nextEntry.runtimeState?.responseSidecar,
        vote,
      }),
    });
    return nextEntry;
  });

  return changed ? buildHostResponseStateFromEntries(nextEntries) : state;
}

export interface HostTurnResponseState extends HostResponseProjection {
  readonly entries: readonly HostResponseEntry[];
}

export interface HostResponseView {
  readonly turnId: string;
  readonly id: string;
  readonly participant: string;
  readonly state: TurnResponseTurn['response']['status'];
  readonly usedContext: TurnResponseTurn['response']['usedContext'] | null;
  readonly contentReferences: readonly NonNullable<TurnResponseTurn['response']['contentReferences']>[number][];
  readonly codeCitations: readonly NonNullable<TurnResponseTurn['response']['codeCitations']>[number][];
  readonly progressMessages: readonly NonNullable<TurnResponseTurn['response']['progressMessages']>[number][];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminationReason: TurnResponseTurn['response']['terminationReason'] | null;
  readonly isComplete: boolean;
  readonly isCanceled: boolean;
  readonly value: readonly TurnResponsePart[];
  getMarkdown(): string;
  getFinalResponse(): string;
  toString(): string;
}

export interface HostPendingConfirmationState {
  readonly startedWaitingAt: number;
  readonly detail?: string;
}

export type HostResponseClearToPreviousToolInvocationReason =
  | 'no_reason'
  | 'filtered_content_retry'
  | 'copyright_content_retry';

interface HostTurnWaitingRuntimeState {
  readonly accumulatedMs: number;
  readonly startedAt?: number;
  readonly detail?: string;
}

interface HostResponseSidecarRuntimeState {
  readonly slashCommand?: TurnResponseCommand | null;
  readonly responseId?: string;
  readonly result?: string;
  readonly responseMarkdownInfo?: readonly HostResponseMarkdownInfo[];
  readonly followups?: readonly TurnResponseFollowup[];
  readonly modelState?: HostResponseModelState;
  readonly vote?: HostResponseVoteDirection;
  readonly timestamp?: number;
  readonly elapsedMs?: number;
  readonly timeSpentWaiting?: number;
  readonly completionTokens?: number;
}

interface HostTurnResponseClearRuntimeState {
  readonly prefixPartCount: number;
  readonly clearedPartCount: number;
  readonly reason: HostResponseClearToPreviousToolInvocationReason;
  readonly message?: string;
}

interface HostResponseProjectionBuildOptions {
  readonly disabledRequestTurnIds?: readonly string[];
  readonly previousDialogItems?: readonly ChatDialogViewItem[] | null;
  readonly dialogItemStore?: HostDialogItemProjectionStore;
}

export interface HostDialogProjectionMetrics {
  readonly itemCount: number;
  readonly changedItemCount: number;
  readonly reusedTurnCount: number;
  readonly rebuiltTurnCount: number;
  readonly frozenTurnCount: number;
  readonly prunedTurnCount: number;
  readonly durationMs: number;
}

export interface HostItemLifecycleItemSnapshot {
  readonly itemId: string;
  readonly itemKind: CanonicalRenderItemKind;
  readonly status: CanonicalRenderItemStatus;
  readonly scope?: CanonicalRenderItemScope;
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly deltaCount: number;
  readonly totalDeltaBytes: number;
  readonly lastSourceEventType?: string;
}

export interface HostItemLifecycleTurnSnapshot {
  readonly turnId: string;
  readonly status: CanonicalRenderItemStatus;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly updatedAt: number;
  readonly itemCount: number;
  readonly runningItemCount: number;
  readonly completedItemCount: number;
  readonly failedItemCount: number;
  readonly cancelledItemCount: number;
  readonly deltaCount: number;
  readonly totalDeltaBytes: number;
  readonly recentItems: readonly HostItemLifecycleItemSnapshot[];
}

export interface HostItemLifecycleSnapshot {
  readonly turnCount: number;
  readonly runningTurnCount: number;
  readonly itemCount: number;
  readonly runningItemCount: number;
  readonly deltaCount: number;
  readonly totalDeltaBytes: number;
  readonly turns: readonly HostItemLifecycleTurnSnapshot[];
}

interface HostTurnRuntimeState {
  readonly waiting?: HostTurnWaitingRuntimeState;
  readonly responseClear?: HostTurnResponseClearRuntimeState;
  readonly responseSidecar?: HostResponseSidecarRuntimeState;
}

interface HostResponseTimingState {
  readonly timestamp: number;
  readonly elapsedMs: number;
  readonly confirmationAdjustedTimestamp: number;
}

export interface PersistedHostResponseRecordInput {
  readonly turnResponses?: readonly PersistedHostTurnResponse[];
  readonly sidecar?: {
    readonly response?: {
      readonly compatMessages?: unknown[];
    };
  };
}

export interface LiveHostRequestGraphSource {
  readonly liveTurnResponses: readonly TurnResponseTurn[];
  readonly responseOwnerTurnId: string | null;
  readonly disabledRequestTurnIds: readonly string[];
  getSnapshot(): SessionSnapshot | null;
}

interface HostResponseOwnerBinding {
  readonly turnId: string;
  readonly turn: TurnResponseTurn;
  readonly runtimeState?: HostTurnRuntimeState;
}

interface ResolvedLiveHostRequestGraphSource {
  readonly snapshot: SessionSnapshot | null;
  readonly liveTurnResponses: readonly TurnResponseTurn[];
  readonly orderedTurnIds: readonly string[];
  readonly responseOwner: HostResponseOwnerBinding | null;
  readonly disabledRequestTurnIds: readonly string[];
  readonly responseOwnerUpdatedAt: number;
  readonly tailMessage: ChatListItem | undefined;
}

interface LiveHostRequestGraphStamp {
  readonly viewRevision: number;
  readonly turnEntryStateRevision: number;
  readonly sourceHasConversationContent: boolean;
  readonly disabledRequestTurnIdsKey: string;
  readonly chatListLength: number;
  readonly lastMessageRole: string;
  readonly lastMessageState: string;
  readonly lastMessageSource: string;
  readonly lastMessageTurnId: string;
  readonly lastMessageContent: string;
  readonly partStoreRevision: number;
  readonly snapshotRevision: number;
  readonly snapshotUpdatedAt: number;
  readonly liveTurnCount: number;
  readonly liveTurnLastId: string;
  readonly liveTurnLastUpdatedAt: number;
  readonly responseOwnerTurnId: string;
  readonly responseOwnerUpdatedAt: number;
}

export function createLiveHostRequestGraphSource(
  getSnapshot: () => SessionSnapshot | null,
  liveTurnResponses: readonly TurnResponseTurn[],
  responseOwnerTurnId: string | null = null,
  disabledRequestTurnIds: readonly string[] = [],
): LiveHostRequestGraphSource {
  const normalizedLiveTurnResponses = normalizeLiveTurnResponses(liveTurnResponses);
  const normalizedDisabledRequestTurnIds = Array.from(new Set(
    disabledRequestTurnIds.filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0),
  ));
  return {
    getSnapshot,
    liveTurnResponses: normalizedLiveTurnResponses,
    responseOwnerTurnId,
    disabledRequestTurnIds: normalizedDisabledRequestTurnIds,
  };
}

export function enrichLiveTurnResponsesFromHostView(
  _snapshot: SessionSnapshot | null,
  _chatList: readonly ChatListItem[],
  _partStore: HostResponsePartStore,
  liveTurnResponses: readonly TurnResponseTurn[],
): TurnResponseTurn[] {
  return normalizeLiveTurnResponses(liveTurnResponses);
}

// ---- H1: Host-facing Stream Contract ----
// These types define the protocol between the extension-side stream aggregator
// (LexRenderEventBridge) and the host-side request-graph consumer (LiveHostRequestGraphCache).
// The contract now exposes a single incremental turn snapshot upsert instead of
// separate begin/update notifications, bringing the host side closer to the shared
// turn-response stream builder contract.

export type HostStreamResponseItemType =
  | 'response_started'
  | 'turn_request_update'
  | 'turn_rounds_update'
  | 'response_identity_update'
  | 'response_reference'
  | 'response_code_citation'
  | 'response_progress_message'
  | 'response_followups'
  | 'response_status_update'
  | 'usage'
  | 'clear_to_previous_tool_invocation'
  | 'response_part_update';

interface HostStreamResponseItemBase<TItemType extends HostStreamResponseItemType> {
  itemType: TItemType;
}

export interface HostStreamResponsePartUpdateEvent extends HostStreamResponseItemBase<'response_part_update'> {
  partIndex: number;
  updatedAt: number;
  kind: 'add' | 'update' | 'append';
  part: TurnResponseTurn['response']['parts'][number];
  appendTextMode?: 'delta';
}

export interface HostStreamResponseStartedEvent extends HostStreamResponseItemBase<'response_started'> {
  createdAt: number;
}

export interface HostStreamTurnRequestUpdateEvent extends HostStreamResponseItemBase<'turn_request_update'> {
  value: HostStreamTurnRequestPatch;
}

export interface HostStreamTurnRequestPatch {
  content?: string;
  displayContent?: string;
}

export interface HostStreamTurnRoundsUpdateEvent extends HostStreamResponseItemBase<'turn_rounds_update'> {
  value: HostStreamTurnRoundsPatch;
}

export interface HostStreamTurnRoundsPatch {
  startIndex: number;
  rounds: TurnResponseTurn['rounds'];
}

export interface HostStreamResponseIdentityPatch {
  participant?: string | null;
  slashCommand?: TurnResponseCommand | null;
}

export interface HostStreamResponseIdentityUpdateEvent extends HostStreamResponseItemBase<'response_identity_update'> {
  value: HostStreamResponseIdentityPatch;
  updatedAt: number;
}

export type HostStreamResponseReferenceValue = TurnResponseTurn['response']['usedContext']
  | NonNullable<TurnResponseTurn['response']['contentReferences']>[number]
  | null;

export interface HostStreamResponseReferenceEvent extends HostStreamResponseItemBase<'response_reference'> {
  value: HostStreamResponseReferenceValue;
  updatedAt: number;
}

export interface HostStreamResponseCodeCitationEvent extends HostStreamResponseItemBase<'response_code_citation'> {
  value: NonNullable<TurnResponseTurn['response']['codeCitations']>[number];
  updatedAt: number;
}

export interface HostStreamResponseProgressMessageEvent extends HostStreamResponseItemBase<'response_progress_message'> {
  value: NonNullable<TurnResponseTurn['response']['progressMessages']>[number];
  updatedAt: number;
}

export interface HostStreamResponseFollowupsEvent extends HostStreamResponseItemBase<'response_followups'> {
  value: readonly TurnResponseFollowup[] | undefined;
  updatedAt: number;
}

export interface HostStreamResponseStatusUpdateEvent extends HostStreamResponseItemBase<'response_status_update'> {
  value: TurnResponseTurn['response']['status'];
  updatedAt: number;
}

export interface HostStreamUsageEvent extends HostStreamResponseItemBase<'usage'> {
  value: NonNullable<TurnResponseTurn['usage']>;
  updatedAt: number;
}

export interface HostStreamClearToPreviousToolInvocationEvent extends HostStreamResponseItemBase<'clear_to_previous_tool_invocation'> {
  updatedAt: number;
  reason: HostResponseClearToPreviousToolInvocationReason;
}

export type HostStreamTurnUpdateEvent =
  | HostStreamTurnRequestUpdateEvent
  | HostStreamTurnRoundsUpdateEvent;

export type HostStreamResponseUpdateEvent =
  | HostStreamResponseIdentityUpdateEvent
  | HostStreamResponseReferenceEvent
  | HostStreamResponseCodeCitationEvent
  | HostStreamResponseProgressMessageEvent
  | HostStreamResponseFollowupsEvent
  | HostStreamResponseStatusUpdateEvent
  | HostStreamUsageEvent;

export type HostStreamResponseItem =
  | HostStreamResponseStartedEvent
  | HostStreamTurnUpdateEvent
  | HostStreamResponseUpdateEvent
  | HostStreamClearToPreviousToolInvocationEvent
  | HostStreamResponsePartUpdateEvent;

export function createHostStreamResponseStartedItem(createdAt: number): HostStreamResponseStartedEvent {
  return {
    itemType: 'response_started',
    createdAt,
  };
}

export function createHostStreamTurnRequestUpdateItem(
  value: HostStreamTurnRequestPatch,
): HostStreamTurnRequestUpdateEvent {
  return {
    itemType: 'turn_request_update',
    value,
  };
}

export function createHostStreamTurnRoundsUpdateItem(
  value: HostStreamTurnRoundsPatch,
): HostStreamTurnRoundsUpdateEvent {
  return {
    itemType: 'turn_rounds_update',
    value,
  };
}

function cloneHostStreamResponseIdentityPatch(
  value: HostStreamResponseIdentityPatch,
): HostStreamResponseIdentityPatch {
  const cloned: HostStreamResponseIdentityPatch = {};
  if (Object.prototype.hasOwnProperty.call(value, 'participant')) {
    cloned.participant = value.participant ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'slashCommand')) {
    cloned.slashCommand = value.slashCommand ?? null;
  }
  return cloned;
}

export function createHostStreamResponseIdentityUpdateItem(
  value: HostStreamResponseIdentityPatch,
  updatedAt: number,
): HostStreamResponseIdentityUpdateEvent {
  return {
    itemType: 'response_identity_update',
    value: cloneHostStreamResponseIdentityPatch(value),
    updatedAt,
  };
}

export function createHostStreamResponseReferenceItem(
  value: HostStreamResponseReferenceValue,
  updatedAt: number,
): HostStreamResponseReferenceEvent {
  return {
    itemType: 'response_reference',
    value: value == null
      ? null
      : (value.kind === 'usedContext'
        ? cloneHostStreamUsedContext(value)
        : cloneHostStreamContentReference(value)),
    updatedAt,
  };
}

export function createHostStreamResponseUsedContextItem(
  value: TurnResponseTurn['response']['usedContext'] | null,
  updatedAt: number,
): HostStreamResponseReferenceEvent {
  return createHostStreamResponseReferenceItem(value, updatedAt);
}

export function createHostStreamResponseContentReferenceItem(
  value: NonNullable<TurnResponseTurn['response']['contentReferences']>[number],
  updatedAt: number,
): HostStreamResponseReferenceEvent {
  return createHostStreamResponseReferenceItem(value, updatedAt);
}

export function createHostStreamResponseCodeCitationItem(
  value: NonNullable<TurnResponseTurn['response']['codeCitations']>[number],
  updatedAt: number,
): HostStreamResponseCodeCitationEvent {
  return {
    itemType: 'response_code_citation',
    value: cloneHostStreamCodeCitation(value),
    updatedAt,
  };
}

export function createHostStreamResponseProgressMessageItem(
  value: NonNullable<TurnResponseTurn['response']['progressMessages']>[number],
  updatedAt: number,
): HostStreamResponseProgressMessageEvent {
  return {
    itemType: 'response_progress_message',
    value: cloneHostStreamProgressMessage(value),
    updatedAt,
  };
}

export function createHostStreamResponseFollowupsItem(
  value: readonly TurnResponseFollowup[] | undefined,
  updatedAt: number,
): HostStreamResponseFollowupsEvent {
  return {
    itemType: 'response_followups',
    value: cloneHostStreamFollowups(value),
    updatedAt,
  };
}

export function createHostStreamResponseStatusUpdateItem(
  value: TurnResponseTurn['response']['status'],
  updatedAt: number,
): HostStreamResponseStatusUpdateEvent {
  return {
    itemType: 'response_status_update',
    value,
    updatedAt,
  };
}

export function createHostStreamUsageItem(
  value: NonNullable<TurnResponseTurn['usage']>,
  updatedAt: number,
): HostStreamUsageEvent {
  return {
    itemType: 'usage',
    value: { ...value },
    updatedAt,
  };
}

export function createHostStreamClearToPreviousToolInvocationItem(
  updatedAt: number,
  reason: HostResponseClearToPreviousToolInvocationReason,
): HostStreamClearToPreviousToolInvocationEvent {
  return {
    itemType: 'clear_to_previous_tool_invocation',
    updatedAt,
    reason,
  };
}

export function createHostStreamResponsePartUpdateItem(params: {
  updatedAt: number;
  partIndex: number;
  kind: 'add' | 'update' | 'append';
  part: TurnResponseTurn['response']['parts'][number];
  appendTextMode?: 'delta';
}): HostStreamResponsePartUpdateEvent {
  return {
    itemType: 'response_part_update',
    partIndex: params.partIndex,
    updatedAt: params.updatedAt,
    kind: params.kind,
    part: params.part,
    ...(params.appendTextMode ? { appendTextMode: params.appendTextMode } : {}),
  };
}

export interface HostStreamResponseStartedItemEvent {
  type: 'response_started';
  turnId: string;
  createdAt: number;
}

export interface HostStreamTurnRequestUpdateItemEvent {
  type: 'turn_request_update';
  turnId: string;
  value: HostStreamTurnRequestPatch;
}

export interface HostStreamTurnRoundsUpdateItemEvent {
  type: 'turn_rounds_update';
  turnId: string;
  value: HostStreamTurnRoundsPatch;
}

export interface HostStreamResponseIdentityUpdateItemEvent {
  type: 'response_identity_update';
  turnId: string;
  value: HostStreamResponseIdentityPatch;
  updatedAt: number;
}

export interface HostStreamResponseReferenceItemEvent {
  type: 'reference';
  turnId: string;
  value: HostStreamResponseReferenceValue;
  updatedAt: number;
}

export interface HostStreamResponseCodeCitationItemEvent {
  type: 'codeCitation';
  turnId: string;
  value: NonNullable<TurnResponseTurn['response']['codeCitations']>[number];
  updatedAt: number;
}

export interface HostStreamResponseProgressMessageItemEvent {
  type: 'progress';
  turnId: string;
  value: NonNullable<TurnResponseTurn['response']['progressMessages']>[number];
  updatedAt: number;
}

export interface HostStreamResponseFollowupsItemEvent {
  type: 'response_followups';
  turnId: string;
  value: readonly TurnResponseFollowup[] | undefined;
  updatedAt: number;
}

export interface HostStreamResponseStatusUpdateItemEvent {
  type: 'response_status_update';
  turnId: string;
  value: TurnResponseTurn['response']['status'];
  updatedAt: number;
}

export interface HostStreamUsageItemEvent {
  type: 'usage';
  turnId: string;
  value: NonNullable<TurnResponseTurn['usage']>;
  updatedAt: number;
}

export interface HostStreamClearToPreviousToolInvocationItemEvent {
  type: 'clear_to_previous_tool_invocation' | 'clearToPreviousToolInvocation';
  turnId: string;
  updatedAt: number;
  reason: HostResponseClearToPreviousToolInvocationReason;
}

interface HostStreamPartItemEventBase {
  turnId: string;
  partIndex: number;
  updatedAt: number;
}

export interface HostStreamResponsePartUpdateItemEvent extends HostStreamPartItemEventBase {
  type: 'response_part_update';
  kind: 'add' | 'update' | 'append';
  part: TurnResponseTurn['response']['parts'][number];
}

export interface HostStreamPushItemEvent extends HostStreamPartItemEventBase {
  type: 'push';
  kind: 'add' | 'update' | 'append';
  part: TurnResponseTurn['response']['parts'][number];
}

export interface HostStreamMarkdownItemEvent extends HostStreamPartItemEventBase {
  type: 'markdown';
  kind: 'add' | 'append';
  content: string;
}

export interface HostStreamThinkingProgressItemEvent extends HostStreamPartItemEventBase {
  type: 'thinkingProgress';
  kind: 'add' | 'append' | 'update';
  content: string;
  isComplete: boolean;
}

export interface HostStreamWarningItemEvent extends HostStreamPartItemEventBase {
  type: 'warning';
  message: string;
  part?: Extract<TurnResponsePart, { type: 'warning' }>;
}

export interface HostStreamInfoItemEvent extends HostStreamPartItemEventBase {
  type: 'info';
  message: string;
  part?: Extract<TurnResponsePart, { type: 'info' }>;
}

export interface HostStreamConfirmationItemEvent extends HostStreamPartItemEventBase {
  type: 'confirmation';
  part: Extract<TurnResponsePart, { type: 'confirmation' }>;
}

export interface HostStreamQuestionCarouselItemEvent extends HostStreamPartItemEventBase {
  type: 'question_carousel' | 'questionCarousel';
  part: Extract<TurnResponsePart, { type: 'question' }>;
}

export interface HostStreamBeginToolInvocationItemEvent extends HostStreamPartItemEventBase {
  type: 'begin_tool_invocation' | 'beginToolInvocation';
  part: Extract<TurnResponsePart, { type: 'tool_call' }>;
}

export interface HostStreamUpdateToolInvocationItemEvent extends HostStreamPartItemEventBase {
  type: 'update_tool_invocation' | 'updateToolInvocation';
  part: Extract<TurnResponsePart, { type: 'tool_call' }>;
}

export interface HostStreamSessionClearedEvent {
  type: 'session_cleared';
}

export interface HostStreamItemLifecycleEvent {
  type: 'item_lifecycle';
  turnId: string;
  event: CanonicalRenderLifecycleEvent;
  emittedAt: number;
}

/**
 * Events with a direct or near-direct semantic peer on VS Code ChatResponseStream.
 * These are the only host events that should keep chasing upstream stream-method naming.
 */
export type HostStreamVsCodeStreamLikeEvent =
  | HostStreamResponseReferenceItemEvent
  | HostStreamResponseCodeCitationItemEvent
  | HostStreamResponseProgressMessageItemEvent
  | HostStreamUsageItemEvent
  | HostStreamClearToPreviousToolInvocationItemEvent
  | HostStreamMarkdownItemEvent
  | HostStreamThinkingProgressItemEvent
  | HostStreamInfoItemEvent
  | HostStreamWarningItemEvent
  | HostStreamConfirmationItemEvent
  | HostStreamQuestionCarouselItemEvent
  | HostStreamBeginToolInvocationItemEvent
  | HostStreamUpdateToolInvocationItemEvent;

/**
 * Events that are still required by the local bridge/cache contract but do not map to a
 * real ChatResponseStream method in VS Code. These should evolve toward model/lifecycle
 * boundaries, not be renamed into fake upstream stream methods.
 */
export type HostStreamInternalBridgeEvent =
  | HostStreamResponseStartedItemEvent
  | HostStreamTurnRequestUpdateItemEvent
  | HostStreamTurnRoundsUpdateItemEvent
  | HostStreamResponseIdentityUpdateItemEvent
  | HostStreamResponseFollowupsItemEvent
  | HostStreamResponseStatusUpdateItemEvent
  | HostStreamResponsePartUpdateItemEvent
  | HostStreamPushItemEvent
  | HostStreamItemLifecycleEvent
  | HostStreamSessionClearedEvent;

export type HostStreamEvent = HostStreamVsCodeStreamLikeEvent | HostStreamInternalBridgeEvent;

interface HostItemLifecycleMutableItem {
  itemId: string;
  itemKind: CanonicalRenderItemKind;
  status: CanonicalRenderItemStatus;
  scope?: CanonicalRenderItemScope;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  deltaCount: number;
  totalDeltaBytes: number;
  lastSourceEventType?: string;
}

interface HostItemLifecycleMutableTurn {
  turnId: string;
  status: CanonicalRenderItemStatus;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  items: Map<string, HostItemLifecycleMutableItem>;
  itemOrder: string[];
}

class HostItemLifecycleStore {
  private static readonly MAX_TURNS = 20;
  private static readonly MAX_ITEMS_PER_TURN = 200;
  private readonly turns = new Map<string, HostItemLifecycleMutableTurn>();
  private turnOrder: string[] = [];

  record(turnId: string, event: CanonicalRenderLifecycleEvent): void {
    const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (!normalizedTurnId) {
      return;
    }

    const timestamp = readCanonicalLifecycleTimestamp(event);
    const turn = this.ensureTurn(normalizedTurnId, timestamp);
    switch (event.type) {
      case 'turnStarted':
        turn.status = 'running';
        turn.startedAt = timestamp;
        turn.completedAt = undefined;
        turn.updatedAt = timestamp;
        turn.items.clear();
        turn.itemOrder = [];
        return;
      case 'turnCompleted':
        turn.status = event.status;
        turn.completedAt = timestamp;
        turn.updatedAt = timestamp;
        return;
      case 'itemStarted': {
        const item = this.ensureItem(turn, event.itemId, event.itemKind, timestamp);
        item.status = 'running';
        item.scope = event.scope;
        item.startedAt = item.startedAt ?? timestamp;
        item.updatedAt = timestamp;
        item.lastSourceEventType = event.sourceEventType;
        return;
      }
      case 'itemDelta': {
        const item = this.ensureItem(turn, event.itemId, event.itemKind, timestamp);
        item.scope = event.scope ?? item.scope;
        item.deltaCount += Math.max(1, event.deltaCount ?? 1);
        item.totalDeltaBytes += Math.max(0, event.byteLength ?? 0);
        item.updatedAt = timestamp;
        item.lastSourceEventType = event.sourceEventType;
        return;
      }
      case 'itemCompleted': {
        const item = this.ensureItem(turn, event.itemId, event.itemKind, timestamp);
        item.status = event.status;
        item.scope = event.scope ?? item.scope;
        item.completedAt = timestamp;
        item.updatedAt = timestamp;
        item.lastSourceEventType = event.sourceEventType;
        return;
      }
    }
  }

  snapshot(): HostItemLifecycleSnapshot {
    const turns = this.turnOrder
      .map(turnId => this.turns.get(turnId))
      .filter((turn): turn is HostItemLifecycleMutableTurn => !!turn)
      .map(turn => this.snapshotTurn(turn));

    return {
      turnCount: turns.length,
      runningTurnCount: turns.filter(turn => turn.status === 'running').length,
      itemCount: turns.reduce((total, turn) => total + turn.itemCount, 0),
      runningItemCount: turns.reduce((total, turn) => total + turn.runningItemCount, 0),
      deltaCount: turns.reduce((total, turn) => total + turn.deltaCount, 0),
      totalDeltaBytes: turns.reduce((total, turn) => total + turn.totalDeltaBytes, 0),
      turns,
    };
  }

  clear(): void {
    this.turns.clear();
    this.turnOrder = [];
  }

  private ensureTurn(turnId: string, timestamp: number): HostItemLifecycleMutableTurn {
    let turn = this.turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        status: 'running',
        updatedAt: timestamp,
        items: new Map<string, HostItemLifecycleMutableItem>(),
        itemOrder: [],
      };
      this.turns.set(turnId, turn);
      this.turnOrder.push(turnId);
      this.pruneTurns();
    }
    turn.updatedAt = Math.max(turn.updatedAt, timestamp);
    return turn;
  }

  private ensureItem(
    turn: HostItemLifecycleMutableTurn,
    itemId: string,
    itemKind: CanonicalRenderItemKind,
    timestamp: number,
  ): HostItemLifecycleMutableItem {
    let item = turn.items.get(itemId);
    if (!item) {
      item = {
        itemId,
        itemKind,
        status: 'running',
        updatedAt: timestamp,
        deltaCount: 0,
        totalDeltaBytes: 0,
      };
      turn.items.set(itemId, item);
      turn.itemOrder.push(itemId);
      this.pruneItems(turn);
    }
    item.itemKind = itemKind;
    item.updatedAt = Math.max(item.updatedAt, timestamp);
    return item;
  }

  private snapshotTurn(turn: HostItemLifecycleMutableTurn): HostItemLifecycleTurnSnapshot {
    const items = turn.itemOrder
      .map(itemId => turn.items.get(itemId))
      .filter((item): item is HostItemLifecycleMutableItem => !!item);
    const recentItems = items.slice(-20).map(item => ({ ...item }));
    return {
      turnId: turn.turnId,
      status: turn.status,
      ...(typeof turn.startedAt === 'number' ? { startedAt: turn.startedAt } : {}),
      ...(typeof turn.completedAt === 'number' ? { completedAt: turn.completedAt } : {}),
      updatedAt: turn.updatedAt,
      itemCount: items.length,
      runningItemCount: items.filter(item => item.status === 'running').length,
      completedItemCount: items.filter(item => item.status === 'completed').length,
      failedItemCount: items.filter(item => item.status === 'failed').length,
      cancelledItemCount: items.filter(item => item.status === 'cancelled').length,
      deltaCount: items.reduce((total, item) => total + item.deltaCount, 0),
      totalDeltaBytes: items.reduce((total, item) => total + item.totalDeltaBytes, 0),
      recentItems,
    };
  }

  private pruneTurns(): void {
    while (this.turnOrder.length > HostItemLifecycleStore.MAX_TURNS) {
      const removedTurnId = this.turnOrder.shift();
      if (removedTurnId) {
        this.turns.delete(removedTurnId);
      }
    }
  }

  private pruneItems(turn: HostItemLifecycleMutableTurn): void {
    while (turn.itemOrder.length > HostItemLifecycleStore.MAX_ITEMS_PER_TURN) {
      const removedItemId = turn.itemOrder.shift();
      if (removedItemId) {
        turn.items.delete(removedItemId);
      }
    }
  }
}

function readCanonicalLifecycleTimestamp(event: CanonicalRenderLifecycleEvent): number {
  return Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
}

function normalizeHostStreamEvent(event: HostStreamEvent): {
  turnId: string;
  item: HostStreamResponseItem;
} | null {
  switch (event.type) {
    case 'session_cleared':
      return null;
    case 'item_lifecycle':
      return null;
    case 'response_started':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseStartedItem(event.createdAt),
      };
    case 'turn_request_update':
      return {
        turnId: event.turnId,
        item: createHostStreamTurnRequestUpdateItem(event.value),
      };
    case 'turn_rounds_update':
      return {
        turnId: event.turnId,
        item: createHostStreamTurnRoundsUpdateItem(event.value),
      };
    case 'response_identity_update':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseIdentityUpdateItem(event.value, event.updatedAt),
      };
    case 'reference':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseReferenceItem(event.value, event.updatedAt),
      };
    case 'codeCitation':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseCodeCitationItem(event.value, event.updatedAt),
      };
    case 'progress':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseProgressMessageItem(event.value, event.updatedAt),
      };
    case 'response_followups':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseFollowupsItem(event.value, event.updatedAt),
      };
    case 'response_status_update':
      return {
        turnId: event.turnId,
        item: createHostStreamResponseStatusUpdateItem(event.value, event.updatedAt),
      };
    case 'usage':
      return {
        turnId: event.turnId,
        item: createHostStreamUsageItem(event.value, event.updatedAt),
      };
    case 'clear_to_previous_tool_invocation':
    case 'clearToPreviousToolInvocation':
      return {
        turnId: event.turnId,
        item: createHostStreamClearToPreviousToolInvocationItem(event.updatedAt, event.reason),
      };
    case 'markdown':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: event.kind,
          part: {
            type: 'markdown',
            content: event.content,
          },
          ...(event.kind === 'append' ? { appendTextMode: 'delta' as const } : {}),
        }),
      };
    case 'thinkingProgress':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: event.kind,
          part: {
            type: 'thinking',
            content: event.content,
            isComplete: event.isComplete,
          },
          ...(event.kind === 'append' ? { appendTextMode: 'delta' as const } : {}),
        }),
      };
    case 'response_part_update':
    case 'push':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: event.kind,
          part: event.part,
        }),
      };
    case 'warning':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'add',
          part: event.part ?? {
            type: 'warning',
            message: event.message,
          },
        }),
      };
    case 'info':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'add',
          part: event.part ?? {
            type: 'info',
            message: event.message,
          },
        }),
      };
    case 'confirmation':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'update',
          part: event.part,
        }),
      };
    case 'question_carousel':
    case 'questionCarousel':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'update',
          part: event.part,
        }),
      };
    case 'begin_tool_invocation':
    case 'beginToolInvocation':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'add',
          part: event.part,
        }),
      };
    case 'update_tool_invocation':
    case 'updateToolInvocation':
      return {
        turnId: event.turnId,
        item: createHostStreamResponsePartUpdateItem({
          updatedAt: event.updatedAt,
          partIndex: event.partIndex,
          kind: 'update',
          part: event.part,
        }),
      };
  }
}

/** Consumer side of the H1 host-facing stream contract. */
export interface IHostStreamListener {
  onHostStreamEvent(event: HostStreamEvent): void;
  onHostItemLifecycleEvent?(turnId: string, event: CanonicalRenderLifecycleEvent): void;
}

export class LiveHostRequestGraphCache implements IHostStreamListener {
  private viewRevision = 0;
  private turnEntryStateRevision = 0;
  private cachedStamp: LiveHostRequestGraphStamp | null = null;
  private cachedState: HostTurnResponseState | null = null;
  private cachedRequestModel: HostRequestModel | null = null;
  private hasPrimedModel = false;
  private readonly dialogItemStore = new HostDialogItemProjectionStore();
  private readonly itemLifecycleStore = new HostItemLifecycleStore();
  private readonly turnEntriesById = new Map<string, HostTurnResponseEntry>();
  private readonly hostStreamTurnIds = new Set<string>();
  private turnEntryOrder: string[] = [];

  /** H1: Respond to a host stream event emitted by the extension-side aggregator.
   *  Incrementally updates the turn entry map without waiting for a full pull cycle. */
  onHostStreamEvent(event: HostStreamEvent): void {
    if (event.type === 'item_lifecycle') {
      this.itemLifecycleStore.record(event.turnId, event.event);
      return;
    }

    if (event.type === 'session_cleared') {
      this.itemLifecycleStore.clear();
      return;
    }

    const normalized = normalizeHostStreamEvent(event);
    this.applyNormalizedHostStreamEvent(normalized);
  }

  onHostItemLifecycleEvent(turnId: string, event: CanonicalRenderLifecycleEvent): void {
    this.itemLifecycleStore.record(turnId, event);
  }

  private applyNormalizedHostStreamEvent(normalized: {
    turnId: string;
    item: HostStreamResponseItem;
  } | null): void {
    if (!normalized) {
      return;
    }

    const existing = this.turnEntriesById.get(normalized.turnId);
    const observedAt = getHostStreamResponseItemObservedAt(normalized.item);
    const nextTurn = isHostStreamClearToPreviousToolInvocationEvent(normalized.item)
      ? (existing?.turnResponse ?? createEmptyHostStreamTurn(normalized.turnId, observedAt))
      : applyHostStreamEvent(existing?.turnResponse ?? null, normalized.turnId, normalized.item);
    if (existing) {
      existing.turnResponse = nextTurn;
      applyHostStreamItemRuntimeState(existing, normalized.item, observedAt);
    } else {
      const entry: HostTurnResponseEntry = {
        kind: 'turn',
        turnId: normalized.turnId,
        turnResponse: nextTurn,
        user: null,
        assistant: null,
      };
      applyHostStreamItemRuntimeState(entry, normalized.item, observedAt);
      this.turnEntriesById.set(normalized.turnId, entry);
      this.turnEntryOrder.push(normalized.turnId);
    }
    this.hostStreamTurnIds.add(normalized.turnId);

    this.turnEntryStateRevision += 1;
    this.markDirty();
  }

  markDirty(): void {
    this.viewRevision += 1;
  }

  replaceState(state: HostTurnResponseState | null): void {
    this.dialogItemStore.clear();
    this.turnEntriesById.clear();
    this.hostStreamTurnIds.clear();
    this.turnEntryOrder = [];

    for (const entry of state?.entries ?? []) {
      if (entry.kind !== 'turn') {
        continue;
      }

      this.turnEntriesById.set(entry.turnId, cloneHostTurnResponseEntry(entry));
      this.turnEntryOrder.push(entry.turnId);
    }

    this.cachedStamp = null;
    this.cachedState = state;
    this.cachedRequestModel = state
      ? buildHostRequestModelFromEntries(state.entries)
      : null;
    this.hasPrimedModel = true;
    this.itemLifecycleStore.clear();
    this.turnEntryStateRevision += 1;
  }

  clear(): void {
    this.cachedStamp = null;
    this.cachedState = null;
    this.cachedRequestModel = null;
    this.hasPrimedModel = false;
    this.dialogItemStore.clear();
    this.itemLifecycleStore.clear();
    this.turnEntriesById.clear();
    this.hostStreamTurnIds.clear();
    this.turnEntryOrder = [];
    this.turnEntryStateRevision += 1;
    this.viewRevision += 1;
  }

  getState(
    source: LiveHostRequestGraphSource,
  ): HostTurnResponseState | null {
    return this.resolveCurrentOutputs(source).state;
  }

  getRequestModel(
    source: LiveHostRequestGraphSource,
  ): HostRequestModel | null {
    return this.resolveCurrentOutputs(source).requestModel;
  }

  getLastDialogProjectionMetrics(): HostDialogProjectionMetrics {
    return this.dialogItemStore.getLastMetrics();
  }

  getItemLifecycleSnapshot(): HostItemLifecycleSnapshot {
    return this.itemLifecycleStore.snapshot();
  }

  private resolveCurrentOutputs(
    source: LiveHostRequestGraphSource,
  ): { state: HostTurnResponseState | null; requestModel: HostRequestModel | null } {
    const normalizedSource = createLiveHostRequestGraphSource(
      () => source.getSnapshot(),
      source.liveTurnResponses,
      source.responseOwnerTurnId,
      source.disabledRequestTurnIds,
    );
    const snapshot = normalizedSource.getSnapshot();
    this.syncTurnEntries(normalizedSource.liveTurnResponses, snapshot);
    if (this.canReuseCachedModel(snapshot, normalizedSource.liveTurnResponses, normalizedSource.disabledRequestTurnIds)) {
      return {
        state: this.cachedState,
        requestModel: this.cachedRequestModel,
      };
    }

    const resolvedSource = resolveLiveHostRequestGraphSource(
      normalizedSource,
      snapshot,
      this.turnEntryOrder,
      this.turnEntriesById,
    );

    const stamp = buildLiveHostRequestGraphStamp(
      this.viewRevision,
      this.turnEntryStateRevision,
      resolvedSource,
    );
    if (this.cachedStamp && isSameLiveHostRequestGraphStamp(this.cachedStamp, stamp)) {
      if (!stamp.sourceHasConversationContent && this.cachedState) {
        this.cachedState = null;
        this.cachedRequestModel = null;
        return { state: null, requestModel: null };
      }

      return {
        state: this.cachedState,
        requestModel: this.cachedRequestModel,
      };
    }

    if (this.hasPrimedModel && normalizedSource.liveTurnResponses.length === 0) {
      this.cachedStamp = stamp;
      this.hasPrimedModel = false;
      return {
        state: this.cachedState,
        requestModel: this.cachedRequestModel,
      };
    }

    const state = buildMaybeHostResponseStateFromResolvedTurnSources(
      resolvedSource,
      this.turnEntriesById,
      this.cachedState?.dialogItems ?? null,
      this.dialogItemStore,
    );
    const requestModel = buildMaybeHostRequestModelFromResolvedTurnSources(
      resolvedSource,
      this.turnEntriesById,
    );
    this.cachedStamp = stamp;
    this.cachedState = state;
    this.cachedRequestModel = requestModel;
    this.hasPrimedModel = false;
    return { state, requestModel };
  }

  private canReuseCachedModel(
    snapshot: SessionSnapshot | null,
    liveTurnResponses: readonly TurnResponseTurn[],
    disabledRequestTurnIds: readonly string[],
  ): boolean {
    if (!this.cachedStamp || this.hasPrimedModel) {
      return false;
    }

    if (this.cachedStamp.partStoreRevision !== -1) {
      return false;
    }

    if (!this.cachedStamp.sourceHasConversationContent) {
      return false;
    }

    if (this.cachedStamp.turnEntryStateRevision !== this.turnEntryStateRevision) {
      return false;
    }

    const lastTurn = liveTurnResponses[liveTurnResponses.length - 1];
    return this.cachedStamp.snapshotRevision === (snapshot?.revision ?? -1)
      && this.cachedStamp.snapshotUpdatedAt === (snapshot?.updatedAt ?? -1)
      && this.cachedStamp.disabledRequestTurnIdsKey === disabledRequestTurnIds.join('\u0000')
      && this.cachedStamp.liveTurnCount === liveTurnResponses.length
      && this.cachedStamp.liveTurnLastId === (lastTurn?.turnId ?? '')
      && this.cachedStamp.liveTurnLastUpdatedAt === (lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1);
  }

  /** Canonical entry point: canonical inputs (snapshot + turnResponses) are named separately
   *  from the host cache state. The resulting model is still cached by stamp in the same way as getModel(). */
  getRequestModelFromCanonical(
    getSnapshot: () => SessionSnapshot | null,
    liveTurnResponses: readonly TurnResponseTurn[],
    responseOwnerTurnId: string | null = null,
    disabledRequestTurnIds: readonly string[] = [],
  ): HostRequestModel | null {
    return this.getRequestModel(
      createLiveHostRequestGraphSource(getSnapshot, liveTurnResponses, responseOwnerTurnId, disabledRequestTurnIds),
    );
  }

  getStateFromCanonical(
    getSnapshot: () => SessionSnapshot | null,
    liveTurnResponses: readonly TurnResponseTurn[],
    disabledRequestTurnIds: readonly string[] = [],
  ): HostTurnResponseState | null {
    return this.getState(
      createLiveHostRequestGraphSource(getSnapshot, liveTurnResponses, null, disabledRequestTurnIds),
    );
  }

  private syncTurnEntries(
    liveTurnResponses: readonly TurnResponseTurn[],
    snapshot: SessionSnapshot | null,
  ): void {
    let changed = false;
    const liveTurnIds = new Set(liveTurnResponses.map(turn => turn.turnId));
    const snapshotTurnIdsForRetention = new Set(snapshot?.turns?.map(turn => turn.id) ?? []);
    const hasSnapshotTurns = snapshotTurnIdsForRetention.size > 0;
    const retainedTurnIds = liveTurnResponses.length > 0
      ? liveTurnIds
      : hasSnapshotTurns
        ? snapshotTurnIdsForRetention
        : new Set([...this.hostStreamTurnIds].filter(turnId => this.turnEntriesById.has(turnId)));

    if (liveTurnResponses.length === 0) {
      this.pruneTurnEntries(retainedTurnIds);
      return;
    }

    for (const turn of liveTurnResponses) {
      const existing = this.turnEntriesById.get(turn.turnId);
      if (existing) {
        if (existing.turnResponse !== turn) {
          changed = true;
        }
        existing.turnResponse = turn;
        refreshHostTurnEntryWaitingState(existing, turn.updatedAt || Date.now());
        continue;
      }

      const entry: HostTurnResponseEntry = {
        kind: 'turn',
        turnId: turn.turnId,
        turnResponse: turn,
        user: null,
        assistant: null,
      };
      refreshHostTurnEntryWaitingState(entry, turn.updatedAt || Date.now());
      this.turnEntriesById.set(turn.turnId, entry);
      this.turnEntryOrder.push(turn.turnId);
      changed = true;
    }

    changed = this.pruneTurnEntries(retainedTurnIds) || changed;

    const nextTurnEntryOrder = liveTurnResponses.length > 0
      ? liveTurnResponses.map(turn => turn.turnId).filter(turnId => this.turnEntriesById.has(turnId))
      : hasSnapshotTurns
        ? (snapshot?.turns?.map(turn => turn.id).filter(turnId => this.turnEntriesById.has(turnId)) ?? [])
        : this.turnEntryOrder.filter(turnId => this.turnEntriesById.has(turnId));
    if (nextTurnEntryOrder.length !== this.turnEntryOrder.length
      || nextTurnEntryOrder.some((turnId, index) => turnId !== this.turnEntryOrder[index])) {
      changed = true;
    }
    this.turnEntryOrder = nextTurnEntryOrder;

    if (changed) {
      this.turnEntryStateRevision += 1;
    }
  }

  private pruneTurnEntries(retainedTurnIds: ReadonlySet<string>): boolean {
    let changed = false;
    this.turnEntryOrder = this.turnEntryOrder.filter(turnId => retainedTurnIds.has(turnId));

    for (const turnId of [...this.turnEntriesById.keys()]) {
      if (!retainedTurnIds.has(turnId)) {
        this.turnEntriesById.delete(turnId);
        this.hostStreamTurnIds.delete(turnId);
        changed = true;
      }
    }

    return changed;
  }
}

export function hasHostResponseConversationContent(
  model: Pick<HostResponseProjection, 'turnResponses' | 'chatList' | 'dialogItems'> | null | undefined,
): boolean {
  return (model?.turnResponses?.length ?? 0) > 0
    || (model?.chatList?.length ?? 0) > 0
    || (model?.dialogItems?.length ?? 0) > 0;
}

export function buildHostRequestModel(
  turnResponses: readonly TurnResponseTurn[],
): HostRequestModel | null {
  return buildHostRequestModelFromOwner(
    turnResponses.length > 0
      ? {
        turnId: turnResponses[turnResponses.length - 1].turnId,
        turn: turnResponses[turnResponses.length - 1],
      }
      : null,
  );
}

function buildHostRequestModelFromEntries(
  entries: readonly HostResponseEntry[],
): HostRequestModel | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'turn' || !entry.turnResponse) {
      continue;
    }

    return buildHostRequestModelFromOwner({
      turnId: entry.turnId,
      turn: projectTurnResponseForHostEntry(entry),
      runtimeState: entry.runtimeState,
    });
  }

  return null;
}

function buildHostResponseStateFromEntries(
  entries: readonly HostResponseEntry[],
  options: HostResponseProjectionBuildOptions = {},
): HostTurnResponseState {
  return {
    entries,
    ...buildHostResponseProjectionFromEntries(entries, options),
  };
}

function buildHostResponseProjectionFromEntries(
  entries: readonly HostResponseEntry[],
  options: HostResponseProjectionBuildOptions = {},
): HostResponseProjection {
  const turnResponses = entries
    .filter((entry): entry is HostTurnResponseEntry => entry.kind === 'turn' && !!entry.turnResponse)
    .map(entry => projectTurnResponseForHostEntry(entry));

  return {
    turnResponses,
    chatList: buildChatListFromEntries(entries),
    dialogItems: buildCanonicalDialogItemsFromEntries(entries, options),
  };
}

function buildHostRequestModelFromOwner(
  owner: HostResponseOwnerBinding | null,
  options: { isStale?: boolean } = {},
): HostRequestModel | null {
  const latestTurnResponse = owner?.turn ?? null;
  if (!latestTurnResponse || !owner) {
    return null;
  }

  const responseSidecar = owner?.runtimeState?.responseSidecar;
  const responseView = latestTurnResponse
    ? buildHostResponseView(latestTurnResponse, owner?.runtimeState?.responseClear, responseSidecar)
    : null;
  const entireResponseView = latestTurnResponse ? buildHostResponseView(latestTurnResponse, undefined, responseSidecar) : null;
  const responseState = latestTurnResponse?.response.status ?? null;
  const completedAt = responseState && responseState !== 'streaming'
    ? (latestTurnResponse?.updatedAt ?? latestTurnResponse?.response.updatedAt ?? null)
    : null;
  const pendingConfirmation = deriveHostPendingConfirmationState(
    latestTurnResponse,
    owner?.runtimeState?.waiting?.startedAt,
  );
  const responseTiming = deriveHostResponseTimingState(
    latestTurnResponse,
    pendingConfirmation,
    owner?.runtimeState?.waiting?.accumulatedMs ?? 0,
  );
  const slashCommand = resolveHostResponseSlashCommand(latestTurnResponse, owner?.runtimeState);
  const followups = resolveHostResponseFollowups(latestTurnResponse, owner?.runtimeState);
  const derivedTimeSpentWaiting = responseTiming
    ? Math.max(0, responseTiming.confirmationAdjustedTimestamp - responseTiming.timestamp)
    : null;
  const modelState = deriveHostResponseModelState(
    latestTurnResponse,
    pendingConfirmation,
    completedAt,
    responseSidecar?.modelState,
  );
  const timestamp = responseSidecar?.timestamp ?? responseTiming?.timestamp ?? null;
  const timeSpentWaiting = responseSidecar?.timeSpentWaiting ?? derivedTimeSpentWaiting;
  const confirmationAdjustedTimestamp = timestamp !== null && timeSpentWaiting !== null
    ? timestamp + timeSpentWaiting
    : (responseTiming?.confirmationAdjustedTimestamp ?? null);
  const agentOrSlashCommandDetected = deriveHostAgentOrSlashCommandDetected(latestTurnResponse, slashCommand);

  const responseModel: HostResponseModel = {
    requestId: owner.turnId,
    request: null,
    id: responseSidecar?.responseId ?? latestTurnResponse?.response.id ?? null,
    state: responseState,
    slashCommand,
    summaryPreview: resolveHostResponseSummaryPreview(latestTurnResponse),
    agentOrSlashCommandDetected,
    usedContext: latestTurnResponse?.response.usedContext ?? null,
    contentReferences: [...(latestTurnResponse?.response.contentReferences ?? [])],
    codeCitations: [...(latestTurnResponse?.response.codeCitations ?? [])],
    progressMessages: [...(latestTurnResponse?.response.progressMessages ?? [])],
    followups,
    completedAt,
    terminationReason: latestTurnResponse?.response.terminationReason ?? null,
    isComplete: responseState !== null && responseState !== 'streaming',
    isCanceled: responseState === 'cancelled',
    isIncomplete: responseState !== null && responseState === 'streaming',
    isStale: options.isStale === true,
    response: responseView,
    entireResponse: entireResponseView,
    isPendingConfirmation: pendingConfirmation,
    responseMarkdownInfo: responseSidecar?.responseMarkdownInfo?.map(info => ({ ...info })) ?? [],
    modelState,
    vote: responseSidecar?.vote,
    timestamp,
    elapsedMs: responseSidecar?.elapsedMs ?? responseTiming?.elapsedMs ?? null,
    confirmationAdjustedTimestamp,
    usage: latestTurnResponse?.usage ?? null,
    completionTokenCount: responseSidecar?.completionTokens ?? latestTurnResponse?.usage?.outputTokens ?? null,
  };

  const requestModel: HostRequestModel = {
    id: owner.turnId,
    turnId: owner.turnId,
    timestamp: latestTurnResponse.createdAt,
    message: latestTurnResponse.request,
    response: responseModel,
  };

  (responseModel as { request: HostRequestModel | null }).request = requestModel;
  return requestModel;
}

function resolveHostResponseSlashCommand(
  turn: TurnResponseTurn,
  runtimeState?: HostTurnRuntimeState,
): TurnResponseCommand | null {
  if (runtimeState) {
    if (runtimeState.responseSidecar && Object.prototype.hasOwnProperty.call(runtimeState.responseSidecar, 'slashCommand')) {
      return normalizeHostResponseSlashCommand(runtimeState.responseSidecar.slashCommand);
    }

    return null;
  }

  return normalizeHostResponseSlashCommand(turn.responseModel?.slashCommand);
}

function normalizeHostResponseSlashCommand(
  slashCommand: TurnResponseCommand | null | undefined,
): TurnResponseCommand | null {
  if (!slashCommand || typeof slashCommand.name !== 'string') {
    return null;
  }

  const normalizedName = slashCommand.name.trim();
  if (!normalizedName) {
    return null;
  }

  return { ...slashCommand, name: normalizedName };
}

function resolveHostResponseSummaryPreview(
  turn: TurnResponseTurn | null | undefined,
): string | null {
  const summaryPreview = normalizeTurnResponseSummaryPreview(turn?.responseModel?.summaryPreview);
  return summaryPreview ?? null;
}

function deriveHostAgentOrSlashCommandDetected(
  turn: TurnResponseTurn | null | undefined,
  slashCommand: TurnResponseCommand | null,
): boolean {
  if (slashCommand) {
    return true;
  }

  if (!turn) {
    return false;
  }

  return getTurnResponseParticipant(turn.response.participant) !== getTurnResponseParticipant(undefined);
}

function resolveHostResponseFollowups(
  turn: TurnResponseTurn,
  runtimeState?: HostTurnRuntimeState,
): readonly TurnResponseFollowup[] {
  if (runtimeState?.responseSidecar?.followups !== undefined) {
    return runtimeState.responseSidecar.followups.map(followup => ({ ...followup }));
  }

  return turn.responseModel?.followups?.map(followup => ({ ...followup })) ?? [];
}

function buildHostResponseView(
  turn: TurnResponseTurn,
  clearState?: HostTurnResponseClearRuntimeState,
  responseSidecar?: Pick<HostResponseSidecarRuntimeState, 'responseId' | 'result'>,
): HostResponseView {
  const viewParts = buildHostResponseViewParts(turn.response.parts, clearState);
  const resultText = responseSidecar?.result || turn.response.resultText || collectMainTurnResponseText(viewParts);
  const responseState = turn.response.status;

  return {
    turnId: turn.turnId,
    id: responseSidecar?.responseId || turn.response.id,
    participant: turn.response.participant,
    state: responseState,
    usedContext: turn.response.usedContext ?? null,
    contentReferences: [...(turn.response.contentReferences ?? [])],
    codeCitations: [...(turn.response.codeCitations ?? [])],
    progressMessages: [...(turn.response.progressMessages ?? [])],
    createdAt: turn.response.createdAt,
    updatedAt: turn.response.updatedAt,
    terminationReason: turn.response.terminationReason ?? null,
    isComplete: responseState !== 'streaming',
    isCanceled: responseState === 'cancelled',
    value: viewParts,
    getMarkdown: () => resultText,
    getFinalResponse: () => resultText,
    toString: () => resultText,
  };
}

function normalizePersistedResponseMarkdownInfo(
  value: readonly HostResponseMarkdownInfo[] | undefined,
): HostResponseMarkdownInfo[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is HostResponseMarkdownInfo => !!entry && typeof entry.suggestionId === 'string' && entry.suggestionId.length > 0)
    .map(entry => ({ suggestionId: entry.suggestionId }));

  return normalized.length > 0 ? normalized : undefined;
}

function normalizePersistedResponseModelState(
  value: HostResponseModelState | undefined,
): HostResponseModelState | undefined {
  if (!value || typeof value !== 'object' || typeof value.value !== 'number') {
    return undefined;
  }

  if (value.value === HostResponseModelStateValue.Pending || value.value === HostResponseModelStateValue.NeedsInput) {
    return { value: HostResponseModelStateValue.Cancelled, completedAt: Date.now() };
  }

  if (
    (value.value === HostResponseModelStateValue.Complete
      || value.value === HostResponseModelStateValue.Cancelled
      || value.value === HostResponseModelStateValue.Failed)
    && typeof (value as { completedAt?: unknown }).completedAt === 'number'
  ) {
    return {
      value: value.value,
      completedAt: (value as { completedAt: number }).completedAt,
    };
  }

  return undefined;
}

function deriveHostResponseModelState(
  turn: TurnResponseTurn,
  pendingConfirmation: HostPendingConfirmationState | null,
  completedAt: number | null,
  persistedState?: HostResponseModelState,
): HostResponseModelState {
  const normalizedPersistedState = normalizePersistedResponseModelState(persistedState);
  if (normalizedPersistedState) {
    return normalizedPersistedState;
  }

  if (pendingConfirmation) {
    return { value: HostResponseModelStateValue.NeedsInput };
  }

  switch (turn.response.status) {
    case 'streaming':
      return { value: HostResponseModelStateValue.Pending };
    case 'cancelled':
      return { value: HostResponseModelStateValue.Cancelled, completedAt: completedAt ?? turn.updatedAt ?? Date.now() };
    case 'error':
      return { value: HostResponseModelStateValue.Failed, completedAt: completedAt ?? turn.updatedAt ?? Date.now() };
    case 'completed':
    default:
      return { value: HostResponseModelStateValue.Complete, completedAt: completedAt ?? turn.updatedAt ?? Date.now() };
  }
}

function buildHostResponseViewParts(
  parts: readonly TurnResponsePart[],
  clearState?: HostTurnResponseClearRuntimeState,
): TurnResponsePart[] {
  if (!clearState) {
    return projectTurnResponseDisplayParts(parts);
  }

  const prefixPartCount = Math.max(0, Math.min(clearState.prefixPartCount, parts.length));
  const clearedPartCount = Math.max(prefixPartCount, Math.min(clearState.clearedPartCount, parts.length));
  return projectTurnResponseDisplayParts([
    ...parts.slice(0, prefixPartCount),
    ...(clearState.message ? [{ type: 'markdown', content: clearState.message } satisfies Extract<TurnResponsePart, { type: 'markdown' }>] : []),
    ...parts.slice(clearedPartCount),
  ]);
}

function deriveHostPendingConfirmationState(
  turn: TurnResponseTurn | null,
  startedWaitingAtOverride?: number,
): HostPendingConfirmationState | null {
  if (!turn) {
    return null;
  }

  const startedWaitingAt = startedWaitingAtOverride ?? (turn.updatedAt || turn.createdAt);

  for (const part of turn.response.parts) {
    if (part.type === 'tool_call') {
      const approval = projectToolCallApprovalDisplayData(part);
      if (approval && !approval.resolved) {
        return {
          startedWaitingAt,
          detail: approval.title || approval.message,
        };
      }
      continue;
    }

    if (part.type === 'confirmation' && part.resolved !== true) {
      return {
        startedWaitingAt,
        detail: part.title || part.message,
      };
    }

    if (part.type === 'question' && hasPendingQuestionAnswers(part)) {
      return {
        startedWaitingAt,
        detail: part.questions[0]?.question || 'Answer questions to continue...',
      };
    }
  }

  return null;
}

function hasPendingQuestionAnswers(
  part: Extract<TurnResponsePart, { type: 'question' }>,
): boolean {
  if (!part.questions.length) {
    return false;
  }

  if (!part.answers) {
    return true;
  }

  return part.questions.some(question => !part.answers?.[question.question]);
}

function deriveHostResponseTimingState(
  turn: TurnResponseTurn | null,
  pendingConfirmation: HostPendingConfirmationState | null,
  accumulatedWaitingMs = 0,
): HostResponseTimingState | null {
  if (!turn) {
    return null;
  }

  const timestamp = turn.createdAt || turn.updatedAt;
  const completedAt = turn.updatedAt || turn.createdAt;
  const confirmationAdjustedTimestamp = timestamp + Math.max(0, accumulatedWaitingMs);
  const elapsedMs = pendingConfirmation
    ? Math.max(0, pendingConfirmation.startedWaitingAt - confirmationAdjustedTimestamp)
    : Math.max(0, completedAt - confirmationAdjustedTimestamp);

  return {
    timestamp,
    elapsedMs,
    confirmationAdjustedTimestamp,
  };
}

function getHostStreamResponseItemObservedAt(event: HostStreamResponseItem): number {
  if (isHostStreamResponseStartedEvent(event)) {
    return event.createdAt;
  }

  if (isHostStreamResponseProgressEvent(event)
    || isHostStreamResponseFollowupsEvent(event)
    || isHostStreamResponseStatusUpdateEvent(event)
    || isHostStreamUsageEvent(event)
    || isHostStreamClearToPreviousToolInvocationEvent(event)
    || isHostStreamResponsePartUpdateEvent(event)) {
    return event.updatedAt;
  }

  return Date.now();
}

function isHostStreamClearToPreviousToolInvocationEvent(
  event: HostStreamResponseItem,
): event is HostStreamClearToPreviousToolInvocationEvent {
  return event.itemType === 'clear_to_previous_tool_invocation';
}

function applyHostStreamItemRuntimeState(
  entry: HostTurnResponseEntry,
  event: HostStreamResponseItem,
  observedAt: number,
): void {
  if (isHostStreamClearToPreviousToolInvocationEvent(event)) {
    entry.runtimeState = {
      ...entry.runtimeState,
      responseClear: buildHostTurnResponseClearRuntimeState(entry.turnResponse, event.reason),
    };
  }

  if (isHostStreamResponseIdentityUpdateEvent(event) && Object.prototype.hasOwnProperty.call(event.value, 'slashCommand')) {
    entry.runtimeState = compactHostTurnRuntimeState({
      ...entry.runtimeState,
      responseSidecar: compactHostResponseSidecarRuntimeState({
        ...entry.runtimeState?.responseSidecar,
        slashCommand: normalizeHostResponseSlashCommand(event.value.slashCommand),
      }),
    });
  }

  if (isHostStreamResponseFollowupsEvent(event)) {
    entry.runtimeState = compactHostTurnRuntimeState({
      ...entry.runtimeState,
      responseSidecar: compactHostResponseSidecarRuntimeState({
        ...entry.runtimeState?.responseSidecar,
        followups: cloneHostStreamFollowups(event.value),
      }),
    });
  }

  refreshHostTurnEntryWaitingState(entry, observedAt);
}

function buildHostTurnResponseClearRuntimeState(
  turn: TurnResponseTurn | null,
  reason: HostResponseClearToPreviousToolInvocationReason,
): HostTurnResponseClearRuntimeState {
  const parts = turn?.response.parts ?? [];
  let lastToolInvocationIndex = -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === 'tool_call') {
      lastToolInvocationIndex = index;
      break;
    }
  }

  return {
    prefixPartCount: lastToolInvocationIndex === -1 ? 0 : lastToolInvocationIndex + 1,
    clearedPartCount: parts.length,
    reason,
    message: getHostResponseClearRetryMessage(reason),
  };
}

function getHostResponseClearRetryMessage(
  reason: HostResponseClearToPreviousToolInvocationReason,
): string | undefined {
  switch (reason) {
    case 'copyright_content_retry':
      return 'Response cleared due to possible match to public code, retrying with modified prompt.';
    case 'filtered_content_retry':
      return 'Response cleared due to content safety filters, retrying with modified prompt.';
    default:
      return undefined;
  }
}

function refreshHostTurnEntryWaitingState(entry: HostTurnResponseEntry, observedAt: number): void {
  const pending = deriveHostPendingConfirmationState(entry.turnResponse);
  const waitingState = entry.runtimeState?.waiting;

  if (pending) {
    const nextWaiting: HostTurnWaitingRuntimeState = {
      accumulatedMs: waitingState?.accumulatedMs ?? 0,
      startedAt: waitingState?.startedAt ?? observedAt,
      detail: pending.detail,
    };
    entry.runtimeState = compactHostTurnRuntimeState({
      ...entry.runtimeState,
      waiting: nextWaiting,
    });
    return;
  }

  if (waitingState?.startedAt !== undefined) {
    entry.runtimeState = compactHostTurnRuntimeState({
      ...entry.runtimeState,
      waiting: {
        accumulatedMs: (waitingState.accumulatedMs ?? 0) + Math.max(0, observedAt - waitingState.startedAt),
      },
    });
    return;
  }

  if (waitingState?.accumulatedMs) {
    entry.runtimeState = compactHostTurnRuntimeState({
      ...entry.runtimeState,
      waiting: {
        accumulatedMs: waitingState.accumulatedMs,
      },
    });
    return;
  }

  entry.runtimeState = compactHostTurnRuntimeState({
    ...entry.runtimeState,
    waiting: undefined,
  });
}

function compactHostTurnRuntimeState(state: HostTurnRuntimeState | undefined): HostTurnRuntimeState | undefined {
  if (!state) {
    return undefined;
  }

  return state.waiting || state.responseClear || state.responseSidecar ? state : undefined;
}

function compactHostResponseSidecarRuntimeState(
  state: HostResponseSidecarRuntimeState | undefined,
): HostResponseSidecarRuntimeState | undefined {
  if (!state) {
    return undefined;
  }

  return state.slashCommand !== undefined
    || state.responseId !== undefined
    || state.result !== undefined
    || state.responseMarkdownInfo !== undefined
    || state.followups !== undefined
    || state.modelState !== undefined
    || state.vote !== undefined
    || state.timestamp !== undefined
    || state.elapsedMs !== undefined
    || state.timeSpentWaiting !== undefined
    || state.completionTokens !== undefined
    ? state
    : undefined;
}

export function buildHostProjectionStateFromPersistedRecord(
  record: PersistedHostResponseRecordInput,
): HostTurnResponseState {
  const entries = buildHostResponseEntries(record.turnResponses ?? []);
  return buildHostResponseStateFromEntries(entries);
}

export function buildHostResponseStateFromCanonical(
  snapshot: SessionSnapshot | null,
  liveTurnResponses: readonly TurnResponseTurn[],
): HostTurnResponseState | null {
  const normalizedLiveTurnResponses = normalizeLiveTurnResponses(liveTurnResponses);
  const turnEntriesById = createHostTurnEntriesById(normalizedLiveTurnResponses);
  const orderedTurnIds = resolveOrderedTurnIds(
    snapshot,
    normalizedLiveTurnResponses.map(turn => turn.turnId),
    turnEntriesById,
  );

  const resolvedSource = resolveLiveHostRequestGraphSourceFromInputs(
    snapshot,
    normalizedLiveTurnResponses,
    null,
    orderedTurnIds,
    turnEntriesById,
  );

  return buildMaybeHostResponseStateFromResolvedTurnSources(
    resolvedSource,
    turnEntriesById,
  );
}

export function buildHostRequestModelFromCanonical(
  snapshot: SessionSnapshot | null,
  liveTurnResponses: readonly TurnResponseTurn[],
  responseOwnerTurnId: string | null = null,
): HostRequestModel | null {
  const normalizedLiveTurnResponses = normalizeLiveTurnResponses(liveTurnResponses);
  const turnEntriesById = createHostTurnEntriesById(normalizedLiveTurnResponses);
  const orderedTurnIds = resolveOrderedTurnIds(
    snapshot,
    normalizedLiveTurnResponses.map(turn => turn.turnId),
    turnEntriesById,
  );
  const resolvedSource = resolveLiveHostRequestGraphSourceFromInputs(
    snapshot,
    normalizedLiveTurnResponses,
    responseOwnerTurnId,
    orderedTurnIds,
    turnEntriesById,
  );

  return buildMaybeHostRequestModelFromResolvedTurnSources(
    resolvedSource,
    turnEntriesById,
  );
}

function resolveLiveHostRequestGraphSourceFromInputs(
  snapshot: SessionSnapshot | null,
  liveTurnResponses: readonly TurnResponseTurn[],
  responseOwnerTurnId: string | null,
  orderedTurnIds: readonly string[],
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): ResolvedLiveHostRequestGraphSource {
  return resolveLiveHostRequestGraphSource(
    createLiveHostRequestGraphSource(() => snapshot, liveTurnResponses, responseOwnerTurnId),
    snapshot,
    orderedTurnIds,
    turnEntriesById,
  );
}

function resolveLiveHostRequestGraphSource(
  source: LiveHostRequestGraphSource,
  snapshot: SessionSnapshot | null,
  orderedTurnIds: readonly string[],
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): ResolvedLiveHostRequestGraphSource {
  const responseOwner = resolveResponseOwnerBinding(
    source.responseOwnerTurnId,
    turnEntriesById,
  );
  const responseOwnerUpdatedAt = responseOwner
    ? (responseOwner.turn.updatedAt
      ?? responseOwner.turn.response.updatedAt
      ?? -1)
    : -1;
  const canonicalTailState = buildHostResponseStateFromEntries(
    buildOrderedHostResponseEntries(orderedTurnIds, turnEntriesById),
  );

  return {
    snapshot,
    liveTurnResponses: source.liveTurnResponses,
    orderedTurnIds,
    responseOwner,
    disabledRequestTurnIds: source.disabledRequestTurnIds,
    responseOwnerUpdatedAt,
    tailMessage: canonicalTailState.chatList[canonicalTailState.chatList.length - 1],
  };
}

function buildMaybeHostResponseStateFromResolvedTurnSources(
  resolvedSource: ResolvedLiveHostRequestGraphSource,
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
  previousDialogItems?: readonly ChatDialogViewItem[] | null,
  dialogItemStore?: HostDialogItemProjectionStore,
): HostTurnResponseState | null {
  const entries = buildOrderedHostResponseEntries(resolvedSource.orderedTurnIds, turnEntriesById);
  if (entries.length === 0) {
    return null;
  }

  const state = buildHostResponseStateFromEntries(entries, {
    disabledRequestTurnIds: resolvedSource.disabledRequestTurnIds,
    previousDialogItems,
    dialogItemStore,
  });
  return hasHostResponseConversationContent(state) ? state : null;
}

function buildMaybeHostRequestModelFromResolvedTurnSources(
  resolvedSource: ResolvedLiveHostRequestGraphSource,
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): HostRequestModel | null {
  const entries = buildOrderedHostResponseEntries(resolvedSource.orderedTurnIds, turnEntriesById);
  if (entries.length === 0) {
    return null;
  }

  const projection = buildHostResponseProjectionFromEntries(entries, {
    disabledRequestTurnIds: resolvedSource.disabledRequestTurnIds,
  });
  if (!hasHostResponseConversationContent(projection)) {
    return null;
  }

  return buildHostRequestModelFromOwner(
    resolvedSource.responseOwner ?? resolveTailHostResponseOwner(entries),
    { isStale: false },
  );
}

function resolveTailHostResponseOwner(
  entries: readonly HostResponseEntry[],
): HostResponseOwnerBinding | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind !== 'turn' || !entry.turnResponse) {
      continue;
    }

    return {
      turnId: entry.turnId,
      turn: projectTurnResponseForHostEntry(entry),
      runtimeState: entry.runtimeState,
    };
  }

  return null;
}

function resolveResponseOwnerBinding(
  responseOwnerTurnId: string | null,
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): HostResponseOwnerBinding | null {
  if (!responseOwnerTurnId) {
    return null;
  }

  const entry = turnEntriesById.get(responseOwnerTurnId);
  if (!entry?.turnResponse) {
    return null;
  }

  return {
    turnId: entry.turnId,
    turn: projectTurnResponseForHostEntry(entry),
    runtimeState: entry.runtimeState,
  };
}

function resolveOrderedTurnIds(
  snapshot: SessionSnapshot | null,
  turnEntryOrder: readonly string[],
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): string[] {
  if (turnEntryOrder.length > 0) {
    return turnEntryOrder.filter(turnId => turnEntriesById.has(turnId));
  }

  const snapshotOrder = snapshot?.turns?.map(turn => turn.id).filter(turnId => turnEntriesById.has(turnId)) ?? [];
  if (snapshotOrder.length > 0) {
    return snapshotOrder;
  }

  return [...turnEntriesById.keys()];
}

function createHostTurnEntriesById(
  turnResponses: readonly TurnResponseTurn[],
): Map<string, HostTurnResponseEntry> {
  return new Map<string, HostTurnResponseEntry>(
    turnResponses.map((turn) => [turn.turnId, {
      kind: 'turn',
      turnId: turn.turnId,
      turnResponse: turn,
      user: null,
      assistant: null,
    } satisfies HostTurnResponseEntry]),
  );
}
function buildOrderedHostResponseEntries(
  orderedTurnIds: readonly string[],
  turnEntriesById: ReadonlyMap<string, HostTurnResponseEntry>,
): HostResponseEntry[] {
  const entries: HostResponseEntry[] = [];
  for (const turnId of orderedTurnIds) {
    const turnEntry = turnEntriesById.get(turnId);
    if (turnEntry) {
      entries.push(cloneHostTurnResponseEntry(turnEntry));
    }
  }

  return entries;
}

function projectTurnResponseForHostEntry(entry: HostTurnResponseEntry): TurnResponseTurn {
  const turn = entry.turnResponse!;
  const response = turn.response ?? {
    id: entry.turnId,
    participant: getTurnResponseParticipant(undefined),
    status: 'streaming',
    parts: [],
    resultText: '',
    createdAt: turn.createdAt ?? Date.now(),
    updatedAt: turn.updatedAt ?? Date.now(),
  };
  const responseModel = cloneProjectedTurnResponseModel(turn.responseModel);
  const { responseModel: _responseModel, ...turnWithoutResponseModel } = turn as TurnResponseTurn & {
    responseModel?: unknown;
  };
  const request = turn.request ?? { content: '' };
  return {
    ...turnWithoutResponseModel,
    request,
    rounds: cloneProjectedTurnRounds(turn.rounds ?? []),
    ...(responseModel ? { responseModel } : {}),
    response: {
      ...response,
      parts: normalizePersistedTurnResponseParts(
        assignFallbackPartIdsForImportedTurn(turn.turnId, response.parts ?? []),
      ),
    },
  };
}

function cloneProjectedTurnRounds(
  rounds: TurnResponseTurn['rounds'],
): TurnResponseTurn['rounds'] {
  return (rounds ?? []).map((round) => {
    const { summary: _runtimeSummary, ...roundWithoutSummary } = round;
    return {
      ...roundWithoutSummary,
      toolCalls: (round.toolCalls ?? []).map(toolCall => ({ ...toolCall })),
    };
  });
}

function cloneProjectedTurnResponseModel(
  responseModel: TurnResponseTurn['responseModel'] | undefined,
): TurnResponseTurn['responseModel'] | undefined {
  const cloned = cloneTurnResponseModelSidecar(responseModel);
  const quotaSnapshot = responseModel?.quotaSnapshot;

  if (!cloned && !quotaSnapshot) {
    return undefined;
  }

  return {
    ...(cloned ?? {}),
    ...(quotaSnapshot ? { quotaSnapshot: { ...quotaSnapshot } } : {}),
  };
}

function cloneHostTurnResponseEntry(entry: HostTurnResponseEntry): HostTurnResponseEntry {
  return {
    kind: 'turn',
    turnId: entry.turnId,
    turnResponse: entry.turnResponse,
    user: entry.user ? { ...entry.user } : null,
    assistant: entry.assistant ? { ...entry.assistant } : null,
    runtimeState: entry.runtimeState
      ? {
        waiting: entry.runtimeState.waiting ? { ...entry.runtimeState.waiting } : undefined,
        responseClear: entry.runtimeState.responseClear ? { ...entry.runtimeState.responseClear } : undefined,
        responseSidecar: cloneHostResponseSidecarRuntimeState(entry.runtimeState.responseSidecar),
      }
      : undefined,
  };
}

function cloneHostResponseSidecarRuntimeState(
  state: HostResponseSidecarRuntimeState | undefined,
): HostResponseSidecarRuntimeState | undefined {
  if (!state) {
    return undefined;
  }

  return compactHostResponseSidecarRuntimeState({
    ...(state.slashCommand !== undefined ? { slashCommand: normalizeHostResponseSlashCommand(state.slashCommand) } : {}),
    ...(typeof state.responseId === 'string' ? { responseId: state.responseId } : {}),
    ...(typeof state.result === 'string' ? { result: state.result } : {}),
    ...(state.responseMarkdownInfo
      ? { responseMarkdownInfo: state.responseMarkdownInfo.map(info => ({ ...info })) }
      : {}),
    ...(state.followups ? { followups: cloneHostStreamFollowups(state.followups) } : {}),
    ...(state.modelState ? { modelState: cloneHostResponseModelState(state.modelState) } : {}),
    ...(state.vote === 0 || state.vote === 1 ? { vote: state.vote } : {}),
    ...(typeof state.timestamp === 'number' ? { timestamp: state.timestamp } : {}),
    ...(typeof state.elapsedMs === 'number' ? { elapsedMs: state.elapsedMs } : {}),
    ...(typeof state.timeSpentWaiting === 'number' ? { timeSpentWaiting: state.timeSpentWaiting } : {}),
    ...(typeof state.completionTokens === 'number' ? { completionTokens: state.completionTokens } : {}),
  });
}

function cloneHostResponseModelState(
  state: HostResponseModelState,
): HostResponseModelState {
  return 'completedAt' in state
    ? { ...state }
    : { value: state.value };
}

function buildLiveHostRequestGraphStamp(
  viewRevision: number,
  turnEntryStateRevision: number,
  source: ResolvedLiveHostRequestGraphSource,
): LiveHostRequestGraphStamp {
  const stampedChatList: readonly ChatListItem[] = [];
  const lastMessage = stampedChatList[stampedChatList.length - 1] ?? source.tailMessage;
  const lastTurn = source.liveTurnResponses[source.liveTurnResponses.length - 1];
  const sourceHasConversationContent = stampedChatList.length > 0
    || source.liveTurnResponses.length > 0
    || (source.snapshot?.turns?.length ?? 0) > 0
    || source.orderedTurnIds.length > 0;

  return {
    viewRevision,
    turnEntryStateRevision,
    sourceHasConversationContent,
    disabledRequestTurnIdsKey: source.disabledRequestTurnIds.join('\u0000'),
    chatListLength: stampedChatList.length,
    lastMessageRole: lastMessage?.role ?? '',
    lastMessageState: lastMessage?.state ?? '',
    lastMessageSource: lastMessage?.source ?? '',
    lastMessageTurnId: lastMessage?.turnId ?? '',
    lastMessageContent: typeof lastMessage?.content === 'string' ? lastMessage.content : '',
    partStoreRevision: -1,
    snapshotRevision: source.snapshot?.revision ?? -1,
    snapshotUpdatedAt: source.snapshot?.updatedAt ?? -1,
    liveTurnCount: source.liveTurnResponses.length,
    liveTurnLastId: lastTurn?.turnId ?? '',
    liveTurnLastUpdatedAt: lastTurn?.updatedAt ?? lastTurn?.response?.updatedAt ?? -1,
    responseOwnerTurnId: source.responseOwner?.turnId ?? '',
    responseOwnerUpdatedAt: source.responseOwnerUpdatedAt,
  };
}

function isSameLiveHostRequestGraphStamp(
  left: LiveHostRequestGraphStamp,
  right: LiveHostRequestGraphStamp,
): boolean {
  return left.viewRevision === right.viewRevision
    && left.turnEntryStateRevision === right.turnEntryStateRevision
    && left.sourceHasConversationContent === right.sourceHasConversationContent
    && left.disabledRequestTurnIdsKey === right.disabledRequestTurnIdsKey
    && left.chatListLength === right.chatListLength
    && left.lastMessageRole === right.lastMessageRole
    && left.lastMessageState === right.lastMessageState
    && left.lastMessageSource === right.lastMessageSource
    && left.lastMessageTurnId === right.lastMessageTurnId
    && left.lastMessageContent === right.lastMessageContent
    && left.partStoreRevision === right.partStoreRevision
    && left.snapshotRevision === right.snapshotRevision
    && left.snapshotUpdatedAt === right.snapshotUpdatedAt
    && left.liveTurnCount === right.liveTurnCount
    && left.liveTurnLastId === right.liveTurnLastId
    && left.liveTurnLastUpdatedAt === right.liveTurnLastUpdatedAt
    && left.responseOwnerTurnId === right.responseOwnerTurnId
    && left.responseOwnerUpdatedAt === right.responseOwnerUpdatedAt;
}

function asPersistedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asPersistedRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map(entry => asPersistedRecord(entry))
      .filter((entry): entry is Record<string, unknown> => !!entry)
      .map(entry => ({ ...entry }))
    : [];
}

function firstPersistedString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function mergePersistedStringArrays(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): readonly string[] | undefined {
  const merged = Array.from(new Set([
    ...(previous ?? []),
    ...(next ?? []),
  ].map(value => firstPersistedString(value)).filter((value): value is string => !!value)));
  return merged.length > 0 ? merged : undefined;
}

function getPersistedTurnResponsePartIdentity(part: TurnResponsePart): string | null {
  if (part.type === 'terminal') {
    const terminalSessionKey = getPersistedTerminalSessionKey(part);
    if (terminalSessionKey) {
      return `terminal-session:${terminalSessionKey}`;
    }
  }

  if ('partId' in part && typeof part.partId === 'string' && part.partId.length > 0) {
    return part.partId;
  }

  switch (part.type) {
    case 'tool_call':
      return typeof part.toolCallId === 'string' && part.toolCallId.length > 0
        ? `tool_call:${part.toolCallId}`
        : null;
    case 'terminal':
      return typeof part.toolCallId === 'string' && part.toolCallId.length > 0
        ? `terminal:${part.toolCallId}`
        : null;
    case 'state':
      return typeof part.stateId === 'string' && part.stateId.length > 0
        ? `state:${part.stateId}`
        : null;
    case 'confirmation':
      return typeof part.askId === 'string' && part.askId.length > 0
        ? `confirmation:${part.askId}`
        : null;
    case 'subagent':
      return typeof part.toolCallId === 'string' && part.toolCallId.length > 0
        ? `subagent:${part.toolCallId}`
        : null;
    case 'plan':
      return typeof part.partId === 'string' && part.partId.length > 0
        ? part.partId
        : 'plan:proposed';
    default:
      return null;
  }
}

function getPersistedTerminalSessionKey(part: Extract<TurnResponsePart, { type: 'terminal' }>): string | undefined {
  return firstPersistedString(part.processId, part.outputSessionId, part.terminalId);
}

type ImportedTurnResponsePart = TurnResponsePart;

function assignFallbackPartIdsForImportedTurn(
  turnId: string,
  parts: readonly ImportedTurnResponsePart[],
): TurnResponsePart[] {
  return parts.map((part, index) => {
    if ('partId' in part && typeof part.partId === 'string' && part.partId.trim().length > 0) {
      return part;
    }

    switch (part.type) {
      case 'tool_call':
        return {
          ...part,
          partId: typeof part.toolCallId === 'string' && part.toolCallId.length > 0
            ? `tool:${part.toolCallId}`
            : `tool:${turnId}:${index}`,
        };
      case 'markdown':
        return {
          ...part,
          partId: `markdown:${turnId}:${index}`,
        } as TurnResponsePart;
      case 'thinking':
        return {
          ...part,
          partId: `thinking:${turnId}:${index}`,
        } as TurnResponsePart;
      case 'question':
        return {
          ...part,
          partId: `question:${turnId}:${index}`,
        };
      case 'confirmation':
        return {
          ...part,
          partId: typeof part.askId === 'string' && part.askId.length > 0
            ? `confirmation:${part.askId}`
            : `confirmation:${turnId}:${index}`,
          source: part.source,
          actions: part.actions,
          primaryScope: part.primaryScope,
          resolved: part.resolved,
          result: part.result,
          scope: part.scope,
        };
      case 'terminal':
        const terminalSessionKey = getPersistedTerminalSessionKey(part);
        return {
          ...part,
          partId: terminalSessionKey
            ? `terminal-session:${terminalSessionKey}`
            : typeof part.toolCallId === 'string' && part.toolCallId.length > 0
            ? `terminal:${part.toolCallId}`
            : `terminal:${turnId}:${index}`,
        };
      case 'subagent':
        return {
          ...part,
          partId: typeof part.toolCallId === 'string' && part.toolCallId.length > 0
            ? `subagent:${part.toolCallId}`
            : `subagent:${turnId}:${index}`,
        };
      case 'plan':
        return {
          ...part,
          partId: `plan:${turnId}:${index}`,
        };
      default:
        return part;
    }
  });
}

function mergePersistedTimelineEntries(previous: unknown, next: unknown): Record<string, unknown>[] | undefined {
  const merged: Record<string, unknown>[] = [];
  const indexByRecordId = new Map<string, number>();

  const appendEntries = (entries: Record<string, unknown>[]) => {
    for (const entry of entries) {
      const recordId = typeof entry['recordId'] === 'string' ? entry['recordId'] : undefined;
      if (!recordId) {
        merged.push({ ...entry });
        continue;
      }

      const existingIndex = indexByRecordId.get(recordId);
      if (existingIndex === undefined) {
        indexByRecordId.set(recordId, merged.length);
        merged.push({ ...entry });
        continue;
      }

      merged[existingIndex] = {
        ...merged[existingIndex],
        ...entry,
      };
    }
  };

  appendEntries(asPersistedRecordArray(previous));
  appendEntries(asPersistedRecordArray(next));

  return merged.length > 0 ? merged : undefined;
}

function mergePersistedToolSpecificData(previous: unknown, next: unknown): Record<string, unknown> | undefined {
  const previousRecord = asPersistedRecord(previous);
  const nextRecord = asPersistedRecord(next);
  if (!previousRecord && !nextRecord) {
    return undefined;
  }

  const merged = {
    ...(previousRecord ?? {}),
    ...(nextRecord ?? {}),
  };

  // Live subagent child output is represented as scoped first-class parts.
  // `toolSpecificData.childItems` is a legacy restore/migration shape only;
  // preserving it in sparse live updates reintroduces parent-metadata churn.
  if (merged['kind'] === 'subagent') {
    delete merged['childItems'];
  }

  return merged;
}

function mergePersistedPartMetadata(previous: unknown, next: unknown): Record<string, unknown> | undefined {
  const previousRecord = asPersistedRecord(previous);
  const nextRecord = asPersistedRecord(next);
  if (!previousRecord && !nextRecord) {
    return undefined;
  }

  const merged = {
    ...(previousRecord ?? {}),
    ...(nextRecord ?? {}),
  };
  const timeline = mergePersistedTimelineEntries(previousRecord?.['timeline'], nextRecord?.['timeline']);
  if (timeline) {
    merged['timeline'] = timeline;
  }
  const toolSpecificData = mergePersistedToolSpecificData(previousRecord?.['toolSpecificData'], nextRecord?.['toolSpecificData']);
  if (toolSpecificData) {
    merged['toolSpecificData'] = toolSpecificData;
  }

  return merged;
}

function mergePersistedTurnResponsePart(previous: TurnResponsePart, next: TurnResponsePart): TurnResponsePart {
  if (previous.type !== next.type) {
    return next;
  }

  switch (next.type) {
    case 'thinking': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'thinking' }>;
      return {
        ...previousPart,
        ...next,
        content: next.content.length > 0 ? next.content : previousPart.content,
      };
    }
    case 'tool_call': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'tool_call' }>;
      return {
        ...previousPart,
        ...next,
        args: next.args ?? previousPart.args,
        metadata: mergePersistedPartMetadata(previousPart.metadata, next.metadata),
      };
    }
    case 'state': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'state' }>;
      return {
        ...previousPart,
        ...next,
        kind: next.kind ?? previousPart.kind,
        progress: next.progress ?? previousPart.progress,
        metadata: mergePersistedPartMetadata(previousPart.metadata, next.metadata),
      };
    }
    case 'confirmation': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'confirmation' }>;
      return {
        ...previousPart,
        ...next,
        args: next.args ?? previousPart.args,
        toolName: next.toolName ?? previousPart.toolName,
        title: next.title ?? previousPart.title,
        subtitle: next.subtitle ?? previousPart.subtitle,
        source: next.source ?? previousPart.source,
        actions: next.actions ?? previousPart.actions,
        primaryScope: next.primaryScope ?? previousPart.primaryScope,
        result: next.result ?? previousPart.result,
        scope: next.scope ?? previousPart.scope,
      };
    }
    case 'terminal': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'terminal' }>;
      return {
        ...previousPart,
        ...next,
        command: next.command || previousPart.command,
        output: next.output ?? previousPart.output,
        stderr: next.stderr ?? previousPart.stderr,
        exitCode: next.exitCode ?? previousPart.exitCode,
        isRunning: next.isRunning ?? previousPart.isRunning,
        toolCallId: next.toolCallId ?? previousPart.toolCallId,
        sourceToolCallIds: mergePersistedStringArrays(previousPart.sourceToolCallIds, next.sourceToolCallIds),
        processId: next.processId ?? previousPart.processId,
        outputSessionId: next.outputSessionId ?? previousPart.outputSessionId,
        terminalId: next.terminalId ?? previousPart.terminalId,
        outputFilePath: next.outputFilePath ?? previousPart.outputFilePath,
        cwd: next.cwd ?? previousPart.cwd,
        status: next.status ?? previousPart.status,
        bytesTotal: next.bytesTotal ?? previousPart.bytesTotal,
        lastOutputAt: next.lastOutputAt ?? previousPart.lastOutputAt,
      };
    }
    case 'subagent': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'subagent' }>;
      return {
        ...previousPart,
        ...next,
        childItems: next.childItems ?? previousPart.childItems,
        metadata: mergePersistedPartMetadata(previousPart.metadata, next.metadata),
      };
    }
    case 'plan': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'plan' }>;
      return {
        ...previousPart,
        ...next,
        text: next.text || previousPart.text,
        steps: next.steps ?? previousPart.steps,
        assumptions: next.assumptions ?? previousPart.assumptions,
        verification: next.verification ?? previousPart.verification,
        source: next.source ?? previousPart.source,
      };
    }
    default:
      return next;
  }
}

function normalizePersistedTurnResponseParts(parts: readonly TurnResponsePart[]): TurnResponsePart[] {
  const normalizedParts: TurnResponsePart[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const part of parts) {
    const identity = getPersistedTurnResponsePartIdentity(part);
    if (!identity) {
      normalizedParts.push(part);
      continue;
    }

    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, normalizedParts.length);
      normalizedParts.push(part);
      continue;
    }

    normalizedParts[existingIndex] = mergePersistedTurnResponsePart(normalizedParts[existingIndex], part);
  }

  return removePersistedTerminalOwnedToolCalls(normalizedParts);
}

function removePersistedTerminalOwnedToolCalls(parts: readonly TurnResponsePart[]): TurnResponsePart[] {
  const owners = collectPersistedTerminalOwners(parts);
  if (owners.toolCallIds.size === 0 && owners.sessionIds.size === 0) {
    return [...parts];
  }

  const terminalOwnedToolCallIds = new Set(owners.toolCallIds);
  for (const part of parts) {
    if (isPersistedTerminalOwnedToolCall(part, owners)) {
      terminalOwnedToolCallIds.add(part.toolCallId);
    }
  }

  return parts.filter(part => {
    if (part.type === 'tool_call') {
      return !terminalOwnedToolCallIds.has(part.toolCallId);
    }

    if (part.type === 'confirmation') {
      const metadata = asPersistedRecord(part.metadata);
      const confirmationToolCallId = firstPersistedString(part.askId, metadata?.['toolCallId']);
      return !confirmationToolCallId || !terminalOwnedToolCallIds.has(confirmationToolCallId);
    }

    return true;
  });
}

function collectPersistedTerminalOwners(parts: readonly TurnResponsePart[]): { toolCallIds: Set<string>; sessionIds: Set<string> } {
  const toolCallIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const part of parts) {
    if (part.type !== 'terminal') {
      continue;
    }

    const terminal = part as Extract<TurnResponsePart, { type: 'terminal' }>;
    if (terminal.toolCallId) {
      toolCallIds.add(terminal.toolCallId);
    }
    for (const sourceToolCallId of terminal.sourceToolCallIds ?? []) {
      if (sourceToolCallId) {
        toolCallIds.add(sourceToolCallId);
      }
    }
    for (const sessionId of [terminal.processId, terminal.outputSessionId, terminal.terminalId]) {
      if (sessionId) {
        sessionIds.add(sessionId);
      }
    }
  }

  return { toolCallIds, sessionIds };
}

function isPersistedTerminalOwnedToolCall(
  part: TurnResponsePart,
  owners: { toolCallIds: ReadonlySet<string>; sessionIds: ReadonlySet<string> },
): part is TurnResponseToolCallPart {
  if (part.type !== 'tool_call' || !isTerminalSessionToolName(part.toolName)) {
    return false;
  }

  if (owners.toolCallIds.has(part.toolCallId)) {
    return true;
  }

  const args = asPersistedRecord(part.args);
  const metadata = asPersistedRecord(part.metadata);
  const sessionIds = [
    firstPersistedString(args?.['processId']),
    firstPersistedString(args?.['outputSessionId']),
    firstPersistedString(args?.['terminalId']),
    firstPersistedString(args?.['id']),
    firstPersistedString(metadata?.['processId']),
    firstPersistedString(metadata?.['outputSessionId']),
    firstPersistedString(metadata?.['terminalId']),
    firstPersistedString(metadata?.['id']),
    ...extractPersistedTerminalSessionIdsFromText(firstPersistedString(part.text, metadata?.['resultText'])),
  ].filter((value): value is string => !!value);

  return sessionIds.some(sessionId => owners.sessionIds.has(sessionId));
}

function extractPersistedTerminalSessionIdsFromText(text: string | undefined): string[] {
  if (!text) {
    return [];
  }

  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const key = match[1];
    if (key !== 'processId' && key !== 'outputSessionId' && key !== 'terminalId' && key !== 'id') {
      continue;
    }
    const value = firstPersistedString(match[2]);
    if (value) {
      ids.push(value);
    }
  }
  return ids;
}

function getPersistedTurnDisplayContent(turn: TurnResponseTurn): string {
  if (typeof turn.request?.displayContent === 'string') {
    return turn.request.displayContent;
  }

  return typeof turn.request?.content === 'string' ? turn.request.content : '';
}

function shouldMergeTurnResponseContinuation(
  previous: TurnResponseTurn | null,
  next: TurnResponseTurn,
): boolean {
  if (!previous) {
    return false;
  }

  if (previous.response.status !== 'streaming' || next.response.status === 'streaming') {
    return false;
  }

  if (previous.response.participant !== next.response.participant) {
    return false;
  }

  if ((previous.request?.content ?? '') !== (next.request?.content ?? '')) {
    return false;
  }

  if (getPersistedTurnDisplayContent(previous) !== getPersistedTurnDisplayContent(next)) {
    return false;
  }

  return true;
}

function mergeTurnResponseContinuation(previous: TurnResponseTurn, next: TurnResponseTurn): TurnResponseTurn {
  const mergedParts = normalizePersistedTurnResponseParts([
    ...(previous.response.parts ?? []),
    ...(next.response.parts ?? []),
  ]);

  return {
    ...next,
    request: {
      ...previous.request,
      ...next.request,
    },
    rounds: next.rounds?.length > 0 ? next.rounds : previous.rounds,
    response: {
      ...previous.response,
      ...next.response,
      parts: mergedParts,
      continuation: next.response.continuation ?? previous.response.continuation,
      resultText: next.response.resultText || collectMainTurnResponseText(mergedParts),
      createdAt: previous.response.createdAt || next.response.createdAt,
      updatedAt: next.response.updatedAt || previous.response.updatedAt,
    },
    createdAt: previous.createdAt || next.createdAt,
    updatedAt: next.updatedAt || previous.updatedAt,
  };
}

function mergeTurnResponseContinuations(turns: readonly TurnResponseTurn[]): TurnResponseTurn[] {
  const mergedTurns: TurnResponseTurn[] = [];

  for (const turn of turns) {
    const previous = mergedTurns.length > 0 ? mergedTurns[mergedTurns.length - 1] : null;
    if (shouldMergeTurnResponseContinuation(previous, turn)) {
      mergedTurns[mergedTurns.length - 1] = mergeTurnResponseContinuation(previous!, turn);
      continue;
    }

    mergedTurns.push(turn);
  }

  return mergedTurns;
}

function normalizeLiveTurnResponses(turnResponses: readonly TurnResponseTurn[]): TurnResponseTurn[] {
  return mergeTurnResponseContinuations(turnResponses);
}

function buildHostResponseEntries(
  turnResponses: readonly PersistedHostTurnResponse[],
): HostResponseEntry[] {
  if (turnResponses.length > 0) {
    return turnResponses.map(turn => {
      const turnResponse = normalizeHostTurnResponseForProjection(turn);
      return {
        kind: 'turn',
        turnId: turnResponse.turnId,
        turnResponse,
        user: null,
        assistant: null,
        runtimeState: buildPersistedHostTurnRuntimeState(turnResponse.response),
      } satisfies HostTurnResponseEntry;
    });
  }

  return [];
}

function normalizeHostTurnResponseForProjection(turn: PersistedHostTurnResponse): PersistedHostTurnResponse {
  const now = Date.now();
  const turnId = typeof turn.turnId === 'string' && turn.turnId.length > 0
    ? turn.turnId
    : `turn-${now}`;
  const request = turn.request ?? { content: '' };
  const response = turn.response ?? {
    id: turnId,
    participant: getTurnResponseParticipant(undefined),
    status: 'streaming',
    parts: [],
    resultText: '',
    createdAt: turn.createdAt ?? now,
    updatedAt: turn.updatedAt ?? now,
  };
  return {
    ...turn,
    turnId,
    request,
    response: {
      ...response,
      parts: normalizePersistedTurnResponseParts(
        assignFallbackPartIdsForImportedTurn(turnId, response.parts ?? []),
      ),
    },
    rounds: turn.rounds ?? [],
    createdAt: turn.createdAt ?? response.createdAt ?? now,
    updatedAt: turn.updatedAt ?? response.updatedAt ?? now,
  };
}

function buildPersistedHostTurnRuntimeState(
  response: PersistedHostTurnResponse['response'],
): HostTurnRuntimeState | undefined {
  if (!response) {
    return undefined;
  }

  const persistedResponseData = extractPersistedResponseData(response);
  if (!persistedResponseData) {
    return undefined;
  }

  return {
    responseSidecar: {
      ...(normalizeHostResponseSlashCommand(persistedResponseData.slashCommand) ? { slashCommand: normalizeHostResponseSlashCommand(persistedResponseData.slashCommand) } : {}),
      ...(typeof persistedResponseData.responseId === 'string' && persistedResponseData.responseId.length > 0 ? { responseId: persistedResponseData.responseId } : {}),
      ...(normalizePersistedResponseMarkdownInfo(persistedResponseData.responseMarkdownInfo)
        ? { responseMarkdownInfo: normalizePersistedResponseMarkdownInfo(persistedResponseData.responseMarkdownInfo) }
        : {}),
      ...(persistedResponseData.followups ? { followups: cloneHostStreamFollowups(persistedResponseData.followups) } : {}),
      ...(normalizePersistedResponseModelState(persistedResponseData.modelState)
        ? { modelState: normalizePersistedResponseModelState(persistedResponseData.modelState) }
        : {}),
      ...(persistedResponseData.vote === 0 || persistedResponseData.vote === 1 ? { vote: persistedResponseData.vote } : {}),
      ...(typeof persistedResponseData.timestamp === 'number' ? { timestamp: persistedResponseData.timestamp } : {}),
      ...(typeof persistedResponseData.elapsedMs === 'number' ? { elapsedMs: persistedResponseData.elapsedMs } : {}),
      ...(typeof persistedResponseData.timeSpentWaiting === 'number' ? { timeSpentWaiting: persistedResponseData.timeSpentWaiting } : {}),
      ...(typeof persistedResponseData.completionTokens === 'number' ? { completionTokens: persistedResponseData.completionTokens } : {}),
    },
  };
}

function extractPersistedResponseData(
  response: TurnResponseTurn['response'] & PersistedHostResponseData,
): PersistedHostResponseData | undefined {
  const persistedResponseData: PersistedHostResponseData = {
    ...(normalizeHostResponseSlashCommand(response.slashCommand)
      ? { slashCommand: normalizeHostResponseSlashCommand(response.slashCommand)! }
      : {}),
    ...(typeof response.responseId === 'string' && response.responseId.length > 0 ? { responseId: response.responseId } : {}),
    ...(normalizePersistedResponseMarkdownInfo(response.responseMarkdownInfo)
      ? { responseMarkdownInfo: normalizePersistedResponseMarkdownInfo(response.responseMarkdownInfo) }
      : {}),
    ...(Array.isArray(response.followups) ? { followups: response.followups.map(followup => ({ ...followup })) } : {}),
    ...(normalizePersistedResponseModelState(response.modelState)
      ? { modelState: normalizePersistedResponseModelState(response.modelState) }
      : {}),
    ...(response.vote === 0 || response.vote === 1 ? { vote: response.vote } : {}),
    ...(typeof response.timestamp === 'number' ? { timestamp: response.timestamp } : {}),
    ...(typeof response.elapsedMs === 'number' ? { elapsedMs: response.elapsedMs } : {}),
    ...(typeof response.timeSpentWaiting === 'number' ? { timeSpentWaiting: response.timeSpentWaiting } : {}),
    ...(typeof response.completionTokens === 'number' ? { completionTokens: response.completionTokens } : {}),
  };

  return Object.keys(persistedResponseData).length > 0 ? persistedResponseData : undefined;
}

export function buildChatListFromEntries(entries: readonly HostResponseEntry[]): ChatListItem[] {
  const chatList: ChatListItem[] = [];

  for (const entry of entries) {
    for (const message of buildTurnEntryMessageProjections(entry)) {
      chatList.push({
        role: message.role,
        content: message.content,
        state: message.state,
        source: message.source,
        modelName: message.modelName,
        modelBillingLabel: message.modelBillingLabel,
        turnId: message.turnContext?.turnId,
      });
    }
  }

  return chatList;
}

export function buildTurnNativeRestoreChatListFromEntries(entries: readonly HostResponseEntry[]): ChatListItem[] {
  const chatList: ChatListItem[] = [];

  for (const entry of entries) {
    for (const message of buildTurnEntryMessageProjections(entry)) {
      if (message.role === 'aily') {
        continue;
      }

      chatList.push({
        role: message.role,
        content: message.content,
        state: message.state,
        source: message.source,
        modelName: message.modelName,
        modelBillingLabel: message.modelBillingLabel,
        turnId: message.turnContext?.turnId,
      });
    }
  }

  return chatList;
}

export function buildTurnNativeRestoreChatList(
  chatList: readonly ChatListItem[],
  turnIds: ReadonlySet<string>,
): ChatListItem[] {
  const skippedCanonicalAssistantByTurnId = new Set<string>();
  const restoreList: ChatListItem[] = [];

  for (const message of chatList) {
    if (message.role !== 'aily') {
      restoreList.push({ ...message });
      continue;
    }

    if (typeof message.turnId !== 'string' || !turnIds.has(message.turnId)) {
      restoreList.push({ ...message });
      continue;
    }

    if (!skippedCanonicalAssistantByTurnId.has(message.turnId)) {
      skippedCanonicalAssistantByTurnId.add(message.turnId);
      continue;
    }

    restoreList.push({ ...message });
  }

  return restoreList;
 }

function buildCanonicalDialogItemsFromEntries(
  entries: readonly HostResponseEntry[],
  options: HostResponseProjectionBuildOptions = {},
): ChatDialogViewItem[] {
  const startedAt = readHighResolutionNow();
  const disabledRequestTurnIds = new Set(options.disabledRequestTurnIds ?? []);
  const items: ChatDialogViewItem[] = [];
  const retainedTurnIds = new Set<string>();
  options.dialogItemStore?.beginProjection();

  for (const entry of entries) {
    if (entry.kind !== 'turn' || !entry.turnResponse) {
      continue;
    }

    const requestDisabled = disabledRequestTurnIds.has(entry.turnId);
    retainedTurnIds.add(entry.turnId);
    items.push(...(
      options.dialogItemStore?.resolveEntryItems(entry, requestDisabled)
      ?? buildCanonicalDialogItemsForEntry(entry, requestDisabled)
    ));
  }
  options.dialogItemStore?.prune(retainedTurnIds);

  const stabilizedItems = stabilizeCanonicalDialogItems(
    finalizeCanonicalDialogItems(items, disabledRequestTurnIds),
    options.previousDialogItems,
  );
  const finalizedItems = options.dialogItemStore?.freezeCompletedItems(stabilizedItems) ?? stabilizedItems;
  options.dialogItemStore?.completeProjection(
    finalizedItems,
    options.previousDialogItems ?? null,
    readHighResolutionNow() - startedAt,
  );
  return finalizedItems;
}

function buildCanonicalDialogItemsForEntry(
  entry: HostTurnResponseEntry,
  requestDisabled: boolean,
): ChatDialogViewItem[] {
  if (!entry.turnResponse) {
    return [];
  }

  const items: ChatDialogViewItem[] = [];
  const userItem = buildCanonicalRequestDialogItemForEntry(entry, requestDisabled);
  if (userItem) {
    items.push(userItem);
  }

  const assistantItem = buildCanonicalResponseDialogItemForEntry(entry, requestDisabled);
  if (assistantItem) {
    items.push(assistantItem);
  }

  return items;
}

function buildCanonicalRequestDialogItemForEntry(
  entry: HostTurnResponseEntry,
  requestDisabled: boolean,
): ChatDialogViewItem | null {
  if (!entry.turnResponse) {
    return null;
  }

  const userProjection = buildTurnResponseUserMessageProjection(entry.turnResponse, entry.user ?? undefined);
  const userTurnContext = buildDialogTurnContext({
    turnResponse: entry.turnResponse,
    requestDisabled,
    requestContent: userProjection.turnContext?.requestContent,
    displayContent: userProjection.turnContext?.displayContent,
  });

  if (!userTurnContext) {
    return null;
  }

  return {
    id: `request:${entry.turnId}`,
    turnId: entry.turnId,
    role: 'user',
    content: userProjection.content,
    doing: userProjection.state === 'doing',
    turnModelName: '',
    turnContext: userTurnContext,
    parts: [],
    turnResponse: entry.turnResponse,
    revision: readDialogItemRevision(entry.turnResponse),
    isLastAily: false,
    isFirstUserTurn: false,
    showCheckpointRestore: false,
  };
}

function buildCanonicalResponseDialogItemForEntry(
  entry: HostTurnResponseEntry,
  requestDisabled: boolean,
): ChatDialogViewItem | null {
  if (!entry.turnResponse) {
    return null;
  }

  const assistantProjection = buildTurnResponseAssistantMessageProjection(entry.turnResponse, entry.assistant ?? undefined);
  const assistantTurnContext = buildDialogTurnContext({
    turnResponse: entry.turnResponse,
    requestDisabled,
  });

  if (!assistantTurnContext) {
    return null;
  }

  return {
    id: `response:${entry.turnId}`,
    turnId: entry.turnId,
    responseId: entry.turnId,
    role: 'aily',
    content: assistantProjection.content || getTurnResponseAssistantText(entry.turnResponse),
    doing: assistantProjection.state === 'doing',
    turnModelName: assistantProjection.modelName || '',
    turnModelBillingLabel: assistantProjection.modelBillingLabel,
    turnContext: assistantTurnContext,
    parts: turnResponsePartsToDisplayChatParts(buildHostResponseViewParts(entry.turnResponse.response.parts)),
    turnResponse: entry.turnResponse,
    revision: readDialogItemRevision(entry.turnResponse),
    responseVote: entry.runtimeState?.responseSidecar?.vote,
    isLastAily: false,
    isFirstUserTurn: false,
    showCheckpointRestore: false,
  };
}

function readDialogItemRevision(turnResponse: TurnResponseTurn): number {
  return turnResponse.response.updatedAt
    ?? turnResponse.updatedAt
    ?? turnResponse.response.createdAt
    ?? turnResponse.createdAt
    ?? 0;
}

class HostDialogItemProjectionStore {
  private readonly entryItemsByTurnId = new Map<string, {
    readonly requestSignature: string;
    readonly responseSignature: string;
    readonly requestItem: ChatDialogViewItem | null;
    readonly responseItem: ChatDialogViewItem | null;
    readonly items: readonly ChatDialogViewItem[];
    readonly frozen: boolean;
  }>();
  private readonly frozenTurnIds = new Set<string>();
  private currentMetrics = createEmptyHostDialogProjectionMetrics();
  private lastMetrics = createEmptyHostDialogProjectionMetrics();

  beginProjection(): void {
    this.currentMetrics = createEmptyHostDialogProjectionMetrics();
  }

  resolveEntryItems(
    entry: HostTurnResponseEntry,
    requestDisabled: boolean,
  ): readonly ChatDialogViewItem[] {
    const requestSignature = buildCanonicalDialogRequestSignature(entry, requestDisabled);
    const responseSignature = buildCanonicalDialogResponseSignature(entry, requestDisabled);
    const cached = this.entryItemsByTurnId.get(entry.turnId);
    if (cached?.requestSignature === requestSignature && cached.responseSignature === responseSignature) {
      this.currentMetrics = {
        ...this.currentMetrics,
        reusedTurnCount: this.currentMetrics.reusedTurnCount + 1,
        frozenTurnCount: this.currentMetrics.frozenTurnCount + (cached.frozen ? 1 : 0),
      };
      return cached.items;
    }

    const shouldFreeze = isCompletedHostTurnEntry(entry);
    const requestItem = cached?.requestSignature === requestSignature
      ? cached.requestItem
      : buildCanonicalRequestDialogItemForEntry(entry, requestDisabled);
    const responseItem = cached?.responseSignature === responseSignature
      ? cached.responseItem
      : buildCanonicalResponseDialogItemForEntry(entry, requestDisabled);
    const items = [
      ...(requestItem ? [requestItem] : []),
      ...(responseItem ? [responseItem] : []),
    ];
    if (shouldFreeze) {
      this.frozenTurnIds.add(entry.turnId);
    } else {
      this.frozenTurnIds.delete(entry.turnId);
    }
    this.entryItemsByTurnId.set(entry.turnId, {
      requestSignature,
      responseSignature,
      requestItem,
      responseItem,
      items,
      frozen: shouldFreeze,
    });
    this.currentMetrics = {
      ...this.currentMetrics,
      reusedTurnCount: this.currentMetrics.reusedTurnCount + (cached ? 1 : 0),
      rebuiltTurnCount: this.currentMetrics.rebuiltTurnCount + (cached ? 0 : 1),
      frozenTurnCount: this.currentMetrics.frozenTurnCount + (shouldFreeze ? 1 : 0),
    };
    return items;
  }

  prune(retainedTurnIds: ReadonlySet<string>): void {
    let prunedTurnCount = 0;
    for (const turnId of [...this.entryItemsByTurnId.keys()]) {
      if (!retainedTurnIds.has(turnId)) {
        this.entryItemsByTurnId.delete(turnId);
        this.frozenTurnIds.delete(turnId);
        prunedTurnCount += 1;
      }
    }
    if (prunedTurnCount > 0) {
      this.currentMetrics = {
        ...this.currentMetrics,
        prunedTurnCount: this.currentMetrics.prunedTurnCount + prunedTurnCount,
      };
    }
  }

  completeProjection(
    items: readonly ChatDialogViewItem[],
    previousItems: readonly ChatDialogViewItem[] | null,
    durationMs: number,
  ): void {
    const previousById = new Map((previousItems ?? []).map(item => [item.id, item] as const));
    const changedItemCount = previousItems
      ? items.reduce((count, item) => count + (previousById.get(item.id) === item ? 0 : 1), 0)
      : items.length;
    this.lastMetrics = {
      ...this.currentMetrics,
      itemCount: items.length,
      changedItemCount,
      durationMs,
    };
    traceHostDialogProjectionMetrics(this.lastMetrics);
  }

  freezeCompletedItems(items: readonly ChatDialogViewItem[]): ChatDialogViewItem[] {
    if (this.frozenTurnIds.size === 0) {
      return [...items];
    }

    return items.map(item => {
      const turnId = item.turnContext?.turnId;
      return turnId && this.frozenTurnIds.has(turnId) && !Object.isFrozen(item)
        ? Object.freeze({ ...item })
        : item;
    });
  }

  getLastMetrics(): HostDialogProjectionMetrics {
    return this.lastMetrics;
  }

  clear(): void {
    this.entryItemsByTurnId.clear();
    this.frozenTurnIds.clear();
    this.currentMetrics = createEmptyHostDialogProjectionMetrics();
    this.lastMetrics = createEmptyHostDialogProjectionMetrics();
  }
}

function createEmptyHostDialogProjectionMetrics(): HostDialogProjectionMetrics {
  return {
    itemCount: 0,
    changedItemCount: 0,
    reusedTurnCount: 0,
    rebuiltTurnCount: 0,
    frozenTurnCount: 0,
    prunedTurnCount: 0,
    durationMs: 0,
  };
}

function isCompletedHostTurnEntry(entry: HostTurnResponseEntry): boolean {
  const status = entry.turnResponse?.response.status;
  return !!status && status !== 'streaming';
}

function readHighResolutionNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function traceHostDialogProjectionMetrics(metrics: HostDialogProjectionMetrics): void {
  if (metrics.itemCount === 0) {
    return;
  }

  let debugEnabled = false;
  try {
    debugEnabled = globalThis.localStorage?.getItem('aily.chat.projectionPerf') === '1';
  } catch {
    debugEnabled = false;
  }

  if (!debugEnabled && metrics.durationMs < 16) {
    return;
  }

  console.debug('[AilyChat][ProjectionPerf]', {
    itemCount: metrics.itemCount,
    changedItemCount: metrics.changedItemCount,
    reusedTurnCount: metrics.reusedTurnCount,
    rebuiltTurnCount: metrics.rebuiltTurnCount,
    frozenTurnCount: metrics.frozenTurnCount,
    prunedTurnCount: metrics.prunedTurnCount,
    durationMs: Math.round(metrics.durationMs * 100) / 100,
  });
}

function buildCanonicalDialogRequestSignature(
  entry: HostTurnResponseEntry,
  requestDisabled: boolean,
): string {
  const turn = entry.turnResponse;
  const request = turn?.request;
  return [
    entry.turnId,
    requestDisabled === true ? 'disabled' : 'enabled',
    request?.content ?? '',
    request?.displayContent ?? '',
    getRequestMetadataSignature(request?.metadata),
    buildRoundsProjectionSignature(turn?.rounds),
    entry.user?.displayContent ?? '',
    entry.user?.requestContent ?? '',
    entry.user?.state ?? '',
  ].join('\u0000');
}

function buildCanonicalDialogResponseSignature(
  entry: HostTurnResponseEntry,
  requestDisabled: boolean,
): string {
  const turn = entry.turnResponse;
  const response = turn?.response;
  const request = turn?.request;
  const parts = response?.parts ?? [];
  const lastPart = parts.length > 0 ? parts[parts.length - 1] : null;

  return [
    entry.turnId,
    requestDisabled === true ? 'disabled' : 'enabled',
    getRequestMetadataSignature(request?.metadata),
    turn?.updatedAt ?? '',
    response?.id ?? '',
    response?.participant ?? '',
    response?.status ?? '',
    response?.resultText ?? '',
    response?.createdAt ?? '',
    response?.updatedAt ?? '',
    parts.length,
    getTurnResponsePartProjectionSignature(lastPart),
    response?.progressMessages?.length ?? 0,
    entry.assistant?.content ?? '',
    entry.assistant?.state ?? '',
    entry.assistant?.modelName ?? '',
    entry.assistant?.modelBillingLabel ?? '',
    entry.runtimeState?.responseSidecar?.vote ?? '',
  ].join('\u0000');
}

function getRequestMetadataSignature(metadata: TurnResponseTurn['request']['metadata'] | undefined): string {
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }
  const record = metadata as Record<string, unknown>;
  return [
    normalizeMetadataSignatureValue(record['checkpointId']),
    normalizeMetadataSignatureValue(record['requestId']),
    normalizeMetadataSignatureValue(record['checkpointTurnIndex']),
  ].join('\u001f');
}

function normalizeMetadataSignatureValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

function buildRoundsProjectionSignature(rounds: TurnResponseTurn['rounds'] | undefined): string {
  if (!rounds?.length) {
    return '0';
  }

  const lastRound = rounds[rounds.length - 1];
  return [
    rounds.length,
    lastRound?.id ?? '',
    lastRound?.toolCalls?.length ?? 0,
  ].join(':');
}

function getTurnResponsePartProjectionSignature(part: TurnResponsePart | null): string {
  if (!part) {
    return '';
  }

  const record = part as unknown as Record<string, unknown>;
  const content = typeof record['content'] === 'string'
    ? record['content']
    : typeof record['text'] === 'string'
      ? record['text']
      : typeof record['output'] === 'string'
        ? record['output']
        : '';
  return [
    part.type,
    typeof record['partId'] === 'string' ? record['partId'] : '',
    typeof record['toolCallId'] === 'string' ? record['toolCallId'] : '',
    typeof record['status'] === 'string' ? record['status'] : '',
    typeof record['state'] === 'string' ? record['state'] : '',
    typeof record['isRunning'] === 'boolean' ? String(record['isRunning']) : '',
    typeof record['exitCode'] === 'number' ? String(record['exitCode']) : '',
    typeof record['lastOutputAt'] === 'number' ? String(record['lastOutputAt']) : '',
    content.length,
    content,
  ].join(':');
}

function finalizeCanonicalDialogItems(
  items: readonly ChatDialogViewItem[],
  disabledRequestTurnIds: ReadonlySet<string>,
): ChatDialogViewItem[] {
  if (items.length === 0) {
    return [];
  }

  const firstUserIndex = items.findIndex(item => item.role === 'user' && !!item.turnContext?.turnId);
  let lastAilyIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].role === 'aily') {
      lastAilyIndex = index;
      break;
    }
  }

  return items.map((item, index) => ({
    ...item,
    isLastAily: index === lastAilyIndex,
    isFirstUserTurn: index === firstUserIndex,
    showCheckpointRestore: false,
  }));
}

function stabilizeCanonicalDialogItems(
  nextItems: readonly ChatDialogViewItem[],
  previousItems: readonly ChatDialogViewItem[] | null | undefined,
): ChatDialogViewItem[] {
  if (!previousItems?.length || nextItems.length === 0) {
    return [...nextItems];
  }

  const previousById = new Map(previousItems.map(item => [item.id, item]));
  let reusedCount = 0;
  const stabilized = nextItems.map((item) => {
    const previous = previousById.get(item.id);
    if (!previous || !canReuseCanonicalDialogItem(previous, item)) {
      return item;
    }
    reusedCount += 1;
    return previous;
  });

  return reusedCount > 0 ? stabilized : [...nextItems];
}

function canReuseCanonicalDialogItem(
  previous: ChatDialogViewItem,
  next: ChatDialogViewItem,
): boolean {
  return previous.role === next.role
    && previous.content === next.content
    && previous.doing === next.doing
    && previous.turnModelName === next.turnModelName
    && previous.turnModelBillingLabel === next.turnModelBillingLabel
    && getCanonicalDialogPartsSignature(previous.parts) === getCanonicalDialogPartsSignature(next.parts)
    && previous.turnResponse === next.turnResponse
    && previous.revision === next.revision
    && previous.responseVote === next.responseVote
    && previous.isLastAily === next.isLastAily
    && previous.isFirstUserTurn === next.isFirstUserTurn
    && previous.showCheckpointRestore === next.showCheckpointRestore
    && getCanonicalDialogContextSignature(previous) === getCanonicalDialogContextSignature(next);
}

function getCanonicalDialogPartsSignature(parts: readonly ChatPart[]): string {
  return parts
    .map((part, index) => {
      const record = part as unknown as Record<string, unknown>;
      return [
        index,
        part.type,
        typeof record['partId'] === 'string' ? record['partId'] : '',
        typeof record['toolCallId'] === 'string' ? record['toolCallId'] : '',
        typeof record['status'] === 'string' ? record['status'] : '',
        typeof record['state'] === 'string' ? record['state'] : '',
        typeof record['content'] === 'string' ? record['content'].length : '',
        typeof record['text'] === 'string' ? record['text'].length : '',
        typeof record['output'] === 'string' ? record['output'].length : '',
      ].join(':');
    })
    .join('\u0000');
}

function getCanonicalDialogContextSignature(item: ChatDialogViewItem): string {
  const context = item.turnContext;
  const turn = context?.turnResponse;
  const response = turn?.response;
  const baseSignature = [
    context?.turnId ?? '',
    context?.requestDisabled === true ? 'disabled' : 'enabled',
    context?.requestContent ?? '',
    context?.displayContent ?? '',
    context?.roundCount ?? 0,
    context?.toolCallCount ?? 0,
    context?.lastRoundId ?? '',
  ];

  if (item.role === 'user') {
    return baseSignature.join('\u0000');
  }

  return [
    ...baseSignature,
    turn?.updatedAt ?? '',
    response?.updatedAt ?? '',
    response?.status ?? '',
    response?.resultText ?? '',
    response?.parts?.length ?? 0,
    response?.progressMessages?.length ?? 0,
  ].join('\u0000');
}

function buildTurnEntryMessageProjections(
  entry: HostTurnResponseEntry,
): ChatDialogViewMessageProjection[] {
  const messages: ChatDialogViewMessageProjection[] = [];
  const shouldShowSyntheticUser = !entry.user && !!entry.turnResponse;
  const shouldShowUser = !!entry.user || shouldShowSyntheticUser;
  const shouldShowAssistant = !!entry.assistant || !!entry.turnResponse;

  if (shouldShowUser) {
    if (entry.turnResponse) {
      messages.push(buildTurnResponseUserMessageProjection(entry.turnResponse, entry.user ?? undefined));
    } else {
      const turnContext = buildDialogTurnContext({
        turnId: entry.turnId,
        requestContent: entry.user?.requestContent,
        displayContent: entry.user?.displayContent,
      });
      messages.push({
        role: 'user',
        content: entry.user?.displayContent ?? '',
        state: entry.user?.state ?? 'done',
        turnContext,
        source: entry.user?.source,
        modelName: entry.user?.modelName,
        modelBillingLabel: entry.user?.modelBillingLabel,
      });
    }
  }

  if (shouldShowAssistant) {
    if (entry.turnResponse) {
      messages.push({
        ...buildTurnResponseAssistantMessageProjection(entry.turnResponse, entry.assistant ?? undefined),
        responseVote: entry.runtimeState?.responseSidecar?.vote,
      });
    } else {
      const turnContext = buildDialogTurnContext({ turnId: entry.turnId });
      messages.push({
        role: 'aily',
        content: entry.assistant?.content ?? '',
        state: entry.assistant?.state ?? 'done',
        turnContext,
        source: getTurnResponseParticipant(entry.assistant?.source),
        modelName: entry.assistant?.modelName,
        modelBillingLabel: entry.assistant?.modelBillingLabel,
        responseVote: entry.runtimeState?.responseSidecar?.vote,
      });
    }
  }

  return messages;
}

function createEmptyHostStreamTurn(
  turnId: string,
  createdAt: number,
): TurnResponseTurn {
  return {
    turnId,
    request: { content: '' },
    rounds: [],
    response: {
      id: turnId,
      participant: getTurnResponseParticipant(undefined),
      status: 'streaming',
      parts: [],
      resultText: '',
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

function applyHostStreamEvent(
  currentTurn: TurnResponseTurn | null,
  turnId: string,
  event: HostStreamResponseItem,
): TurnResponseTurn {
  if (isHostStreamResponseStartedEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.createdAt);
    return {
      ...baseTurn,
      response: {
        ...baseTurn.response,
        createdAt: baseTurn.response.createdAt ?? event.createdAt,
      },
      createdAt: baseTurn.createdAt ?? event.createdAt,
    };
  }

  if (isHostStreamTurnRequestUpdateEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, Date.now());
    const nextRequestBase: TurnResponseTurn['request'] = {
      ...baseTurn.request,
      ...(Object.prototype.hasOwnProperty.call(event.value, 'content')
        && typeof event.value.content === 'string'
        ? { content: event.value.content }
        : {}),
    };

    const nextRequest = Object.prototype.hasOwnProperty.call(event.value, 'displayContent')
      ? (typeof event.value.displayContent === 'string'
        ? {
          ...nextRequestBase,
          displayContent: event.value.displayContent,
        }
        : (() => {
          const { displayContent, ...rest } = nextRequestBase;
          return rest;
        })())
      : nextRequestBase;

    return {
      ...baseTurn,
      request: nextRequest,
    };
  }

  if (isHostStreamTurnRoundsUpdateEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, Date.now());
    const startIndex = Math.max(0, Math.min(event.value.startIndex, baseTurn.rounds.length));
    return {
      ...baseTurn,
      rounds: [
        ...baseTurn.rounds.slice(0, startIndex),
        ...event.value.rounds,
      ],
    };
  }

  if (isHostStreamResponseIdentityUpdateEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
    const nextResponse: TurnResponseTurn['response'] = {
      ...baseTurn.response,
      updatedAt: event.updatedAt,
      ...(Object.prototype.hasOwnProperty.call(event.value, 'participant')
        ? {
          participant: getTurnResponseParticipant(event.value.participant ?? baseTurn.response.participant),
        }
        : {}),
    };

    return {
      ...baseTurn,
      updatedAt: event.updatedAt,
      response: nextResponse,
    };
  }

  if (isHostStreamResponseProgressEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
    return applyHostStreamResponseProgressUpdate(baseTurn, event);
  }

  if (isHostStreamResponseFollowupsEvent(event)) {
    return currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
  }

  if (isHostStreamResponseStatusUpdateEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
    return {
      ...baseTurn,
      updatedAt: event.updatedAt,
      response: {
        ...baseTurn.response,
        status: event.value,
        updatedAt: event.updatedAt,
      },
    };
  }

  if (isHostStreamUsageEvent(event)) {
    const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
    return {
      ...baseTurn,
      usage: { ...event.value },
      updatedAt: event.updatedAt,
      response: {
        ...baseTurn.response,
        updatedAt: event.updatedAt,
      },
    };
  }

  if (isHostStreamClearToPreviousToolInvocationEvent(event)) {
    return currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
  }

  const baseTurn = currentTurn ?? createEmptyHostStreamTurn(turnId, event.updatedAt);
  const nextParts = [...baseTurn.response.parts];
  const partIndex = resolveHostStreamPartIndex(event);
  if (partIndex >= nextParts.length) {
    nextParts.push(event.part);
  } else {
    nextParts[partIndex] = mergeHostStreamResponsePart(nextParts[partIndex], event);
  }

  return {
    ...baseTurn,
    updatedAt: event.updatedAt,
    response: {
      ...baseTurn.response,
      parts: nextParts,
      resultText: deriveHostStreamResultText(baseTurn.response.resultText, event, nextParts),
      updatedAt: event.updatedAt,
    },
  };
}

function deriveHostStreamResultText(
  previousResultText: string | undefined,
  event: HostStreamResponsePartUpdateEvent,
  nextParts: readonly TurnResponsePart[],
): string {
  let resultText = previousResultText ?? '';
  if (event.part.type !== 'markdown' || isSubagentScopedTurnResponsePart(event.part)) {
    return resultText;
  }

  if (event.kind === 'add') {
    return resultText + event.part.content;
  }

  if (event.kind === 'append' && event.appendTextMode === 'delta') {
    return resultText + event.part.content;
  }

  return collectMainTurnResponseText(nextParts);
}

function mergeHostStreamResponsePart(
  previous: TurnResponsePart,
  event: HostStreamResponsePartUpdateEvent,
): TurnResponsePart {
  if (event.kind === 'append' && event.appendTextMode === 'delta') {
    return mergeDeltaHostStreamResponsePart(previous, event.part);
  }

  return mergePersistedTurnResponsePart(previous, event.part);
}

function mergeDeltaHostStreamResponsePart(previous: TurnResponsePart, next: TurnResponsePart): TurnResponsePart {
  if (previous.type !== next.type) {
    return next;
  }

  switch (next.type) {
    case 'markdown': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'markdown' }>;
      return {
        ...previousPart,
        ...next,
        type: 'markdown',
        content: previousPart.content + next.content,
      };
    }
    case 'thinking': {
      const previousPart = previous as Extract<TurnResponsePart, { type: 'thinking' }>;
      return {
        ...previousPart,
        ...next,
        content: previousPart.content + next.content,
      };
    }
    default:
      return mergePersistedTurnResponsePart(previous, next);
  }
}

function isHostStreamResponseStartedEvent(event: HostStreamResponseItem): event is HostStreamResponseStartedEvent {
  return event.itemType === 'response_started';
}

function isHostStreamTurnRequestUpdateEvent(event: HostStreamResponseItem): event is HostStreamTurnRequestUpdateEvent {
  return event.itemType === 'turn_request_update';
}

function isHostStreamTurnRoundsUpdateEvent(event: HostStreamResponseItem): event is HostStreamTurnRoundsUpdateEvent {
  return event.itemType === 'turn_rounds_update';
}

function isHostStreamResponseIdentityUpdateEvent(event: HostStreamResponseItem): event is HostStreamResponseIdentityUpdateEvent {
  return event.itemType === 'response_identity_update';
}

function isHostStreamResponseProgressEvent(
  event: HostStreamResponseItem,
): event is HostStreamResponseReferenceEvent | HostStreamResponseCodeCitationEvent | HostStreamResponseProgressMessageEvent {
  return event.itemType === 'response_reference'
    || event.itemType === 'response_code_citation'
    || event.itemType === 'response_progress_message';
}

function isHostStreamResponseStatusUpdateEvent(event: HostStreamResponseItem): event is HostStreamResponseStatusUpdateEvent {
  return event.itemType === 'response_status_update';
}

function isHostStreamResponseFollowupsEvent(event: HostStreamResponseItem): event is HostStreamResponseFollowupsEvent {
  return event.itemType === 'response_followups';
}

function isHostStreamUsageEvent(event: HostStreamResponseItem): event is HostStreamUsageEvent {
  return event.itemType === 'usage';
}

function isHostStreamResponsePartUpdateEvent(event: HostStreamResponseItem): event is HostStreamResponsePartUpdateEvent {
  return event.itemType === 'response_part_update';
}

function resolveHostStreamPartIndex(event: HostStreamResponsePartUpdateEvent): number {
  return event.partIndex;
}

function cloneHostStreamUsedContext(
  value: TurnResponseTurn['response']['usedContext'] | null,
): TurnResponseTurn['response']['usedContext'] | null {
  return value
    ? {
      ...value,
      documents: value.documents.map(document => ({
        ...document,
        ranges: document.ranges.map(range => ({ ...range })),
      })),
    }
    : null;
}

function cloneHostStreamContentReferences(
  value: NonNullable<TurnResponseTurn['response']['contentReferences']>,
): NonNullable<TurnResponseTurn['response']['contentReferences']> {
  return value.map(reference => ({
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
  }));
}

function cloneHostStreamContentReference(
  value: NonNullable<TurnResponseTurn['response']['contentReferences']>[number],
): NonNullable<TurnResponseTurn['response']['contentReferences']>[number] {
  return cloneHostStreamContentReferences([value])[0];
}

function cloneHostStreamCodeCitations(
  value: NonNullable<TurnResponseTurn['response']['codeCitations']>,
): NonNullable<TurnResponseTurn['response']['codeCitations']> {
  return value.map(citation => ({ ...citation }));
}

function cloneHostStreamCodeCitation(
  value: NonNullable<TurnResponseTurn['response']['codeCitations']>[number],
): NonNullable<TurnResponseTurn['response']['codeCitations']>[number] {
  return cloneHostStreamCodeCitations([value])[0];
}

function cloneHostStreamProgressMessages(
  value: NonNullable<TurnResponseTurn['response']['progressMessages']>,
): NonNullable<TurnResponseTurn['response']['progressMessages']> {
  return value.map(message => ({ ...message }));
}

function cloneHostStreamProgressMessage(
  value: NonNullable<TurnResponseTurn['response']['progressMessages']>[number],
): NonNullable<TurnResponseTurn['response']['progressMessages']>[number] {
  return cloneHostStreamProgressMessages([value])[0];
}

function cloneHostStreamFollowups(
  value: readonly TurnResponseFollowup[] | undefined,
): readonly TurnResponseFollowup[] | undefined {
  return value?.map(followup => ({ ...followup }));
}

