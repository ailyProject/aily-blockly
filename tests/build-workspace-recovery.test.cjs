'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {createRequire} = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const modulePath = require.resolve('../child/scripts/build-workspace-lease');
const {acquireBuildWorkspace} = require(modulePath);

function fixture(t, operation = 'publish') {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-recover-publication-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  const child = spawnSync(process.execPath, ['-e',
    `require(process.argv[1]).acquireBuildWorkspace(process.argv[2], process.argv[3]);`, modulePath, project, operation],
    {encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  const marker = path.join(project, '.build/aily-workspace.lock');
  return {project, marker, bytes: fs.readFileSync(marker, 'utf8')};
}

for (const operation of ['publish', 'clean']) test(`an exited ${operation} owner is recovered without deleting project data or artifacts`, t => {
  const f = fixture(t, operation);
  for (const file of ['project.abi', '.build/firmware.elf', '.build/aily-artifact-manifest.json']) {
    fs.writeFileSync(path.join(f.project, file), 'preserve');
  }
  const lease = acquireBuildWorkspace(f.project, 'compile');
  assert.notEqual(lease.buildId, JSON.parse(f.bytes).token);
  assert.throws(() => acquireBuildWorkspace(f.project, 'publish'), {code: 'BUILD_WORKSPACE_BUSY'});
  lease.release();
  assert.equal(fs.existsSync(f.marker), false);
  for (const file of ['project.abi', '.build/firmware.elf', '.build/aily-artifact-manifest.json']) {
    assert.equal(fs.readFileSync(path.join(f.project, file), 'utf8'), 'preserve');
  }
});

for (const operation of ['compile', 'preprocess', 'verify']) test(`an exited ${operation} owner still needs verified descendant termination`, t => {
  const f = fixture(t, operation);
  assert.throws(() => acquireBuildWorkspace(f.project, 'publish'), {code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes);
});

test('publication and cleanup leases cannot delegate subprocess work', t => {
  const f = fixture(t);
  for (const operation of ['publish', 'clean']) {
    const lease = acquireBuildWorkspace(f.project, operation);
    assert.throws(() => lease.childEnvironment(), {code: 'BUILD_WORKSPACE_OWNER_MISMATCH'});
    assert.throws(() => lease.builderEnvironment('verify'), {code: 'BUILD_WORKSPACE_OWNER_MISMATCH'});
    lease.release();
  }
});

test('any Builder phase blocks automatic recovery, even if its record is incomplete', t => {
  const f = fixture(t);
  const builder = path.join(f.project, '.build/aily-builder.lock');
  fs.writeFileSync(builder, 'incomplete');
  assert.throws(() => acquireBuildWorkspace(f.project, 'publish'), {code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes);
  assert.equal(fs.readFileSync(builder, 'utf8'), 'incomplete');
});

test('an interrupted or unsafe recovery guard is retained rather than bypassed', t => {
  const f = fixture(t), guard = path.join(f.project, '.build/aily-workspace-recovery.lock');
  fs.writeFileSync(guard, 'incomplete');
  assert.throws(() => acquireBuildWorkspace(f.project, 'publish'), {code: 'BUILD_WORKSPACE_BUSY'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes);
  assert.equal(fs.readFileSync(guard, 'utf8'), 'incomplete');
});

test('a live publication is never reclaimed', t => {
  const f = fixture(t), lease = acquireBuildWorkspace(f.project, 'publish');
  const bytes = fs.readFileSync(f.marker, 'utf8');
  assert.throws(() => acquireBuildWorkspace(f.project, 'compile'), {code: 'BUILD_WORKSPACE_BUSY'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), bytes);
  lease.assertOwned(); lease.release();
});

test('a delayed recovery revalidates the owner after acquiring its guard', t => {
  const f = fixture(t), sourceRequire = createRequire(modulePath);
  const replacement = JSON.stringify({...JSON.parse(f.bytes), pid: process.pid, token: randomUUID()});
  const context = {module: {exports: {}}, process, require: name => name === 'node:fs' ? {
    ...fs,
    openSync: (...args) => {
      const fd = fs.openSync(...args);
      if (String(args[0]).endsWith('aily-workspace-recovery.lock')) fs.writeFileSync(f.marker, replacement);
      return fd;
    },
  } : sourceRequire(name)};
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, {filename: modulePath});
  assert.throws(() => context.module.exports.acquireBuildWorkspace(f.project, 'compile'), {code: 'BUILD_WORKSPACE_BUSY'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), replacement);
  assert.equal(fs.existsSync(path.join(f.project, '.build/aily-workspace-recovery.lock')), false);
});

test('simultaneous recovery contenders cannot delete the new live owner', async t => {
  const f = fixture(t);
  const code = `const {acquireBuildWorkspace}=require(process.argv[1]);
    process.send('ready'); process.once('message',()=>{
      try {const lease=acquireBuildWorkspace(process.argv[2],'publish'); process.send('acquired');
        process.once('message',()=>{lease.assertOwned();lease.release();process.exit(0)});
      } catch(e) {process.send(e.code);process.exit(0);}
    });`;
  const children = Array.from({length: 12}, () => spawn(process.execPath, ['-e', code, modulePath, f.project],
    {stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true}));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const finished = children.map(child => once(child, 'close'));
  await Promise.all(children.map(child => once(child, 'message')));
  const outcomes = children.map(child => once(child, 'message').then(([value]) => value));
  children.forEach(child => child.send('acquire'));
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(value => value === 'acquired').length, 1, JSON.stringify(results));
  assert.equal(results.filter(value => value === 'BUILD_WORKSPACE_BUSY').length, 11, JSON.stringify(results));
  children[results.indexOf('acquired')].send('release');
  for (const [code] of await Promise.all(finished)) assert.equal(code, 0);
  assert.equal(fs.existsSync(f.marker), false);
});
