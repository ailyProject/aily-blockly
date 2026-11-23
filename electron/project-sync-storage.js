const fs = require('node:fs');
const { decodeHistoryAbs } = require('./history-abs-object');
const { readSaveSnapshot } = require('./project-save-snapshot');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { storageExecutor, observeStorageExecutor, retireEmptyProjectFileLock, retireProjectFileLock } = require('./project-file-lock-owner');
const { assertNoPreparedWorkspaceMigration } = require('./project-workspace-mode');
const { MAX_PROJECT_FILE_BYTES, projectFileHash: hash, projectFileFault: fault, projectFileGuard,
  createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');

const PROJECT_SYNC_STORAGE_VERSION = 2;
const SCOPE_CHECK_INTERVAL_MS = 200;
const mirrors = new Set(['project.abi', 'project.abs', 'project.abs.map.json']);
const readOnlyInputs = new Set(['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock']);
const readableFiles = new Set([...mirrors, ...readOnlyInputs]);
const baseline = /^baselines\/[A-Za-z0-9_-]{1,96}\.json$/;
const recovery = /^recoveries\/[A-Za-z0-9_-]{1,96}\.json$/;
const rawMirrorArchive = /^recoveries\/(abs|map)-raw-[a-f0-9]{64}\.bin$/;
const repairableMirror = new Map([['project.abs', 'abs'], ['project.abs.map.json', 'map']]);
const metadata = new Set(['operation.json', 'lineage.json']);
const workspaceMetadata = new Set(['workspace-mode.json']);
const historyObject = /^history-objects\/([a-f0-9]{64})$/;
const historyHash = key => {
  const match = typeof key === 'string' ? historyObject.exec(key) : null;
  return match && match[0] === key ? match[1] : null;
};
const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const sameRecord = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function matchesOriginalApplyRefusal(read, key, bytes, attachment, executor) {
  if (!bytes || !/^recoveries\/admission-[a-f0-9]{64}\.json$/.test(key)) return false;
  try {
    const receipt = JSON.parse(bytes.toString('utf8'));
    const requestId = receipt?.request?.requestId;
    if (receipt?.version !== 1 || Object.keys(receipt).length !== 9 || receipt.kind !== 'not-started' || receipt.project !== attachment.root
      || !/^[a-f0-9-]{36}$/.test(receipt.operationId) || typeof receipt.code !== 'string' || !receipt.code
      || typeof receipt.message !== 'string' || typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(requestId)
      || !isDeepStrictEqual(receipt.request, { operation: 'abs_apply', requestId })
      || !isDeepStrictEqual(receipt.attachment, attachment) || !isDeepStrictEqual(receipt.executor, executor)
      || key !== `recoveries/admission-${hash('abs-apply\0' + requestId).slice(7)}.json`) return false;
    const suffix = hash(requestId).slice(7);
    const writer = JSON.parse(read(`recoveries/application-writer-${suffix}.json`));
    return writer?.version === 1 && writer.kind === 'validated-writer' && writer.requestId === requestId
      && writer.project === attachment.root && isDigest(writer.candidateHash)
      && isDeepStrictEqual(writer.attachment, attachment) && isDeepStrictEqual(writer.executor, executor)
      && read(`recoveries/request-${suffix}.json`) === null;
  } catch { return false; }
}

function copiedCommittedSaveMatches(read, expected, pointer, journal, snapshot) {
  const request = snapshot.nativeSave;
  if (snapshot.version !== 1 || snapshot.kind !== 'document-save' || request?.version !== 2 || !isDigest(request.inputDigest)
    || typeof request.requestId !== 'string' || !/^pub2-[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(request.requestId)) return false;
  const indexKey = `recoveries/request-${hash('native-save-v2\0' + request.requestId).slice(7)}.json`;
  const stageKey = `recoveries/application-${snapshot.id}.json`;
  if (!isDigest(expected[indexKey]) || !isDigest(expected[stageKey])) return false;
  const index = JSON.parse(read(indexKey)), stage = JSON.parse(read(stageKey));
  const generation = JSON.parse(read(`baselines/${pointer.generation}.json`));
  if (!generation || !snapshot.disk || !index || !stage) return false;
  const binding = stage.evidence?.binding;
  const scope = generation.context?.scope ?? generation.projection?.map?.scope;
  const abs = generation.snapshot ?? generation.projection?.abs;
  const original = { operationId: snapshot.id, request, attachment: snapshot.attachment, executor: snapshot.executor };
  return index.version === 2 && index.kind === 'native-save' && index.project === snapshot.project
    && index.snapshotHash === journal.hash && index.sourceStageVersion === snapshot.sourceStageVersion
    && Object.entries(original).every(([key, value]) => sameRecord(index[key], value))
    && stage.version === 2 && stage.kind === 'native-save' && stage.project === snapshot.project
    && stage.snapshotHash === journal.hash && Object.entries(original).every(([key, value]) => sameRecord(stage.ref?.[key], value))
    && binding?.generation === pointer.generation && scope?.projectKey === snapshot.project && sameRecord(binding.scope, scope)
    && isDigest(binding.absHash) && typeof abs === 'string' && hash(abs) === binding.absHash
    && stage.evidence.absBytes === Buffer.byteLength(abs)
    && stage.inputAbiHash === hash(snapshot.disk.abi) && expected['project.abi'] === binding.abiHash
    && expected['project.abs.map.json'] === binding.mapHash && expected['project.abs'] === (generation.authorSource?.hash ?? binding.absHash)
    && generation.mode === 'import' && generation.previousPointer === snapshot.committed
    && generation.previousCommitted === hash(snapshot.committed)
    && ['abi', 'abs', 'map'].every(key => generation.expected?.[key] === hash(snapshot.disk[key]));
}

/** A project-bound, revocable host capability, not an IPC lock token or a second transaction engine. */
async function openProjectSyncStorage(projectPath, assertCurrent, options = {}) {
  const files = options.files || fs;
  const ownerGuard = projectFileGuard(assertCurrent);
  let modeGuard = () => {};
  const guard = () => { ownerGuard(); modeGuard(); };
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw fault('PROJECT_FILE_INVALID', 'Expected an absolute project path.');
  guard();
  const root = await files.promises.realpath(projectPath);
  guard();
  const access = createProjectFileAccess(root, projectPath, files);
  const executor = storageExecutor();
  const directories = [path.join(root, '.aily'), path.join(root, '.aily', 'abs-sync')];
  const modeBytes = () => {
    try { access.checkDirectory(directories[0]); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    return access.readRegular(path.join(directories[0], 'workspace-mode.json'));
  };
  const selectedMode = modeBytes();
  modeGuard = () => {
    access.checkRoot();
    if (hash(modeBytes()) !== hash(selectedMode)) throw fault('ABS_WORKSPACE_MODE_CHANGED', 'The project execution mode changed; the original storage capability was revoked.');
  };
  const locate = (key, create = false, raw = false) => {
    const objectHash = historyHash(key);
    if (typeof key !== 'string' || !(objectHash || key === 'history-workspace.json' || readableFiles.has(key) || metadata.has(key) || workspaceMetadata.has(key) || key === 'prepared.json' || key === 'committed.json' || baseline.test(key) || recovery.test(key) || raw && rawMirrorArchive.test(key))) {
      throw fault('ABS_STORAGE_KEY_INVALID', 'Unsupported ABS sync storage key.');
    }
    if (objectHash && create) throw fault('ABS_STORAGE_WRITE_INVALID', 'History objects are read-only through sync storage.');
    access.checkRoot();
    if (readableFiles.has(key)) return path.join(root, key);
    if (key === 'history-workspace.json') {
      const directory = path.join(root, '.workspace-history');
      try { access.checkDirectory(directory); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      return path.join(directory, 'workspace.json');
    }
    const parents = workspaceMetadata.has(key) ? [directories[0]] : objectHash ? [path.join(root, '.workspace-history'), path.join(root, '.workspace-history', 'objects'),
      path.join(root, '.workspace-history', 'objects', objectHash.slice(0, 2))] : baseline.test(key) || recovery.test(key) || raw && rawMirrorArchive.test(key)
      ? [...directories, path.join(directories[1], key.split('/')[0])] : directories;
    for (const directory of parents) {
      if (create) {
        try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      try { access.checkDirectory(directory); }
      catch (error) { if (!create && error.code === 'ENOENT') return null; throw error; }
    }
    return workspaceMetadata.has(key) ? path.join(directories[0], key)
      : objectHash ? path.join(parents[2], objectHash + '.blob') : path.join(directories[1], ...key.split('/'));
  };
  const readPhysicalBytes = (key, raw = false) => {
    const file = locate(key, false, raw);
    if (file === null) return null;
    const bytes = access.readRegular(file);
    if (historyHash(key)) {
      guard();
      if (locate(key) !== file) throw fault('PROJECT_FILE_UNSAFE_PATH', 'History object ancestry changed during its read.');
    }
    return bytes;
  };
  const readBytes = (key, raw = false) => {
    const bytes = readPhysicalBytes(key, raw), object = historyHash(key);
    return bytes && object ? decodeHistoryAbs(bytes, object, tail => readPhysicalBytes('history-objects/' + tail)) : bytes;
  };
  const readText = key => {
    const bytes = readBytes(key);
    if (bytes === null) return null;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      if (key === 'prepared.json') throw fault('ABS_BASELINE_CORRUPT', 'The prepared generation is not valid UTF-8. Its original bytes were retained.');
      if (key === 'operation.json') throw fault('ABS_OPERATION_CORRUPT', 'The operation pointer is not valid UTF-8. Its original bytes were retained.');
      throw fault('ABS_STORAGE_ENCODING_INVALID', 'Sync files must contain exact UTF-8; invalid bytes were retained.');
    }
    return text;
  };
  // These pointers are written by atomic rename. An unparsable file cannot be
  // a partially published live generation. Keep valid (including newer) JSON
  // for the normal version, ownership and checksum checks.
  const malformedPointer = key => {
    const bytes = readBytes(key);
    if (bytes === null) return false;
    try {
      const text = bytes.toString('utf8');
      JSON.parse(text);
      return !Buffer.from(text, 'utf8').equals(bytes);
    } catch (error) { if (error instanceof SyntaxError) return true; throw error; }
  };
  const retireMalformedPointers = async (includeCommitted = false) => {
    guard();
    const prepared = 'prepared.json', committed = 'committed.json';
    if (!malformedPointer(prepared) && !(includeCommitted && malformedPointer(committed))) return;
    const lock = await acquireProjectFileLock(access, guard, options.timeoutMs);
    try {
      const retire = key => {
        guard(); lock.assertOwned();
        if (!malformedPointer(key)) return;
        assertNoPreparedWorkspaceMigration(access);
        files.unlinkSync(locate(key));
      };
      retire(prepared);
      if (includeCommitted && readBytes(prepared) === null) retire(committed);
    } finally {
      const warnings = lock.release();
      if (warnings.length) throw fault('ABS_COMMIT_UNCERTAIN', warnings.join('; '));
    }
  };
  const retireCopiedLock = async ({ original, expected, phase = 'prepared' } = {}) => {
    const required = ['committed.json', 'operation.json', ...mirrors];
    if (!original?.attachment || !original.executor || !expected || Array.isArray(expected)
      || !['prepared', 'committed'].includes(phase) || required.some(key => !isDigest(expected[key]))
      || !Object.hasOwn(expected, 'prepared.json')
      || (phase === 'prepared' ? !isDigest(expected['prepared.json']) : expected['prepared.json'] !== null)
      || !Object.keys(expected).some(key => baseline.test(key))
      || !Object.keys(expected).some(key => /^recoveries\/operation-[a-f0-9-]{36}\.json$/.test(key)))
      throw fault('PROJECT_FILE_LOCK_CHANGED', 'Missing exact source and journal evidence for the copied lock.');
    const verify = () => {
      guard(); assertNoPreparedWorkspaceMigration(access);
      for (const [key, expectedHash] of Object.entries(expected)) {
        if (hash(readBytes(key)) !== expectedHash)
          throw fault('ABS_TRANSACTION_CONFLICT', 'The copied journal changed before lock recovery.');
      }
      const pointer = JSON.parse(readText('operation.json'));
      const generation = JSON.parse(readText(phase === 'prepared' ? 'prepared.json' : 'committed.json'));
      const snapshotKey = `recoveries/operation-${pointer.id}.json`;
      const snapshot = readSaveSnapshot(JSON.parse(readText(snapshotKey)), name => readBytes(`recoveries/${name}`));
      if (expected[snapshotKey] !== pointer.hash || snapshot?.id !== pointer.id
        || !isDigest(generation.hash) || expected[`baselines/${generation.generation}.json`] !== generation.hash
        || snapshot.project !== original.attachment.root
        || !sameRecord(snapshot.attachment, original.attachment) || !sameRecord(snapshot.executor, original.executor)
        || phase === 'committed' && !copiedCommittedSaveMatches(readText, expected, generation, pointer, snapshot))
        throw fault('PROJECT_FILE_LOCK_CHANGED', 'The copied journal does not bind the retained native lock owner.');
    };
    verify();
    const lock = await acquireProjectFileLock(access, guard, options.timeoutMs, {
      original, archive: () => {
        verify();
        return locate(`recoveries/copied-lock-${randomUUID()}.json`, true);
      },
    });
    const warnings = lock.release();
    if (warnings.length) throw fault('ABS_COMMIT_UNCERTAIN', warnings.join('; '));
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
    retireEmptyProjectFileLock: async observation => retireEmptyProjectFileLock(access, ownerGuard, observation),
    retireProjectFileLock: async observation => retireProjectFileLock(access, ownerGuard, observation),
    retireCopiedLock,
    retireMalformedPointers,
    withLock: async (operation, observeScope = false) => {
      if (typeof operation !== 'function') throw fault('ABS_STORAGE_OPERATION_INVALID', 'Expected a scoped storage operation.');
      const lock = await acquireProjectFileLock(access, guard, options.timeoutMs);
      let active = true;
      let scopeTimer;
      const pending = new Set();
      const check = () => {
        if (!active) throw fault('ABS_STORAGE_SCOPE_CLOSED', 'Storage write capability has expired.');
        guard(); lock.assertOwned();
      };
      const replaceBytes = async (key, expectedHash, bytes, raw = false, verify = () => {}) => {
        check();
        if (bytes && bytes.length > MAX_PROJECT_FILE_BYTES) throw fault('PROJECT_FILE_TOO_LARGE', 'Sync file exceeds the 128 MiB publication limit.');
        const checkMigration = () => {
          try { assertNoPreparedWorkspaceMigration(access); }
          catch (error) {
            // A prepared migration excludes program writers. The current validated
            // writer may still seal an immutable refusal for its own unused ID.
            if (error.code !== 'ABS_WORKSPACE_MIGRATION_PENDING' || expectedHash !== null
              || !matchesOriginalApplyRefusal(readText, key, bytes, access.attachment, executor)) throw error;
          }
        };
        checkMigration();
        verify();
        const before = readBytes(key, raw);
        if (hash(before) !== expectedHash) return false;
        if (bytes === null && before === null || bytes !== null && before?.equals(bytes)) return true;
        const target = locate(key, true, raw);
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
          check(); locate(key, false, raw); checkMigration(); verify();
          if (hash(readBytes(key, raw)) !== expectedHash) return false;
          attempted = true;
          if (bytes === null) files.unlinkSync(target);
          else { files.renameSync(temporary, target); owned = false; }
          if (hash(readBytes(key, raw)) !== hash(bytes)) throw fault('ABS_COMMIT_UNCERTAIN', 'Sync bytes changed during publication.');
          return true;
        } catch (error) {
          if (attempted) {
            try {
              const actual = hash(readBytes(key, raw));
              if (actual === hash(bytes)) return true;
              if (actual !== expectedHash) throw fault('ABS_COMMIT_UNCERTAIN', 'Sync publication outcome is unknown; retain the recovery journal.');
            } catch (inspectionError) { throw fault('ABS_COMMIT_UNCERTAIN', inspectionError.message); }
          }
          throw error;
        } finally {
          if (owned) {
            // Never clean by an old path after root/internal directory replacement.
            locate(key, false, raw);
            try { files.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
      };
      const replace = async (key, expectedHash, content) => {
        check();
        if (historyHash(key)) throw fault('ABS_STORAGE_WRITE_INVALID', 'History objects are read-only through sync storage.');
        locate(key);
        if (key === 'history-workspace.json' || readOnlyInputs.has(key) || workspaceMetadata.has(key) || !(expectedHash === null || isDigest(expectedHash))
          || !(content === null || typeof content === 'string')
          || (content === null && key !== 'prepared.json' && key !== 'operation.json')
          || ((baseline.test(key) || recovery.test(key)) && expectedHash !== null)) {
          throw fault('ABS_STORAGE_WRITE_INVALID', 'Invalid conditional sync write or immutable baseline mutation.');
        }
        return replaceBytes(key, expectedHash, content === null ? null : Buffer.from(content, 'utf8'));
      };
      const retireInvalidAbsMirror = async ({ key, abiHash, committedHash, operationHash, absHash, replacement } = {}) => {
        check();
        if (!repairableMirror.has(key) || !isDigest(abiHash)
          || [committedHash, operationHash].some(value => value !== null && !isDigest(value))
          || absHash !== undefined && (key !== 'project.abs.map.json' || !isDigest(absHash))
          || !(replacement === null || typeof replacement === 'string')) {
          throw fault('ABS_STORAGE_WRITE_INVALID', 'Invalid legacy mirror recovery request.');
        }
        const verify = () => {
          assertNoPendingAbsGeneration(access);
          if (hash(readBytes('project.abi')) !== abiHash || hash(readBytes('committed.json')) !== committedHash
            || hash(readBytes('operation.json')) !== operationHash
            || absHash !== undefined && hash(readBytes('project.abs')) !== absHash)
            throw fault('ABS_DISK_CONFLICT', 'The saved source changed before legacy mirror recovery.');
        };
        const bytes = readBytes(key);
        if (bytes === null || Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return false;
        const originalHash = hash(bytes);
        const archive = `recoveries/${repairableMirror.get(key)}-raw-${originalHash.slice(7)}.bin`;
        verify();
        if (hash(readBytes(archive, true)) !== originalHash && !await replaceBytes(archive, null, bytes, true, verify))
          throw fault('ABS_RECOVERY_ARCHIVE_CONFLICT', 'Could not preserve the original mirror bytes.');
        if (!await replaceBytes(key, originalHash, replacement === null ? null : Buffer.from(replacement, 'utf8'), false, verify))
          throw fault('ABS_DISK_CONFLICT', 'The invalid mirror changed before recovery.');
        return true;
      };
      const track = method => (...args) => {
        const result = method(...args);
        pending.add(result);
        result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      };
      const scoped = {
        attachment: access.attachment,
        executor,
        read: async key => { check(); return readText(key); },
        replace: track(replace),
        retireInvalidAbsMirror: track(retireInvalidAbsMirror),
      };
      try {
        check();
        const callback = operation(scoped);
        // A renderer may no longer be able to deliver its settlement after
        // revocation. Observe the same trusted guard while its callback waits.
        // A slow but current owner retains the native lock.
        const invalidated = observeScope && new Promise((_, reject) => {
          scopeTimer = setInterval(() => {
            try { check(); } catch (error) { reject(error); }
          }, SCOPE_CHECK_INTERVAL_MS);
        });
        const result = await (invalidated ? Promise.race([callback, invalidated]) : callback);
        check();
        return result;
      } finally {
        active = false;
        clearInterval(scopeTimer);
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
          replaceResult: (...args) => resultOf(() => locked.replace(...args)),
          retireInvalidAbsMirrorResult: request => resultOf(() => locked.retireInvalidAbsMirror(request)) } : locked;
        const returned = operation(scoped, settle);
        if (returned !== undefined) {
          if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
          reject(fault('ABS_STORAGE_OPERATION_INVALID', 'Bridge callbacks must return void and settle explicitly.'));
        }
      } catch (error) { reject(error); }
    }), true);
  return {
    attachment: storage.attachment,
    executor: storage.executor,
    observeExecutor: original => storage.observeExecutor(original),
    observeExecutorResult: original => resultOf(() => storage.observeExecutor(original)),
    read: key => storage.read(key),
    withLock: operation => withBridgeLock(operation, false),
    readResult: key => resultOf(() => storage.read(key)),
    retireEmptyProjectFileLockResult: observation => resultOf(() => storage.retireEmptyProjectFileLock(observation)),
    retireProjectFileLockResult: observation => resultOf(() => storage.retireProjectFileLock(observation)),
    retireCopiedLockResult: proof => resultOf(() => storage.retireCopiedLock(proof)),
    retireMalformedPointersResult: includeCommitted => resultOf(() => storage.retireMalformedPointers(includeCommitted)),
    withLockResult: operation => resultOf(() => withBridgeLock(operation, true)),
  };
}

module.exports = { openProjectSyncStorage, openProjectSyncStorageBridge, PROJECT_SYNC_STORAGE_VERSION };
