'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { tryAcquireFileLock } = require('../child/scripts/native-file-lock');
const { inspectBuildWorkspaceIdle } = require('../child/scripts/build-workspace-lease');
const { createProjectFileAccess, acquireProjectFileLock, assertNoPendingAbsGeneration } = require('./project-file-access');
const { createProjectRecoveryReceipts } = require('./project-recovery-receipts');
const legacy = require('./project-repair-environment');
const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
const ID = /^[A-Za-z0-9_-]{8,96}$/;
const fault = (code, message, details) => Object.assign(new Error(message), { code, details });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown'; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : 'unknown'; } };
const location = record => path.join(record.parentAppData, 'agent-repair-environments', 'lineages', record.lineageId || record.environmentId);
const currentFile = directory => path.join(directory, 'current.json');
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Repair lineage directory is linked.');
}
function registerRepairLineage(record, recordFile) {
  const directory = location(record); privateDirectory(directory);
  const originFile = path.join(directory, 'origin.json');
  if (!fs.existsSync(originFile)) {
    const origin = { version: 1, lineageId: record.environmentId, project: record.project, sourceProject: record.sourceProject,
      requestId: record.requestId, originParentHostPid: record.parentHostPid, sourceRendererGeneration: record.sourceRendererGeneration,
      originalRecordFile: recordFile, hostCodeIdentity: record.hostCodeIdentity };
    try { legacy.writeNew(originFile, origin); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!fs.existsSync(currentFile(directory))) {
    try { legacy.writeNew(currentFile(directory), { version: 1, lineageId: record.environmentId, epoch: 0,
      ownerHostPid: record.parentHostPid, environmentId: record.environmentId, recordFile, hostPid: record.hostPid,
      sourceView: record.originalViewPreserved === true ? 'retained' : 'unavailable' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return directory;
}
function readLineage(directory, expectedCode) {
  const origin = legacy.readJson(path.join(directory, 'origin.json')), current = legacy.readJson(currentFile(directory));
  if (origin.version !== 1 || current.version !== 1 || origin.lineageId !== path.basename(directory)
    || current.lineageId !== origin.lineageId || !Number.isSafeInteger(current.epoch) || current.epoch < 0
    || !Number.isSafeInteger(current.ownerHostPid) || current.ownerHostPid < 1
    || expectedCode && origin.hostCodeIdentity !== expectedCode) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Repair lineage identity is unsupported or belongs to another build.');
  const record = legacy.readJson(current.recordFile);
  if (!same(record.project, origin.project) || !same(record.sourceProject, origin.sourceProject) || record.requestId !== origin.requestId
    || record.environmentId !== current.environmentId || record.hostCodeIdentity !== origin.hostCodeIdentity
    || record.hostPid !== current.hostPid || !same(location(record), directory)) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Active repair epoch differs from its durable origin.');
  const original = legacy.verifyFork(record.parentAppData, origin.sourceProject, origin.requestId, false, record.physicalOrigin, record.admission);
  if (!same(original.result.project, origin.project)) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Fork origin does not match this exact target.');
  return { directory, origin, current, record, original };
}
function recordEpoch(directory, current) {
  const epochs = path.join(directory, 'owners'); privateDirectory(epochs);
  const ownerFacts = value => ({ version: value.version, lineageId: value.lineageId, epoch: value.epoch,
    ownerHostPid: value.ownerHostPid, environmentId: value.environmentId, recordFile: value.recordFile, hostPid: value.hostPid });
  const file = path.join(epochs, `${current.epoch}.json`), text = JSON.stringify(ownerFacts(current));
  try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST' || JSON.stringify(ownerFacts(legacy.readJson(file))) !== text) throw error; }
}
function environment(facts, state = facts.record.state) {
  const { origin, current, record } = facts;
  return { version: 2, state, project: origin.project, sourceProject: origin.sourceProject,
    parentHostPid: current.ownerHostPid, ...(current.hostPid ? { hostPid: current.hostPid } : {}), requestId: origin.requestId,
    environmentId: current.environmentId, hostCodeIdentity: record.hostCodeIdentity, lineageId: origin.lineageId,
    epoch: current.epoch, sourceView: current.sourceView,
    ...(current.sourceView === 'retained' ? { originalViewPreserved: true } : {}) };
}
function readChildLineageIdentity(record, params, pid = process.pid) {
  const directory = location(record);
  if (!fs.existsSync(currentFile(directory))) return null;
  const facts = readLineage(directory, record.hostCodeIdentity), current = facts.current;
  const v2 = params?.version === 2 && params.lineageId === facts.origin.lineageId && params.epoch === current.epoch;
  const initialCompatibility = params?.version === undefined && current.epoch === 0;
  if ((!v2 && !initialCompatibility) || !same(params?.project, record.project)
    || params.environmentId !== current.environmentId || params.requestId !== record.requestId
    || params.parentHostPid !== current.ownerHostPid || current.hostPid !== pid
    || current.environmentId !== record.environmentId)
    return { ok: false, operation: 'project_repair_identity', code: 'PROJECT_REPAIR_IDENTITY_MISMATCH', message: 'The repair epoch or native owner changed; inspect its durable lineage.' };
  return { ok: true, operation: 'project_repair_identity', repairEnvironment: { ...environment(facts),
    ...(facts.record.initialNormalization ? { initialNormalization: facts.record.initialNormalization } : {}) } };
}

/** Immutable fork ancestry and current target observations are separate facts.
 * A resume request may adopt a live child or start one known-idle new epoch;
 * neither operation can release source protection or replace the source view. */
function createRepairContinuationController(options) {
  const { appDataPath, execPath, appPath, env = process.env, serve = false } = options;
  const pid = options.pid || process.pid, hostCodeIdentity = legacy.codeIdentity(execPath, appPath);
  const processState = options.processState || alive, query = options.queryChild || legacy.queryChild, launch = options.spawnChild || spawn;
  const root = path.join(appDataPath, 'agent-repair-environments');
  const hashAbi = project => createProjectRecoveryReceipts(appDataPath).abiHash(project);
  function find(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'A repair inspection requires its exact absolute target.');
    if (!fs.existsSync(root)) throw fault('PROJECT_REPAIR_LINEAGE_NOT_FOUND', 'No native repair lineage exists for this target.');
    const matches = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const recordFile = path.join(root, entry.name), record = legacy.readJson(recordFile);
      if (!same(record.project, target)) continue;
      if (record.hostCodeIdentity !== hostCodeIdentity) throw fault('PROJECT_REPAIR_BUILD_CHANGED', 'This saved repair environment belongs to another host build.');
      legacy.verifyFork(record.parentAppData, record.sourceProject, record.requestId, false, record.physicalOrigin, record.admission);
      matches.push(registerRepairLineage(record, recordFile));
    }
    if (matches.length !== 1) throw fault('PROJECT_REPAIR_LINEAGE_NOT_FOUND', 'Exactly one native fork lineage must match the associated target.');
    return readLineage(matches[0], hostCodeIdentity);
  }
  function sourceView(facts) {
    return facts.origin.originParentHostPid === pid && processState(pid) === true
      && options.sourceViewRetained?.(facts.origin) === true ? 'retained' : 'unavailable';
  }
  const publicRecord = facts => ({ ...facts.record, lineageId: facts.origin.lineageId, epoch: facts.current.epoch,
    parentHostPid: facts.current.ownerHostPid });
  function reply(facts, operation, resumeRequestId, state, extra = {}) {
    facts = { ...facts, current: { ...facts.current, sourceView: sourceView(facts) } };
    if (extra.pendingResume || state === 'starting' && facts.record.launchState !== 'prepared') return { ok: false, operation, project: facts.origin.project,
      code: 'PROJECT_REPAIR_ENVIRONMENT_STARTING', repairEnvironment: environment(facts, state),
      pendingResume: { ...(resumeRequestId ? { resumeRequestId } : {}), state: 'starting', epoch: facts.current.epoch },
      sourceGuardReleased: false, originalWorkspaceRebound: false, ...extra };
    const currentAbiHash = hashAbi(facts.origin.project);
    if (!currentAbiHash) throw fault('PROJECT_REPAIR_PRIMARY_UNAVAILABLE', 'The current saved target ABI is missing.');
    return { ok: true, operation, project: facts.origin.project, repairEnvironment: environment(facts, state),
      recoveryContinuation: { version: 1, scope: 'native-durable-repair-lineage', sourceProject: facts.origin.sourceProject,
        project: facts.origin.project, requestId: facts.origin.requestId, ...(resumeRequestId ? { resumeRequestId } : {}),
        ownerHostPid: facts.current.ownerHostPid, lineageId: facts.origin.lineageId, epoch: facts.current.epoch,
        hostCodeIdentity, currentAbiHash, sourceView: facts.current.sourceView,
        originalForkSourceAbiHash: facts.original.receipt.sourceAbiHash, sourceGuardReleased: false, originalWorkspaceRebound: false,
        initialNormalization: facts.record.initialNormalization || null }, ...extra };
  }
  function pending(facts) {
    const directory = path.join(facts.directory, 'requests');
    if (!fs.existsSync(directory)) return undefined;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.json')) continue;
      const request = legacy.readJson(path.join(directory, file));
      if (request.state === 'pending') return { resumeRequestId: request.resumeRequestId, state: 'unknown', epoch: request.epoch };
    }
  }
  function retryable(facts) {
    const directory = path.join(facts.directory, 'requests');
    if (!fs.existsSync(directory)) return undefined;
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.json')) continue;
      const request = legacy.readJson(path.join(directory, file));
      if (request.state === 'preparing' || request.state === 'not-started') return {
        resumeRequestId: request.resumeRequestId, state: 'not-started',
        phase: request.failure?.phase || 'preparation', code: request.failure?.code || 'PROJECT_REPAIR_PREPARATION_INTERRUPTED' };
    }
  }
  const retryAction = (project, requestId, retry) => ({ tool: 'project_recover',
    input: { project, action: 'resume_environment', requestId, resumeRequestId: retry.resumeRequestId } });
  function guard(facts) {
    const handle = tryAcquireFileLock(path.join(facts.directory, 'lineage.guard'));
    if (!handle) throw fault('PROJECT_REPAIR_LINEAGE_BUSY', 'Another native resume owns this lineage.', { resource: 'repair-lineage', requestId: facts.origin.requestId });
    return handle;
  }
  function rememberPhysicalOrigin(facts) {
    if (facts.record.physicalOrigin) return facts;
    // This function is called only with the lineage guard held and after a
    // fresh source/target physical-independence check, never from missing data.
    const physicalOrigin = facts.original.physicalOrigin;
    const original = legacy.readJson(facts.origin.originalRecordFile);
    if (!same(original.project, facts.origin.project) || !same(original.sourceProject, facts.origin.sourceProject)
      || original.requestId !== facts.origin.requestId) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Cannot upgrade a different physical origin.');
    legacy.writeRecord(facts.origin.originalRecordFile, { ...original, physicalOrigin });
    if (!same(facts.current.recordFile, facts.origin.originalRecordFile)) legacy.writeRecord(facts.current.recordFile, { ...facts.record, physicalOrigin });
    return readLineage(facts.directory, hostCodeIdentity);
  }
  async function inspect(params) {
    if (params?.version !== 1 || Object.keys(params).some(name => !['version', 'project'].includes(name))) throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Repair inspection accepts only its exact target.');
    let facts = find(params.project), lock = guard(facts);
    try {
      facts = rememberPhysicalOrigin(readLineage(facts.directory, hostCodeIdentity));
      // Inspection does not transfer ownership, even when this is a new parent.
      const status = processState(facts.current.hostPid), authenticated = status === true ? await query(publicRecord(facts)) : null;
      const uncertain = pending(facts), retry = uncertain ? undefined : retryable(facts);
      return reply(facts, 'project_repair_inspect', undefined,
        authenticated?.state || (facts.record.launchState === 'prepared' ? 'starting' : status === false ? 'failed' : 'starting'),
        { ...(uncertain ? { pendingResume: uncertain } : {}),
          ...(retry ? { retryableResume: retry, nextAction: retryAction(facts.origin.project, facts.origin.requestId, retry) } : {}),
          childState: facts.record.launchState === 'prepared' ? 'never-started' : status === false ? 'exited' : authenticated ? 'authenticated' : 'unknown' });
    } finally { lock.close(); }
  }
  async function reserveTarget(facts, allowChildView = false, resumeRequestId) {
    const rootPath = fs.realpathSync(facts.origin.project), access = createProjectFileAccess(rootPath, facts.origin.project);
    const check = () => access.checkRoot();
    let writer;
    try { writer = await acquireProjectFileLock(access, check, 0); }
    catch (error) { throw fault('PROJECT_REPAIR_TARGET_BUSY', 'A file/library writer remains. Its lock was retained; no new epoch was started.',
      { resource: 'project-files.write.lock', path: path.join(rootPath, '.aily', 'project-files.write.lock'), cause: error.code,
        owner: readOwner(path.join(rootPath, '.aily', 'project-files.write.lock')) }); }
    let build;
    try {
      build = (options.inspectBuildIdle || inspectBuildWorkspaceIdle)(rootPath); assertNoPendingAbsGeneration(access);
      const views = options.projectViewLocks || require('./project-lock');
      const view = views.readViewLockSnapshot(rootPath), open = view?.owner;
      let projectViewRecovery;
      if (open && !(allowChildView && open.pid === facts.current.hostPid)) {
        if (open.pid !== facts.current.hostPid || !same(open.execPath, facts.record.execPath) || processState(open.pid) !== false)
          throw fault('PROJECT_REPAIR_TARGET_BUSY', 'The target still has an active or unknown project-view owner.', { resource: 'project-open.lock', owner: open });
        const archives = path.join(facts.directory, 'retired-views'); privateDirectory(archives);
        const archive = path.join(archives, randomUUID() + '.json');
        legacy.writeNew(archive, { version: 1, project: facts.origin.project, lineageId: facts.origin.lineageId,
          epoch: facts.current.epoch, resumeRequestId, snapshot: view });
        const recovered = views.recoverExitedViewLock(rootPath, view,
          () => { writer.assertOwned(); build.assertIdle(); }, pid => processState(pid) === false);
        if (!recovered.ok) throw fault('PROJECT_REPAIR_TARGET_BUSY', recovered.error || 'The known exited view changed before handoff.',
          { resource: 'project-open.lock', owner: open, cause: recovered.code });
        projectViewRecovery = { version: 1, previousOwnerPid: open.pid, previousViewHash: view.hash, archive };
      }
      writer.assertOwned(); build.assertIdle();
      return { hash: hashAbi(facts.origin.project), projectViewRecovery, assertIdle: () => { writer.assertOwned(); build.assertIdle(); },
        release: () => { build.release(); writer.release(); } };
    } catch (error) { build?.release(); writer.release(); throw error; }
  }
  async function resume(params) {
    if (params?.version !== 1 || !ID.test(params.requestId || '') || !ID.test(params.resumeRequestId || '')
      || Object.keys(params).some(name => !['version', 'project', 'sourceProject', 'requestId', 'resumeRequestId'].includes(name)))
      throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Resume requires the exact target, original fork and stable resume request.');
    let facts = find(params.project), lock = guard(facts);
    try {
      facts = rememberPhysicalOrigin(readLineage(facts.directory, hostCodeIdentity));
      if (!same(params.sourceProject, facts.origin.sourceProject) || params.requestId !== facts.origin.requestId)
        throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Resume does not match this target origin.');
      const directory = path.join(facts.directory, 'requests'); privateDirectory(directory);
      const requestFile = path.join(directory, params.resumeRequestId + '.json');
      const oldRequest = fs.existsSync(requestFile) ? legacy.readJson(requestFile) : null;
      const state = processState(facts.current.hostPid), authenticated = state === true ? await query(publicRecord(facts)) : null;
      if (oldRequest) {
        if (oldRequest.resumeRequestId !== params.resumeRequestId || oldRequest.requestId !== params.requestId)
          throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'Resume request belongs to a different lineage.');
        if (!['preparing', 'not-started'].includes(oldRequest.state)) return reply(facts, 'project_repair_resume', params.resumeRequestId,
          authenticated?.state || (state === false ? 'failed' : 'starting'), { resumeState: oldRequest.state,
            ...(oldRequest.state === 'pending' ? { pendingResume: { resumeRequestId: params.resumeRequestId, state: 'unknown', epoch: oldRequest.epoch } } : {}),
            childState: state === false ? 'exited' : authenticated ? 'authenticated' : 'unknown' });
      }
      const unknown = pending(facts);
      if (unknown) return reply(facts, 'project_repair_resume', unknown.resumeRequestId, 'starting', { pendingResume: unknown, resumeState: 'pending', childState: 'unknown' });
      const known = retryable(facts);
      if (known && known.resumeRequestId !== params.resumeRequestId) return { ok: false, operation: 'project_repair_resume', project: facts.origin.project,
        code: 'PROJECT_REPAIR_NOT_STARTED', retryableResume: known, nextAction: retryAction(facts.origin.project, facts.origin.requestId, known),
        sourceGuardReleased: false, originalWorkspaceRebound: false };
      if (state !== false && !authenticated && facts.record.launchState !== 'prepared') return reply(facts, 'project_repair_resume', params.resumeRequestId, 'starting', { resumeState: 'not-started', childState: 'unknown' });
      const transfer = facts.current.ownerHostPid !== pid;
      if (transfer && processState(facts.current.ownerHostPid) !== false) throw fault('PROJECT_REPAIR_OWNER_STILL_ACTIVE',
        'The previous native owner is alive or unconfirmed; this host did not change repair ownership or start a new epoch.',
        { resource: 'repair-owner', owner: { pid: facts.current.ownerHostPid }, requestId: facts.origin.requestId });
      if (authenticated) {
        const reservation = transfer ? await reserveTarget(facts, true) : null;
        try {
          if (transfer) {
            const status = await query(publicRecord(facts), undefined, 'project_repair_adoptable');
            if (status?.ownerStatus?.idle !== true) throw fault('PROJECT_REPAIR_TARGET_BUSY',
              'The authenticated child still has a lifecycle or runtime writer; ownership was not changed.', { resource: 'repair-child-runtime', owner: { pid: facts.current.hostPid } });
            reservation.assertIdle();
          }
          const epoch = facts.current.epoch + (transfer || facts.current.epoch === 0 ? 1 : 0);
          const next = { ...facts.current, epoch, ownerHostPid: pid, sourceView: sourceView(facts) };
          recordEpoch(facts.directory, facts.current); recordEpoch(facts.directory, next);
          legacy.writeRecord(currentFile(facts.directory), next);
          legacy.writeNew(requestFile, { version: 1, requestId: params.requestId, resumeRequestId: params.resumeRequestId, epoch, state: 'completed' });
          facts = readLineage(facts.directory, hostCodeIdentity);
          return reply(facts, 'project_repair_resume', params.resumeRequestId, authenticated.state, { resumeState: 'completed', childState: 'authenticated' });
        } finally { reservation?.release(); }
      }
      const reservation = await reserveTarget(facts, false, params.resumeRequestId);
      try {
        const epoch = facts.current.epoch + 1, environmentId = randomUUID();
        const epochs = path.join(facts.directory, 'epochs'); privateDirectory(epochs);
        const privateRoot = path.join(epochs, environmentId); privateDirectory(privateRoot);
        const recordFile = path.join(epochs, `${epoch}-${environmentId}.json`);
        const record = { ...facts.record, state: 'starting', launchState: 'starting', environmentId, lineageId: facts.origin.lineageId, epoch,
          parentHostPid: pid, hostPid: null, targetAbiHash: reservation.hash,
          privateAppData: path.join(privateRoot, 'appdata'), profile: path.join(privateRoot, 'profile'),
          initialNormalization: null, originalViewPreserved: sourceView(facts) === 'retained' };
        record.projectViewRecovery = reservation.projectViewRecovery;
        const request = { version: 1, requestId: params.requestId, resumeRequestId: params.resumeRequestId, epoch,
          attemptId: environmentId, recordFile, state: 'preparing' };
        (oldRequest ? legacy.writeRecord : legacy.writeNew)(requestFile, request);
        const notStarted = (error, phase) => {
          const failure = { phase, code: error.code || 'PROJECT_REPAIR_PREPARATION_FAILED', message: error.message };
          legacy.writeRecord(requestFile, { ...request, state: 'not-started', failure });
          const retry = { resumeRequestId: params.resumeRequestId, state: 'not-started', phase, code: failure.code };
          return Object.assign(fault('PROJECT_REPAIR_NOT_STARTED', 'The repair process was not started. Correct the reported preparation error and resume the same request.', failure),
            { retryableResume: retry, nextAction: retryAction(facts.origin.project, facts.origin.requestId, retry) });
        };
        let launchOptions;
        try {
          legacy.writeNew(recordFile, record); legacy.seedPrivateData(record, appDataPath); reservation.assertIdle();
          launchOptions = { env: legacy.childEnvironment(env, record, recordFile), cwd: appPath, detached: false, windowsHide: true, stdio: 'ignore' };
        } catch (error) { throw notStarted(error, 'preparation'); }
        // Only this durable boundary makes a crash ambiguous. Preparing evidence
        // proves no launch was permitted; missing PID after launch remains unknown.
        legacy.writeRecord(requestFile, { ...request, state: 'pending', phase: 'launching' });
        let child;
        try { child = launch(execPath, [appPath, ...(serve ? ['--serve'] : []), `--user-data-dir=${record.profile}`], launchOptions); }
        catch (error) {
          // Only Node's synchronous argument-validation rejection proves the
          // launch was never submitted. An arbitrary launcher/ACK exception is
          // deliberately still an unknown pending outcome.
          if (['ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_OUT_OF_RANGE', 'ERR_MISSING_ARGS'].includes(error.code))
            throw notStarted(error, 'launch-rejected');
          throw error;
        }
        child?.once?.('error', () => {});
        if (!Number.isSafeInteger(child?.pid) || child.pid < 1) throw fault('PROJECT_REPAIR_SPAWN_UNCONFIRMED', 'A new repair process could not be confirmed. Preserve this request for inspection.');
        legacy.writeNew(path.join(privateRoot, 'spawn.json'), { pid: child.pid, environmentId });
        record.hostPid = child.pid; legacy.writeRecord(recordFile, record);
        const next = { version: 1, lineageId: facts.origin.lineageId, epoch, ownerHostPid: pid,
          environmentId, recordFile, hostPid: child.pid, sourceView: sourceView(facts) };
        recordEpoch(facts.directory, facts.current); recordEpoch(facts.directory, next);
        legacy.writeRecord(currentFile(facts.directory), next);
        legacy.writeRecord(requestFile, { version: 1, requestId: params.requestId, resumeRequestId: params.resumeRequestId, epoch, state: 'completed' });
        child.unref?.();
        facts = readLineage(facts.directory, hostCodeIdentity);
        return reply(facts, 'project_repair_resume', params.resumeRequestId, 'starting', { resumeState: 'completed', childState: 'starting' });
      } finally { reservation.release(); }
    } finally { lock.close(); }
  }
  const safely = (operation, params, action) => action(params).catch(error => ({ ok: false, operation, project: params?.project,
    code: error.code || 'PROJECT_REPAIR_CONTINUATION_FAILED', message: error.message, details: error.details,
    sourceGuardReleased: false, originalWorkspaceRebound: false,
    ...(error.retryableResume ? { retryableResume: error.retryableResume, nextAction: error.nextAction } : {}),
    ...(error.code === 'PROJECT_REPAIR_HISTORICAL_PROOF_UNAVAILABLE' ? {
      nextAction: { tool: 'project_recover', input: { project: params?.project, action: 'inspect' } },
      guidance: 'Inspect the preserved current target using the normal recovery tool. An offered complete independent-copy route can continue without inventing historical source evidence.' } : {}),
    ...(error.code === 'PROJECT_REPAIR_EVIDENCE_CHANGED' ? {
      nextAction: { tool: 'project_recover', input: { project: params?.project, action: 'inspect_environment' } } } : {}),
    recoverability: { state: error.retryableResume ? 'not-started' : error.code === 'PROJECT_REPAIR_HISTORICAL_PROOF_UNAVAILABLE'
      ? 'historical-proof-unavailable' : error.code === 'PROJECT_REPAIR_EVIDENCE_CHANGED' ? 'observation-raced' : 'blocked-by-owner',
      automaticTakeover: false, doNotDeleteLocks: true, doNotRetryBlindly: true },
    observeAction: { tool: 'project_recover', input: { project: params?.project, action: 'inspect_environment' } },
    resumeCondition: error.code === 'PROJECT_REPAIR_EVIDENCE_CHANGED'
      ? 'Read the exact target lineage again. A raced observation does not authorize replaying a mutation, deleting a lease, or changing its request nonce.'
      : 'Resume only after the reported owner/resource state changes. Observation does not authorize retrying mutation, deleting a lease, or choosing a different request nonce.' }));
  return { inspect: params => safely('project_repair_inspect', params, inspect), resume: params => safely('project_repair_resume', params, resume),
    async handoffTarget({ project, sourceProject, requestId }) {
      let facts;
      try { facts = find(project); }
      catch (error) { if (error.code === 'PROJECT_REPAIR_LINEAGE_NOT_FOUND') return null; throw error; }
      const lock = guard(facts);
      let historicalSource;
      try {
        facts = readLineage(facts.directory, hostCodeIdentity);
        if (!same(facts.origin.sourceProject, sourceProject) || facts.origin.requestId !== requestId
          || facts.record.admission?.kind !== 'authenticated-repair-child')
          throw fault('PROJECT_REPAIR_LINEAGE_INVALID', 'The saved handoff belongs to another native source or request.');
        if (facts.current.ownerHostPid !== pid) throw fault('PROJECT_REPAIR_OWNER_STILL_ACTIVE',
          'Resume the exact saved target under its current native owner before observing an earlier handoff.',
          { resource: 'repair-owner', owner: { pid: facts.current.ownerHostPid }, requestId });
        historicalSource = { ...facts.record.admission.sourceEnvironment };
      } finally { lock.close(); }
      return { sourceEnvironment: historicalSource, observation: await inspect({ version: 1, project }) };
    },
    async authenticatedSource(expected) {
      if (expected?.version !== 2 || expected.parentHostPid !== pid) throw fault('PROJECT_REPAIR_IDENTITY_MISMATCH', 'The delegated source is not owned by this native parent.');
      let facts = find(expected.project), lock = guard(facts);
      try {
        facts = rememberPhysicalOrigin(readLineage(facts.directory, hostCodeIdentity));
        const actual = environment(facts);
        for (const name of ['project', 'sourceProject', 'parentHostPid', 'hostPid', 'requestId', 'environmentId', 'lineageId', 'epoch', 'hostCodeIdentity']) {
          if (actual[name] !== expected[name]) throw fault('PROJECT_REPAIR_IDENTITY_MISMATCH', 'The delegated source differs from its native owner lineage.');
        }
        if (processState(actual.hostPid) !== true) throw fault('PROJECT_REPAIR_IDENTITY_MISMATCH', 'The delegated source process is not confirmed alive.');
        const authenticated = await query(publicRecord(facts));
        if (!authenticated || !['ready', 'load-failed'].includes(authenticated.state)) throw fault('PROJECT_REPAIR_IDENTITY_MISMATCH', 'The delegated source did not authenticate its current native child.');
        return { ...publicRecord(facts), state: authenticated.state };
      } finally { lock.close(); }
    } };
}
function readOwner(file) { try { return legacy.readJson(file, 4 * 1024 * 1024); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function checkRepairProjectOpen(record, requestedProject, pid = process.pid) {
  if (!same(record.project, requestedProject)) return { ok: false, code: 'PROJECT_REPAIR_TARGET_MISMATCH', error: 'An independent repair host may open only its exact native target.' };
  const owner = readOwner(path.join(record.project, '.aily', 'project-open.lock'));
  if (owner && owner.pid !== pid) return { ok: false, code: 'PROJECT_REPAIR_TARGET_BUSY', error: 'Another project-view record remains; recovery never forces or deletes it.', owner: { pid: owner.pid } };
  return null;
}
module.exports = { createRepairContinuationController, registerRepairLineage, readChildLineageIdentity, checkRepairProjectOpen };
