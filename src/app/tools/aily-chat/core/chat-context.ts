/**
 * IChatContext — ChatEngineService 的解耦接口
 *
 * 拆分为 6 个聚焦子接口，IChatContext 继承全部（向后兼容）。
 * 新代码 / Bridge 应尽量依赖最窄的子接口或 Pick<>，减少耦合面积。
 *
 * 子接口：
 * - IAgentLifecycle  — agent 运行时状态标志
 * - IChatViewAccess  — UI 渲染（list / partStore / scrollManager）
 * - ISessionAccess   — 会话身份与持久化
 * - IProjectContext   — 项目/环境/模型配置
 * - IChatServiceAccess — Angular DI 服务容器
 * - IChatCoordination  — Helper 引用 + 协调方法
 *
 * 使用 `import type` 引用 Helper 类型，避免运行时循环依赖。
 */

import type { NgZone } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { NzMessageService } from 'ng-zorro-antd/message';

import type { ChatSurfaceModeId } from './chat-mode';
import type { ChatAgentRuntimeMode, ChatAgentRuntimeModeSource } from './chat-agent-runtime-mode';
import type { ChatService, ModelConfig } from '../services/chat.service';
import type { McpService } from '../services/mcp.service';
import type { AilyChatConfigService } from '../services/aily-chat-config.service';
import type { AilyChatLanguageModelsService } from '../services/aily-chat-language-models.service';
import type { ChatHistoryService } from '../services/chat-history.service';
import type { RepetitionDetectionService } from '../services/repetition-detection.service';
import type { ContextBudgetFacade } from '../services/context-budget-facade';
import type { AbsAutoSyncService } from '../services/abs-auto-sync.service';
import type { EditCheckpointService, IWorkspaceCheckpointProvider } from '../services/edit-checkpoint.service';
import type { ScrollManagerService } from '../services/scroll-manager.service';
import type { ResourceManagerService } from '../services/resource-manager.service';
import type { MenuManagerService } from '../services/menu-manager.service';
import type { ChatViewAdapter } from '../services/chat-view-adapter';
import type { ChatRuntimeOwnerInteractionHostPort } from '../services/chat-runtime-owner-ports';

import type { ChatMessage } from './chat-types';
import type { ChatPartStore } from './chat-part-store';

// Helper 类型（import type 避免运行时循环）
import type { MessageDisplayHelper } from '../helpers/message-display.helper';
import type { SessionLifecycleHelper } from '../helpers/session-lifecycle.helper';
import type { LexOwnerFacade } from '../helpers/lex-stream.helper';
import type { EditActionsHelper } from '../helpers/edit-actions.helper';
import type { UserInteractionHelper } from '../helpers/user-interaction.helper';

// ---------------------------------------------------------------------------
// 1. Agent 运行时状态
// ---------------------------------------------------------------------------

/** Agent 运行时生命周期标志（turn 执行期间变化的状态） */
export interface IAgentLifecycle {
  isCancelled: boolean;
  isCompleted: boolean;
  isWaiting: boolean;
  aiWriting: boolean;
  isSessionStarting: boolean;
  hasInitializedForThisLogin: boolean;
  toolCallingIteration: number;
  activeToolExecutions: number;
  currentStatelessMode: boolean;
  pendingEditFeedback: string | null;
  readPendingEditFeedback?(sessionId?: string | null): string | null;
  writePendingEditFeedback?(sessionId: string | null | undefined, value: string | null): void;
  pendingUserInput: boolean;
  mcpInitialized: boolean;
  lastStopReason: string;
  legacyActivatedDeferredTools: Set<string>;
  currentMessageSource: string;
  messageSubscription: any;
  _pendingModelSwitch: ModelConfig | null;
  _pendingModeSwitch: ChatSurfaceModeId | null;
  _pendingSwitchSessionId: string | null;
}

// ---------------------------------------------------------------------------
// 2. UI 视图访问
// ---------------------------------------------------------------------------

/** UI 渲染相关状态与服务 */
export interface IChatViewAccess {
  list: ChatMessage[];
  inputValue: string;
  toolCallStates: { [key: string]: string };
  readonly partStore: ChatPartStore;
  readonly viewAdapter: ChatViewAdapter;
  readonly scrollManager: ScrollManagerService;
  readonly menuManager: MenuManagerService;
   /** 显式使共享 host request graph/projection 失效 */
  invalidateHostRequestGraph(): void;
  /** 同步触发变更检测 */
  triggerSyncDetectChanges(): void;
  /** 当前可见 transcript attachment generation；live 写入必须匹配该 generation。 */
  readVisibleTranscriptAttachmentGeneration?(sessionId?: string | null): number | null;
}

// ---------------------------------------------------------------------------
// 3. 会话身份与持久化
// ---------------------------------------------------------------------------

/** 会话标识、历史与持久化 */
export interface ISessionAccess {
  sessionId: string;
  readonly sessionTitle: string;
  sessionAllowedPaths: string[];
  readonly conversationMessages: any[];
  readonly chatService: ChatService;
  readonly chatHistoryService: ChatHistoryService;
}

// ---------------------------------------------------------------------------
// 4. 项目/环境/模型上下文
// ---------------------------------------------------------------------------

/** 项目路径、用户身份与模型配置 */
export interface IProjectContext {
  prjRootPath: string;
  prjPath: string;
  currentUserGroup: string[];
  isLoggedIn: boolean;
  debug: boolean;
  readonly currentMode: ChatSurfaceModeId;
  readonly currentAgentRuntimeMode: ChatAgentRuntimeMode;
  readonly currentAgentRuntimeModeSource: ChatAgentRuntimeModeSource;
  readonly currentModel: ModelConfig;
  readonly currentModelName: string | undefined;
  readonly currentModelBillingLabel?: string;
  /** 获取当前项目路径 */
  getCurrentProjectPath(): string;
}

// ---------------------------------------------------------------------------
// 5. Angular 服务容器
// ---------------------------------------------------------------------------

/** 注入的 Angular 服务集合 */
export interface IChatServiceAccess {
  readonly ailyChatConfigService: AilyChatConfigService;
  readonly languageModelsService: AilyChatLanguageModelsService;
  readonly mcpService: McpService;
  readonly editCheckpointService: EditCheckpointService;
  readonly workspaceCheckpointProvider?: IWorkspaceCheckpointProvider;
  readonly contextBudgetService: ContextBudgetFacade;
  readonly repetitionDetectionService: RepetitionDetectionService;
  readonly absAutoSyncService: AbsAutoSyncService;
  readonly ngZone: NgZone;
  readonly translate: TranslateService;
  readonly message: NzMessageService;
  readonly resourceManager: ResourceManagerService;
  readonly runtimeInteractionHost: ChatRuntimeOwnerInteractionHostPort;
}

// ---------------------------------------------------------------------------
// 6. Helper 引用与协调方法
// ---------------------------------------------------------------------------

/** Helper 实例引用 + Engine 级别协调方法 */
export interface IChatCoordination {
  readonly msg: MessageDisplayHelper;
  readonly session: SessionLifecycleHelper;
  readonly lexStream: LexOwnerFacade;
  readonly editActions: EditActionsHelper;
  readonly interaction: UserInteractionHelper;
  openSettings(): void;
  /** 将 lex runtime 的 custom-agent provider source 绑定给宿主 runtime mode owner。 */
  syncCustomAgentProviderSource?(agentModeSource: unknown): void;
  /** 将 session customization provider binding（metadata + itemProvider）绑定给宿主 runtime mode owner。 */
  syncSessionCustomizationProvider?(providerBinding: unknown): void;
  /** 将多个按 sessionType 分开的 session customization provider binding 绑定给宿主 runtime mode owner。 */
  syncSessionCustomizationProviders?(providerBindings: readonly unknown[]): void;
  /** 将 session customization content owner 绑定给宿主 runtime mode owner。 */
  syncSessionCustomizationContentProvider?(contentProvider: unknown): void;
  /** 将 session provider-options source 绑定给宿主 session/provider option owner。 */
  syncSessionProviderOptionsSource?(sourceBinding: unknown): void;
  /** 将多个按 sessionType 分开的 session provider-options source 绑定给宿主 session/provider option owner。 */
  syncSessionProviderOptionsSources?(sourceBindings: readonly unknown[]): void;
  /** 将 lex runtime 当前 custom-agent provider 暴露的 agent definition 列表同步给宿主 current mode resolver。 */
  syncCustomAgentProviderModes?(agentModes: readonly unknown[]): void;
  /** 将 lex runtime 当前已注册 agent 列表同步给视图层。 */
  syncRegisteredAgentNames?(agentNames: readonly string[]): void;
  /** 发送消息 */
  send(sender: string, content: string, clear?: boolean, sessionId?: string | null): Promise<void>;
  /** 应用延迟的模型/模式切换 */
  applyPendingSwitch(sessionId?: string | null): Promise<void>;
  /** 工具审批桥接（委托到 interaction） */
  handleToolApproval(
    request: import('../helpers/tool-approval-ui').ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }>;
  checkToolApprovalPreflight(
    request: import('../helpers/tool-approval-ui').ToolApprovalRequest,
  ): Promise<{ approved: true } | { approved: false; reason?: string }>;
}

// ---------------------------------------------------------------------------
// 完整接口（向后兼容 — 继承全部子接口）
// ---------------------------------------------------------------------------

/**
 * ChatEngineService implements IChatContext。
 *
 * 新代码应尽量依赖最窄的子接口：
 * - 仅需 partStore → Pick<IChatViewAccess, 'partStore'>
 * - 仅需 session 保存 → ISessionAccess & Pick<IChatServiceAccess, 'editCheckpointService' | 'contextBudgetService'>
 * - 跨切面 bridge → IChatContext（完整）
 */
export interface IChatContext extends
  IAgentLifecycle,
  IChatViewAccess,
  ISessionAccess,
  IProjectContext,
  IChatServiceAccess,
  IChatCoordination {}
