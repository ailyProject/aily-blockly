'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { childScriptPath } = require('./child-script-path');
const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0);return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function claimInstanceProfile(basePath) {
  const directory = path.join(basePath, 'instances');fs.mkdirSync(directory, { recursive: true });
  // This permanent anchor is never unlinked. The kernel releases the mutex on
  // a crash, so simultaneous cold launches cannot publish the same slot.
  const deadline = Date.now() + 10000;let allocation;
  while (!(allocation = tryAcquireFileLock(path.join(directory, '.allocation.lock')))) {
    if (Date.now() > deadline) throw new Error('Timed out allocating an independent application profile');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  try {
    const slots = fs.readdirSync(directory).flatMap(name => {
      const match = /^instance-(\d+)$/.exec(name);return match ? [Number(match[1])] : [];
    }).sort((a,b) => a-b);
    let next = slots.length ? slots[slots.length - 1] + 1 : 0;
    for (let attempt = 0; attempt < slots.length + 1024; attempt++) {
      const index = attempt < slots.length ? slots[attempt] : next++;
      const instancePath = path.join(directory, 'instance-' + index);fs.mkdirSync(instancePath, { recursive: true });
      const lockPath = path.join(instancePath, 'instance.lock');
      const lease = tryAcquireFileLock(path.join(instancePath, '.profile.lease'));
      if (!lease) continue;
      try {
        let previous;try { previous = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) {}
        // Existing software versions still publish PID records. Respect live
        // legacy owners. For the new protocol, the acquired native lease is
        // authoritative even if a dead owner's PID has since been recycled.
        if (previous?.profileLeaseVersion !== 1 && isAlive(previous?.pid)) { lease.close();continue; }
        const instanceId = randomUUID();
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startTime: Date.now(), instanceId, profileLeaseVersion: 1 }));
        let released = false;
        return { path: instancePath, lockPath, instanceId, release() {
          if (released) return;
          try {
            const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (current.pid === process.pid && current.instanceId === instanceId) fs.unlinkSync(lockPath);
          } catch (_) {}
          released = true;lease.close();
        } };
      } catch (error) { lease.close();throw error; }
    }
    throw new Error('No independent application profile slot could be allocated');
  } finally { allocation.close(); }
}
module.exports = { claimInstanceProfile };
