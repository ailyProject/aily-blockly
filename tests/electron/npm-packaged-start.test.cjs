'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createPackage } = require('@electron/asar');
const { packageBuildLockRuntime } = require('../../scripts/package-build-lock-runtime.cjs');

test('packaged Electron cold-start acquires the npm lock with external native resources', { skip: !['win32', 'darwin'].includes(process.platform) }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-npm-packaged-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const source = path.join(root, 'source'), binary = path.join(root, 'binary');
  const profile = path.join(root, 'profile');
  let resources, executable;
  if (process.platform === 'darwin') {
    const bundle = path.resolve(path.dirname(require('electron')), '../..');
    const target = path.join(binary, 'AilyNpmFixture.app');
    fs.cpSync(bundle, target, { recursive: true, verbatimSymlinks: true });
    const configured = spawnSync('/usr/libexec/PlistBuddy', ['-c',
      'Set :CFBundleIdentifier pro.aily.npm-lock-fixture', '-c', 'Set :CFBundleExecutable aily-npm-fixture',
      path.join(target, 'Contents/Info.plist')], { encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    resources = path.join(target, 'Contents/Resources');
    executable = path.join(target, 'Contents/MacOS/aily-npm-fixture');
    fs.renameSync(path.join(target, 'Contents/MacOS/Electron'), executable);
  } else {
    resources = path.join(binary, 'resources');
    executable = path.join(binary, 'aily-npm-fixture.exe');
  }
  fs.mkdirSync(path.join(source, 'electron'), { recursive: true });
  fs.mkdirSync(resources, { recursive: true }); fs.mkdirSync(profile);
  const electronRoot = path.dirname(require('electron'));
  // Reuse read-only runtime bytes, but give this process its own resources,
  // package, profile and prefix. No real application or serial backend starts.
  for (const item of process.platform === 'win32' ? fs.readdirSync(electronRoot, { withFileTypes: true }) : []) {
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
  const prefix = path.join(root, 'prefix');
  const auth = '{"access_token":"isolated-test-token"}\n';
  fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(prefix, '.aily'), auth, { mode: 0o600 });
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
      const options = { command: 'npm', args: ['install', '--prefix', ${JSON.stringify(prefix)}] };
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
  const launched = spawnSync(executable, [], { cwd: root, env,
    windowsHide: true, encoding: 'utf8', timeout: 25000 });
  assert.equal(launched.status, 0, (fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : '') + launched.stderr + launched.error);
  assert.deepEqual(JSON.parse(fs.readFileSync(result, 'utf8')), { packaged: true, nativeLock: true, queued: true });
  assert.equal(fs.readFileSync(path.join(prefix, '.aily'), 'utf8'), auth);
});
