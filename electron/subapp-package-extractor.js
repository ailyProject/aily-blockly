const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createHash, timingSafeEqual } = require('crypto');

const BLOCK_SIZE = 512;
const DEFAULT_MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100000;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function headerText(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  return buffer.toString('utf8', start, end >= start && end < start + length ? end : start + length);
}

function parseOctal(buffer, start, length, label) {
  const raw = buffer.subarray(start, start + length);
  if (raw[0] & 0x80) throw new Error(`Unsupported base-256 tar ${label}`);
  const value = raw.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid tar ${label}`);
  return parsed;
}

function checksumMatches(header) {
  const expected = parseOctal(header, 148, 8, 'checksum');
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return sum === expected;
}

function parsePax(data) {
  const values = {};
  let offset = 0;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    if (separator < 0) throw new Error('Invalid PAX record length');
    const lengthText = data.toString('ascii', offset, separator);
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('Invalid PAX record length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < separator - offset + 3 || offset + length > data.length) {
      throw new Error('Invalid PAX record range');
    }
    const record = data.toString('utf8', separator + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals < 1) throw new Error('Invalid PAX record');
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function safeArchivePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.includes('\0') || rawPath.includes('\\')) {
    throw new Error('Unsafe path in subapp archive');
  }
  const normalized = rawPath.replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Unsafe path in subapp archive: ${rawPath}`);
  }
  const parts = normalized.split('/');
  if (parts.shift() !== 'package' || parts.length === 0) {
    throw new Error(`Subapp archive must contain one package/ root: ${rawPath}`);
  }
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part)
      || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part)
      || Buffer.byteLength(part, 'utf8') > 255) {
      throw new Error(`Unsafe path in subapp archive: ${rawPath}`);
    }
  }
  return parts;
}

function ensureDirectory(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe extraction directory: ${current}`);
    }
  }
  return current;
}

function extractNpmTarball(tarballPath, destination, options = {}) {
  const compressedStat = fs.statSync(tarballPath);
  const maxCompressedBytes = options.maxCompressedBytes || DEFAULT_MAX_COMPRESSED_BYTES;
  const maxExpandedBytes = options.maxExpandedBytes || DEFAULT_MAX_EXPANDED_BYTES;
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
  if (!compressedStat.isFile() || compressedStat.size > maxCompressedBytes) {
    throw new Error('Subapp archive exceeds the compressed size limit');
  }
  const compressed = fs.readFileSync(tarballPath);
  let archive;
  try {
    archive = zlib.gunzipSync(compressed, { maxOutputLength: maxExpandedBytes });
  } catch (error) {
    throw new Error(`Unable to decompress subapp archive: ${error.message}`);
  }
  if (archive.length > maxExpandedBytes) throw new Error('Subapp archive exceeds the expanded size limit');

  const destinationPath = path.resolve(destination);
  ensureDirectory(path.dirname(destinationPath), [path.basename(destinationPath)]);
  if (fs.readdirSync(destinationPath).length > 0) throw new Error('Subapp extraction destination is not empty');

  const seen = new Set();
  let offset = 0;
  let entries = 0;
  let nextPax = null;
  let globalPax = {};
  let longPath = '';
  let extractedBytes = 0;
  let ended = false;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (header.every(byte => byte === 0)) {
      ended = true;
      break;
    }
    if (!checksumMatches(header)) throw new Error('Subapp archive has an invalid tar checksum');
    entries += 1;
    if (entries > maxEntries) throw new Error('Subapp archive contains too many entries');

    const type = String.fromCharCode(header[156] || 0);
    const headerSize = parseOctal(header, 124, 12, 'size');
    if (offset + headerSize > archive.length) throw new Error('Subapp archive entry is truncated');
    const content = archive.subarray(offset, offset + headerSize);
    offset += Math.ceil(headerSize / BLOCK_SIZE) * BLOCK_SIZE;

    if (type === 'x' || type === 'g') {
      const pax = parsePax(content);
      if (type === 'g') globalPax = { ...globalPax, ...pax };
      else nextPax = pax;
      continue;
    }
    if (type === 'L') {
      longPath = content.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'K') throw new Error('Subapp archives may not contain hard links');

    const pax = { ...globalPax, ...(nextPax || {}) };
    nextPax = null;
    const prefix = headerText(header, 345, 155);
    const headerPath = `${prefix ? `${prefix}/` : ''}${headerText(header, 0, 100)}`;
    const archivePath = pax.path || longPath || headerPath;
    longPath = '';
    const declaredSize = pax.size === undefined ? headerSize : Number(pax.size);
    if (!Number.isSafeInteger(declaredSize) || declaredSize !== headerSize) {
      throw new Error('Unsupported PAX size in subapp archive');
    }
    const parts = safeArchivePath(archivePath);
    const key = parts.join('/').toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`Duplicate path in subapp archive: ${archivePath}`);
    seen.add(key);

    if (type === '5') {
      if (headerSize !== 0) throw new Error('Subapp archive directory contains data');
      ensureDirectory(destinationPath, parts);
      continue;
    }
    if (type !== '\0' && type !== '0' && type !== '7') {
      throw new Error(`Unsupported subapp archive entry type: ${type || 'NUL'}`);
    }
    extractedBytes += headerSize;
    if (extractedBytes > maxExpandedBytes) throw new Error('Subapp archive exceeds the file size limit');
    const parent = ensureDirectory(destinationPath, parts.slice(0, -1));
    const target = path.join(parent, parts[parts.length - 1]);
    const mode = parseOctal(header, 100, 8, 'mode') & 0o777;
    const descriptor = fs.openSync(target, 'wx', mode || 0o644);
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(target, mode || 0o644);
    options.onProgress?.(Math.min(100, Math.round((offset / archive.length) * 100)));
  }
  if (!ended || !seen.has('package.json')) throw new Error('Subapp archive is incomplete');
  options.onProgress?.(100);
  return { entries: seen.size, extractedBytes };
}

function verifyTarballIntegrity(tarballPath, integrity) {
  const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(String(integrity || ''));
  if (!match) throw new Error('Invalid subapp package integrity');
  const expected = Buffer.from(match[2], 'base64');
  const actual = createHash(match[1]).update(fs.readFileSync(tarballPath)).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Subapp package integrity verification failed');
  }
}

module.exports = { extractNpmTarball, safeArchivePath, verifyTarballIntegrity };
