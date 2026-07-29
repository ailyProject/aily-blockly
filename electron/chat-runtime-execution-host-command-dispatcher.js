const { pathToFileURL } = require('url');

const VALID_RUNTIME_OWNER_METHODS = new Set([
  'prewarmRuntime',
  'restoreRuntimeSession',
  'forkSession',
  'readSessionExecutionState',
  'readEditingSessionState',
  'readEditingSessionContent',
  'operateEditingSessionEntry',
  'acceptEditingSession',
  'buildEditingSessionNavigationPlan',
  'applyEditingSessionNavigation',
  'commitEditingSessionNavigation',
  'rollbackEditingSessionNavigation',
  'startTurn',
  'stopTurn',
  'disposeSessionResources',
  'resolveInteraction',
]);

function createExecutionHostCommandDispatcher(options = {}) {
  const runtimeOwner = options.runtimeOwner;
  if (!runtimeOwner || typeof runtimeOwner !== 'object') {
    throw new Error('[AilyChat][ExecutionHost] Runtime owner is required.');
  }
  const postMessage = typeof options.postMessage === 'function' ? options.postMessage : () => {};
  const registrationState = createRuntimeOwnerRegistrationState();
  const eventSubscription = typeof runtimeOwner.onEvent === 'function'
    ? runtimeOwner.onEvent(event => {
        const ownerEvent = createRuntimeOwnerEvent(event, registrationState);
        if (ownerEvent) {
          postMessage({
            type: 'event',
            payload: createProtocolSafePayload(ownerEvent),
          });
        }
      })
    : null;

  return {
    async handleCommand(command = {}) {
      const requestId = typeof command.requestId === 'string' ? command.requestId : '';
      try {
        const method = normalizeRuntimeOwnerMethod(command.method);
        const args = Array.isArray(command.args) ? command.args : [];
        trackRuntimeOwnerCommand(method, args, registrationState);
        const result = await callRuntimeOwnerMethod(runtimeOwner, method, args);
        if (requestId) {
          postMessage({
            type: 'response',
            payload: createProtocolSafePayload({
              requestId,
              ok: true,
              result,
            }),
          });
        }
      } catch (error) {
        if (!requestId) {
          return;
        }
        postMessage({
          type: 'response',
          payload: createProtocolSafePayload({
            requestId,
            ok: false,
            error: createErrorPayload(error),
          }),
        });
      }
    },
    dispose() {
      if (eventSubscription && typeof eventSubscription.dispose === 'function') {
        eventSubscription.dispose();
      }
    },
  };
}

function loadRuntimeOwnerFromEnvironment(options = {}) {
  const env = options.env || process.env;
  const modulePath = env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE || env.__AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE__;
  if (!modulePath) {
    throw new Error('[AilyChat][ExecutionHost] AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE is required.');
  }
  const runtimeModule = require(modulePath);
  return createRuntimeOwnerFromModule(runtimeModule, modulePath, options);
}

async function loadRuntimeOwnerFromEnvironmentAsync(options = {}) {
  const env = options.env || process.env;
  const modulePath = env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE || env.__AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE__;
  if (!modulePath) {
    throw new Error('[AilyChat][ExecutionHost] AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE is required.');
  }
  const runtimeModule = await loadRuntimeModule(modulePath);
  return createRuntimeOwnerFromModule(runtimeModule, modulePath, options);
}

async function loadRuntimeModule(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (!isEsmRequireError(error)) {
      throw error;
    }
  }
  return await import(toImportSpecifier(modulePath));
}

function isEsmRequireError(error) {
  if (!error) {
    return false;
  }
  return error.code === 'ERR_REQUIRE_ESM'
    || String(error.message || '').includes('require() of ES Module');
}

function toImportSpecifier(modulePath) {
  if (/^[a-zA-Z]:[\\/]/.test(modulePath) || modulePath.startsWith('/') || modulePath.startsWith('\\\\')) {
    return pathToFileURL(modulePath).href;
  }
  return modulePath;
}

function createRuntimeOwnerFromModule(runtimeModule, modulePath, options) {
  if (typeof runtimeModule === 'function') {
    return runtimeModule(options);
  }
  if (runtimeModule && typeof runtimeModule.createRuntimeOwner === 'function') {
    return runtimeModule.createRuntimeOwner(options);
  }
  if (runtimeModule && typeof runtimeModule.default === 'function') {
    return runtimeModule.default(options);
  }
  if (runtimeModule && typeof runtimeModule.startTurn === 'function') {
    return runtimeModule;
  }
  throw new Error(`[AilyChat][ExecutionHost] Runtime module ${modulePath} does not export a runtime owner.`);
}

function createRuntimeOwnerRegistrationState() {
  return {
    activeTurnIds: new Map(),
    activeRequestIds: new Map(),
  };
}

function normalizeRuntimeOwnerMethod(method) {
  if (VALID_RUNTIME_OWNER_METHODS.has(method)) {
    return method;
  }
  throw new Error(`[AilyChat][RuntimeHost] Unsupported runtime owner command method: ${String(method || '<missing>')}`);
}

function trackRuntimeOwnerCommand(method, args, registrationState) {
  if (method === 'startTurn') {
    const command = args[0] || {};
    const request = command.request || {};
    const sessionId = normalizeNonEmptyString(command.sessionId || request.sessionId);
    const turnId = normalizeNonEmptyString(command.turnId || request.activeResponseHandle);
    const requestId = readRequestMetadataRequestId(request);
    if (sessionId && turnId) {
      registrationState.activeTurnIds.set(sessionId, turnId);
      if (requestId) {
        registrationState.activeRequestIds.set(sessionId, requestId);
      } else {
        registrationState.activeRequestIds.delete(sessionId);
      }
    }
    return;
  }
  if (method === 'disposeSessionResources') {
    const command = args[0] || {};
    const sessionId = normalizeNonEmptyString(command.sessionId);
    if (sessionId) {
      registrationState.activeTurnIds.delete(sessionId);
      registrationState.activeRequestIds.delete(sessionId);
    }
  }
}

function callRuntimeOwnerMethod(runtimeOwner, method, args) {
  switch (method) {
    case 'prewarmRuntime': {
      const command = args[0] || {};
      return runtimeOwner.prewarmRuntime({
        sessionId: command.sessionId,
        providerOptions: command.providerOptions || null,
        agentRuntimeMode: command.agentRuntimeMode || null,
        currentModel: command.currentModel || null,
        summarizerModel: command.summarizerModel || null,
      });
    }
    case 'restoreRuntimeSession': {
      const command = args[0] || {};
      if (!command.snapshot || typeof command.snapshot !== 'object') {
        throw new Error('[AilyChat][RuntimeHost] restoreRuntimeSession requires a session snapshot.');
      }
      return runtimeOwner.restoreRuntimeSession(command);
    }
    case 'forkSession': {
      if (typeof runtimeOwner.forkSession !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not support session fork.');
      }
      return runtimeOwner.forkSession(args[0] || {});
    }
    case 'readSessionExecutionState': {
      if (typeof runtimeOwner.readSessionExecutionState !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not expose execution state.');
      }
      return runtimeOwner.readSessionExecutionState(args[0] || {});
    }
    case 'readEditingSessionState': {
      if (typeof runtimeOwner.readEditingSessionState !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not expose editing-session state.');
      }
      return runtimeOwner.readEditingSessionState(args[0] || {});
    }
    case 'readEditingSessionContent': {
      if (typeof runtimeOwner.readEditingSessionContent !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not expose editing-session content.');
      }
      return runtimeOwner.readEditingSessionContent(args[0] || {});
    }
    case 'operateEditingSessionEntry': {
      if (typeof runtimeOwner.operateEditingSessionEntry !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner cannot operate editing-session entries.');
      }
      return runtimeOwner.operateEditingSessionEntry(args[0] || {});
    }
    case 'acceptEditingSession': {
      if (typeof runtimeOwner.acceptEditingSession !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner cannot accept the editing session.');
      }
      return runtimeOwner.acceptEditingSession(args[0] || {});
    }
    case 'buildEditingSessionNavigationPlan': {
      if (typeof runtimeOwner.buildEditingSessionNavigationPlan !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner does not expose editing-session navigation plans.');
      }
      return runtimeOwner.buildEditingSessionNavigationPlan(args[0] || {});
    }
    case 'applyEditingSessionNavigation': {
      if (typeof runtimeOwner.applyEditingSessionNavigation !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner cannot apply editing-session navigation.');
      }
      return runtimeOwner.applyEditingSessionNavigation(args[0] || {});
    }
    case 'commitEditingSessionNavigation': {
      if (typeof runtimeOwner.commitEditingSessionNavigation !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner cannot commit editing-session navigation.');
      }
      return runtimeOwner.commitEditingSessionNavigation(args[0] || {});
    }
    case 'rollbackEditingSessionNavigation': {
      if (typeof runtimeOwner.rollbackEditingSessionNavigation !== 'function') {
        throw new Error('[AilyChat][RuntimeHost] Runtime owner cannot roll back editing-session navigation.');
      }
      return runtimeOwner.rollbackEditingSessionNavigation(args[0] || {});
    }
    case 'startTurn': {
      const command = args[0] || {};
      const request = command.request;
      if (!request || typeof request !== 'object') {
        throw new Error('[AilyChat][RuntimeHost] startTurn requires a submit request.');
      }
      return runtimeOwner.startTurn({
        sessionId: command.sessionId || request.sessionId,
        turnId: command.turnId || request.activeResponseHandle,
        request: {
          ...request,
          sessionId: command.sessionId || request.sessionId,
          activeResponseHandle: command.turnId || request.activeResponseHandle,
        },
        executionContext: command.executionContext,
      });
    }
    case 'stopTurn': {
      const command = args[0] || {};
      return runtimeOwner.stopTurn({
        sessionId: command.sessionId,
        turnId: command.turnId,
      });
    }
    case 'disposeSessionResources': {
      const command = args[0] || {};
      return runtimeOwner.disposeSessionResources({
        sessionId: command.sessionId,
        deleteStorage: command.deleteStorage === true,
        projectPath: command.projectPath ?? null,
      });
    }
    case 'resolveInteraction':
      return runtimeOwner.resolveInteraction(args[0]);
    default:
      throw new Error(`[AilyChat][RuntimeHost] Unsupported runtime owner command method: ${String(method || '<missing>')}`);
  }
}

function createRuntimeOwnerEvent(event, registrationState) {
  const sessionId = normalizeNonEmptyString(event && event.sessionId);
  if (!sessionId) {
    return null;
  }
  if (isRuntimeOwnerEvent(event)) {
    return normalizeExplicitRuntimeOwnerEvent(event, sessionId, registrationState);
  }
  const trackedTurnId = registrationState.activeTurnIds.get(sessionId) || '';
  if (event.kind === 'render-event') {
    const renderEventTurnId = readRenderEventTurnId(event.renderEvent);
    const turnId = renderEventTurnId || normalizeNonEmptyString(event.turnId) || trackedTurnId;
    if (!turnId) {
      return null;
    }
    if (renderEventTurnId) {
      registrationState.activeTurnIds.set(sessionId, renderEventTurnId);
    }
    return {
      kind: 'turnProgress',
      sessionId,
      turnId,
      revision: Number(event.revision) || 0,
      ...(event.request ? { request: event.request } : {}),
      renderEvent: event.renderEvent,
    };
  }
  const turnId = trackedTurnId || readEventTurnId(event);
  if (!turnId) {
    return null;
  }
  const revision = Number(event.revision) || 0;
  switch (event.kind) {
    case 'transcript':
    case 'turn-transcript':
    case 'part-transcript':
      return null;
    case 'view-request':
    case 'resource-request':
      return {
        kind: 'turnProgress',
        sessionId,
        turnId,
        revision,
        event,
      };
    case 'session-state':
    case 'runtime-status':
      if (event.state && event.state.requestInProgress === false) {
        registrationState.activeTurnIds.delete(sessionId);
        registrationState.activeRequestIds.delete(sessionId);
        return {
          kind: 'turnCompleted',
          sessionId,
          turnId,
          revision,
          state: event.state,
        };
      }
      registrationState.activeTurnIds.set(sessionId, turnId);
      return {
        kind: 'turnProgress',
        sessionId,
        turnId,
        revision,
        event,
      };
    case 'interaction':
      return {
        kind: 'turnInteractionRequested',
        sessionId,
        turnId,
        revision,
        interaction: event.interaction,
      };
    case 'error':
      registrationState.activeTurnIds.delete(sessionId);
      registrationState.activeRequestIds.delete(sessionId);
      return {
        kind: 'turnError',
        sessionId,
        turnId,
        revision,
        error: event.error,
      };
    default:
      return null;
  }
}

function isRuntimeOwnerEvent(event) {
  const kind = event && event.kind;
  return kind === 'turnProgress'
    || kind === 'editingSessionChanged'
    || kind === 'turnDiffUpdated'
    || kind === 'runtimeProjectPathUpdated'
    || kind === 'turnInteractionRequested'
    || kind === 'turnError'
    || kind === 'turnCompleted';
}

function normalizeExplicitRuntimeOwnerEvent(event, sessionId, registrationState) {
  if (event.kind === 'editingSessionChanged') {
    const revision = Number(event.revision);
    return Number.isFinite(revision) && revision >= 0
      ? {
          kind: 'editingSessionChanged',
          sessionId,
          revision,
        }
      : null;
  }
  if (event.kind === 'turnDiffUpdated') {
    const turnId = normalizeNonEmptyString(event.turnId);
    const revision = Number(event.revision);
    return turnId && Number.isFinite(revision) && revision >= 0 && typeof event.diff === 'string'
      ? {
          kind: 'turnDiffUpdated',
          sessionId,
          turnId,
          revision,
          diff: event.diff,
        }
      : null;
  }
  const trackedTurnId = registrationState.activeTurnIds.get(sessionId) || '';
  const turnId = normalizeNonEmptyString(event.turn && event.turn.turnId)
    || normalizeNonEmptyString(event.turnId)
    || trackedTurnId;
  if (!turnId) {
    return null;
  }
  if (event.kind === 'turnCompleted' || event.kind === 'turnError') {
    registrationState.activeTurnIds.delete(sessionId);
    registrationState.activeRequestIds.delete(sessionId);
  } else {
    registrationState.activeTurnIds.set(sessionId, turnId);
  }
  return {
    ...event,
    sessionId,
    turnId,
  };
}

function readEventTurnId(event) {
  if ((event.kind === 'session-state' || event.kind === 'runtime-status') && event.state && event.state.activeTurnId) {
    return normalizeNonEmptyString(event.state.activeTurnId);
  }
  return '';
}

function readRenderEventTurnId(event) {
  return event && typeof event === 'object'
    ? normalizeNonEmptyString(event.turnId)
    : '';
}

function normalizeNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function readRequestMetadataRequestId(request) {
  const metadata = request && request.metadata;
  return metadata && typeof metadata === 'object'
    ? normalizeNonEmptyString(metadata.requestId)
    : '';
}

function createProtocolSafePayload(value) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value, createProtocolSafeJsonReplacer()));
  } catch {
    return value;
  }
}

function createProtocolSafeJsonReplacer() {
  const seen = new WeakSet();
  return (_key, value) => {
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      return undefined;
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (value instanceof Map) {
      return Array.from(value.entries());
    }
    if (value instanceof Set) {
      return Array.from(value.values());
    }
    return value;
  };
}

function createErrorPayload(error) {
  return {
    message: error && error.message ? error.message : String(error || 'Unknown execution host error'),
    name: error && typeof error.name === 'string' ? error.name : 'Error',
    code: error && typeof error.code === 'string' ? error.code : 'execution_host_runtime_failed',
    retryable: error && typeof error.retryable === 'boolean' ? error.retryable : false,
  };
}

module.exports = {
  createExecutionHostCommandDispatcher,
  loadRuntimeOwnerFromEnvironment,
  loadRuntimeOwnerFromEnvironmentAsync,
  normalizeRuntimeOwnerMethod,
};
