const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { childScriptPath } = require('./child-script-path');
const instanceId = randomUUID();
let ownIdentity;
const fault = (code, message) => Object.assign(new Error(message), { code });
const positivePid = value => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => a?.version === b?.version && a?.root === b?.root
  && ['dev', 'ino', 'birthtimeNs'].every(key => a?.identity?.[key] === b?.identity?.[key]);
const markerToken = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const stagingProtocol = 'exclusive-link-v1';
const stagingName = (directory, token) => path.join(directory, `.project-files.write.lock.${token}.tmp`);
const plainMarker = stat => stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 16384n;
const sameMarker = (stat, original) => plainMarker(stat) && stat.dev === original.dev && stat.ino === original.ino;
const changedMarker = () => fault('PROJECT_FILE_LOCK_CHANGED', 'Project lock ownership changed; retained the marker.');
const busyMarker = () => fault('PROJECT_FILE_BUSY', 'Project writer lock is busy or its previous owner cannot be verified.');

function markerStatAt(files, filename) {
  try { return files.lstatSync(filename, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function assertMarkerBytes(files, filename, original, links, bytes) {
  const stat = markerStatAt(files, filename);
  if (!sameMarker(stat, original) || stat.nlink !== links || !files.readFileSync(filename).equals(bytes)) throw changedMarker();
  return stat;
}

function rootAttachment(root, files = fs) {
  const stat = files.lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('PROJECT_FILE_UNSAFE_PATH', 'Project attachment is not a physical directory.');
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || typeof stat.birthtimeNs !== 'bigint') return undefined;
  if (typeof files.openSync !== 'function' || typeof files.fstatSync !== 'function' || typeof files.closeSync !== 'function') return undefined;
  // Electron's Windows path-stat implementation can report dev=0 even outside
  // ASAR. The opened physical directory supplies the authoritative volume;
  // neither a synthetic path value nor a zero wildcard grants an attachment.
  const flags = (files.constants?.O_RDONLY ?? 0) | (files.constants?.O_NOFOLLOW ?? 0);
  const descriptor = files.openSync(root, flags);
  try {
    const opened = files.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || typeof opened.dev !== 'bigint' || typeof opened.ino !== 'bigint'
      || typeof opened.birthtimeNs !== 'bigint') throw fault('PROJECT_FILE_UNSAFE_PATH', 'Project directory handle identity is unavailable.');
    const after = files.lstatSync(root, { bigint: true });
    for (const observed of [stat, after]) {
      if (!observed.isDirectory() || observed.isSymbolicLink() || typeof observed.dev !== 'bigint'
        || observed.ino !== opened.ino || observed.birthtimeNs !== opened.birthtimeNs
        || observed.dev !== 0n && observed.dev !== opened.dev) {
        throw fault('PROJECT_FILE_UNSAFE_PATH', 'Project directory changed while observing its physical handle.');
      }
    }
    return Object.freeze({ version: 1, root, identity: Object.freeze({ dev: String(opened.dev), ino: String(opened.ino), birthtimeNs: String(opened.birthtimeNs) }) });
  } finally { files.closeSync(descriptor); }
}

function storageExecutor() {
  if (!ownIdentity) {
    const { processIdentity } = require(childScriptPath('build-process-identity.js'));
    const { getSystemBootId } = require(childScriptPath('system-boot-id.js'));
    ownIdentity = { processIdentity: processIdentity(process.pid), bootId: getSystemBootId() };
  }
  // The main host overwrites this before creating a renderer. Do not bind its
  // value at module import, or confuse a renderer PID with the CLI host PID.
  const inherited = Number(process.env.AILY_LIBRARY_HOST_PID);
  const hostPid = positivePid(inherited) ? inherited : process.versions.electron ? null : process.pid;
  return Object.freeze({ version: 1, hostPid, storagePid: process.pid, instanceId, ...ownIdentity });
}

function ownerIsDead(owner, executor) {
  if (!positivePid(owner?.pid) || typeof owner.token !== 'string' || owner.token.length < 8) return false;
  const { isSystemBootId } = require(childScriptPath('system-boot-id.js'));
  if (isSystemBootId(owner.bootId) && isSystemBootId(executor.bootId) && owner.bootId !== executor.bootId) return true;
  try { process.kill(owner.pid, 0); }
  catch (error) { return error.code === 'ESRCH'; } // EPERM/unsupported stays protected.
  if (typeof owner.processIdentity !== 'string' || !/^(?:win32|linux):\d+$/.test(owner.processIdentity)) return false;
  const observed = require(childScriptPath('build-process-identity.js')).processIdentity(owner.pid);
  return typeof observed === 'string' && observed !== owner.processIdentity;
}

/** Read-only execution identity observation; never kills or replaces an owner. */
function observeStorageExecutor(original, observer = storageExecutor()) {
  const result = (state, reason) => ({ version: 1, state, reason });
  if (original?.version !== 1 || !positivePid(original.storagePid) || !positivePid(original.hostPid)
    || typeof original.instanceId !== 'string' || original.instanceId.length < 8
    || ![original.processIdentity, original.bootId].every(value => value === null || typeof value === 'string'))
    return result('unknown', 'invalid-executor');
  if (original.storagePid === observer.storagePid && original.instanceId === observer.instanceId)
    return result('active', 'same-instance');
  const { isSystemBootId } = require(childScriptPath('system-boot-id.js'));
  if (isSystemBootId(original.bootId) && isSystemBootId(observer.bootId) && original.bootId !== observer.bootId)
    return result('exited', 'system-restarted');
  const { getProcessState } = require(childScriptPath('process-state.js'));
  const state = getProcessState(original.storagePid);
  if (state === false) return result('exited', 'process-exited');
  if (state !== true) return result('unknown', 'process-unavailable');
  if (typeof original.processIdentity !== 'string' || !/^(?:win32|linux):\d+$/.test(original.processIdentity))
    return result('unknown', 'identity-unavailable');
  const current = require(childScriptPath('build-process-identity.js')).processIdentity(original.storagePid);
  if (typeof current !== 'string') return result('unknown', 'identity-unavailable');
  return current === original.processIdentity ? result('active', 'process-matched') : result('exited', 'process-reused');
}

function tryArchiveEmptyMarker(access, directory, marker, stat, assertScope) {
  if (process.platform !== 'win32' || !access.attachment) return 'protected';
  const { files } = access;
  const parent = rootAttachment(directory, files);
  if (!parent || parent.identity.dev !== access.attachment.identity.dev || typeof stat.birthtimeNs !== 'bigint')
    throw changedMarker();
  assertScope();
  const current = markerStatAt(files, marker);
  if (!current) return 'absent';
  if (!sameMarker(current, stat) || current.nlink !== 1n || current.size !== 0n || current.birthtimeNs !== stat.birthtimeNs)
    throw changedMarker();
  const retire = require('./owned-process').runtime()?.binding.archiveEmptyProjectLock;
  if (typeof retire !== 'function') return 'protected';
  const { dev, ino, birthtimeNs } = parent.identity;
  const result = retire(directory, randomUUID(), BigInt(dev), BigInt(ino), BigInt(birthtimeNs) / 100n,
    current.ino, current.birthtimeNs / 100n);
  if (result === 0) return 'archived';
  if (result === 2) return 'absent'; // The older writer removed its own marker.
  if (result === 5 || result === 32 || result === 33 || result === 50) return 'protected'; // Denied, in use, or unsupported filesystem.
  throw changedMarker();
}

/** Warm-session recovery touches only the exact legacy marker, not any request,
 * generation or publication. A busy native guard is never waited on here. */
function retireEmptyProjectFileLock(access, guard) {
  const { root, files, checkRoot, checkDirectory } = access;
  const directory = path.join(root, '.aily'), marker = path.join(directory, 'project-files.write.lock');
  guard(); checkRoot();
  if (!markerStatAt(files, directory)) return false;
  checkDirectory(directory);
  const stat = markerStatAt(files, marker);
  if (!stat || stat.size !== 0n) return false;
  if (!plainMarker(stat) || stat.nlink !== 1n) throw changedMarker();
  const guardFile = path.join(directory, 'project-files.guard');
  const native = require(childScriptPath('native-file-lock.js')).tryAcquireFileLock(guardFile);
  if (!native) throw busyMarker();
  try {
    const outcome = tryArchiveEmptyMarker(access, directory, marker, stat, () => {
      guard(); checkRoot(); checkDirectory(directory); native.assertHeld();
    });
    if (outcome === 'protected') throw busyMarker();
    return outcome === 'archived';
  } finally { native.close(); }
}

/** The permanent native anchor serializes recovery, while the canonical marker
 * remains the common exclusion point for old and new writers. No timeout/PID
 * alone authorizes deleting the marker; an exact dead owner is checked while
 * the native anchor and physical project identity are held. */
async function acquirePublicationLock(access, guard, timeoutMs, copiedRecovery) {
  const { root, files, checkRoot, checkDirectory } = access;
  const directory = path.join(root, '.aily'), marker = path.join(directory, 'project-files.write.lock');
  guard(); checkRoot();
  try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  checkDirectory(directory);
  const executor = storageExecutor(), attachment = access.attachment, token = randomUUID();
  const staged = stagingName(directory, token);
  const owner = Buffer.from(JSON.stringify({ version: 2, pid: process.pid, token, publication: stagingProtocol,
    processIdentity: executor.processIdentity, bootId: executor.bootId, instanceId: executor.instanceId,
    ...(attachment ? { attachment } : {}) }));
  const deadline = Date.now() + timeoutMs;
  let native, descriptor, preparedStat, markerStat;
  const wait = async () => {
    if (Date.now() >= deadline) throw busyMarker();
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  };
  const assertScope = (checkContext = true) => {
    if (checkContext) guard();
    checkRoot(); checkDirectory(directory); native.assertHeld();
  };
  const assertMarker = (checkContext = true) => {
    assertScope(checkContext);
    assertMarkerBytes(files, marker, markerStat, 1n, owner);
  };
  const publish = () => {
    if (!preparedStat) {
      descriptor = files.openSync(staged, 'wx', 0o600);
      const opened = files.fstatSync(descriptor, { bigint: true });
      const stat = markerStatAt(files, staged);
      if (!plainMarker(stat) || !opened.isFile() || stat.ino !== opened.ino || stat.nlink !== 1n
        || (stat.dev !== 0n && stat.dev !== opened.dev)) throw changedMarker();
      preparedStat = stat;
      files.writeFileSync(descriptor, owner);
      files.fsyncSync(descriptor);
    }
    assertScope();
    assertMarkerBytes(files, staged, preparedStat, 1n, owner);
    // Link creation publishes only the fully written inode and is exclusive
    // even against legacy writers that do not hold the native guard.
    try { files.linkSync(staged, marker); }
    catch (error) { if (error.code === 'EEXIST') return; throw error; }
    markerStat = assertMarkerBytes(files, marker, preparedStat, 2n, owner);
    assertMarkerBytes(files, staged, preparedStat, 2n, owner);
    files.unlinkSync(staged);
    preparedStat = undefined;
    assertMarker();
  };
  try {
    const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));
    while (!native) {
      guard(); checkRoot(); checkDirectory(directory);
      native = tryAcquireFileLock(path.join(directory, 'project-files.guard'));
      if (!native) await wait();
    }
    while (!markerStat) {
      assertScope();
      const stat = markerStatAt(files, marker);
      if (!stat) publish();
      else {
        if (!plainMarker(stat) || (stat.nlink !== 1n && stat.nlink !== 2n)) throw changedMarker();
        if (stat.size === 0n && stat.nlink === 1n) {
          if (tryArchiveEmptyMarker(access, directory, marker, stat, assertScope) === 'protected') await wait();
          continue;
        }
        const bytes = files.readFileSync(marker);
        let previous; try { previous = JSON.parse(bytes.toString('utf8')); } catch { /* Retain unverified bytes. */ }
        // An interrupted publication can leave exactly one additional name for
        // this inode. Other aliases do not establish ownership of the marker.
        let interruptedStage;
        if (stat.nlink === 2n) {
          if (previous?.version !== 2 || previous.publication !== stagingProtocol || typeof previous.token !== 'string'
            || !markerToken.test(previous.token)) throw changedMarker();
          interruptedStage = stagingName(directory, previous.token);
          assertMarkerBytes(files, interruptedStage, stat, 2n, bytes);
        }
        const foreign = previous?.attachment && (!attachment || !same(previous.attachment, attachment));
        let archive;
        if (foreign) {
          const original = copiedRecovery?.original;
          const identity = original?.executor;
          if (!attachment || !original || previous.version !== 2 || !same(previous.attachment, original.attachment)
            || previous.pid !== identity?.storagePid || previous.instanceId !== identity.instanceId
            || previous.processIdentity !== identity.processIdentity || previous.bootId !== identity.bootId
            || observeStorageExecutor(identity, executor).state !== 'exited')
            throw fault('PROJECT_FILE_LOCK_CHANGED', 'The retained lock belongs to an unverified original attachment or writer.');
          archive = copiedRecovery.archive();
        }
        if (ownerIsDead(previous, executor)) {
          assertScope();
          assertMarkerBytes(files, marker, stat, stat.nlink, bytes);
          if (interruptedStage) {
            assertMarkerBytes(files, interruptedStage, stat, 2n, bytes);
            files.unlinkSync(interruptedStage);
            assertMarkerBytes(files, marker, stat, 1n, bytes);
          }
          // Preserve the exact foreign record. Only this target's elected
          // guard can retire its copied marker; the original path is untouched.
          if (archive) files.renameSync(marker, archive);
          else files.unlinkSync(marker);
        } else await wait();
      }
    }
    let released = false;
    return {
      assertOwned: () => assertMarker(),
      release() {
        if (released) return [];
        released = true;
        const warnings = [];
        try { assertMarker(false); files.unlinkSync(marker); } catch (error) { warnings.push(error.message); }
        try { files.closeSync(descriptor); } catch (error) { warnings.push(error.message); }
        try { native.close(); } catch (error) { warnings.push(error.message); }
        return warnings;
      },
    };
  } catch (error) {
    try {
      if (markerStat) {
        assertScope(false);
        const links = preparedStat ? 2n : 1n;
        assertMarkerBytes(files, marker, markerStat, links, owner);
        if (preparedStat) assertMarkerBytes(files, staged, preparedStat, links, owner);
        files.unlinkSync(marker);
      }
      if (preparedStat) {
        assertScope(false);
        const stat = markerStatAt(files, staged);
        if (sameMarker(stat, preparedStat) && stat.nlink === 1n) files.unlinkSync(staged);
      }
    } catch { /* Preserve unknown marker. */ }
    if (descriptor !== undefined) {
      try { files.closeSync(descriptor); } catch { /* Original error wins. */ }
    }
    native?.close(); throw error;
  }
}

module.exports = { rootAttachment, storageExecutor, acquirePublicationLock, ownerIsDead, observeStorageExecutor, retireEmptyProjectFileLock };
