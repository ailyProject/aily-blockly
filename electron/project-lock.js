/**
 * 跨版本 / 多实例：项目目录内 .aily/project-open.lock 独占与检测
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");

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

/**
 * 锁文件创建时间早于系统最近一次启动 → 必定是陈旧锁（进程不可能跨越重启存活）
 */
function isLockStaleAfterReboot(lockData) {
  if (!lockData || !lockData.startedAt) {
    return false;
  }
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  return lockData.startedAt < bootTimeMs - 5000; // 5s 容差
}

/**
 * 在 Windows 上额外校验 PID 对应进程的可执行路径是否匹配锁中记录的 execPath，
 * 防止 PID 复用导致误判。
 */
function isHolderProcessMatch(lockData) {
  if (!lockData || !lockData.pid || !lockData.execPath) {
    return false;
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
        return actual === expected;
      }
      return false;
    } catch {
      return false;
    }
  }
  return true; // 非 Windows 平台回退到仅 PID 检查
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
function tryAcquireLock(projectPath, options = {}) {
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

  const existing = readLock(lockPath);
  if (existing && existing.pid === process.pid) {
    return { ok: true, normalizedPath: normalized, lockPath, alreadyHeld: true };
  }

  if (existing && isLockStaleAfterReboot(existing)) {
    // 锁创建于上次重启之前，直接视为陈旧
  } else if (existing && isPidAlive(existing.pid) && isHolderProcessMatch(existing)) {
    return {
      ok: false,
      conflict: true,
      holder: {
        pid: existing.pid,
        execPath: existing.execPath,
        appVersion: existing.appVersion,
        startedAt: existing.startedAt,
      },
      normalizedPath: normalized,
    };
  }

  try {
    fs.unlinkSync(lockPath);
  } catch (e) {
    return { ok: false, error: e.message, normalizedPath: normalized };
  }

  try {
    fs.writeFileSync(lockPath, writeLockPayload(), { flag: "wx" });
    return { ok: true, normalizedPath: normalized, lockPath, recoveredStale: true };
  } catch (e2) {
    if (e2.code === "EEXIST") {
      return tryAcquireLock(projectPath, { force: true });
    }
    return { ok: false, error: e2.message, normalizedPath: normalized };
  }
}

function releaseLock(projectPath) {
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

function focusProcessByPid(pid) {
  if (!isPidAlive(pid)) {
    return { ok: false, reason: "dead" };
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
};
