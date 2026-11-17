'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { runtime } = require('./owned-process');

async function pruneDiscoveryFiles(directory, { native = runtime(), isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} } = {}) {
  let files;try { files = await fs.promises.readdir(directory); } catch (_) { return; }
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue;
    try {
      const filename = path.join(directory, file), descriptor = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
      if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0 || file !== `${descriptor.pid}.json`) continue;
      let alive = isAlive(descriptor.pid);
      if (alive && native && /^\d+$/.test(descriptor.processCreated || '')) {
        // A reused PID is not the host that published this descriptor. An
        // inaccessible process is kept; a slow /ping never authorizes deletion.
        try { alive = native.binding.identity(descriptor.pid) === descriptor.processCreated; } catch (_) { continue; }
      }
      if (alive) continue;
      const field = descriptor.instanceId ? 'instanceId' : 'token', value = descriptor[field];
      if (!/^[a-f0-9-]{16,128}$/.test(value || '')) continue;
      if (native) native.binding.removeDescriptor(filename, field, value);
      // Windows uses an exclusive native file handle for identity-safe removal.
      // On other platforms this change leaves the existing lifecycle intact.
    } catch (_) { /* Transient writes and other owners' files remain untouched. */ }
  }
}
function watchDiscoveryFileSync(filename, instanceId, logger) {
  const native = runtime();if (!native) return {};
  try {
    const processCreated = native.binding.identity(process.pid);
    // This observer must outlive a forced main-process exit. It owns no task
    // Job and holds an exact process HANDLE, not a polling PID identity.
    const observer = spawn(native.launcher, ['--watch', String(process.pid), processCreated, filename, instanceId],
      { detached: true, windowsHide: true, stdio: 'ignore' });
    observer.on('error', error => logger.warn('[cli-bridge] discovery observer:', error.message));observer.unref();
    return { processCreated };
  } catch (error) { logger.warn('[cli-bridge] discovery observer:', error.message);return {}; }
}
function watchDiscoveryFile(filename, instanceId, logger) {
  if (process.platform !== 'win32') return Promise.resolve({});
  return new Promise(resolve => {
    // Worker bootstrap from static bundled text also works inside app.asar.
    // Native DLL loading, CreateProcess and stale-file maintenance never block
    // the main thread while Chromium is preparing the first window.
    let worker;
    try {
      worker = new Worker(fs.readFileSync(path.join(__dirname, 'cli-discovery-observer-worker.js'), 'utf8'),
        { eval: true, workerData: { moduleRoot: __dirname, filename, instanceId } });
    } catch (error) {
      logger.warn('[cli-bridge] discovery worker:', error.message);
      resolve(watchDiscoveryFileSync(filename, instanceId, logger));return;
    }
    let settled = false;
    const finish = identity => { if (!settled) { settled = true;resolve(identity); } };
    const fallback = error => {
      if (settled) return;
      logger.warn('[cli-bridge] discovery worker:', error.message);
      finish(watchDiscoveryFileSync(filename, instanceId, logger));
    };
    worker.on('message', message => message.ready ? finish(message.identity) : fallback(new Error(message.error || 'Observer initialization failed')));
    worker.once('error', fallback);
    worker.once('exit', code => { if (!settled) fallback(new Error('Observer worker exited: ' + code)); });
    worker.unref();
  });
}
module.exports = { pruneDiscoveryFiles, watchDiscoveryFile };
