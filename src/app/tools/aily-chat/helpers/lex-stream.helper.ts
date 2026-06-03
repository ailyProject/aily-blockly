/**
 * LexOwnerFacade — aily-lex 核心引擎
 *
 * aily-blockly 到 aily-lex 的主路径桥接层，
 * 统一承接 LLM 调用、事件处理和 host 侧状态同步。
 *
 * 设计要点：
 * - 动态 import(`aily-lex`) 避免硬依赖
 * - 复用引擎的 MessageDisplayHelper / ChatViewAdapter 做显示
 * - 复用 lex TurnManager 做持久化
 * - 工具执行由 lex 核心 + contributed tools (IHostToolProvider) 处理
 */

import type { IChatCoordination, IChatServiceAccess, ISessionAccess } from '../core/chat-context';
import { PartEventProcessor } from '../core/part-event-processor';
import { ChatPartStore } from '../core/chat-part-store';
import {
  bootstrapBlocklyLexAgent,
  type BootstrapLexAgentContext,
} from './lex-agent-bootstrap';
import { LexAgentLifecycleBridge } from './lex-agent-lifecycle-bridge';
import { LexTurnSessionBridge } from './lex-turn-session-bridge';
import { LexAskConfirmationBridge } from './lex-ask-confirmation-bridge';
import { LexHostSyncBridge } from './lex-host-sync-bridge';
import { LexMessageLifecycleBridge } from './lex-message-lifecycle-bridge';
import { LexUiEventBridge } from './lex-ui-event-bridge';
import { LexTurnStartupBridge } from './lex-turn-startup-bridge';
import { LexTurnExecutionBridge } from './lex-turn-execution-bridge';
import { LexTurnRuntimeBridge } from './lex-turn-runtime-bridge';
import { LexTurnControlBridge } from './lex-turn-control-bridge';
import { LexSessionPersistenceBridge } from './lex-session-persistence-bridge';
import { LexRuntimeConfigBridge } from './lex-runtime-config-bridge';
import { LexRenderEventBridge } from './lex-render-event-bridge';
import { LexSessionRestoreBridge } from './lex-session-restore-bridge';
import { LexSessionFacade } from './lex-session-facade';
import type { IMetricsService, MetricsSnapshot, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import type { IHostStreamListener } from './host-turn-response-state';
import type { HostSessionSaveTarget } from './host-session-save-bridge';

type LexOwnerRenderBridge = Parameters<LexTurnExecutionBridge['setRenderEventBridge']>[0] & {
  readonly turnResponses: readonly TurnResponseTurn[];
  finalizeCurrentTurn(fallbackStatus?: TurnResponseStatus): boolean;
  hydrateTurnResponses(turnResponses: readonly TurnResponseTurn[]): void;
  setHostStreamListener(listener: IHostStreamListener | null): void;
  clearSessionState(): void;
};

type LexOwnerAgentAccess = Pick<LexAgentLifecycleBridge, 'ensureAgent' | 'isConfiguredFor' | 'loadModule' | 'stop' | 'dispose' | 'disposeAll' | 'getAgent' | 'getHandle' | 'getSessionIds'>;
type LexOwnerConversationAccess = Pick<LexTurnSessionBridge, 'messages'>;
type LexOwnerUiAccess = Pick<LexUiEventBridge, 'presentQuestion' | 'updateQuestionAnswers' | 'presentConfirmation' | 'resolveConfirmation' | 'presentToolCallApproval' | 'resolveToolCallApproval' | 'processEvent'>;
type LexOwnerTurnAccess = Pick<LexTurnRuntimeBridge, 'begin' | 'run' | 'draft' | 'ensureMessage' | 'appendError'>;
type LexOwnerTurnControlAccess = Pick<
  LexTurnControlBridge,
  'currentId' | 'turnIdByRound' | 'requestContent' | 'lastRoundId' | 'complete' | 'discardIncomplete' | 'removeFrom' | 'restartFrom' | 'clear'
>;
type LexOwnerRuntimeAccess = Pick<LexRuntimeConfigBridge, 'tools' | 'llmConfig'>;
type LexOwnerSessionAccess = Pick<LexSessionFacade, 'save' | 'snapshot' | 'resolveRestorePlan' | 'restoreResolvedSnapshot' | 'restore'>;
type LexOwnerMessageLifecycleAccess = Pick<LexMessageLifecycleBridge, 'resetTurnState' | 'currentMessageHandle'>;
type LexOwnerExecutionAccess = Pick<LexTurnExecutionBridge, 'flushPendingEvents'>;
type LexOwnerPendingEventAccess = Pick<LexSessionPersistenceBridge, 'drainPendingEvents'>;

// aily-lex 类型按需获取（运行时动态加载，编译期仅用 type import）
type AilyLexModule = import('./lex-agent-bootstrap').AilyLexModule;

type LexOwnerContext = BootstrapLexAgentContext
  & Pick<IChatCoordination, 'lexStream' | 'openSettings' | 'syncCustomAgentProviderSource' | 'syncCustomAgentProviderModes' | 'syncRegisteredAgentNames'>
  & Pick<IChatServiceAccess, 'runtimeInteractionHost'>
  & Pick<ISessionAccess, 'sessionTitle' | 'chatService'>
  & {
    buildExecutionSaveTarget?(sessionId: string | null | undefined): HostSessionSaveTarget | null;
    resolveActiveRuntimeSessionId?(): string | null | undefined;
    syncExecutionRuntimeTurnResponses(
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[] | null | undefined,
    ): void;
    readSessionRuntimeState?(
      sessionId: string | null | undefined,
    ): { readonly turnResponses?: readonly TurnResponseTurn[] } | undefined;
  }
  & ConstructorParameters<typeof LexHostSyncBridge>[0]
  & ConstructorParameters<typeof LexMessageLifecycleBridge>[0]
  & ConstructorParameters<typeof LexUiEventBridge>[0]
  & ConstructorParameters<typeof LexTurnStartupBridge>[0]
  & ConstructorParameters<typeof LexTurnExecutionBridge>[0]
  & ConstructorParameters<typeof LexRuntimeConfigBridge>[0]
  & ConstructorParameters<typeof LexRenderEventBridge>[0];

export class LexOwnerFacade {
  /** lex 模块/agent 生命周期桥 */
  private readonly _agentLifecycleBridge: LexOwnerAgentAccess;
  /** turn/session 适配桥，封装 lex TurnManager 与 OpenAI 形状转换 */
  private readonly _turnBridge: LexOwnerConversationAccess;
  /** assistant 消息生命周期桥 */
  private readonly _messageLifecycleBridge: LexOwnerMessageLifecycleAccess;
  /** lex -> UI 统一事件入口 */
  private readonly _uiEventBridge: LexOwnerUiAccess;
  /** turn 执行编排桥 */
  private readonly _turnExecutionBridge: LexOwnerExecutionAccess;
  /** turn runtime 桥，聚合 startup/execution/ui 生命周期入口 */
  private readonly _turnRuntimeBridge: LexOwnerTurnAccess;
  /** turn 控制桥，封装 turn 历史的直接修改/完成操作 */
  private readonly _turnControlBridge: LexOwnerTurnControlAccess;
  /** session 持久化桥，封装 save/restore 与挂起事件冲刷 */
  private readonly _sessionPersistenceBridge: LexOwnerPendingEventAccess;
  /** runtime 配置桥，封装 host tools 与 llm config 读取 */
  private readonly _runtimeConfigBridge: LexOwnerRuntimeAccess;
  /** 会话 owner façade，聚合持久化与 persisted restore */
  private readonly _sessionFacade: LexOwnerSessionAccess;
  /** live turn-native 响应聚合器 */
  private readonly _renderEventBridge: LexOwnerRenderBridge;
  /** host-owned compaction metrics reused across same-session agent rebuilds */
  private _compactionMetricsService: IMetricsService | null = null;
  private _compactionMetricsSessionId: string | null = null;

  get agent(): LexOwnerAgentAccess {
    return this._agentLifecycleBridge;
  }

  get turns(): LexOwnerTurnControlAccess {
    return this._turnControlBridge;
  }

  get turn(): LexOwnerTurnAccess {
    return this._turnRuntimeBridge;
  }

  get conversation(): LexOwnerConversationAccess {
    return this._turnBridge;
  }

  get ui(): LexOwnerUiAccess {
    return this._uiEventBridge;
  }

  get runtime(): LexOwnerRuntimeAccess {
    return this._runtimeConfigBridge;
  }

  get session(): LexOwnerSessionAccess {
    return this._sessionFacade;
  }

  get compactionMetricsSnapshot(): MetricsSnapshot | null {
    return this._compactionMetricsService?.snapshot()
      ?? this._agentLifecycleBridge.getHandle()?.getMetricsSnapshot?.()
      ?? this._agentLifecycleBridge.getAgent()?.getMetricsSnapshot?.()
      ?? null;
  }

  get turnResponses(): readonly TurnResponseTurn[] {
    return this._renderEventBridge.turnResponses;
  }

  hydrateTurnResponses(turnResponses: readonly TurnResponseTurn[]): void {
    this._renderEventBridge.hydrateTurnResponses(turnResponses);
  }

  finalizeCurrentTurnResponse(fallbackStatus: TurnResponseStatus = 'completed'): boolean {
    return this._renderEventBridge.finalizeCurrentTurn(fallbackStatus);
  }

  async compactConversation(): Promise<boolean> {
    const changed = await this._agentLifecycleBridge.getHandle()?.compactConversationOnDemand?.()
      ?? await this._agentLifecycleBridge.getAgent()?.compactConversationOnDemand?.()
      ?? await this._agentLifecycleBridge.getHandle()?.compactIfNeededForFinalize()
      ?? await this._agentLifecycleBridge.getAgent()?.compactIfNeededForFinalize?.()
      ?? false;
    this._flushPendingEvents();
    return changed;
  }

  /** H1: wire a host stream listener into the render bridge so host-side consumers
   *  receive incremental turn events without polling turnResponses on every CD cycle. */
  setHostStreamListener(listener: IHostStreamListener | null): void {
    this._renderEventBridge.setHostStreamListener(listener);
  }

  resetSessionState(): void {
    this.ctx.invalidateHostRequestGraph();
    this._messageLifecycleBridge.resetTurnState();
    this._renderEventBridge.clearSessionState();
  }

  /**
   * 优先从 lex 默认 SessionStorage 恢复；若不存在标准 snapshot，则回退到旧 blockly turns。
   *
   * 这样 SessionLifecycleHelper 不再需要理解旧格式 turns 的具体结构。
   */
  constructor(private ctx: LexOwnerContext) {
    const askConfirmationBridge = new LexAskConfirmationBridge(this.ctx);
    const hostSyncBridge = new LexHostSyncBridge(this.ctx);
    const agentLifecycleBridge = new LexAgentLifecycleBridge({
      getSessionId: () => this.ctx.resolveActiveRuntimeSessionId?.() ?? this.ctx.sessionId,
      loadModule: () => import('aily-lex/browser'),
      createAgent: (lex, sessionId) => bootstrapBlocklyLexAgent({
        ctx: this.ctx,
        lex,
        sessionId,
        metrics: this._resolveCompactionMetricsService(lex, sessionId),
        askHandler: (askContext) => askConfirmationBridge.handleAskConfirmation(askContext),
        onSubagentEvent: (event) => this._uiEventBridge.processEvent(event, 'subagent'),
      }),
      onAgentReady: (agent, _lex, currentTodoUnsubscribe) => {
        this._flushPendingEvents();

        const registeredAgentModes = agent.agentModeManager.getAll();
        if (this.ctx.syncCustomAgentProviderSource) {
          this.ctx.syncCustomAgentProviderSource(agent.agentModeManager);
        } else if (this.ctx.syncCustomAgentProviderModes) {
          this.ctx.syncCustomAgentProviderModes(registeredAgentModes);
        } else {
          this.ctx.syncRegisteredAgentNames?.(
            registeredAgentModes.map(definition => definition.agentType),
          );
        }

        try {
          const fileHistory = agentLifecycleBridge.getHandle()?.getFileHistory()
            ?? agent.getFileHistory();
          this.ctx.editCheckpointService.setFileHistory(fileHistory);
        } catch {
          // ignore if agent not ready
        }

        this.ctx.editCheckpointService.setTimelineContext(
          this.ctx.resolveActiveRuntimeSessionId?.() ?? this.ctx.sessionId ?? null,
          this.ctx.prjPath || this.ctx.prjRootPath || null,
        );

        currentTodoUnsubscribe?.();
        return null;
      },
    });
    this._agentLifecycleBridge = agentLifecycleBridge;
    const turnBridge = new LexTurnSessionBridge(() => agentLifecycleBridge.getAgent());
    this._turnBridge = turnBridge;
    const turnControlBridge = new LexTurnControlBridge(turnBridge);
    this._turnControlBridge = turnControlBridge;
    const runtimeConfigBridge = new LexRuntimeConfigBridge(this.ctx);
    this._runtimeConfigBridge = runtimeConfigBridge;
    const sessionPersistenceBridge = new LexSessionPersistenceBridge({
      getHandle: (sessionId) => agentLifecycleBridge.getHandle(sessionId),
      getAgent: (sessionId) => agentLifecycleBridge.getAgent(sessionId),
      flushPendingEvents: (events) => {
        this._turnExecutionBridge.flushPendingEvents(events);
      },
    });
    this._sessionPersistenceBridge = sessionPersistenceBridge;
    const sessionRestoreBridge = new LexSessionRestoreBridge({
      ensureAgent: (sessionId) => agentLifecycleBridge.ensureAgent(sessionId),
      getLex: () => agentLifecycleBridge.getLex(),
      getCwd: () => this.ctx.prjPath || this.ctx.prjRootPath || '',
      restoreSnapshot: (snapshot) => sessionPersistenceBridge.restoreSession(snapshot),
    });
    this._sessionFacade = new LexSessionFacade(
      sessionPersistenceBridge,
      sessionRestoreBridge,
    );
    const partProcessor = new PartEventProcessor(
      this.ctx.partStore,
      () => this._messageLifecycleBridge.currentMessageHandle,
    );
    const messageLifecycleBridge = new LexMessageLifecycleBridge(
      this.ctx,
      partProcessor,
      async () => agentLifecycleBridge.getHandle()?.compactIfNeededForFinalize()
        ?? await agentLifecycleBridge.getAgent()?.compactIfNeededForFinalize?.()
        ?? false,
      (fallbackStatus) => this._renderEventBridge.finalizeCurrentTurn(fallbackStatus),
      () => this._renderEventBridge.turnResponses,
    );
    this._messageLifecycleBridge = messageLifecycleBridge;
    const renderEventBridge = new LexRenderEventBridge(
      this.ctx,
      hostSyncBridge,
      messageLifecycleBridge,
      () => turnControlBridge.snapshot(),
    );
    this._renderEventBridge = renderEventBridge;
    const uiEventBridge = new LexUiEventBridge(
      this.ctx,
      partProcessor,
      hostSyncBridge,
      messageLifecycleBridge,
      renderEventBridge,
    );
    this._uiEventBridge = uiEventBridge;
    const turnStartupBridge = new LexTurnStartupBridge(
      this.ctx,
      (userMessage, displayContent, metadata) => turnControlBridge.start(userMessage, displayContent, metadata),
      (turnId, userMessage, displayContent, metadata) => renderEventBridge.seedPendingTurn(turnId, userMessage, displayContent, metadata),
      () => uiEventBridge.ensureAilyMessage(),
      () => turnBridge.messages(),
      () => runtimeConfigBridge.tools(),
    );
    const turnExecutionBridge = new LexTurnExecutionBridge(
      this.ctx,
      uiEventBridge,
      (sessionId, controller) => {
        agentLifecycleBridge.setAbortController(sessionId, controller);
      },
      (sessionId) => {
        agentLifecycleBridge.setAbortController(sessionId, null);
      },
      () => this.ctx.sessionId,
      () => turnControlBridge.currentRequestMetadata(),
      (sessionId): HostSessionSaveTarget | null => {
        const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
          ? sessionId.trim()
          : '';
        if (!targetSessionId) {
          return null;
        }

        const runtimeScopedTarget = this.ctx.buildExecutionSaveTarget?.(targetSessionId);
        if (runtimeScopedTarget) {
          return runtimeScopedTarget;
        }

        const chatService = this.ctx.chatService;
        if (!chatService) {
          return null;
        }

        const sessionTitleCandidate = typeof chatService.readCurrentSessionTitleCandidate === 'function'
          ? chatService.readCurrentSessionTitleCandidate()
          : {
            text: this.ctx.sessionTitle || '',
            source: chatService.currentSessionTitleSource,
            revision: chatService.currentSessionTitleRevision,
          };

        return {
          sessionId: targetSessionId,
          sessionTitleCandidate,
          sessionType: chatService.currentSessionType,
          providerOptions: {
            folderPath: chatService.currentSessionPath || null,
            permissionMode: chatService.currentSessionPermissionMode,
            ...(chatService.currentSessionPermissionLevel
              ? { permissionLevel: chatService.currentSessionPermissionLevel }
              : {}),
          },
          selectedMode: chatService.selectedMode,
          resolvedMode: chatService.currentResolvedMode,
          model: this.ctx.currentModel ? { ...this.ctx.currentModel } : null,
        };
      },
      (sessionId) => agentLifecycleBridge.saveSession(sessionId),
      (sessionId) => {
        const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(sessionId)?.turnResponses;
        if (runtimeTurnResponses && runtimeTurnResponses.length > 0) {
          return runtimeTurnResponses;
        }
        const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        const currentSessionId = typeof this.ctx.sessionId === 'string' ? this.ctx.sessionId.trim() : '';
        if (!targetSessionId || targetSessionId === currentSessionId) {
          return renderEventBridge.turnResponses.length > 0
            ? renderEventBridge.turnResponses
            : this.ctx.lexStream.turnResponses;
        }
        return [];
      },
      (sessionId, turnResponses) => {
        this.ctx.syncExecutionRuntimeTurnResponses?.(sessionId, turnResponses);
      },
      (sessionId, seedTurnResponses) => {
        const detachedPartStore = new ChatPartStore();
        let detachedList: any[] = [];
        const ownerCtx = this.ctx;
        const detachedRenderEventBridge = new LexRenderEventBridge(
          {
            get partStore() { return detachedPartStore; },
            get list() { return detachedList; },
            set list(value) { detachedList = Array.isArray(value) ? value : []; },
            invalidateHostRequestGraph: () => {},
            triggerSyncDetectChanges: () => {},
            get toolCallingIteration() { return ownerCtx.toolCallingIteration; },
            set toolCallingIteration(value) { ownerCtx.toolCallingIteration = value; },
            get isCancelled() { return ownerCtx.isCancelled; },
            get currentMessageSource() { return ownerCtx.currentMessageSource; },
            get contextBudgetService() { return ownerCtx.contextBudgetService; },
          },
          hostSyncBridge,
          {
            ensureAilyMessage: () => {},
            get currentMessageHandle() { return null; },
          },
          () => agentLifecycleBridge.getSessionSnapshot(sessionId),
        );
        detachedRenderEventBridge.hydrateTurnResponses(seedTurnResponses);
        return detachedRenderEventBridge;
      },
      () => this.ctx.resolveActiveRuntimeSessionId?.() ?? this.ctx.sessionId,
    );
    this._turnExecutionBridge = turnExecutionBridge;
    // Activate the RenderEvent path: wire the render bridge into execution
    turnExecutionBridge.setRenderEventBridge(renderEventBridge);
    this._turnRuntimeBridge = new LexTurnRuntimeBridge(
      agentLifecycleBridge,
      turnStartupBridge,
      turnExecutionBridge,
      uiEventBridge,
    );
  }

  private _flushPendingEvents(): void {
    this._turnExecutionBridge.flushPendingEvents(this._sessionPersistenceBridge.drainPendingEvents());
  }

  private _resolveCompactionMetricsService(lex: AilyLexModule, sessionId: string): IMetricsService {
    if (!this._compactionMetricsService || this._compactionMetricsSessionId !== sessionId) {
      this._compactionMetricsService = new lex.InMemoryMetricsService();
      this._compactionMetricsSessionId = sessionId;
    }

    return this._compactionMetricsService;
  }
}

