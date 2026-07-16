import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import type { TurnResponseTurn } from 'aily-lex/browser';
import { ChatPartStore } from '../core/chat-part-store';
import {
  DEFAULT_CHAT_SESSION_TYPE,
  normalizeChatSelectedMode,
  normalizeChatSessionType,
  type ChatSelectedMode,
} from '../core/chat-mode';
import type { ChatRuntimeHostProtocolTruncation } from '../core/chat-runtime-host-contract';
import type { ChatSessionTitleSource } from '../core/chat-session-title';
import type { HostTurnResponseState } from '../helpers/host-turn-response-state';
import type { PendingFollowupRequest } from '../helpers/chat-pending-request';
import {
  canRedoSessionCheckpointTimeline,
  cloneSessionCheckpointTimelineState,
  createSessionCheckpointTimelineState,
  getSessionCheckpointHiddenTurnResponses,
  getSessionCheckpointVisibleTurnResponses,
  redoSessionCheckpointTimeline,
  restoreSessionCheckpointTimelineToCheckpoint,
  spliceSessionCheckpointTimelineForwardBranch,
  type SessionCheckpointTimelineState,
} from '../helpers/session-checkpoint-timeline-model';
import { commitSessionCheckpointForwardBranch } from '../helpers/session-checkpoint-branch-commit';
import {
  normalizeHostSessionProviderOptions,
  type HostSessionProviderOptions,
} from '../helpers/host-session-input-state';
import { turnResponsePartsToDisplayChatParts } from '../core/turn-response-part-mapper';
import {
  ChatSessionRuntimeStoreService,
  type ChatSessionRuntimeChangeOptions,
  type ChatSessionRuntimeState,
  type ChatSessionRuntimeStatePatch,
} from './chat-session-runtime-store.service';
import { buildSessionTurnOwnerDiagnostics } from '../helpers/session-turn-owner-diagnostics';

export type ChatSessionResource = string;

export interface ChatSessionTitleModelState {
  readonly text: string;
  readonly source: ChatSessionTitleSource;
  readonly revision?: number;
  readonly durable?: boolean;
}

export interface ChatSessionModelInputState {
  readonly providerOptions?: HostSessionProviderOptions;
  readonly selectedMode?: ChatSelectedMode;
  readonly draftText?: string;
}

export interface ChatSessionModelCreateProps {
  readonly sessionResource: ChatSessionResource;
  readonly title?: Partial<ChatSessionTitleModelState> | null;
  readonly projectPath?: string | null;
  readonly sessionType?: string | null;
  readonly inputState?: ChatSessionModelInputState | null;
  readonly turnResponses?: readonly TurnResponseTurn[] | null;
}

export interface ChatSessionModelMetadataPatch {
  readonly title?: Partial<ChatSessionTitleModelState> | null;
  readonly projectPath?: string | null;
  readonly sessionType?: string | null;
  readonly inputState?: ChatSessionModelInputState | null;
}

export interface ChatSessionTurnOwnerPolicyOptions {
  readonly allowForkedTurns?: boolean;
  readonly source?: string;
}

export interface ChatSessionRequestListTransactionResult {
  readonly kind:
    | 'commitRestoredCheckpointForwardBranch'
    | 'restoreCheckpoint'
    | 'rollbackCheckpointRestore'
    | 'redoCheckpoint'
    | 'rollbackCheckpointRedo'
    | 'forkPrefix'
    | 'removeFromTurn'
    | 'replaceAll'
    | 'appendCompletedTurn'
    | 'appendTransientTurn'
    | 'settleCheckpointMetadata';
  readonly sessionResource: ChatSessionResource;
  readonly revision: number;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly checkpointTimelineState: SessionCheckpointTimelineState;
  readonly discardedTurnResponses?: readonly TurnResponseTurn[];
  readonly retainedTurnIds: readonly string[];
  readonly discardedTurnIds?: readonly string[];
  readonly previousTurnResponses?: readonly TurnResponseTurn[];
  readonly previousCheckpointTimelineState?: SessionCheckpointTimelineState | null;
  readonly restoredTurnIds?: readonly string[];
  readonly forkBoundaryTurnId?: string;
  readonly removeFromTurnId?: string;
  readonly appendedTurnId?: string;
  readonly transient?: boolean;
  readonly checkpointId?: string;
  readonly protocolTruncation?: ChatRuntimeHostProtocolTruncation | null;
  readonly effects: ChatSessionRequestListTransactionEffects;
}

export interface ChatSessionRequestListTransactionEffects {
  readonly executionHost: {
    readonly hydrateTurnResponses: readonly TurnResponseTurn[];
    readonly protocolTruncation: ChatRuntimeHostProtocolTruncation | null;
  };
  readonly hostProjection: {
    readonly turnResponses: readonly TurnResponseTurn[];
  };
  readonly persistence: {
    readonly turnResponses: readonly TurnResponseTurn[];
  };
}

export interface ChatSessionPreparedRedoTransaction {
  readonly kind: 'redoCheckpoint';
  readonly sessionResource: ChatSessionResource;
  readonly turnResponses: readonly TurnResponseTurn[];
  readonly checkpointTimelineState: SessionCheckpointTimelineState;
  readonly previousTurnResponses: readonly TurnResponseTurn[];
  readonly previousCheckpointTimelineState: SessionCheckpointTimelineState;
  readonly retainedTurnIds: readonly string[];
  readonly restoredTurnIds: readonly string[];
}

interface ChatSessionTurnResponseMutationOptions {
  readonly syncPartStore?: boolean;
}

function withRequestListTransactionEffects(
  result: Omit<ChatSessionRequestListTransactionResult, 'effects'>,
): ChatSessionRequestListTransactionResult {
  return {
    ...result,
    effects: {
      executionHost: {
        hydrateTurnResponses: result.turnResponses,
        protocolTruncation: result.protocolTruncation ?? null,
      },
      hostProjection: {
        turnResponses: result.turnResponses,
      },
      persistence: {
        turnResponses: result.turnResponses,
      },
    },
  };
}

export type ChatSessionModelStoreChangeKind = 'created' | 'updated' | 'disposed';
export type ChatSessionModelStoreChangeReason =
  | ChatSessionRequestListTransactionResult['kind']
  | 'metadata'
  | 'inputDraft'
  | 'projection'
  | 'turnDelta';

export interface ChatSessionModelStoreChangedEvent {
  readonly sessionResource: ChatSessionResource;
  readonly kind: ChatSessionModelStoreChangeKind;
  readonly reason?: ChatSessionModelStoreChangeReason;
}

export interface ChatSessionModelReference {
  readonly object: ChatSessionModel;
  dispose(): void;
}

export function normalizeChatSessionResource(value: string | null | undefined): ChatSessionResource {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTitleState(value?: Partial<ChatSessionTitleModelState> | null): ChatSessionTitleModelState {
  const text = typeof value?.text === 'string' ? value.text : '';
  return {
    text,
    source: value?.source ?? (text ? 'default-first-request' : 'empty'),
    ...(typeof value?.revision === 'number' ? { revision: value.revision } : {}),
    ...(typeof value?.durable === 'boolean' ? { durable: value.durable } : {}),
  };
}

function normalizeProjectPath(value?: string | null): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeInputState(value?: ChatSessionModelInputState | null): ChatSessionModelInputState {
  return {
    ...(value?.providerOptions
      ? { providerOptions: normalizeHostSessionProviderOptions(value.providerOptions) }
      : {}),
    ...(value?.selectedMode
      ? { selectedMode: normalizeChatSelectedMode(value.selectedMode) }
      : {}),
    ...(typeof value?.draftText === 'string'
      ? { draftText: value.draftText }
      : {}),
  };
}

export class ChatSessionModel {
  private titleState: ChatSessionTitleModelState;
  private projectPathState: string | null;
  private sessionTypeState: string;
  private inputStateValue: ChatSessionModelInputState;
  private turnResponsesValue: TurnResponseTurn[] = [];
  private requestListRevisionValue = 0;
  private pendingFollowupQueue: PendingFollowupRequest[] = [];
  private checkpointTimelineState: SessionCheckpointTimelineState | null = null;

  constructor(
    private readonly runtimeStore: ChatSessionRuntimeStoreService,
    props: ChatSessionModelCreateProps,
  ) {
    this.sessionResource = normalizeChatSessionResource(props.sessionResource);
    if (!this.sessionResource) {
      throw new Error('ChatSessionModel requires a sessionResource');
    }

    this.titleState = normalizeTitleState(props.title);
    this.projectPathState = normalizeProjectPath(props.projectPath);
    this.sessionTypeState = normalizeChatSessionType(props.sessionType, DEFAULT_CHAT_SESSION_TYPE);
    this.inputStateValue = normalizeInputState(props.inputState);
    this.turnResponsesValue = cloneTurnResponses(props.turnResponses);
    this.syncCanonicalResponsePartStore(this.turnResponsesValue);
  }

  readonly sessionResource: ChatSessionResource;
  readonly partStore = new ChatPartStore();

  get sessionId(): string {
    return this.sessionResource;
  }

  get title(): ChatSessionTitleModelState {
    return { ...this.titleState };
  }

  get projectPath(): string | null {
    return this.projectPathState;
  }

  get sessionType(): string {
    return this.sessionTypeState;
  }

  get inputState(): ChatSessionModelInputState {
    return {
      ...(this.inputStateValue.providerOptions
        ? { providerOptions: normalizeHostSessionProviderOptions(this.inputStateValue.providerOptions) }
        : {}),
      ...(this.inputStateValue.selectedMode
        ? { selectedMode: normalizeChatSelectedMode(this.inputStateValue.selectedMode) }
        : {}),
      ...(typeof this.inputStateValue.draftText === 'string'
        ? { draftText: this.inputStateValue.draftText }
        : {}),
    };
  }

  get runtimeState(): ChatSessionRuntimeState | undefined {
    return this.runtimeStore.read(this.sessionResource);
  }

  get turnResponses(): readonly TurnResponseTurn[] {
    return this.getTurnResponses();
  }

  get requestListRevision(): number {
    return this.requestListRevisionValue;
  }

  get hostProjectionState(): HostTurnResponseState | null {
    return this.runtimeState?.hostProjectionState ?? null;
  }

  getTurnResponses(): readonly TurnResponseTurn[] {
    return cloneTurnResponses(this.turnResponsesValue);
  }

  /**
   * Hot-path read-only view for host projection. This intentionally preserves
   * array identity so projection caches can behave like VS Code's service-owned
   * response model instead of rebuilding from cloned transcripts on every read.
   */
  peekTurnResponsesForProjection(): readonly TurnResponseTurn[] {
    return this.turnResponsesValue;
  }

  replaceTurnResponses(turnResponses: readonly TurnResponseTurn[] | null | undefined): readonly TurnResponseTurn[] {
    const previousTurnIds = this.turnResponsesValue.map(turn => turn.turnId);
    const existingTurnsById = new Map(this.turnResponsesValue.map(turn => [turn.turnId, turn]));
    const existingTurnsByRequestId = buildRequestIdTurnMap(this.turnResponsesValue);
    this.turnResponsesValue = Array.isArray(turnResponses)
      ? coalesceTurnResponsesByRequestId(turnResponses.map(turnResponse => mergeTurnResponseWithExistingRequest(
        existingTurnsById.get(turnResponse.turnId)
          ?? existingTurnsByRequestId.get(readTurnResponseRequestId(turnResponse) ?? ''),
        turnResponse,
      )))
      : [];
    this.syncCanonicalResponsePartStore(this.turnResponsesValue, previousTurnIds);
    this.syncCheckpointTimelineWithCanonicalTurnResponses();
    this.bumpRequestListRevision();
    return this.getTurnResponses();
  }

  replaceAllTurnResponsesTransaction(
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    if (!Array.isArray(turnResponses)) {
      return null;
    }

    const previousTurnResponses = cloneTurnResponses(this.turnResponsesValue);
    const previousCheckpointTimelineState = this.getCheckpointTimelineState();
    const nextTurnResponses = this.replaceTurnResponses(turnResponses);
    const checkpointTimelineState = this.getCheckpointTimelineState()
      ?? createSessionCheckpointTimelineState({
        sessionResource: this.sessionResource,
        turnResponses: nextTurnResponses,
      });
    const retainedTurnIds = nextTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);
    const retainedTurnIdSet = new Set(retainedTurnIds);
    const discardedTurnResponses = cloneTurnResponses(previousTurnResponses.filter(turn => {
      const turnId = normalizeChatSessionResource(turn.turnId);
      return turnId.length > 0 && !retainedTurnIdSet.has(turnId);
    }));
    const discardedTurnIds = discardedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);

    return withRequestListTransactionEffects({
      kind: 'replaceAll',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds,
      discardedTurnResponses,
      discardedTurnIds,
    });
  }

  appendOrReplaceTurnResponse(
    turnResponse: TurnResponseTurn,
    options?: ChatSessionTurnResponseMutationOptions,
  ): readonly TurnResponseTurn[] {
    const existingIndex = this.turnResponsesValue.findIndex(turn => turn.turnId === turnResponse.turnId);
    const requestId = readTurnResponseRequestId(turnResponse);
    const existingRequestIndex = existingIndex < 0 && requestId
      ? this.turnResponsesValue.findIndex(turn => readTurnResponseRequestId(turn) === requestId)
      : -1;
    const targetIndex = existingIndex >= 0 ? existingIndex : existingRequestIndex;
    const clonedTurnResponse = mergeTurnResponseWithExistingRequest(
      targetIndex >= 0 ? this.turnResponsesValue[targetIndex] : undefined,
      turnResponse,
    );
    if (targetIndex >= 0) {
      const previousTurnId = this.turnResponsesValue[targetIndex]?.turnId;
      this.turnResponsesValue.splice(targetIndex, 1, clonedTurnResponse);
      const clearTurnIds = previousTurnId && previousTurnId !== clonedTurnResponse.turnId
        ? [previousTurnId]
        : [];
      if (options?.syncPartStore !== false) {
        this.syncCanonicalResponsePartStore([clonedTurnResponse], clearTurnIds);
      }
    } else {
      this.turnResponsesValue.push(clonedTurnResponse);
      if (options?.syncPartStore !== false) {
        this.syncCanonicalResponsePartStore([clonedTurnResponse]);
      }
    }
    this.syncCheckpointTimelineWithCanonicalTurnResponses();
    this.bumpRequestListRevision();
    return this.getTurnResponses();
  }

  appendTurnTransaction(
    turnResponse: TurnResponseTurn | null | undefined,
    kind: 'appendCompletedTurn' | 'appendTransientTurn',
  ): ChatSessionRequestListTransactionResult | null {
    if (!turnResponse) {
      return null;
    }

    const previousTurnResponses = cloneTurnResponses(this.turnResponsesValue);
    const previousCheckpointTimelineState = this.getCheckpointTimelineState();
    const nextTurnResponses = this.appendOrReplaceTurnResponse(turnResponse, {
      syncPartStore: kind !== 'appendTransientTurn',
    });
    if (kind === 'appendTransientTurn') {
      this.upsertTurnResponseParts(turnResponse.turnId, turnResponse.response?.parts);
    }
    const checkpointTimelineState = this.getCheckpointTimelineState()
      ?? createSessionCheckpointTimelineState({
        sessionResource: this.sessionResource,
        turnResponses: nextTurnResponses,
      });
    const appendedTurnId = normalizeChatSessionResource(turnResponse.turnId);

    return withRequestListTransactionEffects({
      kind,
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds: nextTurnResponses
        .map(turn => normalizeChatSessionResource(turn.turnId))
        .filter((candidate): candidate is string => candidate.length > 0),
      discardedTurnIds: [],
      ...(appendedTurnId ? { appendedTurnId } : {}),
      transient: kind === 'appendTransientTurn',
    });
  }

  settleCheckpointMetadataTransaction(
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    checkpointTimelineState: SessionCheckpointTimelineState | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    if (!Array.isArray(turnResponses)) {
      return null;
    }

    const previousTurnResponses = cloneTurnResponses(this.turnResponsesValue);
    const previousCheckpointTimelineState = this.getCheckpointTimelineState();
    const nextTurnResponses = this.replaceTurnResponses(turnResponses);
    const nextCheckpointTimelineState = cloneSessionCheckpointTimelineState(checkpointTimelineState);
    this.checkpointTimelineState = nextCheckpointTimelineState?.sessionResource === this.sessionResource
      ? nextCheckpointTimelineState
      : createSessionCheckpointTimelineState({
        sessionResource: this.sessionResource,
        turnResponses: nextTurnResponses,
      });
    const committedCheckpointTimelineState = this.getCheckpointTimelineState()
      ?? createSessionCheckpointTimelineState({
        sessionResource: this.sessionResource,
        turnResponses: nextTurnResponses,
      });
    const retainedTurnIds = nextTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);
    const retainedTurnIdSet = new Set(retainedTurnIds);
    const discardedTurnResponses = cloneTurnResponses(previousTurnResponses.filter(turn => {
      const turnId = normalizeChatSessionResource(turn.turnId);
      return turnId.length > 0 && !retainedTurnIdSet.has(turnId);
    }));

    return withRequestListTransactionEffects({
      kind: 'settleCheckpointMetadata',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState: committedCheckpointTimelineState,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds,
      discardedTurnResponses,
      discardedTurnIds: discardedTurnResponses
        .map(turn => normalizeChatSessionResource(turn.turnId))
        .filter((candidate): candidate is string => candidate.length > 0),
    });
  }

  upsertTurnResponseParts(
    turnId: string | null | undefined,
    parts: TurnResponseTurn['response']['parts'] | null | undefined,
  ): boolean {
    const normalizedTurnId = normalizeChatSessionResource(turnId);
    if (!normalizedTurnId || !Array.isArray(parts) || parts.length === 0) {
      return false;
    }

    let changed = false;
    for (const part of turnResponsePartsToChatParts(parts)) {
      changed = this.partStore.upsertPartForResponse(normalizedTurnId, part) || changed;
    }
    return changed;
  }

  removeTurnResponsesAfter(turnId: string | null | undefined): readonly TurnResponseTurn[] {
    const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
    if (!normalizedTurnId) {
      return this.getTurnResponses();
    }

    const turnIndex = this.turnResponsesValue.findIndex(turn => turn.turnId === normalizedTurnId);
    if (turnIndex < 0) {
      return this.getTurnResponses();
    }

    const removedTurnIds = this.turnResponsesValue.slice(turnIndex + 1).map(turn => turn.turnId);
    this.turnResponsesValue = this.turnResponsesValue.slice(0, turnIndex + 1);
    this.syncCanonicalResponsePartStore(this.turnResponsesValue.slice(turnIndex), removedTurnIds);
    this.syncCheckpointTimelineWithCanonicalTurnResponses();
    this.bumpRequestListRevision();
    return this.getTurnResponses();
  }

  getCheckpointTimelineState(): SessionCheckpointTimelineState | null {
    return cloneSessionCheckpointTimelineState(this.checkpointTimelineState);
  }

  replaceCheckpointTimelineState(state: SessionCheckpointTimelineState | null | undefined): void {
    const clonedState = cloneSessionCheckpointTimelineState(state);
    this.checkpointTimelineState = clonedState && clonedState.sessionResource === this.sessionResource
      ? clonedState
      : null;
  }

  clearCheckpointTimelineState(): void {
    this.checkpointTimelineState = null;
  }

  canRedoCheckpointTimeline(): boolean {
    return canRedoSessionCheckpointTimeline(this.checkpointTimelineState);
  }

  getDisabledCheckpointTurnIds(): readonly string[] {
    return getSessionCheckpointHiddenTurnResponses(this.checkpointTimelineState)
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);
  }

  spliceCheckpointTimelineForwardBranch(): SessionCheckpointTimelineState | null {
    if (!this.checkpointTimelineState) {
      return null;
    }

    this.checkpointTimelineState = spliceSessionCheckpointTimelineForwardBranch(this.checkpointTimelineState);
    return this.getCheckpointTimelineState();
  }

  commitRestoredCheckpointForwardBranch(): ChatSessionRequestListTransactionResult | null {
    const committedBranch = commitSessionCheckpointForwardBranch(this.checkpointTimelineState);
    if (!committedBranch) {
      return null;
    }

    const nextTurnResponses = this.replaceTurnResponses(committedBranch.turnResponses);
    this.checkpointTimelineState = cloneSessionCheckpointTimelineState(committedBranch.checkpointTimelineState);
    const checkpointTimelineState = this.getCheckpointTimelineState();
    if (!checkpointTimelineState) {
      return null;
    }
    const retainedTurnIds = nextTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);
    const discardedTurnIds = committedBranch.discardedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);

    return withRequestListTransactionEffects({
      kind: 'commitRestoredCheckpointForwardBranch',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      discardedTurnResponses: cloneTurnResponses(committedBranch.discardedTurnResponses),
      retainedTurnIds,
      discardedTurnIds,
      protocolTruncation: buildRequestListProtocolTruncation(retainedTurnIds, discardedTurnIds),
    });
  }

  commitCheckpointRestoreTransaction(
    checkpointId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const normalizedCheckpointId = normalizeChatSessionResource(checkpointId);
    if (!normalizedCheckpointId) {
      return null;
    }

    const previousTurnResponses = cloneTurnResponses(this.turnResponsesValue);
    const previousCheckpointTimelineState = this.getCheckpointTimelineState();
    const fullTimelineState = createSessionCheckpointTimelineState({
      sessionResource: this.sessionResource,
      turnResponses: previousTurnResponses,
    });
    const checkpointTimelineState = restoreSessionCheckpointTimelineToCheckpoint(
      fullTimelineState,
      normalizedCheckpointId,
    );
    if (!checkpointTimelineState) {
      return null;
    }

    const retainedTurnResponses = getSessionCheckpointVisibleTurnResponses(checkpointTimelineState);
    const nextTurnResponses = this.replaceTurnResponses(retainedTurnResponses);
    this.checkpointTimelineState = cloneSessionCheckpointTimelineState(checkpointTimelineState);
    const committedCheckpointTimelineState = this.getCheckpointTimelineState();
    if (!committedCheckpointTimelineState) {
      return null;
    }

    const retainedTurnIds = nextTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);
    const retainedTurnIdSet = new Set(retainedTurnIds);
    const discardedTurnResponses = cloneTurnResponses(previousTurnResponses.filter(turn => {
      const turnId = normalizeChatSessionResource(turn.turnId);
      return !turnId || !retainedTurnIdSet.has(turnId);
    }));
    const discardedTurnIds = discardedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);

    return withRequestListTransactionEffects({
      kind: 'restoreCheckpoint',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      checkpointId: normalizedCheckpointId,
      turnResponses: nextTurnResponses,
      checkpointTimelineState: committedCheckpointTimelineState,
      discardedTurnResponses,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds,
      discardedTurnIds,
      protocolTruncation: buildRequestListProtocolTruncation(retainedTurnIds, discardedTurnIds),
    });
  }

  rollbackCheckpointRestoreTransaction(
    committed: ChatSessionRequestListTransactionResult | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    if (
      !committed
      || committed.sessionResource !== this.sessionResource
      || committed.kind !== 'restoreCheckpoint'
      || !committed.previousTurnResponses
    ) {
      return null;
    }

    const nextTurnResponses = this.replaceTurnResponses(committed.previousTurnResponses);
    this.checkpointTimelineState = cloneSessionCheckpointTimelineState(
      committed.previousCheckpointTimelineState ?? null,
    ) ?? createSessionCheckpointTimelineState({
      sessionResource: this.sessionResource,
      turnResponses: nextTurnResponses,
    });
    const checkpointTimelineState = this.getCheckpointTimelineState();
    if (!checkpointTimelineState) {
      return null;
    }

    return withRequestListTransactionEffects({
      kind: 'rollbackCheckpointRestore',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      checkpointId: committed.checkpointId,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      previousTurnResponses: cloneTurnResponses(committed.turnResponses),
      previousCheckpointTimelineState: cloneSessionCheckpointTimelineState(committed.checkpointTimelineState),
      retainedTurnIds: nextTurnResponses
        .map(turn => normalizeChatSessionResource(turn.turnId))
        .filter((turnId): turnId is string => turnId.length > 0),
      discardedTurnIds: [],
    });
  }

  prepareCheckpointRedoTransaction(): ChatSessionPreparedRedoTransaction | null {
    if (!canRedoSessionCheckpointTimeline(this.checkpointTimelineState)) {
      return null;
    }

    const previousCheckpointTimelineState = cloneSessionCheckpointTimelineState(this.checkpointTimelineState);
    if (!previousCheckpointTimelineState) {
      return null;
    }

    const checkpointTimelineState = redoSessionCheckpointTimeline(previousCheckpointTimelineState);
    const turnResponses = getSessionCheckpointVisibleTurnResponses(checkpointTimelineState);
    const previousTurnResponses = getSessionCheckpointVisibleTurnResponses(previousCheckpointTimelineState);
    const previousTurnIds = previousTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);
    const nextTurnIds = turnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((turnId): turnId is string => turnId.length > 0);

    return {
      kind: 'redoCheckpoint',
      sessionResource: this.sessionResource,
      turnResponses,
      checkpointTimelineState,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds: nextTurnIds,
      restoredTurnIds: nextTurnIds.filter(turnId => !previousTurnIds.includes(turnId)),
    };
  }

  commitCheckpointRedoTransaction(
    prepared: ChatSessionPreparedRedoTransaction | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    if (!prepared || prepared.sessionResource !== this.sessionResource) {
      return null;
    }

    const nextTurnResponses = this.replaceTurnResponses(prepared.turnResponses);
    this.checkpointTimelineState = cloneSessionCheckpointTimelineState(prepared.checkpointTimelineState);
    const checkpointTimelineState = this.getCheckpointTimelineState();
    if (!checkpointTimelineState) {
      return null;
    }

    return withRequestListTransactionEffects({
      kind: 'redoCheckpoint',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      previousTurnResponses: cloneTurnResponses(prepared.previousTurnResponses),
      previousCheckpointTimelineState: cloneSessionCheckpointTimelineState(prepared.previousCheckpointTimelineState),
      retainedTurnIds: nextTurnResponses
        .map(turn => normalizeChatSessionResource(turn.turnId))
        .filter((turnId): turnId is string => turnId.length > 0),
      restoredTurnIds: prepared.restoredTurnIds,
    });
  }

  rollbackCheckpointRedoTransaction(
    prepared: ChatSessionPreparedRedoTransaction | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    if (!prepared || prepared.sessionResource !== this.sessionResource) {
      return null;
    }

    const nextTurnResponses = this.replaceTurnResponses(prepared.previousTurnResponses);
    this.checkpointTimelineState = cloneSessionCheckpointTimelineState(prepared.previousCheckpointTimelineState);
    const checkpointTimelineState = this.getCheckpointTimelineState();
    if (!checkpointTimelineState) {
      return null;
    }

    return withRequestListTransactionEffects({
      kind: 'rollbackCheckpointRedo',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState,
      previousTurnResponses: cloneTurnResponses(prepared.turnResponses),
      previousCheckpointTimelineState: cloneSessionCheckpointTimelineState(prepared.checkpointTimelineState),
      retainedTurnIds: nextTurnResponses
        .map(turn => normalizeChatSessionResource(turn.turnId))
        .filter((turnId): turnId is string => turnId.length > 0),
      restoredTurnIds: [],
    });
  }

  removeFromTurnTransaction(
    turnId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const targetTurnId = normalizeChatSessionResource(turnId);
    if (!targetTurnId) {
      return null;
    }

    const previousTurnResponses = cloneTurnResponses(this.turnResponsesValue);
    const previousCheckpointTimelineState = this.getCheckpointTimelineState();
    const checkpointTimelineState = this.getCheckpointTimelineState();
    const canonicalTurnResponses = checkpointTimelineState
      ? getSessionCheckpointVisibleTurnResponses(checkpointTimelineState)
      : previousTurnResponses;
    const targetIndex = canonicalTurnResponses.findIndex(turn =>
      normalizeChatSessionResource(turn.turnId) === targetTurnId
    );
    if (targetIndex < 0) {
      return null;
    }

    const retainedTurnResponses = canonicalTurnResponses.slice(0, targetIndex);
    const discardedTurnResponses = cloneTurnResponses(canonicalTurnResponses.slice(targetIndex));
    const nextTurnResponses = this.replaceTurnResponses(retainedTurnResponses);
    const committedCheckpointTimelineState = this.getCheckpointTimelineState()
      ?? createSessionCheckpointTimelineState({
        sessionResource: this.sessionResource,
        turnResponses: nextTurnResponses,
      });
    const retainedTurnIds = nextTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);
    const discardedTurnIds = discardedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);

    return withRequestListTransactionEffects({
      kind: 'removeFromTurn',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: nextTurnResponses,
      checkpointTimelineState: committedCheckpointTimelineState,
      discardedTurnResponses,
      previousTurnResponses,
      previousCheckpointTimelineState,
      retainedTurnIds,
      discardedTurnIds,
      removeFromTurnId: targetTurnId,
      protocolTruncation: buildRequestListProtocolTruncation(retainedTurnIds, discardedTurnIds, targetTurnId),
    });
  }

  prepareForkPrefixBeforeTurn(
    turnId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const boundaryTurnId = normalizeChatSessionResource(turnId);
    if (!boundaryTurnId) {
      return null;
    }

    const checkpointTimelineState = this.getCheckpointTimelineState();
    if (!checkpointTimelineState) {
      return null;
    }

    const canonicalVisibleTurnResponses = getSessionCheckpointVisibleTurnResponses(checkpointTimelineState);
    const boundaryIndex = canonicalVisibleTurnResponses.findIndex(turn =>
      normalizeChatSessionResource(turn.turnId) === boundaryTurnId
    );
    if (boundaryIndex < 0) {
      return null;
    }

    const retainedTurnResponses = cloneTurnResponses(canonicalVisibleTurnResponses.slice(0, boundaryIndex));
    const discardedTurnResponses = cloneTurnResponses(canonicalVisibleTurnResponses.slice(boundaryIndex));
    const retainedTurnIds = retainedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);
    const discardedTurnIds = discardedTurnResponses
      .map(turn => normalizeChatSessionResource(turn.turnId))
      .filter((candidate): candidate is string => candidate.length > 0);

    return withRequestListTransactionEffects({
      kind: 'forkPrefix',
      sessionResource: this.sessionResource,
      revision: this.requestListRevision,
      turnResponses: retainedTurnResponses,
      checkpointTimelineState,
      discardedTurnResponses,
      retainedTurnIds,
      discardedTurnIds,
      forkBoundaryTurnId: boundaryTurnId,
    });
  }

  getPendingFollowupRequests(): readonly PendingFollowupRequest[] {
    return this.pendingFollowupQueue.map(request => clonePendingFollowupRequest(request));
  }

  replacePendingFollowupRequests(requests: readonly PendingFollowupRequest[] | null | undefined): readonly PendingFollowupRequest[] {
    this.pendingFollowupQueue = Array.isArray(requests)
      ? requests.map(request => clonePendingFollowupRequest(request))
      : [];
    return this.getPendingFollowupRequests();
  }

  enqueuePendingFollowupRequest(request: PendingFollowupRequest): readonly PendingFollowupRequest[] {
    const nextRequest = clonePendingFollowupRequest(request);
    if (nextRequest.kind === 'steering') {
      let insertIndex = 0;
      for (let index = 0; index < this.pendingFollowupQueue.length; index += 1) {
        if (this.pendingFollowupQueue[index].kind === 'steering') {
          insertIndex = index + 1;
        } else {
          break;
        }
      }
      this.pendingFollowupQueue.splice(insertIndex, 0, nextRequest);
    } else {
      this.pendingFollowupQueue.push(nextRequest);
    }

    return this.getPendingFollowupRequests();
  }

  removePendingFollowupRequest(requestId: string | null | undefined): boolean {
    const normalizedRequestId = typeof requestId === 'string' ? requestId.trim() : '';
    if (!normalizedRequestId || this.pendingFollowupQueue.length === 0) {
      return false;
    }

    const nextQueue = this.pendingFollowupQueue.filter(request => request.id !== normalizedRequestId);
    if (nextQueue.length === this.pendingFollowupQueue.length) {
      return false;
    }

    this.pendingFollowupQueue = nextQueue;
    return true;
  }

  clearPendingFollowupRequests(): void {
    this.pendingFollowupQueue = [];
  }

  updateMetadata(patch: ChatSessionModelMetadataPatch): void {
    if (patch.title !== undefined) {
      this.titleState = normalizeTitleState({
        ...this.titleState,
        ...(patch.title ?? {}),
      });
    }

    if (patch.projectPath !== undefined) {
      this.projectPathState = normalizeProjectPath(patch.projectPath);
    }

    if (patch.sessionType !== undefined) {
      this.sessionTypeState = normalizeChatSessionType(patch.sessionType, DEFAULT_CHAT_SESSION_TYPE);
    }

    if (patch.inputState !== undefined) {
      this.inputStateValue = normalizeInputState({
        ...this.inputStateValue,
        ...(patch.inputState ?? {}),
      });
    }
  }

  applyRuntimeState(
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    const nextState = this.resolveRuntimeStatePatchForModel(state);
    this.runtimeStore.replaceRuntimeState(this.sessionResource, nextState, options);
  }

  private resolveRuntimeStatePatchForModel(state: ChatSessionRuntimeStatePatch): ChatSessionRuntimeStatePatch {
    if (state.turnResponses === undefined) {
      return state;
    }

    const incomingTurnResponses = Array.isArray(state.turnResponses)
      ? state.turnResponses
      : [];
    if (incomingTurnResponses.length > 0 || this.turnResponsesValue.length === 0) {
      return {
        ...state,
        turnResponses: this.replaceTurnResponses(incomingTurnResponses),
      };
    }

    const existingRuntimeState = this.runtimeStore.read(this.sessionResource);
    return {
      ...state,
      // Runtime/projection mirrors can transiently report an empty transcript while
      // a request is starting. The session model is the canonical transcript owner,
      // so empty mirrors must not erase already accepted user turns.
      turnResponses: this.getTurnResponses(),
      ...(state.hostProjectionState === null && existingRuntimeState?.hostProjectionState
        ? { hostProjectionState: existingRuntimeState.hostProjectionState }
        : {}),
    };
  }

  applyProjection(
    state: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): void {
    this.runtimeStore.replaceRuntimeState(this.sessionResource, {
      hostProjectionState: state,
    }, options);
  }

  dispose(): void {
    this.turnResponsesValue = [];
    this.pendingFollowupQueue = [];
    this.checkpointTimelineState = null;
    this.partStore.destroy();
  }

  private syncCanonicalResponsePartStore(
    turns: readonly TurnResponseTurn[],
    clearTurnIds: readonly string[] = [],
  ): void {
    const turnIdsToClear = new Set<string>();
    for (const turnId of clearTurnIds) {
      const normalizedTurnId = normalizeChatSessionResource(turnId);
      if (normalizedTurnId) {
        turnIdsToClear.add(normalizedTurnId);
      }
    }
    for (const turn of turns) {
      const normalizedTurnId = normalizeChatSessionResource(turn.turnId);
      if (normalizedTurnId) {
        turnIdsToClear.add(normalizedTurnId);
      }
    }

    for (const turnId of turnIdsToClear) {
      const turn = turns.find(candidate => normalizeChatSessionResource(candidate.turnId) === turnId);
      this.partStore.replacePartsForResponse(turnId, turnResponsePartsToChatParts(turn?.response?.parts));
    }
  }

  private syncCheckpointTimelineWithCanonicalTurnResponses(): void {
    if (
      canRedoSessionCheckpointTimeline(this.checkpointTimelineState)
      && isCanonicalCheckpointTimelinePrefix(this.checkpointTimelineState, this.turnResponsesValue)
    ) {
      return;
    }

    const nextTimeline = createSessionCheckpointTimelineState({
      sessionResource: this.sessionResource,
      turnResponses: this.turnResponsesValue,
    });
    this.checkpointTimelineState = nextTimeline.checkpoints.length > 0
      ? nextTimeline
      : null;
  }

  private bumpRequestListRevision(): void {
    this.requestListRevisionValue += 1;
  }
}

export interface ChatSessionModelAcquireOptions {
  readonly suppressCreatedEvent?: boolean;
}

function cloneTurnResponses(turnResponses: readonly TurnResponseTurn[] | null | undefined): TurnResponseTurn[] {
  return Array.isArray(turnResponses)
    ? turnResponses.map(turnResponse => cloneTurnResponse(turnResponse))
    : [];
}

function cloneTurnResponse(turnResponse: TurnResponseTurn): TurnResponseTurn {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(turnResponse) as TurnResponseTurn;
  }

  return JSON.parse(JSON.stringify(turnResponse)) as TurnResponseTurn;
}

function turnResponsePartsToChatParts(
  parts: TurnResponseTurn['response']['parts'] | null | undefined,
) {
  return turnResponsePartsToDisplayChatParts(parts);
}

function buildRequestListProtocolTruncation(
  retainedTurnIds: readonly string[],
  discardedTurnIds: readonly string[],
  preferredRemoveFromTurnId?: string | null,
): ChatRuntimeHostProtocolTruncation | null {
  const normalizedRetainedTurnIds = retainedTurnIds
    .map(turnId => normalizeChatSessionResource(turnId))
    .filter((turnId): turnId is string => turnId.length > 0);
  const normalizedDiscardedTurnIds = discardedTurnIds
    .map(turnId => normalizeChatSessionResource(turnId))
    .filter((turnId): turnId is string => turnId.length > 0);
  const removeFromTurnId = normalizeChatSessionResource(preferredRemoveFromTurnId)
    || normalizedDiscardedTurnIds[0]
    || '';
  if (removeFromTurnId) {
    return {
      kind: 'removeFrom',
      turnId: removeFromTurnId,
      retainedTurnIds: normalizedRetainedTurnIds,
      discardedTurnIds: normalizedDiscardedTurnIds,
    };
  }

  if (normalizedRetainedTurnIds.length === 0 && normalizedDiscardedTurnIds.length > 0) {
    return {
      kind: 'clear',
      retainedTurnIds: normalizedRetainedTurnIds,
      discardedTurnIds: normalizedDiscardedTurnIds,
    };
  }

  return null;
}

function isCanonicalCheckpointTimelinePrefix(
  state: SessionCheckpointTimelineState | null,
  turnResponses: readonly TurnResponseTurn[],
): boolean {
  if (!state) {
    return false;
  }

  if (turnResponses.length > state.turnResponses.length) {
    if (
      isTurnResponseIdPrefix(turnResponses, state.turnResponses)
      && turnResponses.slice(state.turnResponses.length).every(isUncheckpointedTransientTurnResponse)
    ) {
      return true;
    }

    const visibleTurnResponses = getSessionCheckpointVisibleTurnResponses(state);
    return isTurnResponseIdPrefix(turnResponses, visibleTurnResponses)
      && turnResponses.slice(visibleTurnResponses.length).every(isUncheckpointedTransientTurnResponse);
  }

  if (isTurnResponseIdPrefix(state.turnResponses, turnResponses)) {
    return true;
  }

  const visibleTurnResponses = getSessionCheckpointVisibleTurnResponses(state);
  return isTurnResponseIdPrefix(turnResponses, visibleTurnResponses)
    && turnResponses.slice(visibleTurnResponses.length).every(isUncheckpointedTransientTurnResponse);
}

function isTurnResponseIdPrefix(
  turnResponses: readonly TurnResponseTurn[],
  prefixTurnResponses: readonly TurnResponseTurn[],
): boolean {
  if (prefixTurnResponses.length > turnResponses.length) {
    return false;
  }
  return prefixTurnResponses.every((turnResponse, index) => {
    const canonicalTurnId = normalizeChatSessionResource(turnResponse.turnId);
    const candidateTurnId = normalizeChatSessionResource(turnResponses[index]?.turnId);
    return canonicalTurnId.length > 0 && canonicalTurnId === candidateTurnId;
  });
}

function isUncheckpointedTransientTurnResponse(turnResponse: TurnResponseTurn): boolean {
  const metadata = turnResponse?.request && typeof turnResponse.request === 'object'
    ? (turnResponse.request as { metadata?: Record<string, unknown> }).metadata
    : undefined;
  const checkpointId = typeof metadata?.['checkpointId'] === 'string'
    ? metadata['checkpointId'].trim()
    : '';
  return checkpointId.length === 0;
}

function mergeTurnResponseWithExistingRequest(
  existingTurn: TurnResponseTurn | undefined,
  nextTurn: TurnResponseTurn,
): TurnResponseTurn {
  const clonedNextTurn = cloneTurnResponse(nextTurn);
  if (!existingTurn?.request) {
    return clonedNextTurn;
  }

  const existingRequest = existingTurn.request;
  const nextRequest = clonedNextTurn.request;
  if (!nextRequest) {
    return {
      ...clonedNextTurn,
      request: cloneTurnRequest(existingRequest),
    };
  }

  const shouldPreserveContent = isBlankRequestText(nextRequest.content)
    && !isBlankRequestText(existingRequest.content);
  const shouldPreserveDisplayContent = isBlankRequestText(nextRequest.displayContent)
    && !isBlankRequestText(existingRequest.displayContent);
  const mergedMetadata = mergeRequestMetadata(existingRequest.metadata, nextRequest.metadata);
  const shouldPreserveMetadata = mergedMetadata !== nextRequest.metadata;

  if (!shouldPreserveContent && !shouldPreserveDisplayContent && !shouldPreserveMetadata) {
    return clonedNextTurn;
  }

  return {
    ...clonedNextTurn,
    request: {
      ...nextRequest,
      ...(shouldPreserveContent ? { content: existingRequest.content } : {}),
      ...(shouldPreserveDisplayContent ? { displayContent: existingRequest.displayContent } : {}),
      ...(shouldPreserveMetadata ? { metadata: mergedMetadata } : {}),
    },
  };
}

function coalesceTurnResponsesByRequestId(turnResponses: readonly TurnResponseTurn[]): TurnResponseTurn[] {
  const coalesced: TurnResponseTurn[] = [];
  const indexesByRequestId = new Map<string, number>();
  for (const turn of turnResponses) {
    const requestId = readTurnResponseRequestId(turn);
    const existingIndex = requestId ? indexesByRequestId.get(requestId) : undefined;
    if (existingIndex === undefined) {
      if (requestId) {
        indexesByRequestId.set(requestId, coalesced.length);
      }
      coalesced.push(turn);
      continue;
    }

    coalesced[existingIndex] = mergeTurnResponseWithExistingRequest(coalesced[existingIndex], turn);
  }
  return coalesced;
}

function buildRequestIdTurnMap(turnResponses: readonly TurnResponseTurn[]): Map<string, TurnResponseTurn> {
  const turnsByRequestId = new Map<string, TurnResponseTurn>();
  for (const turn of turnResponses) {
    const requestId = readTurnResponseRequestId(turn);
    if (requestId) {
      turnsByRequestId.set(requestId, turn);
    }
  }
  return turnsByRequestId;
}

function readTurnResponseRequestId(turn: TurnResponseTurn | null | undefined): string | null {
  const requestId = turn?.request?.metadata?.['requestId'];
  return typeof requestId === 'string' && requestId.trim().length > 0
    ? requestId.trim()
    : null;
}

function mergeRequestMetadata(
  existingMetadata: TurnResponseTurn['request']['metadata'],
  nextMetadata: TurnResponseTurn['request']['metadata'],
): TurnResponseTurn['request']['metadata'] {
  if (existingMetadata === undefined) {
    return cloneRequestMetadata(nextMetadata);
  }
  if (nextMetadata === undefined) {
    return cloneRequestMetadata(existingMetadata);
  }
  return {
    ...(cloneRequestMetadata(existingMetadata) as Record<string, unknown>),
    ...(cloneRequestMetadata(nextMetadata) as Record<string, unknown>),
  } as TurnResponseTurn['request']['metadata'];
}

function cloneTurnRequest(request: TurnResponseTurn['request']): TurnResponseTurn['request'] {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(request) as TurnResponseTurn['request'];
  }

  return JSON.parse(JSON.stringify(request)) as TurnResponseTurn['request'];
}

function cloneRequestMetadata(
  metadata: TurnResponseTurn['request']['metadata'],
): TurnResponseTurn['request']['metadata'] {
  if (metadata === undefined) {
    return undefined;
  }

  try {
    return globalThis.structuredClone(metadata);
  } catch {
    return JSON.parse(JSON.stringify(metadata)) as TurnResponseTurn['request']['metadata'];
  }
}

function isBlankRequestText(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function clonePendingFollowupRequest(request: PendingFollowupRequest): PendingFollowupRequest {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(request) as PendingFollowupRequest;
  }

  return JSON.parse(JSON.stringify(request)) as PendingFollowupRequest;
}

function hasBlockingIncomingOwnerMismatch(
  sessionResource: string,
  incomingTurnResponses: readonly TurnResponseTurn[],
  existingTurnResponses: readonly TurnResponseTurn[],
  options?: ChatSessionTurnOwnerPolicyOptions,
): boolean {
  const incomingDiagnostics = buildSessionTurnOwnerDiagnostics(sessionResource, incomingTurnResponses);
  if (incomingDiagnostics.mismatchCount === 0 || options?.allowForkedTurns === true) {
    return false;
  }

  const existingTurnIds = new Set(
    existingTurnResponses
      .map(turn => typeof turn?.turnId === 'string' ? turn.turnId : '')
      .filter(turnId => turnId.length > 0),
  );
  if (existingTurnIds.size === 0) {
    return true;
  }

  return incomingDiagnostics.mismatchedTurnIds.some(turnId => !existingTurnIds.has(turnId));
}

@Injectable()
export class ChatSessionModelStoreService {
  private readonly models = new Map<ChatSessionResource, ChatSessionModel>();
  private readonly references = new Map<ChatSessionResource, number>();
  private readonly pendingDispose = new Set<ChatSessionResource>();
  private readonly changedSubject = new Subject<ChatSessionModelStoreChangedEvent>();

  readonly changed$ = this.changedSubject.asObservable();

  constructor(
    private readonly runtimeStore: ChatSessionRuntimeStoreService,
  ) {}

  get(sessionResource: string | null | undefined): ChatSessionModel | undefined {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    return normalizedResource ? this.models.get(normalizedResource) : undefined;
  }

  has(sessionResource: string | null | undefined): boolean {
    return !!this.get(sessionResource);
  }

  values(): readonly ChatSessionModel[] {
    return [...this.models.values()];
  }

  getSessionResources(): readonly ChatSessionResource[] {
    return [...this.models.keys()];
  }

  acquireExisting(
    sessionResource: string | null | undefined,
  ): ChatSessionModelReference | undefined {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    const model = normalizedResource ? this.models.get(normalizedResource) : undefined;
    return model ? this.createReference(model) : undefined;
  }

  acquireOrCreate(
    props: ChatSessionModelCreateProps,
    options: ChatSessionModelAcquireOptions = {},
  ): ChatSessionModelReference {
    const normalizedResource = normalizeChatSessionResource(props.sessionResource);
    if (!normalizedResource) {
      throw new Error('ChatSessionModelStore.acquireOrCreate requires a sessionResource');
    }

    let model = this.models.get(normalizedResource);
    if (!model) {
      model = new ChatSessionModel(this.runtimeStore, {
        ...props,
        sessionResource: normalizedResource,
      });
      this.models.set(normalizedResource, model);
      this.pendingDispose.delete(normalizedResource);
      if (!options.suppressCreatedEvent) {
        this.changedSubject.next({ sessionResource: normalizedResource, kind: 'created' });
      }
    } else {
      model.updateMetadata(props);
      this.changedSubject.next({ sessionResource: normalizedResource, kind: 'updated' });
    }

    return this.createReference(model);
  }

  updateMetadata(
    sessionResource: string | null | undefined,
    patch: ChatSessionModelMetadataPatch,
  ): boolean {
    const model = this.get(sessionResource);
    if (!model) {
      return false;
    }

    model.updateMetadata(patch);
    this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    return true;
  }

  updateInputDraft(
    sessionResource: string | null | undefined,
    draftText: string,
  ): boolean {
    const model = this.get(sessionResource);
    if (!model) {
      return false;
    }

    model.updateMetadata({
      inputState: {
        ...model.inputState,
        draftText,
      },
    });
    this.changedSubject.next({
      sessionResource: model.sessionResource,
      kind: 'updated',
      reason: 'inputDraft',
    });
    return true;
  }

  replaceTurnResponses(
    sessionResource: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    return this.replaceAllTurnResponsesTransaction(sessionResource, turnResponses, ownerPolicy)?.turnResponses ?? null;
  }

  replaceAllTurnResponsesTransaction(
    sessionResource: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model || !Array.isArray(turnResponses)) {
      return null;
    }

    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(model.sessionResource, turnResponses);
    if (ownerDiagnostics.mismatchCount > 0) {
      const blocked = hasBlockingIncomingOwnerMismatch(
        model.sessionResource,
        turnResponses,
        model.turnResponses,
        ownerPolicy,
      );
      console.warn(blocked
        ? '[ChatSessionModelStore][blocked-owner-mismatch]'
        : '[ChatSessionModelStore][owner-mismatch]', {
        phase: 'replaceTurnResponses',
        sessionResource: model.sessionResource,
        mismatchCount: ownerDiagnostics.mismatchCount,
        mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
        source: ownerPolicy?.source ?? null,
      });
      if (blocked) {
        return null;
      }
    }

    const result = model.replaceAllTurnResponsesTransaction(turnResponses);
    if (result) {
      this.changedSubject.next({
        sessionResource: model.sessionResource,
        kind: 'updated',
        reason: 'replaceAll',
      });
    }
    return result;
  }

  appendOrReplaceTurnResponse(
    sessionResource: string | null | undefined,
    turnResponse: TurnResponseTurn,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(model.sessionResource, [turnResponse]);
    if (ownerDiagnostics.mismatchCount > 0) {
      const blocked = hasBlockingIncomingOwnerMismatch(
        model.sessionResource,
        [turnResponse],
        model.turnResponses,
        ownerPolicy,
      );
      console.warn(blocked
        ? '[ChatSessionModelStore][blocked-owner-mismatch]'
        : '[ChatSessionModelStore][owner-mismatch]', {
        phase: 'appendOrReplaceTurnResponse',
        sessionResource: model.sessionResource,
        mismatchCount: ownerDiagnostics.mismatchCount,
        mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
        source: ownerPolicy?.source ?? null,
      });
      if (blocked) {
        return null;
      }
    }

    const status = turnResponse.response?.status;
    const result = model.appendTurnTransaction(
      turnResponse,
      typeof status === 'string' && status !== 'streaming'
        ? 'appendCompletedTurn'
        : 'appendTransientTurn',
    );
    if (result) {
      this.changedSubject.next({
        sessionResource: model.sessionResource,
        kind: 'updated',
        reason: typeof status === 'string' && status !== 'streaming'
          ? 'appendCompletedTurn'
          : 'appendTransientTurn',
      });
    }
    return result?.turnResponses ?? null;
  }

  appendCompletedTurnTransaction(
    sessionResource: string | null | undefined,
    turnResponse: TurnResponseTurn,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.appendTurnTransaction(turnResponse, 'appendCompletedTurn');
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated', reason: 'appendCompletedTurn' });
    }
    return result;
  }

  appendTransientTurnTransaction(
    sessionResource: string | null | undefined,
    turnResponse: TurnResponseTurn,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.appendTurnTransaction(turnResponse, 'appendTransientTurn');
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated', reason: 'appendTransientTurn' });
    }
    return result;
  }

  settleCheckpointMetadataTransaction(
    sessionResource: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[] | null | undefined,
    checkpointTimelineState: SessionCheckpointTimelineState | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.settleCheckpointMetadataTransaction(turnResponses, checkpointTimelineState);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  appendOrReplaceTurnResponseDelta(
    sessionResource: string | null | undefined,
    turnResponse: TurnResponseTurn,
    parts: TurnResponseTurn['response']['parts'] | null | undefined,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): readonly TurnResponseTurn[] | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(model.sessionResource, [turnResponse]);
    if (ownerDiagnostics.mismatchCount > 0) {
      const blocked = hasBlockingIncomingOwnerMismatch(
        model.sessionResource,
        [turnResponse],
        model.turnResponses,
        ownerPolicy,
      );
      console.warn(blocked
        ? '[ChatSessionModelStore][blocked-owner-mismatch]'
        : '[ChatSessionModelStore][owner-mismatch]', {
        phase: 'appendOrReplaceTurnResponseDelta',
        sessionResource: model.sessionResource,
        mismatchCount: ownerDiagnostics.mismatchCount,
        mismatchedOwners: ownerDiagnostics.mismatchedOwners,
        mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
        firstTurnId: ownerDiagnostics.firstTurnId,
        firstRequestPreview: ownerDiagnostics.firstRequestPreview,
        source: ownerPolicy?.source ?? null,
      });
      if (blocked) {
        return null;
      }
    }

    const nextTurnResponses = model.appendOrReplaceTurnResponse(turnResponse, {
      syncPartStore: false,
    });
    model.upsertTurnResponseParts(turnResponse.turnId, parts);
    this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated', reason: 'turnDelta' });
    return nextTurnResponses;
  }

  commitRestoredCheckpointForwardBranch(
    sessionResource: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.commitRestoredCheckpointForwardBranch();
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  commitCheckpointRestoreTransaction(
    sessionResource: string | null | undefined,
    checkpointId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.commitCheckpointRestoreTransaction(checkpointId);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  rollbackCheckpointRestoreTransaction(
    sessionResource: string | null | undefined,
    committed: ChatSessionRequestListTransactionResult | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.rollbackCheckpointRestoreTransaction(committed);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  prepareCheckpointRedoTransaction(
    sessionResource: string | null | undefined,
  ): ChatSessionPreparedRedoTransaction | null {
    const model = this.get(sessionResource);
    return model?.prepareCheckpointRedoTransaction() ?? null;
  }

  commitCheckpointRedoTransaction(
    sessionResource: string | null | undefined,
    prepared: ChatSessionPreparedRedoTransaction | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.commitCheckpointRedoTransaction(prepared);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  rollbackCheckpointRedoTransaction(
    sessionResource: string | null | undefined,
    prepared: ChatSessionPreparedRedoTransaction | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.rollbackCheckpointRedoTransaction(prepared);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  removeFromTurnTransaction(
    sessionResource: string | null | undefined,
    turnId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    if (!model) {
      return null;
    }

    const result = model.removeFromTurnTransaction(turnId);
    if (result) {
      this.changedSubject.next({ sessionResource: model.sessionResource, kind: 'updated' });
    }
    return result;
  }

  prepareForkPrefixBeforeTurn(
    sessionResource: string | null | undefined,
    turnId: string | null | undefined,
  ): ChatSessionRequestListTransactionResult | null {
    const model = this.get(sessionResource);
    return model?.prepareForkPrefixBeforeTurn(turnId) ?? null;
  }

  applyRuntimeState(
    sessionResource: string | null | undefined,
    state: ChatSessionRuntimeStatePatch,
    options?: ChatSessionRuntimeChangeOptions,
    ownerPolicy?: ChatSessionTurnOwnerPolicyOptions,
  ): boolean {
    const model = this.get(sessionResource);
    if (!model) {
      return false;
    }

    if (Array.isArray(state.turnResponses)) {
      const ownerDiagnostics = buildSessionTurnOwnerDiagnostics(model.sessionResource, state.turnResponses);
      if (ownerDiagnostics.mismatchCount > 0) {
        const blocked = hasBlockingIncomingOwnerMismatch(
          model.sessionResource,
          state.turnResponses,
          model.turnResponses,
          ownerPolicy,
        );
        console.warn(blocked
          ? '[ChatSessionModelStore][blocked-owner-mismatch]'
          : '[ChatSessionModelStore][owner-mismatch]', {
          phase: 'applyRuntimeState',
          sessionResource: model.sessionResource,
          mismatchCount: ownerDiagnostics.mismatchCount,
          mismatchedOwners: ownerDiagnostics.mismatchedOwners,
          mismatchedTurnIds: ownerDiagnostics.mismatchedTurnIds.slice(0, 5),
          firstTurnId: ownerDiagnostics.firstTurnId,
          firstRequestPreview: ownerDiagnostics.firstRequestPreview,
          reason: options?.reason ?? null,
          source: ownerPolicy?.source ?? null,
        });
        if (blocked) {
          return false;
        }
      }
    }

    model.applyRuntimeState(state, options);
    this.changedSubject.next({
      sessionResource: model.sessionResource,
      kind: 'updated',
      ...(options?.reason === 'projection' ? { reason: 'projection' as const } : {}),
    });
    return true;
  }

  applyProjection(
    sessionResource: string | null | undefined,
    state: HostTurnResponseState | null,
    options?: ChatSessionRuntimeChangeOptions,
  ): boolean {
    const model = this.get(sessionResource);
    if (!model) {
      return false;
    }

    model.applyProjection(state, options);
    this.changedSubject.next({
      sessionResource: model.sessionResource,
      kind: 'updated',
      reason: 'projection',
    });
    return true;
  }

  disposeSession(sessionResource: string | null | undefined): boolean {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    if (!normalizedResource || !this.models.has(normalizedResource)) {
      return false;
    }

    if ((this.references.get(normalizedResource) ?? 0) > 0) {
      this.pendingDispose.add(normalizedResource);
      return true;
    }

    this.disposeModelNow(normalizedResource);
    return true;
  }

  clear(): void {
    for (const [sessionResource, model] of this.models.entries()) {
      model.dispose();
      this.runtimeStore.clearSession(sessionResource, { reason: 'clearAll', listAffecting: true });
      this.changedSubject.next({ sessionResource, kind: 'disposed' });
    }
    this.models.clear();
    this.references.clear();
    this.pendingDispose.clear();
  }

  getReferenceCount(sessionResource: string | null | undefined): number {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    return normalizedResource ? this.references.get(normalizedResource) ?? 0 : 0;
  }

  private createReference(model: ChatSessionModel): ChatSessionModelReference {
    const sessionResource = model.sessionResource;
    this.references.set(sessionResource, (this.references.get(sessionResource) ?? 0) + 1);

    let disposed = false;
    return {
      object: model,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.releaseReference(sessionResource);
      },
    };
  }

  private releaseReference(sessionResource: ChatSessionResource): void {
    const nextCount = Math.max((this.references.get(sessionResource) ?? 0) - 1, 0);
    if (nextCount > 0) {
      this.references.set(sessionResource, nextCount);
      return;
    }

    this.references.delete(sessionResource);
    if (this.pendingDispose.delete(sessionResource)) {
      this.disposeModelNow(sessionResource);
    }
  }

  private disposeModelNow(sessionResource: ChatSessionResource): void {
    const model = this.models.get(sessionResource);
    if (!model || !this.models.delete(sessionResource)) {
      return;
    }

    model.dispose();
    this.references.delete(sessionResource);
    this.pendingDispose.delete(sessionResource);
    this.runtimeStore.clearSession(sessionResource, { reason: 'clear', listAffecting: true });
    this.changedSubject.next({ sessionResource, kind: 'disposed' });
  }
}
