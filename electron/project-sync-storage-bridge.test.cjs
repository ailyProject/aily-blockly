const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

test('actual Electron full preload persists identity generations and recovers after renderer restart', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-sync-bridge-'));
  const env = { ...process.env, AILY_PROJECT_SYNC_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(__dirname, 'test/project-sync-storage-bridge.cjs')], { env, windowsHide: true });
      let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Electron generation test timed out\n' + output)); }, 55000);
      child.stdout.on('data', value => output += value); child.stderr.on('data', value => output += value);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 && output.includes('PROJECT_SYNC_BRIDGE_OK') ? resolve() : reject(new Error(output)); });
    });
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-sync-bridge-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
