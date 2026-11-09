const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { storageExecutor, observeStorageExecutor } = require('./project-file-lock-owner');
const { MAX_PROJECT_FILE_BYTES, projectFileHash: hash, projectFileFault: fault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock } = require('./project-file-access');

const PROJECT_SYNC_STORAGE_VERSION = 2;
const mirrors = new Set(['project.abi', 'project.abs', 'project.abs.map.json']);
const readOnlyInputs = new Set(['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock']);
const readableFiles = new Set([...mirrors, ...readOnlyInputs]);
const baseline = /^baselines\/[A-Za-z0-9_-]{1,96}\.json$/;
const recovery = /^recoveries\/[A-Za-z0-9_-]{1,96}\.json$/;
const metadata = new Set(['operation.json', 'lineage.json']);
const historyObject = /^history-objects\/([a-f0-9]{64})$/;
const historyHash = key => {
  const match = typeof key === 'string' ? historyObject.exec(key) : null;
  return match && match[0] === key ? match[1] : null;
};

/** A project-bound, revocable host capability, not an IPC lock token or a second transaction engine. */
async function openProjectSyncStorage(projectPath, assertCurrent, options = {}) {
  const files = options.files || fs;
  const guard = projectFileGuard(assertCurrent);
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw fault('PROJECT_FILE_INVALID', 'Expected an absolute project path.');
  guard();
  const root = await files.promises.realpath(projectPath);
  guard();
  const access = createProjectFileAccess(root, projectPath, files);
  const executor = storageExecutor();
  const directories = [path.join(root, '.aily'), path.join(root, '.aily', 'abs-sync')];
  const locate = (key, create = false) => {
    const objectHash = historyHash(key);
    if (typeof key !== 'string' || !(objectHash || readableFiles.has(key) || metadata.has(key) || key === 'prepared.json' || key === 'committed.json' || baseline.test(key) || recovery.test(key))) {
      throw fault('ABS_STORAGE_KEY_INVALID', 'Unsupported ABS sync storage key.');
    }
    if (objectHash && create) throw fault('ABS_STORAGE_WRITE_INVALID', 'History objects are read-only through sync storage.');
    access.checkRoot();
    if (readableFiles.has(key)) return path.join(root, key);
    const parents = objectHash ? [path.join(root, '.workspace-history'), path.join(root, '.workspace-history', 'objects'),
      path.join(root, '.workspace-history', 'objects', objectHash.slice(0, 2))] : baseline.test(key) || recovery.test(key)
      ? [...directories, path.join(directories[1], key.split('/')[0])] : directories;
    for (const directory of parents) {
      if (create) {
        try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      try { access.checkDirectory(directory); }
      catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    }
    return objectHash ? path.join(parents[2], objectHash + '.blob') : path.join(directories[1], ...key.split('/'));
  };
  const readBytes = key => {
    const file = locate(key);
    if (file === null) return null;
    const bytes = access.readRegular(file);
    if (historyHash(key)) {
      guard();
      if (locate(key) !== file) throw fault('PROJECT_FILE_UNSAFE_PATH', 'History object ancestry changed during its read.');
    }
    return bytes;
  };
  const readText = key => {
    const bytes = readBytes(key);
    if (bytes === null) return null;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw fault('ABS_STORAGE_ENCODING_INVALID', 'Sync files must contain exact UTF-8; invalid bytes were retained.');
    return text;
  };
  return {
    attachment: access.attachment,
    executor,
    observeExecutor: async original => {
      guard(); access.checkRoot();
      const result = observeStorageExecutor(original, executor);
      guard(); return result;
    },
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
        if (historyHash(key)) throw fault('ABS_STORAGE_WRITE_INVALID', 'History objects are read-only through sync storage.');
        // Validate keys even for no-op/delete requests. Baselines are append-only;
        // only the prepared journal may be deleted by the sync protocol.
        locate(key);
        if (readOnlyInputs.has(key) || !(expectedHash === null || /^sha256:[a-f0-9]{64}$/.test(expectedHash))
          || !(content === null || typeof content === 'string')
          || (content === null && key !== 'prepared.json' && key !== 'operation.json')
          || ((baseline.test(key) || recovery.test(key)) && expectedHash !== null)) {
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
        attachment: access.attachment,
        executor,
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
  // Error custom properties are stripped by contextBridge. Recovery codes cross
  // as plain data, including scoped reads/writes and failures acquiring a lock.
  const resultOf = async operation => {
    try { return { ok: true, value: await operation() }; }
    catch (error) { return { ok: false, error: {
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
      message: error instanceof Error ? error.message : String(error),
    } }; }
  };
  const withBridgeLock = (operation, typed) => storage.withLock(locked => new Promise((resolve, reject) => {
      const settle = result => {
        if (result?.ok === true) resolve(result.value);
        else if (result?.ok === false && typeof result.error?.message === 'string') {
          reject(fault(typeof result.error.code === 'string' ? result.error.code : 'ABS_STORAGE_OPERATION_FAILED', result.error.message));
        } else reject(fault('ABS_STORAGE_RESULT_INVALID', 'Invalid renderer operation settlement.'));
      };
      try {
        if (typeof operation !== 'function') throw fault('ABS_STORAGE_OPERATION_INVALID', 'Expected a renderer callback.');
        const scoped = typed ? { ...locked, readResult: key => resultOf(() => locked.read(key)),
          replaceResult: (...args) => resultOf(() => locked.replace(...args)) } : locked;
        const returned = operation(scoped, settle);
        if (returned !== undefined) {
          if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
          reject(fault('ABS_STORAGE_OPERATION_INVALID', 'Bridge callbacks must return void and settle explicitly.'));
        }
      } catch (error) { reject(error); }
    }));
  return {
    attachment: storage.attachment,
    executor: storage.executor,
    observeExecutor: original => storage.observeExecutor(original),
    observeExecutorResult: original => resultOf(() => storage.observeExecutor(original)),
    read: key => storage.read(key),
    withLock: operation => withBridgeLock(operation, false),
    readResult: key => resultOf(() => storage.read(key)),
    withLockResult: operation => resultOf(() => withBridgeLock(operation, true)),
  };
}

module.exports = { openProjectSyncStorage, openProjectSyncStorageBridge, PROJECT_SYNC_STORAGE_VERSION };
