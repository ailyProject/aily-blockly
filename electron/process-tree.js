const { exec } = require('child_process');
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
  } catch (_) {
    return false;
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

function killRegisteredProcessTree(pid, label) {
  if (!pid) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (isWin32) {
      exec(`taskkill /PID ${pid} /T /F`, (error, stdout, stderr) => {
        const success = !error;
        // console.info('[PROC_TRACE][PROCESS_TREE_KILL]', {
        //   label,
        //   pid,
        //   method: 'taskkill',
        //   success,
        //   durationMs: Date.now() - startedAt,
        //   error: error?.message || '',
        //   stderr: stderr?.trim?.() || ''
        // });
        resolve(success);
      });
      return;
    }

    void terminateUnixProcessTree(pid, label, startedAt).then(resolve);
  });
}

module.exports = {
  killRegisteredProcessTree,
};
