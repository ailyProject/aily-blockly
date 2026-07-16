/**
 * ChatHistoryService - Copilot 风格的聊天历史管理服务
 *
 * 采用「全局索引 + 项目级索引 + 分项目/全局兜底数据」三轨架构：
 * - 全局索引：~/.aily/chat_history_index.json（用户级，永远可用，包含所有条目）
 * - 项目索引：{projectPath}/.chat_history/chat_history_index.json（项目级，仅该项目的条目）
 *   · 项目索引优先：加载时项目级条目覆盖全局同 ID 条目
 *   · 项目索引条目不含冗余的 projectPath / projectName（已隐含于存储路径）
 * - 聊天数据：有项目 → {projectPath}/.chat_history/{sessionId}.jsonl
 *             无项目 → ~/.aily/chat_history/{sessionId}.jsonl
 *
 * 持久化策略：关键节点立即保存 + 30s 定时兜底
 * - 每轮对话结束（SSE complete）立即保存
 * - 标题生成完成时更新索引
 * - newChat / 切换会话时保存
 * - 30s 定时检查 dirty 标记
 *
 * 数据范围：UI 列表 + 元数据
 * - 标准会话快照由 lex SessionStorage 持有
 * - 本地数据文件主要承担历史列表、标题和项目归属职责
 * - 新保存路径只保存 metadata + canonical turnResponses，不再保留旧 snapshot 镜像字段
 *
 * 索引写入策略（双写）：
 * - 每次 writeIndex() 同时写全局索引和项目级索引
 * - 项目切换时调用 reloadProjectIndex() 合并新项目的本地索引
 *
 * @see Copilot 使用全局 globalStorageUri 不分项目，我们在此基础上加了 projectPath 标记
 */

import { Injectable, OnDestroy, Optional } from '@angular/core';
import { Subject } from 'rxjs';
import type { SessionSnapshot, TurnResponseCommand, TurnResponseFollowup, TurnResponseTurn } from 'aily-lex/browser';
import { AilyHost } from '../core/host';
import type { ChatAgentRuntimeMode, ChatAgentRuntimeModeSource } from '../core/chat-agent-runtime-mode';
import {
  chatSessionScopeProjectPath,
  isSameChatSessionScopePath,
  normalizeChatSessionScopePath,
  type ChatSessionScope,
} from '../core/chat-session-scope';
import { SkillRegistry as BlocklySkillRegistry } from '../core/skill-registry';
import { EditCheckpointService, type RequestCheckpointMetadata } from './edit-checkpoint.service';
import { ChatHistoryIndexStore, type ChatHistoryIndexLoadDiagnostics } from './chat-history-index-store';
import { buildHostSessionDebugEvents, createHostSessionDebugEventId, type HostSessionDebugEvent } from './host-session-debug-events';
import {
  decodeHostSessionDebugExport,
  encodeHostSessionDebugExport,
  type HostSessionDevelopmentModePreferenceSummary,
  type HostSessionDebugDualPersistenceSummary,
  type HostSessionDebugExportAugmentation,
  type HostSessionDebugExportEnvelope,
  type HostSessionDebugLiveRuntimeOverlaySummary,
  type HostSessionRestoreFailureSummary,
  type HostSessionRestoreDiagnosticsSummary,
} from './host-session-debug-export';
import { resolveHostSessionRuntimeAuxiliary } from '../helpers/host-session-runtime-auxiliary';
import { HostSessionAdoptionBridge } from './host-session-adoption-bridge';
import { HostSessionPersistenceBridge, type HostSessionDirtyOptions, type HostSessionDirtyPolicy, type HostSessionFlushOptions } from './host-session-persistence-bridge';
import { HostSessionRecordStore } from './host-session-record-store';
import { ChatService } from './chat.service';
import { ChatSessionEntryStateService } from './chat-session-entry-state.service';
import { ChatSessionStateService } from './chat-session-state.service';
import { ChatSessionRuntimeStoreService } from './chat-session-runtime-store.service';
import {
  normalizePersistedChatSessionTitleSource,
  type PersistedChatSessionTitleSource,
} from '../core/chat-session-title';
import {
  DEFAULT_CHAT_SESSION_TYPE,
  normalizeChatSessionType,
  normalizeChatSurfaceModeId,
  type ChatModeId,
  type ChatSessionInputState,
  type ChatSessionModeDescriptor,
  type ChatSessionType,
  type ChatSurfaceModeId,
  type ChatSelectedMode,
} from '../core/chat-mode';
import type { PlanPart } from '../core/chat-parts';
import {
  normalizeHostSessionRequestRoutingSummary,
  type HostSessionRequestRoutingSummary,
} from '../helpers/host-session-request-routing';
import {
  normalizeHostSessionInteractionActionSummary,
  type HostSessionInteractionActionSummary,
} from '../helpers/host-session-interaction-action';
import type { HostSessionTurnRuntimeTruth } from '../helpers/host-session-runtime-truth';
import type { PendingFollowupRequest } from '../helpers/chat-pending-request';
import {
  type HostSessionSelectedModeResolveOptions,
  normalizeHostSessionInputStateFromMetadata,
  resolveHostSessionModeDescriptorFromMetadata,
  resolveHostSessionSummaryModeFromMetadata,
  resolveHostSessionSelectedModeFromMetadata,
} from '../helpers/host-session-input-state';
import { ConfigService } from '../../../services/config.service';
import type { SessionLifecycleRestoreErrorDetails } from '../helpers/session-lifecycle.helper';

// ===== 类型定义 =====

/** 全局索引中的会话条目 */
export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  titleSource?: PersistedChatSessionTitleSource;
  defaultTitle?: string;
  sessionType?: ChatSessionType;
  /** 创建此会话时的项目路径，null 表示无项目 */
  projectPath: string | null;
  sessionScopeSchemaVersion?: number;
  /** 项目显示名称，null 表示无项目 */
  projectName: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  mode: ChatSurfaceModeId;
  agentRuntimeMode?: ChatAgentRuntimeMode;
  runtimeMode?: ChatAgentRuntimeMode;
  agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  runtimeModeSource?: ChatAgentRuntimeModeSource;
  modeDescriptor?: ChatSessionModeDescriptor;
  inputState?: ChatSessionInputState;
  requestRouting?: HostSessionRequestRoutingSummary;
  interactionActionSummary?: HostSessionInteractionActionSummary;
  model: string | null;
  /** 数据文件是否可用（项目路径被删除/移动时标记为 false） */
  dataAvailable?: boolean;
}

export interface PersistedHostResponseData {
  /**
   * VS Code `ChatResponseModel.toJSON()` 风格的 response-level persisted fields.
   * 这些字段只出现在宿主持久化记录中，不属于 aily-lex canonical response runtime shape。
   */
  slashCommand?: TurnResponseCommand;
  responseId?: string;
  responseMarkdownInfo?: ReadonlyArray<{ readonly suggestionId: string }>;
  followups?: readonly TurnResponseFollowup[];
  modelState?:
    | { value: 0 }
    | { value: 4 }
    | { value: 1 | 2 | 3; completedAt: number };
  vote?: 0 | 1;
  timestamp?: number;
  elapsedMs?: number;
  timeSpentWaiting?: number;
  completionTokens?: number;
}

export type PersistedHostTurnResponse = Omit<TurnResponseTurn, 'response'> & {
  /** Per-turn request mode truth. This must not be inferred from the current session picker. */
  modeId?: ChatModeId;
  /** Per-turn selected mode snapshot used by restore/history/debug surfaces. */
  modeSelection?: ChatSelectedMode;
  /** Per-turn request routing snapshot. New records should prefer this over session metadata fallbacks. */
  requestRouting?: HostSessionRequestRoutingSummary;
  /** Durable plan artifact extracted from response parts for Plan mode restore/debug. */
  planPart?: PlanPart;
  /** Latest handoff / restored interaction action associated with this turn. */
  handoffAction?: HostSessionInteractionActionSummary;
  /** Per-turn runtime/profile truth captured at submit time. */
  runtimeTruth?: HostSessionTurnRuntimeTruth;
  response: TurnResponseTurn['response'] & PersistedHostResponseData;
};

export interface HostSessionResponseSidecar {
  compatMessages?: unknown[];
}

export interface HostSessionCheckpointTimelineSidecar {
  sessionResource: string;
  currentCheckpointIndex: number;
  currentTurnResponseCount?: number;
  checkpoints?: HostSessionCheckpointTimelineEntrySidecar[];
  turnResponses: PersistedHostTurnResponse[];
}

export interface HostSessionCheckpointTimelineEntrySidecar {
  checkpointId: string;
  requestId: string;
  turnId?: string;
  turnIndex: number;
  metadata?: RequestCheckpointMetadata;
}

export interface HostSessionCheckpointMarkerSidecar {
  sessionResource: string;
  currentCheckpointIndex: number;
  currentTurnResponseCount?: number;
}

export interface HostSessionSidecar {
  response?: HostSessionResponseSidecar;
  checkpointMarker?: HostSessionCheckpointMarkerSidecar;
  checkpointRedoBranch?: HostSessionCheckpointTimelineSidecar;
  /** @deprecated New records must use checkpointMarker/checkpointRedoBranch. */
  checkpointTimeline?: HostSessionCheckpointTimelineSidecar;
}

export interface HostSessionSkillInvocationTraceFile {
  readonly path: string;
  readonly uri: string;
  readonly category?: string;
}

export interface HostSessionSkillInvocationTraceEntry {
  readonly toolCallId: string;
  readonly name: string;
  readonly skillUri: string;
  readonly mode: 'inline' | 'fork';
  readonly scope: 'request' | 'session';
  readonly relatedFiles: readonly HostSessionSkillInvocationTraceFile[];
}

export interface HostSessionRuntimeAuxiliary {
  requestContext?: NonNullable<SessionSnapshot['requestContext']>;
  activeSkillNames?: readonly string[];
  skillInvocationTrace?: readonly HostSessionSkillInvocationTraceEntry[];
  pendingFollowupRequests?: readonly PendingFollowupRequest[];
  yieldRequested?: boolean;
}

/** 单个会话的宿主持久化记录 */
export interface HostSessionRecord {
  /** Copilot 风格的 turn/request/response 容器。 */
  turnResponses?: PersistedHostTurnResponse[];
  /** response-model sidecars that should not live inside response content turns. */
  sidecar?: HostSessionSidecar;
  /** Runtime-only host mirrors that should not live in the primary session metadata contract. */
  auxiliary?: HostSessionRuntimeAuxiliary;
  /** 会话元数据 */
  metadata: SessionMetadata;
}

export interface ChatListItem {
  role: string;
  content: string;
  state: 'doing' | 'done';
  source?: string;
  /** 该消息对应的模型名称（创建时快照） */
  modelName?: string;
  /** 该消息对应的计费倍率（创建时快照） */
  modelBillingLabel?: string;
  /** 关联的 lex turn ID，用于恢复时按 turn 粒度分消息 */
  turnId?: string;
}

export interface SessionMetadata {
  sessionId: string;
  title: string;
  titleSource?: PersistedChatSessionTitleSource;
  defaultTitle?: string;
  sessionType?: ChatSessionType;
  projectPath: string | null;
  sessionScopeSchemaVersion?: number;
  createdAt: number;
  updatedAt: number;
  mode: ChatSurfaceModeId;
  agentRuntimeMode?: ChatAgentRuntimeMode;
  runtimeMode?: ChatAgentRuntimeMode;
  agentRuntimeModeSource?: ChatAgentRuntimeModeSource;
  runtimeModeSource?: ChatAgentRuntimeModeSource;
  modeDescriptor?: ChatSessionModeDescriptor;
  inputState?: ChatSessionInputState;
  requestRouting?: HostSessionRequestRoutingSummary;
  interactionActionSummary?: HostSessionInteractionActionSummary;
  model: string | null;
  /** 上下文预算快照 */
  contextBudget?: {
    currentTokens: number;
    maxContextTokens: number;
    usagePercent: number;
    systemTokens?: number;
    baseSystemTokens?: number;
    instructionTokens?: number;
    skillTokens?: number;
    toolsTokens?: number;
    toolSourceTokens?: Record<string, number>;
    messagesTokens?: number;
    toolResultsTokens?: number;
    messageCount?: number;
  };
  requestContext?: NonNullable<SessionSnapshot['requestContext']>;
  activeSkillNames?: readonly string[];
  /**
   * Fork capability used to create this session.
   * `protocol` requires a real backend/runtime fork provider; Blockly transcript copies must stay `transcript`.
   */
  forkKind?: 'protocol' | 'transcript';
  forkedFromSessionId?: string;
  forkedBeforeTurnId?: string;
  forkedRetainedTurnCount?: number;
  /** 工具调用迭代次数 */
  toolCallingIteration: number;
}

/** 项目级索引条目（不含冗余的 projectPath/projectName，存储在项目目录时使用） */
export type ProjectIndexEntry = Omit<SessionIndexEntry, 'projectPath' | 'projectName'>;

/** 历史列表的筛选模式 */
export type HistoryFilterMode = 'all' | 'current-project';

/** 当前活跃会话的宿主侧持久化快照。 */
export interface LiveHostSessionRecord {
  sessionId: string;
  turnResponses?: PersistedHostTurnResponse[];
  sidecar?: HostSessionSidecar;
  auxiliary?: HostSessionRuntimeAuxiliary;
  metadata: Partial<SessionMetadata> & { sessionId: string };
}

export interface ImportedDebugSessionRecord {
  sessionId: string;
  sourceSessionId: string;
  title: string;
  importedAt: number;
  hostRecord: HostSessionRecord;
  debugEvents: readonly HostSessionDebugEvent[];
  debugCompanionFiles?: Readonly<Record<string, string>>;
  debugDualPersistence?: HostSessionDebugDualPersistenceSummary;
  debugLiveRuntimeOverlay?: HostSessionDebugLiveRuntimeOverlaySummary;
  debugRestoreDiagnostics?: HostSessionRestoreDiagnosticsSummary;
  debugRestoreFailure?: HostSessionRestoreFailureSummary;
}

export interface SessionTitleUpdateOptions {
  readonly source?: PersistedChatSessionTitleSource;
}

export interface HostSessionStoreChangeEvent {
  readonly sessionId: string;
  readonly scope: 'persisted' | 'imported';
  readonly kind: 'updated' | 'deleted';
}

function resolveDurablePersistedTitleCandidate(
  title: unknown,
  source: unknown,
  defaultTitle?: unknown,
): { title: string; source?: PersistedChatSessionTitleSource } | null {
  const normalizedTitle = typeof title === 'string' ? title.trim() : '';
  if (!normalizedTitle) {
    return null;
  }

  const normalizedSource = normalizePersistedChatSessionTitleSource(source);
  if (normalizedSource) {
    return {
      title: normalizedTitle,
      source: normalizedSource,
    };
  }

  const normalizedDefaultTitle = typeof defaultTitle === 'string' ? defaultTitle.trim() : '';
  return !normalizedDefaultTitle || normalizedTitle !== normalizedDefaultTitle
    ? { title: normalizedTitle }
    : null;
}

export function countHostRecordMessages(record: Pick<HostSessionRecord, 'turnResponses'>): number {
  if (!record.turnResponses?.length) {
    return 0;
  }

  return record.turnResponses.length * 2;
}

type LiveSessionProvider = (sessionId: string) => LiveHostSessionRecord | null;

@Injectable({
  providedIn: 'root'
})
export class ChatHistoryService implements OnDestroy {

  // ===== 状态 =====
  /** 全局会话索引（内存） */
  private index: SessionIndexEntry[] = [];
  /** 索引是否已从磁盘加载 */
  private indexLoaded = false;
  /** 脏标记：索引有未保存的变更 */
  private indexDirty = false;
  /** 索引版本号（每次索引语义变更 +1） */
  private indexRevision = 0;
  /** getHistoryList 缓存对应的索引版本号 */
  private historyListCacheRevision = -1;
  /** 按 filter/project 维度缓存已排序历史快照 */
  private readonly historyListCache = new Map<string, SessionIndexEntry[]>();
  /** 定时兜底保存的 timer ID */
  private autoSaveTimer: any = null;
  private saveStateFlushTimer: any = null;
  private saveStateFlushAllowsActiveRecoverySnapshot = false;
  private readonly pendingRecoverySnapshotSessionIds = new Set<string>();

  // ===== 路径常量 =====
  private readonly INDEX_FILE = 'chat_history_index.json';
  private readonly CHAT_DATA_DIR = 'chat_history';
  private readonly PROJECT_CHAT_DIR = '.chat_history';
  private readonly indexStore: ChatHistoryIndexStore;
  private readonly hostRecordStore: HostSessionRecordStore;
  private readonly hostSessionPersistenceBridge: HostSessionPersistenceBridge;
  private readonly hostSessionAdoptionBridge: HostSessionAdoptionBridge;
  private autoSaveSessionActiveProvider: ((sessionId: string) => boolean) | null = null;
  private readonly importedDebugSessions = new Map<string, ImportedDebugSessionRecord>();
  private readonly latestRestoreFailures = new Map<string, HostSessionRestoreFailureSummary>();
  private readonly latestRestoreFailureImportedSessions = new Map<string, string>();
  private latestIndexLoadDiagnostics: ChatHistoryIndexLoadDiagnostics & {
    readonly normalizedEntryCount: number;
    readonly rootPathToNullCount: number;
  } = {
    normalizedEntryCount: 0,
    rootPathToNullCount: 0,
    projectIndexPatchedProjectPathCount: 0,
    rebuiltProjectEntryCount: 0,
  };
  private readonly hostSessionChangedSubject = new Subject<HostSessionStoreChangeEvent>();
  readonly hostSessionChanged$ = this.hostSessionChangedSubject.asObservable();

  constructor(
    @Optional() private readonly chatService?: ChatService,
    @Optional() private readonly chatSessionEntryStateService?: ChatSessionEntryStateService,
    @Optional() private readonly chatSessionStateService?: ChatSessionStateService,
    @Optional() private readonly chatSessionRuntimeStore?: ChatSessionRuntimeStoreService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.hostRecordStore = new HostSessionRecordStore({
      projectChatDir: this.PROJECT_CHAT_DIR,
      getGlobalChatDataDir: () => this.getGlobalChatDataDir(),
      getGlobalProjectRootPath: () => this.getGlobalProjectRootPath(),
      joinPath: (...parts) => this.joinPath(...parts),
      isSamePath: (a, b) => this.isSamePath(a ?? null, b ?? null),
      resolveModeById: (modeId) => this.resolveStoredModeById(modeId),
      resolveModeByName: (modeName) => this.resolveStoredModeByName(modeName),
    });
    this.indexStore = new ChatHistoryIndexStore({
      indexFile: this.INDEX_FILE,
      projectChatDir: this.PROJECT_CHAT_DIR,
      getGlobalAilyDir: () => this.getGlobalAilyDir(),
      getCurrentProjectPath: () => this.getCurrentProjectPath(),
      joinPath: (...parts) => this.joinPath(...parts),
      extractProjectName: (projectPath) => this.extractProjectName(projectPath),
      isSamePath: (a, b) => this.isSamePath(a ?? null, b ?? null),
      readHostRecord: (sessionId, projectPath) => this.hostRecordStore.read(sessionId, projectPath),
      resolveModeById: (modeId) => this.resolveStoredModeById(modeId),
      resolveModeByName: (modeName) => this.resolveStoredModeByName(modeName),
    });
    this.hostSessionPersistenceBridge = new HostSessionPersistenceBridge(this.hostRecordStore, {
      ensureIndexLoaded: () => this.ensureIndexLoaded(),
      findIndexEntry: (sessionId) => this.index.find(e => e.sessionId === sessionId),
      upsertIndexEntry: (sessionId, metadata, messageCount, updateTimestamp, options) =>
        this.upsertIndexEntry(sessionId, metadata, messageCount, updateTimestamp, options),
      writeIndex: () => this.writeIndex(),
      writeIndexAsync: () => this.writeIndexAsync(),
      markIndexDirty: () => { this.indexDirty = true; },
      hasDirtyIndex: () => this.indexDirty,
      isSamePath: (a, b) => this.isSamePath(a ?? null, b ?? null),
    });
    this.hostSessionAdoptionBridge = new HostSessionAdoptionBridge(this.hostRecordStore, {
      projectChatDir: this.PROJECT_CHAT_DIR,
      joinPath: (...parts) => this.joinPath(...parts),
      extractProjectName: (projectPath) => this.extractProjectName(projectPath),
      isSamePath: (a, b) => this.isSamePath(a ?? null, b ?? null),
      deleteSessionFile: (sessionId, projectPath) => this.deleteSessionFile(sessionId, projectPath),
      deleteSessionFileOrThrow: (sessionId, projectPath) => this.deleteSessionFileOrThrow(sessionId, projectPath),
    });
    this.startAutoSave();
  }

  ngOnDestroy(): void {
    // 强制保存所有脏数据
    this.flushAll();
    this.stopAutoSave();
  }

  // =========================================================================
  // 公共 API - 索引管理
  // =========================================================================

  /**
   * 获取历史列表（按 updatedAt 降序）
   * @param filter 筛选模式
   * @param projectPath 当前项目路径（filter='current-project' 时使用）
   * @param projectRootPath 项目根目录路径（可选），用于同时包含根目录下创建的孤儿会话
   */
  getHistoryList(filter: HistoryFilterMode = 'all', projectPath?: string | null, projectRootPath?: string | null): SessionIndexEntry[] {
    this.ensureIndexLoaded();
    this.ensureHistoryListCacheRevision();

    const cacheKey = this.buildHistoryListCacheKey(filter, projectPath, projectRootPath);
    const cached = this.historyListCache.get(cacheKey);
    if (cached) {
      return [...cached];
    }

    let result = this.index.filter(entry => this.isListableHistoryEntry(entry));

    if (filter === 'current-project') {
      const normalizedProjectPath = normalizeChatSessionScopePath(projectPath);
      const normalizedProjectRootPath = normalizeChatSessionScopePath(projectRootPath);
      const isGlobalScope = !normalizedProjectPath
        || isSameChatSessionScopePath(normalizedProjectPath, normalizedProjectRootPath);
      result = isGlobalScope
        ? result.filter(e => e.projectPath === null)
        : result.filter(e => this.isSamePath(e.projectPath, normalizedProjectPath));
    }

    // 按 updatedAt 降序
    result.sort((a, b) => b.updatedAt - a.updatedAt);
    this.historyListCache.set(cacheKey, result);
    return [...result];
  }

  private isListableHistoryEntry(entry: SessionIndexEntry): boolean {
    if ((entry.messageCount ?? 0) > 0) {
      return true;
    }

    const title = (entry.title || entry.defaultTitle || '').trim().toLowerCase();
    return Boolean(title
      && title !== '新会话'
      && title !== '新对话'
      && title !== 'new session'
      && title !== 'new chat');
  }

  getHistoryListForScope(scope: ChatSessionScope): SessionIndexEntry[] {
    return this.getHistoryList('current-project', chatSessionScopeProjectPath(scope), scope.projectRootPath);
  }

  /**
   * 查找/确认索引条目是否存在
   */
  findEntry(sessionId: string): SessionIndexEntry | undefined {
    this.ensureIndexLoaded();
    return this.index.find(e => e.sessionId === sessionId);
  }

  /**
   * 绑定当前活跃会话的 live provider。
   *
   * ChatHistoryService 不再假设自己的 cache 持有最新会话内容；
   * dirty 兜底保存时通过宿主回调拉取当前 UI/元数据。
   */
  setLiveSessionProvider(provider: LiveSessionProvider | null): void {
    this.hostSessionPersistenceBridge.setLiveSessionProvider(provider);
  }

  setAutoSaveSessionActiveProvider(provider: ((sessionId: string) => boolean) | null): void {
    this.autoSaveSessionActiveProvider = provider;
  }

  // =========================================================================
  // 公共 API - 保存
  // =========================================================================

  /**
   * 保存宿主持久化记录（完整保存：索引 + 数据文件）
   * 在每轮对话结束、newChat、组件销毁时调用。
   * 标准 snapshot 仍由 lex SessionStorage 持有。
   */
  saveHostRecord(record: LiveHostSessionRecord): void {
    this.hostSessionPersistenceBridge.saveHostRecord(record);
    if (record.sessionId) {
      this.emitHostSessionChanged({ sessionId: record.sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  async saveHostRecordAsync(
    record: LiveHostSessionRecord,
    options?: { readonly allowEmptyTranscript?: boolean },
  ): Promise<void> {
    await this.hostSessionPersistenceBridge.saveHostRecordAsync(record, options);
    if (record.sessionId) {
      this.emitHostSessionChanged({ sessionId: record.sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  /**
   * 仅保存宿主会话元数据/索引，不重写完整 transcript 数据文件。
   * 对齐 VS Code `storeSessionsMetadataOnly(...)`：用于标题、模式、草稿/输入状态等
   * 可发现性更新，避免把 metadata cadence 接回完整历史写入。
   */
  saveHostRecordMetadataOnly(record: LiveHostSessionRecord): void {
    this.hostSessionPersistenceBridge.saveHostRecordMetadataOnly(record);
    if (record.sessionId) {
      this.emitHostSessionChanged({ sessionId: record.sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  async saveHostRecordMetadataOnlyAsync(record: LiveHostSessionRecord): Promise<void> {
    await this.hostSessionPersistenceBridge.saveHostRecordMetadataOnlyAsync(record);
    if (record.sessionId) {
      this.emitHostSessionChanged({ sessionId: record.sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  /**
   * 仅更新索引中的标题（标题生成完成时调用，低 IO）
   */
  updateTitle(sessionId: string, title: string, options?: SessionTitleUpdateOptions): void {
    this.hostSessionPersistenceBridge.updateTitle(sessionId, title, options);
    if (sessionId) {
      this.emitHostSessionChanged({ sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  /**
   * 标记会话数据有变更（用于 dirty 跟踪，30s 兜底保存时使用）
   */
  markDirty(sessionId: string, options?: HostSessionDirtyOptions): void {
    const policy = options?.policy ?? 'recovery-snapshot';
    this.hostSessionPersistenceBridge.markDirty(sessionId, options);
    if (policy === 'authoritative') {
      this.scheduleSaveStateFlush();
    }
  }

  async updateTitleAsync(sessionId: string, title: string, options?: SessionTitleUpdateOptions): Promise<void> {
    await this.hostSessionPersistenceBridge.updateTitleAsync(sessionId, title, options);
    if (sessionId) {
      this.emitHostSessionChanged({ sessionId, scope: 'persisted', kind: 'updated' });
    }
  }

  // =========================================================================
  // 公共 API - 加载
  // =========================================================================

  /**
  * 加载宿主持久化记录
   * 查找顺序：内存缓存 → 磁盘文件
   * @param sessionId 会话ID
   * @param projectPathHint 可选的项目路径提示（当索引中找不到时，用于搜索旧格式文件）
  * @returns HostSessionRecord 或 null（文件不存在/损坏）
   */
  loadHostRecord(sessionId: string, projectPathHint?: string | null): HostSessionRecord | null {
    const imported = this.importedDebugSessions.get(sessionId);
    if (imported) {
      return imported.hostRecord;
    }

    return this.hostSessionPersistenceBridge.loadHostRecord(sessionId, projectPathHint);
  }

  exportDebugSnapshot(sessionId: string, projectPathHint?: string | null): Uint8Array | null {
    this.ensureIndexLoaded();

    const entry = this.index.find(item => item.sessionId === sessionId);
    const resolvedProjectPath = projectPathHint ?? entry?.projectPath ?? null;
    const record = this.hostSessionPersistenceBridge.loadHostRecord(sessionId, resolvedProjectPath);
    if (!record) {
      return null;
    }

    return encodeHostSessionDebugExport(
      record,
      entry,
      undefined,
      this.getModeResolveOptions(),
      this.buildDebugExportAugmentation(record, resolvedProjectPath),
    );
  }

  decodeDebugSnapshot(data: Uint8Array): HostSessionDebugExportEnvelope | null {
    return decodeHostSessionDebugExport(data);
  }

  captureRestoreFailureDebugSnapshot(
    details: SessionLifecycleRestoreErrorDetails,
    errorMessage?: string,
  ): ImportedDebugSessionRecord | null {
    this.ensureIndexLoaded();

    const sessionId = details.diagnostics.sessionId;
    const entry = this.index.find(item => item.sessionId === sessionId);
    const resolvedProjectPath = details.diagnostics.projectPath ?? entry?.projectPath ?? null;
    const summary = this.buildRestoreFailureSummary(details, errorMessage);
    this.latestRestoreFailures.set(sessionId, summary);

    const record = this.loadHostRecord(sessionId, resolvedProjectPath);
    if (!record) {
      return null;
    }

    const previousImportedSessionId = this.latestRestoreFailureImportedSessions.get(sessionId);
    if (previousImportedSessionId) {
      this.clearImportedDebugSnapshot(previousImportedSessionId);
    }

    const encoded = encodeHostSessionDebugExport(
      record,
      entry,
      undefined,
      this.getModeResolveOptions(),
      this.buildDebugExportAugmentation(record, resolvedProjectPath),
    );
    const imported = this.importDebugSnapshot(encoded);
    if (imported) {
      this.latestRestoreFailureImportedSessions.set(sessionId, imported.sessionId);
    }
    return imported;
  }

  clearRecordedRestoreFailure(sessionId: string): void {
    if (!sessionId) {
      return;
    }

    this.latestRestoreFailures.delete(sessionId);
    const importedSessionId = this.latestRestoreFailureImportedSessions.get(sessionId);
    if (importedSessionId) {
      this.clearImportedDebugSnapshot(importedSessionId);
      return;
    }

    this.latestRestoreFailureImportedSessions.delete(sessionId);
  }

  importDebugSnapshot(data: Uint8Array): ImportedDebugSessionRecord | null {
    const decoded = this.decodeDebugSnapshot(data);
    if (!decoded) {
      return null;
    }

    const importedAt = Date.now();
    const sourceSessionId = decoded.session.sessionId || decoded.hostRecord.metadata.sessionId;
    const sessionId = `import:${sourceSessionId}:${importedAt}`;
    const title = resolveImportedDebugSnapshotTitle(decoded);
    const metadata = this.hostRecordStore.createFullMetadata({
      ...decoded.hostRecord.metadata,
      sessionId,
      title,
      projectPath: null,
      updatedAt: importedAt,
    });
    const hostRecord = this.hostRecordStore.createRecord(
      metadata,
      decoded.hostRecord.turnResponses,
      decoded.hostRecord.sidecar,
      decoded.hostRecord.auxiliary,
    );
    const importedRecord: ImportedDebugSessionRecord = {
      sessionId,
      sourceSessionId,
      title,
      importedAt,
      hostRecord,
      debugEvents: this.retargetImportedDebugEvents(
        Array.isArray(decoded.debug?.events) && decoded.debug.events.length > 0
          ? decoded.debug.events
          : buildHostSessionDebugEvents(hostRecord),
        sessionId,
      ),
      ...(decoded.debug?.companionFiles ? { debugCompanionFiles: { ...decoded.debug.companionFiles } } : {}),
      ...(decoded.debug?.dualPersistence ? { debugDualPersistence: { ...decoded.debug.dualPersistence } } : {}),
      ...(decoded.debug?.liveRuntimeOverlay ? { debugLiveRuntimeOverlay: { ...decoded.debug.liveRuntimeOverlay } } : {}),
      ...(decoded.debug?.restoreDiagnostics ? { debugRestoreDiagnostics: { ...decoded.debug.restoreDiagnostics } } : {}),
      ...(decoded.debug?.restoreFailure ? { debugRestoreFailure: { ...decoded.debug.restoreFailure } } : {}),
    };

    this.importedDebugSessions.set(sessionId, importedRecord);
    this.emitHostSessionChanged({ sessionId, scope: 'imported', kind: 'updated' });
    return importedRecord;
  }

  getImportedDebugSnapshot(sessionId: string): ImportedDebugSessionRecord | null {
    return this.importedDebugSessions.get(sessionId) ?? null;
  }

  clearImportedDebugSnapshot(sessionId: string): void {
    if (!this.importedDebugSessions.delete(sessionId)) {
      return;
    }

    for (const [sourceSessionId, importedSessionId] of this.latestRestoreFailureImportedSessions.entries()) {
      if (importedSessionId === sessionId) {
        this.latestRestoreFailureImportedSessions.delete(sourceSessionId);
        break;
      }
    }

    this.emitHostSessionChanged({ sessionId, scope: 'imported', kind: 'deleted' });
  }

  listImportedDebugSnapshots(): readonly ImportedDebugSessionRecord[] {
    return [...this.importedDebugSessions.values()]
      .sort((left, right) => right.importedAt - left.importedAt);
  }

  private retargetImportedDebugEvents(
    events: readonly HostSessionDebugEvent[],
    sessionId: string,
  ): HostSessionDebugEvent[] {
    const idMap = new Map<string, string>();
    const nextEvents = events.map((event, index) => {
      const nextId = createHostSessionDebugEventId(sessionId, event.turnId, event.kind, index);
      idMap.set(event.id, nextId);
      return {
        ...event,
        id: nextId,
        sessionId,
        sequence: index,
      };
    });

    return nextEvents.map(event => ({
      ...event,
      parentEventId: event.parentEventId ? idMap.get(event.parentEventId) : undefined,
    }));
  }
  // =========================================================================
  // 公共 API - 孤儿会话领养（根目录 → 项目）
  // =========================================================================

  /**
   * 将所有根目录孤儿会话（projectPath === null 或 projectPath === rootPath）迁移归属到指定项目。
   * 适用于：用户最初无项目时创建了聊天记录，之后新建了项目，
   * 希望将之前的历史记录归入新项目。
   *
   * 操作内容：
   * 1. 更新索引条目的 projectPath / projectName
   * 2. 将数据文件从全局目录移动到项目 .chat_history/ 目录
   * 3. 更新内存缓存中的 metadata
   *
   * @param projectPath 目标项目的绝对路径
   * @param rootPath 可选，项目根目录路径（用于识别保存在根目录下的孤儿会话）
   * @returns 被迁移的会话数量
   */
  adoptOrphanSessions(projectPath: string, rootPath?: string | null): number {
    if (!projectPath) return 0;
    this.ensureIndexLoaded();

    const adopted = this.hostSessionAdoptionBridge.adoptOrphanSessions(
      this.index,
      this.hostSessionPersistenceBridge.getSessionCache(),
      projectPath,
      rootPath,
    );
    if (adopted === 0) return 0;

    this.bumpIndexRevision();
    this.indexDirty = true;
    this.writeIndex();
    return adopted;
  }

  adoptGlobalSessionToProject(
    sessionId: string,
    projectPath: string,
    rootPath?: string | null,
    reason = 'session-scope-adoption',
  ): boolean {
    const normalizedProjectPath = this.normalizePersistedProjectPath(projectPath);
    if (!sessionId || !normalizedProjectPath) return false;
    this.ensureIndexLoaded();

    const rollbackSnapshot = this.captureSingleSessionAdoptionSnapshot(sessionId);

    try {
      const adopted = this.hostSessionAdoptionBridge.adoptSingleGlobalSession(
        this.index,
        this.hostSessionPersistenceBridge.getSessionCache(),
        sessionId,
        normalizedProjectPath,
        rootPath,
      );
      if (!adopted) return false;

      this.bumpIndexRevision();
      this.indexDirty = true;
      this.writeIndexOrThrow(normalizedProjectPath);
      this.indexDirty = false;
      this.emitHostSessionChanged({ sessionId, scope: 'persisted', kind: 'updated' });
      console.log('[ChatHistory] session-scope-adoption', {
        sessionId,
        oldScope: 'global',
        newScope: 'project',
        projectPath: normalizedProjectPath,
        reason,
      });
      return true;
    } catch (error) {
      console.warn('[ChatHistory] session-scope-adoption rollback', {
        sessionId,
        projectPath: normalizedProjectPath,
        reason,
        error,
      });
      if (rollbackSnapshot) {
        this.restoreSingleSessionAdoptionSnapshot(rollbackSnapshot, normalizedProjectPath);
      }
      return false;
    }
  }

  // =========================================================================
  // 公共 API - 项目切换时重新加载项目索引
  // =========================================================================

  /**
   * 项目切换后重新加载项目级索引并合并到内存。
   * 在 currentProjectPath$ 变化时调用，确保新项目的本地索引被加载。
   * @param projectPath 新项目的绝对路径
   */
  reloadProjectIndex(projectPath: string): void {
    this.index = this.indexStore.mergeProjectIndex(this.index, projectPath);
    this.bumpIndexRevision();
  }

  // =========================================================================
  // 公共 API - 删除
  // =========================================================================

  /**
   * 删除会话（索引 + 数据文件 + checkpoint 文件 + 缓存）
   */
  deleteSession(sessionId: string): void {
    this.ensureIndexLoaded();
    const entry = this.index.find(e => e.sessionId === sessionId);

    if (entry?.projectPath) {
      EditCheckpointService.cleanSessionCheckpoints(entry.projectPath, sessionId);
    }

    if (entry) {
      this.deleteSessionFile(sessionId, entry.projectPath);
      this.deleteLexSnapshotFile(sessionId, entry.projectPath);
    }
    this.deleteSessionFile(sessionId, null);
    this.deleteLexSnapshotFile(sessionId, null);

    this.index = this.index.filter(e => e.sessionId !== sessionId);
    this.bumpIndexRevision();
    this.indexDirty = true;
    this.writeIndex();

    this.hostSessionPersistenceBridge.clearSessionState(sessionId);
    this.chatSessionEntryStateService?.clearSessionEntryTarget(sessionId, entry?.projectPath ?? null);
    this.chatSessionStateService?.clearSessionState(sessionId, entry?.projectPath ?? null);
    this.emitHostSessionChanged({ sessionId, scope: 'persisted', kind: 'deleted' });
  }

  private emitHostSessionChanged(event: HostSessionStoreChangeEvent): void {
    this.hostSessionChangedSubject.next(event);
  }

  // =========================================================================
  // 公共 API - 强制保存
  // =========================================================================

  /**
   * 强制保存所有脏数据（组件销毁/窗口关闭时调用）
   */
  flushAll(options?: HostSessionFlushOptions): void {
    this.hostSessionPersistenceBridge.flushAll(options);
  }

  async flushAllAsync(options?: HostSessionFlushOptions): Promise<void> {
    try {
      await this.hostSessionPersistenceBridge.flushAllAsync(options);
    } catch (error) {
      console.warn('[ChatHistory] Failed to flush sessions asynchronously:', error);
    }
  }

  flushSession(sessionId: string, options?: HostSessionFlushOptions): void {
    this.hostSessionPersistenceBridge.flushSession(sessionId, options);
  }

  async flushSessionAsync(sessionId: string, options?: HostSessionFlushOptions): Promise<void> {
    try {
      await this.hostSessionPersistenceBridge.flushSessionAsync(sessionId, options);
    } catch (error) {
      console.warn(`[ChatHistory] Failed to flush session asynchronously (${sessionId}):`, error);
    }
  }

  scheduleRecoverySnapshotFlush(sessionId?: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (normalizedSessionId) {
      this.pendingRecoverySnapshotSessionIds.add(normalizedSessionId);
    }
    this.scheduleSaveStateFlush({ allowActiveRecoverySnapshots: true });
  }

  // =========================================================================
  // 索引操作
  // =========================================================================

  /**
   * 更新或创建索引条目
   * @param updateTimestamp 是否更新 updatedAt（默认 true），纯保存/切换时传 false 避免时间戳污染
   */
  private upsertIndexEntry(
    sessionId: string,
    metadata: SessionMetadata,
    messageCount: number,
    updateTimestamp: boolean = true,
    options: { readonly dataAvailable?: boolean } = {},
  ): void {
    const selectedMode = resolveHostSessionSummaryModeFromMetadata(metadata);
    const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(metadata, this.getModeResolveOptions());
    const inputState = normalizeHostSessionInputStateFromMetadata(metadata, this.getModeResolveOptions());
    const requestRouting = normalizeHostSessionRequestRoutingSummary(metadata.requestRouting, selectedMode);
    const interactionActionSummary = normalizeHostSessionInteractionActionSummary(metadata.interactionActionSummary);
    const normalizedMetadataProjectPath = this.normalizePersistedProjectPath(metadata.projectPath);
    const existing = this.index.find(e => e.sessionId === sessionId);
    const nextTitle = metadata.title || '';
    const nextDefaultTitle = metadata.defaultTitle || undefined;
    const nextDurableTitle = resolveDurablePersistedTitleCandidate(nextTitle, metadata.titleSource, nextDefaultTitle);
    const existingDurableTitle = existing
      ? resolveDurablePersistedTitleCandidate(existing.title, existing.titleSource, existing.defaultTitle)
      : null;
    const resolvedDurableTitle = nextDurableTitle ?? existingDurableTitle;
    if (existing) {
      existing.title = resolvedDurableTitle?.title ?? '';
      existing.titleSource = resolvedDurableTitle?.source;
      existing.defaultTitle = nextDefaultTitle;
      existing.sessionType = normalizeChatSessionType(metadata.sessionType, existing.sessionType ?? DEFAULT_CHAT_SESSION_TYPE);
      if (updateTimestamp) {
        existing.updatedAt = metadata.updatedAt || Date.now();
      }
      existing.messageCount = messageCount;
      existing.mode = selectedMode.modeId;
      existing.modeDescriptor = modeDescriptor;
      existing.inputState = inputState;
      existing.requestRouting = requestRouting;
      existing.interactionActionSummary = interactionActionSummary;
      existing.model = metadata.model ?? existing.model;
      existing.projectPath = normalizedMetadataProjectPath;
      existing.projectName = this.extractProjectName(normalizedMetadataProjectPath);
      existing.sessionScopeSchemaVersion = metadata.sessionScopeSchemaVersion ?? 1;
      existing.dataAvailable = options.dataAvailable ?? true;
    } else {
      this.index.push({
        sessionId,
        title: resolvedDurableTitle?.title ?? '',
        ...(resolvedDurableTitle?.source ? { titleSource: resolvedDurableTitle.source } : {}),
        ...(nextDefaultTitle ? { defaultTitle: nextDefaultTitle } : {}),
        sessionType: normalizeChatSessionType(metadata.sessionType),
        projectPath: normalizedMetadataProjectPath,
        sessionScopeSchemaVersion: metadata.sessionScopeSchemaVersion ?? 1,
        projectName: this.extractProjectName(normalizedMetadataProjectPath),
        createdAt: metadata.createdAt || Date.now(),
        updatedAt: metadata.updatedAt || Date.now(),
        messageCount,
        mode: selectedMode.modeId,
        modeDescriptor,
        inputState,
        requestRouting,
        ...(interactionActionSummary ? { interactionActionSummary } : {}),
        model: metadata.model ?? null,
        dataAvailable: options.dataAvailable ?? true,
      });
    }
    this.bumpIndexRevision();
    this.indexDirty = true;
  }

  // =========================================================================
  // 磁盘 IO
  // =========================================================================

  /**
   * 加载索引（全局 + 项目级合并，项目级优先）
   */
  private ensureIndexLoaded(): void {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    let rootPathToNullCount = 0;
    const mergedIndex = this.indexStore.loadMergedIndex();
    this.index = mergedIndex.map((entry) => {
      const normalized = this.normalizeIndexEntry(entry);
      if (entry.projectPath !== null && normalized.projectPath === null) {
        rootPathToNullCount += 1;
      }
      return normalized;
    });
    this.latestIndexLoadDiagnostics = {
      normalizedEntryCount: this.index.length,
      rootPathToNullCount,
      ...this.indexStore.getLatestLoadDiagnostics(),
    };
    if (this.latestIndexLoadDiagnostics.rootPathToNullCount > 0
      || this.latestIndexLoadDiagnostics.projectIndexPatchedProjectPathCount > 0
      || this.latestIndexLoadDiagnostics.rebuiltProjectEntryCount > 0) {
      console.info('[ChatHistory] session scope migration', this.latestIndexLoadDiagnostics);
    }
    this.bumpIndexRevision();
  }

  private bumpIndexRevision(): void {
    this.indexRevision += 1;
    this.invalidateHistoryListCache();
  }

  private invalidateHistoryListCache(): void {
    this.historyListCache.clear();
    this.historyListCacheRevision = this.indexRevision;
  }

  private ensureHistoryListCacheRevision(): void {
    if (this.historyListCacheRevision === this.indexRevision) {
      return;
    }

    this.historyListCache.clear();
    this.historyListCacheRevision = this.indexRevision;
  }

  private buildHistoryListCacheKey(
    filter: HistoryFilterMode,
    projectPath?: string | null,
    projectRootPath?: string | null,
  ): string {
    const normalizePath = (value?: string | null) => (value ?? '').replace(/\\/g, '/').toLowerCase();
    return [
      filter,
      normalizePath(projectPath),
      normalizePath(projectRootPath),
    ].join('|');
  }

  private normalizePersistedProjectPath(projectPath: string | null | undefined): string | null {
    const normalizedProjectPath = normalizeChatSessionScopePath(projectPath);
    if (!normalizedProjectPath) {
      return null;
    }

    let projectRootPath: string | null = null;
    try {
      projectRootPath = normalizeChatSessionScopePath(AilyHost.get().project?.projectRootPath);
    } catch {
      projectRootPath = null;
    }
    return isSameChatSessionScopePath(normalizedProjectPath, projectRootPath)
      ? null
      : normalizedProjectPath;
  }

  private normalizeIndexEntry(entry: SessionIndexEntry): SessionIndexEntry {
    const selectedMode = resolveHostSessionSummaryModeFromMetadata(entry);
    const modeDescriptor = resolveHostSessionModeDescriptorFromMetadata(entry, this.getModeResolveOptions());
    const inputState = normalizeHostSessionInputStateFromMetadata(entry, this.getModeResolveOptions());
    const requestRouting = normalizeHostSessionRequestRoutingSummary(entry.requestRouting, selectedMode);
    const interactionActionSummary = normalizeHostSessionInteractionActionSummary(entry.interactionActionSummary);
    const normalizedProjectPath = this.normalizePersistedProjectPath(entry.projectPath);

    return {
      ...entry,
      projectPath: normalizedProjectPath,
      projectName: this.extractProjectName(normalizedProjectPath),
      sessionScopeSchemaVersion: entry.sessionScopeSchemaVersion ?? 1,
      sessionType: normalizeChatSessionType(entry.sessionType),
      mode: selectedMode.modeId,
      modeDescriptor,
      inputState,
      requestRouting,
      ...(interactionActionSummary ? { interactionActionSummary } : {}),
    };
  }

  /**
   * 写入索引（双写：全局 + 项目级）
   */
  private writeIndex(): void {
    if (this.indexStore.writeGlobalIndex(this.index)) {
      this.indexDirty = false;
    }
    this.indexStore.writeProjectIndex(this.index);
  }

  private writeIndexOrThrow(projectPath?: string | null): void {
    this.indexStore.writeGlobalIndexOrThrow(this.index);
    this.indexStore.writeProjectIndexOrThrow(this.index, projectPath);
  }

  private resolveStoredModeById(modeId: string) {
    return this.chatService?.runtimeModeCollection.findModeById(modeId);
  }

  private resolveStoredModeByName(modeName: string) {
    return this.chatService?.runtimeModeCollection.findModeByName(modeName);
  }

  private getModeResolveOptions(): HostSessionSelectedModeResolveOptions {
    return {
      resolveModeById: (modeId) => this.resolveStoredModeById(modeId),
      resolveModeByName: (modeName) => this.resolveStoredModeByName(modeName),
    };
  }

  /**
   * 删除会话数据文件
   */
  private deleteSessionFile(sessionId: string, projectPath: string | null): void {
    if (!this.hasFs()) return;

    try {
      if (projectPath) {
        const filePath = this.joinPath(projectPath, this.PROJECT_CHAT_DIR, `${sessionId}.jsonl`);
        if (this.fileExists(filePath)) {
          AilyHost.get().fs.unlinkSync(filePath);
        }
      } else {
        const filePath = this.joinPath(this.getGlobalChatDataDir(), `${sessionId}.jsonl`);
        if (this.fileExists(filePath)) {
          AilyHost.get().fs.unlinkSync(filePath);
        }
      }
    } catch { }
  }

  private deleteSessionFileOrThrow(sessionId: string, projectPath: string | null): void {
    if (!this.hasFs()) return;

    if (projectPath) {
      const filePath = this.joinPath(projectPath, this.PROJECT_CHAT_DIR, `${sessionId}.jsonl`);
      if (this.fileExists(filePath)) {
        AilyHost.get().fs.unlinkSync(filePath);
      }
      return;
    }

    const filePath = this.joinPath(this.getGlobalChatDataDir(), `${sessionId}.jsonl`);
    if (this.fileExists(filePath)) {
      AilyHost.get().fs.unlinkSync(filePath);
    }
  }

  private deleteLexSnapshotFile(sessionId: string, projectPath: string | null): void {
    if (!this.hasFs()) return;

    try {
      const filePath = this.resolveLexSnapshotFilePath(sessionId, projectPath);
      if (this.fileExists(filePath)) {
        AilyHost.get().fs.unlinkSync(filePath);
      }
    } catch { }
  }

  private captureSingleSessionAdoptionSnapshot(sessionId: string): {
    readonly entry: SessionIndexEntry;
    readonly record: HostSessionRecord | null;
    readonly hadCachedRecord: boolean;
  } | null {
    const entry = this.index.find(item => item.sessionId === sessionId);
    if (!entry) {
      return null;
    }

    const sessionCache = this.hostSessionPersistenceBridge.getSessionCache();
    const cachedRecord = sessionCache.get(sessionId) ?? null;
    const record = cachedRecord ?? this.hostRecordStore.read(sessionId, entry.projectPath ?? null);
    return {
      entry: JSON.parse(JSON.stringify(entry)) as SessionIndexEntry,
      record: record ? JSON.parse(JSON.stringify(record)) as HostSessionRecord : null,
      hadCachedRecord: cachedRecord !== null,
    };
  }

  private restoreSingleSessionAdoptionSnapshot(snapshot: {
    readonly entry: SessionIndexEntry;
    readonly record: HostSessionRecord | null;
    readonly hadCachedRecord: boolean;
  }, adoptedProjectPath: string | null): void {
    const existing = this.index.find(item => item.sessionId === snapshot.entry.sessionId);
    if (existing) {
      Object.assign(existing, JSON.parse(JSON.stringify(snapshot.entry)) as SessionIndexEntry);
    } else {
      this.index.push(JSON.parse(JSON.stringify(snapshot.entry)) as SessionIndexEntry);
    }

    const sessionCache = this.hostSessionPersistenceBridge.getSessionCache();
    if (snapshot.record) {
      if (snapshot.hadCachedRecord) {
        sessionCache.set(snapshot.entry.sessionId, JSON.parse(JSON.stringify(snapshot.record)) as HostSessionRecord);
      } else {
        sessionCache.delete(snapshot.entry.sessionId);
      }

      try {
        this.hostRecordStore.writeOrThrow(snapshot.entry.sessionId, JSON.parse(JSON.stringify(snapshot.record)) as HostSessionRecord);
      } catch (error) {
        console.warn('[ChatHistory] 恢复 session-scope-adoption 宿主持久化记录失败:', error);
      }
    } else {
      sessionCache.delete(snapshot.entry.sessionId);
    }

    try {
      this.deleteSessionFile(snapshot.entry.sessionId, adoptedProjectPath);
    } catch {
      // best effort cleanup of the partially adopted record
    }

    this.indexDirty = true;
    this.bumpIndexRevision();
    this.writeIndex();
  }

  // =========================================================================
  // 定时兜底保存
  // =========================================================================

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      if (this.hostSessionPersistenceBridge.hasDirtySessions() || this.indexDirty) {
        console.log(`[ChatHistory] 定时保存: ${this.hostSessionPersistenceBridge.getDirtySessionCount()} 个脏会话, 索引dirty=${this.indexDirty}`);
        void this.flushAllAsync({
          shouldSkipSession: (sessionId, policy) => {
            const active = this.autoSaveSessionActiveProvider?.(sessionId) === true;
            if (active && policy === 'recovery-snapshot') {
              return true;
            }
            return false;
          },
        });
      }
    }, 30000); // 30s
  }

  private async writeIndexAsync(): Promise<void> {
    if (await this.indexStore.writeIndexesAsync(this.index)) {
      this.indexDirty = false;
    }
  }

  private stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.saveStateFlushTimer) {
      clearTimeout(this.saveStateFlushTimer);
      this.saveStateFlushTimer = null;
    }
  }

  private scheduleSaveStateFlush(options?: { readonly allowActiveRecoverySnapshots?: boolean }): void {
    if (options?.allowActiveRecoverySnapshots === true) {
      this.saveStateFlushAllowsActiveRecoverySnapshot = true;
    }
    if (this.saveStateFlushTimer) {
      return;
    }

    this.saveStateFlushTimer = setTimeout(() => {
      this.saveStateFlushTimer = null;
      const allowActiveRecoverySnapshot = this.saveStateFlushAllowsActiveRecoverySnapshot;
      this.saveStateFlushAllowsActiveRecoverySnapshot = false;
      const pendingRecoverySnapshotSessionIds = allowActiveRecoverySnapshot
        ? [...this.pendingRecoverySnapshotSessionIds]
        : [];
      if (pendingRecoverySnapshotSessionIds.length > 0) {
        this.pendingRecoverySnapshotSessionIds.clear();
        for (const sessionId of pendingRecoverySnapshotSessionIds) {
          void this.flushSessionAsync(sessionId);
        }
      }
      if (this.hostSessionPersistenceBridge.hasDirtySessions() || this.indexDirty) {
        void this.flushAllAsync({
          shouldSkipSession: (sessionId, policy) => this.shouldSkipActiveRecoverySnapshot(sessionId, policy),
        });
      }
    }, 1000);
  }

  private shouldSkipActiveRecoverySnapshot(sessionId: string, policy: HostSessionDirtyPolicy): boolean {
    const active = this.autoSaveSessionActiveProvider?.(sessionId) === true;
    if (active && policy === 'recovery-snapshot') {
      return true;
    }
    return false;
  }

  // =========================================================================
  // 文件系统工具方法
  // =========================================================================

  private hasFs(): boolean {
    return typeof window !== 'undefined' && !!AilyHost.get().fs;
  }

  private fileExists(path: string): boolean {
    try {
      return AilyHost.get().fs.existsSync(path);
    } catch {
      return false;
    }
  }

  private readFileText(path: string): string | null {
    try {
      return AilyHost.get().fs.readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  }

  private buildDebugExportAugmentation(
    record: HostSessionRecord,
    projectPath: string | null,
  ): HostSessionDebugExportAugmentation | undefined {
    const scopeDiagnosticsNotes = this.buildScopeDiagnosticsNotes(record, projectPath);
    const restoreDiagnostics = this.buildRestoreDiagnosticsSummary(record, projectPath);
    const restoreFailure = this.latestRestoreFailures.get(record.metadata.sessionId) ?? null;
    const liveRuntimeOverlay = this.buildLiveRuntimeOverlaySummary(record);
    const summary = this.buildDualPersistenceSummary(record, projectPath);
    const developmentModePreference = this.buildDevelopmentModePreferenceSummary();
    if (!summary
      && !restoreDiagnostics
      && !restoreFailure
      && !liveRuntimeOverlay
      && !developmentModePreference
      && scopeDiagnosticsNotes.length === 0) {
      return undefined;
    }

    const companionFiles: Record<string, string> = {};
    if (liveRuntimeOverlay) {
      companionFiles['live_runtime_overlay.json'] = JSON.stringify(liveRuntimeOverlay, null, 2);
    }
    if (summary) {
      companionFiles['dual_persistence_diagnostics.json'] = JSON.stringify(summary, null, 2);
    }
    if (restoreDiagnostics) {
      companionFiles['restore_diagnostics.json'] = JSON.stringify(restoreDiagnostics, null, 2);
    }
    if (restoreFailure) {
      companionFiles['restore_failure.json'] = JSON.stringify(restoreFailure, null, 2);
    }
    if (developmentModePreference) {
      companionFiles['development_mode_preference.json'] = JSON.stringify(developmentModePreference, null, 2);
    }
    const lexSnapshotPath = restoreDiagnostics?.lexSnapshotPath ?? summary?.lexSnapshotPath;
    const rawLexSnapshot = lexSnapshotPath ? this.readFileText(lexSnapshotPath) : undefined;
    if (typeof rawLexSnapshot === 'string' && rawLexSnapshot.length > 0) {
      companionFiles['lex_session_snapshot.json'] = rawLexSnapshot;
    }

    return {
      ...(liveRuntimeOverlay ? { liveRuntimeOverlay } : {}),
      ...(developmentModePreference ? { developmentModePreference } : {}),
      ...(summary ? { dualPersistence: summary } : {}),
      ...(restoreDiagnostics ? { restoreDiagnostics } : {}),
      ...(restoreFailure ? { restoreFailure } : {}),
      ...(scopeDiagnosticsNotes.length > 0 ? { scopeDiagnostics: { notes: scopeDiagnosticsNotes } } : {}),
      companionFiles,
    };
  }

  private buildDevelopmentModePreferenceSummary(): HostSessionDevelopmentModePreferenceSummary | null {
    const config = this.configService?.data;
    const preference = this.configService?.getDevelopmentModePreference?.();
    if (!preference) {
      return null;
    }

    return {
      preference,
      ...(typeof config?.developmentModePreferenceSource === 'string'
        ? { source: config.developmentModePreferenceSource }
        : {}),
      ...(typeof config?.developmentModePreferenceUpdatedAt === 'number'
        ? { updatedAt: config.developmentModePreferenceUpdatedAt }
        : {}),
      ...(typeof config?.developmentModePreferencePromptedAt === 'number'
        ? { promptedAt: config.developmentModePreferencePromptedAt }
        : {}),
    };
  }

  private buildScopeDiagnosticsNotes(record: HostSessionRecord, projectPath: string | null): string[] {
    const notes: string[] = [];
    const diagnostics = this.latestIndexLoadDiagnostics;

    if (diagnostics.rootPathToNullCount > 0
      || diagnostics.projectIndexPatchedProjectPathCount > 0
      || diagnostics.rebuiltProjectEntryCount > 0) {
      notes.push(
        `session scope migration counts: normalizedEntries=${diagnostics.normalizedEntryCount}, rootPathToNull=${diagnostics.rootPathToNullCount}, projectIndexPatchedProjectPath=${diagnostics.projectIndexPatchedProjectPathCount}, rebuiltProjectEntries=${diagnostics.rebuiltProjectEntryCount}.`,
      );
    }

    const rootPath = this.getGlobalProjectRootPath();
    const globalVisibleEntries = this.getHistoryList('current-project', null, rootPath);
    const hiddenProjectEntries = this.index.filter((entry) => entry.projectPath !== null).length;
    if (globalVisibleEntries.length === 0 && hiddenProjectEntries > 0) {
      notes.push(`Global scope list is empty; ${hiddenProjectEntries} project-scoped entries are currently hidden by the scope filter.`);
    }

    const resolvedProjectPath = projectPath ?? record.metadata.projectPath ?? null;
    if (resolvedProjectPath) {
      const matchingEntry = this.index.find((entry) => (
        entry.sessionId === record.metadata.sessionId && this.isSamePath(entry.projectPath, resolvedProjectPath)
      ));
      const projectDataFileCount = this.countProjectSessionDataFiles(resolvedProjectPath);
      if (!matchingEntry && projectDataFileCount > 0) {
        notes.push(`Project scope list is empty, but ${projectDataFileCount} session data file(s) exist under ${resolvedProjectPath}/.chat_history; check index merge or projectPath normalization.`);
      }
    }

    return notes;
  }

  private countProjectSessionDataFiles(projectPath: string): number {
    if (!this.hasFs()) {
      return 0;
    }

    try {
      const chatDir = this.joinPath(projectPath, this.PROJECT_CHAT_DIR);
      if (!this.fileExists(chatDir)) {
        return 0;
      }

      const files = AilyHost.get().fs.readdirSync(chatDir);
      return Array.isArray(files)
        ? files.filter((file: string) => typeof file === 'string' && file.endsWith('.jsonl')).length
        : 0;
    } catch {
      return 0;
    }
  }

  private buildLiveRuntimeOverlaySummary(
    record: HostSessionRecord,
  ): HostSessionDebugLiveRuntimeOverlaySummary | null {
    const sessionId = record.metadata.sessionId;
    const runtimeState = this.chatSessionRuntimeStore?.read(sessionId);
    if (!runtimeState) {
      return null;
    }

    const debugSummary = runtimeState.debugSummary;
    const quotaOverlay = runtimeState.quotaOverlay;
    const viewOverlay = runtimeState.viewOverlay;
    return {
      sessionId,
      ...(runtimeState.status ? { status: runtimeState.status } : {}),
      pendingRequest: runtimeState.requestInProgress,
      needsInput: runtimeState.status === 'needs_input' || debugSummary?.needsInput === true,
      attachedView: runtimeState.attachedView,
      ...(typeof debugSummary?.title === 'string' ? { title: debugSummary.title } : {}),
      ...(typeof debugSummary?.titleSource === 'string' ? { titleSource: debugSummary.titleSource } : {}),
      ...(typeof debugSummary?.titleRevision === 'number' && Number.isFinite(debugSummary.titleRevision)
        ? { titleRevision: Math.floor(debugSummary.titleRevision) }
        : {}),
      turnResponseCount: runtimeState.turnResponses.length,
      hostProjectionPresent: !!runtimeState.hostProjectionState,
      quotaOverlayPresent: !!quotaOverlay || debugSummary?.quotaOverlayPresent === true,
      requestQuotaNotice: !!quotaOverlay?.requestInputNotice || debugSummary?.requestQuotaNotice === true,
      authQuotaProjected: !!quotaOverlay?.authQuotaInfo || debugSummary?.authQuotaProjected === true,
      contextBudgetOverlayPresent: !!viewOverlay?.contextBudgetSnapshot || debugSummary?.contextBudgetOverlayPresent === true,
      inputNoticeOverlayPresent: !!viewOverlay?.chatInputNotice || debugSummary?.inputNoticeOverlayPresent === true,
      ...(runtimeState.capabilities ? { capabilities: { ...runtimeState.capabilities } } : {}),
      ...(debugSummary?.lastViewDetachAt ? { lastViewDetachAt: debugSummary.lastViewDetachAt } : {}),
      ...(debugSummary?.lastExplicitInterruptAt ? { lastExplicitInterruptAt: debugSummary.lastExplicitInterruptAt } : {}),
      ...(debugSummary?.lastExplicitDisposeAt ? { lastExplicitDisposeAt: debugSummary.lastExplicitDisposeAt } : {}),
      notes: [
        'Live runtime overlay is sourced from ChatSessionRuntimeStoreService, not from the visible chat view.',
        ...(typeof debugSummary?.titleSource === 'string'
          ? ['Title/source/revision in this section describe the live runtime title snapshot, not durable hostRecord truth.']
          : []),
        ...(quotaOverlay
          ? ['Quota/notice overlay belongs to the live runtime owner and is not durable hostRecord truth.']
          : []),
        ...(viewOverlay
          ? ['Context budget/input notice view overlay belongs to the live runtime owner and is projected only when reattached.']
          : []),
      ],
    };
  }

  private buildRestoreFailureSummary(
    details: SessionLifecycleRestoreErrorDetails,
    errorMessage?: string,
  ): HostSessionRestoreFailureSummary {
    const diagnostics = details.diagnostics;
    const restoreFailure = details.restoreFailure;
    const resolvedErrorMessage = errorMessage?.trim()
      || (restoreFailure?.kind ? `[${restoreFailure.kind}] restore failed` : 'Session restore failed.');

    return {
      sessionId: diagnostics.sessionId,
      stage: details.stage,
      projectPath: diagnostics.projectPath ?? null,
      requestSource: diagnostics.requestSource,
      hostRecordSource: diagnostics.hostRecordSource,
      metadataSource: diagnostics.metadataSource,
      ...(restoreFailure?.kind ? { restoreKind: restoreFailure.kind } : {}),
      ...(restoreFailure?.hostRecordSessionId ? { hostRecordSessionId: restoreFailure.hostRecordSessionId } : {}),
      ...(restoreFailure?.storedSnapshotState ? { storedSnapshotState: restoreFailure.storedSnapshotState } : {}),
      errorMessage: resolvedErrorMessage,
      notes: [
        'Restore failure kinds remain owned by the host-side restore bridge and resolver seam.',
        'Pane-owned loadSession callbacks may notify the user, but debug/export should consume this structured summary instead of parsing message text.',
      ],
    };
  }

  private buildRestoreDiagnosticsSummary(
    record: HostSessionRecord,
    projectPath: string | null,
  ): HostSessionRestoreDiagnosticsSummary | null {
    if (!record.metadata.sessionId) {
      return null;
    }

    const lexSnapshotPath = this.resolveLexSnapshotFilePath(record.metadata.sessionId, projectPath);
    const rawLexSnapshot = this.readFileText(lexSnapshotPath);
    const parsedLexSnapshot = rawLexSnapshot ? this.safeParseJson(rawLexSnapshot) : null;
    const storedSnapshotState = rawLexSnapshot === undefined
      ? 'missing'
      : (parsedLexSnapshot ? 'loaded' : 'load-failed');
    const storedSnapshotError = rawLexSnapshot !== undefined && !parsedLexSnapshot
      ? 'Lex snapshot could not be parsed during debug export.'
      : undefined;
    const missingActiveSkillNames = this.resolveMissingRestoredSkillNames(record);
    const notes = [
      'Restore-plan diagnostics are owned by the host-side restore resolver and bridge seam.',
      ...(storedSnapshotState === 'missing'
        ? ['No lex auxiliary snapshot was present when the debug export was generated.']
        : []),
      ...(storedSnapshotState === 'load-failed'
        ? ['The lex auxiliary snapshot existed but could not be read as a valid snapshot payload.']
        : []),
      ...(missingActiveSkillNames.length > 0
        ? [`Restore degraded because persisted active skills are unavailable in the current registry: ${missingActiveSkillNames.join(', ')}.`]
        : []),
    ];

    return {
      sessionId: record.metadata.sessionId,
      lexSnapshotPath,
      storedSnapshotState,
      ...(storedSnapshotError ? { storedSnapshotError } : {}),
      ...(missingActiveSkillNames.length > 0 ? { missingActiveSkillNames } : {}),
      notes,
    };
  }

  private resolveMissingRestoredSkillNames(record: HostSessionRecord): string[] {
    const activeSkillNames = resolveHostSessionRuntimeAuxiliary(record)?.activeSkillNames ?? [];
    if (activeSkillNames.length === 0) {
      return [];
    }

    return activeSkillNames.filter(name => !BlocklySkillRegistry.getSkillContext(name));
  }

  private buildDualPersistenceSummary(
    record: HostSessionRecord,
    projectPath: string | null,
  ): HostSessionDebugDualPersistenceSummary | null {
    if (!record.metadata.sessionId) {
      return null;
    }

    const hostRecordPath = this.resolveHostRecordFilePath(record.metadata.sessionId, projectPath);
    const lexSnapshotPath = this.resolveLexSnapshotFilePath(record.metadata.sessionId, projectPath);
    const rawLexSnapshot = this.readFileText(lexSnapshotPath);
    const parsedLexSnapshot = rawLexSnapshot ? this.safeParseJson(rawLexSnapshot) : null;
    const indexEntry = this.index.find(entry => entry.sessionId === record.metadata.sessionId);
    const runtimeAuxiliary = resolveHostSessionRuntimeAuxiliary(record);
    const hostTitle = record.metadata.title || '';
    const hostTitleSource = record.metadata.titleSource;
    const hostDefaultTitle = record.metadata.defaultTitle || '';
    const indexTitle = indexEntry?.title;
    const indexTitleSource = indexEntry?.titleSource;
    const indexDefaultTitle = indexEntry?.defaultTitle || '';
    const displayTitle = hostTitle || indexTitle || hostDefaultTitle || indexDefaultTitle;
    const displayTitleSource = (hostTitle || indexTitle)
      ? (hostTitleSource ?? indexTitleSource ?? 'legacy-custom')
      : (hostDefaultTitle || indexDefaultTitle ? 'default-first-request' : 'empty');
    const hostAuxiliaryMirrors = [
      ...(runtimeAuxiliary?.requestContext ? ['auxiliary.requestContext'] : []),
      ...(runtimeAuxiliary?.activeSkillNames?.length ? ['auxiliary.activeSkillNames'] : []),
    ];
    const notes = [
      'Host record remains the UI-visible durable transcript and metadata source.',
      'Lex snapshot remains the FileSessionStorage-owned runtime snapshot used for auxiliary restore state.',
      ...(hostAuxiliaryMirrors.length > 0
        ? ['Host auxiliary runtime metadata is mirrored onto the host record for restore/debug continuity.']
        : []),
      ...(rawLexSnapshot && !parsedLexSnapshot
        ? ['Lex snapshot exists but could not be parsed during debug export.']
        : []),
    ];

    return {
      hostRecordPath,
      lexSnapshotPath,
      lexSnapshotPresent: typeof rawLexSnapshot === 'string',
      hostTurnResponseCount: record.turnResponses?.length ?? 0,
      ...(parsedLexSnapshot && Array.isArray((parsedLexSnapshot as { turns?: unknown[] }).turns)
        ? { lexTurnCount: (parsedLexSnapshot as { turns: unknown[] }).turns.length }
        : {}),
      displayTitle,
      displayTitleSource,
      hostTitle,
      ...(hostTitleSource ? { hostTitleSource } : {}),
      ...(hostDefaultTitle ? { hostDefaultTitle } : {}),
      ...(indexTitle !== undefined ? { indexTitle } : {}),
      ...(indexTitleSource ? { indexTitleSource } : {}),
      ...(indexDefaultTitle ? { indexDefaultTitle } : {}),
      hostPrimaryFields: [
        'turnResponses',
        'metadata.title',
        'metadata.titleSource',
        'metadata.defaultTitle',
        'metadata.sessionType',
        'metadata.projectPath',
        'metadata.mode',
        'metadata.modeDescriptor',
        'metadata.inputState',
        'metadata.requestRouting',
        'metadata.interactionActionSummary',
        'metadata.model',
      ],
      lexPrimaryFields: [
        'turns',
        'requestContext',
        'activeSkillNames',
        'todos',
        'executionNarrative',
        'revision',
        'createdAt',
        'updatedAt',
      ],
      ...(hostAuxiliaryMirrors.length > 0 ? { hostAuxiliaryMirrors } : {}),
      notes,
    };
  }

  private resolveHostRecordFilePath(sessionId: string, projectPath: string | null): string {
    const projectFilePath = projectPath
      ? this.joinPath(projectPath, this.PROJECT_CHAT_DIR, `${sessionId}.jsonl`)
      : null;
    if (projectFilePath && this.fileExists(projectFilePath)) {
      return projectFilePath;
    }

    return this.joinPath(this.getGlobalChatDataDir(), `${sessionId}.jsonl`);
  }

  private resolveLexSnapshotFilePath(sessionId: string, projectPath: string | null): string {
    const encodedSessionId = encodeURIComponent(sessionId);
    if (projectPath) {
      return this.joinPath(projectPath, this.PROJECT_CHAT_DIR, 'lex-sessions', `${encodedSessionId}.json`);
    }

    const userHome = AilyHost.get().path?.getUserHome?.() || '';
    return this.joinPath(userHome, '.aily', this.CHAT_DATA_DIR, 'lex-sessions', `${encodedSessionId}.json`);
  }

  private safeParseJson(raw: string): unknown | null {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private joinPath(...parts: string[]): string {
    // 优先使用 Electron 的 path API
    if (AilyHost.get().path?.join) {
      return AilyHost.get().path.join(...parts);
    }
    // 降级：简单拼接
    return parts.join('/').replace(/\/+/g, '/');
  }

  private getGlobalAilyDir(): string {
    return AilyHost.get().path?.getAppDataPath?.() || '';
  }

  private getGlobalChatDataDir(): string {
    return this.joinPath(this.getGlobalAilyDir(), this.CHAT_DATA_DIR);
  }

  /** 获取项目根目录路径（所有项目的父目录，如 Documents/AilyProjects） */
  private getGlobalProjectRootPath(): string | null {
    try {
      return AilyHost.get().project?.projectRootPath || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前活跃项目路径（排除项目根目录）
   */
  private getCurrentProjectPath(): string | null {
    try {
      const currentPath = AilyHost.get().project?.currentProjectPath;
      const rootPath = AilyHost.get().project?.projectRootPath;
      if (currentPath && (!rootPath || !this.isSamePath(currentPath, rootPath))) {
        return currentPath;
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractProjectName(projectPath: string | null): string | null {
    if (!projectPath) return null;
    // 取最后一段路径作为项目名
    const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || null;
  }

  /**
   * 路径比较（兼容 Windows/Unix 路径分隔符差异）
   */
  private isSamePath(a: string | null, b: string | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(a) === normalize(b);
  }
}

const IMPORTED_DEBUG_SNAPSHOT_FALLBACK_TITLE = 'Imported Debug Snapshot';

function resolveImportedDebugSnapshotTitle(decoded: HostSessionDebugExportEnvelope): string {
  return decoded.session.title
    || decoded.session.defaultTitle
    || decoded.hostRecord.metadata.title
    || decoded.hostRecord.metadata.defaultTitle
    || deriveImportedDebugSnapshotTitleFromHostRecord(decoded.hostRecord)
    || deriveImportedDebugSnapshotTitleFromEvents(decoded.debug.events)
    || IMPORTED_DEBUG_SNAPSHOT_FALLBACK_TITLE;
}

function deriveImportedDebugSnapshotTitleFromHostRecord(record: HostSessionRecord): string | undefined {
  const turnResponses = record.turnResponses;
  if (!Array.isArray(turnResponses)) {
    return undefined;
  }

  for (const turnResponse of turnResponses) {
    const title = readImportedDebugRequestTitle((turnResponse as { request?: unknown }).request);
    if (title) {
      return title;
    }
  }

  return undefined;
}

function readImportedDebugRequestTitle(request: unknown): string | undefined {
  const text = typeof request === 'string'
    ? request
    : request && typeof request === 'object'
      ? ((request as { messageText?: unknown }).messageText
        ?? (request as { prompt?: unknown }).prompt
        ?? (request as { text?: unknown }).text
        ?? (request as { content?: unknown }).content)
      : undefined;

  if (typeof text !== 'string') {
    return undefined;
  }

  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const firstLine = normalized.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return undefined;
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
}

function deriveImportedDebugSnapshotTitleFromEvents(events: readonly HostSessionDebugEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind !== 'userMessage') {
      continue;
    }

    const title = event.message.trim();
    if (!title) {
      continue;
    }

    return title.length > 80 ? `${title.slice(0, 80)}...` : title;
  }

  return undefined;
}
