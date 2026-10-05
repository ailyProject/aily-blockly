'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const TIMEOUT_MS = 5000;
const RETRY_MS = 500;
const heldLocks = new Map();
let pendingAcquisitions = 0;
let shuttingDown = false;
let cleanupScheduled = false;

function readLock(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { return null; }
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function removeLock(filename) {
  try { fs.unlinkSync(filename); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    console.warn('[AUTH_CREDENTIALS_LOCK_REMOVE_FAILED]', error.message);
    return false;
  }
}

function recoverStaleLock(filename) {
  const holder = readLock(filename);
  // An incomplete publication is busy, never permission to remove the file.
  if (!holder) return;
  if (holder.released === true) {
    // Only its live owner may remove a released fixed-name writer marker.
    if (!isPidAlive(Number(holder.pid)) || heldLocks.get(holder.token)?.filename === filename) removeLock(filename);
    return;
  }
  const bootTime = Date.now() - os.uptime() * 1000;
  if ((holder.startedAt && holder.startedAt < bootTime - 5000) || !isPidAlive(Number(holder.pid))) removeLock(filename);
}

function publishReleased(lock, holder) {
  const temporary = `${lock.filename}.${lock.token}.tmp`;
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx');
    created = true;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ ...holder, released: true, commandBorrowed: false }));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, lock.filename);
  } finally {
    if (created) removeLock(temporary);
  }
}

function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setTimeout(() => {
    cleanupScheduled = false;
    for (const lock of heldLocks.values()) if (lock.released) releaseLock(lock);
  }, RETRY_MS);
  timer?.unref?.();
}

function releaseLock(lock) {
  if (lock.nativeWorkPending) return false;
  const holder = readLock(lock.filename);
  if ((!holder && fs.existsSync(lock.filename))
      || (holder && (holder.pid !== process.pid || holder.token !== lock.token))) {
    if (!lock.released) return false;
    heldLocks.delete(lock.token);
    return true;
  }
  if (holder) {
    if (!holder.released) {
      try { publishReleased(lock, holder); }
      catch (error) {
        console.warn('[AUTH_CREDENTIALS_LOCK_RELEASE_FAILED]', error.message);
        return false;
      }
    }
    lock.released = true;
    if (!removeLock(lock.filename)) {
      scheduleCleanup();
      return true;
    }
  }
  heldLocks.delete(lock.token);
  return true;
}

async function acquireLock() {
  const startedAt = Date.now();
  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const directory = path.join(process.env.AILY_APPDATA_PATH || app.getPath('userData'), '.lock', 'auth-credentials');
  const filename = path.join(directory, 'writer.lock');
  const payload = { token, pid: process.pid, execPath: process.execPath, appVersion: app.getVersion(),
    label: 'auth-credentials', mode: 'write', startedAt };
  pendingAcquisitions++;
  try {
    let attempted = false;
    while (!attempted || Date.now() - startedAt < TIMEOUT_MS) {
      attempted = true;
      if (shuttingDown) throw new Error('AUTH_CREDENTIALS_LOCK_SHUTDOWN');
      fs.mkdirSync(directory, { recursive: true });
      try {
        try { fs.writeFileSync(filename, JSON.stringify(payload, null, 2), { flag: 'wx' }); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(filename, JSON.stringify(payload, null, 2), { flag: 'wx' });
        }
        const lock = { token, filename, nativeWorkPending: true };
        heldLocks.set(token, lock);
        return lock;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        recoverStaleLock(filename);
      }
      const remaining = TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_MS, remaining)));
    }
    throw new Error('AUTH_CREDENTIALS_LOCK_TIMEOUT');
  } finally {
    pendingAcquisitions--;
    if (!heldLocks.has(token)) {
      const holder = readLock(filename);
      if (holder?.pid === process.pid && holder.token === token) {
        const lock = { token, filename, nativeWorkPending: false };
        heldLocks.set(token, lock);
        releaseLock(lock);
      }
    }
  }
}

async function withAuthCredentialsLock(operation) {
  const lock = await acquireLock();
  try { return await operation(); }
  finally {
    lock.nativeWorkPending = false;
    releaseLock(lock);
  }
}

function releaseAllAuthCredentialsLocks() {
  const result = { ok: true, retained: pendingAcquisitions, failed: 0 };
  for (const lock of heldLocks.values()) {
    if (lock.nativeWorkPending) result.retained++;
    else if (!releaseLock(lock)) result.failed++;
  }
  result.ok = result.retained === 0 && result.failed === 0;
  return result;
}

module.exports = {
  withAuthCredentialsLock,
  beginAuthCredentialsShutdown: () => { shuttingDown = true; },
  releaseAllAuthCredentialsLocks,
};
