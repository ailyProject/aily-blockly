'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { app } = require('electron');
const { childScriptPath } = require('./child-script-path');

const TIMEOUT_MS = 5000;
const RETRY_MS = 500;
const heldLocks = new Map();
let pendingAcquisitions = 0;
let shuttingDown = false;
let cleanupScheduled = false;

const lockFault = code => Object.assign(new Error(code), { code });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

function tryGuard(filename) {
  const anchor = path.join(path.dirname(filename), 'writer.guard');
  const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));
  const handle = tryAcquireFileLock(anchor);
  if (!handle) return null;
  try {
    const stat = fs.lstatSync(anchor, { bigint: true });
    const identity = { version: 1, device: String(stat.dev), inode: String(stat.ino), born: String(stat.birthtimeNs) };
    handle.assertHeld();
    return { handle, identity };
  } catch (error) { handle.close(); throw error; }
}

function readMarker(filename) {
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096n) return { state: 'unverified' };
    const bytes = fs.readFileSync(filename);
    if (!sameFile(stat, fs.lstatSync(filename, { bigint: true }))) return { state: 'unverified' };
    let owner;
    try { owner = JSON.parse(bytes); }
    catch { return { state: 'unverified' }; }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 ||
        typeof owner.token !== 'string' || !/^[\w-]{8,128}$/.test(owner.token) ||
        owner.label !== 'auth-credentials' || owner.mode !== 'write' ||
        !Number.isSafeInteger(owner.startedAt) || owner.startedAt <= 0) return { state: 'unverified' };
    return { state: 'owned', owner, stat, bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw error;
  }
}

function mayRetire(owner, guard) {
  if ('guard' in owner) {
    const identity = owner.guard;
    return identity?.version === 1 && ['device', 'inode', 'born'].every(key => identity[key] === guard.identity[key]);
  }
  // The legacy writer did not observe the guard. Require an exited complete
  // owner, never age or a permission failure as authority to unpublish it.
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}

function removeMarker(filename, original, guard) {
  const observed = readMarker(filename);
  guard.handle.assertHeld();
  if (observed.state === 'absent') return true;
  if (observed.state !== 'owned' || !sameFile(observed.stat, original.stat) ||
      !observed.bytes.equals(original.bytes)) return false;
  fs.unlinkSync(filename);
  return true;
}

function publish(filename, owner, guard, released = false) {
  const staged = `${filename}.${owner.token}.${released ? 'release' : 'publish'}.tmp`;
  let stagedExists = false;
  try {
    const descriptor = fs.openSync(staged, 'wx', 0o600);
    stagedExists = true;
    try {
      fs.writeFileSync(descriptor, JSON.stringify(owner));
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    guard.handle.assertHeld();
    if (released) fs.renameSync(staged, filename);
    else fs.linkSync(staged, filename);
  } finally {
    if (stagedExists) {
      try { fs.unlinkSync(staged); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

function scheduleCleanup() {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setTimeout(() => {
    cleanupScheduled = false;
    for (const lock of heldLocks.values()) if (!lock.nativeWorkPending) releaseLock(lock);
  }, RETRY_MS);
  timer?.unref?.();
}

function releaseLock(lock) {
  if (lock.nativeWorkPending) return false;
  let guard = lock.guard;
  try {
    guard ??= tryGuard(lock.filename);
    if (!guard) { scheduleCleanup(); return lock.released; }
    let marker = readMarker(lock.filename);
    if (marker.state === 'absent' || (marker.state === 'owned' && marker.owner.token !== lock.token)) {
      heldLocks.delete(lock.token);
      return true;
    }
    if (marker.state !== 'owned' || marker.owner.pid !== process.pid || !mayRetire(marker.owner, guard)) return false;
    if (!marker.owner.released) {
      publish(lock.filename, { ...marker.owner, released: true, commandBorrowed: false }, guard, true);
      marker = readMarker(lock.filename);
      if (marker.state !== 'owned' || marker.owner.token !== lock.token) return false;
    }
    lock.released = true;
    if (!removeMarker(lock.filename, marker, guard)) return false;
    heldLocks.delete(lock.token);
    return true;
  } catch {
    console.warn('[AUTH_CREDENTIALS_LOCK_RELEASE_FAILED]');
    scheduleCleanup();
    return lock.released;
  } finally {
    guard?.handle.close();
    lock.guard = undefined;
  }
}

function tryAcquireMarker(filename, payload) {
  const guard = tryGuard(filename);
  if (!guard) return { state: 'busy' };
  let retained = false;
  try {
    const marker = readMarker(filename);
    if (marker.state === 'unverified') return marker;
    if (marker.state === 'owned') {
      if (!mayRetire(marker.owner, guard)) return { state: 'busy' };
      if (!removeMarker(filename, marker, guard)) return { state: 'unverified' };
    }
    try { publish(filename, { ...payload, guard: guard.identity }, guard); }
    catch (error) {
      const attempted = readMarker(filename);
      if (attempted.state === 'owned' && attempted.owner.token === payload.token) {
        removeMarker(filename, attempted, guard);
      }
      if (error.code === 'EEXIST') return { state: 'busy' };
      throw error;
    }
    const lock = { token: payload.token, filename, guard, nativeWorkPending: true, released: false };
    heldLocks.set(lock.token, lock);
    retained = true;
    return { state: 'acquired', lock };
  } finally { if (!retained) guard.handle.close(); }
}

async function acquireLock() {
  const startedAt = Date.now();
  const directory = path.join(process.env.AILY_APPDATA_PATH || app.getPath('userData'), '.lock', 'auth-credentials');
  const filename = path.join(directory, 'writer.lock');
  const payload = { token: `${process.pid}_${startedAt}_${randomUUID()}`, pid: process.pid, execPath: process.execPath,
    appVersion: app.getVersion(), label: 'auth-credentials', mode: 'write', startedAt };
  pendingAcquisitions++;
  try {
    let state;
    do {
      if (shuttingDown) throw lockFault('AUTH_CREDENTIALS_LOCK_SHUTDOWN');
      fs.mkdirSync(directory, { recursive: true });
      const result = tryAcquireMarker(filename, payload);
      if (result.state === 'acquired') return result.lock;
      state = result.state;
      const remaining = TIMEOUT_MS - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_MS, remaining)));
    } while (Date.now() - startedAt < TIMEOUT_MS);
    throw lockFault(state === 'unverified' ? 'AUTH_CREDENTIALS_LOCK_UNVERIFIED' : 'AUTH_CREDENTIALS_LOCK_TIMEOUT');
  } finally { pendingAcquisitions--; }
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
