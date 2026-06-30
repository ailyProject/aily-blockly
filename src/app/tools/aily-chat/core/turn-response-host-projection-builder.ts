import type { TurnResponseTurn } from 'aily-lex/browser';

import type { ChatPartStore } from './chat-part-store';
import type { ChatMessageHandle, OpaqueChatMessageHandle } from '../helpers/chat-message-handle';
import {
  hydrateQuestionAnswersFromAskUserToolMetadata,
  turnResponsePartToChatParts,
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

    const hydratedParts = hydrateQuestionAnswersFromAskUserToolMetadata(turn.response.parts);
    for (let partIndex = 0; partIndex < hydratedParts.length; partIndex++) {
      const part = hydratedParts[partIndex];
      const chatParts = turnResponsePartToChatParts(
        part,
        options.preserveInteractiveState ? existingParts[partIndex] : undefined,
      );
      for (const chatPart of chatParts) {
        this.partStore.addPartToHandle(handle, chatPart);
      }
    }

    if (options.syncContent !== false) {
      handle.message.content = this.resolveProjectedContent(handle, turn);
    }

    return changed;
  }
}
