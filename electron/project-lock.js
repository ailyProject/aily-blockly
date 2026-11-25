'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
const { childScriptPath } = require('./child-script-path');
const { rootAttachment } = require('./project-file-lock-owner');
const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));
const { getProcessState } = require(childScriptPath('process-state.js'));
const { getSystemBootId, isSystemBootId } = require(childScriptPath('system-boot-id.js'));
const { observeBuildProcessIdentity } = require(childScriptPath('build-process-identity.js'));

const LOCK_SEGMENTS = ['.aily', 'project-open.lock'];
const VIEW_LEASE_VERSION = 1;
const WINDOWS_VIEW_LOCK_OFFSET = 0x100000000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const supportsFocus = process.platform === 'darwin' || process.platform === 'win32';
const heldViews = new Map();
let processIdentity;

function getLockPath(normalizedRoot) {
  return path.join(normalizedRoot, ...LOCK_SEGMENTS);
}

function normalizeProjectPathStrict(projectPath) {
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) {
    const err = new Error("PROJECT_PATH_NOT_EXIST");
    err.code = "ENOENT";
    throw err;
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    const err = new Error("PROJECT_PATH_NOT_DIR");
    err.code = "ENOTDIR";
    throw err;
  }
  try {
    // Native resolution returns the physical casing of case-insensitive paths.
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** 释放锁时用，不校验路径是否存在 */
function normalizeProjectPathLoose(projectPath) {
  if (!projectPath) {
    return "";
  }
  const resolved = path.resolve(projectPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const validPid = pid => Number.isSafeInteger(pid) && pid > 0;
const validToken = token => typeof token === 'string' && UUID.test(token);
const viewRecordChanged = () => ({ ok: false, code: 'PROJECT_VIEW_CHANGED',
  error: 'The project view no longer belongs to the original owner.' });
const viewError = error => ({ ok: false, code: error.code, error: error.message });

function safeViewDirectory(root, create = false) {
  const directory = path.join(root, '.aily');
  if (create) fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe project view coordination directory.');
  return directory;
}

function takeGuard(root) {
  const filename = path.join(safeViewDirectory(root, true), 'project-view.guard');
  // LockFileEx blocks reads inside the locked range. A read handle and a byte
  // beyond the contents allow shared readers and still overlap legacy locks.
  return process.platform === 'win32'
    ? tryAcquireFileLock(filename, { offset: WINDOWS_VIEW_LOCK_OFFSET, length: 1, readOnly: true })
    : tryAcquireFileLock(filename);
}

function validRecord(owner) {
  return validPid(owner?.pid) && typeof owner.execPath === 'string'
    && (path.posix.isAbsolute(owner.execPath) || path.win32.isAbsolute(owner.execPath))
    && Number.isFinite(owner.startedAt) && owner.startedAt > 0;
}

function isNativeViewOwner(owner) {
  return owner?.viewLeaseVersion === VIEW_LEASE_VERSION && validRecord(owner) && validToken(owner.viewToken);
}

function legacyOwnership(owner) {
  // Old records do not bind their PID to a host, so a missing local PID does
  // not exclude a legacy editor on a shared mount or another PID namespace.
  return { state: 'unknown', reason: validRecord(owner) && owner.viewLeaseVersion === undefined
    ? 'legacy-owner-unverified' : 'invalid-owner-record' };
}

function scopeHash(root) {
  try {
    const attachment = rootAttachment(root);
    return attachment ? createHash('sha256').update(JSON.stringify(attachment)).digest('hex') : null;
  } catch { return null; }
}

function makeOwner(root, viewToken) {
  const bootId = supportsFocus ? getSystemBootId() : null;
  if (bootId && processIdentity === undefined) processIdentity = observeBuildProcessIdentity(process.pid);
  return { viewLeaseVersion: VIEW_LEASE_VERSION, viewToken, pid: process.pid, execPath: process.execPath,
    appVersion: app.getVersion(), startedAt: Date.now(), bootId, processIdentity: processIdentity ?? null,
    scope: bootId && processIdentity ? scopeHash(root) : null };
}

function localOwnerMatches(root, owner, token = owner?.viewToken) {
  return supportsFocus && isNativeViewOwner(owner) && owner.viewToken === token && isSystemBootId(owner.bootId)
    && owner.bootId === getSystemBootId() && typeof owner.scope === 'string' && owner.scope === scopeHash(root)
    && typeof owner.processIdentity === 'string' && getProcessState(owner.pid) === true
    && owner.processIdentity === observeBuildProcessIdentity(owner.pid);
}

function describeConflict(root, owner, ownership, focus) {
  const code = ownership.state === 'active' ? 'PROJECT_VIEW_OCCUPIED'
    : ownership.state === 'busy' ? 'PROJECT_VIEW_BUSY' : 'PROJECT_VIEW_OWNER_UNKNOWN';
  return { ok: false, conflict: true, code, normalizedPath: root, ownership,
    ...(validPid(owner?.pid) ? { holder: { pid: owner.pid, appVersion: owner.appVersion } } : {}),
    ...(focus ? { focus: { viewToken: owner.viewToken } } : {}),
    error: ownership.state === 'active' ? 'Another process still owns the project view.'
      : ownership.state === 'busy' ? 'Another project-view operation holds the native guard.'
        : 'Project-view ownership is unconfirmed; its record was retained.' };
}

function busyView(root) {
  let owner;
  try { owner = readSnapshotAt(root)?.owner; } catch { /* The holder may still be publishing. */ }
  if (isNativeViewOwner(owner)) {
    return describeConflict(root, owner, { state: 'active', reason: 'native-view-guard-held' }, localOwnerMatches(root, owner));
  }
  return describeConflict(root, owner, { state: 'busy', reason: 'native-view-guard-held' });
}

function sameSnapshot(a, b) {
  return !!a && !!b && a.project === b.project && a.hash === b.hash
    && Object.keys(a.identity).every(key => a.identity[key] === b.identity?.[key]);
}

function matchesSnapshot(root, expected) {
  const current = readSnapshotAt(root);
  return expected ? sameSnapshot(current, expected) : !current;
}

function publishOwner(root, guard, prior, owner) {
  const marker = getLockPath(root);
  const staging = path.join(path.dirname(marker), `.project-open.lock.${owner.viewToken}.tmp`);
  let staged = false;
  try {
    // A crash can leave a staging file, but never a partial diagnostic record.
    const descriptor = fs.openSync(staging, 'wx', 0o600);
    staged = true;
    try { fs.writeFileSync(descriptor, JSON.stringify(owner, null, 2)); }
    finally { fs.closeSync(descriptor); }
    guard.assertHeld();
    if (!matchesSnapshot(root, prior)) return false;
    fs.renameSync(staging, marker);
    staged = false;
    return true;
  } finally { if (staged) fs.unlinkSync(staging); }
}

function tryAcquireLock(projectPath, options = {}) {
  let guard;
  try {
    const root = normalizeProjectPathStrict(projectPath);
    const existing = heldViews.get(root);
    if (existing) {
      if (!isHeld(root, existing.viewToken) || !matchesSnapshot(root, existing.snapshot)) return viewRecordChanged();
      return { ok: true, normalizedPath: root, lockPath: getLockPath(root), viewToken: existing.viewToken, alreadyHeld: true };
    }
    guard = takeGuard(root);
    if (!guard) return busyView(root);
    let snapshot;
    try { snapshot = readSnapshotAt(root); }
    catch { return describeConflict(root, undefined, { state: 'unknown', reason: 'invalid-owner-record' }); }

    if (snapshot && !isNativeViewOwner(snapshot.owner)) {
      if (options.strict) return { ok: false, code: 'PROJECT_REPAIR_TARGET_BUSY', normalizedPath: root,
        error: 'A legacy project-view record remains; strict repair opening did not replace it.' };
      return describeConflict(root, snapshot.owner, legacyOwnership(snapshot.owner));
    }

    const viewToken = randomUUID();
    const owner = makeOwner(root, viewToken);
    if (!publishOwner(root, guard, snapshot, owner)) return viewRecordChanged();
    const published = readSnapshotAt(root);
    if (published?.owner?.viewToken !== viewToken) return viewRecordChanged();
    heldViews.set(root, { guard, viewToken, snapshot: published });
    guard = undefined;
    return { ok: true, normalizedPath: root, lockPath: getLockPath(root), viewToken,
      ...(snapshot && { recoveredStale: true }) };
  } catch (error) { return viewError(error); }
  finally { guard?.close(); }
}

function isHeld(projectPath, viewToken) {
  try {
    const owner = heldViews.get(normalizeProjectPathLoose(projectPath));
    if (!owner || viewToken !== undefined && owner.viewToken !== viewToken) return false;
    owner.guard.assertHeld();
    return true;
  } catch { return false; }
}

function captureHeldView(projectPath) {
  try {
    const root = normalizeProjectPathLoose(projectPath), current = heldViews.get(root);
    if (current && isHeld(root, current.viewToken) && matchesSnapshot(root, current.snapshot)) {
      return { viewToken: current.viewToken };
    }
  } catch { /* The original handle or record changed. */ }
}

function matchesHeldView(root, expected) {
  const current = heldViews.get(root);
  return !!current && (!expected || (expected.viewToken !== undefined
    ? current.viewToken === expected.viewToken : sameSnapshot(current.snapshot, expected)));
}

function releaseLock(projectPath, expected) {
  let root = normalizeProjectPathLoose(projectPath);
  if (projectPath && !heldViews.has(root)) root = path.resolve(projectPath);
  if (!matchesHeldView(root, expected)) return expected ? viewRecordChanged() : { ok: true };
  return releaseHeldView(root, heldViews.get(root));
}

function releaseHeldView(root, current, retainOnFailure = false) {
  let removed = false;
  try {
    current.guard.assertHeld();
    if (!matchesSnapshot(root, current.snapshot)) return viewRecordChanged();
    fs.unlinkSync(getLockPath(root));
    removed = true;
    return { ok: true };
  } catch (error) { return viewError(error); }
  finally {
    if (removed || !retainOnFailure) {
      heldViews.delete(root);
      current.guard.close();
    }
  }
}

function releaseAll() {
  const results = Array.from(heldViews, ([root, current]) => releaseHeldView(root, current));
  return { ok: results.every(result => result.ok), results };
}

function handoffViewLock(sourceProject, source, targetProject, target) {
  try {
    const sourceRoot = normalizeProjectPathStrict(sourceProject), targetRoot = normalizeProjectPathStrict(targetProject);
    const matches = (root, expected) => expected && matchesHeldView(root, expected) && captureHeldView(root);
    if (sourceRoot === targetRoot || !matches(sourceRoot, source) || !matches(targetRoot, target)) return viewRecordChanged();
    return releaseHeldView(sourceRoot, heldViews.get(sourceRoot), true);
  } catch (error) { return viewError(error); }
}

function readSnapshotAt(root) {
  let before;
  const filename = getLockPath(root);
  try {
    safeViewDirectory(root);
    before = fs.lstatSync(filename, { bigint: true });
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const keys = ['dev', 'ino', 'size', 'birthtimeNs', 'mtimeNs'];
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n)
    throw new Error('Unsafe project-view record.');
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    // Windows Electron path and handle stats may report different devices.
    if (!opened.isFile() || opened.nlink !== before.nlink || keys.slice(1).some(key => opened[key] !== before[key])) {
      throw new Error('Project-view record changed while opening.');
    }
    bytes = fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  const after = fs.lstatSync(filename, { bigint: true });
  if (keys.some(key => before[key] !== after[key]) || after.nlink !== before.nlink)
    throw new Error('Project-view record changed while reading.');
  const contents = bytes.toString('utf8');
  return { project: root, owner: JSON.parse(contents), contents,
    hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    identity: Object.fromEntries(keys.map(key => [key, String(before[key])])) };
}

function readViewLockSnapshot(projectPath) {
  return readSnapshotAt(normalizeProjectPathStrict(projectPath));
}

function inspectViewLock(projectPath) {
  let guard;
  try {
    const root = normalizeProjectPathStrict(projectPath);
    const local = heldViews.has(root);
    if (!local) guard = takeGuard(root);
    let snapshot;
    try { snapshot = readSnapshotAt(root); }
    catch { return { ok: true, state: guard ? 'unknown' : 'busy', reason: 'invalid-owner-record' }; }
    if (local) return { ok: true, state: isHeld(root) ? 'held' : 'unknown', snapshot };
    if (!guard) return { ok: true, state: 'busy', snapshot };
    guard.assertHeld();
    return { ok: true, state: !snapshot || isNativeViewOwner(snapshot.owner) ? 'available' : 'unknown', snapshot };
  } catch (error) { return { ...viewError(error), state: 'unknown' }; }
  finally { guard?.close(); }
}

/** Exact, lineage-owned recovery. The caller continues to own its writer and build guards. */
function recoverExitedViewLock(projectPath, expected, assertCurrent, isExited) {
  let guard;
  try {
    const root = normalizeProjectPathStrict(projectPath);
    if (heldViews.has(root) || !(guard = takeGuard(root))) return busyView(root);
    assertCurrent();
    const current = readSnapshotAt(root), owner = current?.owner;
    if (!validRecord(owner) || !sameSnapshot(current, expected)
      || !isNativeViewOwner(owner) && (!path.isAbsolute(owner.execPath) || isExited(owner.pid) !== true))
      return viewRecordChanged();
    assertCurrent();
    guard.assertHeld();
    if (!matchesSnapshot(root, expected) || !isNativeViewOwner(owner) && isExited(owner.pid) !== true)
      return viewRecordChanged();
    fs.unlinkSync(getLockPath(root));
    return { ok: true, recoveredStaleView: true, previousViewHash: expected.hash };
  } catch (error) { return viewError(error); }
  finally { guard?.close(); }
}

function focusProjectOwner(projectPath, viewToken) {
  if (!validToken(viewToken)) return { ok: false, reason: 'unknown' };
  const observed = inspectViewLock(projectPath);
  const snapshot = observed.snapshot;
  if (observed.state !== 'busy' || !localOwnerMatches(snapshot?.project, snapshot?.owner, viewToken))
    return { ok: false, reason: 'unknown' };
  return focusProcessByPid(snapshot.owner.pid);
}

function focusProcessByPid(pid) {
  const state = getProcessState(pid);
  if (state !== true) {
    return { ok: false, reason: state === false ? 'dead' : 'unknown' };
  }
  const { execFileSync } = require("child_process");
  if (process.platform === "darwin") {
    try {
      execFileSync(
        "osascript",
        [
          "-e",
          `tell application "System Events" to set frontmost of first process whose unix id is ${pid} to true`,
        ],
        { stdio: "ignore", timeout: 8000 }
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  if (process.platform === "win32") {
    const psScript = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -ne $p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [W32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }`;
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", psScript], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 8000,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }
  return { ok: false, reason: "unsupported" };
}

module.exports = {
  getLockPath, normalizeProjectPathStrict, normalizeProjectPathLoose,
  tryAcquireLock, isHeld, captureHeldView, releaseLock, releaseAll, handoffViewLock, focusProjectOwner,
  readViewLockSnapshot, inspectViewLock, recoverExitedViewLock, isNativeViewOwner,
};
