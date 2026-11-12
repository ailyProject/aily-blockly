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

/** The permanent native anchor serializes recovery, while the legacy wx marker
 * remains the common exclusion point for old and new writers. No timeout/PID
 * alone authorizes deleting the marker; an exact dead owner is checked while
 * the native anchor and physical project identity are held. */
async function acquirePublicationLock(access, guard, timeoutMs) {
  const { root, files, checkRoot, checkDirectory } = access;
  const directory = path.join(root, '.aily'), marker = path.join(directory, 'project-files.write.lock');
  guard(); checkRoot();
  try { files.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  checkDirectory(directory);
  const executor = storageExecutor(), attachment = access.attachment;
  const owner = JSON.stringify({ version: 2, pid: process.pid, token: randomUUID(),
    processIdentity: executor.processIdentity, bootId: executor.bootId, instanceId: executor.instanceId,
    ...(attachment ? { attachment } : {}) });
  const deadline = Date.now() + timeoutMs;
  let native, descriptor, markerStat;
  const busy = () => fault('PROJECT_FILE_BUSY', 'Project writer lock is busy or its previous owner cannot be verified.');
  const wait = async () => {
    if (Date.now() >= deadline) throw busy();
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
  };
  const assertMarker = (checkContext = true) => {
    if (checkContext) guard();
    checkRoot(); checkDirectory(directory); native.assertHeld();
    const stat = files.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !markerStat
      || stat.dev !== markerStat.dev || stat.ino !== markerStat.ino || files.readFileSync(marker, 'utf8') !== owner)
      throw fault('PROJECT_FILE_LOCK_CHANGED', 'Project lock ownership changed; retained the marker.');
  };
  try {
    const { tryAcquireFileLock } = require(childScriptPath('native-file-lock.js'));
    while (!native) {
      guard(); checkRoot(); checkDirectory(directory);
      native = tryAcquireFileLock(path.join(directory, 'project-files.guard'));
      if (!native) await wait();
    }
    while (descriptor === undefined) {
      guard(); checkRoot(); checkDirectory(directory); native.assertHeld();
      try { descriptor = files.openSync(marker, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const stat = files.lstatSync(marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384)
          throw fault('PROJECT_FILE_LOCK_CHANGED', 'Unsafe project lock marker was retained.');
        const bytes = files.readFileSync(marker);
        let previous; try { previous = JSON.parse(bytes.toString('utf8')); } catch { /* Retain unverified bytes. */ }
        if (previous?.attachment && (!attachment || !same(previous.attachment, attachment)))
          throw fault('PROJECT_FILE_LOCK_CHANGED', 'The retained lock belongs to a different physical attachment.');
        if (ownerIsDead(previous, executor)) {
          guard(); checkRoot(); checkDirectory(directory); native.assertHeld();
          const current = files.lstatSync(marker);
          if (current.dev !== stat.dev || current.ino !== stat.ino || !files.readFileSync(marker).equals(bytes))
            throw fault('PROJECT_FILE_LOCK_CHANGED', 'The observed lock changed before recovery.');
          files.unlinkSync(marker);
        } else await wait();
      }
    }
    markerStat = files.lstatSync(marker);
    files.writeFileSync(descriptor, owner, 'utf8');
    files.fsyncSync(descriptor);
    assertMarker();
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
    if (descriptor !== undefined) {
      try { if (markerStat) { assertMarker(false); files.unlinkSync(marker); } } catch { /* Preserve unknown marker. */ }
      try { files.closeSync(descriptor); } catch { /* Original error wins. */ }
    }
    native?.close(); throw error;
  }
}

module.exports = { rootAttachment, storageExecutor, acquirePublicationLock, ownerIsDead, observeStorageExecutor };
