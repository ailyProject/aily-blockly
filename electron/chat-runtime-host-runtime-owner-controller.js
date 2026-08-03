const { isUsableWebContents } = require('./chat-runtime-host-session-store');

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

function normalizeRuntimeOwnerId(runtimeOwnerId) {
  return typeof runtimeOwnerId === 'string' && runtimeOwnerId.trim().length > 0
    ? runtimeOwnerId.trim()
    : 'aily-chat-host-runtime-owner';
}

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

function createRuntimeOwnerSnapshot(runtimeOwner) {
  if (!runtimeOwner) {
    return null;
  }
  return {
    runtimeOwnerId: runtimeOwner.runtimeOwnerId,
    ownerKey: runtimeOwner.ownerKey,
    kind: runtimeOwner.kind,
    usable: typeof runtimeOwner.isUsable === 'function' ? !!runtimeOwner.isUsable() : true,
  };
}

class ChatRuntimeHostRuntimeOwnerController {
  constructor(options = {}) {
    if (!options.BrowserWindow) {
      throw new Error('[AilyChat][RuntimeHost] BrowserWindow is required.');
    }
    if (!options.runtimeOwnerCommandChannel) {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner command channel is required.');
    }

    this.BrowserWindow = options.BrowserWindow;
    this.runtimeOwnerCommandChannel = options.runtimeOwnerCommandChannel;
    this.commandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
      ? options.commandTimeoutMs
      : DEFAULT_COMMAND_TIMEOUT_MS;
    this.onCommandResult = typeof options.onCommandResult === 'function'
      ? options.onCommandResult
      : () => {};
    this.onRuntimeOwnerLost = typeof options.onRuntimeOwnerLost === 'function'
      ? options.onRuntimeOwnerLost
      : () => {};

    this.hostWindowRef = null;
    this.runtimeOwner = null;
    this.commandSeed = 0;
    this.pendingCommands = new Map();
  }

  setHostWindow(hostWindow) {
    this.hostWindowRef = hostWindow || null;
  }

  handleRuntimeOwnerRegister(event, payload = {}) {
    this.assertHostRuntimeOwner(event);
    const runtimeOwnerId = normalizeRuntimeOwnerId(payload.runtimeOwnerId ?? payload.runtimeOwnerId);
    const webContents = event.sender;
    const ownerKey = `renderer:${webContents.id}`;
    const registration = this.registerRuntimeOwnerTransport({
      runtimeOwnerId,
      ownerKey,
      kind: 'renderer',
      sendCommand: command => webContents.send(this.runtimeOwnerCommandChannel, command),
      isUsable: () => isUsableWebContents(webContents),
      matchesEvent: candidateEvent => !!candidateEvent
        && !!candidateEvent.sender
        && candidateEvent.sender.id === webContents.id,
    });
    if (isRuntimeOwnerTraceEnabled()) {
      console.log('[AilyChat][RuntimeOwnerRegistered]', JSON.stringify({
        runtimeOwnerId,
        ownerKey,
        kind: 'renderer',
        webContentsId: webContents.id,
      }));
    }
    webContents.once('destroyed', () => this.clearRuntimeOwnerIfMatches(ownerKey));
    return registration;
  }

  handleRuntimeOwnerUnregister(event, payload = {}) {
    const runtimeOwnerId = normalizeRuntimeOwnerId(payload.runtimeOwnerId ?? payload.runtimeOwnerId);
    if (!this.runtimeOwner) {
      return { ok: true };
    }
    this.assertRegisteredRuntimeOwnerSender(event);
    if (this.runtimeOwner.runtimeOwnerId !== runtimeOwnerId) {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner id mismatch during unregister.');
    }
    this.clearRuntimeOwnerIfMatches(this.runtimeOwner.ownerKey);
    return { ok: true };
  }

  hasUsableRuntimeOwner() {
    return !!this.readRuntimeOwnerTransport();
  }

  registerRuntimeOwnerTransport(transport = {}) {
    const runtimeOwnerId = normalizeRuntimeOwnerId(transport.runtimeOwnerId);
    const ownerKey = typeof transport.ownerKey === 'string' && transport.ownerKey.trim()
      ? transport.ownerKey.trim()
      : runtimeOwnerId;
    if (typeof transport.sendCommand !== 'function') {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner transport requires sendCommand.');
    }
    if (this.runtimeOwner && this.runtimeOwner.ownerKey !== ownerKey) {
      throw new Error('[AilyChat][RuntimeHost] A different runtime owner is already registered.');
    }

    this.runtimeOwner = {
      runtimeOwnerId,
      ownerKey,
      kind: typeof transport.kind === 'string' && transport.kind.trim()
        ? transport.kind.trim()
        : 'execution-host',
      sendCommand: transport.sendCommand,
      isUsable: typeof transport.isUsable === 'function'
        ? transport.isUsable
        : () => true,
      dispose: typeof transport.dispose === 'function'
        ? transport.dispose
        : null,
      matchesEvent: typeof transport.matchesEvent === 'function'
        ? transport.matchesEvent
        : null,
    };
    console.warn('[AilyChat][RuntimeOwnerRegistered]', JSON.stringify(createRuntimeOwnerSnapshot(this.runtimeOwner)));
    return { ok: true, runtimeOwnerId, ownerKey };
  }

  dispatchCommand(method, args, options = {}) {
    const runtimeOwnerTransport = this.readRuntimeOwnerTransport();
    if (!runtimeOwnerTransport) {
      throw new Error('[AilyChat][RuntimeHost] No registered host runtime owner.');
    }

    const requestId = this.nextCommandId(method);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(`[AilyChat][RuntimeHost] Runtime host command timed out: ${method}`));
      }, timeoutMs);

      this.pendingCommands.set(requestId, { resolve, reject, timer, method, args });
      runtimeOwnerTransport.sendCommand({ requestId, method, args });
    });
  }

  handleRuntimeOwnerResponse(event, payload = {}) {
    this.assertRegisteredRuntimeOwnerSender(event);
    this.handleRuntimeOwnerTransportResponse(payload);
  }

  handleRuntimeOwnerTransportResponse(payload = {}) {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const pending = this.pendingCommands.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(requestId);
    if (payload.ok === false) {
      const error = new Error(payload.error?.message || '[AilyChat][RuntimeHost] Runtime owner command failed.');
      if (payload.error?.code) {
        error.code = payload.error.code;
      }
      pending.reject(error);
      return;
    }

    this.onCommandResult(pending.method, pending.args, payload.result);
    pending.resolve(payload.result);
  }

  assertRegisteredRuntimeOwnerSender(event) {
    if (!this.runtimeOwner || !this.runtimeOwner.matchesEvent || !this.runtimeOwner.matchesEvent(event)) {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner message came from a non-host renderer.');
    }
  }

  clearPendingCommands(error) {
    for (const [requestId, pending] of this.pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingCommands.delete(requestId);
    }
  }

  clearRuntimeOwnerIfMatches(ownerKey) {
    if (!this.runtimeOwner || this.runtimeOwner.ownerKey !== ownerKey) {
      return;
    }
    const runtimeOwner = this.runtimeOwner;
    this.runtimeOwner = null;
    if (typeof runtimeOwner.dispose === 'function') {
      try {
        runtimeOwner.dispose();
      } catch (error) {
        console.warn('[AilyChat][RuntimeHost] Runtime owner dispose failed:', error && error.message ? error.message : error);
      }
    }
    const error = new Error('[AilyChat][RuntimeHost] Registered runtime owner was destroyed.');
    error.code = 'runtime_owner_lost';
    error.retryable = true;
    if (isRuntimeOwnerTraceEnabled()) {
      console.warn('[AilyChat][RuntimeOwnerLost]', JSON.stringify({
        ownerKey,
        kind: runtimeOwner.kind,
      }));
    }
    this.clearPendingCommands(error);
    this.onRuntimeOwnerLost(error);
  }

  getSenderWindow(event) {
    return event && event.sender ? this.BrowserWindow.fromWebContents(event.sender) : null;
  }

  assertHostRuntimeOwner(event) {
    const senderWindow = this.getSenderWindow(event);
    if (!this.hostWindowRef || !senderWindow || senderWindow !== this.hostWindowRef) {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner must be registered by the host main window.');
    }
  }

  readRuntimeOwnerTransport() {
    if (!this.runtimeOwner || !this.runtimeOwner.isUsable()) {
      if (this.runtimeOwner) {
        this.clearRuntimeOwnerIfMatches(this.runtimeOwner.ownerKey);
      }
      return null;
    }
    return this.runtimeOwner;
  }

  snapshotRuntimeOwner() {
    return createRuntimeOwnerSnapshot(this.readRuntimeOwnerTransport());
  }

  nextCommandId(method) {
    this.commandSeed += 1;
    return `chat_runtime_${method}_${Date.now().toString(36)}_${this.commandSeed.toString(36)}`;
  }
}

module.exports = {
  ChatRuntimeHostRuntimeOwnerController,
  DEFAULT_COMMAND_TIMEOUT_MS,
  normalizeRuntimeOwnerId,
};


