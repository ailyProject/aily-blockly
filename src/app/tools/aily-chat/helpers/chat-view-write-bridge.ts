import type {
  IAgentLifecycle,
  IChatServiceAccess,
  IChatViewAccess,
  IProjectContext,
  ISessionAccess,
} from '../core/chat-context';
import type { ChatPart, ConfirmationPart, QuestionPart } from '../core/chat-parts';
import { buildPendingToolCallApprovalMetadata, buildResolvedToolCallApprovalMetadata } from '../core/tool-call-approval';
import { getTurnResponseParticipant } from '../core/turn-response-stream-contract';
import { deserializeContentToParts } from '../core/content-deserializer';
import { markContentAsHistory as _markContentAsHistory } from '../services/content-sanitizer.service';
import type { ToolApprovalRequest } from './tool-approval-ui';
import type { ChatViewAdapter } from '../services/chat-view-adapter';
import {
  clearChatMessageHandleContent,
  collectChatMessageHandles,
  createOpaqueChatMessageHandle,
  findChatMessageHandleByMessage,
  getChatMessageHandle,
  findChatMessageHandleByTurnId,
  findLatestChatMessageHandle,
  isUsableChatMessageHandle,
  syncChatMessageHandleContent,
  truncateChatMessageListFromHandle,
  type ChatMessageHandle,
  type OpaqueChatMessageHandle,
} from './chat-message-handle';
import { buildChatListFromEntries, buildTurnNativeRestoreChatListFromEntries, type HostResponseEntry } from './host-turn-response-state';

import type { ChatListItem } from '../services/chat-history.service';

export type ChatViewWriteBridgeContext = Pick<
  IChatViewAccess,
  'list' | 'partStore' | 'viewAdapter' | 'scrollManager' | 'invalidateHostRequestGraph' | 'triggerSyncDetectChanges'
> & Pick<ISessionAccess, 'sessionId'>
  & Pick<IProjectContext, 'currentModelName' | 'currentModelBillingLabel'>
  & Pick<IAgentLifecycle, 'currentMessageSource'>
  & Pick<IChatServiceAccess, 'ngZone'>
  & {
    markCurrentViewVisibleProjectionOwner: () => void;
    markHistoryDirty: (sessionId: string) => void;
    readonly legacyListProjectionBoundary?: 'history-import' | 'edit-action-result' | 'session-restore';
  };

type ChatViewWriteListAccess = Pick<
  ChatViewWriteBridgeContext,
  'list' | 'scrollManager' | 'triggerSyncDetectChanges' | 'currentModelName' | 'currentModelBillingLabel' | 'currentMessageSource' | 'markCurrentViewVisibleProjectionOwner'
>;

type ChatViewWriteStoreAccess = Pick<
  ChatViewWriteBridgeContext,
  'partStore'
>;

type ChatViewWriteHistoryAccess = Pick<
  ChatViewWriteBridgeContext,
  'sessionId' | 'markHistoryDirty'
>;

type ChatViewWriteAdapterAccess = Pick<
  ChatViewAdapter,
  'reset' | 'requestChangeDetection'
>;

type ChatViewWriteViewSyncAccess = Pick<
  ChatViewWriteBridgeContext,
  'invalidateHostRequestGraph' | 'ngZone'
> & {
  viewAdapter: ChatViewWriteAdapterAccess;
};

type ChatViewWriteHistoryRestoreAccess = Pick<ChatViewWriteListAccess, 'list'>
  & ChatViewWriteStoreAccess
  & Pick<ChatViewWriteListAccess, 'markCurrentViewVisibleProjectionOwner'>
  & Pick<ChatViewWriteViewSyncAccess, 'ngZone' | 'viewAdapter'>;

type ChatViewWriteMutationAccess = Pick<
  ChatViewWriteListAccess,
  'list' | 'scrollManager' | 'triggerSyncDetectChanges'
> & ChatViewWriteStoreAccess & ChatViewWriteHistoryAccess;

type ChatViewWriteResetAccess = Pick<
  ChatViewWriteListAccess,
  'list' | 'triggerSyncDetectChanges' | 'markCurrentViewVisibleProjectionOwner'
> & ChatViewWriteStoreAccess & Pick<ChatViewWriteViewSyncAccess, 'invalidateHostRequestGraph' | 'viewAdapter'>;

type ChatViewWriteMessageHandleAccess = Pick<
  ChatViewWriteListAccess,
  'list' | 'scrollManager' | 'triggerSyncDetectChanges' | 'currentModelName' | 'currentModelBillingLabel' | 'currentMessageSource' | 'markCurrentViewVisibleProjectionOwner'
> & ChatViewWriteStoreAccess;

class ChatViewHistoryRestoreHelper {
  constructor(
    private readonly access: ChatViewWriteHistoryRestoreAccess,
    private readonly appendPartsFromBoundaryHandle: (
      handle: ChatMessageHandle<ChatListItem>,
      parts: readonly ChatPart[],
    ) => void,
  ) {}

  restoreLegacyHistoryList(chatList: readonly ChatListItem[]): void {
    this.setHistoryList(chatList.map(item => {
      if (item.content && typeof item.content === 'string') {
        return { ...item, content: _markContentAsHistory(item.content) };
      }
      return item;
    }));
    this.hydrateAilyHistoryParts({ treatContentAsHistory: false });
  }

  restoreTurnNativeHistoryList(
    chatList: readonly ChatListItem[],
    turnIds: ReadonlySet<string>,
  ): void {
    this.setHistoryList(chatList);
    this.hydrateAilyHistoryParts({
      shouldHydrate: handle => !handle.message.turnId || !turnIds.has(handle.message.turnId),
    });
  }

  private setHistoryList(chatList: readonly ChatListItem[]): void {
    this.access.markCurrentViewVisibleProjectionOwner();
    this.access.viewAdapter.reset?.();
    this.access.list = chatList.map(item => ({ ...item }));
  }

  private hydrateAilyHistoryParts(options: {
    shouldHydrate?: (handle: ChatMessageHandle<ChatListItem>) => boolean;
    treatContentAsHistory?: boolean;
    resetStore?: boolean;
    notifyView?: boolean;
  } = {}): void {
    if (options.resetStore !== false) {
      this.access.partStore.reset();
    }

    const treatContentAsHistory = options.treatContentAsHistory !== false;
    for (const handle of collectChatMessageHandles(this.access.list, message => message.role === 'aily')) {
      if (options.shouldHydrate && !options.shouldHydrate(handle)) {
        continue;
      }

      const message = handle.message;
      if (message.role !== 'aily' || typeof message.content !== 'string' || !message.content) {
        continue;
      }

      const nextContent = treatContentAsHistory ? _markContentAsHistory(message.content) : message.content;
      message.content = nextContent;

      const parts = deserializeContentToParts(nextContent);
      if (parts.length === 0) {
        this.access.partStore.addPartToHandle(handle, { type: 'markdown', content: nextContent });
      } else {
        this.appendPartsFromBoundaryHandle(handle, parts);
      }
    }

    if (options.notifyView !== false) {
      this.access.ngZone.run(() => {
        this.access.viewAdapter.requestChangeDetection?.();
      });
    }
  }
}

class ChatViewPartMutationHelper {
  constructor(
    private readonly access: ChatViewWriteMutationAccess,
    private readonly resolveWriteHandle: (
      handle: ChatMessageHandle<ChatListItem>,
    ) => ChatMessageHandle<ChatListItem> | OpaqueChatMessageHandle<ChatListItem>,
    private readonly findLatestAilyPartsMessageHandle: () => OpaqueChatMessageHandle<ChatListItem> | null,
    private readonly findLatestIndexedAilyPartsMessageHandle: () => ChatMessageHandle<ChatListItem> | null,
    private readonly findLatestMatchingMessageHandle: (
      role: string,
      source?: string,
    ) => ChatMessageHandle<ChatListItem> | null,
    private readonly toOpaqueMessageHandle: (
      handle: ChatMessageHandle<ChatListItem>,
    ) => OpaqueChatMessageHandle<ChatListItem>,
    private readonly ensureTrailingAilyPartsMessageHandle: (
      options?: {
        source?: string;
        state?: 'doing' | 'done';
        scrollOnCreate?: boolean;
        forceNew?: boolean;
        turnId?: string;
      },
    ) => ChatMessageHandle<ChatListItem>,
    private readonly appendPartsFromBoundaryHandle: (
      handle: ChatMessageHandle<ChatListItem>,
      parts: readonly ChatPart[],
    ) => void,
    private readonly syncMessageContent: (handle: ChatMessageHandle<ChatListItem>) => boolean,
    private readonly markHistoryDirty: (markDirty: boolean | undefined) => void,
  ) {}

  appendPartToHandle(
    handle: ChatMessageHandle<ChatListItem>,
    part: ChatPart,
    options: {
      state?: 'doing' | 'done';
      markDirty?: boolean;
    } = {},
  ): boolean {
    if (!isUsableChatMessageHandle(handle)) {
      return false;
    }

    this.access.partStore.addPartToHandle(this.resolveWriteHandle(handle), part);
    if (options.state) {
      handle.message.state = options.state;
    }
    this.syncMessageContent(handle);
    this.access.triggerSyncDetectChanges();
    this.markHistoryDirty(options.markDirty);
    return true;
  }

  appendMarkdownToHandle(
    handle: ChatMessageHandle<ChatListItem>,
    text: string,
    options: { markDirty?: boolean } = {},
  ): boolean {
    if (!isUsableChatMessageHandle(handle)) {
      return false;
    }

    this.access.partStore.appendToMarkdownHandle(this.resolveWriteHandle(handle), text);
    this.syncMessageContent(handle);
    this.access.triggerSyncDetectChanges();
    this.markHistoryDirty(options.markDirty);
    return true;
  }

  updateQuestionAnswersByPartId(
    answers: QuestionPart['answers'],
    partId: string,
    options: { markDirty?: boolean } = {},
  ): boolean {
    const opaqueHandle = this.access.partStore.findQuestionOpaqueHandle(partId);
    if (!opaqueHandle || typeof opaqueHandle.storeKey !== 'object') {
      return false;
    }

    const handle = findChatMessageHandleByMessage(this.access.list, opaqueHandle.storeKey as ChatListItem, { role: 'aily' });
    if (!handle) {
      return false;
    }

    const updated = this.access.partStore.updateQuestionAnswersForHandle(handle, answers, partId);
    if (updated) {
      this.syncMessageContent(handle);
      this.access.triggerSyncDetectChanges();
      this.markHistoryDirty(options.markDirty);
    }
    return updated;
  }

  updateConfirmationResultByPartId(
    partId: string,
    next: {
      resolved: boolean;
      result?: ConfirmationPart['result'];
      scope?: ConfirmationPart['scope'];
    },
    options: { markDirty?: boolean } = {},
  ): boolean {
    const opaqueHandle = this.access.partStore.findConfirmationOpaqueHandle(partId);
    if (!opaqueHandle || typeof opaqueHandle.storeKey !== 'object') {
      return false;
    }

    const handle = findChatMessageHandleByMessage(this.access.list, opaqueHandle.storeKey as ChatListItem, { role: 'aily' });
    if (!handle) {
      return false;
    }

    const updated = this.access.partStore.updateConfirmationResultForHandle(handle, partId, next);
    if (updated) {
      this.syncMessageContent(handle);
      this.access.triggerSyncDetectChanges();
      this.markHistoryDirty(options.markDirty);
    }
    return updated;
  }

  updateToolCallApprovalRequestByToolCallId(
    request: ToolApprovalRequest,
    options: { markDirty?: boolean } = {},
  ): boolean {
    const opaqueHandle = this.access.partStore.findToolCallOpaqueHandle(request.toolCallId);
    if (!opaqueHandle || typeof opaqueHandle.storeKey !== 'object') {
      return false;
    }

    const handle = findChatMessageHandleByMessage(this.access.list, opaqueHandle.storeKey as ChatListItem, { role: 'aily' });
    if (!handle) {
      return false;
    }

    const updated = this.access.partStore.patchToolCallForHandle(handle, request.toolCallId, {
      state: 'pending_approval',
      text: request.message || `${request.toolName} requires approval`,
      args: request.args,
      metadata: {
        approval: buildPendingToolCallApprovalMetadata({
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          message: request.message,
          source: request.source,
          title: request.title,
          subtitle: request.subtitle,
          actions: request.actions,
          primaryScope: request.primaryScope,
          args: request.args,
        }),
      },
    });

    if (updated) {
      this.syncMessageContent(handle);
      this.access.triggerSyncDetectChanges();
      this.markHistoryDirty(options.markDirty);
    }
    return updated;
  }

  resolveToolCallApprovalByToolCallId(
    toolCallId: string,
    next: {
      approved: boolean;
      scope?: ConfirmationPart['scope'];
    },
    options: { markDirty?: boolean } = {},
  ): boolean {
    const opaqueHandle = this.access.partStore.findToolCallOpaqueHandle(toolCallId);
    if (!opaqueHandle || typeof opaqueHandle.storeKey !== 'object') {
      return false;
    }

    const handle = findChatMessageHandleByMessage(this.access.list, opaqueHandle.storeKey as ChatListItem, { role: 'aily' });
    if (!handle) {
      return false;
    }

    const updated = this.access.partStore.patchToolCallForHandle(handle, toolCallId, {
      state: next.approved ? 'doing' : 'error',
      metadata: {
        approval: buildResolvedToolCallApprovalMetadata({
          toolCallId,
          result: next.approved ? 'approved' : 'rejected',
          scope: next.scope,
        }),
      },
    });

    if (updated) {
      this.syncMessageContent(handle);
      this.access.triggerSyncDetectChanges();
      this.markHistoryDirty(options.markDirty);
    }
    return updated;
  }

  appendMarkdownToLatestPartsMessage(role: string, text: string, source?: string): boolean {
    const handle = this.findLatestMatchingMessageHandle(role, source);
    if (!handle || !this.access.partStore.hasPartsForHandle(handle)) {
      return false;
    }

    this.access.partStore.appendToMarkdownHandle(this.toOpaqueMessageHandle(handle), text);
    return true;
  }

  appendAilyPartsMessageHandle(
    parts: readonly ChatPart[],
    options: {
      scroll?: boolean;
      source?: string;
      state?: 'doing' | 'done';
      markDirty?: boolean;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    const handle = this.ensureTrailingAilyPartsMessageHandle({
      source: options.source,
      state: options.state ?? 'done',
      scrollOnCreate: false,
      forceNew: true,
    });

    this.appendPartsFromBoundaryHandle(handle, parts);
    this.syncMessageContent(handle);
    this.access.triggerSyncDetectChanges();

    if (options.scroll) {
      this.access.scrollManager.setScrollLock(true);
      this.access.scrollManager.scrollToBottom();
    }

    if (options.markDirty !== false && this.access.sessionId) {
      this.access.markHistoryDirty(this.access.sessionId);
    }

    return handle;
  }
}

class ChatViewResetHelper {
  constructor(private readonly access: ChatViewWriteResetAccess) {}

  clearChatView(options: { detectChanges?: boolean } = {}): void {
    this.access.invalidateHostRequestGraph();
    this.access.viewAdapter.reset?.();
    this.access.markCurrentViewVisibleProjectionOwner();
    this.access.list = [];
    this.access.partStore.reset();

    if (options.detectChanges !== false) {
      this.access.triggerSyncDetectChanges();
    }
  }

  findTurnStartHandle(turnId: string): ChatMessageHandle<ChatListItem> | null {
    return findChatMessageHandleByTurnId(this.access.list, turnId, { role: 'user' })
      ?? findChatMessageHandleByTurnId(this.access.list, turnId);
  }

  truncateFromHandle(handle: ChatMessageHandle<ChatListItem> | null): boolean {
    if (!isUsableChatMessageHandle(handle)) {
      return false;
    }

    this.access.partStore.clearMessagesAtOrAfterHandle(handle);
    this.access.markCurrentViewVisibleProjectionOwner();
    truncateChatMessageListFromHandle(this.access.list, handle);
    this.access.triggerSyncDetectChanges();
    return true;
  }

  truncateFromTurnId(turnId: string): boolean {
    return this.truncateFromHandle(this.findTurnStartHandle(turnId));
  }

  truncateFrom(fromIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.access.list.length) {
      return false;
    }

    return this.truncateFromHandle(getChatMessageHandle(this.access.list, fromIndex));
  }
}

class ChatViewMessageHandleHelper {
  constructor(private readonly access: ChatViewWriteMessageHandleAccess) {}

  getMessageHandles(role?: string): ChatMessageHandle<ChatListItem>[] {
    return collectChatMessageHandles(this.access.list, message => !role || message.role === role);
  }

  findMessageHandleByTurnId(
    turnId: string,
    options: { role?: string } = {},
  ): ChatMessageHandle<ChatListItem> | null {
    return findChatMessageHandleByTurnId(this.access.list, turnId, options);
  }

  ensureTrailingAilyPartsMessageHandle(
    options: {
      source?: string;
      state?: 'doing' | 'done';
      scrollOnCreate?: boolean;
      forceNew?: boolean;
      turnId?: string;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    const msgSource = getTurnResponseParticipant(options.source ?? this.access.currentMessageSource);
    const trailingHandle = findLatestChatMessageHandle(this.access.list);
    const lastMessage = trailingHandle?.message ?? null;

    if (!options.forceNew
        && lastMessage
        && lastMessage.role === 'aily'
        && lastMessage.state === 'doing'
        && getTurnResponseParticipant(lastMessage.source) === msgSource) {
      if (options.turnId && lastMessage.turnId && lastMessage.turnId !== options.turnId) {
        // Completed/foreign-turn assistant entries must remain immutable.
      } else {
      if (options.turnId && !lastMessage.turnId) {
        lastMessage.turnId = options.turnId;
      }
      return trailingHandle!;
      }
    }

    this.access.markCurrentViewVisibleProjectionOwner();
    this.access.list.push({
      role: 'aily',
      content: '',
      state: options.state ?? 'doing',
      source: msgSource,
      modelName: this.access.currentModelName || undefined,
      modelBillingLabel: this.access.currentModelBillingLabel || undefined,
      turnId: options.turnId,
    } as any);

    this.access.triggerSyncDetectChanges();
    if (options.scrollOnCreate !== false) {
      this.access.scrollManager?.scrollToBottom?.();
    }

    return findLatestChatMessageHandle(this.access.list)!;
  }

  insertAilyPartsMessageHandleAfter(
    anchorHandle: ChatMessageHandle<ChatListItem> | null,
    options: {
      source?: string;
      state?: 'doing' | 'done';
      scrollOnCreate?: boolean;
      turnId?: string;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    if (!isUsableChatMessageHandle(anchorHandle)) {
      return this.ensureTrailingAilyPartsMessageHandle({ ...options, forceNew: true });
    }

    const msgSource = getTurnResponseParticipant(options.source ?? this.access.currentMessageSource);
    const insertIndex = Math.min(anchorHandle.msgIndex + 1, this.access.list.length);
    this.access.partStore.shiftMessageIndexes(insertIndex, 1);
    this.access.markCurrentViewVisibleProjectionOwner();
    this.access.list.splice(insertIndex, 0, {
      role: 'aily',
      content: '',
      state: options.state ?? 'doing',
      source: msgSource,
      modelName: this.access.currentModelName || undefined,
      modelBillingLabel: this.access.currentModelBillingLabel || undefined,
      turnId: options.turnId,
    } as any);

    this.access.triggerSyncDetectChanges();
    if (options.scrollOnCreate !== false) {
      this.access.scrollManager?.scrollToBottom?.();
    }

    return getChatMessageHandle(this.access.list, insertIndex)!;
  }

  findLatestMatchingMessageHandle(role: string, source?: string): ChatMessageHandle<ChatListItem> | null {
    const msgSource = getTurnResponseParticipant(source || this.access.currentMessageSource);
    return findLatestChatMessageHandle(
      this.access.list,
      message => message.role === role && getTurnResponseParticipant(message.source) === msgSource,
    );
  }

  findLatestAilyPartsMessageHandle(): OpaqueChatMessageHandle<ChatListItem> | null {
    const handles = this.getMessageHandles('aily');
    for (let index = handles.length - 1; index >= 0; index--) {
      const handle = handles[index]!;
      if (this.access.partStore.hasPartsForHandle(handle)) {
        return this.toOpaqueMessageHandle(handle);
      }
    }

    return null;
  }

  findLatestIndexedAilyPartsMessageHandle(): ChatMessageHandle<ChatListItem> | null {
    const handles = this.getMessageHandles('aily');
    for (let index = handles.length - 1; index >= 0; index--) {
      const handle = handles[index]!;
      if (this.access.partStore.hasPartsForHandle(handle)) {
        return handle;
      }
    }

    return null;
  }

  toOpaqueMessageHandle(handle: ChatMessageHandle<ChatListItem>): OpaqueChatMessageHandle<ChatListItem> {
    return createOpaqueChatMessageHandle(handle.message);
  }

  appendPartsFromBoundaryHandle(
    handle: ChatMessageHandle<ChatListItem>,
    parts: readonly ChatPart[],
  ): void {
    let targetHandle: ChatMessageHandle<ChatListItem> | OpaqueChatMessageHandle<ChatListItem> = handle;

    for (let index = 0; index < parts.length; index++) {
      this.access.partStore.addPartToHandle(targetHandle, parts[index]!);
      if (index === 0) {
        targetHandle = this.toOpaqueMessageHandle(handle);
      }
    }
  }

  resolveWriteHandle(handle: ChatMessageHandle<ChatListItem>): ChatMessageHandle<ChatListItem> | OpaqueChatMessageHandle<ChatListItem> {
    return this.access.partStore.hasPartsForHandle(handle)
      ? this.toOpaqueMessageHandle(handle)
      : handle;
  }

  syncMessageContent(handle: ChatMessageHandle<ChatListItem>): boolean {
    syncChatMessageHandleContent(handle, this.access.partStore);
    return true;
  }
}

export class ChatViewWriteBridge {
  private readonly listAccess: ChatViewWriteListAccess;
  private readonly storeAccess: ChatViewWriteStoreAccess;
  private readonly historyAccess: ChatViewWriteHistoryAccess;
  private readonly viewSyncAccess: ChatViewWriteViewSyncAccess;
  private readonly messageHandleHelper: ChatViewMessageHandleHelper;
  private readonly historyRestoreHelper: ChatViewHistoryRestoreHelper;
  private readonly partMutationHelper: ChatViewPartMutationHelper;
  private readonly resetHelper: ChatViewResetHelper;
  private readonly legacyListProjectionBoundary: ChatViewWriteBridgeContext['legacyListProjectionBoundary'];

  constructor(ctx: ChatViewWriteBridgeContext) {
    this.listAccess = ctx;
    this.storeAccess = ctx;
    this.historyAccess = ctx;
    this.viewSyncAccess = ctx;
    this.legacyListProjectionBoundary = ctx.legacyListProjectionBoundary;
    const bridge = this;
    this.messageHandleHelper = new ChatViewMessageHandleHelper({
      get list() {
        return bridge.listAccess.list;
      },
      set list(list) {
        bridge.listAccess.list = list;
      },
      get scrollManager() {
        return bridge.listAccess.scrollManager;
      },
      get triggerSyncDetectChanges() {
        return bridge.listAccess.triggerSyncDetectChanges;
      },
      get currentModelName() {
        return bridge.listAccess.currentModelName;
      },
      get currentMessageSource() {
        return bridge.listAccess.currentMessageSource;
      },
      get markCurrentViewVisibleProjectionOwner() {
        return bridge.listAccess.markCurrentViewVisibleProjectionOwner;
      },
      get partStore() {
        return bridge.storeAccess.partStore;
      },
    });
    this.historyRestoreHelper = new ChatViewHistoryRestoreHelper(
      {
        get list() {
          return bridge.listAccess.list;
        },
        set list(list) {
          bridge.listAccess.list = list;
        },
        get markCurrentViewVisibleProjectionOwner() {
          return bridge.listAccess.markCurrentViewVisibleProjectionOwner;
        },
        get partStore() {
          return bridge.storeAccess.partStore;
        },
        get ngZone() {
          return bridge.viewSyncAccess.ngZone;
        },
        get viewAdapter() {
          return bridge.viewSyncAccess.viewAdapter;
        },
      },
      (handle, parts) => this.messageHandleHelper.appendPartsFromBoundaryHandle(handle, parts),
    );
    this.partMutationHelper = new ChatViewPartMutationHelper(
      {
        get list() {
          return bridge.listAccess.list;
        },
        get scrollManager() {
          return bridge.listAccess.scrollManager;
        },
        get triggerSyncDetectChanges() {
          return bridge.listAccess.triggerSyncDetectChanges;
        },
        get partStore() {
          return bridge.storeAccess.partStore;
        },
        get sessionId() {
          return bridge.historyAccess.sessionId;
        },
        markHistoryDirty: (sessionId) => bridge.historyAccess.markHistoryDirty(sessionId),
      },
      handle => this.messageHandleHelper.resolveWriteHandle(handle),
      () => this.messageHandleHelper.findLatestAilyPartsMessageHandle(),
      () => this.messageHandleHelper.findLatestIndexedAilyPartsMessageHandle(),
      (role, source) => this.messageHandleHelper.findLatestMatchingMessageHandle(role, source),
      handle => this.messageHandleHelper.toOpaqueMessageHandle(handle),
      options => this.messageHandleHelper.ensureTrailingAilyPartsMessageHandle(options),
      (handle, parts) => this.messageHandleHelper.appendPartsFromBoundaryHandle(handle, parts),
      handle => this.messageHandleHelper.syncMessageContent(handle),
      markDirty => this.markHistoryDirty(markDirty),
    );
    this.resetHelper = new ChatViewResetHelper({
      get list() {
        return bridge.listAccess.list;
      },
      set list(list) {
        bridge.listAccess.list = list;
      },
      get triggerSyncDetectChanges() {
        return bridge.listAccess.triggerSyncDetectChanges;
      },
      get markCurrentViewVisibleProjectionOwner() {
        return bridge.listAccess.markCurrentViewVisibleProjectionOwner;
      },
      get partStore() {
        return bridge.storeAccess.partStore;
      },
      get invalidateHostRequestGraph() {
        return bridge.viewSyncAccess.invalidateHostRequestGraph;
      },
      get viewAdapter() {
        return bridge.viewSyncAccess.viewAdapter;
      },
    });
  }

  restoreLegacyHistoryList(chatList: readonly ChatListItem[]): void {
    this.historyRestoreHelper.restoreLegacyHistoryList(chatList);
  }

  restoreTurnNativeHistoryList(
    chatList: readonly ChatListItem[],
    turnIds: ReadonlySet<string>,
  ): void {
    this.historyRestoreHelper.restoreTurnNativeHistoryList(chatList, turnIds);
  }

  restoreTurnNativeHistoryEntries(
    entries: readonly HostResponseEntry[],
    turnIds: ReadonlySet<string>,
  ): void {
    this.historyRestoreHelper.restoreTurnNativeHistoryList(buildTurnNativeRestoreChatListFromEntries(entries), turnIds);
  }

  getMessageHandles(role?: string): ChatMessageHandle<ChatListItem>[] {
    return this.messageHandleHelper.getMessageHandles(role);
  }

  findMessageHandleByTurnId(turnId: string, options: { role?: string } = {}): ChatMessageHandle<ChatListItem> | null {
    return this.messageHandleHelper.findMessageHandleByTurnId(turnId, options);
  }

  ensureTrailingAilyPartsMessageHandle(
    options: {
      source?: string;
      state?: 'doing' | 'done';
      scrollOnCreate?: boolean;
      forceNew?: boolean;
      turnId?: string;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    this.assertLegacyListProjectionBoundary('ensureTrailingAilyPartsMessageHandle');
    return this.messageHandleHelper.ensureTrailingAilyPartsMessageHandle(options);
  }

  insertAilyPartsMessageHandleAfter(
    anchorHandle: ChatMessageHandle<ChatListItem> | null,
    options: {
      source?: string;
      state?: 'doing' | 'done';
      scrollOnCreate?: boolean;
      turnId?: string;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    this.assertLegacyListProjectionBoundary('insertAilyPartsMessageHandleAfter');
    return this.messageHandleHelper.insertAilyPartsMessageHandleAfter(anchorHandle, options);
  }

  appendPartToHandle(
    handle: ChatMessageHandle<ChatListItem>,
    part: ChatPart,
    options: {
      state?: 'doing' | 'done';
      markDirty?: boolean;
    } = {},
  ): boolean {
    return this.partMutationHelper.appendPartToHandle(handle, part, options);
  }

  appendMarkdownToHandle(
    handle: ChatMessageHandle<ChatListItem>,
    text: string,
    options: { markDirty?: boolean } = {},
  ): boolean {
    return this.partMutationHelper.appendMarkdownToHandle(handle, text, options);
  }

  updateQuestionAnswersByPartId(
    answers: QuestionPart['answers'],
    partId: string,
    options: { markDirty?: boolean } = {},
  ): boolean {
    return this.partMutationHelper.updateQuestionAnswersByPartId(answers, partId, options);
  }

  updateConfirmationResultByPartId(
    partId: string,
    next: {
      resolved: boolean;
      result?: ConfirmationPart['result'];
      scope?: ConfirmationPart['scope'];
    },
    options: { markDirty?: boolean } = {},
  ): boolean {
    return this.partMutationHelper.updateConfirmationResultByPartId(partId, next, options);
  }

  updateToolCallApprovalRequestByToolCallId(
    request: ToolApprovalRequest,
    options: { markDirty?: boolean } = {},
  ): boolean {
    return this.partMutationHelper.updateToolCallApprovalRequestByToolCallId(request, options);
  }

  resolveToolCallApprovalByToolCallId(
    toolCallId: string,
    next: {
      approved: boolean;
      scope?: ConfirmationPart['scope'];
    },
    options: { markDirty?: boolean } = {},
  ): boolean {
    return this.partMutationHelper.resolveToolCallApprovalByToolCallId(toolCallId, next, options);
  }

  clearChatView(options: { detectChanges?: boolean } = {}): void {
    this.resetHelper.clearChatView(options);
  }

  appendMarkdownToLatestPartsMessage(role: string, text: string, source?: string): boolean {
    this.assertLegacyListProjectionBoundary('appendMarkdownToLatestPartsMessage');
    return this.partMutationHelper.appendMarkdownToLatestPartsMessage(role, text, source);
  }

  appendAilyPartsMessageHandle(
    parts: readonly ChatPart[],
    options: {
      scroll?: boolean;
      source?: string;
      state?: 'doing' | 'done';
      markDirty?: boolean;
    } = {},
  ): ChatMessageHandle<ChatListItem> {
    this.assertLegacyListProjectionBoundary('appendAilyPartsMessageHandle');
    return this.partMutationHelper.appendAilyPartsMessageHandle(parts, options);
  }

  findLatestIndexedAilyPartsMessageHandle(): ChatMessageHandle<ChatListItem> | null {
    this.assertLegacyListProjectionBoundary('findLatestIndexedAilyPartsMessageHandle');
    return this.messageHandleHelper.findLatestIndexedAilyPartsMessageHandle();
  }

  findTurnStartHandle(turnId: string): ChatMessageHandle<ChatListItem> | null {
    return this.resetHelper.findTurnStartHandle(turnId);
  }

  truncateFromHandle(handle: ChatMessageHandle<ChatListItem> | null): boolean {
    return this.resetHelper.truncateFromHandle(handle);
  }

  truncateFromTurnId(turnId: string): boolean {
    return this.resetHelper.truncateFromTurnId(turnId);
  }

  truncateFrom(fromIndex: number): boolean {
    return this.resetHelper.truncateFrom(fromIndex);
  }

  private markHistoryDirty(markDirty: boolean | undefined): void {
    if (markDirty === false || !this.historyAccess.sessionId) {
      return;
    }

    this.historyAccess.markHistoryDirty(this.historyAccess.sessionId);
  }

  private assertLegacyListProjectionBoundary(method: string): void {
    if (this.legacyListProjectionBoundary) {
      return;
    }

    throw new Error(`${method} is a legacy list projection API and cannot be used by live transcript rendering.`);
  }
}
