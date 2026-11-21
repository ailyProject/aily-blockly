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
const uuid4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sessionUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function readProjectNavigationRecovery(value) {
  const request = value?.navigationRequest;
  if (value?.version !== 1 || !positivePid(value.originalTargetPid)
    || typeof value.originalInstanceId !== 'string' || !uuid4.test(value.originalInstanceId)
    || typeof value.sessionId !== 'string' || !sessionUuid.test(value.sessionId) || !request || Array.isArray(request)
    || Object.keys(value).some(name => !['version', 'originalTargetPid', 'originalInstanceId', 'sessionId', 'navigationRequest'].includes(name))
    || Object.keys(request).some(name => !['version', 'requestId', 'rendererGeneration', 'deadlineAt', 'operation', 'sourceProject', 'targetProject'].includes(name))
    || request.version !== 1 || typeof request.requestId !== 'string' || !uuid4.test(request.requestId) || !positivePid(request.rendererGeneration)
    || !positivePid(request.deadlineAt) || request.sourceProject !== null && !absolute(request.sourceProject)
    || !(request.operation === 'project_open' && absolute(request.targetProject)
      || request.operation === 'project_close' && absolute(request.sourceProject) && request.targetProject === null)) return null;
  const { requestId, rendererGeneration, deadlineAt, operation, sourceProject, targetProject } = request;
  return { version: 1, originalTargetPid: value.originalTargetPid, originalInstanceId: value.originalInstanceId,
    sessionId: value.sessionId, navigationRequest: { version: 1, requestId, rendererGeneration, deadlineAt, operation,
      sourceProject, targetProject } };
}

function readProjectCreateRecovery(value) {
  const request = value?.createRequest;
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(name => !['version', 'requestId', 'rendererGeneration', 'deadlineAt'].includes(name))
    || request.version !== 1 || typeof request.requestId !== 'string' || !uuid4.test(request.requestId)
    || !positivePid(request.rendererGeneration) || !positivePid(request.deadlineAt)
    || typeof value.recoverySessionId !== 'string' || !sessionUuid.test(value.recoverySessionId)
    || typeof value.originalInstanceId !== 'string' || !uuid4.test(value.originalInstanceId)) return null;
  const { version, requestId, rendererGeneration, deadlineAt } = request;
  return { createRequest: { version, requestId, rendererGeneration, deadlineAt },
    recoverySessionId: value.recoverySessionId, originalInstanceId: value.originalInstanceId };
}

function readCreation(value) {
  const recovery = readProjectCreateRecovery(value);
  if (!recovery || value.sourceProject !== null && (typeof value.sourceProject !== 'string' || !path.isAbsolute(value.sourceProject))) return null;
  return { ...recovery, sourceProject: value.sourceProject };
}

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
  const readFile = file => {
    let stat;
    try { stat = files.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
      throw fault('PROJECT_CRASH_RESUME_RECORD_UNSAFE', 'Navigation metadata is not a private bounded regular file.');
    const bytes = files.readFileSync(file), after = files.lstatSync(file);
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      throw fault('PROJECT_CRASH_RESUME_RECORD_CHANGED', 'Navigation metadata changed while reading.');
    const record = JSON.parse(bytes.toString('utf8')), { checksum, ...data } = record;
    if (data.version !== 1 || data.profile !== profile || checksum !== hash(JSON.stringify(canonical(data))))
      throw fault('PROJECT_CRASH_RESUME_RECORD_INVALID', 'Navigation metadata has invalid identity or checksum.');
    return { record: data, bytes, stat };
  };
  const validAttachment = (attachment, project) => attachment?.version === 1 && attachment.root === project
    && ['dev', 'ino', 'birthtimeNs'].every(name => typeof attachment.identity?.[name] === 'string'
      && /^-?\d+$/.test(attachment.identity[name]));
  const read = store => {
    const stored = readFile(store.file);
    if (!stored) return null;
    const data = stored.record;
    const executor = data.executor, attachment = data.attachment;
    const physical = data.closed === true ? data.navigation?.navigationRequest?.sourceProject : data.project;
    if (!absolute(physical) || !validAttachment(attachment, physical)
      || (data.closed === true ? data.project !== null || data.navigation?.navigationRequest?.operation !== 'project_close'
        : data.navigation && data.navigation.navigationRequest?.operation !== 'project_open')
      || executor?.version !== 1 || !positivePid(executor.hostPid) || executor.hostPid !== executor.storagePid
      || typeof executor.instanceId !== 'string' || executor.instanceId.length < 8
      || executor.processIdentity !== null && !validCreation(executor.processIdentity)
      || executor.bootId !== null && typeof executor.bootId !== 'string'
      || data.creation !== undefined && (!data.creation || !same(readCreation(data.creation), data.creation))
      || data.navigation !== undefined && !same(readProjectNavigationRecovery(data.navigation), data.navigation)
      || data.viewId !== undefined && !uuid4.test(data.viewId)) {
      throw fault('PROJECT_CRASH_RESUME_RECORD_INVALID', 'Navigation metadata has invalid identity or checksum.');
    }
    return stored;
  };
  const assertLocation = store => {
    const physical = files.realpathSync(stateDirectory);
    const bucket = directory(directory(physical, 'project-crash-resume', false), profile, false);
    if (!same(rootAttachment(physical, files), store.identity) || !same(rootAttachment(bucket, files), store.bucketIdentity))
      throw fault('PROJECT_CRASH_RESUME_STORAGE_CHANGED', 'Navigation storage changed before settlement.');
  };
  const assertCurrent = (store, previous, file = store.file) => {
    assertLocation(store);
    const current = readFile(file);
    if (!!current !== !!previous || current && (current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino
      || !current.bytes.equals(previous.bytes))) throw fault('PROJECT_CRASH_RESUME_RECORD_CHANGED', 'Navigation owner changed before settlement.');
  };

  const writeFile = (store, previous, data, file, verify) => {
    const temp = path.join(store.bucket, `active-${randomUUID()}.tmp`);
    try {
      const fd = files.openSync(temp, 'wx', 0o600);
      try { files.writeFileSync(fd, JSON.stringify({ ...data, checksum: hash(JSON.stringify(canonical(data))) })); files.fsyncSync(fd); }
      finally { files.closeSync(fd); }
      assertCurrent(store, previous, file);
      verify?.();
      files.renameSync(temp, file);
    } finally { try { files.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  };
  const testAttachment = attachment => {
    try { return !!attachment && same(rootAttachment(attachment.root, files), attachment); }
    catch { return false; }
  };
  const assertPhysical = attachment => {
    if (!testAttachment(attachment))
      throw fault('PROJECT_CRASH_RESUME_PROJECT_CHANGED', 'Project changed before navigation was recorded.');
  };
  const write = (store, previous, data) => writeFile(store, previous, data, store.file, () => assertPhysical(data.attachment));
  const creationFile = (store, id) => path.join(store.bucket, `creation-${id}.json`);
  const navigationFile = (store, id) => path.join(store.bucket, `navigation-${id}.json`);
  const rememberCreation = (store, record) => {
    if (!record?.creation) return;
    const file = creationFile(store, record.creation.createRequest.requestId), previous = readFile(file);
    const data = { version: 1, profile, project: record.project, attachment: record.attachment, creation: record.creation };
    if (previous) {
      if (!same(data, previous.record)) throw fault('PROJECT_CREATE_REQUEST_REUSED', 'The original creation identity changed.');
      return;
    }
    // The authoritative active record already preserves this historical proof.
    // A replaced or unavailable path still cannot attest to that old creation.
    writeFile(store, null, data, file);
  };

  const matchingCreation = (previous, project, query) => {
    const original = readProjectCreateRecovery(query), record = previous?.record;
    if (!original || !record?.creation || !same(readProjectCreateRecovery(record.creation), original)
      || typeof project !== 'string' || !path.isAbsolute(project) || key(project) !== key(record.project)
      || !same(record.executor, currentExecutor())) return { reason: 'unconfirmed' };
    let attachment;
    try { attachment = rootAttachment(record.project, files); } catch { /* An unavailable directory cannot attest to the original create. */ }
    return same(attachment, record.attachment) ? { record } : { reason: 'attachment-mismatch' };
  };
  const ownsCursor = (cursor, executor) => !cursor || same(cursor.executor, executor) || ownerState(cursor.executor) === 'exited';
  const sameProject = (left, right) => absolute(left) && absolute(right) && key(left) === key(right);
  const getNavigation = (store, reference) => {
    if (!reference) return null;
    const file = navigationFile(store, reference.navigationRequest.requestId), stored = readFile(file);
    if (!stored || !same(stored.record.reference, reference)) return null;
    return { ...stored, file };
  };
  const matchesView = (cursor, project, reference, attachment) => {
    if (!cursor || !same(cursor.navigation, reference) || !same(cursor.attachment, attachment)) return false;
    const executor = currentExecutor();
    if (cursor.closed) return project === null && ownsCursor(cursor, executor);
    return same(cursor.executor, executor) && sameProject(cursor.project, project);
  };
  const inspectNavigation = (store, cursor, project, reference) => {
    const stored = getNavigation(store, reference);
    if (!stored) return { ok: true, activationCurrent: false };
    const { activation, sourceAttachment } = stored.record;
    const result = stored.record.result ?? (activation?.state === 'closed'
      ? { ok: true, operation: 'project_close', project: null } : undefined);
    const attachment = activation?.state === 'open' ? activation.attachment : sourceAttachment;
    if (attachment && !testAttachment(attachment)) return { ok: true, activationCurrent: false, reason: 'attachment-mismatch' };
    const activationCurrent = !!activation && matchesView(cursor, project, reference, attachment);
    return { ok: true, activationCurrent, ...(activationCurrent ? { activationViewId: cursor.viewId } : {}),
      navigationReceipt: { ...reference.navigationRequest, state: result ? result.ok ? 'completed' : 'failed' : 'pending',
        ...(activation ? { activation } : {}), ...(sourceAttachment ? { sourceAttachment } : {}) },
      ...(result ? { result } : {}) };
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
    record(project, { creation, createdAttachment, restore } = {}) {
      return run(true, (store, previous) => {
        if (typeof project !== 'string' || !path.isAbsolute(project)) throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Expected an exact absolute project.');
        const physical = files.realpathSync(project);
        if (key(physical) !== key(project)) throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Linked project aliases do not grant a physical attachment.');
        const attachment = rootAttachment(physical, files), executor = currentExecutor();
        if (!attachment || attachment.identity.ino === '0') throw fault('PROJECT_CRASH_RESUME_PROJECT_INVALID', 'Project physical identity is unavailable.');
        const prior = previous?.record, sameOwner = prior && same(prior.executor, executor);
        if (prior && !sameOwner && ownerState(prior.executor) !== 'exited')
          throw fault('PROJECT_CRASH_RESUME_OWNER_ACTIVE', 'The existing navigation owner is live or unverified.');
        const activation = creation === undefined ? null : readCreation(creation);
        if (creation !== undefined && (!activation || !same(createdAttachment, attachment)))
          throw fault('PROJECT_CREATE_NAVIGATION_ATTACHMENT_CHANGED', 'The original creation does not match the active physical directory.');
        const resumed = prior?.creation && restore?.reason === 'interrupted'
          && same(restore.executor, prior.executor) && same(restore.creation, prior.creation)
          && same(restore.attachment, prior.attachment);
        const original = activation ?? (prior?.creation && same(prior.attachment, attachment) && (sameOwner || resumed) ? prior.creation : null);
        const navigationResumed = prior?.navigation && restore?.reason === 'interrupted'
          && same(restore.navigation, prior.navigation) && same(restore.executor, prior.executor);
        const sameView = !prior?.closed && same(prior?.attachment, attachment);
        const navigation = !activation && sameView && (sameOwner || navigationResumed) ? prior.navigation : undefined;
        const viewId = sameView && sameOwner && !activation ? prior.viewId ?? randomUUID() : randomUUID();
        const data = { version: 1, profile, project: physical, attachment, executor, viewId,
          ...(original ? { creation: original } : {}), ...(navigation ? { navigation } : {}),
          ...(navigation && prior.navigationAcknowledged === true ? { navigationAcknowledged: true } : {}) };
        if (previous && same(previous.record, data)) {
          if (activation) rememberCreation(store, data);
          return { ok: true, recorded: false, project: physical, reason: 'unchanged', activationViewId: viewId };
        }
        rememberCreation(store, prior);
        write(store, previous, data);
        if (activation) rememberCreation(store, data);
        return { ok: true, recorded: true, project: physical, activationViewId: viewId,
          ...(!activation && resumed && original ? { recoverySessionId: original.recoverySessionId } : {}),
          ...(navigationResumed && navigation && !data.navigationAcknowledged ? { recoverySessionId: navigation.sessionId } : {}) };
      });
    },
    recordNavigation(value, activation, sourceAttachment) {
      return run(true, (store, cursor) => {
        const reference = readProjectNavigationRecovery(value), executor = currentExecutor();
        if (!reference || reference.originalTargetPid !== executor.hostPid || !ownsCursor(cursor?.record, executor))
          throw fault('PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID', 'Navigation proof does not belong to this original owner.');
        const request = reference.navigationRequest;
        if (sourceAttachment && (!sameProject(sourceAttachment.root, request.sourceProject) || !testAttachment(sourceAttachment)))
          throw fault('PROJECT_NAVIGATION_SOURCE_CHANGED', 'The original navigation source was replaced.');
        const file = navigationFile(store, request.requestId), old = readFile(file), previous = old?.record;
        if (old && (!same(previous.reference, reference) || !same(previous.sourceAttachment, sourceAttachment)))
          throw fault('PROJECT_NAVIGATION_REQUEST_REUSED', 'The original navigation identity changed.');
        if (previous?.result || previous?.activation && (!activation || !same(previous.activation, activation)))
          return { ok: false, code: 'PROJECT_NAVIGATION_REQUEST_REUSED' };
        const data = { version: 1, profile, reference, ...(sourceAttachment ? { sourceAttachment } : {}),
          ...(activation ? { activation } : {}) };
        if (!activation) {
          if (!previous) writeFile(store, old, data, file);
          return { ok: true };
        }
        const open = request.operation === 'project_open' && activation.state === 'open';
        const attachment = open ? activation.attachment : sourceAttachment;
        const project = open ? activation.project : null;
        const active = cursor?.record;
        if (open ? !sameProject(project, request.targetProject) || !same(active?.attachment, attachment) || active?.closed
          : request.operation !== 'project_close' || activation.state !== 'closed' || activation.project !== null
            || !sameProject(attachment?.root, request.sourceProject) || active && (!active.closed || !same(active.navigation, reference))) {
          throw fault('PROJECT_NAVIGATION_CONTEXT_CHANGED', 'The persisted cursor does not match the original activation.');
        }
        assertPhysical(attachment);
        // Save the operation evidence independently from the active cursor.
        // A failed cursor write still cannot grant current activation.
        if (!previous?.activation) writeFile(store, old, data, file, () => assertPhysical(attachment));
        if (same(active?.navigation, reference)) return { ok: true, activationViewId: active.viewId };
        rememberCreation(store, active);
        const viewId = randomUUID();
        write(store, cursor, { version: 1, profile, project, attachment, executor, viewId, navigation: reference,
          ...(!open ? { closed: true } : {}) });
        return { ok: true, activationViewId: viewId };
      });
    },
    finishNavigation(value, result) {
      return run(false, (store, cursor) => {
        const reference = readProjectNavigationRecovery(value), stored = getNavigation(store, reference);
        const executor = currentExecutor();
        if (!reference || reference.originalTargetPid !== executor.hostPid || !stored || typeof result?.ok !== 'boolean')
          return { ok: false, code: 'PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID' };
        const { activation } = stored.record;
        if (result.ok && (!activation || (activation.state === 'open' ? !sameProject(activation.project, result.project) : result.project !== null)))
          return { ok: false, code: 'PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID' };
        const projected = { ok: result.ok, operation: reference.navigationRequest.operation,
          ...(activation ? { project: activation.project } : {}),
          ...(result.projectType === 'blockly' ? { projectType: 'blockly' } : {}),
          ...(typeof result.code === 'string' ? { code: result.code.slice(0, 96) } : {}),
          ...(typeof result.message === 'string' ? { message: result.message.slice(0, 1024) } : {}) };
        if (stored.record.result && !same(stored.record.result, projected))
          return { ok: false, code: 'PROJECT_NAVIGATION_REQUEST_REUSED' };
        if (!stored.record.result) writeFile(store, stored, { ...stored.record, result: projected }, stored.file);
        return { ok: true, activationViewId: cursor?.record.navigation && same(cursor.record.navigation, reference)
          ? cursor.record.viewId : undefined };
      });
    },
    observeNavigation(project, value) {
      return run(false, (store, previous) => inspectNavigation(store, previous?.record, project, readProjectNavigationRecovery(value)));
    },
    acknowledgeNavigation(project, value) {
      return run(false, (store, previous) => {
        const cursor = previous?.record;
        const observed = inspectNavigation(store, cursor, project, readProjectNavigationRecovery(value));
        if (!observed.activationCurrent || typeof project !== 'string') return { ok: true, acknowledged: false };
        if (cursor.navigationAcknowledged !== true) write(store, previous, { ...cursor, navigationAcknowledged: true });
        return { ok: true, acknowledged: true };
      });
    },
    canReopenFrom(value, project) {
      const reference = readProjectNavigationRecovery(value);
      if (!reference || reference.navigationRequest.operation !== 'project_close'
        || !sameProject(project, reference.navigationRequest.sourceProject)) return false;
      const observed = this.observeNavigation(null, reference);
      return observed.activationCurrent === true && observed.navigationReceipt?.state === 'completed';
    },
    observeOriginalCreation(project, query) {
      return run(false, (store, previous) => {
        const original = readProjectCreateRecovery(query);
        if (!original) return { ok: true, project: null, activationCurrent: false };
        const cursor = previous?.record;
        const { record: live } = matchingCreation(previous, project, query);
        const historical = readFile(creationFile(store, original.createRequest.requestId))?.record;
        const record = live ?? historical;
        if (!record?.creation || !same(readProjectCreateRecovery(record.creation), original)
          || !validAttachment(record.attachment, record.project) || !testAttachment(record.attachment))
          return { ok: true, project: null, activationCurrent: false };
        return { ok: true, project: record.project, attachment: record.attachment, creation: record.creation,
          activationCurrent: !!live, ...(live ? { activationViewId: cursor.viewId } : {}) };
      });
    },
    viewIdentity(project) {
      return run(false, (_store, previous) => {
        const record = previous?.record;
        if (record && same(record.executor, currentExecutor()) && testAttachment(record.attachment)
          && (record.closed ? project === null : sameProject(record.project, project))) return { activationViewId: record.viewId };
        return {};
      }).activationViewId;
    },
    observeCreation(project, query) {
      return run(false, (store, previous) => {
        const { record, reason } = matchingCreation(previous, project, query);
        if (!record) return { ok: true, project: null, reason };
        assertCurrent(store, previous);
        return { ok: true, project: record.project, attachment: record.attachment, creation: record.creation };
      });
    },
    acknowledgeCreation(project, query) {
      return run(false, (store, previous) => {
        const { record } = matchingCreation(previous, project, query);
        if (!record) return { ok: true, acknowledged: false };
        rememberCreation(store, record);
        const { creation: _acknowledged, ...navigation } = record;
        write(store, previous, navigation);
        return { ok: true, acknowledged: true };
      });
    },
    clear(project) {
      return run(false, (store, previous) => {
        if (!previous) return { ok: true, cleared: false, reason: 'no-record' };
        if (!same(previous.record.executor, currentExecutor())) return { ok: true, cleared: false, reason: 'different-owner' };
        if (project !== undefined && (typeof project !== 'string' || !path.isAbsolute(project) || key(project) !== key(previous.record.project)))
          return { ok: true, cleared: false, reason: 'different-project' };
        rememberCreation(store, previous.record);
        assertCurrent(store, previous); files.unlinkSync(store.file);
        return { ok: true, cleared: true };
      });
    },
    suspend() {
      return run(false, (store, previous) => {
        const record = previous?.record;
        if (!record || !same(record.executor, currentExecutor()) || record.navigation || record.creation)
          return { ok: true, cleared: false };
        assertCurrent(store, previous); files.unlinkSync(store.file);
        return { ok: true, cleared: true };
      });
    },
    interruptedProject() {
      return run(false, (store, previous) => {
        if (!previous) return { ok: true, project: null, reason: 'no-record' };
        const record = previous.record, state = ownerState(record.executor);
        if (state !== 'exited') return { ok: true, project: null, reason: state === 'active' ? 'owner-active' : 'owner-unknown' };
        if (record.closed) return { ok: true, project: null, reason: 'closed' };
        let attachment;
        try { attachment = rootAttachment(record.project, files); } catch { /* Preserve the record if the physical root is missing or unavailable. */ }
        if (!same(attachment, record.attachment)) return { ok: true, project: null, reason: 'attachment-mismatch' };
        assertCurrent(store, previous);
        return { ok: true, project: record.project, attachment: record.attachment, executor: record.executor,
          ...(record.creation ? { creation: record.creation } : {}),
          ...(record.navigation ? { navigation: record.navigation } : {}), reason: 'interrupted' };
      });
    },
  };
}

module.exports = { createProjectCrashResume, readProjectCreateRecovery, readProjectNavigationRecovery };
