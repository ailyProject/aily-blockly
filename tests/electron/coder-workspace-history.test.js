const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { coderWorkspaceHistory } = require('../../electron/coder-workspace-history');

test('Coder Host validates the exact prepared mode change and never changes source files', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-history-host-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"coder"}\n');
  fs.writeFileSync(path.join(root, 'main.cpp'), '// preserve\n');
  const guard = () => {};
  const before = await coderWorkspaceHistory(root, { operation: 'status' }, guard);
  assert.equal(before.protocol.workspaceMode, 'overlay-v1');
  assert.equal(before.protocol.workspaceModeBinding.product, 'coder');
  const record = Buffer.from(JSON.stringify({
    version: 1, product: 'coder', workspaceId: 'original-project',
    attachment: before.protocol.workspaceModeBinding.attachment, modeBeforeHash: null,
  }));
  const recordHash = createHash('sha256').update(record).digest('hex');
  const request = { operation: 'select', recordHash };
  await assert.rejects(coderWorkspaceHistory(root, request, guard), /original Coder History migration/);

  const history = path.join(root, '.workspace-history');
  const objectDir = path.join(history, 'objects', recordHash.slice(0, 2));
  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, recordHash + '.blob'), record);
  fs.writeFileSync(path.join(history, 'workspace.json'), JSON.stringify({
    workspaceId: 'original-project', executionMode: 'overlay-v1',
    executionMigration: { version: 1, product: 'coder', from: 'overlay-v1', to: 'project-v1', phase: 'prepared', recordHash },
  }));
  await assert.rejects(coderWorkspaceHistory(root, request, () => { throw Error('Detached Host'); }), /Detached Host/);
  const selected = await coderWorkspaceHistory(root, request, guard);
  assert.equal(selected.protocol.workspaceMode, 'project-v1');
  assert.deepEqual(await coderWorkspaceHistory(root, request, guard), selected);
  assert.equal(fs.readFileSync(path.join(root, 'main.cpp'), 'utf8'), '// preserve\n');
});
