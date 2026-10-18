'use strict';

// 传输用的库内容键只包含相对路径、大小和内容摘要，相同库跨项目只上传缺失内容。
// 编译器、开发板与编译选项仍由 Builder 独立纳入编译缓存键，不能混用不兼容的 .a。
const protocol = require('./protocol');
const POLICY = 'sha256-relative-tree-v1';
const KIND = 'aily-cloud-input-manifest';
const fail = (code, message) => Object.assign(new Error(message || code), { code });
const check = (ok, code = 'INVALID_INPUT_MANIFEST') => { if (!ok) throw fail(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const closed = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function safePath(value) {
  protocol.validateRelativePath(value);
  check(value.length <= 240, 'INVALID_SNAPSHOT_PATH');
  return value;
}
function libraryContentKey(files, root) {
  safePath(root);
  const selected = files.filter(file => file.path.startsWith(root + '/')).map(file => ({
    path: file.path.slice(root.length + 1), sizeBytes: file.sizeBytes, sha256: file.sha256
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  check(selected.length > 0, 'INVALID_LIBRARY');
  for (const file of selected) { safePath(file.path); check(integer(file.sizeBytes) && hash(file.sha256)); }
  return protocol.sha256(protocol.canonicalJson({ schemaVersion: 1, policy: POLICY, files: selected }));
}
function toManifest(snapshot) {
  const identity = { ...protocol.snapshotBody(snapshot), inputDigest: snapshot.inputDigest };
  const manifest = { schemaVersion: 1, kind: KIND, snapshot: identity,
    libraryKeys: identity.libraries.map(library => ({ name: library.name, root: library.root, key: libraryContentKey(identity.files, library.root) })) };
  validateManifest(manifest);
  return manifest;
}
function validateManifest(manifest, limits = {}) {
  check(closed(manifest, ['schemaVersion', 'kind', 'snapshot', 'libraryKeys']) && manifest.schemaVersion === 1 && manifest.kind === KIND);
  const s = manifest.snapshot;
  check(closed(s, ['schemaVersion','kind','mode','boardModule','boardVersion','boardDigest','entry','boardOptions','macros','libraries','files','inputDigest'])
    && s.schemaVersion === 1 && s.kind === 'aily-cloud-build-input' && ['blockly', 'coder'].includes(s.mode));
  check(/^@[^/\\]+\/(?:board|coder)-[A-Za-z0-9_.-]+$/.test(s.boardModule || '')
    && typeof s.boardVersion === 'string' && s.boardVersion.length > 0 && s.boardVersion.length <= 100 && hash(s.boardDigest));
  safePath(s.entry); check(/\.(?:ino|cpp)$/i.test(s.entry));
  check(plain(s.boardOptions) && Object.keys(s.boardOptions).length <= 64
    && Object.entries(s.boardOptions).every(([key, value]) => /^[A-Za-z0-9_.-]{1,100}$/.test(key) && typeof value === 'string'
      && value.length <= 256 && !/[\x00-\x1f]/.test(value)));
  check(Array.isArray(s.macros) && s.macros.length <= 256);
  for (const macro of s.macros) {
    // 保留宏的顺序和有意重复的 -D 名称，传输层不能改变实际编译语义。
    check(closed(macro, ['name','value']) && /^[A-Za-z_]\w{0,127}$/.test(macro.name || '')
      && typeof macro.value === 'string' && macro.value.length <= 4096 && !/[\x00\r\n]/.test(macro.value));
  }
  const maxFiles = limits.maxFiles ?? 4096, maxBytes = limits.maxInputBytes ?? 128 * 1024 * 1024, maxFile = limits.maxFileBytes ?? maxBytes;
  check(integer(maxFiles) && integer(maxBytes) && integer(maxFile));
  check(Array.isArray(s.files) && s.files.length > 0 && s.files.length <= maxFiles);
  const blobs = new Map(), paths = [], originalPaths = new Set(); let totalBytes = 0;
  for (const file of s.files) {
    check(closed(file, ['path','sizeBytes','sha256'])); safePath(file.path);
    check(integer(file.sizeBytes) && file.sizeBytes <= maxFile && hash(file.sha256));
    const normalized = file.path.toLowerCase(); paths.push(normalized); originalPaths.add(file.path);
    const previous = blobs.get(file.sha256); check(!previous || previous.sizeBytes === file.sizeBytes, 'INPUT_HASH_MISMATCH');
    blobs.set(file.sha256, { sha256: file.sha256, sizeBytes: file.sizeBytes });
    totalBytes += file.sizeBytes; check(totalBytes <= maxBytes, 'INPUT_CAPACITY_EXCEEDED');
  }
  // 排序后检查重名及文件/目录冲突，避免对每个文件重新扫描整个清单。
  paths.sort(); const pathSet = new Set();
  for (const name of paths) {
    check(!pathSet.has(name), 'INVALID_SNAPSHOT_PATH');
    const parts = name.split('/'); let ancestor = '';
    for (let i = 0; i < parts.length - 1; i++) { ancestor += (i ? '/' : '') + parts[i]; check(!pathSet.has(ancestor), 'INVALID_SNAPSHOT_PATH'); }
    pathSet.add(name);
  }
  check(originalPaths.has(s.entry), 'INVALID_INPUT_MANIFEST');
  check(Array.isArray(s.libraries) && s.libraries.length <= 512);
  const roots = new Set(), keys = [];
  for (const library of s.libraries) {
    check(closed(library, ['name','root']) && typeof library.name === 'string' && library.name.length > 0 && library.name.length <= 256
      && !/[\x00-\x1f]/.test(library.name)); safePath(library.root);
    check(!roots.has(library.root.toLowerCase()), 'INVALID_LIBRARY'); roots.add(library.root.toLowerCase());
    keys.push({ name: library.name, root: library.root, key: libraryContentKey(s.files, library.root) });
  }
  check(Array.isArray(manifest.libraryKeys) && protocol.canonicalJson(manifest.libraryKeys) === protocol.canonicalJson(keys), 'LIBRARY_CONTENT_KEY_MISMATCH');
  check(hash(s.inputDigest) && protocol.snapshotDigest(s) === s.inputDigest, 'INPUT_DIGEST_MISMATCH');
  const files = [...blobs.values()];
  return { snapshot: s, files, libraryKeys: keys, totalBytes, uniqueBytes: files.reduce((n, file) => n + file.sizeBytes, 0), fileCount: s.files.length };
}
function blobRecords(snapshot, missing) {
  check(Array.isArray(missing) && missing.length <= 4096);
  const selected = new Map(snapshot.files.map(file => [file.sha256, file])), seen = new Set();
  return missing.map(file => {
    check(closed(file, ['sha256','sizeBytes']) && hash(file.sha256) && integer(file.sizeBytes) && !seen.has(file.sha256), 'INVALID_INPUT_BLOB');
    const source = selected.get(file.sha256); check(source && source.sizeBytes === file.sizeBytes && typeof source.dataBase64 === 'string', 'INPUT_HASH_MISMATCH');
    seen.add(file.sha256); return { sha256: file.sha256, sizeBytes: file.sizeBytes, dataBase64: source.dataBase64 };
  });
}
module.exports = { toManifest, blobRecords };
