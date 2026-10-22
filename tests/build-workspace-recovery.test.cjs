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

function patchedModule(patch) {
  const sourceRequire = createRequire(modulePath);
  const context = {module: {exports: {}}, process, Buffer, require: name => name === 'node:fs' ? {...fs, ...patch} : sourceRequire(name)};
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context, {filename: modulePath});
  return context.module.exports;
}

test('a delayed recovery cannot replace a new live owner', t => {
  const f = fixture(t);
  const replacement = JSON.stringify({...JSON.parse(f.bytes), pid: process.pid, token: randomUUID()});
  const module = patchedModule({writeSync: (...args) => {
    const written = fs.writeSync(...args);
    if (String(args[1]).includes('"kind":"claim"')) {
      fs.unlinkSync(f.marker); fs.writeFileSync(f.marker, replacement);
    }
    return written;
  }});
  assert.throws(() => module.acquireBuildWorkspace(f.project, 'compile'), {code: 'BUILD_WORKSPACE_BUSY'});
  assert.equal(fs.readFileSync(f.marker, 'utf8'), replacement);
});

for (const stage of ['prepared', 'claimed', 'replaced']) test(`SIGKILL after ${stage} recovery is recoverable again`, t => {
  const f = fixture(t);
  const script = `const fs=require('node:fs');const stage=process.argv[3];
    const writeFile=fs.writeFileSync,write=fs.writeSync,rename=fs.renameSync;
    fs.writeFileSync=(...args)=>{const r=writeFile(...args);if(stage==='prepared'&&String(args[0]).endsWith('.tmp'))process.kill(process.pid,'SIGKILL');return r};
    fs.writeSync=(...args)=>{const r=write(...args);if(stage==='claimed'&&String(args[1]).includes('"kind":"claim"'))process.kill(process.pid,'SIGKILL');return r};
    fs.renameSync=(...args)=>{const r=rename(...args);if(stage==='replaced')process.kill(process.pid,'SIGKILL');return r};
    require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'publish');`;
  const child = spawnSync(process.execPath, ['-e', script, modulePath, f.project, stage], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const owner = acquireBuildWorkspace(f.project, 'publish'); owner.assertOwned(); owner.release();
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(path.join(f.project, '.build/aily-workspace-recovery.lock')), false);
});

test('EPERM replacing the record retires the claim and closes every descriptor', t => {
  const f = fixture(t), descriptors = new Set();
  const module = patchedModule({
    openSync: (...args) => {const fd=fs.openSync(...args);descriptors.add(fd);return fd},
    closeSync: fd => {fs.closeSync(fd);descriptors.delete(fd)},
    renameSync: () => {throw Object.assign(new Error('injected rename failure'), {code: 'EPERM'})},
  });
  assert.throws(() => module.acquireBuildWorkspace(f.project, 'publish'), {code: 'EPERM'});
  assert.equal(descriptors.size, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.marker,'utf8').split('\n')[0]).token, JSON.parse(f.bytes).token);
  // A separate module/process can see the relinquished claim even though its PID is alive.
  const child = spawnSync(process.execPath, ['-e',
    `const l=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'publish');l.release();`, modulePath, f.project], {encoding:'utf8'});
  assert.equal(child.status, 0, child.stderr);
});

test('staging cleanup failure cannot hide a successfully initialized lease', t => {
  const f=fixture(t), descriptors=new Set();
  const module=patchedModule({
    openSync: (...args)=>{const fd=fs.openSync(...args);descriptors.add(fd);return fd},
    closeSync: fd=>{fs.closeSync(fd);descriptors.delete(fd)},
    unlinkSync: filename=>{if(String(filename).endsWith('.tmp'))throw Object.assign(new Error('injected cleanup failure'),{code:'EPERM'});return fs.unlinkSync(filename)},
  });
  const owner=module.acquireBuildWorkspace(f.project,'publish');
  assert.equal(descriptors.size,0); owner.assertOwned();
  assert.equal(JSON.parse(fs.readFileSync(f.marker,'utf8')).token,owner.buildId);
  owner.release(); acquireBuildWorkspace(f.project,'publish').release();
});

test('a partial append grants no ownership and does not block the next attempt', t => {
  const f=fixture(t);let short=true;
  const module=patchedModule({writeSync:(fd,buffer)=>{
    if(short){short=false;return fs.writeSync(fd,buffer.subarray(0,30))}return fs.writeSync(fd,buffer);
  }});
  assert.throws(()=>module.acquireBuildWorkspace(f.project,'publish'),{code:'BUILD_WORKSPACE_INVALID'});
  acquireBuildWorkspace(f.project,'publish').release();
});

test('a failed retirement append permits a same-process retry after filesystem recovery', t => {
  const f=fixture(t);let failing=true;
  const module=patchedModule({
    renameSync:(...args)=>{if(failing)throw Object.assign(new Error('injected rename error'),{code:'EPERM'});return fs.renameSync(...args)},
    writeSync:(fd,buffer)=>{if(failing&&String(buffer).includes('"kind":"retire"'))throw Object.assign(new Error('injected disk error'),{code:'ENOSPC'});return fs.writeSync(fd,buffer)},
  });
  assert.throws(()=>module.acquireBuildWorkspace(f.project,'publish'),{code:'EPERM'});
  failing=false;
  const owner=module.acquireBuildWorkspace(f.project,'publish');owner.assertOwned();owner.release();
});

test('an older host acquiring its recovery guard during our claim is still excluded', t => {
  const f=fixture(t),guard=path.join(f.project,'.build/aily-workspace-recovery.lock');
  const module=patchedModule({writeSync:(...args)=>{
    const count=fs.writeSync(...args);
    if(String(args[1]).includes('"kind":"claim"')) fs.writeFileSync(guard,JSON.stringify({pid:process.pid,ownerToken:JSON.parse(f.bytes).token}));
    return count;
  }});
  assert.throws(()=>module.acquireBuildWorkspace(f.project,'publish'),{code:'BUILD_WORKSPACE_BUSY'});
  assert.equal(JSON.parse(fs.readFileSync(f.marker,'utf8').split('\n')[0]).token,JSON.parse(f.bytes).token);
  fs.unlinkSync(guard);acquireBuildWorkspace(f.project,'publish').release();
});

test('a valid dead legacy recovery guard is inert, while a live guard still excludes', t => {
  const f=fixture(t),guard=path.join(f.project,'.build/aily-workspace-recovery.lock');
  fs.writeFileSync(guard,JSON.stringify({pid:process.pid,ownerToken:JSON.parse(f.bytes).token}));
  assert.throws(()=>acquireBuildWorkspace(f.project,'publish'),{code:'BUILD_WORKSPACE_BUSY'});
  fs.writeFileSync(guard,JSON.stringify({pid:JSON.parse(f.bytes).pid,ownerToken:JSON.parse(f.bytes).token}));
  const bytes=fs.readFileSync(guard,'utf8');
  acquireBuildWorkspace(f.project,'publish').release();
  assert.equal(fs.readFileSync(guard,'utf8'),bytes);
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
