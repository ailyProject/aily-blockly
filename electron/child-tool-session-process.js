'use strict';

const DEFAULT_GRACEFUL_SHUTDOWN_WAIT_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS = 3000;

async function stopChildToolSessionProcess(session, dependencies = {}) {
  if (!session) return false;

  const {
    fetchImpl = globalThis.fetch,
    getActiveProcesses = () => [],
    gracefulShutdownWaitMs = DEFAULT_GRACEFUL_SHUTDOWN_WAIT_MS,
    isPidAlive = () => false,
    killProcessTree = async () => undefined,
    killStream = () => false,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    shutdownRequestTimeoutMs = DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS,
  } = dependencies;
  const streamId = String(session.streamId || '').trim();
  const hostPid = Number.isInteger(session?.hostInfo?.pid)
    ? session.hostInfo.pid
    : null;

  const shutdownAccepted = await tryShutdownChildToolByUrl(
    session,
    fetchImpl,
    shutdownRequestTimeoutMs,
  );
  if (shutdownAccepted) {
    const stoppedGracefully = await waitForChildToolProcessGone({
      getActiveProcesses,
      gracefulShutdownWaitMs,
      hostPid,
      isPidAlive,
      pollIntervalMs,
      streamId,
    });
    if (stoppedGracefully) return true;
  }

  if (streamId && isStreamActive(streamId, getActiveProcesses)) {
    await killStream(streamId);
  }
  if (hostPid && isPidAlive(hostPid)) {
    await killProcessTree(hostPid, `child-tool:${streamId || 'detached'}`);
  }
  return !hostPid || !isPidAlive(hostPid);
}

async function tryShutdownChildToolByUrl(
  session,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_SHUTDOWN_REQUEST_TIMEOUT_MS,
) {
  const shutdownUrl = getSafeShutdownUrl(session);
  if (!shutdownUrl || typeof fetchImpl !== 'function') return false;

  try {
    const response = await withTimeout(
      fetchImpl(shutdownUrl, {
        method: 'POST',
        ...(typeof globalThis.AbortSignal?.timeout === 'function'
          ? { signal: globalThis.AbortSignal.timeout(requestTimeoutMs) }
          : {}),
      }),
      requestTimeoutMs,
    );
    return !!response?.ok;
  } catch (_) {
    return false;
  }
}

function getSafeShutdownUrl(session) {
  const rawBaseUrl = typeof session?.hostInfo?.url === 'string'
    ? session.hostInfo.url.trim()
    : '';
  const rawShutdownUrl = typeof session?.hostInfo?.shutdownUrl === 'string'
    ? session.hostInfo.shutdownUrl.trim()
    : '';
  if (!rawBaseUrl || !rawShutdownUrl) return '';

  try {
    const baseUrl = new URL(rawBaseUrl);
    const shutdownUrl = new URL(rawShutdownUrl);
    if (
      baseUrl.protocol !== 'http:'
      || shutdownUrl.protocol !== 'http:'
      || shutdownUrl.origin !== baseUrl.origin
      || !isLoopbackHostname(shutdownUrl.hostname)
    ) {
      return '';
    }
    return shutdownUrl.toString();
  } catch (_) {
    return '';
  }
}

async function waitForChildToolProcessGone(options) {
  const deadline = Date.now() + Math.max(0, options.gracefulShutdownWaitMs);
  while (Date.now() <= deadline) {
    const streamAlive = options.streamId
      ? isStreamActive(options.streamId, options.getActiveProcesses)
      : false;
    const hostAlive = options.hostPid
      ? options.isPidAlive(options.hostPid)
      : false;
    if (!streamAlive && !hostAlive) return true;
    await delay(options.pollIntervalMs);
  }
  return false;
}

function isStreamActive(streamId, getActiveProcesses) {
  return getActiveProcesses().some(
    (processInfo) => processInfo.streamId === streamId,
  );
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '[::1]'
    || normalized === '::1';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function withTimeout(promise, milliseconds) {
  let timeout;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Child tool shutdown request timed out.')),
        Math.max(1, milliseconds),
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

module.exports = {
  getSafeShutdownUrl,
  stopChildToolSessionProcess,
  tryShutdownChildToolByUrl,
};
