import { Injectable, OnDestroy, Optional } from '@angular/core';
import { Subscription, Subject } from 'rxjs';

import { ChatService } from './chat.service';
import { ChatHistoryService } from './chat-history.service';
import { AilyHost } from '../core/host';
import { HostSessionItemController } from '../helpers/host-session-item-controller';
import { ChatSessionStateService } from './chat-session-state.service';
import type { ChatSessionRuntimeChangedEvent } from './chat-session-runtime-store.service';
import { ChatSessionRuntimeStoreService } from './chat-session-runtime-store.service';
import { ChatPerformanceTracer } from './chat-perf-tracer';
import type { ChatSessionListAction, ChatSessionListItem } from './menu-manager.service';
import type {
  HostSessionHistoryItem,
  HostSessionListItem as HostSessionListProjectionItem,
  HostSessionListItemMetadata,
  HostSessionListItemTiming,
  SessionInventorySummary,
} from '../helpers/host-session-item-controller';
import { EditCheckpointService } from './edit-checkpoint.service';

type SessionListSourceLike = Partial<HostSessionHistoryItem> & Partial<HostSessionListProjectionItem> & Partial<ChatSessionListItem> & {
  readonly name?: string;
  readonly updatedAt?: number;
};

export interface ChatSessionListItemsDelta {
  readonly kind: 'full' | 'item';
  readonly affectsOrder: boolean;
  readonly sessionId?: string;
}

export interface SessionListRefreshRequest {
  readonly reason: 'open' | 'entry' | 'reopen' | 'filter' | 'state' | 'runtime' | 'manual' | 'project' | 'service-created' | 'shell';
  readonly scope: 'summary' | 'visible-details' | 'full';
  readonly priority: 'after-paint' | 'normal' | 'idle';
  readonly sessionIds?: readonly string[];
  readonly limit?: number;
  readonly filter?: 'all' | 'current-project';
  readonly projectPath?: string | null;
  readonly projectRootPath?: string | null;
}

export type ChatSessionListLoadStateKind = 'idle' | 'loading-summary' | 'hydrating-visible-details' | 'ready' | 'error';

export interface ChatSessionListLoadState {
  readonly kind: ChatSessionListLoadStateKind;
  readonly canRetry: boolean;
}

@Injectable()
export class ChatSessionItemsService implements OnDestroy {
  private static readonly INITIAL_SUMMARY_LIMIT = 40;

  private _sessionListItems: ChatSessionListItem[] = [];
  private _sessionListRevision = 0;
  private _sessionInventoryRevision = 0;
  private readonly hostSessionItemController: HostSessionItemController;
  private readonly controllerSubscription = new Subscription();
  private readonly sessionListItemsChangedSubject = new Subject<void>();
  private readonly sessionListItemsDeltaSubject = new Subject<ChatSessionListItemsDelta>();
  private readonly sessionInventoryChangedSubject = new Subject<void>();
  private readonly sessionListItemMap = new Map<string, ChatSessionListItem>();
  private readonly pendingSessionItemRefresh = new Set<string>();
  private pendingFullRefresh = false;
  private refreshScheduled = false;
  private pendingRefreshRequest: SessionListRefreshRequest | null = null;
  private pendingRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshRequestGeneration = 0;
  private activeRefreshRequestGeneration = 0;
  private refreshRequestInFlight = false;
  private _sessionListLoadState: ChatSessionListLoadState = {
    kind: 'idle',
    canRetry: false,
  };
  private lastFailedRefreshRequest: SessionListRefreshRequest | null = null;

  readonly sessionListItemsChanged$ = this.sessionListItemsChangedSubject.asObservable();
  readonly sessionListItemsDelta$ = this.sessionListItemsDeltaSubject.asObservable();
  readonly sessionInventoryChanged$ = this.sessionInventoryChangedSubject.asObservable();
  private readonly sessionListLoadStateChangedSubject = new Subject<void>();
  readonly sessionListLoadStateChanged$ = this.sessionListLoadStateChangedSubject.asObservable();

  constructor(
    private readonly chatService: ChatService,
    private readonly chatHistoryService: ChatHistoryService,
    private readonly chatSessionRuntimeStore: ChatSessionRuntimeStoreService,
    @Optional() private readonly editCheckpointService: EditCheckpointService | null = null,
    @Optional() private readonly chatSessionStateService: ChatSessionStateService | null = null,
  ) {
    ChatPerformanceTracer.increment('session_list.service_created');
    ChatPerformanceTracer.mark('session_list.service_created');
    this.hostSessionItemController = new HostSessionItemController({
      chatService: this.chatService,
      chatHistoryService: this.chatHistoryService,
      ...(this.editCheckpointService ? { editCheckpointService: this.editCheckpointService } : {}),
      ...(this.chatSessionStateService ? { chatSessionStateService: this.chatSessionStateService } : {}),
      readLiveSessionTurnResponses: (sessionId) => this.chatSessionRuntimeStore.readTurnResponses(sessionId),
      readLiveSessionRuntimeState: (sessionId) => this.chatSessionRuntimeStore.read(sessionId),
    });
    this.controllerSubscription.add(this.hostSessionItemController.itemsChanged$.subscribe((event) => {
      this.bumpSessionInventoryRevision();
      if (event.sessionId) {
        this.refreshSessionListItem(event.sessionId, 'controller-item-changed');
        return;
      }

      this.scheduleFullRefresh('controller-items-changed');
    }));
    this.controllerSubscription.add(this.chatSessionRuntimeStore.runtimeChanged$.subscribe((event) => {
      this.handleRuntimeChanged(event);
    }));
    this.scheduleInitialSummaryLoad('service-created');
  }

  ngOnDestroy(): void {
    this.controllerSubscription.unsubscribe();
  }

  get sessionItemController(): HostSessionItemController {
    return this.hostSessionItemController;
  }

  get sessionListItems(): ChatSessionListItem[] {
    return this._sessionListItems;
  }

  get sessionListRevision(): number {
    return this._sessionListRevision;
  }

  get sessionInventoryRevision(): number {
    return this._sessionInventoryRevision;
  }

  get sessionListLoadState(): ChatSessionListLoadState {
    return this._sessionListLoadState;
  }

  readCachedSessionItem(sessionId: string | null | undefined): ChatSessionListItem | null {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    return normalizedSessionId ? this.sessionListItemMap.get(normalizedSessionId) ?? null : null;
  }

  set sessionListItems(value: ChatSessionListItem[]) {
    this.commitSessionListItems(Array.isArray(value) ? [...value] : [], {
      kind: 'full',
      affectsOrder: true,
    });
  }

  readSessionListItems(
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): readonly HostSessionListProjectionItem[] {
    const resolvedProjectPath = projectPath ?? this.resolveCurrentProjectPath();
    const resolvedProjectRootPath = projectRootPath ?? AilyHost.get().project.projectRootPath ?? null;
    return this.hostSessionItemController.readListItems(
      'current-project',
      resolvedProjectPath,
      resolvedProjectRootPath,
    );
  }

  readSessionViewItems(
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): readonly ChatSessionListItem[] {
    return this.readSessionListItems(projectPath, projectRootPath).map(item => this.toSessionListItem(item));
  }

  readSessionSummaryViewItems(
    projectPath?: string | null,
    projectRootPath?: string | null,
    limit?: number,
    filter: 'all' | 'current-project' = 'current-project',
  ): readonly ChatSessionListItem[] {
    const resolvedProjectPath = projectPath ?? this.resolveCurrentProjectPath();
    const resolvedProjectRootPath = projectRootPath ?? AilyHost.get().project.projectRootPath ?? null;
    const items = this.hostSessionItemController.readSummaryItems(
      filter,
      resolvedProjectPath,
      resolvedProjectRootPath,
      { limit },
    ).map(item => this.toSessionListItem(item));
    ChatPerformanceTracer.mark('session_list.summary_rows_projected', `count=${items.length},filter=${filter}${typeof limit === 'number' ? `,limit=${limit}` : ''}`);
    return items;
  }

  readCurrentSessionViewItem(
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): ChatSessionListItem | null {
    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!currentSessionId) {
      return null;
    }

    const currentItem = this.readCachedSessionItem(currentSessionId);
    if (currentItem) {
      return currentItem;
    }

    const projectedSummary = this.readOrProjectSessionSummary(currentSessionId, projectPath, projectRootPath, 'all');
    if (projectedSummary) {
      return projectedSummary;
    }

    return this._sessionListItems.find(item => item.current || item.sessionId === currentSessionId) ?? null;
  }

  readOrProjectSessionSummary(
    sessionId: string | null | undefined,
    projectPath?: string | null,
    projectRootPath?: string | null,
    filter: 'all' | 'current-project' = 'current-project',
  ): ChatSessionListItem | null {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }

    const cachedItem = this.readCachedSessionItem(normalizedSessionId);
    if (cachedItem) {
      return cachedItem;
    }

    const summaryItem = this.hostSessionItemController.readSummaryItem(
      normalizedSessionId,
      filter,
      projectPath ?? this.resolveCurrentProjectPath(),
      projectRootPath ?? AilyHost.get().project.projectRootPath ?? null,
    );
    return summaryItem ? this.toSessionListItem(summaryItem) : null;
  }

  loadInitialSummaries(
    limit = ChatSessionItemsService.INITIAL_SUMMARY_LIMIT,
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): void {
    const nextItems = [...this.readSessionSummaryViewItems(projectPath, projectRootPath, limit)];
    this.commitSessionListItems(nextItems, {
      kind: 'full',
      affectsOrder: !this.isSessionListOrderEqual(this._sessionListItems, nextItems),
    });
    this.markSessionListReady();
  }

  loadMoreSummaries(
    cursor = this._sessionListItems.length,
    limit = ChatSessionItemsService.INITIAL_SUMMARY_LIMIT,
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): void {
    const resolvedProjectPath = projectPath ?? this.resolveCurrentProjectPath();
    const resolvedProjectRootPath = projectRootPath ?? AilyHost.get().project.projectRootPath ?? null;
    const summaryItems = this.hostSessionItemController.readSummaryItems(
      'current-project',
      resolvedProjectPath,
      resolvedProjectRootPath,
      { cursor, limit },
    ).map(item => this.toSessionListItem(item));
    if (summaryItems.length === 0) {
      return;
    }

    const mergedItems = [...this._sessionListItems];
    for (const item of summaryItems) {
      const existingIndex = mergedItems.findIndex(candidate => candidate.sessionId === item.sessionId);
      if (existingIndex >= 0) {
        mergedItems.splice(existingIndex, 1, item);
      } else {
        mergedItems.push(item);
      }
    }

    mergedItems.sort((left, right) => this.compareSessionListItems(left, right));
    this.commitSessionListItems(mergedItems, {
      kind: 'full',
      affectsOrder: !this.isSessionListOrderEqual(this._sessionListItems, mergedItems),
    });
    this.markSessionListReady();
  }

  hydrateVisibleDetails(
    sessionIds: readonly string[],
    _reason = 'visible-details',
    projectPath?: string | null,
    projectRootPath?: string | null,
    filter: 'all' | 'current-project' = 'current-project',
  ): void {
    ChatPerformanceTracer.increment('session_list.load.visible-details');
    const prepared = this.prepareVisibleDetailsRefresh(sessionIds, projectPath, projectRootPath, filter);
    if (!prepared) {
      return;
    }

    this.commitSessionListItems(prepared.items, {
      kind: 'item',
      affectsOrder: prepared.affectsOrder,
    });
    this.markSessionListReady();
  }

  private prepareVisibleDetailsRefresh(
    sessionIds: readonly string[],
    projectPath?: string | null,
    projectRootPath?: string | null,
    filter: 'all' | 'current-project' = 'current-project',
  ): { readonly items: ChatSessionListItem[]; readonly affectsOrder: boolean } | null {
    const detailSpan = ChatPerformanceTracer.begin('session_list.visible_detail_hydration', `requested=${sessionIds.length}`);
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      ChatPerformanceTracer.end(detailSpan, 'session_list.visible_detail_hydration', 'empty');
      return null;
    }

    const resolvedProjectPath = projectPath ?? this.resolveCurrentProjectPath();
    const resolvedProjectRootPath = projectRootPath ?? AilyHost.get().project.projectRootPath ?? null;
    let nextItems = [...this._sessionListItems];
    let changed = false;

    for (const rawSessionId of sessionIds) {
      const sessionId = this.normalizeSessionId(rawSessionId);
      if (!sessionId) {
        continue;
      }

      const summary = this.hostSessionItemController.readSummaryItem(
        sessionId,
        filter,
        resolvedProjectPath,
        resolvedProjectRootPath,
      );
      const detailed = summary
        ? this.hostSessionItemController.hydrateListItemDetail(sessionId, summary)
        : null;
      if (!detailed) {
        continue;
      }

      const nextItem = this.toSessionListItem(detailed);
      const previousIndex = nextItems.findIndex(item => item.sessionId === sessionId);
      if (previousIndex < 0) {
        nextItems.push(nextItem);
        changed = true;
        continue;
      }

      if (this.isSameSessionListItem(nextItems[previousIndex], nextItem)) {
        continue;
      }

      nextItems.splice(previousIndex, 1, nextItem);
      changed = true;
    }

    if (!changed) {
      ChatPerformanceTracer.end(detailSpan, 'session_list.visible_detail_hydration', 'unchanged');
      return null;
    }

    nextItems.sort((left, right) => this.compareSessionListItems(left, right));
    ChatPerformanceTracer.mark('session_list.detail_rows_hydrated', `count=${sessionIds.length}`);
    ChatPerformanceTracer.end(detailSpan, 'session_list.visible_detail_hydration', `count=${sessionIds.length}`);
    return {
      items: nextItems,
      affectsOrder: !this.isSessionListOrderEqual(this._sessionListItems, nextItems),
    };
  }

  refreshHistoryList(
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): void {
    const refreshSpan = ChatPerformanceTracer.begin('session_list.full_refresh');
    ChatPerformanceTracer.increment('session_list.load.full');
    ChatPerformanceTracer.increment('session_list.sync_refresh_history');
    const nextItems = [...this.readSessionSummaryViewItems(projectPath, projectRootPath, undefined)];
    ChatPerformanceTracer.mark('session_list.full_rows_projected', `count=${nextItems.length}`);
    this.commitSessionListItems(nextItems, {
      kind: 'full',
      affectsOrder: !this.isSessionListOrderEqual(this._sessionListItems, nextItems),
    });
    this.markSessionListReady();
    ChatPerformanceTracer.end(refreshSpan, 'session_list.full_refresh', `count=${nextItems.length}`);
  }

  retryLastSessionListRefresh(): void {
    const retryRequest = this.lastFailedRefreshRequest ?? {
      reason: 'manual' as const,
      scope: 'summary' as const,
      priority: 'normal' as const,
      limit: ChatSessionItemsService.INITIAL_SUMMARY_LIMIT,
      projectPath: this.resolveCurrentProjectPath(),
      projectRootPath: AilyHost.get().project.projectRootPath ?? null,
    };

    this.requestSessionListRefresh({
      ...retryRequest,
      reason: 'manual',
      priority: 'normal',
    });
  }

  scheduleFullRefresh(_reason = 'scheduled-full-refresh'): void {
    this.pendingFullRefresh = true;
    this.pendingSessionItemRefresh.clear();
    this.scheduleRefreshFlush();
  }

  scheduleSessionItemRefresh(
    sessionId: string | null | undefined,
    _reason = 'scheduled-item-refresh',
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    if (this.pendingFullRefresh) {
      return;
    }

    this.pendingSessionItemRefresh.add(normalizedSessionId);
    this.scheduleRefreshFlush();
  }

  refreshSessionListItem(
    sessionId: string | null | undefined,
    _reason = 'manual-item-refresh',
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    const resolvedProjectPath = projectPath ?? this.resolveCurrentProjectPath();
    const resolvedProjectRootPath = projectRootPath ?? AilyHost.get().project.projectRootPath ?? null;
    const projectionItem = this.hostSessionItemController.readListItem(
      normalizedSessionId,
      'current-project',
      resolvedProjectPath,
      resolvedProjectRootPath,
    );
    const nextItem = projectionItem ? this.toSessionListItem(projectionItem) : null;

    const previousItems = this._sessionListItems;
    const previousIndex = previousItems.findIndex(item => item.sessionId === normalizedSessionId);

    if (!nextItem && previousIndex < 0) {
      return;
    }

    const nextItems = [...previousItems];
    if (!nextItem && previousIndex >= 0) {
      nextItems.splice(previousIndex, 1);
      this.commitSessionListItems(nextItems, {
        kind: 'item',
        sessionId: normalizedSessionId,
        affectsOrder: true,
      });
      return;
    }

    if (!nextItem) {
      return;
    }

    if (previousIndex >= 0) {
      if (this.isSameSessionListItem(previousItems[previousIndex], nextItem)) {
        return;
      }

      nextItems.splice(previousIndex, 1, nextItem);
    } else {
      nextItems.push(nextItem);
    }

    nextItems.sort((left, right) => this.compareSessionListItems(left, right));
    this.commitSessionListItems(nextItems, {
      kind: 'item',
      sessionId: normalizedSessionId,
      affectsOrder: !this.isSessionListOrderEqual(previousItems, nextItems),
    });
  }

  private handleRuntimeChanged(event: ChatSessionRuntimeChangedEvent): void {
    if (event.sessionId === null || event.reason === 'clearAll') {
      this.bumpSessionInventoryRevision();
      this.scheduleFullRefresh('runtime-clear-all');
      return;
    }

    if (!event.listAffecting) {
      return;
    }

    this.bumpSessionInventoryRevision();
    this.scheduleSessionItemRefresh(event.sessionId, `runtime-${event.reason}`);
  }

  private bumpSessionInventoryRevision(): void {
    this._sessionInventoryRevision += 1;
    this.sessionInventoryChangedSubject.next();
  }

  private scheduleRefreshFlush(): void {
    if (this.refreshScheduled) {
      return;
    }

    this.refreshScheduled = true;
    queueMicrotask(() => this.flushScheduledRefreshes());
  }

  private flushScheduledRefreshes(): void {
    this.refreshScheduled = false;
    if (this.pendingFullRefresh) {
      this.pendingFullRefresh = false;
      this.pendingSessionItemRefresh.clear();
      this.refreshHistoryList();
      return;
    }

    if (this.pendingSessionItemRefresh.size === 0) {
      return;
    }

    const sessionIds = [...this.pendingSessionItemRefresh.values()];
    this.pendingSessionItemRefresh.clear();
    for (const sessionId of sessionIds) {
      this.refreshSessionListItem(sessionId, 'runtime-batch');
    }
  }

  private normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private commitSessionListItems(
    items: readonly ChatSessionListItem[],
    delta: ChatSessionListItemsDelta,
  ): void {
    const normalizedItems = Array.isArray(items) ? [...items] : [];
    if (this.areSessionListItemsEqual(this._sessionListItems, normalizedItems)) {
      return;
    }

    this._sessionListItems = normalizedItems;
    this._sessionListRevision += 1;
    this.sessionListItemMap.clear();
    for (const item of normalizedItems) {
      if (item.sessionId) {
        this.sessionListItemMap.set(item.sessionId, item);
      }
    }

    this.sessionListItemsChangedSubject.next();
    this.sessionListItemsDeltaSubject.next(delta);
  }

  private isSessionListOrderEqual(
    left: readonly ChatSessionListItem[],
    right: readonly ChatSessionListItem[],
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index++) {
      if (left[index].sessionId !== right[index].sessionId) {
        return false;
      }
    }

    return true;
  }

  private compareSessionListItems(left: ChatSessionListItem, right: ChatSessionListItem): number {
    if (!left.archived && right.archived) {
      return -1;
    }
    if (left.archived && !right.archived) {
      return 1;
    }

    if (!left.archived && !right.archived) {
      if (left.pinned && !right.pinned) {
        return -1;
      }
      if (!left.pinned && right.pinned) {
        return 1;
      }

      const leftNeedsInput = left.status === 'needs_input';
      const rightNeedsInput = right.status === 'needs_input';
      if (leftNeedsInput && !rightNeedsInput) {
        return -1;
      }
      if (!leftNeedsInput && rightNeedsInput) {
        return 1;
      }
    }

    const leftUpdated = left.timing?.updated ?? left.timing?.created ?? 0;
    const rightUpdated = right.timing?.updated ?? right.timing?.created ?? 0;
    return rightUpdated - leftUpdated;
  }

  private areSessionListItemsEqual(
    left: readonly ChatSessionListItem[],
    right: readonly ChatSessionListItem[],
  ): boolean {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index++) {
      if (!this.isSameSessionListItem(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  private isSameSessionListItem(left: ChatSessionListItem, right: ChatSessionListItem): boolean {
    if (left === right) {
      return true;
    }

    return left.sessionId === right.sessionId
      && left.title === right.title
      && (left.titleSource ?? '') === (right.titleSource ?? '')
      && (left.titleDurable === true) === (right.titleDurable === true)
      && left.description === right.description
      && (left.sessionType ?? '') === (right.sessionType ?? '')
      && (left.projectPath ?? '') === (right.projectPath ?? '')
      && (left.badge ?? '') === (right.badge ?? '')
      && (left.status ?? '') === (right.status ?? '')
      && (left.mode ?? '') === (right.mode ?? '')
      && left.archived === right.archived
      && left.pinned === right.pinned
      && left.read === right.read
      && left.markedUnread === right.markedUnread
      && left.current === right.current
      && this.isSameSessionListTiming(left.timing, right.timing)
      && this.isSameSessionListMetadata(left.metadata, right.metadata)
      && this.isSameSessionListChanges(left.changes, right.changes)
      && this.isSameSerializableValue(left.requestRouting, right.requestRouting)
      && this.isSameSerializableValue(left.inputState, right.inputState)
      && this.isSameSessionListActions(left.actions, right.actions);
  }

  private isSameSessionListTiming(
    left: HostSessionListItemTiming | undefined,
    right: HostSessionListItemTiming | undefined,
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }

    return left.created === right.created
      && left.updated === right.updated
      && (left.lastRequestStarted ?? null) === (right.lastRequestStarted ?? null)
      && (left.lastRequestEnded ?? null) === (right.lastRequestEnded ?? null);
  }

  private isSameSessionListMetadata(
    left: HostSessionListItemMetadata | undefined,
    right: HostSessionListItemMetadata | undefined,
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }

    return left.providerLabel === right.providerLabel
      && (left.projectLabel ?? '') === (right.projectLabel ?? '')
      && (left.workingDirectoryPath ?? '') === (right.workingDirectoryPath ?? '');
  }

  private isSameSessionListChanges(
    left: HostSessionListProjectionItem['changes'] | undefined,
    right: HostSessionListProjectionItem['changes'] | undefined,
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }

    return left.fileCount === right.fileCount
      && left.insertions === right.insertions
      && left.deletions === right.deletions;
  }

  private isSameSessionListActions(
    left: readonly ChatSessionListAction[] | undefined,
    right: readonly ChatSessionListAction[] | undefined,
  ): boolean {
    if (!left && !right) {
      return true;
    }
    if (!left || !right) {
      return false;
    }
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index++) {
      if (left[index].icon !== right[index].icon
        || left[index].action !== right[index].action
        || left[index].title !== right[index].title
        || (left[index].active ?? false) !== (right[index].active ?? false)) {
        return false;
      }
    }

    return true;
  }

  private isSameSerializableValue(left: unknown, right: unknown): boolean {
    if (left === right) {
      return true;
    }
    if (left === undefined || right === undefined) {
      return left === right;
    }

    return JSON.stringify(left) === JSON.stringify(right);
  }

  private toSessionListItem(item: SessionListSourceLike): ChatSessionListItem {
    const fallbackTitle = typeof item?.title === 'string' && item.title.trim().length > 0
      ? item.title.trim()
      : (typeof item?.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : this.resolveUntitledSessionFallback(item));

    const description = typeof item?.description === 'string' && item.description.trim().length > 0
      ? item.description.trim()
      : '';
    const timing = item?.timing ?? this.buildFallbackTiming(item);
    const metadata = item?.metadata ?? this.buildFallbackMetadata(item);
    const changes = item?.changes;

    return {
      sessionId: typeof item?.sessionId === 'string' ? item.sessionId : '',
      title: fallbackTitle,
      ...(typeof item?.titleSource === 'string' && item.titleSource.trim().length > 0 ? { titleSource: item.titleSource.trim() as any } : {}),
      ...(item?.titleDurable === true ? { titleDurable: true } : {}),
      description,
      ...(typeof item?.sessionType === 'string' && item.sessionType.trim().length > 0 ? { sessionType: item.sessionType.trim() } : {}),
      ...(typeof item?.projectPath === 'string' || item?.projectPath === null ? { projectPath: item.projectPath ?? null } : {}),
      ...(typeof item?.badge === 'string' && item.badge.trim().length > 0 ? { badge: item.badge.trim() } : {}),
      ...(typeof item?.status === 'string' && item.status.trim().length > 0 ? { status: item.status.trim() } : {}),
      ...(timing ? { timing } : {}),
      ...(metadata ? { metadata } : {}),
      ...(changes ? { changes } : {}),
      ...(typeof item?.mode === 'string' && item.mode.trim().length > 0 ? { mode: item.mode.trim() } : {}),
      ...(item?.requestRouting ? { requestRouting: item.requestRouting } : {}),
      ...(item?.inputState ? { inputState: item.inputState } : {}),
      archived: item?.archived === true,
      pinned: item?.pinned === true,
      read: item?.read !== false,
      markedUnread: item?.markedUnread === true,
      current: item?.current === true,
      actions: Array.isArray(item?.actions) && item.actions.length > 0 ? item.actions : this.buildSessionActions(item),
    };
  }

  private buildSessionActions(item: SessionListSourceLike): readonly ChatSessionListAction[] {
    const archived = item?.archived === true;
    const pinned = item?.pinned === true;

    return [
      {
        icon: pinned ? 'fa-solid fa-thumbtack' : 'fa-light fa-thumbtack',
        action: pinned ? 'unpin-session' : 'pin-session',
        title: pinned ? '取消置顶' : '置顶',
        ...(pinned ? { active: true } : {}),
      },
      {
        icon: archived ? 'fa-solid fa-archive' : 'fa-light fa-archive',
        action: archived ? 'unarchive-session' : 'archive-session',
        title: archived ? '取消归档' : '归档',
        ...(archived ? { active: true } : {}),
      },
      { icon: 'fa-light fa-pen', action: 'rename-session', title: '重命名' },
      { icon: 'fa-light fa-trash', action: 'delete-session', title: '删除' },
    ];
  }

  private buildFallbackTiming(item: SessionListSourceLike): HostSessionListItemTiming | undefined {
    const created = typeof item?.timing?.created === 'number'
      ? item.timing.created
      : (typeof item?.createdAt === 'number' ? item.createdAt : undefined);
    const updated = typeof item?.timing?.updated === 'number'
      ? item.timing.updated
      : (typeof item?.updatedAt === 'number' ? item.updatedAt : created);

    if (created === undefined || updated === undefined) {
      return undefined;
    }

    return {
      created,
      updated,
      ...(typeof item?.timing?.lastRequestStarted === 'number' ? { lastRequestStarted: item.timing.lastRequestStarted } : {}),
      ...(typeof item?.timing?.lastRequestEnded === 'number' ? { lastRequestEnded: item.timing.lastRequestEnded } : {}),
    };
  }

  private buildFallbackMetadata(item: SessionListSourceLike): HostSessionListItemMetadata | undefined {
    if (item?.metadata?.providerLabel) {
      return item.metadata;
    }

    const providerLabel = this.describeSessionType(typeof item?.sessionType === 'string' ? item.sessionType : undefined);
    const workingDirectoryPath = typeof item?.projectPath === 'string' && item.projectPath.trim().length > 0
      ? item.projectPath.trim()
      : undefined;
    const projectLabel = this.describeProjectPath(workingDirectoryPath ?? null);

    if (!providerLabel && !projectLabel && !workingDirectoryPath) {
      return undefined;
    }

    return {
      providerLabel,
      ...(projectLabel ? { projectLabel } : {}),
      ...(workingDirectoryPath ? { workingDirectoryPath } : {}),
    };
  }

  private describeSessionType(sessionType?: string): string {
    const normalizedType = typeof sessionType === 'string' ? sessionType.trim() : '';
    switch (normalizedType) {
      case 'local':
        return 'Local';
      case 'claude-code':
        return 'Claude Code';
      case 'copilotcli':
        return 'Copilot CLI';
      case 'agent':
        return 'Agent';
      default:
        return normalizedType.length > 0
          ? normalizedType
            .split(/[-_\s]+/)
            .filter(part => part.length > 0)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ')
          : '';
    }
  }

  private describeProjectPath(projectPath: string | null): string {
    if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
      return '';
    }

    const normalizedPath = projectPath.replace(/[\\/]+$/, '');
    const segments = normalizedPath.split(/[\\/]+/).filter(segment => segment.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : normalizedPath;
  }

  private resolveCurrentProjectPath(): string | null {
    const currentProjectPath = AilyHost.get().project.currentProjectPath;
    const projectRootPath = AilyHost.get().project.projectRootPath;
    return currentProjectPath && currentProjectPath !== projectRootPath
      ? currentProjectPath
      : projectRootPath || null;
  }

  requestSessionListRefresh(request: SessionListRefreshRequest): void {
    ChatPerformanceTracer.increment(`session_list.request.${request.scope}`);
    ChatPerformanceTracer.mark('session_list.request_scheduled', `${request.reason}:${request.scope}:${request.priority}`);
    this.pendingRefreshRequest = this.mergeRefreshRequests(this.pendingRefreshRequest, request);
    this.refreshRequestGeneration += 1;
    this.markRequestedSessionListLoadState(this.pendingRefreshRequest);
    this.scheduleRefreshRequestFlush(this.pendingRefreshRequest.priority, this.refreshRequestGeneration);
  }

  scheduleInitialSummaryLoad(reason: SessionListRefreshRequest['reason'] = 'service-created'): void {
    this.requestSessionListRefresh({
      reason,
      scope: 'summary',
      priority: 'after-paint',
      limit: ChatSessionItemsService.INITIAL_SUMMARY_LIMIT,
    });
  }

  private scheduleRefreshRequestFlush(
    priority: SessionListRefreshRequest['priority'],
    generation: number,
  ): void {
    if (this.refreshRequestInFlight) {
      return;
    }

    const delay = priority === 'idle' ? 50 : 0;
    if (this.pendingRefreshTimer !== null && delay > 0) {
      return;
    }
    if (this.pendingRefreshTimer !== null) {
      clearTimeout(this.pendingRefreshTimer);
      this.pendingRefreshTimer = null;
    }
    this.pendingRefreshTimer = setTimeout(() => {
      this.pendingRefreshTimer = null;
      void this.flushPendingRefreshRequest(generation);
    }, delay);
  }

  private mergeRefreshRequests(
    existing: SessionListRefreshRequest | null,
    incoming: SessionListRefreshRequest,
  ): SessionListRefreshRequest {
    if (!existing) {
      return incoming;
    }

    const scopeRank: Record<SessionListRefreshRequest['scope'], number> = {
      summary: 0,
      'visible-details': 1,
      full: 2,
    };
    const priorityRank: Record<SessionListRefreshRequest['priority'], number> = {
      idle: 0,
      'after-paint': 1,
      normal: 2,
    };
    const scope = scopeRank[incoming.scope] >= scopeRank[existing.scope]
      ? incoming.scope
      : existing.scope;
    const priority = priorityRank[incoming.priority] >= priorityRank[existing.priority]
      ? incoming.priority
      : existing.priority;
    const sessionIds = scope === 'visible-details'
      ? [...new Set([...(existing.sessionIds ?? []), ...(incoming.sessionIds ?? [])])]
      : undefined;
    const limit = scope === 'summary'
      ? Math.max(existing.limit ?? 0, incoming.limit ?? 0) || undefined
      : incoming.limit ?? existing.limit;

    return {
      reason: incoming.reason,
      scope,
      priority,
      ...(sessionIds && sessionIds.length > 0 ? { sessionIds } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(incoming.filter !== undefined || existing.filter !== undefined
        ? { filter: incoming.filter ?? existing.filter ?? 'current-project' }
        : {}),
      ...(incoming.projectPath !== undefined || existing.projectPath !== undefined
        ? { projectPath: incoming.projectPath ?? existing.projectPath ?? null }
        : {}),
      ...(incoming.projectRootPath !== undefined || existing.projectRootPath !== undefined
        ? { projectRootPath: incoming.projectRootPath ?? existing.projectRootPath ?? null }
        : {}),
    };
  }

  private async flushPendingRefreshRequest(expectedGeneration?: number): Promise<void> {
    if (this.refreshRequestInFlight) {
      return;
    }

    if (expectedGeneration !== undefined && expectedGeneration !== this.refreshRequestGeneration) {
      return;
    }

    const request = this.pendingRefreshRequest;
    const generation = this.refreshRequestGeneration;
    this.pendingRefreshRequest = null;
    if (!request) {
      return;
    }

    this.refreshRequestInFlight = true;
    this.activeRefreshRequestGeneration = generation;
    this.markRequestedSessionListLoadState(request);

    let requestCompleted = false;

    try {
      const apply = await this.prepareRefreshRequestApplication(request);
      if (!apply) {
        requestCompleted = true;
        return;
      }

      if (generation !== this.refreshRequestGeneration) {
        return;
      }

      apply();
      requestCompleted = true;
    } catch (error) {
      if (generation !== this.refreshRequestGeneration && this.pendingRefreshRequest) {
        return;
      }

      this.markSessionListLoadError(request, error);
      return;
    } finally {
      if (this.activeRefreshRequestGeneration === generation) {
        this.activeRefreshRequestGeneration = 0;
      }
      this.refreshRequestInFlight = false;

      if (this.pendingRefreshRequest) {
        this.markRequestedSessionListLoadState(this.pendingRefreshRequest);
        this.scheduleRefreshRequestFlush(this.pendingRefreshRequest.priority, this.refreshRequestGeneration);
      } else if (requestCompleted) {
        this.markSessionListReady();
      }
    }
  }

  private async prepareRefreshRequestApplication(
    request: SessionListRefreshRequest,
  ): Promise<(() => void) | null> {
    switch (request.scope) {
      case 'summary': {
        const summarySpan = ChatPerformanceTracer.begin('session_list.initial_summary_load', request.reason);
        ChatPerformanceTracer.increment('session_list.load.summary');
        const nextItems = [...this.readSessionSummaryViewItems(
          request.projectPath,
          request.projectRootPath,
          request.limit ?? ChatSessionItemsService.INITIAL_SUMMARY_LIMIT,
          request.filter ?? 'current-project',
        )];
        const affectsOrder = !this.isSessionListOrderEqual(this._sessionListItems, nextItems);
        ChatPerformanceTracer.end(summarySpan, 'session_list.initial_summary_load', `count=${nextItems.length}`);
        return () => {
          this.commitSessionListItems(nextItems, {
            kind: 'full',
            affectsOrder,
          });
        };
      }
      case 'visible-details': {
        ChatPerformanceTracer.increment('session_list.load.visible-details');
        const prepared = this.prepareVisibleDetailsRefresh(
          request.sessionIds ?? [],
          request.projectPath,
          request.projectRootPath,
          request.filter ?? 'current-project',
        );
        if (!prepared) {
          return null;
        }

        return () => {
          this.commitSessionListItems(prepared.items, {
            kind: 'item',
            affectsOrder: prepared.affectsOrder,
          });
        };
      }
      case 'full': {
        const fullSpan = ChatPerformanceTracer.begin('session_list.full_refresh', request.reason);
        ChatPerformanceTracer.increment('session_list.load.full');
        const nextItems = [...this.readSessionSummaryViewItems(
          request.projectPath,
          request.projectRootPath,
          undefined,
          request.filter ?? 'current-project',
        )];
        const affectsOrder = !this.isSessionListOrderEqual(this._sessionListItems, nextItems);
        ChatPerformanceTracer.mark('session_list.full_rows_projected', `count=${nextItems.length}`);
        ChatPerformanceTracer.end(fullSpan, 'session_list.full_refresh', `count=${nextItems.length}`);
        return () => {
          this.commitSessionListItems(nextItems, {
            kind: 'full',
            affectsOrder,
          });
        };
      }
      default:
        return null;
    }
  }

  private resolveUntitledSessionFallback(item: SessionListSourceLike): string {
    return '新对话';
  }

  private markRequestedSessionListLoadState(request: SessionListRefreshRequest | null): void {
    if (!request) {
      return;
    }

    const nextKind = this.resolveSessionListLoadStateKind(request);
    if (!nextKind) {
      return;
    }

    if (nextKind === 'hydrating-visible-details' && this._sessionListItems.length === 0) {
      return;
    }

    this.setSessionListLoadState({
      kind: nextKind,
      canRetry: false,
    });
  }

  private resolveSessionListLoadStateKind(
    request: SessionListRefreshRequest,
  ): ChatSessionListLoadStateKind | null {
    switch (request.scope) {
      case 'summary':
      case 'full':
        return 'loading-summary';
      case 'visible-details':
        return 'hydrating-visible-details';
      default:
        return null;
    }
  }

  private markSessionListReady(): void {
    this.lastFailedRefreshRequest = null;
    this.setSessionListLoadState({
      kind: 'ready',
      canRetry: false,
    });
  }

  private markSessionListLoadError(request: SessionListRefreshRequest, error: unknown): void {
    if (request.scope === 'visible-details') {
      console.warn('[AilyChat][SessionList] visible detail hydration failed', error);
      this.markSessionListReady();
      return;
    }

    this.lastFailedRefreshRequest = request;
    this.setSessionListLoadState({
      kind: 'error',
      canRetry: true,
    });
    console.error('[AilyChat][SessionList] refresh failed', error);
  }

  private setSessionListLoadState(nextState: ChatSessionListLoadState): void {
    if (this._sessionListLoadState.kind === nextState.kind && this._sessionListLoadState.canRetry === nextState.canRetry) {
      return;
    }

    this._sessionListLoadState = nextState;
    this.sessionListLoadStateChangedSubject.next();
  }
}
