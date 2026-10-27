const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyRepairNormalization } = require('../../electron/project-repair-normalization');
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const output = path.resolve(__dirname, '../test-results/abs-recovery-restart-20261026/normalization');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const project = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => { assert.ok(project.startsWith(output + path.sep)); fs.rmSync(project, { recursive: true, force: true }); });
  const before = '{"blocks":{"blocks":[]}}', after = '{"blocks":{"blocks":[]},"$ailyProjectData":{"version":1}}';
  const beforeHash = digest(before), afterHash = digest(after), backups = path.join(project, '.aily', 'project-data-backups');
  fs.mkdirSync(backups, { recursive: true }); fs.writeFileSync(path.join(backups, beforeHash.slice(7) + '.abi'), before);
  const step = { version: 1, kind: 'project-data-normalization', beforeAbiHash: beforeHash, afterAbiHash: afterHash,
    publication: { status: 'COMMITTED', hash: afterHash, backupHash: beforeHash },
    changes: { schemaMarker: 1, inlinePayloads: 0, genericValues: 0, shadowIds: 0, fieldValues: 0, shapes: 0, blockTypes: 0 } };
  return { project, before, after, beforeHash, afterHash, backups, step };
}
test('normalization accepts only an exact typed acknowledged before/after chain with native original bytes', t => {
  const f = fixture(t), proof = verifyRepairNormalization(f.project, f.beforeHash, f.afterHash, [f.step]);
  assert.equal(proof.kind, 'project-data-normalization'); assert.equal(proof.beforeAbiHash, f.beforeHash); assert.equal(proof.afterAbiHash, f.afterHash);
  assert.deepEqual(proof.transitions, [f.step]); assert.equal(verifyRepairNormalization(f.project, f.beforeHash, f.beforeHash, []), null);
});
for (const name of ['missing-chain', 'wrong-before', 'wrong-after', 'uncommitted', 'backup-hash', 'unknown-kind', 'undeclared-change']) test(`normalization rejects ${name} instead of accepting ready+arbitrary target bytes`, t => {
  const f = fixture(t), step = structuredClone(f.step);
  if (name === 'wrong-before') step.beforeAbiHash = digest('other');
  if (name === 'wrong-after') step.afterAbiHash = digest('other');
  if (name === 'uncommitted') step.publication.status = 'UNKNOWN';
  if (name === 'backup-hash') step.publication.backupHash = digest('other');
  if (name === 'unknown-kind') step.kind = 'arbitrary-ready';
  if (name === 'undeclared-change') step.changes.schemaMarker = 0;
  assert.throws(() => verifyRepairNormalization(f.project, f.beforeHash, f.afterHash, name === 'missing-chain' ? [] : [step]), /typed normalization/);
});
test('normalization refuses changed original backups without rewriting them', t => {
  const f = fixture(t), file = path.join(f.backups, f.beforeHash.slice(7) + '.abi'); fs.writeFileSync(file, 'external');
  assert.throws(() => verifyRepairNormalization(f.project, f.beforeHash, f.afterHash, [f.step]), /typed normalization/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'external');
});
for (const ancestor of ['.aily', 'project-data-backups']) test(`normalization rejects a linked ${ancestor} ancestor`, t => {
  const f = fixture(t), moved = path.join(f.project, 'moved');
  const original = ancestor === '.aily' ? path.join(f.project, '.aily') : f.backups;
  fs.renameSync(original, moved); fs.symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyRepairNormalization(f.project, f.beforeHash, f.afterHash, [f.step]), /typed normalization/);
});
