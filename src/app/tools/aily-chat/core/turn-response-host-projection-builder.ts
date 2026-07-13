import type { TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPartStore } from './chat-part-store';
import type { ChatPart } from './chat-parts';
import type { ChatMessageHandle, OpaqueChatMessageHandle } from '../helpers/chat-message-handle';
import {
  turnResponsePartsToDisplayChatParts,
} from './turn-response-part-mapper';
import {
  getTurnResponseParticipant,
  getTurnResponseResponseText,
  toTurnResponseHostMessageState,
} from './turn-response-stream-contract';

export interface TurnResponseProjectionMessage {
  content: string;
  turnId?: string;
  state?: string;
  source?: string;
}

export type TurnResponseProjectionHandle<
  TMessage extends TurnResponseProjectionMessage = TurnResponseProjectionMessage,
> = ChatMessageHandle<TMessage> | OpaqueChatMessageHandle<TMessage>;

export interface IncrementalTurnResponsePartSource {
  projectPendingPartsTo(
    targetStore: TurnResponseIncrementalProjectionStore,
    targetHandle: TurnResponseProjectionHandle | null,
  ): boolean;
}

type TurnResponseIncrementalProjectionStore = Pick<
  ChatPartStore,
  'projectPartChangesFromHandle'
>;

type TurnResponseProjectionStore = Pick<
  ChatPartStore,
  'addPartToHandle' | 'clearMessageHandle' | 'getPartsForHandle' | 'projectPartChangesFromHandle' | 'serializeToContentHandle'
>;

export class TurnResponseHostProjectionBuilder {
  constructor(private readonly partStore: TurnResponseProjectionStore) {}

  private resolveProjectedContent(
    handle: TurnResponseProjectionHandle,
    turn: Pick<TurnResponseTurn, 'response'>,
  ): string {
    const serializedContent = this.partStore.serializeToContentHandle(handle);
    if (serializedContent) {
      return serializedContent;
    }

    return getTurnResponseResponseText(turn.response);
  }

  clearHandle<TMessage extends TurnResponseProjectionMessage>(
    handle: TurnResponseProjectionHandle<TMessage> | null,
    options: { clearContent?: boolean } = {},
  ): void {
    if (!handle) {
      return;
    }

    this.partStore.clearMessageHandle(handle);
    if (options.clearContent !== false) {
      handle.message.content = '';
    }
  }

  syncMessageMeta<TMessage extends TurnResponseProjectionMessage>(
    handle: TurnResponseProjectionHandle<TMessage> | null,
    turn: Pick<TurnResponseTurn, 'turnId' | 'response'>,
  ): boolean {
    if (!handle) {
      return false;
    }

    const nextState = toTurnResponseHostMessageState(turn.response.status);
    const nextSource = getTurnResponseParticipant(turn.response.participant);
    const changed = handle.message.turnId !== turn.turnId
      || handle.message.state !== nextState
      || handle.message.source !== nextSource;

    handle.message.turnId = turn.turnId;
    handle.message.state = nextState;
    handle.message.source = nextSource;
    return changed;
  }

  projectIncrementalParts<TMessage extends TurnResponseProjectionMessage>(
    handle: TurnResponseProjectionHandle<TMessage> | null,
    source: IncrementalTurnResponsePartSource,
    options: { syncContent?: boolean } = {},
  ): boolean {
    if (!handle) {
      return false;
    }

    const changed = source.projectPendingPartsTo(this.partStore, handle);
    if (options.syncContent) {
      handle.message.content = this.partStore.serializeToContentHandle(handle);
    }

    return changed;
  }

  projectTurn<TMessage extends TurnResponseProjectionMessage>(
    handle: TurnResponseProjectionHandle<TMessage> | null,
    turn: Pick<TurnResponseTurn, 'turnId' | 'response'>,
    options: { preserveInteractiveState?: boolean; syncContent?: boolean } = {},
  ): boolean {
    if (!handle) {
      return false;
    }

    const existingParts = options.preserveInteractiveState
      ? [...this.partStore.getPartsForHandle(handle)]
      : [];

    this.partStore.clearMessageHandle(handle);
    const changed = this.syncMessageMeta(handle, turn);

    const chatParts = turnResponsePartsToDisplayChatParts(turn.response.parts);
    const existingPartsByKey = options.preserveInteractiveState
      ? new Map(existingParts.map(part => [getDisplayChatPartKey(part), part]).filter((entry): entry is [string, ChatPart] => !!entry[0]))
      : null;
    for (const chatPart of chatParts) {
      const existingPart = existingPartsByKey?.get(getDisplayChatPartKey(chatPart));
      this.partStore.addPartToHandle(
        handle,
        existingPart && existingPart.type === chatPart.type
          ? mergeInteractiveDisplayState(chatPart, existingPart)
          : chatPart,
      );
    }

    if (options.syncContent !== false) {
      handle.message.content = this.resolveProjectedContent(handle, turn);
    }

    return changed;
  }
}

function mergeInteractiveDisplayState(
  nextPart: ChatPart,
  existingPart: ChatPart,
): ChatPart {
  if (nextPart.type === 'question' && existingPart.type === 'question' && !nextPart.answers && existingPart.answers) {
    return {
      ...nextPart,
      answers: { ...existingPart.answers },
    };
  }

  if (nextPart.type === 'confirmation' && existingPart.type === 'confirmation') {
    return {
      ...nextPart,
      resolved: nextPart.resolved || existingPart.resolved,
      result: nextPart.result ?? existingPart.result,
      scope: nextPart.scope ?? existingPart.scope,
    };
  }

  return nextPart;
}

function getDisplayChatPartKey(part: ChatPart): string {
  switch (part.type) {
    case 'tool_call':
      return `tool:${part.toolCallId}`;
    case 'terminal':
      return part.partId
        || part.processId
        || part.outputSessionId
        || part.terminalId
        || (part.toolCallId ? `terminal:${part.toolCallId}` : '');
    case 'question':
      return part.partId || `question:${part.questions.map(question => question.question).join('\u0000')}`;
    case 'confirmation':
      return part.partId || `confirmation:${part.askId}`;
    case 'state':
      return `state:${part.stateId}`;
    case 'markdown':
    case 'thinking':
    case 'plan':
    case 'error':
      return part.partId || '';
  }
}
