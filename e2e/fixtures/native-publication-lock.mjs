// A scheduling fixture for an already completed native publication. The actual
// HistoryStore owns acquisition, cancellation checks and token-safe release.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function holdNativePublicationRetirement(store, project) {
  assert.equal(path.resolve(store.workspaceRoot).toLowerCase(), path.resolve(project).toLowerCase());
  let release, acquired, reject, ownedToken;
  const held = new Promise((resolve, fail) => { acquired = resolve; reject = fail; });
  const wait = new Promise(resolve => { release = resolve; });
  const lock = path.join(store.workspaceDir, 'workspace.lock');
  const operation = store.withWorkspaceLock(async () => {
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.ok(typeof owner.token === 'string' && owner.token.startsWith(process.pid + '-'));
    ownedToken = owner.token;
    acquired({ processId: owner.pid, source: 'real-HistoryStore.withWorkspaceLock' });
    await wait;
  });
  // Always consume an early acquisition failure. This never manufactures a
  // lock or removes another process's lock as a fallback.
  operation.catch(reject);
  let ownership;
  try { ownership = await held; }
  catch (error) { release(); await operation.catch(() => {}); throw error; }
  let closed = false;
  return {
    ownership,
    async release() {
      if (closed) return;
      release(); await operation;
      const owner = await fs.readFile(path.join(lock, 'owner.json'), 'utf8')
        .then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
      assert.notEqual(owner?.token, ownedToken, 'The owned HistoryStore lock must be released');
      closed = true;
    },
  };
}
