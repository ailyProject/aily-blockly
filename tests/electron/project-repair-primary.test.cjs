const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { createNativeRepairPrimary } = require('../../electron/project-repair-primary');
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const output = path.resolve(__dirname, '../test-results/agent-tools-repair-20261027/primary-publication');
fs.mkdirSync(output, { recursive: true });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(output, 'case-')), project = path.join(root, 'C'), sourceProject = path.join(root, 'B');
  t.after(() => { if (!path.resolve(root).startsWith(output + path.sep)) throw new Error('Unsafe cleanup'); fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(project); fs.mkdirSync(sourceProject);
  const text = '{"workspace":"complete current target"}', requestId = 'native-primary-request';
  fs.writeFileSync(path.join(project, 'project.abi'), text);
  const record = { project, sourceProject, requestId, targetAbiHash: hash(text) };
  const receipt = { state: 'completed', requestId, sourceAbiHash: hash('{"historical":"source"}') };
  const result = { project, sourceProject, projectSaved: true, recoverySource: { kind: 'workspace', complete: true } };
  const data = { version: 1, kind: 'native-completed-fork-primary', project, sourceProject, requestId,
    primary: { text, hash: hash(text) }, origin: { sourceKind: 'workspace', sourceAbiHash: receipt.sourceAbiHash } };
  const directory = path.join(project, '.aily', 'recovery-primary'); fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(data)), originalArchive = path.join(directory, hash(bytes).slice(7) + '.json');
  return { root, project, record, receipt, result, bytes, directory, originalArchive,
    create: () => createNativeRepairPrimary(record, receipt, result) };
}
function withFiles(files) {
  const filename = path.resolve(__dirname, '../../electron/project-repair-primary.js'), localRequire = createRequire(filename);
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(filename, 'utf8'))(
    name => name === 'node:fs' ? files : localRequire(name), instance, instance.exports);
  return instance.exports.createNativeRepairPrimary;
}
test('a valid native primary proof is reused without publishing hardlinks', t => {
  const f = fixture(t), proof = f.create();
  assert.equal(proof.archive, f.originalArchive); assert.deepEqual(f.create(), proof);
  assert.equal(fs.statSync(proof.archive).nlink, 1); assert.deepEqual(fs.readdirSync(f.directory), [path.basename(proof.archive)]);
});
test('an old hardlink cleanup denial is preserved and a fresh unlinked proof restores admission', t => {
  const f = fixture(t), temporary = path.join(f.directory, randomUUID() + '.tmp');
  fs.writeFileSync(temporary, f.bytes); fs.linkSync(temporary, f.originalArchive);
  const proof = f.create();
  assert.notEqual(proof.archive, f.originalArchive); assert.match(path.basename(proof.archive), /^[a-f0-9]{64}\.json$/);
  assert.equal(fs.statSync(proof.archive).nlink, 1); assert.deepEqual(fs.readFileSync(proof.archive), f.bytes);
  for (const file of [temporary, f.originalArchive]) { assert.equal(fs.statSync(file).nlink, 2); assert.deepEqual(fs.readFileSync(file), f.bytes); }
});
test('a partial old archive is not overwritten or accepted as a complete proof', t => {
  const f = fixture(t), partial = f.bytes.subarray(0, 13); fs.writeFileSync(f.originalArchive, partial);
  const proof = f.create(); assert.notEqual(proof.archive, f.originalArchive);
  assert.deepEqual(fs.readFileSync(proof.archive), f.bytes); assert.deepEqual(fs.readFileSync(f.originalArchive), partial);
  assert.equal(fs.statSync(proof.archive).nlink, 1);
});
test('an unsafe final-name alias is retained without reading or modifying its external target', t => {
  const f = fixture(t), external = path.join(f.root, 'external-user-data.txt');
  fs.writeFileSync(external, 'retain unrelated user bytes'); fs.linkSync(external, f.originalArchive);
  const proof = f.create(); assert.notEqual(proof.archive, f.originalArchive);
  assert.equal(fs.statSync(proof.archive).nlink, 1); assert.equal(fs.readFileSync(external, 'utf8'), 'retain unrelated user bytes');
  assert.equal(fs.statSync(external).nlink, 2);
});
test('unsafe proof directory ancestry still rejects rather than falling back outside the target', t => {
  const f = fixture(t), external = path.join(f.root, 'outside'); fs.mkdirSync(external);
  fs.rmdirSync(f.directory); fs.symlinkSync(external, f.directory, 'junction');
  assert.throws(f.create, /directory|linked|unsafe/i); assert.deepEqual(fs.readdirSync(external), []);
});
test('an interrupted exclusive write remains inert and the next admission uses a complete fresh file', t => {
  const f = fixture(t);
  const interrupted = withFiles({ ...fs, writeFileSync(filename, bytes, options) {
    if (filename === f.originalArchive) {
      fs.writeFileSync(filename, bytes.subarray(0, 11), options);
      throw Object.assign(new Error('Interrupted local write'), { code: 'EIO' });
    }
    return fs.writeFileSync(filename, bytes, options);
  } });
  assert.throws(() => interrupted(f.record, f.receipt, f.result), { code: 'EIO' });
  const proof = f.create(); assert.notEqual(proof.archive, f.originalArchive);
  assert.deepEqual(fs.readFileSync(f.originalArchive), f.bytes.subarray(0, 11));
  assert.deepEqual(fs.readFileSync(proof.archive), f.bytes); assert.equal(fs.statSync(proof.archive).nlink, 1);
});
test('a concurrent exclusive publisher can win without being overwritten or needing a temporary hardlink', t => {
  const f = fixture(t); let linked = false;
  const concurrent = withFiles({ ...fs, linkSync() { linked = true; throw new Error('Hardlinks are unavailable'); },
    writeFileSync(filename, bytes, options) {
      fs.writeFileSync(filename, bytes, options); throw Object.assign(new Error('Another publisher won'), { code: 'EEXIST' });
    } });
  const proof = concurrent(f.record, f.receipt, f.result);
  assert.equal(proof.archive, f.originalArchive); assert.equal(linked, false);
  assert.equal(fs.statSync(proof.archive).nlink, 1); assert.deepEqual(fs.readFileSync(proof.archive), f.bytes);
});
