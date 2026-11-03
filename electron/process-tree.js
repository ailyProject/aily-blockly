const { exec, execFile } = require('child_process');
const path = require('node:path');
const { isWin32 } = require('./platform');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function listUnixChildProcessIds(pid) {
  return new Promise((resolve) => {
    exec(`pgrep -P ${pid}`, (error, stdout) => {
      if (error && !stdout?.trim()) {
        resolve([]);
        return;
      }

      const childPids = String(stdout || '')
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolve(childPids);
    });
  });
}

async function collectUnixProcessTreePids(pid, seen = new Set()) {
  if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) {
    return [];
  }

  seen.add(pid);
  const childPids = await listUnixChildProcessIds(pid);
  const descendants = [];

  for (const childPid of childPids) {
    descendants.push(...await collectUnixProcessTreePids(childPid, seen));
    descendants.push(childPid);
  }

  return descendants;
}

function trySignalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (_) {
    return false;
  }
}

async function terminateUnixProcessTree(pid, label, startedAt) {
  const descendantPids = await collectUnixProcessTreePids(pid);
  const targetPids = [...descendantPids, pid].filter((value, index, array) => array.indexOf(value) === index);
  const termResults = targetPids.map((targetPid) => ({
    pid: targetPid,
    signal: 'SIGTERM',
    sent: trySignalProcess(targetPid, 'SIGTERM')
  }));

  await sleep(350);

  const remainingPids = targetPids.filter((targetPid) => isProcessAlive(targetPid));
  const killResults = remainingPids.map((targetPid) => ({
    pid: targetPid,
    signal: 'SIGKILL',
    sent: trySignalProcess(targetPid, 'SIGKILL')
  }));

  await sleep(100);

  const aliveAfterKill = targetPids.filter((targetPid) => isProcessAlive(targetPid));
  const success = aliveAfterKill.length === 0;

  const logPayload = {
    label,
    pid,
    method: 'unix-process-tree',
    success,
    durationMs: Date.now() - startedAt,
    targetPids,
    escalated: remainingPids,
    aliveAfterKill,
    signals: [...termResults, ...killResults]
  };

  if (success) {
    console.info('[PROC_TRACE][PROCESS_TREE_KILL]', logPayload);
  } else {
    console.warn('[PROC_TRACE][PROCESS_TREE_KILL]', logPayload);
  }

  return success;
}

function windowsProcessSnapshot() {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $null -ne $_.CreationDate } | ForEach-Object { @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().Ticks.ToString() } }) | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const rows = JSON.parse(stdout);
        if (!Array.isArray(rows) || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parent)
          || typeof row.created !== 'string' || !/^\d+$/.test(row.created))) throw new Error('Invalid process snapshot.');
        resolve(rows);
      } catch (error) { reject(error); }
    });
  });
}

function windowsTaskkill(pid) {
  return new Promise(resolve => exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 10000 },
    (error, _stdout, stderr) => resolve({ success: !error, error: error?.message || '', stderr: stderr?.trim?.() || '' })));
}

async function terminateWindowsProcessTree(pid, label, startedAt) {
  // Capture descendants before taskkill can orphan them. Creation identity
  // prevents a recycled PID from becoming evidence or a later kill target.
  let before;
  try { before = await windowsProcessSnapshot(); } catch { /* A failed snapshot cannot attest a failed kill. */ }
  const known = new Map();
  const root = before?.find(row => row.pid === pid);
  if (root) known.set(pid, root.created);
  const includeChildren = rows => {
    const current = new Map(rows.map(row => [row.pid, row]));
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        if (known.has(row.pid) || !known.has(row.parent)) continue;
        const parent = current.get(row.parent);
        if (parent && parent.created !== known.get(row.parent)) continue;
        known.set(row.pid, row.created); changed = true;
      }
    } while (changed);
  };
  if (root) includeChildren(before);
  const first = await windowsTaskkill(pid);
  let success = first.success, verifiedAfterFailure = false, aliveAfterKill = [];
  if (!success && root) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rows = await windowsProcessSnapshot();
        includeChildren(rows);
        aliveAfterKill = rows.filter(row => known.get(row.pid) === row.created).map(row => row.pid);
        if (!aliveAfterKill.length) { success = true; verifiedAfterFailure = true; break; }
        // taskkill may return nonzero when a compiler child exits while its
        // native /T enumeration runs. Retry only the still-owned identities.
        if (attempt < 2) {
          await Promise.all(aliveAfterKill.map(target => windowsTaskkill(target)));
          await sleep(100);
        }
      } catch { break; }
    }
  }
  console.info('[PROC_TRACE][PROCESS_TREE_KILL]', { label, pid, method: 'taskkill', success,
    durationMs: Date.now() - startedAt, verifiedAfterFailure,
    targetPids: [...known.keys()], aliveAfterKill, error: first.error, stderr: first.stderr });
  return success;
}

function killRegisteredProcessTree(pid, label, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (isWin32) {
      if (options?.preferNativeAck === true) {
        // An owned advisory process must yield to save without a full CIM scan.
        // Native /T success attests the tree; failure stays unconfirmed so the
        // command supervisor retains its resources and workspace ownership.
        void windowsTaskkill(pid).then(result => {
          console.info('[PROC_TRACE][PROCESS_TREE_KILL]', { label, pid, method: 'taskkill-native-ack',
            success: result.success, durationMs: Date.now() - startedAt, error: result.error, stderr: result.stderr });
          resolve(result.success);
        }, () => resolve(false));
      } else {
        void terminateWindowsProcessTree(pid, label, startedAt).then(resolve, () => resolve(false));
      }
      return;
    }

    void terminateUnixProcessTree(pid, label, startedAt).then(resolve);
  });
}

module.exports = {
  killRegisteredProcessTree,
};
