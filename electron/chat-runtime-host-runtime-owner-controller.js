const { isUsableWebContents } = require('./chat-runtime-host-session-store');

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

function normalizeRuntimeOwnerId(runtimeOwnerId) {
  return typeof runtimeOwnerId === 'string' && runtimeOwnerId.trim().length > 0
    ? runtimeOwnerId.trim()
    : 'aily-chat-host-runtime-owner';
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
    this.runtimeOwnerWindowRef = null;
    this.runtimeOwner = null;
    this.commandSeed = 0;
    this.pendingCommands = new Map();
  }

  setHostWindow(hostWindow) {
    this.hostWindowRef = hostWindow || null;
  }

  setRuntimeOwnerWindow(runtimeOwnerWindow) {
    this.runtimeOwnerWindowRef = runtimeOwnerWindow || null;
    if (!runtimeOwnerWindow && this.runtimeOwner) {
      const error = new Error('[AilyChat][RuntimeHost] Runtime owner window was cleared.');
      error.code = 'runtime_owner_lost';
      error.retryable = true;
      this.clearRuntimeOwnerIfMatches(this.runtimeOwner.webContentsId);
      this.clearPendingCommands(error);
    }
  }

  handleRuntimeOwnerRegister(event, payload = {}) {
    this.assertHostRuntimeOwner(event);
    const runtimeOwnerId = normalizeRuntimeOwnerId(payload.runtimeOwnerId ?? payload.runtimeOwnerId);
    if (this.runtimeOwner && this.runtimeOwner.webContentsId !== event.sender.id) {
      throw new Error('[AilyChat][RuntimeHost] A different runtime owner is already registered.');
    }

    this.runtimeOwner = {
      runtimeOwnerId: runtimeOwnerId,
      webContentsId: event.sender.id,
      webContents: event.sender,
    };
    console.log('[AilyChat][RuntimeOwnerRegistered]', JSON.stringify({
      runtimeOwnerId,
      webContentsId: event.sender.id,
    }));
    event.sender.once('destroyed', () => this.clearRuntimeOwnerIfMatches(event.sender.id));
    return { ok: true, runtimeOwnerId };
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
    this.clearRuntimeOwnerIfMatches(event.sender.id);
    return { ok: true };
  }

  hasUsableRuntimeOwner() {
    return !!this.readRuntimeOwnerWebContents();
  }

  dispatchCommand(method, args) {
    const runtimeOwnerWebContents = this.readRuntimeOwnerWebContents();
    if (!runtimeOwnerWebContents) {
      throw new Error('[AilyChat][RuntimeHost] No registered host runtime owner.');
    }

    const requestId = this.nextCommandId(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(`[AilyChat][RuntimeHost] Runtime host command timed out: ${method}`));
      }, this.commandTimeoutMs);

      this.pendingCommands.set(requestId, { resolve, reject, timer, method, args });
      runtimeOwnerWebContents.send(this.runtimeOwnerCommandChannel, { requestId, method, args });
    });
  }

  handleRuntimeOwnerResponse(event, payload = {}) {
    this.assertRegisteredRuntimeOwnerSender(event);
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
    if (!this.runtimeOwner || !event || !event.sender || this.runtimeOwner.webContentsId !== event.sender.id) {
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

  clearRuntimeOwnerIfMatches(webContentsId) {
    if (!this.runtimeOwner || this.runtimeOwner.webContentsId !== webContentsId) {
      return;
    }
    this.runtimeOwner = null;
    const error = new Error('[AilyChat][RuntimeHost] Registered runtime owner was destroyed.');
    error.code = 'runtime_owner_lost';
    error.retryable = true;
    console.warn('[AilyChat][RuntimeOwnerLost]', JSON.stringify({ webContentsId }));
    this.clearPendingCommands(error);
    this.onRuntimeOwnerLost(error);
  }

  getSenderWindow(event) {
    return event && event.sender ? this.BrowserWindow.fromWebContents(event.sender) : null;
  }

  assertHostRuntimeOwner(event) {
    const senderWindow = this.getSenderWindow(event);
    if (!this.runtimeOwnerWindowRef || !senderWindow || senderWindow !== this.runtimeOwnerWindowRef) {
      throw new Error('[AilyChat][RuntimeHost] Runtime owner must be registered by the designated execution host window.');
    }
  }

  readRuntimeOwnerWebContents() {
    if (!this.runtimeOwner || !isUsableWebContents(this.runtimeOwner.webContents)) {
      if (this.runtimeOwner) {
        this.clearRuntimeOwnerIfMatches(this.runtimeOwner.webContentsId);
      }
      return null;
    }
    return this.runtimeOwner.webContents;
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


