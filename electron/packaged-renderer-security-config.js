'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const CONFIG_FILENAME = 'packaged-renderer-security.json';
const MAX_CONFIG_BYTES = 4096;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Main selects this bundled file before creating its original HTTP server.
 * No Renderer request, environment variable or user preference chooses it. */
function loadPackagedRendererSecurityOptions({ moduleDirectory = __dirname } = {}) {
  if (typeof moduleDirectory !== 'string' || !path.isAbsolute(moduleDirectory)) {
    throw new TypeError('The packaged Renderer module directory must be absolute.');
  }
  const configurationPath = path.join(moduleDirectory, 'resources', CONFIG_FILENAME);
  let stat;
  try { stat = fs.lstatSync(configurationPath); }
  catch (error) {
    if (error.code === 'ENOENT') return Object.freeze({});
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CONFIG_BYTES) {
    throw new TypeError('Packaged Renderer security requires a bounded bundled file.');
  }
  const bytes = fs.readFileSync(configurationPath);
  if (bytes.length !== stat.size || bytes.length > MAX_CONFIG_BYTES) {
    throw new TypeError('The bundled Renderer security file changed while reading.');
  }
  const config = JSON.parse(bytes.toString('utf8'));
  if (!exact(config, config?.crossOriginIsolated === true
    ? ['schemaVersion', 'kind', 'crossOriginIsolated', 'index']
    : ['schemaVersion', 'kind', 'crossOriginIsolated'])
    || config.schemaVersion !== 1 || config.kind !== 'aily-packaged-renderer-security'
    || typeof config.crossOriginIsolated !== 'boolean') {
    throw new TypeError('Invalid bundled Renderer security configuration.');
  }
  if (!config.crossOriginIsolated) return Object.freeze({});
  const index = config.index;
  if (!exact(index, ['bytes', 'sha256']) || !Number.isSafeInteger(index.bytes)
    || index.bytes < 1 || index.bytes > MAX_INDEX_BYTES
    || typeof index.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(index.sha256)) {
    throw new TypeError('Isolated Renderer security requires an exact index identity.');
  }
  verifyIndex(path.join(moduleDirectory, '..', 'renderer', 'index.html'), index);
  return Object.freeze({ crossOriginIsolated: true });
}

function verifyIndex(filename, expected) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes) {
    throw new TypeError('The isolated Renderer index size or file identity differs.');
  }
  const descriptor = fs.openSync(filename, 'r');
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== expected.bytes) {
      throw new TypeError('The isolated Renderer index changed before reading.');
    }
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0;
    for (;;) {
      const size = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!size) break;
      count += size;
      if (count > expected.bytes) throw new TypeError('The isolated Renderer index exceeds its identity.');
      hash.update(buffer.subarray(0, size));
    }
    const after = fs.fstatSync(descriptor);
    if (count !== expected.bytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || hash.digest('hex') !== expected.sha256) {
      throw new TypeError('The isolated Renderer index SHA-256 differs.');
    }
  } finally { fs.closeSync(descriptor); }
}

module.exports = { CONFIG_FILENAME, MAX_CONFIG_BYTES, MAX_INDEX_BYTES, loadPackagedRendererSecurityOptions };
