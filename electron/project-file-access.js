const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_PROJECT_FILE_BYTES = 128 * 1024 * 1024;
const projectFileHash = value => value === null ? null : `sha256:${createHash('sha256').update(value).digest('hex')}`;
const projectFileFault = (code, message) => Object.assign(new Error(message), { code });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function projectFileGuard(assertCurrent) {
  return () => {
    if (typeof assertCurrent !== 'function') throw projectFileFault('PROJECT_FILE_GUARD_REQUIRED', 'A synchronous context guard is required.');
    const value = assertCurrent();
    if (value !== undefined) {
      if (value && typeof value.catch === 'function') value.catch(() => undefined);
      throw projectFileFault('PROJECT_FILE_GUARD_REQUIRED', 'The context guard must be synchronous and return void.');
    }
  };
}

/** Physical project identity and regular-file checks, shared by all host publications. */
function createProjectFileAccess(root, projectPath, files = fs) {
  const identities = new Map();
  const checkDirectory = directory => {
    const stat = files.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (identities.has(directory) && !sameFile(identities.get(directory), stat))) {
      throw projectFileFault('PROJECT_FILE_UNSAFE_PATH', 'Project storage directory identity changed or is linked.');
    }
    identities.set(directory, stat);
    return stat;
  };
  checkDirectory(root);
  const checkRoot = () => {
    checkDirectory(root);
    if (files.realpathSync(projectPath) !== root || files.realpathSync(root) !== root) {
      throw projectFileFault('PROJECT_FILE_UNSAFE_PATH', 'Project root identity changed during publication.');
    }
  };
  const readRegular = file => {
    checkRoot();
    try {
      const stat = files.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw projectFileFault('PROJECT_FILE_UNSAFE_PATH', 'Project files must be regular, unlinked files.');
      if (stat.size > MAX_PROJECT_FILE_BYTES) throw projectFileFault('PROJECT_FILE_TOO_LARGE', 'Project file exceeds the 128 MiB publication limit.');
      return files.readFileSync(file);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return { root, files, checkRoot, checkDirectory, readRegular };
}

/** A pending generation is a durable write barrier, not just an in-process lock. */
function assertNoPendingAbsGeneration(access) {
  access.checkRoot();
  for (const directory of [path.join(access.root, '.aily'), path.join(access.root, '.aily', 'abs-sync')]) {
    try { access.checkDirectory(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
  try { access.files.lstatSync(path.join(access.root, '.aily', 'abs-sync', 'prepared.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw projectFileFault('ABS_TRANSACTION_PENDING', 'An ABS generation is pending. Recover or explicitly abandon it before publishing project files.');
}

/** Project File Lock v1. No nested acquisition, timeout takeover, or automatic stale-lock removal. */
async function acquireProjectFileLock(access, guard, timeoutMs = 5000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw projectFileFault('PROJECT_FILE_INVALID', 'Invalid lock timeout.');
  const { root, files, checkRoot, checkDirectory } = access;
  const directory = path.join(root, '.aily');
  const lockPath = path.join(directory, 'project-files.write.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  guard(); checkRoot();
  try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  checkDirectory(directory);
  const deadline = Date.now() + timeoutMs;
  let lock;
  while (lock === undefined) {
    guard(); checkRoot(); checkDirectory(directory);
    try { lock = files.openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw projectFileFault('PROJECT_FILE_BUSY', 'Project writer lock is busy. Abandoned locks require explicit owner verification; no automatic takeover.');
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  // Compare path identity with the same API throughout. On this Windows Electron
  // runtime lstat.dev is 0 but fstat.dev is the volume id. The exclusive open,
  // path inode and unpredictable owner bytes together establish ownership.
  let identity;
  try { identity = files.lstatSync(lockPath); }
  catch (error) { files.closeSync(lock); throw error; } // Retain an unverified lock.
  const assertOwned = () => {
    checkRoot(); checkDirectory(directory);
    const current = files.lstatSync(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !sameFile(identity, current)
      || files.readFileSync(lockPath, 'utf8') !== owner) {
      throw projectFileFault('PROJECT_FILE_LOCK_CHANGED', 'Project lock ownership changed; retained the lock.');
    }
  };
  const release = () => {
    const warnings = [];
    try { files.closeSync(lock); } catch (error) { warnings.push(error.message); }
    try { assertOwned(); files.unlinkSync(lockPath); } catch (error) { warnings.push(error.message); }
    return warnings;
  };
  try { files.writeFileSync(lock, owner, 'utf8'); }
  catch (error) { release(); throw error; }
  return { assertOwned, release };
}

module.exports = { MAX_PROJECT_FILE_BYTES, projectFileHash, projectFileFault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration };
