const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { openProjectSyncStorage, openProjectSyncStorageBridge } = require('../../electron/project-sync-storage');
const { projectFileHash: hash } = require('../../electron/project-file-access');
const names = ['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock'];
const roots = [];
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-env-input-read-')); roots.push(root); return root;
}
const guard = () => undefined;
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-env-input-read-'));
  fs.rmSync(root, { recursive: true, force: true });
} });

test('five optional environment inputs return exact UTF-8 or null without creating files', async () => {
  const root = project(), storage = await openProjectSyncStorage(root, guard);
  for (const name of names) assert.equal(await storage.read(name), null);
  assert.deepEqual(fs.readdirSync(root), []);
  const text = '\ufeff中文 😀\r\n';
  for (const name of names) { fs.writeFileSync(path.join(root, name), text); assert.equal(await storage.read(name), text); }
  for (const key of ['.npmrc/../project.abi', 'package-lock.json:stream', 'yarn.lock\n', '../.npmrc'])
    await assert.rejects(storage.read(key), { code: 'ABS_STORAGE_KEY_INVALID' });
});

test('all environment input writes including matching no-ops and absent deletes remain forbidden', async () => {
  const root = project(), storage = await openProjectSyncStorage(root, guard);
  await storage.withLock(async locked => {
    for (const name of names) {
      await assert.rejects(locked.replace(name, null, null), { code: 'ABS_STORAGE_WRITE_INVALID' });
      await assert.rejects(locked.replace(name, null, 'new'), { code: 'ABS_STORAGE_WRITE_INVALID' });
      fs.writeFileSync(path.join(root, name), 'original');
      await assert.rejects(locked.replace(name, hash('original'), 'original'), { code: 'ABS_STORAGE_WRITE_INVALID' });
      await assert.rejects(locked.replace(name, hash('original'), 'changed'), { code: 'ABS_STORAGE_WRITE_INVALID' });
      assert.equal(await locked.read(name), 'original');
    }
  });
  for (const name of names) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'original');
});

test('the native plain-result bridge carries missing inputs as null and keeps unsafe content as typed failure', async () => {
  const root = project(), bridge = await openProjectSyncStorageBridge(root, guard);
  for (const name of names) assert.deepEqual(await bridge.readResult(name), { ok: true, value: null });
  fs.writeFileSync(path.join(root, '.npmrc'), Buffer.from([0xc3, 0x28]));
  const invalid = await bridge.readResult('.npmrc');
  assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'ABS_STORAGE_ENCODING_INVALID');
  fs.unlinkSync(path.join(root, '.npmrc')); fs.mkdirSync(path.join(root, '.npmrc'));
  const directory = await bridge.readResult('.npmrc');
  assert.equal(directory.ok, false); assert.equal(directory.error.code, 'PROJECT_FILE_UNSAFE_PATH');
});

test('input hard links are rejected instead of extending the read capability to an external alias', async () => {
  const root = project(), source = path.join(project(), 'original');
  fs.writeFileSync(source, 'retained outside input'); fs.linkSync(source, path.join(root, '.npmrc'));
  const storage = await openProjectSyncStorage(root, guard);
  await assert.rejects(storage.read('.npmrc'), { code: 'PROJECT_FILE_UNSAFE_PATH' });
  assert.equal(fs.readFileSync(source, 'utf8'), 'retained outside input');
});
