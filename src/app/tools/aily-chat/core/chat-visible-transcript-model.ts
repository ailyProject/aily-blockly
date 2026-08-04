import type { TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPart } from './chat-parts';
import {
  turnResponsePartToChatParts,
  turnResponsePartsToDisplayChatPartEntries,
} from './turn-response-part-mapper';
import {
  buildTurnResponseAssistantMessageProjection,
  getTurnResponseAssistantText,
  getTurnResponseDisplayContent,
} from './turn-response-stream-contract';
import {
  buildDialogTurnContext,
  type DialogTurnContext,
} from './user-turn-action-target';
import {
  ChatStreamStatsTracker,
  countChatMarkdownWords,
  type ChatStreamStats,
} from './chat-stream-stats';

export type ChatVisibleTranscriptItemKind = 'request' | 'response';
export type ChatVisibleTranscriptRole = 'user' | 'aily';
export type ChatVisibleTranscriptChangeKind = 'added' | 'updated' | 'removed' | 'completed';

export interface ChatVisibleTranscriptChange {
  readonly kind: ChatVisibleTranscriptChangeKind;
  readonly itemId: string;
}

export interface ChatVisibleTranscriptItem {
  readonly id: string;
  readonly kind: ChatVisibleTranscriptItemKind;
  readonly role: ChatVisibleTranscriptRole;
  readonly turnId: string;
  readonly status: TurnResponseStatus;
  readonly contentPreview: string;
  readonly parts: readonly ChatPart[];
  readonly turnResponse: TurnResponseTurn | null;
  readonly turnContext: DialogTurnContext | null;
  readonly contentUpdateTimings?: ChatStreamStats;
  readonly revision: number;
}

export interface ChatVisibleTranscriptDialogItem {
  readonly id: string;
  readonly turnId?: string;
  readonly responseId?: string;
  readonly role: ChatVisibleTranscriptRole;
  readonly content: string;
  readonly doing: boolean;
  readonly turnModelName: string;
  readonly turnModelBillingLabel?: string;
  readonly turnContext: DialogTurnContext | null;
  readonly parts: readonly ChatPart[];
  readonly turnResponse: TurnResponseTurn | null;
  readonly contentUpdateTimings?: ChatStreamStats;
  readonly revision: number;
  readonly responseVote?: 0 | 1;
  readonly isLastAily: boolean;
  readonly isFirstUserTurn: boolean;
  readonly showCheckpointRestore: boolean;
}

export interface ChatVisibleTranscriptRuntimeOverlay {
  readonly turnResponses: readonly TurnResponseTurn[];
}

export interface ChatVisibleTranscriptDialogItemPatch {
  readonly itemId: string;
  readonly index: number;
  readonly item: ChatVisibleTranscriptDialogItem;
  readonly kind: ChatVisibleTranscriptChangeKind;
  /** Response-model parts changed by the originating host delta. */
  readonly changedParts?: readonly ChatPart[];
  /** Canonical indices in the visible response-part projection. */
  readonly changedPartIndices?: readonly number[];
}

interface ChatVisibleTranscriptItemRecord {
  readonly item: ChatVisibleTranscriptItem;
  readonly signature: string;
}

interface ChatVisibleTranscriptDialogItemRecord {
  readonly itemRevision: number;
  readonly isLastAily: boolean;
  readonly isFirstUserTurn: boolean;
  readonly dialogItem: ChatVisibleTranscriptDialogItem;
}

export function chatVisibleRequestItemId(turnId: string): string {
  return `request:${turnId}`;
}

export function chatVisibleResponseItemId(turnId: string): string {
  return `response:${turnId}`;
}

export class ChatVisibleTranscriptModel {
  private readonly records = new Map<string, ChatVisibleTranscriptItemRecord>();
  private readonly dialogItemCache = new Map<string, ChatVisibleTranscriptDialogItemRecord>();
  private readonly streamStatsTrackers = new Map<string, ChatStreamStatsTracker>();
  private readonly streamPartWordCounts = new Map<string, Map<string, number>>();
  private readonly responsePartSlots = new Map<string, readonly (readonly ChatPart[])[]>();
  private orderedIds: string[] = [];
  private readonly orderedIndexById = new Map<string, number>();
  private readonly changes: ChatVisibleTranscriptChange[] = [];
  private firstUserItemId: string | null = null;
  private lastAilyItemId: string | null = null;
  private projectedFirstUserItemId: string | null = null;
  private projectedLastAilyItemId: string | null = null;

  getItems(): readonly ChatVisibleTranscriptItem[] {
    return this.orderedIds
      .map(id => this.records.get(id)?.item)
      .filter((item): item is ChatVisibleTranscriptItem => !!item);
  }

  getItem(itemId: string): ChatVisibleTranscriptItem | undefined {
    return this.records.get(itemId)?.item;
  }

  getResponseItem(turnId: string): ChatVisibleTranscriptItem | undefined {
    return this.getItem(chatVisibleResponseItemId(turnId));
  }

  getResponseDisplayPartIndices(
    turnId: string,
    sourcePartIndices: readonly number[],
  ): readonly number[] {
    const slots = this.responsePartSlots.get(turnId);
    if (!slots || sourcePartIndices.length === 0) {
      return [];
    }
    const sourceIndexSet = new Set(sourcePartIndices);
    const displayIndices: number[] = [];
    let displayIndex = 0;
    slots.forEach((slot, sourcePartIndex) => {
      for (let offset = 0; offset < slot.length; offset += 1) {
        if (sourceIndexSet.has(sourcePartIndex)) {
          displayIndices.push(displayIndex);
        }
        displayIndex += 1;
      }
    });
    return displayIndices;
  }

  replaceFromSessionModel(turnResponses: readonly TurnResponseTurn[] | null | undefined): readonly ChatVisibleTranscriptChange[] {
    const nextIds: string[] = [];
    const expectedIds = new Set<string>();
    let firstUserItemId: string | null = null;
    let lastAilyItemId: string | null = null;

    for (const turn of turnResponses ?? []) {
      const request = this.insertTurnRequestInternal(turn, { recordOrder: false });
      const response = this.upsertTurnResponseInternal(turn, { recordOrder: false });
      nextIds.push(request.id, response.id);
      expectedIds.add(request.id);
      expectedIds.add(response.id);
      firstUserItemId ??= request.id;
      if (response.turnContext?.turnResponse) {
        lastAilyItemId = response.id;
      }
    }

    for (const itemId of [...this.records.keys()]) {
      if (!expectedIds.has(itemId)) {
        const removedTurnId = this.records.get(itemId)?.item.turnId;
        this.records.delete(itemId);
        this.dialogItemCache.delete(itemId);
        if (removedTurnId && !expectedIds.has(chatVisibleResponseItemId(removedTurnId))) {
          this.streamStatsTrackers.delete(removedTurnId);
          this.streamPartWordCounts.delete(removedTurnId);
          this.responsePartSlots.delete(removedTurnId);
        }
        this.pushChange('removed', itemId);
      }
    }

    this.orderedIds = nextIds;
    this.rebuildOrderedIndex();
    this.firstUserItemId = firstUserItemId;
    this.lastAilyItemId = lastAilyItemId;
    return this.peekChanges();
  }

  attachRuntimeOverlay(runtimeState: ChatVisibleTranscriptRuntimeOverlay | null | undefined): readonly ChatVisibleTranscriptChange[] {
    return this.replaceFromSessionModel(runtimeState?.turnResponses ?? []);
  }

  insertTurnRequest(turn: TurnResponseTurn): ChatVisibleTranscriptItem {
    return this.insertTurnRequestInternal(turn, { recordOrder: true });
  }

  private insertTurnRequestInternal(
    turn: TurnResponseTurn,
    options: { recordOrder: boolean },
  ): ChatVisibleTranscriptItem {
    const itemId = chatVisibleRequestItemId(turn.turnId);
    const item = this.upsertItem({
      id: itemId,
      kind: 'request',
      role: 'user',
      turnId: turn.turnId,
      status: turn.response.status,
      contentPreview: getTurnResponseDisplayContent(turn.request),
      parts: [],
      turnResponse: turn,
      turnContext: buildDialogTurnContext({ turnResponse: turn }),
      contentUpdateTimings: undefined,
    });
    if (options.recordOrder) {
      this.ensureOrderedItem(item);
    }
    return item;
  }

  upsertTurnResponse(turn: TurnResponseTurn): ChatVisibleTranscriptItem {
    return this.upsertTurnResponseInternal(turn, { recordOrder: true });
  }

  private upsertTurnResponseInternal(
    turn: TurnResponseTurn,
    options: { recordOrder: boolean },
  ): ChatVisibleTranscriptItem {
    const parts = this.replaceResponsePartSlots(turn.turnId, turn.response.parts);
    const contentPreview = getTurnResponseAssistantText(turn);
    const item = this.upsertItem({
      id: chatVisibleResponseItemId(turn.turnId),
      kind: 'response',
      role: 'aily',
      turnId: turn.turnId,
      status: turn.response.status,
      contentPreview,
      parts,
      turnResponse: turn,
      turnContext: buildDialogTurnContext({ turnResponse: turn }),
      contentUpdateTimings: this.updateStreamStats(
        turn.turnId,
        turn.response.status,
        turn.response.parts,
      ),
    });
    if (options.recordOrder) {
      this.ensureOrderedItem(item);
    }
    return item;
  }

  upsertResponsePart(
    turnId: string,
    sourcePartIndex: number,
    part: TurnResponsePart,
  ): ChatVisibleTranscriptItem {
    return this.upsertResponseParts(turnId, [part], [sourcePartIndex]);
  }

  upsertResponseParts(
    turnId: string,
    parts: readonly TurnResponsePart[],
    sourcePartIndices: readonly number[],
    authoritativeTurn?: TurnResponseTurn,
  ): ChatVisibleTranscriptItem {
    const responseId = chatVisibleResponseItemId(turnId);
    const existing = this.records.get(responseId)?.item;
    if (!existing) {
      throw new Error(`Cannot upsert response part before response item exists: ${turnId}`);
    }
    if (parts.length !== sourcePartIndices.length) {
      throw new Error(`Response part delta index mismatch: ${turnId}`);
    }

    const nextParts = authoritativeTurn
      ? this.replaceResponsePartSlots(turnId, authoritativeTurn.response.parts)
      : this.patchResponsePartSlots(turnId, parts, sourcePartIndices);
    return this.upsertItem({
      id: existing.id,
      kind: 'response',
      role: 'aily',
      turnId: existing.turnId,
      status: authoritativeTurn?.response.status ?? existing.status,
      // The response row is part-owned while streaming. Materializing the
      // complete assistant text here would copy every growing markdown part
      // before the mounted content-part renderer sees the delta.
      contentPreview: existing.contentPreview,
      parts: nextParts,
      turnResponse: authoritativeTurn ?? existing.turnResponse,
      turnContext: authoritativeTurn
        ? buildDialogTurnContext({ turnResponse: authoritativeTurn })
        : existing.turnContext,
      contentUpdateTimings: this.updateStreamStats(
        turnId,
        existing.status,
        parts,
      ),
    });
  }

  private replaceResponsePartSlots(
    turnId: string,
    responseParts: readonly TurnResponsePart[],
  ): readonly ChatPart[] {
    const slots: ChatPart[][] = Array.from({ length: responseParts.length }, () => []);
    for (const entry of turnResponsePartsToDisplayChatPartEntries(responseParts)) {
      slots[entry.sourcePartIndex].push(entry.part);
    }
    this.responsePartSlots.set(turnId, slots);
    return slots.flat();
  }

  private patchResponsePartSlots(
    turnId: string,
    parts: readonly TurnResponsePart[],
    sourcePartIndices: readonly number[],
  ): readonly ChatPart[] {
    const previousSlots = this.responsePartSlots.get(turnId);
    if (!previousSlots) {
      throw new Error(`Cannot patch response part slots before response projection exists: ${turnId}`);
    }

    const nextSlots = previousSlots.map(slot => [...slot]);
    for (let index = 0; index < parts.length; index += 1) {
      const sourcePartIndex = sourcePartIndices[index];
      if (!Number.isInteger(sourcePartIndex) || sourcePartIndex < 0) {
        throw new Error(`Invalid canonical response part index: ${turnId}`);
      }
      while (nextSlots.length <= sourcePartIndex) {
        nextSlots.push([]);
      }
      nextSlots[sourcePartIndex] = turnResponsePartToChatParts(
        parts[index],
        nextSlots[sourcePartIndex][0],
      );
    }
    this.responsePartSlots.set(turnId, nextSlots);
    return nextSlots.flat();
  }

  /**
   * Project only the list items touched by a response-model delta. This mirrors
   * VS Code's list renderer contract: the list owns stable rows while the
   * response renderer receives item-local updates.
   */
  toDialogItemPatches(
    changes: readonly ChatVisibleTranscriptChange[] | null | undefined,
  ): readonly ChatVisibleTranscriptDialogItemPatch[] {
    const uniqueChanges = new Map<string, ChatVisibleTranscriptChangeKind>();
    for (const change of changes ?? []) {
      uniqueChanges.set(change.itemId, change.kind);
    }
    if (uniqueChanges.size === 0) {
      return [];
    }

    const firstUserItemId = this.firstUserItemId;
    const lastAilyItemId = this.lastAilyItemId;

    // List presentation state belongs to the stable row model as well. When a
    // new turn is appended, update only the row that previously owned the
    // first/last presentation flag instead of rescanning or rebuilding rows.
    if (this.projectedFirstUserItemId
      && this.projectedFirstUserItemId !== firstUserItemId
      && this.orderedIndexById.has(this.projectedFirstUserItemId)) {
      uniqueChanges.set(this.projectedFirstUserItemId, 'updated');
    }
    if (this.projectedLastAilyItemId
      && this.projectedLastAilyItemId !== lastAilyItemId
      && this.orderedIndexById.has(this.projectedLastAilyItemId)) {
      uniqueChanges.set(this.projectedLastAilyItemId, 'updated');
    }

    const patches: ChatVisibleTranscriptDialogItemPatch[] = [];
    for (const [itemId, kind] of uniqueChanges) {
      const index = this.orderedIndexById.get(itemId) ?? -1;
      const item = index >= 0 ? this.records.get(itemId)?.item : undefined;
      if (!item) {
        continue;
      }
      patches.push({
        itemId,
        index,
        kind,
        item: this.toDialogItem(item, {
          isLastAily: itemId === lastAilyItemId,
          isFirstUserTurn: itemId === firstUserItemId,
        }),
      });
    }
    this.projectedFirstUserItemId = firstUserItemId;
    this.projectedLastAilyItemId = lastAilyItemId;
    return patches;
  }

  completeResponse(turnId: string, status: Exclude<TurnResponseStatus, 'streaming'>): ChatVisibleTranscriptItem {
    const responseId = chatVisibleResponseItemId(turnId);
    const existing = this.records.get(responseId)?.item;
    if (!existing) {
      throw new Error(`Cannot complete response before response item exists: ${turnId}`);
    }

    const item = this.upsertItem({
      id: existing.id,
      kind: 'response',
      role: 'aily',
      turnId: existing.turnId,
      status,
      contentPreview: collectChatPartAssistantPreview(existing.parts, existing.contentPreview),
      parts: existing.parts,
      turnResponse: existing.turnResponse
        ? {
            ...existing.turnResponse,
            response: {
              ...existing.turnResponse.response,
              status,
            },
          }
        : null,
      turnContext: existing.turnResponse
        ? buildDialogTurnContext({
            turnResponse: {
              ...existing.turnResponse,
              response: {
                ...existing.turnResponse.response,
                status,
              },
            },
          })
        : existing.turnContext,
      contentUpdateTimings: existing.contentUpdateTimings,
    });
    this.streamPartWordCounts.delete(turnId);
    this.pushChange('completed', item.id);
    return item;
  }

  toDialogItems(): readonly ChatVisibleTranscriptDialogItem[] {
    const items = this.getItems();
    this.projectedFirstUserItemId = this.firstUserItemId;
    this.projectedLastAilyItemId = this.lastAilyItemId;

    return items.map(item => this.toDialogItem(item, {
      isLastAily: item.id === this.lastAilyItemId,
      isFirstUserTurn: item.id === this.firstUserItemId,
    }));
  }

  toDialogItemsAfterChanges(
    previousItems: readonly ChatVisibleTranscriptDialogItem[] | null | undefined,
    changes: readonly ChatVisibleTranscriptChange[] | null | undefined,
  ): readonly ChatVisibleTranscriptDialogItem[] {
    const currentItems = this.getItems();
    const previous = previousItems ?? [];
    const changeList = changes ?? [];
    if (previous.length !== currentItems.length
      || changeList.length === 0
      || changeList.some(change => change.kind === 'added' || change.kind === 'removed')) {
      return this.toDialogItems();
    }

    for (let index = 0; index < currentItems.length; index++) {
      if (previous[index]?.id !== currentItems[index]?.id) {
        return this.toDialogItems();
      }
    }

    const changedItemIds = new Set(changeList.map(change => change.itemId));
    if (changedItemIds.size === 0) {
      return previous;
    }

    const firstUserIndex = currentItems.findIndex(item => item.role === 'user');
    const lastAilyIndex = findLastIndex(currentItems, item => item.role === 'aily' && !!item.turnContext?.turnResponse);
    this.projectedFirstUserItemId = firstUserIndex >= 0 ? currentItems[firstUserIndex].id : null;
    this.projectedLastAilyItemId = lastAilyIndex >= 0 ? currentItems[lastAilyIndex].id : null;
    let changed = false;
    const patched = currentItems.map((item, index) => {
      const nextDialogItem = changedItemIds.has(item.id)
        ? this.toDialogItem(item, {
          isLastAily: index === lastAilyIndex,
          isFirstUserTurn: index === firstUserIndex,
        })
        : previous[index];
      if (nextDialogItem !== previous[index]) {
        changed = true;
      }
      return nextDialogItem;
    });

    return changed ? patched : previous;
  }

  drainChanges(): readonly ChatVisibleTranscriptChange[] {
    const drained = this.peekChanges();
    this.changes.length = 0;
    return drained;
  }

  peekChanges(): readonly ChatVisibleTranscriptChange[] {
    return this.changes.map(change => ({ ...change }));
  }

  private toDialogItem(
    item: ChatVisibleTranscriptItem,
    flags: { isLastAily: boolean; isFirstUserTurn: boolean },
  ): ChatVisibleTranscriptDialogItem {
    const cached = this.dialogItemCache.get(item.id);
    if (cached
      && cached.itemRevision === item.revision
      && cached.isLastAily === flags.isLastAily
      && cached.isFirstUserTurn === flags.isFirstUserTurn) {
      return cached.dialogItem;
    }

    const assistantProjection = item.kind === 'response' && item.turnResponse
      ? buildTurnResponseAssistantMessageProjection(item.turnResponse, {
        ...(item.contentPreview ? { content: item.contentPreview } : {}),
      })
      : null;

    const dialogItem = Object.freeze({
      id: item.id,
      turnId: item.turnId,
      responseId: item.kind === 'response' ? item.turnId : undefined,
      role: item.role,
      content: item.contentPreview,
      doing: item.kind === 'response' && item.status === 'streaming',
      turnModelName: assistantProjection?.modelName ?? '',
      turnModelBillingLabel: assistantProjection?.modelBillingLabel,
      turnContext: item.turnContext,
      parts: item.parts,
      turnResponse: item.turnResponse,
      contentUpdateTimings: item.contentUpdateTimings,
      revision: item.revision,
      isLastAily: flags.isLastAily,
      isFirstUserTurn: flags.isFirstUserTurn,
      showCheckpointRestore: false,
    } satisfies ChatVisibleTranscriptDialogItem);
    this.dialogItemCache.set(item.id, {
      itemRevision: item.revision,
      isLastAily: flags.isLastAily,
      isFirstUserTurn: flags.isFirstUserTurn,
      dialogItem,
    });
    return dialogItem;
  }

  private upsertItem(props: Omit<ChatVisibleTranscriptItem, 'revision'>): ChatVisibleTranscriptItem {
    const existingRecord = this.records.get(props.id);
    const signature = createItemSignature(props);
    if (existingRecord?.signature === signature) {
      return existingRecord.item;
    }

    const item = freezeItem({
      ...props,
      parts: freezeChatParts(props.parts),
      revision: (existingRecord?.item.revision ?? 0) + 1,
    });
    this.records.set(props.id, { item, signature });
    this.pushChange(existingRecord ? 'updated' : 'added', props.id);
    return item;
  }

  private updateStreamStats(
    turnId: string,
    status: TurnResponseStatus,
    parts: readonly TurnResponsePart[],
  ): ChatStreamStats | undefined {
    let tracker = this.streamStatsTrackers.get(turnId);
    if (!tracker && status === 'streaming') {
      tracker = new ChatStreamStatsTracker();
      this.streamStatsTrackers.set(turnId, tracker);
    }
    if (!tracker) {
      return undefined;
    }

    let partWordCounts = this.streamPartWordCounts.get(turnId);
    if (!partWordCounts) {
      partWordCounts = new Map<string, number>();
      this.streamPartWordCounts.set(turnId, partWordCounts);
    }
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.type !== 'markdown' && part.type !== 'thinking') {
        continue;
      }
      const persistedPartId = (part as unknown as { readonly partId?: unknown }).partId;
      const partId = typeof persistedPartId === 'string'
        ? persistedPartId
        : `${part.type}:legacy:${index}`;
      partWordCounts.set(partId, countChatMarkdownWords(part.content));
    }
    const totalWordCount = Array.from(partWordCounts.values())
      .reduce((total, count) => total + count, 0);
    tracker.update(totalWordCount);
    return tracker.data;
  }

  private ensureOrderedItem(item: ChatVisibleTranscriptItem): void {
    if (this.orderedIndexById.has(item.id)) {
      return;
    }
    this.orderedIndexById.set(item.id, this.orderedIds.length);
    this.orderedIds = [...this.orderedIds, item.id];
    if (item.role === 'user') {
      this.firstUserItemId ??= item.id;
    } else if (item.turnContext?.turnResponse) {
      this.lastAilyItemId = item.id;
    }
  }

  private rebuildOrderedIndex(): void {
    this.orderedIndexById.clear();
    for (let index = 0; index < this.orderedIds.length; index += 1) {
      this.orderedIndexById.set(this.orderedIds[index], index);
    }
  }

  private pushChange(kind: ChatVisibleTranscriptChangeKind, itemId: string): void {
    this.changes.push({ kind, itemId });
  }
}

function collectChatPartAssistantPreview(parts: readonly ChatPart[], fallback: string): string {
  const content = parts
    .filter((part): part is Extract<ChatPart, { type: 'markdown' }> => part.type === 'markdown' && part.sourceAgentRole !== 'subagent')
    .map(part => part.content)
    .join('');
  return content || fallback;
}

function createItemSignature(item: Omit<ChatVisibleTranscriptItem, 'revision'>): string {
  if (item.kind === 'request') {
    return [
      item.id,
      item.kind,
      item.role,
      item.turnId,
      item.contentPreview,
      item.turnResponse?.request.content ?? '',
      item.turnResponse?.request.displayContent ?? '',
      item.turnResponse?.createdAt ?? '',
      stableSmallJson(item.turnResponse?.request?.attachments ?? null),
      stableSmallJson(selectRequestPresentationMetadata(item.turnResponse?.request?.metadata)),
    ].join('\u001f');
  }

  const responseModel = item.turnResponse?.responseModel;
  return [
    item.id,
    item.kind,
    item.role,
    item.turnId,
    item.status,
    item.turnResponse?.response.status ?? '',
    item.turnResponse?.updatedAt ?? '',
    stableSmallJson(item.turnResponse?.request?.metadata ?? null),
    responseModel?.modelName ?? '',
    responseModel?.modelBillingLabel ?? '',
    responseModel?.modelRouting ?? '',
    item.contentUpdateTimings?.impliedWordLoadRate ?? '',
    item.contentUpdateTimings?.lastWordCount ?? '',
    item.parts.map(createPartRevisionSignature).join('\u001e'),
  ].join('\u001f');
}

function selectRequestPresentationMetadata(
  metadata: TurnResponseTurn['request']['metadata'] | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const presentationKeys = [
    'agentId',
    'command',
    'commandKind',
    'explicitAgentInvocation',
    'modeId',
    'modeInfo',
    'modelRouting',
    'parsedParts',
    'requestRouting',
    'userSelectedTools',
  ] as const;
  const selected: Record<string, unknown> = {};
  for (const key of presentationKeys) {
    if (metadata[key] !== undefined) {
      selected[key] = metadata[key];
    }
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

function createPartRevisionSignature(part: ChatPart): string {
  const scope = readPartScopeSignature(part);
  switch (part.type) {
    case 'markdown':
    case 'thinking':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.contentRef ?? '',
        part.contentLength ?? part.content?.length ?? 0,
        sampleTextRevision(part.content),
        part.type === 'thinking' ? (part.isComplete ? 'complete' : 'streaming') : '',
      ].join(':');
    case 'tool_call':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.toolCallId,
        part.toolName,
        part.state,
        part.text,
        stableSmallJson(part.args ?? null),
        stableSmallJson(part.metadata?.['toolSpecificData'] ?? null),
        stableSmallJson(part.metadata?.['approval'] ?? part.metadata?.['approvalRequest'] ?? null),
      ].join(':');
    case 'state':
      return [
        part.type,
        scope,
        part.stateId,
        part.kind ?? '',
        part.state,
        part.progress ?? '',
        part.text,
      ].join(':');
    case 'error':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.severity ?? '',
        part.message,
      ].join(':');
    case 'question':
      return [
        part.type,
        scope,
        part.partId ?? '',
        stableSmallJson(part.questions ?? []),
        stableSmallJson(part.answers ?? null),
        part.isHistory ? 'history' : 'live',
      ].join(':');
    case 'confirmation':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.askId,
        part.resolved ? 'resolved' : 'pending',
        part.result ?? '',
        part.scope ?? '',
        part.selectedActionId ?? '',
        part.selectedActionLabel ?? '',
      ].join(':');
    case 'terminal':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.toolCallId ?? '',
        Array.isArray(part.sourceToolCallIds) ? part.sourceToolCallIds.join(',') : '',
        part.processId ?? '',
        part.outputSessionId ?? '',
        part.terminalId ?? '',
        part.command,
        part.status ?? '',
        part.isRunning ? 'running' : 'idle',
        part.exitCode ?? '',
        part.bytesTotal ?? '',
        part.lastOutputAt ?? '',
        part.output?.length ?? 0,
        sampleTextRevision(part.output),
        part.stderr?.length ?? 0,
        sampleTextRevision(part.stderr ?? ''),
      ].join(':');
    case 'plan':
      return [
        part.type,
        scope,
        part.partId ?? '',
        part.status,
        part.source ?? '',
        part.text?.length ?? 0,
        sampleTextRevision(part.text),
        stableSmallJson(part.steps ?? null),
      ].join(':');
  }
}

function readPartScopeSignature(part: ChatPart): string {
  const scoped = part as {
    sourceAgentRole?: string;
    subAgentInvocationId?: string;
    parentToolCallId?: string;
    sequence?: number;
  };
  return [
    scoped.sourceAgentRole ?? '',
    scoped.subAgentInvocationId ?? '',
    scoped.parentToolCallId ?? '',
    scoped.sequence ?? '',
  ].join(':');
}

function sampleTextRevision(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const prefix = value.slice(0, 48);
  const suffix = value.length > 96 ? value.slice(-48) : '';
  return `${prefix}\u001d${suffix}`;
}

function stableSmallJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return String(value ?? '');
  }
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
        return nested;
      }
      return Object.keys(nested as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (nested as Record<string, unknown>)[key];
          return acc;
        }, {});
    });
  } catch {
    return '';
  }
}

function freezeChatParts(parts: readonly ChatPart[]): readonly ChatPart[] {
  return Object.freeze([...parts]);
}

function freezeItem(item: ChatVisibleTranscriptItem): ChatVisibleTranscriptItem {
  return Object.freeze({
    ...item,
    parts: freezeChatParts(item.parts),
  });
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T, index: number) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index], index)) {
      return index;
    }
  }
  return -1;
}
