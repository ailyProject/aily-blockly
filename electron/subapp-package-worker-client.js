const path = require('path');
const { Worker } = require('worker_threads');

function extractNpmTarballInBackground(tarballPath, destination, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'subapp-package-worker.js'), {
      workerData: {
        tarballPath,
        destination,
        integrity: options.integrity,
        maxCompressedBytes: options.maxCompressedBytes,
        maxExpandedBytes: options.maxExpandedBytes,
        maxEntries: options.maxEntries,
      },
    });
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      operation(value);
    };
    worker.on('message', message => {
      if (message?.type === 'progress') {
        options.onProgress?.(message.progress);
        return;
      }
      if (message?.type === 'complete') {
        finish(resolve, message.result);
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.error?.message || 'Subapp package worker failed');
        error.name = message.error?.name || 'Error';
        if (message.error?.code) error.code = message.error.code;
        if (message.error?.stack) error.stack = message.error.stack;
        finish(reject, error);
      }
    });
    worker.once('error', error => finish(reject, error));
    worker.once('exit', code => {
      if (!settled) finish(reject, new Error(`Subapp package worker exited before completion (${code})`));
    });
  });
}

module.exports = { extractNpmTarballInBackground };
