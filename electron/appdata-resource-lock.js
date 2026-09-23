// 管理 AppData 资源的跨进程读写锁，避免多实例并发冲突。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const lockScope = new AsyncLocalStorage();
const { ipcMain, app } = require('electron');
const LOCK_DIR = '.lock';
const LOCK_ROOT = 'appdata-resource-lock';
const WRITER_FILE = 'writer.lock';
const READERS_DIR = 'readers';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_INTERVAL_MS = 500;
const heldLocks = new Map();
const pendingRequests = new Map();
let handlersRegistered = false;

function getAppDataPath() {
  return process.env.AILY_APPDATA_PATH || app.getPath('userData');
}

function getLockRootPath() {
  return path.join(getAppDataPath(), LOCK_DIR, lockScope.getStore() || LOCK_ROOT);
}

function getWriterLockPath() {
  return path.join(getLockRootPath(), WRITER_FILE);
}

function getReadersDirPath() {
  return path.join(getLockRootPath(), READERS_DIR);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function isLockStaleAfterReboot(lockData) {
  if (!lockData || !lockData.startedAt) {
    return false;
  }

  const bootTimeMs = Date.now() - os.uptime() * 1000;

  return lockData.startedAt < bootTimeMs - 5000;
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(lockPath, payload) {
  const dir = path.dirname(lockPath);

  fs.mkdirSync(dir, { recursive: true });

  try {
    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
  }
}

function removeStaleLock(lockPath, holder, reason) {
  try {
    fs.unlinkSync(lockPath);

    console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_STALE_REMOVED]', {
      reason,
      lockPath,
      holder
    });

    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }

    console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_STALE_REMOVE_FAILED]', {
      reason,
      lockPath,
      error: error?.message || String(error),
      holder
    });

    return false;
  }
}

function isLockAlive(lockPath) {
  const holder = readLock(lockPath);
  // A creator may have reserved the file but not finished writing its payload.
  // Unreadable is busy, never permission to unlink another process's lock.
  if (!holder) return { unverified: true };
  if (isLockStaleAfterReboot(holder) || (!holder.commandBorrowed && !isPidAlive(Number(holder.pid)))) {
    removeStaleLock(lockPath, holder, isLockStaleAfterReboot(holder) ? 'after-reboot' : 'dead-pid');
    return null;
  }

  return holder;
}

function getActiveWriter() {
  const writerPath = getWriterLockPath();
  const writer = fs.existsSync(writerPath) ? isLockAlive(writerPath) : null;

  return writer ? { lockPath: writerPath, holder: writer } : null;
}

function getActiveReaders() {
  const readersDir = getReadersDirPath();

  fs.mkdirSync(readersDir, { recursive: true });

  let entries = [];

  try {
    entries = fs.readdirSync(readersDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fs.mkdirSync(readersDir, { recursive: true });

      return [];
    }

    throw error;
  }

  const activeReaders = [];

  for (const entry of entries) {
    if (!entry.endsWith('.lock')) {
      continue;
    }

    const lockPath = path.join(readersDir, entry);
    const holder = isLockAlive(lockPath);

    if (holder) {
      activeReaders.push({ lockPath, holder });
    }
  }

  return activeReaders;
}

function createPayload(token, label, mode, ownerWebContentsId) {
  return {
    token,
    pid: process.pid,
    ownerWebContentsId,
    execPath: process.execPath,
    appVersion: app.getVersion(),
    label,
    mode,
    startedAt: Date.now()
  };
}

function logWait(event, label, mode, startedAt, extra) {
  console.info(`[PROC_TRACE][APPDATA_FILE_LOCK_${event}]`, {
    label,
    mode,
    waitMs: Date.now() - startedAt,
    ...extra
  });
}

async function acquireReadLock(label, token, startedAt, timeoutMs, options = {}) {
  let lastHolderLogAt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (options.isCancelled?.()) {
      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_OWNER_DESTROYED', mode: 'read' };
    }

    const writer = getActiveWriter();

    if (writer) {
      const now = Date.now();

      if (now - lastHolderLogAt > 5000) {
        lastHolderLogAt = now;

        logWait('WAIT', label, 'read', startedAt, {
          waitingFor: 'writer',
          holder: writer.holder
        });
      }

      await sleep(RETRY_INTERVAL_MS);

      continue;
    }

    const readerLockPath = path.join(getReadersDirPath(), `${token}.lock`);

    try {
      writeLock(readerLockPath, createPayload(token, label, 'read', options.ownerWebContentsId));
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      removeStaleLock(readerLockPath, readLock(readerLockPath), 'duplicate-token');

      continue;
    }

    if (options.isCancelled?.()) {
      removeStaleLock(readerLockPath, readLock(readerLockPath), 'owner-destroyed');

      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_OWNER_DESTROYED', mode: 'read' };
    }

    if (!getActiveWriter()) {
      heldLocks.set(token, {
        mode: 'read',
        lockPath: readerLockPath,
        label,
        ownerWebContentsId: options.ownerWebContentsId
      });

      return { ok: true, token, mode: 'read', lockPath: readerLockPath, waitMs: Date.now() - startedAt };
    }

    removeStaleLock(readerLockPath, readLock(readerLockPath), 'writer-raced-reader');
    await sleep(RETRY_INTERVAL_MS);
  }

  return { ok: false, error: 'APPDATA_RESOURCE_LOCK_TIMEOUT', mode: 'read', writer: getActiveWriter()?.holder };
}

async function acquireWriteLock(label, token, startedAt, timeoutMs, options = {}) {
  const writerLockPath = getWriterLockPath();
  let hasWriterLock = false;
  let lastHolderLogAt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (options.isCancelled?.()) {
      if (hasWriterLock) {
        removeStaleLock(writerLockPath, readLock(writerLockPath), 'owner-destroyed');
      }

      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_OWNER_DESTROYED', mode: 'write' };
    }

    if (!hasWriterLock) {
      try {
        writeLock(writerLockPath, createPayload(token, label, 'write', options.ownerWebContentsId));

        hasWriterLock = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }

        const writer = getActiveWriter();
        const now = Date.now();

        if (writer && now - lastHolderLogAt > 5000) {
          lastHolderLogAt = now;

          logWait('WAIT', label, 'write', startedAt, {
            waitingFor: 'writer',
            holder: writer.holder
          });
        }

        await sleep(RETRY_INTERVAL_MS);

        continue;
      }
    }

    const readers = getActiveReaders().filter((reader) => reader.holder.token !== token);

    if (readers.length === 0) {
      heldLocks.set(token, {
        mode: 'write',
        lockPath: writerLockPath,
        label,
        ownerWebContentsId: options.ownerWebContentsId
      });

      return { ok: true, token, mode: 'write', lockPath: writerLockPath, waitMs: Date.now() - startedAt };
    }

    const now = Date.now();

    if (now - lastHolderLogAt > 5000) {
      lastHolderLogAt = now;

      logWait('WAIT', label, 'write', startedAt, {
        waitingFor: 'readers',
        readers: readers.map((reader) => reader.holder)
      });
    }

    await sleep(RETRY_INTERVAL_MS);
  }

  if (hasWriterLock) {
    removeStaleLock(writerLockPath, readLock(writerLockPath), 'writer-timeout');
  }

  return { ok: false, error: 'APPDATA_RESOURCE_LOCK_TIMEOUT', mode: 'write', readers: getActiveReaders().map((reader) => reader.holder) };
}

async function acquireAppDataResourceLock(label, mode = 'write', timeoutMs = DEFAULT_TIMEOUT_MS, options = {}) {
  const startedAt = Date.now();
  const normalizedMode = mode === 'read' ? 'read' : 'write';
  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    const result = normalizedMode === 'read'
      ? await acquireReadLock(label, token, startedAt, timeoutMs, options)
      : await acquireWriteLock(label, token, startedAt, timeoutMs, options);

    if (result.ok) {
      console.info('[PROC_TRACE][APPDATA_FILE_LOCK_ACQUIRED]', {
        label,
        mode: normalizedMode,
        token,
        lockPath: result.lockPath,
        waitMs: result.waitMs
      });
    } else {
      console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_TIMEOUT]', {
        label,
        mode: normalizedMode,
        timeoutMs,
        result
      });
    }

    return result;
  } catch (error) {
    console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_ACQUIRE_ERROR]', {
      label,
      mode: normalizedMode,
      error: error?.message || String(error)
    });

    throw error;
  }
}

function releaseAppDataResourceLock(token) {
  const lock = heldLocks.get(token);

  if (!lock) {
    return { ok: true, alreadyReleased: true };
  }

  // A renderer leaving its scope (or being destroyed) does not stop its build.
  lock.releaseRequested = true;
  if (lock.borrowers > 0 || lock.ownerWorkPending) return { ok: true, retainedByCommand: true };

  lock.removeOwnerListeners?.();

  const holder = readLock(lock.lockPath);

  if (holder?.pid === process.pid && holder?.token === token) {
    try {
      fs.unlinkSync(lock.lockPath);

      console.info('[PROC_TRACE][APPDATA_FILE_LOCK_RELEASED]', {
        token,
        mode: lock.mode,
        label: holder.label,
        lockPath: lock.lockPath,
        ownerWebContentsId: lock.ownerWebContentsId
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_RELEASE_ERROR]', {
          token,
          mode: lock.mode,
          error: error?.message || String(error)
        });

        return { ok: false, error: error?.message || String(error) };
      }
    }
  }

  heldLocks.delete(token);

  return { ok: true };
}

/** Only main may lend a live lease to a command from its owning renderer.
 * Reuse the granted lock; reacquiring here can deadlock behind our own lease.
 */
function retainAppDataResourceLock(token, ownerWebContentsId, mode) {
  const lock = heldLocks.get(token);
  const holder = lock && readLock(lock.lockPath);
  if (!['read', 'write'].includes(mode) || !lock || lock.mode !== mode || lock.releaseRequested
      || !Number.isSafeInteger(ownerWebContentsId) || lock.ownerWebContentsId !== ownerWebContentsId
      || holder?.token !== token || holder?.pid !== process.pid) {
    throw new Error('APPDATA_RESOURCE_LOCK_NOT_OWNED');
  }
  // A dead main PID cannot certify that command descendants also stopped.
  // After a host crash, keep handed-off leases until explicit recovery/reboot.
  if (!holder.commandBorrowed) fs.writeFileSync(lock.lockPath, JSON.stringify({ ...holder, commandBorrowed: true }));
  lock.borrowers = (lock.borrowers || 0) + 1;
  let released = false;
  return { assertOwnerActive() {
    if (lock.releaseRequested || released) throw new Error('APPDATA_RESOURCE_LOCK_CANCELLED');
  }, release() {
    if (released) return;
    released = true;
    lock.borrowers--;
    if (lock.releaseRequested && lock.borrowers === 0) releaseAppDataResourceLock(token);
  } };
}

function releaseAllAppDataResourceLocks() {
  for (const token of Array.from(heldLocks.keys())) {
    releaseAppDataResourceLock(token);
  }
}

function registerAppDataResourceLockHandlers() {
  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;

  ipcMain.handle('appdata-resource-lock-acquire', async (event, data = {}) => {
    const ownerWebContents = event.sender;
    const requestId = data.requestId;
    const key = requestId === undefined ? undefined : `${ownerWebContents.id}:${requestId}`;
    if (key && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId) || pendingRequests.has(key))) {
      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_INVALID_REQUEST' };
    }
    const request = { cancelled: false };
    if (key) pendingRequests.set(key, request);
    let ownerDestroyed = ownerWebContents.isDestroyed();
    let token;
    let ownerWorkFinished;

    const markOwnerDestroyed = () => {
      if (ownerDestroyed) return;

      ownerDestroyed = true;
      removeOwnerListeners();
      const lock = heldLocks.get(token);
      if (lock) {
        // Revoke lending immediately, even while the old document's work drains.
        lock.releaseRequested = true;
        lock.ownerWorkPending = true;
      }

      console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_OWNER_INVALIDATED]', {
        token,
        label: data.label || 'unknown',
        ownerWebContentsId: ownerWebContents.id
      });

      // Snapshot only the old document's npm work. Never release a write lock
      // while its install process is still writing shared dependencies.
      ownerWorkFinished = Promise.all([
        // Resolve lazily: cmd/npm themselves depend on the lease authority.
        require('./npm').waitForOwnerNpmRequests(ownerWebContents),
        require('./cmd').waitForOwnerCmdNpmProcesses(ownerWebContents)
      ]);

      if (token) {
        const orphanToken = token;

        void ownerWorkFinished.then(() => {
          lock.ownerWorkPending = false;
          releaseAppDataResourceLock(orphanToken);
        });
      }
    };

    const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) markOwnerDestroyed();
    };

    const removeOwnerListeners = () => {
      ownerWebContents.removeListener('did-start-navigation', onNavigation);
      ownerWebContents.removeListener('render-process-gone', markOwnerDestroyed);
      ownerWebContents.removeListener('destroyed', markOwnerDestroyed);
    };

    ownerWebContents.on('did-start-navigation', onNavigation);
    ownerWebContents.on('render-process-gone', markOwnerDestroyed);
    ownerWebContents.on('destroyed', markOwnerDestroyed);

    let result;

    try {
      result = await acquireAppDataResourceLock(
        data.label || 'unknown',
        data.mode || 'write',
        data.timeoutMs || DEFAULT_TIMEOUT_MS,
        {
          ownerWebContentsId: ownerWebContents.id,
          isCancelled: () => request.cancelled || ownerDestroyed || ownerWebContents.isDestroyed()
        }
      );
    } catch (error) {
      removeOwnerListeners();

      throw error;
    } finally {
      if (key) pendingRequests.delete(key);
    }

    if (request.cancelled) {
      removeOwnerListeners();
      if (result.ok) releaseAppDataResourceLock(result.token);
      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_CANCELLED' };
    }
    if (!result.ok) {
      removeOwnerListeners();

      return result;
    }

    if (ownerDestroyed || ownerWebContents.isDestroyed()) {
      await ownerWorkFinished;

      releaseAppDataResourceLock(result.token);
      removeOwnerListeners();

      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_OWNER_DESTROYED', mode: result.mode };
    }

    token = result.token;

    const lock = heldLocks.get(result.token);

    if (lock) {
      lock.removeOwnerListeners = removeOwnerListeners;
    }

    return { ...result, commandHandoff: true, writerCommandHandoff: true };
  });

  ipcMain.handle('appdata-resource-lock-cancel', (event, data = {}) => {
    const request = pendingRequests.get(`${event.sender.id}:${data.requestId}`);
    if (request) request.cancelled = true;
    return { ok: true, cancelled: !!request };
  });

  ipcMain.handle('appdata-resource-lock-release', (event, data = {}) => {
    const lock = heldLocks.get(data.token);
    if (lock && lock.ownerWebContentsId !== event.sender.id) return { ok: false, error: 'APPDATA_RESOURCE_LOCK_NOT_OWNED' };
    return releaseAppDataResourceLock(data.token);
  });
}

async function withAppDataResourceLock(scope, operation) {
  return lockScope.run(scope, async () => {
    const lock = await acquireAppDataResourceLock(scope, 'write', 15000);

    if (!lock.ok) throw new Error(lock.error);

    try {
      return await operation();
    } finally {
      releaseAppDataResourceLock(lock.token);
    }
  });
}

/** Native consumer scope on the SAME reader/writer protocol as compile/npm.
 * A command borrows this lease; scope exit never releases a running command.
 * Not registered as IPC and never creates a second lock namespace/queue.
 */
async function withAppDataReadLease(ownerWebContentsId, { signal, timeoutMs }, operation) {
  if (!Number.isSafeInteger(ownerWebContentsId)) throw new TypeError('A native reader requires a window owner.');
  return lockScope.run(LOCK_ROOT, async () => {
    const lock = await acquireAppDataResourceLock('build-input-verification', 'read', timeoutMs, {
      ownerWebContentsId, isCancelled: () => signal.aborted,
    });
    if (!lock.ok) throw signal.reason || Object.assign(new Error(lock.error), { code: lock.error });
    try {
      signal.throwIfAborted();
      return await operation({ borrow: () => retainAppDataResourceLock(lock.token, ownerWebContentsId, 'read') });
    } finally { releaseAppDataResourceLock(lock.token); }
  });
}

module.exports = {
  withAppDataReadLease,
  retainAppDataResourceLock,
  withAppDataResourceLock,
  registerAppDataResourceLockHandlers,
  releaseAllAppDataResourceLocks,
};
