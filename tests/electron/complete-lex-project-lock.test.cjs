'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { openProjectSyncStorage } = require('../../electron/project-sync-storage');

const testResults = path.resolve(__dirname, '../test-results/complete-lex-project-lock');
fs.mkdirSync(testResults, { recursive: true });

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(testResults, 'project-')));
  const directory = path.join(root, '.aily');
  const marker = path.join(directory, 'project-files.write.lock');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'project.abs'), 'Existing draft');
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync.native(testResults));
    assert.match(path.basename(root), /^project-/);
    fs.rmSync(root, { recursive: true });
  });
  return { root, marker, directory, storage: await openProjectSyncStorage(root, () => {}) };
}

async function interruptedWorker(t, root, cut) {
  const child = fork(path.join(__dirname, 'fixtures/complete-lex-lock-worker.cjs'), [root, cut],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const ended = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  };
  t.after(stop);
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(12000) });
  assert.equal(ready.pid, child.pid);
  return { stop, token: ready.token };
}

function observe(marker, attachment) {
  const stat = fs.lstatSync(marker, { bigint: true });
  const bytes = fs.readFileSync(marker);
  return {
    attachment, marker: {
      token: JSON.parse(bytes).token, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs),
    },
  };
}

for (const cut of ['linked', 'canonical-only']) {
  test(`an exact dead Lex marker can retire without saving: ${cut}`, { timeout: 25000 }, async t => {
    const { root, marker, directory, storage } = await fixture(t);
    const worker = await interruptedWorker(t, root, cut);
    const staged = path.join(directory, `.project-files.write.lock.${worker.token}.tmp`);
    const observation = observe(marker, storage.attachment);
    const bytes = fs.readFileSync(marker);
    assert.equal(fs.lstatSync(marker).nlink, cut === 'linked' ? 2 : 1);
    await assert.rejects(storage.retireProjectFileLock(observation), { code: 'PROJECT_FILE_BUSY' });
    assert.deepEqual(fs.readFileSync(marker), bytes);
    await worker.stop();
    await assert.rejects(storage.retireProjectFileLock({
      ...observation, marker: { ...observation.marker, sha256: 'sha256:' + '0'.repeat(64) },
    }), { code: 'PROJECT_FILE_LOCK_CHANGED' });
    assert.deepEqual(fs.readFileSync(marker), bytes);
    assert.equal(await storage.retireProjectFileLock(observation), true);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(staged), false);
    assert.equal(await storage.retireProjectFileLock(observation), false);
    assert.equal(await storage.read('project.abs'), 'Existing draft');
    assert.equal(await storage.read('committed.json'), null);

    await storage.withLock(async locked => {
      const replacement = fs.readFileSync(marker);
      await assert.rejects(storage.retireProjectFileLock(observation), { code: 'PROJECT_FILE_BUSY' });
      assert.deepEqual(fs.readFileSync(marker), replacement);
      assert.equal(await locked.read('project.abs'), 'Existing draft');
    });
  });
}

test('a copied detached owner or unexpected second link cannot authorize removal', { timeout: 25000 }, async t => {
  const { root, marker, directory, storage } = await fixture(t);
  const worker = await interruptedWorker(t, root, 'linked');
  await worker.stop();
  const staged = path.join(directory, `.project-files.write.lock.${worker.token}.tmp`);
  const alien = path.join(directory, `.${randomUUID()}`);
  fs.renameSync(staged, alien);
  await assert.rejects(storage.retireProjectFileLock(observe(marker, storage.attachment)), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  assert.equal(fs.lstatSync(alien).nlink, 2);
  fs.unlinkSync(alien);

  const owner = JSON.parse(fs.readFileSync(marker));
  owner.workspace.attachment.identity.ino = '0';
  fs.writeFileSync(marker, JSON.stringify(owner));
  await assert.rejects(storage.retireProjectFileLock(observe(marker, storage.attachment)), { code: 'PROJECT_FILE_LOCK_CHANGED' });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), owner);
});
