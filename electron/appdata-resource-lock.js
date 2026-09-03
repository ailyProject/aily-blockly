// 管理 AppData 资源的跨进程读写锁，避免多实例并发冲突。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain, app } = require('electron');

const LOCK_DIR = '.lock';
const LOCK_ROOT = 'appdata-resource-lock';
const WRITER_FILE = 'writer.lock';
const READERS_DIR = 'readers';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_INTERVAL_MS = 500;

const heldLocks = new Map();
let handlersRegistered = false;

function getAppDataPath() {
  return process.env.AILY_APPDATA_PATH || app.getPath('userData');
}

function getLockRootPath() {
  return path.join(getAppDataPath(), LOCK_DIR, LOCK_ROOT);
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
  if (!holder || isLockStaleAfterReboot(holder) || !isPidAlive(Number(holder.pid))) {
    removeStaleLock(lockPath, holder, !holder ? 'unreadable' : isLockStaleAfterReboot(holder) ? 'after-reboot' : 'dead-pid');
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

  if (lock.ownerWebContents && lock.onOwnerDestroyed && !lock.ownerWebContents.isDestroyed()) {
    lock.ownerWebContents.removeListener('destroyed', lock.onOwnerDestroyed);
  }

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
    let ownerDestroyed = ownerWebContents.isDestroyed();
    const markOwnerDestroyed = () => {
      ownerDestroyed = true;
    };

    if (!ownerDestroyed) {
      ownerWebContents.once('destroyed', markOwnerDestroyed);
    }

    const result = await acquireAppDataResourceLock(
      data.label || 'unknown',
      data.mode || 'write',
      data.timeoutMs || DEFAULT_TIMEOUT_MS,
      {
        ownerWebContentsId: ownerWebContents.id,
        isCancelled: () => ownerDestroyed || ownerWebContents.isDestroyed()
      }
    );

    if (!ownerWebContents.isDestroyed()) {
      ownerWebContents.removeListener('destroyed', markOwnerDestroyed);
    }

    if (!result.ok) {
      return result;
    }

    if (ownerDestroyed || ownerWebContents.isDestroyed()) {
      releaseAppDataResourceLock(result.token);
      return { ok: false, error: 'APPDATA_RESOURCE_LOCK_OWNER_DESTROYED', mode: result.mode };
    }

    const lock = heldLocks.get(result.token);
    if (lock) {
      const releaseOnOwnerDestroyed = () => {
        console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_OWNER_DESTROYED]', {
          token: result.token,
          label: lock.label,
          mode: lock.mode,
          ownerWebContentsId: ownerWebContents.id
        });
        releaseAppDataResourceLock(result.token);
      };
      lock.ownerWebContents = ownerWebContents;
      lock.onOwnerDestroyed = releaseOnOwnerDestroyed;
      ownerWebContents.once('destroyed', releaseOnOwnerDestroyed);
    }

    return result;
  });

  ipcMain.handle('appdata-resource-lock-release', (_event, data = {}) => {
    return releaseAppDataResourceLock(data.token);
  });
}

module.exports = {
  registerAppDataResourceLockHandlers,
  releaseAllAppDataResourceLocks,
};
