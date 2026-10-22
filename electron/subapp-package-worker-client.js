const path = require('path');
const { Worker } = require('worker_threads');

function extractNpmTarballInBackground(tarballPath, destination, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'subapp-package-worker.js'), {
      // Eval starts the main process under --inspect-brk. A Worker inheriting
      // that debugger state pauses before extracting and never reports progress.
      execArgv: [],
      workerData: {
        tarballPath,
        destination,
        integrity: options.integrity,
        maxCompressedBytes: options.maxCompressedBytes,
        maxExpandedBytes: options.maxExpandedBytes,
        maxEntries: options.maxEntries,
      },
    });
    let completed = false;
    let result;
    let failure;
    worker.on('message', message => {
      if (message?.type === 'progress') {
        options.onProgress?.(message.progress);
        return;
      }
      if (message?.type === 'complete') {
        completed = true;
        result = message.result;
        return;
      }
      if (message?.type === 'error') {
        const error = new Error(message.error?.message || 'Subapp package worker failed');
        error.name = message.error?.name || 'Error';
        if (message.error?.code) error.code = message.error.code;
        if (message.error?.stack) error.stack = message.error.stack;
        failure ||= error;
      }
    });
    worker.once('error', error => { failure ||= error; });
    worker.once('exit', code => {
      // The caller may publish or remove the extraction directory immediately.
      // A message acknowledges the work; only exit returns its ownership.
      if (failure) reject(failure);
      else if (code !== 0 || !completed) {
        reject(new Error(`Subapp package worker exited before successful completion (${code})`));
      } else resolve(result);
    });
  });
}

module.exports = { extractNpmTarballInBackground };
