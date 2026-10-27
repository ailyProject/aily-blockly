const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { createProjectRecoveryReceipts } = require('../../electron/project-recovery-receipts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-fork-receipts-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-fork-receipts-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'project.abi'), '{"saved":"source"}');
  fs.writeFileSync(path.join(target, 'project.abi'), '{"saved":"target"}');
  const appdata = path.join(root, 'private-host'), store = createProjectRecoveryReceipts(appdata);
  return { root, source, target, appdata, store, request: 'request-test-001' };
}

test('completed receipts survive a new native renderer without source mutation or another copy', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.source, 'project.abi'));
  const started = f.store.begin(f.source, f.request, 'copy-options', f.store.abiHash(f.source));
  assert.equal(started.created, true);
  const result = { ok: true, operation: 'project_fork', sourceProject: f.source, project: f.target, projectSaved: true };
  f.store.complete(f.source, f.request, 'copy-options', result, f.store.abiHash(f.target));
  const restored = createProjectRecoveryReceipts(f.appdata);
  const observed = restored.status(f.source, f.request);
  assert.equal(observed.state, 'completed'); assert.deepEqual(observed.result, result);
  const separateProcess = JSON.parse(execFileSync(process.execPath, ['-e',
    `const {createProjectRecoveryReceipts}=require(${JSON.stringify(path.resolve(__dirname, '../../electron/project-recovery-receipts'))});
    console.log(JSON.stringify(createProjectRecoveryReceipts(${JSON.stringify(f.appdata)}).status(${JSON.stringify(f.source)},${JSON.stringify(f.request)})));`
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.deepEqual(separateProcess.result, result);
  assert.notEqual(observed.sourceAbiHash, observed.targetAbiHash);
  assert.equal(restored.begin(f.source, f.request, 'copy-options', null).created, false);
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'project.abi')), before);
  assert.deepEqual(fs.readdirSync(f.source), ['project.abi']);
});

test('same request cannot change options or be completed by a replacement owner', t => {
  const f = fixture(t);
  f.store.begin(f.source, f.request, 'options-a', f.store.abiHash(f.source));
  assert.throws(() => f.store.begin(f.source, f.request, 'options-b', null), /different source\/options/);
  const restored = createProjectRecoveryReceipts(f.appdata);
  assert.equal(restored.status(f.source, f.request).state, 'running');
  assert.throws(() => restored.complete(f.source, f.request, 'options-a', { ok: true }, null), /original live fork owner/);
  assert.equal(restored.status(f.source, 'request-not-seen'), null);
});

test('malformed IDs and linked receipt directories are never used', t => {
  const f = fixture(t);
  assert.throws(() => f.store.begin(f.source, '../escape', '', null), /identity/);
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(f.appdata);
  fs.symlinkSync(outside, path.join(f.appdata, 'agent-recovery-receipts'), 'junction');
  assert.throws(() => f.store.status(f.source, f.request), /private regular directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('ABI evidence is exact bytes and rejects linked primary documents', t => {
  const f = fixture(t), bytes = Buffer.from([0xff, 0xfe, 0x41]);
  fs.writeFileSync(path.join(f.source, 'project.abi'), bytes);
  const expected = 'sha256:' + require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  assert.equal(f.store.abiHash(f.source), expected);
  fs.linkSync(path.join(f.source, 'project.abi'), path.join(f.root, 'linked-abi'));
  assert.throws(() => f.store.abiHash(f.source), /unlinked regular file/);
});

test('saved completion requires target evidence and cannot overwrite an existing completion', t => {
  const f = fixture(t);
  f.store.begin(f.source, f.request, '', null);
  assert.throws(() => f.store.complete(f.source, f.request, '', { projectSaved: true }, null), /ABI evidence/);
  f.store.complete(f.source, f.request, '', { projectSaved: false, ok: false }, null);
  assert.throws(() => f.store.complete(f.source, f.request, '', { projectSaved: false, ok: true }, null), /original live fork owner/);
});
