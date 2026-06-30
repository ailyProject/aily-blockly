const RUNTIME_OWNER_REGISTER_CHANNEL = 'aily-chat-runtime-owner-register';
const RUNTIME_OWNER_UNREGISTER_CHANNEL = 'aily-chat-runtime-owner-unregister';
const HOST_COMMAND_CHANNEL = 'aily-chat-runtime-host-command';
const RUNTIME_OWNER_COMMAND_CHANNEL = 'aily-chat-runtime-owner-command';
const RUNTIME_OWNER_RESPONSE_CHANNEL = 'aily-chat-runtime-owner-response';
const RUNTIME_OWNER_EVENT_CHANNEL = 'aily-chat-runtime-owner-event';
const HOST_EVENT_CHANNEL = 'aily-chat-runtime-host-event';
const RESOURCE_HANDLER_REGISTER_CHANNEL = 'aily-chat-runtime-resource-handler-register';
const RESOURCE_HANDLER_UNREGISTER_CHANNEL = 'aily-chat-runtime-resource-handler-unregister';
const RESOURCE_HANDLER_COMMAND_CHANNEL = 'aily-chat-runtime-resource-handler-command';
const RESOURCE_HANDLER_RESPONSE_CHANNEL = 'aily-chat-runtime-resource-handler-response';
const {
  ChatRuntimeHostSessionStore,
  HOST_SESSION_STORE_MISS,
  isUsableWebContents,
  normalizeSessionId,
} = require('./chat-runtime-host-session-store');
const {
  ChatRuntimeHostRuntimeOwnerController,
  DEFAULT_COMMAND_TIMEOUT_MS,
} = require('./chat-runtime-host-runtime-owner-controller');

const channels = {
  RUNTIME_OWNER_REGISTER_CHANNEL,
  RUNTIME_OWNER_UNREGISTER_CHANNEL,
  HOST_COMMAND_CHANNEL,
  RUNTIME_OWNER_COMMAND_CHANNEL,
  RUNTIME_OWNER_RESPONSE_CHANNEL,
  RUNTIME_OWNER_EVENT_CHANNEL,
  HOST_EVENT_CHANNEL,
  RESOURCE_HANDLER_REGISTER_CHANNEL,
  RESOURCE_HANDLER_UNREGISTER_CHANNEL,
  RESOURCE_HANDLER_COMMAND_CHANNEL,
  RESOURCE_HANDLER_RESPONSE_CHANNEL,
};

const ALLOWED_METHODS = new Set([
  'attachView',
  'detachView',
  'submitTurn',
  'readSubmitReadiness',
  'ensureSessionCanRerun',
  'stopTurn',
  'disposeSession',
  'readSessionState',
  'readSessionInventory',
  'readTranscript',
  'awaitRequestCompletion',
  'runWorkspaceFinalizeBoundaryProbe',
  'readInteractionSnapshot',
  'resolveInteraction',
  'recordResourceRequest',
  'requestResourceOperation',
]);

function measureTextLength(value) {
  if (typeof value === 'string') {
    return value.length;
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + measureTextLength(item), 0);
  }
  if (typeof value.text === 'string') {
    return value.text.length;
  }
  if (typeof value.content === 'string') {
    return value.content.length;
  }
  if (typeof value.value === 'string') {
    return value.value.length;
  }
  if (Array.isArray(value.parts)) {
    return measureTextLength(value.parts);
  }
  if (Array.isArray(value.items)) {
    return measureTextLength(value.items);
  }
  return 0;
}

function summarizeTurnResponse(turn) {
  const response = turn && typeof turn === 'object' && turn.response && typeof turn.response === 'object'
    ? turn.response
    : null;
  const parts = response && Array.isArray(response.parts)
    ? response.parts
    : [];
  return {
    turnId: typeof turn?.turnId === 'string' ? turn.turnId : undefined,
    requestId: typeof turn?.requestId === 'string' ? turn.requestId : undefined,
    status: typeof turn?.status === 'string' ? turn.status : undefined,
    responseId: typeof response?.id === 'string' ? response.id : undefined,
    parts: parts.length,
    textLength: measureTextLength(parts),
  };
}

function summarizeTranscript(transcript) {
  const turns = transcript && Array.isArray(transcript.turns)
    ? transcript.turns
    : transcript && Array.isArray(transcript.turnResponses)
      ? transcript.turnResponses
      : [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  return {
    turns: turns.length,
    lastTurn: summarizeTurnResponse(lastTurn),
  };
}

function summarizeRuntimeOwnerPayload(payload) {
  const event = payload && typeof payload.event === 'object' ? payload.event : null;
  const state = event && typeof event.state === 'object' ? event.state : null;
  const renderEvent = payload && typeof payload.renderEvent === 'object' ? payload.renderEvent : null;
  return {
    kind: typeof payload?.kind === 'string' ? payload.kind : undefined,
    sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
    turnId: typeof payload?.turnId === 'string' ? payload.turnId : undefined,
    revision: Number(payload?.revision) || 0,
    hasTurn: !!payload?.turn,
    turn: payload?.turn ? summarizeTurnResponse(payload.turn) : undefined,
    hasRenderEvent: !!renderEvent,
    renderEventType: typeof renderEvent?.type === 'string' ? renderEvent.type : undefined,
    renderEventKind: typeof renderEvent?.kind === 'string' ? renderEvent.kind : undefined,
    nestedEventKind: typeof event?.kind === 'string' ? event.kind : undefined,
    stateRequestInProgress: typeof state?.requestInProgress === 'boolean' ? state.requestInProgress : undefined,
    stateActiveTurnId: typeof state?.activeTurnId === 'string' ? state.activeTurnId : undefined,
    hasInteraction: !!payload?.interaction,
    hasError: !!payload?.error,
  };
}

function summarizeCanonicalHostEvent(event) {
  const state = event && typeof event.state === 'object' ? event.state : null;
  return {
    kind: typeof event?.kind === 'string' ? event.kind : undefined,
    sessionId: typeof event?.sessionId === 'string' ? event.sessionId : undefined,
    revision: Number(event?.revision) || 0,
    transcript: event?.transcript ? summarizeTranscript(event.transcript) : undefined,
    turn: event?.turn ? summarizeTurnResponse(event.turn) : undefined,
    stateRequestInProgress: typeof state?.requestInProgress === 'boolean' ? state.requestInProgress : undefined,
    stateActiveTurnId: typeof state?.activeTurnId === 'string' ? state.activeTurnId : undefined,
    stateTranscriptRevision: Number(state?.transcriptRevision) || undefined,
    hasInteraction: !!event?.interaction,
    hasError: !!event?.error,
    requestKind: typeof event?.request?.kind === 'string' ? event.request.kind : undefined,
    requestPhase: typeof event?.request?.phase === 'string' ? event.request.phase : undefined,
  };
}

class ChatRuntimeHostProcessService {
  constructor(options = {}) {
    if (!options.BrowserWindow) {
      throw new Error('[AilyChat][RuntimeHost] BrowserWindow is required.');
    }
    this.BrowserWindow = options.BrowserWindow;
    this.hostSessionStore = new ChatRuntimeHostSessionStore();
    this.runtimeOwnerController = new ChatRuntimeHostRuntimeOwnerController({
      BrowserWindow: options.BrowserWindow,
      commandTimeoutMs: Number.isFinite(options.commandTimeoutMs)
        ? options.commandTimeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS,
      runtimeOwnerCommandChannel: RUNTIME_OWNER_COMMAND_CHANNEL,
      onCommandResult: (method, args, result) => this.hostSessionStore.cacheCommandResult(method, args, result),
      onRuntimeOwnerLost: error => this.handleRuntimeOwnerLost(error),
    });
    this.resourceOperationHandler = typeof options.resourceOperationHandler === 'function'
      ? options.resourceOperationHandler
      : null;
    this.resourceOperationSeed = 0;
    this.resourceOperationHandlerRenderer = null;
    this.resourceOperationCommandSeed = 0;
    this.pendingResourceOperationCommands = new Map();
    this.resourceOperationCommandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
      ? options.commandTimeoutMs
      : DEFAULT_COMMAND_TIMEOUT_MS;
  }

  setMainWindow(mainWindow) {
    this.mainWindowRef = mainWindow || null;
    this.runtimeOwnerController.setHostWindow(mainWindow);
  }

  setRuntimeOwnerWindow(runtimeOwnerWindow) {
    this.runtimeOwnerController.setRuntimeOwnerWindow(runtimeOwnerWindow);
  }

  async handleRuntimeOwnerRegister(event, payload = {}) {
    return this.runtimeOwnerController.handleRuntimeOwnerRegister(event, payload);
  }

  async handleRuntimeOwnerUnregister(event, payload = {}) {
    return this.runtimeOwnerController.handleRuntimeOwnerUnregister(event, payload);
  }

  async handleResourceOperationHandlerRegister(event, payload = {}) {
    this.assertResourceHandlerSender(event);
    const handlerId = typeof payload.handlerId === 'string' && payload.handlerId.trim()
      ? payload.handlerId.trim()
      : 'aily-chat-host-resource-handler';
    if (this.resourceOperationHandlerRenderer
      && this.resourceOperationHandlerRenderer.webContentsId !== event.sender.id) {
      throw new Error('[AilyChat][RuntimeHost] A different runtime resource handler is already registered.');
    }

    this.resourceOperationHandlerRenderer = {
      handlerId,
      webContentsId: event.sender.id,
      webContents: event.sender,
    };
    event.sender.once('destroyed', () => this.clearResourceOperationHandlerIfMatches(event.sender.id));
    return { ok: true, handlerId };
  }

  async handleResourceOperationHandlerUnregister(event, payload = {}) {
    if (!this.resourceOperationHandlerRenderer) {
      return { ok: true };
    }
    this.assertRegisteredResourceHandlerSender(event);
    const handlerId = typeof payload.handlerId === 'string' && payload.handlerId.trim()
      ? payload.handlerId.trim()
      : 'aily-chat-host-resource-handler';
    if (this.resourceOperationHandlerRenderer.handlerId !== handlerId) {
      throw new Error('[AilyChat][RuntimeHost] Runtime resource handler id mismatch during unregister.');
    }
    this.clearResourceOperationHandlerIfMatches(event.sender.id);
    return { ok: true };
  }

  async handleHostCommand(event, payload = {}) {
    const method = typeof payload.method === 'string' ? payload.method : '';
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`[AilyChat][RuntimeHost] Unsupported runtime host method: ${method || '<missing>'}`);
    }

    const args = Array.isArray(payload.args) ? payload.args : [];
    if (method === 'attachView') {
      return this.handleAttachView(event, args);
    }
    if (method === 'detachView') {
      return this.handleDetachView(args);
    }
    if (method === 'stopTurn') {
      return this.handleStopTurn(args);
    }
    if (method === 'disposeSession') {
      return this.handleDisposeSession(args);
    }
    if (method === 'submitTurn') {
      return this.handleSubmitTurn(args);
    }
    if (method === 'resolveInteraction') {
      return this.handleResolveInteraction(args);
    }
    if (method === 'recordResourceRequest') {
      return this.handleRecordResourceRequest(args);
    }
    if (method === 'requestResourceOperation') {
      return this.handleRequestResourceOperation(args);
    }
    if (method === 'runWorkspaceFinalizeBoundaryProbe') {
      return Promise.resolve();
    }
    const hostResult = this.hostSessionStore.readHostCommandResult(method, args);
    if (hostResult !== HOST_SESSION_STORE_MISS) {
      return hostResult;
    }

    const runtimeOwnerUnavailableHostResult = this.hostSessionStore.readRuntimeOwnerUnavailableHostCommandResult(method, args);
    if (runtimeOwnerUnavailableHostResult !== HOST_SESSION_STORE_MISS) {
      return runtimeOwnerUnavailableHostResult;
    }
    throw new Error(`[AilyChat][RuntimeHost] Host command is not implemented by the host service: ${method}.`);
  }

  handleAttachView(event, args) {
    const state = this.hostSessionStore.attachView(args && args[0], args && args[1], event && event.sender, args && args[2]);
    // attachView is a request/response command for the attaching renderer. The
    // renderer reads the authoritative transcript snapshot after the command
    // returns, so echoing session-state/transcript here creates a second empty
    // model pass during entry -> session transitions.
    this.replayPendingInteractionForAttachedSession(state && state.sessionId);
    this.replayViewRequestsForAttachedSession(state && state.sessionId);
    this.replayResourceRequestsForAttachedSession(state && state.sessionId);
    return state;
  }

  handleDetachView(args) {
    const state = this.hostSessionStore.detachView(args && args[0], args && args[1]);
    if (state) {
      this.broadcastSessionState('session-state', state);
    }
    return undefined;
  }

  async handleSubmitTurn(args) {
    const request = args && args[0];
    const runningState = this.hostSessionStore.beginSubmittedTurn(request);
    this.replayTranscriptForAttachedSession(runningState.sessionId);
    this.broadcastSessionState('runtime-status', runningState);
    const submittedRequest = this.hostSessionStore.readActiveSubmittedRequest(runningState.sessionId) || request;
    const startTurnCommand = {
      sessionId: runningState.sessionId,
      turnId: runningState.activeTurnId,
      request: submittedRequest,
      executionContext: {
        selectedMode: runningState.selectedMode ?? null,
        providerOptions: runningState.providerOptions ?? null,
        agentRuntimeMode: submittedRequest && submittedRequest.agentRuntimeMode !== undefined
          ? submittedRequest.agentRuntimeMode ?? null
          : null,
        agentRuntimeModeSource: submittedRequest && submittedRequest.agentRuntimeModeSource !== undefined
          ? submittedRequest.agentRuntimeModeSource ?? null
          : null,
        currentModel: runningState.currentModel ?? null,
        transcriptRevision: Number(runningState.transcriptRevision) || 0,
        protocolTruncation: submittedRequest && submittedRequest.protocolTruncation ? submittedRequest.protocolTruncation : null,
      },
    };
    if (!this.dispatchRuntimeOwnerCommandIfAvailable('startTurn', [startTurnCommand], runningState.sessionId, {
      failSubmittedTurnOnError: true,
      unavailableMessage: '[AilyChat][RuntimeHost] No registered runtime owner.',
    })) {
      const error = new Error('[AilyChat][RuntimeHost] No registered runtime owner.');
      error.code = 'runtime_owner_unavailable';
      error.retryable = true;
      this.failSubmittedTurnWithError(runningState.sessionId, error);
    }
    return this.hostSessionStore.buildSessionState(runningState.sessionId);
  }

  handleStopTurn(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    const previousState = this.hostSessionStore.buildSessionState(sessionId);
    const stoppedTranscript = this.hostSessionStore.cancelRunningTurn(
      sessionId,
      previousState && previousState.activeTurnId,
      previousState && previousState.transcriptRevision,
    );
    if (stoppedTranscript) {
      this.broadcastHostEvent({
        kind: 'transcript',
        sessionId: stoppedTranscript.sessionId,
        revision: Number(stoppedTranscript.revision) || 0,
        transcript: stoppedTranscript,
      });
    }
    const stoppedState = this.hostSessionStore.stopSession(sessionId);
    if (stoppedState) {
      this.broadcastSessionState('runtime-status', stoppedState);
    }
    this.dispatchRuntimeOwnerCommandIfAvailable('stopTurn', [{
      sessionId,
      turnId: previousState && previousState.activeTurnId,
    }], sessionId);
    return undefined;
  }

  handleDisposeSession(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    const disposedState = this.hostSessionStore.disposeSession(sessionId);
    if (disposedState) {
      this.broadcastSessionState('runtime-status', disposedState);
    }
    this.dispatchRuntimeOwnerCommandIfAvailable('disposeSessionResources', [{ sessionId }], sessionId);
    return undefined;
  }

  async handleResolveInteraction(args) {
    const request = args && args[0];
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] resolveInteraction requires a session id.');
    }
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      throw new Error('[AilyChat][RuntimeHost] No registered host runtime owner.');
    }
    const hostResolution = this.hostSessionStore.resolveInteractionRequest(request);
    const hostEvents = Array.isArray(hostResolution.events) ? hostResolution.events : [];
    for (const hostEvent of hostEvents) {
      if (hostEvent) {
        this.broadcastHostEvent(hostEvent);
      }
    }
    const ownerSnapshot = await this.runtimeOwnerController.dispatchCommand('resolveInteraction', [{
      sessionId,
      interactionId: typeof request.id === 'string' ? request.id : '',
      request,
    }]);
    return ownerSnapshot || hostResolution.snapshot;
  }

  handleRecordResourceRequest(args) {
    const request = args && args[0];
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] recordResourceRequest requires a session id.');
    }
    const event = this.hostSessionStore.cacheResourceRequestEvent({
      kind: 'resource-request',
      sessionId,
      request: {
        ...request,
        sessionId,
      },
    });
    if (event) {
      this.broadcastHostEvent(event);
    }
    return event;
  }

  async handleRequestResourceOperation(args) {
    const request = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
    const sessionId = normalizeSessionId(request && request.sessionId);
    const kind = this.normalizeResourceOperationKind(request && request.kind);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] requestResourceOperation requires a session id.');
    }
    if (!kind) {
      throw new Error('[AilyChat][RuntimeHost] requestResourceOperation requires a resource kind.');
    }

    const id = this.normalizeResourceOperationId(request && request.id, kind);
    const baseRequest = {
      id,
      sessionId,
      kind,
      ...(typeof request.label === 'string' && request.label.trim() ? { label: request.label.trim() } : {}),
      ...(typeof request.detail === 'string' && request.detail.trim() ? { detail: request.detail.trim() } : {}),
      ...(request.resource && typeof request.resource === 'object' ? { resource: request.resource } : {}),
    };
    const startedEvent = this.recordHostResourceRequest({
      ...baseRequest,
      phase: 'started',
    });
    if (!startedEvent) {
      throw new Error(`[AilyChat][RuntimeHost] Unsupported resource operation kind: ${kind}.`);
    }

    try {
      if (!this.resourceOperationHandler) {
        const result = await this.dispatchResourceOperationToRegisteredHandler({
          ...request,
          id,
          sessionId,
          kind,
        });
        this.recordHostResourceRequest({
          ...baseRequest,
          phase: 'completed',
        });
        return {
          id,
          sessionId,
          kind,
          ok: true,
          result,
        };
      }
      const result = await this.resourceOperationHandler({
        ...request,
        id,
        sessionId,
        kind,
      });
      this.recordHostResourceRequest({
        ...baseRequest,
        phase: 'completed',
      });
      return {
        id,
        sessionId,
        kind,
        ok: true,
        result,
      };
    } catch (error) {
      this.recordHostResourceRequest({
        ...baseRequest,
        phase: 'failed',
        error: this.toResourceOperationError(error),
      });
      throw error;
    }
  }

  dispatchResourceOperationToRegisteredHandler(request) {
    const resourceHandlerWebContents = this.readResourceOperationHandlerWebContents();
    if (!resourceHandlerWebContents) {
      const error = new Error(`[AilyChat][RuntimeHost] No host resource operation handler registered for ${request.kind}.`);
      error.code = 'resource_operation_handler_unavailable';
      error.retryable = true;
      throw error;
    }

    const requestId = this.nextResourceOperationCommandId(request.kind);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResourceOperationCommands.delete(requestId);
        reject(new Error(`[AilyChat][RuntimeHost] Runtime resource operation timed out: ${request.kind}`));
      }, this.resourceOperationCommandTimeoutMs);

      this.pendingResourceOperationCommands.set(requestId, { resolve, reject, timer, request });
      resourceHandlerWebContents.send(RESOURCE_HANDLER_COMMAND_CHANNEL, { requestId, request });
    });
  }

  handleResourceOperationHandlerResponse(event, payload = {}) {
    try {
      this.assertRegisteredResourceHandlerSender(event);
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
      const pending = this.pendingResourceOperationCommands.get(requestId);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingResourceOperationCommands.delete(requestId);
      if (payload.ok === false) {
        const error = new Error(payload.error?.message || '[AilyChat][RuntimeHost] Runtime resource operation failed.');
        if (payload.error?.code) {
          error.code = payload.error.code;
        }
        if (typeof payload.error?.retryable === 'boolean') {
          error.retryable = payload.error.retryable;
        }
        pending.reject(error);
        return;
      }
      pending.resolve(payload.result);
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored resource handler response:', error.message);
    }
  }

  clearResourceOperationHandlerIfMatches(webContentsId) {
    if (!this.resourceOperationHandlerRenderer || this.resourceOperationHandlerRenderer.webContentsId !== webContentsId) {
      return;
    }
    this.resourceOperationHandlerRenderer = null;
    const error = new Error('[AilyChat][RuntimeHost] Registered runtime resource handler was destroyed.');
    error.code = 'resource_handler_lost';
    error.retryable = true;
    for (const [requestId, pending] of this.pendingResourceOperationCommands) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingResourceOperationCommands.delete(requestId);
    }
  }

  assertResourceHandlerSender(event) {
    const senderWindow = event && event.sender ? this.BrowserWindow.fromWebContents(event.sender) : null;
    if (this.mainWindowRef && senderWindow !== this.mainWindowRef) {
      throw new Error('[AilyChat][RuntimeHost] Runtime resource handler must be registered by the host main window.');
    }
    if (!event || !event.sender) {
      throw new Error('[AilyChat][RuntimeHost] Runtime resource handler registration requires a sender.');
    }
  }

  assertRegisteredResourceHandlerSender(event) {
    if (!this.resourceOperationHandlerRenderer
      || !event
      || !event.sender
      || this.resourceOperationHandlerRenderer.webContentsId !== event.sender.id) {
      throw new Error('[AilyChat][RuntimeHost] Runtime resource handler message came from a non-resource-handler renderer.');
    }
  }

  readResourceOperationHandlerWebContents() {
    if (!this.resourceOperationHandlerRenderer || !isUsableWebContents(this.resourceOperationHandlerRenderer.webContents)) {
      if (this.resourceOperationHandlerRenderer) {
        this.clearResourceOperationHandlerIfMatches(this.resourceOperationHandlerRenderer.webContentsId);
      }
      return null;
    }
    return this.resourceOperationHandlerRenderer.webContents;
  }

  nextResourceOperationCommandId(kind) {
    this.resourceOperationCommandSeed += 1;
    return `chat_runtime_resource_${kind}_${Date.now().toString(36)}_${this.resourceOperationCommandSeed.toString(36)}`;
  }

  recordHostResourceRequest(request) {
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      return null;
    }
    const event = this.hostSessionStore.cacheResourceRequestEvent({
      kind: 'resource-request',
      sessionId,
      request: {
        ...request,
        sessionId,
      },
    });
    if (event) {
      this.broadcastHostEvent(event);
    }
    return event;
  }

  normalizeResourceOperationKind(kind) {
    return typeof kind === 'string' ? kind.trim() : '';
  }

  normalizeResourceOperationId(id, kind) {
    if (typeof id === 'string' && id.trim()) {
      return id.trim();
    }
    this.resourceOperationSeed += 1;
    return `resource_operation_${kind}_${Date.now().toString(36)}_${this.resourceOperationSeed.toString(36)}`;
  }

  toResourceOperationError(error) {
    const maybeError = error || {};
    return {
      code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
      message: typeof maybeError.message === 'string'
        ? maybeError.message
        : String(error || 'Resource operation failed.'),
      retryable: typeof maybeError.retryable === 'boolean' ? maybeError.retryable : undefined,
    };
  }

  dispatchRuntimeOwnerCommandIfAvailable(method, args, sessionId, options = {}) {
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      return false;
    }
    this.runtimeOwnerController.dispatchCommand(method, args)
      .catch(error => {
        console.error('[AilyChat][RuntimeHost] Runtime owner command dispatch failed:', {
          method,
          sessionId,
          message: error && error.message ? error.message : String(error || 'Unknown runtime owner error'),
          code: error && typeof error.code === 'string' ? error.code : undefined,
          stack: error && error.stack ? error.stack : undefined,
        });
        if (options.failSubmittedTurnOnError) {
          this.failSubmittedTurnWithError(sessionId, error);
          return;
        }
        this.broadcastRuntimeError(sessionId, error);
      });
    return true;
  }

  failSubmittedTurnWithError(sessionId, error) {
    const transcript = this.hostSessionStore.markSubmittedTurnFailed(sessionId, error);
    const failedState = this.hostSessionStore.failSubmittedTurn(sessionId);
    if (!failedState) {
      return;
    }
    if (transcript) {
      this.replayTranscriptForAttachedSession(failedState.sessionId);
    }
    this.broadcastRuntimeError(failedState.sessionId, error, failedState.transcriptRevision);
    this.broadcastSessionState('runtime-status', failedState);
  }

  handleRuntimeOwnerResponse(event, payload = {}) {
    try {
      this.runtimeOwnerController.handleRuntimeOwnerResponse(event, payload);
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner response:', error.message);
    }
  }

  handleRuntimeOwnerLost(error) {
    const failedStates = this.hostSessionStore.failRunningTurns();
    for (const failedState of failedStates) {
      this.broadcastRuntimeError(failedState.sessionId, error, failedState.transcriptRevision);
      this.broadcastSessionState('runtime-status', failedState);
    }
  }

  handleRuntimeOwnerEvent(event, payload = {}) {
    try {
      this.runtimeOwnerController.assertRegisteredRuntimeOwnerSender(event);
      console.log('[AilyChat][RuntimeOwnerEventIn]', JSON.stringify(summarizeRuntimeOwnerPayload(payload)));
      const canonicalEvents = this.hostSessionStore.cacheRuntimeOwnerEvent(payload);
      const eventList = Array.isArray(canonicalEvents) ? canonicalEvents : [canonicalEvents];
      console.log('[AilyChat][RuntimeOwnerEventOut]', JSON.stringify({
        sourceKind: typeof payload?.kind === 'string' ? payload.kind : undefined,
        sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
        turnId: typeof payload?.turnId === 'string' ? payload.turnId : undefined,
        canonicalEvents: eventList.filter(Boolean).map(item => summarizeCanonicalHostEvent(item)),
        dropped: !eventList.some(Boolean),
      }));
      for (const canonicalEvent of eventList) {
        if (canonicalEvent) {
          this.broadcastHostEvent(canonicalEvent);
        }
      }
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner event:', error.message);
    }
  }

  broadcastHostEvent(payload) {
    if (!this.isSessionViewScopedEvent(payload)) {
      this.broadcastHostEventToAllWindows(payload);
      return;
    }
    this.broadcastHostEventToAttachedViews(payload);
  }

  broadcastHostEventToAllWindows(payload) {
    for (const win of this.BrowserWindow.getAllWindows()) {
      try {
        if (win && !win.isDestroyed() && isUsableWebContents(win.webContents)) {
          win.webContents.send(HOST_EVENT_CHANNEL, payload);
        }
      } catch (error) {
        console.warn('[AilyChat][RuntimeHost] Failed to broadcast host event:', error.message);
      }
    }
  }

  broadcastSessionState(kind, state) {
    if (!state || !state.sessionId) {
      return;
    }
    this.broadcastHostEvent({
      kind,
      sessionId: state.sessionId,
      revision: Number(state.transcriptRevision) || 0,
      state,
    });
  }

  broadcastRuntimeError(sessionId, error, revision = 0) {
    const maybeError = error || {};
    this.broadcastHostEvent({
      kind: 'error',
      sessionId,
      revision: Number(revision) || 0,
      error: {
        code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
        message: typeof maybeError.message === 'string'
          ? maybeError.message
          : String(error || 'Unknown runtime host error'),
        retryable: typeof maybeError.retryable === 'boolean' ? maybeError.retryable : undefined,
      },
    });
  }

  broadcastHostEventToAttachedViews(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    if (!sessionId) {
      return;
    }
    for (const webContents of this.hostSessionStore.readAttachedViewWebContents(sessionId)) {
      try {
        webContents.send(HOST_EVENT_CHANNEL, payload);
      } catch (error) {
        console.warn('[AilyChat][RuntimeHost] Failed to send host event to attached view:', error.message);
      }
    }
  }

  replayViewRequestsForAttachedSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    for (const event of this.hostSessionStore.readViewRequestEvents(normalizedSessionId)) {
      this.broadcastHostEventToAttachedViews(event);
    }
  }

  replayTranscriptForAttachedSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const transcript = this.hostSessionStore.buildTranscriptSnapshot(normalizedSessionId);
    if (!transcript || (!Array.isArray(transcript.turnResponses) || transcript.turnResponses.length === 0)) {
      return;
    }
    this.broadcastHostEventToAttachedViews({
      kind: 'transcript',
      sessionId: normalizedSessionId,
      revision: Number(transcript.revision) || 0,
      transcript,
    });
  }

  replayPendingInteractionForAttachedSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const event = this.hostSessionStore.buildPendingInteractionEvent(normalizedSessionId);
    if (event) {
      this.broadcastHostEventToAttachedViews(event);
    }
  }

  replayResourceRequestsForAttachedSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    for (const event of this.hostSessionStore.readResourceRequestEvents(normalizedSessionId)) {
      this.broadcastHostEventToAttachedViews(event);
    }
  }

  isSessionViewScopedEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    switch (payload.kind) {
      case 'transcript':
      case 'turn-transcript':
      case 'interaction':
      case 'view-request':
      case 'resource-request':
      case 'error':
        return true;
      default:
        return false;
    }
  }
}

module.exports = {
  ChatRuntimeHostProcessService,
  channels,
};


