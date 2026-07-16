import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { filter, Subject } from 'rxjs';

import { IMenuItem } from '../../../configs/menu.config';
import { normalizeAgentIdentifier, normalizeAgentIdentifiers } from '../core/agent-identifiers';
import {
  CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL,
  CHAT_CUSTOM_AGENT_EDIT_ACTION_ID,
  CHAT_CUSTOM_AGENT_VIEW_ACTION_ID,
  CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
} from '../helpers/chat-configure-custom-agents-action';
import {
  insertComposerLineBreak,
  resolveComposerKeyAction as _resolveComposerKeyAction,
  resolveAgentSuggestionKeyAction,
  type AgentSuggestionKeyAction,
  type ComposerKeyAction,
  type ComposerLineBreakEdit,
} from '../helpers/chat-composer-view';
import { buildChatModelMenuState } from '../helpers/chat-model-menu-builder';
import {
  AilyChatConfigService,
} from './aily-chat-config.service';
import { AilyChatLanguageModelsService } from './aily-chat-language-models.service';
import { ChatDebugBrowserService } from './chat-debug-browser.service';
import { ChatSessionItemsService, type ChatSessionListLoadState } from './chat-session-items.service';
import {
  ChatSessionModelStoreService,
  type ChatSessionModelStoreChangedEvent,
} from './chat-session-model-store.service';
import { ChatSessionRuntimeStoreService } from './chat-session-runtime-store.service';
import { ChatSessionViewModelStoreService, type ChatSessionViewModel } from './chat-session-view-model-store.service';
import { ChatSessionsControlService } from './chat-sessions-control.service';
import { ChatService } from './chat.service';
import { type ChatSessionListItem, type MenuPosition } from './menu-manager.service';
import {
  isPlanChatResolvedMode,
  createPlanChatResolvedMode,
  normalizeChatSelectedMode,
  resolveChatCurrentMode,
  type ChatResolvedMode,
  type ChatResolvedModeTarget,
  type ChatSelectedMode,
  type ChatSurfaceModeId,
} from '../core/chat-mode';
import { isCustomSessionTitleSource, normalizeChatSessionTitleSource, type ChatSessionDisplayTitle, type ChatSessionTitleSource } from '../core/chat-session-title';
import { isSameChatSessionScopePath, normalizeChatSessionScopePath } from '../core/chat-session-scope';
import { AilyHost } from '../core/host';
import type { ChatHostHeaderActionContext } from '../core/chat-host-header-actions';
import type { ChatHostHeaderActionRequest } from '../core/chat-host-header-actions';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { resolveHostSessionSelectedModeFromMetadata } from '../helpers/host-session-input-state';
import type { ChatSessionTitleActionContext, ChatSessionTitleActionRequest, ChatSessionTitleSurfaceModel } from '../core/chat-session-title-actions';
import { ChatHostHeaderActionRegistry } from '../helpers/chat-host-header-action-registry';
import { ChatSessionTitleActionRegistry } from '../helpers/chat-session-title-action-registry';
import type { ChatSessionInventoryGroup } from '../helpers/chat-session-presentation';

const BUILTIN_AGENT_PICKER_NAMES = new Set(['agent', 'ask', 'edit', 'qa']);

function isPaneStateTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.tracePaneState', [
    '__AILY_CHAT_TRACE_PANE_STATE__',
    'AILY_CHAT_TRACE_PANE_STATE',
  ]) || isAilyCategoryDebugEnabled('aily.chat.traceRequestState', [
    '__AILY_CHAT_TRACE_REQUEST_STATE__',
    'AILY_CHAT_TRACE_REQUEST_STATE',
  ]);
}

export type ChatPaneSurface = 'chat' | 'blank-session' | 'session-loading' | 'entry' | 'welcome' | 'login' | 'debug-home' | 'debug-session';

export interface ChatPaneSessionListSurfaceModel {
  readonly title: string;
  readonly variant: 'sidebar' | 'entry';
  readonly groups: readonly ChatSessionInventoryGroup[];
  readonly loadState: ChatSessionListLoadState;
  readonly hostClasses: readonly string[];
}

export interface ChatPaneSessionPickerSurfaceModel {
  readonly groups: readonly ChatSessionInventoryGroup[];
  readonly selectedSessionId: string;
  readonly revealSessionId: string;
  readonly position: MenuPosition;
  readonly width: number;
  readonly maxHeight: number;
}

export interface ChatPaneEntryInfoSurfaceModel {
  readonly iconClass: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly actionLabelKey: string;
  readonly hostClasses: readonly string[];
}

export interface ChatPaneLoadingSurfaceModel {
  readonly sessionId: string;
  readonly title: string;
  readonly iconClass: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly hostClasses: readonly string[];
}

export interface ChatPaneStageSurfaceModel {
  readonly paneSurface: 'chat' | 'blank-session' | 'session-loading' | 'entry' | 'welcome';
  readonly showConversation: boolean;
  readonly guideSurface: ChatPaneEntryInfoSurfaceModel | null;
  readonly loadingSurface?: ChatPaneLoadingSurfaceModel | null;
  readonly showSidebarSessionList: boolean;
  readonly sidebarSessionListSurface: ChatPaneSessionListSurfaceModel | null;
  readonly showStackedSessionList: boolean;
  readonly stackedSessionListSurface: ChatPaneSessionListSurfaceModel | null;
  readonly showSender: boolean;
}

interface ChatPaneChromeActionBindings {
  readonly runNewChatAction: () => boolean;
  readonly runToggleSettingsAction: () => boolean;
  readonly runGoBackAction: () => boolean;
  readonly runPickSessionAction: (event: MouseEvent) => boolean;
}

/**
 * ChatViewService
 *
 * 收拢 aily-chat 组件中的纯视图状态，避免 host shell 继续堆积
 * 与 agent/runtime 无关的 UI 字段与派生逻辑。
 */
@Injectable()
export class ChatViewService {
  readonly senderMinHeight = 180;
  readonly senderMaxHeight = 600;

  currentUrl = '';
  bottomHeight = this.senderMinHeight;
  showSettings = false;
  showAgentSuggestions = false;
  agentSuggestions: string[] = [];
  private readonly sessionViewModelChangedSubject = new Subject<void>();
  private paneChromeActionBindings: ChatPaneChromeActionBindings | null = null;
  private lastPaneDiagnosticsKey = '';
  private lastPaneLayoutDiagnosticsKey = '';
  private lastPaneLayoutDiagnosticsLogAt = 0;
  private sessionModelViewRefreshHandle: { dispose(): void } | null = null;
  private sessionModelViewRefreshPending = false;
  private pendingSessionLoad: {
    readonly sessionId: string;
    readonly title: string;
    readonly visible: boolean;
  } | null = null;

  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly ailyChatConfigService = inject(AilyChatConfigService);
  private readonly languageModelsService = inject(AilyChatLanguageModelsService);
  private readonly debugBrowser = inject(ChatDebugBrowserService);
  private readonly chatSessionItemsService = inject(ChatSessionItemsService);
  private readonly chatSessionModelStore = inject(ChatSessionModelStoreService);
  private readonly chatSessionRuntimeStore = inject(ChatSessionRuntimeStoreService);
  private readonly chatSessionViewModelStore = inject(ChatSessionViewModelStoreService);
  private readonly chatSessionsControlService = inject(ChatSessionsControlService);
  private readonly chatService = inject(ChatService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostHeaderActionRegistry = new ChatHostHeaderActionRegistry(() => ({
    ...this.readHostHeaderActionContext(),
    runNewChatAction: () => this.paneChromeActionBindings?.runNewChatAction() ?? false,
    runToggleSettingsAction: () => this.paneChromeActionBindings?.runToggleSettingsAction() ?? false,
  }));
  private readonly sessionTitleActionRegistry = new ChatSessionTitleActionRegistry(() => ({
    ...this.readSessionTitleActionContext({
      hasConversationContent: this.hasConversationContent,
    }),
    runGoBackAction: () => this.paneChromeActionBindings?.runGoBackAction() ?? false,
    runPickSessionAction: (event: MouseEvent) => this.paneChromeActionBindings?.runPickSessionAction(event) ?? false,
  }));

  private availableCustomModes: ChatResolvedMode[] = [];
  readonly sessionViewModelChanged$ = this.sessionViewModelChangedSubject.asObservable();

  constructor() {
    this.currentUrl = this.router.url;
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.currentUrl = event.urlAfterRedirects;
      });

    this.chatSessionsControlService.controlChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshSessionViewModel();
      });
    this.chatSessionItemsService.sessionListLoadStateChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshSessionViewModel();
      });
    this.chatSessionViewModelStore.changed$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshSessionViewModel();
      });
    this.chatSessionModelStore.changed$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event.sessionResource === this.currentViewSessionResource) {
          if (this.isAttachedRendererOwnedModelChange(event)) {
            return;
          }
          this.scheduleSessionModelViewRefresh();
        }
      });
    this.chatService.sessionInputStateChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshSessionViewModel();
      });
    (this.chatService.sessionDisplayTitleChanged$ ?? this.chatService.sessionTitleChanged$)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.sessionViewModelChangedSubject.next();
      });
    this.debugBrowser.onDidChange
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.syncSessionViewerSuppression();
        this.refreshSessionViewModel();
      });

    this.syncSessionViewerSuppression();
    this.destroyRef.onDestroy(() => this.clearPendingSessionModelViewRefresh());
  }

  get isStandaloneWindow(): boolean {
    return this.currentUrl === '/aily-chat';
  }

  get sessionListItems(): readonly ChatSessionListItem[] {
    return this.chatSessionsControlService.sessionListItems;
  }

  get currentViewModel(): ChatSessionViewModel | null {
    return this.chatSessionViewModelStore.currentViewModel;
  }

  get currentViewSessionResource(): string {
    const sessionResource = this.currentViewModel?.sessionResource;
    return typeof sessionResource === 'string' ? sessionResource.trim() : '';
  }

  get currentViewSessionId(): string {
    return this.currentViewSessionResource;
  }

  get sessionSidebarMinWidth(): number {
    return this.chatSessionsControlService.sessionSidebarMinWidth;
  }

  get sessionSidebarDefaultWidth(): number {
    return this.chatSessionsControlService.sessionSidebarDefaultWidth;
  }

  get sessionSidebarResizeMinWidth(): number {
    return this.chatSessionsControlService.sessionSidebarResizeMinWidth;
  }

  get sessionViewportWidth(): number {
    return this.chatSessionsControlService.sessionViewportWidth;
  }

  get sessionSidebarWidth(): number {
    return this.chatSessionsControlService.sessionSidebarWidth;
  }

  get sessionSidebarMaxWidth(): number {
    return this.chatSessionsControlService.sessionSidebarMaxWidth;
  }

  get entrySessionItems(): ReadonlyArray<{ sessionId: string; title: string; current: boolean }> {
    return this.sessionListItems.map(item => ({
      sessionId: item.sessionId,
      title: item.title,
      current: item.current,
    }));
  }

  get currentSessionDisplayTitle(): ChatSessionDisplayTitle {
    if (!this.hasActiveSessionTitleOwner) {
      return {
        text: '',
        source: 'empty',
        durable: false,
      };
    }

    const projectedTitle = this.readProjectedCurrentSessionDisplayTitle();
    const liveTitle = this.readLiveCurrentSessionDisplayTitle();

    if (projectedTitle.text && (!liveTitle.text || !liveTitle.durable)) {
      return projectedTitle;
    }

    if (liveTitle.text) {
      return liveTitle;
    }

    if (projectedTitle.text) {
      return projectedTitle;
    }

    return {
      text: '',
      source: 'empty',
      durable: false,
    };
  }

  get currentSessionTitle(): string {
    return this.currentSessionDisplayTitle.text;
  }

  get currentPaneTitle(): string {
    switch (this.currentPaneSurface) {
      case 'debug-session':
        return this.debugBrowser.activeImportedResourceSummary?.displayTitle ?? '';
      case 'chat':
      case 'blank-session':
        return this.currentSessionDisplayTitle.text
          || (!this.hasActiveSessionTitleOwner ? this.readDefaultPaneTitle() : '');
      case 'session-loading':
        return this.pendingSessionLoad?.title
          || this.currentSessionDisplayTitle.text
          || (!this.hasActiveSessionTitleOwner ? this.readDefaultPaneTitle() : '');
      default:
        return '';
    }
  }

  get showSessionPicker(): boolean {
    return this.chatSessionsControlService.showSessionPicker;
  }

  get sessionPickerPosition(): MenuPosition {
    return this.chatSessionsControlService.sessionPickerPosition;
  }

  get selectedSessionId(): string {
    return this.chatSessionsControlService.selectedSessionId;
  }

  get pickerRevealSessionId(): string {
    return this.chatSessionsControlService.pickerRevealSessionId;
  }

  get sessionListGroups(): readonly ChatSessionInventoryGroup[] {
    return this.chatSessionsControlService.sessionListGroups;
  }

  get sessionPickerGroups(): readonly ChatSessionInventoryGroup[] {
    return this.chatSessionsControlService.sessionPickerGroups;
  }

  get sessionListDisplayMode(): 'hidden' | 'stacked' | 'sidebar' {
    return this.chatSessionsControlService.sessionListDisplayMode;
  }

  get showSessionSidebar(): boolean {
    return this.chatSessionsControlService.showSessionSidebar;
  }

  get showStackedSessionList(): boolean {
    return this.chatSessionsControlService.showStackedSessionList;
  }

  get showLoginSurface(): boolean {
    return this.chatSessionsControlService.showLoginSurface;
  }

  get showWelcomeSurface(): boolean {
    return this.currentPaneSurface === 'welcome';
  }

  get hasConversationContent(): boolean {
    return this.readCurrentViewHasConversationContent();
  }

  get sessionTitleSurfaceModel(): ChatSessionTitleSurfaceModel {
    return this.sessionTitleActionRegistry.getSurfaceModel(this.currentPaneTitle);
  }

  get isSessionTitleSurfaceClickEnabled(): boolean {
    return this.currentPaneSurface === 'chat'
      || this.currentPaneSurface === 'blank-session'
      || this.currentPaneSurface === 'session-loading';
  }

  get hostHeaderActions() {
    return this.hostHeaderActionRegistry.getActions();
  }

  get sidebarSessionListSurfaceModel(): ChatPaneSessionListSurfaceModel {
    return this.buildSessionListSurfaceModel('sidebar');
  }

  get stackedSessionListSurfaceModel(): ChatPaneSessionListSurfaceModel {
    return this.buildSessionListSurfaceModel('stacked');
  }

  get sessionPickerSurfaceModel(): ChatPaneSessionPickerSurfaceModel | null {
    if (!this.showSessionPicker) {
      return null;
    }

    return {
      groups: this.sessionPickerGroups,
      selectedSessionId: this.selectedSessionId,
      revealSessionId: this.pickerRevealSessionId,
      position: this.sessionPickerPosition,
      width: 320,
      maxHeight: 360,
    };
  }

  get paneStageSurfaceModel(): ChatPaneStageSurfaceModel | null {
    const paneSurface = this.currentPaneSurface;
    if (paneSurface !== 'chat'
      && paneSurface !== 'blank-session'
      && paneSurface !== 'session-loading'
      && paneSurface !== 'entry'
      && paneSurface !== 'welcome') {
      return null;
    }

    const showSessionInventory = paneSurface === 'entry'
      || paneSurface === 'chat'
      || paneSurface === 'welcome'
      || paneSurface === 'blank-session'
      || paneSurface === 'session-loading';
    const showSidebarSessionList = showSessionInventory
      && this.showSessionSidebar;
    const showStackedSessionList = showSessionInventory
      && this.showStackedSessionList;

    return {
      paneSurface,
      showConversation: paneSurface === 'chat',
      guideSurface: this.buildGuideSurfaceModel(
        paneSurface === 'entry' || paneSurface === 'blank-session'
          ? 'entry'
          : paneSurface === 'welcome'
            ? 'welcome'
            : null,
      ),
      loadingSurface: paneSurface === 'session-loading' ? this.buildLoadingSurfaceModel() : null,
      showSidebarSessionList,
      sidebarSessionListSurface: showSidebarSessionList ? this.buildSessionListSurfaceModel('sidebar') : null,
      showStackedSessionList,
      stackedSessionListSurface: showStackedSessionList ? this.buildSessionListSurfaceModel('stacked') : null,
      showSender: paneSurface === 'chat'
        || paneSurface === 'blank-session'
        || paneSurface === 'session-loading'
        || paneSurface === 'entry',
    };
  }

  get entryInfoSurfaceModel(): ChatPaneEntryInfoSurfaceModel | null {
    return this.buildGuideSurfaceModel(this.currentPaneSurface === 'entry' ? 'entry' : null);
  }

  get currentPaneSurface(): ChatPaneSurface {
    if (this.showLoginSurface) {
      return 'login';
    }

    if (this.chatSessionsControlService.showWelcomeSurface) {
      return 'welcome';
    }

    if (this.pendingSessionLoad?.visible) {
      return 'session-loading';
    }

    const hasCurrentSessionIdentity = this.hasCurrentSessionIdentity;
    const hasActiveCurrentSessionRequest = this.hasActiveCurrentSessionRequest;
    const hasConversationContent = this.hasConversationContent;
    if (this.debugBrowser.isOpen
      && !hasCurrentSessionIdentity
      && !hasConversationContent
      && !hasActiveCurrentSessionRequest) {
      return this.debugBrowser.activeImportedResourceSummary ? 'debug-session' : 'debug-home';
    }

    if (!hasConversationContent && !hasActiveCurrentSessionRequest) {
      if (hasCurrentSessionIdentity && !this.isEmptyFreshSessionStartupShell) {
        return 'blank-session';
      }
      return 'entry';
    }

    if (!hasCurrentSessionIdentity) {
      return 'entry';
    }

    return 'chat';
  }

  openSessionPicker(anchor?: MouseEvent | null): void {
    this.chatSessionsControlService.openSessionPicker(anchor);
  }

  bindPaneChromeActions(bindings: ChatPaneChromeActionBindings): void {
    this.paneChromeActionBindings = bindings;
    this.refreshSessionViewModel();
  }

  runSessionTitleAction(request: ChatSessionTitleActionRequest): boolean {
    return this.sessionTitleActionRegistry.runAction(request);
  }

  runHostHeaderAction(request: ChatHostHeaderActionRequest): boolean {
    return this.hostHeaderActionRegistry.runAction(request);
  }

  closeSessionPicker(): void {
    this.chatSessionsControlService.closeSessionPicker();
  }

  retrySessionListLoad(): void {
    this.chatSessionItemsService.retryLastSessionListRefresh();
  }

  selectSession(sessionId: string): void {
    this.chatSessionsControlService.selectSession(sessionId);
  }

  beginSessionLoadSurface(input: { sessionId: string; title?: string | null }): void {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!sessionId) {
      return;
    }

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    this.pendingSessionLoad = {
      sessionId,
      title,
      visible: false,
    };
    this.chatSessionsControlService.selectSession(sessionId);
    this.refreshSessionViewModel();
  }

  revealSessionLoadSurface(sessionId: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId || this.pendingSessionLoad?.sessionId !== normalizedSessionId) {
      return;
    }

    if (this.pendingSessionLoad.visible) {
      return;
    }

    this.pendingSessionLoad = {
      ...this.pendingSessionLoad,
      visible: true,
    };
    this.refreshSessionViewModel();
  }

  clearSessionLoadSurface(sessionId?: string | null): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (normalizedSessionId && this.pendingSessionLoad?.sessionId !== normalizedSessionId) {
      return;
    }

    if (!this.pendingSessionLoad) {
      return;
    }

    this.pendingSessionLoad = null;
    this.refreshSessionViewModel();
  }

  syncSessionViewerLayout(input: {
    hasConversationContent: boolean;
    isAuthenticated: boolean;
  }): void {
    const hasCurrentSession = this.hasCurrentSessionIdentity;
    const hasConversationContent = hasCurrentSession
      ? this.readCurrentViewHasConversationContent(input.hasConversationContent)
      : false;
    this.chatSessionsControlService.syncViewerLayout({
      hasConversationContent,
      hasCurrentSession,
      isAuthenticated: input.isAuthenticated,
    });
    this.syncSessionViewerSuppression();
  }

  readSessionListDisplayMode(hasConversationContent: boolean): 'hidden' | 'stacked' | 'sidebar' {
    this.syncSessionViewerLayout({
      hasConversationContent,
      isAuthenticated: this.chatSessionsControlService.isAuthenticated,
    });

    return this.sessionListDisplayMode;
  }

  readSessionTitleActionContext(input: {
    hasConversationContent: boolean;
  }): ChatSessionTitleActionContext {
    this.syncSessionViewerLayout({
      hasConversationContent: input.hasConversationContent,
      isAuthenticated: this.chatSessionsControlService.isAuthenticated,
    });

    const paneSurface = this.currentPaneSurface;
    return this.chatSessionsControlService.readSessionTitleActionContext({
      isChatSurface: paneSurface === 'chat' || paneSurface === 'blank-session' || paneSurface === 'session-loading',
      isBlankSessionSurface: paneSurface === 'blank-session',
    });
  }

  readHostHeaderActionContext(): ChatHostHeaderActionContext {
    return {
      currentPaneSurface: this.currentPaneSurface,
      showSettings: this.showSettings,
    };
  }

  private syncSessionViewerSuppression(): void {
    const suppressForSurface = this.currentPaneSurface !== 'chat'
      && this.currentPaneSurface !== 'blank-session'
      && this.currentPaneSurface !== 'session-loading'
      && this.currentPaneSurface !== 'entry';
    this.chatSessionsControlService.setSessionViewerSuppressed(this.showSettings || suppressForSurface);
  }

  private buildSessionListSurfaceModel(displayMode: 'sidebar' | 'stacked'): ChatPaneSessionListSurfaceModel {
    if (displayMode === 'sidebar') {
      return {
        title: 'Sessions',
        variant: 'sidebar',
        groups: this.sessionListGroups,
        loadState: this.chatSessionItemsService.sessionListLoadState,
        hostClasses: ['chat-session-sidebar-content'],
      };
    }

    return {
      title: 'Sessions',
      variant: 'entry',
      groups: this.sessionListGroups,
      loadState: this.chatSessionItemsService.sessionListLoadState,
      hostClasses: this.currentPaneSurface === 'entry' || this.currentPaneSurface === 'blank-session'
        ? ['entry-session-control', 'entry-guide-stacked']
        : ['entry-session-control'],
    };
  }

  private buildGuideSurfaceModel(surface: 'entry' | 'welcome' | null): ChatPaneEntryInfoSurfaceModel | null {
    if (surface === 'entry') {
      return {
        iconClass: 'fa-light fa-star-christmas',
        titleKey: 'AILY_CHAT.SERVICE_TITLE',
        descriptionKey: 'AILY_CHAT.DISCLAIMER',
        actionLabelKey: 'AILY_CHAT.USAGE_GUIDE',
        hostClasses: ['guide-box', 'ccenter', 'entry-surface-guide'],
      };
    }

    if (surface === 'welcome') {
      return {
        iconClass: 'fa-light fa-star-christmas',
        titleKey: 'AILY_CHAT.SERVICE_TITLE',
        descriptionKey: 'AILY_CHAT.DISCLAIMER',
        actionLabelKey: 'AILY_CHAT.USAGE_GUIDE',
        hostClasses: ['guide-box', 'ccenter', 'welcome-surface-guide'],
      };
    }

    return null;
  }

  private buildLoadingSurfaceModel(): ChatPaneLoadingSurfaceModel | null {
    const pendingLoad = this.pendingSessionLoad;
    if (!pendingLoad) {
      return null;
    }

    return {
      sessionId: pendingLoad.sessionId,
      title: pendingLoad.title,
      iconClass: 'fa-light fa-spinner-third',
      titleKey: 'AILY_CHAT.SESSION_LOADING_TITLE',
      descriptionKey: 'AILY_CHAT.SESSION_LOADING_DESCRIPTION',
      hostClasses: ['guide-box', 'ccenter', 'session-loading-surface-guide'],
    };
  }

  private refreshSessionViewModel(): void {
    this.emitPaneDiagnostics();
    this.sessionViewModelChangedSubject.next();
  }

  private isAttachedRendererOwnedModelChange(event: ChatSessionModelStoreChangedEvent): boolean {
    return event.kind === 'updated'
      && (event.reason === 'appendTransientTurn'
        || event.reason === 'turnDelta'
        || event.reason === 'inputDraft'
        || event.reason === 'projection');
  }

  private scheduleSessionModelViewRefresh(): void {
    this.sessionModelViewRefreshPending = true;
    if (this.sessionModelViewRefreshHandle !== null) {
      return;
    }

    const schedule = typeof globalThis.requestAnimationFrame === 'function'
      ? (callback: () => void) => {
        const frameId = globalThis.requestAnimationFrame(callback);
        return { dispose: () => globalThis.cancelAnimationFrame?.(frameId) };
      }
      : (callback: () => void) => {
        const timerId = setTimeout(callback, 16);
        return { dispose: () => clearTimeout(timerId) };
      };

    this.sessionModelViewRefreshHandle = schedule(() => {
      this.sessionModelViewRefreshHandle = null;
      if (!this.sessionModelViewRefreshPending) {
        return;
      }
      this.sessionModelViewRefreshPending = false;
      this.sessionViewModelChangedSubject.next();
    });
  }

  private clearPendingSessionModelViewRefresh(): void {
    this.sessionModelViewRefreshHandle?.dispose();
    this.sessionModelViewRefreshHandle = null;
    this.sessionModelViewRefreshPending = false;
  }

  private emitPaneDiagnostics(): void {
    if (!this.debugBrowser.isOpen && !isPaneStateTraceEnabled()) {
      return;
    }

    const paneSurface = this.currentPaneSurface;
    const currentViewModel = this.currentViewModel;
    const currentModel = currentViewModel?.model ?? null;
    const currentProjection = currentModel?.hostProjectionState ?? null;
    const currentProjectionTurnCount = Array.isArray(currentProjection?.turnResponses)
      ? currentProjection.turnResponses.length
      : 0;
    const currentModelTurnCount = currentProjectionTurnCount > 0
      ? currentProjectionTurnCount
      : Array.isArray(currentModel?.turnResponses)
        ? currentModel.turnResponses.length
        : 0;
    const currentProjectionChatListCount = Array.isArray(currentProjection?.chatList)
      ? currentProjection.chatList.length
      : 0;
    const currentProjectionDialogCount = Array.isArray(currentProjection?.dialogItems)
      ? currentProjection.dialogItems.length
      : 0;
    const hasConversationContent = this.hasConversationContent;
    const liveSessionId = this.liveCurrentSessionResource;
    const liveRuntimeState = liveSessionId
      ? this.chatSessionRuntimeStore.read(liveSessionId)
      : undefined;
    const diagnostics = {
      paneSurface,
      hasConversationContent,
      controlHasConversationContent: this.chatSessionsControlService.hasConversationContent,
      hasCurrentSessionIdentity: this.hasCurrentSessionIdentity,
      hasCurrentSession: this.chatSessionsControlService.hasCurrentSession,
      hasBlankSessionShell: this.chatService.hasBlankSessionShell === true,
      currentSessionId: this.chatService.currentSessionId,
      currentViewSessionResource: this.currentViewSessionResource,
      liveSessionId,
      liveRequestInProgress: liveRuntimeState?.requestInProgress === true,
      liveStatus: liveRuntimeState?.status ?? null,
      currentModelTurnCount,
      currentProjectionTurnCount,
      currentProjectionChatListCount,
      currentProjectionDialogCount,
      currentPaneTitle: this.currentPaneTitle,
      pendingSessionLoad: this.pendingSessionLoad,
      liveSessionTitle: this.chatService.currentSessionTitle,
      projectedSessionTitle: this.currentSessionViewItem?.title ?? '',
      sessionListDisplayMode: this.chatSessionsControlService.sessionListDisplayMode,
      sessionViewportWidth: this.chatSessionsControlService.sessionViewportWidth,
      sessionSidebarMinWidth: this.chatSessionsControlService.sessionSidebarMinWidth,
      sessionSidebarWidth: this.chatSessionsControlService.sessionSidebarWidth,
      sessionSidebarMaxWidth: this.chatSessionsControlService.sessionSidebarMaxWidth,
      titleSurfaceShouldRender: this.sessionTitleSurfaceModel.shouldRender,
      titleSurfaceNavigationIconActionCount: this.sessionTitleSurfaceModel.navigationIconActions.length,
      titleSurfaceHasTitleAction: this.sessionTitleSurfaceModel.titleAction !== null,
      titleSurfaceActionCount: this.sessionTitleSurfaceModel.actions.length,
    };
    const semanticDiagnostics = {
      paneSurface,
      hasConversationContent,
      controlHasConversationContent: this.chatSessionsControlService.hasConversationContent,
      hasCurrentSessionIdentity: this.hasCurrentSessionIdentity,
      hasCurrentSession: this.chatSessionsControlService.hasCurrentSession,
      hasBlankSessionShell: this.chatService.hasBlankSessionShell === true,
      currentSessionId: this.chatService.currentSessionId,
      currentViewSessionResource: this.currentViewSessionResource,
      liveSessionId,
      liveRequestInProgress: liveRuntimeState?.requestInProgress === true,
      liveStatus: liveRuntimeState?.status ?? null,
      currentModelTurnCount,
      currentProjectionTurnCount,
      currentProjectionChatListCount,
      currentProjectionDialogCount,
      currentPaneTitle: this.currentPaneTitle,
      pendingSessionLoad: this.pendingSessionLoad,
      liveSessionTitle: this.chatService.currentSessionTitle,
      projectedSessionTitle: this.currentSessionViewItem?.title ?? '',
      sessionListDisplayMode: this.chatSessionsControlService.sessionListDisplayMode,
      titleSurfaceShouldRender: this.sessionTitleSurfaceModel.shouldRender,
      titleSurfaceNavigationIconActionCount: this.sessionTitleSurfaceModel.navigationIconActions.length,
      titleSurfaceHasTitleAction: this.sessionTitleSurfaceModel.titleAction !== null,
      titleSurfaceActionCount: this.sessionTitleSurfaceModel.actions.length,
    };
    const semanticKey = JSON.stringify(semanticDiagnostics);
    const layoutKey = [
      this.chatSessionsControlService.sessionViewportWidth,
      this.chatSessionsControlService.sessionSidebarMinWidth,
      this.chatSessionsControlService.sessionSidebarWidth,
      this.chatSessionsControlService.sessionSidebarMaxWidth,
    ].join('|');
    const semanticChanged = semanticKey !== this.lastPaneDiagnosticsKey;
    const layoutChanged = layoutKey !== this.lastPaneLayoutDiagnosticsKey;
    const now = Date.now();
    const shouldLogLayoutChange = layoutChanged && now - this.lastPaneLayoutDiagnosticsLogAt >= 1000;
    if (!semanticChanged && !shouldLogLayoutChange) {
      return;
    }

    if (semanticChanged) {
      this.lastPaneDiagnosticsKey = semanticKey;
      console.info('[AilyChat][PaneState]', diagnostics);
    }

    if (layoutChanged && shouldLogLayoutChange) {
      this.lastPaneLayoutDiagnosticsKey = layoutKey;
      this.lastPaneLayoutDiagnosticsLogAt = now;
    }

    console.info(
      '[AilyChat][PaneStateScalar]',
      [
        `surface=${paneSurface}`,
        `content=${hasConversationContent}`,
        `controlContent=${this.chatSessionsControlService.hasConversationContent}`,
        `identity=${this.hasCurrentSessionIdentity}`,
        `currentSessionId=${this.chatService.currentSessionId || '<empty>'}`,
        `viewResource=${this.currentViewSessionResource || '<empty>'}`,
        `liveSessionId=${liveSessionId || '<empty>'}`,
        `liveRequest=${liveRuntimeState?.requestInProgress === true}`,
        `liveStatus=${liveRuntimeState?.status ?? '<none>'}`,
        `modelTurns=${currentModelTurnCount}`,
        `projectionTurns=${currentProjectionTurnCount}`,
        `projectionChatList=${currentProjectionChatListCount}`,
        `projectionDialogs=${currentProjectionDialogCount}`,
        `sessionMode=${this.chatSessionsControlService.sessionListDisplayMode}`,
        `sessionViewportWidth=${this.chatSessionsControlService.sessionViewportWidth}`,
        `sessionSidebarMinWidth=${this.chatSessionsControlService.sessionSidebarMinWidth}`,
        `blankShell=${this.chatService.hasBlankSessionShell === true}`,
      ].join(' '),
    );
  }

  private readCurrentViewHasConversationContent(fallback = this.chatSessionsControlService.hasConversationContent): boolean {
    const model = this.currentViewModel?.model;
    if (!model) {
      return fallback === true;
    }

    if (this.hasActiveCurrentSessionRequest) {
      return true;
    }

    const projection = model.hostProjectionState;
    if (this.hasArrayContent(projection?.turnResponses)
      || this.hasArrayContent(projection?.chatList)
      || this.hasArrayContent(projection?.dialogItems)
      || this.hasArrayContent((projection as { readonly entries?: readonly unknown[] } | null)?.entries)) {
      return true;
    }

    return Array.isArray(model.turnResponses) && model.turnResponses.length > 0;
  }

  private hasArrayContent(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0;
  }

  private get currentSessionViewItem(): ChatSessionListItem | null {
    const currentViewSessionResource = this.currentViewSessionResource;
    if (!currentViewSessionResource) {
      return null;
    }

    return this.chatSessionItemsService.readCurrentSessionViewItem(
      undefined,
      undefined,
      currentViewSessionResource,
    );
  }

  private readProjectedCurrentSessionDisplayTitle(): ChatSessionDisplayTitle {
    const projectedItem = this.currentSessionViewItem;
    const currentSessionId = this.currentViewSessionResource;
    const projectedTitle = projectedItem?.title ?? '';
    if (!isMeaningfulSessionTitle(projectedTitle, currentSessionId)) {
      return {
        text: '',
        source: 'empty',
        durable: false,
      };
    }

    const projectedSource = typeof projectedItem?.titleSource === 'string'
      ? normalizeChatSessionTitleSource(projectedItem.titleSource)
      : (projectedItem?.titleDurable === true ? 'legacy-custom' : 'default-first-request');
    const durable = projectedItem?.titleDurable === true || isCustomSessionTitleSource(projectedSource);

    return {
      text: projectedTitle,
      source: durable ? (isCustomSessionTitleSource(projectedSource) ? projectedSource : 'legacy-custom') : projectedSource,
      durable,
    };
  }

  private readLiveCurrentSessionDisplayTitle(): ChatSessionDisplayTitle {
    const liveTitle = this.chatService.currentSessionTitle;
    const currentSessionId = this.currentViewSessionResource;
    const liveOwnerSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (!currentSessionId || liveOwnerSessionId !== currentSessionId || !isMeaningfulSessionTitle(liveTitle, currentSessionId)) {
      return {
        text: '',
        source: 'empty',
        durable: false,
      };
    }

    const liveTitleSource = this.readCurrentSessionTitleSource();
    if (liveTitleSource === undefined) {
      return {
        text: liveTitle,
        source: 'legacy-custom',
        durable: true,
      };
    }

    return {
      text: liveTitle,
      source: liveTitleSource,
      durable: isCustomSessionTitleSource(liveTitleSource),
    };
  }

  private readCurrentSessionTitleSource(): ChatSessionTitleSource | undefined {
    const titleSource = (this.chatService as { readonly currentSessionTitleSource?: unknown }).currentSessionTitleSource;
    if (typeof titleSource !== 'string') {
      return undefined;
    }

    return normalizeChatSessionTitleSource(titleSource);
  }

  private get hasCurrentSessionIdentity(): boolean {
    return this.currentViewSessionResource.length > 0
      || this.liveCurrentSessionResource.length > 0
      || this.chatService.hasBlankSessionShell === true;
  }

  private get isEmptyFreshSessionStartupShell(): boolean {
    return this.currentViewSessionResource.length > 0
      && this.chatService.hasBlankSessionShell !== true
      && this.currentModelHasNoConversationContent
      && !this.hasMeaningfulCurrentSessionTitle;
  }

  private get currentModelHasNoConversationContent(): boolean {
    const model = this.currentViewModel?.model;
    if (!model) {
      return true;
    }

    const projection = model.hostProjectionState;
    return !this.hasArrayContent(projection?.turnResponses)
      && !this.hasArrayContent(projection?.chatList)
      && !this.hasArrayContent(projection?.dialogItems)
      && !this.hasArrayContent((projection as { readonly entries?: readonly unknown[] } | null)?.entries)
      && (!Array.isArray(model.turnResponses) || model.turnResponses.length === 0);
  }

  private get hasMeaningfulCurrentSessionTitle(): boolean {
    const sessionId = this.currentViewSessionResource || this.liveCurrentSessionResource;
    return isMeaningfulSessionTitle(this.chatService.currentSessionTitle, sessionId)
      || isMeaningfulSessionTitle(this.currentSessionViewItem?.title ?? '', sessionId);
  }

  private get hasActiveCurrentSessionRequest(): boolean {
    const currentSessionResource = this.currentViewSessionResource || this.liveCurrentSessionResource;
    if (!currentSessionResource) {
      return false;
    }

    return this.chatSessionRuntimeStore.read(currentSessionResource)?.requestInProgress === true;
  }

  private get liveCurrentSessionResource(): string {
    return typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
  }

  private get hasActiveSessionTitleOwner(): boolean {
    return this.currentViewSessionResource.length > 0;
  }

  private readDefaultPaneTitle(): string {
    const host = AilyHost.get();
    const projectPath = normalizeChatSessionScopePath(host.project?.currentProjectPath);
    const projectRootPath = normalizeChatSessionScopePath(host.project?.projectRootPath);
    const isProjectScope = !!projectPath && !isSameChatSessionScopePath(projectPath, projectRootPath);
    if (isProjectScope) {
      return readNonEmptyString(host.project?.projectName)
        || readPathBasename(projectPath)
        || this.readGlobalDefaultPaneTitle();
    }

    return this.readGlobalDefaultPaneTitle();
  }

  private readGlobalDefaultPaneTitle(): string {
    const translated = this.translate.instant('AILY_CHAT.SERVICE_TITLE');
    return readNonEmptyString(translated) || 'Aily Chat';
  }

  private resolveVisibleSelectedMode(): ChatSelectedMode {
    const targetSessionId = this.currentViewSessionResource;
    const runtimeSelectedMode = targetSessionId
      ? this.chatSessionRuntimeStore.read(targetSessionId)?.selectedMode
      : undefined;
    if (runtimeSelectedMode) {
      return normalizeChatSelectedMode(runtimeSelectedMode);
    }

    const currentSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
    if (targetSessionId && targetSessionId !== currentSessionId) {
      const inputState = this.chatSessionItemsService.sessionItemController.getChatSessionInputState(targetSessionId);
      return resolveHostSessionSelectedModeFromMetadata({
        inputState,
      }, {
        resolveModeById: (modeId) => this.chatService.findResolvedModeById(modeId),
        resolveModeByName: (modeName) => this.chatService.findResolvedModeByName(modeName),
      });
    }

    return normalizeChatSelectedMode(this.chatService.selectedMode ?? {
      modeId: this.chatService.currentMode,
      customAgentTarget: this.chatService.currentCustomAgentTarget,
    });
  }

  private getCurrentResolvedMode(): ChatResolvedMode {
    const selectedMode = this.resolveVisibleSelectedMode();
    const currentResolvedMode = this.chatService.currentResolvedMode;
    if (currentResolvedMode
      && typeof currentResolvedMode === 'object'
      && !Array.isArray(currentResolvedMode)
      && currentResolvedMode.kind === selectedMode.modeId
      && currentResolvedMode.customAgentTarget === selectedMode.customAgentTarget) {
      return currentResolvedMode;
    }

    if (selectedMode.modeId === 'agent') {
      const providerBackedMode = this.findAvailableCustomModeByAgentTarget(selectedMode.customAgentTarget);
      if (providerBackedMode) {
        return providerBackedMode;
      }
    }

    return resolveChatCurrentMode(selectedMode);
  }

  private findAvailableCustomModeByAgentTarget(agentTarget: string | null | undefined): ChatResolvedMode | undefined {
    const normalizedAgentTarget = normalizeAgentIdentifier(agentTarget);
    if (!normalizedAgentTarget) {
      return undefined;
    }

    return this.getAvailableCustomModes().find((mode) =>
      normalizeAgentIdentifier(mode.customAgentTarget ?? mode.name) === normalizedAgentTarget);
  }

  private getRuntimeModeCollection(): { readonly builtin?: readonly ChatResolvedMode[]; readonly custom?: readonly ChatResolvedMode[] } | undefined {
    const collection = (this.chatService as unknown as {
      readonly runtimeModeCollection?: {
        readonly builtin?: readonly ChatResolvedMode[];
        readonly custom?: readonly ChatResolvedMode[];
      };
    }).runtimeModeCollection;
    return collection && typeof collection === 'object' && !Array.isArray(collection)
      ? collection
      : undefined;
  }

  private getAvailableBuiltinModes(): readonly ChatResolvedMode[] {
    const runtimeBuiltinModes = this.getRuntimeModeCollection()?.builtin;
    if (Array.isArray(runtimeBuiltinModes) && runtimeBuiltinModes.length > 0) {
      return runtimeBuiltinModes.some((mode) => mode.kind === 'plan')
        ? runtimeBuiltinModes
        : [...runtimeBuiltinModes, resolveChatCurrentMode({ modeId: 'plan' })];
    }

    return [
      resolveChatCurrentMode({ modeId: 'agent' }),
      resolveChatCurrentMode({ modeId: 'plan' }),
      resolveChatCurrentMode({ modeId: 'ask' }),
    ];
  }

  private getAvailableCustomModes(): readonly ChatResolvedMode[] {
    const collectionCustomModes = this.getRuntimeModeCollection()?.custom;
    if (Array.isArray(collectionCustomModes) && collectionCustomModes.length > 0) {
      return collectionCustomModes;
    }

    const runtimeModes = Array.isArray(this.chatService.availableResolvedCustomModes)
      ? this.chatService.availableResolvedCustomModes
      : [];
    return runtimeModes.length > 0 ? runtimeModes : this.availableCustomModes;
  }

  private getHiddenCustomAgentTargets(): Set<string> {
    return new Set(normalizeAgentIdentifiers(this.ailyChatConfigService.hiddenCustomAgentTargets));
  }

  private getCurrentSessionCustomAgentTarget(): ChatResolvedModeTarget | undefined {
    return typeof this.chatService.getCurrentSessionCustomAgentTarget === 'function'
      ? this.chatService.getCurrentSessionCustomAgentTarget()
      : undefined;
  }

  private isBootstrapPlanMode(mode: ChatResolvedMode): boolean {
    return isPlanChatResolvedMode(mode)
      && !mode.uri
      && mode.modeInstructions?.metadata?.['source'] === 'bootstrap';
  }

  private isProviderBackedPlanMode(mode: ChatResolvedMode): boolean {
    return isPlanChatResolvedMode(mode)
      && !this.isBootstrapPlanMode(mode)
      && typeof mode.uri === 'string'
      && mode.uri.trim().length > 0;
  }

  private getPlanMode(): ChatResolvedMode | undefined {
    const availablePlanMode = this.getAvailableCustomModes()
      .find((mode) => this.isProviderBackedPlanMode(mode));
    if (availablePlanMode) {
      return availablePlanMode;
    }

    const currentResolvedMode = this.getCurrentResolvedMode();
    return this.isProviderBackedPlanMode(currentResolvedMode)
      ? currentResolvedMode
      : createPlanChatResolvedMode();
  }

  private isModeVisibleInCurrentPicker(
    mode: ChatResolvedMode,
    currentSessionCustomAgentTarget: ChatResolvedModeTarget | undefined,
  ): boolean {
    return !currentSessionCustomAgentTarget
      || mode.target === undefined
      || mode.target === 'undefined'
      || mode.target === currentSessionCustomAgentTarget;
  }

  private getAvailableAgentTargets(): string[] {
    const hiddenTargets = this.getHiddenCustomAgentTargets();
    return [...new Set(this.getAvailableCustomModes()
      .filter((mode) => mode.hidden !== true)
      .filter((mode) => mode.enabled !== false)
      .filter((mode) => mode.visibility?.userInvocable !== false)
      .map((mode) => mode.customAgentTarget ?? mode.name)
      .filter((target): target is string => Boolean(target))
      .filter((target) => !hiddenTargets.has(target))
      .filter((target) => !BUILTIN_AGENT_PICKER_NAMES.has(target.toLowerCase())))]
      .sort((left, right) => left.localeCompare(right));
  }

  get modeMenuItems(): IMenuItem[] {
    const currentResolvedMode = this.getCurrentResolvedMode();
    const hiddenTargets = this.getHiddenCustomAgentTargets();
    const currentSessionCustomAgentTarget = this.getCurrentSessionCustomAgentTarget();
    const planMode = this.getPlanMode();
    const builtinModeItems = this.getAvailableBuiltinModes()
      .filter((mode) => mode.kind !== 'edit')
      .sort((left, right) => {
        const order = { agent: 0, plan: 1, ask: 2, edit: 3 } satisfies Record<ChatSurfaceModeId, number>;
        return order[left.kind] - order[right.kind];
      })
      .map((mode) => {
        const isAgentMode = mode.kind === 'agent';
        const isAskMode = mode.kind === 'ask';
        const isPlanMode = mode.kind === 'plan';
        return {
          name: isAgentMode
            ? this.translate.instant('AILY_CHAT.MODE_AGENT_FULL')
            : isAskMode
              ? this.translate.instant('AILY_CHAT.MODE_QA_FULL')
              : isPlanMode
                ? planMode?.label ?? mode.label
                : mode.label,
          action: `${mode.kind}-mode`,
          icon: isAgentMode
            ? 'fa-light fa-user-astronaut'
            : isAskMode
              ? 'fa-light fa-comment-smile'
              : isPlanMode
                ? 'fa-light fa-list-check'
                : 'fa-light fa-pen-to-square',
          current: isPlanMode
            ? isPlanChatResolvedMode(currentResolvedMode)
            : currentResolvedMode.isBuiltin && currentResolvedMode.kind === mode.kind,
          ...(isPlanMode && planMode?.description ? { tooltip: planMode.description } : {}),
          data: { mode: mode.kind },
        } satisfies IMenuItem;
      })
      .filter((item) => item.data?.mode !== 'ask' || !currentSessionCustomAgentTarget);
    const items: IMenuItem[] = [...builtinModeItems];

    const customAgentItems = this.getAvailableCustomModes()
      .filter((mode) => {
        const customAgentTarget = mode.customAgentTarget ?? mode.name;
        return !mode.isBuiltin
          && !isPlanChatResolvedMode(mode)
          && mode.hidden !== true
          && mode.enabled !== false
          && mode.visibility?.userInvocable !== false
            && this.isModeVisibleInCurrentPicker(mode, currentSessionCustomAgentTarget)
          && Boolean(customAgentTarget)
          && !hiddenTargets.has(customAgentTarget)
          && !BUILTIN_AGENT_PICKER_NAMES.has(customAgentTarget.toLowerCase());
      })
      .map((mode) => {
        const customAgentTarget = mode.customAgentTarget ?? mode.name;
        const customAgentSource = {
          id: mode.id,
          ...(mode.uri ? { uri: mode.uri } : {}),
          ...(mode.source ? { source: mode.source } : {}),
          name: mode.name,
          target: customAgentTarget,
        };
        const sourceActions = mode.uri
          ? [
              {
                icon: 'fa-light fa-eye',
                action: CHAT_CUSTOM_AGENT_VIEW_ACTION_ID,
                title: 'View Agent',
              },
              {
                icon: 'fa-light fa-pen-to-square',
                action: CHAT_CUSTOM_AGENT_EDIT_ACTION_ID,
                title: 'Edit Agent',
              },
            ]
          : undefined;
        return {
        name: mode.label,
        action: 'custom-agent-mode',
        icon: 'fa-light fa-user-astronaut',
        current: !currentResolvedMode.isBuiltin && currentResolvedMode.id === mode.id,
        ...(mode.description ? { tooltip: mode.description } : {}),
        ...(sourceActions ? { actions: sourceActions } : {}),
        data: {
          mode: 'agent' satisfies ChatSurfaceModeId,
          modeId: mode.id,
          customAgentTarget,
          customAgentSource,
        },
      } satisfies IMenuItem;
      });

    if (customAgentItems.length > 0) {
      items.push({ sep: true }, ...customAgentItems);
    }

    items.push(
      { sep: true },
      {
        name: CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_LABEL,
        action: CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID,
        icon: 'fa-light fa-gear',
      },
    );

    return items;
  }

  get modelMenuItems(): IMenuItem[] {
    return [...this.buildModelMenuState().modelMenuItems];
  }

  get currentReasoningEffortLabel(): string {
    return this.buildModelMenuState().currentReasoningEffortLabel;
  }

  get currentReasoningEffortDisplayLabel(): string {
    return this.buildModelMenuState().currentReasoningEffortDisplayLabel;
  }

  get hasReasoningEffortOptions(): boolean {
    return this.buildModelMenuState().hasReasoningEffortOptions;
  }

  get currentReasoningEffortMenuItems(): IMenuItem[] {
    return [...this.buildModelMenuState().currentReasoningEffortMenuItems];
  }

  get firstAgentSuggestion(): string | undefined {
    return this.agentSuggestions[0];
  }

  resolveSuggestionKeyAction(key: string): AgentSuggestionKeyAction {
    return resolveAgentSuggestionKeyAction(key, this.agentSuggestions);
  }

  applyComposerLineBreak(value: string, selectionStart: number, selectionEnd: number): ComposerLineBreakEdit {
    return insertComposerLineBreak(value, selectionStart, selectionEnd);
  }

  resolveComposerKeyAction(input: {
    key: string;
    ctrlKey: boolean;
    altKey: boolean;
    inputValue: string;
    selectionStart: number;
    selectionEnd: number;
    isWaiting: boolean;
  }): ComposerKeyAction {
    return _resolveComposerKeyAction({
      ...input,
      suggestions: this.agentSuggestions,
    });
  }

  setCurrentUrl(url: string): void {
    this.currentUrl = url;
  }

  setBottomHeight(height: number): void {
    if (typeof height === 'number' && !Number.isNaN(height)) {
      this.bottomHeight = Math.min(this.senderMaxHeight, Math.max(this.senderMinHeight, height));
    }
  }

  setSessionViewportWidth(width: number): void {
    this.chatSessionsControlService.setSessionViewportWidth(width);
  }

  setSessionSidebarWidth(width: number, options?: { persist?: boolean }): void {
    this.chatSessionsControlService.setSessionSidebarWidth(width, options);
  }

  resolveSessionListDisplayMode(input: {
    hasSessions: boolean;
    hasConversationContent: boolean;
    hasCurrentSession?: boolean;
  }): 'hidden' | 'stacked' | 'sidebar' {
    return this.chatSessionsControlService.resolveSessionListDisplayMode({
      hasSessions: input.hasSessions,
      hasConversationContent: input.hasConversationContent,
      hasCurrentSession: input.hasCurrentSession === true,
    });
  }

  setSettingsVisible(visible: boolean): void {
    this.showSettings = visible;
    this.syncSessionViewerSuppression();
    this.refreshSessionViewModel();
  }

  openSettings(): void {
    this.setSettingsVisible(true);
  }

  toggleSettings(): void {
    this.setSettingsVisible(!this.showSettings);
  }

  closeSettings(): void {
    this.setSettingsVisible(false);
  }

  setAvailableAgents(agentNames: readonly string[]): void {
    this.availableCustomModes = normalizeAgentIdentifiers(agentNames)
      .filter((agentName) => !BUILTIN_AGENT_PICKER_NAMES.has(agentName.toLowerCase()))
      .sort((left, right) => left.localeCompare(right))
      .map((agentName) => resolveChatCurrentMode({ modeId: 'agent', customAgentTarget: agentName }));
  }

  setAvailableAgentModes(agentModes: readonly ChatResolvedMode[]): void {
    const nextModes = new Map<string, ChatResolvedMode>();
    for (const agentMode of agentModes) {
      const customAgentTarget = typeof agentMode.customAgentTarget === 'string' && agentMode.customAgentTarget.trim()
        ? agentMode.customAgentTarget.trim()
        : typeof agentMode.name === 'string' && agentMode.name.trim()
          ? agentMode.name.trim()
          : '';
      if (!customAgentTarget || BUILTIN_AGENT_PICKER_NAMES.has(customAgentTarget.toLowerCase())) {
        continue;
      }

      nextModes.set(customAgentTarget, {
        ...agentMode,
        customAgentTarget,
      });
    }

    this.availableCustomModes = Array.from(nextModes.values())
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  updateAgentSuggestions(inputValue: string): void {
    if (!inputValue.startsWith('@')) {
      this.hideAgentSuggestions();
      return;
    }

    const query = inputValue.slice(1).split(/\s/)[0].toLowerCase();
    this.agentSuggestions = this.getAvailableAgentTargets()
      .filter((agentTarget) => agentTarget.toLowerCase().startsWith(query));
    this.showAgentSuggestions = this.agentSuggestions.length > 0 && !inputValue.includes(' ');
  }

  hideAgentSuggestions(): void {
    this.showAgentSuggestions = false;
    this.agentSuggestions = [];
  }

  applyAgentSelection(agentName: string): string {
    this.hideAgentSuggestions();
    return `@${agentName} `;
  }

  private buildModelMenuState() {
    return buildChatModelMenuState({
      currentModel: this.chatService.currentModel,
      recentModelPresetIds: typeof this.chatService.getRecentModelPresetIds === 'function'
        ? this.chatService.getRecentModelPresetIds()
        : [],
      pinnedModelIds: typeof this.chatService.getPinnedModelIds === 'function'
        ? this.chatService.getPinnedModelIds()
        : [],
      ailyChatConfigService: this.ailyChatConfigService,
      languageModelsService: this.languageModelsService,
    });
  }
}

function isMeaningfulSessionTitle(title: unknown, sessionId?: string): boolean {
  if (typeof title !== 'string') {
    return false;
  }

  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return false;
  }

  return !isTechnicalSessionTitle(normalizedTitle, sessionId)
    && !isPlaceholderSessionTitle(normalizedTitle);
}

function isTechnicalSessionTitle(title: string, sessionId?: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (normalizedSessionId && normalizedTitle === normalizedSessionId) {
    return true;
  }

  return /^lex-\d{6,}$/i.test(normalizedTitle);
}

function isPlaceholderSessionTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle) {
    return true;
  }

  if (/^untitled(?:\s+chat)?(?:\s*\d+)?$/i.test(normalizedTitle)) {
    return true;
  }

  return normalizedTitle === 'new chat'
    || normalizedTitle === 'new session'
    || normalizedTitle === 'current session'
    || normalizedTitle === '新对话'
    || normalizedTitle === '新会话';
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPathBasename(path: string): string {
  const normalizedPath = path.trim().replace(/[\\/]+$/g, '');
  if (!normalizedPath) {
    return '';
  }

  const parts = normalizedPath.split(/[\\/]+/g);
  return parts[parts.length - 1]?.trim() ?? '';
}
