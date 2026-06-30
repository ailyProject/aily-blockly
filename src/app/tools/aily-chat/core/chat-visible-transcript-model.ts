import type { TurnResponsePart, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPart } from './chat-parts';
import {
  hydrateQuestionAnswersFromAskUserToolMetadata,
  turnResponsePartToChatParts,
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
  readonly revision: number;
  readonly responseVote?: 0 | 1;
  readonly isLastAily: boolean;
  readonly isFirstUserTurn: boolean;
  readonly showCheckpointRestore: boolean;
}

export interface ChatVisibleTranscriptRuntimeOverlay {
  readonly turnResponses: readonly TurnResponseTurn[];
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
  private orderedIds: string[] = [];
  private readonly changes: ChatVisibleTranscriptChange[] = [];

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
        this.records.delete(itemId);
        this.dialogItemCache.delete(itemId);
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
    const item = this.upsertItem({
      id: chatVisibleResponseItemId(turn.turnId),
      kind: 'response',
      role: 'aily',
      turnId: turn.turnId,
      status: turn.response.status,
      contentPreview: getTurnResponseAssistantText(turn),
      parts: turnResponsePartsToChatParts(turn.response.parts),
      turnResponse: turn,
      turnContext: buildDialogTurnContext({ turnResponse: turn }),
    });
    if (options.recordOrder) {
      this.ensureOrderedItem(item.id);
    }
    return item;
  }

  upsertResponsePart(turnId: string, part: TurnResponsePart): ChatVisibleTranscriptItem {
    const responseId = chatVisibleResponseItemId(turnId);
    const existing = this.records.get(responseId)?.item;
    if (!existing) {
      throw new Error(`Cannot upsert response part before response item exists: ${turnId}`);
    }

    const nextParts = mergeChatParts(existing.parts, turnResponsePartsToChatParts([part]));
    return this.upsertItem({
      id: existing.id,
      kind: 'response',
      role: 'aily',
      turnId: existing.turnId,
      status: existing.status,
      contentPreview: existing.contentPreview,
      parts: nextParts,
      turnResponse: existing.turnResponse,
      turnContext: existing.turnContext,
    });
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
    });
    this.pushChange('completed', item.id);
    return item;
  }

  toDialogItems(): readonly ChatVisibleTranscriptDialogItem[] {
    const items = this.getItems();
    const firstUserIndex = items.findIndex(item => item.role === 'user');
    const lastAilyIndex = findLastIndex(items, item => item.role === 'aily' && !!item.turnContext?.turnResponse);

    return items.map((item, index) => this.toDialogItem(item, {
      isLastAily: index === lastAilyIndex,
      isFirstUserTurn: index === firstUserIndex,
    }));
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
      parts: cloneChatParts(props.parts),
      revision: (existingRecord?.item.revision ?? 0) + 1,
    });
    this.records.set(props.id, { item, signature });
    this.pushChange(existingRecord ? 'updated' : 'added', props.id);
    return item;
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
  const merged = [...existing];
  for (const part of incoming) {
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

function turnResponsePartsToChatParts(parts: readonly TurnResponsePart[]): readonly ChatPart[] {
  return hydrateQuestionAnswersFromAskUserToolMetadata(parts)
    .flatMap(part => turnResponsePartToChatParts(part));
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
  return JSON.stringify({
    id: item.id,
    kind: item.kind,
    role: item.role,
    turnId: item.turnId,
    status: item.status,
    contentPreview: item.contentPreview,
    turnResponseStatus: item.turnResponse?.response.status,
    turnResponseUpdatedAt: item.turnResponse?.updatedAt,
    requestMetadata: item.turnResponse?.request?.metadata,
    responseModel: item.turnResponse?.responseModel
      ? {
        modelName: item.turnResponse.responseModel.modelName,
        modelBillingLabel: item.turnResponse.responseModel.modelBillingLabel,
        modelRouting: item.turnResponse.responseModel.modelRouting,
      }
      : undefined,
    parts: item.parts.map(part => ({
      key: getChatPartStableKey(part),
      value: part,
    })),
  });
}

function cloneChatParts(parts: readonly ChatPart[]): readonly ChatPart[] {
  return Object.freeze(parts.map(cloneChatPart));
}

function cloneChatPart(part: ChatPart): ChatPart {
  return { ...part } as ChatPart;
}

function freezeItem(item: ChatVisibleTranscriptItem): ChatVisibleTranscriptItem {
  return Object.freeze({
    ...item,
    parts: cloneChatParts(item.parts),
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
