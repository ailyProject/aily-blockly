'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectBuildWorkspaceIdle } = require('../child/scripts/build-workspace-lease');
const { getProcessState } = require('../child/scripts/process-state');
const { createProjectFileAccess } = require('./project-file-access');

const operations = new Set(['compile', 'preprocess', 'publish', 'clean', 'verify']);
const unconfirmedReasons = new Set(['owner-alive', 'delegation-unconfirmed', 'legacy-owner-unconfirmed',
  'builder-phase-unconfirmed', 'legacy-recovery-unconfirmed']);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const unverified = (reason, nativeCode) => ({ ok: false, code: 'PROJECT_RECOVERY_SOURCE_UNVERIFIED',
  build: { state: 'unverified', reason, ...(nativeCode ? { nativeCode } : {}) },
  message: 'Source build ownership could not be inspected safely; all existing records were retained.' });
const busy = (reason, owner) => ({ ok: false, code: 'PROJECT_RECOVERY_SOURCE_BUSY',
  build: { state: 'active', reason, ...(owner ? { owner } : {}) },
  message: 'An active build still owns this source. No recovery copy was admitted and no owner was released.' });

function readRetainedOwner(project, details) {
  const root = fs.realpathSync(project), access = createProjectFileAccess(root, project);
  const directory = path.join(root, '.build'); access.checkDirectory(directory);
  const filename = details.recordPath;
  if (typeof filename !== 'string' || !path.isAbsolute(filename)
    || key(path.dirname(filename)) !== key(directory)
    || !['aily-workspace.lock', 'aily-builder.lock', 'aily-workspace-recovery.lock'].includes(path.basename(filename)))
    throw new Error('The build observation did not identify its exact source record.');
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 4 * 1024 * 1024)
    throw new Error('The retained build record is unsafe.');
  const bytes = access.readRegular(filename), after = fs.lstatSync(filename);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('The retained build record changed during observation.');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); }
  catch { record = JSON.parse(bytes.toString('utf8').split('\n', 1)[0]); }
  if (record?.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1
    || typeof record.token !== 'string' || !/^[a-f0-9-]{36}$/.test(record.token)
    || !operations.has(record.operation) || record.pid !== details.owner?.pid || record.operation !== details.owner?.operation
    || record.nativeLeaseVersion !== undefined && record.nativeLeaseVersion !== 1
    || record.delegationVersion !== undefined && record.delegationVersion !== 1
    || record.delegated !== undefined && typeof record.delegated !== 'boolean'
    || record.released !== undefined && typeof record.released !== 'boolean')
    throw new Error('The retained build record is unsupported or differs from its observation.');
  access.checkRoot(); access.checkDirectory(directory);
  return { pid: record.pid, operation: record.operation };
}

/** Observation for a saved-source copy, not a build lease or a takeover.
 * The caller separately retains source-file publication exclusion and omits
 * build/runtime outputs. Unknown old compiler descendants remain protected in
 * the source, but do not prevent continuing in an independent saved copy. */
function inspectProjectCopyBuild(project) {
  let lease;
  try {
    lease = inspectBuildWorkspaceIdle(project); lease.assertIdle();
    return { ok: true, build: { state: 'idle' } };
  } catch (error) {
    const details = error?.details;
    if (details?.resource !== 'build-workspace') return unverified('inspection-failed', error?.code);
    // A held native guard is direct live ownership, even with no readable PID.
    if (details.reason === 'native-guard-unavailable' && error.code === 'BUILD_WORKSPACE_BUSY')
      return busy(details.reason, details.owner);
    if (!unconfirmedReasons.has(details.reason)) return unverified(details.reason || 'inspection-failed', error.code);
    let owner;
    try { owner = readRetainedOwner(project, details); }
    catch { return unverified('record-unverified', error.code); }
    const state = getProcessState(owner.pid);
    if (state === true) return busy(details.reason, owner);
    return { ok: true, build: { state: 'ownership-unconfirmed', reason: details.reason,
      owner: { ...owner, processState: state === false ? 'exited' : 'unknown' } } };
  } finally { lease?.release(); }
}

module.exports = { inspectProjectCopyBuild };
