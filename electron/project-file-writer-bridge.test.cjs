const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
test('real Electron contextBridge runs synchronous guards before native commit', { timeout: 25000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-bridge-'));
  fs.writeFileSync(path.join(root, 'project.abi'), 'before');
  const env = { ...process.env, AILY_PROJECT_FILE_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE; // Only this isolated test child must boot Electron, not Node mode.
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(__dirname, 'test/project-file-writer-bridge.cjs')], { env, windowsHide: true });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Electron bridge test timed out')); }, 20000);
      child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 && output.includes('PROJECT_FILE_BRIDGE_OK') ? resolve() : reject(new Error(output)); });
    });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-project-bridge-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
