'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createProjectFileAccess, projectFileHash } = require('./project-file-access');
const KIND = 'native-completed-fork-primary';
const fail = message => Object.assign(new Error(message), { code: 'PROJECT_REPAIR_PRIMARY_INVALID' });

/** Archive the actual saved C primary without mislabelling it as B's old disk
 * source. Called only from the authenticated same-build bootstrap admission. */
function createNativeRepairPrimary(record, receipt, result) {
  const root = fs.realpathSync(record.project), access = createProjectFileAccess(root, record.project);
  const expected = record.targetAbiHash || receipt.targetAbiHash;
  if (receipt.state !== 'completed' || result.projectSaved !== true || result.recoverySource?.kind !== 'workspace'
    || result.recoverySource.complete !== true || result.project !== record.project || result.sourceProject !== record.sourceProject
    || receipt.requestId !== record.requestId || !/^sha256:[a-f0-9]{64}$/.test(receipt.sourceAbiHash || '')) throw fail('The native workspace fork origin was not confirmed.');
  const primary = access.readRegular(path.join(root, 'project.abi'));
  if (primary === null || projectFileHash(primary) !== expected) throw fail('The current target primary differs from its native epoch.');
  for (const directory of [path.join(root, '.aily'), path.join(root, '.aily', 'recovery-primary')]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    access.checkDirectory(directory);
  }
  const origin = { sourceKind: 'workspace', sourceAbiHash: receipt.sourceAbiHash };
  const data = { version: 1, kind: KIND, project: record.project, sourceProject: record.sourceProject, requestId: record.requestId,
    primary: { text: primary.toString('utf8'), hash: expected }, origin };
  // The request is part of the immutable proof identity, not merely the ABI
  // hash: equal programs saved by different forks cannot overwrite each other.
  const directory = path.join(root, '.aily', 'recovery-primary');
  const bytes = Buffer.from(JSON.stringify(data));
  const check = () => { access.checkRoot(); access.checkDirectory(directory); };
  const matches = filename => {
    check();
    try { return access.readRegular(filename)?.equals(bytes) === true; }
    catch (error) { if (error.code === 'PROJECT_FILE_UNSAFE_PATH') return false; throw error; }
  };
  const publish = filename => {
    check();
    try { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return matches(filename);
  };
  let archive = path.join(directory, projectFileHash(bytes).slice(7) + '.json');
  if (!matches(archive) && (fs.existsSync(archive) || !publish(archive))) {
    // Never delete, repair or accept an unsafe/partial prior artifact. A fresh
    // exclusive file is not a capability until its full unlinked bytes pass
    // readback. Crashes/concurrent publications may leave inert evidence only.
    archive = path.join(directory, projectFileHash(Buffer.concat([bytes, Buffer.from(randomUUID())])).slice(7) + '.json');
    if (!publish(archive)) throw fail('A complete fresh primary proof was not published.');
  }
  const saved = access.readRegular(archive);
  if (!saved?.equals(bytes) || !access.readRegular(path.join(root, 'project.abi'))?.equals(primary)) throw fail('The saved target or its primary proof changed during admission.');
  return { version: 1, kind: KIND, project: record.project, sourceProject: record.sourceProject,
    requestId: record.requestId, abiHash: expected, archive: path.join(record.project, '.aily', 'recovery-primary', path.basename(archive)), origin };
}
module.exports = { createNativeRepairPrimary };
