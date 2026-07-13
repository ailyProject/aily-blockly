import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, ReplaySubject, Subject } from 'rxjs';
import type { TurnResponseTurn } from 'aily-lex/browser';
import { MCPTool } from './mcp.service';
import { ChatAPI } from '../core/api-endpoints';
import { AilyChatConfigService, ModelConfigOption } from './aily-chat-config.service';
import { AilyChatLanguageModelsService } from './aily-chat-language-models.service';
import { ContextBudgetService } from './context-budget.service';
import {
  ChatRuntimeModeService,
  type ChatCustomModeSourceKind,
  type ChatCustomAgentProviderSource,
  type ChatSessionCustomizationAgentCatalogEntry,
  type ChatSessionCustomizationProviderMetadata,
  type ChatSessionCustomizationProviderBinding,
  type ChatSessionCustomizationContentProvider,
  type ChatSessionCustomizationItem,
} from './chat-runtime-mode.service';
import {
  type ChatSessionProviderOptionsSource,
  type ChatSessionProviderOptionsSourceBinding,
  type ChatSessionProviderOptionsSourceContext,
  type ChatSessionProviderOptionsSourceRepository,
  type ChatSessionProviderOptionsSourceSnapshot,
  type ChatSessionProviderOptionsSourceSubscription,
} from './chat-session-provider-options-source.service';
import { AilyHost } from '../core/host';
import { normalizeAgentIdentifier } from '../core/agent-identifiers';
import {
  DEFAULT_CHAT_RESOLVED_MODE,
  DEFAULT_CHAT_SESSION_PERMISSION_MODE,
  DEFAULT_CHAT_SESSION_PERMISSION_PROFILE,
  DEFAULT_CHAT_SESSION_TYPE,
  DEFAULT_CHAT_SELECTED_MODE,
  DEFAULT_CHAT_SURFACE_MODE_ID,
  createBuiltinChatResolvedMode,
  createPlanChatResolvedMode,
  createChatSessionInputModeFromResolvedMode,
  isPlanChatAgentTarget,
  normalizeChatSelectedMode,
  normalizeChatSessionProviderOptionGroups,
  normalizeChatSessionPermissionMode,
  normalizeChatSessionPermissionProfile,
  type ChatSessionInputMode,
  type ChatSessionInputModeInstructions,
  type ChatSessionInputState,
  type ChatSessionProviderOptionGroup,
  type ChatSessionProviderOptionIcon,
  type ChatSessionProviderOptionItem,
  normalizeChatSessionType,
  resolveChatSessionCustomAgentTarget,
  resolveChatCurrentMode,
  resolveChatSelectedCustomAgentTarget,
  resolveChatSurfaceModeId,
  type ChatSessionPermissionMode,
  type ChatSessionPermissionProfile,
  type ChatResolvedModeTarget,
  type ChatSessionType,
  type ChatResolvedMode,
  type ChatRuntimeModeCollection,
  type ChatSelectedMode,
  normalizeChatSurfaceModeId,
  type ChatSurfaceModeId,
} from '../core/chat-mode';
import {
  HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID,
  HOST_SESSION_FOLDER_OPTION_ID,
  HOST_SESSION_PERMISSION_MODE_OPTION_ID,
  HOST_SESSION_PERMISSION_PROFILE_OPTION_ID,
  normalizeHostSessionProviderOptions,
  resolveHostSessionProviderOptionGroups,
  resolveHostSessionProviderOptionsFromInputState,
  type HostSessionProviderOptions,
} from '../helpers/host-session-input-state';
import {
  getTurnResponseResolvedPresetId,
  getTurnResponseResolvedModelBillingLabel,
  getTurnResponseResolvedModelName,
} from '../helpers/turn-response-response-model';
import {
  isCustomSessionTitleSource,
  normalizeChatSessionTitleSource,
  type ChatSessionTitleCandidate,
  type ChatSessionTitleSource,
} from '../core/chat-session-title';
import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import { auditLogService } from './audit-log.service';

// 使用 ModelConfigOption 作为统一的模型配置类型，保留 ModelConfig 别名以兼容旧代码
export type ModelConfig = ModelConfigOption;

export interface ChatTextOptions {
  sender?: string;
  type?: string;
  cover?: boolean;  // 是否覆盖之前的内容
  autoSend?: boolean; // 是否自动发送
  newChatFirst?: boolean; // 发送前先新建会话
  action?: string;
  payload?: unknown;
}

export interface ChatTextMessage {
  text: string;
  options?: ChatTextOptions;
  timestamp?: number;
}

export interface ChatServiceSessionProviderOptions {
  readonly folderPath?: unknown;
  readonly permissionMode?: unknown;
  readonly permissionProfile?: unknown;
  readonly permissionLevel?: unknown;
  readonly approvalsReviewer?: unknown;
  readonly approvalPolicy?: unknown;
}

export interface ChatServiceSessionIdentity {
  readonly sessionId?: unknown;
  readonly sessionType?: unknown;
  readonly providerOptions?: ChatServiceSessionProviderOptions | null;
  readonly inputState?: unknown;
}

export interface ChatServiceSessionOptionUpdate {
  readonly optionId: string;
  readonly value?: unknown;
}

export interface ChatServiceSessionProviderOptionsResult {
  readonly optionGroups: readonly ChatSessionProviderOptionGroup[];
  readonly newSessionOptions: Record<string, string>;
}

const AILY_AGENT_ISOLATION_OPTION_ID = 'isolation';
const AILY_AGENT_REPOSITORY_OPTION_ID = 'repository';
const AILY_AGENT_BRANCH_OPTION_ID = 'branch';
const AILY_AGENT_WORKSPACE_ISOLATION_ID = 'workspace';
const AILY_AGENT_WORKTREE_ISOLATION_ID = 'worktree';

type ChatServiceProviderSelectionState = Record<string, string>;

function normalizeChatSessionPermissionLevel(value: unknown): string | undefined {
  const normalizedValue = typeof value === 'string'
    ? value.trim()
    : '';
  return normalizedValue || undefined;
}

function normalizeChatSessionApprovalsReviewer(value: unknown): 'user' | 'auto_review' | undefined {
  return value === 'auto_review' || value === 'user'
    ? value
    : undefined;
}

function normalizeChatSessionApprovalPolicy(value: unknown): 'on_request' | 'never' | undefined {
  return value === 'never' || value === 'on_request'
    ? value
    : undefined;
}

function disposeSessionProviderOptionsSourceSubscription(
  subscription: ChatSessionProviderOptionsSourceSubscription | null,
): void {
  if (!subscription) {
    return;
  }

  if (typeof subscription === 'function') {
    subscription();
    return;
  }

  if (typeof subscription.unsubscribe === 'function') {
    subscription.unsubscribe();
    return;
  }

  subscription.dispose?.();
}

@Injectable({
  providedIn: 'root'
})
export class ChatService {

  private _currentModeId = DEFAULT_CHAT_RESOLVED_MODE.id;
  private _currentResolvedMode: ChatResolvedMode = DEFAULT_CHAT_RESOLVED_MODE;
  private _currentAgentRuntimeMode: ChatAgentRuntimeMode = 'unbound';
  private _currentAgentRuntimeModeSource: ChatAgentRuntimeModeSource = 'fallback';
  /**
   * @deprecated Adapter for the currently attached chat view selection.
   * Do not use this as session/model truth; read/write the target ChatSessionModel
   * through ChatSessionModelStore/ChatSessionViewModelStore instead.
   */
  private _currentSessionId = '';
  private _currentSessionPath = '';
  private _currentSessionType: ChatSessionType = DEFAULT_CHAT_SESSION_TYPE;
  private _currentSessionPermissionMode: ChatSessionPermissionMode = DEFAULT_CHAT_SESSION_PERMISSION_MODE;
  private _currentSessionPermissionProfile: ChatSessionPermissionProfile = DEFAULT_CHAT_SESSION_PERMISSION_PROFILE;
  private _currentSessionPermissionLevel: string | undefined;
  private _currentSessionApprovalsReviewer: 'user' | 'auto_review' | undefined;
  private _currentSessionApprovalPolicy: 'on_request' | 'never' | undefined;
  private _hasBlankSessionShell = false;
  private _newSessionFolderPath: string | undefined;
  private _newSessionPermissionMode: ChatSessionPermissionMode | undefined;
  private _newSessionPermissionProfile: ChatSessionPermissionProfile | undefined;
  private _newSessionApprovalsReviewer: 'user' | 'auto_review' | undefined;
  private _newSessionApprovalPolicy: 'on_request' | 'never' | undefined;
  private _currentSessionProviderSelections: ChatServiceProviderSelectionState = {};
  private _newSessionProviderSelections: ChatServiceProviderSelectionState = {};
  private readonly sessionInputStateChangedSubject = new Subject<void>();
  private readonly sessionProviderOptionsChangedSubject = new Subject<void>();
  private readonly sessionDisplayTitleChangedSubject = new Subject<void>();
  private readonly sessionDurableTitleChangedSubject = new Subject<void>();
  private boundSessionProviderOptionsSources: readonly ChatSessionProviderOptionsSourceBinding[] = [];
  private boundSessionProviderOptionsSource: ChatSessionProviderOptionsSource | null = null;
  private boundSessionProviderOptionsSourceSubscription: ChatSessionProviderOptionsSourceSubscription | null = null;
  private sessionProviderOptionsSourceBindingGeneration = 0;
  private readonly runtimeModeService: ChatRuntimeModeService;
  private _currentSessionTitle = '';
  private _currentSessionTitleSource: ChatSessionTitleSource = 'empty';
  private _currentSessionTitleRevision = 0;
  currentModel: ModelConfig | null = null; // 当前模型，在构造函数中初始化
  resolvedActiveModel: ModelConfig | null = null;
  resolvedActiveDisplayModel: ModelConfig | null = null;
  resolvedActiveModelBillingLabel: string | undefined;
  private rateLimitAutoSwitchToAuto = false;

  readonly sessionInputStateChanged$ = this.sessionInputStateChangedSubject.asObservable();
  readonly sessionProviderOptionsChanged$ = this.sessionProviderOptionsChangedSubject.asObservable();
  readonly sessionDisplayTitleChanged$ = this.sessionDisplayTitleChangedSubject.asObservable();
  readonly sessionTitleChanged$ = this.sessionDisplayTitleChanged$;
  readonly sessionDurableTitleChanged$ = this.sessionDurableTitleChangedSubject.asObservable();

  get currentSessionId(): string {
    return this._currentSessionId;
  }

  /**
   * @deprecated Adapter for the currently attached chat view selection.
   * Do not use this as session/model truth; attach/acquire the target model
   * through ChatSessionModelStore/ChatSessionViewModelStore instead.
   */
  set currentSessionId(sessionId: string) {
    const normalizedSessionId = typeof sessionId === 'string'
      ? sessionId.trim()
      : '';
    if (this._currentSessionId === normalizedSessionId) {
      return;
    }

    this._currentSessionProviderSelections = {};
    this._currentSessionPermissionLevel = undefined;
    this._currentSessionApprovalsReviewer = undefined;
    this._currentSessionApprovalPolicy = undefined;
    this._currentSessionId = normalizedSessionId;
    if (normalizedSessionId.length > 0) {
      this._hasBlankSessionShell = false;
    }
    this.notifySessionInputStateChanged();
  }

  get hasBlankSessionShell(): boolean {
    return this._hasBlankSessionShell;
  }

  set hasBlankSessionShell(value: boolean) {
    const normalizedValue = value === true;
    if (this._hasBlankSessionShell === normalizedValue) {
      return;
    }

    this._hasBlankSessionShell = normalizedValue;
    this.notifySessionInputStateChanged();
  }

  get currentSessionTitle(): string {
    return this._currentSessionTitle;
  }

  set currentSessionTitle(title: string) {
    const normalizedTitle = typeof title === 'string' ? title : '';
    this.setCurrentSessionTitle({
      text: normalizedTitle,
      source: normalizedTitle ? 'legacy-custom' : 'empty',
    });
  }

  get currentSessionTitleSource(): ChatSessionTitleSource {
    return this._currentSessionTitleSource;
  }

  get currentSessionTitleRevision(): number {
    return this._currentSessionTitleRevision;
  }

  readCurrentSessionTitleCandidate(): ChatSessionTitleCandidate {
    return {
      text: this._currentSessionTitle,
      source: this._currentSessionTitleSource,
      revision: this._currentSessionTitleRevision,
    };
  }

  setCurrentSessionTitle(candidate: {
    readonly text?: unknown;
    readonly source?: unknown;
    readonly revision?: unknown;
  }): void {
    const previousDurableIdentity = this.buildDurableSessionTitleIdentity(
      this._currentSessionTitle,
      this._currentSessionTitleSource,
    );
    const normalizedTitle = typeof candidate.text === 'string' ? candidate.text : '';
    const normalizedSource = normalizedTitle
      ? normalizeChatSessionTitleSource(candidate.source)
      : 'empty';
    const effectiveSource = normalizedTitle && normalizedSource !== 'empty'
      ? normalizedSource
      : 'empty';
    const nextRevision = typeof candidate.revision === 'number' && Number.isFinite(candidate.revision)
      ? Math.max(this._currentSessionTitleRevision + 1, Math.floor(candidate.revision))
      : this._currentSessionTitleRevision + 1;

    if (this._currentSessionTitle === normalizedTitle
      && this._currentSessionTitleSource === effectiveSource) {
      return;
    }

    this._currentSessionTitle = normalizedTitle;
    this._currentSessionTitleSource = effectiveSource;
    this._currentSessionTitleRevision = nextRevision;
    this.sessionDisplayTitleChangedSubject.next();

    const nextDurableIdentity = this.buildDurableSessionTitleIdentity(
      this._currentSessionTitle,
      this._currentSessionTitleSource,
    );
    if (previousDurableIdentity !== nextDurableIdentity) {
      this.sessionDurableTitleChangedSubject.next();
    }
  }

  private buildDurableSessionTitleIdentity(title: string, source: ChatSessionTitleSource): string {
    return title && isCustomSessionTitleSource(source)
      ? `${source}\u0000${title}`
      : '';
  }

  // 记录当前会话创建时的项目路径，用于确保历史记录保存到正确位置
  get currentSessionPath(): string {
    return this._currentSessionPath;
  }

  set currentSessionPath(path: string) {
    const normalizedPath = typeof path === 'string'
      ? path.trim()
      : '';
    if (this._currentSessionPath === normalizedPath) {
      return;
    }

    this._currentSessionPath = normalizedPath;
    this.refreshBoundSessionProviderOptionsSource();
    this.notifySessionInputStateChanged();
  }

  get currentSessionType(): ChatSessionType {
    return this._currentSessionType;
  }

  set currentSessionType(sessionType: ChatSessionType) {
    const normalizedSessionType = normalizeChatSessionType(sessionType);
    if (this._currentSessionType === normalizedSessionType) {
      return;
    }

    this.runtimeModeService.setCurrentSessionType(normalizedSessionType);
    this._currentSessionType = normalizedSessionType;
    this.refreshResolvedCurrentMode();
    void this.activateBoundSessionProviderOptionsSourceForCurrentSessionType(undefined, true);
    this.notifySessionInputStateChanged();
  }

  get currentSessionPermissionMode(): ChatSessionPermissionMode {
    return this._currentSessionPermissionMode;
  }

  set currentSessionPermissionMode(permissionMode: ChatSessionPermissionMode) {
    const normalizedPermissionMode = normalizeChatSessionPermissionMode(permissionMode);
    if (this._currentSessionPermissionMode === normalizedPermissionMode) {
      return;
    }

    this._currentSessionPermissionMode = normalizedPermissionMode;
    this.notifySessionInputStateChanged();
  }

  get currentSessionPermissionProfile(): ChatSessionPermissionProfile {
    return this._currentSessionPermissionProfile;
  }

  set currentSessionPermissionProfile(permissionProfile: ChatSessionPermissionProfile) {
    const normalizedPermissionProfile = normalizeChatSessionPermissionProfile(permissionProfile);
    if (this._currentSessionPermissionProfile === normalizedPermissionProfile) {
      return;
    }

    this._currentSessionPermissionProfile = normalizedPermissionProfile;
    this.notifySessionInputStateChanged();
  }

  get currentSessionPermissionLevel(): string | undefined {
    return this._currentSessionPermissionLevel;
  }

  set currentSessionPermissionLevel(permissionLevel: string | undefined) {
    const normalizedPermissionLevel = normalizeChatSessionPermissionLevel(permissionLevel);
    if (this._currentSessionPermissionLevel === normalizedPermissionLevel) {
      return;
    }

    this._currentSessionPermissionLevel = normalizedPermissionLevel;
    this.notifySessionInputStateChanged();
  }

  get currentSessionApprovalsReviewer(): 'user' | 'auto_review' | undefined {
    return this._currentSessionApprovalsReviewer;
  }

  set currentSessionApprovalsReviewer(approvalsReviewer: 'user' | 'auto_review' | undefined) {
    const normalizedApprovalsReviewer = normalizeChatSessionApprovalsReviewer(approvalsReviewer);
    if (this._currentSessionApprovalsReviewer === normalizedApprovalsReviewer) {
      return;
    }

    this._currentSessionApprovalsReviewer = normalizedApprovalsReviewer;
    this.notifySessionInputStateChanged();
  }

  get currentSessionApprovalPolicy(): 'on_request' | 'never' | undefined {
    return this._currentSessionApprovalPolicy;
  }

  set currentSessionApprovalPolicy(approvalPolicy: 'on_request' | 'never' | undefined) {
    const normalizedApprovalPolicy = normalizeChatSessionApprovalPolicy(approvalPolicy);
    if (this._currentSessionApprovalPolicy === normalizedApprovalPolicy) {
      return;
    }

    this._currentSessionApprovalPolicy = normalizedApprovalPolicy;
    this.notifySessionInputStateChanged();
  }

  /** 由 ChatEngineService 同步：是否正在等待 AI 响应 */
  isWaiting = false;

  /**
   * ReplaySubject(1) 仅用于“聊天面板尚未挂载时”暂存最近一条外部消息。
   * 消息被 ChatEngineService 消费后会立即清空，避免重新打开面板时重复自动发送。
   */
  private textSubject = new ReplaySubject<ChatTextMessage | null>(1);
  private static instance: ChatService;
  private static readonly maxRecentModelPresetIds = 5;

  /** ChatService 是否已挂载（供 UiService 等外部模块判断能否直连发送） */
  static get isReady(): boolean {
    return !!ChatService.instance;
  }


  constructor(
    private http: HttpClient,
    private ailyChatConfigService: AilyChatConfigService,
    private contextBudgetService: ContextBudgetService,
    private languageModelsService: AilyChatLanguageModelsService,
    runtimeModeService?: ChatRuntimeModeService,
  ) {
    ChatService.instance = this;
    this.runtimeModeService = runtimeModeService ?? new ChatRuntimeModeService(this.ailyChatConfigService);
    this.runtimeModeService.setCurrentSessionType(this._currentSessionType);
    this.runtimeModeService.runtimeModeCollection.onDidChange.subscribe(() => {
      this.refreshResolvedCurrentMode();
    });
    // 从配置加载AI聊天模式
    this.loadChatMode();
    this.loadRateLimitAutoSwitchToAuto();
    // 从配置加载AI模型
    this.loadChatModel();

    // 订阅配置变更，当模型列表更新时重新加载
    this.ailyChatConfigService.configChanged$.subscribe(() => {
      const savedModel = AilyHost.get().config.data?.aiChatModel as { model?: string; presetId?: string; name?: string } | null | undefined;
      console.info(
        `[AilyChat][ModelState] configChanged -> loadChatModel savedModel=${savedModel?.model ?? ''}/${savedModel?.presetId ?? ''}/${savedModel?.name ?? ''}`,
      );
      this.loadChatModel();
    });

    this.ailyChatConfigService.modelCatalogChanged$.subscribe(() => {
      console.info(
        `[AilyChat][ModelState] modelCatalogChanged -> refreshCurrentModelRuntimeMetadata currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
      );
      this.refreshCurrentModelRuntimeMetadata();
      // A catalog refresh changes the model provider options, not the durable
      // mode/permission state of every tracked session. Keep this on the
      // provider-options channel so the current/blank input models refresh
      // without rebuilding persisted session list items.
      this.sessionProviderOptionsChangedSubject.next();
    });
  }

  get selectedMode(): ChatSelectedMode {
    return normalizeChatSelectedMode({
      modeId: this._currentResolvedMode.kind,
      customAgentTarget: this._currentResolvedMode.customAgentTarget,
    });
  }

  get currentResolvedMode(): ChatResolvedMode {
    return this._currentResolvedMode;
  }

  getCurrentSessionCustomAgentTarget(): ChatResolvedModeTarget | undefined {
    return this.getCustomAgentTargetForSessionType(this.currentSessionType);
  }

  getCustomAgentTargetForSessionType(sessionType: unknown): ChatResolvedModeTarget | undefined {
    return resolveChatSessionCustomAgentTarget(sessionType);
  }

  get runtimeModeCollection(): ChatRuntimeModeCollection {
    return this.runtimeModeService.runtimeModeCollection;
  }

  get availableResolvedCustomModes(): readonly ChatResolvedMode[] {
    return this.runtimeModeService.availableResolvedCustomModes;
  }

  get activeCustomModeSource(): ChatCustomModeSourceKind {
    return this.runtimeModeService.activeCustomModeSource;
  }

  get activeSessionCustomizationProviderMetadata(): ChatSessionCustomizationProviderMetadata | undefined {
    return this.runtimeModeService.activeSessionCustomizationProviderMetadata;
  }

  get activeSessionCustomizationAgentEntries(): readonly ChatSessionCustomizationAgentCatalogEntry[] {
    return this.runtimeModeService.activeSessionCustomizationAgentEntries;
  }

  findResolvedModeById(modeId: string | null | undefined): ChatResolvedMode | undefined {
    const normalizedModeId = typeof modeId === 'string'
      ? modeId.trim()
      : '';
    if (!normalizedModeId) {
      return undefined;
    }

    const builtinModeId = resolveChatSurfaceModeId(normalizedModeId);
    if (builtinModeId) {
      return createBuiltinChatResolvedMode(builtinModeId);
    }

    return this.runtimeModeService.findResolvedModeById(normalizedModeId)
      ?? this.findRuntimeModeByCustomAgentTarget(normalizedModeId)
      ?? (isPlanChatAgentTarget(normalizedModeId) ? createPlanChatResolvedMode() : undefined)
      ?? (this._currentResolvedMode.id === normalizedModeId ? this._currentResolvedMode : undefined);
  }

  findResolvedModeByName(modeName: string | null | undefined): ChatResolvedMode | undefined {
    const normalizedModeName = typeof modeName === 'string'
      ? modeName.trim()
      : '';
    if (!normalizedModeName) {
      return undefined;
    }

    return this.runtimeModeService.findResolvedModeByName(normalizedModeName)
      ?? this.findRuntimeModeByCustomAgentTarget(normalizedModeName)
      ?? (isPlanChatAgentTarget(normalizedModeName) ? createPlanChatResolvedMode() : undefined)
      ?? (this._currentResolvedMode.name === normalizedModeName ? this._currentResolvedMode : undefined);
  }

  get currentMode(): ChatSurfaceModeId {
    return this._currentResolvedMode.kind;
  }

  set currentMode(mode: ChatSurfaceModeId) {
    this.setChatMode(mode, false);
  }

  get currentAgentRuntimeMode(): ChatAgentRuntimeMode {
    return this._currentAgentRuntimeMode;
  }

  set currentAgentRuntimeMode(mode: ChatAgentRuntimeMode | string | null | undefined) {
    this._currentAgentRuntimeMode = normalizeChatAgentRuntimeMode(mode, 'unbound');
  }

  get currentAgentRuntimeModeSource(): ChatAgentRuntimeModeSource {
    return this._currentAgentRuntimeModeSource;
  }

  set currentAgentRuntimeModeSource(source: ChatAgentRuntimeModeSource | string | null | undefined) {
    this._currentAgentRuntimeModeSource = normalizeChatAgentRuntimeModeSource(source, 'fallback');
  }

  setCurrentAgentRuntimeMode(
    mode: ChatAgentRuntimeMode | string | null | undefined,
    source: ChatAgentRuntimeModeSource | string | null | undefined = this._currentAgentRuntimeModeSource,
  ): ChatAgentRuntimeMode {
    const previousMode = this._currentAgentRuntimeMode;
    const previousSource = this._currentAgentRuntimeModeSource;
    const nextMode = normalizeChatAgentRuntimeMode(mode, 'unbound');
    const nextSource = normalizeChatAgentRuntimeModeSource(source, 'fallback');
    this._currentAgentRuntimeMode = nextMode;
    this._currentAgentRuntimeModeSource = nextSource;
    this.recordRuntimeModeTelemetry(previousMode, previousSource, nextMode, nextSource);
    return this._currentAgentRuntimeMode;
  }

  private recordRuntimeModeTelemetry(
    previousMode: ChatAgentRuntimeMode,
    previousSource: ChatAgentRuntimeModeSource,
    mode: ChatAgentRuntimeMode,
    source: ChatAgentRuntimeModeSource,
  ): void {
    if (previousMode === mode && previousSource === source) {
      return;
    }

    auditLogService.logSuccess({
      operation: 'setRuntimeMode',
      tool: 'chatRuntimeMode',
      target: mode,
      sessionId: this.currentSessionId || undefined,
      riskLevel: 'low',
      metadata: {
        previousMode,
        previousSource,
        mode,
        source,
      },
    });
  }

  get currentCustomAgentTarget(): string | undefined {
    return this._currentResolvedMode.kind === 'agent'
      ? this._currentResolvedMode.customAgentTarget
      : undefined;
  }

  set currentCustomAgentTarget(agentTarget: string | undefined) {
    const normalizedAgentTarget = normalizeAgentIdentifier(agentTarget);
    if (!normalizedAgentTarget) {
      if (this._currentResolvedMode.kind === 'agent' && !this._currentResolvedMode.isBuiltin) {
        this.applyResolvedModeSelection(createBuiltinChatResolvedMode('agent'), false);
      }
      return;
    }

    this.applyResolvedModeSelection(
      this.resolveCompatSelectionMode({
        modeId: 'agent',
        customAgentTarget: normalizedAgentTarget,
      }),
      false,
    );
  }

  setCustomAgentProviderModes(agentModes: readonly unknown[] | PromiseLike<readonly unknown[]>): Promise<void> {
    return this.runtimeModeService.setCustomAgentProviderModes(agentModes);
  }

  bindCustomAgentProviderSource(
    agentModeSource: ChatCustomAgentProviderSource | PromiseLike<ChatCustomAgentProviderSource | null> | null,
  ): Promise<void> {
    return this.runtimeModeService.bindCustomAgentProviderSource(agentModeSource);
  }

  setSessionCustomizationItems(
    items: readonly ChatSessionCustomizationItem[] | PromiseLike<readonly ChatSessionCustomizationItem[]>,
  ): Promise<void> {
    return this.runtimeModeService.setSessionCustomizationItems(items);
  }

  bindSessionCustomizationProvider(
    providerBinding: ChatSessionCustomizationProviderBinding | PromiseLike<ChatSessionCustomizationProviderBinding | null> | null,
  ): Promise<void> {
    return this.runtimeModeService.bindSessionCustomizationProvider(providerBinding);
  }

  bindSessionCustomizationProviders(
    providerBindings: readonly ChatSessionCustomizationProviderBinding[] | PromiseLike<readonly ChatSessionCustomizationProviderBinding[] | null> | null,
  ): Promise<void> {
    return this.runtimeModeService.bindSessionCustomizationProviders(providerBindings);
  }

  bindSessionCustomizationContentProvider(
    contentProvider: ChatSessionCustomizationContentProvider | PromiseLike<ChatSessionCustomizationContentProvider | null> | null,
  ): Promise<void> {
    return this.runtimeModeService.bindSessionCustomizationContentProvider(contentProvider);
  }

  bindSessionProviderOptionsSource(
    source: ChatSessionProviderOptionsSource | PromiseLike<ChatSessionProviderOptionsSource | null> | null,
  ): Promise<void> {
    const sourceBindingsPromise = Promise.resolve(source).then((resolvedSource) => {
      return resolvedSource ? [{ source: resolvedSource }] : [];
    });
    return this.bindSessionProviderOptionsSources(sourceBindingsPromise);
  }

  bindSessionProviderOptionsSources(
    sourceBindings: readonly ChatSessionProviderOptionsSourceBinding[] | PromiseLike<readonly ChatSessionProviderOptionsSourceBinding[] | null> | null,
  ): Promise<void> {
    const bindingGeneration = ++this.sessionProviderOptionsSourceBindingGeneration;
    return Promise.resolve(sourceBindings)
      .then((resolvedBindings) => {
        if (bindingGeneration !== this.sessionProviderOptionsSourceBindingGeneration) {
          return;
        }

        this.boundSessionProviderOptionsSources = Array.isArray(resolvedBindings)
          ? resolvedBindings.filter((entry): entry is ChatSessionProviderOptionsSourceBinding => !!entry?.source)
          : [];
        return this.activateBoundSessionProviderOptionsSourceForCurrentSessionType(bindingGeneration, true);
      })
      .catch(() => undefined);
  }

  refreshSessionProviderOptionsSources(): Promise<void> {
    return Promise.resolve(this.refreshBoundSessionProviderOptionsSource())
      .then(() => undefined);
  }

  setChatMode(mode: ChatSurfaceModeId | string, storeSelection = true): void {
    const normalizedMode = typeof mode === 'string'
      ? mode.trim()
      : '';
    if (!normalizedMode) {
      return;
    }

    const resolvedMode = this.findResolvedModeById(normalizedMode)
      ?? this.findResolvedModeByName(normalizedMode)
      ?? this.findResolvedModeById('agent')
      ?? DEFAULT_CHAT_RESOLVED_MODE;

    this.applyResolvedModeSelection(resolvedMode, storeSelection);
  }

  /**
   * 从配置加载AI聊天模式
   */
  private loadChatMode(): void {
    const config = AilyHost.get().config;
    const persistedMode = config.data?.aiChatMode;
    const persistedCustomAgentTarget = normalizeAgentIdentifier(config.data?.aiChatCustomAgentTarget);
    const normalizedMode = persistedMode !== undefined
      ? normalizeChatSurfaceModeId(persistedMode)
      : DEFAULT_CHAT_SELECTED_MODE.modeId;

    if (normalizedMode === 'agent' && persistedCustomAgentTarget) {
      this.setSelectedMode({
        modeId: 'agent',
        customAgentTarget: persistedCustomAgentTarget,
      }, { persist: false });
    } else {
      this.setChatMode(normalizedMode, false);
    }

    if (persistedMode !== undefined
      && config.data
      && (persistedMode !== normalizedMode || config.data.aiChatCustomAgentTarget !== persistedCustomAgentTarget)) {
      config.data.aiChatMode = normalizedMode;
      config.data.aiChatCustomAgentTarget = normalizedMode === 'agent'
        ? persistedCustomAgentTarget || undefined
        : undefined;
      config.save?.();
    }
  }

  resetChatModeToPersistedSelection(): void {
    this.loadChatMode();
  }

  private loadRateLimitAutoSwitchToAuto(): void {
    this.rateLimitAutoSwitchToAuto = AilyHost.get().config.data?.aiChatRateLimitAutoSwitchToAuto === true;
  }

  /**
   * 保存AI聊天模式到配置
   */
  saveChatMode(mode: ChatSurfaceModeId): void {
    this.setChatMode(mode, true);
  }

  saveSelectedMode(selectedMode: { readonly modeId?: unknown; readonly customAgentTarget?: unknown }): void {
    this.setSelectedMode(selectedMode);
  }

  setSelectedMode(
    selectedMode: { readonly modeId?: unknown; readonly customAgentTarget?: unknown },
    options?: { persist?: boolean },
  ): void {
    const nextSelectedMode = normalizeChatSelectedMode(selectedMode, this.selectedMode);
    this.applyResolvedModeSelection(
      this.resolveCompatSelectionMode(nextSelectedMode),
      options?.persist !== false,
    );
  }

  saveCurrentCustomAgentTarget(agentTarget: string | null | undefined): void {
    const normalizedAgentTarget = normalizeAgentIdentifier(agentTarget);
    this.setSelectedMode(
      normalizedAgentTarget
        ? { modeId: 'agent', customAgentTarget: normalizedAgentTarget }
        : { modeId: 'agent' },
    );
  }

  setCurrentSessionPermissionMode(permissionMode: unknown): void {
    this.currentSessionPermissionMode = normalizeChatSessionPermissionMode(permissionMode);
  }

  setCurrentSessionPermissionProfile(permissionProfile: unknown): void {
    this.currentSessionPermissionProfile = normalizeChatSessionPermissionProfile(permissionProfile);
  }

  setCurrentSessionPermissionLevel(permissionLevel: unknown): void {
    this.currentSessionPermissionLevel = normalizeChatSessionPermissionLevel(permissionLevel);
  }

  setCurrentSessionApprovalsReviewer(approvalsReviewer: unknown): void {
    this.currentSessionApprovalsReviewer = normalizeChatSessionApprovalsReviewer(approvalsReviewer);
  }

  setCurrentSessionApprovalPolicy(approvalPolicy: unknown): void {
    this.currentSessionApprovalPolicy = normalizeChatSessionApprovalPolicy(approvalPolicy);
  }

  setCurrentSessionType(sessionType: unknown): void {
    this.currentSessionType = normalizeChatSessionType(sessionType);
  }

  getCurrentSessionProviderOptions(): HostSessionProviderOptions {
    return {
      folderPath: this.currentSessionPath,
      permissionMode: this.currentSessionPermissionMode,
      permissionProfile: this.currentSessionPermissionProfile,
      ...(this.currentSessionPermissionLevel ? { permissionLevel: this.currentSessionPermissionLevel } : {}),
      ...(this.currentSessionApprovalsReviewer ? { approvalsReviewer: this.currentSessionApprovalsReviewer } : {}),
      ...(this.currentSessionApprovalPolicy ? { approvalPolicy: this.currentSessionApprovalPolicy } : {}),
    };
  }

  getNewSessionProviderOptions(
    fallback?: ChatServiceSessionProviderOptions | null,
  ): HostSessionProviderOptions {
    const normalizedFallback = this.normalizeProviderOptionsInput(fallback);
    return normalizeHostSessionProviderOptions({
      folderPath: this._newSessionFolderPath,
      permissionMode: this._newSessionPermissionMode,
      permissionProfile: this._newSessionPermissionProfile,
      approvalsReviewer: this._newSessionApprovalsReviewer,
      approvalPolicy: this._newSessionApprovalPolicy,
    }, normalizedFallback);
  }

  buildCurrentSessionProviderOptionGroups(
    previousInputState?: ChatSessionInputState | null,
    fallback?: ChatServiceSessionProviderOptions | null,
  ): readonly ChatSessionProviderOptionGroup[] {
    const normalizedFallback = this.normalizeProviderOptionsInput(fallback);
    const providerOptions = normalizeHostSessionProviderOptions(
      this.getCurrentSessionProviderOptions(),
      normalizedFallback,
    );
    return this.buildProviderOptionGroupsForSessionType(
      this.currentSessionType,
      previousInputState,
      providerOptions,
      this._currentSessionProviderSelections,
      'current',
    );
  }

  buildNewSessionProviderOptionGroups(
    previousInputState?: ChatSessionInputState | null,
    fallback?: ChatServiceSessionProviderOptions | null,
  ): readonly ChatSessionProviderOptionGroup[] {
    const providerOptions = this.getNewSessionProviderOptions(fallback);
    return this.buildProviderOptionGroupsForSessionType(
      this.currentSessionType,
      previousInputState,
      providerOptions,
      this._newSessionProviderSelections,
      'new',
    );
  }

  provideSessionProviderOptions(
    previousInputState?: ChatSessionInputState | null,
    fallback?: ChatServiceSessionProviderOptions | null,
  ): ChatServiceSessionProviderOptionsResult {
    const providerOptions = this.getNewSessionProviderOptions(fallback);
    return {
      optionGroups: this.buildNewSessionProviderOptionGroups(previousInputState, fallback),
      newSessionOptions: this.buildNewSessionOptionSelections(this.currentSessionType, providerOptions, this._newSessionProviderSelections),
    };
  }

  applySessionProviderOptionUpdates(
    updates: ReadonlyArray<ChatServiceSessionOptionUpdate>,
    options?: {
      readonly sessionId?: unknown;
      readonly applyToCurrentSession?: boolean;
      readonly fallbackProviderOptions?: ChatServiceSessionProviderOptions | null;
    },
  ): HostSessionProviderOptions {
    let nextProviderOptions = this.getNewSessionProviderOptions(options?.fallbackProviderOptions);
    let nextNewSelections = { ...this._newSessionProviderSelections };
    let nextCurrentSelections = { ...this._currentSessionProviderSelections };
    let hadProviderOptionsChange = false;
    let hadNewSelectionChange = false;
    let shouldApplyToCurrentSession = options?.applyToCurrentSession !== false;

    if (options?.sessionId !== undefined) {
      shouldApplyToCurrentSession = shouldApplyToCurrentSession && this.isCurrentSessionTarget(options.sessionId);
    }

    for (const update of updates) {
      const optionId = typeof update.optionId === 'string'
        ? update.optionId.trim()
        : '';
      if (!optionId) {
        continue;
      }

      if (optionId === HOST_SESSION_PERMISSION_MODE_OPTION_ID) {
        if (typeof update.value !== 'string' || update.value.trim().length === 0) {
          continue;
        }

        const selectionValue = update.value.trim();
        const permissionMode = normalizeChatSessionPermissionMode(update.value, nextProviderOptions.permissionMode);
        const permissionProfile = normalizeChatSessionPermissionProfile(update.value, nextProviderOptions.permissionProfile);
        const normalizedPermissionMode = permissionMode === 'bypassPermissions'
          ? DEFAULT_CHAT_SESSION_PERMISSION_MODE
          : permissionMode;
        if (normalizedPermissionMode !== nextProviderOptions.permissionMode || permissionProfile !== nextProviderOptions.permissionProfile) {
          nextProviderOptions = {
            ...nextProviderOptions,
            permissionMode: normalizedPermissionMode,
            permissionProfile,
          };
          hadProviderOptionsChange = true;
        }
        if (nextNewSelections[optionId] !== selectionValue) {
          nextNewSelections = {
            ...nextNewSelections,
            [optionId]: selectionValue,
          };
          hadNewSelectionChange = true;
        }
        if (shouldApplyToCurrentSession && nextCurrentSelections[optionId] !== selectionValue) {
          nextCurrentSelections = {
            ...nextCurrentSelections,
            [optionId]: selectionValue,
          };
        }
        continue;
      }

      if (optionId === HOST_SESSION_PERMISSION_PROFILE_OPTION_ID) {
        if (typeof update.value !== 'string' || update.value.trim().length === 0) {
          continue;
        }

        const selectionValue = update.value.trim();
        const permissionProfile = normalizeChatSessionPermissionProfile(update.value, nextProviderOptions.permissionProfile);
        if (permissionProfile !== nextProviderOptions.permissionProfile) {
          nextProviderOptions = {
            ...nextProviderOptions,
            permissionProfile,
          };
          hadProviderOptionsChange = true;
        }
        if (nextNewSelections[optionId] !== selectionValue) {
          nextNewSelections = {
            ...nextNewSelections,
            [optionId]: selectionValue,
          };
          hadNewSelectionChange = true;
        }
        if (shouldApplyToCurrentSession && nextCurrentSelections[optionId] !== selectionValue) {
          nextCurrentSelections = {
            ...nextCurrentSelections,
            [optionId]: selectionValue,
          };
        }
        continue;
      }

      if (optionId === 'approvalsReviewer') {
        if (typeof update.value !== 'string' || update.value.trim().length === 0) {
          continue;
        }

        const selectionValue = update.value.trim();
        const approvalsReviewer = normalizeChatSessionApprovalsReviewer(update.value);
        if (approvalsReviewer && approvalsReviewer !== nextProviderOptions.approvalsReviewer) {
          nextProviderOptions = {
            ...nextProviderOptions,
            approvalsReviewer,
          };
          hadProviderOptionsChange = true;
        }
        if (approvalsReviewer && nextNewSelections[optionId] !== selectionValue) {
          nextNewSelections = {
            ...nextNewSelections,
            [optionId]: selectionValue,
          };
          hadNewSelectionChange = true;
        }
        if (approvalsReviewer && shouldApplyToCurrentSession && nextCurrentSelections[optionId] !== selectionValue) {
          nextCurrentSelections = {
            ...nextCurrentSelections,
            [optionId]: selectionValue,
          };
        }
        continue;
      }

      if (optionId === 'approvalPolicy') {
        if (typeof update.value !== 'string' || update.value.trim().length === 0) {
          continue;
        }

        const selectionValue = update.value.trim();
        const approvalPolicy = normalizeChatSessionApprovalPolicy(update.value);
        if (approvalPolicy && approvalPolicy !== nextProviderOptions.approvalPolicy) {
          nextProviderOptions = {
            ...nextProviderOptions,
            approvalPolicy,
          };
          hadProviderOptionsChange = true;
        }
        if (approvalPolicy && nextNewSelections[optionId] !== selectionValue) {
          nextNewSelections = {
            ...nextNewSelections,
            [optionId]: selectionValue,
          };
          hadNewSelectionChange = true;
        }
        if (approvalPolicy && shouldApplyToCurrentSession && nextCurrentSelections[optionId] !== selectionValue) {
          nextCurrentSelections = {
            ...nextCurrentSelections,
            [optionId]: selectionValue,
          };
        }
        continue;
      }

      if ((optionId === HOST_SESSION_FOLDER_OPTION_ID || optionId === AILY_AGENT_REPOSITORY_OPTION_ID) && typeof update.value === 'string') {
        const folderPath = update.value.trim();
        if (folderPath !== nextProviderOptions.folderPath) {
          nextProviderOptions = {
            ...nextProviderOptions,
            folderPath,
          };
          hadProviderOptionsChange = true;
        }

        if (nextNewSelections[AILY_AGENT_REPOSITORY_OPTION_ID] !== folderPath) {
          nextNewSelections = {
            ...nextNewSelections,
            [AILY_AGENT_REPOSITORY_OPTION_ID]: folderPath,
          };
          hadNewSelectionChange = true;
        }

        if (shouldApplyToCurrentSession && nextCurrentSelections[AILY_AGENT_REPOSITORY_OPTION_ID] !== folderPath) {
          nextCurrentSelections = {
            ...nextCurrentSelections,
            [AILY_AGENT_REPOSITORY_OPTION_ID]: folderPath,
          };
        }
        continue;
      }

      if (typeof update.value !== 'string' || update.value.trim().length === 0) {
        continue;
      }

      const selectionValue = update.value.trim();
      if (nextNewSelections[optionId] !== selectionValue) {
        nextNewSelections = {
          ...nextNewSelections,
          [optionId]: selectionValue,
        };
        hadNewSelectionChange = true;
      }

      if (shouldApplyToCurrentSession && nextCurrentSelections[optionId] !== selectionValue) {
        nextCurrentSelections = {
          ...nextCurrentSelections,
          [optionId]: selectionValue,
        };
      }
    }

    if (hadProviderOptionsChange || hadNewSelectionChange) {
      this._newSessionFolderPath = nextProviderOptions.folderPath;
      this._newSessionPermissionMode = nextProviderOptions.permissionMode;
      this._newSessionPermissionProfile = nextProviderOptions.permissionProfile;
      this._newSessionApprovalsReviewer = nextProviderOptions.approvalsReviewer;
      this._newSessionApprovalPolicy = nextProviderOptions.approvalPolicy;
      this._newSessionProviderSelections = nextNewSelections;
      this.sessionProviderOptionsChangedSubject.next();
    }

    if (shouldApplyToCurrentSession) {
      const hadCurrentSelectionChange = !this.areProviderSelectionsEqual(this._currentSessionProviderSelections, nextCurrentSelections);
      if (hadProviderOptionsChange || hadCurrentSelectionChange) {
        this._currentSessionProviderSelections = nextCurrentSelections;
        if (hadProviderOptionsChange) {
          this.applySessionProviderOptions(nextProviderOptions);
        } else {
          this.notifySessionInputStateChanged();
        }
      }
    }

    return nextProviderOptions;
  }

  applySessionProviderOptions(
    providerOptions?: ChatServiceSessionProviderOptions | null,
  ): HostSessionProviderOptions {
    const folderPath = typeof providerOptions?.folderPath === 'string'
      ? providerOptions.folderPath.trim()
      : '';
    const permissionMode = normalizeChatSessionPermissionMode(
      providerOptions?.permissionMode,
      this.currentSessionPermissionMode,
    );
    const permissionProfile = normalizeChatSessionPermissionProfile(
      providerOptions?.permissionProfile ?? providerOptions?.permissionMode,
      this.currentSessionPermissionProfile,
    );
    const permissionLevel = normalizeChatSessionPermissionLevel(
      providerOptions?.permissionLevel,
    ) ?? this.currentSessionPermissionLevel;
    const approvalsReviewer = normalizeChatSessionApprovalsReviewer(providerOptions?.approvalsReviewer)
      ?? this.currentSessionApprovalsReviewer
      ?? this.ailyChatConfigService.getLexApprovalsReviewer?.();
    const approvalPolicy = normalizeChatSessionApprovalPolicy(providerOptions?.approvalPolicy)
      ?? (permissionMode === 'bypassPermissions' ? 'never' : undefined)
      ?? this.currentSessionApprovalPolicy
      ?? this.ailyChatConfigService.getLexApprovalPolicy?.();
    const hadProviderOptionsChange = this.currentSessionPath !== folderPath
      || this.currentSessionPermissionMode !== (permissionMode === 'bypassPermissions' ? DEFAULT_CHAT_SESSION_PERMISSION_MODE : permissionMode)
      || this.currentSessionPermissionProfile !== permissionProfile
      || this.currentSessionPermissionLevel !== permissionLevel
      || this.currentSessionApprovalsReviewer !== approvalsReviewer
      || this.currentSessionApprovalPolicy !== approvalPolicy;

    this.currentSessionPath = folderPath;
    this.currentSessionPermissionMode = permissionMode === 'bypassPermissions'
      ? DEFAULT_CHAT_SESSION_PERMISSION_MODE
      : permissionMode;
    this.currentSessionPermissionProfile = permissionProfile;
    this.currentSessionPermissionLevel = permissionLevel;
    this.currentSessionApprovalsReviewer = approvalsReviewer;
    this.currentSessionApprovalPolicy = approvalPolicy;

    const normalizedProviderOptions = {
      folderPath,
      permissionMode: this.currentSessionPermissionMode,
      permissionProfile,
      ...(permissionLevel ? { permissionLevel } : {}),
      ...(approvalsReviewer ? { approvalsReviewer } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
    };
    this.applyCurrentSessionProviderSelections(normalizedProviderOptions, {
      notify: !hadProviderOptionsChange,
    });
    return normalizedProviderOptions;
  }

  private applyCurrentSessionProviderSelections(
    providerOptions: HostSessionProviderOptions,
    options?: {
      readonly notify?: boolean;
    },
  ): void {
    let nextSelections = { ...this._currentSessionProviderSelections };

    if (providerOptions.folderPath) {
      nextSelections = {
        ...nextSelections,
        [HOST_SESSION_FOLDER_OPTION_ID]: providerOptions.folderPath,
        [AILY_AGENT_REPOSITORY_OPTION_ID]: providerOptions.folderPath,
      };
    }

    nextSelections = {
      ...nextSelections,
      [HOST_SESSION_PERMISSION_MODE_OPTION_ID]: providerOptions.permissionMode,
      [HOST_SESSION_PERMISSION_PROFILE_OPTION_ID]: providerOptions.permissionProfile ?? DEFAULT_CHAT_SESSION_PERMISSION_PROFILE,
      ...(providerOptions.approvalsReviewer
        ? { [HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID]: providerOptions.approvalsReviewer }
        : {}),
      ...(providerOptions.approvalPolicy
        ? { approvalPolicy: providerOptions.approvalPolicy }
        : {}),
    };

    if (this.areProviderSelectionsEqual(this._currentSessionProviderSelections, nextSelections)) {
      return;
    }

    this._currentSessionProviderSelections = nextSelections;
    if (options?.notify !== false) {
      this.notifySessionInputStateChanged();
    }
  }

  applySessionIdentity(identity?: ChatServiceSessionIdentity | null): void {
    if (!identity) {
      return;
    }

    if (identity.sessionId !== undefined) {
      this.currentSessionId = typeof identity.sessionId === 'string'
        ? identity.sessionId.trim()
        : '';
    }

    if (identity.sessionType !== undefined) {
      this.currentSessionType = normalizeChatSessionType(identity.sessionType, this.currentSessionType);
    }

    let normalizedProviderOptions: HostSessionProviderOptions | undefined;
    if (identity.providerOptions !== undefined) {
      normalizedProviderOptions = this.applySessionProviderOptions(identity.providerOptions);
    }

    if (identity.inputState !== undefined) {
      this.applyCurrentSessionProviderStateFromInputState(identity.inputState, normalizedProviderOptions);
    }
  }

  clearCurrentCustomAgentTarget(): void {
    this.currentCustomAgentTarget = undefined;
  }

  private isCurrentSessionTarget(sessionId: unknown): boolean {
    if (sessionId === undefined || sessionId === null) {
      return true;
    }

    return (typeof sessionId === 'string' ? sessionId.trim() : '') === this.currentSessionId;
  }

  private normalizeProviderOptionsInput(
    providerOptions?: ChatServiceSessionProviderOptions | null,
  ): Partial<HostSessionProviderOptions> {
    return {
      ...(typeof providerOptions?.folderPath === 'string'
        ? { folderPath: providerOptions.folderPath.trim() }
        : {}),
      ...(providerOptions?.permissionMode !== undefined
        ? { permissionMode: normalizeChatSessionPermissionMode(providerOptions.permissionMode, DEFAULT_CHAT_SESSION_PERMISSION_MODE) }
        : {}),
      ...(providerOptions?.permissionProfile !== undefined || providerOptions?.permissionMode === 'bypassPermissions'
        ? { permissionProfile: normalizeChatSessionPermissionProfile(providerOptions.permissionProfile ?? providerOptions.permissionMode) }
        : {}),
      ...(providerOptions?.permissionLevel !== undefined
        ? { permissionLevel: normalizeChatSessionPermissionLevel(providerOptions.permissionLevel) }
        : {}),
      ...(providerOptions?.approvalsReviewer !== undefined
        ? { approvalsReviewer: normalizeChatSessionApprovalsReviewer(providerOptions.approvalsReviewer) }
        : {}),
      ...(providerOptions?.approvalPolicy !== undefined
        ? { approvalPolicy: normalizeChatSessionApprovalPolicy(providerOptions.approvalPolicy) }
        : {}),
    };
  }

  private buildProviderOptionGroupsForSessionType(
    sessionType: ChatSessionType,
    previousInputState: ChatSessionInputState | null | undefined,
    providerOptions: HostSessionProviderOptions,
    selectionState: ChatServiceProviderSelectionState,
    scope: 'current' | 'new',
  ): readonly ChatSessionProviderOptionGroup[] {
    if (sessionType === 'aily-agent') {
      return this.buildAilyAgentProviderOptionGroups(
        previousInputState,
        providerOptions,
        selectionState,
        scope,
        this.readSessionProviderOptionsSourceSnapshot(sessionType),
      );
    }

    return resolveHostSessionProviderOptionGroups(previousInputState, providerOptions);
  }

  private buildNewSessionOptionSelections(
    sessionType: ChatSessionType,
    providerOptions: HostSessionProviderOptions,
    selectionState: ChatServiceProviderSelectionState,
  ): Record<string, string> {
    if (sessionType === 'aily-agent') {
      const sourceSnapshot = this.readSessionProviderOptionsSourceSnapshot(sessionType);
      const sourceRepository = this.readSourceRepository(
        sourceSnapshot,
        providerOptions.folderPath || this.readSelectionStateValue(selectionState, AILY_AGENT_REPOSITORY_OPTION_ID),
      );
      const newSessionOptions: Record<string, string> = {
        [AILY_AGENT_ISOLATION_OPTION_ID]: this.readSelectionStateValue(selectionState, AILY_AGENT_ISOLATION_OPTION_ID)
          ?? AILY_AGENT_WORKSPACE_ISOLATION_ID,
      };

      const repository = this.readSelectionStateValue(selectionState, AILY_AGENT_REPOSITORY_OPTION_ID)
        || sourceRepository?.path
        || sourceSnapshot?.repositories[0]?.path
        || providerOptions.folderPath;
      if (repository) {
        newSessionOptions[AILY_AGENT_REPOSITORY_OPTION_ID] = repository;
      }

      const branch = sourceRepository?.kind === 'folder'
        ? undefined
        : this.readSelectionStateValue(selectionState, AILY_AGENT_BRANCH_OPTION_ID)
          || sourceRepository?.currentBranch
          || sourceSnapshot?.repositories.find((repositoryEntry) => repositoryEntry.kind === 'repository')?.currentBranch;
      if (branch) {
        newSessionOptions[AILY_AGENT_BRANCH_OPTION_ID] = branch;
      }

      return newSessionOptions;
    }

    return {
      [HOST_SESSION_PERMISSION_MODE_OPTION_ID]: providerOptions.permissionMode,
      [HOST_SESSION_PERMISSION_PROFILE_OPTION_ID]: providerOptions.permissionProfile,
      ...(providerOptions.approvalsReviewer
        ? { [HOST_SESSION_APPROVALS_REVIEWER_OPTION_ID]: providerOptions.approvalsReviewer }
        : {}),
      ...(providerOptions.folderPath
        ? { [HOST_SESSION_FOLDER_OPTION_ID]: providerOptions.folderPath }
        : {}),
    };
  }

  private buildAilyAgentProviderOptionGroups(
    previousInputState: ChatSessionInputState | null | undefined,
    providerOptions: HostSessionProviderOptions,
    selectionState: ChatServiceProviderSelectionState,
    scope: 'current' | 'new',
    sourceSnapshot: ChatSessionProviderOptionsSourceSnapshot | null,
  ): readonly ChatSessionProviderOptionGroup[] {
    const storedGroups = normalizeChatSessionProviderOptionGroups(previousInputState);
    const storedGroupById = new Map(storedGroups.map((group) => [group.id, group]));
    const groups: ChatSessionProviderOptionGroup[] = [];
    const supportsWorktree = sourceSnapshot?.supportsWorktree !== false;
    const isCurrentScope = scope === 'current';

    const isolationGroup = storedGroupById.get(AILY_AGENT_ISOLATION_OPTION_ID);
    const isolationItems: readonly ChatSessionProviderOptionItem[] = supportsWorktree
      ? [
        { id: AILY_AGENT_WORKSPACE_ISOLATION_ID, name: 'Workspace', icon: this.createProviderOptionIcon('folder') },
        { id: AILY_AGENT_WORKTREE_ISOLATION_ID, name: 'Worktree', icon: this.createProviderOptionIcon('worktree') },
      ]
      : [
        { id: AILY_AGENT_WORKSPACE_ISOLATION_ID, name: 'Workspace', icon: this.createProviderOptionIcon('folder') },
      ];
    const isolationSelectedId = this.readSelectionStateValue(selectionState, AILY_AGENT_ISOLATION_OPTION_ID)
      ?? this.readSelectedOptionIdFromGroup(isolationGroup)
      ?? AILY_AGENT_WORKSPACE_ISOLATION_ID;
    const isolationSelected = isolationItems.find((item) => item.id === isolationSelectedId) ?? isolationItems[0];
    groups.push(this.withSelectedDefaultMetadata({
      id: AILY_AGENT_ISOLATION_OPTION_ID,
      name: isolationGroup?.name ?? 'Isolation',
      ...(isolationGroup?.description ? { description: isolationGroup.description } : { description: 'Pick Isolation Mode' }),
      ...(isolationGroup?.icon ? { icon: isolationGroup.icon } : {}),
      items: isolationItems,
      selected: isCurrentScope ? this.withLockedMetadata(isolationSelected) : isolationSelected,
    }, scope));

    const repositoryGroup = storedGroupById.get(AILY_AGENT_REPOSITORY_OPTION_ID);
    const sourceRepositories = sourceSnapshot?.repositories ?? [];
    const repositorySelectedId = this.readSelectionStateValue(selectionState, AILY_AGENT_REPOSITORY_OPTION_ID)
      || this.readSelectedOptionIdFromGroup(repositoryGroup)
      || this.readSourceRepository(sourceSnapshot, providerOptions.folderPath)?.path
      || sourceRepositories[0]?.path;
    const sourceRepository = this.readSourceRepository(sourceSnapshot, repositorySelectedId);
    const repositorySelectedBase = repositorySelectedId
      ? (sourceRepository
        ? this.createSourceRepositoryOptionItem(sourceRepository)
        : repositoryGroup?.items.find((item) => item.id === repositorySelectedId)
          ? this.withFallbackIcon(repositoryGroup.items.find((item) => item.id === repositorySelectedId)!, 'folder')
          : this.createPathOptionItem(repositorySelectedId, 'folder'))
      : (repositoryGroup?.selected ? this.withFallbackIcon(repositoryGroup.selected, 'folder') : undefined);
    const repositorySelected = repositorySelectedBase
      ? (isCurrentScope ? this.withLockedMetadata(repositorySelectedBase) : repositorySelectedBase)
      : undefined;
    const repositoryItems = isCurrentScope
      ? (repositorySelected ? [repositorySelected] : [])
      : sourceRepositories.length > 0
      ? sourceRepositories.map((repository) => this.createSourceRepositoryOptionItem(repository))
      : repositoryGroup?.items.length
      ? repositoryGroup.items.map((item) => this.withFallbackIcon(item, 'folder'))
      : (repositorySelectedId ? [this.createPathOptionItem(repositorySelectedId, 'folder')] : []);
    groups.push(this.withSelectedDefaultMetadata({
      id: AILY_AGENT_REPOSITORY_OPTION_ID,
      name: repositoryGroup?.name ?? 'Folder',
      ...(repositoryGroup?.description
        ? { description: repositoryGroup.description }
        : { description: 'Pick Folder' }),
      ...(repositoryGroup?.icon ? { icon: repositoryGroup.icon } : { icon: this.createProviderOptionIcon('folder') }),
      ...(!isCurrentScope && (repositoryGroup?.commands?.length || sourceSnapshot?.repositoryCommands?.length)
        ? { commands: repositoryGroup?.commands?.length ? repositoryGroup.commands : sourceSnapshot?.repositoryCommands }
        : {}),
      items: repositoryItems,
      ...(repositorySelected ? { selected: repositorySelected } : {}),
    }, scope));

    const branchGroup = storedGroupById.get(AILY_AGENT_BRANCH_OPTION_ID);
    const branchSelectedId = sourceRepository?.kind === 'folder'
      ? undefined
      : this.readSelectionStateValue(selectionState, AILY_AGENT_BRANCH_OPTION_ID)
        ?? this.readSelectedOptionIdFromGroup(branchGroup)
        ?? sourceRepository?.currentBranch;
    const sourceBranchItems = sourceRepository?.kind === 'repository'
      ? sourceRepository.branches
      : [];
    const branchSelectedBase = branchSelectedId
      ? (sourceBranchItems.includes(branchSelectedId)
        ? this.createNamedOptionItem(branchSelectedId, branchSelectedId, 'git-branch')
        : branchGroup?.items.find((item) => item.id === branchSelectedId)
          ? this.withFallbackIcon(branchGroup.items.find((item) => item.id === branchSelectedId)!, 'git-branch')
          : this.createNamedOptionItem(branchSelectedId, branchSelectedId, 'git-branch'))
      : (branchGroup?.selected ? this.withFallbackIcon(branchGroup.selected, 'git-branch') : undefined);
    const branchSelected = branchSelectedBase
      ? (isCurrentScope ? this.withLockedMetadata(branchSelectedBase) : branchSelectedBase)
      : undefined;
    if ((isCurrentScope || ((sourceRepository?.kind === 'repository' || !sourceRepository) && (branchGroup || branchSelectedId || sourceBranchItems.length > 0))) && supportsWorktree) {
      const branchItems = isCurrentScope
        ? (branchSelected ? [branchSelected] : [])
        : sourceBranchItems.length > 0
        ? sourceBranchItems.map((branch) => this.createNamedOptionItem(branch, branch, 'git-branch'))
        : branchGroup?.items.length
        ? branchGroup.items.map((item) => this.withFallbackIcon(item, 'git-branch'))
        : (branchSelectedId ? [this.createNamedOptionItem(branchSelectedId, branchSelectedId, 'git-branch')] : []);
      groups.push(this.withSelectedDefaultMetadata({
        id: AILY_AGENT_BRANCH_OPTION_ID,
        name: branchGroup?.name ?? 'Branch',
        ...(branchGroup?.description ? { description: branchGroup.description } : { description: 'Pick Branch' }),
        ...(branchGroup?.icon ? { icon: branchGroup.icon } : { icon: this.createProviderOptionIcon('git-branch') }),
        ...(!isCurrentScope && branchGroup?.commands?.length ? { commands: branchGroup.commands } : {}),
        when: branchGroup?.when ?? `chatSessionOption.${AILY_AGENT_ISOLATION_OPTION_ID} == '${AILY_AGENT_WORKTREE_ISOLATION_ID}'`,
        items: branchItems,
        ...(branchSelected ? { selected: branchSelected } : {}),
      }, scope));
    }

    return groups;
  }

  private withSelectedDefaultMetadata(
    group: ChatSessionProviderOptionGroup,
    scope: 'current' | 'new',
  ): ChatSessionProviderOptionGroup {
    if (scope !== 'new' || !group.selected) {
      return group;
    }

    const items = group.items.map((item) => ({
      ...item,
      ...(item.id === group.selected?.id ? { default: true } : {}),
    }));
    const selected = items.find((item) => item.id === group.selected?.id) ?? { ...group.selected, default: true };

    return {
      ...group,
      items,
      selected,
    };
  }

  private withFallbackIcon(
    item: ChatSessionProviderOptionItem,
    iconId: string,
  ): ChatSessionProviderOptionItem {
    if (item.icon) {
      return item;
    }

    return {
      ...item,
      icon: this.createProviderOptionIcon(iconId),
    };
  }

  private withLockedMetadata(
    item: ChatSessionProviderOptionItem,
  ): ChatSessionProviderOptionItem {
    if (item.locked) {
      return item;
    }

    return {
      ...item,
      locked: true,
    };
  }

  private createPathOptionItem(
    path: string,
    iconId: string,
  ): ChatSessionProviderOptionItem {
    return this.createNamedOptionItem(path, this.readPathLabel(path), iconId);
  }

  private createSourceRepositoryOptionItem(
    repository: ChatSessionProviderOptionsSourceRepository,
  ): ChatSessionProviderOptionItem {
    return this.createNamedOptionItem(
      repository.path,
      repository.label,
      repository.kind === 'repository' ? 'repo' : 'folder',
    );
  }

  private createNamedOptionItem(
    id: string,
    name: string,
    iconId: string,
  ): ChatSessionProviderOptionItem {
    return {
      id,
      name,
      icon: this.createProviderOptionIcon(iconId),
    };
  }

  private createProviderOptionIcon(iconId: string): ChatSessionProviderOptionIcon {
    return { id: iconId };
  }

  private readPathLabel(path: string): string {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (!normalizedPath) {
      return path;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    return segments[segments.length - 1] || normalizedPath;
  }

  private readSelectedOptionIdFromGroup(
    group: ChatSessionProviderOptionGroup | undefined,
  ): string | undefined {
    const selectedId = typeof group?.selected?.id === 'string'
      ? group.selected.id.trim()
      : '';
    if (selectedId) {
      return selectedId;
    }

    const firstItemId = typeof group?.items?.[0]?.id === 'string'
      ? group.items[0].id.trim()
      : '';
    return firstItemId || undefined;
  }

  private readSelectionStateValue(
    selectionState: ChatServiceProviderSelectionState,
    optionId: string,
  ): string | undefined {
    const value = selectionState[optionId];
    return typeof value === 'string' && value.trim()
      ? value.trim()
      : undefined;
  }

  private areProviderSelectionsEqual(
    left: ChatServiceProviderSelectionState,
    right: ChatServiceProviderSelectionState,
  ): boolean {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    return leftKeys.every((key) => left[key] === right[key]);
  }

  private applyCurrentSessionProviderStateFromInputState(
    inputState?: unknown,
    fallbackProviderOptions?: ChatServiceSessionProviderOptions | null,
  ): void {
    const fallbackOptions = this.normalizeProviderOptionsInput(fallbackProviderOptions);
    const hasExplicitFallbackOptions = fallbackProviderOptions !== undefined && fallbackProviderOptions !== null;
    const normalizedProviderOptions = hasExplicitFallbackOptions
      ? normalizeHostSessionProviderOptions(fallbackOptions)
      : resolveHostSessionProviderOptionsFromInputState(inputState, fallbackOptions);
    const groups = resolveHostSessionProviderOptionGroups(inputState as ChatSessionInputState | null | undefined, normalizedProviderOptions);
    const nextSelections = this.readSelectionStateFromGroups(groups);
    const hadSelectionChange = !this.areProviderSelectionsEqual(this._currentSessionProviderSelections, nextSelections);
    const hadProviderOptionsChange = this.currentSessionPath !== (normalizedProviderOptions.folderPath ?? '')
      || this.currentSessionPermissionMode !== normalizedProviderOptions.permissionMode
      || this.currentSessionPermissionProfile !== normalizedProviderOptions.permissionProfile
      || this.currentSessionPermissionLevel !== normalizedProviderOptions.permissionLevel
      || this.currentSessionApprovalsReviewer !== normalizedProviderOptions.approvalsReviewer
      || this.currentSessionApprovalPolicy !== normalizedProviderOptions.approvalPolicy;

    this._currentSessionProviderSelections = nextSelections;

    if (hadProviderOptionsChange) {
      this.applySessionProviderOptions(normalizedProviderOptions);
      return;
    }

    if (hadSelectionChange) {
      this.notifySessionInputStateChanged();
    }
  }

  private readSelectionStateFromGroups(
    groups: readonly ChatSessionProviderOptionGroup[],
  ): ChatServiceProviderSelectionState {
    const selectionState: ChatServiceProviderSelectionState = {};

    for (const group of groups) {
      const selectedId = this.readSelectedOptionIdFromGroup(group);
      if (!selectedId) {
        continue;
      }

      selectionState[group.id] = selectedId;
    }

    return selectionState;
  }

  private activateBoundSessionProviderOptionsSourceForCurrentSessionType(
    bindingGeneration = this.sessionProviderOptionsSourceBindingGeneration,
    forceRefresh = false,
  ): Promise<void> | void {
    if (bindingGeneration !== this.sessionProviderOptionsSourceBindingGeneration) {
      return;
    }

    const nextBinding = this.selectSessionProviderOptionsSourceBindingForCurrentSessionType();
    const nextSource = nextBinding?.source ?? null;
    const didSourceChange = this.boundSessionProviderOptionsSource !== nextSource;

    if (didSourceChange) {
      this.detachSessionProviderOptionsSource();
      this.boundSessionProviderOptionsSource = nextSource;
    }

    if (didSourceChange && nextSource?.onDidChange) {
      const subscription = nextSource.onDidChange(() => {
        this.sessionProviderOptionsChangedSubject.next();
      });
      if (bindingGeneration === this.sessionProviderOptionsSourceBindingGeneration) {
        this.boundSessionProviderOptionsSourceSubscription = subscription ?? null;
      } else {
        disposeSessionProviderOptionsSourceSubscription(subscription ?? null);
      }
    }

    if (forceRefresh) {
      return this.refreshBoundSessionProviderOptionsSource();
    }

    if (didSourceChange) {
      this.sessionProviderOptionsChangedSubject.next();
    }
  }

  private selectSessionProviderOptionsSourceBindingForCurrentSessionType(): ChatSessionProviderOptionsSourceBinding | null {
    const exactMatch = this.boundSessionProviderOptionsSources.find((entry) => {
      const normalizedSessionType = typeof entry.sessionType === 'string'
        ? entry.sessionType.trim()
        : '';
      return normalizedSessionType === this.currentSessionType;
    });
    if (exactMatch) {
      return exactMatch;
    }

    return this.boundSessionProviderOptionsSources.find((entry) => !entry.sessionType) ?? null;
  }

  private detachSessionProviderOptionsSource(): void {
    disposeSessionProviderOptionsSourceSubscription(this.boundSessionProviderOptionsSourceSubscription);
    this.boundSessionProviderOptionsSourceSubscription = null;
    this.boundSessionProviderOptionsSource = null;
  }

  private refreshBoundSessionProviderOptionsSource(): Promise<void> | void {
    const source = this.boundSessionProviderOptionsSource;
    if (!source?.refresh) {
      return;
    }

    return Promise.resolve(source.refresh(this.createSessionProviderOptionsSourceContext()))
      .then(() => undefined)
      .catch(() => undefined);
  }

  private createSessionProviderOptionsSourceContext(): ChatSessionProviderOptionsSourceContext {
    return {
      workspacePath: this.currentSessionPath || AilyHost.get().project.currentProjectPath || null,
      projectPath: AilyHost.get().project.currentProjectPath || null,
      projectRootPath: AilyHost.get().project.projectRootPath || null,
    };
  }

  private readSessionProviderOptionsSourceSnapshot(
    sessionType: ChatSessionType,
  ): ChatSessionProviderOptionsSourceSnapshot | null {
    if (sessionType !== this.currentSessionType) {
      return null;
    }

    return this.boundSessionProviderOptionsSource?.getSnapshot() ?? null;
  }

  private readSourceRepository(
    sourceSnapshot: ChatSessionProviderOptionsSourceSnapshot | null,
    repositoryPath?: string,
  ): ChatSessionProviderOptionsSourceRepository | undefined {
    if (!sourceSnapshot?.repositories.length) {
      return undefined;
    }

    const normalizedRepositoryPath = typeof repositoryPath === 'string'
      ? repositoryPath.trim()
      : '';
    if (normalizedRepositoryPath) {
      const exactMatch = sourceSnapshot.repositories.find((repository) => this.isSameOrEquivalentPath(repository.path, normalizedRepositoryPath));
      if (exactMatch) {
        return exactMatch;
      }

      const containingMatches = sourceSnapshot.repositories
        .filter((repository) => this.isParentPathOf(repository.path, normalizedRepositoryPath))
        .sort((left, right) => right.path.length - left.path.length);
      if (containingMatches.length > 0) {
        return containingMatches[0];
      }

      return sourceSnapshot.repositories[0];
    }

    return sourceSnapshot.repositories[0];
  }

  private isSameOrEquivalentPath(left: string, right: string): boolean {
    return this.normalizeProviderPath(left) === this.normalizeProviderPath(right);
  }

  private isParentPathOf(parent: string, child: string): boolean {
    const normalizedParent = this.normalizeProviderPath(parent);
    const normalizedChild = this.normalizeProviderPath(child);
    if (!normalizedParent || !normalizedChild) {
      return false;
    }

    return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
  }

  private normalizeProviderPath(path: string): string {
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (!normalizedPath) {
      return '';
    }

    return (AilyHost.get().platform?.isWindows ?? false)
      ? normalizedPath.toLowerCase()
      : normalizedPath;
  }

  getRateLimitAutoSwitchToAutoEnabled(): boolean {
    return this.rateLimitAutoSwitchToAuto;
  }

  setRateLimitAutoSwitchToAuto(enabled: boolean): void {
    this.rateLimitAutoSwitchToAuto = enabled === true;
    const config = AilyHost.get().config;
    if (config.data) {
      config.data.aiChatRateLimitAutoSwitchToAuto = this.rateLimitAutoSwitchToAuto;
    }
    config.save?.();
  }

  /**
   * 从配置加载AI模型
   */
  private loadChatModel(): void {
    const savedModel = AilyHost.get().config.data?.aiChatModel;
    const enabledModels = this.ailyChatConfigService.getEnabledModels();
    const savedModelInfo = savedModel as { model?: string; presetId?: string; name?: string } | null | undefined;

    console.info(
      `[AilyChat][ModelState] loadChatModel start savedModel=${savedModelInfo?.model ?? ''}/${savedModelInfo?.presetId ?? ''}/${savedModelInfo?.name ?? ''} enabledCount=${enabledModels.length}`,
    );

    // 重置当前模型，确保每次都重新验证
    this.currentModel = null;

    if (savedModel) {
      this.currentModel = this.ailyChatConfigService.resolveSavedModel(savedModel);
    }

    // 如果没有保存模型或保存的模型不可用，优先回退到内置 Auto preset。
    if (!this.currentModel) {
      this.currentModel = this.ailyChatConfigService.resolveSelectablePresetModel(
        this.ailyChatConfigService.getDefaultModelPresetId(),
      );
    }

    // 如果 Auto preset 也不可用，再回退到第一个已启用的具体模型。
    if (!this.currentModel && enabledModels.length > 0) {
      this.currentModel = enabledModels[0];
    }

    this.currentModel = this.applyPersistedLanguageModelConfiguration(this.currentModel);
    console.info(
      `[AilyChat][ModelState] loadChatModel resolved currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
    );

    this.clearResolvedActiveModel();

    if (this.currentModel) {
      // 更新保存的模型配置，但不要把启动恢复路径计入 recent。
      this.saveChatModel(this.currentModel, { rememberRecent: false });
      return;
    }

    this.contextBudgetService.updateModelContextSize(this.currentModel);
  }

  /**
   * 保存AI模型到配置
   */
  saveChatModel(model: ModelConfig, options?: { rememberRecent?: boolean }): boolean {
    const normalizedModel = this.resolveSelectableRuntimeModel(model);
    console.info('[AilyChat][ModelSwitch] saveChatModel', {
      incomingModel: model,
      normalizedModel,
      rememberRecent: options?.rememberRecent !== false,
    });
    console.info(
      `[AilyChat][ModelSwitch] saveChatModel scalar incoming=${model?.model ?? ''}/${model?.presetId ?? ''}/${model?.name ?? ''} normalized=${normalizedModel?.model ?? ''}/${normalizedModel?.presetId ?? ''}/${normalizedModel?.name ?? ''} rememberRecent=${options?.rememberRecent !== false}`,
    );
    if (!normalizedModel) {
      console.info('[AilyChat][ModelSwitch] saveChatModel rejected model because normalization returned null', {
        incomingModel: model,
      });
      return false;
    }

    this.currentModel = this.applyPersistedLanguageModelConfiguration(normalizedModel);
    console.info('[AilyChat][ModelSwitch] saveChatModel applied currentModel', {
      currentModel: this.currentModel,
    });
    console.info(
      `[AilyChat][ModelSwitch] saveChatModel applied scalar currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
    );
    this.clearResolvedActiveModel();
    this.contextBudgetService.updateModelContextSize(this.currentModel);
    const config = AilyHost.get().config;
    if (config.data) {
      config.data.aiChatModel = this.buildPersistedChatModel(this.currentModel);
      if (options?.rememberRecent !== false) {
        config.data.aiChatRecentModelPresetIds = this.buildNextRecentModelPresetIds(this.currentModel);
      }
    }
    const persistedModel = config.data?.aiChatModel as { model?: string; presetId?: string; name?: string } | null | undefined;
    console.info(
      `[AilyChat][ModelSwitch] saveChatModel persisted scalar aiChatModel=${persistedModel?.model ?? ''}/${persistedModel?.presetId ?? ''}/${persistedModel?.name ?? ''}`,
    );
    config.save?.();
    return true;
  }

  getRecentModelPresetIds(): string[] {
    const rawRecentPresetIds = AilyHost.get().config.data?.aiChatRecentModelPresetIds;
    if (!Array.isArray(rawRecentPresetIds)) {
      return [];
    }

    return [...new Set(rawRecentPresetIds
      .filter((presetId): presetId is string => typeof presetId === 'string')
      .map(presetId => presetId.trim())
      .filter(presetId => presetId.length > 0 && presetId !== this.ailyChatConfigService.getDefaultModelPresetId())
      .filter((presetId) => {
        const preset = this.ailyChatConfigService.getModelPresetById(presetId);
        return !preset || preset.enabled;
      }))]
      .slice(0, ChatService.maxRecentModelPresetIds);
  }

  getPinnedModelIds(): string[] {
    const rawPinnedModelIds = AilyHost.get().config.data?.aiChatPinnedModelIds;
    if (!Array.isArray(rawPinnedModelIds)) {
      return [];
    }

    const defaultPresetId = this.ailyChatConfigService.getDefaultModelPresetId();
    return [...new Set(rawPinnedModelIds
      .filter((modelId): modelId is string => typeof modelId === 'string')
      .map(modelId => modelId.trim())
      .filter(modelId => modelId.length > 0 && modelId !== defaultPresetId)
      .filter((modelId) => {
        const preset = this.ailyChatConfigService.getModelPresetById(modelId);
        return !preset || preset.enabled;
      }))];
  }

  pinModelId(modelId: string): void {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId || normalizedModelId === this.ailyChatConfigService.getDefaultModelPresetId()) {
      return;
    }

    const pinnedModelIds = this.getPinnedModelIds();
    if (pinnedModelIds.includes(normalizedModelId)) {
      return;
    }

    const config = AilyHost.get().config;
    if (config.data) {
      config.data.aiChatPinnedModelIds = [...pinnedModelIds, normalizedModelId];
    }
    config.save?.();
  }

  unpinModelId(modelId: string): void {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!normalizedModelId) {
      return;
    }

    const config = AilyHost.get().config;
    if (config.data) {
      config.data.aiChatPinnedModelIds = this.getPinnedModelIds().filter((id) => id !== normalizedModelId);
    }
    config.save?.();
  }

  isModelPinned(modelId: string): boolean {
    const normalizedModelId = typeof modelId === 'string' ? modelId.trim() : '';
    return !!normalizedModelId && this.getPinnedModelIds().includes(normalizedModelId);
  }

  private buildNextRecentModelPresetIds(model: ModelConfig | null): string[] {
    const presetId = typeof model?.presetId === 'string' ? model.presetId.trim() : '';
    if (!presetId || presetId === this.ailyChatConfigService.getDefaultModelPresetId()) {
      return this.getRecentModelPresetIds();
    }

    return [presetId, ...this.getRecentModelPresetIds().filter(id => id !== presetId)]
      .slice(0, ChatService.maxRecentModelPresetIds);
  }

  private refreshCurrentModelRuntimeMetadata(): void {
    console.info(
      `[AilyChat][ModelState] refreshCurrentModelRuntimeMetadata start currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
    );
    if (this.currentModel) {
      const refreshedModel = this.ailyChatConfigService.resolveSavedModel(this.currentModel);
      if (refreshedModel) {
        this.currentModel = this.applyPersistedLanguageModelConfiguration(refreshedModel);
        console.info(
          `[AilyChat][ModelState] refreshCurrentModelRuntimeMetadata resolved currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
        );
        this.refreshResolvedActiveModelRuntimeMetadata();
        this.contextBudgetService.updateModelContextSize(this.currentModel);
        return;
      }
    }

    this.currentModel = this.ailyChatConfigService.resolveSelectablePresetModel(
      this.ailyChatConfigService.getDefaultModelPresetId(),
    );
    console.info(
      `[AilyChat][ModelState] refreshCurrentModelRuntimeMetadata fallback currentModel=${this.currentModel?.model ?? ''}/${this.currentModel?.presetId ?? ''}/${this.currentModel?.name ?? ''}`,
    );
    this.refreshResolvedActiveModelRuntimeMetadata();
    this.contextBudgetService.updateModelContextSize(this.currentModel);
  }

  private resolveSelectableRuntimeModel(model: ModelConfig | null | undefined): ModelConfig | null {
    if (!model) {
      return null;
    }

    const explicitPresetId = typeof model.presetId === 'string' ? model.presetId.trim() : '';
    const implicitPresetId = !explicitPresetId && typeof model.model === 'string'
      ? this.ailyChatConfigService.getModelPresetById(model.model)?.id ?? ''
      : '';
    const presetId = explicitPresetId || implicitPresetId;
    if (presetId) {
      const selectablePresetModel = this.ailyChatConfigService.resolveSelectablePresetModel(presetId);
      if (!selectablePresetModel) {
        return null;
      }

      return this.ailyChatConfigService.normalizeRuntimeModel({
        ...selectablePresetModel,
        reasoningEffort: model.reasoningEffort ?? selectablePresetModel.reasoningEffort,
      });
    }

    return this.ailyChatConfigService.normalizeRuntimeModel(model);
  }

  private refreshResolvedCurrentMode(): void {
    const builtinModeId = resolveChatSurfaceModeId(this._currentModeId);
    if (builtinModeId) {
      this.updateResolvedModeSelection(
        this.constrainResolvedModeToCurrentSession(createBuiltinChatResolvedMode(builtinModeId)),
      );
      return;
    }

    const previousCustomAgentTarget = this._currentResolvedMode.kind === 'agent'
      ? this._currentResolvedMode.customAgentTarget
      : undefined;
    const normalizedCurrentModeId = typeof this._currentModeId === 'string'
      ? this._currentModeId.trim()
      : '';
    const resolvedMode = this.findRuntimeModeByCustomAgentTarget(previousCustomAgentTarget)
      ?? this.findRuntimeModeByCustomAgentTarget(normalizedCurrentModeId)
      ?? (normalizedCurrentModeId ? this.runtimeModeService.findResolvedModeById(normalizedCurrentModeId) : undefined)
      ?? (normalizedCurrentModeId ? this.runtimeModeService.findResolvedModeByName(normalizedCurrentModeId) : undefined);
    if (resolvedMode) {
      this.updateResolvedModeSelection(this.constrainResolvedModeToCurrentSession(resolvedMode));
      return;
    }

    this.updateResolvedModeSelection(createBuiltinChatResolvedMode('agent'));
  }

  private applyResolvedModeSelection(mode: ChatResolvedMode, storeSelection: boolean): void {
    const constrainedMode = this.constrainResolvedModeToCurrentSession(mode);
    this.updateResolvedModeSelection(constrainedMode);

    if (!storeSelection) {
      return;
    }

    const config = AilyHost.get().config;
    if (config.data) {
      config.data.aiChatMode = mode.kind;
      config.data.aiChatCustomAgentTarget = mode.kind === 'agent' && mode.isBuiltin === false
        ? normalizeAgentIdentifier(mode.customAgentTarget ?? mode.name) || undefined
        : undefined;
    }
    config.save?.();
  }

  private constrainResolvedModeToCurrentSession(mode: ChatResolvedMode): ChatResolvedMode {
    const currentSessionCustomAgentTarget = this.getCurrentSessionCustomAgentTarget();
    if (!currentSessionCustomAgentTarget) {
      return mode;
    }

    if (mode.isBuiltin) {
      return mode.kind === 'agent'
        ? mode
        : createBuiltinChatResolvedMode('agent');
    }

    return mode.target === undefined
      || mode.target === 'undefined'
      || mode.target === currentSessionCustomAgentTarget
      ? mode
      : createBuiltinChatResolvedMode('agent');
  }

  private resolveCompatSelectionMode(selectedMode: ChatSelectedMode): ChatResolvedMode {
    if (selectedMode.modeId !== 'agent' || !selectedMode.customAgentTarget) {
      return createBuiltinChatResolvedMode(selectedMode.modeId);
    }

    return this.findRuntimeModeByCustomAgentTarget(selectedMode.customAgentTarget)
      ?? this.findResolvedModeByName(selectedMode.customAgentTarget)
      ?? resolveChatCurrentMode(selectedMode, {
        resolveAgentModeDefinition: (agentId) => this.runtimeModeService.getRuntimeAgentModeDefinition(agentId),
      });
  }

  private findRuntimeModeByCustomAgentTarget(agentTarget: string | null | undefined): ChatResolvedMode | undefined {
    const normalizedAgentTarget = normalizeAgentIdentifier(agentTarget);
    if (!normalizedAgentTarget) {
      return undefined;
    }

    return this.runtimeModeService.findResolvedModeByCustomAgentTarget(normalizedAgentTarget);
  }

  private updateResolvedModeSelection(mode: ChatResolvedMode): void {
    const previousInputMode = createChatSessionInputModeFromResolvedMode(this._currentResolvedMode);
    const nextInputMode = createChatSessionInputModeFromResolvedMode(mode);
    const didChange = !areChatSessionInputModesEqual(previousInputMode, nextInputMode);

    this._currentModeId = mode.id;
    this._currentResolvedMode = mode;

    if (didChange) {
      this.notifySessionInputStateChanged();
    }
  }

  private notifySessionInputStateChanged(): void {
    this.sessionInputStateChangedSubject.next();
  }

  getActiveDisplayModel(): ModelConfig | null {
    return this.resolvedActiveDisplayModel ?? this.resolvedActiveModel ?? this.currentModel;
  }

  clearResolvedActiveModel(): void {
    this.resolvedActiveModel = null;
    this.resolvedActiveDisplayModel = null;
    this.resolvedActiveModelBillingLabel = undefined;
  }

  private isLegacyContextInfoSession(sessionId: string): boolean {
    return !!sessionId && !sessionId.startsWith('lex-');
  }

  async syncResolvedActiveModelFromContextInfo(sessionId: string): Promise<void> {
    if (!sessionId) {
      this.clearResolvedActiveModel();
      return;
    }

    // /api/v1/context_info only understands legacy stateful sessions stored on the service.
    // Lex stateless sessions use lex-* ids and already stream context budget + response model metadata.
    if (!this.isLegacyContextInfoSession(sessionId)) {
      this.clearResolvedActiveModel();
      return;
    }

    const contextInfo = await this.fetchContextInfo(sessionId);
    if (!contextInfo) {
      return;
    }

    this.resolvedActiveModel = this.ailyChatConfigService.resolveRuntimeModelFromServerModelName(
      contextInfo.model_name,
      { contextWindowTokens: contextInfo.model_context_limit },
    );
    this.resolvedActiveDisplayModel = this.ailyChatConfigService.resolvePresetDisplayModel(contextInfo.model_preset_id)
      ?? this.resolvedActiveModel;
    this.resolvedActiveModelBillingLabel = undefined;

    if (this.resolvedActiveModel) {
      this.contextBudgetService.updateModelContextSize(this.resolvedActiveModel);
      return;
    }

    if (typeof contextInfo.model_context_limit === 'number' && contextInfo.model_context_limit > 0) {
      this.contextBudgetService.maxContextTokens = contextInfo.model_context_limit;
    }
  }

  private applyPersistedLanguageModelConfiguration(model: ModelConfig | null): ModelConfig | null {
    if (!model) {
      return null;
    }

    const modelId = typeof model.presetId === 'string' && model.presetId.trim()
      ? model.presetId.trim()
      : typeof model.model === 'string'
        ? model.model.trim()
        : '';
    if (!modelId) {
      return this.ailyChatConfigService.normalizeRuntimeModel(model);
    }

    const configuredReasoningEffort = this.languageModelsService.getModelConfiguration(modelId)?.['reasoningEffort'];
    if (typeof configuredReasoningEffort !== 'string') {
      return this.ailyChatConfigService.normalizeRuntimeModel(model);
    }

    return this.ailyChatConfigService.normalizeRuntimeModel({
      ...model,
      reasoningEffort: configuredReasoningEffort as ModelConfig['reasoningEffort'],
    });
  }

  private buildPersistedChatModel(model: ModelConfig | null): ModelConfig | null {
    if (!model) {
      return null;
    }

    const { reasoningEffort: _reasoningEffort, ...persistedModel } = model;
    return persistedModel as ModelConfig;
  }

  async syncResolvedActiveModelAfterSuccessfulTurn(
    sessionId: string,
    turnResponses: readonly TurnResponseTurn[],
  ): Promise<void> {
    if (!sessionId) {
      this.clearResolvedActiveModel();
      return;
    }

    if (this.isLegacyContextInfoSession(sessionId)) {
      await this.syncResolvedActiveModelFromContextInfo(sessionId);
      return;
    }

    this.syncResolvedActiveModelFromTurnResponses(turnResponses);
  }

  private syncResolvedActiveModelFromTurnResponses(turnResponses: readonly TurnResponseTurn[]): void {
    for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
      const modelName = getTurnResponseResolvedModelName(turnResponses[index]);
      const presetId = getTurnResponseResolvedPresetId(turnResponses[index]);
      const modelBillingLabel = getTurnResponseResolvedModelBillingLabel(turnResponses[index]);
      if (!modelName && !modelBillingLabel && !presetId) {
        continue;
      }

      this.resolvedActiveModelBillingLabel = modelBillingLabel;
      this.resolvedActiveDisplayModel = presetId
        ? this.ailyChatConfigService.resolvePresetDisplayModel(presetId)
        : null;

      if (!modelName) {
        this.resolvedActiveModel = null;
        if (this.resolvedActiveDisplayModel) {
          return;
        }
        continue;
      }

      this.resolvedActiveModel = this.ailyChatConfigService.resolveRuntimeModelFromServerModelName(modelName);
      if (!this.resolvedActiveDisplayModel) {
        this.resolvedActiveDisplayModel = this.resolvedActiveModel;
      }
      if (this.resolvedActiveModel) {
        this.contextBudgetService.updateModelContextSize(this.resolvedActiveModel);
        return;
      }

      if (this.resolvedActiveDisplayModel) {
        return;
      }
    }

    this.clearResolvedActiveModel();
  }

  private refreshResolvedActiveModelRuntimeMetadata(): void {
    if (!this.resolvedActiveModel) {
      return;
    }

    this.resolvedActiveModel = this.ailyChatConfigService.resolveRuntimeModelFromServerModelName(
      this.resolvedActiveModel.model || this.resolvedActiveModel.name,
      { contextWindowTokens: this.resolvedActiveModel.contextWindowTokens },
    );

    if (this.resolvedActiveDisplayModel?.presetId) {
      this.resolvedActiveDisplayModel = this.ailyChatConfigService.resolvePresetDisplayModel(this.resolvedActiveDisplayModel.presetId);
      return;
    }

    this.resolvedActiveDisplayModel = this.resolvedActiveModel;
  }


  /**
     * 发送文本到聊天组件
     * @param text 要发送的文本内容
     * @param options 发送选项，包含 sender、type、cover 等参数
     */
  sendTextToChat(text: string, options?: ChatTextOptions): void {
    // 设置默认值：cover 默认为 true
    const finalOptions: ChatTextOptions = {
      cover: true,  // 默认覆盖模式
      ...options    // 用户提供的选项会覆盖默认值
    };

    const message: ChatTextMessage = {
      text,
      options: finalOptions,
      timestamp: Date.now()
    };
    this.textSubject.next(message);

    // 发送后滚动到页面底部
  }

  /**
   * 获取文本消息的Observable，供聊天组件订阅
   */
  getTextMessages(): Observable<ChatTextMessage | null> {
    return this.textSubject.asObservable();
  }

  /**
   * 清空已消费的外部消息缓冲，避免 ReplaySubject 在新订阅时重放旧消息。
   */
  clearBufferedTextMessage(timestamp?: number): void {
    if (timestamp == null) {
      this.textSubject.next(null);
      return;
    }

    this.textSubject.next(null);
  }

  /**
   * 静态方法，提供全局访问
   * @param text 要发送的文本内容
   * @param options 发送选项，包含 sender、type、cover 等参数
   */
  static sendToChat(text: string, options?: ChatTextOptions): void {
    if (ChatService.instance) {
      ChatService.instance.sendTextToChat(text, options);
    } else {
      console.warn('ChatService尚未初始化');
    }
  }

  startSession(
    mode: string,
    tools: MCPTool[] | null = null,
    maxCount?: number,
    customllmConfig?: any,
    selectModel?: string,
    customSessionId?: string,
    modelPresetId?: string,
    reasoningEffort?: ModelConfig['reasoningEffort'],
  ): Observable<any> {
    const payload: any = {
      session_id: customSessionId || this.currentSessionId,
      tools: tools || [],
      mode
    };

    const effectiveModelPresetId = modelPresetId ?? this.currentModel?.presetId;
    const effectiveReasoningEffort = reasoningEffort ?? this.currentModel?.reasoningEffort;

    // 如果提供了 maxCount 参数，添加到请求中
    if (maxCount !== undefined && maxCount > 0) {
      payload.max_count = maxCount;
    }

    // 如果提供了自定义LLM配置，添加到请求中
    if (customllmConfig) {
      payload.llm_config = customllmConfig;
    }

    // 如果提供了选择的模型名称，添加到请求中
    if (selectModel) {
      payload.select_model = selectModel;
    }

    if (effectiveModelPresetId) {
      payload.model_preset_id = effectiveModelPresetId;
    }

    if (effectiveReasoningEffort) {
      payload.reasoning_effort = effectiveReasoningEffort;
    }

    return this.http.post(ChatAPI.startSession, payload);
  }

  /**
    * 获取旧版有状态会话的系统提示词 / 工具定义 token 数和模型上下文窗口大小。
    * Lex 无状态会话不走这里，而是依赖流式 context_budget / responseModel 元数据。
   */
  async fetchContextInfo(sessionId: string): Promise<{
    system_tokens: number;
    tools_tokens: number;
    model_context_limit: number;
    model_name?: string;
    model_preset_id?: string;
  } | null> {
    try {
      const token = await AilyHost.get().auth.getToken!();
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const resp = await fetch(`${ChatAPI.contextInfo}/${sessionId}`, { headers });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      console.warn('[ChatService] fetchContextInfo failed:', e);
      return null;
    }
  }

  closeSession(sessionId: string) {
    return this.http.post(`${ChatAPI.closeSession}/${sessionId}`, {});
  }

  getHistory(sessionId: string) {
    return this.http.get(`${ChatAPI.getHistory}/${sessionId}`);
  }

  stopSession(sessionId: string) {
    return this.http.post(`${ChatAPI.stopSession}/${sessionId}`, {});
  }

  cancelTask(sessionId: string) {
    return this.http.post(`${ChatAPI.cancelTask}/${sessionId}`,{});
  }
}

function areChatSessionInputModesEqual(left: ChatSessionInputMode, right: ChatSessionInputMode): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && areChatSessionInputModeInstructionsEqual(left.modeInstructions, right.modeInstructions);
}

function areChatSessionInputModeInstructionsEqual(
  left: ChatSessionInputModeInstructions | undefined,
  right: ChatSessionInputModeInstructions | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  if (left.uri !== right.uri
    || left.name !== right.name
    || left.content !== right.content
    || left.isBuiltin !== right.isBuiltin) {
    return false;
  }

  return areInstructionMetadataEqual(left.metadata, right.metadata);
}

function areInstructionMetadataEqual(
  left: Readonly<Record<string, boolean | string | number>> | undefined,
  right: Readonly<Record<string, boolean | string | number>> | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(key => left[key] === right[key]);
}
