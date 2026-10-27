// 管理项目目录独占锁，防止多个应用实例重复打开同一项目。
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { createHash } = require('node:crypto');
const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');
const { getProcessState } = require('../child/scripts/process-state');

const LOCK_SEGMENTS = [".aily", "project-open.lock"];

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
    return fs.realpathSync(resolved);
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
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  return getProcessState(pid) === true;
}

/**
 * 在 Windows 上额外校验 PID 对应进程的可执行路径是否匹配锁中记录的 execPath，
 * 防止 PID 复用导致误判。
 */
function isHolderProcessMatch(lockData) {
  if (!lockData || !lockData.pid || !lockData.execPath) {
    return 'unknown';
  }
  if (process.platform === "win32") {
    try {
      const { execFileSync } = require("child_process");
      const out = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${lockData.pid}`, "get", "ExecutablePath", "/value"],
        { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
      const match = out.match(/ExecutablePath=(.+)/i);
      if (match) {
        const actual = match[1].trim().toLowerCase();
        const expected = lockData.execPath.trim().toLowerCase();
        if (!path.isAbsolute(actual)) return 'unknown';
        return actual === expected;
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return true; // 非 Windows 平台回退到仅 PID 检查
}

function viewOwnerState(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1 || typeof owner.execPath !== 'string'
    || !path.isAbsolute(owner.execPath) || !Number.isFinite(owner.startedAt) || owner.startedAt <= 0)
    return { state: 'unknown', reason: 'invalid-owner-record' };
  const state = getProcessState(owner.pid);
  if (state !== true) return { state: state === false ? 'exited' : 'unknown',
    reason: state === false ? 'process-exited' : 'process-query-unavailable' };
  const match = isHolderProcessMatch(owner);
  return match === false ? { state: 'exited', reason: 'pid-reused' }
    : { state: match === true ? 'active' : 'unknown', reason: match === true ? 'process-matched' : 'executable-query-unavailable' };
}

function viewConflict(normalizedPath, holder, ownership) {
  return { ok: false, conflict: true, code: ownership.state === 'unknown' ? 'PROJECT_VIEW_OWNER_UNKNOWN' : 'PROJECT_VIEW_OCCUPIED',
    normalizedPath, ...(holder ? { holder } : {}), ownership,
    error: ownership.state === 'unknown' ? 'Project-view ownership is unconfirmed; its record was retained.'
      : 'Another process still owns the project view; its record was retained.' };
}

function writeLockPayload() {
  return JSON.stringify(
    {
      pid: process.pid,
      execPath: process.execPath,
      appVersion: app.getVersion(),
      startedAt: Date.now(),
    },
    null,
    2
  );
}

/**
 * @returns {{ ok: true, normalizedPath: string, lockPath?: string, alreadyHeld?: boolean, recoveredStale?: boolean }
 *   | { ok: false, conflict?: boolean, holder?: object, normalizedPath?: string, error?: string }}
 */
function withViewRecordGuard(projectPath, action) {
  let guard;
  try {
    const root = normalizeProjectPathStrict(projectPath), directory = path.join(root, '.aily');
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, error: 'Unsafe project view coordination directory.' };
    guard = tryAcquireFileLock(path.join(directory, 'project-view.guard'));
    if (!guard) return { ok: false, code: 'PROJECT_VIEW_BUSY', error: 'Another project-view operation owns the record.' };
    guard.assertHeld();
    return action(root);
  } catch (error) { return { ok: false, code: error.code, error: error.message }; }
  finally { guard?.close(); }
}

function tryAcquireLock(projectPath, options = {}) {
  const strict = options.strict === true;
  // Dead-owner evidence is an internal handoff capability, never a forwarded
  // public option or caller-supplied PID assertion.
  return withViewRecordGuard(projectPath, () => tryAcquireLockUnlocked(projectPath,
    { strict, force: strict ? false : !!options.force }));
}

function tryAcquireLockUnlocked(projectPath, options = {}) {
  const { force = false } = options;
  let normalized;
  try {
    normalized = normalizeProjectPathStrict(projectPath);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  const lockPath = getLockPath(normalized);
  const ailyDir = path.dirname(lockPath);
  if (!fs.existsSync(ailyDir)) {
    fs.mkdirSync(ailyDir, { recursive: true });
  }

  if (force) {
    try {
      if (fs.existsSync(lockPath)) {
        const data = readLock(lockPath);
        if (!data || data.pid !== process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch (e) {
      console.error("project-lock force unlink:", e);
    }
  }

  try {
    fs.writeFileSync(lockPath, writeLockPayload(), { flag: "wx" });
    return { ok: true, normalizedPath: normalized, lockPath };
  } catch (e) {
    if (e.code !== "EEXIST") {
      return { ok: false, error: e.message, normalizedPath: normalized };
    }
  }

  let snapshot;
  try { snapshot = readViewLockSnapshot(normalized); }
  catch { return viewConflict(normalized, undefined, { state: 'unknown', reason: 'invalid-owner-record' }); }
  const existing = snapshot?.owner;
  if (existing && existing.pid === process.pid) {
    return { ok: true, normalizedPath: normalized, lockPath, alreadyHeld: true };
  }

  // Repair bootstrap has already resolved any exact known-dead previous view.
  // A new/unknown record is never treated as stale or offered force takeover.
  if (options.strict) return { ok: false, code: 'PROJECT_REPAIR_TARGET_BUSY',
    error: 'Another project-view record remains; strict repair opening did not replace it.', normalizedPath: normalized };

  const ownership = existing?.pid === options.confirmedDeadPid && options.confirmedDeadPid
    ? { state: 'exited', reason: 'exact-native-handoff' } : viewOwnerState(existing);
  if (ownership.state !== 'exited') return viewConflict(normalized, existing, ownership);

  try {
    const current = readViewLockSnapshot(normalized);
    if (!snapshot || !current || current.hash !== snapshot.hash
      || JSON.stringify(current.identity) !== JSON.stringify(snapshot.identity))
      return { ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'Project-view ownership changed before recovery; its record was retained.', normalizedPath: normalized };
    fs.unlinkSync(lockPath);
  } catch (e) {
    return { ok: false, error: e.message, normalizedPath: normalized };
  }

  try {
    fs.writeFileSync(lockPath, writeLockPayload(), { flag: "wx" });
    return { ok: true, normalizedPath: normalized, lockPath, recoveredStale: true };
  } catch (e2) {
    if (e2.code === "EEXIST") {
      return { ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'Project-view ownership changed during recovery; the newer record was retained.', normalizedPath: normalized };
    }
    return { ok: false, error: e2.message, normalizedPath: normalized };
  }
}

function releaseLock(projectPath) {
  if (!projectPath || !fs.existsSync(normalizeProjectPathLoose(projectPath))) return { ok: true };
  return withViewRecordGuard(projectPath, () => releaseLockUnlocked(projectPath));
}

function releaseLockUnlocked(projectPath) {
  if (!projectPath) {
    return { ok: true };
  }
  const normalized = normalizeProjectPathLoose(projectPath);
  const lockPath = getLockPath(normalized);
  if (!fs.existsSync(lockPath)) {
    return { ok: true };
  }
  const data = readLock(lockPath);
  if (data && data.pid === process.pid) {
    try {
      fs.unlinkSync(lockPath);
    } catch (e) {
      console.error("project-lock release:", e);
      return { ok: false, error: e.message };
    }
  }
  return { ok: true };
}

function readViewLockSnapshot(projectPath) {
  const root = normalizeProjectPathStrict(projectPath), filename = getLockPath(root);
  let before;
  try { before = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) throw new Error('Unsafe project-view record.');
  const bytes = fs.readFileSync(filename), after = fs.lstatSync(filename);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error('Project-view record changed while reading.');
  return { project: root, owner: JSON.parse(bytes.toString('utf8')), contents: bytes.toString('utf8'),
    hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    identity: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs } };
}

/** Exact lineage-owned stale VIEW handoff only. File/npm/build leases are not
 * consulted or removed here; the caller must retain their independent guards. */
function recoverExitedViewLock(projectPath, expected, assertCurrent, isExited) {
  return withViewRecordGuard(projectPath, () => {
    assertCurrent();
    const current = readViewLockSnapshot(projectPath);
    if (!expected || !current || current.project !== expected.project || current.hash !== expected.hash
      || JSON.stringify(current.identity) !== JSON.stringify(expected.identity)
      || !Number.isSafeInteger(current.owner?.pid) || current.owner.pid <= 0 || current.owner.pid !== expected.owner?.pid
      || typeof current.owner.execPath !== 'string' || !path.isAbsolute(current.owner.execPath)
      || !Number.isFinite(current.owner.startedAt) || current.owner.startedAt <= 0
      || current.owner.execPath !== expected.owner.execPath || isExited(current.owner.pid) !== true)
      return { ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'The exact exited repair view was not confirmed; its record was retained.' };
    assertCurrent();
    const final = readViewLockSnapshot(projectPath);
    if (!final || final.hash !== expected.hash || JSON.stringify(final.identity) !== JSON.stringify(expected.identity)
      || isExited(final.owner.pid) !== true) return { ok: false, code: 'PROJECT_VIEW_CHANGED', error: 'The repair view changed before its non-force handoff; retained the current record.' };
    const acquired = tryAcquireLockUnlocked(projectPath, { force: false, confirmedDeadPid: current.owner.pid });
    if (!acquired.ok) return acquired;
    const released = releaseLockUnlocked(projectPath);
    return released.ok ? { ok: true, recoveredStaleView: true, previousViewHash: current.hash } : released;
  });
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
  getLockPath,
  normalizeProjectPathStrict,
  normalizeProjectPathLoose,
  tryAcquireLock,
  releaseLock,
  focusProcessByPid,
  isPidAlive,
  readViewLockSnapshot,
  recoverExitedViewLock,
};
