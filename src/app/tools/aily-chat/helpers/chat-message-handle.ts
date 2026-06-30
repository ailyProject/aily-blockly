import {
  type ChatPartStore,
  type ChatPartStoreOpaqueHandle,
} from '../core/chat-part-store';

type ChatMessageLike = {
  role?: string;
  content: string;
  turnId?: string;
  state?: string;
  source?: string;
};

function getHostViewMsgIndex(message: object): number | undefined {
  const hostViewMsgIndex = (message as { hostViewMsgIndex?: unknown }).hostViewMsgIndex;
  return typeof hostViewMsgIndex === 'number' ? hostViewMsgIndex : undefined;
}

function hasIndexedStorePosition(handle: { msgIndex?: unknown } | null): handle is { msgIndex: number } {
  return typeof handle?.msgIndex === 'number' && handle.msgIndex >= 0;
}

function hasUsableStoreIdentity(
  handle: ({ storeKey?: object | symbol; message?: unknown; msgIndex?: unknown } & object) | null,
): boolean {
  if (!handle) {
    return false;
  }

  if (typeof handle.storeKey === 'object' || typeof handle.storeKey === 'symbol') {
    return true;
  }

  if (hasIndexedStorePosition(handle)) {
    return true;
  }

  return !!handle.message && typeof handle.message === 'object';
}

export interface OpaqueChatMessageHandle<TMessage extends ChatMessageLike = ChatMessageLike>
  extends ChatPartStoreOpaqueHandle {
  readonly message: TMessage;
}

type IndexedStoreHandle = {
  msgIndex: number;
  storeKey?: object | symbol;
};

export type ChatMessageHandle<TMessage extends ChatMessageLike = ChatMessageLike> =
  IndexedStoreHandle & {
    readonly message: TMessage;
  };

export function createOpaqueChatMessageHandle<TMessage extends ChatMessageLike>(
  message: TMessage,
): OpaqueChatMessageHandle<TMessage> {
  return { message };
}

export function createChatMessageHandle<TMessage extends ChatMessageLike>(
  message: TMessage,
  msgIndex: number,
): ChatMessageHandle<TMessage> {
  const hostViewMsgIndex = getHostViewMsgIndex(message);
  return {
    message,
    msgIndex: hostViewMsgIndex ?? msgIndex,
  };
}

export function getChatMessageHandle<TMessage extends ChatMessageLike>(
  list: readonly TMessage[],
  msgIndex: number,
): ChatMessageHandle<TMessage> | null {
  if (msgIndex < 0 || msgIndex >= list.length) {
    return null;
  }

  return createChatMessageHandle(list[msgIndex], msgIndex);
}

export function collectChatMessageHandles<TMessage extends ChatMessageLike>(
  list: readonly TMessage[],
  predicate?: (message: TMessage) => boolean,
): ChatMessageHandle<TMessage>[] {
  const handles: ChatMessageHandle<TMessage>[] = [];

  for (let msgIndex = 0; msgIndex < list.length; msgIndex++) {
    const message = list[msgIndex];
    if (predicate && !predicate(message)) {
      continue;
    }

    handles.push(createChatMessageHandle(message, msgIndex));
  }

  return handles;
}

export function findLatestChatMessageHandle<TMessage extends ChatMessageLike>(
  list: readonly TMessage[],
  predicate?: (message: TMessage, msgIndex: number) => boolean,
): ChatMessageHandle<TMessage> | null {
  for (let msgIndex = list.length - 1; msgIndex >= 0; msgIndex--) {
    const message = list[msgIndex];
    if (predicate && !predicate(message, msgIndex)) {
      continue;
    }

    return createChatMessageHandle(message, msgIndex);
  }

  return null;
}

export function findChatMessageHandleByTurnId<TMessage extends ChatMessageLike>(
  list: readonly TMessage[],
  turnId: string,
  options: { role?: string } = {},
): ChatMessageHandle<TMessage> | null {
  return findLatestChatMessageHandle(
    list,
    message => message.turnId === turnId && (!options.role || message.role === options.role),
  );
}

export function findChatMessageHandleByMessage<TMessage extends ChatMessageLike>(
  list: readonly TMessage[],
  messageRef: TMessage,
  options: { role?: string } = {},
): ChatMessageHandle<TMessage> | null {
  return findLatestChatMessageHandle(
    list,
    message => message === messageRef && (!options.role || message.role === options.role),
  );
}

export function isUsableChatMessageHandle<TMessage extends ChatMessageLike>(
  handle: ChatMessageHandle<TMessage> | null,
): handle is ChatMessageHandle<TMessage> {
  return hasUsableStoreIdentity(handle) && hasIndexedStorePosition(handle);
}

export function truncateChatMessageListFromHandle<TMessage extends ChatMessageLike>(
  list: TMessage[],
  handle: ChatMessageHandle<TMessage> | null,
): boolean {
  if (!isUsableChatMessageHandle(handle)) {
    return false;
  }

  list.splice(handle.msgIndex);
  return true;
}

export function syncChatMessageHandleContent<TMessage extends ChatMessageLike>(
  handle: OpaqueChatMessageHandle<TMessage>,
  partStore: Pick<ChatPartStore, 'serializeToContentHandle'>,
): void {
  handle.message.content = partStore.serializeToContentHandle(handle);
}

export function clearChatMessageHandleContent<TMessage extends ChatMessageLike>(
  handle: OpaqueChatMessageHandle<TMessage>,
): void {
  handle.message.content = '';
}