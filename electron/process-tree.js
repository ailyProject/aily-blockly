const { exec, execFile } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isWin32 } = require('./platform');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExited(child) {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

function readProcessIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19] || null;
  } catch {
    return null;
  }
}

function captureRegisteredProcessIdentity(child) {
  if (!Number.isInteger(child.pid) || processExited(child)) return Promise.resolve(null);
  const capture = isWin32
    ? windowsPowerShell(`[Diagnostics.Process]::GetProcessById(${child.pid}).StartTime.ToUniversalTime().Ticks.ToString()`, 3000)
    : process.platform === 'linux' ? Promise.resolve(readProcessIdentity(child.pid)) : unixBirth(child.pid);
  return capture.then(value => processExited(child) ? null : value, () => null);
}

function unixBirth(pid) {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 }, (error, output) =>
      resolve(error ? null : output.trim() || null));
  });
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

async function terminateUnixProcessTree(pid, label, startedAt, registered, startedIdentity, observe) {
  const descendantPids = await collectUnixProcessTreePids(pid);
  const targetPids = [...descendantPids, pid].filter((value, index, array) => array.indexOf(value) === index);
  const identity = target => process.platform === 'linux' ? Promise.resolve(readProcessIdentity(target)) : unixBirth(target);
  const birth = registered ? await startedIdentity : null;
  if (registered && (!birth || processExited(registered) || await identity(pid) !== birth || processExited(registered))) return false;
  const targets = registered
    ? new Map(await Promise.all(targetPids.map(async target => [target, await identity(target)])))
    : new Map(targetPids.map(target => [target, null]));
  if (registered && (processExited(registered) || targets.get(pid) !== birth)) return false;
  const permitted = async target => !registered || (targets.get(target) && await identity(target) === targets.get(target));
  if (registered) observe?.(async () => {
    const matches = await Promise.all(targetPids.map(async target => {
      const start = targets.get(target);
      const current = await identity(target);
      return start && current ? start === current : isProcessAlive(target);
    }));
    return !matches.some(Boolean);
  });
  const termResults = await Promise.all(targetPids.map(async targetPid => ({
    pid: targetPid,
    signal: 'SIGTERM',
    sent: await permitted(targetPid) && trySignalProcess(targetPid, 'SIGTERM')
  })));

  await sleep(350);

  const remainingPids = targetPids.filter((targetPid) => isProcessAlive(targetPid));
  const killResults = await Promise.all(remainingPids.map(async targetPid => ({
    pid: targetPid,
    signal: 'SIGKILL',
    sent: await permitted(targetPid) && trySignalProcess(targetPid, 'SIGKILL')
  })));

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

function windowsPowerShell(script, timeout = 10000) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + script],
    { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

const pendingWindowsSnapshots = new Map();

function windowsProcessSnapshot(timeout = 10000, includeUnknown = false) {
  // Requests with the same timeout can share a query before it starts.
  // Once launched, a later request must capture fresh identities.
  if (!pendingWindowsSnapshots.has(timeout)) {
    pendingWindowsSnapshots.set(timeout, Promise.resolve().then(() => {
      pendingWindowsSnapshots.delete(timeout);
      return readWindowsProcessSnapshot(timeout);
    }));
  }
  const snapshot = pendingWindowsSnapshots.get(timeout);
  return includeUnknown ? snapshot : snapshot.then(rows => rows.filter(row => row.created !== null));
}

async function readWindowsProcessSnapshot(timeout) {
  const text = await windowsPowerShell(
    'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { $null } } })',
    timeout);
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.some(row => !Number.isInteger(row.pid) || !Number.isInteger(row.parent)
    || (row.created !== null && (typeof row.created !== 'string' || !/^\d+$/.test(row.created))))) throw new Error('Invalid process snapshot.');
  return rows;
}

function windowsTaskkill(pid) {
  return new Promise(resolve => exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 10000 },
    (error, _stdout, stderr) => resolve({ success: !error, error: error?.message || '', stderr: stderr?.trim?.() || '' })));
}

async function stopBoundWindowsProcesses(identities, rootPid, rootBirth, timeout) {
  const encoded = Buffer.from(JSON.stringify(identities.map(row => ({
    pid: row.pid, birth: row.pid === rootPid ? rootBirth : row.created, exact: row.pid === rootPid
  }))), 'utf8').toString('base64');
  // Opening SafeHandle first pins the exact kernel object. Reading StartTime
  // and Kill on this Process instance then use that same handle.
  await windowsPowerShell(`
    $entries = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
    foreach ($entry in $entries) {
      $target = $null
      try {
        $target = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
        $null = $target.SafeHandle
        $ticks = $target.StartTime.ToUniversalTime().Ticks
        if (!$entry.exact) { $ticks -= $ticks % 10 }
        if ($ticks.ToString() -eq $entry.birth -and !$target.HasExited) { $target.Kill() }
      } catch { } finally { if ($null -ne $target) { $target.Dispose() } }
    }
  `, timeout);
}

async function terminateBoundWindowsTree(registered, identity, observe) {
  const deadline = Date.now() + 6000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const birth = await identity;
  if (typeof birth !== 'string' || !/^\d+$/.test(birth) || processExited(registered)) return false;
  const pid = registered.pid;
  const known = new Map([[pid, (BigInt(birth) / 10n * 10n).toString()]]);
  const owned = rows => {
    const current = new Map(rows.map(row => [row.pid, row]));
    let changed;
    do {
      changed = false;
      for (const row of rows) {
        const parentBirth = known.get(row.parent);
        const parent = current.get(row.parent);
        if (!parentBirth || !row.created || known.has(row.pid) || parent?.created !== parentBirth
          || BigInt(row.created) < BigInt(parentBirth)) continue;
        known.set(row.pid, row.created);
        changed = true;
      }
    } while (changed);
    return rows.filter(row => known.get(row.pid) === row.created);
  };
  const incomplete = rows => {
    const current = new Map(rows.map(row => [row.pid, row]));
    return rows.some(row => {
      if (row.created === null && known.has(row.pid)) return true;
      const parentBirth = known.get(row.parent);
      if (!parentBirth || known.has(row.pid)) return false;
      const parent = current.get(row.parent);
      if (parent?.created && parent.created !== parentBirth) return false;
      return !row.created || (!parent?.created && BigInt(row.created) >= BigInt(parentBirth));
    });
  };
  const before = await windowsProcessSnapshot(remaining(), true);
  if (processExited(registered) || before.find(row => row.pid === pid)?.created !== known.get(pid)) return false;
  observe?.(async () => {
    const rows = await windowsProcessSnapshot(3000, true);
    return owned(rows).length === 0 && !incomplete(rows);
  });
  let targets = owned(before);
  const attempted = new Set();
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    // Stop parents first. A late child is only a stop target if its parent is
    // still the same process in the snapshot; an ambiguous row holds proof.
    const newTargets = targets.filter(row => !attempted.has(row.pid));
    for (const row of newTargets) attempted.add(row.pid);
    if (newTargets.length) {
      try {
        await stopBoundWindowsProcesses(newTargets.sort((a, b) => Number(BigInt(a.created) - BigInt(b.created))), pid, birth, remaining());
      } catch { /* Delivery can fail after the signal. Verify the original tree below. */ }
    }
    await sleep(100);
    const rows = await windowsProcessSnapshot(remaining(), true);
    targets = owned(rows);
    if (!targets.length && !incomplete(rows)) return true;
  }
  return false;
}

async function terminateWindowsProcessTree(pid, label, startedAt, options = {}) {
  // Capture descendants before taskkill can orphan them. Creation identity
  // prevents a recycled PID from becoming evidence or a later kill target.
  let before;
  try { before = await windowsProcessSnapshot(); } catch { /* A failed snapshot cannot attest a failed kill. */ }
  const originalCompletedNormally = options.originalProcessCompletedNormally?.() === true;
  if (originalCompletedNormally) {
    // The registered ChildProcess can finish while CIM is enumerating it. Do
    // not kill its old PID: it may already belong to another process. A failed
    // enumeration or any possible remaining tree still leaves stop unresolved.
    const success = !!before && !before.some(row => row.pid === pid || row.parent === pid);
    console.info('[PROC_TRACE][PROCESS_TREE_KILL]', { label, pid, method: 'taskkill', success,
      durationMs: Date.now() - startedAt, snapshotAvailable: !!before, originalCompletedNormally,
      alreadyExited: success, verifiedAfterFailure: false, targetPids: [], aliveAfterKill: [] });
    return success;
  }
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
    durationMs: Date.now() - startedAt, snapshotAvailable: !!before, originalCompletedNormally,
    verifiedAfterFailure,
    targetPids: [...known.keys()], aliveAfterKill, error: first.error, stderr: first.stderr });
  return success;
}

function killRegisteredProcessTree(pid, label, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve(false);
  }

  if (options.registered && options.registered.pid !== pid) return Promise.resolve(false);
  const ownedProcess = options.registered || options.ownedProcess;
  if (ownedProcess) {
    const { getOwnedProcessInfo, stopOwnedProcess } = require('./owned-process');
    if (getOwnedProcessInfo(ownedProcess)) {
      // Failure must retain this exact ownership. Never fall through to a PID scan
      // that might now refer to a different task or main-software instance.
      return stopOwnedProcess(ownedProcess).catch(() => false);
    }
  }

  if (options.registered) {
    if (processExited(options.registered)) return Promise.resolve(false);
    const operation = isWin32
      ? terminateBoundWindowsTree(options.registered, options.identity, options.observe)
      : terminateUnixProcessTree(pid, label, Date.now(), options.registered, options.identity, options.observe);
    return operation.catch(() => false);
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
        void terminateWindowsProcessTree(pid, label, startedAt, options).then(resolve, () => resolve(false));
      }
      return;
    }

    void terminateUnixProcessTree(pid, label, startedAt).then(resolve);
  });
}

module.exports = {
  captureRegisteredProcessIdentity,
  killRegisteredProcessTree,
};
