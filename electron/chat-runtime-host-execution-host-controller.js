const path = require('path');

const DEFAULT_EXECUTION_HOST_OWNER_KEY = 'execution-host:aily-chat';
const DEFAULT_EXECUTION_HOST_RUNTIME_OWNER_ID = 'aily-chat-execution-host';
const DEFAULT_EXECUTION_HOST_ENTRY = path.join(__dirname, 'chat-runtime-execution-host-worker.js');

function normalizeExecutionHostMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'utility' || normalized === 'utilityprocess') {
    return 'utility';
  }
  if (normalized === 'worker' || normalized === 'worker_threads') {
    return 'worker';
  }
  if (normalized === 'off' || normalized === 'false' || normalized === '0') {
    return 'off';
  }
  return 'auto';
}

function readConfiguredExecutionHostMode(env = process.env) {
  const rawMode = env.AILY_CHAT_EXECUTION_HOST || env.__AILY_CHAT_EXECUTION_HOST__;
  return rawMode === undefined || rawMode === null || rawMode === ''
    ? 'off'
    : normalizeExecutionHostMode(rawMode);
}

function hasConfiguredRuntimeOwnerModule(env = process.env) {
  const modulePath = env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE || env.__AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE__;
  return typeof modulePath === 'string' && modulePath.trim().length > 0;
}

function readConfiguredRuntimeOwnerModule(env = process.env) {
  const modulePath = env.AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE || env.__AILY_CHAT_EXECUTION_HOST_RUNTIME_MODULE__;
  return typeof modulePath === 'string' ? modulePath.trim() : '';
}

class ChatRuntimeHostExecutionHostController {
  constructor(options = {}) {
    if (!options.runtimeHostService) {
      throw new Error('[AilyChat][ExecutionHost] runtimeHostService is required.');
    }

    this.runtimeHostService = options.runtimeHostService;
    this.utilityProcess = options.utilityProcess || null;
    this.Worker = options.Worker || null;
    this.entry = options.entry || DEFAULT_EXECUTION_HOST_ENTRY;
    this.mode = normalizeExecutionHostMode(options.mode || readConfiguredExecutionHostMode(options.env));
    this.env = options.env || process.env;
    this.executionHost = null;
    this.started = false;
  }

  shouldStart() {
    return this.mode !== 'off' && hasConfiguredRuntimeOwnerModule(this.env);
  }

  start() {
    const runtimeModule = readConfiguredRuntimeOwnerModule(this.env);
    if (this.started) {
      console.warn('[AilyChat][ExecutionHostStart]', JSON.stringify({
        phase: 'skip',
        reason: 'already-started',
        mode: this.mode,
        hasRuntimeModule: !!runtimeModule,
      }));
      return false;
    }
    if (!this.shouldStart()) {
      console.warn('[AilyChat][ExecutionHostStart]', JSON.stringify({
        phase: 'skip',
        reason: this.mode === 'off' ? 'mode-off' : 'missing-runtime-module',
        mode: this.mode,
        hasRuntimeModule: !!runtimeModule,
        runtimeModule,
      }));
      return false;
    }
    const child = this.createChild();
    if (!child) {
      console.warn('[AilyChat][ExecutionHostStart]', JSON.stringify({
        phase: 'skip',
        reason: 'child-not-created',
        mode: this.mode,
        hasRuntimeModule: !!runtimeModule,
        runtimeModule,
      }));
      return false;
    }

    this.executionHost = child;
    this.started = true;
    this.runtimeHostService.registerRuntimeOwnerTransport({
      runtimeOwnerId: DEFAULT_EXECUTION_HOST_RUNTIME_OWNER_ID,
      ownerKey: DEFAULT_EXECUTION_HOST_OWNER_KEY,
      kind: child.kind,
      sendCommand: command => child.postMessage({ type: 'command', payload: command }),
      isUsable: () => this.started && !child.exited,
      dispose: () => this.stop({ clearTransport: false }),
    });
    console.warn('[AilyChat][ExecutionHostStart]', JSON.stringify({
      phase: 'started',
      mode: this.mode,
      childKind: child.kind,
      runtimeModule,
    }));
    return true;
  }

  stop(options = {}) {
    if (!this.started) {
      return;
    }
    const child = this.executionHost;
    this.executionHost = null;
    this.started = false;
    if (!child) {
      return;
    }
    try {
      child.kill();
    } catch (error) {
      console.warn('[AilyChat][ExecutionHost] failed to stop execution host:', error && error.message ? error.message : error);
    }
    if (options.clearTransport !== false && typeof this.runtimeHostService.clearRuntimeOwnerTransport === 'function') {
      this.runtimeHostService.clearRuntimeOwnerTransport(DEFAULT_EXECUTION_HOST_OWNER_KEY);
    }
  }

  createChild() {
    if (this.mode === 'utility' || this.mode === 'auto') {
      const utilityChild = this.createUtilityProcessChild();
      if (utilityChild || this.mode === 'utility') {
        return utilityChild;
      }
    }
    if (this.mode === 'worker' || this.mode === 'auto') {
      return this.createWorkerChild();
    }
    return null;
  }

  createUtilityProcessChild() {
    if (!this.utilityProcess || typeof this.utilityProcess.fork !== 'function') {
      return null;
    }
    const child = this.utilityProcess.fork(this.entry, [], {
      env: {
        ...process.env,
        ...this.env,
        AILY_CHAT_EXECUTION_HOST_KIND: 'utility',
      },
    });
    return this.wrapMessageChild('utilityProcess', child);
  }

  createWorkerChild() {
    const Worker = this.Worker || tryReadWorkerThreadsWorker();
    if (typeof Worker !== 'function') {
      return null;
    }
    const child = new Worker(this.entry, {
      env: {
        ...process.env,
        ...this.env,
        AILY_CHAT_EXECUTION_HOST_KIND: 'worker',
      },
      workerData: {
        kind: 'worker',
      },
    });
    return this.wrapMessageChild('worker', child);
  }

  wrapMessageChild(kind, child) {
    if (!child || typeof child.postMessage !== 'function') {
      return null;
    }
    const wrapped = {
      kind,
      exited: false,
      postMessage: message => child.postMessage(message),
      kill: () => {
        wrapped.exited = true;
        if (typeof child.kill === 'function') {
          child.kill();
          return;
        }
        if (typeof child.terminate === 'function') {
          child.terminate();
        }
      },
    };
    const onMessage = message => this.handleExecutionHostMessage(message);
    const onExit = () => {
      this.handleExecutionHostExit(wrapped);
    };
    if (typeof child.on === 'function') {
      child.on('message', onMessage);
      child.once?.('exit', onExit);
      child.once?.('error', error => {
        console.error('[AilyChat][ExecutionHost] execution host error:', error);
        this.handleExecutionHostExit(wrapped);
      });
    }
    return wrapped;
  }

  handleExecutionHostExit(child) {
    if (!child || child.exited) {
      return;
    }
    child.exited = true;
    if (this.executionHost === child) {
      this.executionHost = null;
      this.started = false;
    }
    if (typeof this.runtimeHostService.clearRuntimeOwnerTransport === 'function') {
      this.runtimeHostService.clearRuntimeOwnerTransport(DEFAULT_EXECUTION_HOST_OWNER_KEY);
    }
  }

  handleExecutionHostMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'response') {
      this.runtimeHostService.handleRuntimeOwnerTransportResponse(message.payload || {});
      return;
    }
    if (message.type === 'event') {
      void this.runtimeHostService.handleRuntimeOwnerTransportEvent(message.payload || {}).catch(error => {
        console.warn('[AilyChat][ExecutionHost] Ignored runtime owner event:', {
          message: error && error.message ? error.message : String(error || 'Unknown runtime owner event error'),
        });
      });
      return;
    }
    if (message.type === 'ready') {
      console.warn('[AilyChat][ExecutionHostStart]', JSON.stringify({
        phase: 'ready',
        mode: this.mode,
        childKind: this.executionHost?.kind || '<none>',
        runtimeModule: readConfiguredRuntimeOwnerModule(this.env),
      }));
      return;
    }
    if (message.type === 'startup-error') {
      console.error('[AilyChat][ExecutionHostStart]', JSON.stringify({
        phase: 'startup-error',
        mode: this.mode,
        childKind: this.executionHost?.kind || '<none>',
        runtimeModule: readConfiguredRuntimeOwnerModule(this.env),
        error: message.payload || {},
      }));
      const child = this.executionHost;
      if (child) {
        this.stop();
      }
      return;
    }
    if (message.type === 'host-command') {
      void this.respondToExecutionHostRequest('host-command-response', message.payload, payload =>
        this.runtimeHostService.handleExecutionHostCommand(payload));
      return;
    }
    if (message.type === 'resource-operation') {
      void this.respondToExecutionHostRequest('resource-operation-response', message.payload, payload =>
        this.runtimeHostService.handleExecutionHostResourceOperation(payload));
    }
  }

  async respondToExecutionHostRequest(responseType, payload = {}, handler) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId || !this.executionHost || this.executionHost.exited) {
      return;
    }
    try {
      const result = await handler(payload);
      this.executionHost.postMessage({
        type: responseType,
        payload: {
          requestId,
          ok: true,
          result: createProtocolSafePayload(result),
        },
      });
    } catch (error) {
      this.executionHost.postMessage({
        type: responseType,
        payload: {
          requestId,
          ok: false,
          error: createErrorPayload(error),
        },
      });
    }
  }
}

function createProtocolSafePayload(value) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function createErrorPayload(error) {
  return {
    message: error && error.message ? error.message : String(error || 'Unknown execution host error'),
    ...(error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...(error && typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
  };
}

function tryReadWorkerThreadsWorker() {
  try {
    return require('worker_threads').Worker;
  } catch {
    return null;
  }
}

module.exports = {
  ChatRuntimeHostExecutionHostController,
  DEFAULT_EXECUTION_HOST_ENTRY,
  DEFAULT_EXECUTION_HOST_OWNER_KEY,
  DEFAULT_EXECUTION_HOST_RUNTIME_OWNER_ID,
  hasConfiguredRuntimeOwnerModule,
  normalizeExecutionHostMode,
  readConfiguredExecutionHostMode,
  readConfiguredRuntimeOwnerModule,
};
