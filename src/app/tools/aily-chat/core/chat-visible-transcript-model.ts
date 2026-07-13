import type { TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPart } from './chat-parts';
import {
  turnResponsePartsToDisplayChatParts,
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
  private orderedIds: string[] = [];
  private readonly changes: ChatVisibleTranscriptChange[] = [];
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

  replaceFromSessionModel(turnResponses: readonly TurnResponseTurn[] | null | undefined): readonly ChatVisibleTranscriptChange[] {
    const nextIds: string[] = [];
    const expectedIds = new Set<string>();

    for (const turn of turnResponses ?? []) {
      const request = this.upsertTurnRequestInternal(turn, { recordOrder: false });
      const response = this.upsertTurnResponseInternal(turn, { recordOrder: false });
      nextIds.push(request.id, response.id);
      expectedIds.add(request.id);
      expectedIds.add(response.id);
    }

    for (const itemId of [...this.records.keys()]) {
      if (!expectedIds.has(itemId)) {
        const removedTurnId = this.records.get(itemId)?.item.turnId;
        this.records.delete(itemId);
        this.dialogItemCache.delete(itemId);
        if (removedTurnId && !expectedIds.has(chatVisibleResponseItemId(removedTurnId))) {
          this.streamStatsTrackers.delete(removedTurnId);
        }
        this.pushChange('removed', itemId);
      }
    }

    this.orderedIds = nextIds;
    return this.peekChanges();
  }

  attachRuntimeOverlay(runtimeState: ChatVisibleTranscriptRuntimeOverlay | null | undefined): readonly ChatVisibleTranscriptChange[] {
    return this.replaceFromSessionModel(runtimeState?.turnResponses ?? []);
  }

  upsertTurnRequest(turn: TurnResponseTurn): ChatVisibleTranscriptItem {
    return this.upsertTurnRequestInternal(turn, { recordOrder: true });
  }

  private upsertTurnRequestInternal(
    turn: TurnResponseTurn,
    options: { recordOrder: boolean },
  ): ChatVisibleTranscriptItem {
    const item = this.upsertItem({
      id: chatVisibleRequestItemId(turn.turnId),
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
      this.ensureOrderedItem(item.id);
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
    const parts = turnResponsePartsToChatParts(turn.response.parts);
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
        collectChatPartStreamingText(parts, contentPreview),
      ),
    });
    if (options.recordOrder) {
      this.ensureOrderedItem(item.id);
    }
    return item;
  }

  upsertResponsePart(turnId: string, part: TurnResponsePart): ChatVisibleTranscriptItem {
    return this.upsertResponseParts(turnId, [part]);
  }

  upsertResponseParts(turnId: string, parts: readonly TurnResponsePart[]): ChatVisibleTranscriptItem {
    const responseId = chatVisibleResponseItemId(turnId);
    const existing = this.records.get(responseId)?.item;
    if (!existing) {
      throw new Error(`Cannot upsert response part before response item exists: ${turnId}`);
    }

    const nextParts = mergeChatParts(existing.parts, turnResponsePartsToChatParts(parts));
    const contentPreview = collectChatPartAssistantPreview(nextParts, existing.contentPreview);
    return this.upsertItem({
      id: existing.id,
      kind: 'response',
      role: 'aily',
      turnId: existing.turnId,
      status: existing.status,
      contentPreview,
      parts: nextParts,
      turnResponse: existing.turnResponse,
      turnContext: existing.turnContext,
      contentUpdateTimings: this.updateStreamStats(
        turnId,
        existing.status,
        collectChatPartStreamingText(nextParts, contentPreview),
      ),
    });
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

    let firstUserIndex = -1;
    let lastAilyIndex = -1;
    const indexByItemId = new Map<string, number>();
    for (let index = 0; index < this.orderedIds.length; index += 1) {
      const itemId = this.orderedIds[index];
      indexByItemId.set(itemId, index);
      const item = this.records.get(itemId)?.item;
      if (!item) {
        continue;
      }
      if (firstUserIndex < 0 && item.role === 'user') {
        firstUserIndex = index;
      }
      if (item.role === 'aily' && !!item.turnContext?.turnResponse) {
        lastAilyIndex = index;
      }
    }

    const firstUserItemId = firstUserIndex >= 0 ? this.orderedIds[firstUserIndex] : null;
    const lastAilyItemId = lastAilyIndex >= 0 ? this.orderedIds[lastAilyIndex] : null;

    // List presentation state belongs to the stable row model as well. When a
    // new turn is appended, update only the row that previously owned the
    // first/last presentation flag instead of rescanning or rebuilding rows.
    if (this.projectedFirstUserItemId
      && this.projectedFirstUserItemId !== firstUserItemId
      && indexByItemId.has(this.projectedFirstUserItemId)) {
      uniqueChanges.set(this.projectedFirstUserItemId, 'updated');
    }
    if (this.projectedLastAilyItemId
      && this.projectedLastAilyItemId !== lastAilyItemId
      && indexByItemId.has(this.projectedLastAilyItemId)) {
      uniqueChanges.set(this.projectedLastAilyItemId, 'updated');
    }

    const patches: ChatVisibleTranscriptDialogItemPatch[] = [];
    for (const [itemId, kind] of uniqueChanges) {
      const index = indexByItemId.get(itemId) ?? -1;
      const item = index >= 0 ? this.records.get(itemId)?.item : undefined;
      if (!item) {
        continue;
      }
      patches.push({
        itemId,
        index,
        kind,
        item: this.toDialogItem(item, {
          isLastAily: index === lastAilyIndex,
          isFirstUserTurn: index === firstUserIndex,
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
      contentPreview: existing.contentPreview,
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
      contentUpdateTimings: this.updateStreamStats(
        turnId,
        status,
        collectChatPartStreamingText(existing.parts, existing.contentPreview),
      ) ?? existing.contentUpdateTimings,
    });
    this.pushChange('completed', item.id);
    return item;
  }

  toDialogItems(): readonly ChatVisibleTranscriptDialogItem[] {
    const items = this.getItems();
    const firstUserIndex = items.findIndex(item => item.role === 'user');
    const lastAilyIndex = findLastIndex(items, item => item.role === 'aily' && !!item.turnContext?.turnResponse);

    this.projectedFirstUserItemId = firstUserIndex >= 0 ? items[firstUserIndex].id : null;
    this.projectedLastAilyItemId = lastAilyIndex >= 0 ? items[lastAilyIndex].id : null;

    return items.map((item, index) => this.toDialogItem(item, {
      isLastAily: index === lastAilyIndex,
      isFirstUserTurn: index === firstUserIndex,
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
    markdown: string,
  ): ChatStreamStats | undefined {
    let tracker = this.streamStatsTrackers.get(turnId);
    if (!tracker && status === 'streaming') {
      tracker = new ChatStreamStatsTracker();
      this.streamStatsTrackers.set(turnId, tracker);
    }
    if (!tracker) {
      return undefined;
    }

    tracker.update(countChatMarkdownWords(markdown));
    return tracker.data;
  }

  private ensureOrderedItem(itemId: string): void {
    if (!this.orderedIds.includes(itemId)) {
      this.orderedIds = [...this.orderedIds, itemId];
    }
  }

  private pushChange(kind: ChatVisibleTranscriptChangeKind, itemId: string): void {
    this.changes.push({ kind, itemId });
  }
}

function mergeChatParts(existing: readonly ChatPart[], incoming: readonly ChatPart[]): readonly ChatPart[] {
  let merged = [...existing];
  for (const part of incoming) {
    if (part.type === 'terminal') {
      merged = removeTerminalOwnedInvocationParts(merged, part);
    }
    const key = getChatPartStableKey(part);
    const existingIndex = key
      ? merged.findIndex(candidate => getChatPartStableKey(candidate) === key)
      : -1;
    if (existingIndex >= 0) {
      merged[existingIndex] = cloneChatPart(part);
    } else {
      merged.push(cloneChatPart(part));
    }
  }
  return merged;
}

function removeTerminalOwnedInvocationParts(parts: readonly ChatPart[], terminal: Extract<ChatPart, { type: 'terminal' }>): ChatPart[] {
  const toolCallIds = new Set<string>([
    terminal.toolCallId,
    ...(Array.isArray(terminal.sourceToolCallIds) ? terminal.sourceToolCallIds : []),
  ].filter((value): value is string => !!value));
  if (toolCallIds.size === 0) {
    return [...parts];
  }
  return parts.filter(part => {
    if (part.type === 'tool_call' && toolCallIds.has(part.toolCallId)) {
      return false;
    }
    if (part.type === 'confirmation' && (toolCallIds.has(part.askId) || (part.partId && toolCallIds.has(part.partId.replace(/^confirmation:/, ''))))) {
      return false;
    }
    return true;
  });
}

function collectChatPartAssistantPreview(parts: readonly ChatPart[], fallback: string): string {
  const content = parts
    .filter((part): part is Extract<ChatPart, { type: 'markdown' }> => part.type === 'markdown' && part.sourceAgentRole !== 'subagent')
    .map(part => part.content)
    .join('');
  return content || fallback;
}

function collectChatPartStreamingText(parts: readonly ChatPart[], fallback: string): string {
  const content = parts
    .filter((part): part is Extract<ChatPart, { type: 'markdown' | 'thinking' }> => (
      part.type === 'markdown' || part.type === 'thinking'
    ))
    .map(part => part.content)
    .join('');
  return content || fallback;
}

function turnResponsePartsToChatParts(parts: readonly TurnResponsePart[]): readonly ChatPart[] {
  return turnResponsePartsToDisplayChatParts(parts);
}

function getChatPartStableKey(part: ChatPart): string | undefined {
  switch (part.type) {
    case 'markdown':
    case 'thinking':
    case 'question':
    case 'confirmation':
    case 'terminal':
    case 'plan':
      return part.partId;
    case 'tool_call':
      return part.partId ?? `tool:${part.toolCallId}`;
    case 'state':
      return `state:${part.stateId}`;
    case 'error':
      return part.partId;
  }
}

function createItemSignature(item: Omit<ChatVisibleTranscriptItem, 'revision'>): string {
  const responseModel = item.turnResponse?.responseModel;
  return [
    item.id,
    item.kind,
    item.role,
    item.turnId,
    item.status,
    item.contentPreview,
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

function cloneChatPart(part: ChatPart): ChatPart {
  return { ...part } as ChatPart;
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
