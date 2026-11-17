const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-workspace-mode-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^aily-workspace-mode-/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('native storage reads the one project mode marker and cannot mutate it through the program capability', async t => {
  const root = fixture(t), marker = JSON.stringify({ version: 1, mode: 'project-v1' });
  fs.mkdirSync(path.join(root, '.aily')); fs.writeFileSync(path.join(root, '.aily/workspace-mode.json'), marker);
  const storage = await openProjectSyncStorage(root, () => {});
  assert.equal(await storage.read('workspace-mode.json'), marker);
  await storage.withLock(async access => {
    await assert.rejects(access.replace('workspace-mode.json', null, marker), { code: 'ABS_STORAGE_WRITE_INVALID' });
    assert.equal(await access.replace('project.abs', null, 'real author draft'), true);
  });
  assert.equal(fs.readFileSync(path.join(root, 'project.abs'), 'utf8'), 'real author draft');
});

test('changing the marker revokes an existing read and locked writer without choosing another engine', async t => {
  const root = fixture(t), storage = await openProjectSyncStorage(root, () => {});
  assert.equal(await storage.read('workspace-mode.json'), null);
  fs.mkdirSync(path.join(root, '.aily')); fs.writeFileSync(path.join(root, '.aily/workspace-mode.json'), '{"version":1,"mode":"project-v1"}');
  await assert.rejects(storage.read('project.abs'), { code: 'ABS_WORKSPACE_MODE_CHANGED' });
  await assert.rejects(storage.withLock(access => access.replace('project.abs', null, 'must not write')), { code: 'ABS_WORKSPACE_MODE_CHANGED' });
  assert.equal(fs.existsSync(path.join(root, 'project.abs')), false);
});
