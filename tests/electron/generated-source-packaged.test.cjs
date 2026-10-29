'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createPackage } = require('@electron/asar');
const { packageBuildLockRuntime } = require('../../scripts/package-build-lock-runtime.cjs');

test('real packaged ASAR preload resolves external child before environment initialization and rejects old versions', { skip: process.platform !== 'win32' }, async t => {
  const outputs = path.resolve(__dirname, '../test-results/generated-source-packaged-20261029');
  await fs.mkdir(outputs, { recursive: true });
  const root = await fs.mkdtemp(path.join(outputs, 'runtime-'));
  assert.equal(path.dirname(root), outputs); assert.ok(path.basename(root).startsWith('runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(outputs));
    try { await fs.copyFile(path.join(root, 'electron/resources/probe-trace.log'), path.join(outputs, `${path.basename(root)}-trace.log`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const runtime = path.join(root, 'electron'), source = path.join(root, 'source'), resources = path.join(runtime, 'resources');
  const electron = require('electron'), distribution = path.dirname(electron);
  await fs.mkdir(runtime);
  // A private runtime gives the real renderer its actual resourcesPath. Do not
  // modify dependencies or fake renderer app/process metadata to pass the test.
  for (const entry of await fs.readdir(distribution, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.name === 'resources') continue;
    await fs.cp(path.join(distribution, entry.name), path.join(runtime, entry.name), {
      recursive: true, dereference: false, errorOnExist: true, force: false,
      filter: async filename => { assert.equal((await fs.lstat(filename)).isSymbolicLink(), false); return true; },
    });
  }
  const executable = path.join(runtime, 'aily-owned-source-probe.exe');
  await fs.rename(path.join(runtime, path.basename(electron)), executable);
  await fs.mkdir(path.join(source, 'electron'), { recursive: true }); await fs.mkdir(resources);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'aily-owned-source-archive-probe', version: '1.0.0', main: 'main.cjs' }));
  await fs.copyFile(path.join(__dirname, 'fixtures/generated-source-packaged-main.cjs'), path.join(source, 'main.cjs'));
  await fs.copyFile(path.join(__dirname, 'fixtures/generated-source-packaged-preload.cjs'), path.join(source, 'electron/generated-source-packaged-preload.cjs'));
  for (const name of ['child-script-path.js', 'build-workspace-publication.js']) await fs.copyFile(path.join(__dirname, '../../electron', name), path.join(source, 'electron', name));
  await createPackage(source, path.join(resources, 'app.asar'));
  const child = path.join(resources, 'child');
  await packageBuildLockRuntime({ destination: child, platform: process.platform, arch: process.arch });
  await fs.mkdir(path.join(child, 'scripts'));
  for (const entry of await fs.readdir(path.join(__dirname, '../../child/scripts'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
    await fs.copyFile(path.join(__dirname, '../../child/scripts', entry.name), path.join(child, 'scripts', entry.name));
  }
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(project, '.temp/sketch'), { recursive: true }); await fs.writeFile(path.join(project, 'package.json'), '{"type":"blockly"}');
  const environment = { ...process.env };
  for (const name of ['AILY_CHILD_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete environment[name];
  for (const mismatch of [false, true]) {
    const original = mismatch ? 'second manual source\r\n' : 'original manual source\r\n';
    await fs.writeFile(path.join(project, '.temp/sketch/sketch.ino'), original);
    await fs.writeFile(path.join(resources, 'probe.json'), JSON.stringify({ project, original, expectMismatch: mismatch }));
    if (mismatch) await fs.writeFile(path.join(child, 'scripts/build-workspace-publication.js'), 'module.exports = { generatedSourceArchiveVersion: 0, publishArduinoGeneratedCode() { throw Error("old publisher must not run"); } };');
    const result = spawnSync(executable, [], { cwd: root, env: environment,
      encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, result.stderr?.trim() || result.stdout?.trim() || result.error?.message);
    assert.match(result.stdout, new RegExp(`GENERATED_SOURCE_ARCHIVE_PACKAGED_OK ${mismatch ? 'old-child-rejected' : 'preserved'}`));
  }
});
