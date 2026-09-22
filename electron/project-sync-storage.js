const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_PROJECT_FILE_BYTES, projectFileHash: hash, projectFileFault: fault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock } = require('./project-file-access');

const PROJECT_SYNC_STORAGE_VERSION = 2;
const mirrors = new Set(['project.abi', 'project.abs', 'project.abs.map.json']);
const baseline = /^baselines\/[A-Za-z0-9_-]{1,96}\.json$/;

/** A project-bound, revocable host capability, not an IPC lock token or a second transaction engine. */
async function openProjectSyncStorage(projectPath, assertCurrent, options = {}) {
  const files = options.files || fs;
  const guard = projectFileGuard(assertCurrent);
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw fault('PROJECT_FILE_INVALID', 'Expected an absolute project path.');
  guard();
  const root = await files.promises.realpath(projectPath);
  guard();
  const access = createProjectFileAccess(root, projectPath, files);
  const directories = [path.join(root, '.aily'), path.join(root, '.aily', 'abs-sync')];
  const locate = (key, create = false) => {
    if (typeof key !== 'string' || !(mirrors.has(key) || key === 'prepared.json' || key === 'committed.json' || baseline.test(key))) {
      throw fault('ABS_STORAGE_KEY_INVALID', 'Unsupported ABS sync storage key.');
    }
    access.checkRoot();
    if (mirrors.has(key)) return path.join(root, key);
    const parents = baseline.test(key) ? [...directories, path.join(directories[1], 'baselines')] : directories;
    for (const directory of parents) {
      if (create) {
        try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      try { access.checkDirectory(directory); }
      catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    }
    return path.join(directories[1], ...key.split('/'));
  };
  const readBytes = key => {
    const file = locate(key);
    return file === null ? null : access.readRegular(file);
  };
  const readText = key => {
    const bytes = readBytes(key);
    if (bytes === null) return null;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw fault('ABS_STORAGE_ENCODING_INVALID', 'Sync files must contain exact UTF-8; invalid bytes were retained.');
    return text;
  };
  return {
    read: async key => { guard(); return readText(key); },
    withLock: async operation => {
      if (typeof operation !== 'function') throw fault('ABS_STORAGE_OPERATION_INVALID', 'Expected a scoped storage operation.');
      const lock = await acquireProjectFileLock(access, guard, options.timeoutMs);
      let active = true;
      const pending = new Set();
      const check = () => {
        if (!active) throw fault('ABS_STORAGE_SCOPE_CLOSED', 'Storage write capability has expired.');
        guard(); lock.assertOwned();
      };
      const replace = async (key, expectedHash, content) => {
        check();
        // Validate keys even for no-op/delete requests. Baselines are append-only;
        // only the prepared journal may be deleted by the sync protocol.
        locate(key);
        if (!(expectedHash === null || /^sha256:[a-f0-9]{64}$/.test(expectedHash))
          || !(content === null || typeof content === 'string')
          || (content === null && key !== 'prepared.json')
          || (baseline.test(key) && expectedHash !== null)) {
          throw fault('ABS_STORAGE_WRITE_INVALID', 'Invalid conditional sync write or immutable baseline mutation.');
        }
        const bytes = content === null ? null : Buffer.from(content, 'utf8');
        if (bytes && bytes.length > MAX_PROJECT_FILE_BYTES) throw fault('PROJECT_FILE_TOO_LARGE', 'Sync file exceeds the 128 MiB publication limit.');
        const before = readBytes(key);
        if (hash(before) !== expectedHash) return false;
        if (bytes === null && before === null || bytes !== null && before?.equals(bytes)) return true;
        const target = locate(key, true);
        let temporary;
        let owned = false;
        let attempted = false;
        try {
          if (bytes !== null) {
            temporary = path.join(path.dirname(target), `.abs-sync-${randomUUID()}.tmp`);
            const handle = await files.promises.open(temporary, 'wx', 0o600);
            owned = true;
            try { check(); await handle.writeFile(bytes); await handle.sync(); }
            finally { await handle.close(); }
          }
          // No await from the final renderer guard/physical identity/CAS to rename.
          check(); locate(key);
          if (hash(readBytes(key)) !== expectedHash) return false;
          attempted = true;
          if (bytes === null) files.unlinkSync(target);
          else { files.renameSync(temporary, target); owned = false; }
          if (hash(readBytes(key)) !== hash(bytes)) throw fault('ABS_COMMIT_UNCERTAIN', 'Sync bytes changed during publication.');
          return true;
        } catch (error) {
          if (attempted) {
            try {
              const actual = hash(readBytes(key));
              if (actual === hash(bytes)) return true;
              if (actual !== expectedHash) throw fault('ABS_COMMIT_UNCERTAIN', 'Sync publication outcome is unknown; retain the recovery journal.');
            } catch (inspectionError) { throw fault('ABS_COMMIT_UNCERTAIN', inspectionError.message); }
          }
          throw error;
        } finally {
          if (owned) {
            // Never clean by an old path after root/internal directory replacement.
            locate(key);
            try { files.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
      };
      const scoped = {
        read: async key => { check(); return readText(key); },
        replace: (...args) => {
          const result = replace(...args);
          pending.add(result);
          result.then(() => pending.delete(result), () => pending.delete(result));
          return result;
        },
      };
      try {
        check();
        const result = await operation(scoped);
        check();
        return result;
      } finally {
        active = false;
        // An unawaited callback write must finish (or fail its revoked guard)
        // before another process may acquire this lock.
        await Promise.allSettled([...pending]);
        const warnings = lock.release();
        if (warnings.length) throw fault('ABS_COMMIT_UNCERTAIN', warnings.join('; '));
      }
    },
  };
}

/** contextBridge recognizes native Promise, not Angular's ZoneAwarePromise returned
 * by renderer callbacks. Settlement crosses explicitly; no Promise object is cloned.
 */
async function openProjectSyncStorageBridge(projectPath, assertCurrent, options) {
  const storage = await openProjectSyncStorage(projectPath, assertCurrent, options);
  return {
    read: key => storage.read(key),
    withLock: operation => storage.withLock(locked => new Promise((resolve, reject) => {
      const settle = result => {
        if (result?.ok === true) resolve(result.value);
        else if (result?.ok === false && typeof result.error?.message === 'string') {
          reject(fault(typeof result.error.code === 'string' ? result.error.code : 'ABS_STORAGE_OPERATION_FAILED', result.error.message));
        } else reject(fault('ABS_STORAGE_RESULT_INVALID', 'Invalid renderer operation settlement.'));
      };
      try {
        if (typeof operation !== 'function') throw fault('ABS_STORAGE_OPERATION_INVALID', 'Expected a renderer callback.');
        const returned = operation(locked, settle);
        if (returned !== undefined) {
          if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
          reject(fault('ABS_STORAGE_OPERATION_INVALID', 'Bridge callbacks must return void and settle explicitly.'));
        }
      } catch (error) { reject(error); }
    })),
  };
}

module.exports = { openProjectSyncStorage, openProjectSyncStorageBridge, PROJECT_SYNC_STORAGE_VERSION };
