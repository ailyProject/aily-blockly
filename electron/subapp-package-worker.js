const { parentPort, workerData } = require('worker_threads');
const { extractNpmTarball, verifyTarballIntegrity } = require('./subapp-package-extractor');

try {
  verifyTarballIntegrity(workerData.tarballPath, workerData.integrity);
  const result = extractNpmTarball(workerData.tarballPath, workerData.destination, {
    maxCompressedBytes: workerData.maxCompressedBytes,
    maxExpandedBytes: workerData.maxExpandedBytes,
    maxEntries: workerData.maxEntries,
    onProgress: progress => parentPort.postMessage({ type: 'progress', progress }),
  });
  parentPort.postMessage({ type: 'complete', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      code: error?.code,
      stack: error?.stack,
    },
  });
} finally {
  parentPort.close();
}
