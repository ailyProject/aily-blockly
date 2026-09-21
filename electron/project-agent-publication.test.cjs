const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { replaceProjectText } = require('./project-file-writer');
const { openProjectSyncStorage } = require('./project-sync-storage');
const { startAgentPublication } = require('./test/project-agent-process.cjs');
const agentRoot = process.env.AILY_AGENT_ROOT || path.resolve(__dirname, '../../aily-lex-pro/packages/aily-agent');
const roots = [];
const project = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-agent-interop-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'project.abi'), 'before'); return root; };
const request = root => ({ projectPath: root, fileName: 'project.abi', content: 'host after',
  expectedHash: `sha256:${createHash('sha256').update('before').digest('hex')}` });
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-agent-interop-'));
  fs.rmSync(root, { recursive: true, force: true });
} });

test('the independent Agent refuses publication while the actual Blockly writer holds the lock', async () => {
  const root = project(); let competitor;
  const files = { ...fs, renameSync(from, to) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'test/project-agent-process.cjs'), root, agentRoot],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); competitor = JSON.parse(result.stdout);
    fs.renameSync(from, to);
  } };
  assert.equal((await replaceProjectText(request(root), () => {}, { files })).status, 'COMMITTED');
  assert.equal(competitor.code, 'PROJECT_FILE_BUSY');
  assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'host after');
});

test('Blockly waits for the real Agent history transaction and publishes after it releases the lock', async () => {
  const root = project(); const release = await startAgentPublication(root, agentRoot);
  let settled = false;
  const publication = replaceProjectText(request(root), () => {}).then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(settled, false); assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'before');
  } finally { assert.equal((await release()).status, 'COMMITTED'); }
  assert.equal((await publication).status, 'COMMITTED');
  assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'host after');
});

test('independent Agent respects generation lock and the durable pending barrier after release', async () => {
  const root = project(); const storage = await openProjectSyncStorage(root, () => {});
  const competitor = () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'test/project-agent-process.cjs'), root, agentRoot],
      { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  await storage.withLock(async locked => {
    assert.equal(competitor().code, 'PROJECT_FILE_BUSY');
    await locked.replace('prepared.json', null, 'pending generation');
  });
  assert.equal(competitor().code, 'ABS_TRANSACTION_PENDING');
  assert.equal(fs.readFileSync(path.join(root, 'project.abi'), 'utf8'), 'before');
  assert.equal(await storage.read('prepared.json'), 'pending generation');
});
