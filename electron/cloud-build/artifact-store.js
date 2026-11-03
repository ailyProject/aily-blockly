'use strict';
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('./protocol');
// 只管理项目内带归属标记的云产物；清理前验证路径、链接和工作区锁，保护用户文件。
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const { acquireBuildWorkspace } = require(path.join(childRoot, 'scripts/build-workspace-lease'));
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const PUBLISHED = new RegExp(`^([A-Za-z0-9_-]{1,128})-${UUID}$`, 'u');
const STAGING = new RegExp(`^cloud-import-${UUID}$`, 'u');
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
function physicalDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync(directory)) !== normalized(directory)) throw protocol.error('UNSAFE_PATH', 'Cloud artifact directory is linked.');
  return stat;
}
function ownedLocation(root, directory) {
  root = fs.realpathSync(root);
  const absolute = path.resolve(directory), relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw protocol.error('UNSAFE_PATH', 'Cloud cleanup escaped its project.');
  const parts = relative.split(path.sep);
  if (!(parts.length === 3 && parts[0] === '.build' && parts[1] === 'cloud' && PUBLISHED.test(parts[2]))
      && !(parts.length === 2 && parts[0] === '.temp' && STAGING.test(parts[1]))) throw protocol.error('UNSAFE_PATH', 'Cloud cleanup requires an owned artifact directory.');
  physicalDirectory(root);
  let current = root;
  for (const part of parts) { current = path.join(current, part); physicalDirectory(current); }
  return absolute;
}
function readMarker(directory, filename) {
  const file = path.join(directory, filename), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024) throw protocol.error('UNSAFE_PATH', 'Unsafe cloud cleanup marker.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function isOwned(directory, staging) {
  try {
    const marker = readMarker(directory, 'aily-cloud-import.json');
    if (marker.schemaVersion === 1 && marker.kind === 'aily-cloud-owned-directory') return true;
  } catch { /* 已发布目录也可通过结果标记确认归属。 */ }
  if (staging) return false;
  try {
    const result = readMarker(directory, 'aily-cloud-result.json'), match = PUBLISHED.exec(path.basename(directory));
    return result.manifest?.kind === 'aily-cloud-build-result' && result.manifest.schemaVersion === 1 && result.manifest.jobId === match?.[1];
  } catch { return false; }
}
function treeBytes(directory) {
  let count = 0, bytes = 0;
  const walk = folder => {
    physicalDirectory(folder);
    for (const item of fs.readdirSync(folder)) {
      if (++count > 16384) throw protocol.error('UNSAFE_PATH', 'Cloud cleanup inventory exceeds its limit.');
      const filename = path.join(folder, item), stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) throw protocol.error('UNSAFE_PATH', 'Cloud cleanup does not follow links.');
      if (stat.isDirectory()) walk(filename);
      else if (stat.isFile()) bytes += stat.size;
      else throw protocol.error('UNSAFE_PATH', 'Unexpected cloud artifact entry.');
    }
  };
  walk(directory); return bytes;
}
function removeOwnedDirectory(root, directory, lease) {
  const absolute = ownedLocation(root, directory);
  if (!isOwned(absolute, path.basename(path.dirname(absolute)) === '.temp')) return false;
  const before = physicalDirectory(absolute);
  treeBytes(absolute);
  lease?.assertOwned();
  ownedLocation(root, absolute);
  const after = physicalDirectory(absolute);
  if (before.dev !== after.dev || before.ino !== after.ino) throw protocol.error('UNSAFE_PATH', 'Cloud artifact directory changed during cleanup.');
  fs.rmSync(absolute, { recursive: true, force: false });
  return true;
}
/** 按数量、大小和最后修改时间回收云产物；磁盘结果记录本身不赋予复用或烧录权限。 */
function collectCloudArtifacts(root, options = {}) {
  const protectedDirectories = new Set((options.protectedDirectories || []).map(value => normalized(path.resolve(value))));
  const retention = { maxDirectories: 2, maxBytes: 128 * 1024 * 1024, maxAgeMs: 30 * 86400000,
    stagingMaxAgeMs: 86400000, ...(options.retention || {}) };
  const now = options.now ?? Date.now();
  const lease = options.lease || acquireBuildWorkspace(root, 'clean');
  const removed = [];
  try {
    lease.assertOwned();
    const inventory = [];
    const directory = path.join(fs.realpathSync(root), '.build', 'cloud');
    if (fs.existsSync(directory)) {
      physicalDirectory(directory);
      for (const name of fs.readdirSync(directory)) {
        if (!PUBLISHED.test(name)) continue;
        const candidate = path.join(directory, name);
        try {
          ownedLocation(root, candidate);
          if (!isOwned(candidate, false)) continue;
          const stat = physicalDirectory(candidate);
          inventory.push({ directory: candidate, bytes: treeBytes(candidate), modified: stat.mtimeMs,
            protected: protectedDirectories.has(normalized(candidate)) });
        } catch { /* 无法识别或含链接的目录不能遍历、删除。 */ }
      }
    }
    let retained = inventory.filter(item => item.protected).length;
    let retainedBytes = inventory.filter(item => item.protected).reduce((sum, item) => sum + item.bytes, 0);
    for (const item of inventory.filter(item => !item.protected).sort((a, b) => b.modified - a.modified || a.directory.localeCompare(b.directory))) {
      if (now - item.modified <= retention.maxAgeMs && retained < retention.maxDirectories && retainedBytes + item.bytes <= retention.maxBytes) {
        retained++; retainedBytes += item.bytes; continue;
      }
      if (removeOwnedDirectory(root, item.directory, lease)) removed.push(item.directory);
    }
    const temporary = path.join(fs.realpathSync(root), '.temp');
    if (fs.existsSync(temporary)) {
      physicalDirectory(temporary);
      for (const name of fs.readdirSync(temporary)) {
        if (!STAGING.test(name)) continue;
        const candidate = path.join(temporary, name);
        if (protectedDirectories.has(normalized(candidate))) continue;
        try {
          ownedLocation(root, candidate);
          // 其他应用实例可能还在下载，暂存目录仅在所属进程退出后清理。
          // 此 PID 检查只用于下载暂存区，不能据此回收含编译子进程的工作区锁。
          const marker = readMarker(candidate, 'aily-cloud-import.json');
          if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) continue;
          let alive = true;
          try { process.kill(marker.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
          if (alive) continue;
          if (now - physicalDirectory(candidate).mtimeMs >= retention.stagingMaxAgeMs && removeOwnedDirectory(root, candidate, lease)) removed.push(candidate);
        } catch { /* 无法确认归属或状态时保留现场。 */ }
      }
    }
    return removed;
  } finally { if (!options.lease) lease.release(); }
}
module.exports = { collectCloudArtifacts, removeOwnedDirectory };
