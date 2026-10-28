'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { importProjectDirectory } = require('../../electron/project-file-copy');
const { acquireBuildWorkspace } = require('../../child/scripts/build-workspace-lease');
const { publishArduinoGeneratedCode } = require('../../child/scripts/build-workspace-publication');

const leaseModule = require.resolve('../../child/scripts/build-workspace-lease');
const ownerRelative = '.build/aily-workspace.lock';
const sketchRelative = '.temp/sketch/sketch.ino';

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-build-import-')));
  const source = path.join(directory, '旧项目');
  const target = path.join(directory, 'recovered-project');
  fs.mkdirSync(source);
  const abi = '{"blocks":{"languageVersion":0,"blocks":[]}}';
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"isolated-fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(source, 'project.abi'), abi);
  fs.mkdirSync(path.join(source, '.temp/sketch'), { recursive: true });
  fs.writeFileSync(path.join(source, sketchRelative), '// original generated code\n');
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('aily-build-import-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { source, target, abi };
}

function exitedDelegatingOwner(source) {
  const child = spawnSync(process.execPath, ['-e',
    'const owner=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],"compile"); owner.childEnvironment();',
    leaseModule, source], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return fs.readFileSync(path.join(source, ownerRelative), 'utf8');
}

test('current source evidence: an exited delegated owner excludes publication even after its native handle closes', t => {
  const f = fixture(t), owner = exitedDelegatingOwner(f.source);
  assert.throws(() => publishArduinoGeneratedCode(f.source, { sketchCode: '// next\n' }),
    { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(path.join(f.source, ownerRelative), 'utf8'), owner);
  assert.equal(fs.readFileSync(path.join(f.source, 'project.abi'), 'utf8'), f.abi);
  assert.equal(fs.readFileSync(path.join(f.source, sketchRelative), 'utf8'), '// original generated code\n');
});

test('fresh import does not inherit a dead legacy owner or require its receiver to reboot', t => {
  const f = fixture(t), record = JSON.parse(exitedDelegatingOwner(f.source));
  for (const key of ['bootId', 'nativeLeaseVersion', 'delegationVersion', 'delegated']) delete record[key];
  const original = JSON.stringify(record);
  fs.writeFileSync(path.join(f.source, ownerRelative), original);
  importProjectDirectory(f.source, f.target);
  assert.doesNotThrow(() => publishArduinoGeneratedCode(f.target, { sketchCode: '// recovered\n' }));
  assert.equal(fs.readFileSync(path.join(f.target, sketchRelative), 'utf8'), '// recovered\n');
  assert.equal(fs.readFileSync(path.join(f.source, ownerRelative), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(f.source, 'project.abi'), 'utf8'), f.abi);
});

test('fresh import is independent of a live source owner and never retires that owner', t => {
  const f = fixture(t), sourceOwner = acquireBuildWorkspace(f.source, 'compile');
  try {
    sourceOwner.childEnvironment();
    const original = fs.readFileSync(path.join(f.source, ownerRelative), 'utf8');
    importProjectDirectory(f.source, f.target);
    assert.doesNotThrow(() => publishArduinoGeneratedCode(f.target, { sketchCode: '// separate outputs\n' }));
    sourceOwner.assertOwned();
    assert.equal(fs.readFileSync(path.join(f.source, ownerRelative), 'utf8'), original);
    assert.equal(fs.readFileSync(path.join(f.source, sketchRelative), 'utf8'), '// original generated code\n');
    assert.throws(() => acquireBuildWorkspace(f.source, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
  } finally { sourceOwner.release(); }
});

test('import excludes only reserved root build owners and preserves firmware, backups and nested content', t => {
  const f = fixture(t);
  const excluded = [ownerRelative, '.build/aily-builder.lock', '.build/aily-workspace-recovery.lock'];
  const included = ['.build/firmware.bin', '.build/custom.lock', '.aily/build-workspace.guard',
    '.aily/project-data-backups/original.abi', '.aily/abs-sync/recovery.json',
    'nested/.build/aily-workspace.lock', 'src/aily-builder.lock'];
  for (const relative of [...excluded, ...included]) {
    const filename = path.join(f.source, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, relative);
  }
  importProjectDirectory(f.source, f.target);
  for (const relative of excluded) {
    assert.equal(fs.existsSync(path.join(f.target, relative)), false);
    assert.equal(fs.readFileSync(path.join(f.source, relative), 'utf8'), relative);
  }
  for (const relative of included) assert.equal(fs.readFileSync(path.join(f.target, relative), 'utf8'), relative);
  fs.writeFileSync(path.join(f.target, '.build/firmware.bin'), 'new independent output');
  assert.equal(fs.readFileSync(path.join(f.source, '.build/firmware.bin'), 'utf8'), '.build/firmware.bin');
});
