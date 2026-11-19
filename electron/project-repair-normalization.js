'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const HASH = /^sha256:[a-f0-9]{64}$/;
const kinds = ['schemaMarker', 'inlinePayloads', 'genericValues', 'shadowIds', 'fieldValues', 'shapes', 'blockTypes'];

/** A typed normalizer commit is not a blanket permission to accept whatever
 * bytes happen to exist when loading finishes. Every acknowledged transition
 * must chain to this epoch's primary and retain its native original backup. */
function verifyRepairNormalization(project, beforeAbiHash, afterAbiHash, transitions) {
  const reject = () => { throw Object.assign(new Error('Initial repair loading changed the saved primary without an exact typed normalization/backup chain.'), { code: 'PROJECT_REPAIR_NORMALIZATION_UNVERIFIED' }); };
  if (!Array.isArray(transitions) || transitions.length > 32 || !HASH.test(beforeAbiHash || '') || !HASH.test(afterAbiHash || '')) reject();
  if (beforeAbiHash === afterAbiHash && transitions.length === 0) return null;
  let previous = beforeAbiHash;
  for (const step of transitions) {
    if (step?.version !== 1 || step.kind !== 'project-data-normalization' || step.beforeAbiHash !== previous
      || !HASH.test(step.afterAbiHash || '') || step.publication?.status !== 'COMMITTED'
      || step.publication.hash !== step.afterAbiHash || step.publication.backupHash !== previous
      || !step.changes || Object.keys(step.changes).some(key => !kinds.includes(key))
      || kinds.some(key => !Number.isSafeInteger(step.changes[key]) || step.changes[key] < 0)
      || !kinds.some(key => step.changes[key] > 0)) reject();
    for (const directory of [project, path.join(project, '.aily'), path.join(project, '.aily', 'project-data-backups')]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) reject();
    }
    const filename = path.join(project, '.aily', 'project-data-backups', previous.slice(7) + '.abi');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024
      || digest(fs.readFileSync(filename)) !== previous) reject();
    previous = step.afterAbiHash;
  }
  if (previous !== afterAbiHash || transitions.length === 0) reject();
  return { version: 1, kind: 'project-data-normalization', beforeAbiHash, afterAbiHash, transitions };
}
module.exports = { verifyRepairNormalization };
