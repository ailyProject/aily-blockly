const path = require('path');
const { Worker } = require('worker_threads');
const { fault, duration } = require('./subapp-download');

function extractNpmTarballInBackground(tarballPath, destination, options = {}) {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
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
    let settled = false;
    let completed = null;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      operation(value);
    };
    let terminating = false;
    const stop = async error => {
      if (settled || terminating) return;
      terminating = true;
      try { await worker.terminate(); }
      finally { finish(reject, error); }
    };
    const abort = () => { void stop(options.signal.reason || fault('SUBAPP_CANCELLED', 'Subapp extraction cancelled')); };
    const timer = setTimeout(() => { void stop(fault('SUBAPP_EXTRACT_TIMEOUT', 'Subapp extraction exceeded its time limit')); },
      duration(options.timeoutMs, 3 * 60 * 1000));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', message => {
      if (terminating) return;
      if (message?.type === 'progress') {
        try { options.onProgress?.(message.progress); } catch (error) { void stop(error); }
        return;
      }
      if (message?.type === 'complete') {
        // Wait until the worker exits so extracted files are closed before the
        // staging directory is renamed. Windows denies that rename while a handle remains.
        completed = message.result;
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
      if (terminating || settled) return;
      if (completed) finish(resolve, completed);
      else finish(reject, new Error(`Subapp package worker exited before completion (${code})`));
    });
  });
}

module.exports = { extractNpmTarballInBackground };
