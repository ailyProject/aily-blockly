const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { rootAttachment, acquirePublicationLock } = require('./project-file-lock-owner');
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
  // The JS resolver lstats every ancestor on every guard. Keep the same physical
  // path checks, using the native resolver (also used by fs.promises.realpath).
  // Injected/older file systems may only provide the ordinary synchronous API.
  const realpath = files.realpathSync.native || files.realpathSync;
  const identities = new Map();

  const checkDirectory = directory => {
    const stat = files.lstatSync(directory);

    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (identities.has(directory) && !sameFile(identities.get(directory), stat))) {
      const subject = directory === root ? 'Project root' : 'Project storage path';

      const reason = stat.isSymbolicLink() ? 'is a symbolic link'
        : !stat.isDirectory() ? 'is not a directory' : 'identity changed during publication';

      throw projectFileFault('PROJECT_FILE_UNSAFE_PATH', `${subject} ${reason}.`);
    }

    identities.set(directory, stat);

    return stat;
  };

  checkDirectory(root);
  const attachment = rootAttachment(root, files);

  const checkRoot = () => {
    checkDirectory(root);
    if (attachment && JSON.stringify(rootAttachment(root, files)) !== JSON.stringify(attachment)) {
      throw projectFileFault('PROJECT_FILE_UNSAFE_PATH', 'Project physical attachment changed during publication.');
    }

    if (realpath(projectPath) !== root || realpath(root) !== root) {
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

  return { root, files, checkRoot, checkDirectory, readRegular, attachment };
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

/** Native recovery arbitration plus the legacy marker exclusion point. */
async function acquireProjectFileLock(access, guard, timeoutMs = 5000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw projectFileFault('PROJECT_FILE_INVALID', 'Invalid lock timeout.');
  return acquirePublicationLock(access, guard, timeoutMs);
}

module.exports = { MAX_PROJECT_FILE_BYTES, projectFileHash, projectFileFault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration };
