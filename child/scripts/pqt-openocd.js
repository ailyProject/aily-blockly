'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// Pinned by arduino-pico 5.1.0's package/package_pico_index.template.json.
// No global PATH or board package is changed. Only the explicit CMSIS-DAP
// upload selection needs this otherwise undeclared Windows SDK dependency.
const PQT_OPENOCD = Object.freeze({
  id: 'pqt-openocd', runtimeVersion: '4.1.0-1aec55e', directory: 'pqt-openocd@4.1.0-1aec55e',
  archiveName: '.pqt-openocd-4.1.0-1aec55e.windows-x64.zip', rootPrefix: 'openocd/',
  url: 'https://github.com/earlephilhower/pico-quick-toolchain/releases/download/4.1.0/x86_64-w64-mingw32.openocd-ebec9504d.250530.zip',
  sha256: '9998c1559a9e9c5bb792405b94690c53eca392cd5e329096efe393ba0b6af246', sizeBytes: 2541780,
});
const MAX_FILES = 4096, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fault = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => fault('UPLOADER_INVALID', message);
const tampered = message => fault('UPLOADER_TAMPERED', message);
const checkAbort = signal => signal?.throwIfAborted();
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
function needsPqtOpenocd({ sdkIdentity, boardOptions, platform = process.platform, arch = process.arch } = {}) {
  const reviewedSdk = sdkIdentity?.package === '@aily-project/sdk-rp2040' && sdkIdentity.version === '5.1.0';
  return platform === 'win32' && arch === 'x64' && reviewedSdk
    && boardOptions?.uploadmethod === 'picoprobe_cmsis_dap';
}
function physical(filename, type) {
  const stat = fs.lstatSync(filename);
  if ((type === 'file' ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink()
    || canonical(fs.realpathSync(filename)) !== canonical(path.resolve(filename))) throw tampered('The pinned OpenOCD cache contains a linked or nonphysical path.');
  return stat;
}
function safeMember(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\\\x00-\x1f\x7f<>:"|?*\uFFFD]/u.test(name)
    || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalid('OpenOCD archive has an unsafe member path.');
  return name;
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let result = index; for (let bit = 0; bit < 8; bit++) result = result & 1 ? 0xedb88320 ^ (result >>> 1) : result >>> 1;
  return result >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function decodeArchive(bytes, descriptor, signal) {
  checkAbort(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length !== descriptor.sizeBytes || sha256(bytes) !== descriptor.sha256) throw invalid('OpenOCD archive failed its pinned SHA-256 verification.');
  let end = bytes.length - 22;
  for (const limit = Math.max(0, bytes.length - 65557); end >= limit && bytes.readUInt32LE(end) !== 0x06054b50; end--);
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
    || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalid('OpenOCD archive is not a supported single-disk ZIP.');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_FILES || bytes.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) throw invalid('OpenOCD ZIP directory is invalid or oversized.');
  let cursor = centralStart, total = 0;
  const files = new Map(), directories = new Set(), seen = new Set();
  for (let index = 0; index < count; index++) {
    checkAbort(signal);
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid('OpenOCD ZIP central directory is truncated.');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38), mode = external >>> 16, kind = mode & 0xf000, local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34)
      || ![0, 0x4000, 0x8000].includes(kind) || compressed === 0xffffffff || length === 0xffffffff || local === 0xffffffff) throw invalid('OpenOCD ZIP contains an encrypted, linked, oversized or unsupported member.');
    const originalName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor = next;
    if (!originalName.startsWith(descriptor.rootPrefix)) throw invalid('OpenOCD ZIP member is outside the pinned tool root.');
    const isDirectory = originalName.endsWith('/');
    if ((kind === 0x4000 && !isDirectory) || (kind === 0x8000 && isDirectory)) throw invalid('OpenOCD ZIP member type is inconsistent.');
    const relative = originalName.slice(descriptor.rootPrefix.length).replace(/\/$/, '');
    if (!relative) { if (!isDirectory) throw invalid('OpenOCD ZIP tool root is not a directory.'); continue; }
    safeMember(relative);
    const key = relative.toLowerCase(); if (seen.has(key)) throw invalid('OpenOCD ZIP has duplicate member paths.'); seen.add(key);
    const parts = relative.split('/');
    for (let level = 1; level < parts.length; level++) directories.add(parts.slice(0, level).join('/'));
    if (isDirectory) { if (length || compressed) throw invalid('OpenOCD ZIP directory contains a payload.'); directories.add(relative); continue; }
    if (length > MAX_FILE_BYTES || (total += length) > MAX_TOTAL_BYTES || local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid('OpenOCD ZIP output exceeds its bounded extraction budget.');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtraLength;
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || start + compressed > centralStart
      || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== originalName) throw invalid('OpenOCD ZIP local member disagrees with its central directory.');
    const compressedBytes = bytes.subarray(start, start + compressed);
    let content;
    try { content = method === 8 ? zlib.inflateRawSync(compressedBytes, { maxOutputLength: MAX_FILE_BYTES }) : Buffer.from(compressedBytes); }
    catch { throw invalid('OpenOCD ZIP member could not be decompressed safely.'); }
    if (content.length !== length || crc32(content) !== crc) throw invalid('OpenOCD ZIP member failed its length or CRC validation.');
    files.set(relative, { bytes: content, sha256: sha256(content) });
  }
  if (cursor !== end || !files.has('bin/openocd.exe') || !files.has('share/openocd/scripts/target/rp2040.cfg')) throw invalid('OpenOCD ZIP lacks its required executable or target scripts.');
  const lowerFiles = new Set([...files.keys()].map(name => name.toLowerCase()));
  if ([...directories].some(name => lowerFiles.has(name.toLowerCase()))) throw invalid('OpenOCD ZIP paths conflict as files and directories.');
  return { files, directories };
}
function verifyTree(directory, archive, signal) {
  physical(directory, 'directory');
  let count = 0;
  function walk(current, prefix = '') {
    checkAbort(signal);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (++count > MAX_FILES * 2) throw tampered('The cached OpenOCD tree has unexpected entries.');
      const relative = prefix ? prefix + '/' + entry.name : entry.name, filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw tampered('The cached OpenOCD tree contains a linked member.');
      if (entry.isDirectory()) {
        if (!archive.directories.has(relative)) throw tampered('The cached OpenOCD tree has an unexpected directory.');
        physical(filename, 'directory'); walk(filename, relative);
      } else {
        const expected = archive.files.get(relative), stat = physical(filename, 'file');
        if (!expected || stat.size !== expected.bytes.length || sha256(fs.readFileSync(filename)) !== expected.sha256) throw tampered('A cached OpenOCD file differs from the pinned official archive.');
      }
    }
  }
  walk(directory);
  for (const relative of archive.directories) {
    checkAbort(signal); const filename = path.join(directory, ...relative.split('/'));
    if (!fs.existsSync(filename)) throw tampered('The cached OpenOCD tree is missing a pinned directory.');
    physical(filename, 'directory');
  }
  for (const [relative, expected] of archive.files) {
    checkAbort(signal); const filename = path.join(directory, ...relative.split('/'));
    if (!fs.existsSync(filename) || physical(filename, 'file').size !== expected.bytes.length) throw tampered('The cached OpenOCD tree is incomplete.');
  }
}
async function pinnedArchive(toolsRoot, descriptor, fetcher, signal) {
  const cache = path.join(toolsRoot, descriptor.archiveName);
  if (fs.existsSync(cache)) {
    physical(cache, 'file'); const bytes = fs.readFileSync(cache); decodeArchive(bytes, descriptor, signal); return bytes;
  }
  if (typeof fetcher !== 'function') throw fault('UPLOADER_MISSING', 'This Node runtime cannot download the pinned Windows OpenOCD tool.');
  const temporary = path.join(toolsRoot, '.pqt-openocd-download-' + crypto.randomUUID() + '.part');
  let fd;
  try {
    checkAbort(signal);
    // GitHub release assets redirect to GitHub's asset host. Authentication is
    // never sent, and the complete payload must match the embedded size/hash.
    const response = await fetcher(descriptor.url, { redirect: 'follow', signal });
    if (!response.ok || !response.body) throw fault('UPLOADER_MISSING', 'The official Windows OpenOCD download failed.');
    const header = response.headers?.get?.('content-length');
    if (header !== null && header !== undefined && Number(header) !== descriptor.sizeBytes) throw invalid('OpenOCD download has an unexpected size.');
    fd = fs.openSync(temporary, 'wx'); let total = 0; const digest = crypto.createHash('sha256');
    for await (const chunk of response.body) {
      checkAbort(signal); const bytes = Buffer.from(chunk); total += bytes.length;
      if (total > descriptor.sizeBytes) throw invalid('OpenOCD download exceeds its pinned archive size.');
      digest.update(bytes); fs.writeSync(fd, bytes);
    }
    checkAbort(signal);
    if (total !== descriptor.sizeBytes || digest.digest('hex') !== descriptor.sha256) throw invalid('OpenOCD download failed its pinned SHA-256 verification.');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const bytes = fs.readFileSync(temporary); decodeArchive(bytes, descriptor, signal);
    if (fs.existsSync(cache)) { physical(cache, 'file'); decodeArchive(fs.readFileSync(cache), descriptor, signal); }
    else {
      try { fs.renameSync(temporary, cache); }
      catch (error) { if (!fs.existsSync(cache)) throw error; physical(cache, 'file'); decodeArchive(fs.readFileSync(cache), descriptor, signal); }
    }
    return bytes;
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(temporary, { force: true }); }
}
async function ensurePinnedZip(toolsRoot, descriptor, { fetch: fetcher = globalThis.fetch, signal } = {}) {
  checkAbort(signal); toolsRoot = path.resolve(toolsRoot); fs.mkdirSync(toolsRoot, { recursive: true }); physical(toolsRoot, 'directory');
  const bytes = await pinnedArchive(toolsRoot, descriptor, fetcher, signal), archive = decodeArchive(bytes, descriptor, signal);
  const directory = path.join(toolsRoot, descriptor.directory);
  if (fs.existsSync(directory)) { verifyTree(directory, archive, signal); return { directory, runtimeVersion: descriptor.runtimeVersion, executable: path.join(directory, 'bin', 'openocd.exe') }; }
  const stage = fs.mkdtempSync(path.join(toolsRoot, '.pqt-openocd-stage-'));
  try {
    for (const name of [...archive.directories].sort((a, b) => a.length - b.length)) { checkAbort(signal); fs.mkdirSync(path.join(stage, ...name.split('/')), { recursive: true }); }
    for (const [name, file] of archive.files) { checkAbort(signal); fs.writeFileSync(path.join(stage, ...name.split('/')), file.bytes, { flag: 'wx' }); }
    verifyTree(stage, archive, signal); checkAbort(signal);
    try { fs.renameSync(stage, directory); }
    catch (error) { if (!fs.existsSync(directory)) throw error; verifyTree(directory, archive, signal); }
    return { directory, runtimeVersion: descriptor.runtimeVersion, executable: path.join(directory, 'bin', 'openocd.exe') };
  } finally {
    // stage was created immediately above as a direct child of toolsRoot.
    if (path.dirname(path.resolve(stage)) !== toolsRoot || !path.basename(stage).startsWith('.pqt-openocd-stage-')) throw invalid('OpenOCD staging cleanup escaped its tools root.');
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
async function ensurePqtOpenocd({ sdkIdentity, toolsRoot, boardOptions, platform = process.platform, arch = process.arch, fetch: fetcher, signal } = {}) {
  if (!needsPqtOpenocd({ sdkIdentity, boardOptions, platform, arch })) return null;
  if (typeof toolsRoot !== 'string' || !path.isAbsolute(toolsRoot)) throw invalid('OpenOCD requires the local application tools directory.');
  return ensurePinnedZip(toolsRoot, PQT_OPENOCD, { fetch: fetcher, signal });
}
module.exports = { PQT_OPENOCD, needsPqtOpenocd, ensurePqtOpenocd, ensurePinnedZip, decodeArchive, crc32 };
