const HOST_SESSION_STORE_MISS = Symbol('aily-chat-runtime-host-session-store-miss');
const {
  ChatRuntimeHostTranscriptBuilder,
} = require('./chat-runtime-host-transcript-builder');

const MAX_VIEW_REQUEST_EVENTS_PER_SESSION = 50;
const MAX_RESOURCE_REQUEST_EVENTS_PER_SESSION = 100;

function isUsableWebContents(webContents) {
  return !!webContents && !webContents.isDestroyed();
}

function normalizeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : '';
}

function normalizeViewId(viewId) {
  return typeof viewId === 'string' && viewId.trim().length > 0
    ? viewId.trim()
    : '';
}

function normalizeInteractionId(interactionId) {
  return typeof interactionId === 'string' && interactionId.trim().length > 0
    ? interactionId.trim()
    : '';
}

function normalizeViewRequestId(requestId) {
  return typeof requestId === 'string' && requestId.trim().length > 0
    ? requestId.trim()
    : '';
}

function normalizeViewRequestKind(kind) {
  return kind === 'notification' || kind === 'todo-state' || kind === 'handoff'
    ? kind
    : '';
}

function normalizeResourceRequestId(requestId) {
  return typeof requestId === 'string' && requestId.trim().length > 0
    ? requestId.trim()
    : '';
}

function normalizeResourceRequestKind(kind) {
  return kind === 'abs-workspace-export'
    || kind === 'file-read'
    || kind === 'file-write'
    || kind === 'file-edit'
    || kind === 'workspace-mutation'
    || kind === 'project-info'
    || kind === 'project-build'
    || kind === 'project-lint'
    || kind === 'tool-approval'
    || kind === 'blockly-workspace'
    || kind === 'subapp-agent'
    || kind === 'board-search'
    || kind === 'library-analysis'
    || kind === 'diagnostics'
    || kind === 'session-title'
    || kind === 'save-current-session'
    || kind === 'history-persistence'
    ? kind
    : '';
}

function normalizeResourceRequestPhase(phase) {
  return phase === 'started' || phase === 'completed' || phase === 'failed'
    ? phase
    : '';
}

function normalizeTodoStatus(status) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'in-progress':
    case 'doing':
    case 'active':
    case 'running':
      return 'in-progress';
    case 'not-started':
    case 'pending':
    case 'todo':
    default:
      return 'not-started';
  }
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';
}

function normalizeVisibleAttachmentGeneration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function clonePayload(value) {
  if (value == null) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function readTurnParts(turn) {
  return Array.isArray(turn && turn.response && turn.response.parts)
    ? turn.response.parts
    : [];
}

function readTurnStatus(turn) {
  return typeof (turn && turn.response && turn.response.status) === 'string'
    ? turn.response.status
    : undefined;
}

function createCheckpointTimelineState(sessionId, turnResponses, options = {}) {
  const turns = Array.isArray(turnResponses) ? clonePayload(turnResponses) : [];
  const checkpoints = [];
  turns.forEach((turn, turnIndex) => {
    const metadata = turn && turn.request && turn.request.metadata && typeof turn.request.metadata === 'object'
      ? turn.request.metadata
      : null;
    const checkpointId = normalizeOptionalString(metadata && metadata.checkpointId);
    if (!checkpointId) {
      return;
    }
    const turnId = normalizeOptionalString(turn && turn.turnId);
    checkpoints.push({
      checkpointId,
      requestId: normalizeOptionalString(metadata && metadata.requestId) || turnId || checkpointId,
      ...(turnId ? { turnId } : {}),
      turnIndex,
    });
  });
  const lastCheckpointIndex = checkpoints.length - 1;
  const requestedCheckpointIndex = Number(options.currentCheckpointIndex);
  const currentCheckpointIndex = Number.isFinite(requestedCheckpointIndex)
    ? Math.max(-1, Math.min(lastCheckpointIndex, Math.floor(requestedCheckpointIndex)))
    : lastCheckpointIndex;
  const requestedTurnCount = Number(options.currentTurnResponseCount);
  const checkpointTurnCount = currentCheckpointIndex >= 0
    ? checkpoints[currentCheckpointIndex].turnIndex + 1
    : 0;
  const currentTurnResponseCount = Number.isFinite(requestedTurnCount)
    ? Math.max(0, Math.min(turns.length, Math.floor(requestedTurnCount)))
    : turns.length;
  return {
    sessionResource: sessionId,
    currentCheckpointIndex,
    currentTurnResponseCount: Math.max(currentCheckpointIndex >= 0 ? checkpointTurnCount : 0, currentTurnResponseCount),
    checkpoints,
    turnResponses: turns,
  };
}

function normalizeSessionScopeKey(value) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';
}

function createSessionScopeMismatchError(message) {
  const error = new Error(message);
  error.code = 'session_scope_mismatch';
  error.retryable = false;
  return error;
}

function createCheckpointRevisionMismatchError(expectedRevision, currentRevision) {
  const expected = Number(expectedRevision) || 0;
  const current = Number(currentRevision) || 0;
  const error = new Error(`Checkpoint revision mismatch: expected ${expected}, current ${current}.`);
  error.code = 'request_list_revision_mismatch';
  error.expectedRevision = expected;
  error.currentRevision = current;
  return error;
}

function buildCheckpointSidecar(sessionId, turnResponses, checkpointTimeline) {
  const timeline = checkpointTimeline && checkpointTimeline.sessionResource === sessionId
    ? clonePayload(checkpointTimeline)
    : createCheckpointTimelineState(sessionId, turnResponses);
  const checkpointMarker = {
    sessionResource: sessionId,
    currentCheckpointIndex: timeline.currentCheckpointIndex,
    currentTurnResponseCount: timeline.currentTurnResponseCount,
  };
  return timeline.checkpoints.length === 0 || timeline.turnResponses.length === 0
    ? { checkpointMarker }
    : {
        checkpointMarker,
        checkpointRedoBranch: {
          ...clonePayload(timeline),
        },
      };
}

function collectChangedTurnParts(previousTurn, nextTurn) {
  const previousParts = readTurnParts(previousTurn);
  const nextParts = readTurnParts(nextTurn);
  if (nextParts.length === 0) {
    return { parts: [], partIndices: [] };
  }
  const changed = [];
  const partIndices = [];
  nextParts.forEach((part, index) => {
    if (previousParts[index] !== part) {
      changed.push(part);
      partIndices.push(index);
    }
  });
  return { parts: changed, partIndices };
}

class ChatRuntimeHostSessionStore {
  constructor() {
    this.sessionStates = new Map();
    this.transcriptBuilder = new ChatRuntimeHostTranscriptBuilder();
    this.checkpointTimelines = new Map();
    this.editingSessionRevisions = new Map();
    this.turnDiffRevisions = new Map();
    this.interactions = new Map();
    this.viewRequestEvents = new Map();
    this.resourceRequestEvents = new Map();
    this.sessionInventoryMetadata = new Map();
    this.sessionScopeKeys = new Map();
    this.viewSessions = new Map();
    this.sessionViews = new Map();
    this.viewAttachmentGenerations = new Map();
    this.viewWebContents = new Map();
    this.completionWaiters = new Map();
    this.activeSubmittedRequests = new Map();
    this.submittedTurnSequence = 0;
    this.submittedCheckpointSequence = 0;
  }

  clearSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    this.sessionStates.delete(normalizedSessionId);
    this.transcriptBuilder.clearSession(normalizedSessionId);
    this.checkpointTimelines.delete(normalizedSessionId);
    this.editingSessionRevisions.delete(normalizedSessionId);
    this.turnDiffRevisions.delete(normalizedSessionId);
    this.interactions.delete(normalizedSessionId);
    this.viewRequestEvents.delete(normalizedSessionId);
    this.resourceRequestEvents.delete(normalizedSessionId);
    this.sessionInventoryMetadata.delete(normalizedSessionId);
    this.sessionScopeKeys.delete(normalizedSessionId);
    this.activeSubmittedRequests.delete(normalizedSessionId);
    this.resolveCompletionWaiters(normalizedSessionId);
    const viewIds = this.sessionViews.get(normalizedSessionId);
    if (viewIds) {
      for (const viewId of viewIds) {
        this.viewSessions.delete(viewId);
        this.viewAttachmentGenerations.delete(viewId);
        this.viewWebContents.delete(viewId);
      }
    }
    this.sessionViews.delete(normalizedSessionId);
  }

  readAttachedViewIds(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return [];
    }
    const viewIds = this.sessionViews.get(normalizedSessionId);
    return viewIds ? [...viewIds] : [];
  }

  readAttachedViewWebContents(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return [];
    }
    const viewIds = this.sessionViews.get(normalizedSessionId);
    if (!viewIds || viewIds.size === 0) {
      return [];
    }
    const webContentsList = [];
    const seenIds = new Set();
    for (const viewId of viewIds) {
      const webContents = this.viewWebContents.get(viewId);
      if (!isUsableWebContents(webContents) || seenIds.has(webContents.id)) {
        continue;
      }
      seenIds.add(webContents.id);
      webContentsList.push(webContents);
    }
    return webContentsList;
  }

  withAttachedViewIds(state) {
    if (!state || typeof state !== 'object') {
      return state;
    }
    const sessionId = normalizeSessionId(state.sessionId);
    if (!sessionId) {
      return state;
    }
    return {
      ...state,
      attachedViewIds: this.readAttachedViewIds(sessionId),
    };
  }

  buildSessionState(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const cachedState = this.sessionStates.get(normalizedSessionId);
    if (cachedState) {
      return this.withAttachedViewIds(clonePayload(cachedState));
    }
    return {
      sessionId: normalizedSessionId,
      status: 'idle',
      requestInProgress: false,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
      activeTurnId: null,
      transcriptRevision: this.transcriptBuilder.readTranscriptRevision(normalizedSessionId),
      selectedMode: null,
      providerOptions: null,
      currentModel: null,
    };
  }

  readKnownSessionIds() {
    const sessionIds = new Set();
    for (const sessionId of this.sessionStates.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.transcriptBuilder.readSessionIds()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.interactions.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.viewRequestEvents.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.resourceRequestEvents.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.sessionInventoryMetadata.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of this.sessionViews.keys()) {
      sessionIds.add(sessionId);
    }
    return [...sessionIds];
  }

  buildSessionInventorySnapshot() {
    const sessions = this.readKnownSessionIds()
      .map(sessionId => this.buildSessionInventoryItem(sessionId))
      .filter(Boolean)
      .sort((left, right) => {
        const leftRunning = left.requestInProgress === true ? 1 : 0;
        const rightRunning = right.requestInProgress === true ? 1 : 0;
        if (leftRunning !== rightRunning) {
          return rightRunning - leftRunning;
        }
        const revisionDelta = (Number(right.transcriptRevision) || 0) - (Number(left.transcriptRevision) || 0);
        if (revisionDelta !== 0) {
          return revisionDelta;
        }
        return String(left.sessionId).localeCompare(String(right.sessionId));
      });
    return {
      revision: sessions.reduce(
        (maxRevision, state) => Math.max(maxRevision, Number(state.transcriptRevision) || 0),
        0,
      ),
      sessions,
    };
  }

  buildSessionInventoryItem(sessionId) {
    const state = this.buildSessionState(sessionId);
    if (!state) {
      return null;
    }
    const metadata = this.sessionInventoryMetadata.get(state.sessionId) ?? {};
    return {
      ...metadata,
      ...state,
    };
  }

  buildTranscriptSnapshot(sessionId) {
    return this.transcriptBuilder.buildTranscriptSnapshot(sessionId);
  }

  buildSessionTurnPage(request, options = {}) {
    const input = request && typeof request === 'object' ? request : {};
    const sessionId = normalizeSessionId(input.sessionId);
    if (!sessionId) {
      return null;
    }
    const requestedScopeKey = normalizeSessionScopeKey(input.sessionScopeKey);
    const boundScopeKey = this.sessionScopeKeys.get(sessionId) ?? '';
    if (options.requireBoundScope === true) {
      if (!requestedScopeKey || !boundScopeKey || requestedScopeKey !== boundScopeKey) {
        throw createSessionScopeMismatchError('Turn page request does not match the attached session resource scope.');
      }
    }
    const sessionScopeKey = requestedScopeKey || boundScopeKey;
    const transcript = this.buildTranscriptSnapshot(sessionId);
    if (!transcript) {
      return null;
    }
    const turns = Array.isArray(transcript.turnResponses) ? transcript.turnResponses : [];
    const cursor = input.cursor ? decodeTurnPageCursor(input.cursor) : null;
    if (cursor && cursor.sessionId !== sessionId) {
      throw createInvalidTurnPageCursorError('Turn page cursor belongs to another session.');
    }
    if (cursor && cursor.sessionScopeKey !== sessionScopeKey) {
      throw createInvalidTurnPageCursorError('Turn page cursor belongs to another session resource scope.');
    }
    const direction = input.sortDirection === 'ascending' ? 'ascending' : 'descending';
    const anchorTurnId = cursor?.anchorTurnId ?? null;
    const includeAnchor = cursor?.includeAnchor === true;
    const itemsView = input.itemsView === 'notLoaded' || input.itemsView === 'full'
      ? input.itemsView
      : 'summary';
    const limit = Math.max(1, Math.min(100, Number.isFinite(Number(input.limit)) ? Math.floor(Number(input.limit)) : 30));
    let anchorIndex = direction === 'descending' ? turns.length - 1 : 0;
    if (anchorTurnId) {
      anchorIndex = turns.findIndex(turn => normalizeOptionalString(turn && turn.turnId) === anchorTurnId);
      if (anchorIndex < 0) {
        throw createInvalidTurnPageCursorError('Turn page anchor no longer exists in the session.');
      }
      if (!includeAnchor) {
        anchorIndex += direction === 'descending' ? -1 : 1;
      }
    }

    const pageTurns = [];
    let index = anchorIndex;
    while (index >= 0 && index < turns.length && pageTurns.length < limit) {
      pageTurns.push(projectTurnPageItemsView(clonePayload(turns[index]), itemsView));
      index += direction === 'descending' ? -1 : 1;
    }

    const firstTurnId = normalizeOptionalString(pageTurns[0] && pageTurns[0].turnId);
    const lastTurnId = normalizeOptionalString(pageTurns[pageTurns.length - 1] && pageTurns[pageTurns.length - 1].turnId);
    const hasNext = direction === 'descending' ? index >= 0 : index < turns.length;
    return {
      sessionId,
      data: pageTurns,
      nextCursor: hasNext && lastTurnId
        ? encodeTurnPageCursor({ sessionId, sessionScopeKey, anchorTurnId: lastTurnId, includeAnchor: false })
        : null,
      backwardsCursor: firstTurnId
        ? encodeTurnPageCursor({
            sessionId,
            sessionScopeKey,
            anchorTurnId: firstTurnId,
            includeAnchor: true,
          })
        : null,
      revision: Number(transcript.revision) || 0,
    };
  }

  mutateSessionRequestList(request) {
    const input = request && typeof request === 'object' ? request : {};
    const sessionId = normalizeSessionId(input.sessionId);
    const operation = input.operation && typeof input.operation === 'object' ? input.operation : {};
    const turnId = normalizeOptionalString(operation.turnId);
    if (!sessionId || operation.kind !== 'removeFromTurn' || !turnId) {
      const error = new Error('Unsupported request-list mutation.');
      error.code = 'invalid_request_list_mutation';
      throw error;
    }

    const state = this.buildSessionState(sessionId);
    if ((state && state.requestInProgress === true) || this.activeSubmittedRequests.has(sessionId)) {
      const error = new Error('Cannot mutate the request list while a turn is running.');
      error.code = 'request_in_progress';
      error.retryable = true;
      throw error;
    }

    const mutation = this.transcriptBuilder.removeFromTurn({
      sessionId,
      turnId,
      expectedRevision: input.expectedRevision,
    });
    this.checkpointTimelines.delete(sessionId);
    const revision = Number(mutation.transcript && mutation.transcript.revision) || 0;
    const nextState = {
      ...(state || {}),
      sessionId,
      transcriptRevision: revision,
      attachedViewIds: this.readAttachedViewIds(sessionId),
    };
    this.sessionStates.set(sessionId, clonePayload(nextState));
    const retainedTurnIds = clonePayload(mutation.retainedTurnIds);
    const discardedTurnIds = clonePayload(mutation.discardedTurnIds);
    const protocolTruncation = {
      kind: 'removeFrom',
      turnId,
      retainedTurnIds,
      discardedTurnIds,
    };
    return {
      sessionId,
      revision,
      operation: { kind: 'removeFromTurn', turnId },
      retainedTurnIds,
      discardedTurnIds,
      protocolTruncation,
      page: this.buildSessionTurnPage({
        sessionId,
        limit: Math.max(1, Math.min(100, Number(input.pageLimit) || 30)),
        sortDirection: 'descending',
        itemsView: 'full',
      }),
    };
  }

  readCheckpointTimeline(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const existing = this.checkpointTimelines.get(normalizedSessionId);
    if (existing) {
      return clonePayload(existing);
    }
    const transcript = this.buildTranscriptSnapshot(normalizedSessionId);
    const turns = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const timeline = createCheckpointTimelineState(normalizedSessionId, turns);
    this.checkpointTimelines.set(normalizedSessionId, clonePayload(timeline));
    return clonePayload(timeline);
  }

  readCheckpointNavigationState(request) {
    const input = request && typeof request === 'object' ? request : {};
    const sessionId = normalizeSessionId(input.sessionId);
    if (!sessionId || !this.hasHostSession(sessionId)) {
      return null;
    }
    const transcript = this.buildTranscriptSnapshot(sessionId);
    const timeline = this.readCheckpointTimeline(sessionId);
    if (!transcript || !timeline) {
      return null;
    }
    const checkpointId = normalizeOptionalString(input.checkpointId);
    const turnId = normalizeOptionalString(input.turnId);
    const cloneEntry = checkpoint => checkpoint ? clonePayload(checkpoint) : null;
    const requestedCheckpoint = checkpointId
      ? timeline.checkpoints.find(checkpoint => checkpoint.checkpointId === checkpointId)
      : turnId
        ? timeline.checkpoints.find(checkpoint => checkpoint.turnId === turnId || checkpoint.requestId === turnId)
        : null;
    return {
      sessionId,
      revision: Number(transcript.revision) || 0,
      checkpointCount: timeline.checkpoints.length,
      currentCheckpointIndex: timeline.currentCheckpointIndex,
      currentTurnResponseCount: timeline.currentTurnResponseCount,
      canRedo: timeline.currentCheckpointIndex + 1 < timeline.checkpoints.length,
      currentCheckpoint: cloneEntry(timeline.checkpoints[timeline.currentCheckpointIndex]),
      nextCheckpoint: cloneEntry(timeline.checkpoints[timeline.currentCheckpointIndex + 1]),
      requestedCheckpoint: cloneEntry(requestedCheckpoint),
    };
  }

  restoreSessionCheckpoint(request) {
    const input = request && typeof request === 'object' ? request : {};
    const sessionId = normalizeSessionId(input.sessionId);
    const checkpointId = normalizeOptionalString(input.checkpointId);
    this.assertCheckpointMutationAllowed(sessionId);
    const previousTranscript = this.buildTranscriptSnapshot(sessionId);
    const currentRevision = Number(previousTranscript && previousTranscript.revision) || 0;
    if (Number(input.expectedRevision) !== currentRevision) {
      throw createCheckpointRevisionMismatchError(input.expectedRevision, currentRevision);
    }
    const previousTimeline = this.readCheckpointTimeline(sessionId);
    const checkpointIndex = previousTimeline.checkpoints.findIndex(checkpoint => checkpoint.checkpointId === checkpointId);
    if (checkpointIndex < 0) {
      const error = new Error(`Checkpoint does not exist in the canonical response model: ${checkpointId}.`);
      error.code = 'checkpoint_not_found';
      throw error;
    }
    const checkpoint = previousTimeline.checkpoints[checkpointIndex];
    const nextTimeline = createCheckpointTimelineState(sessionId, previousTimeline.turnResponses, {
      currentCheckpointIndex: checkpointIndex - 1,
      currentTurnResponseCount: checkpoint.turnIndex,
    });
    const transcript = this.transcriptBuilder.replaceTurnResponses({
      sessionId,
      turnResponses: nextTimeline.turnResponses.slice(0, nextTimeline.currentTurnResponseCount),
      expectedRevision: currentRevision,
    });
    this.checkpointTimelines.set(sessionId, clonePayload(nextTimeline));
    this.updateCheckpointMutationSessionState(sessionId, transcript.revision);
    return this.buildCheckpointMutationResult({
      request: input,
      sessionId,
      checkpointId,
      direction: 'restore',
      transcript,
      timeline: nextTimeline,
      previousTranscript,
      previousTimeline,
    });
  }

  redoSessionCheckpoint(request) {
    const input = request && typeof request === 'object' ? request : {};
    const sessionId = normalizeSessionId(input.sessionId);
    const checkpointId = normalizeOptionalString(input.checkpointId);
    this.assertCheckpointMutationAllowed(sessionId);
    const previousTranscript = this.buildTranscriptSnapshot(sessionId);
    const currentRevision = Number(previousTranscript && previousTranscript.revision) || 0;
    if (Number(input.expectedRevision) !== currentRevision) {
      throw createCheckpointRevisionMismatchError(input.expectedRevision, currentRevision);
    }
    const previousTimeline = this.readCheckpointTimeline(sessionId);
    const nextCheckpointIndex = previousTimeline.currentCheckpointIndex + 1;
    const checkpoint = previousTimeline.checkpoints[nextCheckpointIndex];
    if (!checkpoint) {
      const error = new Error('No forward checkpoint is available to redo.');
      error.code = 'checkpoint_redo_unavailable';
      throw error;
    }
    if (checkpointId && checkpoint.checkpointId !== checkpointId) {
      const error = new Error(
        `Requested redo checkpoint is not the canonical next checkpoint: ${checkpointId}.`,
      );
      error.code = 'checkpoint_redo_identity_mismatch';
      throw error;
    }
    const nextTimeline = createCheckpointTimelineState(sessionId, previousTimeline.turnResponses, {
      currentCheckpointIndex: nextCheckpointIndex,
      currentTurnResponseCount: checkpoint.turnIndex + 1,
    });
    const transcript = this.transcriptBuilder.replaceTurnResponses({
      sessionId,
      turnResponses: nextTimeline.turnResponses.slice(0, nextTimeline.currentTurnResponseCount),
      expectedRevision: currentRevision,
    });
    this.checkpointTimelines.set(sessionId, clonePayload(nextTimeline));
    this.updateCheckpointMutationSessionState(sessionId, transcript.revision);
    return this.buildCheckpointMutationResult({
      request: input,
      sessionId,
      checkpointId: checkpoint.checkpointId,
      direction: 'redo',
      transcript,
      timeline: nextTimeline,
      previousTranscript,
      previousTimeline,
    });
  }

  rollbackCheckpointMutation(mutation) {
    if (!mutation || !mutation.previousTranscript || !mutation.previousTimeline) {
      return null;
    }
    const restored = this.transcriptBuilder.restoreAfterFailedRequestListMutation({
      transcript: mutation.previousTranscript,
      expectedRevision: mutation.revision,
    });
    this.checkpointTimelines.set(restored.sessionId, clonePayload(mutation.previousTimeline));
    this.updateCheckpointMutationSessionState(restored.sessionId, restored.revision);
    return restored;
  }

  assertCheckpointMutationAllowed(sessionId) {
    if (!sessionId) {
      const error = new Error('Checkpoint mutation requires a session id.');
      error.code = 'invalid_checkpoint_mutation';
      throw error;
    }
    const state = this.buildSessionState(sessionId);
    if ((state && state.requestInProgress === true) || this.activeSubmittedRequests.has(sessionId)) {
      const error = new Error('Cannot navigate checkpoints while a turn is running.');
      error.code = 'request_in_progress';
      error.retryable = true;
      throw error;
    }
  }

  updateCheckpointMutationSessionState(sessionId, revision) {
    const state = this.buildSessionState(sessionId) || {};
    this.sessionStates.set(sessionId, clonePayload({
      ...state,
      sessionId,
      status: 'completed',
      requestInProgress: false,
      activeTurnId: null,
      transcriptRevision: Number(revision) || 0,
      attachedViewIds: this.readAttachedViewIds(sessionId),
    }));
  }

  buildCheckpointMutationResult({ request, sessionId, checkpointId, direction, transcript, timeline, previousTranscript, previousTimeline }) {
    const previousIds = new Set((previousTranscript.turnResponses || [])
      .map(turn => normalizeOptionalString(turn && turn.turnId))
      .filter(Boolean));
    const retainedTurnIds = (transcript.turnResponses || [])
      .map(turn => normalizeOptionalString(turn && turn.turnId))
      .filter(Boolean);
    return {
      sessionId,
      checkpointId,
      direction,
      revision: Number(transcript.revision) || 0,
      retainedTurnIds,
      restoredTurnIds: retainedTurnIds.filter(turnId => !previousIds.has(turnId)),
      canRedo: timeline.currentCheckpointIndex < timeline.checkpoints.length - 1,
      checkpointTimeline: clonePayload(timeline),
      page: this.buildSessionTurnPage({
        sessionId,
        limit: Math.max(1, Math.min(100, Number(request.pageLimit) || 30)),
        sortDirection: 'descending',
        itemsView: 'full',
      }),
      previousTranscript: clonePayload(previousTranscript),
      previousTimeline: clonePayload(previousTimeline),
    };
  }

  prepareForkSession(request) {
    const input = request && typeof request === 'object' ? request : {};
    const sourceSessionId = normalizeSessionId(input.sourceSessionId);
    const targetSessionId = normalizeSessionId(input.targetSessionId);
    const sourceState = this.buildSessionState(sourceSessionId);
    if ((sourceState && sourceState.requestInProgress === true) || this.activeSubmittedRequests.has(sourceSessionId)) {
      const error = new Error('Cannot fork a session while a turn is running.');
      error.code = 'request_in_progress';
      error.retryable = true;
      throw error;
    }
    if (this.readKnownSessionIds().includes(targetSessionId)) {
      const error = new Error(`Session fork target already exists: ${targetSessionId}.`);
      error.code = 'session_fork_target_exists';
      throw error;
    }
    const prepared = this.transcriptBuilder.prepareForkPrefix({
      sourceSessionId,
      targetSessionId,
      beforeTurnId: input.beforeTurnId,
      expectedRevision: input.expectedRevision,
    });
    if (prepared.turnResponses.length === 0) {
      const error = new Error('Cannot fork before the first request.');
      error.code = 'empty_session_fork_prefix';
      throw error;
    }
    return prepared;
  }

  commitForkSession(request, prepared, turnResponses) {
    const input = request && typeof request === 'object' ? request : {};
    const sourceState = this.buildSessionState(prepared.sourceSessionId);
    if ((sourceState && sourceState.requestInProgress === true) || this.activeSubmittedRequests.has(prepared.sourceSessionId)) {
      const error = new Error('Cannot commit a session fork while the source turn is running.');
      error.code = 'request_in_progress';
      throw error;
    }
    const transcript = this.transcriptBuilder.commitForkTranscript({
      sourceSessionId: prepared.sourceSessionId,
      targetSessionId: prepared.targetSessionId,
      sourceRevision: prepared.sourceRevision,
      turnResponses,
    });
    const metadata = input.metadata && typeof input.metadata === 'object' ? clonePayload(input.metadata) : {};
    metadata.forkKind = 'protocol';
    metadata.forkedFromSessionId = prepared.sourceSessionId;
    metadata.forkedBeforeTurnId = prepared.beforeTurnId;
    metadata.forkedRetainedTurnCount = prepared.retainedTurnIds.length;
    this.sessionInventoryMetadata.set(prepared.targetSessionId, metadata);
    const sourceScopeKey = this.sessionScopeKeys.get(prepared.sourceSessionId);
    if (sourceScopeKey) {
      this.sessionScopeKeys.set(prepared.targetSessionId, sourceScopeKey);
    }
    this.sessionStates.set(prepared.targetSessionId, clonePayload({
      sessionId: prepared.targetSessionId,
      status: 'completed',
      requestInProgress: false,
      activeTurnId: null,
      attachedViewIds: this.readAttachedViewIds(prepared.targetSessionId),
      transcriptRevision: Number(transcript.revision) || 0,
      selectedMode: input.selectedMode || sourceState?.selectedMode || null,
      providerOptions: input.providerOptions || sourceState?.providerOptions || null,
      currentModel: input.currentModel || sourceState?.currentModel || null,
    }));
    this.checkpointTimelines.set(
      prepared.targetSessionId,
      createCheckpointTimelineState(prepared.targetSessionId, turnResponses),
    );
    return {
      sourceSessionId: prepared.sourceSessionId,
      targetSessionId: prepared.targetSessionId,
      sourceRevision: prepared.sourceRevision,
      targetRevision: Number(transcript.revision) || 0,
      retainedTurnIds: clonePayload(prepared.retainedTurnIds),
      forkKind: 'protocol',
      page: this.buildSessionTurnPage({
        sessionId: prepared.targetSessionId,
        limit: Math.max(1, Math.min(100, Number(input.pageLimit) || 30)),
        sortDirection: 'descending',
        itemsView: 'full',
      }),
    };
  }

  rollbackForkSession(targetSessionId) {
    this.clearSession(targetSessionId);
  }

  rollbackSessionRequestListMutation(previousTranscript, expectedRevision) {
    const restored = this.transcriptBuilder.restoreAfterFailedRequestListMutation({
      transcript: previousTranscript,
      expectedRevision,
    });
    const sessionId = normalizeSessionId(restored && restored.sessionId);
    if (!sessionId) {
      return null;
    }
    const state = this.buildSessionState(sessionId);
    this.sessionStates.set(sessionId, clonePayload({
      ...(state || {}),
      sessionId,
      transcriptRevision: Number(restored.revision) || 0,
      attachedViewIds: this.readAttachedViewIds(sessionId),
    }));
    return clonePayload(restored);
  }

  buildLiveHostSessionRecord(sessionId, statePatch, options = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const transcript = this.transcriptBuilder.buildTranscriptSnapshot(normalizedSessionId);
    const turnResponses = Array.isArray(transcript && transcript.turnResponses)
      ? clonePayload(transcript.turnResponses)
      : [];
    if (turnResponses.length === 0 && options.allowEmptyTranscript !== true) {
      return null;
    }
    const state = {
      ...(this.buildSessionState(normalizedSessionId) || {}),
      ...(statePatch && typeof statePatch === 'object' ? statePatch : {}),
    };
    const metadata = this.sessionInventoryMetadata.get(normalizedSessionId) ?? {};
    const now = Date.now();
    const activeTurnId = this.normalizeActiveTurnId(state.activeTurnId);
    return {
      sessionId: normalizedSessionId,
      metadata: {
        ...clonePayload(metadata),
        sessionId: normalizedSessionId,
        title: typeof metadata.title === 'string' ? metadata.title : '',
        ...(typeof metadata.titleSource === 'string' ? { titleSource: metadata.titleSource } : {}),
        ...(typeof metadata.sessionType === 'string' ? { sessionType: metadata.sessionType } : {}),
        projectPath: Object.prototype.hasOwnProperty.call(metadata, 'projectPath') ? metadata.projectPath : null,
        createdAt: typeof metadata.createdAt === 'number' && Number.isFinite(metadata.createdAt)
          ? metadata.createdAt
          : now,
        updatedAt: now,
        mode: typeof metadata.mode === 'string' && metadata.mode.trim()
          ? metadata.mode.trim()
          : typeof state.selectedMode === 'string' && state.selectedMode.trim()
            ? state.selectedMode.trim()
            : 'agent',
        model: state.currentModel ?? null,
        toolCallingIteration: 0,
      },
      turnResponses,
      sidecar: buildCheckpointSidecar(
        normalizedSessionId,
        turnResponses,
        this.checkpointTimelines.get(normalizedSessionId),
      ),
      auxiliary: {
        runtimeHost: {
          transcriptRevision: Number(transcript && transcript.revision) || Number(state.transcriptRevision) || 0,
          requestInProgress: state.requestInProgress === true,
          activeTurnId: activeTurnId || null,
          status: typeof state.status === 'string' ? state.status : null,
        },
      },
    };
  }

  buildInteractionSnapshot(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    if (this.interactions.has(normalizedSessionId)) {
      return clonePayload(this.interactions.get(normalizedSessionId));
    }
    return {
      sessionId: normalizedSessionId,
      revision: 0,
      question: null,
      confirmationQueue: [],
      activeConfirmationIndex: 0,
      activePlanReview: null,
      backgroundCommandSessionKeys: [],
      backgroundProcessIds: [],
      processInventoryRevision: 0,
      processes: [],
    };
  }

  buildPendingInteractionEvent(sessionId) {
    const interaction = this.buildInteractionSnapshot(sessionId);
    if (!this.hasPendingInteraction(interaction)) {
      return null;
    }
    return {
      kind: 'interaction',
      sessionId: interaction.sessionId,
      revision: Number(interaction.revision) || 0,
      interaction,
    };
  }

  readViewRequestEvents(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return [];
    }
    return (this.viewRequestEvents.get(normalizedSessionId) ?? []).map(event => clonePayload(event));
  }

  readResourceRequestEvents(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return [];
    }
    return (this.resourceRequestEvents.get(normalizedSessionId) ?? []).map(event => clonePayload(event));
  }

  hasHostSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    return !!normalizedSessionId
      && (this.sessionStates.has(normalizedSessionId)
        || this.transcriptBuilder.hasTranscript(normalizedSessionId)
        || this.interactions.has(normalizedSessionId)
        || this.sessionViews.has(normalizedSessionId));
  }

  attachView(viewId, sessionId, webContents, options) {
    const normalizedViewId = normalizeViewId(viewId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedViewId || !normalizedSessionId) {
      throw new Error('[AilyChat][RuntimeHost] attachView requires a view id and session id.');
    }
    const visibleAttachmentGeneration = normalizeVisibleAttachmentGeneration(
      options && options.visibleAttachmentGeneration,
    );
    if (visibleAttachmentGeneration === null) {
      throw new Error('[AilyChat][RuntimeHost] attachView requires a visible attachment generation.');
    }
    const sessionScopeKey = normalizeSessionScopeKey(options && options.sessionScopeKey);
    if (!sessionScopeKey) {
      throw new Error('[AilyChat][RuntimeHost] attachView requires a session resource scope key.');
    }

    const boundScopeKey = this.sessionScopeKeys.get(normalizedSessionId);
    const attachedViewIds = this.sessionViews.get(normalizedSessionId);
    const hasOtherAttachedView = !!attachedViewIds
      && [...attachedViewIds].some(attachedViewId => attachedViewId !== normalizedViewId);
    if (boundScopeKey && boundScopeKey !== sessionScopeKey && hasOtherAttachedView) {
      throw createSessionScopeMismatchError('Cannot rebind a session resource while another view is attached to its previous scope.');
    }
    this.sessionScopeKeys.set(normalizedSessionId, sessionScopeKey);

    const previousSessionId = this.viewSessions.get(normalizedViewId);
    if (previousSessionId && previousSessionId !== normalizedSessionId) {
      const previousViews = this.sessionViews.get(previousSessionId);
      if (previousViews) {
        previousViews.delete(normalizedViewId);
        if (previousViews.size === 0) {
          this.sessionViews.delete(previousSessionId);
        }
      }
      this.refreshSessionAttachedViews(previousSessionId);
    }

    this.viewSessions.set(normalizedViewId, normalizedSessionId);
    this.viewAttachmentGenerations.set(normalizedViewId, visibleAttachmentGeneration);
    if (isUsableWebContents(webContents)) {
      this.viewWebContents.set(normalizedViewId, webContents);
      webContents.once('destroyed', () => {
        if (this.viewWebContents.get(normalizedViewId) === webContents) {
          this.detachView(normalizedViewId);
        }
      });
    }
    let viewIds = this.sessionViews.get(normalizedSessionId);
    if (!viewIds) {
      viewIds = new Set();
      this.sessionViews.set(normalizedSessionId, viewIds);
    }
    viewIds.add(normalizedViewId);
    this.refreshSessionAttachedViews(normalizedSessionId);
    return this.buildSessionState(normalizedSessionId);
  }

  detachView(viewId, expectedSessionId) {
    const normalizedViewId = normalizeViewId(viewId);
    if (!normalizedViewId) {
      throw new Error('[AilyChat][RuntimeHost] detachView requires a view id.');
    }

    const boundSessionId = this.viewSessions.get(normalizedViewId);
    const normalizedExpectedSessionId = normalizeSessionId(expectedSessionId);
    if (normalizedExpectedSessionId && boundSessionId && boundSessionId !== normalizedExpectedSessionId) {
      throw new Error('[AilyChat][RuntimeHost] Runtime view is bound to a different session.');
    }

    const targetSessionId = normalizedExpectedSessionId || boundSessionId;
    if (!targetSessionId) {
      return null;
    }

    this.viewSessions.delete(normalizedViewId);
    this.viewAttachmentGenerations.delete(normalizedViewId);
    this.viewWebContents.delete(normalizedViewId);
    const viewIds = this.sessionViews.get(targetSessionId);
    if (viewIds) {
      viewIds.delete(normalizedViewId);
      if (viewIds.size === 0) {
        this.sessionViews.delete(targetSessionId);
      }
    }
    this.refreshSessionAttachedViews(targetSessionId);
    return this.buildSessionState(targetSessionId);
  }

  refreshSessionAttachedViews(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !this.sessionStates.has(normalizedSessionId)) {
      return;
    }
    this.sessionStates.set(
      normalizedSessionId,
      this.withAttachedViewIds(clonePayload(this.sessionStates.get(normalizedSessionId))),
    );
  }

  cacheSessionState(state) {
    const sessionId = normalizeSessionId(state && state.sessionId);
    if (!sessionId) {
      return null;
    }
    const nextState = clonePayload(this.withAttachedViewIds(state));
    this.sessionStates.set(sessionId, nextState);
    if (nextState.requestInProgress !== true) {
      this.resolveCompletionWaiters(sessionId);
    }
    return clonePayload(nextState);
  }

  cacheRuntimeOwnerReportedSessionState(state) {
    const sessionId = normalizeSessionId(state && state.sessionId);
    if (!sessionId || !this.hasHostSession(sessionId)) {
      return null;
    }

    const previousState = this.buildSessionState(sessionId);
    if (this.isHostTerminalStatus(previousState && previousState.status)) {
      return null;
    }

    const ownerState = clonePayload(state);
    const ownerRequestInProgress = ownerState && ownerState.requestInProgress === true;
    const ownerTranscriptRevision = Number(ownerState && ownerState.transcriptRevision) || 0;
    const previousTranscriptRevision = Number(previousState && previousState.transcriptRevision) || 0;
    const transcriptRevision = Math.max(previousTranscriptRevision, ownerTranscriptRevision);
    let nextState;

    if (previousState && previousState.requestInProgress === true) {
      if (ownerRequestInProgress) {
        const previousActiveTurnId = this.normalizeActiveTurnId(previousState.activeTurnId);
        const ownerActiveTurnId = this.resolveRuntimeOwnerVisibleTurnId({
          sessionId,
          turnId: ownerState.activeTurnId,
        });
        let nextTranscriptRevision = transcriptRevision;
        if (previousActiveTurnId && ownerActiveTurnId && previousActiveTurnId !== ownerActiveTurnId) {
          const previousTurnHasProgress = this.hasRuntimeOwnerTurnObservableProgress(sessionId, previousActiveTurnId);
          const migratedTranscript = previousTurnHasProgress
            ? this.seedRuntimeOwnerReportedActiveTurn({
              sessionId,
              turnId: ownerActiveTurnId,
              revision: transcriptRevision,
              ownerState,
            })
            : this.transcriptBuilder.replaceTurnId({
              sessionId,
              fromTurnId: previousActiveTurnId,
              toTurnId: ownerActiveTurnId,
              revision: transcriptRevision,
            });
          nextTranscriptRevision = Math.max(
            nextTranscriptRevision,
            Number(migratedTranscript && migratedTranscript.revision) || 0,
          );
        }
        nextState = {
          ...previousState,
          activeTurnId: ownerActiveTurnId || previousActiveTurnId || previousState.activeTurnId || null,
          transcriptRevision: nextTranscriptRevision,
          selectedMode: ownerState.selectedMode !== undefined
            ? ownerState.selectedMode ?? null
            : previousState.selectedMode ?? null,
          providerOptions: ownerState.providerOptions !== undefined
            ? ownerState.providerOptions ?? null
            : previousState.providerOptions ?? null,
          attachedViewIds: this.readAttachedViewIds(sessionId),
        };
      } else {
        nextState = {
          ...previousState,
          status: this.normalizeRuntimeOwnerSettledStatus(ownerState.status),
          requestInProgress: false,
          activeTurnId: this.normalizeActiveTurnId(ownerState.activeTurnId) || null,
          transcriptRevision,
          selectedMode: ownerState.selectedMode !== undefined
            ? ownerState.selectedMode ?? null
            : previousState.selectedMode ?? null,
          providerOptions: ownerState.providerOptions !== undefined
            ? ownerState.providerOptions ?? null
            : previousState.providerOptions ?? null,
          attachedViewIds: this.readAttachedViewIds(sessionId),
        };
      }
    } else {
      if (ownerRequestInProgress) {
        const ownerActiveTurnId = this.resolveRuntimeOwnerVisibleTurnId({
          sessionId,
          turnId: ownerState.activeTurnId,
        });
        const seededTranscript = this.seedRuntimeOwnerReportedActiveTurn({
          sessionId,
          turnId: ownerActiveTurnId,
          revision: transcriptRevision,
          ownerState,
        });
        const nextTranscriptRevision = Math.max(
          transcriptRevision,
          Number(seededTranscript && seededTranscript.revision) || 0,
        );
        nextState = {
          ...previousState,
          sessionId,
          status: 'running',
          requestInProgress: true,
          activeTurnId: ownerActiveTurnId || null,
          transcriptRevision: nextTranscriptRevision,
          selectedMode: ownerState.selectedMode !== undefined
            ? ownerState.selectedMode ?? null
            : previousState.selectedMode ?? null,
          providerOptions: ownerState.providerOptions !== undefined
            ? ownerState.providerOptions ?? null
            : previousState.providerOptions ?? null,
          attachedViewIds: this.readAttachedViewIds(sessionId),
        };
      } else {
      nextState = {
        ...previousState,
        status: this.normalizeIdleRuntimeOwnerStatus(previousState && previousState.status, ownerState.status),
        requestInProgress: false,
        activeTurnId: null,
        transcriptRevision,
        selectedMode: ownerState.selectedMode !== undefined
          ? ownerState.selectedMode ?? null
          : previousState.selectedMode ?? null,
        providerOptions: ownerState.providerOptions !== undefined
          ? ownerState.providerOptions ?? null
          : previousState.providerOptions ?? null,
        attachedViewIds: this.readAttachedViewIds(sessionId),
      };
      }
    }

    this.sessionStates.set(sessionId, clonePayload(nextState));
    if (nextState.requestInProgress !== true) {
      this.resolveCompletionWaiters(sessionId);
      this.activeSubmittedRequests.delete(sessionId);
    }
    return clonePayload(nextState);
  }

  cacheTranscript(transcript) {
    return this.transcriptBuilder.acceptTranscriptSnapshot(transcript);
  }

  restoreCanonicalTranscript(sessionId, turnResponses, checkpointTimeline) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !Array.isArray(turnResponses)) {
      const error = new Error('[AilyChat][RuntimeHost] Canonical transcript restore requires a session id and turn array.');
      error.code = 'invalid_session_restore';
      throw error;
    }
    const state = this.buildSessionState(normalizedSessionId);
    if ((state && state.requestInProgress === true) || this.activeSubmittedRequests.has(normalizedSessionId)) {
      const error = new Error('[AilyChat][RuntimeHost] Cannot restore the canonical transcript while a turn is running.');
      error.code = 'request_in_progress';
      error.retryable = true;
      throw error;
    }

    const restoredTimeline = this.restoreCheckpointTimeline(
      normalizedSessionId,
      turnResponses,
      checkpointTimeline,
    );
    const currentRevision = this.transcriptBuilder.readTranscriptRevision(normalizedSessionId);
    const transcript = this.transcriptBuilder.replaceTurnResponses({
      sessionId: normalizedSessionId,
      turnResponses,
      expectedRevision: currentRevision,
    });
    if (restoredTimeline) {
      this.checkpointTimelines.set(normalizedSessionId, clonePayload(restoredTimeline));
    } else {
      this.checkpointTimelines.delete(normalizedSessionId);
    }
    this.sessionStates.set(normalizedSessionId, clonePayload({
      ...(state || {}),
      sessionId: normalizedSessionId,
      requestInProgress: false,
      activeTurnId: null,
      transcriptRevision: Number(transcript.revision) || 0,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    }));
    return clonePayload(transcript);
  }

  restoreCheckpointTimeline(sessionId, visibleTurnResponses, checkpointTimeline) {
    if (!checkpointTimeline || typeof checkpointTimeline !== 'object') {
      return null;
    }
    if (normalizeSessionId(checkpointTimeline.sessionResource) !== sessionId
      || !Array.isArray(checkpointTimeline.turnResponses)) {
      const error = new Error('[AilyChat][RuntimeHost] Restored checkpoint timeline has an invalid session owner.');
      error.code = 'invalid_checkpoint_timeline_restore';
      throw error;
    }
    const restored = createCheckpointTimelineState(sessionId, checkpointTimeline.turnResponses, {
      currentCheckpointIndex: checkpointTimeline.currentCheckpointIndex,
      currentTurnResponseCount: checkpointTimeline.currentTurnResponseCount,
    });
    const visiblePrefix = restored.turnResponses.slice(0, restored.currentTurnResponseCount);
    const visibleIds = visibleTurnResponses.map(turn => normalizeOptionalString(turn && turn.turnId));
    const prefixIds = visiblePrefix.map(turn => normalizeOptionalString(turn && turn.turnId));
    if (visibleIds.length !== prefixIds.length
      || visibleIds.some((turnId, index) => !turnId || turnId !== prefixIds[index])) {
      const error = new Error('[AilyChat][RuntimeHost] Restored checkpoint cursor does not match the canonical visible request list.');
      error.code = 'checkpoint_timeline_visible_prefix_mismatch';
      throw error;
    }
    return restored;
  }

  buildTurnTranscriptEvent(transcript, turnId, revisionFallback = 0) {
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!transcript || !normalizedTurnId) {
      return null;
    }
    const turns = Array.isArray(transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const turn = turns.find(candidate => this.normalizeActiveTurnId(candidate && candidate.turnId) === normalizedTurnId);
    if (!turn) {
      return null;
    }
    return {
      kind: 'turn-transcript',
      sessionId: transcript.sessionId,
      turnId: normalizedTurnId,
      revision: Number(transcript.revision) || Number(revisionFallback) || 0,
      turn: clonePayload(turn),
    };
  }

  cacheRuntimeOwnerTurnSnapshot(payload) {
    const sessionId = payload && payload.sessionId;
    const turnId = payload && payload.turnId;
    const transcript = this.transcriptBuilder.acceptTurnSnapshot({
      sessionId,
      turnId,
      revision: payload && payload.revision,
      turn: this.retargetRuntimeOwnerTurnSnapshot(payload && payload.turn, turnId),
    });
    return this.buildTurnTranscriptEvent(
      transcript,
      turnId,
      payload && payload.revision,
    );
  }

  cacheRuntimeOwnerRenderEvent(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const renderEvent = payload && payload.renderEvent && typeof payload.renderEvent === 'object'
      ? payload.renderEvent
      : null;
    const normalizedTurnId = this.normalizeActiveTurnId(payload && payload.turnId);
    const beforeTurn = this.transcriptBuilder.readTurn(sessionId, normalizedTurnId);
    const transcript = this.transcriptBuilder.acceptRenderEvent({
      sessionId,
      turnId: payload && payload.turnId,
      revision: payload && payload.revision,
      request: (payload && payload.request) || this.readActiveSubmittedRequest(sessionId),
      event: this.retargetRuntimeOwnerRenderEvent(renderEvent, payload && payload.turnId),
    });
    const turns = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const nextTurn = turns.find(candidate => this.normalizeActiveTurnId(candidate && candidate.turnId) === normalizedTurnId) || null;
    const changed = collectChangedTurnParts(beforeTurn, nextTurn);
    const sourceEventType = typeof renderEvent?.type === 'string' ? renderEvent.type : null;
    const sourceEventTimestamp = Number.isFinite(Number(renderEvent?.timestamp))
      ? Number(renderEvent.timestamp)
      : null;
    const hostPublishedAt = Date.now();
    const beforeStatus = readTurnStatus(beforeTurn);
    const nextStatus = readTurnStatus(nextTurn);
    const requiresAuthoritativeTurn = !beforeTurn
      || readTurnParts(beforeTurn).length !== readTurnParts(nextTurn).length
      || beforeStatus !== nextStatus;
    const transcriptEvent = changed.parts.length > 0 && nextTurn
      ? {
          kind: 'part-transcript',
          sessionId,
          turnId: normalizedTurnId,
          revision: Number(transcript && transcript.revision) || Number(payload && payload.revision) || 0,
          parts: clonePayload(changed.parts),
          partIndices: [...changed.partIndices],
          ...(requiresAuthoritativeTurn ? { turn: clonePayload(nextTurn) } : {}),
          ...(readTurnStatus(nextTurn) ? { status: readTurnStatus(nextTurn) } : {}),
          ...(sourceEventType ? { sourceEventType } : {}),
          ...(sourceEventTimestamp !== null ? { sourceEventTimestamp } : {}),
          hostPublishedAt,
        }
      : {
          ...this.buildTurnTranscriptEvent(
            transcript,
            payload && payload.turnId,
            payload && payload.revision,
          ),
          ...(sourceEventType ? { sourceEventType } : {}),
          ...(sourceEventTimestamp !== null ? { sourceEventTimestamp } : {}),
          hostPublishedAt,
        };
    const interactionEvents = this.cacheInteractionFromRenderEvent({
      sessionId,
      revision: Number(payload && payload.revision) || Number(transcript && transcript.revision) || 0,
      renderEvent,
    });
    const todoViewRequestEvents = this.cacheTodoViewRequestFromRenderEvent({
      sessionId,
      revision: Number(payload && payload.revision) || Number(transcript && transcript.revision) || 0,
      renderEvent,
    });
    if (interactionEvents.length > 0 || todoViewRequestEvents.length > 0) {
      return [
        transcriptEvent,
        ...interactionEvents,
        ...todoViewRequestEvents,
      ].filter(Boolean);
    }
    return transcriptEvent;
  }

  cacheTodoViewRequestFromRenderEvent({ sessionId, revision, renderEvent }) {
    if (!sessionId || !renderEvent || typeof renderEvent !== 'object') {
      return [];
    }
    if (renderEvent.type !== 'todo_update') {
      return [];
    }
    const items = Array.isArray(renderEvent.items)
      ? renderEvent.items
      : [];
    const normalizedItems = items.map((item, index) => {
      const record = item && typeof item === 'object' ? item : {};
      const rawId = record.id;
      const numericId = typeof rawId === 'number' && Number.isFinite(rawId)
        ? rawId
        : typeof rawId === 'string' && rawId.trim().length > 0 && Number.isFinite(Number(rawId.trim()))
          ? Number(rawId.trim())
          : index + 1;
      const title = typeof record.activeForm === 'string' && record.activeForm.trim().length > 0
        ? record.activeForm.trim()
        : typeof record.title === 'string' && record.title.trim().length > 0
          ? record.title.trim()
          : typeof record.content === 'string' && record.content.trim().length > 0
            ? record.content.trim()
            : `Todo ${numericId}`;
      return {
        id: numericId,
        content: title,
        status: normalizeTodoStatus(record.status),
        priority: 'medium',
        updatedAt: Date.now(),
      };
    });
    const event = this.cacheViewRequestEvent({
      kind: 'view-request',
      sessionId,
      revision,
      request: {
        id: `todo-state:${sessionId}`,
        sessionId,
        kind: 'todo-state',
        todoState: {
          items: normalizedItems,
        },
      },
    });
    return event ? [event] : [];
  }

  cacheInteractionFromRenderEvent({ sessionId, revision, renderEvent }) {
    if (!sessionId || !renderEvent || typeof renderEvent !== 'object') {
      return [];
    }
    if (renderEvent.type === 'approval_request') {
      return this.cacheApprovalRequestInteractionFromRenderEvent({ sessionId, revision, renderEvent });
    }
    if (renderEvent.type === 'approval_resolve') {
      return this.cacheApprovalResolveInteractionFromRenderEvent({ sessionId, revision, renderEvent });
    }
    if (renderEvent.type !== 'question_request') {
      return [];
    }
    const requestId = normalizeInteractionId(renderEvent.requestId);
    if (!requestId) {
      return [];
    }
    const current = this.buildInteractionSnapshot(sessionId);
    if (!current) {
      return [];
    }
    const partId = `question:${requestId}`;
    const questions = Array.isArray(renderEvent.questions)
      ? renderEvent.questions.map(question => {
          const item = question && typeof question === 'object' ? question : {};
          return {
            question: typeof item.question === 'string' ? item.question : '',
            options: Array.isArray(item.options)
              ? item.options.map(option => {
                  const optionItem = option && typeof option === 'object' ? option : {};
                  return {
                    label: typeof optionItem.label === 'string' ? optionItem.label : '',
                    ...(typeof optionItem.description === 'string' ? { description: optionItem.description } : {}),
                    ...(typeof optionItem.recommended === 'boolean' ? { recommended: optionItem.recommended } : {}),
                  };
                })
              : undefined,
            allow_freeform: item.allow_freeform === true || item.allowFreeform === true,
            multi_select: item.multi_select === true || item.multiSelect === true,
          };
        })
      : [];
    const next = this.nextInteractionResult(current, {
      question: {
        sessionId,
        partId,
        data: {
          partId,
          isHistory: false,
          questions,
        },
      },
    });
    const state = this.cacheInteraction(next.snapshot);
    return [
      {
        kind: 'interaction',
        sessionId,
        revision: Number(next.snapshot.revision) || Number(revision) || 0,
        interaction: clonePayload(next.snapshot),
      },
      state ? this.buildSessionStateEvent('runtime-status', sessionId) : null,
    ].filter(Boolean);
  }

  cacheApprovalRequestInteractionFromRenderEvent({ sessionId, revision, renderEvent }) {
    const requestId = this.normalizeApprovalInteractionId(renderEvent);
    if (!requestId) {
      return [];
    }
    const current = this.buildInteractionSnapshot(sessionId);
    if (!current) {
      return [];
    }
    const queue = Array.isArray(current.confirmationQueue) ? current.confirmationQueue : [];
    const actions = Array.isArray(renderEvent.actions)
      ? renderEvent.actions
        .filter(action => action && typeof action === 'object')
        .map(action => clonePayload(action))
      : [];
    const toolCallId = normalizeInteractionId(renderEvent.toolCallId);
    const requestPartId = toolCallId || requestId;
    const confirmation = {
      sessionId,
      id: requestId,
      kind: toolCallId ? 'approval' : 'confirmation',
      partId: requestPartId,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolCallId ? {} : { askId: requestId }),
      toolName: typeof renderEvent.toolName === 'string' ? renderEvent.toolName : undefined,
      data: {
        kind: toolCallId ? 'approval' : 'confirmation',
        partId: requestPartId,
        ...(toolCallId ? { toolCallId } : { askId: requestId }),
        toolName: typeof renderEvent.toolName === 'string' ? renderEvent.toolName : undefined,
        title: typeof renderEvent.title === 'string' && renderEvent.title.trim()
          ? renderEvent.title
          : '确认操作',
        ...(typeof renderEvent.subtitle === 'string' ? { subtitle: renderEvent.subtitle } : {}),
        message: typeof renderEvent.message === 'string' ? renderEvent.message : '',
        args: renderEvent.input && typeof renderEvent.input === 'object' && !Array.isArray(renderEvent.input)
          ? clonePayload(renderEvent.input)
          : {},
        actions,
        primaryScope: typeof renderEvent.primaryScope === 'string' ? renderEvent.primaryScope : 'once',
        ...(typeof renderEvent.description === 'string' ? { description: renderEvent.description } : {}),
        ...(renderEvent.approveCombination && typeof renderEvent.approveCombination === 'object'
          ? { approveCombination: clonePayload(renderEvent.approveCombination) }
          : {}),
        ...(typeof renderEvent.allowAutoConfirm === 'boolean'
          ? { allowAutoConfirm: renderEvent.allowAutoConfirm }
          : {}),
      },
    };
    const nextQueue = queue.filter(entry => normalizeInteractionId(entry && entry.id) !== requestId).concat(confirmation);
    const next = this.nextInteractionResult(current, {
      confirmationQueue: nextQueue,
      activeConfirmationIndex: nextQueue.length - 1,
    });
    const state = this.cacheInteraction(next.snapshot);
    return [
      {
        kind: 'interaction',
        sessionId,
        revision: Number(next.snapshot.revision) || Number(revision) || 0,
        interaction: clonePayload(next.snapshot),
      },
      state ? this.buildSessionStateEvent('runtime-status', sessionId) : null,
    ].filter(Boolean);
  }

  cacheApprovalResolveInteractionFromRenderEvent({ sessionId, revision, renderEvent }) {
    const requestId = this.normalizeApprovalInteractionId(renderEvent);
    if (!requestId) {
      return [];
    }
    const current = this.buildInteractionSnapshot(sessionId);
    if (!current) {
      return [];
    }
    const queue = Array.isArray(current.confirmationQueue) ? current.confirmationQueue : [];
    const targetIndex = queue.findIndex(entry => normalizeInteractionId(entry && entry.id) === requestId);
    if (targetIndex < 0) {
      return [];
    }
    const nextQueue = queue.filter((_, index) => index !== targetIndex);
    const nextIndex = nextQueue.length === 0
      ? 0
      : Math.min(this.normalizeConfirmationIndex(current.activeConfirmationIndex, queue.length), nextQueue.length - 1);
    const next = this.nextInteractionResult(current, {
      confirmationQueue: nextQueue,
      activeConfirmationIndex: nextIndex,
    });
    const state = this.cacheInteraction(next.snapshot);
    return [
      {
        kind: 'interaction',
        sessionId,
        revision: Number(next.snapshot.revision) || Number(revision) || 0,
        interaction: clonePayload(next.snapshot),
      },
      state ? this.buildSessionStateEvent('runtime-status', sessionId) : null,
    ].filter(Boolean);
  }

  normalizeApprovalInteractionId(renderEvent) {
    const toolCallId = normalizeInteractionId(renderEvent && renderEvent.toolCallId);
    if (toolCallId) {
      return toolCallId;
    }
    const requestId = normalizeInteractionId(renderEvent && renderEvent.requestId);
    return requestId ? `confirmation:${requestId}` : '';
  }

  cacheInteraction(interaction) {
    const sessionId = normalizeSessionId(interaction && interaction.sessionId);
    if (!sessionId) {
      return null;
    }
    this.interactions.set(sessionId, clonePayload(interaction));
    return this.applyInteractionDerivedSessionState(sessionId);
  }

  hasPendingInteraction(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return false;
    }
    if (snapshot.question && typeof snapshot.question === 'object') {
      return true;
    }
    if (Array.isArray(snapshot.confirmationQueue) && snapshot.confirmationQueue.length > 0) {
      return true;
    }
    if (snapshot.activePlanReview && typeof snapshot.activePlanReview === 'object') {
      return true;
    }
    return (
      (Array.isArray(snapshot.backgroundCommandSessionKeys)
        && snapshot.backgroundCommandSessionKeys.length > 0)
      || (Array.isArray(snapshot.backgroundProcessIds)
        && snapshot.backgroundProcessIds.length > 0)
    );
  }

  applyInteractionDerivedSessionState(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !this.hasHostSession(normalizedSessionId)) {
      return null;
    }
    const previousState = this.buildSessionState(normalizedSessionId);
    if (!previousState || this.isHostTerminalStatus(previousState.status)) {
      return null;
    }
    const pending = this.hasPendingInteraction(this.buildInteractionSnapshot(normalizedSessionId));
    const nextStatus = pending
      ? 'needs_input'
      : previousState.requestInProgress === true
        ? 'running'
        : previousState.status;
    if (previousState.status === nextStatus) {
      return null;
    }
    const nextState = {
      ...previousState,
      status: nextStatus,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    };
    this.sessionStates.set(normalizedSessionId, clonePayload(nextState));
    return clonePayload(nextState);
  }

  resolveInteractionRequest(request) {
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] resolveInteraction requires a session id.');
    }
    this.assertAttachedInteractionView(request, sessionId);

    const kind = typeof request.kind === 'string' ? request.kind : '';
    const current = this.buildInteractionSnapshot(sessionId);
    const requestId = normalizeInteractionId(request.id);
    let next = null;

    switch (kind) {
      case 'question.complete':
      case 'question.skip':
        next = this.resolveQuestionInteraction(current, requestId, kind);
        break;
      case 'confirmation.navigate':
        next = this.resolveConfirmationNavigateInteraction(current, requestId, Number(request.delta) || 0);
        break;
      case 'confirmation.resolve':
        next = this.resolveConfirmationInteraction(current, requestId);
        break;
      case 'confirmation.action':
        next = this.validateConfirmationActionInteraction(current, requestId);
        break;
      case 'planReview.resolve':
        next = this.resolvePlanReviewInteraction(current, requestId);
        break;
      case 'commandSession.action':
        next = this.validateCommandSessionInteraction(current);
        break;
      default:
        throw this.createInteractionError(`Unknown interaction request kind: ${kind || '<missing>'}.`);
    }

    const stateAfterInteraction = next.changed
      ? this.cacheInteraction(next.snapshot)
      : null;
    return {
      snapshot: clonePayload(next.snapshot),
      events: [
        next.changed
          ? {
            kind: 'interaction',
            sessionId,
            revision: Number(next.snapshot.revision) || 0,
            interaction: clonePayload(next.snapshot),
          }
          : null,
        stateAfterInteraction ? this.buildSessionStateEvent('runtime-status', sessionId) : null,
      ].filter(Boolean),
    };
  }

  assertAttachedInteractionView(request, sessionId) {
    const viewId = normalizeViewId(request && request.viewId);
    if (!viewId) {
      throw this.createInteractionError('Stale interaction request with no attached runtime view.');
    }

    const boundSessionId = this.viewSessions.get(viewId);
    if (boundSessionId !== sessionId) {
      throw this.createInteractionError(`Stale interaction request from detached view ${viewId}.`);
    }

    const expectedGeneration = this.viewAttachmentGenerations.get(viewId);
    const requestGeneration = normalizeVisibleAttachmentGeneration(request && request.visibleAttachmentGeneration);
    if (expectedGeneration === undefined || expectedGeneration === null) {
      throw this.createInteractionError(`Stale interaction request from view ${viewId} without host generation.`);
    }
    if (requestGeneration === null || requestGeneration !== expectedGeneration) {
      throw this.createInteractionError(`Stale interaction request from view ${viewId} generation ${requestGeneration ?? '<missing>'}.`);
    }
  }

  resolveQuestionInteraction(current, requestId, kind) {
    const question = current.question && typeof current.question === 'object' ? current.question : null;
    const questionId = normalizeInteractionId(question && question.partId);
    if (!question || !questionId || requestId !== questionId) {
      throw this.createInteractionError(`Stale ${kind} request for ${requestId || '<missing>'}.`);
    }
    return this.nextInteractionResult(current, { question: null });
  }

  resolveConfirmationNavigateInteraction(current, requestId, delta) {
    const queue = Array.isArray(current.confirmationQueue) ? current.confirmationQueue : [];
    if (queue.length === 0) {
      throw this.createInteractionError('Stale confirmation.navigate request with no pending confirmations.');
    }
    const activeIndex = this.normalizeConfirmationIndex(current.activeConfirmationIndex, queue.length);
    const activeId = normalizeInteractionId(queue[activeIndex] && queue[activeIndex].id);
    if (!activeId || requestId !== activeId) {
      throw this.createInteractionError(`Stale confirmation.navigate request for ${requestId || '<missing>'}.`);
    }
    const nextIndex = (activeIndex + delta + queue.length) % queue.length;
    return this.nextInteractionResult(current, { activeConfirmationIndex: nextIndex });
  }

  resolveConfirmationInteraction(current, requestId) {
    const queue = Array.isArray(current.confirmationQueue) ? current.confirmationQueue : [];
    const targetIndex = queue.findIndex(entry => normalizeInteractionId(entry && entry.id) === requestId);
    if (!requestId || targetIndex < 0) {
      throw this.createInteractionError(`Stale confirmation.resolve request for ${requestId || '<missing>'}.`);
    }
    const nextQueue = queue.filter((_, index) => index !== targetIndex);
    const nextIndex = nextQueue.length === 0
      ? 0
      : Math.min(this.normalizeConfirmationIndex(current.activeConfirmationIndex, queue.length), nextQueue.length - 1);
    return this.nextInteractionResult(current, {
      confirmationQueue: nextQueue,
      activeConfirmationIndex: nextIndex,
    });
  }

  validateConfirmationActionInteraction(current, requestId) {
    const queue = Array.isArray(current.confirmationQueue) ? current.confirmationQueue : [];
    const target = queue.find(entry => normalizeInteractionId(entry && entry.id) === requestId);
    if (!requestId || !target) {
      throw this.createInteractionError(`Stale confirmation.action request for ${requestId || '<missing>'}.`);
    }
    return { snapshot: current, changed: false };
  }

  resolvePlanReviewInteraction(current, requestId) {
    const planReview = current.activePlanReview && typeof current.activePlanReview === 'object'
      ? current.activePlanReview
      : null;
    const planReviewId = normalizeInteractionId(planReview && planReview.id);
    if (!planReview || !planReviewId || requestId !== planReviewId) {
      throw this.createInteractionError(`Stale planReview.resolve request for ${requestId || '<missing>'}.`);
    }
    return this.nextInteractionResult(current, { activePlanReview: null });
  }

  validateCommandSessionInteraction(current) {
    const backgroundKeys = Array.isArray(current.backgroundCommandSessionKeys)
      ? current.backgroundCommandSessionKeys
      : [];
    if (backgroundKeys.length === 0) {
      throw this.createInteractionError('Stale commandSession.action request with no pending command session.');
    }
    return { snapshot: current, changed: false };
  }

  nextInteractionResult(current, patch) {
    const snapshot = {
      sessionId: current.sessionId,
      revision: (Number(current.revision) || 0) + 1,
      question: Object.prototype.hasOwnProperty.call(patch, 'question')
        ? patch.question
        : current.question ?? null,
      confirmationQueue: Object.prototype.hasOwnProperty.call(patch, 'confirmationQueue')
        ? clonePayload(patch.confirmationQueue) ?? []
        : clonePayload(current.confirmationQueue) ?? [],
      activeConfirmationIndex: Object.prototype.hasOwnProperty.call(patch, 'activeConfirmationIndex')
        ? Number(patch.activeConfirmationIndex) || 0
        : Number(current.activeConfirmationIndex) || 0,
      activePlanReview: Object.prototype.hasOwnProperty.call(patch, 'activePlanReview')
        ? patch.activePlanReview
        : current.activePlanReview ?? null,
      backgroundCommandSessionKeys: clonePayload(current.backgroundCommandSessionKeys) ?? [],
      backgroundProcessIds: Object.prototype.hasOwnProperty.call(patch, 'backgroundProcessIds')
        ? clonePayload(patch.backgroundProcessIds) ?? []
        : clonePayload(current.backgroundProcessIds) ?? [],
      processInventoryRevision: Object.prototype.hasOwnProperty.call(patch, 'processInventoryRevision')
        ? Number(patch.processInventoryRevision) || 0
        : Number(current.processInventoryRevision) || 0,
      processes: Object.prototype.hasOwnProperty.call(patch, 'processes')
        ? clonePayload(patch.processes) ?? []
        : clonePayload(current.processes) ?? [],
    };
    return { snapshot, changed: true };
  }

  normalizeConfirmationIndex(index, length) {
    if (!Number.isFinite(index) || length <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(Number(index) || 0, length - 1));
  }

  createInteractionError(message) {
    const error = new Error(`[AilyChat][RuntimeHost] ${message}`);
    error.code = 'stale_interaction';
    return error;
  }

  cacheHostEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    switch (payload.kind) {
      case 'session-state':
      case 'runtime-status':
        return this.cacheSessionState(payload.state)
          ? this.buildSessionStateEvent(payload.kind, payload.state && payload.state.sessionId)
          : null;
      case 'transcript':
        {
          const transcript = this.cacheTranscript(payload.transcript);
          return transcript
            ? {
                kind: 'transcript',
                sessionId: transcript.sessionId,
                revision: Number(transcript.revision) || Number(payload.revision) || 0,
                transcript,
              }
            : null;
        }
      case 'interaction':
        {
          const state = this.cacheInteraction(payload.interaction);
          return [
            payload,
            state ? this.buildSessionStateEvent('runtime-status', payload.sessionId) : null,
          ].filter(Boolean);
        }
      case 'view-request':
        return this.cacheViewRequestEvent(payload);
      case 'resource-request':
        return this.cacheResourceRequestEvent(payload);
      default:
        return payload;
    }
  }

  cacheRuntimeOwnerEvent(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    switch (payload.kind) {
      case 'turnProgress':
        return this.cacheRuntimeOwnerTurnProgress(payload);
      case 'editingSessionChanged':
        return this.cacheRuntimeOwnerEditingSessionChanged(payload);
      case 'turnDiffUpdated':
        return this.cacheRuntimeOwnerTurnDiffUpdated(payload);
      case 'runtimeProjectPathUpdated':
        return payload;
      case 'turnInteractionRequested':
        return this.cacheRuntimeOwnerTurnInteractionRequested(payload);
      case 'turnError':
        return this.cacheRuntimeOwnerTurnError(payload);
      case 'turnCompleted':
        return this.cacheRuntimeOwnerTurnCompleted(payload);
      default:
        return null;
    }
  }

  cacheRuntimeOwnerTurnProgress(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const payloadTurnId = this.normalizeActiveTurnId(payload && payload.turnId);
    const turnSnapshotId = this.readCanonicalTurnSnapshotId(payload && payload.turn);
    const renderEventTurnId = this.readCanonicalRenderEventTurnId(payload && payload.renderEvent);
    const turnId = turnSnapshotId || renderEventTurnId || payloadTurnId;
    const visibleTurnId = this.resolveRuntimeOwnerVisibleTurnId({
      sessionId,
      turnId,
      request: payload && payload.request,
      turn: payload && payload.turn,
    });
    if (!this.isCurrentRuntimeOwnerTurn(sessionId, payloadTurnId)
      && !this.isCurrentRuntimeOwnerTurn(sessionId, turnId)
      && !this.isCurrentRuntimeOwnerTurn(sessionId, visibleTurnId)) {
      if (payload && payload.renderEvent && this.canApplySettledRuntimeOwnerResponseMetadata({
        sessionId,
        turnId: visibleTurnId || renderEventTurnId || turnId,
        renderEvent: payload.renderEvent,
      })) {
        const settledMetadataEvent = this.cacheRuntimeOwnerRenderEvent({
          ...payload,
          sessionId,
          turnId: visibleTurnId || renderEventTurnId || turnId,
        });
        const modelRouting = payload.renderEvent.modelRouting && typeof payload.renderEvent.modelRouting === 'object'
          ? payload.renderEvent.modelRouting
          : null;
        console.info(
          '[AilyChat][SettledResponseMetadataScalar]',
          [
            `sessionId=${sessionId}`,
            `turnId=${visibleTurnId || renderEventTurnId || turnId}`,
            `selectedPreset=${normalizeOptionalString(modelRouting && modelRouting.selectedPresetId) || '<none>'}`,
            `billing=${normalizeOptionalString(payload.renderEvent.modelBillingLabel) || normalizeOptionalString(modelRouting && modelRouting.modelBillingLabel) || '<none>'}`,
          ].join(' '),
        );
        return settledMetadataEvent;
      }
      if (payload && payload.renderEvent && this.acceptRuntimeOwnerServiceOwnedResponseProgress({
        sessionId,
        turnId: visibleTurnId || renderEventTurnId || turnId,
        request: payload.request,
        revision: payload.revision,
        renderEvent: payload.renderEvent,
      })) {
        return this.cacheRuntimeOwnerRenderEvent({
          ...payload,
          sessionId,
          turnId: visibleTurnId || renderEventTurnId || turnId,
        });
      }
      if (payload && payload.turn && this.acceptRuntimeOwnerServiceOwnedResponseProgress({
        sessionId,
        turnId: visibleTurnId || turnSnapshotId || turnId,
        request: payload.request,
        revision: payload.revision,
        turn: payload.turn,
      })) {
        return this.cacheRuntimeOwnerTurnSnapshot({
          ...payload,
          sessionId,
          turnId: visibleTurnId || turnSnapshotId || turnId,
        });
      }
      const event = payload && payload.event;
      if (event && typeof event === 'object'
        && (event.kind === 'session-state' || event.kind === 'runtime-status')
        && event.state
        && event.state.requestInProgress === true
        && this.normalizeActiveTurnId(event.state.activeTurnId) === payloadTurnId) {
        const state = this.cacheRuntimeOwnerReportedSessionState({
          ...event.state,
          sessionId,
          activeTurnId: visibleTurnId || payloadTurnId,
          requestInProgress: true,
        });
        return state
          ? this.buildSessionStateEvent(event.kind, state.sessionId)
          : null;
      }
      return null;
    }
    if (payload.turn) {
      if (turnSnapshotId && turnSnapshotId !== payloadTurnId) {
        this.acceptRuntimeOwnerServiceOwnedResponseProgress({
          sessionId,
          turnId: visibleTurnId || turnSnapshotId,
          request: payload.request,
          turn: payload.turn,
          revision: payload.revision,
        });
      }
      return this.cacheRuntimeOwnerTurnSnapshot({
        ...payload,
        sessionId,
        turnId: visibleTurnId || turnSnapshotId || turnId,
      });
    }
    if (payload.renderEvent) {
      if (renderEventTurnId && renderEventTurnId !== payloadTurnId) {
        this.acceptRuntimeOwnerServiceOwnedResponseProgress({
          sessionId,
          turnId: visibleTurnId || renderEventTurnId,
          request: payload.request,
          revision: payload.revision,
          renderEvent: payload.renderEvent,
        });
      }
      return this.cacheRuntimeOwnerRenderEvent({
        ...payload,
        sessionId,
        turnId: visibleTurnId || renderEventTurnId || turnId,
      });
    }
    const event = payload && payload.event;
    if (!event || typeof event !== 'object') {
      return null;
    }
    switch (event.kind) {
      case 'session-state':
      case 'runtime-status': {
        if (!event.state || event.state.requestInProgress !== true) {
          return null;
        }
        const state = this.cacheRuntimeOwnerReportedSessionState({
          ...event.state,
          sessionId,
          activeTurnId: visibleTurnId || turnId,
          requestInProgress: true,
        });
        return state
          ? this.buildSessionStateEvent(event.kind, state.sessionId)
          : null;
      }
      case 'view-request': {
        if (!event.request || event.request.sessionId !== sessionId) {
          return null;
        }
        return this.cacheViewRequestEvent({
          ...event,
          sessionId,
        });
      }
      case 'resource-request': {
        if (!event.request || event.request.sessionId !== sessionId) {
          return null;
        }
        return this.cacheResourceRequestEvent({
          ...event,
          sessionId,
        });
      }
      default:
        return null;
    }
  }

  cacheViewRequestEvent(event) {
    const sessionId = normalizeSessionId(event && event.sessionId);
    const request = event && event.request && typeof event.request === 'object'
      ? event.request
      : null;
    const requestSessionId = normalizeSessionId(request && request.sessionId);
    const requestId = normalizeViewRequestId(request && request.id);
    const requestKind = normalizeViewRequestKind(request && request.kind);
    if (!sessionId || requestSessionId !== sessionId || !requestId || !requestKind) {
      return null;
    }

    const normalizedEvent = {
      kind: 'view-request',
      sessionId,
      revision: Number(event.revision) || this.transcriptBuilder.readTranscriptRevision(sessionId),
      request: clonePayload({
        ...request,
        id: requestId,
        sessionId,
        kind: requestKind,
      }),
    };
    const current = this.viewRequestEvents.get(sessionId) ?? [];
    let next = current.filter(item => {
      const existingId = normalizeViewRequestId(item && item.request && item.request.id);
      const existingKind = normalizeViewRequestKind(item && item.request && item.request.kind);
      return existingId !== requestId && !(requestKind === 'todo-state' && existingKind === 'todo-state');
    });
    next.push(normalizedEvent);
    if (next.length > MAX_VIEW_REQUEST_EVENTS_PER_SESSION) {
      next = next.slice(next.length - MAX_VIEW_REQUEST_EVENTS_PER_SESSION);
    }
    this.viewRequestEvents.set(sessionId, next);
    return clonePayload(normalizedEvent);
  }

  cacheResourceRequestEvent(event) {
    const sessionId = normalizeSessionId(event && event.sessionId);
    const request = event && event.request && typeof event.request === 'object'
      ? event.request
      : null;
    const requestSessionId = normalizeSessionId(request && request.sessionId);
    const requestId = normalizeResourceRequestId(request && request.id);
    const requestKind = normalizeResourceRequestKind(request && request.kind);
    const requestPhase = normalizeResourceRequestPhase(request && request.phase);
    if (!sessionId || requestSessionId !== sessionId || !requestId || !requestKind || !requestPhase) {
      return null;
    }

    const error = request.error && typeof request.error === 'object'
      ? {
          code: typeof request.error.code === 'string' ? request.error.code : undefined,
          message: typeof request.error.message === 'string' ? request.error.message : 'Resource request failed.',
          retryable: typeof request.error.retryable === 'boolean' ? request.error.retryable : undefined,
        }
      : undefined;
    const normalizedRequest = {
      id: requestId,
      sessionId,
      kind: requestKind,
      phase: requestPhase,
      ...(typeof request.label === 'string' && request.label.trim() ? { label: request.label.trim() } : {}),
      ...(typeof request.detail === 'string' && request.detail.trim() ? { detail: request.detail.trim() } : {}),
      ...(request.resource && typeof request.resource === 'object' ? { resource: clonePayload(request.resource) } : {}),
      ...(error ? { error } : {}),
    };
    const normalizedEvent = {
      kind: 'resource-request',
      sessionId,
      revision: Number(event.revision) || this.transcriptBuilder.readTranscriptRevision(sessionId),
      request: clonePayload(normalizedRequest),
    };
    const current = this.resourceRequestEvents.get(sessionId) ?? [];
    let next = current.concat([normalizedEvent]);
    if (next.length > MAX_RESOURCE_REQUEST_EVENTS_PER_SESSION) {
      next = next.slice(next.length - MAX_RESOURCE_REQUEST_EVENTS_PER_SESSION);
    }
    this.resourceRequestEvents.set(sessionId, next);
    return clonePayload(normalizedEvent);
  }

  cacheRuntimeOwnerTurnInteractionRequested(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const turnId = this.normalizeActiveTurnId(payload && payload.turnId);
    if (!this.isCurrentRuntimeOwnerTurn(sessionId, turnId)) {
      return null;
    }
    const interaction = payload && payload.interaction && payload.interaction.sessionId === sessionId
      ? payload.interaction
      : null;
    if (!interaction) {
      return null;
    }
    const state = this.cacheInteraction(interaction);
    return [
      {
        kind: 'interaction',
        sessionId,
        revision: Number(interaction.revision) || Number(payload.revision) || 0,
        interaction: clonePayload(interaction),
      },
      state ? this.buildSessionStateEvent('runtime-status', sessionId) : null,
    ].filter(Boolean);
  }

  cacheRuntimeOwnerTurnError(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const turnId = this.normalizeActiveTurnId(payload && payload.turnId);
    if (!this.isCurrentRuntimeOwnerTurn(sessionId, turnId)) {
      return null;
    }
    const error = payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : {};
    const transcript = this.markSubmittedTurnFailed(sessionId, error, Number(payload.revision) || 0);
    const failedState = this.failSubmittedTurn(sessionId);
    if (!failedState) {
      return null;
    }
    const events = [
      {
        kind: 'error',
        sessionId,
        revision: Number(payload.revision) || Number(failedState.transcriptRevision) || 0,
        error: {
          code: typeof error.code === 'string' ? error.code : undefined,
          message: typeof error.message === 'string' ? error.message : 'Runtime owner turn failed.',
          retryable: typeof error.retryable === 'boolean' ? error.retryable : undefined,
        },
      },
      this.buildSessionStateEvent('runtime-status', sessionId),
    ];
    if (transcript) {
      events.unshift({
        kind: 'transcript',
        sessionId,
        revision: Number(transcript.revision) || 0,
        transcript,
      });
    }
    return events.filter(Boolean);
  }

  cacheRuntimeOwnerTurnCompleted(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const payloadTurnId = this.normalizeActiveTurnId(payload && payload.turnId);
    const turnSnapshotId = this.readCanonicalTurnSnapshotId(payload && payload.turn);
    const turnId = turnSnapshotId || payloadTurnId;
    const visibleTurnId = this.resolveRuntimeOwnerVisibleTurnId({
      sessionId,
      turnId,
      request: payload && payload.request,
      turn: payload && payload.turn,
    });
    if (!this.isCurrentRuntimeOwnerTurn(sessionId, payloadTurnId)
      && !this.isCurrentRuntimeOwnerTurn(sessionId, turnId)
      && !this.isCurrentRuntimeOwnerTurn(sessionId, visibleTurnId)) {
      if (!(payload && payload.turn && this.acceptRuntimeOwnerServiceOwnedResponseProgress({
        sessionId,
        turnId: visibleTurnId || turnSnapshotId || turnId,
        request: payload.request,
        revision: payload.revision,
        turn: payload.turn,
      }))) {
        return null;
      }
    }
    const hasFinalTurn = !!(payload && payload.turn);
    const hasInteraction = !!(payload && payload.interaction && payload.interaction.sessionId === sessionId);
    if (!hasFinalTurn
      && !hasInteraction
      && !this.hasRuntimeOwnerTurnObservableProgress(sessionId, visibleTurnId || turnId)) {
      return null;
    }
    const events = [];
    if (payload.turn) {
      const transcriptEvent = this.cacheRuntimeOwnerTurnSnapshot({
        ...payload,
        sessionId,
        turnId: visibleTurnId || turnSnapshotId || turnId,
      });
      if (transcriptEvent) {
        events.push(transcriptEvent);
      }
    }
    if (payload.interaction && payload.interaction.sessionId === sessionId) {
      this.cacheInteraction(payload.interaction);
      events.push({
        kind: 'interaction',
        sessionId,
        revision: Number(payload.interaction.revision) || Number(payload.revision) || 0,
        interaction: clonePayload(payload.interaction),
      });
    }
    const completionTurnId = visibleTurnId || turnSnapshotId || turnId || payloadTurnId;
    const completedTranscript = completionTurnId
      ? this.transcriptBuilder.completeTurn({
        sessionId,
        turnId: completionTurnId,
        revision: payload && payload.revision,
        timestamp: Date.now(),
      })
      : null;
    const completedTranscriptEvent = completedTranscript
      ? this.buildTurnTranscriptEvent(
        completedTranscript,
        completionTurnId,
        payload && payload.revision,
      )
      : null;
    if (completedTranscriptEvent) {
      events.push(completedTranscriptEvent);
    }
    const previousState = this.buildSessionState(sessionId);
    const transcriptRevision = Math.max(
      Number(previousState && previousState.transcriptRevision) || 0,
      Number(payload.revision) || 0,
      Number(payload.state && payload.state.transcriptRevision) || 0,
      events.reduce((maxRevision, event) => Math.max(maxRevision, Number(event && event.revision) || 0), 0),
    );
    const ownerState = payload.state && typeof payload.state === 'object'
      ? {
          ...payload.state,
          sessionId,
          requestInProgress: false,
          activeTurnId: null,
          transcriptRevision,
        }
      : {
          ...previousState,
          sessionId,
          status: 'completed',
          requestInProgress: false,
          activeTurnId: null,
          transcriptRevision,
        };
    const state = this.cacheRuntimeOwnerReportedSessionState(ownerState);
    if (state) {
      events.push(this.buildSessionStateEvent('runtime-status', sessionId));
    }
    return events.filter(Boolean);
  }

  cacheCommandResult(method, args, result) {
    switch (method) {
      case 'attachView':
        this.attachView(args && args[0], args && args[1], null, args && args[2]);
        this.cacheRuntimeOwnerReportedSessionState(result);
        return;
      case 'readSessionState':
        this.cacheSessionState(result);
        return;
      case 'submitTurn':
        this.cacheRuntimeOwnerReportedSessionState(result);
        return;
      case 'detachView':
        this.detachView(args && args[0], args && args[1]);
        return;
      case 'ensureSessionCanRerun':
        this.cacheSessionState(result && result.state);
        return;
      case 'readTranscript':
        this.cacheTranscript(result);
        return;
      case 'readInteractionSnapshot':
      case 'resolveInteraction':
        this.cacheInteraction(result);
        return;
      case 'disposeSession':
        this.clearSession(args && args[0]);
        return;
      default:
        return;
    }
  }

  readHostCommandResult(method, args) {
    if (method === 'readSessionInventory') {
      return this.buildSessionInventorySnapshot();
    }
    if (method === 'readSessionTurnPage') {
      return this.buildSessionTurnPage(args && args[0], { requireBoundScope: true });
    }
    if (method === 'readCheckpointNavigationState') {
      return this.readCheckpointNavigationState(args && args[0]);
    }
    const sessionId = normalizeSessionId(args && args[0]);
    if (!sessionId) {
      return HOST_SESSION_STORE_MISS;
    }
    switch (method) {
      case 'readSubmitReadiness': {
        const state = this.buildSessionState(sessionId);
        const activeSubmittedRequestInProgress = this.activeSubmittedRequests.has(sessionId);
        return (state && state.requestInProgress === true) || activeSubmittedRequestInProgress
          ? {
              sessionId,
              canSubmit: false,
              requestInProgress: true,
            }
          : {
              sessionId,
              canSubmit: true,
              requestInProgress: false,
            };
      }
      case 'ensureSessionCanRerun': {
        const state = this.buildSessionState(sessionId);
        return state && state.requestInProgress === true
          ? {
              sessionId,
              activeRequestInProgress: true,
              staleGateCleared: false,
              state,
            }
          : {
              sessionId,
              activeRequestInProgress: false,
              staleGateCleared: false,
              state,
            };
      }
      case 'awaitRequestCompletion': {
        return this.awaitRequestCompletion(sessionId);
      }
      case 'readSessionState':
        return this.buildSessionState(sessionId);
      case 'readTranscript':
        return this.buildTranscriptSnapshot(sessionId);
      case 'readInteractionSnapshot':
        return this.buildInteractionSnapshot(sessionId);
      default:
        return HOST_SESSION_STORE_MISS;
    }
  }

  readRuntimeOwnerUnavailableHostCommandResult(method, args) {
    if (method === 'attachView') {
      return this.attachView(args && args[0], args && args[1], null, args && args[2]);
    }
    if (method === 'detachView') {
      this.detachView(args && args[0], args && args[1]);
      return undefined;
    }
    if (method === 'readSessionTurnPage') {
      const request = args && args[0];
      const sessionId = normalizeSessionId(request && request.sessionId);
      return sessionId && this.hasHostSession(sessionId)
        ? this.buildSessionTurnPage(request, { requireBoundScope: true })
        : HOST_SESSION_STORE_MISS;
    }

    const sessionId = normalizeSessionId(args && args[0]);
    if (!sessionId || !this.hasHostSession(sessionId)) {
      return HOST_SESSION_STORE_MISS;
    }

    const state = this.buildSessionState(sessionId);
    switch (method) {
      case 'readSessionState':
        return state;
      case 'readSubmitReadiness':
        return {
          sessionId,
          canSubmit: false,
          requestInProgress: state && state.requestInProgress === true,
        };
      case 'ensureSessionCanRerun':
        return {
          sessionId,
          activeRequestInProgress: state && state.requestInProgress === true,
          staleGateCleared: false,
          state: this.withAttachedViewIds(state),
        };
      case 'awaitRequestCompletion':
        return this.awaitRequestCompletion(sessionId);
      case 'readTranscript':
        return this.buildTranscriptSnapshot(sessionId);
      case 'readInteractionSnapshot':
        return this.buildInteractionSnapshot(sessionId);
      default:
        return HOST_SESSION_STORE_MISS;
    }
  }

  beginSubmittedTurn(request) {
    const sessionId = normalizeSessionId(request && request.sessionId);
    if (!sessionId) {
      throw new Error('[AilyChat][RuntimeHost] submitTurn requires a session id.');
    }
    const previousState = this.buildSessionState(sessionId);
    if ((previousState && previousState.requestInProgress === true)
      || this.activeSubmittedRequests.has(sessionId)) {
      const error = new Error('[AilyChat][RuntimeHost] Cannot submit a new turn while the service-owned request model is still running.');
      error.code = 'request_in_progress';
      error.retryable = true;
      error.sessionId = sessionId;
      throw error;
    }
    const checkpointTimeline = this.checkpointTimelines.get(sessionId);
    const checkpointProtocolTruncation = checkpointTimeline
      ? this.buildCheckpointProtocolTruncation(
          checkpointTimeline,
          this.buildTranscriptSnapshot(sessionId),
        )
      : undefined;
    if (checkpointTimeline) {
      // VS Code splices the disabled forward checkpoint branch when a new
      // request starts after restore. The visible canonical transcript already
      // contains exactly the retained prefix, so dropping the sidecar branch is
      // the atomic model-side commit before seeding the new request.
      this.checkpointTimelines.delete(sessionId);
    }
    const effectiveRequest = checkpointTimeline
      ? {
          ...request,
          protocolTruncation: checkpointProtocolTruncation,
        }
      : request;
    const activeTurnId = this.normalizeActiveTurnId(request && request.activeResponseHandle)
      || this.createSubmittedTurnId(sessionId);
    const submittedRequest = this.buildSubmittedRequestWithStableId(effectiveRequest, activeTurnId);
    this.cacheSubmittedTurnInventoryMetadata(sessionId, submittedRequest);
    this.activeSubmittedRequests.set(sessionId, clonePayload(submittedRequest));
    const transcript = this.transcriptBuilder.seedSubmittedTurn({
      sessionId,
      turnId: activeTurnId,
      request: submittedRequest,
      revision: Number(previousState && previousState.transcriptRevision) || 0,
      timestamp: Date.now(),
      protocolTruncation: submittedRequest && submittedRequest.protocolTruncation
        ? submittedRequest.protocolTruncation
        : null,
    });
    const nextState = {
      ...previousState,
      sessionId,
      status: 'running',
      requestInProgress: true,
      attachedViewIds: this.readAttachedViewIds(sessionId),
      activeTurnId,
      transcriptRevision: transcript
        ? Number(transcript.revision) || 0
        : Number(previousState && previousState.transcriptRevision) || 0,
      selectedMode: submittedRequest && submittedRequest.selectedMode !== undefined
        ? submittedRequest.selectedMode ?? null
        : previousState.selectedMode ?? null,
      providerOptions: request && request.providerOptions !== undefined
        ? request.providerOptions ?? null
        : previousState.providerOptions ?? null,
      currentModel: request && request.currentModel !== undefined
        ? request.currentModel ?? null
        : previousState.currentModel ?? null,
    };
    this.sessionStates.set(sessionId, clonePayload(nextState));
    return clonePayload(nextState);
  }

  cacheRuntimeOwnerEditingSessionChanged(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const revision = Number(payload && payload.revision);
    if (!sessionId || !Number.isFinite(revision) || revision < 0) {
      return null;
    }
    const currentRevision = this.editingSessionRevisions.get(sessionId);
    if (Number.isFinite(currentRevision) && revision <= currentRevision) {
      return null;
    }
    this.editingSessionRevisions.set(sessionId, revision);
    return {
      kind: 'editing-session',
      sessionId,
      revision,
    };
  }

  cacheRuntimeOwnerTurnDiffUpdated(payload) {
    const sessionId = normalizeSessionId(payload && payload.sessionId);
    const turnId = normalizeOptionalString(payload && payload.turnId);
    const revision = Number(payload && payload.revision);
    if (!sessionId || !turnId || !Number.isFinite(revision) || revision < 0 || typeof payload.diff !== 'string') {
      return null;
    }
    let revisions = this.turnDiffRevisions.get(sessionId);
    if (!revisions) {
      revisions = new Map();
      this.turnDiffRevisions.set(sessionId, revisions);
    }
    const currentRevision = revisions.get(turnId);
    if (Number.isFinite(currentRevision) && revision <= currentRevision) {
      return null;
    }
    revisions.set(turnId, revision);
    return {
      kind: 'turn-diff',
      sessionId,
      turnId,
      revision,
      diff: payload.diff,
    };
  }

  buildCheckpointProtocolTruncation(timeline, transcript) {
    const retainedTurnIds = (transcript && Array.isArray(transcript.turnResponses)
      ? transcript.turnResponses
      : [])
      .map(turn => normalizeOptionalString(turn && turn.turnId))
      .filter(Boolean);
    const discardedTurnIds = (timeline && Array.isArray(timeline.turnResponses)
      ? timeline.turnResponses.slice(timeline.currentTurnResponseCount)
      : [])
      .map(turn => normalizeOptionalString(turn && turn.turnId))
      .filter(Boolean);
    return discardedTurnIds.length > 0
      ? {
          kind: 'removeFrom',
          turnId: discardedTurnIds[0],
          retainedTurnIds,
          discardedTurnIds,
        }
      : null;
  }

  buildSubmittedRequestWithStableId(request, activeTurnId) {
    const sourceRequest = request && typeof request === 'object' ? request : {};
    const normalizedActiveTurnId = this.normalizeActiveTurnId(activeTurnId);
    const metadata = sourceRequest.metadata && typeof sourceRequest.metadata === 'object'
      ? clonePayload(sourceRequest.metadata)
      : {};
    const requestId = this.normalizeActiveTurnId(metadata.requestId) || normalizedActiveTurnId;
    if (requestId) {
      metadata.requestId = requestId;
    }
    const checkpointId = this.normalizeActiveTurnId(metadata.checkpointId)
      || this.createSubmittedCheckpointId(normalizedActiveTurnId || requestId);
    if (checkpointId) {
      metadata.checkpointId = checkpointId;
    }
    return {
      ...clonePayload(sourceRequest),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      activeResponseHandle: normalizedActiveTurnId || sourceRequest.activeResponseHandle || null,
    };
  }

  createSubmittedCheckpointId(activeTurnId) {
    const normalizedActiveTurnId = this.normalizeActiveTurnId(activeTurnId);
    this.submittedCheckpointSequence += 1;
    const suffix = `${Date.now().toString(36)}-${this.submittedCheckpointSequence.toString(36)}`;
    if (!normalizedActiveTurnId) {
      return `cp_${suffix}`;
    }
    const safeTurnId = normalizedActiveTurnId.replace(/[^A-Za-z0-9_-]+/g, '_');
    return `cp_${safeTurnId}_${suffix}`;
  }

  createSubmittedTurnId(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    this.submittedTurnSequence += 1;
    return `${normalizedSessionId}-turn-${Date.now().toString(36)}-${this.submittedTurnSequence.toString(36)}`;
  }

  markSubmittedTurnFailed(sessionId, error, revision) {
    const previousState = this.buildSessionState(sessionId);
    const normalizedSessionId = normalizeSessionId(previousState && previousState.sessionId);
    const activeTurnId = this.normalizeActiveTurnId(previousState && previousState.activeTurnId);
    if (!normalizedSessionId || !activeTurnId) {
      return null;
    }
    let transcript = this.transcriptBuilder.markTurnFailed({
      sessionId: normalizedSessionId,
      turnId: activeTurnId,
      revision,
      error,
    });
    if (transcript) {
      return transcript;
    }

    this.transcriptBuilder.seedSubmittedTurn({
      sessionId: normalizedSessionId,
      turnId: activeTurnId,
      request: this.readActiveSubmittedRequest(normalizedSessionId) ?? { sessionId: normalizedSessionId },
      revision,
      timestamp: Date.now(),
    });
    transcript = this.transcriptBuilder.markTurnFailed({
      sessionId: normalizedSessionId,
      turnId: activeTurnId,
      revision,
      error,
    });
    return transcript;
  }

  cacheSubmittedTurnInventoryMetadata(sessionId, request) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !request || typeof request !== 'object') {
      return;
    }
    const rawMetadata = request.metadata && typeof request.metadata === 'object'
      ? request.metadata.hostSessionInventory
      : null;
    if (!rawMetadata || typeof rawMetadata !== 'object') {
      return;
    }
    const previous = this.sessionInventoryMetadata.get(normalizedSessionId) ?? {};
    const next = { ...previous };
    const title = normalizeOptionalString(rawMetadata.title);
    if (title) {
      next.title = title;
    }
    const titleSource = normalizeOptionalString(rawMetadata.titleSource);
    if (titleSource) {
      next.titleSource = titleSource;
    }
    if (rawMetadata.titleDurable === true) {
      next.titleDurable = true;
    }
    const sessionType = normalizeOptionalString(rawMetadata.sessionType);
    if (sessionType) {
      next.sessionType = sessionType;
    }
    if (typeof rawMetadata.projectPath === 'string' || rawMetadata.projectPath === null) {
      next.projectPath = rawMetadata.projectPath;
    }
    const mode = normalizeOptionalString(rawMetadata.mode);
    if (mode) {
      next.mode = mode;
    }
    this.sessionInventoryMetadata.set(normalizedSessionId, clonePayload(next));
  }

  failSubmittedTurn(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const previousState = this.buildSessionState(normalizedSessionId);
    const nextState = {
      ...previousState,
      sessionId: normalizedSessionId,
      status: 'failed',
      requestInProgress: false,
      activeTurnId: this.normalizeActiveTurnId(previousState.activeTurnId) || previousState.activeTurnId || null,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
      transcriptRevision: this.transcriptBuilder.readTranscriptRevision(normalizedSessionId),
    };
    this.sessionStates.set(normalizedSessionId, clonePayload(nextState));
    this.resolveCompletionWaiters(normalizedSessionId);
    this.activeSubmittedRequests.delete(normalizedSessionId);
    return clonePayload(nextState);
  }

  failRunningTurns() {
    const runningSessionIds = [];
    for (const [sessionId, state] of this.sessionStates) {
      if (state && state.requestInProgress === true) {
        runningSessionIds.push(sessionId);
      }
    }
    return runningSessionIds
      .map(sessionId => this.failSubmittedTurn(sessionId))
      .filter(Boolean);
  }

  cancelRunningTurn(sessionId, turnId, revision) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return null;
    }
    const previousState = this.buildSessionState(normalizedSessionId);
    const transcript = this.transcriptBuilder.cancelTurn({
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      revision: revision ?? (Number(previousState && previousState.transcriptRevision) || 0),
      timestamp: Date.now(),
    });
    if (!transcript) {
      return null;
    }
    const nextState = {
      ...previousState,
      sessionId: normalizedSessionId,
      transcriptRevision: Number(transcript.revision) || Number(previousState && previousState.transcriptRevision) || 0,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    };
    this.sessionStates.set(normalizedSessionId, clonePayload(nextState));
    return clonePayload(transcript);
  }

  stopSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const previousState = this.buildSessionState(normalizedSessionId);
    const nextState = {
      ...previousState,
      sessionId: normalizedSessionId,
      status: 'stopped',
      requestInProgress: false,
      activeTurnId: null,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    };
    this.sessionStates.set(normalizedSessionId, clonePayload(nextState));
    this.resolveCompletionWaiters(normalizedSessionId);
    this.activeSubmittedRequests.delete(normalizedSessionId);
    return clonePayload(nextState);
  }

  disposeSession(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const previousState = this.buildSessionState(normalizedSessionId);
    const disposedState = {
      ...previousState,
      sessionId: normalizedSessionId,
      status: 'disposed',
      requestInProgress: false,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    };
    this.sessionStates.set(normalizedSessionId, clonePayload(disposedState));
    this.resolveCompletionWaiters(normalizedSessionId);
    this.activeSubmittedRequests.delete(normalizedSessionId);
    this.clearSession(normalizedSessionId);
    return clonePayload(disposedState);
  }

  awaitRequestCompletion(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return Promise.resolve();
    }
    const state = this.sessionStates.get(normalizedSessionId);
    if (!state || state.requestInProgress !== true) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const waiters = this.completionWaiters.get(normalizedSessionId) || [];
      waiters.push(resolve);
      this.completionWaiters.set(normalizedSessionId, waiters);
    });
  }

  resolveCompletionWaiters(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const waiters = this.completionWaiters.get(normalizedSessionId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    this.completionWaiters.delete(normalizedSessionId);
    for (const resolve of waiters) {
      resolve();
    }
  }

  normalizeActiveTurnId(value) {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : '';
  }

  acceptRuntimeOwnerServiceOwnedResponseProgress({ sessionId, turnId, request, revision, renderEvent, turn }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const visibleTurnId = this.resolveRuntimeOwnerVisibleTurnId({
      sessionId: normalizedSessionId,
      turnId,
      request,
      turn,
    });
    if (!normalizedSessionId || !visibleTurnId || !this.hasHostSession(normalizedSessionId)) {
      return false;
    }

    const previousState = this.buildSessionState(normalizedSessionId);
    if (this.isHostTerminalStatus(previousState && previousState.status)) {
      return false;
    }

    const transcript = this.transcriptBuilder.buildTranscriptSnapshot(normalizedSessionId);
    const turns = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const existingTurn = turns.find(item =>
      this.normalizeActiveTurnId(item && item.turnId) === visibleTurnId);
    const hasModelProgress = (renderEvent && typeof renderEvent === 'object')
      || this.turnHasObservableProgress(turn);
    if (!hasModelProgress) {
      return false;
    }

    const effectiveRequest = request || this.readActiveSubmittedRequest(normalizedSessionId);
    const previousActiveTurnId = this.normalizeActiveTurnId(previousState && previousState.activeTurnId);
    const isAlreadyCurrent = previousState
      && previousState.requestInProgress === true
      && previousActiveTurnId === visibleTurnId;
    if (existingTurn && this.turnHasObservableProgress(existingTurn) && !isAlreadyCurrent) {
      const isSettledTurnSnapshotUpdate = this.isSettledRuntimeOwnerTurnSnapshotUpdate({
        existingTurn,
        incomingTurn: turn,
        request: effectiveRequest,
      });
      if (!isSettledTurnSnapshotUpdate) {
        return false;
      }
    }

    let nextTranscriptRevision = Math.max(
      Number(previousState && previousState.transcriptRevision) || 0,
      Number(transcript && transcript.revision) || 0,
      Number(revision) || 0,
    );
    if (!existingTurn) {
      const requestId = this.readSubmitRequestId(effectiveRequest) || this.readTurnRequestId(turn);
      const seedTurn = this.findEmptyServiceOwnedResponseSeed({
        transcript,
        preferredTurnId: previousActiveTurnId,
        requestId,
      });
      const seedTurnId = this.normalizeActiveTurnId(seedTurn && seedTurn.turnId);
      const seededTranscript = seedTurnId && seedTurnId === visibleTurnId
        ? transcript
        : this.transcriptBuilder.seedSubmittedTurn({
          sessionId: normalizedSessionId,
          turnId: visibleTurnId,
          request: this.buildRuntimeOwnerServiceOwnedResponseRequest({
            sessionId: normalizedSessionId,
            request: effectiveRequest,
            turn,
          }),
          revision,
          timestamp: renderEvent && typeof renderEvent === 'object'
            ? renderEvent.timestamp
            : Date.now(),
        });
      nextTranscriptRevision = Math.max(
        nextTranscriptRevision,
        Number(seededTranscript && seededTranscript.revision) || 0,
      );
    }

    this.sessionStates.set(normalizedSessionId, clonePayload({
      ...previousState,
      sessionId: normalizedSessionId,
      status: 'running',
      requestInProgress: true,
      activeTurnId: visibleTurnId,
      transcriptRevision: nextTranscriptRevision,
      selectedMode: effectiveRequest && effectiveRequest.selectedMode !== undefined
        ? effectiveRequest.selectedMode ?? null
        : previousState && previousState.selectedMode !== undefined ? previousState.selectedMode ?? null : null,
      providerOptions: effectiveRequest && effectiveRequest.providerOptions !== undefined
        ? effectiveRequest.providerOptions ?? null
        : previousState && previousState.providerOptions !== undefined ? previousState.providerOptions ?? null : null,
      currentModel: effectiveRequest && effectiveRequest.currentModel !== undefined
        ? effectiveRequest.currentModel ?? null
        : previousState && previousState.currentModel !== undefined ? previousState.currentModel ?? null : null,
      attachedViewIds: this.readAttachedViewIds(normalizedSessionId),
    }));
    return true;
  }

  buildRuntimeOwnerServiceOwnedResponseRequest({ sessionId, request, turn }) {
    const sourceRequest = request && typeof request === 'object' ? request : {};
    const turnRequest = turn && turn.request && typeof turn.request === 'object'
      ? turn.request
      : {};
    const metadata = sourceRequest.metadata && typeof sourceRequest.metadata === 'object'
      ? sourceRequest.metadata
      : turnRequest.metadata && typeof turnRequest.metadata === 'object'
        ? turnRequest.metadata
        : undefined;
    const requestText = typeof sourceRequest.requestText === 'string'
      ? sourceRequest.requestText
      : typeof sourceRequest.content === 'string'
        ? sourceRequest.content
        : typeof turnRequest.content === 'string'
          ? turnRequest.content
          : '';
    const displayText = typeof sourceRequest.displayText === 'string'
      ? sourceRequest.displayText
      : typeof turnRequest.displayContent === 'string'
        ? turnRequest.displayContent
        : undefined;
    return {
      ...sourceRequest,
      sessionId,
      requestText,
      displayText,
      ...(metadata ? { metadata: clonePayload(metadata) } : {}),
    };
  }

  readTurnRequestId(turn) {
    const request = turn && turn.request && typeof turn.request === 'object'
      ? turn.request
      : null;
    const metadata = request && request.metadata && typeof request.metadata === 'object'
      ? request.metadata
      : null;
    return this.normalizeActiveTurnId(metadata && metadata.requestId);
  }

  readSubmitRequestId(request) {
    const metadata = request && request.metadata && typeof request.metadata === 'object'
      ? request.metadata
      : null;
    return this.normalizeActiveTurnId(metadata && metadata.requestId);
  }

  isSettledRuntimeOwnerTurnSnapshotUpdate({ existingTurn, incomingTurn, request }) {
    if (!incomingTurn || typeof incomingTurn !== 'object') {
      return false;
    }

    const existingTurnId = this.normalizeActiveTurnId(existingTurn && existingTurn.turnId);
    const incomingTurnId = this.normalizeActiveTurnId(incomingTurn && incomingTurn.turnId);
    if (!existingTurnId || existingTurnId !== incomingTurnId) {
      return false;
    }

    const existingRequestId = this.readTurnRequestId(existingTurn);
    const incomingRequestId = this.readSubmitRequestId(request) || this.readTurnRequestId(incomingTurn);
    if (existingRequestId && incomingRequestId && existingRequestId !== incomingRequestId) {
      return false;
    }

    return this.turnHasObservableProgress(incomingTurn);
  }

  readActiveSubmittedRequest(sessionId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const request = this.activeSubmittedRequests.get(normalizedSessionId);
    return request ? clonePayload(request) : null;
  }

  resolveRuntimeOwnerVisibleTurnId({ sessionId, turnId, request, turn }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const ownerTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId || !ownerTurnId) {
      return ownerTurnId;
    }
    const state = this.buildSessionState(normalizedSessionId);
    const activeTurnId = this.normalizeActiveTurnId(state && state.activeTurnId);
    if (!activeTurnId || state.requestInProgress !== true) {
      return ownerTurnId;
    }
    if (activeTurnId === ownerTurnId) {
      return activeTurnId;
    }
    const activeRequest = this.activeSubmittedRequests.get(normalizedSessionId);
    if (!activeRequest) {
      return this.hasRuntimeOwnerTurnObservableProgress(normalizedSessionId, ownerTurnId)
        ? ownerTurnId
        : activeTurnId;
    }
    const activeRequestId = this.readSubmitRequestId(activeRequest);
    const ownerRequestId = this.readSubmitRequestId(request) || this.readTurnRequestId(turn);
    if (!ownerRequestId || !activeRequestId || ownerRequestId === activeRequestId) {
      return activeTurnId;
    }
    return ownerTurnId;
  }

  retargetRuntimeOwnerTurnSnapshot(turn, visibleTurnId) {
    const normalizedTurnId = this.normalizeActiveTurnId(visibleTurnId);
    if (!turn || typeof turn !== 'object' || !normalizedTurnId) {
      return turn;
    }
    const nextTurn = clonePayload(turn);
    nextTurn.turnId = normalizedTurnId;
    if (nextTurn.response && typeof nextTurn.response === 'object') {
      nextTurn.response = {
        ...nextTurn.response,
        id: normalizedTurnId,
      };
    }
    return nextTurn;
  }

  retargetRuntimeOwnerRenderEvent(event, visibleTurnId) {
    const normalizedTurnId = this.normalizeActiveTurnId(visibleTurnId);
    if (!event || typeof event !== 'object' || !normalizedTurnId) {
      return event;
    }
    if (this.normalizeActiveTurnId(event.turnId) === normalizedTurnId) {
      return event;
    }
    return {
      ...clonePayload(event),
      turnId: normalizedTurnId,
    };
  }

  readCanonicalTurnSnapshotId(turn) {
    if (!turn || typeof turn !== 'object') {
      return '';
    }
    const turnId = this.normalizeActiveTurnId(turn.turnId);
    const response = turn.response && typeof turn.response === 'object' ? turn.response : null;
    const responseId = this.normalizeActiveTurnId(response && response.id);
    if (turnId && responseId && turnId !== responseId) {
      return '';
    }
    return turnId || responseId;
  }

  readCanonicalRenderEventTurnId(event) {
    return event && typeof event === 'object'
      ? this.normalizeActiveTurnId(event.turnId)
      : '';
  }

  findEmptyServiceOwnedResponseSeed({ transcript, preferredTurnId, requestId }) {
    const turns = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const normalizedPreferredTurnId = this.normalizeActiveTurnId(preferredTurnId);
    const normalizedRequestId = this.normalizeActiveTurnId(requestId);
    const isEligibleSeed = turn => {
      const turnId = this.normalizeActiveTurnId(turn && turn.turnId);
      if (!turnId) {
        return false;
      }
      const response = turn.response && typeof turn.response === 'object' ? turn.response : null;
      const responseId = this.normalizeActiveTurnId(response && response.id);
      if (responseId && responseId !== turnId) {
        return false;
      }
      if (normalizedRequestId && this.readTurnRequestId(turn) !== normalizedRequestId) {
        return false;
      }
      return !this.turnHasObservableProgress(turn);
    };
    if (normalizedPreferredTurnId) {
      const preferredTurn = turns.find(item =>
        this.normalizeActiveTurnId(item && item.turnId) === normalizedPreferredTurnId);
      if (isEligibleSeed(preferredTurn)) {
        return preferredTurn;
      }
    }
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (isEligibleSeed(turns[index])) {
        return turns[index];
      }
    }
    return null;
  }

  hasRuntimeOwnerTurnObservableProgress(sessionId, turnId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return false;
    }
    const transcript = this.transcriptBuilder.buildTranscriptSnapshot(normalizedSessionId);
    const turn = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses.find(item => this.normalizeActiveTurnId(item && item.turnId) === normalizedTurnId)
      : null;
    return this.turnHasObservableProgress(turn);
  }

  seedRuntimeOwnerReportedActiveTurn({ sessionId, turnId, revision, ownerState }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return null;
    }
    const currentTranscript = this.transcriptBuilder.buildTranscriptSnapshot(normalizedSessionId);
    const existingTurn = Array.isArray(currentTranscript && currentTranscript.turnResponses)
      ? currentTranscript.turnResponses.find(item =>
        this.normalizeActiveTurnId(item && item.turnId) === normalizedTurnId)
      : null;
    if (existingTurn) {
      return currentTranscript;
    }
    return this.transcriptBuilder.seedSubmittedTurn({
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      request: {
        sessionId: normalizedSessionId,
        requestText: typeof ownerState?.requestText === 'string' ? ownerState.requestText : '',
        displayText: typeof ownerState?.displayText === 'string' ? ownerState.displayText : undefined,
        selectedMode: ownerState && ownerState.selectedMode !== undefined ? ownerState.selectedMode : undefined,
        providerOptions: ownerState && ownerState.providerOptions !== undefined ? ownerState.providerOptions : undefined,
      },
      revision,
      timestamp: Date.now(),
    });
  }

  turnHasObservableProgress(turn) {
    if (!turn || typeof turn !== 'object') {
      return false;
    }
    const response = turn.response && typeof turn.response === 'object' ? turn.response : null;
    const parts = Array.isArray(response && response.parts) ? response.parts : [];
    const topLevelParts = Array.isArray(turn.parts) ? turn.parts : [];
    if (parts.length > 0 || topLevelParts.length > 0) {
      return true;
    }
    if (typeof response?.resultText === 'string' && response.resultText.trim().length > 0) {
      return true;
    }
    if (typeof turn.resultText === 'string' && turn.resultText.trim().length > 0) {
      return true;
    }
    if (Array.isArray(turn.rounds) && turn.rounds.length > 0) {
      return true;
    }
    if (Array.isArray(response?.progressMessages) && response.progressMessages.length > 0) {
      return true;
    }
    if (Array.isArray(response?.contentReferences) && response.contentReferences.length > 0) {
      return true;
    }
    if (Array.isArray(response?.codeCitations) && response.codeCitations.length > 0) {
      return true;
    }
    return false;
  }

  canApplySettledRuntimeOwnerResponseMetadata({ sessionId, turnId, renderEvent }) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId
      || !normalizedTurnId
      || !renderEvent
      || renderEvent.type !== 'turn_end'
      || !this.hasHostSession(normalizedSessionId)) {
      return false;
    }

    const state = this.buildSessionState(normalizedSessionId);
    if (!state
      || state.requestInProgress === true
      || this.isHostTerminalStatus(state.status)) {
      return false;
    }

    const transcript = this.transcriptBuilder.buildTranscriptSnapshot(normalizedSessionId);
    const turns = Array.isArray(transcript && transcript.turnResponses)
      ? transcript.turnResponses
      : [];
    const existingTurn = turns.find(candidate =>
      this.normalizeActiveTurnId(candidate && candidate.turnId) === normalizedTurnId);
    return readTurnStatus(existingTurn) === 'completed';
  }

  isCurrentRuntimeOwnerTurn(sessionId, turnId) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    const normalizedTurnId = this.normalizeActiveTurnId(turnId);
    if (!normalizedSessionId || !normalizedTurnId) {
      return false;
    }
    const state = this.buildSessionState(normalizedSessionId);
    if (!state || state.requestInProgress !== true) {
      return false;
    }
    return this.normalizeActiveTurnId(state.activeTurnId) === normalizedTurnId;
  }

  isHostTerminalStatus(status) {
    return status === 'stopped'
      || status === 'disposed'
      || status === 'failed'
      || status === 'cancelled';
  }

  normalizeRuntimeOwnerSettledStatus(status) {
    return typeof status === 'string' && status.trim().length > 0
      ? status.trim()
      : 'idle';
  }

  normalizeIdleRuntimeOwnerStatus(previousStatus, ownerStatus) {
    if (typeof previousStatus === 'string' && previousStatus.trim().length > 0) {
      return previousStatus;
    }
    return this.normalizeRuntimeOwnerSettledStatus(ownerStatus);
  }

  buildSessionStateEvent(kind, sessionId) {
    const state = this.buildSessionState(sessionId);
    if (!state) {
      return null;
    }
    return {
      kind,
      sessionId: state.sessionId,
      revision: Number(state.transcriptRevision) || 0,
      state,
    };
  }
}

const TURN_PAGE_CURSOR_PREFIX = 'aily-turn-page-v1:';

function projectTurnPageItemsView(turn, itemsView) {
  if (!turn || typeof turn !== 'object') {
    return turn;
  }
  turn.itemsView = itemsView;
  if (itemsView === 'full') {
    return turn;
  }

  turn.rounds = [];
  if (Array.isArray(turn.parts)) {
    turn.parts = [];
  }
  const response = turn.response && typeof turn.response === 'object'
    ? turn.response
    : null;
  if (!response) {
    return turn;
  }
  const parts = Array.isArray(response.parts) ? response.parts : [];
  if (itemsView === 'notLoaded') {
    response.parts = [];
    response.resultText = '';
    return turn;
  }

  const finalAgentPart = [...parts].reverse().find(part =>
    part && (part.type === 'markdown' || part.type === 'text'));
  response.parts = finalAgentPart ? [clonePayload(finalAgentPart)] : [];
  return turn;
}

function encodeTurnPageCursor(cursor) {
  const payload = JSON.stringify({
    v: 2,
    s: cursor.sessionId,
    k: cursor.sessionScopeKey,
    a: cursor.anchorTurnId,
    i: cursor.includeAnchor === true,
  });
  return `${TURN_PAGE_CURSOR_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function decodeTurnPageCursor(value) {
  if (typeof value !== 'string' || !value.startsWith(TURN_PAGE_CURSOR_PREFIX)) {
    throw createInvalidTurnPageCursorError('Invalid turn page cursor.');
  }
  try {
    const encoded = value.slice(TURN_PAGE_CURSOR_PREFIX.length);
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const sessionId = normalizeSessionId(payload && payload.s);
    const sessionScopeKey = normalizeSessionScopeKey(payload && payload.k);
    const anchorTurnId = normalizeOptionalString(payload && payload.a);
    if (payload?.v !== 2 || !sessionId || !sessionScopeKey || !anchorTurnId) {
      throw new Error('Invalid cursor payload.');
    }
    return { sessionId, sessionScopeKey, anchorTurnId, includeAnchor: payload.i === true };
  } catch (error) {
    if (error && error.code === 'invalid_turn_cursor') {
      throw error;
    }
    throw createInvalidTurnPageCursorError('Invalid turn page cursor.');
  }
}

function createInvalidTurnPageCursorError(message) {
  const error = new Error(message);
  error.code = 'invalid_turn_cursor';
  error.retryable = false;
  return error;
}

module.exports = {
  ChatRuntimeHostSessionStore,
  HOST_SESSION_STORE_MISS,
  clonePayload,
  isUsableWebContents,
  normalizeSessionId,
  normalizeViewId,
};
