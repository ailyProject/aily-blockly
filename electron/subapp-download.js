'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const fault = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const duration = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

async function downloadFileWithProgress(fileUrl, destination, onProgress, options = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(options.signal.reason || fault('SUBAPP_CANCELLED', 'Subapp download cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(fault('SUBAPP_DOWNLOAD_TIMEOUT', 'Subapp download exceeded its time limit')),
    duration(options.downloadTimeoutMs, 5 * 60 * 1000));
  let idle;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(fault('SUBAPP_DOWNLOAD_IDLE_TIMEOUT', 'Subapp download stopped receiving data')),
      duration(options.downloadIdleTimeoutMs, 30000));
  };
  const fetch = options.downloadFetch || ((url, settings) => (new URL(url).protocol === 'http:' ? http : https).get(url, settings));
  const request = url => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const req = fetch(url, { headers: { Accept: '*/*' }, signal });
    const cancel = () => { req.destroy(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    req.once('close', () => signal.removeEventListener('abort', cancel));
    req.once('error', reject);
    req.once('response', resolve);
  });
  try {
    signal.throwIfAborted();
    touch();
    let current = fileUrl;
    let redirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 5;
    while (true) {
      const response = await request(current);
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        const location = response.headers.location;
        response.destroy();
        if (redirects-- <= 0) throw new Error(`Too many redirects while downloading ${fileUrl}`);
        current = new URL(location, current).toString();
        touch();
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new Error(`Download failed: HTTP ${status}`);
      }
      const total = Number(response.headers['content-length']) || 0;
      let downloaded = 0, lastPercent = -1;
      response.on('data', chunk => {
        touch();
        downloaded += chunk.length;
        const percent = Math.min(100, Math.max(0, Math.round(downloaded * 100 / total)));
        if (total && percent !== lastPercent) {
          lastPercent = percent;
          try { onProgress?.(percent); } catch (error) { controller.abort(error); }
        }
      });
      await pipeline(response, fs.createWriteStream(destination), { signal });
      signal.throwIfAborted();
      onProgress?.(100);
      return destination;
    }
  } catch (error) {
    // pipeline has closed the file before rejecting, including on Windows.
    try { await fs.promises.rm(destination, { force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* private staging cleanup retries */ }
    throw signal.aborted ? signal.reason : error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(idle);
    options.signal?.removeEventListener('abort', abort);
  }
}

module.exports = { downloadFileWithProgress, fault, duration };
