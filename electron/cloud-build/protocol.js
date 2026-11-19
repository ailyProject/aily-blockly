'use strict';

const crypto = require('node:crypto');
// 统一快照格式、路径限制、摘要和结果验签，保证本地与网关计算的是同一份输入。
const MAX_FILES = 4096;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const error = (code, message) => Object.assign(new Error(message), { code });
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw error('INVALID_INPUT', 'Non-finite number.');
  return value;
}
const canonicalJson = value => JSON.stringify(canonicalize(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value !== value.normalize('NFC')
      || value.startsWith('/') || /[\\\x00-\x1f<>:"|?*]/u.test(value)) throw error('UNSAFE_PATH', 'Unsafe build file path.');
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw error('UNSAFE_PATH', 'Unsafe build file path.');
  return value;
}
function snapshotBody(snapshot) {
  return {
    schemaVersion: 1, kind: 'aily-cloud-build-input', mode: snapshot.mode,
    boardModule: snapshot.boardModule, boardVersion: snapshot.boardVersion, boardDigest: snapshot.boardDigest,
    entry: snapshot.entry, boardOptions: snapshot.boardOptions || {}, macros: snapshot.macros || [],
    libraries: snapshot.libraries || [],
    files: (snapshot.files || []).map(({ path, sha256, sizeBytes }) => ({ path, sha256, sizeBytes }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
}
const snapshotDigest = snapshot => sha256(canonicalJson(snapshotBody(snapshot)));
// 捕获阶段已读取并哈希实际文件；此处验证清单与身份，避免重复读取和编码源码。
function inputLimits(limits = {}) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw error('INVALID_INPUT_LIMITS', 'Invalid cloud input limits.');
  const ceilings = { maxFiles: MAX_FILES, maxInputBytes: MAX_INPUT_BYTES, maxFileBytes: MAX_BYTES };
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const value = Object.hasOwn(limits, key) ? limits[key] : ceiling;
    if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_INPUT_LIMITS', 'Invalid cloud input limit: ' + key);
    return [key, Math.min(value, ceiling)];
  }));
}
function validateSnapshot(snapshot, limits = {}) {
  const budget = inputLimits(limits);
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.kind !== 'aily-cloud-build-input'
      || !['blockly', 'coder'].includes(snapshot.mode)
      || !/^@[^/\\]+\/(?:board|coder)-[A-Za-z0-9_.-]+$/u.test(snapshot.boardModule || '')
      || typeof snapshot.boardVersion !== 'string' || snapshot.boardVersion.length > 100
      || !/^[a-f0-9]{64}$/u.test(snapshot.boardDigest || '')
      || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > budget.maxFiles) {
    throw error('INVALID_INPUT', 'Invalid cloud build snapshot.');
  }
  validateRelativePath(snapshot.entry);
  if (!snapshot.boardOptions || typeof snapshot.boardOptions !== 'object' || Array.isArray(snapshot.boardOptions)
      || Object.keys(snapshot.boardOptions).length > 64
      || Object.entries(snapshot.boardOptions).some(([key, value]) => !/^[A-Za-z0-9_.-]{1,100}$/u.test(key)
        || typeof value !== 'string' || value.length > 256 || /[\x00-\x1f]/u.test(value))) {
    throw error('INVALID_INPUT', 'Invalid board options.');
  }
  if (!Array.isArray(snapshot.macros) || snapshot.macros.length > 256 || snapshot.macros.some(item =>
    !/^[A-Za-z_]\w{0,127}$/u.test(item?.name || '') || typeof item.value !== 'string' || item.value.length > 4096
      || /[\x00\r\n]/u.test(item.value))) throw error('INVALID_INPUT', 'Invalid build macros.');
  if (!Array.isArray(snapshot.libraries) || snapshot.libraries.length > 512 || snapshot.libraries.some(item =>
    typeof item?.name !== 'string' || !item.name || item.name.length > 256 || !validateRelativePath(item.root))) {
    throw error('INVALID_INPUT', 'Invalid library roots.');
  }
  const seen = new Set();
  let sizeBytes = 0;
  for (const file of snapshot.files) {
    validateRelativePath(file?.path);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > budget.maxFileBytes
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw error('INVALID_INPUT', 'Invalid build file identity.');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw error('UNSAFE_PATH', 'Duplicate build file path.');
    seen.add(key);
    sizeBytes += file.sizeBytes;
    if (sizeBytes > budget.maxInputBytes) throw error('INPUT_TOO_LARGE', 'Build input exceeds its byte budget.');
  }
  if (!snapshot.files.some(file => file.path === snapshot.entry)) throw error('INVALID_INPUT', 'Build entry is missing.');
  for (const library of snapshot.libraries) {
    if (!snapshot.files.some(file => file.path.startsWith(`${library.root}/`))) throw error('INVALID_INPUT', 'Library root has no captured content.');
  }
  const digest = snapshotDigest(snapshot);
  if (snapshot.inputDigest !== digest) throw error('INPUT_DIGEST_MISMATCH', 'Build snapshot identity does not match its content.');
  return { digest, sizeBytes, fileCount: snapshot.files.length };
}
function boardDigest(boardPackage, boardJson) { return sha256(canonicalJson({ package: boardPackage, board: boardJson })); }
function verifyManifest(manifest, signature, publicKey) {
  if (signature?.algorithm !== 'Ed25519' || typeof signature.value !== 'string' || typeof publicKey !== 'string') {
    throw error('SIGNATURE_INVALID', 'Missing cloud result signature.');
  }
  const key = crypto.createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(canonicalJson(manifest)), key, Buffer.from(signature.value, 'base64'))) {
    throw error('SIGNATURE_INVALID', 'Cloud result signature is invalid.');
  }
  return true;
}

module.exports = { MAX_FILES, MAX_BYTES, MAX_INPUT_BYTES, inputLimits, error, canonicalJson, sha256, validateRelativePath,
  snapshotBody, snapshotDigest, validateSnapshot, boardDigest, verifyManifest };
