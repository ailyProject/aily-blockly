const path = require('node:path');
const { Worker } = require('node:worker_threads');

const CLEANUP_TIMEOUT_MS = 45_000;
const retiredUninstallPrefix = target => `.aily-uninstall-${path.basename(target)}-`;
const isRetiredUninstallName = (target, name) => {
  const prefix = retiredUninstallPrefix(target);
  return name.startsWith(prefix) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name.slice(prefix.length));
};

function runSubappVersionCleanup(rootDir, entry, options) {
  if (options.isBusy()) return Promise.resolve(true);
  return new Promise(resolve => {
    const worker = new Worker(path.join(__dirname, 'subapp-version-cleanup-worker.js'), {
      execArgv: [],
      workerData: {
        rootDir,
        updateRootDir: options.updateRootDir,
        entry,
        platform: options.platform || process.platform,
        profiles: options.versionCleanupProfiles || [],
        hostPid: process.pid,
        customProcessInventory: Boolean(options.hasProcessesUsingPath),
      },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let retry = true;
    let stopping = false;
    const timer = setTimeout(() => {
      stopping = true;
      // Keep one worker at a time, including when a stalled OS call delays exit.
      // The worker never holds a lock needed by launch, publication or uninstall.
      void worker.terminate().catch(() => {});
    }, options.versionCleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);
    timer.unref();

    const reply = (type, check) => {
      // Test inventory and host liveness can reject or outlive this worker.
      // An uncertain result leaves the old version in place.
      void Promise.resolve().then(check).catch(() => true).then(busy => {
        if (!stopping) worker.postMessage({ type, busy: Boolean(busy) });
      }).catch(() => {});
    };
    worker.on('message', message => {
      if (stopping) return;
      if (message.type === 'ready') reply('decision', options.isBusy);
      if (message.type === 'process-query') {
        reply('process-result', () => options.hasProcessesUsingPath(message.directory, options.platform));
      }
      if (message.type === 'complete') retry = Boolean(message.retry);
    });
    worker.once('error', () => { retry = true; });
    worker.once('exit', code => {
      stopping = true;
      clearTimeout(timer);
      resolve(retry || code !== 0);
    });
    worker.unref();
  });
}

module.exports = { isRetiredUninstallName, retiredUninstallPrefix, runSubappVersionCleanup };
