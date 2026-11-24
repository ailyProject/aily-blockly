'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { runtime } = require(path.join(workerData.moduleRoot, 'owned-process'));

(async () => {
  const native = runtime();
  if (!native) { parentPort.postMessage({ ready: true, identity: {} });return; }
  const processCreated = native.binding.identity(process.pid);
  const observer = spawn(native.launcher, ['--watch', String(process.pid), processCreated, workerData.filename, workerData.instanceId],
    { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { observer.once('spawn', resolve);observer.once('error', reject); });
  observer.unref();
  // Publication in the main process is fenced behind this acknowledgement:
  // if the main process dies earlier, no discovery file has been published.
  parentPort.postMessage({ ready: true, identity: { processCreated } });
  const { pruneDiscoveryFiles } = require(path.join(workerData.moduleRoot, 'cli-discovery-lifecycle'));
  await pruneDiscoveryFiles(path.dirname(workerData.filename), { native });
})().catch(error => parentPort.postMessage({ error: error.message })).finally(() => parentPort.close());
