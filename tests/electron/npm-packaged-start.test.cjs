'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createPackage } = require('@electron/asar');
const { packageBuildLockRuntime } = require('../../scripts/package-build-lock-runtime.cjs');

test('packaged Electron cold-start acquires the npm lock with external native resources', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-npm-packaged-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const source = path.join(root, 'source'), binary = path.join(root, 'binary');
  const resources = path.join(binary, 'resources'), profile = path.join(root, 'profile');
  fs.mkdirSync(path.join(source, 'electron'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(profile);
  const electronRoot = path.dirname(require('electron'));
  // Reuse read-only runtime bytes, but give this process its own resources,
  // package, profile and prefix. No real application or serial backend starts.
  for (const item of fs.readdirSync(electronRoot, { withFileTypes: true })) {
    if (item.name === 'resources') continue;
    const from = path.join(electronRoot, item.name), to = path.join(binary, item.name === 'electron.exe' ? 'aily-npm-fixture.exe' : item.name);
    if (item.isDirectory()) fs.symlinkSync(from, to, 'junction');
    else fs.linkSync(from, to);
  }
  for (const name of ['npm-mutation-queue.js', 'child-script-path.js']) {
    fs.copyFileSync(path.join(__dirname, '../../electron', name), path.join(source, 'electron', name));
  }
  const child = path.join(resources, 'child');
  await packageBuildLockRuntime({ destination: child, platform: process.platform, arch: process.arch });
  fs.mkdirSync(path.join(child, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '../../child/scripts/native-file-lock.js'), path.join(child, 'scripts/native-file-lock.js'));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'aily-npm-cold-fixture', version: '1.0.0', main: 'main.cjs' }));
  const result = path.join(root, 'result.json');
  fs.writeFileSync(path.join(source, 'main.cjs'), `
    const { app } = require('electron');
    const fs = require('node:fs'), assert = require('node:assert/strict');
    app.setPath('userData', ${JSON.stringify(profile)});
    app.setPath('sessionData', ${JSON.stringify(profile)});
    const fail = error => { fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({error:String(error.stack)})); app.exit(1); };
    setTimeout(() => fail(new Error('Cold start timed out')), 15000).unref();
    app.whenReady().then(async () => {
      assert.equal(app.isPackaged, true);
      for (const key of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) assert.equal(process.env[key], undefined);
      const { acquireNpmMutation } = require('./electron/npm-mutation-queue');
      const options = { command: 'npm', args: ['install', '--prefix', ${JSON.stringify(path.join(root, 'prefix'))}] };
      const release = await acquireNpmMutation(options);
      let waited = false;
      const next = acquireNpmMutation(options, { onWait: () => { waited = true; } });
      assert.equal(waited, true); release(); (await next)();
      fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ packaged: app.isPackaged, nativeLock: true, queued: true }));
      app.exit(0);
    }).catch(fail);
  `);
  await createPackage(source, path.join(resources, 'app.asar'));
  const env = { ...process.env };
  for (const key of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const launched = spawnSync(path.join(binary, 'aily-npm-fixture.exe'), [], { cwd: root, env,
    windowsHide: true, encoding: 'utf8', timeout: 25000 });
  assert.equal(launched.status, 0, (fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : '') + launched.stderr + launched.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { packaged: true, nativeLock: true, queued: true });
});
