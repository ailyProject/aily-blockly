const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const sourceRoot = process.env.AILY_CLOUD_HOST_SOURCE_ROOT || path.resolve(__dirname, '../..');
for (const product of ['blockly', 'coder']) {
  test(`real Electron ${product} dispatches production cold/hot cloud project requests`, { timeout: 30000 }, async () => {
    const outputRoot = path.join(sourceRoot, 'tests/test-results/cloud-project-host');
    fs.mkdirSync(outputRoot, { recursive: true });
    const profile = fs.mkdtempSync(path.join(outputRoot, `${product}-`));
    const env = { ...process.env, AILY_CLOUD_HOST_SOURCE_ROOT: sourceRoot, AILY_CLOUD_HOST_PRODUCT: product,
      AILY_CLOUD_HOST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = require(require.resolve('electron', { paths: [sourceRoot] }));
    await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(__dirname, 'fixtures/cloud-project-host.cjs')], { env, windowsHide: true });
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Cloud project Electron smoke timed out')); }, 25000);
      child.stdout.on('data', value => output += value);
      child.stderr.on('data', value => output += value);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => {
        clearTimeout(timer);
        fs.writeFileSync(path.join(profile, 'host.log'), output);
        try { assert.equal(code, 0, output); assert.match(output, /CLOUD_PROJECT_HOST_OK/); resolve(); }
        catch (error) { reject(error); }
      });
    });
  });
}
