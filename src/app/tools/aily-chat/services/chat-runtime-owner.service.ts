import { DestroyRef, Injectable, inject } from '@angular/core';

import { LexOwnerFacade, type LexOwnerContext } from '../helpers/lex-stream.helper';
import { terminalTranscriptProjection } from '../core/chat-runtime-projection-policy';
import { buildSeededTurnResponseTurn } from '../core/turn-response-stream-contract';
import {
  normalizeChatAgentRuntimeMode,
  normalizeChatAgentRuntimeModeSource,
} from '../core/chat-agent-runtime-mode';
import { normalizeChatSelectedMode } from '../core/chat-mode';
import type {
  ChatRuntimeOwnerExecutor,
  ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand,
  ChatRuntimeOwnerExecutorEvent,
  ChatRuntimeOwnerExecutorResolveInteractionCommand,
  ChatRuntimeOwnerExecutorRenderEventProgress,
  ChatRuntimeOwnerExecutorStartTurnCommand,
  ChatRuntimeOwnerExecutorStopTurnCommand,
  ChatRuntimeHostEvent,
  ChatRuntimeHostEventSubscription,
  ChatRuntimeHostInteractionSnapshot,
  ChatRuntimeHostSessionId,
  ChatRuntimeHostSessionState,
  ChatRuntimeHostSubmitRequest,
  ChatRuntimeHostProtocolTruncation,
  ChatRuntimeHostTranscriptSnapshot,
  ChatRuntimeHostNotificationSeverity,
  ChatRuntimeHostTodoItem,
  ChatRuntimeHostViewRequest,
  ChatRuntimeHostViewRequestKind,
} from '../core/chat-runtime-host-contract';
import type { ChatModeId } from '../core/chat-mode';
import type { RenderEvent, TurnResponseTurn } from 'aily-lex/browser';
import { normalizeHostSessionProviderOptions } from '../helpers/host-session-input-state';
import type { RuntimeCommandSessionActionResult } from './chat-runtime-interaction-host.service';
import {
  CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER,
  CHAT_RUNTIME_OWNER_STATE,
  CHAT_RUNTIME_OWNER_SUBMITTED_TURN_LIFECYCLE,
  type ChatRuntimeOwnerContextBinderPort,
  type ChatRuntimeOwnerInteractionHostPort,
  type ChatRuntimeOwnerRuntimeControllerPort,
  type ChatRuntimeOwnerStatePort,
  type ChatRuntimeOwnerSubmittedTurnLifecyclePort,
} from './chat-runtime-owner-ports';

/**
 * Owns the live chat runtime boundary.
 *
 * This service intentionally accepts exactly one context and exposes exactly one
 * Lex owner for the current renderer process. The next migration step can move
 * this contract behind an Electron host owner without keeping ChatEngineService
 * as the runtime constructor.
 */
@Injectable()
export class ChatRuntimeOwnerService implements ChatRuntimeOwnerExecutor, ChatRuntimeOwnerContextBinderPort {
  private readonly runtimeController = inject<ChatRuntimeOwnerRuntimeControllerPort>(CHAT_RUNTIME_OWNER_RUNTIME_CONTROLLER);
  private readonly runtimeInteractionHost = inject<ChatRuntimeOwnerInteractionHostPort>(
    CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  );
  private readonly runtimeOwnerState = inject<ChatRuntimeOwnerStatePort>(CHAT_RUNTIME_OWNER_STATE);
  private readonly submittedTurnLifecycle = inject<ChatRuntimeOwnerSubmittedTurnLifecyclePort>(
    CHAT_RUNTIME_OWNER_SUBMITTED_TURN_LIFECYCLE,
  );
  private readonly destroyRef = inject(DestroyRef);

  private context: LexOwnerContext | null = null;
  private sourceContext: LexOwnerContext | null = null;
  private owner: LexOwnerFacade | null = null;
  private readonly eventListeners = new Set<(
    event: ChatRuntimeHostEvent | ChatRuntimeOwnerExecutorRenderEventProgress | ChatRuntimeOwnerExecutorEvent
  ) => void>();
  private readonly pendingLiveTranscriptSessionIds = new Set<ChatRuntimeHostSessionId>();
  private readonly transcriptRevisions = new Map<ChatRuntimeHostSessionId, number>();
  private readonly submittedTurnIdAliases = new Map<ChatRuntimeHostSessionId, Map<string, string>>();
  private viewRequestSeed = 0;
  private liveTranscriptFlushScheduled = false;

  constructor() {
    const interactionSubscription = this.runtimeInteractionHost.onSnapshot(snapshot => {
      this.emitInteraction(snapshot);
    });
    this.destroyRef.onDestroy(() => {
      interactionSubscription.dispose();
    });
  }

  bindContext(context: LexOwnerContext): LexOwnerFacade {
    if (this.owner) {
      if (this.sourceContext !== context) {
        throw new Error('[AilyChat][RuntimeOwner] Runtime owner cannot be rebound to a different context.');
      }
      return this.owner;
    }

    this.sourceContext = context;
    this.context = this.createRuntimeOwnerContext(context);
    this.owner = new LexOwnerFacade(this.context);
    return this.owner;
  }

  readOwner(): LexOwnerFacade {
    if (!this.owner) {
      throw new Error('[AilyChat][RuntimeOwner] Runtime owner has not been bound.');
    }
    return this.owner;
  }

  async startTurn(command: ChatRuntimeOwnerExecutorStartTurnCommand): Promise<ChatRuntimeHostSessionState> {
    const request = command?.request;
    if (!request || typeof request !== 'object') {
      throw new Error('[AilyChat][RuntimeOwner] startTurn requires a submit request.');
    }
    const normalizedRequest = this.normalizeSubmitRequest({
      ...request,
      sessionId: command.sessionId || request.sessionId,
      activeResponseHandle: command.turnId || request.activeResponseHandle,
      currentModel: request.currentModel !== undefined
        ? request.currentModel
        : command.executionContext?.currentModel ?? null,
      agentRuntimeMode: request.agentRuntimeMode !== undefined
        ? request.agentRuntimeMode
        : command.executionContext?.agentRuntimeMode ?? null,
      agentRuntimeModeSource: request.agentRuntimeModeSource !== undefined
        ? request.agentRuntimeModeSource
        : command.executionContext?.agentRuntimeModeSource ?? null,
      protocolTruncation: request.protocolTruncation ?? command.executionContext?.protocolTruncation ?? null,
    });
    this.projectSubmittedTurnExecutionContext(normalizedRequest);
    return this.startSubmittedTurn(normalizedRequest);
  }

  private async startSubmittedTurn(normalizedRequest: ChatRuntimeHostSubmitRequest): Promise<ChatRuntimeHostSessionState> {
    const displayText = normalizedRequest.displayText ?? normalizedRequest.requestText;
    const releaseOwnerScope = this.runtimeOwnerState.beginRuntimeSessionOwnerScope(normalizedRequest.sessionId);
    let backgroundStarted = false;
    let requestStateStarted = false;
    let activeResponseHandle: string | null = null;
    try {
      const owner = this.readOwner();
      const seededTurn = this.buildSubmittedCanonicalSeededTurn(normalizedRequest, displayText);
      activeResponseHandle = seededTurn.turnId;
      const canonicalRequest: ChatRuntimeHostSubmitRequest = {
        ...normalizedRequest,
        activeResponseHandle,
      };
      this.beginSubmittedRequestState(canonicalRequest.sessionId, activeResponseHandle);
      requestStateStarted = true;
      const committedTurnResponses = this.commitSubmittedSeededTurn(canonicalRequest.sessionId, seededTurn);
      this.requireContext().syncExecutionRuntimeTurnResponses(
        canonicalRequest.sessionId,
        committedTurnResponses,
        terminalTranscriptProjection('handoff'),
      );
      this.emitSessionState(canonicalRequest.sessionId, 'runtime-status');
      this.emitTranscript(canonicalRequest.sessionId);

      backgroundStarted = true;
      this.scheduleSubmittedTurnBackground(() => this.runSubmittedTurnInBackground({
        owner,
        request: canonicalRequest,
        displayText,
        activeResponseHandle,
        releaseOwnerScope,
      }));
      return this.buildSessionState(canonicalRequest.sessionId);
    } catch (error) {
      this.emitRuntimeError(normalizedRequest.sessionId, error);
      this.emitSessionState(normalizedRequest.sessionId, 'runtime-status');
      if (requestStateStarted && activeResponseHandle) {
        this.completeSubmittedRequestState(normalizedRequest.sessionId, activeResponseHandle);
      }
      throw error;
    } finally {
      if (!backgroundStarted) {
        releaseOwnerScope();
      }
    }
  }

  private scheduleSubmittedTurnBackground(callback: () => void): void {
    const scheduleAfterFrame = typeof globalThis.requestAnimationFrame === 'function'
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : null;
    const scheduleTimer = typeof globalThis.setTimeout === 'function'
      ? globalThis.setTimeout.bind(globalThis)
      : null;
    if (scheduleAfterFrame && scheduleTimer) {
      scheduleAfterFrame(() => {
        scheduleTimer(callback, 0);
      });
      return;
    }
    if (scheduleTimer) {
      scheduleTimer(callback, 0);
      return;
    }
    callback();
  }

  private runSubmittedTurnInBackground(options: {
    readonly owner: LexOwnerFacade;
    readonly request: ChatRuntimeHostSubmitRequest;
    readonly displayText: string;
    readonly activeResponseHandle: unknown;
    readonly releaseOwnerScope: () => void;
  }): void {
    void (async () => {
      let completedSuccessfully = false;
      try {
        await this.prepareSubmittedTurn(options.request, options.owner);
        this.applySubmittedTurnProtocolTruncation(
          options.request.sessionId,
          options.request.protocolTruncation ?? null,
          options.owner,
        );
        const beginResult = options.owner.turn.begin(
          options.request.requestText,
          options.displayText,
          options.request.metadata ?? undefined,
        );
        const seededTurn = this.buildSubmittedSeededTurn(
          options.owner,
          options.request,
          options.displayText,
          beginResult,
        );
        const committedTurnResponses = this.commitSubmittedSeededTurn(options.request.sessionId, seededTurn);
        this.requireContext().syncExecutionRuntimeTurnResponses(
          options.request.sessionId,
          committedTurnResponses,
          terminalTranscriptProjection('handoff'),
        );
        this.emitTranscript(options.request.sessionId);
        this.emitSessionState(options.request.sessionId, 'runtime-status');
        this.scheduleSubmittedTurnStartupResourceSettle(options.request.sessionId);
        await options.owner.turn.run(options.request.requestText, options.displayText);
        completedSuccessfully = true;
      } catch (error) {
        this.emitRuntimeError(options.request.sessionId, error);
      }
      if (completedSuccessfully) {
        await this.completeSubmittedTurnEffects(options.request.sessionId);
      }
    })()
      .catch(error => {
        this.emitRuntimeError(options.request.sessionId, error);
      })
      .finally(() => {
        this.publishTerminalSessionModelTranscript(options.request.sessionId);
        this.completeSubmittedRequestState(options.request.sessionId, options.activeResponseHandle, {
          emitState: false,
        });
        const state = this.buildSessionState(options.request.sessionId);
        this.emitTranscript(options.request.sessionId);
        this.emitSessionState(options.request.sessionId, 'runtime-status', state);
        options.releaseOwnerScope();
      });
  }

  private async prepareSubmittedTurn(
    normalizedRequest: ChatRuntimeHostSubmitRequest,
    owner: LexOwnerFacade,
  ): Promise<void> {
    try {
      await this.submittedTurnLifecycle.prepareSubmittedTurn(normalizedRequest, owner);
    } catch (error) {
      this.emitRuntimeError(normalizedRequest.sessionId, error);
      this.emitSessionState(normalizedRequest.sessionId, 'runtime-status');
      throw error;
    }
  }

  private scheduleSubmittedTurnStartupResourceSettle(sessionId: ChatRuntimeHostSessionId): void {
    void this.submittedTurnLifecycle.settleSubmittedTurnStartupResources(sessionId)
      .catch(error => {
        this.emitRuntimeError(sessionId, error);
        this.emitSessionState(sessionId, 'runtime-status');
      });
  }

  private applySubmittedTurnProtocolTruncation(
    sessionId: ChatRuntimeHostSessionId,
    truncation: ChatRuntimeHostProtocolTruncation | null | undefined,
    owner: LexOwnerFacade,
  ): void {
    if (!truncation) {
      return;
    }

    const retainedTurnResponses = this.resolveProtocolTruncationRetainedTurnResponses(
      sessionId,
      truncation,
      owner,
    );

    if (truncation.kind === 'clear') {
      owner.turns.clear();
      owner.hydrateTurnResponses(sessionId, retainedTurnResponses, { visibility: 'visibleAttach' });
      return;
    }

    const turnId = typeof truncation.turnId === 'string' ? truncation.turnId.trim() : '';
    if (!turnId) {
      throw new Error('[AilyChat][RuntimeOwner] protocol truncation removeFrom requires a turn id.');
    }
    owner.turns.removeFrom(this.resolveSubmittedTurnIdOwnerAlias(sessionId, turnId));
    owner.hydrateTurnResponses(sessionId, retainedTurnResponses, { visibility: 'visibleAttach' });
  }

  private resolveProtocolTruncationRetainedTurnResponses(
    sessionId: ChatRuntimeHostSessionId,
    truncation: ChatRuntimeHostProtocolTruncation,
    owner: LexOwnerFacade,
  ): readonly TurnResponseTurn[] {
    const retainedTurnIds = Array.isArray(truncation.retainedTurnIds)
      ? truncation.retainedTurnIds
        .map(turnId => typeof turnId === 'string' ? turnId.trim() : '')
        .filter(Boolean)
      : [];
    if (retainedTurnIds.length === 0) {
      return [];
    }

    const retainedTurnIdSet = new Set<string>();
    for (const retainedTurnId of retainedTurnIds) {
      retainedTurnIdSet.add(retainedTurnId);
      retainedTurnIdSet.add(this.resolveSubmittedTurnIdOwnerAlias(sessionId, retainedTurnId));
    }
    const currentTurnResponses = owner.getTurnResponses(sessionId);
    return currentTurnResponses.filter(turn => {
      const turnId = typeof turn?.turnId === 'string' ? turn.turnId.trim() : '';
      return retainedTurnIdSet.has(turnId)
        || retainedTurnIdSet.has(this.resolveSubmittedTurnIdAlias(sessionId, turnId));
    }).map(turn => {
      const turnId = typeof turn?.turnId === 'string' ? turn.turnId.trim() : '';
      const canonicalTurnId = turnId ? this.resolveSubmittedTurnIdAlias(sessionId, turnId) : '';
      return canonicalTurnId && canonicalTurnId !== turnId
        ? this.retargetTurnResponseTurn(turn, canonicalTurnId)
        : turn;
    });
  }

  private async completeSubmittedTurnEffects(sessionId: ChatRuntimeHostSessionId): Promise<void> {
    try {
      await this.submittedTurnLifecycle.completeSubmittedTurn(sessionId);
    } catch (error) {
      this.emitRuntimeError(sessionId, error);
      this.emitSessionState(sessionId, 'runtime-status');
      throw error;
    }
  }

  private publishTerminalSessionModelTranscript(sessionId: ChatRuntimeHostSessionId): void {
    const context = this.requireContext();
    const turnResponses = this.readAuthoritativeServiceOwnedTurnResponses(sessionId);
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      this.logTerminalTranscriptModel(sessionId, 'missing-authoritative-service-model', []);
      return;
    }

    this.logTerminalTranscriptModel(sessionId, 'service-owned-response-model', turnResponses);
    context.syncExecutionRuntimeTurnResponses?.(
      sessionId,
      turnResponses,
      terminalTranscriptProjection('execution'),
    );
    this.emitServiceOwnedResponseModelProgress(sessionId, turnResponses);
  }

  private publishStoppedSessionModelTranscript(
    sessionId: ChatRuntimeHostSessionId,
    turnId: string | null | undefined,
  ): void {
    const context = this.requireContext();
    const turnResponses = this.readStoppedServiceOwnedTurnResponses(sessionId, turnId);
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      this.logTerminalTranscriptModel(sessionId, 'missing-stopped-service-model', []);
      return;
    }

    this.logTerminalTranscriptModel(sessionId, 'stopped-service-owned-response-model', turnResponses);
    context.syncExecutionRuntimeTurnResponses?.(
      sessionId,
      turnResponses,
      terminalTranscriptProjection('execution'),
    );
  }

  private readAuthoritativeServiceOwnedTurnResponses(sessionId: ChatRuntimeHostSessionId): readonly TurnResponseTurn[] | null {
    const turnResponses = this.readServiceOwnedTurnResponses(sessionId);
    return hasAuthoritativeResponseModel(turnResponses) ? turnResponses : null;
  }

  private readStoppedServiceOwnedTurnResponses(
    sessionId: ChatRuntimeHostSessionId,
    turnId: string | null | undefined,
  ): readonly TurnResponseTurn[] | null {
    const canonicalTurnResponses = this.readCanonicalSessionModelTurnResponses(sessionId);
    const ownerTurnResponses = this.readServiceOwnedTurnResponses(sessionId);
    if (Array.isArray(canonicalTurnResponses) && canonicalTurnResponses.length > 0) {
      if (!Array.isArray(ownerTurnResponses) || ownerTurnResponses.length === 0) {
        return terminalizeStoppedCanonicalTurnResponses(canonicalTurnResponses, turnId);
      }
      const branchState = compareTerminalOwnerBranchToCanonical(
        canonicalTurnResponses,
        ownerTurnResponses,
      );
      if (branchState !== 'compatible') {
        this.logTerminalTranscriptModel(sessionId, `stale-${branchState}-owner-model`, ownerTurnResponses);
        return terminalizeStoppedCanonicalTurnResponses(canonicalTurnResponses, turnId);
      }
      return terminalizeStoppedCanonicalTurnResponses(
        hasAuthoritativeResponseModel(ownerTurnResponses) ? ownerTurnResponses : canonicalTurnResponses,
        turnId,
      );
    }

    return Array.isArray(ownerTurnResponses) && ownerTurnResponses.length > 0
      ? terminalizeStoppedCanonicalTurnResponses(ownerTurnResponses, turnId)
      : null;
  }

  private readServiceOwnedTurnResponses(sessionId: ChatRuntimeHostSessionId): readonly TurnResponseTurn[] | null {
    const owner = this.owner;
    if (!owner) {
      return null;
    }
    const turnResponses = owner.getTurnResponses(sessionId);
    if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
      return null;
    }
    return this.normalizeServiceOwnedTurnResponses(sessionId, turnResponses);
  }

  private normalizeServiceOwnedTurnResponses(
    sessionId: ChatRuntimeHostSessionId,
    turnResponses: readonly TurnResponseTurn[],
  ): readonly TurnResponseTurn[] {
    const aliases = this.submittedTurnIdAliases.get(sessionId);
    if (!aliases || aliases.size === 0) {
      return turnResponses;
    }

    let changed = false;
    const normalizedTurnResponses = turnResponses.map(turn => {
      const sourceTurnId = this.normalizeSubmittedTurnId(turn?.turnId);
      const targetTurnId = sourceTurnId ? aliases.get(sourceTurnId) : undefined;
      if (!targetTurnId || targetTurnId === sourceTurnId) {
        return turn;
      }

      changed = true;
      return this.retargetTurnResponseTurn(turn, targetTurnId);
    });

    return changed ? normalizedTurnResponses : turnResponses;
  }

  private retargetTurnResponseTurn(turn: TurnResponseTurn, turnId: string): TurnResponseTurn {
    return {
      ...turn,
      turnId,
      response: {
        ...turn.response,
        id: turnId,
      },
    };
  }

  private readCanonicalSessionModelTurnResponses(sessionId: ChatRuntimeHostSessionId): readonly TurnResponseTurn[] | null {
    const context = this.requireContext();
    const turnResponses = typeof context.readSessionTurnResponses === 'function'
      ? context.readSessionTurnResponses(sessionId)
      : null;
    return Array.isArray(turnResponses) && turnResponses.length > 0
      ? turnResponses
      : null;
  }

  private logTerminalTranscriptModel(
    sessionId: ChatRuntimeHostSessionId,
    source: string,
    turnResponses: readonly TurnResponseTurn[],
  ): void {
    const lastTurn = turnResponses[turnResponses.length - 1];
    const response = lastTurn?.response as {
      readonly parts?: readonly unknown[];
      readonly resultText?: unknown;
    } | undefined;
    const resultTextLength = typeof response?.resultText === 'string' ? response.resultText.length : 0;
    console.info('[AilyChat][RuntimeOwnerTerminalModel]', JSON.stringify({
      sessionId,
      source,
      turns: turnResponses.length,
      lastTurnId: lastTurn?.turnId ?? null,
      lastParts: Array.isArray(response?.parts) ? response.parts.length : 0,
      lastTextLength: resultTextLength,
    }));
  }

  private emitServiceOwnedResponseModelProgress(
    sessionId: ChatRuntimeHostSessionId,
    turnResponses: readonly TurnResponseTurn[],
  ): void {
    const turn = selectLatestAuthoritativeResponseTurn(turnResponses);
    if (!turn?.turnId) {
      return;
    }
    const event: ChatRuntimeOwnerExecutorEvent = {
      kind: 'turnProgress',
      sessionId,
      turnId: turn.turnId,
      revision: this.readTranscriptRevision(sessionId),
      turn,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private beginSubmittedRequestState(
    sessionId: ChatRuntimeHostSessionId,
    activeResponseHandle: unknown,
  ): void {
    this.runtimeController.beginSubmittedRequestState({
      sessionId,
      activeResponseHandle,
      stopSession: () => {
        void this.stopTurn({ sessionId });
      },
      disposeSession: () => {
        void this.disposeSessionResources({ sessionId });
      },
      attachedView: false,
    });
    this.emitSessionState(sessionId, 'runtime-status');
  }

  private completeSubmittedRequestState(
    sessionId: ChatRuntimeHostSessionId,
    activeResponseHandle: unknown,
    options?: { readonly emitState?: boolean },
  ): void {
    this.runtimeController.completeSubmittedRequestState(sessionId, activeResponseHandle);
    if (options?.emitState !== false) {
      this.emitSessionState(sessionId, 'runtime-status');
    }
  }

  private buildSubmittedSeededTurn(
    owner: LexOwnerFacade,
    normalizedRequest: ChatRuntimeHostSubmitRequest,
    displayText: string,
    beginResult: unknown,
  ): TurnResponseTurn {
    const ownerTurnId = this.resolveOwnerSubmittedTurnId(owner, beginResult);
    const turnId = this.resolveSubmittedTurnId(
      owner,
      normalizedRequest.sessionId,
      beginResult,
      normalizedRequest.activeResponseHandle,
    );
    this.registerSubmittedTurnIdAlias(normalizedRequest.sessionId, ownerTurnId, turnId);
    const currentRequestMetadata = typeof owner.turns?.currentRequestMetadata === 'function'
      ? owner.turns.currentRequestMetadata()
      : undefined;
    const context = this.requireContext();
    const participant = typeof context.currentMessageSource === 'string'
      ? context.currentMessageSource
      : undefined;

    return buildSeededTurnResponseTurn({
      turnId,
      requestContent: normalizedRequest.requestText,
      displayContent: displayText,
      metadata: (currentRequestMetadata ?? normalizedRequest.metadata) as TurnResponseTurn['request']['metadata'],
      participant,
    });
  }

  private buildSubmittedCanonicalSeededTurn(
    normalizedRequest: ChatRuntimeHostSubmitRequest,
    displayText: string,
  ): TurnResponseTurn {
    const turnId = this.normalizeSubmittedTurnId(normalizedRequest.activeResponseHandle)
      || this.throwMissingSubmittedTurnId(normalizedRequest.sessionId);
    const context = this.requireContext();
    const participant = typeof context.currentMessageSource === 'string'
      ? context.currentMessageSource
      : undefined;

    return buildSeededTurnResponseTurn({
      turnId,
      requestContent: normalizedRequest.requestText,
      displayContent: displayText,
      metadata: normalizedRequest.metadata as TurnResponseTurn['request']['metadata'],
      participant,
    });
  }

  private commitSubmittedSeededTurn(
    sessionId: ChatRuntimeHostSessionId,
    seededTurn: TurnResponseTurn,
  ): readonly TurnResponseTurn[] {
    const context = this.requireContext();
    if (typeof context.appendSessionModelTurnResponse !== 'function') {
      throw new Error('[AilyChat][RuntimeOwner] Runtime submit requires canonical session model append support.');
    }

    const committedTurnResponses = context.appendSessionModelTurnResponse(sessionId, seededTurn, {
      source: 'runtime-host-submit-turn',
    });
    if (!committedTurnResponses) {
      throw new Error('[AilyChat][RuntimeOwner] Runtime submit could not commit the canonical turn seed.');
    }

    return committedTurnResponses;
  }

  private resolveSubmittedTurnId(
    owner: LexOwnerFacade,
    sessionId: ChatRuntimeHostSessionId,
    beginResult: unknown,
    preferredTurnId?: unknown,
  ): string {
    const preferred = this.normalizeSubmittedTurnId(preferredTurnId);
    if (preferred) {
      return preferred;
    }

    return this.resolveOwnerSubmittedTurnId(owner, beginResult)
      || this.throwMissingSubmittedTurnId(sessionId);
  }

  private resolveOwnerSubmittedTurnId(
    owner: LexOwnerFacade,
    beginResult: unknown,
  ): string {
    const beginTurnId = this.normalizeSubmittedTurnId(beginResult);
    if (beginTurnId) {
      return beginTurnId;
    }

    const currentTurnId = typeof owner.turns?.currentId === 'function'
      ? this.normalizeSubmittedTurnId(owner.turns.currentId())
      : '';
    if (currentTurnId) {
      return currentTurnId;
    }

    return '';
  }

  private throwMissingSubmittedTurnId(sessionId: ChatRuntimeHostSessionId): never {
    throw new Error(`[AilyChat][RuntimeOwner] Runtime submit for ${sessionId} did not create a canonical turn id.`);
  }

  private registerSubmittedTurnIdAlias(
    sessionId: ChatRuntimeHostSessionId,
    sourceTurnId: string,
    targetTurnId: string,
  ): void {
    if (!sourceTurnId || !targetTurnId || sourceTurnId === targetTurnId) {
      return;
    }

    let aliases = this.submittedTurnIdAliases.get(sessionId);
    if (!aliases) {
      aliases = new Map<string, string>();
      this.submittedTurnIdAliases.set(sessionId, aliases);
    }
    aliases.set(sourceTurnId, targetTurnId);
  }

  private resolveSubmittedTurnIdAlias(
    sessionId: ChatRuntimeHostSessionId,
    turnId: string,
  ): string {
    return this.submittedTurnIdAliases.get(sessionId)?.get(turnId) ?? turnId;
  }

  private resolveSubmittedTurnIdOwnerAlias(
    sessionId: ChatRuntimeHostSessionId,
    turnId: string,
  ): string {
    const aliases = this.submittedTurnIdAliases.get(sessionId);
    if (!aliases || aliases.size === 0) {
      return turnId;
    }

    for (const [sourceTurnId, targetTurnId] of aliases) {
      if (targetTurnId === turnId) {
        return sourceTurnId;
      }
    }
    return turnId;
  }

  private normalizeSubmittedTurnId(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (value && typeof value === 'object') {
      const record = value as { readonly id?: unknown; readonly turnId?: unknown };
      if (typeof record.turnId === 'string' && record.turnId.trim().length > 0) {
        return record.turnId.trim();
      }
      if (typeof record.id === 'string' && record.id.trim().length > 0) {
        return record.id.trim();
      }
    }

    return '';
  }

  private requireContext(): LexOwnerContext {
    if (!this.context) {
      throw new Error('[AilyChat][RuntimeOwner] Runtime owner context has not been bound.');
    }

    return this.context;
  }

  private createRuntimeOwnerContext(context: LexOwnerContext): LexOwnerContext {
    const ownerContext = Object.create(context) as LexOwnerContext;
    Object.defineProperty(ownerContext, 'viewRequests', {
      configurable: true,
      enumerable: true,
      value: this.createHostViewRequestDispatcher(),
    });
    Object.defineProperty(ownerContext, 'suppressVisibleTurnStartupProjection', {
      configurable: true,
      enumerable: true,
      value: true,
    });
    ownerContext.syncExecutionRuntimeTurnResponses = (
      sessionId: string | null | undefined,
      turnResponses: readonly TurnResponseTurn[] | null | undefined,
      options,
    ): void => {
      context.syncExecutionRuntimeTurnResponses(sessionId, turnResponses, options);
      this.scheduleLiveTranscriptEvent(sessionId);
    };
    ownerContext.syncExecutionRuntimeState = (saveTarget): void => {
      const sessionId = typeof saveTarget?.sessionId === 'string' ? saveTarget.sessionId.trim() : '';
      if (sessionId && Array.isArray(saveTarget?.turnResponses)) {
        context.syncExecutionRuntimeTurnResponses(
          sessionId,
          saveTarget.turnResponses,
          terminalTranscriptProjection('execution'),
        );
      }
      context.syncExecutionRuntimeState(saveTarget);
      if (sessionId && Array.isArray(saveTarget?.turnResponses)) {
        this.scheduleLiveTranscriptEvent(sessionId);
      }
    };
    ownerContext.readSessionTurnResponses = (sessionId: string | null | undefined): readonly TurnResponseTurn[] => {
      const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
      if (!normalizedSessionId) {
        return [];
      }
      const ownerTurnResponses = this.readServiceOwnedTurnResponses(normalizedSessionId);
      const canonicalTurnResponses = typeof context.readSessionTurnResponses === 'function'
        ? context.readSessionTurnResponses(normalizedSessionId)
        : null;
      if (Array.isArray(canonicalTurnResponses) && canonicalTurnResponses.length > 0) {
        if (!Array.isArray(ownerTurnResponses) || ownerTurnResponses.length === 0) {
          return canonicalTurnResponses;
        }
        const branchState = compareTerminalOwnerBranchToCanonical(canonicalTurnResponses, ownerTurnResponses);
        if (branchState !== 'compatible') {
          return branchState === 'shorter'
            ? canonicalTurnResponses
            : ownerTurnResponses;
        }
        return hasAuthoritativeResponseModel(ownerTurnResponses)
          ? ownerTurnResponses
          : canonicalTurnResponses;
      }
      if (Array.isArray(canonicalTurnResponses)) {
        return canonicalTurnResponses;
      }
      return ownerTurnResponses ?? [];
    };
    ownerContext.emitExecutionRenderEvent = (sessionId, renderEvent, request): void => {
      this.emitRenderEventProgress(sessionId, renderEvent, request as ChatRuntimeHostSubmitRequest | null | undefined);
    };
    return ownerContext;
  }

  private createHostViewRequestDispatcher() {
    return {
      notify: (
        sessionId: ChatRuntimeHostSessionId | null | undefined,
        severity: ChatRuntimeHostNotificationSeverity,
        message: unknown,
      ): void => {
        const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
        const normalizedMessage = typeof message === 'string' ? message.trim() : '';
        if (!normalizedSessionId || !normalizedMessage) {
          return;
        }

        this.emitViewRequest({
          id: this.nextViewRequestId('notification'),
          sessionId: normalizedSessionId,
          kind: 'notification',
          notification: {
            severity,
            message: normalizedMessage,
          },
        });
      },
      syncTodoState: (
        sessionId: ChatRuntimeHostSessionId | null | undefined,
        items: readonly ChatRuntimeHostTodoItem[],
      ): void => {
        const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
        if (!normalizedSessionId) {
          return;
        }

        this.emitViewRequest({
          id: this.nextViewRequestId('todo-state'),
          sessionId: normalizedSessionId,
          kind: 'todo-state',
          todoState: {
            items: items.map(item => ({ ...item })),
          },
        });
      },
      requestHandoff: (input: {
        readonly sessionId: ChatRuntimeHostSessionId | null | undefined;
        readonly targetAgent?: string;
        readonly targetModeId?: ChatModeId;
        readonly message: string;
        readonly suggestedInput?: string;
      }): void => {
        const normalizedSessionId = this.normalizeOptionalSessionId(input.sessionId);
        const normalizedMessage = typeof input.message === 'string' ? input.message.trim() : '';
        if (!normalizedSessionId || !normalizedMessage) {
          return;
        }

        this.emitViewRequest({
          id: this.nextViewRequestId('handoff'),
          sessionId: normalizedSessionId,
          kind: 'handoff',
          handoff: {
            ...(input.targetAgent ? { targetAgent: input.targetAgent } : {}),
            ...(input.targetModeId ? { targetModeId: input.targetModeId } : {}),
            message: normalizedMessage,
            ...(input.suggestedInput ? { suggestedInput: input.suggestedInput } : {}),
          },
        });
      },
    };
  }

  private nextViewRequestId(kind: ChatRuntimeHostViewRequestKind): string {
    this.viewRequestSeed += 1;
    return `view_request_${kind}_${Date.now().toString(36)}_${this.viewRequestSeed.toString(36)}`;
  }

  private scheduleLiveTranscriptEvent(sessionId: string | null | undefined): void {
    const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }

    this.pendingLiveTranscriptSessionIds.add(normalizedSessionId);
    if (this.liveTranscriptFlushScheduled) {
      return;
    }

    this.liveTranscriptFlushScheduled = true;
    const scheduleMicrotask = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (callback: () => void) => { void Promise.resolve().then(callback); };
    scheduleMicrotask(() => this.flushLiveTranscriptEvents());
  }

  private flushLiveTranscriptEvents(): void {
    this.liveTranscriptFlushScheduled = false;
    const sessionIds = [...this.pendingLiveTranscriptSessionIds];
    this.pendingLiveTranscriptSessionIds.clear();
    for (const sessionId of sessionIds) {
      this.emitTranscript(sessionId);
      this.emitSessionState(sessionId, 'runtime-status');
    }
  }

  async stopTurn(command: ChatRuntimeOwnerExecutorStopTurnCommand): Promise<void> {
    const normalizedSessionId = this.normalizeSessionId(command?.sessionId);
    const owner = this.readOwner();
    try {
      owner.agent.stop(normalizedSessionId);
    } finally {
      this.terminalizeStoppedOwnerTurn(owner, command?.turnId);
      this.publishStoppedSessionModelTranscript(normalizedSessionId, command?.turnId);
    }
    this.runtimeController.stopSession(normalizedSessionId);
    this.emitTranscript(normalizedSessionId);
    this.emitSessionState(normalizedSessionId, 'runtime-status');
  }

  private terminalizeStoppedOwnerTurn(owner: LexOwnerFacade, commandTurnId: string | null | undefined): void {
    const currentTurnId = typeof owner.turns.currentId === 'function'
      ? owner.turns.currentId()
      : null;
    if (!currentTurnId) {
      return;
    }

    const normalizedCommandTurnId = typeof commandTurnId === 'string' ? commandTurnId.trim() : '';
    if (normalizedCommandTurnId && normalizedCommandTurnId !== currentTurnId) {
      console.warn('[AilyChat][RuntimeOwner] stopTurn target differs from active owner turn', {
        targetTurnId: normalizedCommandTurnId,
        activeTurnId: currentTurnId,
      });
    }

    try {
      owner.turns.fail();
      return;
    } catch (error) {
      console.warn('[AilyChat][RuntimeOwner] stopTurn failed to mark active turn as failed; discarding incomplete turn', error);
    }

    try {
      owner.turns.discardIncomplete();
    } catch (error) {
      console.warn('[AilyChat][RuntimeOwner] stopTurn failed to discard active turn', error);
    }
  }

  async disposeSessionResources(
    command: ChatRuntimeOwnerExecutorDisposeSessionResourcesCommand,
  ): Promise<void> {
    this.disposeRuntimeSessionResources(command?.sessionId);
  }

  private disposeRuntimeSessionResources(sessionId: ChatRuntimeHostSessionId): void {
    const normalizedSessionId = this.normalizeSessionId(sessionId);
    this.runtimeController.disposeSession(normalizedSessionId);
    this.emitSessionState(normalizedSessionId, 'session-state');
    this.transcriptRevisions.delete(normalizedSessionId);
    this.submittedTurnIdAliases.delete(normalizedSessionId);
  }

  async resolveInteraction(
    command: ChatRuntimeOwnerExecutorResolveInteractionCommand,
  ): Promise<ChatRuntimeHostInteractionSnapshot | null> {
    const request = command?.request;
    if (!request || typeof request !== 'object') {
      throw new Error('[AilyChat][RuntimeOwner] resolveInteraction requires an interaction request.');
    }
    const normalizedSessionId = this.normalizeSessionId(request?.sessionId);
    switch (request.kind) {
      case 'question.complete': {
        const result = (request.payload as { result?: unknown } | null | undefined)?.result;
        this.runtimeInteractionHost.completeQuestion(normalizedSessionId, result as never);
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      }
      case 'question.skip':
        this.runtimeInteractionHost.skipQuestion(normalizedSessionId);
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      case 'confirmation.navigate':
        this.runtimeInteractionHost.navigateConfirmation(normalizedSessionId, Number(request.delta) || 0);
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      case 'confirmation.resolve': {
        const result = (request.payload as { result?: unknown } | null | undefined)?.result;
        if (request.id) {
          this.runtimeInteractionHost.resolveConfirmation(normalizedSessionId, request.id, result as never);
        }
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      }
      case 'confirmation.action': {
        const actionId = (request.payload as { actionId?: unknown } | null | undefined)?.actionId;
        if (request.id && typeof actionId === 'string') {
          this.runtimeInteractionHost.triggerConfirmationAction(normalizedSessionId, request.id, actionId);
        }
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      }
      case 'planReview.resolve': {
        const result = (request.payload as { result?: unknown } | null | undefined)?.result;
        if (request.id) {
          this.runtimeInteractionHost.resolvePlanReview(normalizedSessionId, request.id, result as never);
        }
        return this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
      }
      case 'commandSession.action': {
        const commandRequest = (request.payload as { request?: unknown } | null | undefined)?.request;
        const result = await this.runtimeInteractionHost.requestCommandSessionAction(
          normalizedSessionId,
          commandRequest as never,
        ) as RuntimeCommandSessionActionResult;
        const snapshot = this.runtimeInteractionHost.readSnapshot(normalizedSessionId);
        return {
          ...snapshot,
          commandSessionActionResult: result,
        } as unknown as ChatRuntimeHostInteractionSnapshot;
      }
    }
  }

  onEvent(
    listener: (
      event: ChatRuntimeHostEvent | ChatRuntimeOwnerExecutorRenderEventProgress | ChatRuntimeOwnerExecutorEvent
    ) => void,
  ): ChatRuntimeHostEventSubscription {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  private buildSessionState(
    sessionId: ChatRuntimeHostSessionId,
  ): ChatRuntimeHostSessionState {
    return this.runtimeController.buildSessionState(this.buildSessionSnapshotInput(sessionId));
  }

  private buildTranscriptSnapshot(
    sessionId: ChatRuntimeHostSessionId,
    revision = this.readTranscriptRevision(sessionId),
  ): ChatRuntimeHostTranscriptSnapshot {
    return this.runtimeController.buildTranscriptSnapshot(this.buildSessionSnapshotInput(sessionId, revision));
  }

  private emitSessionState(
    sessionId: ChatRuntimeHostSessionId,
    kind: 'session-state' | 'runtime-status',
    state = this.buildSessionState(sessionId),
  ): void {
    const event: ChatRuntimeHostEvent = {
      kind,
      sessionId,
      revision: state.transcriptRevision,
      state,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private emitTranscript(sessionId: ChatRuntimeHostSessionId): void {
    const transcript = this.buildTranscriptSnapshot(sessionId, this.nextTranscriptRevision(sessionId));
    const event: ChatRuntimeHostEvent = {
      kind: 'transcript',
      sessionId,
      revision: transcript.revision,
      transcript,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private emitRenderEventProgress(
    sessionId: ChatRuntimeHostSessionId | null | undefined,
    renderEvent: RenderEvent,
    request?: ChatRuntimeHostSubmitRequest | null,
  ): void {
    const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const requestTurnId = this.normalizeSubmittedTurnId(request?.activeResponseHandle);
    const eventTurnId = this.normalizeSubmittedTurnId((renderEvent as { readonly turnId?: unknown }).turnId);
    const turnId = requestTurnId
      || (eventTurnId ? this.resolveSubmittedTurnIdAlias(normalizedSessionId, eventTurnId) : '');
    if (requestTurnId && eventTurnId) {
      this.registerSubmittedTurnIdAlias(normalizedSessionId, eventTurnId, requestTurnId);
    }
    const normalizedRenderEvent = this.retargetRenderEventTurnId(renderEvent, turnId);
    const event: ChatRuntimeOwnerExecutorRenderEventProgress = {
      kind: 'render-event',
      sessionId: normalizedSessionId,
      turnId,
      request: request ?? undefined,
      revision: this.readTranscriptRevision(normalizedSessionId),
      renderEvent: normalizedRenderEvent,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private retargetRenderEventTurnId(renderEvent: RenderEvent, turnId: string): RenderEvent {
    if (!turnId || !renderEvent || typeof renderEvent !== 'object') {
      return renderEvent;
    }

    const currentTurnId = this.normalizeSubmittedTurnId((renderEvent as { readonly turnId?: unknown }).turnId);
    if (!currentTurnId || currentTurnId === turnId) {
      return renderEvent;
    }

    return {
      ...renderEvent,
      turnId,
    } as RenderEvent;
  }

  private emitRuntimeError(sessionId: ChatRuntimeHostSessionId, error: unknown): void {
    const maybeError = error as { message?: unknown; code?: unknown; retryable?: unknown } | null | undefined;
    const event: ChatRuntimeHostEvent = {
      kind: 'error',
      sessionId,
      revision: this.readTranscriptRevision(sessionId),
      error: {
        code: typeof maybeError?.code === 'string' ? maybeError.code : undefined,
        message: typeof maybeError?.message === 'string' ? maybeError.message : String(error || 'Unknown runtime error'),
        retryable: typeof maybeError?.retryable === 'boolean' ? maybeError.retryable : undefined,
      },
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private emitInteraction(snapshot: ChatRuntimeHostInteractionSnapshot): void {
    const event: ChatRuntimeHostEvent = {
      kind: 'interaction',
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      interaction: snapshot,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private emitViewRequest(request: ChatRuntimeHostViewRequest): void {
    const event: ChatRuntimeHostEvent = {
      kind: 'view-request',
      sessionId: request.sessionId,
      revision: this.readTranscriptRevision(request.sessionId),
      request,
    };
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private buildSessionSnapshotInput(
    sessionId: ChatRuntimeHostSessionId,
    transcriptRevision = this.readTranscriptRevision(sessionId),
  ) {
    return {
      sessionId,
      attachedViewIds: [],
      transcriptRevision,
    };
  }

  private readTranscriptRevision(sessionId: ChatRuntimeHostSessionId): number {
    return this.transcriptRevisions.get(sessionId) ?? 0;
  }

  private nextTranscriptRevision(sessionId: ChatRuntimeHostSessionId): number {
    const nextRevision = this.readTranscriptRevision(sessionId) + 1;
    this.transcriptRevisions.set(sessionId, nextRevision);
    return nextRevision;
  }

  private normalizeSessionId(sessionId: ChatRuntimeHostSessionId): ChatRuntimeHostSessionId {
    const normalizedSessionId = this.normalizeOptionalSessionId(sessionId);
    if (!normalizedSessionId) {
      throw new Error('[AilyChat][RuntimeOwner] Missing runtime session id.');
    }
    return normalizedSessionId;
  }

  private normalizeOptionalSessionId(sessionId: ChatRuntimeHostSessionId | null | undefined): ChatRuntimeHostSessionId | null {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    return normalizedSessionId || null;
  }

  private normalizeSubmitRequest(request: ChatRuntimeHostSubmitRequest): ChatRuntimeHostSubmitRequest {
    if (!request || typeof request !== 'object') {
      throw new Error('[AilyChat][RuntimeOwner] Missing runtime submit request.');
    }

    const sessionId = this.normalizeSessionId(request.sessionId);
    const requestText = typeof request.requestText === 'string' ? request.requestText.trim() : '';
    if (!requestText) {
      throw new Error('[AilyChat][RuntimeOwner] Missing runtime submit request text.');
    }

    const displayText = typeof request.displayText === 'string' && request.displayText.trim().length > 0
      ? request.displayText
      : requestText;

    return {
      ...request,
      sessionId,
      requestText,
      displayText,
      metadata: request.metadata ?? null,
    };
  }

  private projectSubmittedTurnExecutionContext(request: ChatRuntimeHostSubmitRequest): void {
    const hasProviderOptions = request.providerOptions !== undefined;
    const hasSelectedMode = request.selectedMode !== undefined;
    const hasCurrentModel = request.currentModel !== undefined;
    const hasAgentRuntimeMode = request.agentRuntimeMode !== undefined;
    const hasAgentRuntimeModeSource = request.agentRuntimeModeSource !== undefined;
    if (!hasProviderOptions && !hasSelectedMode && !hasCurrentModel && !hasAgentRuntimeMode && !hasAgentRuntimeModeSource) {
      return;
    }

    this.runtimeController.projectRuntimeState(request.sessionId, {
      ...(hasProviderOptions
        ? { providerOptions: request.providerOptions ? normalizeHostSessionProviderOptions(request.providerOptions) : null }
        : {}),
      ...(hasSelectedMode
        ? { selectedMode: request.selectedMode ? normalizeChatSelectedMode(request.selectedMode) : null }
        : {}),
      ...(hasCurrentModel
        ? { currentModel: request.currentModel ?? null }
        : {}),
      ...(hasAgentRuntimeMode
        ? { agentRuntimeMode: request.agentRuntimeMode ? normalizeChatAgentRuntimeMode(request.agentRuntimeMode) : null }
        : {}),
      ...(hasAgentRuntimeModeSource
        ? { agentRuntimeModeSource: request.agentRuntimeModeSource ? normalizeChatAgentRuntimeModeSource(request.agentRuntimeModeSource) : null }
        : {}),
      debugSummary: {
        ...(hasProviderOptions ? { providerOptionsPresent: !!request.providerOptions } : {}),
        ...(hasSelectedMode ? { selectedModePresent: !!request.selectedMode } : {}),
        ...(hasAgentRuntimeMode ? { agentRuntimeModePresent: !!request.agentRuntimeMode } : {}),
        ...(hasCurrentModel ? { currentModelPresent: !!request.currentModel } : {}),
      },
    }, {
      reason: 'state',
      listAffecting: false,
      highFrequency: false,
    });
  }
}

function hasAuthoritativeResponseModel(turnResponses: readonly TurnResponseTurn[] | null | undefined): boolean {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return false;
  }

  return turnResponses.some(turn => {
    const response = turn?.response as {
      readonly parts?: readonly unknown[];
      readonly resultText?: unknown;
      readonly content?: unknown;
      readonly rounds?: readonly unknown[];
    } | undefined;
    if (!response) {
      return false;
    }
    if (Array.isArray(response.parts) && response.parts.length > 0) {
      return true;
    }
    if (typeof response.resultText === 'string' && response.resultText.trim().length > 0) {
      return true;
    }
    if (typeof response.content === 'string' && response.content.trim().length > 0) {
      return true;
    }
    return Array.isArray(response.rounds) && response.rounds.length > 0;
  });
}

function selectLatestAuthoritativeResponseTurn(
  turnResponses: readonly TurnResponseTurn[] | null | undefined,
): TurnResponseTurn | null {
  if (!Array.isArray(turnResponses)) {
    return null;
  }
  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const turn = turnResponses[index];
    if (hasAuthoritativeResponseModel([turn])) {
      return turn;
    }
  }
  return null;
}

function terminalizeStoppedCanonicalTurnResponses(
  turnResponses: readonly TurnResponseTurn[],
  turnId: string | null | undefined,
): readonly TurnResponseTurn[] {
  if (!Array.isArray(turnResponses) || turnResponses.length === 0) {
    return [];
  }

  const normalizedTurnId = normalizeTurnIdentityString(turnId);
  const targetIndex = normalizedTurnId
    ? turnResponses.findIndex(turn => normalizeTurnIdentityString(turn?.turnId) === normalizedTurnId)
    : findLatestNonTerminalTurnIndex(turnResponses);
  if (targetIndex < 0) {
    return turnResponses;
  }

  return turnResponses.map((turn, index) => {
    if (index !== targetIndex) {
      return turn;
    }
    const response = turn.response ?? {};
    if (response.status === 'cancelled') {
      return turn;
    }
    const updatedAt = Date.now();
    return {
      ...turn,
      response: {
        ...response,
        status: 'cancelled',
        terminationReason: response.terminationReason ?? 'cancelled_by_user',
        updatedAt,
      },
      updatedAt,
    } as TurnResponseTurn;
  });
}

function findLatestNonTerminalTurnIndex(turnResponses: readonly TurnResponseTurn[]): number {
  for (let index = turnResponses.length - 1; index >= 0; index -= 1) {
    const status = turnResponses[index]?.response?.status;
    if (status !== 'completed' && status !== 'cancelled' && status !== 'error') {
      return index;
    }
  }
  return turnResponses.length - 1;
}

type TerminalOwnerBranchComparison = 'compatible' | 'shorter' | 'diverged';

function compareTerminalOwnerBranchToCanonical(
  canonicalTurnResponses: readonly TurnResponseTurn[],
  ownerTurnResponses: readonly TurnResponseTurn[],
): TerminalOwnerBranchComparison {
  if (ownerTurnResponses.length < canonicalTurnResponses.length) {
    return 'shorter';
  }

  for (let index = 0; index < canonicalTurnResponses.length; index += 1) {
    if (!isSameCanonicalTurnIdentity(canonicalTurnResponses[index], ownerTurnResponses[index])) {
      return 'diverged';
    }
  }

  return 'compatible';
}

function isSameCanonicalTurnIdentity(
  left: TurnResponseTurn | null | undefined,
  right: TurnResponseTurn | null | undefined,
): boolean {
  const leftTurnId = normalizeTurnIdentityString(left?.turnId);
  const rightTurnId = normalizeTurnIdentityString(right?.turnId);
  if (leftTurnId || rightTurnId) {
    return !!leftTurnId && leftTurnId === rightTurnId;
  }

  const leftRequestId = readTurnRequestIdentity(left);
  const rightRequestId = readTurnRequestIdentity(right);
  return !!leftRequestId && leftRequestId === rightRequestId;
}

function readTurnRequestIdentity(turn: TurnResponseTurn | null | undefined): string {
  const metadata = turn?.request?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  const requestId = (metadata as Record<string, unknown>)['requestId'];
  return normalizeTurnIdentityString(requestId);
}

function normalizeTurnIdentityString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
