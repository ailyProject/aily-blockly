import type { IAgentLifecycle, IChatServiceAccess, IChatViewAccess } from '../core/chat-context';
import type {
  RenderEvent,
  RenderClearToPreviousToolInvocationReason,
  SessionSnapshot,
  TurnResponseCommand,
  TurnResponseQuestionPart,
  TurnResponseStatus,
  TurnResponseTurn,
} from 'aily-lex/browser';
import { createTurnResponseCommand } from 'aily-lex/browser';
import type { TurnResponseProjectionHandle } from '../core/turn-response-host-projection-builder';
import { TurnResponseIncrementalBuilder } from '../core/turn-response-stream-builder';
import type { LexHostSyncBridge } from './lex-host-sync-bridge';
import { LexRenderHostStreamEmitter, type HostStreamPartChange } from './lex-render-host-stream-emitter';
import { LexRenderProjectionSync } from './lex-render-projection-sync';
import { LexRenderTurnMaterializer } from './lex-render-turn-materializer';
import { LexSideEffectHandler } from './lex-side-effect-handler';
import {
  buildTurnResponseRequest,
  getTurnResponseParticipant,
} from '../core/turn-response-stream-contract';
import {
  type HostResponseClearToPreviousToolInvocationReason,
  type IHostStreamListener,
} from './host-turn-response-state';
import {
  cloneTurnResponseModelSidecar,
  getTurnResponseResolvedModelName,
  withExplicitAgentSummaryPreview,
} from './turn-response-response-model';

/** Narrow context: only needs partStore for rendering + toolCallingIteration for turn tracking */
type LexRenderEventBridgeContext =
  Pick<IChatViewAccess, 'partStore' | 'list' | 'invalidateHostRequestGraph' | 'triggerSyncDetectChanges'>
  & Pick<IAgentLifecycle, 'toolCallingIteration' | 'isCancelled' | 'currentMessageSource'>
  & Pick<IChatServiceAccess, 'contextBudgetService'>;

type RenderMessageLifecycleAccess = {
  ensureAilyMessage(turnId?: string): void;
  readonly currentMessageHandle: TurnResponseProjectionHandle | null;
};

/**
 * LexRenderEventBridge — unified bridge that consumes RenderEvent
 * and writes to ChatPartStore via RenderEventPartAdapter.
 *
 * Replaces the chain of:
 *   LexAgentEventBridge → LexRuntimeEventBridge
 *                        → LexStateEventBridge
 *                        → LexSubagentPartBridge
 *                        → PartEventProcessor
 *
 * Also satisfies the minimal reset/finalize contract so LexMessageLifecycleBridge can
 * call reset()/finalize() without knowing which processor is in use.
 *
 * Side effects previously scattered across those bridges are handled inline.
 */
export class LexRenderEventBridge {
  private readonly _streamBuilder: TurnResponseIncrementalBuilder;
  private readonly _sideEffects: LexSideEffectHandler;
  private readonly _hostStreamEmitter = new LexRenderHostStreamEmitter();
  private readonly _projectionSync: LexRenderProjectionSync;
  private readonly _turnMaterializer: LexRenderTurnMaterializer;
  private readonly _turnResponses = new Map<string, TurnResponseTurn>();
  private _currentTurn: TurnResponseTurn | null = null;
  private _pendingRequestContent = '';
  private _pendingRequestDisplayContent: string | undefined;
  private _pendingRequestMetadata: TurnResponseTurn['request']['metadata'];
  private _currentTurnHasExecutionError = false;

  constructor(
    private readonly ctx: LexRenderEventBridgeContext,
    private readonly hostSyncBridge: LexHostSyncBridge,
    private readonly messageLifecycleBridge: RenderMessageLifecycleAccess,
    private readonly getSessionSnapshot?: () => SessionSnapshot | null,
  ) {
    this._streamBuilder = new TurnResponseIncrementalBuilder();
    this._sideEffects = new LexSideEffectHandler(ctx, hostSyncBridge);
    this._projectionSync = new LexRenderProjectionSync(ctx, messageLifecycleBridge);
    this._turnMaterializer = new LexRenderTurnMaterializer(ctx, getSessionSnapshot);
  }

  /** H1: update the host stream listener at runtime (e.g. after session restore). */
  setHostStreamListener(listener: IHostStreamListener | null): void {
    this._hostStreamEmitter.setListener(listener);
  }

  prepareTurnRequest(
    requestContent: string,
    displayContent?: string,
    metadata?: TurnResponseTurn['request']['metadata'],
  ): void {
    this._pendingRequestContent = requestContent;
    this._pendingRequestDisplayContent = displayContent;
    this._pendingRequestMetadata = metadata;
  }

  seedPendingTurn(
    turnId: string,
    requestContent: string,
    displayContent?: string,
    metadata?: TurnResponseTurn['request']['metadata'],
  ): void {
    if (!turnId || this._turnResponses.has(turnId)) {
      return;
    }

    const createdAt = Date.now();
    const request = buildTurnResponseRequest(requestContent, displayContent, metadata);
    const slashCommand = resolveInitialResponseSlashCommand(metadata);
    const seededTurn: TurnResponseTurn = {
      turnId,
      request,
      rounds: [],
      response: {
        id: turnId,
        participant: getTurnResponseParticipant(this.ctx.currentMessageSource),
        status: 'streaming',
        parts: [],
        resultText: '',
        createdAt,
        updatedAt: createdAt,
      },
      ...(slashCommand ? { responseModel: { slashCommand } } : {}),
      createdAt,
      updatedAt: createdAt,
    };

    this._turnResponses.set(turnId, seededTurn);
    this.ctx.invalidateHostRequestGraph();
    this.ctx.triggerSyncDetectChanges();
  }

  get turnResponses(): readonly TurnResponseTurn[] {
    return [...this._turnResponses.values()]
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(turn => clonePublicTurnResponseTurn(turn));
  }

  hydrateTurnResponses(turnResponses: readonly TurnResponseTurn[]): void {
    this.reset();
    this._turnResponses.clear();

    for (const turn of turnResponses) {
      this._turnResponses.set(turn.turnId, cloneTurnResponseTurn(turn));
    }

    this.restoreHydratedCurrentTurn();
  }

  processInteractionEvent(event: Extract<RenderEvent, { type: 'approval_request' | 'approval_resolve' | 'question_request' }>): boolean {
    if (!this._currentTurn) {
      return false;
    }

    this.processEvent(event);
    return true;
  }

  updateQuestionAnswers(answers: TurnResponseQuestionPart['answers'], partId: string): boolean {
    if (!this._currentTurn) {
      return false;
    }

    const parts = this._currentTurn.response.parts;
    if (partId.trim().length === 0) {
      return false;
    }

    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index];
      if (part?.type !== 'question' || part.partId !== partId) {
        continue;
      }

      const nextParts = [...parts];
      nextParts[index] = {
        ...part,
        answers: cloneQuestionAnswers(answers),
      };
      this._currentTurn = {
        ...this._currentTurn,
        updatedAt: Date.now(),
        response: {
          ...this._currentTurn.response,
          parts: nextParts,
        },
      };
      this._turnResponses.set(this._currentTurn.turnId, this._currentTurn);
      this.ctx.invalidateHostRequestGraph();
      this.ctx.triggerSyncDetectChanges();
      return true;
    }

    return false;
  }

  finalizeCurrentTurn(fallbackStatus: TurnResponseStatus = 'completed'): boolean {
    if (!this._currentTurn) {
      const latestStreamingTurn = this.resolveLatestStreamingTurn();
      if (!latestStreamingTurn) {
        return false;
      }

      const finalizedTurn: TurnResponseTurn = {
        ...latestStreamingTurn,
        updatedAt: Date.now(),
        response: {
          ...latestStreamingTurn.response,
          status: fallbackStatus,
          updatedAt: Date.now(),
        },
      };
      this._turnResponses.set(finalizedTurn.turnId, finalizedTurn);
      this.ctx.invalidateHostRequestGraph();
      this.ctx.triggerSyncDetectChanges();
      return true;
    }

    this.syncCurrentTurn(Date.now(), fallbackStatus);
    this._projectionSync.projectPendingChanges(this._currentTurn, this._streamBuilder);
    return true;
  }

  appendExecutionError(message: string): boolean {
    if (!this._currentTurn) {
      return false;
    }

    this._currentTurnHasExecutionError = true;
    this.messageLifecycleBridge.ensureAilyMessage(this._currentTurn.turnId);
    this._streamBuilder.processEvent({ type: 'error_notice', message, timestamp: Date.now() });
    this.syncCurrentTurn(Date.now(), 'error');
    this._projectionSync.projectPendingChanges(this._currentTurn, this._streamBuilder);
    return true;
  }

  processEvent(event: RenderEvent): void {
    let turnBeginMode: 'fresh' | 'continued' | null = null;
    if (event.type === 'turn_begin') {
      turnBeginMode = this.beginTurn(event.turnId, event.timestamp);
    }

    this._sideEffects.processEvent(event);

    if (!this._currentTurn) {
      return;
    }

    this.messageLifecycleBridge.ensureAilyMessage(this._currentTurn.turnId);

    if (event.type === 'turn_begin') {
      if (turnBeginMode === 'fresh') {
        this._projectionSync.clearProjectedMessage(this._currentTurn);
      }
      this._projectionSync.syncProjectedMessageMeta(this._currentTurn);
      if (turnBeginMode === 'continued') {
        this.ctx.invalidateHostRequestGraph();
        this.ctx.triggerSyncDetectChanges();
      }
      return;
    }

    if (event.type === 'turn_end') {
      this.syncCurrentTurn(
        event.timestamp,
        'completed',
        event.usage,
        event.continuation,
        event.modelName,
        event.modelBillingLabel,
        event.modelRouting,
        event.quotaSnapshot,
        event.terminationReason,
      );
      if (event.modelName || event.modelBillingLabel || event.modelRouting || event.quotaSnapshot) {
        this.ctx.invalidateHostRequestGraph();
        this.ctx.triggerSyncDetectChanges();
      }
      this._projectionSync.projectPendingChanges(this._currentTurn, this._streamBuilder);
      return;
    }

    if (event.type === 'clear_to_previous_tool_invocation') {
      this._hostStreamEmitter.emitClearToPreviousToolInvocation(
        this._currentTurn.turnId,
        event.timestamp,
        toHostClearToPreviousToolInvocationReason(event.reason),
      );
      this.ctx.invalidateHostRequestGraph();
      this.ctx.triggerSyncDetectChanges();
      return;
    }

    const responseModelChanged = this._streamBuilder.processEvent(event) && isResponseModelRenderEvent(event);
    this.syncCurrentTurn(event.timestamp, this.resolveLiveFallbackStatus());
    this._projectionSync.projectPendingChanges(this._currentTurn, this._streamBuilder);
    if (event.type === 'response_followups') {
      this._hostStreamEmitter.emitResponseFollowups(this._currentTurn.turnId, event.value, event.timestamp);
    }
    if (responseModelChanged) {
      this.ctx.invalidateHostRequestGraph();
      this.ctx.triggerSyncDetectChanges();
    }
  }

  /** Flush an array of pending RenderEvents. */
  flushPendingEvents(events: readonly RenderEvent[]): void {
    for (const event of events) {
      this.processEvent(event);
    }
  }

  /** Reset per-turn state. */
  reset(): void {
    this._streamBuilder.reset();
    this._currentTurn = null;
    this._pendingRequestContent = '';
    this._pendingRequestDisplayContent = undefined;
    this._pendingRequestMetadata = undefined;
    this._currentTurnHasExecutionError = false;
  }

  /** Clear all retained live turn responses when a session is replaced or restored. */
  clearSessionState(): void {
    this.reset();
    this._turnResponses.clear();
    this._hostStreamEmitter.clearSessionState();
  }

  /** Clean up. */
  dispose(): void {
    this._streamBuilder.destroy();
  }

  private beginTurn(turnId: string, timestamp: number): 'fresh' | 'continued' {
    this._currentTurnHasExecutionError = false;
    const request = buildTurnResponseRequest(
      this._pendingRequestContent,
      this._pendingRequestDisplayContent,
      this._pendingRequestMetadata,
    );
    const initialSlashCommand = resolveInitialResponseSlashCommand(this._pendingRequestMetadata);

    if (this.shouldContinueCurrentTurn(request)) {
      const previousTurn = this._currentTurn!;
      const continuedTurn = this._streamBuilder.retargetCurrentTurn({
        turnId,
        request,
        participant: getTurnResponseParticipant(this.ctx.currentMessageSource),
        slashCommand: initialSlashCommand,
        timestamp,
      });
      if (continuedTurn) {
        this._currentTurn = continuedTurn;
        this._turnResponses.set(this._currentTurn.turnId, this._currentTurn);
        this._hostStreamEmitter.emitTurnDelta(this._currentTurn, previousTurn, []);
        return 'continued';
      }
    }

    if (this._currentTurn) {
      this.syncCurrentTurn(timestamp, 'completed');
    }

    this._currentTurn = this._streamBuilder.beginTurn({
      turnId,
      request,
      participant: getTurnResponseParticipant(this.ctx.currentMessageSource),
      slashCommand: initialSlashCommand,
      timestamp,
    });
    this._turnResponses.set(turnId, this._currentTurn);
    this._hostStreamEmitter.emitTurnStarted(this._currentTurn);
    this._hostStreamEmitter.emitInitialTurnFieldUpdates(this._currentTurn);
    return 'fresh';
  }

  private shouldContinueCurrentTurn(request: TurnResponseTurn['request']): boolean {
    if (!this._currentTurn || this._currentTurn.response.status !== 'streaming') {
      return false;
    }

    return this._currentTurn.request.content === request.content
      && (this._currentTurn.request.displayContent ?? '') === (request.displayContent ?? '');
  }

  private resolveLatestStreamingTurn(): TurnResponseTurn | null {
    let latest: TurnResponseTurn | null = null;
    for (const turn of this._turnResponses.values()) {
      if (turn.response.status !== 'streaming') {
        continue;
      }

      if (!latest || turn.updatedAt > latest.updatedAt) {
        latest = turn;
      }
    }

    return latest;
  }

  private restoreHydratedCurrentTurn(): void {
    const latestStreamingTurn = this.resolveLatestStreamingTurn();
    if (!latestStreamingTurn) {
      this._currentTurn = null;
      this._currentTurnHasExecutionError = false;
      return;
    }

    this._currentTurn = cloneTurnResponseTurn(latestStreamingTurn);
    this._currentTurnHasExecutionError = false;
    this._streamBuilder.hydrateTurn(this._currentTurn);
  }

  private resolveLiveFallbackStatus(): TurnResponseStatus {
    const currentStatus = this._currentTurn?.response.status;
    return currentStatus && currentStatus !== 'streaming'
      ? currentStatus
      : 'streaming';
  }

  private syncCurrentTurn(
    updatedAt: number,
    fallbackStatus: TurnResponseStatus,
    usage?: TurnResponseTurn['usage'],
    continuation?: TurnResponseTurn['response']['continuation'],
    modelName?: string,
    modelBillingLabel?: string,
    modelRouting?: NonNullable<TurnResponseTurn['responseModel']>['modelRouting'],
    quotaSnapshot?: TurnResponseTurn['responseModel']['quotaSnapshot'],
    terminationReason?: TurnResponseTurn['response']['terminationReason'],
  ): void {
    if (!this._currentTurn) {
      return;
    }

    const previousTurn = this._currentTurn;
    const materialized = this._turnMaterializer.materializeCurrentTurn(
      this._streamBuilder,
      this._currentTurn,
      {
        updatedAt,
        fallbackStatus,
        hasExecutionError: this._currentTurnHasExecutionError,
        usage,
        continuation,
        modelName,
        modelBillingLabel,
        modelRouting,
        quotaSnapshot,
        terminationReason,
      },
    );

    if (!materialized) {
      return;
    }

    this._currentTurn = withExplicitAgentSummaryPreview(materialized);

    const selectedPresetId = typeof this._currentTurn.responseModel?.modelRouting?.selectedPresetId === 'string'
      ? this._currentTurn.responseModel.modelRouting.selectedPresetId
      : undefined;
    const selectedModel = typeof this._currentTurn.responseModel?.modelRouting?.selectedModel === 'string'
      ? this._currentTurn.responseModel.modelRouting.selectedModel
      : undefined;
    if (selectedPresetId || selectedModel || this._currentTurn.responseModel?.modelName) {
      console.log('[LexRender] materialized turn response model:', {
        turnId: this._currentTurn.turnId,
        modelName: this._currentTurn.responseModel?.modelName,
        modelBillingLabel: this._currentTurn.responseModel?.modelBillingLabel,
        selectedPresetId,
        selectedModel,
      });
    }

    const previousModelName = getTurnResponseModelName(previousTurn);
    const currentModelName = getTurnResponseModelName(this._currentTurn);
    if (currentModelName && currentModelName !== previousModelName) {
      this.ctx.contextBudgetService?.updateModelContextSize({
        model: currentModelName,
        presetId: currentModelName,
      });
    }

    this._turnResponses.set(this._currentTurn.turnId, this._currentTurn);
    const partChanges = this._streamBuilder.drainTurnResponsePartChanges();
    this._hostStreamEmitter.emitTurnDelta(this._currentTurn, previousTurn, partChanges);
  }
}

function getTurnResponseModelName(turn: TurnResponseTurn | null | undefined): string | undefined {
  return getTurnResponseResolvedModelName(turn);
}

function toHostClearToPreviousToolInvocationReason(
  reason: RenderClearToPreviousToolInvocationReason,
): HostResponseClearToPreviousToolInvocationReason {
  return reason;
}

function cloneTurnResponseTurn(turn: TurnResponseTurn): TurnResponseTurn {
  const responseModel = cloneTurnResponseModelSidecar(turn.responseModel);

  return {
    ...turn,
    ...(turn.usage ? { usage: { ...turn.usage } } : {}),
    request: { ...turn.request },
    rounds: turn.rounds.map(round => ({
      ...round,
      toolCalls: round.toolCalls.map(toolCall => ({ ...toolCall })),
    })),
    response: {
      ...turn.response,
      ...(turn.response.usedContext
        ? {
          usedContext: {
            ...turn.response.usedContext,
            documents: turn.response.usedContext.documents.map(document => ({
              ...document,
              ranges: document.ranges.map(range => ({ ...range })),
            })),
          },
        }
        : {}),
      contentReferences: (turn.response.contentReferences ?? []).map(reference => ({
        ...reference,
        ...(reference.options
          ? {
            options: {
              ...reference.options,
              ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
              ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
            },
          }
          : {}),
      })),
      codeCitations: (turn.response.codeCitations ?? []).map(citation => ({ ...citation })),
      progressMessages: (turn.response.progressMessages ?? []).map(message => ({ ...message })),
      parts: turn.response.parts.map(part => ({ ...part })),
    },
    ...(responseModel ? { responseModel } : {}),
  };
}

function clonePublicTurnResponseTurn(turn: TurnResponseTurn): TurnResponseTurn {
  const responseModel = cloneTurnResponseModelSidecar(turn.responseModel);

  return {
    ...turn,
    ...(turn.usage ? { usage: { ...turn.usage } } : {}),
    request: { ...turn.request },
    rounds: turn.rounds.map(round => ({
      ...round,
      toolCalls: round.toolCalls.map(toolCall => ({ ...toolCall })),
    })),
    response: {
      ...turn.response,
      ...(turn.response.usedContext
        ? {
          usedContext: {
            ...turn.response.usedContext,
            documents: turn.response.usedContext.documents.map(document => ({
              ...document,
              ranges: document.ranges.map(range => ({ ...range })),
            })),
          },
        }
        : {}),
      contentReferences: (turn.response.contentReferences ?? []).map(reference => ({
        ...reference,
        ...(reference.options
          ? {
            options: {
              ...reference.options,
              ...(reference.options.status ? { status: { ...reference.options.status } } : {}),
              ...(reference.options.diffMeta ? { diffMeta: { ...reference.options.diffMeta } } : {}),
            },
          }
          : {}),
      })),
      codeCitations: (turn.response.codeCitations ?? []).map(citation => ({ ...citation })),
      progressMessages: (turn.response.progressMessages ?? []).map(message => ({ ...message })),
      parts: turn.response.parts.map(part => ({ ...part })),
    },
    ...(responseModel ? { responseModel } : {}),
  };
}

function resolveInitialResponseSlashCommand(
  metadata: TurnResponseTurn['request']['metadata'],
): TurnResponseCommand | undefined {
  const slashCommand = metadata?.command;
  return slashCommand ? createTurnResponseCommand(slashCommand.name, slashCommand) : undefined;
}

function cloneQuestionAnswers(answers: TurnResponseQuestionPart['answers']): TurnResponseQuestionPart['answers'] {
  if (!answers) {
    return undefined;
  }

  return Object.fromEntries(Object.entries(answers).map(([question, answer]) => [question, {
    selected: Array.isArray(answer.selected) ? [...answer.selected] : [],
    freeText: answer.freeText ?? null,
    skipped: !!answer.skipped,
  }]));
}

function isResponseModelRenderEvent(
  event: RenderEvent,
): event is Extract<RenderEvent, {
  type: 'response_reference' | 'response_code_citation' | 'response_progress_message' | 'response_followups' | 'response_command' | 'usage'
}> {
  return event.type === 'response_reference'
    || event.type === 'response_code_citation'
    || event.type === 'response_progress_message'
    || event.type === 'response_followups'
    || event.type === 'response_command'
    || event.type === 'usage';
}
