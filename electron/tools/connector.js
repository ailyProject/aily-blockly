'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ipcMain, webContents } = require('electron');

const {
  createManagedToolLifecycle,
  getChildNodeExecutable,
  probeManagedCli,
  resolveLocalPackage,
  resolveManagedPackage,
} = require('./managed-npm-cli');
const {
  assertSessionResult,
  normalizeConnectParams,
  normalizeDisconnectParams,
  normalizeSessionRequest,
} = require('./connector-ipc-policy');
const {
  forgetKnownSshHost,
  prepareConnectorRequest,
  shouldIgnoreSshHostKey,
} = require('./ssh-host-key-policy');

const TOOL_KEY = 'aily-connector';
const PACKAGE_NAME = '@aily-project/aily-connector';
const PROTOCOL_VERSION = 1;
const READY_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_REQUEST_TIMEOUT_MS = 120_000;
const SESSION_REQUEST_TIMEOUT_MS = (4 * 60 * 60 * 1_000) + 30_000;
const REQUIRED_OPERATIONS = ['project.sync', 'run.file', 'run.stop'];

let childPath = '';
let sshConnectQueue = Promise.resolve();
let handlersRegistered = false;
let daemon = null;

const sessionOwners = new Map();
const ownerSessions = new Map();
const watchedOwners = new Map();
const pendingOwners = new Set();

class ConnectorDaemonClient extends EventEmitter {
  constructor(toolState) {
    super();
    this.toolState = toolState;
    this.child = null;
    this.pending = new Map();
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.stopping = false;
  }

  async start() {
    if (this.child?.connected && this.readyPromise) return this.readyPromise;
    this.stopping = false;
    const child = fork(this.toolState.entryPath, ['daemon', '--ipc'], {
      execPath: this.toolState.nodeExecutable || getChildNodeExecutable(childPath),
      env: {
        ...process.env,
        AILY_CONNECTOR_DATA_PATH: process.env.AILY_CONNECTOR_DATA_PATH,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child = child;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const readyTimer = setTimeout(() => {
      this.fail(new Error('aily-connector daemon readiness timed out'));
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();
    this.readyPromise.finally(() => clearTimeout(readyTimer)).catch(() => undefined);

    child.on('message', message => this.handleMessage(message));
    child.stdout?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) console.warn('[aily-connector][unexpected-stdout]', text.slice(0, 1_000));
    });
    child.stderr?.on('data', chunk => {
      const text = String(chunk || '').trim();
      if (text) {
        const message = text.slice(0, 2_000);
        console.warn('[aily-connector]', message);
        this.emit('stderr', message);
      }
    });
    child.once('error', error => this.fail(error));
    child.once('exit', (code, signal) => {
      this.fail(new Error(`aily-connector daemon exited (${code ?? 'null'}/${signal || 'none'})`));
    });
    return this.readyPromise;
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object' || message.protocolVersion !== PROTOCOL_VERSION) {
      this.fail(new Error('aily-connector daemon sent an incompatible protocol message'));
      return;
    }
    if (message.method === 'connector.ready') {
      if (message.params?.capabilities?.protocolVersion !== PROTOCOL_VERSION) {
        this.fail(new Error('aily-connector daemon protocol is incompatible'));
        return;
      }
      this.readyResolve?.(message.params);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.method === 'session.event') {
      this.emit('sessionEvent', decodeBinary(message.params));
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error) pending.reject(publicError(message.error));
    else pending.resolve(decodeBinary(message.result));
  }

  async request(method, params = {}, timeoutMs) {
    await this.start();
    if (!this.child?.connected) throw new Error('aily-connector daemon is not connected');
    const id = randomUUID();
    const timeout = timeoutMs
      || (method === 'session.connect'
        ? CONNECT_REQUEST_TIMEOUT_MS
        : (method === 'session.request' ? SESSION_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`aily-connector request timed out: ${method}`), {
          code: 'OPERATION_TIMEOUT',
        }));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({
        protocolVersion: PROTOCOL_VERSION,
        id,
        method,
        params: encodeBinary(params),
      }, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    try {
      if (child.connected) {
        await this.request('connector.shutdown', {}, 3_000).catch(() => undefined);
      }
    } finally {
      this.fail(new Error('aily-connector daemon stopped'), true);
    }
  }

  fail(error, expected = false) {
    const child = this.child;
    if (!child && !this.readyPromise && this.pending.size === 0) return;
    this.child = null;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    try {
      if (child?.connected) child.disconnect();
    } catch {
      // The IPC channel may already be closing.
    }
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      // Process cleanup is best effort after a daemon failure.
    }
    if (!expected && !this.stopping) this.emit('crash', error);
  }
}

function resolveConnectorTool({ prefix, childPath: probeChildPath = childPath } = {}) {
  const configuredProject = process.env.AILY_CONNECTOR_PROJECT;
  const local = configuredProject ? resolveLocalPackage({
    packageName: PACKAGE_NAME,
    binKey: TOOL_KEY,
    projectPath: configuredProject,
  }) : null;
  const resolved = local || resolveManagedPackage({
    packageName: PACKAGE_NAME,
    binKey: TOOL_KEY,
    prefix,
  });
  if (!resolved) return { ok: false, error: 'aily-connector package entry was not found' };
  const result = probeManagedCli({
    resolved,
    childPath: probeChildPath,
    prefix,
    expectedProtocolVersion: PROTOCOL_VERSION,
  });
  if (!result.ok) return result;
  const transports = result.capabilities?.deviceTransports;
  const operations = result.capabilities?.operations;
  if (
    !Array.isArray(transports)
    || !transports.includes('ssh')
    || !transports.includes('serial')
    || !Array.isArray(operations)
    || REQUIRED_OPERATIONS.some(operation => !operations.includes(operation))
  ) {
    return { ok: false, error: 'aily-connector does not provide the required Linux board capabilities' };
  }
  return result;
}

function assertConnectorInstallAllowed() {
  if (sessionOwners.size > 0 || pendingOwners.size > 0) {
    throw new Error('Disconnect all Linux boards before updating aily-connector');
  }
  if (process.env.AILY_CONNECTOR_PROJECT) {
    throw new Error('The local aily-connector override must be updated from its source project');
  }
}

const lifecycle = createManagedToolLifecycle({
  toolKey: TOOL_KEY,
  packageName: PACKAGE_NAME,
  probe: resolveConnectorTool,
  missingChildPathError: 'AILY_CHILD_PATH is not configured',
  missingReadyError: 'aily-connector package entry was not found',
  installIncompleteError: 'aily-connector installation is incomplete',
  installError: `${PACKAGE_NAME} npm installation failed`,
  preservePreviousProbeError: false,
  reinitializeAfterSettle: true,
  statusFields: state => ({ path: state.entryPath || '' }),
}, {
  // Reject immediately so an existing board session never waits behind an
  // unrelated npm install. Recheck after acquiring the prefix lock to close
  // the queueing race, then stop the daemon immediately before installation.
  preflightMutation: assertConnectorInstallAllowed,
  assertMutationAllowed: assertConnectorInstallAllowed,
  beforeMutation: shutdown,
  canReuseReadyState: state => !!state.entryPath && fs.existsSync(state.entryPath),
  isStatusStateValid: state => !!state.entryPath && fs.existsSync(state.entryPath),
});

function initialize(nextChildPath, prerequisite = Promise.resolve(), options = {}) {
  childPath = nextChildPath || childPath;
  return lifecycle.initialize(childPath, prerequisite, {
    installLatest: options.installManaged === true && !process.env.AILY_CONNECTOR_PROJECT,
  });
}

async function waitForReady() {
  const result = await lifecycle.waitForReady();
  if (!result.ok) throw new Error(result.error || 'aily-connector is unavailable');
  return result;
}

async function ensureDaemon() {
  const state = await waitForReady();
  if (!daemon) {
    daemon = new ConnectorDaemonClient(state);
    daemon.on('sessionEvent', routeSessionEvent);
    daemon.on('stderr', message => {
      notifyAllOwners({
        type: 'connector.stderr',
        error: { code: 'DAEMON_STDERR', message },
      });
    });
    daemon.on('crash', error => {
      notifyDisconnectedOwners(error);
      notifyAllOwners({
        type: 'connector.crashed',
        error: { code: 'DAEMON_EXITED', message: error.message },
      });
      clearOwners();
      daemon = null;
    });
  }
  await daemon.start();
  return daemon;
}

async function installCompatibleVersion(targetVersion = 'latest', options = {}) {
  const { installResult, readyResult } = await lifecycle.performInstallMutation({
    targetVersion,
    force: options.force === true,
    reason: options.reason || 'manual',
  });
  if (!installResult.ok || !readyResult.ok) {
    throw new Error(installResult.error || readyResult.error || 'aily-connector installation is incomplete');
  }
  return readyResult;
}

function getStatus() {
  return lifecycle.getStatus();
}

function checkForUpdate() {
  return lifecycle.checkForUpdate();
}

function registerHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle('aily-connector-status', async () => getStatus());
  ipcMain.handle('aily-connector-check-update', async () => checkForUpdate());
  ipcMain.handle('aily-connector-update', async () => {
    const result = await installCompatibleVersion('latest', { force: true });
    return { version: result.version, status: getStatus() };
  });
  ipcMain.handle('aily-connector-wait-ready', async () => {
    const state = await waitForReady();
    return { version: state.version, protocolVersion: state.capabilities.protocolVersion };
  });
  ipcMain.handle('aily-connector-connect', async (event, params) => {
    return connectorIpcResult(async () => {
      const request = normalizeConnectParams(params);
      const ownerGeneration = watchOwner(event.sender);
      pendingOwners.add(event.sender.id);
      try {
        const client = await ensureDaemon();
        const result = assertSessionResult(
          await requestSessionConnect(client, request),
          request.transport,
        );
        if (!isCurrentOwner(event.sender, ownerGeneration)) {
          await client.request(
            'session.disconnect',
            { sessionId: result.sessionId },
            10_000,
          ).catch(() => undefined);
          const error = new Error('Connector owner was closed while the board was connecting');
          error.code = 'SESSION_CLOSED';
          throw error;
        }
        bindSession(event.sender.id, result.sessionId);
        return result;
      } finally {
        pendingOwners.delete(event.sender.id);
      }
    });
  });
  ipcMain.handle('aily-connector-request', async (event, params = {}) => {
    return connectorIpcResult(async () => {
      const request = normalizeSessionRequest(params);
      requireSessionOwner(event.sender.id, request.sessionId);
      const client = await ensureDaemon();
      const requestedTimeout = Number.isInteger(request.timeoutMs)
        ? Math.min(SESSION_REQUEST_TIMEOUT_MS, request.timeoutMs + 10_000)
        : SESSION_REQUEST_TIMEOUT_MS;
      return client.request('session.request', request, requestedTimeout);
    });
  });
  ipcMain.handle('aily-connector-disconnect', async (event, params = {}) => {
    return connectorIpcResult(async () => {
      const request = normalizeDisconnectParams(params);
      requireSessionOwner(event.sender.id, request.sessionId);
      const client = await ensureDaemon();
      const result = await client.request('session.disconnect', request);
      unbindSession(request.sessionId);
      return result;
    });
  });
}

function requestSessionConnect(client, request) {
  if (request.transport !== 'ssh') {
    return client.request('session.connect', request);
  }

  const task = sshConnectQueue.then(async () => {
    if (!shouldIgnoreSshHostKey(request)) {
      return client.request('session.connect', request);
    }

    await forgetKnownSshHost(request.endpoint);
    try {
      return await client.request('session.connect', prepareConnectorRequest(request));
    } finally {
      await forgetKnownSshHost(request.endpoint).catch(error => {
        console.warn('[aily-connector] Failed to clear ignored SSH host key:', error);
      });
    }
  });
  sshConnectQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function connectorIpcResult(action) {
  try {
    return { ailyConnectorIpc: 1, ok: true, result: await action() };
  } catch (error) {
    return {
      ailyConnectorIpc: 1,
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'CONNECTOR_ERROR',
        message: error instanceof Error ? error.message : String(error || 'Connector request failed'),
        ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
      },
    };
  }
}

function watchOwner(sender) {
  const existing = watchedOwners.get(sender.id);
  if (existing) return existing.generation;
  const record = { generation: 1 };
  const invalidate = () => {
    record.generation += 1;
    void releaseOwner(sender.id);
  };
  const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) invalidate();
  };
  const onRenderGone = () => invalidate();
  const onDestroyed = () => {
    watchedOwners.delete(sender.id);
    sender.off?.('did-start-navigation', onNavigation);
    sender.off?.('render-process-gone', onRenderGone);
    invalidate();
  };
  sender.on?.('did-start-navigation', onNavigation);
  sender.on?.('render-process-gone', onRenderGone);
  sender.once?.('destroyed', onDestroyed);
  watchedOwners.set(sender.id, record);
  return record.generation;
}

function isCurrentOwner(sender, generation) {
  return !sender.isDestroyed?.()
    && watchedOwners.get(sender.id)?.generation === generation;
}

function bindSession(ownerId, sessionId) {
  sessionOwners.set(sessionId, ownerId);
  let sessions = ownerSessions.get(ownerId);
  if (!sessions) ownerSessions.set(ownerId, sessions = new Set());
  sessions.add(sessionId);
}

function unbindSession(sessionId) {
  const ownerId = sessionOwners.get(sessionId);
  sessionOwners.delete(sessionId);
  if (ownerId === undefined) return;
  const sessions = ownerSessions.get(ownerId);
  sessions?.delete(sessionId);
  if (sessions?.size === 0) ownerSessions.delete(ownerId);
}

function requireSessionOwner(ownerId, sessionId) {
  if (!sessionId || sessionOwners.get(sessionId) !== ownerId) {
    const error = new Error('Connector session is closed or owned by another renderer');
    error.code = 'SESSION_CLOSED';
    throw error;
  }
}

async function releaseOwner(ownerId) {
  const sessions = Array.from(ownerSessions.get(ownerId) || []);
  ownerSessions.delete(ownerId);
  if (!daemon) {
    for (const sessionId of sessions) sessionOwners.delete(sessionId);
    return;
  }
  await Promise.allSettled(sessions.map(async sessionId => {
    try {
      await daemon.request('session.disconnect', { sessionId }, 10_000);
    } finally {
      sessionOwners.delete(sessionId);
    }
  }));
}

function routeSessionEvent(event) {
  const ownerId = sessionOwners.get(event?.sessionId);
  if (ownerId === undefined) return;
  const owner = webContents.fromId(ownerId);
  if (!owner || owner.isDestroyed()) {
    void releaseOwner(ownerId);
    return;
  }
  owner.send('aily-connector-event', event);
  if (event?.event?.type === 'device.disconnected') unbindSession(event.sessionId);
}

function notifyDisconnectedOwners(error) {
  for (const [sessionId, ownerId] of sessionOwners.entries()) {
    const owner = webContents.fromId(ownerId);
    if (!owner || owner.isDestroyed()) continue;
    owner.send('aily-connector-event', {
      sessionId,
      event: {
        type: 'device.disconnected',
        reason: 'DAEMON_EXITED',
        message: error?.message || 'Aily Connector stopped unexpectedly',
      },
    });
  }
}

function notifyAllOwners(payload) {
  const ownerIds = new Set([...ownerSessions.keys(), ...pendingOwners]);
  for (const ownerId of ownerIds) {
    const owner = webContents.fromId(ownerId);
    if (owner && !owner.isDestroyed()) owner.send('aily-connector-event', payload);
  }
}

function clearOwners() {
  sessionOwners.clear();
  ownerSessions.clear();
  pendingOwners.clear();
}

async function shutdown() {
  const active = daemon;
  daemon = null;
  if (active) {
    active.removeAllListeners('sessionEvent');
    active.removeAllListeners('stderr');
    active.removeAllListeners('crash');
    await active.stop().catch(() => undefined);
  }
  clearOwners();
}

function decodeBinary(value) {
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$binary === 'string') {
      return Buffer.from(value.$binary, 'base64');
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeBinary(item)]));
  }
  return value;
}

function encodeBinary(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeBinary);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeBinary(item)]));
  }
  return value;
}

function publicError(value) {
  const error = new Error(typeof value?.message === 'string' ? value.message : 'Connector request failed');
  error.code = typeof value?.code === 'string' ? value.code : 'CONNECTOR_ERROR';
  if (value?.details && typeof value.details === 'object') error.details = value.details;
  return error;
}

module.exports = {
  ConnectorDaemonClient,
  initialize,
  registerHandlers,
  resolveConnectorTool,
  shutdown,
  waitForReady,
};
