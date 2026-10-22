'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');
const modulePath = require.resolve('../child/scripts/build-workspace-lease');
const nativePath = require.resolve('../child/scripts/native-file-lock');
const { acquireBuildWorkspace } = require(modulePath);

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-native-recovery-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, marker: path.join(root, '.build/aily-workspace.lock'), anchor: path.join(root, '.aily/build-workspace.guard') };
}
function fixture(t, operation = 'publish', delegated = false) {
  const f = project(t);
  const child = spawnSync(process.execPath, ['-e',
    `const lease=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],process.argv[3]);
     if(process.argv[4]==='true')lease.builderEnvironment(process.argv[3]);`, modulePath, f.root, operation, String(delegated)],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return { ...f, bytes: fs.readFileSync(f.marker, 'utf8') };
}
function patchedModule(patch, bootId) {
  const proxy = { ...fs, ...patch }, cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const local = createRequire(filename), context = { module: { exports: {} }, process, Buffer,
      require: name => name === 'node:fs' ? proxy : name === './native-file-lock' ? load(nativePath)
        : name === './system-boot-id' && bootId !== undefined ? { ...local(name), getSystemBootId: () => bootId } : local(name) };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    cache.set(filename, context.module.exports); return context.module.exports;
  }
  return load(modulePath);
}
function tracked(patch = {}) {
  const descriptors = new Set();
  const api = patchedModule({ ...patch,
    openSync: (...args) => { const fd = fs.openSync(...args); descriptors.add(fd); return fd; },
    closeSync: fd => { fs.closeSync(fd); descriptors.delete(fd); },
  });
  return { api, descriptors };
}

for (const operation of ['publish', 'clean']) {
  test(`exited ${operation} without a child grant recovers and preserves project data`, t => {
    const f = fixture(t, operation);
    for (const file of ['project.abi', '.build/firmware.elf', '.build/aily-artifact-manifest.json']) fs.writeFileSync(path.join(f.root, file), 'preserve');
    const lease = acquireBuildWorkspace(f.root, 'compile');
    assert.notEqual(lease.buildId, JSON.parse(f.bytes).token);
    assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
    lease.release();
    assert.equal(fs.existsSync(f.marker), false);
    for (const file of ['project.abi', '.build/firmware.elf', '.build/aily-artifact-manifest.json']) assert.equal(fs.readFileSync(path.join(f.root, file), 'utf8'), 'preserve');
  });
}
for (const operation of ['compile', 'preprocess', 'verify']) {
  test(`exited ${operation} with a persisted absence of grants recovers`, t => {
    const f = fixture(t, operation);
    assert.equal(JSON.parse(f.bytes).delegated, false);
    acquireBuildWorkspace(f.root, 'publish').release();
    assert.equal(fs.existsSync(f.marker), false);
  });
  test(`exited delegated ${operation} requires verified process-tree termination`, t => {
    const f = fixture(t, operation, true);
    assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
    assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes);
  });
  test(`legacy exited ${operation} remains conservative without delegation metadata`, t => {
    const f = fixture(t, operation), record = JSON.parse(f.bytes);
    delete record.nativeLeaseVersion; delete record.delegationVersion; delete record.delegated; delete record.bootId;
    fs.writeFileSync(f.marker, JSON.stringify(record));
    assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
  });
}

test('publication and cleanup cannot grant a subprocess', t => {
  const f = project(t);
  for (const operation of ['publish', 'clean']) {
    const owner = acquireBuildWorkspace(f.root, operation);
    assert.throws(owner.childEnvironment, { code: 'BUILD_WORKSPACE_OWNER_MISMATCH' });
    assert.throws(() => owner.builderEnvironment('verify'), { code: 'BUILD_WORKSPACE_OWNER_MISMATCH' });
    owner.release();
  }
});

test('an orphan or incomplete Builder phase always excludes new writers', t => {
  const f = fixture(t), builder = path.join(f.root, '.build/aily-builder.lock');
  fs.writeFileSync(builder, 'incomplete');
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes);
});

for (const stage of ['anchor-open', 'kernel-acquired', 'prepared', 'installed']) {
  test(`SIGKILL at ${stage} cannot strand native ownership`, t => {
    const f = project(t);
    const script = `const fs=require('node:fs'),path=require('node:path'),stage=process.argv[3];
      const open=fs.openSync,write=fs.writeFileSync,rename=fs.renameSync;
      fs.openSync=(...args)=>{const fd=open(...args);if(stage==='anchor-open'&&String(args[0]).endsWith('.guard'))process.kill(process.pid,'SIGKILL');return fd};
      fs.writeFileSync=(...args)=>{const result=write(...args);if(stage==='prepared'&&String(args[0]).endsWith('.tmp'))process.kill(process.pid,'SIGKILL');return result};
      fs.renameSync=(...args)=>{const result=rename(...args);if(stage==='installed')process.kill(process.pid,'SIGKILL');return result};
      const native=require(require.resolve('fs-native-extensions',{paths:[path.dirname(process.argv[1])]})),lock=native.tryLock;
      native.tryLock=(...args)=>{const result=lock(...args);if(result&&stage==='kernel-acquired')process.kill(process.pid,'SIGKILL');return result};
      require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'publish');`;
    const result = spawnSync(process.execPath, ['-e', script, modulePath, f.root, stage], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    acquireBuildWorkspace(f.root, 'publish').release();
    assert.equal(fs.statSync(f.anchor).size, 0); // Presence is harmless, not a held lock.
    assert.equal(fs.existsSync(f.marker), false);
    assert.equal(fs.existsSync(path.join(f.root, '.build/aily-workspace-recovery.lock')), false);
  });
}

test('failed preparation closes the native descriptor and never exposes an empty owner record', t => {
  const f = project(t), { api, descriptors } = tracked({ writeFileSync: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  assert.throws(() => api.acquireBuildWorkspace(f.root, 'publish'), { code: 'ENOSPC' });
  assert.equal(descriptors.size, 0); assert.equal(fs.existsSync(f.marker), false);
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('repeated replacement failures cannot grow a journal or strand an owner', t => {
  const f = fixture(t), { api, descriptors } = tracked({ renameSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } });
  for (let i = 0; i < 1500; i++) assert.throws(() => api.acquireBuildWorkspace(f.root, 'publish'), { code: 'EPERM' });
  assert.equal(fs.readFileSync(f.marker, 'utf8'), f.bytes); assert.equal(descriptors.size, 0);
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('installation returns the lease without a fallible post-rename read', t => {
  const f = fixture(t); let installed = false;
  const { api, descriptors } = tracked({
    renameSync: (...args) => { fs.renameSync(...args); installed = true; },
    readFileSync: (filename, ...args) => { if (installed && filename === f.marker) { installed = false; throw Object.assign(new Error('read failure'), { code: 'EIO' }); } return fs.readFileSync(filename, ...args); },
  });
  const owner = api.acquireBuildWorkspace(f.root, 'publish');
  assert.throws(owner.assertOwned, { code: 'EIO' });
  owner.release(); assert.equal(descriptors.size, 0);
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('a release read failure still closes the handle and allows a fresh same-process publication', t => {
  const f = project(t); let reject = false;
  const { api, descriptors } = tracked({ readFileSync: (filename, ...args) => {
    if (reject && filename === f.marker) { reject = false; throw Object.assign(new Error('read failure'), { code: 'EIO' }); }
    return fs.readFileSync(filename, ...args);
  } });
  const owner = api.acquireBuildWorkspace(f.root, 'publish'); reject = true;
  assert.throws(owner.release, { code: 'EIO' }); assert.equal(descriptors.size, 0);
  const next = acquireBuildWorkspace(f.root, 'publish');
  assert.throws(owner.release, { code: 'BUILD_WORKSPACE_BUSY' }); next.assertOwned(); next.release();
});

test('EPERM deleting a completed delegated record leaves a replaceable receipt, not a held lock', t => {
  const f = project(t), { api, descriptors } = tracked({ unlinkSync: filename => {
    if (filename === f.marker) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return fs.unlinkSync(filename);
  } });
  const owner = api.acquireBuildWorkspace(f.root, 'compile'); owner.childEnvironment(); owner.release();
  assert.equal(descriptors.size, 0); assert.equal(JSON.parse(fs.readFileSync(f.marker, 'utf8')).released, true);
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('supervisor accepts a completed receipt when owner unlink was denied', t => {
  const f = project(t), { api } = tracked({ unlinkSync: filename => {
    if (filename === f.marker) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return fs.unlinkSync(filename);
  } });
  const supervisor = api.createBuildWorkspaceSupervisor(f.root);
  const key = 'AILY_BUILD_WORKSPACE_SUPERVISOR', previous = process.env[key];
  process.env[key] = supervisor.environment[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const owner = api.acquireBuildWorkspace(f.root, 'compile'); owner.childEnvironment();
  assert.equal(supervisor.canReleaseResources(), false);
  owner.release(); assert.equal(supervisor.canReleaseResources(), true);
});

test('a granted compiler surviving its parent remains protected before writing a Builder marker', t => {
  const f = project(t);
  const result = spawnSync(process.execPath, ['-e', `
    const owner=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {env:owner.childEnvironment(),detached:true,stdio:'ignore',windowsHide:true});
    child.unref();require('node:fs').writeFileSync(process.argv[3],String(child.pid));
    process.kill(process.pid,'SIGKILL');`, modulePath, f.root, path.join(f.root, 'descendant.pid')],
    { encoding: 'utf8', timeout: 10000 });
  const pid = Number(fs.readFileSync(path.join(f.root, 'descendant.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.equal(result.signal, 'SIGKILL', result.stderr); process.kill(pid, 0);
  assert.equal(fs.existsSync(path.join(f.root, '.build/aily-builder.lock')), false);
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_RECOVERY_REQUIRED' });
});

test('old oversized recovery journals migrate without keeping the old size limit', t => {
  const f = fixture(t), original = JSON.parse(f.bytes); delete original.nativeLeaseVersion; delete original.delegated;
  const lines = [JSON.stringify(original)];
  for (let i = 0; i < 1500; i++) {
    const token = randomUUID();
    lines.push(JSON.stringify({ kind: 'claim', token, parent: original.token, pid: process.pid }), JSON.stringify({ kind: 'retire', token, pid: process.pid }));
  }
  fs.writeFileSync(f.marker, lines.join('\n') + '\n'); assert.ok(fs.statSync(f.marker).size > 256 * 1024);
  const owner = acquireBuildWorkspace(f.root, 'publish'); assert.ok(fs.statSync(f.marker).size < 1024); owner.release();
});

test('live old recovery claims and malformed old markers remain protected', t => {
  const f = fixture(t), original = JSON.parse(f.bytes); delete original.nativeLeaseVersion; delete original.delegated;
  fs.writeFileSync(f.marker, JSON.stringify(original) + '\n' + JSON.stringify({ kind: 'claim', token: randomUUID(), parent: original.token, pid: process.pid }) + '\n');
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
  fs.writeFileSync(f.marker, '');
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
});

test('dead legacy recovery guard is inert, while active or incomplete guards remain protected', t => {
  const f = fixture(t), guard = path.join(f.root, '.build/aily-workspace-recovery.lock');
  for (const bytes of ['incomplete', JSON.stringify({ pid: process.pid, ownerToken: JSON.parse(f.bytes).token })]) {
    fs.writeFileSync(guard, bytes); assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
  }
  fs.writeFileSync(guard, JSON.stringify({ pid: JSON.parse(f.bytes).pid, ownerToken: JSON.parse(f.bytes).token }));
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('clearing .build cannot remove kernel exclusion stored outside that cache', t => {
  const f = project(t), owner = acquireBuildWorkspace(f.root, 'publish'), anchor = fs.statSync(f.anchor);
  fs.rmSync(path.join(f.root, '.build'), { recursive: true });
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), { code: 'BUILD_WORKSPACE_BUSY' });
  assert.equal(fs.statSync(f.anchor).ino, anchor.ino);
  assert.throws(owner.release, { code: 'ENOENT' }); // Closes even when cache was removed externally.
  acquireBuildWorkspace(f.root, 'publish').release();
});

test('12 competing processes share kernel exclusion and cannot steal an active lease', async t => {
  const f = fixture(t);
  const code = `const {acquireBuildWorkspace}=require(process.argv[1]);process.send('ready');process.once('message',()=>{
    try{const lease=acquireBuildWorkspace(process.argv[2],'publish');process.send('acquired');process.once('message',()=>{lease.assertOwned();lease.release();process.exit(0)})}
    catch(e){process.send(e.code);process.exit(0)}});`;
  const children = Array.from({ length: 12 }, () => spawn(process.execPath, ['-e', code, modulePath, f.root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  const finished = children.map(child => once(child, 'close'));
  await Promise.all(children.map(child => once(child, 'message')));
  const outcomes = children.map(child => once(child, 'message').then(([value]) => value)); children.forEach(child => child.send('acquire'));
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(value => value === 'acquired').length, 1, JSON.stringify(results));
  assert.equal(results.filter(value => value === 'BUILD_WORKSPACE_BUSY').length, 11, JSON.stringify(results));
  children[results.indexOf('acquired')].send('release');
  for (const [code] of await Promise.all(finished)) assert.equal(code, 0);
});

const BOOT_A = `${process.platform}:11111111-1111-4111-8111-111111111111`;
const BOOT_B = `${process.platform}:22222222-2222-4222-8222-222222222222`;

test('a legacy orphan is observed once and recovered only after a different kernel boot', t => {
  const f = fixture(t, 'compile', true), record = JSON.parse(f.bytes);
  delete record.bootId; delete record.delegationVersion; delete record.delegated;
  fs.writeFileSync(f.marker, JSON.stringify(record));
  const beforeRestart = patchedModule({}, BOOT_A);
  assert.throws(() => beforeRestart.acquireBuildWorkspace(f.root, 'publish'), /Restart the computer/);
  const observed = fs.readFileSync(f.marker, 'utf8');
  assert.equal(JSON.parse(observed).recoveryObservedBootId, BOOT_A);
  assert.throws(() => beforeRestart.acquireBuildWorkspace(f.root, 'publish'), /RECOVERY_REQUIRED/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), observed);
  fs.writeFileSync(path.join(f.root, '.build/firmware.bin'), 'preserve');
  patchedModule({}, BOOT_B).acquireBuildWorkspace(f.root, 'publish').release();
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.readFileSync(path.join(f.root, '.build/firmware.bin'), 'utf8'), 'preserve');
});

test('a restarted system recovers only its matching Builder phase despite PID reuse', t => {
  const f = fixture(t, 'compile', true), record = { ...JSON.parse(f.bytes), bootId: BOOT_A, pid: process.pid };
  fs.writeFileSync(f.marker, JSON.stringify(record));
  const builder = path.join(f.root, '.build/aily-builder.lock');
  fs.writeFileSync(builder, JSON.stringify({ ...record, token: randomUUID(), ownerToken: record.token }));
  patchedModule({}, BOOT_B).acquireBuildWorkspace(f.root, 'publish').release();
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.existsSync(builder), false);
});

for (const invalid of ['foreign', 'incomplete']) test(`a reboot does not remove a ${invalid} Builder record`, t => {
  const f = fixture(t, 'compile', true), record = { ...JSON.parse(f.bytes), bootId: BOOT_A };
  fs.writeFileSync(f.marker, JSON.stringify(record));
  const builder = path.join(f.root, '.build/aily-builder.lock');
  const bytes = invalid === 'incomplete' ? '' : JSON.stringify({ ...record, token: randomUUID(), ownerToken: randomUUID() });
  fs.writeFileSync(builder, bytes);
  assert.throws(() => patchedModule({}, BOOT_B).acquireBuildWorkspace(f.root, 'publish'), /BUILD_WORKSPACE_/);
  assert.equal(fs.readFileSync(builder, 'utf8'), bytes);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), JSON.stringify(record));
});

test('unavailable boot identity and wall-clock changes cannot retire a granted owner', t => {
  const f = fixture(t, 'verify', true), record = { ...JSON.parse(f.bytes), bootId: BOOT_A, startedAt: '1990-01-01T00:00:00.000Z' };
  fs.writeFileSync(f.marker, JSON.stringify(record));
  for (const bootId of [null, BOOT_A]) {
    assert.throws(() => patchedModule({}, bootId).acquireBuildWorkspace(f.root, 'publish'), /RECOVERY_REQUIRED/);
    assert.equal(fs.readFileSync(f.marker, 'utf8'), JSON.stringify(record));
  }
});

test('case normalization is not evidence of a kernel restart', t => {
  const boot = `${process.platform}:abcdefab-abcd-4abc-8abc-abcdefabcdef`;
  const f = fixture(t, 'compile', true), record = { ...JSON.parse(f.bytes), bootId: `${process.platform}:${boot.split(':')[1].toUpperCase()}` };
  fs.writeFileSync(f.marker, JSON.stringify(record));
  assert.throws(() => patchedModule({}, boot).acquireBuildWorkspace(f.root, 'publish'), /RECOVERY_REQUIRED/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), JSON.stringify(record));
});

test('a failed grant write cannot return an environment or launch an inherited preprocess', t => {
  const f = project(t);
  let failGrant = false;
  const api = patchedModule({ renameSync: (...args) => {
    if (failGrant) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    return fs.renameSync(...args);
  } });
  const owner = api.acquireBuildWorkspace(f.root, 'compile'); failGrant = true;
  assert.throws(owner.childEnvironment, { code: 'EIO' });
  assert.equal(JSON.parse(fs.readFileSync(f.marker)).delegated, false);
  const child = spawnSync(process.execPath, ['-e',
    `require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'preprocess',{inherited:process.argv[3]});`,
    modulePath, f.root, owner.buildId], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /OWNER_MISMATCH/);
  owner.release();
});

test('a crash immediately after recording a grant remains protected before the child starts', t => {
  const f = project(t);
  const child = spawnSync(process.execPath, ['-e', `
    const fs=require('node:fs'); const owner=require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
    const rename=fs.renameSync;fs.renameSync=(...args)=>{rename(...args);process.kill(process.pid,'SIGKILL')};
    owner.childEnvironment();`, modulePath, f.root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.marker)).delegated, true);
  assert.throws(() => acquireBuildWorkspace(f.root, 'publish'), /RECOVERY_REQUIRED/);
});
