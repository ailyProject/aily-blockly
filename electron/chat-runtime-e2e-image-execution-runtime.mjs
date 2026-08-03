import {
  resolveChatImageAttachments,
  toManagedChatImageAttachment,
} from './chat-image-media-store.mjs';

export function createRuntimeOwner(options = {}) {
  return new ImageE2eRuntimeOwner(options);
}

export default createRuntimeOwner;

class ImageE2eRuntimeOwner {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.listeners = new Set();
    this.sessions = new Map();
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async preflightTurnImages(command = {}) {
    const request = command.request && typeof command.request === 'object'
      ? command.request
      : {};
    const images = await resolveChatImageAttachments(request.imageAttachments, {
      env: this.env,
    });
    return {
      schemaVersion: 1,
      kind: 'aily-chat-image-preflight-result',
      imageAttachments: images.map(toManagedChatImageAttachment),
    };
  }

  async prewarmRuntime(command = {}) {
    const sessionId = normalizeString(command.sessionId);
    this.ensureSession(sessionId);
    return { sessionId, ensured: true, executionHost: 'e2e-image-worker' };
  }

  async restoreRuntimeSession(command = {}) {
    const sessionId = normalizeString(command.sessionId);
    const session = this.ensureSession(sessionId);
    session.requestInProgress = false;
    session.activeTurnId = null;
    return this.readSessionExecutionState({ sessionId });
  }

  readSessionExecutionState(command = {}) {
    const sessionId = normalizeString(command.sessionId);
    const session = this.sessions.get(sessionId);
    return {
      sessionId,
      status: session?.requestInProgress ? 'running' : 'completed',
      requestInProgress: session?.requestInProgress === true,
      activeTurnId: session?.activeTurnId || null,
      transcriptRevision: Number(session?.revision) || 0,
    };
  }

  readEditingSessionState(command = {}) {
    return {
      sessionId: normalizeString(command.sessionId),
      revision: 0,
      entries: [],
      operations: [],
    };
  }

  readEditingSessionContent() {
    return null;
  }

  async startTurn(command = {}) {
    const sessionId = normalizeString(command.sessionId || command.request?.sessionId);
    const turnId = normalizeString(command.turnId || command.request?.activeResponseHandle);
    const request = command.request && typeof command.request === 'object'
      ? command.request
      : {};
    const session = this.ensureSession(sessionId);
    session.requestInProgress = true;
    session.activeTurnId = turnId;
    session.revision += 1;

    const timestamp = Date.now();
    const attachments = (Array.isArray(request.imageAttachments) ? request.imageAttachments : [])
      .map(image => {
        const mediaRef = image?.source?.kind === 'managed-ref'
          ? normalizeString(image.source.mediaRef)
          : '';
        return mediaRef
          ? {
              type: 'image',
              name: normalizeString(image.name) || 'image',
              uri: mediaRef,
              ...(normalizeString(image.mimeType) ? { mimeType: image.mimeType } : {}),
              ...(image.detail ? { detail: image.detail } : {}),
            }
          : null;
      })
      .filter(Boolean);
    const turn = {
      turnId,
      request: {
        content: normalizeString(request.requestText),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      rounds: [],
      response: {
        id: turnId,
        participant: 'main',
        status: 'completed',
        parts: [],
        resultText: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    session.requestInProgress = false;
    session.activeTurnId = null;
    session.revision += 1;
    this.emit({
      kind: 'turnCompleted',
      sessionId,
      turnId,
      revision: session.revision,
      turn,
      state: this.readSessionExecutionState({ sessionId }),
    });
  }

  async stopTurn(command = {}) {
    const sessionId = normalizeString(command.sessionId);
    const session = this.ensureSession(sessionId);
    session.requestInProgress = false;
    session.activeTurnId = null;
    session.revision += 1;
    return this.readSessionExecutionState({ sessionId });
  }

  async disposeSessionResources(command = {}) {
    this.sessions.delete(normalizeString(command.sessionId));
  }

  resolveInteraction() {
    return undefined;
  }

  ensureSession(sessionId) {
    if (!sessionId) {
      throw new Error('[AilyChat][E2EImageRuntime] Session id is required.');
    }
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        revision: 0,
        requestInProgress: false,
        activeTurnId: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}
