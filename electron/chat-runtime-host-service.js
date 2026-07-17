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
  clonePayload,
  isUsableWebContents,
  normalizeSessionId,
} = require('./chat-runtime-host-session-store');
const {
  ChatRuntimeHostRuntimeOwnerController,
  DEFAULT_COMMAND_TIMEOUT_MS,
} = require('./chat-runtime-host-runtime-owner-controller');
const { showNotification } = require('./notification');

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
  'prewarmRuntime',
  'restoreRuntimeSession',
  'readSessionExecutionState',
  'submitTurn',
  'readSubmitReadiness',
  'ensureSessionCanRerun',
  'stopTurn',
  'disposeSession',
  'readSessionState',
  'readSessionInventory',
  'readTranscript',
  'readSessionTurnPage',
  'readCheckpointNavigationState',
  'mutateSessionRequestList',
  'restoreSessionCheckpoint',
  'redoSessionCheckpoint',
  'forkSession',
  'awaitRequestCompletion',
  'runWorkspaceFinalizeBoundaryProbe',
  'readInteractionSnapshot',
  'resolveInteraction',
  'recordResourceRequest',
  'requestResourceOperation',
]);

const EXECUTION_HOST_ALLOWED_METHODS = new Set([
  'readSubmitReadiness',
  'ensureSessionCanRerun',
  'readSessionState',
  'readSessionInventory',
  'readTranscript',
  'readSessionTurnPage',
  'readCheckpointNavigationState',
  'mutateSessionRequestList',
  'restoreSessionCheckpoint',
  'redoSessionCheckpoint',
  'forkSession',
  'awaitRequestCompletion',
  'runWorkspaceFinalizeBoundaryProbe',
  'readInteractionSnapshot',
  'recordResourceRequest',
  'requestResourceOperation',
]);

function isRuntimeOwnerTraceEnabled() {
  const value = process && process.env
    ? (process.env.AILY_CHAT_TRACE_RUNTIME_OWNER_EVENTS || process.env.__AILY_CHAT_TRACE_RUNTIME_OWNER_EVENTS__)
    : '';
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

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

function summarizeInteraction(interaction) {
  const confirmationQueue = Array.isArray(interaction?.confirmationQueue)
    ? interaction.confirmationQueue
    : [];
  const activeConfirmation = confirmationQueue[
    Math.max(0, Math.min(Number(interaction?.activeConfirmationIndex) || 0, confirmationQueue.length - 1))
  ];
  return {
    sessionId: typeof interaction?.sessionId === 'string' ? interaction.sessionId : undefined,
    revision: Number(interaction?.revision) || 0,
    hasQuestion: !!interaction?.question,
    confirmationCount: confirmationQueue.length,
    activeConfirmationId: typeof activeConfirmation?.id === 'string' ? activeConfirmation.id : undefined,
    activeToolCallId: typeof activeConfirmation?.toolCallId === 'string' ? activeConfirmation.toolCallId : undefined,
    activeToolName: typeof activeConfirmation?.toolName === 'string' ? activeConfirmation.toolName : undefined,
    hasPlanReview: !!interaction?.activePlanReview,
  };
}

function traceActiveTurnDurability(phase, payload = {}) {
  try {
    console.info('[AilyChat][ActiveTurnDurability]', JSON.stringify({
      phase,
      ...payload,
    }));
  } catch {
    console.info('[AilyChat][ActiveTurnDurability]', phase);
  }
}

function isCheckpointOwnedTurn(turn) {
  const metadata = turn && turn.request && turn.request.metadata;
  return metadata && typeof metadata === 'object' && [
    'checkpointId',
    'checkpointNamespace',
    'checkpointRef',
    'checkpointRefs',
    'startCheckpointRef',
    'additionalCheckpointRefs',
    'additionalStartCheckpointRefs',
  ].some(key => metadata[key] !== undefined && metadata[key] !== null);
}

function normalizeTurnId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function hasCheckpointOwnedTurn(turns) {
  return (Array.isArray(turns) ? turns : []).some(isCheckpointOwnedTurn);
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
    this.pendingExecutionStarts = new Map();
    this.pendingExecutionTurnIds = new Map();
    this.showSystemNotification = typeof options.showSystemNotification === 'function'
      ? options.showSystemNotification
      : showNotification;
    this.notificationNeedsInputKeys = new Map();
    this.notificationRequestInProgress = new Map();
  }

  setMainWindow(mainWindow) {
    this.mainWindowRef = mainWindow || null;
    this.runtimeOwnerController.setHostWindow(mainWindow);
  }

  async handleRuntimeOwnerRegister(event, payload = {}) {
    return this.runtimeOwnerController.handleRuntimeOwnerRegister(event, payload);
  }

  async handleRuntimeOwnerUnregister(event, payload = {}) {
    return this.runtimeOwnerController.handleRuntimeOwnerUnregister(event, payload);
  }

  registerRuntimeOwnerTransport(transport = {}) {
    return this.runtimeOwnerController.registerRuntimeOwnerTransport(transport);
  }

  clearRuntimeOwnerTransport(ownerKey) {
    this.runtimeOwnerController.clearRuntimeOwnerIfMatches(ownerKey);
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
    if (method === 'prewarmRuntime') {
      return this.handlePrewarmRuntime(args);
    }
    if (method === 'restoreRuntimeSession') {
      return this.handleRestoreRuntimeSession(args);
    }
    if (method === 'readSessionExecutionState') {
      return this.handleReadSessionExecutionState(args);
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
    if (method === 'readSubmitReadiness') {
      return this.handleReadSubmitReadiness(args);
    }
    if (method === 'ensureSessionCanRerun') {
      return this.handleEnsureSessionCanRerun(args);
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
    if (method === 'mutateSessionRequestList') {
      return this.handleMutateSessionRequestList(args);
    }
    if (method === 'restoreSessionCheckpoint' || method === 'redoSessionCheckpoint') {
      return this.handleCheckpointMutation(method, args);
    }
    if (method === 'forkSession') {
      return this.handleForkSession(args);
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

  async handleExecutionHostCommand(payload = {}) {
    const method = typeof payload.method === 'string' ? payload.method : '';
    if (!EXECUTION_HOST_ALLOWED_METHODS.has(method)) {
      throw new Error(`[AilyChat][RuntimeHost] Unsupported execution-host method: ${method || '<missing>'}`);
    }

    const args = Array.isArray(payload.args) ? payload.args : [];
    if (method === 'recordResourceRequest') {
      return this.handleRecordResourceRequest(args);
    }
    if (method === 'requestResourceOperation') {
      return this.handleRequestResourceOperation(args);
    }
    if (method === 'runWorkspaceFinalizeBoundaryProbe') {
      return Promise.resolve();
    }
    if (method === 'mutateSessionRequestList') {
      return this.handleMutateSessionRequestList(args);
    }
    if (method === 'restoreSessionCheckpoint' || method === 'redoSessionCheckpoint') {
      return this.handleCheckpointMutation(method, args);
    }
    if (method === 'forkSession') {
      return this.handleForkSession(args);
    }

    const hostResult = this.hostSessionStore.readHostCommandResult(method, args);
    if (hostResult !== HOST_SESSION_STORE_MISS) {
      return hostResult;
    }
    const runtimeOwnerUnavailableHostResult = this.hostSessionStore.readRuntimeOwnerUnavailableHostCommandResult(method, args);
    if (runtimeOwnerUnavailableHostResult !== HOST_SESSION_STORE_MISS) {
      return runtimeOwnerUnavailableHostResult;
    }
    throw new Error(`[AilyChat][RuntimeHost] Execution-host command is not implemented by the host service: ${method}.`);
  }

  async handleExecutionHostResourceOperation(payload = {}) {
    const request = payload && payload.request && typeof payload.request === 'object'
      ? payload.request
      : payload;
    return this.handleRequestResourceOperation([clonePayload(request)]);
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

  async handlePrewarmRuntime(args) {
    const request = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] prewarmRuntime requires a session id.');
    }
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      return { sessionId, ensured: false };
    }
    const result = await this.runtimeOwnerController.dispatchCommand('prewarmRuntime', [{
      ...request,
      sessionId,
    }]);
    return result && typeof result === 'object'
      ? result
      : { sessionId, ensured: !!result };
  }

  async handleSubmitTurn(args) {
    const request = args && args[0];
    const submittedSessionId = normalizeSessionId(request && request.sessionId);
    if (!submittedSessionId) {
      throw new Error('[AilyChat][RuntimeHost] submitTurn requires a session id.');
    }
    await this.reconcileSessionExecutionState(submittedSessionId);
    const runningState = this.hostSessionStore.beginSubmittedTurn(request);
    this.pendingExecutionTurnIds.set(runningState.sessionId, runningState.activeTurnId);
    const requestMetadata = request && request.requestMetadata && typeof request.requestMetadata === 'object'
      ? request.requestMetadata
      : request && request.metadata && typeof request.metadata === 'object'
        ? request.metadata
        : null;
    const requestRouting = requestMetadata && requestMetadata.requestRouting && typeof requestMetadata.requestRouting === 'object'
      ? requestMetadata.requestRouting
      : null;
    const explicitAgentInvocation = requestMetadata && requestMetadata.explicitAgentInvocation && typeof requestMetadata.explicitAgentInvocation === 'object'
      ? requestMetadata.explicitAgentInvocation
      : null;
    console.warn('[AilyChat][RuntimeHostSubmitBoundary]', JSON.stringify({
      phase: 'begin-submitted-turn',
      sessionId: runningState.sessionId,
      activeTurnId: runningState.activeTurnId,
      hasRuntimeOwner: this.runtimeOwnerController.hasUsableRuntimeOwner(),
      requestTextLength: measureTextLength(request && request.requestText),
      customAgentTarget: requestRouting && typeof requestRouting.customAgentTarget === 'string'
        ? requestRouting.customAgentTarget
        : undefined,
      explicitAgentTarget: explicitAgentInvocation && typeof explicitAgentInvocation.targetAgent === 'string'
        ? explicitAgentInvocation.targetAgent
        : undefined,
      explicitAgentSource: explicitAgentInvocation && typeof explicitAgentInvocation.source === 'string'
        ? explicitAgentInvocation.source
        : undefined,
      hasExplicitAgentPrompt: !!(explicitAgentInvocation && typeof explicitAgentInvocation.prompt === 'string' && explicitAgentInvocation.prompt.length > 0),
      approvalPolicy: request && request.providerOptions ? request.providerOptions.approvalPolicy : undefined,
      approvalsReviewer: request && request.providerOptions ? request.providerOptions.approvalsReviewer : undefined,
      permissionMode: request && request.providerOptions ? request.providerOptions.permissionMode : undefined,
      permissionProfile: request && request.providerOptions ? request.providerOptions.permissionProfile : undefined,
    }));
    try {
      await this.persistHostSessionRecord(runningState.sessionId, 'submitted');
      traceActiveTurnDurability('submitted', {
        sessionId: runningState.sessionId,
        activeTurnId: runningState.activeTurnId,
        transcriptRevision: Number(runningState.transcriptRevision) || 0,
      });
    } catch (error) {
      this.clearPendingExecutionTransition(runningState.sessionId, runningState.activeTurnId);
      await this.failSubmittedTurnWithError(runningState.sessionId, error);
      throw error;
    }
    const currentState = this.hostSessionStore.buildSessionState(runningState.sessionId);
    if (currentState?.requestInProgress !== true
      || currentState.activeTurnId !== runningState.activeTurnId) {
      this.clearPendingExecutionTransition(runningState.sessionId, runningState.activeTurnId);
      return currentState;
    }
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
    if (!this.dispatchSubmittedTurnStart(startTurnCommand, runningState.sessionId)) {
      this.clearPendingExecutionTransition(runningState.sessionId, runningState.activeTurnId);
      const error = new Error('[AilyChat][RuntimeHost] No registered runtime owner.');
      error.code = 'runtime_owner_unavailable';
      error.retryable = true;
      await this.failSubmittedTurnWithError(runningState.sessionId, error);
    }
    return this.hostSessionStore.buildSessionState(runningState.sessionId);
  }

  async handleRestoreRuntimeSession(args) {
    const request = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
    const sessionId = normalizeSessionId(request.sessionId);
    if (!sessionId || !request.snapshot || request.snapshot.sessionId !== sessionId
      || !Array.isArray(request.snapshot.turns)) {
      throw new Error('[AilyChat][RuntimeHost] restoreRuntimeSession requires a matching session snapshot.');
    }
    if (!Array.isArray(request.turnResponses)) {
      throw new Error('[AilyChat][RuntimeHost] restoreRuntimeSession requires the canonical turn response list.');
    }
    const snapshotTurnIds = request.snapshot.turns.map(turn => normalizeTurnId(turn && turn.id));
    const responseTurnIds = request.turnResponses.map(turn => normalizeTurnId(turn && turn.turnId));
    if (snapshotTurnIds.length !== responseTurnIds.length
      || snapshotTurnIds.some((turnId, index) => !turnId || turnId !== responseTurnIds[index])) {
      throw new Error('[AilyChat][RuntimeHost] Runtime snapshot and canonical turn response list do not match.');
    }
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      throw new Error('[AilyChat][RuntimeHost] No registered host runtime owner.');
    }
    const { turnResponses, ...runtimeRequest } = request;
    const result = await this.runtimeOwnerController.dispatchCommand('restoreRuntimeSession', [{
      ...runtimeRequest,
      sessionId,
    }]);
    if (!result || result.sessionId !== sessionId || Number(result.turnCount) !== responseTurnIds.length) {
      throw new Error('[AilyChat][RuntimeHost] Execution owner restored an invalid request list.');
    }
    const transcript = this.hostSessionStore.restoreCanonicalTranscript(sessionId, turnResponses);
    return {
      ...result,
      transcriptRevision: Number(transcript && transcript.revision) || 0,
    };
  }

  async handleReadSessionExecutionState(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] readSessionExecutionState requires a session id.');
    }
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      return {
        sessionId,
        exists: false,
        requestInProgress: false,
        activeTurnId: null,
      };
    }
    const state = await this.runtimeOwnerController.dispatchCommand('readSessionExecutionState', [{ sessionId }]);
    return state && typeof state === 'object'
      ? state
      : {
          sessionId,
          exists: false,
          requestInProgress: false,
          activeTurnId: null,
        };
  }

  async handleReadSubmitReadiness(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    await this.reconcileSessionExecutionState(sessionId);
    return this.hostSessionStore.readHostCommandResult('readSubmitReadiness', [sessionId]);
  }

  async handleEnsureSessionCanRerun(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    const reconciliation = await this.reconcileSessionExecutionState(sessionId);
    const result = this.hostSessionStore.readHostCommandResult('ensureSessionCanRerun', [sessionId]);
    return result === HOST_SESSION_STORE_MISS
      ? result
      : {
          ...result,
          staleGateCleared: reconciliation.staleGateCleared,
        };
  }

  async handleStopTurn(args) {
    const rawCommand = args && args[0];
    const stopCommand = rawCommand && typeof rawCommand === 'object'
      ? rawCommand
      : { sessionId: rawCommand };
    const sessionId = normalizeSessionId(stopCommand && stopCommand.sessionId);
    const requestedTurnId = normalizeSessionId(stopCommand && stopCommand.turnId);
    const previousState = this.hostSessionStore.buildSessionState(sessionId);
    const targetTurnId = requestedTurnId || (previousState && previousState.activeTurnId) || null;
    this.clearPendingExecutionTransition(sessionId, targetTurnId);
    const stoppedTranscript = this.hostSessionStore.cancelRunningTurn(
      sessionId,
      targetTurnId,
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
    if (stoppedTranscript) {
      await this.persistHostSessionRecord(sessionId, 'cancelled', {
        requestInProgress: false,
        activeTurnId: null,
        status: 'stopped',
      });
      traceActiveTurnDurability('terminal', {
        sessionId,
        activeTurnId: targetTurnId,
        status: 'stopped',
        reason: 'explicit-stop',
        transcriptRevision: Number(stoppedTranscript.revision) || 0,
      });
    }
    await this.dispatchRuntimeOwnerCommandAndWaitIfAvailable('stopTurn', [{
      sessionId,
      turnId: targetTurnId,
    }], sessionId);
    const stoppedState = this.hostSessionStore.stopSession(sessionId);
    if (stoppedState) {
      this.broadcastSessionState('runtime-status', stoppedState);
    }
    return undefined;
  }

  async persistHostSessionRecord(sessionId, reason, statePatch, options) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return false;
    }
    const record = this.hostSessionStore.buildLiveHostSessionRecord(normalizedSessionId, statePatch, options);
    if (!record) {
      return false;
    }
    const request = {
      id: this.nextResourceOperationCommandId('save-current-session'),
      sessionId: normalizedSessionId,
      kind: 'save-current-session',
      label: 'Persist chat session',
      detail: typeof reason === 'string' && reason.trim() ? reason.trim() : undefined,
      payload: {
        adapter: 'chatHistory',
        record,
        ...(options && options.allowEmptyTranscript === true ? { allowEmptyTranscript: true } : {}),
      },
    };
    if (this.resourceOperationHandler) {
      await this.resourceOperationHandler(request);
    } else {
      await this.dispatchResourceOperationToRegisteredHandler(request);
    }
    return true;
  }

  async handleMutateSessionRequestList(args) {
    const request = args && args[0];
    const sessionId = normalizeSessionId(request && request.sessionId);
    const previousTranscript = this.hostSessionStore.buildTranscriptSnapshot(sessionId);
    const result = this.hostSessionStore.mutateSessionRequestList(request);
    try {
      await this.persistHostSessionRecord(result.sessionId, 'request-list-mutation', {
        requestInProgress: false,
        activeTurnId: null,
      }, {
        allowEmptyTranscript: true,
      });
      return result;
    } catch (error) {
      if (previousTranscript) {
        this.hostSessionStore.rollbackSessionRequestListMutation(previousTranscript, result.revision);
      }
      throw error;
    }
  }

  async handleCheckpointMutation(method, args) {
    const request = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
    const mutation = method === 'restoreSessionCheckpoint'
      ? this.hostSessionStore.restoreSessionCheckpoint(request)
      : this.hostSessionStore.redoSessionCheckpoint(request);
    try {
      await this.persistHostSessionRecord(mutation.sessionId, method, {
        requestInProgress: false,
        activeTurnId: null,
        status: 'completed',
      }, {
        allowEmptyTranscript: true,
      });
      const { previousTranscript: _previousTranscript, previousTimeline: _previousTimeline, ...result } = mutation;
      return result;
    } catch (error) {
      this.hostSessionStore.rollbackCheckpointMutation(mutation);
      throw error;
    }
  }

  async handleForkSession(args) {
    const request = args && args[0] && typeof args[0] === 'object' ? args[0] : {};
    const prepared = this.hostSessionStore.prepareForkSession(request);
    try {
      let forkedTurns = prepared.turnResponses;
      if (hasCheckpointOwnedTurn(forkedTurns)) {
        const checkpointTurns = prepared.turnResponses.filter(isCheckpointOwnedTurn);
        const metadataResult = await this.handleRequestResourceOperation([{
          sessionId: prepared.targetSessionId,
          kind: 'edit-tracking',
          label: 'Forking checkpoint metadata',
          detail: 'Host-owned session fork is cloning request checkpoint metadata.',
          payload: {
            adapter: 'editTracking',
            action: 'forkRequestCheckpointMetadata',
            sourceSessionResource: prepared.sourceSessionId,
            targetSessionResource: prepared.targetSessionId,
            retainedTurnResponses: checkpointTurns,
          },
        }]);
        const adjusted = metadataResult && metadataResult.result && metadataResult.result.forkedTurnResponses;
        if (!Array.isArray(adjusted) || adjusted.length !== checkpointTurns.length) {
          throw new Error('[AilyChat][RuntimeHost] Checkpoint metadata fork did not return the checkpoint request set.');
        }
        const adjustedByTurnId = new Map(adjusted.map(turn => [turn && turn.turnId, turn]));
        if (checkpointTurns.some(turn => !adjustedByTurnId.has(turn && turn.turnId))) {
          throw new Error('[AilyChat][RuntimeHost] Checkpoint metadata fork changed stable turn identity.');
        }
        forkedTurns = prepared.turnResponses.map(turn => adjustedByTurnId.get(turn && turn.turnId) || turn);
      }
      if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
        throw new Error('[AilyChat][RuntimeHost] No registered runtime owner for session fork.');
      }
      const runtimeResult = await this.runtimeOwnerController.dispatchCommand('forkSession', [{
        sourceSessionId: prepared.sourceSessionId,
        targetSessionId: prepared.targetSessionId,
        beforeTurnId: prepared.beforeTurnId,
        retainedTurnIds: prepared.retainedTurnIds,
        providerOptions: request.providerOptions || null,
        agentRuntimeMode: request.agentRuntimeMode || null,
        currentModel: request.currentModel || null,
      }]);
      if (!runtimeResult || runtimeResult.ensured !== true) {
        throw new Error('[AilyChat][RuntimeHost] Runtime snapshot fork was not created.');
      }
      const result = this.hostSessionStore.commitForkSession(request, prepared, forkedTurns);
      await this.persistHostSessionRecord(result.targetSessionId, 'session-fork');
      return result;
    } catch (error) {
      this.hostSessionStore.rollbackForkSession(prepared.targetSessionId);
      if (this.runtimeOwnerController.hasUsableRuntimeOwner()) {
        try {
          await this.runtimeOwnerController.dispatchCommand('disposeSessionResources', [{
            sessionId: prepared.targetSessionId,
          }]);
        } catch {
          // Preserve the original fork failure.
        }
      }
      throw error;
    }
  }

  async handleDisposeSession(args) {
    const sessionId = normalizeSessionId(args && args[0]);
    if (this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      await this.runtimeOwnerController.dispatchCommand('disposeSessionResources', [{ sessionId }]);
    }
    const disposedState = this.hostSessionStore.disposeSession(sessionId);
    if (disposedState) {
      this.broadcastSessionState('runtime-status', disposedState);
    }
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
      this.pendingResourceOperationCommands.set(requestId, { resolve, reject, request });
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
      console.info('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
        phase: 'missing-owner',
        method,
        sessionId,
      }));
      return false;
    }
    const owner = typeof this.runtimeOwnerController.snapshotRuntimeOwner === 'function'
      ? this.runtimeOwnerController.snapshotRuntimeOwner()
      : null;
    console.warn('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
      phase: 'dispatch',
      method,
      sessionId,
      activeTurnId: args && args[0] && args[0].turnId,
      owner,
    }));
    this.runtimeOwnerController.dispatchCommand(method, args)
      .then(result => {
        console.warn('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
          phase: 'result',
          method,
          sessionId,
          owner,
          resultStatus: result && result.status,
          requestInProgress: result && result.requestInProgress,
        }));
      })
      .catch(error => {
        console.error('[AilyChat][RuntimeHost] Runtime owner command dispatch failed:', {
          method,
          sessionId,
          message: error && error.message ? error.message : String(error || 'Unknown runtime owner error'),
          code: error && typeof error.code === 'string' ? error.code : undefined,
          stack: error && error.stack ? error.stack : undefined,
        });
        if (options.failSubmittedTurnOnError) {
          void this.failSubmittedTurnWithError(sessionId, error);
          return;
        }
        this.broadcastRuntimeError(sessionId, error);
      });
    return true;
  }

  dispatchSubmittedTurnStart(command, sessionId) {
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      return false;
    }

    const startPromise = this.runtimeOwnerController.dispatchCommand('startTurn', [command])
      .catch(async error => {
        await this.failSubmittedTurnWithError(sessionId, error);
        throw error;
      })
      .finally(() => {
        if (this.pendingExecutionStarts.get(sessionId) === startPromise) {
          this.pendingExecutionStarts.delete(sessionId);
        }
        this.clearPendingExecutionTransition(sessionId, command.turnId);
      });
    this.pendingExecutionStarts.set(sessionId, startPromise);
    void startPromise.catch(error => {
      console.error('[AilyChat][RuntimeHost] Runtime owner startTurn failed:', {
        sessionId,
        message: error && error.message ? error.message : String(error || 'Unknown runtime owner error'),
        code: error && typeof error.code === 'string' ? error.code : undefined,
      });
    });
    return true;
  }

  async reconcileSessionExecutionState(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      return { staleGateCleared: false };
    }

    const pendingStart = this.pendingExecutionStarts.get(normalizedSessionId);
    if (pendingStart) {
      await pendingStart.catch(() => undefined);
    }

    const ownerState = await this.runtimeOwnerController.dispatchCommand('readSessionExecutionState', [{
      sessionId: normalizedSessionId,
    }]);
    const hostState = this.hostSessionStore.buildSessionState(normalizedSessionId);
    const hostRequestInProgress = hostState?.requestInProgress === true
      || !!this.hostSessionStore.readActiveSubmittedRequest(normalizedSessionId);
    const ownerRequestInProgress = ownerState?.requestInProgress === true;
    const hostTurnId = typeof hostState?.activeTurnId === 'string' ? hostState.activeTurnId.trim() : '';
    const ownerTurnId = typeof ownerState?.activeTurnId === 'string' ? ownerState.activeTurnId.trim() : '';
    const pendingExecutionTurnId = this.pendingExecutionTurnIds.get(normalizedSessionId) || '';
    const executionStartPending = hostRequestInProgress
      && !ownerRequestInProgress
      && !!hostTurnId
      && pendingExecutionTurnId === hostTurnId;
    const turnMismatch = hostRequestInProgress
      && ownerRequestInProgress
      && !!hostTurnId
      && !!ownerTurnId
      && hostTurnId !== ownerTurnId;

    if (ownerRequestInProgress && (!hostRequestInProgress || turnMismatch)) {
      await this.runtimeOwnerController.dispatchCommand('stopTurn', [{
        sessionId: normalizedSessionId,
        turnId: ownerTurnId || undefined,
      }]);
    }

    if (hostRequestInProgress && (!ownerRequestInProgress || turnMismatch) && !executionStartPending) {
      const error = new Error(turnMismatch
        ? '[AilyChat][RuntimeHost] Execution owner turn identity diverged from the canonical response model.'
        : '[AilyChat][RuntimeHost] Execution owner no longer has the canonical active turn.');
      error.code = turnMismatch ? 'execution_turn_mismatch' : 'execution_turn_lost';
      error.retryable = true;
      await this.failSubmittedTurnWithError(normalizedSessionId, error);
    }

    const staleGateCleared = !executionStartPending
      && (ownerRequestInProgress !== hostRequestInProgress || turnMismatch);
    if (staleGateCleared) {
      console.warn('[AilyChat][ExecutionStateReconciled]', JSON.stringify({
        sessionId: normalizedSessionId,
        hostRequestInProgress,
        ownerRequestInProgress,
        hostTurnId: hostTurnId || null,
        ownerTurnId: ownerTurnId || null,
        turnMismatch,
      }));
    }
    return { staleGateCleared, executionStartPending };
  }

  clearPendingExecutionTransition(sessionId, turnId) {
    const pendingTurnId = this.pendingExecutionTurnIds.get(sessionId);
    if (!pendingTurnId || (turnId && pendingTurnId !== turnId)) {
      return;
    }
    this.pendingExecutionTurnIds.delete(sessionId);
  }

  async dispatchRuntimeOwnerCommandAndWaitIfAvailable(method, args, sessionId) {
    if (!this.runtimeOwnerController.hasUsableRuntimeOwner()) {
      console.warn('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
        phase: 'missing-owner',
        method,
        sessionId,
      }));
      return false;
    }
    const owner = typeof this.runtimeOwnerController.snapshotRuntimeOwner === 'function'
      ? this.runtimeOwnerController.snapshotRuntimeOwner()
      : null;
    console.info('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
      phase: 'dispatch-wait',
      method,
      sessionId,
      activeTurnId: args && args[0] && args[0].turnId,
      owner,
    }));
    try {
      const result = await this.runtimeOwnerController.dispatchCommand(method, args);
      console.info('[AilyChat][RuntimeHostOwnerDispatch]', JSON.stringify({
        phase: 'result-wait',
        method,
        sessionId,
        owner,
        resultStatus: result && result.status,
        requestInProgress: result && result.requestInProgress,
      }));
    } catch (error) {
      console.error('[AilyChat][RuntimeHost] Runtime owner command dispatch failed:', {
        method,
        sessionId,
        message: error && error.message ? error.message : String(error || 'Unknown runtime owner error'),
        code: error && typeof error.code === 'string' ? error.code : undefined,
        stack: error && error.stack ? error.stack : undefined,
      });
    }
    return true;
  }

  async failSubmittedTurnWithError(sessionId, error) {
    const transcript = this.hostSessionStore.markSubmittedTurnFailed(sessionId, error);
    if (transcript) {
      try {
        await this.persistHostSessionRecord(sessionId, 'failed', {
          requestInProgress: false,
          activeTurnId: null,
          status: 'failed',
        });
      } catch (persistError) {
        console.warn('[AilyChat][RuntimeHost] Failed to persist failed turn before clearing active state:', {
          sessionId,
          message: persistError && persistError.message ? persistError.message : String(persistError || 'Unknown persistence error'),
        });
      }
    }
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

  handleRuntimeOwnerTransportResponse(payload = {}) {
    try {
      this.runtimeOwnerController.handleRuntimeOwnerTransportResponse(payload);
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner transport response:', error.message);
    }
  }

  handleRuntimeOwnerLost(error) {
    const failedStates = this.hostSessionStore.failRunningTurns();
    for (const failedState of failedStates) {
      this.broadcastRuntimeError(failedState.sessionId, error, failedState.transcriptRevision);
      this.broadcastSessionState('runtime-status', failedState);
    }
  }

  async handleRuntimeOwnerEvent(event, payload = {}) {
    try {
      this.runtimeOwnerController.assertRegisteredRuntimeOwnerSender(event);
      await this.handleRuntimeOwnerTransportEvent(payload);
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner event:', error.message);
    }
  }

  async handleRuntimeOwnerTransportEvent(payload = {}) {
    try {
      const shouldTraceRuntimeOwnerEvents = isRuntimeOwnerTraceEnabled();
      if (payload && (payload.kind === 'turnInteractionRequested' || payload.interaction)) {
        console.warn('[AilyChat][RuntimeHostInteractionBoundary]', JSON.stringify({
          phase: 'owner-event-in',
          ownerKind: typeof payload.kind === 'string' ? payload.kind : undefined,
          sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
          turnId: typeof payload.turnId === 'string' ? payload.turnId : undefined,
          interaction: summarizeInteraction(payload.interaction),
        }));
      }
      if (shouldTraceRuntimeOwnerEvents) {
        console.log('[AilyChat][RuntimeOwnerEventIn]', JSON.stringify(summarizeRuntimeOwnerPayload(payload)));
      }
      const canonicalEvents = this.hostSessionStore.cacheRuntimeOwnerEvent(payload);
      const eventList = Array.isArray(canonicalEvents) ? canonicalEvents : [canonicalEvents];
      for (const canonicalEvent of eventList) {
        if (canonicalEvent && canonicalEvent.kind === 'interaction') {
          console.warn('[AilyChat][RuntimeHostInteractionBoundary]', JSON.stringify({
            phase: 'canonical-interaction',
            sessionId: canonicalEvent.sessionId,
            revision: Number(canonicalEvent.revision) || 0,
            interaction: summarizeInteraction(canonicalEvent.interaction),
          }));
        }
      }
      if (shouldTraceRuntimeOwnerEvents) {
        console.log('[AilyChat][RuntimeOwnerEventOut]', JSON.stringify({
          sourceKind: typeof payload?.kind === 'string' ? payload.kind : undefined,
          sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : undefined,
          turnId: typeof payload?.turnId === 'string' ? payload.turnId : undefined,
          canonicalEvents: eventList.filter(Boolean).map(item => summarizeCanonicalHostEvent(item)),
          dropped: !eventList.some(Boolean),
        }));
      }
      for (const canonicalEvent of eventList) {
        if (canonicalEvent) {
          this.broadcastHostEvent(canonicalEvent);
          this.updateSystemNotifications(canonicalEvent);
        }
      }
      await this.persistTerminalHostRecordFromEvents(eventList);
    } catch (error) {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner transport event:', error.message);
    }
  }

  async persistTerminalHostRecordFromEvents(events) {
    const eventList = Array.isArray(events) ? events : [];
    const persistOperations = [];
    for (const event of eventList) {
      const state = event && (event.kind === 'runtime-status' || event.kind === 'session-state')
        && event.state && typeof event.state === 'object'
        ? event.state
        : null;
      const sessionId = normalizeSessionId(state && state.sessionId);
      if (!sessionId || state.requestInProgress === true) {
        continue;
      }
      const status = typeof state.status === 'string' && state.status.trim()
        ? state.status.trim()
        : 'completed';
      if (status !== 'completed' && status !== 'failed' && status !== 'stopped' && status !== 'disposed') {
        continue;
      }
      persistOperations.push(this.persistHostSessionRecord(sessionId, 'terminal', {
        requestInProgress: false,
        activeTurnId: null,
        status,
      }).then(persisted => {
        if (persisted) {
          traceActiveTurnDurability('terminal', {
            sessionId,
            status,
            reason: 'runtime-owner-event',
          });
        }
      }, error => {
        console.warn('[AilyChat][RuntimeHost] Failed to persist terminal turn state:', {
          sessionId,
          status,
          message: error && error.message ? error.message : String(error || 'Unknown persistence error'),
        });
      }));
    }
    await Promise.all(persistOperations);
  }

  updateSystemNotifications(event) {
    const sessionId = normalizeSessionId(event && (event.sessionId || event.state?.sessionId));
    if (!sessionId) {
      return;
    }

    if (event.kind === 'interaction') {
      const input = this.readPendingInputNotification(event.interaction);
      const previousKey = this.notificationNeedsInputKeys.get(sessionId) || '';
      if (!input) {
        this.notificationNeedsInputKeys.delete(sessionId);
      } else if (input.key !== previousKey) {
        this.notificationNeedsInputKeys.set(sessionId, input.key);
        this.showChatSystemNotification(input.title, input.body);
      }
      return;
    }

    if (event.kind !== 'runtime-status' && event.kind !== 'session-state') {
      return;
    }
    const state = event.state && typeof event.state === 'object' ? event.state : null;
    if (!state) {
      return;
    }
    const wasRunning = this.notificationRequestInProgress.get(sessionId) === true;
    const isRunning = state.requestInProgress === true;
    this.notificationRequestInProgress.set(sessionId, isRunning);
    if (isRunning) {
      return;
    }

    this.notificationNeedsInputKeys.delete(sessionId);
    if (wasRunning && state.status === 'completed') {
      this.showChatSystemNotification(
        'Aily Chat 已完成',
        typeof state.title === 'string' && state.title.trim() ? state.title.trim() : '会话执行已完成。',
      );
    }
  }

  readPendingInputNotification(interaction) {
    if (!interaction || typeof interaction !== 'object') {
      return null;
    }
    const question = interaction.question && typeof interaction.question === 'object'
      ? interaction.question
      : null;
    if (question) {
      const questionId = String(question.partId || question.askId || question.id || 'question');
      const questions = Array.isArray(question.questions) ? question.questions : [];
      const firstQuestion = questions.find(item => item && typeof item.question === 'string');
      return {
        key: `question:${questionId}`,
        title: 'Aily Chat 需要你的回答',
        body: firstQuestion?.question || question.message || '会话正在等待你的输入。',
      };
    }

    const queue = Array.isArray(interaction.confirmationQueue) ? interaction.confirmationQueue : [];
    if (queue.length === 0) {
      return null;
    }
    const activeIndex = Math.max(0, Math.min(Number(interaction.activeConfirmationIndex) || 0, queue.length - 1));
    const confirmation = queue[activeIndex];
    if (!confirmation || typeof confirmation !== 'object') {
      return null;
    }
    const confirmationId = String(confirmation.id || confirmation.partId || confirmation.toolCallId || activeIndex);
    return {
      key: `confirmation:${confirmationId}`,
      title: 'Aily Chat 等待许可',
      body: confirmation.message || confirmation.title || confirmation.description || '需要你的许可才能继续。',
    };
  }

  showChatSystemNotification(title, body) {
    const targetWindow = this.mainWindowRef;
    if (targetWindow && !targetWindow.isDestroyed?.() && targetWindow.isFocused?.()) {
      return;
    }
    void Promise.resolve(this.showSystemNotification({
      title,
      body: String(body || '').replace(/`/g, "'"),
      timeoutType: 'default',
    }, targetWindow)).catch(error => {
      console.warn('[AilyChat][RuntimeHost] Failed to show chat system notification:',
        error && error.message ? error.message : String(error || 'Unknown notification error'));
    });
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
    const event = {
      kind,
      sessionId: state.sessionId,
      revision: Number(state.transcriptRevision) || 0,
      state,
    };
    this.broadcastHostEvent(event);
    this.updateSystemNotifications(event);
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
    const attachedViews = this.hostSessionStore.readAttachedViewWebContents(sessionId);
    if (payload && payload.kind === 'interaction') {
      console.warn('[AilyChat][RuntimeHostInteractionBoundary]', JSON.stringify({
        phase: 'broadcast-attached-views',
        sessionId,
        attachedViewCount: attachedViews.length,
        interaction: summarizeInteraction(payload.interaction),
      }));
    }
    for (const webContents of attachedViews) {
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
      case 'part-transcript':
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


