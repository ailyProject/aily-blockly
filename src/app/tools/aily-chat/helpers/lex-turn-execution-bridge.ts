import type { IAgentLifecycle } from '../core/chat-context';
import type { ChatRuntimeOwnerScheduler } from '../core/chat-runtime-owner-scheduler';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import type { RenderEvent, SessionSnapshot, TurnRequest, TurnResponseStatus, TurnResponseTurn } from 'aily-lex/browser';
import type { LexTurnDraft } from './lex-message-lifecycle-bridge';
import type { HostSessionSaveTarget } from './host-session-save-bridge';
import { yieldToBrowserTask } from '../tools/browserTaskScheduler';
import {
  terminalTranscriptProjection,
  type ChatRuntimeTurnResponseSyncOptions,
} from '../core/chat-runtime-projection-policy';

type LexTurnExecutionContext = Pick<
  IAgentLifecycle,
  'activeToolExecutions' | 'currentStatelessMode' | 'toolCallingIteration' | 'isCancelled' | 'isWaiting'
> & {
  readonly ownerScheduler: Pick<ChatRuntimeOwnerScheduler, 'runOutsideOwner'>;
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
};

type LexTurnRunOptions = {
  readonly yieldRequested?: () => boolean;
};

type LexChatAgent = {
  chat(userMessage: string, signal: AbortSignal, options?: LexTurnRunOptions): AsyncIterable<any>;
};

/** An object that yields RenderEvent from chat (AgentHandle-like). */
type RenderEventSource = {
  chat(message: string, signal?: AbortSignal, options?: LexTurnRunOptions): AsyncIterable<RenderEvent>;
};

type RenderEventSink = {
  readonly turnResponses?: readonly TurnResponseTurn[];
  reset(): void;
  setProjectionSessionResource?(sessionResource: string | null | undefined, visibleAttachmentGeneration?: number | null): void;
  getProjectionSessionResource?(): string | null | undefined;
  hydrateTurnResponses?(turnResponses: readonly TurnResponseTurn[]): void;
  prepareTurnRequest(requestContent: string, displayContent?: string, metadata?: TurnRequest['metadata']): void;
  processEvent(event: RenderEvent): void;
  flushPendingEvents(events: readonly RenderEvent[]): void;
  finalizeCurrentTurn?(fallbackStatus?: TurnResponseStatus): boolean;
  appendExecutionError(message: string, options?: { readonly retry?: boolean }): boolean;
};

type TurnUiEventSink = {
  ensureResponseItem(turnId?: string): void;
  resetTurnState(): void;
  getCurrentTurnDraft(): LexTurnDraft;
  finalizeTurn(saveTarget?: HostSessionSaveTarget | null): Promise<void>;
  appendExecutionError(message: string, options?: { retry?: boolean }): void;
  processEvent(event: any, scope?: 'main' | 'subagent'): void;
  flushPendingEvents(events: readonly any[]): void;
};

const GENERIC_EXECUTION_ERROR_MESSAGE = 'Sorry, something went wrong.';

interface LexTurnExecutionRunState {
  readonly sessionId: string | null;
  readonly saveTarget: HostSessionSaveTarget | null;
  abortSignal?: AbortSignal;
  detachedRenderEventBridge: RenderEventSink | null;
  visibleSinkGeneration: number | null;
  activeTurnId: string | null;
  activeSubagentRenderScopes: ActiveSubagentRenderScope[];
  requestContent: string;
  requestDisplayContent?: string;
  requestMetadata?: TurnRequest['metadata'];
  usedRenderEventStream: boolean;
}

interface ActiveSubagentRenderScope {
  readonly toolCallId: string;
  readonly subAgentInvocationId: string;
  readonly agentName?: string;
}

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

function traceBackgroundSessionExecution(event: string, details: Record<string, unknown>): void {
  if (!isBackgroundSessionTraceEnabled()) {
    return;
  }
  // console.info('[AilyChat][bg-session][execution]', event, details);
}

function mergeExecutionTurnResponsesById(
  ...sources: readonly (readonly TurnResponseTurn[] | null | undefined)[]
): TurnResponseTurn[] {
  const merged = new Map<string, TurnResponseTurn>();
  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }
    for (const turn of source) {
      if (!turn?.turnId) {
        continue;
      }
      merged.set(turn.turnId, cloneExecutionTurnResponse(turn));
    }
  }
  return [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function cloneExecutionTurnResponse(turn: TurnResponseTurn): TurnResponseTurn {
  try {
    return globalThis.structuredClone(turn);
  } catch {
    return JSON.parse(JSON.stringify(turn)) as TurnResponseTurn;
  }
}

function hasAuthoritativeExecutionTurnResponses(turnResponses: readonly TurnResponseTurn[] | null | undefined): boolean {
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

function selectAuthoritativeExecutionTurnResponses(
  canonicalTurnResponses: readonly TurnResponseTurn[] | null | undefined,
  sinkTurnResponses: readonly TurnResponseTurn[] | null | undefined,
): readonly TurnResponseTurn[] | undefined {
  if (hasAuthoritativeExecutionTurnResponses(canonicalTurnResponses)) {
    return canonicalTurnResponses ?? undefined;
  }
  if (hasAuthoritativeExecutionTurnResponses(sinkTurnResponses)) {
    return sinkTurnResponses ?? undefined;
  }
  if (Array.isArray(canonicalTurnResponses) && canonicalTurnResponses.length > 0) {
    return canonicalTurnResponses;
  }
  return Array.isArray(sinkTurnResponses) ? sinkTurnResponses : undefined;
}

async function yieldOutsideOwner(ctx: Pick<LexTurnExecutionContext, 'ownerScheduler'>, label = 'turn'): Promise<void> {
  const startedAt = performance.now();
  try {
    if (typeof ctx.ownerScheduler?.runOutsideOwner === 'function') {
      await ctx.ownerScheduler.runOutsideOwner(() => yieldToBrowserTask(0));
      ChatPerformanceTracer.recordDuration('turn_yield', performance.now() - startedAt, label, {
        slowThresholdMs: 24,
      });
      return;
    }
  } catch {
    // Fall through to the unpatched browser scheduler if a lightweight test zone mock throws.
  }

  await yieldToBrowserTask(0);
  ChatPerformanceTracer.recordDuration('turn_yield', performance.now() - startedAt, label, {
    slowThresholdMs: 24,
  });
}

/**
 * Handles lex turn execution scheduling for the blockly host path.
 *
 * Keeps runTurn orchestration, render yielding, and pending lifecycle event flush
 * out of LexOwnerFacade so the helper remains a thin runtime bridge.
 */
export class LexTurnExecutionBridge {
  private _renderEventBridge: RenderEventSink | null = null;

  constructor(
    private readonly ctx: LexTurnExecutionContext,
    private readonly uiEventBridge: TurnUiEventSink,
    private readonly setAbortController: (sessionId: string | null | undefined, controller: AbortController | null) => void,
    private readonly clearAbortController: (sessionId: string | null | undefined) => void,
    private readonly getCurrentSessionId: () => string | null | undefined,
    private readonly getCurrentRequestMetadata?: () => TurnRequest['metadata'] | undefined,
    private readonly captureExecutionSaveTarget?: (sessionId: string | null) => HostSessionSaveTarget | null,
    private readonly readExecutionSessionSnapshot?: (sessionId: string | null) => SessionSnapshot | null,
    private readonly readExecutionTurnResponses?: (sessionId: string | null) => readonly TurnResponseTurn[],
    private readonly syncExecutionRuntimeTurnResponses?: (
      sessionId: string | null,
      turnResponses: readonly TurnResponseTurn[] | null | undefined,
      options: ChatRuntimeTurnResponseSyncOptions,
    ) => void,
    private readonly createDetachedRenderEventSink?: (
      sessionId: string,
      seedTurnResponses: readonly TurnResponseTurn[],
    ) => RenderEventSink | null,
    private readonly getExecutionSessionId?: () => string | null | undefined,
    private readonly readExecutionYieldRequested?: (sessionId: string | null | undefined) => boolean,
    private readonly isRuntimeViewAttached?: (sessionId: string | null | undefined) => boolean,
    private readonly readRuntimeViewAttachmentGeneration?: (sessionId: string | null | undefined) => number | null | undefined,
    private readonly isRuntimeViewAttachmentCurrent?: (
      sessionId: string | null | undefined,
      generation: number | null | undefined,
    ) => boolean,
  ) {}

  /**
   * Set the RenderEvent bridge. When set, `runTurnWithRenderEvents()` is used
   * instead of the legacy AgentEvent path.
   */
  setRenderEventBridge(bridge: RenderEventSink): void {
    this._renderEventBridge = bridge;
  }

  runTurn(agent: LexChatAgent | null, userMessage: string): Promise<void> {
    traceBackgroundSessionExecution('run-legacy-turn-start', {
      hasAgent: !!agent,
      sessionId: this.captureExecutionSessionId(),
    });
    if (!agent) {
      console.error('[LexStream] Agent 未初始化，请先调用 ensureAgent()');
      this.uiEventBridge.appendExecutionError(GENERIC_EXECUTION_ERROR_MESSAGE);
      this.ctx.isWaiting = false;
      return Promise.resolve();
    }

    const executionState = this.createExecutionRunState(userMessage);
    if (!this.canUseLegacyAgentEventPath(executionState)) {
      console.warn('[AilyChat][TurnOwner] Legacy AgentEvent path cannot run detached session safely', {
        executionSessionId: executionState.sessionId,
        visibleSessionId: this.captureVisibleSessionId(),
      });
      this.reportExecutionError(
        new Error('Legacy AgentEvent execution cannot be projected to a detached session.'),
        executionState,
      );
      return this.finalizeTurnExecution(executionState);
    }

    const abortController = new AbortController();
    this.setAbortController(executionState.sessionId, abortController);
    const signal = abortController.signal;
    executionState.abortSignal = signal;
    const turnSpan = ChatPerformanceTracer.begin('lex_runTurn');

    this.resetTurnState();

    try {
      return Promise.resolve(this.ctx.ownerScheduler.runOutsideOwner(async () => {
        await this.preparePartsRendering(this.resolveExecutionResponseTurnId(executionState));

        try {
          await ChatPerformanceTracer.runWithSurface(
            'agent_loop',
            () => this.consumeAgentEvents(executionState, agent, userMessage, signal),
            `session=${executionState.sessionId ?? ''}`,
          );
        } catch (error: any) {
          this.reportExecutionError(error, executionState);
        }

        const turnDraft = this.uiEventBridge.getCurrentTurnDraft();
        ChatPerformanceTracer.end(turnSpan, 'lex_runTurn', `toolCalls=${turnDraft.toolCallCount}`);
        await this.finalizeTurnExecution(executionState);
      }));
    } catch (error: any) {
      ChatPerformanceTracer.end(turnSpan, 'lex_runTurn', `error: ${error.message}`);
      return this.finalizeTurnExecution(executionState);
    }
  }

  flushPendingEvents(events: readonly any[]): void {
    if (this._renderEventBridge) {
      // RenderEvent path — events are already RenderEvent[]
      this._renderEventBridge.flushPendingEvents(events as readonly RenderEvent[]);
    } else {
      this.uiEventBridge.flushPendingEvents(events);
    }
  }

  /**
   * Run a turn consuming RenderEvent from an AgentHandle or RenderEventEmitter.
   *
   * This is the new R3 path: RenderEvent → LexRenderEventBridge → ChatPartStore.
   * No PartEventProcessor, no state-event/runtime-event bridge chain.
   */
  runTurnWithRenderEvents(source: RenderEventSource, userMessage: string, displayContent?: string): Promise<void> {
    if (!this._renderEventBridge) {
      console.error('[LexStream] RenderEvent bridge not set, cannot use RenderEvent path');
      return Promise.resolve();
    }

    const executionState = this.createExecutionRunState(userMessage, displayContent);
    const abortController = new AbortController();
    this.setAbortController(executionState.sessionId, abortController);
    const signal = abortController.signal;
    executionState.abortSignal = signal;
    const turnSpan = ChatPerformanceTracer.begin('lex_runTurn_render');

    this.resetRenderEventTurnState(executionState, userMessage, displayContent);

    try {
      return Promise.resolve(this.ctx.ownerScheduler.runOutsideOwner(async () => {
        await yieldOutsideOwner(this.ctx, 'prepare');

        try {
          await ChatPerformanceTracer.runWithSurface(
            'agent_loop',
            () => this.consumeRenderEvents(executionState, source, userMessage, signal),
            `session=${executionState.sessionId ?? ''}`,
          );
        } catch (error: any) {
          this.reportExecutionError(error, executionState);
        }

        const turnDraft = this.uiEventBridge.getCurrentTurnDraft();
        ChatPerformanceTracer.end(turnSpan, 'lex_runTurn_render', `toolCalls=${turnDraft.toolCallCount}`);
        await this.finalizeTurnExecution(executionState);
      }));
    } catch (error: any) {
      ChatPerformanceTracer.end(turnSpan, 'lex_runTurn_render', `error: ${error.message}`);
      return this.finalizeTurnExecution(executionState);
    }
  }

  private createExecutionRunState(
    requestContent: string,
    requestDisplayContent?: string,
  ): LexTurnExecutionRunState {
    const sessionId = this.captureExecutionSessionId();
    return {
      sessionId,
      saveTarget: this.captureExecutionSaveTarget?.(sessionId) ?? null,
      detachedRenderEventBridge: null,
      visibleSinkGeneration: null,
      activeTurnId: null,
      activeSubagentRenderScopes: [],
      requestContent,
      requestDisplayContent,
      requestMetadata: this.getCurrentRequestMetadata?.(),
      usedRenderEventStream: false,
    };
  }

  private captureExecutionSessionId(): string | null {
    const sessionId = this.getExecutionSessionId?.() ?? this.getCurrentSessionId();
    if (typeof sessionId !== 'string') {
      return null;
    }

    const trimmedSessionId = sessionId.trim();
    return trimmedSessionId.length > 0 ? trimmedSessionId : null;
  }

  private async finalizeTurnExecution(state: LexTurnExecutionRunState): Promise<void> {
    traceBackgroundSessionExecution('finalize-turn-execution', {
      sessionId: state.sessionId,
      hasDetachedSink: !!state.detachedRenderEventBridge,
    });
    const finalizeStartedAt = Date.now();
    const fallbackStatus = this.ctx.isCancelled ? 'cancelled' : 'completed';
    try {
      const finalRenderEventSink = state.detachedRenderEventBridge ?? this._renderEventBridge;
      if (finalRenderEventSink?.finalizeCurrentTurn) {
        const finalized = finalRenderEventSink.finalizeCurrentTurn(fallbackStatus);
        traceBackgroundSessionExecution('finalize-render-turn-fallback', {
          sessionId: state.sessionId,
          finalized,
          fallbackStatus,
          sink: state.detachedRenderEventBridge ? 'detached' : 'visible',
        });
      }
      const includePreFinalizedTurnResponses = state.usedRenderEventStream || !!state.detachedRenderEventBridge;
      await this.uiEventBridge.finalizeTurn(this.buildExecutionSaveTarget(state, {
        includeTurnResponses: includePreFinalizedTurnResponses,
      }));
      if (state.usedRenderEventStream || state.detachedRenderEventBridge) {
        this.syncExecutionRuntimeState(state, finalRenderEventSink);
      }
      if (isBackgroundSessionTraceEnabled()) {
        console.info('[AilyChat][FinalizeDebug] finalizeTurnExecution completed', {
          sessionId: state.sessionId,
          elapsedMs: Date.now() - finalizeStartedAt,
          hasDetachedSink: !!state.detachedRenderEventBridge,
        });
      }
    } finally {
      state.detachedRenderEventBridge = null;
      if (state.sessionId) {
        this.clearAbortController(state.sessionId);
      }
    }
  }

  private buildExecutionSaveTarget(
    state: LexTurnExecutionRunState,
    options: { readonly includeTurnResponses?: boolean } = {},
  ): HostSessionSaveTarget | null {
    if (!state.saveTarget) {
      return null;
    }

    const {
      turnResponses: existingTurnResponses,
      ...baseSaveTarget
    } = state.saveTarget;
    const includeTurnResponses = options.includeTurnResponses !== false;
    return {
      ...baseSaveTarget,
      toolCallingIteration: this.ctx.toolCallingIteration,
      sessionSnapshot: this.readExecutionSessionSnapshot?.(state.sessionId) ?? state.saveTarget.sessionSnapshot ?? null,
      ...(includeTurnResponses
        ? { turnResponses: [...(this.readCurrentExecutionTurnResponses(state) ?? existingTurnResponses ?? [])] }
        : {}),
    };
  }

  private readCurrentExecutionTurnResponses(state: LexTurnExecutionRunState): readonly TurnResponseTurn[] | undefined {
    const canonicalTurnResponses = this.readExecutionTurnResponses?.(state.sessionId);
    if (state.sessionId
      && this.isExecutionSessionVisible(state.sessionId)
      && this.isVisibleRenderEventBridgeOwnedBy(state.sessionId)) {
      traceBackgroundSessionExecution('read-visible-turn-responses', {
        sessionId: state.sessionId,
        hasDetachedSink: !!state.detachedRenderEventBridge,
      });
      return selectAuthoritativeExecutionTurnResponses(
        canonicalTurnResponses,
        this._renderEventBridge?.turnResponses ?? state.detachedRenderEventBridge?.turnResponses,
      );
    }

    if (state.detachedRenderEventBridge?.turnResponses) {
      return selectAuthoritativeExecutionTurnResponses(state.detachedRenderEventBridge.turnResponses, canonicalTurnResponses);
    }

    return canonicalTurnResponses;
  }

  private resetRenderEventTurnState(
    state: LexTurnExecutionRunState,
    userMessage: string,
    displayContent?: string,
  ): void {
    if (state.sessionId && !this.isExecutionSessionVisible(state.sessionId)) {
      this.resolveExecutionRenderEventSink(state);
      this.ctx.activeToolExecutions = 0;
      this.ctx.currentStatelessMode = true;
      this.ctx.toolCallingIteration = 0;
      return;
    }

    const executionTurnResponses = mergeExecutionTurnResponsesById(
      this.readExecutionTurnResponses?.(state.sessionId),
    );
    this._renderEventBridge!.reset();
    state.visibleSinkGeneration = this.captureVisibleAttachmentGeneration(state.sessionId);
    this.setVisibleRenderSinkProjectionSession(state.sessionId, state.visibleSinkGeneration);
    this._renderEventBridge!.hydrateTurnResponses?.(executionTurnResponses);
    this._renderEventBridge!.prepareTurnRequest(
      state.requestContent || userMessage,
      state.requestDisplayContent ?? displayContent,
      state.requestMetadata,
    );
    this.ctx.activeToolExecutions = 0;
    this.ctx.currentStatelessMode = true;
    this.ctx.toolCallingIteration = 0;
  }

  private async consumeRenderEvents(
    state: LexTurnExecutionRunState,
    source: RenderEventSource,
    userMessage: string,
    signal: AbortSignal,
  ): Promise<void> {
    state.usedRenderEventStream = true;
    traceBackgroundSessionExecution('consume-render-events-start', {
      sessionId: state.sessionId,
      hasDetachedSink: !!state.detachedRenderEventBridge,
    });
    let lastYieldTime = 0;
    let eventCount = 0;
    let ignoredCrossSessionCancel = false;
    let cancelled = false;
    for await (const event of source.chat(userMessage, signal, {
      yieldRequested: () => this.isExecutionYieldRequested(state),
    })) {
      eventCount += 1;
      if (!this.acceptRenderEventForExecutionOwner(state, event)
        || !this.acceptRenderEventForActiveTurn(state, event)) {
        continue;
      }
      if (eventCount === 1) {
        traceBackgroundSessionExecution('consume-render-events-first', {
          sessionId: state.sessionId,
          eventType: event.type,
          turnId: state.activeTurnId,
        });
      }
      const renderEventSink = this.resolveExecutionRenderEventSink(state);
      const routedEvents = this.routeRenderEventsForSubagentScope(state, event);
      for (const routedEvent of routedEvents) {
        this.emitRenderEventToHost(state, routedEvent);
        renderEventSink.processEvent(routedEvent);
      }

      const cancellationApplies = this.isExecutionCancellationEffective(state);
      if (!cancellationApplies && this.ctx.isCancelled && !ignoredCrossSessionCancel) {
        ignoredCrossSessionCancel = true;
        traceBackgroundSessionExecution('consume-render-events-ignore-cross-session-cancel', {
          sessionId: state.sessionId,
          visibleSessionId: this.captureVisibleSessionId(),
        });
      }
      if (cancellationApplies) {
        cancelled = true;
        break;
      }

      if (!routedEvents.some(routedEvent => this.shouldYieldForRenderEvent(routedEvent.type))) {
        continue;
      }
      const now = performance.now();
      if (now - lastYieldTime >= 16) {
        await yieldOutsideOwner(this.ctx, 'render');
        lastYieldTime = performance.now();
      }
    }
    traceBackgroundSessionExecution('consume-render-events-end', {
      sessionId: state.sessionId,
      eventCount,
      cancelled,
    });
  }

  private shouldYieldForRenderEvent(eventType: string): boolean {
    return eventType === 'markdown_delta'
      || eventType === 'thinking_delta'
      || eventType === 'info_notice'
      || eventType === 'warning_notice'
      || eventType === 'subagent_begin'
      || eventType === 'subagent_activity'
      || eventType === 'subagent_end'
      || eventType === 'tool_call_begin'
      || eventType === 'tool_call_progress'
      || eventType === 'tool_call_end'
      || eventType === 'state_update'
      || eventType === 'error_notice';
  }

  private routeRenderEventsForSubagentScope(
    state: LexTurnExecutionRunState,
    event: RenderEvent,
  ): RenderEvent[] {
    const activeScope = this.getActiveSubagentRenderScope(state);

    if (this.isSubagentStateUpdateRenderEvent(event)) {
      const stateScope = this.readSubagentStateUpdateScope(event);
      if (!stateScope) {
        return [event];
      }
      const existingScope = state.activeSubagentRenderScopes.find(candidate =>
        candidate.toolCallId === stateScope.toolCallId
        || candidate.subAgentInvocationId === stateScope.subAgentInvocationId,
      );
      if (!existingScope && !this.isSubagentStateUpdateTerminal(event)) {
        state.activeSubagentRenderScopes.push(stateScope);
      }
      if (existingScope && this.isSubagentStateUpdateTerminal(event)) {
        this.popActiveSubagentRenderScope(state, existingScope);
      }
      return [event];
    }

    if (event.type === 'subagent_begin') {
      if (activeScope && !this.isEventForActiveSubagentScope(event, activeScope)) {
        return [this.withSubagentScope(activeScope, {
          type: 'tool_call_begin',
          toolCallId: event.toolCallId,
          toolName: event.agentName || 'agent',
          input: { description: event.description },
          timestamp: event.timestamp,
        } as RenderEvent)];
      }

      state.activeSubagentRenderScopes.push({
        toolCallId: event.toolCallId,
        subAgentInvocationId: event.subAgentInvocationId || event.toolCallId,
        agentName: event.agentName,
      });
      return [event];
    }

    if (!activeScope) {
      return [event];
    }

    switch (event.type) {
      case 'subagent_activity':
        return [event];

      case 'subagent_end':
        if (this.isEventForActiveSubagentScope(event, activeScope)) {
          this.popActiveSubagentRenderScope(state, activeScope);
          return [event];
        }
        return [this.withSubagentScope(activeScope, {
          type: 'tool_call_end',
          toolCallId: event.toolCallId,
          toolName: event.agentName || 'agent',
          resultText: event.resultText,
          result: event.resultText ? { content: [{ type: 'text', text: event.resultText }] } : undefined,
          durationMs: event.durationMs,
          state: event.state,
          isError: event.state === 'error',
          timestamp: event.timestamp,
        } as RenderEvent)];

      case 'turn_begin':
      case 'turn_end':
      case 'usage':
      case 'session_meta':
        return [];

      case 'thinking_delta':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'thinking_complete':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'markdown_delta':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'tool_call_begin':
        if (this.isScopedSubagentPartEvent(event, activeScope) && event.toolCallId !== activeScope.toolCallId) {
          return [event];
        }
        if (event.toolCallId === activeScope.toolCallId) {
          return [];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'tool_call_progress':
        if (this.isScopedSubagentPartEvent(event, activeScope) && event.toolCallId !== activeScope.toolCallId) {
          return [event];
        }
        if (event.toolCallId === activeScope.toolCallId) {
          return [];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'tool_call_end':
        if (this.isScopedSubagentPartEvent(event, activeScope) && event.toolCallId !== activeScope.toolCallId) {
          return [event];
        }
        if (event.toolCallId === activeScope.toolCallId || isSubagentToolName(event.toolName)) {
          this.popActiveSubagentRenderScope(state, activeScope);
          return [this.toSubagentEndFromToolCall(activeScope, event)];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'error_notice':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'warning_notice':
      case 'info_notice':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      case 'question_request':
      case 'approval_request':
      case 'approval_resolve':
        if (this.isScopedSubagentPartEvent(event, activeScope)) {
          return [event];
        }
        return [this.withSubagentScope(activeScope, event)];

      default:
        return [];
    }
  }

  private isSubagentStateUpdateRenderEvent(event: RenderEvent): boolean {
    if (event.type !== 'state_update') {
      return false;
    }
    const record = event as RenderEvent & { readonly stateId?: string; readonly kind?: string };
    return record.kind === 'agent_team'
      || (typeof record.stateId === 'string' && record.stateId.startsWith('subagent:'));
  }

  private readSubagentStateUpdateScope(event: RenderEvent): ActiveSubagentRenderScope | null {
    const record = event as RenderEvent & {
      readonly stateId?: string;
      readonly toolCallId?: string;
      readonly subAgentInvocationId?: string;
      readonly agentName?: string;
      readonly metadata?: Record<string, unknown>;
    };
    const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
    const stateToolCallId = typeof record.stateId === 'string' && record.stateId.startsWith('subagent:')
      ? record.stateId.slice('subagent:'.length).trim()
      : '';
    const toolCallId = asString(record.toolCallId)
      || asString(metadata['toolCallId'])
      || stateToolCallId;
    const subAgentInvocationId = asString(record.subAgentInvocationId)
      || asString(metadata['subAgentInvocationId'])
      || toolCallId;
    if (!toolCallId || !subAgentInvocationId) {
      return null;
    }
    return {
      toolCallId,
      subAgentInvocationId,
      agentName: asString(record.agentName) || asString(metadata['agentName']),
    };
  }

  private isSubagentStateUpdateTerminal(event: RenderEvent): boolean {
    const record = event as RenderEvent & { readonly state?: string };
    return record.state === 'done' || record.state === 'error';
  }

  private withSubagentScope<T extends RenderEvent>(
    scope: ActiveSubagentRenderScope,
    event: T,
  ): T {
    const scopedEvent = event as T & { subAgentInvocationId?: string; parentToolCallId?: string };
    return {
      ...event,
      sourceAgentRole: 'subagent',
      subAgentInvocationId: scopedEvent.subAgentInvocationId || scope.subAgentInvocationId,
      parentToolCallId: scopedEvent.parentToolCallId || scope.toolCallId,
    } as T;
  }

  private getActiveSubagentRenderScope(state: LexTurnExecutionRunState): ActiveSubagentRenderScope | null {
    return state.activeSubagentRenderScopes[state.activeSubagentRenderScopes.length - 1] ?? null;
  }

  private popActiveSubagentRenderScope(
    state: LexTurnExecutionRunState,
    scope: ActiveSubagentRenderScope,
  ): void {
    const index = state.activeSubagentRenderScopes.findIndex(candidate =>
      candidate.toolCallId === scope.toolCallId
      && candidate.subAgentInvocationId === scope.subAgentInvocationId,
    );
    if (index >= 0) {
      state.activeSubagentRenderScopes.splice(index, 1);
    }
  }

  private isEventForActiveSubagentScope(
    event: { readonly toolCallId?: string; readonly subAgentInvocationId?: string },
    scope: ActiveSubagentRenderScope,
  ): boolean {
    return event.toolCallId === scope.toolCallId
      || event.subAgentInvocationId === scope.subAgentInvocationId;
  }

  private isScopedSubagentPartEvent(
    event: RenderEvent,
    scope: ActiveSubagentRenderScope,
  ): boolean {
    if (!('type' in event)) {
      return false;
    }
    switch (event.type) {
      case 'markdown_delta':
      case 'thinking_delta':
      case 'thinking_complete':
      case 'tool_call_begin':
      case 'tool_call_progress':
      case 'tool_call_end':
      case 'error_notice':
      case 'warning_notice':
      case 'info_notice':
      case 'question_request':
      case 'approval_request':
      case 'approval_resolve':
        return event.sourceAgentRole === 'subagent'
          || event.subAgentInvocationId === scope.subAgentInvocationId
          || event.parentToolCallId === scope.toolCallId;
      default:
        return false;
    }
  }

  private toSubagentTextActivity(
    scope: ActiveSubagentRenderScope,
    activityKind: 'thinking' | 'text',
    content: string,
    timestamp: number,
  ): RenderEvent {
    return {
      type: 'subagent_activity',
      toolCallId: scope.toolCallId,
      subAgentInvocationId: scope.subAgentInvocationId,
      activityKind,
      content,
      timestamp,
    };
  }

  private toSubagentToolStartedActivity(
    scope: ActiveSubagentRenderScope,
    event: Pick<Extract<RenderEvent, { type: 'tool_call_begin' }>, 'toolCallId' | 'toolName' | 'input' | 'timestamp'>,
  ): RenderEvent {
    return {
      type: 'subagent_activity',
      toolCallId: scope.toolCallId,
      subAgentInvocationId: scope.subAgentInvocationId,
      activityKind: 'tool_started',
      childToolCallId: event.toolCallId,
      toolName: event.toolName,
      argsSummary: summarizeRenderToolInput(event.toolName, event.input),
      state: 'doing',
      timestamp: event.timestamp,
    };
  }

  private toSubagentToolProgressActivity(
    scope: ActiveSubagentRenderScope,
    event: Extract<RenderEvent, { type: 'tool_call_progress' }>,
  ): RenderEvent {
    return {
      type: 'subagent_activity',
      toolCallId: scope.toolCallId,
      subAgentInvocationId: scope.subAgentInvocationId,
      activityKind: 'tool_progress',
      childToolCallId: event.toolCallId,
      content: summarizeRenderToolProgress(event.data),
      state: 'doing',
      timestamp: event.timestamp,
    };
  }

  private toSubagentToolCompletedActivity(
    scope: ActiveSubagentRenderScope,
    event: Pick<Extract<RenderEvent, { type: 'tool_call_end' }>, 'toolCallId' | 'toolName' | 'resultText' | 'durationMs' | 'state' | 'timestamp'>,
  ): RenderEvent {
    return {
      type: 'subagent_activity',
      toolCallId: scope.toolCallId,
      subAgentInvocationId: scope.subAgentInvocationId,
      activityKind: event.state === 'error' ? 'tool_failed' : 'tool_completed',
      childToolCallId: event.toolCallId,
      toolName: event.toolName,
      content: event.resultText,
      state: event.state,
      durationMs: event.durationMs,
      timestamp: event.timestamp,
    };
  }

  private toSubagentEndFromToolCall(
    scope: ActiveSubagentRenderScope,
    event: Extract<RenderEvent, { type: 'tool_call_end' }>,
  ): RenderEvent {
    return {
      type: 'subagent_end',
      toolCallId: scope.toolCallId,
      subAgentInvocationId: scope.subAgentInvocationId,
      agentName: scope.agentName || event.toolName || 'Agent',
      resultText: event.resultText,
      state: event.state,
      durationMs: event.durationMs,
      timestamp: event.timestamp,
    };
  }

  private resetTurnState(): void {
    this.uiEventBridge.resetTurnState();
    this.ctx.activeToolExecutions = 0;
    this.ctx.currentStatelessMode = true;
    this.ctx.toolCallingIteration = 0;
  }

  private async preparePartsRendering(turnId?: string): Promise<void> {
    this.uiEventBridge.ensureResponseItem(turnId);

    // 等待同步 detectChanges 之后再进入 for-await，确保 Parts 组件已挂载。
    await yieldOutsideOwner(this.ctx, 'prepare');
  }

  private resolveExecutionResponseTurnId(state: LexTurnExecutionRunState): string | undefined {
    if (state.activeTurnId) {
      return state.activeTurnId;
    }

    const turnResponses = this.readExecutionTurnResponses?.(state.sessionId);
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      return undefined;
    }

    const requestMetadata = state.requestMetadata && typeof state.requestMetadata === 'object'
      ? state.requestMetadata as Record<string, unknown>
      : null;
    const requestId = typeof requestMetadata?.['requestId'] === 'string'
      ? requestMetadata['requestId'].trim()
      : '';
    const checkpointId = typeof requestMetadata?.['checkpointId'] === 'string'
      ? requestMetadata['checkpointId'].trim()
      : '';

    for (let index = turnResponses.length - 1; index >= 0; index--) {
      const turn = turnResponses[index];
      const metadata = turn?.request?.metadata && typeof turn.request.metadata === 'object'
        ? turn.request.metadata as Record<string, unknown>
        : null;
      const turnRequestId = typeof metadata?.['requestId'] === 'string'
        ? metadata['requestId'].trim()
        : '';
      const turnCheckpointId = typeof metadata?.['checkpointId'] === 'string'
        ? metadata['checkpointId'].trim()
        : '';
      if ((requestId && turnRequestId === requestId) || (checkpointId && turnCheckpointId === checkpointId)) {
        return turn.turnId;
      }
    }

    return turnResponses[turnResponses.length - 1]?.turnId;
  }

  private async consumeAgentEvents(
    state: LexTurnExecutionRunState,
    agent: LexChatAgent,
    userMessage: string,
    signal: AbortSignal,
  ): Promise<void> {
    let lastYieldTime = 0;
    for await (const event of agent.chat(userMessage, signal, {
      yieldRequested: () => this.isExecutionYieldRequested(state),
    })) {
      this.uiEventBridge.processEvent(event);
      traceBackgroundSessionExecution('legacy-agent-event', {
        type: event?.type,
      });
      if (this.isExecutionCancellationEffective(state)) {
        break;
      }
      if (!this.shouldYieldForRendering(event.type)) {
        continue;
      }

      const now = performance.now();
      if (now - lastYieldTime >= 16) {
        await yieldOutsideOwner(this.ctx, 'legacy');
        lastYieldTime = performance.now();
      }
    }
  }

  private canUseLegacyAgentEventPath(state: LexTurnExecutionRunState): boolean {
    if (!state.sessionId) {
      return true;
    }

    return this.isExecutionSessionVisible(state.sessionId);
  }

  private shouldYieldForRendering(eventType: string): boolean {
    return eventType === 'text_delta'
      || eventType === 'thinking'
      || eventType === 'tool_call_start'
      || eventType === 'tool_call_end'
      || eventType === 'instruction_state'
      || eventType === 'task_graph'
      || eventType === 'task_scheduler'
      || eventType === 'task_autonomy'
      || eventType === 'agent_team'
      || eventType === 'error';
  }

  private reportExecutionError(error: any, state: LexTurnExecutionRunState): void {
    if (this.isExecutionCancellationEffective(state) || error?.name?.includes('Abort')) {
      return;
    }

    console.error('[LexStream] Agent 执行异常:', error);
    if (!this._renderEventBridge) {
      this.uiEventBridge.appendExecutionError(GENERIC_EXECUTION_ERROR_MESSAGE, { retry: true });
      return;
    }

    const renderEventSink = this.resolveExecutionRenderEventSink(state);
    if (renderEventSink.appendExecutionError(GENERIC_EXECUTION_ERROR_MESSAGE, { retry: true })) {
      this.syncExecutionRuntimeState(state, renderEventSink);
      return;
    }
    this.uiEventBridge.appendExecutionError(GENERIC_EXECUTION_ERROR_MESSAGE, { retry: true });
  }

  private syncExecutionRuntimeState(
    state: LexTurnExecutionRunState,
    renderEventSink?: RenderEventSink | null,
  ): void {
    const executionSessionId = state.sessionId;
    if (!executionSessionId) {
      return;
    }

    const startedAt = performance.now();
    const canonicalTurnResponses = this.readExecutionTurnResponses?.(executionSessionId);
    const turnResponses = renderEventSink && renderEventSink === state.detachedRenderEventBridge
      ? selectAuthoritativeExecutionTurnResponses(renderEventSink.turnResponses, canonicalTurnResponses)
      : selectAuthoritativeExecutionTurnResponses(canonicalTurnResponses, renderEventSink?.turnResponses);
    this.syncExecutionRuntimeTurnResponses?.(
      executionSessionId,
      turnResponses,
      terminalTranscriptProjection('execution'),
    );
    ChatPerformanceTracer.recordDuration(
      'runtime_turn_response_sync',
      performance.now() - startedAt,
      `session=${executionSessionId},turns=${Array.isArray(turnResponses) ? turnResponses.length : 0}`,
      { slowThresholdMs: 16 },
    );
  }

  private resolveExecutionRenderEventSink(state: LexTurnExecutionRunState): RenderEventSink {
    if (!this._renderEventBridge) {
      throw new Error('RenderEvent bridge not set');
    }

    const executionSessionId = state.sessionId;
    if (!executionSessionId || this.isExecutionSessionVisible(executionSessionId)) {
      const visibleOwnerMismatch = !!executionSessionId
        && (!this.isVisibleRenderEventBridgeOwnedBy(executionSessionId)
          || !this.isVisibleAttachmentGenerationCurrent(state));
      if (state.detachedRenderEventBridge || visibleOwnerMismatch) {
        const mergedTurnResponses = mergeExecutionTurnResponsesById(
          this.readExecutionTurnResponses?.(executionSessionId),
          state.detachedRenderEventBridge?.turnResponses,
        );
        traceBackgroundSessionExecution('reattach-visible-sink', {
          sessionId: executionSessionId ?? null,
          replayedTurnResponses: mergedTurnResponses.length,
          visibleOwnerMismatch,
          visibleAttachmentGeneration: state.visibleSinkGeneration,
          currentVisibleAttachmentGeneration: this.captureVisibleAttachmentGeneration(executionSessionId),
        });
        state.visibleSinkGeneration = this.captureVisibleAttachmentGeneration(executionSessionId);
        this.setVisibleRenderSinkProjectionSession(executionSessionId, state.visibleSinkGeneration);
        this._renderEventBridge.hydrateTurnResponses?.(mergedTurnResponses);
        this._renderEventBridge.prepareTurnRequest(
          state.requestContent,
          state.requestDisplayContent,
          state.requestMetadata,
        );
      }
      if (state.visibleSinkGeneration === null && this.hasVisibleAttachmentGenerationReader()) {
        state.visibleSinkGeneration = this.captureVisibleAttachmentGeneration(executionSessionId);
        this.setVisibleRenderSinkProjectionSession(executionSessionId, state.visibleSinkGeneration);
      }
      state.detachedRenderEventBridge = null;
      return this._renderEventBridge;
    }

    if (!state.detachedRenderEventBridge) {
      const executionTurnResponses = this.readExecutionTurnResponses?.(executionSessionId);
      const seedTurnResponses = mergeExecutionTurnResponsesById(executionTurnResponses);
      traceBackgroundSessionExecution('detach-to-background-sink', {
        sessionId: executionSessionId,
        seedTurnResponses: seedTurnResponses.length,
      });
      state.detachedRenderEventBridge = this.createDetachedRenderEventSink?.(
        executionSessionId,
        seedTurnResponses,
      ) ?? null;
      if (state.detachedRenderEventBridge) {
        state.detachedRenderEventBridge.hydrateTurnResponses?.(seedTurnResponses);
        state.detachedRenderEventBridge.prepareTurnRequest(
          state.requestContent,
          state.requestDisplayContent,
          state.requestMetadata,
        );
      }
    }

    if (!state.detachedRenderEventBridge) {
      throw new Error(`Detached render sink is required for background session ${executionSessionId}.`);
    }

    state.visibleSinkGeneration = null;
    return state.detachedRenderEventBridge;
  }

  private emitRenderEventToHost(state: LexTurnExecutionRunState, event: RenderEvent): void {
    if (typeof this.ctx.emitExecutionRenderEvent !== 'function') {
      return;
    }
    const executionSessionId = state.sessionId;
    if (!executionSessionId) {
      return;
    }
    this.ctx.emitExecutionRenderEvent(executionSessionId, event, {
      sessionId: executionSessionId,
      requestText: state.requestContent,
      displayText: state.requestDisplayContent,
      metadata: state.requestMetadata ?? null,
      activeResponseHandle: state.activeTurnId,
    });
  }

  private acceptRenderEventForActiveTurn(state: LexTurnExecutionRunState, event: RenderEvent): boolean {
    const turnId = this.readRenderEventTurnId(event);
    if (!turnId) {
      return true;
    }

    if (!state.activeTurnId) {
      state.activeTurnId = turnId;
      return true;
    }

    if (state.activeTurnId === turnId) {
      return true;
    }

    traceBackgroundSessionExecution('ignore-cross-turn-render-event', {
      sessionId: state.sessionId,
      activeTurnId: state.activeTurnId,
      eventTurnId: turnId,
      eventType: event.type,
    });
    console.warn('[AilyChat][TurnOwner] Ignore render event for non-active turn', {
      sessionId: state.sessionId,
      activeTurnId: state.activeTurnId,
      eventTurnId: turnId,
      eventType: event.type,
    });
    return false;
  }

  private acceptRenderEventForExecutionOwner(state: LexTurnExecutionRunState, event: RenderEvent): boolean {
    const eventSessionId = this.readRenderEventSessionId(event);
    if (!eventSessionId || !state.sessionId || eventSessionId === state.sessionId) {
      return true;
    }

    traceBackgroundSessionExecution('ignore-cross-session-render-event', {
      sessionId: state.sessionId,
      eventSessionId,
      activeTurnId: state.activeTurnId,
      eventTurnId: this.readRenderEventTurnId(event),
      eventType: event.type,
    });
    console.warn('[AilyChat][TurnOwner] Ignore render event for non-active session', {
      sessionId: state.sessionId,
      eventSessionId,
      activeTurnId: state.activeTurnId,
      eventTurnId: this.readRenderEventTurnId(event),
      eventType: event.type,
    });
    return false;
  }

  private readRenderEventTurnId(event: RenderEvent): string | null {
    const turnId = (event as { turnId?: unknown }).turnId;
    if (typeof turnId !== 'string') {
      return null;
    }

    const trimmedTurnId = turnId.trim();
    return trimmedTurnId.length > 0 ? trimmedTurnId : null;
  }

  private readRenderEventSessionId(event: RenderEvent): string | null {
    const eventRecord = event as {
      sessionId?: unknown;
      trace?: { sessionId?: unknown };
      metadata?: { sessionId?: unknown; sessionResource?: unknown };
    };
    const sessionId = eventRecord.sessionId
      ?? eventRecord.trace?.sessionId
      ?? eventRecord.metadata?.sessionId
      ?? eventRecord.metadata?.sessionResource;
    if (typeof sessionId !== 'string') {
      return null;
    }

    const trimmedSessionId = sessionId.trim();
    return trimmedSessionId.length > 0 ? trimmedSessionId : null;
  }

  private isExecutionSessionVisible(executionSessionId: string): boolean {
    if (typeof this.isRuntimeViewAttached === 'function') {
      return this.isRuntimeViewAttached(executionSessionId) === true;
    }
    return this.captureVisibleSessionId() === executionSessionId;
  }

  private isVisibleRenderEventBridgeOwnedBy(executionSessionId: string): boolean {
    const readProjectionSessionResource = this._renderEventBridge?.getProjectionSessionResource;
    if (typeof readProjectionSessionResource !== 'function') {
      return true;
    }

    return normalizeSessionResource(readProjectionSessionResource.call(this._renderEventBridge)) === executionSessionId;
  }

  private isVisibleAttachmentGenerationCurrent(state: LexTurnExecutionRunState): boolean {
    if (!state.sessionId || !this.isExecutionSessionVisible(state.sessionId)) {
      return false;
    }

    if (!this.hasVisibleAttachmentGenerationReader()) {
      return true;
    }

    const expectedGeneration = normalizeVisibleAttachmentGeneration(state.visibleSinkGeneration);
    if (expectedGeneration === null) {
      return false;
    }

    if (typeof this.isRuntimeViewAttachmentCurrent === 'function') {
      return this.isRuntimeViewAttachmentCurrent(state.sessionId, expectedGeneration) === true;
    }

    const currentGeneration = this.captureVisibleAttachmentGeneration(state.sessionId);
    return currentGeneration !== null && currentGeneration === expectedGeneration;
  }

  private captureVisibleAttachmentGeneration(sessionId: string | null | undefined): number | null {
    if (!sessionId || !this.hasVisibleAttachmentGenerationReader()) {
      return null;
    }

    return normalizeVisibleAttachmentGeneration(this.readRuntimeViewAttachmentGeneration(sessionId));
  }

  private hasVisibleAttachmentGenerationReader(): boolean {
    return typeof this.readRuntimeViewAttachmentGeneration === 'function';
  }

  private setVisibleRenderSinkProjectionSession(sessionId: string | null | undefined, generation: number | null): void {
    if (!this._renderEventBridge?.setProjectionSessionResource) {
      return;
    }

    if (generation === null) {
      this._renderEventBridge.setProjectionSessionResource(sessionId ?? null);
      return;
    }

    this._renderEventBridge.setProjectionSessionResource(sessionId ?? null, generation);
  }

  private captureVisibleSessionId(): string | null {
    const currentSessionId = this.getCurrentSessionId();
    if (typeof currentSessionId !== 'string') {
      return null;
    }

    const trimmedSessionId = currentSessionId.trim();
    return trimmedSessionId.length > 0 ? trimmedSessionId : null;
  }

  private isExecutionCancellationEffective(state: LexTurnExecutionRunState): boolean {
    if (state.abortSignal?.aborted) {
      return true;
    }

    if (!this.ctx.isCancelled) {
      return false;
    }

    if (!state.sessionId) {
      return true;
    }

    return this.isExecutionSessionVisible(state.sessionId);
  }

  private isExecutionYieldRequested(state: LexTurnExecutionRunState): boolean {
    if (!state.sessionId) {
      return false;
    }

    return this.readExecutionYieldRequested?.(state.sessionId) === true;
  }
}

function normalizeSessionResource(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeVisibleAttachmentGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isSubagentToolName(toolName: string | null | undefined): boolean {
  return toolName === 'agent' || toolName === 'runSubagent' || toolName === 'run_subagent';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function firstStringArrayValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const item of value) {
    const text = asString(item);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function truncateRenderSummary(value: string | undefined, maxLength = 120): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}

function summarizeRenderToolInput(toolName: string, input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) {
    return truncateRenderSummary(asString(input));
  }

  switch (toolName) {
    case 'read_file':
    case 'readFile':
      return truncateRenderSummary(firstStringField(record, ['filePath', 'path']));
    case 'file_search':
    case 'glob_search':
    case 'grep_search':
    case 'semantic_search':
      return truncateRenderSummary(
        firstStringField(record, ['query', 'pattern', 'includePattern'])
        || firstStringArrayValue(record, 'filePaths'),
      );
    case 'list_dir':
    case 'create_directory':
    case 'create_file':
    case 'update_file':
    case 'delete_file':
      return truncateRenderSummary(firstStringField(record, ['path', 'filePath', 'directoryPath']));
    case 'command_exec':
      return truncateRenderSummary(firstStringField(record, ['command', 'cmd']));
    default:
      return truncateRenderSummary(
        firstStringField(record, ['description', 'prompt', 'query', 'path', 'filePath', 'command'])
        || JSON.stringify(record),
      );
  }
}

function summarizeRenderToolProgress(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) {
    return truncateRenderSummary(asString(data));
  }

  return truncateRenderSummary(
    firstStringField(record, ['summary', 'detail', 'statusText', 'label', 'message', 'phase'])
    || JSON.stringify(record),
  );
}
