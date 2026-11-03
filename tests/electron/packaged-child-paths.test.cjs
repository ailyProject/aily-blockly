'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createPackage } = require('@electron/asar');
const { packageBuildLockRuntime } = require('../../scripts/package-build-lock-runtime.cjs');

const modules = {
  'project-lock.js': 'tryAcquireLock',
  'project-repair-lineage.js': 'createRepairContinuationController',
  'project-copy-admission.js': 'inspectProjectCopyBuild',
  'project-copy-source.js': 'withProjectCopySource',
};

for (const packaged of [false, true]) {
  test(`${packaged ? 'ASAR' : 'development'} main-process imports load child scripts before environment initialization`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-child-paths-'));
    t.after(async () => {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await fs.rm(root, { recursive: true, force: true });
    });
    const source = path.join(root, 'source');
    const resources = path.join(root, 'resources');
    await fs.mkdir(path.join(source, 'electron'), { recursive: true });
    for (const name of [...Object.keys(modules), 'child-script-path.js', 'project-file-access.js',
      'project-recovery-receipts.js', 'project-repair-environment.js', 'project-repair-commit.js']) {
      await fs.copyFile(path.join(__dirname, '../../electron', name), path.join(source, 'electron', name));
    }
    const appRoot = packaged ? path.join(resources, 'app.asar') : source;
    if (packaged) {
      await fs.mkdir(resources);
      await createPackage(source, appRoot);
    }
    const childRoot = path.join(packaged ? resources : source, 'child');
    await packageBuildLockRuntime({ destination: childRoot, platform: process.platform, arch: process.arch });
    await fs.mkdir(path.join(childRoot, 'scripts'));
    for (const name of ['native-file-lock.js', 'process-state.js', 'build-workspace-lease.js', 'system-boot-id.js']) {
      await fs.copyFile(path.join(__dirname, '../../child/scripts', name), path.join(childRoot, 'scripts', name));
    }
    const probe = `
      const assert = require('node:assert/strict');
      const path = require('node:path');
      const Module = require('node:module');
      const [appRoot, resources, childRoot, packaged, entries] = process.argv.slice(1);
      Object.defineProperty(process, 'resourcesPath', { value: resources });
      const load = Module._load;
      // Node mode retains Electron's real ASAR filesystem and native-module loader.
      // Only the app metadata is supplied; production child imports are not mocked.
      Module._load = function (name, parent, main) {
        return name === 'electron' ? { app: { isPackaged: packaged === 'true', getVersion: () => 'fixture' } }
          : load.call(this, name, parent, main);
      };
      assert.equal(process.env.AILY_CHILD_PATH, undefined);
      for (const [name, exported] of JSON.parse(entries)) {
        assert.equal(typeof require(path.join(appRoot, 'electron', name))[exported], 'function', name);
      }
      for (const name of ['native-file-lock.js', 'process-state.js', 'build-workspace-lease.js']) {
        assert.ok(require.cache[require.resolve(path.join(childRoot, 'scripts', name))], name);
      }
      const { codeIdentity } = require(path.join(appRoot, 'electron/project-repair-environment.js'));
      console.log(codeIdentity(process.execPath, appRoot));
    `;
    const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' };
    delete environment.AILY_CHILD_PATH;
    const runProbe = () => {
      const result = spawnSync(require('electron'), ['-e', probe, appRoot, resources, childRoot,
        String(packaged), JSON.stringify(Object.entries(modules))], {
        cwd: root, env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
      return result.stdout.trim();
    };
    const originalIdentity = runProbe();
    await fs.appendFile(path.join(childRoot, 'scripts/native-file-lock.js'), '\n// Changed lock boundary.\n');
    const childChangedIdentity = runProbe();
    assert.notEqual(childChangedIdentity, originalIdentity, 'external child code participates in the host identity');
    await fs.appendFile(path.join(source, 'electron/child-script-path.js'), '\n// Changed path boundary.\n');
    if (packaged) await createPackage(source, appRoot);
    assert.notEqual(runProbe(), childChangedIdentity, 'the resolver participates in the host identity');
  });
}
