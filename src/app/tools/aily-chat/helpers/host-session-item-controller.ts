import type { TurnResponseTurn } from 'aily-lex/browser';
import { Subject, type Observable } from 'rxjs';
import type { EditCheckpointService } from '../services/edit-checkpoint.service';
import type { ChatSessionStateScopeSnapshot, ChatSessionStateService, PersistedChatSessionState, ResolvedChatSessionState } from '../services/chat-session-state.service';
import type { PersistedChatSessionEntryTarget } from '../services/chat-session-entry-state.service';
import {
  DEFAULT_CHAT_SELECTED_MODE,
  DEFAULT_CHAT_SESSION_INPUT_STATE,
  DEFAULT_CHAT_SESSION_TYPE,
  createChatSessionInputState,
  createChatSessionInputStateFromResolvedMode,
  type ChatSessionInputState,
  type ChatSelectedMode,
  type ChatSessionType,
  type ChatSurfaceModeId,
  normalizeChatSelectedMode,
  normalizeChatSessionType,
  normalizeChatSurfaceModeId,
} from '../core/chat-mode';
import {
  getChatSessionTitleSourcePriority,
  isCustomSessionTitleSource,
  normalizeChatSessionTitleSource,
  normalizeChatSessionTitleCandidate,
  type ChatSessionDisplayTitle,
  type ChatSessionTitleCandidate,
  type ChatSessionTitleSource,
} from '../core/chat-session-title';
import type { ChatHistoryService, HistoryFilterMode, HostSessionRecord, HostSessionStoreChangeEvent, PersistedHostTurnResponse, SessionIndexEntry } from '../services/chat-history.service';
import type { ChatService } from '../services/chat.service';
import type { ChatSessionRuntimeState } from '../services/chat-session-runtime-store.service';
import {
  buildHostSessionProviderOptionGroups,
  normalizeHostSessionInputStateFromMetadata,
  normalizeHostSessionProviderOptions,
  resolveHostSessionProviderOptionsFromInputState,
  type HostSessionProviderOptions,
  type HostSessionSelectedModeResolveOptions,
} from './host-session-input-state';
import { buildHostSessionCurrentPickerRoutingSummary, normalizeHostSessionRequestRoutingSummary } from './host-session-request-routing';
import type { HostSessionRequestRoutingSummary } from './host-session-request-routing';
import {
  isSameChatSessionScopePath,
  normalizeChatSessionScopePath,
} from '../core/chat-session-scope';
import type { ChatAgentRuntimeMode, ChatAgentRuntimeModeSource } from '../core/chat-agent-runtime-mode';
import {
  HostSessionContentProvider,
  resolveHostSessionProjectPathHint,
  type HostSessionContent,
  type HostSessionContentProviderContext,
} from './host-session-content-provider';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';

export interface HostSessionHistoryItem {
  readonly sessionId: string;
  readonly title: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly titleDurable?: boolean;
  readonly sessionType: ChatSessionType;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly current: boolean;
  readonly projectPath: string | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  readonly inputState?: ChatSessionInputState;
  readonly mode?: ChatSurfaceModeId;
  readonly requestRouting?: HostSessionRequestRoutingSummary;
}

export type HostSessionListItemStatus = 'completed' | 'cancelled' | 'in_progress' | 'needs_input' | 'failed';

export function normalizeHostSessionListItemStatus(status: string | null | undefined): HostSessionListItemStatus | undefined {
  switch (typeof status === 'string' ? status.trim() : '') {
    case 'in_progress':
    case 'running':
    case 'streaming':
      return 'in_progress';
    case 'needs_input':
    case 'waiting_question':
    case 'waiting_confirmation':
    case 'waiting_tool_results':
    case 'waiting_plan_review':
    case 'plan_review':
    case 'continue':
      return 'needs_input';
    case 'hard_stopped':
    case 'failed':
    case 'error':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      return undefined;
  }
}

export interface HostSessionListItemTiming {
  readonly created: number;
  readonly updated: number;
  readonly lastRequestStarted?: number;
  readonly lastRequestEnded?: number;
}

export interface HostSessionListItemMetadata {
  readonly providerLabel: string;
  readonly projectLabel?: string;
  readonly workingDirectoryPath?: string;
}

export interface HostSessionListItemChanges {
  readonly fileCount: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface SessionInventorySummary extends HostSessionHistoryItem {
  readonly badge?: string;
  readonly status?: HostSessionListItemStatus;
  readonly description?: string;
  readonly timing: HostSessionListItemTiming;
  readonly metadata: HostSessionListItemMetadata;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly read: boolean;
  readonly markedUnread: boolean;
}

export interface SessionInventoryDetail {
  readonly description?: string;
  readonly changes?: HostSessionListItemChanges;
}

interface SessionInventorySummaryOrderInfo {
  readonly timing: HostSessionListItemTiming;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly status?: HostSessionListItemStatus;
}

export interface SessionInventoryDisplayItem extends SessionInventorySummary, SessionInventoryDetail {}

export type HostSessionListItem = SessionInventoryDisplayItem;

export interface HostSessionSwitchTarget {
  readonly sessionId: string;
  readonly sessionType: ChatSessionType;
  readonly projectPath: string | null;
  readonly providerOptions: HostSessionProviderOptions;
  readonly inputState: ChatSessionInputState;
  readonly entry?: SessionIndexEntry;
}

export type HostSessionSwitchRestoreHostRecordSource = 'override' | 'history' | 'deferred' | 'missing';
export type HostSessionRestoreRequestSource = 'session-switch' | 'entry-target';
export type HostSessionRestoreMetadataSource = 'index-entry' | 'entry-target' | 'none';

export interface HostSessionSwitchRestoreDiagnostics {
  readonly sessionId: string;
  readonly projectPath: string | null;
  readonly requestSource: HostSessionRestoreRequestSource;
  readonly hostRecordSource: HostSessionSwitchRestoreHostRecordSource;
  readonly metadataSource: HostSessionRestoreMetadataSource;
}

export interface HostSessionSwitchRestoreRequest {
  readonly target: HostSessionSwitchTarget;
  readonly sessionContent: HostSessionContent;
  readonly hostRecord: HostSessionRecord | null;
  readonly diagnostics: HostSessionSwitchRestoreDiagnostics;
}

export interface HostSessionSwitchRestoreRequestOptions {
  readonly fallbackProjectPath?: string | null;
  readonly hostRecordOverride?: HostSessionRecord | null;
  readonly deferHostRecord?: boolean;
}

export interface HostSessionEntryRestoreRequestOptions {
  readonly fallbackProjectPath?: string | null;
  readonly deferHostRecord?: boolean;
}

export interface HostSessionManagedItemSeed {
  readonly sessionId: string;
  readonly title?: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly sessionType?: ChatSessionType;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly projectPath?: string | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  readonly inputState?: ChatSessionInputState;
  readonly mode?: ChatSurfaceModeId;
  readonly requestRouting?: HostSessionRequestRoutingSummary;
}

interface HostSessionManagedItem {
  readonly sessionId: string;
  readonly title: string;
  readonly titleSource?: ChatSessionTitleSource;
  readonly titleRevision?: number;
  readonly sessionType: ChatSessionType;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly projectPath: string | null;
  readonly agentRuntimeMode?: ChatAgentRuntimeMode;
  readonly agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  readonly inputState: ChatSessionInputState;
  readonly mode: ChatSurfaceModeId;
  readonly requestRouting?: HostSessionRequestRoutingSummary;
}

interface HostSessionHistoryItemWithTimestamp extends HostSessionHistoryItem {
  readonly updatedAt: number;
}

const BLANK_SESSION_INPUT_STATE_KEY = '__blank__';

type HostSessionTurnResponse = PersistedHostTurnResponse | TurnResponseTurn;
type HostSessionRecordLike = {
  readonly metadata?: NonNullable<HostSessionContent['hostRecord']>['metadata'] | null;
  readonly turnResponses?: readonly HostSessionTurnResponse[] | null;
};

type HostSessionItemControllerContext = {
  readonly chatService: Pick<ChatService, 'currentSessionId' | 'currentSessionPath' | 'currentSessionType' | 'currentSessionPermissionMode' | 'currentSessionPermissionProfile' | 'currentSessionPermissionLevel' | 'currentSessionApprovalsReviewer' | 'currentSessionApprovalPolicy' | 'currentSessionTitle' | 'currentAgentRuntimeMode' | 'currentAgentRuntimeModeSource' | 'currentResolvedMode' | 'selectedMode' | 'findResolvedModeById' | 'findResolvedModeByName' | 'sessionInputStateChanged$' | 'sessionProviderOptionsChanged$' | 'buildCurrentSessionProviderOptionGroups' | 'buildNewSessionProviderOptionGroups'>
    & Partial<Pick<ChatService, 'currentSessionTitleSource'>>
    & Partial<Pick<ChatService, 'sessionDisplayTitleChanged$' | 'sessionDurableTitleChanged$' | 'sessionTitleChanged$'>>;
  readonly chatHistoryService: Pick<ChatHistoryService, 'getHistoryList' | 'findEntry' | 'loadHostRecord' | 'updateTitle' | 'deleteSession'> & Partial<Pick<ChatHistoryService, 'hostSessionChanged$'>>;
  readonly editCheckpointService?: Pick<EditCheckpointService, 'getRequestEditsSummarySync'>;
  readonly chatSessionStateService?: Pick<ChatSessionStateService, 'sessionStateChanged$' | 'resolveSessionState' | 'readScopeSnapshot' | 'setArchived' | 'setPinned' | 'setRead' | 'clearSessionState'>;
  readonly readLiveSessionTurnResponses?: (sessionId: string) => readonly TurnResponseTurn[] | null | undefined;
  readonly readLiveSessionRuntimeState?: (sessionId: string) => ChatSessionRuntimeState | null | undefined;
};

type HostSessionListItemStateResolver = (
  item: Pick<HostSessionHistoryItem, 'sessionId' | 'projectPath'>,
  timing: HostSessionListItemTiming,
) => ResolvedChatSessionState;

const BACKGROUND_SESSION_TRACE_FLAG = 'aily.chat.traceBackgroundSession';
const BACKGROUND_SESSION_TRACE_GLOBAL_KEYS = [
  '__AILY_CHAT_TRACE_BACKGROUND_SESSION__',
  'AILY_CHAT_TRACE_BACKGROUND_SESSION',
] as const;

function parseBackgroundSessionTraceFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
  }
  return false;
}

function isBackgroundSessionTraceEnabled(): boolean {
  try {
    const runtime = globalThis as Record<string, unknown>;
    for (const key of BACKGROUND_SESSION_TRACE_GLOBAL_KEYS) {
      if (parseBackgroundSessionTraceFlag(runtime[key])) {
        return true;
      }
    }
    const localStorageValue = globalThis.localStorage?.getItem?.(BACKGROUND_SESSION_TRACE_FLAG);
    return parseBackgroundSessionTraceFlag(localStorageValue);
  } catch {
    return false;
  }
}

function traceBackgroundSessionStatus(event: string, details: Record<string, unknown>): void {
  if (!isBackgroundSessionTraceEnabled()) {
    return;
  }
  // console.info('[AilyChat][bg-session][status]', event, details);
}

export class HostSessionItemController {
  private readonly hostSessionContentProvider: HostSessionContentProvider;
  private readonly managedItems = new Map<string, HostSessionManagedItem>();
  private readonly trackedInputStates = new Map<string, ChatSessionInputState>();
  private readonly cachedSummaryItems = new Map<string, { readonly key: string; readonly item: SessionInventorySummary }>();
  private readonly cachedListItems = new Map<string, { readonly key: string; readonly item: HostSessionListItem }>();
  private readonly sessionListItemVersions = new Map<string, number>();
  private globalListItemVersion = 0;
  private readonly itemsChangedSubject = new Subject<{ readonly sessionId: string | null }>();
  readonly itemsChanged$: Observable<{ readonly sessionId: string | null }> = this.itemsChangedSubject.asObservable();

  constructor(private readonly ctx: HostSessionItemControllerContext) {
    const contentProviderContext: HostSessionContentProviderContext = {
      get sessionId() {
        return ctx.chatService.currentSessionId;
      },
      chatService: ctx.chatService as HostSessionContentProviderContext['chatService'],
      chatHistoryService: ctx.chatHistoryService as HostSessionContentProviderContext['chatHistoryService'],
    };
    this.hostSessionContentProvider = new HostSessionContentProvider(contentProviderContext);

    this.ctx.chatService.sessionInputStateChanged$?.subscribe(() => {
      this.refreshTrackedInputStates();
      this.notifyItemsChanged(this.ctx.chatService.currentSessionId);
    });

    this.ctx.chatService.sessionProviderOptionsChanged$?.subscribe(() => {
      this.refreshTrackedInputStates();
      this.notifyItemsChanged(this.ctx.chatService.currentSessionId);
    });

    const displayTitleChanged$ = this.ctx.chatService.sessionDisplayTitleChanged$
      ?? this.ctx.chatService.sessionTitleChanged$;
    displayTitleChanged$?.subscribe(() => {
      this.notifyItemsChanged(this.ctx.chatService.currentSessionId);
    });

    const durableTitleChanged$ = this.ctx.chatService.sessionDurableTitleChanged$
      ?? (this.ctx.chatService.sessionDisplayTitleChanged$ ? undefined : this.ctx.chatService.sessionTitleChanged$);
    durableTitleChanged$?.subscribe(() => {
      this.refreshCurrentManagedItemMetadata();
    });

    this.ctx.chatHistoryService.hostSessionChanged$?.subscribe((event) => {
      this.handleHostSessionStoreChange(event);
      this.notifyItemsChanged(event.sessionId);
    });

    this.ctx.chatSessionStateService?.sessionStateChanged$?.subscribe((event: { readonly sessionId?: string }) => {
      this.notifyItemsChanged(event.sessionId);
    });
  }

  createNewChatSessionItem(
    sessionId: string,
    options: Omit<HostSessionManagedItemSeed, 'sessionId'> = {},
  ): HostSessionHistoryItem {
    const item = this.toHistoryItem(this.upsertManagedItem({
      sessionId,
      title: options.title,
      titleSource: options.titleSource,
      titleRevision: options.titleRevision,
      sessionType: options.sessionType ?? this.resolveCurrentSessionType(),
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
      projectPath: options.projectPath ?? this.ctx.chatService.currentSessionPath ?? null,
      agentRuntimeMode: options.agentRuntimeMode,
      agentRuntimeModeSource: options.agentRuntimeModeSource,
      inputState: options.inputState,
      mode: options.mode,
      requestRouting: options.requestRouting,
    }));
    this.notifyItemsChanged(sessionId);
    return item;
  }

  createForkedChatSessionItem(seed: HostSessionManagedItemSeed): HostSessionHistoryItem {
    const item = this.toHistoryItem(this.upsertManagedItem({
      ...seed,
    }));
    this.notifyItemsChanged(seed.sessionId);
    return item;
  }

  renameChatSessionItem(sessionId: string, title: string): void {
    const normalizedTitle = typeof title === 'string'
      ? title.trim()
      : '';
    if (!normalizedTitle) {
      return;
    }

    this.updateManagedChatSessionItemTitle(sessionId, {
      text: normalizedTitle,
      source: 'user',
    });

    if (this.ctx.chatHistoryService.findEntry(sessionId)) {
      this.ctx.chatHistoryService.updateTitle(sessionId, normalizedTitle, { source: 'user' });
    }
  }

  updateManagedChatSessionItemTitle(
    sessionId: string,
    title: string | Partial<ChatSessionTitleCandidate>,
  ): void {
    const candidate = normalizeChatSessionTitleCandidate(typeof title === 'string'
      ? {
          text: title,
          source: 'legacy-custom',
        }
      : title);
    if (!candidate.text) {
      return;
    }

    const managedItem = this.managedItems.get(sessionId);
    if (!managedItem) {
      return;
    }

    const existingPriority = getChatSessionTitleSourcePriority(managedItem.titleSource);
    const nextPriority = getChatSessionTitleSourcePriority(candidate.source);
    const existingRevision = managedItem.titleRevision ?? 0;
    if (managedItem.title
      && existingPriority > nextPriority
      && (existingRevision > candidate.revision || candidate.revision === 0)) {
      return;
    }

    this.managedItems.set(sessionId, {
      ...managedItem,
      title: candidate.text,
      titleSource: candidate.source,
      titleRevision: Math.max(existingRevision + 1, candidate.revision),
      updatedAt: Date.now(),
    });
    this.notifyItemsChanged(sessionId);
  }

  deleteChatSessionItem(sessionId: string): void {
    const managedItem = this.managedItems.get(sessionId);
    this.deleteCachedListItem(sessionId);
    this.managedItems.delete(sessionId);
    this.trackedInputStates.delete(sessionId);
    if (this.ctx.chatHistoryService.findEntry(sessionId)) {
      this.ctx.chatHistoryService.deleteSession(sessionId);
    } else {
      this.ctx.chatSessionStateService?.clearSessionState(sessionId, managedItem?.projectPath ?? null);
    }
    this.notifyItemsChanged(sessionId);
  }

  discardChatSessionItem(sessionId: string | null | undefined): void {
    if (!sessionId) {
      return;
    }

    this.deleteCachedListItem(sessionId);
    this.managedItems.delete(sessionId);
    this.trackedInputStates.delete(sessionId);
    this.notifyItemsChanged(sessionId);
  }

  readHistoryItems(
    filter: HistoryFilterMode = 'all',
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): readonly HostSessionHistoryItem[] {
    const mergedItems = new Map<string, HostSessionHistoryItemWithTimestamp>();
    const persistedEntries = this.ctx.chatHistoryService.getHistoryList(filter, projectPath, projectRootPath);

    for (const entry of persistedEntries) {
      mergedItems.set(entry.sessionId, this.toHistoryItem({
        sessionId: entry.sessionId,
        title: entry.title,
        sessionType: entry.sessionType ?? DEFAULT_CHAT_SESSION_TYPE,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        projectPath: entry.projectPath ?? null,
        agentRuntimeMode: entry.agentRuntimeMode ?? entry.runtimeMode,
        agentRuntimeModeSource: entry.agentRuntimeModeSource ?? entry.runtimeModeSource,
        inputState: this.getChatSessionInputStateFromIndexEntry(entry),
        mode: entry.mode,
        requestRouting: entry.requestRouting,
      }));
    }

    for (const managedItem of this.managedItems.values()) {
      if (mergedItems.has(managedItem.sessionId)) {
        continue;
      }
      if (!this.matchesHistoryFilter(managedItem, filter, projectPath, projectRootPath)) {
        continue;
      }

      mergedItems.set(managedItem.sessionId, this.toHistoryItem(managedItem));
    }

    return [...mergedItems.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  readListItems(
    filter: HistoryFilterMode = 'all',
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): readonly HostSessionListItem[] {
    ChatPerformanceTracer.increment('session_list.read_list_items');
    return this.readSummaryItems(filter, projectPath, projectRootPath)
      .map(item => this.toListItem(item))
      .sort((left, right) => this.compareListItems(left, right));
  }

  readSummaryItems(
    filter: HistoryFilterMode = 'all',
    projectPath?: string | null,
    projectRootPath?: string | null,
    options: { readonly limit?: number; readonly cursor?: number } = {},
  ): readonly SessionInventorySummary[] {
    ChatPerformanceTracer.increment('session_list.read_summary_items');
    const cursor = typeof options.cursor === 'number' && Number.isFinite(options.cursor)
      ? Math.max(0, Math.floor(options.cursor))
      : 0;
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : undefined;

    const stateResolver = this.createListItemStateResolver();
    const historyItems = this.readHistoryItems(filter, projectPath, projectRootPath);

    if (limit !== undefined) {
      const selectedItems = this.selectSummaryHistoryWindow(historyItems, stateResolver, cursor, limit);
      return selectedItems.map(item => this.toSummaryItem(item, stateResolver));
    }

    const summaries = historyItems
      .map(item => this.toSummaryItem(item, stateResolver))
      .sort((left, right) => this.compareListItems(left, right));

    if (limit === undefined) {
      return summaries.slice(cursor);
    }

    return summaries.slice(cursor, cursor + limit);
  }

  private selectSummaryHistoryWindow(
    items: readonly HostSessionHistoryItem[],
    stateResolver: HostSessionListItemStateResolver,
    cursor: number,
    limit: number,
  ): readonly HostSessionHistoryItem[] {
    if (limit <= 0 || items.length === 0) {
      return [];
    }

    const windowSize = cursor + limit;
    const selected: Array<{ readonly item: HostSessionHistoryItem; readonly order: SessionInventorySummaryOrderInfo }> = [];

    for (const item of items) {
      const order = this.buildSummaryOrderInfo(item, stateResolver);
      const insertIndex = selected.findIndex(candidate => this.compareListItems(order, candidate.order) < 0);

      if (insertIndex < 0) {
        if (selected.length < windowSize) {
          selected.push({ item, order });
        }
        continue;
      }

      selected.splice(insertIndex, 0, { item, order });
      if (selected.length > windowSize) {
        selected.pop();
      }
    }

    return selected
      .slice(cursor)
      .map(candidate => candidate.item);
  }

  readListItem(
    sessionId: string,
    filter: HistoryFilterMode = 'all',
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): HostSessionListItem | null {
    const summary = this.readSummaryItem(sessionId, filter, projectPath, projectRootPath);
    return summary ? this.toListItem(summary) : null;
  }

  readSummaryItem(
    sessionId: string,
    filter: HistoryFilterMode = 'all',
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): SessionInventorySummary | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return null;
    }

    const persistedEntry = this.ctx.chatHistoryService.findEntry(normalizedSessionId);
    const persistedHistoryItem = persistedEntry?.sessionId === normalizedSessionId
      ? this.toHistoryItemFromSessionEntry(persistedEntry)
      : null;
    const managedHistoryItem = this.resolveManagedHistoryItem(normalizedSessionId);
    let historyItem = persistedHistoryItem ?? managedHistoryItem;

    if (!historyItem
      || !this.matchesHistoryFilterByProject(historyItem.projectPath, filter, projectPath, projectRootPath)) {
      const indexedEntry = this.ctx.chatHistoryService
        .getHistoryList(filter, projectPath, projectRootPath)
        .find(entry => entry.sessionId === normalizedSessionId);
      historyItem = indexedEntry
        ? this.toHistoryItemFromSessionEntry(indexedEntry)
        : managedHistoryItem ?? persistedHistoryItem;
    }

    if (!historyItem) {
      return null;
    }

    if (!this.matchesHistoryFilterByProject(historyItem.projectPath, filter, projectPath, projectRootPath)) {
      if (managedHistoryItem
        && this.matchesHistoryFilterByProject(managedHistoryItem.projectPath, filter, projectPath, projectRootPath)) {
        return this.toSummaryItem(managedHistoryItem);
      }
      return null;
    }

    return this.toSummaryItem(historyItem);
  }

  hydrateListItemDetail(
    sessionId: string,
    summary?: SessionInventorySummary | null,
  ): HostSessionListItem | null {
    ChatPerformanceTracer.increment('session_list.hydrate_detail_item');
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return null;
    }

    const resolvedSummary = summary ?? this.readSummaryItem(normalizedSessionId);
    return resolvedSummary ? this.toListItem(resolvedSummary) : null;
  }

  setSessionArchived(
    sessionId: string,
    archived: boolean,
    projectPathHint?: string | null,
  ): void {
    const projectPath = this.resolveSessionStateProjectPath(sessionId, projectPathHint);
    this.ctx.chatSessionStateService?.setArchived(
      sessionId,
      projectPath,
      archived,
      this.resolveSessionReadTrackingTime(sessionId, projectPath),
    );
    this.notifyItemsChanged(sessionId);
  }

  setSessionPinned(
    sessionId: string,
    pinned: boolean,
    projectPathHint?: string | null,
  ): void {
    const projectPath = this.resolveSessionStateProjectPath(sessionId, projectPathHint);
    this.ctx.chatSessionStateService?.setPinned(sessionId, projectPath, pinned);
    this.notifyItemsChanged(sessionId);
  }

  setSessionRead(
    sessionId: string,
    read: boolean,
    projectPathHint?: string | null,
  ): void {
    const projectPath = this.resolveSessionStateProjectPath(sessionId, projectPathHint);
    this.ctx.chatSessionStateService?.setRead(
      sessionId,
      projectPath,
      read,
      this.resolveSessionReadTrackingTime(sessionId, projectPath),
    );
    this.notifyItemsChanged(sessionId);
  }

  resolveSessionSwitchTarget(
    sessionId: string,
    fallbackProjectPath?: string | null,
    options: { readonly deferHostRecord?: boolean } = {},
  ): HostSessionSwitchTarget {
    const managedItem = this.managedItems.get(sessionId);
    const entry = this.ctx.chatHistoryService.findEntry(sessionId);
    const isCurrentSession = sessionId === this.ctx.chatService.currentSessionId;
    const projectPathHint = resolveHostSessionProjectPathHint(
      {
        currentSessionPath: managedItem?.projectPath
          ?? entry?.projectPath
          ?? (isCurrentSession ? this.ctx.chatService.currentSessionPath : null),
      },
      fallbackProjectPath,
    );
    const sessionContent = isCurrentSession
      ? undefined
      : options.deferHostRecord === true && !managedItem
        ? this.hostSessionContentProvider.provideChatSessionContent(sessionId, projectPathHint, {
            loadHostRecord: false,
            metadataFallback: entry ?? null,
          })
        : this.resolvePersistedSessionContent(sessionId, projectPathHint, entry);
    const providerOptions = sessionContent?.providerOptions ?? this.getChatSessionProviderOptions(sessionId, projectPathHint);
    const projectPath = managedItem?.projectPath ?? providerOptions.folderPath ?? projectPathHint;
    const inputState = !isCurrentSession && options.deferHostRecord === true && !managedItem
      ? sessionContent?.inputState ?? this.buildPersistedInputState(sessionContent!)
      : this.getChatSessionInputState(sessionId, projectPath);
    const sessionType = isCurrentSession
      ? this.resolveCurrentSessionType()
      : normalizeChatSessionType(sessionContent?.sessionType ?? entry?.sessionType, DEFAULT_CHAT_SESSION_TYPE);

    return {
      sessionId,
      sessionType,
      projectPath,
      providerOptions,
      inputState,
      ...(entry ? { entry } : {}),
    };
  }

  resolveSessionSwitchRestoreRequest(
    sessionId: string,
    options: HostSessionSwitchRestoreRequestOptions = {},
  ): HostSessionSwitchRestoreRequest {
    return this.resolveSessionRestoreRequest({
      sessionId,
      fallbackProjectPath: options.fallbackProjectPath,
      hostRecordOverride: options.hostRecordOverride,
      deferHostRecord: options.deferHostRecord,
      requestSource: 'session-switch',
    });
  }

  resolveSessionEntryRestoreRequest(
    target: PersistedChatSessionEntryTarget,
    options: HostSessionEntryRestoreRequestOptions = {},
  ): HostSessionSwitchRestoreRequest {
    const useTargetAsRestoreCarrier = this.hasCompleteEntryTargetCarrier(target);
    return this.resolveSessionRestoreRequest({
      sessionId: target.sessionId,
      fallbackProjectPath: options.fallbackProjectPath,
      metadataFallback: target,
      useMetadataFallbackAsRestoreCarrier: useTargetAsRestoreCarrier,
      deferHostRecord: options.deferHostRecord,
      requestSource: 'entry-target',
    });
  }

  private resolveSessionRestoreRequest(options: {
    readonly sessionId: string;
    readonly fallbackProjectPath?: string | null;
    readonly hostRecordOverride?: HostSessionRecord | null;
    readonly metadataFallback?: PersistedChatSessionEntryTarget;
    readonly useMetadataFallbackAsRestoreCarrier?: boolean;
    readonly deferHostRecord?: boolean;
    readonly requestSource: HostSessionRestoreRequestSource;
  }): HostSessionSwitchRestoreRequest {
    const metadataFallback = options.metadataFallback;
    if (metadataFallback && options.useMetadataFallbackAsRestoreCarrier !== false) {
      return this.resolveSessionRestoreRequestFromMetadataFallback({
        sessionId: options.sessionId,
        fallbackProjectPath: options.fallbackProjectPath,
        metadataFallback,
        deferHostRecord: options.deferHostRecord,
        requestSource: options.requestSource,
      });
    }

    const switchTargetProjectHint = options.hostRecordOverride
      ? resolveHostSessionProjectPathHint(
          {
            currentSessionPath: typeof options.hostRecordOverride.metadata?.projectPath === 'string'
              ? options.hostRecordOverride.metadata.projectPath
              : null,
          },
          null,
        )
      : metadataFallback?.projectPath ?? options.fallbackProjectPath ?? null;
    const target = this.resolveSessionSwitchTarget(options.sessionId, switchTargetProjectHint, {
      deferHostRecord: options.deferHostRecord,
    });
    const sessionProjectPath = target.providerOptions.folderPath
      ?? target.projectPath
      ?? switchTargetProjectHint
      ?? null;
    const sessionContent = this.hostSessionContentProvider.provideChatSessionContent(
      options.sessionId,
      sessionProjectPath,
      {
        hostRecordOverride: options.hostRecordOverride,
        loadHostRecord: options.deferHostRecord !== true,
        metadataFallback: target.entry ?? metadataFallback ?? null,
        fallbackProviderOptions: target.providerOptions,
      },
    );
    const hostRecord = sessionContent.hostRecord ?? null;

    return {
      target,
      sessionContent,
      hostRecord,
      diagnostics: {
        sessionId: options.sessionId,
        projectPath: sessionProjectPath,
        requestSource: options.requestSource,
        hostRecordSource: options.hostRecordOverride !== undefined
          ? 'override'
          : options.deferHostRecord === true
            ? 'deferred'
          : hostRecord
            ? 'history'
            : 'missing',
        metadataSource: target.entry
          ? 'index-entry'
          : metadataFallback
            ? 'entry-target'
            : 'none',
      },
    };
  }

  private hasCompleteEntryTargetCarrier(target: PersistedChatSessionEntryTarget): boolean {
    const projectPath = this.readNonEmptyString(target.projectPath);
    return !!projectPath
      && !!target.providerOptions
      && !!target.inputState;
  }

  private resolveSessionRestoreRequestFromMetadataFallback(options: {
    readonly sessionId: string;
    readonly fallbackProjectPath?: string | null;
    readonly metadataFallback: PersistedChatSessionEntryTarget;
    readonly deferHostRecord?: boolean;
    readonly requestSource: HostSessionRestoreRequestSource;
  }): HostSessionSwitchRestoreRequest {
    const providerOptions = normalizeHostSessionProviderOptions(options.metadataFallback.providerOptions, {
      folderPath: options.metadataFallback.projectPath ?? null,
      permissionMode: this.ctx.chatService.currentSessionPermissionMode,
      ...(this.ctx.chatService.currentSessionPermissionLevel
        ? { permissionLevel: this.ctx.chatService.currentSessionPermissionLevel }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalsReviewer
        ? { approvalsReviewer: this.ctx.chatService.currentSessionApprovalsReviewer }
        : {}),
      ...(this.ctx.chatService.currentSessionApprovalPolicy
        ? { approvalPolicy: this.ctx.chatService.currentSessionApprovalPolicy }
        : {}),
    });
    const sessionProjectPath = resolveHostSessionProjectPathHint(
      {
        currentSessionPath: options.metadataFallback.projectPath ?? providerOptions.folderPath,
      },
      options.fallbackProjectPath,
    );
    const sessionContent = this.hostSessionContentProvider.provideChatSessionContent(
      options.sessionId,
      sessionProjectPath,
      {
        loadHostRecord: options.deferHostRecord !== true,
        metadataFallback: options.metadataFallback,
        fallbackProviderOptions: providerOptions,
      },
    );
    const sessionType = normalizeChatSessionType(
      sessionContent.sessionType,
      DEFAULT_CHAT_SESSION_TYPE,
    );
    const target: HostSessionSwitchTarget = {
      sessionId: options.sessionId,
      sessionType,
      projectPath: sessionContent.projectPathHint ?? providerOptions.folderPath ?? sessionProjectPath,
      providerOptions: sessionContent.providerOptions,
      inputState: sessionContent.inputState
        ?? options.metadataFallback.inputState
        ?? this.getChatSessionInputState(options.sessionId, sessionProjectPath),
    };
    const hostRecord = sessionContent.hostRecord ?? null;

    return {
      target,
      sessionContent,
      hostRecord,
      diagnostics: {
        sessionId: options.sessionId,
        projectPath: sessionProjectPath,
        requestSource: options.requestSource,
        hostRecordSource: options.deferHostRecord === true
          ? 'deferred'
          : hostRecord
            ? 'history'
            : 'missing',
        metadataSource: 'entry-target',
      },
    };
  }

  getChatSessionInputState(
    sessionId?: string,
    projectPathHint?: string | null,
  ): ChatSessionInputState {
    const providerOptions = this.getChatSessionProviderOptions(sessionId, projectPathHint);
    if (!sessionId) {
      return this.getOrCreateTrackedInputState(BLANK_SESSION_INPUT_STATE_KEY, () =>
        this.buildLiveCurrentInputState(providerOptions, 'new'),
      );
    }

    const managedItem = this.managedItems.get(sessionId);
    if (sessionId === this.ctx.chatService.currentSessionId) {
      const currentInputState = this.getOrCreateTrackedInputState(sessionId, () =>
        this.buildLiveCurrentInputState(providerOptions),
      );
      if (managedItem && managedItem.inputState !== currentInputState) {
        this.updateManagedItemState(sessionId, currentInputState);
      }
      return currentInputState;
    }

    if (managedItem) {
      return this.getOrCreateTrackedInputState(sessionId, () => managedItem.inputState);
    }

    const entry = this.ctx.chatHistoryService.findEntry(sessionId);
    const sessionContent = this.resolvePersistedSessionContent(sessionId, projectPathHint, entry);
    return this.getOrCreateTrackedInputState(sessionId, () => this.buildPersistedInputState(sessionContent));
  }

  getChatSessionProviderOptions(
    sessionId?: string,
    projectPathHint?: string | null,
  ): HostSessionProviderOptions {
    if (!sessionId || sessionId === this.ctx.chatService.currentSessionId) {
      return {
        folderPath: this.ctx.chatService.currentSessionPath || (projectPathHint ?? null),
        permissionMode: this.ctx.chatService.currentSessionPermissionMode,
        permissionProfile: this.ctx.chatService.currentSessionPermissionProfile,
        ...(this.ctx.chatService.currentSessionPermissionLevel
          ? { permissionLevel: this.ctx.chatService.currentSessionPermissionLevel }
          : {}),
        ...(this.ctx.chatService.currentSessionApprovalsReviewer
          ? { approvalsReviewer: this.ctx.chatService.currentSessionApprovalsReviewer }
          : {}),
        ...(this.ctx.chatService.currentSessionApprovalPolicy
          ? { approvalPolicy: this.ctx.chatService.currentSessionApprovalPolicy }
          : {}),
      };
    }

    const managedItem = this.managedItems.get(sessionId);
    if (managedItem) {
      return resolveHostSessionProviderOptionsFromInputState(managedItem.inputState, {
        folderPath: managedItem.projectPath ?? null,
        permissionMode: this.ctx.chatService.currentSessionPermissionMode,
        permissionLevel: managedItem.requestRouting?.permissionLevel,
        approvalsReviewer: managedItem.requestRouting?.approvalsReviewer,
        approvalPolicy: managedItem.requestRouting?.approvalPolicy,
      });
    }

    const entry = this.ctx.chatHistoryService.findEntry(sessionId);
    return this.resolvePersistedSessionContent(sessionId, projectPathHint, entry).providerOptions;
  }

  getChatSessionType(
    sessionId?: string,
    projectPathHint?: string | null,
  ): ChatSessionType {
    if (!sessionId || sessionId === this.ctx.chatService.currentSessionId) {
      return this.resolveCurrentSessionType();
    }

    const managedItem = this.managedItems.get(sessionId);
    if (managedItem) {
      return normalizeChatSessionType(managedItem.sessionType, DEFAULT_CHAT_SESSION_TYPE);
    }

    const entry = this.ctx.chatHistoryService.findEntry(sessionId);
    return normalizeChatSessionType(
      this.resolvePersistedSessionContent(sessionId, projectPathHint, entry).sessionType,
      entry?.sessionType ?? DEFAULT_CHAT_SESSION_TYPE,
    );
  }

  getChatSessionRequestRouting(
    sessionId?: string,
    projectPathHint?: string | null,
  ): HostSessionRequestRoutingSummary | undefined {
    if (!sessionId || sessionId === this.ctx.chatService.currentSessionId) {
      return buildHostSessionCurrentPickerRoutingSummary(
        this.resolveCurrentSelectedMode(),
        undefined,
        this.ctx.chatService.currentSessionPermissionLevel,
        this.ctx.chatService.currentSessionApprovalsReviewer,
        this.ctx.chatService.currentSessionApprovalPolicy,
      );
    }

    const managedItem = this.managedItems.get(sessionId);
    if (managedItem?.requestRouting) {
      return managedItem.requestRouting;
    }

    const entry = this.ctx.chatHistoryService.findEntry(sessionId);
    const sessionContent = this.resolvePersistedSessionContent(sessionId, projectPathHint, entry);
    return sessionContent.metadata?.requestRouting
      ? normalizeHostSessionRequestRoutingSummary(
          sessionContent.metadata.requestRouting,
          sessionContent.metadata.mode ?? DEFAULT_CHAT_SELECTED_MODE,
        )
      : undefined;
  }

  private getModeResolveOptions(): HostSessionSelectedModeResolveOptions {
    return {
      resolveModeById: (modeId) => this.ctx.chatService.findResolvedModeById(modeId),
      resolveModeByName: (modeName) => this.ctx.chatService.findResolvedModeByName?.(modeName),
    };
  }

  private resolvePersistedSessionContent(
    sessionId: string,
    projectPathHint?: string | null,
    entry: SessionIndexEntry | undefined = this.ctx.chatHistoryService.findEntry(sessionId),
  ): HostSessionContent {
    return this.hostSessionContentProvider.provideChatSessionContent(sessionId, projectPathHint, {
      metadataFallback: entry,
    });
  }

  private buildPersistedInputState(sessionContent: HostSessionContent): ChatSessionInputState {
    if (sessionContent.inputState) {
      return sessionContent.inputState;
    }

    if (sessionContent.metadata) {
      return normalizeHostSessionInputStateFromMetadata({
        ...sessionContent.metadata,
        projectPath: sessionContent.providerOptions.folderPath ?? sessionContent.projectPathHint,
      }, this.getModeResolveOptions());
    }

    return createChatSessionInputState(DEFAULT_CHAT_SELECTED_MODE, {
      groups: buildHostSessionProviderOptionGroups(sessionContent.providerOptions),
    });
  }

  private upsertManagedItem(seed: HostSessionManagedItemSeed): HostSessionManagedItem {
    const createdAt = seed.createdAt ?? Date.now();
    const inputState = seed.inputState ?? this.getChatSessionInputState(seed.sessionId, seed.projectPath ?? null);
    const selectedMode = this.resolveCurrentSelectedMode();
    const mode = seed.mode ?? normalizeChatSurfaceModeId(inputState.mode.kind, selectedMode.modeId);
    const titleCandidate = seed.title !== undefined
      ? normalizeChatSessionTitleCandidate({
          text: seed.title,
          source: seed.titleSource,
          revision: seed.titleRevision,
        })
      : this.resolveDefaultManagedTitleCandidate(seed.sessionId);
    const item: HostSessionManagedItem = {
      sessionId: seed.sessionId,
      title: titleCandidate.text,
      titleSource: titleCandidate.source,
      titleRevision: titleCandidate.revision,
      sessionType: normalizeChatSessionType(seed.sessionType, this.resolveCurrentSessionType()),
      createdAt,
      updatedAt: seed.updatedAt ?? createdAt,
      projectPath: seed.projectPath ?? null,
      ...(seed.agentRuntimeMode ? { agentRuntimeMode: seed.agentRuntimeMode } : {}),
      ...(seed.agentRuntimeModeSource ? { agentRuntimeModeSource: seed.agentRuntimeModeSource } : {}),
      inputState,
      mode,
      ...(seed.requestRouting
        ? { requestRouting: seed.requestRouting }
        : {
            requestRouting: buildHostSessionCurrentPickerRoutingSummary(
              selectedMode,
              undefined,
              this.ctx.chatService.currentSessionPermissionLevel,
              this.ctx.chatService.currentSessionApprovalsReviewer,
              this.ctx.chatService.currentSessionApprovalPolicy,
            ),
          }),
    };

    this.managedItems.set(item.sessionId, item);
    this.trackedInputStates.set(item.sessionId, item.inputState);
    return item;
  }

  private resolveManagedItemInputState(item: HostSessionManagedItem): ChatSessionInputState {
    if (item.sessionId !== this.ctx.chatService.currentSessionId) {
      return item.inputState;
    }

    return this.getChatSessionInputState();
  }

  private matchesHistoryFilter(
    item: HostSessionManagedItem,
    filter: HistoryFilterMode,
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): boolean {
    return this.matchesHistoryFilterByProject(item.projectPath, filter, projectPath, projectRootPath);
  }

  private matchesHistoryFilterByProject(
    itemProjectPath: string | null | undefined,
    filter: HistoryFilterMode,
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): boolean {
    if (filter !== 'current-project') {
      return true;
    }

    const normalizedProjectPath = normalizeChatSessionScopePath(projectPath);
    const normalizedProjectRootPath = normalizeChatSessionScopePath(projectRootPath);
    const isGlobalScope = !normalizedProjectPath
      || isSameChatSessionScopePath(normalizedProjectPath, normalizedProjectRootPath);

    if (isGlobalScope) {
      return itemProjectPath === null || itemProjectPath === undefined || normalizeChatSessionScopePath(itemProjectPath) === null;
    }

    return this.isSamePath(itemProjectPath ?? null, normalizedProjectPath);
  }

  private resolveManagedHistoryItem(sessionId: string): HostSessionHistoryItemWithTimestamp | null {
    const managedItem = this.managedItems.get(sessionId);
    return managedItem ? this.toHistoryItem(managedItem) : null;
  }

  private toHistoryItemFromSessionEntry(entry: SessionIndexEntry): HostSessionHistoryItemWithTimestamp {
    return this.toHistoryItem({
      sessionId: entry.sessionId,
      title: entry.title,
      ...(entry.titleSource ? { titleSource: entry.titleSource } : {}),
      sessionType: entry.sessionType ?? DEFAULT_CHAT_SESSION_TYPE,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      projectPath: entry.projectPath ?? null,
      agentRuntimeMode: entry.agentRuntimeMode ?? entry.runtimeMode,
      agentRuntimeModeSource: entry.agentRuntimeModeSource ?? entry.runtimeModeSource,
      inputState: this.getChatSessionInputStateFromIndexEntry(entry),
      mode: entry.mode,
      requestRouting: entry.requestRouting,
    });
  }

  private getChatSessionInputStateFromIndexEntry(entry: SessionIndexEntry): ChatSessionInputState {
    return this.getOrCreateTrackedInputState(entry.sessionId, () => {
      const canonicalEntry = this.ctx.chatHistoryService.findEntry(entry.sessionId) ?? entry;

      if (canonicalEntry.inputState) {
        return canonicalEntry.inputState;
      }

      const providerOptions = normalizeHostSessionProviderOptions({
        folderPath: canonicalEntry.projectPath ?? null,
        permissionMode: this.ctx.chatService.currentSessionPermissionMode,
        permissionLevel: canonicalEntry.requestRouting?.permissionLevel,
        approvalsReviewer: canonicalEntry.requestRouting?.approvalsReviewer,
        approvalPolicy: canonicalEntry.requestRouting?.approvalPolicy,
      }, {
        folderPath: canonicalEntry.projectPath ?? null,
        permissionMode: this.ctx.chatService.currentSessionPermissionMode,
        permissionLevel: canonicalEntry.requestRouting?.permissionLevel,
        approvalsReviewer: canonicalEntry.requestRouting?.approvalsReviewer,
        approvalPolicy: canonicalEntry.requestRouting?.approvalPolicy,
      });
      const selectedMode = normalizeChatSelectedMode({
        modeId: normalizeChatSurfaceModeId(canonicalEntry.mode, DEFAULT_CHAT_SELECTED_MODE.modeId),
        ...(canonicalEntry.requestRouting?.customAgentTarget
          ? { customAgentTarget: canonicalEntry.requestRouting.customAgentTarget }
          : {}),
      });

      return createChatSessionInputState(selectedMode, {
        groups: buildHostSessionProviderOptionGroups(providerOptions),
      });
    });
  }

  private toHistoryItem(
    item: HostSessionManagedItem | (Omit<HostSessionManagedItem, 'requestRouting'> & { requestRouting?: HostSessionRequestRoutingSummary }),
  ): HostSessionHistoryItemWithTimestamp {
    const isCurrent = item.sessionId === this.ctx.chatService.currentSessionId;
    const currentDurableTitle = isCurrent
      ? this.resolveCurrentSessionDurableTitleCandidate(item.sessionId)
      : null;
    const durableTitle = currentDurableTitle?.text || item.title;
    const title = this.resolveDisplaySessionTitleCandidate(
      item.sessionId,
      durableTitle,
      currentDurableTitle?.source ?? item.titleSource,
      item.projectPath,
    );
    const selectedMode = isCurrent
      ? this.resolveCurrentSelectedMode()
      : undefined;
    const inputState = item.sessionId === this.ctx.chatService.currentSessionId
      ? this.getChatSessionInputState(item.sessionId, item.projectPath)
      : item.inputState;

    return {
      sessionId: item.sessionId,
      title: title.text,
      titleSource: title.source,
      titleRevision: item.titleRevision,
      titleDurable: title.durable,
      sessionType: isCurrent ? this.resolveCurrentSessionType() : normalizeChatSessionType(item.sessionType, DEFAULT_CHAT_SESSION_TYPE),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      current: isCurrent,
      projectPath: isCurrent
        ? this.ctx.chatService.currentSessionPath || (item.projectPath ?? null)
        : item.projectPath ?? null,
      ...((isCurrent ? this.ctx.chatService.currentAgentRuntimeMode : item.agentRuntimeMode)
        ? { agentRuntimeMode: isCurrent ? this.ctx.chatService.currentAgentRuntimeMode : item.agentRuntimeMode }
        : {}),
      ...((isCurrent ? this.ctx.chatService.currentAgentRuntimeModeSource : item.agentRuntimeModeSource)
        ? { agentRuntimeModeSource: isCurrent ? this.ctx.chatService.currentAgentRuntimeModeSource : item.agentRuntimeModeSource }
        : {}),
      ...(inputState ? { inputState } : {}),
      ...((isCurrent ? selectedMode?.modeId : item.mode) ? { mode: isCurrent ? selectedMode?.modeId : item.mode } : {}),
      ...((isCurrent
        ? buildHostSessionCurrentPickerRoutingSummary(
            selectedMode ?? DEFAULT_CHAT_SELECTED_MODE,
            undefined,
            this.ctx.chatService.currentSessionPermissionLevel,
            this.ctx.chatService.currentSessionApprovalsReviewer,
            this.ctx.chatService.currentSessionApprovalPolicy,
          )
        : item.requestRouting)
        ? {
            requestRouting: isCurrent
              ? buildHostSessionCurrentPickerRoutingSummary(
                  selectedMode ?? DEFAULT_CHAT_SELECTED_MODE,
                  undefined,
                  this.ctx.chatService.currentSessionPermissionLevel,
                  this.ctx.chatService.currentSessionApprovalsReviewer,
                  this.ctx.chatService.currentSessionApprovalPolicy,
                )
              : item.requestRouting,
          }
        : {}),
    };
  }

  private toSummaryItem(
    item: HostSessionHistoryItem,
    stateResolver: HostSessionListItemStateResolver = (summaryItem, timing) => this.resolveListItemState(summaryItem, timing),
  ): SessionInventorySummary {
    const persistedEntry = this.ctx.chatHistoryService.findEntry(item.sessionId);
    const cacheKey = this.buildDurableListItemCacheKey(item, persistedEntry);
    const cached = this.cachedSummaryItems.get(item.sessionId);
    if (cached?.key === cacheKey) {
      return cached.item;
    }

    const liveRuntimeState = this.readLiveRuntimeState(item.sessionId);
    const liveSummaryRecord = this.buildLiveSummaryRecord(item.sessionId, liveRuntimeState);
    const updatedAt = this.readTurnUpdatedAt(this.getLatestTurnResponse(liveSummaryRecord))
      ?? item.updatedAt
      ?? persistedEntry?.updatedAt
      ?? item.createdAt;
    const timing = this.resolveListItemTiming(item, liveSummaryRecord, updatedAt);
    const sessionState = stateResolver(item, timing);
    const badge = this.resolveListItemBadge(item);
    const status = this.resolveListItemStatus(liveSummaryRecord, liveRuntimeState);
    const description = this.resolveListItemDescription(item, liveSummaryRecord, updatedAt, liveRuntimeState);

    const nextItem: SessionInventorySummary = {
      ...item,
      timing,
      metadata: this.resolveListItemMetadata(item),
      archived: sessionState.archived,
      pinned: sessionState.pinned,
      read: sessionState.read,
      markedUnread: sessionState.markedUnread,
      ...(badge ? { badge } : {}),
      ...(status ? { status } : {}),
      ...(description ? { description } : {}),
    };

    this.cachedSummaryItems.set(item.sessionId, {
      key: cacheKey,
      item: nextItem,
    });

    return nextItem;
  }

  private buildSummaryOrderInfo(
    item: HostSessionHistoryItem,
    stateResolver: HostSessionListItemStateResolver,
  ): SessionInventorySummaryOrderInfo {
    const liveRuntimeState = this.readLiveRuntimeState(item.sessionId);
    const liveSummaryRecord = this.buildLiveSummaryRecord(item.sessionId, liveRuntimeState);
    const persistedEntry = this.ctx.chatHistoryService.findEntry(item.sessionId);
    const updatedAt = this.readTurnUpdatedAt(this.getLatestTurnResponse(liveSummaryRecord))
      ?? item.updatedAt
      ?? persistedEntry?.updatedAt
      ?? item.createdAt;
    const timing = this.resolveListItemTiming(item, liveSummaryRecord, updatedAt);
    const sessionState = stateResolver(item, timing);
    const status = this.resolveListItemStatus(liveSummaryRecord, liveRuntimeState);

    return {
      timing,
      archived: sessionState.archived,
      pinned: sessionState.pinned,
      ...(status ? { status } : {}),
    };
  }

  private toListItem(item: SessionInventorySummary): HostSessionListItem {
    const persistedEntry = this.ctx.chatHistoryService.findEntry(item.sessionId);
    const cacheKey = this.buildDurableListItemCacheKey(item, persistedEntry);
    const cached = this.cachedListItems.get(item.sessionId);
    if (cached?.key === cacheKey) {
      return cached.item;
    }

    ChatPerformanceTracer.increment('session_list.load_host_record');
    const hostRecord = this.ctx.chatHistoryService.loadHostRecord(item.sessionId, item.projectPath ?? null);
    const effectiveHostRecord = this.resolveEffectiveHostRecord(item, hostRecord);
    const updatedAt = this.resolveListItemUpdatedAt(item, effectiveHostRecord, persistedEntry)
      ?? effectiveHostRecord?.metadata?.updatedAt
      ?? item.timing.updated
      ?? item.createdAt;
    const liveRuntimeState = this.readLiveRuntimeState(item.sessionId);
    const timing = this.resolveListItemTiming(item, effectiveHostRecord, updatedAt);
    const status = this.resolveListItemStatus(effectiveHostRecord, liveRuntimeState);
    const changes = this.resolveListItemChanges(effectiveHostRecord);

    const nextItem: HostSessionListItem = {
      ...item,
      timing,
      description: this.resolveListItemDescription(item, effectiveHostRecord, updatedAt, liveRuntimeState),
      ...(status ? { status } : {}),
      ...(changes ? { changes } : {}),
    };

    this.cachedListItems.set(item.sessionId, {
      key: cacheKey,
      item: nextItem,
    });

    return nextItem;
  }

  private buildLiveSummaryRecord(
    sessionId: string,
    liveRuntimeState?: ChatSessionRuntimeState,
  ): HostSessionRecordLike | undefined {
    const runtimeTurnResponses = Array.isArray(liveRuntimeState?.turnResponses) && liveRuntimeState.turnResponses.length > 0
      ? liveRuntimeState.turnResponses
      : undefined;
    const liveTurnResponses = runtimeTurnResponses ?? this.readLiveTurnResponses(sessionId);

    if (!Array.isArray(liveTurnResponses) || liveTurnResponses.length === 0) {
      return undefined;
    }

    return {
      turnResponses: liveTurnResponses as readonly HostSessionTurnResponse[],
    };
  }

  private buildDurableListItemCacheKey(
    item: HostSessionHistoryItem,
    persistedEntry: SessionIndexEntry | undefined,
  ): string {
    const runtimeStamp = this.buildRuntimeCacheStamp(item.sessionId);
    const modeStamp = this.buildModeRoutingCacheStamp(item);
    const currentSessionStamp = item.current ? this.buildCurrentSessionCacheStamp() : '';
    const perSessionVersion = this.sessionListItemVersions.get(item.sessionId) ?? 0;
    const persistedUpdatedAt = persistedEntry?.updatedAt ?? '';
    const persistedMessageCount = persistedEntry?.messageCount ?? '';

    return [
      item.sessionId,
      item.title,
      item.titleSource ?? '',
      item.titleRevision ?? '',
      item.titleDurable ? 1 : 0,
      this.normalizePathForCache(item.projectPath ?? null),
      item.createdAt,
      item.current ? 1 : 0,
      persistedUpdatedAt,
      persistedMessageCount,
      modeStamp,
      runtimeStamp,
      currentSessionStamp,
      perSessionVersion,
      this.globalListItemVersion,
    ].join('::');
  }

  private buildRuntimeCacheStamp(sessionId: string): string {
    const runtimeState = this.readLiveRuntimeState(sessionId);
    const runtimeTurnResponses = runtimeState?.turnResponses;
    const runtimeTurnCount = Array.isArray(runtimeTurnResponses) ? runtimeTurnResponses.length : 0;
    const runtimeLastTurn = runtimeTurnCount > 0
      ? this.readTurnUpdatedAt(runtimeTurnResponses[runtimeTurnCount - 1] as HostSessionTurnResponse)
      : undefined;
    const runtimeLastStatus = runtimeTurnCount > 0
      ? this.readNonEmptyString((runtimeTurnResponses[runtimeTurnCount - 1] as HostSessionTurnResponse)?.response?.continuation?.status)
        ?? this.readNonEmptyString((runtimeTurnResponses[runtimeTurnCount - 1] as HostSessionTurnResponse)?.response?.status)
      : undefined;
    const liveTurnResponses = this.readLiveTurnResponses(sessionId);
    const liveTurnCount = Array.isArray(liveTurnResponses) ? liveTurnResponses.length : 0;
    const liveLastTurn = liveTurnCount > 0
      ? this.readTurnUpdatedAt(liveTurnResponses[liveTurnCount - 1] as HostSessionTurnResponse)
      : undefined;
    const liveLastStatus = liveTurnCount > 0
      ? this.readNonEmptyString((liveTurnResponses[liveTurnCount - 1] as HostSessionTurnResponse)?.response?.continuation?.status)
        ?? this.readNonEmptyString((liveTurnResponses[liveTurnCount - 1] as HostSessionTurnResponse)?.response?.status)
      : undefined;
    const runtimeDescription = this.normalizeListDescriptionText(runtimeState?.description) ?? '';

    return [
      runtimeState?.status ?? '',
      runtimeState?.requestInProgress ? 1 : 0,
      runtimeTurnCount,
      runtimeLastTurn ?? '',
      runtimeLastStatus ?? '',
      liveTurnCount,
      liveLastTurn ?? '',
      liveLastStatus ?? '',
      runtimeDescription,
    ].join('|');
  }

  private buildModeRoutingCacheStamp(item: HostSessionHistoryItem): string {
    return [
      item.mode ?? '',
      item.inputState?.mode?.id ?? '',
      item.inputState?.mode?.kind ?? '',
      item.requestRouting?.selectedModeId ?? '',
      item.requestRouting?.requestModeId ?? '',
      item.requestRouting?.customAgentTarget ?? '',
    ].join('|');
  }

  private buildCurrentSessionCacheStamp(): string {
    const title = this.readNonEmptyString(this.ctx.chatService.currentSessionTitle) ?? '';
    const currentSelectedMode = this.resolveCurrentSelectedMode();

    return [
      this.ctx.chatService.currentSessionId ?? '',
      this.normalizePathForCache(this.ctx.chatService.currentSessionPath ?? null),
      this.ctx.chatService.currentSessionType ?? '',
      title,
      this.readCurrentSessionTitleSource() ?? '',
      currentSelectedMode.modeId,
      currentSelectedMode.customAgentTarget ?? '',
    ].join('|');
  }

  private normalizePathForCache(path: string | null | undefined): string {
    return (path ?? '').replace(/\\/g, '/').toLowerCase();
  }

  private createListItemStateResolver(): HostSessionListItemStateResolver {
    const readScopeSnapshot = this.ctx.chatSessionStateService?.readScopeSnapshot?.bind(this.ctx.chatSessionStateService);
    if (!readScopeSnapshot) {
      return (item, timing) => this.resolveListItemState(item, timing);
    }

    const scopeSnapshots = new Map<string, ChatSessionStateScopeSnapshot>();
    return (item, timing) => {
      const projectPath = this.resolveSessionStateProjectPath(item.sessionId, item.projectPath ?? null);
      const scopeKey = this.normalizePathForCache(projectPath ?? null);
      let scopeSnapshot = scopeSnapshots.get(scopeKey);
      if (!scopeSnapshot) {
        scopeSnapshot = readScopeSnapshot(projectPath);
        scopeSnapshots.set(scopeKey, scopeSnapshot);
      }

      return this.resolveListItemStateFromPersistedState(
        scopeSnapshot.sessions[item.sessionId],
        timing,
        scopeSnapshot.readDateBaseline,
      );
    };
  }

  private resolveListItemState(
    item: Pick<HostSessionHistoryItem, 'sessionId' | 'projectPath'>,
    timing: HostSessionListItemTiming,
  ): ResolvedChatSessionState {
    const trackingTime = timing.lastRequestEnded ?? timing.updated ?? timing.created;
    const projectPath = this.resolveSessionStateProjectPath(item.sessionId, item.projectPath ?? null);
    const scopeSnapshot = this.ctx.chatSessionStateService?.readScopeSnapshot?.(projectPath);
    if (scopeSnapshot) {
      return this.resolveListItemStateFromPersistedState(
        scopeSnapshot.sessions[item.sessionId],
        timing,
        scopeSnapshot.readDateBaseline,
      );
    }

    return this.ctx.chatSessionStateService?.resolveSessionState(item.sessionId, {
      projectPath: this.resolveSessionStateProjectPath(item.sessionId, item.projectPath ?? null),
      trackingTime,
    }) ?? {
      archived: false,
      pinned: false,
      read: true,
      markedUnread: false,
    };
  }

  private resolveListItemStateFromPersistedState(
    persistedState: PersistedChatSessionState | undefined,
    timing: HostSessionListItemTiming,
    readDateBaseline: number,
  ): ResolvedChatSessionState {
    const archived = persistedState?.archived === true;
    const pinned = persistedState?.pinned === true;
    const markedUnread = persistedState?.read === -1;
    const trackingTime = timing.lastRequestEnded ?? timing.updated ?? timing.created;

    let read = archived;
    if (!read) {
      const readDate = Math.max(
        typeof persistedState?.read === 'number' && persistedState.read !== -1 ? persistedState.read : 0,
        readDateBaseline,
      );
      read = !markedUnread && readDate >= trackingTime - 2000;
    }

    return {
      archived,
      pinned,
      read,
      markedUnread,
    };
  }

  private resolveListItemDescription(
    item: Pick<HostSessionHistoryItem, 'sessionId' | 'current' | 'sessionType' | 'projectPath' | 'createdAt'>,
    hostRecord: HostSessionRecordLike | null | undefined,
    updatedAt: number,
    liveRuntimeState?: ChatSessionRuntimeState,
  ): string {
    if (item.current || this.hasLiveRuntimeState(item.sessionId, liveRuntimeState)) {
      const runtimeDescription = this.normalizeListDescriptionText(liveRuntimeState?.description);
      if (runtimeDescription) {
        return runtimeDescription;
      }

      const liveRecord = this.resolveLiveOverlayRecord(hostRecord, liveRuntimeState);
      const effectiveRecord = liveRecord ?? hostRecord;
      if (effectiveRecord) {
        const liveDescription = this.buildCurrentLiveDescription(effectiveRecord);
        if (liveDescription) {
          return liveDescription;
        }
      }
    }

    return '';
  }

  private resolveListItemTiming(
    item: Pick<HostSessionHistoryItem, 'createdAt'>,
    record: HostSessionRecordLike | null | undefined,
    updatedAt: number,
  ): HostSessionListItemTiming {
    const latestTurn = this.getLatestTurnResponse(record);
    const lastRequestEnded = this.readTurnResponseTimestamp(latestTurn);
    const elapsedMs = this.readTurnResponseElapsedMs(latestTurn);
    const lastRequestStarted = lastRequestEnded !== undefined && elapsedMs !== undefined && elapsedMs >= 0
      ? Math.max(item.createdAt, lastRequestEnded - elapsedMs)
      : undefined;

    return {
      created: item.createdAt,
      updated: updatedAt,
      ...(lastRequestStarted !== undefined ? { lastRequestStarted } : {}),
      ...(lastRequestEnded !== undefined ? { lastRequestEnded } : {}),
    };
  }

  private resolveListItemMetadata(
    item: Pick<HostSessionHistoryItem, 'sessionType' | 'projectPath' | 'inputState' | 'requestRouting'>,
  ): HostSessionListItemMetadata {
    const providerOptions = item.inputState
      ? resolveHostSessionProviderOptionsFromInputState(item.inputState, {
          folderPath: item.projectPath ?? null,
          permissionMode: this.ctx.chatService.currentSessionPermissionMode,
          permissionLevel: item.requestRouting?.permissionLevel,
          approvalsReviewer: item.requestRouting?.approvalsReviewer,
          approvalPolicy: item.requestRouting?.approvalPolicy,
        })
      : normalizeHostSessionProviderOptions({
          folderPath: item.projectPath ?? null,
          permissionMode: this.ctx.chatService.currentSessionPermissionMode,
          permissionLevel: item.requestRouting?.permissionLevel,
          approvalsReviewer: item.requestRouting?.approvalsReviewer,
          approvalPolicy: item.requestRouting?.approvalPolicy,
        }, {
          folderPath: item.projectPath ?? null,
          permissionMode: this.ctx.chatService.currentSessionPermissionMode,
          permissionLevel: item.requestRouting?.permissionLevel,
          approvalsReviewer: item.requestRouting?.approvalsReviewer,
          approvalPolicy: item.requestRouting?.approvalPolicy,
        });
    const workingDirectoryPath = this.readNonEmptyString(
      providerOptions.folderPath ?? item.projectPath,
    );
    const projectLabel = this.describeProjectPath(workingDirectoryPath ?? item.projectPath ?? null);

    return {
      providerLabel: this.describeSessionType(item.sessionType),
      ...(projectLabel ? { projectLabel } : {}),
      ...(workingDirectoryPath ? { workingDirectoryPath } : {}),
    };
  }

  private resolveListItemChanges(
    record: HostSessionRecordLike | null | undefined,
  ): HostSessionListItemChanges | undefined {
    const turnId = this.readNonEmptyString(this.getLatestTurnResponse(record)?.turnId);
    if (!turnId || !this.ctx.editCheckpointService) {
      return undefined;
    }

    const summary = this.ctx.editCheckpointService.getRequestEditsSummarySync(turnId);
    if (!summary || summary.fileCount <= 0) {
      return undefined;
    }

    return {
      fileCount: summary.fileCount,
      insertions: summary.totalAdded,
      deletions: summary.totalRemoved,
    };
  }

  private buildListItemDescription(
    item: Pick<HostSessionHistoryItem, 'sessionType' | 'projectPath' | 'createdAt'>,
    updatedAt: number,
  ): string {
    const parts = [
      this.describeSessionType(item.sessionType),
      this.describeProjectPath(item.projectPath),
      this.formatRelativeTime(updatedAt || item.createdAt),
    ].filter((part): part is string => typeof part === 'string' && part.length > 0);

    return parts.join(' • ');
  }

  private buildCurrentLiveDescription(record: HostSessionRecordLike | null | undefined): string | undefined {
    const latestTurn = this.getLatestTurnResponse(record);
    if (!latestTurn) {
      return undefined;
    }

    const structuredPartText = this.readLatestStructuredResponsePartText(latestTurn);
    const progressMessage = this.readLatestProgressMessage(latestTurn);
    const summaryPreview = this.normalizeListDescriptionText(
      this.readNonEmptyString(latestTurn.responseModel?.summaryPreview),
    );
    const partText = this.readLatestResponsePartText(latestTurn);
    const detailText = structuredPartText ?? progressMessage ?? summaryPreview ?? partText;
    const pendingDescription = this.resolvePendingDescription(latestTurn, detailText);

    return pendingDescription
      ?? detailText
      ?? this.describeLiveResponseStatus(latestTurn);
  }

  private readLatestStructuredResponsePartText(turn: HostSessionTurnResponse): string | undefined {
    const parts = turn.response?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return undefined;
    }

    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const text = this.extractStructuredResponsePartText(parts[index]);
      if (text) {
        return text;
      }
    }

    return undefined;
  }

  private getLatestTurnResponse(record: HostSessionRecordLike | null | undefined): HostSessionTurnResponse | undefined {
    const turnResponses = record?.turnResponses;
    return Array.isArray(turnResponses) && turnResponses.length > 0
      ? turnResponses[turnResponses.length - 1]
      : undefined;
  }

  private readLatestProgressMessage(turn: HostSessionTurnResponse): string | undefined {
    const progressMessages = turn.response?.progressMessages;
    if (!Array.isArray(progressMessages) || progressMessages.length === 0) {
      return undefined;
    }

    for (let index = progressMessages.length - 1; index >= 0; index -= 1) {
      const content = this.normalizeListDescriptionText(this.readNonEmptyString(progressMessages[index]?.content));
      if (content) {
        return content;
      }
    }

    return undefined;
  }

  private readLatestResponsePartText(turn: HostSessionTurnResponse): string | undefined {
    const parts = turn.response?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      return this.normalizeListDescriptionText(this.readNonEmptyString(turn.response?.resultText));
    }

    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const text = this.extractResponsePartText(parts[index]);
      if (text) {
        return text;
      }
    }

    return this.normalizeListDescriptionText(this.readNonEmptyString(turn.response?.resultText));
  }

  private extractResponsePartText(part: unknown): string | undefined {
    const candidate = part as {
      readonly type?: unknown;
      readonly title?: unknown;
      readonly message?: unknown;
      readonly content?: unknown;
      readonly text?: unknown;
      readonly description?: unknown;
      readonly resultText?: unknown;
      readonly state?: unknown;
      readonly metadata?: Record<string, unknown> | null;
      readonly questions?: ReadonlyArray<{ readonly question?: unknown }>;
    };

    switch (candidate?.type) {
      case 'question':
        return this.normalizeListDescriptionText(
          this.readNonEmptyString(candidate.questions?.[0]?.question)
            ?? this.readNonEmptyString(candidate.text),
        );
      case 'confirmation':
        return this.normalizeListDescriptionText(
          this.readNonEmptyString(candidate.title)
            ?? this.readNonEmptyString(candidate.message),
        );
      case 'thinking':
        return this.normalizeListDescriptionText(this.readNonEmptyString(candidate.content) ?? 'Thinking...');
      case 'tool_call':
        return this.normalizeListDescriptionText(this.readNonEmptyString(candidate.text));
      case 'subagent':
        return this.normalizeListDescriptionText(
          this.readNonEmptyString(candidate.description)
            ?? this.readNonEmptyString(candidate.text)
            ?? this.readNonEmptyString(candidate.resultText),
        );
      case 'info':
      case 'warning':
      case 'error':
      case 'markdown':
        return this.normalizeListDescriptionText(
          this.readNonEmptyString(candidate.message)
            ?? this.readNonEmptyString(candidate.content),
        );
      default:
        return undefined;
    }
  }

  private extractStructuredResponsePartText(part: unknown): string | undefined {
    const candidate = part as {
      readonly type?: unknown;
      readonly title?: unknown;
      readonly message?: unknown;
      readonly description?: unknown;
      readonly subtitle?: unknown;
      readonly text?: unknown;
      readonly state?: unknown;
      readonly metadata?: Record<string, unknown> | null;
    };

    switch (candidate?.type) {
      case 'confirmation':
        return this.normalizeListDescriptionText(
          this.readNonEmptyString(candidate.title)
            ?? this.readNonEmptyString(candidate.description)
            ?? this.readNonEmptyString(candidate.message)
            ?? this.readNonEmptyString(candidate.subtitle),
        );
      case 'tool_call': {
        const metadata = candidate.metadata ?? undefined;
        const normalizedState = this.readNonEmptyString(candidate.state);
        const preferredMessage = normalizedState === 'done' || normalizedState === 'error'
          ? this.readNonEmptyString(metadata?.['generatedTitle'])
            ?? this.readNonEmptyString(metadata?.['pastTenseMessage'])
            ?? this.readNonEmptyString(metadata?.['invocationMessage'])
          : this.readNonEmptyString(metadata?.['generatedTitle'])
            ?? this.readNonEmptyString(metadata?.['invocationMessage'])
            ?? this.readNonEmptyString(metadata?.['pastTenseMessage']);

        return this.normalizeListDescriptionText(
          preferredMessage
            ?? this.readNonEmptyString(candidate.text),
        );
      }
      default:
        return undefined;
    }
  }

  private resolvePendingDescription(
    turn: HostSessionTurnResponse,
    detailText?: string,
  ): string | undefined {
    const pendingKind = this.readNonEmptyString(turn.response?.continuation?.pendingState?.['kind']);
    const continuationStatus = this.readNonEmptyString(turn.response?.continuation?.status);
    const normalizedPendingKind = pendingKind ?? continuationStatus;

    switch (normalizedPendingKind) {
      case 'question':
      case 'waiting_question':
        return detailText ? `Waiting for answer: ${detailText}` : 'Waiting for answer';
      case 'confirmation':
      case 'waiting_confirmation':
        return detailText ? `Waiting for confirmation: ${detailText}` : 'Waiting for confirmation';
      case 'tool_results':
      case 'waiting_tool_results':
        return detailText ? `Waiting for tool results: ${detailText}` : 'Waiting for tool results';
      case 'plan_review':
        return detailText ? `Plan review required: ${detailText}` : 'Plan review required';
      case 'continue':
        return detailText ? `Continue required: ${detailText}` : 'Continue required';
      default:
        return undefined;
    }
  }

  private describeLiveResponseStatus(turn: HostSessionTurnResponse): string | undefined {
    const status = this.readNonEmptyString(turn.response?.continuation?.status)
      ?? this.readNonEmptyString(turn.response?.status);

    switch (status) {
      case 'running':
        return 'Thinking...';
      case 'waiting_question':
        return 'Waiting for answer';
      case 'waiting_confirmation':
        return 'Waiting for confirmation';
      case 'waiting_tool_results':
        return 'Waiting for tool results';
      case 'plan_review':
        return 'Plan review required';
      case 'continue':
        return 'Continue required';
      case 'hard_stopped':
        return 'Stopped';
      case 'failed':
        return 'Failed';
      default:
        return undefined;
    }
  }

  private resolveListItemBadge(
    item: Pick<HostSessionHistoryItem, 'inputState' | 'requestRouting' | 'mode'>,
  ): string | undefined {
    const instructionName = this.readNonEmptyString(item.inputState?.mode?.modeInstructions?.name);
    if (instructionName) {
      return instructionName;
    }

    const customAgentTarget = this.readNonEmptyString(item.requestRouting?.customAgentTarget);
    if (customAgentTarget) {
      return customAgentTarget;
    }

    return this.describeModeId(item.requestRouting?.requestModeId ?? item.requestRouting?.selectedModeId ?? item.mode);
  }

  private resolveListItemStatus(
    record: HostSessionRecordLike | null | undefined,
    liveRuntimeState?: ChatSessionRuntimeState,
  ): HostSessionListItemStatus | undefined {
    const sessionId = this.readNonEmptyString(record?.metadata?.sessionId) ?? 'unknown';
    const runtimeStatus = normalizeHostSessionListItemStatus(liveRuntimeState?.status);
    if (runtimeStatus) {
      if (runtimeStatus !== 'in_progress' || liveRuntimeState?.requestInProgress === true) {
        traceBackgroundSessionStatus('use-runtime-status', {
          sessionId,
          runtimeStatus,
          requestInProgress: !!liveRuntimeState?.requestInProgress,
        });
        return runtimeStatus;
      }

      // Align with VS Code model semantics: in-progress requires an active request.
      traceBackgroundSessionStatus('drop-stale-runtime-in-progress', {
        sessionId,
        runtimeStatus,
        requestInProgress: !!liveRuntimeState?.requestInProgress,
      });
    }

    const liveRecord = this.resolveLiveOverlayRecord(record, liveRuntimeState);
    if (liveRecord) {
      const latestTurn = this.getLatestTurnResponse(liveRecord);
      if (latestTurn) {
        const continuationStatus = this.readNonEmptyString(latestTurn?.response?.continuation?.status);
        const responseStatus = this.readNonEmptyString(latestTurn?.response?.status);
        const resolvedStatus = continuationStatus ?? responseStatus;
        const turnStatus = normalizeHostSessionListItemStatus(resolvedStatus);
        if (turnStatus) {
          if (turnStatus === 'in_progress' && liveRuntimeState?.requestInProgress !== true) {
            traceBackgroundSessionStatus('drop-stale-live-turn-in-progress', {
              sessionId,
              continuationStatus,
              responseStatus,
              requestInProgress: !!liveRuntimeState?.requestInProgress,
            });
          } else {
            traceBackgroundSessionStatus('use-live-turn-status', {
              sessionId,
              continuationStatus,
              responseStatus,
              turnStatus,
            });
            return turnStatus;
          }
        }
      }
    }

    if (liveRuntimeState?.requestInProgress === true) {
      traceBackgroundSessionStatus('use-runtime-request-in-progress', {
        sessionId,
      });
      return 'in_progress';
    }

    const latestTurn = this.getLatestTurnResponse(record);
    if (latestTurn) {
      const responseStatus = this.readNonEmptyString(latestTurn?.response?.status);
      const turnStatus = this.resolveDurableTurnStatus(responseStatus);
      if (turnStatus) {
        traceBackgroundSessionStatus('use-durable-turn-status', {
          sessionId,
          responseStatus,
          turnStatus,
        });
        return turnStatus;
      }
    }

    return undefined;
  }

  private hasLiveTurnResponsesForRecord(record: HostSessionRecordLike | null | undefined): boolean {
    const sessionId = this.readNonEmptyString(record?.metadata?.sessionId);
    return !!sessionId && this.hasLiveTurnResponses(sessionId);
  }

  private resolveLiveOverlayRecord(
    record: HostSessionRecordLike | null | undefined,
    liveRuntimeState?: ChatSessionRuntimeState,
  ): HostSessionRecordLike | null {
    if (Array.isArray(liveRuntimeState?.turnResponses) && liveRuntimeState.turnResponses.length > 0) {
      return {
        ...(record ?? {}),
        turnResponses: liveRuntimeState.turnResponses,
      };
    }

    return this.hasLiveTurnResponsesForRecord(record) ? record ?? null : null;
  }

  private resolveDurableTurnStatus(status: string | undefined): HostSessionListItemStatus | undefined {
    switch (status) {
      case 'failed':
      case 'error':
        return 'failed';
      case 'completed':
        return 'completed';
      case 'hard_stopped':
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      default:
        return undefined;
    }
  }

  private compareListItems(
    left: Pick<SessionInventorySummary, 'archived' | 'pinned' | 'status' | 'timing'>,
    right: Pick<SessionInventorySummary, 'archived' | 'pinned' | 'status' | 'timing'>,
  ): number {
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

    return (right.timing.updated ?? right.timing.created) - (left.timing.updated ?? left.timing.created);
  }

  private resolveSessionStateProjectPath(
    sessionId: string,
    projectPathHint?: string | null,
  ): string | null {
    if (sessionId === this.ctx.chatService.currentSessionId) {
      return this.ctx.chatService.currentSessionPath
        ?? this.managedItems.get(sessionId)?.projectPath
        ?? this.ctx.chatHistoryService.findEntry(sessionId)?.projectPath
        ?? projectPathHint
        ?? null;
    }

    return this.managedItems.get(sessionId)?.projectPath
      ?? this.ctx.chatHistoryService.findEntry(sessionId)?.projectPath
      ?? projectPathHint
      ?? null;
  }

  private resolveSessionReadTrackingTime(
    sessionId: string,
    projectPathHint?: string | null,
  ): number {
    const projectPath = this.resolveSessionStateProjectPath(sessionId, projectPathHint);
    const hostRecord = this.resolveEffectiveHostRecord(
      { sessionId, current: sessionId === this.ctx.chatService.currentSessionId },
      this.ctx.chatHistoryService.loadHostRecord(sessionId, projectPath),
    );
    const latestTurn = this.getLatestTurnResponse(hostRecord);
    return this.readTurnResponseTimestamp(latestTurn)
      ?? this.readTurnUpdatedAt(latestTurn)
      ?? hostRecord?.metadata?.updatedAt
      ?? this.ctx.chatHistoryService.findEntry(sessionId)?.updatedAt
      ?? hostRecord?.metadata?.createdAt
      ?? this.ctx.chatHistoryService.findEntry(sessionId)?.createdAt
      ?? Date.now();
  }

  private resolveEffectiveHostRecord(
    item: Pick<HostSessionHistoryItem, 'sessionId' | 'current'>,
    record: HostSessionContent['hostRecord'],
  ): HostSessionRecordLike | undefined {
    const liveTurnResponses = this.readLiveTurnResponses(item.sessionId);
    if (!Array.isArray(liveTurnResponses) || liveTurnResponses.length === 0) {
      return record ?? undefined;
    }

    const liveUpdatedAt = this.readTurnUpdatedAt(liveTurnResponses[liveTurnResponses.length - 1]);

    return {
      ...(record ?? {}),
      ...(record?.metadata
        ? {
            metadata: {
              ...record.metadata,
              ...(liveUpdatedAt !== undefined ? { updatedAt: liveUpdatedAt } : {}),
            },
          }
        : {}),
      turnResponses: liveTurnResponses,
    };
  }

  private readLiveTurnResponses(sessionId: string): readonly TurnResponseTurn[] | undefined {
    const liveTurnResponses = this.ctx.readLiveSessionTurnResponses?.(sessionId);
    return Array.isArray(liveTurnResponses) && liveTurnResponses.length > 0
      ? liveTurnResponses
      : undefined;
  }

  private hasLiveTurnResponses(sessionId: string): boolean {
    return (this.readLiveTurnResponses(sessionId)?.length ?? 0) > 0;
  }

  private readLiveRuntimeState(sessionId: string): ChatSessionRuntimeState | undefined {
    const runtimeState = this.ctx.readLiveSessionRuntimeState?.(sessionId);
    return runtimeState ?? undefined;
  }

  private hasLiveRuntimeState(sessionId: string, runtimeState = this.readLiveRuntimeState(sessionId)): boolean {
    return !!runtimeState || this.hasLiveTurnResponses(sessionId);
  }

  private resolveListItemUpdatedAt(
    item: Pick<HostSessionHistoryItem, 'createdAt'>,
    record: HostSessionRecordLike | null | undefined,
    persistedEntry: SessionIndexEntry | undefined,
  ): number | undefined {
    const latestTurn = this.getLatestTurnResponse(record);
    return this.readTurnUpdatedAt(latestTurn)
      ?? record?.metadata?.updatedAt
      ?? persistedEntry?.updatedAt
      ?? item.createdAt;
  }

  private readTurnUpdatedAt(turn: HostSessionTurnResponse | undefined): number | undefined {
    return this.readFiniteNumber((turn as TurnResponseTurn | undefined)?.updatedAt)
      ?? this.readFiniteNumber((turn?.response as { updatedAt?: unknown } | undefined)?.updatedAt)
      ?? this.readTurnResponseTimestamp(turn);
  }

  private readTurnResponseTimestamp(turn: HostSessionTurnResponse | undefined): number | undefined {
    return this.readFiniteNumber((turn?.response as { timestamp?: unknown } | undefined)?.timestamp);
  }

  private readTurnResponseElapsedMs(turn: HostSessionTurnResponse | undefined): number | undefined {
    return this.readFiniteNumber((turn?.response as { elapsedMs?: unknown } | undefined)?.elapsedMs);
  }

  private readFiniteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }

  private normalizeListDescriptionText(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return undefined;
    }

    return normalized.length > 120
      ? `${normalized.slice(0, 117).trimEnd()}...`
      : normalized;
  }

  private describeSessionType(sessionType: string | null | undefined): string {
    const normalizedType = this.readNonEmptyString(sessionType);
    switch (normalizedType) {
      case 'local':
        return 'Local';
      case 'aily-agent':
        return 'Aily Agent';
      case 'agent':
        return 'Agent';
      default:
        return normalizedType
          ? normalizedType
            .split(/[-_\s]+/)
            .filter(part => part.length > 0)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ')
          : '';
    }
  }

  private describeModeId(modeId: string | null | undefined): string | undefined {
    const normalizedModeId = this.readNonEmptyString(modeId);
    switch (normalizedModeId) {
      case 'ask':
        return 'Ask';
      case 'edit':
        return 'Edit';
      case 'agent':
        return 'Agent';
      case 'plan':
        return 'Plan';
      default:
        return normalizedModeId
          ? normalizedModeId
            .split(/[-_\s:/]+/)
            .filter(part => part.length > 0)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ')
          : undefined;
    }
  }

  private describeProjectPath(projectPath: string | null | undefined): string {
    const normalizedPath = this.readNonEmptyString(projectPath)?.replace(/[\\/]+$/, '') ?? '';
    if (!normalizedPath) {
      return '';
    }

    const segments = normalizedPath.split(/[\\/]+/).filter(segment => segment.length > 0);
    return segments.length > 0 ? segments[segments.length - 1] : normalizedPath;
  }

  private formatRelativeTime(timestamp: number | null | undefined): string {
    if (!Number.isFinite(timestamp) || (timestamp ?? 0) <= 0) {
      return '';
    }

    const diffMs = (timestamp as number) - Date.now();
    const absMs = Math.abs(diffMs);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

    if (absMs < 60_000) {
      return rtf.format(Math.round(diffMs / 1000), 'second');
    }
    if (absMs < 3_600_000) {
      return rtf.format(Math.round(diffMs / 60_000), 'minute');
    }
    if (absMs < 86_400_000) {
      return rtf.format(Math.round(diffMs / 3_600_000), 'hour');
    }
    if (absMs < 604_800_000) {
      return rtf.format(Math.round(diffMs / 86_400_000), 'day');
    }

    return rtf.format(Math.round(diffMs / 604_800_000), 'week');
  }

  private readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }

  private resolveCurrentSelectedMode(): ChatSelectedMode {
    if (this.ctx.chatService.selectedMode) {
      return normalizeChatSelectedMode(this.ctx.chatService.selectedMode);
    }

    if (this.ctx.chatService.currentResolvedMode) {
      return normalizeChatSelectedMode({
        modeId: this.ctx.chatService.currentResolvedMode.kind,
        customAgentTarget: this.ctx.chatService.currentResolvedMode.customAgentTarget,
      });
    }

    return normalizeChatSelectedMode({
      modeId: this.getChatSessionInputState().mode.kind,
    });
  }

  private resolveDefaultManagedTitleCandidate(sessionId: string | null | undefined): ChatSessionTitleCandidate {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    const currentSessionId = typeof this.ctx.chatService.currentSessionId === 'string'
      ? this.ctx.chatService.currentSessionId.trim()
      : '';
    const currentTitle = typeof this.ctx.chatService.currentSessionTitle === 'string'
      ? this.ctx.chatService.currentSessionTitle.trim()
      : '';
    if (!normalizedSessionId
      || normalizedSessionId !== currentSessionId
      || !isMeaningfulManagedSessionTitle(currentTitle, normalizedSessionId)) {
      return normalizeChatSessionTitleCandidate(undefined);
    }

    return normalizeChatSessionTitleCandidate({
      text: currentTitle,
      source: this.readCurrentSessionTitleSource() ?? 'legacy-custom',
      revision: (this.ctx.chatService as { readonly currentSessionTitleRevision?: unknown }).currentSessionTitleRevision,
    });
  }

  private resolveCurrentSessionDurableTitleCandidate(sessionId: string | null | undefined): ChatSessionDisplayTitle | null {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    const currentTitle = typeof this.ctx.chatService.currentSessionTitle === 'string'
      ? this.ctx.chatService.currentSessionTitle.trim()
      : '';
    if (!isMeaningfulManagedSessionTitle(currentTitle, normalizedSessionId)) {
      return null;
    }

    const source = this.readCurrentSessionTitleSource();
    if (source === undefined) {
      return {
        text: currentTitle,
        source: 'legacy-custom',
        durable: true,
      };
    }

    if (source === 'empty') {
      return {
        text: currentTitle,
        source: 'legacy-custom',
        durable: true,
      };
    }

    return isCustomSessionTitleSource(source)
      ? {
        text: currentTitle,
        source,
        durable: true,
      }
      : null;
  }

  private resolveDisplaySessionTitleCandidate(
    sessionId: string,
    durableTitle: string | null | undefined,
    durableTitleSource: ChatSessionTitleSource | null | undefined,
    projectPath: string | null | undefined,
  ): ChatSessionDisplayTitle {
    const normalizedDurableTitle = typeof durableTitle === 'string'
      ? durableTitle.trim()
      : '';
    if (isMeaningfulManagedSessionTitle(normalizedDurableTitle, sessionId)) {
      let normalizedSource = normalizeChatSessionTitleSource(durableTitleSource);
      if (normalizedSource === 'default-first-request') {
        return {
          text: normalizedDurableTitle,
          source: 'default-first-request',
          durable: false,
        };
      }
      if (!isCustomSessionTitleSource(normalizedSource)) {
        const persistedEntry = this.ctx.chatHistoryService.findEntry(sessionId);
        const persistedEntryTitle = typeof persistedEntry?.title === 'string'
          ? persistedEntry.title.trim()
          : '';
        const persistedEntrySource = normalizeChatSessionTitleSource(persistedEntry?.titleSource);
        if (persistedEntryTitle === normalizedDurableTitle && isCustomSessionTitleSource(persistedEntrySource)) {
          normalizedSource = persistedEntrySource;
        }
      }
      return {
        text: normalizedDurableTitle,
        source: isCustomSessionTitleSource(normalizedSource) ? normalizedSource : 'legacy-custom',
        durable: true,
      };
    }

    const liveTurnResponses = this.ctx.readLiveSessionTurnResponses?.(sessionId);
    const liveTitle = deriveDefaultTitleFromTurnResponses(liveTurnResponses);
    if (isMeaningfulManagedSessionTitle(liveTitle, sessionId)) {
      return {
        text: liveTitle,
        source: 'default-first-request',
        durable: false,
      };
    }

    const persistedEntry = this.ctx.chatHistoryService.findEntry(sessionId);
    const persistedDefaultTitle = typeof persistedEntry?.defaultTitle === 'string'
      ? persistedEntry.defaultTitle.trim()
      : '';
    if (isMeaningfulManagedSessionTitle(persistedDefaultTitle, sessionId)) {
      return {
        text: persistedDefaultTitle,
        source: 'default-first-request',
        durable: false,
      };
    }

    const persistedRecord = this.shouldReadPersistedFallbackTitleFromHostRecord(persistedEntry)
      ? this.ctx.chatHistoryService.loadHostRecord(sessionId, projectPath ?? null)
      : null;
    const persistedRecordDefaultTitle = typeof persistedRecord?.metadata?.defaultTitle === 'string'
      ? persistedRecord.metadata.defaultTitle.trim()
      : '';
    const persistedTitle = persistedRecordDefaultTitle || deriveDefaultTitleFromTurnResponses(persistedRecord?.turnResponses);
    if (isMeaningfulManagedSessionTitle(persistedTitle, sessionId)) {
      return {
        text: persistedTitle,
        source: 'default-first-request',
        durable: false,
      };
    }

    return {
      text: '',
      source: 'empty',
      durable: false,
    };
  }

  private shouldReadPersistedFallbackTitleFromHostRecord(
    persistedEntry: SessionIndexEntry | undefined,
  ): boolean {
    if (!persistedEntry) {
      return true;
    }

    if (typeof persistedEntry.defaultTitle === 'string' && persistedEntry.defaultTitle.trim().length > 0) {
      return false;
    }

    return (persistedEntry.messageCount ?? 0) > 0;
  }

  private readCurrentSessionTitleSource(): ChatSessionTitleSource | undefined {
    const rawSource = (this.ctx.chatService as { readonly currentSessionTitleSource?: unknown }).currentSessionTitleSource;
    if (rawSource === undefined || rawSource === null) {
      return undefined;
    }

    return normalizeChatSessionTitleSource(rawSource);
  }

  private resolveCurrentSessionType(): ChatSessionType {
    return normalizeChatSessionType(this.ctx.chatService.currentSessionType, DEFAULT_CHAT_SESSION_TYPE);
  }

  private isSamePath(left: string | null | undefined, right: string | null | undefined): boolean {
    return this.normalizePath(left) === this.normalizePath(right);
  }

  private normalizePath(value: string | null | undefined): string {
    return typeof value === 'string'
      ? value.replace(/\\/g, '/').trim().toLowerCase()
      : '';
  }

  private buildLiveCurrentInputState(providerOptions: HostSessionProviderOptions, scope: 'current' | 'new' = 'current'): ChatSessionInputState {
    const groups = (scope === 'new'
      ? this.ctx.chatService.buildNewSessionProviderOptionGroups?.(undefined, providerOptions)
      : this.ctx.chatService.buildCurrentSessionProviderOptionGroups?.(undefined, providerOptions))
      ?? buildHostSessionProviderOptionGroups(providerOptions);

    if (this.ctx.chatService.currentResolvedMode) {
      return createChatSessionInputStateFromResolvedMode(this.ctx.chatService.currentResolvedMode, { groups });
    }

    if (this.ctx.chatService.selectedMode) {
      return createChatSessionInputState(this.ctx.chatService.selectedMode, { groups });
    }

    return createChatSessionInputState(DEFAULT_CHAT_SELECTED_MODE, { groups });
  }

  private getOrCreateTrackedInputState(
    key: string,
    buildState: () => ChatSessionInputState,
  ): ChatSessionInputState {
    const nextState = buildState();
    const existingState = this.trackedInputStates.get(key);
    if (!existingState) {
      this.trackedInputStates.set(key, nextState);
      return nextState;
    }

    this.replaceInputState(existingState, nextState);
    return existingState;
  }

  private replaceInputState(target: ChatSessionInputState, nextState: ChatSessionInputState): void {
    target.mode = nextState.mode;
    target.groups = nextState.groups ?? [];
  }

  private refreshTrackedInputStates(): void {
    const blankState = this.trackedInputStates.get(BLANK_SESSION_INPUT_STATE_KEY);
    if (blankState) {
      this.replaceInputState(blankState, this.buildLiveCurrentInputState(this.getChatSessionProviderOptions(), 'new'));
    }

    const currentSessionId = this.ctx.chatService.currentSessionId;
    if (!currentSessionId) {
      return;
    }

    const currentState = this.trackedInputStates.get(currentSessionId);
    if (currentState) {
      this.replaceInputState(currentState, this.buildLiveCurrentInputState(this.getChatSessionProviderOptions(currentSessionId)));
    }

    if (this.managedItems.has(currentSessionId)) {
      this.updateManagedItemState(currentSessionId, currentState ?? this.getChatSessionInputState(currentSessionId));
    }
  }

  private handleHostSessionStoreChange(event: HostSessionStoreChangeEvent): void {
    if (!event.sessionId) {
      return;
    }

    if (event.kind === 'deleted') {
      this.deleteCachedListItem(event.sessionId);
      this.trackedInputStates.delete(event.sessionId);
      if (event.sessionId !== this.ctx.chatService.currentSessionId) {
        this.managedItems.delete(event.sessionId);
      }
      return;
    }

    this.bumpSessionListItemVersion(event.sessionId);

    if (!this.trackedInputStates.has(event.sessionId) || event.sessionId === this.ctx.chatService.currentSessionId) {
      return;
    }

    const entry = this.ctx.chatHistoryService.findEntry(event.sessionId);
    const projectPathHint = entry?.projectPath ?? null;
    const nextState = this.buildPersistedInputState(this.resolvePersistedSessionContent(event.sessionId, projectPathHint, entry));
    const trackedState = this.trackedInputStates.get(event.sessionId);
    if (trackedState) {
      this.replaceInputState(trackedState, nextState);
    }
  }

  private updateManagedItemState(sessionId: string, inputState: ChatSessionInputState): void {
    const managedItem = this.managedItems.get(sessionId);
    if (!managedItem) {
      return;
    }

    const selectedMode = this.resolveCurrentSelectedMode();
    const currentTitleCandidate = this.resolveDefaultManagedTitleCandidate(sessionId);
    const nextTitle = currentTitleCandidate.text || managedItem.title;
    const nextTitleSource = currentTitleCandidate.text ? currentTitleCandidate.source : managedItem.titleSource;
    const nextTitleRevision = currentTitleCandidate.text ? currentTitleCandidate.revision : managedItem.titleRevision;
    this.managedItems.set(sessionId, {
      ...managedItem,
      title: nextTitle,
      titleSource: nextTitleSource,
      titleRevision: nextTitleRevision,
      projectPath: this.ctx.chatService.currentSessionPath || (managedItem.projectPath ?? null),
      sessionType: this.resolveCurrentSessionType(),
      agentRuntimeMode: this.ctx.chatService.currentAgentRuntimeMode ?? managedItem.agentRuntimeMode,
      agentRuntimeModeSource: this.ctx.chatService.currentAgentRuntimeModeSource ?? managedItem.agentRuntimeModeSource,
      inputState,
      mode: selectedMode.modeId,
      requestRouting: buildHostSessionCurrentPickerRoutingSummary(
        selectedMode,
        undefined,
        this.ctx.chatService.currentSessionPermissionLevel,
        this.ctx.chatService.currentSessionApprovalsReviewer,
        this.ctx.chatService.currentSessionApprovalPolicy,
      ),
      updatedAt: Date.now(),
    });
  }

  private refreshCurrentManagedItemMetadata(): void {
    const currentSessionId = this.ctx.chatService.currentSessionId;
    if (!currentSessionId || !this.managedItems.has(currentSessionId)) {
      return;
    }

    const currentState = this.trackedInputStates.get(currentSessionId)
      ?? this.getChatSessionInputState(currentSessionId, this.ctx.chatService.currentSessionPath ?? null);
    this.updateManagedItemState(currentSessionId, currentState);
  }

  private bumpSessionListItemVersion(sessionId?: string | null): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      this.globalListItemVersion += 1;
      return;
    }

    this.sessionListItemVersions.set(
      normalizedSessionId,
      (this.sessionListItemVersions.get(normalizedSessionId) ?? 0) + 1,
    );
  }

  private deleteCachedListItem(sessionId?: string | null): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return;
    }

    this.cachedSummaryItems.delete(normalizedSessionId);
    this.cachedListItems.delete(normalizedSessionId);
    this.sessionListItemVersions.delete(normalizedSessionId);
  }

  private notifyItemsChanged(sessionId?: string | null): void {
    this.bumpSessionListItemVersion(sessionId);
    this.itemsChangedSubject.next({
      sessionId: typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null,
    });
  }
}

function deriveDefaultTitleFromTurnResponses(turnResponses: readonly HostSessionTurnResponse[] | null | undefined): string {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return '';
  }

  for (const turnResponse of turnResponses) {
    const request = (turnResponse as { request?: unknown })?.request;
    const requestTitle = deriveDefaultTitleFromRequest(request);
    if (requestTitle) {
      return requestTitle;
    }
  }

  return '';
}

function deriveDefaultTitleFromRequest(request: unknown): string {
  const directText = readRequestTextCandidate(request);
  if (directText) {
    return directText;
  }

  if (request && typeof request === 'object') {
    const message = (request as { message?: unknown }).message;
    const nestedMessageText = readRequestTextCandidate(message);
    if (nestedMessageText) {
      return nestedMessageText;
    }
  }

  return '';
}

function readRequestTextCandidate(candidate: unknown): string {
  const text = typeof candidate === 'string'
    ? candidate
    : candidate && typeof candidate === 'object'
      ? ((candidate as { messageText?: unknown }).messageText
        ?? (candidate as { prompt?: unknown }).prompt
        ?? (candidate as { text?: unknown }).text
        ?? (candidate as { content?: unknown }).content)
      : undefined;
  if (typeof text !== 'string') {
    return '';
  }

  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  return normalized.split('\n')[0]?.trim().substring(0, 200) ?? '';
}

function isMeaningfulManagedSessionTitle(title: unknown, sessionId?: string): boolean {
  if (typeof title !== 'string') {
    return false;
  }

  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    return false;
  }

  if (isPlaceholderManagedSessionTitle(normalizedTitle)) {
    return false;
  }

  return !isTechnicalManagedSessionTitle(normalizedTitle, sessionId);
}

function isTechnicalManagedSessionTitle(title: string, sessionId?: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (normalizedSessionId && normalizedTitle === normalizedSessionId) {
    return true;
  }

  return /^lex-\d{6,}$/i.test(normalizedTitle);
}

function isPlaceholderManagedSessionTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle) {
    return true;
  }

  if (/^untitled(?:\s+chat)?(?:\s*\d+)?$/i.test(normalizedTitle)) {
    return true;
  }

  return normalizedTitle === 'new chat'
    || normalizedTitle === 'new session'
    || normalizedTitle === '新对话'
    || normalizedTitle === '新会话';
}
