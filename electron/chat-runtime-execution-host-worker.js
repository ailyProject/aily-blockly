const {
  createExecutionHostCommandDispatcher,
  loadRuntimeOwnerFromEnvironmentAsync,
} = require('./chat-runtime-execution-host-command-dispatcher');

let parentPort = null;

try {
  parentPort = require('worker_threads').parentPort;
} catch {
  parentPort = null;
}

if (!parentPort && process.parentPort) {
  parentPort = process.parentPort;
}

function postMessage(message) {
  if (parentPort && typeof parentPort.postMessage === 'function') {
    parentPort.postMessage(message);
  }
}

function onMessage(listener) {
  if (!parentPort || typeof parentPort.on !== 'function') {
    return;
  }
  parentPort.on('message', listener);
}

let hostRequestSeed = 0;
const pendingHostRequests = new Map();

function nextHostRequestId(prefix) {
  hostRequestSeed += 1;
  return `execution-host-${prefix}-${Date.now()}-${hostRequestSeed}`;
}

function callHost(method, args = []) {
  return sendHostRequest('host-command', 'host-command-response', {
    method,
    args: Array.isArray(args) ? args : [],
  });
}

function requestResourceOperation(request) {
  return sendHostRequest('resource-operation', 'resource-operation-response', {
    request,
  });
}

function sendHostRequest(type, responseType, payload) {
  const requestId = nextHostRequestId(type);
  return new Promise((resolve, reject) => {
    pendingHostRequests.set(requestId, { resolve, reject, responseType });
    postMessage({
      type,
      payload: {
        requestId,
        ...payload,
      },
    });
  });
}

function resolveHostRequest(responseType, payload = {}) {
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
  const pending = pendingHostRequests.get(requestId);
  if (!pending || pending.responseType !== responseType) {
    return false;
  }
  pendingHostRequests.delete(requestId);
  if (payload.ok === false) {
    const error = new Error(payload.error?.message || '[AilyChat][ExecutionHost] Host request failed.');
    if (payload.error?.name) {
      error.name = payload.error.name;
    }
    if (payload.error?.code) {
      error.code = payload.error.code;
    }
    if (typeof payload.error?.retryable === 'boolean') {
      error.retryable = payload.error.retryable;
    }
    pending.reject(error);
    return true;
  }
  pending.resolve(payload.result);
  return true;
}

let commandDispatcher = null;
let startupError = null;
const pendingCommands = [];

onMessage(message => {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'host-command-response') {
    resolveHostRequest('host-command-response', message.payload || {});
    return;
  }
  if (message.type === 'resource-operation-response') {
    resolveHostRequest('resource-operation-response', message.payload || {});
    return;
  }
  if (message.type === 'command') {
    handleCommandMessage(message.payload);
  }
});

void initializeExecutionHost();

async function initializeExecutionHost() {
  try {
    const runtimeOwner = await loadRuntimeOwnerFromEnvironmentAsync({
      callHost,
      requestResourceOperation,
      env: process.env,
    });
    commandDispatcher = createExecutionHostCommandDispatcher({
      runtimeOwner,
      postMessage,
    });
    postMessage({
      type: 'ready',
      payload: {
        kind: 'execution-host-ready',
      },
    });
    drainPendingCommands();
  } catch (error) {
    startupError = error;
    postMessage({
      type: 'startup-error',
      payload: createErrorPayload(error),
    });
    drainPendingCommands();
  }
}

function handleCommandMessage(command) {
  if (commandDispatcher) {
    void commandDispatcher.handleCommand(command);
    return;
  }
  pendingCommands.push(command || {});
}

function drainPendingCommands() {
  while (pendingCommands.length > 0) {
    const command = pendingCommands.shift();
    if (commandDispatcher) {
      void commandDispatcher.handleCommand(command);
      continue;
    }
    respondCommandStartupError(command);
  }
}

function respondCommandStartupError(command = {}) {
  const requestId = typeof command.requestId === 'string' ? command.requestId : '';
  if (!requestId) {
    return;
  }
  postMessage({
    type: 'response',
    payload: {
      requestId,
      ok: false,
      error: createErrorPayload(startupError || new Error('[AilyChat][ExecutionHost] Runtime owner is not ready.')),
    },
  });
}

function createErrorPayload(error) {
  return {
    message: error && error.message ? error.message : String(error || 'Unknown execution host startup error'),
    name: error && typeof error.name === 'string' ? error.name : 'Error',
    code: error && typeof error.code === 'string' ? error.code : 'execution_host_startup_failed',
    retryable: false,
  };
}
