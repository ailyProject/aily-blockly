'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { rootAttachment, storageExecutor } = require('./project-file-lock-owner');
const { childScriptPath } = require('./child-script-path');

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const fault = (code, message) => Object.assign(new Error(message), { code });
const positivePid = value => Number.isSafeInteger(value) && value > 0;
const validCreation = value => typeof value === 'string' && /^(?:win32|linux):\d+$/.test(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;

/** Navigation metadata only. Returning a path grants no journal, write, lock,
 * candidate or recovery capability. The normal project-open path rechecks all of them. */
function createProjectCrashResume(options) {
  const { stateDirectory, profileKey, files = fs, onWarning = () => {} } = options || {};
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)
    || typeof profileKey !== 'string' || !profileKey || profileKey.length > 32768) {
    throw fault('PROJECT_CRASH_RESUME_CONFIG_INVALID', 'Crash navigation requires explicit state and profile roots.');
  }
  const profile = hash(path.isAbsolute(profileKey) ? key(profileKey) : profileKey);
  let storageIdentity;
  const currentExecutor = () => {
    const value = typeof options.executor === 'function' ? options.executor() : options.executor || storageExecutor();
    if (value?.version !== 1 || !positivePid(value.hostPid) || value.hostPid !== value.storagePid
      || typeof value.instanceId !== 'string' || value.instanceId.length < 8
      || value.processIdentity !== null && !validCreation(value.processIdentity)
      || value.bootId !== null && typeof value.bootId !== 'string') {
      throw fault('PROJECT_CRASH_RESUME_EXECUTOR_INVALID', 'Only the identified main executor may record crash navigation.');
    }
    return { version: 1, hostPid: value.hostPid, storagePid: value.storagePid,
      instanceId: value.instanceId, processIdentity: value.processIdentity, bootId: value.bootId };
  };
  const currentBoot = () => typeof options.bootId === 'function' ? options.bootId()
    : options.bootId || require(childScriptPath('system-boot-id.js')).getSystemBootId();
  const processState = options.processState || (pid => require(childScriptPath('process-state.js')).getProcessState(pid));
  const processIdentity = options.processIdentity || (pid => require(childScriptPath('build-process-identity.js')).processIdentity(pid));
  const bootValid = value => require(childScriptPath('system-boot-id.js')).isSystemBootId(value);

  const ownerState = executor => {
    const boot = currentBoot();
    if (bootValid(executor.bootId) && bootValid(boot) && executor.bootId !== boot) return 'exited';
    const state = processState(executor.hostPid);
    if (state === false) return 'exited';
    if (state !== true) return 'unknown';
    const observed = validCreation(executor.processIdentity) ? processIdentity(executor.hostPid) : null;
    if (!validCreation(observed)) return 'unknown';
    return observed === executor.processIdentity ? 'active' : 'exited';
  };
  const directory = (parent, name, create) => {
    const target = path.join(parent, name);
    if (create) try { files.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = files.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(files.realpathSync(target)) !== key(target))
      throw fault('PROJECT_CRASH_RESUME_STORAGE_UNSAFE', 'Navigation storage is linked or replaced.');
    return target;
  };
  const location = create => {
    if (create) files.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    const physical = files.realpathSync(stateDirectory), identity = rootAttachment(physical, files);
    if (!identity || storageIdentity && !same(storageIdentity, identity))
      throw fault('PROJECT_CRASH_RESUME_STORAGE_CHANGED', 'The navigation storage root changed.');
    storageIdentity = identity;
    const bucket = directory(directory(physical, 'project-crash-resume', create), profile, create);
    return { bucket, file: path.join(bucket, 'active.json'), identity, bucketIdentity: rootAttachment(bucket, files) };
  };
  const read = store => {
    let stat;
    try { stat = files.lstatSync(store.file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
      throw fault('PROJECT_CRASH_RESUME_RECORD_UNSAFE', 'Navigation metadata is not a private bounded regular file.');
    const bytes = files.readFileSync(store.file), after = files.lstatSync(store.file);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      throw fault('PROJECT_CRASH_RESUME_RECORD_CHANGED', 'Navigation metadata changed while reading.');
    const record = JSON.parse(bytes.toString('utf8')), { checksum, ...data } = record;
    const executor = data.executor, attachment = data.attachment;
    if (data.version !== 1 || data.profile !== profile || typeof data.project !== 'string' || !path.isAbsolute(data.project)
      || attachment?.version !== 1 || attachment.root !== data.project
      || !['dev', 'ino', 'birthtimeNs'].every(name => typeof attachment.identity?.[name] === 'string' && /^-?\d+$/.test(attachment.identity[name]))
      || executor?.version !== 1 || !positivePid(executor.hostPid) || executor.hostPid !== executor.storagePid
      || typeof executor.instanceId !== 'string' || executor.instanceId.length < 8
      || executor.processIdentity !== null && !validCreation(executor.processIdentity)
      || executor.bootId !== null && typeof executor.bootId !== 'string'
      || checksum !== hash(JSON.stringify(canonical(data)))) {
      throw fault('PROJECT_CRASH_RESUME_RECORD_INVALID', 'Navigation metadata has invalid identity or checksum.');
    }
    return { record: data, bytes, stat };
  };
  const assertCurrent = (store, previous) => {
    const physical = files.realpathSync(stateDirectory);
    const bucket = directory(directory(physical, 'project-crash-resume', false), profile, false);
    if (!same(rootAttachment(physical, files), store.identity) || !same(rootAttachment(bucket, files), store.bucketIdentity))
      throw fault('PROJECT_CRASH_RESUME_STORAGE_CHANGED', 'Navigation storage changed before settlement.');
    const current = read(store);
    if (!!current !== !!previous || current && (current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino
      || !current.bytes.equals(previous.bytes))) throw fault('PROJECT_CRASH_RESUME_RECORD_CHANGED', 'Navigation owner changed before settlement.');
  };
  const run = (create, action) => {
    let lease;
    try {
      let store;
      try { store = location(create); } catch (error) {
        if (!create && error.code === 'ENOENT') return { ok: true, project: null, cleared: false, reason: 'no-record' };
        throw error;
      }
      lease = require(childScriptPath('native-file-lock.js')).tryAcquireFileLock(path.join(store.bucket, 'navigation.guard'));
      if (!lease) throw fault('PROJECT_CRASH_RESUME_BUSY', 'Another navigation update owns this profile.');
      return action(store, read(store));
    } catch (error) {
      const warning = { code: error.code || 'PROJECT_CRASH_RESUME_UNAVAILABLE', message: error.message };
      try { onWarning(warning); } catch { /* Navigation diagnostics cannot block ordinary open/edit. */ }
      return { ok: false, project: null, recorded: false, cleared: false, reason: 'unavailable', ...warning };
    } finally {
      try { lease?.close(); } catch (error) {
        try { onWarning({ code: 'PROJECT_CRASH_RESUME_RELEASE_FAILED', message: error.message }); } catch { /* Non-blocking navigation diagnostic. */ }
      }
    }
  };

  return {
    record(project) {
      return run(true, (store, previous) => {
        if (typeof project !== 'string' || !path.isAbsolute(project)) throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Expected an exact absolute project.');
        const physical = files.realpathSync(project);
        if (key(physical) !== key(project)) throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Linked project aliases do not grant a physical attachment.');
        const attachment = rootAttachment(project, files), executor = currentExecutor();
        if (!attachment || attachment.identity.ino === '0') throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Project physical identity is unavailable.');
        if (previous && !same(previous.record.executor, executor) && ownerState(previous.record.executor) !== 'exited')
          throw fault('PROJECT_CRASH_RESUME_OWNER_ACTIVE', 'The existing navigation owner is live or unverified.');
        const data = { version: 1, profile, project: physical, attachment: { ...attachment, root: physical }, executor };
        if (previous && same(canonical(previous.record), canonical(data))) return { ok: true, recorded: false, project: physical, reason: 'unchanged' };
        const temp = path.join(store.bucket, `active-${randomUUID()}.tmp`);
        try {
          const fd = files.openSync(temp, 'wx', 0o600);
          try { files.writeFileSync(fd, JSON.stringify({ ...data, checksum: hash(JSON.stringify(canonical(data))) })); files.fsyncSync(fd); }
          finally { files.closeSync(fd); }
          assertCurrent(store, previous);
          if (!same(rootAttachment(project, files), attachment)) throw fault('PROJECT_CRASH_RESUME_PROJECT_CHANGED', 'Project changed before navigation was recorded.');
          files.renameSync(temp, store.file);
        } finally { try { files.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
        return { ok: true, recorded: true, project: physical };
      });
    },
    clear(project) {
      return run(false, (store, previous) => {
        if (!previous) return { ok: true, cleared: false, reason: 'no-record' };
        if (!same(previous.record.executor, currentExecutor())) return { ok: true, cleared: false, reason: 'different-owner' };
        if (project !== undefined && (typeof project !== 'string' || !path.isAbsolute(project) || key(project) !== key(previous.record.project)))
          return { ok: true, cleared: false, reason: 'different-project' };
        assertCurrent(store, previous); files.unlinkSync(store.file);
        return { ok: true, cleared: true };
      });
    },
    interruptedProject() {
      return run(false, (store, previous) => {
        if (!previous) return { ok: true, project: null, reason: 'no-record' };
        const record = previous.record, state = ownerState(record.executor);
        if (state !== 'exited') return { ok: true, project: null, reason: state === 'active' ? 'owner-active' : 'owner-unknown' };
        let attachment;
        try { attachment = rootAttachment(record.project, files); } catch { /* Preserve the record if the physical root is missing or unavailable. */ }
        if (!same(attachment, record.attachment)) return { ok: true, project: null, reason: 'attachment-mismatch' };
        assertCurrent(store, previous);
        return { ok: true, project: record.project, attachment: record.attachment, executor: record.executor, reason: 'interrupted' };
      });
    },
  };
}

module.exports = { createProjectCrashResume };
