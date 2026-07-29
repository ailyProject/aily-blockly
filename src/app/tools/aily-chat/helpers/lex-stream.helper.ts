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
import type { IMetricsService, MetricsSnapshot, RenderEvent, TurnRequest, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import type { IHostStreamListener } from './host-turn-response-state';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import type { HostItemLifecycleTextDeltaPolicy } from './lex-render-host-stream-emitter';
import {
  terminalTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';
import { buildTurnResponsesFromSessionSnapshot } from '../core/turn-response-builder';
import { extractChatAgentRuntimeModeFromConfigKey } from '../core/chat-agent-runtime-mode';

type LexOwnerRenderBridge = Parameters<LexTurnExecutionBridge['setRenderEventBridge']>[0] & {
  readonly turnResponses: readonly TurnResponseTurn[];
  finalizeCurrentTurn(fallbackStatus?: TurnResponseStatus): boolean;
  hydrateTurnResponses(turnResponses: readonly TurnResponseTurn[]): void;
  setProjectionSessionResource(sessionResource: string | null | undefined, visibleAttachmentGeneration?: number | null): void;
  setHostStreamListener(listener: IHostStreamListener | null): void;
  setHostItemTextDeltaDeliveryPolicy(turnId: string, policy: HostItemLifecycleTextDeltaPolicy | null, itemId?: string | null): void;
  clearSessionState(): void;
};

export type LexTurnResponsesHydrationVisibility = 'visibleAttach' | 'detached';

type LexOwnerAgentAccess = Pick<LexAgentLifecycleBridge, 'ensureAgent' | 'activateSession' | 'isConfiguredFor' | 'loadModule' | 'stop' | 'dispose' | 'disposeAll' | 'getAgent' | 'getHandle' | 'getSessionIds'>;
type LexOwnerConversationAccess = Pick<LexTurnSessionBridge, 'messages'>;
type LexOwnerUiAccess = Pick<LexUiEventBridge, 'presentQuestion' | 'updateQuestionAnswers' | 'presentConfirmation' | 'resolveConfirmation' | 'presentToolCallApproval' | 'resolveToolCallApproval' | 'processEvent'>;
type LexOwnerTurnAccess = Pick<LexTurnRuntimeBridge, 'begin' | 'run' | 'draft' | 'ensureMessage' | 'appendError'>;
type LexOwnerTurnControlAccess = Pick<
  LexTurnControlBridge,
  'currentId' | 'currentIndex' | 'turnIdByRound' | 'requestContent' | 'lastRoundId' | 'currentRequestMetadata' | 'complete' | 'fail' | 'discardIncomplete' | 'removeFrom' | 'removeFromIndex' | 'restartFrom' | 'clear'
>;
type LexOwnerRuntimeAccess = Pick<LexRuntimeConfigBridge, 'tools' | 'llmConfig'>;
type LexOwnerSessionAccess = Pick<LexSessionFacade, 'save' | 'snapshot' | 'forkSnapshot' | 'resolveRestorePlan' | 'restoreResolvedSnapshot' | 'restore'>;
type LexOwnerMessageLifecycleAccess = Pick<LexMessageLifecycleBridge, 'resetTurnState' | 'currentResponseHandle'>;
type LexOwnerExecutionAccess = Pick<LexTurnExecutionBridge, 'flushPendingEvents'>;
type LexOwnerPendingEventAccess = Pick<LexSessionPersistenceBridge, 'drainPendingEvents'>;

// aily-lex 类型按需获取（运行时动态加载，编译期仅用 type import）
type AilyLexModule = import('./lex-agent-bootstrap').AilyLexModule;

export type LexOwnerContext = BootstrapLexAgentContext
  & Pick<IChatCoordination, 'lexStream' | 'syncCustomAgentProviderSource' | 'syncCustomAgentProviderModes' | 'syncRegisteredAgentNames'>
  & Pick<IChatServiceAccess, 'runtimeInteractionHost'>
  & Pick<ISessionAccess, 'sessionTitle'>
  & {
    buildExecutionSaveTarget?(sessionId: string | null | undefined): HostSessionSaveTarget | null;
    resolveActiveRuntimeSessionId?(): string | null | undefined;
    syncExecutionRuntimeTurnResponses(
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[] | null | undefined,
      options: ChatRuntimeTurnResponseSyncOptions,
    ): void;
    readSessionTurnResponses?(sessionId: string | null | undefined): readonly TurnResponseTurn[];
    suppressVisibleTurnStartupProjection?: boolean;
    emitExecutionRenderEvent?(
      sessionId: string | null | undefined,
      event: RenderEvent,
      request?: {
        readonly sessionId: string;
        readonly requestText: string;
        readonly displayText?: string;
        readonly metadata?: TurnRequest['metadata'] | null;
        readonly activeResponseHandle?: unknown;
      } | null,
    ): void;
    appendSessionModelTurnResponse?(
      sessionId: string | null | undefined,
      turnResponse: TurnResponseTurn,
      ownerPolicy?: { readonly allowForkedTurns?: boolean; readonly source?: string },
    ): readonly TurnResponseTurn[] | null;
    syncRuntimeHostSubmitReadiness?(sessionId: string | null | undefined): void;
    syncRuntimeAgentEntryReady?(
      sessionId: string | null | undefined,
      disposeSession: () => void,
    ): void;
    releaseRuntimeHandle?(sessionId: string | null | undefined): boolean;
    setRuntimeAbortController?(
      sessionId: string | null | undefined,
      controller: AbortController | null,
    ): boolean;
    scheduleLexRequestCompleted?(input: {
      sessionId: string;
      turnId: string;
      reason: string;
      runWorkspaceFinalize: () => Promise<void>;
      runSessionEndHooks: () => Promise<void>;
    }): void;
    readSessionRuntimeState?(
      sessionId: string | null | undefined,
    ): {
      readonly turnResponses?: readonly TurnResponseTurn[];
      readonly yieldRequested?: boolean;
    } | undefined;
    runWithRuntimeSessionOwner?<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
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

  getTurnResponses(sessionId: string): readonly TurnResponseTurn[] {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return [];
    }

    const snapshotTurnResponses = this.readCanonicalSessionSnapshotTurnResponses(targetSessionId);
    if (hasAuthoritativeResponseModel(snapshotTurnResponses)) {
      return snapshotTurnResponses;
    }

    if (this.isRenderEventBridgeProjectedToSession(targetSessionId)) {
      return this._renderEventBridge.turnResponses;
    }

    if (snapshotTurnResponses.length > 0) {
      return snapshotTurnResponses;
    }

    return this.ctx.readSessionRuntimeState?.(targetSessionId)?.turnResponses ?? [];
  }

  hydrateTurnResponses(
    sessionId: string | null | undefined,
    turnResponses: readonly TurnResponseTurn[],
    options: { readonly visibility?: LexTurnResponsesHydrationVisibility } = {},
  ): void {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const visibility = options.visibility ?? (
      targetSessionId && !this.isVisibleAttachedSession(targetSessionId)
        ? 'detached'
        : 'visibleAttach'
    );

    if (visibility !== 'visibleAttach' || (targetSessionId && !this.isVisibleAttachedSession(targetSessionId))) {
      this.ctx.syncExecutionRuntimeTurnResponses?.(
        targetSessionId || null,
        turnResponses,
        terminalTranscriptProjection('restore'),
      );
      return;
    }

    this._renderEventBridge.setProjectionSessionResource?.(
      targetSessionId || null,
      targetSessionId
        ? this.ctx.readRuntimeViewAttachmentGeneration?.(targetSessionId) ?? null
        : null,
    );
    this._renderEventBridge.hydrateTurnResponses(turnResponses);
    if (targetSessionId) {
      this.ctx.syncExecutionRuntimeTurnResponses?.(
        targetSessionId,
        turnResponses,
        terminalTranscriptProjection('restore'),
      );
    }
  }

  finalizeCurrentTurnResponse(fallbackStatus: TurnResponseStatus = 'completed'): boolean {
    return this._renderEventBridge.finalizeCurrentTurn(fallbackStatus);
  }

  /** H1: wire a host stream listener into the render bridge so host-side consumers
   *  receive incremental turn events without polling turnResponses on every CD cycle. */
  setHostStreamListener(listener: IHostStreamListener | null): void {
    this._renderEventBridge.setHostStreamListener(listener);
  }

  setHostItemTextDeltaDeliveryPolicy(
    turnId: string,
    policy: HostItemLifecycleTextDeltaPolicy | null,
    itemId?: string | null,
  ): void {
    this._renderEventBridge.setHostItemTextDeltaDeliveryPolicy(turnId, policy, itemId);
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
      createAgent: (lex, sessionId, configKey) => bootstrapBlocklyLexAgent({
        ctx: this.ctx,
        lex,
        sessionId,
        runtimeMode: extractChatAgentRuntimeModeFromConfigKey(configKey),
        metrics: this._resolveCompactionMetricsService(lex, sessionId),
        askHandler: (askContext) => askConfirmationBridge.handleAskConfirmation(askContext),
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

        currentTodoUnsubscribe?.();
        return null;
      },
      onEntryReady: (entry) => {
        this.ctx.syncRuntimeAgentEntryReady?.(entry.sessionId, entry.disposeSession);
      },
      onEntryDisposed: (sessionId) => {
        this.ctx.releaseRuntimeHandle?.(sessionId);
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
      ensureAgent: (sessionId, options) => agentLifecycleBridge.ensureAgent(sessionId, undefined, options),
      getLex: () => agentLifecycleBridge.getLex(),
      getCwd: () => this.ctx.prjPath || this.ctx.prjRootPath || '',
      restoreSnapshot: (snapshot, sessionId) => sessionPersistenceBridge.restoreSession(snapshot, sessionId),
    });
    this._sessionFacade = new LexSessionFacade(
      sessionPersistenceBridge,
      sessionRestoreBridge,
    );
    const partProcessor = new PartEventProcessor(
      this.ctx.partStore,
      () => this._messageLifecycleBridge.currentResponseHandle,
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
      (userMessage, displayContent, metadata, options) => turnControlBridge.start(userMessage, displayContent, metadata, options),
      (turnId, userMessage, displayContent, metadata) => renderEventBridge.seedPendingTurn(turnId, userMessage, displayContent, metadata),
      (turnId) => uiEventBridge.ensureResponseItem(turnId),
      () => turnBridge.messages(),
      () => runtimeConfigBridge.tools(),
      () => turnControlBridge.currentIndex(),
    );
    const turnExecutionBridge = new LexTurnExecutionBridge(
      this.ctx,
      uiEventBridge,
      (sessionId, controller) => {
        this.ctx.setRuntimeAbortController?.(sessionId, controller);
        agentLifecycleBridge.setAbortController(sessionId, controller);
      },
      (sessionId) => {
        this.ctx.setRuntimeAbortController?.(sessionId, null);
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

        return null;
      },
      (sessionId) => agentLifecycleBridge.saveSession(sessionId),
      (sessionId) => {
        const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (!targetSessionId) {
          return [];
        }

        const snapshotTurnResponses = this.readCanonicalSessionSnapshotTurnResponses(targetSessionId);
        if (hasAuthoritativeResponseModel(snapshotTurnResponses)) {
          return snapshotTurnResponses;
        }

        if (this.isRenderEventBridgeProjectedToSession(targetSessionId)) {
          return renderEventBridge.turnResponses;
        }
        if (snapshotTurnResponses.length > 0) {
          return snapshotTurnResponses;
        }
        const runtimeTurnResponses = this.ctx.readSessionRuntimeState?.(targetSessionId)?.turnResponses;
        if (runtimeTurnResponses && runtimeTurnResponses.length > 0) {
          return runtimeTurnResponses;
        }
        return [];
      },
      (sessionId, turnResponses, options) => {
        this.ctx.syncExecutionRuntimeTurnResponses?.(sessionId, turnResponses, options);
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
            appendSessionModelTurnResponse: (targetSessionId, turnResponse, ownerPolicy) =>
              ownerCtx.appendSessionModelTurnResponse?.(targetSessionId, turnResponse, ownerPolicy) ?? null,
          },
          hostSyncBridge,
          {
            ensureResponseItem: () => {},
          },
          () => agentLifecycleBridge.getSessionSnapshot(sessionId),
        );
        detachedRenderEventBridge.setProjectionSessionResource(sessionId);
        detachedRenderEventBridge.hydrateTurnResponses(seedTurnResponses);
        return detachedRenderEventBridge;
      },
      () => this.ctx.resolveActiveRuntimeSessionId?.() ?? this.ctx.sessionId,
      (sessionId) => this.ctx.readSessionRuntimeState?.(sessionId)?.yieldRequested === true,
      (sessionId) => this.ctx.isRuntimeViewAttached?.(sessionId) === true,
      (sessionId) => this.ctx.readRuntimeViewAttachmentGeneration?.(sessionId) ?? null,
      (sessionId, generation) => this.ctx.isRuntimeViewAttachmentCurrent?.(sessionId, generation) === true,
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

  private isVisibleAttachedSession(sessionId: string): boolean {
    return this.ctx.isRuntimeViewAttached?.(sessionId) === true;
  }

  private isRenderEventBridgeProjectedToSession(sessionId: string): boolean {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return false;
    }
    const projectionSessionResource = this._renderEventBridge.getProjectionSessionResource?.();
    return typeof projectionSessionResource === 'string'
      && projectionSessionResource.trim() === targetSessionId;
  }

  private readCanonicalSessionSnapshotTurnResponses(sessionId: string): readonly TurnResponseTurn[] {
    const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!targetSessionId) {
      return [];
    }
    const handle = this._agentLifecycleBridge.getHandle(targetSessionId) as {
      getSessionSnapshot?: () => ReturnType<LexSessionFacade['snapshot']>;
    } | null;
    const agent = this._agentLifecycleBridge.getAgent(targetSessionId) as {
      getSessionSnapshot?: () => ReturnType<LexSessionFacade['snapshot']>;
    } | null;
    const snapshot = typeof handle?.getSessionSnapshot === 'function'
      ? handle.getSessionSnapshot()
      : typeof agent?.getSessionSnapshot === 'function'
        ? agent.getSessionSnapshot()
        : null;
    if (!snapshot || snapshot.sessionId !== targetSessionId) {
      return [];
    }
    return buildTurnResponsesFromSessionSnapshot(snapshot);
  }

  private _resolveCompactionMetricsService(lex: AilyLexModule, sessionId: string): IMetricsService {
    if (!this._compactionMetricsService || this._compactionMetricsSessionId !== sessionId) {
      this._compactionMetricsService = new lex.InMemoryMetricsService();
      this._compactionMetricsSessionId = sessionId;
    }

    return this._compactionMetricsService;
  }
}

function hasAuthoritativeResponseModel(turnResponses: readonly TurnResponseTurn[] | null | undefined): boolean {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return false;
  }
  return turnResponses.some(turn => {
    const resultText = typeof turn.response?.resultText === 'string'
      ? turn.response.resultText.trim()
      : '';
    return resultText.length > 0
      || (Array.isArray(turn.response?.parts) && turn.response.parts.length > 0)
      || (Array.isArray(turn.rounds) && turn.rounds.length > 0);
  });
}

