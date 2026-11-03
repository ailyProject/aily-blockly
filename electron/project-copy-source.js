'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createProjectFileAccess, acquireProjectFileLock, projectFileGuard } = require('./project-file-access');
const { childScriptPath } = require('./child-script-path');
const { getProcessState } = require(childScriptPath('process-state.js'));
const { inspectProjectCopyBuild } = require('./project-copy-admission');

const fail = (code, message) => Object.assign(new Error(message), { code });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

function readOwner(access) {
  access.checkRoot(); access.checkDirectory(path.join(access.root, '.aily'));
  const filename = path.join(access.root, '.aily/project-files.write.lock'), before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024)
    throw fail('PROJECT_RECOVERY_SOURCE_UNVERIFIED', 'The retained source-file owner record is unsafe.');
  const bytes = access.readRegular(filename), after = fs.lstatSync(filename);
  if (!bytes || !sameFile(before, after)) throw fail('PROJECT_RECOVERY_SOURCE_CHANGED', 'The source-file owner record changed while reading.');
  let owner;
  try { owner = JSON.parse(bytes.toString('utf8')); }
  catch { throw fail('PROJECT_RECOVERY_SOURCE_UNVERIFIED', 'The retained source-file owner record is incomplete.'); }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || Object.keys(owner).some(name => !['pid', 'token'].includes(name))
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(owner.token))
    throw fail('PROJECT_RECOVERY_SOURCE_UNVERIFIED', 'The retained source-file owner format is unsupported.');
  return { bytes, identity: after, owner };
}

function retainedDeadOwner(access) {
  let captured;
  try { captured = readOwner(access); }
  catch (error) { throw error.code ? error : fail('PROJECT_RECOVERY_SOURCE_UNVERIFIED', 'Source-file ownership could not be inspected safely.'); }
  const state = getProcessState(captured.owner.pid);
  if (state !== false) throw fail('PROJECT_RECOVERY_SOURCE_BUSY',
    'The source-file writer is alive or unconfirmed. Its record was retained; no copy was started.');
  return () => {
    let actual;
    try { actual = readOwner(access); }
    catch { throw fail('PROJECT_RECOVERY_SOURCE_CHANGED', 'The retained source-file owner changed during the copy.'); }
    if (!sameFile(captured.identity, actual.identity) || !captured.bytes.equals(actual.bytes)
      || getProcessState(actual.owner.pid) !== false)
      throw fail('PROJECT_RECOVERY_SOURCE_CHANGED', 'The exact exited source-file owner is no longer confirmed.');
  };
}

function runCallback(callback, guard) {
  return new Promise((resolve, reject) => {
    let returned = false, pending, settled = false;
    const finish = result => {
      if (result?.ok === true) resolve();
      else if (result?.ok === false && typeof result.error?.message === 'string')
        reject(Object.assign(new Error(result.error.message), {
          code: typeof result.error.code === 'string' ? result.error.code : 'PROJECT_RECOVERY_COPY_FAILED',
          ...(result.error.uncertain === true ? { uncertain: true } : {}) }));
      else reject(fail('PROJECT_RECOVERY_COPY_INVALID', 'Invalid source-copy callback settlement.'));
    };
    const settle = result => {
      if (settled) return;
      settled = true;
      if (returned) finish(result); else pending = result;
    };
    try {
      const value = callback(guard, settle); returned = true;
      if (value !== undefined) {
        if (value && typeof value.catch === 'function') value.catch(() => {});
        reject(fail('PROJECT_RECOVERY_COPY_INVALID', 'Source-copy callbacks must return void and settle explicitly.'));
      } else if (settled) finish(pending);
    } catch (error) { reject(error); }
  });
}

/** Copy-only coordination. No write/replace/release capability crosses to the
 * renderer. A conclusively exited legacy marker stays intact and continues to
 * block source publications; only a stable read-only copy may use that scope. */
async function withProjectCopySource(project, assertCurrent, callback) {
  let lock, active = true, callbackStarted = false, callbackCompleted = false, result;
  try {
    const context = projectFileGuard(assertCurrent);
    if (typeof project !== 'string' || !path.isAbsolute(project) || typeof callback !== 'function')
      throw fail('PROJECT_RECOVERY_COPY_INVALID', 'A source copy requires its exact project and callback.');
    context();
    const root = await fs.promises.realpath(project); context();
    const access = createProjectFileAccess(root, project);
    let physical, mode = 'exclusive';
    try { lock = await acquireProjectFileLock(access, context, 0); physical = lock.assertOwned; }
    catch (error) {
      // This fallback is restricted to acquisition itself. Callback errors can
      // never be mistaken for a reason to replay publication without a lock.
      if (error.code !== 'PROJECT_FILE_BUSY') throw error;
      physical = retainedDeadOwner(access); mode = 'retained-dead-owner';
    }
    const guard = () => {
      if (!active) throw fail('PROJECT_RECOVERY_COPY_CLOSED', 'The source-copy read scope has ended.');
      physical();
    };
    const check = () => { context(); guard(); };
    const build = () => {
      const observation = inspectProjectCopyBuild(root);
      if (!observation.ok) throw fail(observation.code, observation.message);
      return observation.build;
    };
    check(); const initialBuild = build(); check();
    callbackStarted = true;
    await runCallback(callback, guard); callbackCompleted = true;
    check(); const finalBuild = build(); check();
    result = { ok: true, source: { mode, build: finalBuild.state === 'ownership-unconfirmed' ? finalBuild : initialBuild } };
  } catch (error) {
    result = { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'PROJECT_RECOVERY_COPY_FAILED',
      message: error instanceof Error ? error.message : String(error),
      callbackStarted, callbackCompleted, ...(callbackCompleted || error?.uncertain === true ? { uncertain: true } : {}) } };
  } finally {
    active = false;
    if (lock) {
      let warnings;
      try { warnings = lock.release(); } catch (error) { warnings = [error.message || String(error)]; }
      if (warnings.length) result = { ok: false, error: { code: 'PROJECT_RECOVERY_COPY_UNCERTAIN',
        message: warnings.join('; '), callbackStarted, callbackCompleted, uncertain: true } };
    }
  }
  return result;
}

module.exports = { withProjectCopySource };
