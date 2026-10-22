'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { packageBuildLockRuntime } = require('../scripts/package-build-lock-runtime.cjs');

for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['darwin', 'universal'],
  ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
  test(`packaged lock runtime includes only ${platform}-${arch} N-API binaries and its dependency closure`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aily-lock-package-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const destination = path.join(root, 'resources/child');
    const copied = await packageBuildLockRuntime({ destination, platform, arch });
    assert.equal(copied['fs-native-extensions'], '1.5.1');
    for (const [name, version] of Object.entries(copied)) {
      const manifest = JSON.parse(await fs.readFile(path.join(destination, 'node_modules', name, 'package.json'), 'utf8'));
      assert.equal(manifest.version, version);
      for (const dependency of Object.keys(manifest.dependencies || {})) assert.ok(copied[dependency], dependency);
    }
    const prebuilds = path.join(destination, 'node_modules/fs-native-extensions/prebuilds');
    const targets = arch === 'universal' ? ['darwin-arm64', 'darwin-x64'] : [`${platform}-${arch}`];
    assert.deepEqual((await fs.readdir(prebuilds)).sort(), targets.sort());
    for (const target of targets) assert.deepEqual(await fs.readdir(path.join(prebuilds, target)), ['fs-native-extensions.node']);

    if (platform === process.platform && (arch === process.arch || arch === 'universal')) {
      const scripts = path.join(destination, 'scripts');
      await fs.mkdir(scripts);
      for (const name of ['native-file-lock.js', 'system-boot-id.js', 'build-workspace-lease.js']) {
        await fs.copyFile(path.join(__dirname, '../child/scripts', name), path.join(scripts, name));
      }
      const project = path.join(root, 'project'); await fs.mkdir(project);
      // Outside the checkout and with NODE_PATH cleared: no developer dependency fallback.
      const result = spawnSync(process.execPath, ['-e', `
        const assert=require('node:assert/strict');
        const {acquireBuildWorkspace}=require(process.argv[1]);
        const owner=acquireBuildWorkspace(process.argv[2],'compile');
        assert.throws(()=>acquireBuildWorkspace(process.argv[2],'publish'),{code:'BUILD_WORKSPACE_BUSY'});
        owner.builderEnvironment('compile');owner.release();
        acquireBuildWorkspace(process.argv[2],'publish').release();`,
        path.join(scripts, 'build-workspace-lease.js'), project],
      { cwd: root, env: { ...process.env, NODE_PATH: '' }, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
    }
  });
}
