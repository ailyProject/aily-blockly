import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject } from 'rxjs';

import { AilyHost } from '../core/host';
import { groupChatSessionItemsByDate, type ChatSessionInventoryGroup } from '../helpers/chat-session-presentation';
import type { ChatSessionTitleActionContext } from '../core/chat-session-title-actions';
import { AilyChatConfigService, type ChatSessionViewerOrientationSetting } from './aily-chat-config.service';
import { ChatSessionSelectionService } from './chat-session-selection.service';
import { ChatSessionItemsService } from './chat-session-items.service';
import { ChatPerformanceTracer } from './chat-perf-tracer';
import type { ChatSessionListItemsDelta } from './chat-session-items.service';
import { ChatService } from './chat.service';
import { MenuManagerService, type ChatSessionListItem, type MenuPosition } from './menu-manager.service';

const SESSION_SIDEBAR_WIDTH_CONFIG_KEY = 'aiChatSessionsSidebarWidth';

@Injectable()
export class ChatSessionsControlService {
  private static readonly VISIBLE_DETAIL_HYDRATION_LIMIT = 12;

  readonly sessionSidebarDefaultWidth = 300;
  readonly sessionSidebarResizeMinWidth = 240;
  readonly sessionStageMinWidth = 300;
  readonly sessionSidebarMinWidth = 600;

  private _showSessionPicker = false;
  private _sessionPickerPosition: MenuPosition = { x: 0, y: 0 };
  private _selectedSessionId = '';
  private _pickerRevealSessionId = '';
  private _sessionViewportWidth = 0;
  private _hasConversationContent = false;
  private _hasCurrentSession = false;
  private _isAuthenticated = true;
  private _isSessionViewerSuppressed = false;
  private _isSubappDockExpanded = false;
  private _sessionViewerOrientation = 'sideBySide' as ChatSessionViewerOrientationSetting;
  private _requestedSessionSidebarWidth = this.readPersistedSessionSidebarWidth();
  private _sessionSidebarWidth = this.sessionSidebarDefaultWidth;
  private _sessionSidebarMaxWidth = this.sessionSidebarDefaultWidth;
  private _sessionListDisplayMode: 'hidden' | 'stacked' | 'sidebar' = 'stacked';
  private pendingControlChangedFrameId: number | null = null;
  private cachedSessionListGroups: { revision: string; groups: readonly ChatSessionInventoryGroup[] } | null = null;
  private cachedSessionPickerItems: { revision: string; items: readonly ChatSessionListItem[] } | null = null;
  private cachedSessionPickerGroups: { revision: string; groups: readonly ChatSessionInventoryGroup[] } | null = null;
  private readonly controlChangedSubject = new Subject<void>();

  readonly controlChanged$ = this.controlChangedSubject.asObservable();

  private readonly translate = inject(TranslateService);
  private readonly message = inject(NzMessageService);
  private readonly ailyChatConfigService = inject(AilyChatConfigService);
  private readonly menuManager = inject(MenuManagerService);
  private readonly chatService = inject(ChatService);
  private readonly chatSessionItemsService = inject(ChatSessionItemsService);
  private readonly chatSessionSelectionService = inject(ChatSessionSelectionService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this._sessionViewerOrientation = this.ailyChatConfigService.sessionViewerOrientation;
    this._sessionSidebarWidth = this.normalizeRequestedSessionSidebarWidth(this._requestedSessionSidebarWidth);
    this._sessionSidebarMaxWidth = this.resolveSessionSidebarMaxWidth(this._sessionViewportWidth);

    const sessionListItemsDelta$ = (this.chatSessionItemsService as unknown as {
      sessionListItemsDelta$?: { pipe: (...args: unknown[]) => { subscribe: (callback: (delta: ChatSessionListItemsDelta) => void) => unknown } };
    }).sessionListItemsDelta$;
    if (sessionListItemsDelta$) {
      sessionListItemsDelta$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((delta: ChatSessionListItemsDelta) => {
          this.handleSessionListItemsDelta(delta);
        });
    } else {
      this.chatSessionItemsService.sessionListItemsChanged$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.handleSessionListItemsDelta({ kind: 'full', affectsOrder: true });
        });
    }

    const sessionInventoryChanged$ = (this.chatSessionItemsService as unknown as {
      sessionInventoryChanged$?: { pipe: (...args: unknown[]) => { subscribe: (callback: () => void) => unknown } };
    }).sessionInventoryChanged$;
    if (sessionInventoryChanged$) {
      sessionInventoryChanged$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.handleSessionInventoryChanged();
        });
    }

    this.chatSessionSelectionService.selectedSessionIdChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((sessionId) => {
        const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (normalizedSessionId.length === 0) {
          return;
        }

        this._selectedSessionId = normalizedSessionId;
        if (this._showSessionPicker) {
          this._pickerRevealSessionId = normalizedSessionId;
        }
        this.invalidateGroupCaches();
        this.controlChangedSubject.next();
      });

    this.ailyChatConfigService.configChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.applyConfiguredSessionViewerOrientation(this.ailyChatConfigService.sessionViewerOrientation);
      });

    this.destroyRef.onDestroy(() => {
      this.cancelScheduledControlChanged();
    });

    this.reconcileSelection();
  }

  private handleSessionListItemsDelta(delta: ChatSessionListItemsDelta): void {
    this.invalidateGroupCaches();

    if (delta.kind === 'full' || delta.affectsOrder || !delta.sessionId || delta.sessionId === this._selectedSessionId || delta.sessionId === this.chatService.currentSessionId) {
      this.reconcileSelection();
    }

    const visibleDetailsReason = this.resolveVisibleDetailsRefreshReason(delta);
    if (visibleDetailsReason) {
      this.requestVisibleSessionDetails(visibleDetailsReason);
    }
    if (delta.affectsOrder && !this.updateLayoutProjection({ frameScheduled: true })) {
      this.emitControlChanged(true);
      return;
    }

    if (!delta.affectsOrder) {
      this.emitControlChanged(true);
    }
  }

  private handleSessionInventoryChanged(): void {
    this.cachedSessionPickerItems = null;
    this.cachedSessionPickerGroups = null;
    if (!this._showSessionPicker) {
      return;
    }

    this.reconcileSelection();
    this.requestVisibleSessionDetails('open-picker');
    this.emitControlChanged(true);
  }

  private resolveVisibleDetailsRefreshReason(delta: ChatSessionListItemsDelta): 'state' | 'terminal-transcript' | null {
    const reason = typeof delta.reason === 'string' ? delta.reason : '';
    if (reason === 'visible-details') {
      ChatPerformanceTracer.increment('session_list.visible_detail_hydration.blocked_visible_details_delta');
      return null;
    }

    if (reason === 'runtime-live_transcript') {
      ChatPerformanceTracer.increment('session_list.visible_detail_hydration.blocked_live');
      return null;
    }

    if (reason.startsWith('runtime-') && reason !== 'runtime-terminal_transcript') {
      ChatPerformanceTracer.increment('session_list.visible_detail_hydration.blocked_runtime_metadata');
      return null;
    }

    if (reason === 'runtime-terminal_transcript') {
      ChatPerformanceTracer.increment('session_list.visible_detail_hydration.allowed_terminal');
      return 'terminal-transcript';
    }

    if (delta.kind === 'full' || delta.affectsOrder || !delta.sessionId) {
      ChatPerformanceTracer.increment('session_list.visible_detail_hydration.allowed_state');
      return 'state';
    }

    return null;
  }

  get sessionListItems(): readonly ChatSessionListItem[] {
    return this.readDisplaySessionItems();
  }

  get sessionListGroups(): readonly ChatSessionInventoryGroup[] {
    const revision = this.readSessionListItemsRevision();
    if (this.cachedSessionListGroups?.revision === revision) {
      return this.cachedSessionListGroups.groups;
    }

    const groups = groupChatSessionItemsByDate(this.sessionListItems, { includeArchived: true });
    this.cachedSessionListGroups = { revision, groups };
    return groups;
  }

  get sessionPickerGroups(): readonly ChatSessionInventoryGroup[] {
    const revision = this.readSessionPickerItemsRevision();
    if (this.cachedSessionPickerGroups?.revision === revision) {
      return this.cachedSessionPickerGroups.groups;
    }

    const groups = groupChatSessionItemsByDate(this.readPickerDisplaySessionItems(), { includeArchived: false });
    this.cachedSessionPickerGroups = { revision, groups };
    return groups;
  }

  get showSessionPicker(): boolean {
    return this._showSessionPicker;
  }

  get sessionPickerPosition(): MenuPosition {
    return this._sessionPickerPosition;
  }

  get selectedSessionId(): string {
    return this._selectedSessionId;
  }

  get pickerRevealSessionId(): string {
    return this._pickerRevealSessionId;
  }

  get sessionViewportWidth(): number {
    return this._sessionViewportWidth;
  }

  get sessionSidebarWidth(): number {
    return this._sessionSidebarWidth;
  }

  get sessionSidebarMaxWidth(): number {
    return this._sessionSidebarMaxWidth;
  }

  get hasConversationContent(): boolean {
    return this._hasConversationContent;
  }

  get hasCurrentSession(): boolean {
    return this._hasCurrentSession;
  }

  get isAuthenticated(): boolean {
    return this._isAuthenticated;
  }

  get sessionListDisplayMode(): 'hidden' | 'stacked' | 'sidebar' {
    return this._sessionListDisplayMode;
  }

  get sessionViewerOrientation(): ChatSessionViewerOrientationSetting {
    return this._sessionViewerOrientation;
  }

  get showLoginSurface(): boolean {
    return !this._isAuthenticated
      && this.sessionListItems.length === 0
      && !this._hasConversationContent
      && !this._hasCurrentSession;
  }

  get showWelcomeSurface(): boolean {
    return this.resolveWelcomeSurfaceVisibility({
      hasSessions: this.sessionListItems.length > 0,
      hasConversationContent: this._hasConversationContent,
      hasCurrentSession: this._hasCurrentSession,
    });
  }

  get isSessionViewerSuppressed(): boolean {
    return this._isSessionViewerSuppressed;
  }

  get isSubappDockExpanded(): boolean {
    return this._isSubappDockExpanded;
  }

  get showSessionSidebar(): boolean {
    return this._sessionListDisplayMode === 'sidebar';
  }

  get showStackedSessionList(): boolean {
    return this._sessionListDisplayMode === 'stacked';
  }

  readSessionTitleActionContext(input?: {
    isChatSurface?: boolean;
    isBlankSessionSurface?: boolean;
  }): ChatSessionTitleActionContext {
    return {
      isChatSurface: input?.isChatSurface !== false,
      isBlankSessionSurface: input?.isBlankSessionSurface === true,
      hasSessions: this.sessionListItems.length > 0,
      hasConversationContent: this._hasConversationContent,
      hasCurrentSession: this._hasCurrentSession,
      sessionListDisplayMode: this._sessionListDisplayMode,
    };
  }

  setSessionViewportWidth(width: number): void {
    if (typeof width !== 'number' || !Number.isFinite(width) || width < 0 || width === this._sessionViewportWidth) {
      return;
    }

    this._sessionViewportWidth = width;
    this.updateLayoutProjection();
  }

  setSessionSidebarWidth(width: number, options?: { persist?: boolean }): void {
    const nextRequestedWidth = this.normalizeRequestedSessionSidebarWidth(width);
    if (nextRequestedWidth === this._requestedSessionSidebarWidth) {
      if (options?.persist !== false) {
        this.persistSessionSidebarWidth(nextRequestedWidth);
      }
      this.updateLayoutProjection();
      return;
    }

    this._requestedSessionSidebarWidth = nextRequestedWidth;
    if (options?.persist !== false) {
      this.persistSessionSidebarWidth(nextRequestedWidth);
    }
    this.updateLayoutProjection();
  }

  syncViewerLayout(input: {
    hasConversationContent: boolean;
    hasCurrentSession: boolean;
    isAuthenticated: boolean;
  }): void {
    const nextHasConversationContent = input.hasConversationContent === true;
    const nextHasCurrentSession = input.hasCurrentSession === true;
    const nextIsAuthenticated = input.isAuthenticated === true;

    if (nextHasConversationContent === this._hasConversationContent
      && nextHasCurrentSession === this._hasCurrentSession
      && nextIsAuthenticated === this._isAuthenticated) {
      return;
    }

    this._hasConversationContent = nextHasConversationContent;
    this._hasCurrentSession = nextHasCurrentSession;
    this._isAuthenticated = nextIsAuthenticated;
    if (!this.updateLayoutProjection()) {
      this.controlChangedSubject.next();
    }
  }

  setSessionViewerSuppressed(suppressed: boolean): void {
    const nextSuppressed = suppressed === true;
    if (nextSuppressed === this._isSessionViewerSuppressed) {
      return;
    }

    this._isSessionViewerSuppressed = nextSuppressed;
    if (!this.updateLayoutProjection()) {
      this.controlChangedSubject.next();
    }
  }

  setSubappDockExpanded(expanded: boolean): void {
    const nextExpanded = expanded === true;
    if (nextExpanded === this._isSubappDockExpanded) {
      return;
    }

    this._isSubappDockExpanded = nextExpanded;
    if (!this.updateLayoutProjection()) {
      this.controlChangedSubject.next();
    }
  }

  resolveSessionListDisplayMode(input: {
    hasSessions: boolean;
    hasConversationContent: boolean;
    hasCurrentSession: boolean;
  }): 'hidden' | 'stacked' | 'sidebar' {
    if (this._isSessionViewerSuppressed) {
      return 'hidden';
    }

    if (this._isSubappDockExpanded) {
      return 'hidden';
    }

    if (!input.hasConversationContent) {
      if (this.resolveWelcomeSurfaceVisibility(input)) {
        return 'hidden';
      }

      return this.resolveEntryStateDisplayMode();
    }

    if (!input.hasSessions) {
      return 'hidden';
    }

    if (this._sessionViewerOrientation === 'stacked') {
      return 'hidden';
    }

    return this.shouldPreferSideBySideSessionViewer()
      ? 'sidebar'
      : 'hidden';
  }

  resolveWelcomeSurfaceVisibility(input: {
    hasSessions: boolean;
    hasConversationContent: boolean;
    hasCurrentSession: boolean;
  }): boolean {
    if (!this._isAuthenticated) {
      return false;
    }

    // VS Code only shows the pane welcome view when there is no core/default chat
    // path available. aily-chat currently always has a default submit path, so a
    // fresh pane should stay in entry state and let the first submit create the
    // new session instead of hiding the input behind a generic welcome surface.
    return false;
  }

  openSessionPicker(anchor?: MouseEvent | null): void {
    const pickerItems = this.readPickerDisplaySessionItems();
    if (pickerItems.length === 0) {
      this.message.info(this.translate.instant('AILY_CHAT.NO_HISTORY_SESSION') || '没有历史会话记录');
      return;
    }

    this.menuManager.closeAll();
    const preferredSessionId = this.resolvePreferredSessionId(pickerItems);
    if (preferredSessionId) {
      this._selectedSessionId = preferredSessionId;
      this._pickerRevealSessionId = preferredSessionId;
    }

    this._sessionPickerPosition = this.resolveSessionPickerPosition(anchor);
    this._showSessionPicker = !this._showSessionPicker;
    if (!this._showSessionPicker) {
      this._pickerRevealSessionId = '';
    }

    this.requestVisibleSessionDetails('layout');
    this.controlChangedSubject.next();
  }

  closeSessionPicker(): void {
    if (!this._showSessionPicker && this._pickerRevealSessionId.length === 0) {
      return;
    }

    this._showSessionPicker = false;
    this._pickerRevealSessionId = '';
    this.controlChangedSubject.next();
  }

  selectSession(sessionId: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (normalizedSessionId.length === 0 || normalizedSessionId === this._selectedSessionId) {
      return;
    }

    this._selectedSessionId = normalizedSessionId;
    if (this._showSessionPicker) {
      this._pickerRevealSessionId = normalizedSessionId;
    }
    this.controlChangedSubject.next();
  }

  private reconcileSelection(): void {
    const preferredSessionId = this.resolvePreferredSessionId(
      this._showSessionPicker
        ? this.readPickerDisplaySessionItems()
        : this.readDisplaySessionItems(),
    );
    this._selectedSessionId = preferredSessionId;

    if (!this._showSessionPicker) {
      this._pickerRevealSessionId = '';
      return;
    }

    this._pickerRevealSessionId = preferredSessionId;
  }

  private updateLayoutProjection(options?: { frameScheduled?: boolean }): boolean {
    const layoutSpan = ChatPerformanceTracer.begin('session_list.layout_projection');
    ChatPerformanceTracer.increment('session_list.layout_projection');
    const nextSidebarMaxWidth = this.resolveSessionSidebarMaxWidth(this._sessionViewportWidth);
    const nextSidebarWidth = this.resolveEffectiveSessionSidebarWidth(this._sessionViewportWidth, this._requestedSessionSidebarWidth);
    const nextDisplayMode = this.resolveSessionListDisplayMode({
      hasSessions: this.sessionListItems.length > 0,
      hasConversationContent: this._hasConversationContent,
      hasCurrentSession: this._hasCurrentSession,
    });

    if (nextDisplayMode === this._sessionListDisplayMode
      && nextSidebarWidth === this._sessionSidebarWidth
      && nextSidebarMaxWidth === this._sessionSidebarMaxWidth) {
      ChatPerformanceTracer.end(layoutSpan, 'session_list.layout_projection', 'unchanged');
      return false;
    }

    this._sessionListDisplayMode = nextDisplayMode;
    this._sessionSidebarWidth = nextSidebarWidth;
    this._sessionSidebarMaxWidth = nextSidebarMaxWidth;
    this.requestVisibleSessionDetails('state');
    this.emitControlChanged(options?.frameScheduled === true);
    ChatPerformanceTracer.end(layoutSpan, 'session_list.layout_projection', nextDisplayMode);
    return true;
  }

  private emitControlChanged(frameScheduled = false): void {
    if (!frameScheduled || typeof globalThis.requestAnimationFrame !== 'function') {
      this.cancelScheduledControlChanged();
      this.controlChangedSubject.next();
      return;
    }

    if (this.pendingControlChangedFrameId !== null) {
      return;
    }

    this.pendingControlChangedFrameId = globalThis.requestAnimationFrame(() => {
      this.pendingControlChangedFrameId = null;
      this.controlChangedSubject.next();
    });
  }

  private cancelScheduledControlChanged(): void {
    if (this.pendingControlChangedFrameId === null || typeof globalThis.cancelAnimationFrame !== 'function') {
      this.pendingControlChangedFrameId = null;
      return;
    }

    globalThis.cancelAnimationFrame(this.pendingControlChangedFrameId);
    this.pendingControlChangedFrameId = null;
  }

  private invalidateGroupCaches(): void {
    this.cachedSessionListGroups = null;
    this.cachedSessionPickerItems = null;
    this.cachedSessionPickerGroups = null;
  }

  private readDisplaySessionItems(): readonly ChatSessionListItem[] {
    return this.prependProjectedTargetItems(this.chatSessionItemsService.sessionListItems, 'current-project');
  }

  private readPickerDisplaySessionItems(): readonly ChatSessionListItem[] {
    const revision = this.readSessionPickerItemsRevision();
    if (this.cachedSessionPickerItems?.revision === revision) {
      return this.cachedSessionPickerItems.items;
    }

    const items = this.prependProjectedTargetItems(
      this.chatSessionItemsService.readSessionSummaryViewItems(undefined, undefined, undefined, 'current-project'),
      'current-project',
    );
    this.cachedSessionPickerItems = { revision, items };
    return items;
  }

  private prependProjectedTargetItems(
    baseItems: readonly ChatSessionListItem[],
    filter: 'all' | 'current-project',
  ): readonly ChatSessionListItem[] {
    const projectedTargetIds = this.resolveProjectedTargetSessionIds();
    if (projectedTargetIds.length === 0) {
      return baseItems;
    }

    const knownSessionIds = new Set(baseItems.map(item => item.sessionId));
    const projectedItems: ChatSessionListItem[] = [];
    for (const sessionId of projectedTargetIds) {
      if (knownSessionIds.has(sessionId)) {
        continue;
      }

      const projectedItem = this.chatSessionItemsService.readOrProjectSessionSummary?.(sessionId, undefined, undefined, filter) ?? null;
      if (!projectedItem) {
        continue;
      }

      knownSessionIds.add(projectedItem.sessionId);
      projectedItems.push(projectedItem);
    }

    if (projectedItems.length === 0) {
      return baseItems;
    }

    return [...projectedItems, ...baseItems];
  }

  private resolveProjectedTargetSessionIds(): readonly string[] {
    const targetSessionIds = new Set<string>();
    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (currentSessionId.length > 0 && this.chatService.hasBlankSessionShell !== true) {
      targetSessionIds.add(currentSessionId);
    }

    const selectedSessionId = this._selectedSessionId.trim();
    if (selectedSessionId.length > 0) {
      targetSessionIds.add(selectedSessionId);
    }

    const revealSessionId = this._pickerRevealSessionId.trim();
    if (revealSessionId.length > 0) {
      targetSessionIds.add(revealSessionId);
    }

    return [...targetSessionIds];
  }

  private readSessionListItemsRevision(): string {
    return [
      String(this.chatSessionItemsService.sessionListRevision),
      this.chatService.currentSessionId?.trim?.() ?? '',
      this._selectedSessionId.trim(),
      this._pickerRevealSessionId.trim(),
    ].join('|');
  }

  private readSessionPickerItemsRevision(): string {
    const sessionInventoryRevision = (this.chatSessionItemsService as unknown as { sessionInventoryRevision?: number }).sessionInventoryRevision;
    return [
      String(sessionInventoryRevision ?? this.chatSessionItemsService.sessionListRevision),
      this.chatService.currentSessionId?.trim?.() ?? '',
      this._selectedSessionId.trim(),
      this._pickerRevealSessionId.trim(),
    ].join('|');
  }

  private requestVisibleSessionDetails(reason: 'state' | 'terminal-transcript' | 'open-picker' | 'layout'): void {
    const sessionIds = this.resolveVisibleSessionIds();
    if (sessionIds.length === 0) {
      return;
    }

    this.chatSessionItemsService.requestSessionListRefresh({
      reason,
      scope: 'visible-details',
      priority: 'after-paint',
      sessionIds,
      filter: 'current-project',
    });
  }

  private resolveVisibleSessionIds(): readonly string[] {
    const sourceItems = this._showSessionPicker
      ? this.readPickerDisplaySessionItems().filter(item => item.archived !== true)
      : this.sessionListItems;

    return sourceItems
      .slice(0, ChatSessionsControlService.VISIBLE_DETAIL_HYDRATION_LIMIT)
      .map(item => item.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.trim().length > 0);
  }

  private readPersistedSessionSidebarWidth(): number {
    const persistedWidth = AilyHost.get().config.data?.[SESSION_SIDEBAR_WIDTH_CONFIG_KEY];
    return this.normalizeRequestedSessionSidebarWidth(persistedWidth);
  }

  private persistSessionSidebarWidth(width: number): void {
    const config = AilyHost.get().config;
    if (config.data) {
      config.data[SESSION_SIDEBAR_WIDTH_CONFIG_KEY] = width;
    }
    config.save?.();
  }

  private normalizeRequestedSessionSidebarWidth(width: unknown): number {
    return typeof width === 'number' && Number.isFinite(width)
      ? Math.max(this.sessionSidebarResizeMinWidth, Math.round(width))
      : this.sessionSidebarDefaultWidth;
  }

  private resolveSessionSidebarMaxWidth(viewportWidth: number): number {
    if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
      return Math.max(this.sessionSidebarResizeMinWidth, this.sessionSidebarDefaultWidth);
    }

    return Math.max(this.sessionSidebarResizeMinWidth, Math.floor(viewportWidth - this.sessionStageMinWidth));
  }

  private resolveEffectiveSessionSidebarWidth(viewportWidth: number, requestedWidth: number): number {
    const nextMaxWidth = this.resolveSessionSidebarMaxWidth(viewportWidth);
    return Math.max(this.sessionSidebarResizeMinWidth, Math.min(requestedWidth, nextMaxWidth));
  }

  private resolveEntryStateDisplayMode(): 'stacked' | 'sidebar' {
    if (this._sessionViewerOrientation === 'stacked') {
      return 'stacked';
    }

    return this.shouldPreferSideBySideSessionViewer()
      ? 'sidebar'
      : 'stacked';
  }

  private shouldPreferSideBySideSessionViewer(): boolean {
    return this._sessionViewportWidth >= this.sessionSidebarMinWidth;
  }

  private applyConfiguredSessionViewerOrientation(orientation: ChatSessionViewerOrientationSetting): void {
    if (orientation === this._sessionViewerOrientation) {
      return;
    }

    this._sessionViewerOrientation = orientation;
    if (!this.updateLayoutProjection()) {
      this.controlChangedSubject.next();
    }
  }

  private resolvePreferredSessionId(items: readonly ChatSessionListItem[] = this.sessionListItems): string {
    if (items.length === 0) {
      return '';
    }

    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    const currentItem = items.find(item => item.current || (currentSessionId.length > 0 && item.sessionId === currentSessionId));
    if (currentItem?.sessionId) {
      return currentItem.sessionId;
    }

    const selectedSessionId = this._selectedSessionId.trim();
    if (selectedSessionId.length > 0 && items.some(item => item.sessionId === selectedSessionId)) {
      return selectedSessionId;
    }
    return '';
  }

  private resolveSessionPickerPosition(anchor?: MouseEvent | null): MenuPosition {
    const anchorRect = this.extractSessionPickerAnchorRect(anchor);
    if (!anchorRect) {
      return { x: window.innerWidth - 302, y: 72 };
    }

    const pickerWidth = 300;
    const pickerHeight = 360;
    const gap = 4;
    let x = anchorRect.left;
    let y = anchorRect.bottom + gap;

    if (x + pickerWidth > window.innerWidth - 8) {
      x = Math.max(8, anchorRect.right - pickerWidth);
    }

    if (y + pickerHeight > window.innerHeight - 8) {
      y = Math.max(8, anchorRect.top - pickerHeight - gap);
    }

    return { x: Math.max(0, x), y: Math.max(0, y) };
  }

  private extractSessionPickerAnchorRect(anchor?: MouseEvent | null): { left: number; right: number; top: number; bottom: number } | null {
    if (anchor && typeof anchor.preventDefault === 'function') {
      anchor.preventDefault();
    }
    if (anchor && typeof anchor.stopPropagation === 'function') {
      anchor.stopPropagation();
    }

    const directRect = this.readRectLike(anchor as unknown);
    if (directRect) {
      return directRect;
    }

    const currentTarget = anchor && typeof anchor === 'object' && 'currentTarget' in anchor
      ? (anchor as { currentTarget?: unknown }).currentTarget
      : undefined;
    return this.readRectLike(currentTarget);
  }

  private readRectLike(value: unknown): { left: number; right: number; top: number; bottom: number } | null {
    const rectSource = value && typeof value === 'object' && 'getBoundingClientRect' in value
      ? (value as { getBoundingClientRect?: () => Partial<{ left: number; right: number; top: number; bottom: number }> }).getBoundingClientRect?.()
      : value;

    if (!rectSource || typeof rectSource !== 'object') {
      return null;
    }

    const left = (rectSource as { left?: unknown }).left;
    const right = (rectSource as { right?: unknown }).right;
    const top = (rectSource as { top?: unknown }).top;
    const bottom = (rectSource as { bottom?: unknown }).bottom;

    return typeof left === 'number'
      && typeof right === 'number'
      && typeof top === 'number'
      && typeof bottom === 'number'
      ? { left, right, top, bottom }
      : null;
  }
}
