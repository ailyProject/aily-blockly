'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const test = require('node:test');
const { CommandManager } = require('./cmd');
const { createBuildWorkspaceSupervisor } = require('./build-workspace-supervisor');
const { acquireBuildWorkspace } = require('../child/scripts/build-workspace-lease');

test('unrelated commands do not get a build lifecycle; invalid workspace is refused', () => {
  assert.equal(createBuildWorkspaceSupervisor(undefined), undefined);
  assert.throws(() => createBuildWorkspaceSupervisor('relative/path'), /absolute/);
});

test('registered cancellation stops the owner and descendant before releasing its build marker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-supervised-build-'));
  const manager = new CommandManager(), streamId = 'owned-build-cancel-test';
  t.after(async () => {
    if (manager.getProcess(streamId)) await manager.killProcess(streamId);
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-supervised-build-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = `require(process.argv[1]).acquireBuildWorkspace(process.argv[2], 'compile');
    const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    console.log(JSON.stringify({owner:process.pid,descendant:child.pid}));setInterval(()=>{},1000);`;
  const started = manager.executeCommand({ command: process.execPath,
    args: ['-e', script, path.resolve(__dirname, '../child/scripts/build-workspace-lease.js'), root],
    streamId, shellProfile: false, buildWorkspace: root });
  const closed = once(started.process, 'close');
  const [line] = await once(started.process.stdout, 'data');
  const pids = JSON.parse(String(line));
  assert.ok(fs.existsSync(path.join(root, '.build/aily-workspace.lock')));
  assert.equal(await manager.killProcess(streamId), true);
  await closed;
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(fs.existsSync(path.join(root, '.build/aily-workspace.lock')), false);
  acquireBuildWorkspace(root, 'compile').release();
});

test('a parent exiting with its build marker cannot release the borrowed SDK reader', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-supervised-build-'));
  const manager = new CommandManager(), streamId = 'abandoned-owner';
  let releases = 0;
  const child = manager.executeCommand({ command: process.execPath, streamId, shellProfile: false, buildWorkspace: root,
    args: ['-e', 'require(process.argv[1]).acquireBuildWorkspace(process.argv[2], "compile");process.exit(1)',
      path.resolve(__dirname, '../child/scripts/build-workspace-lease.js'), root] }, { release: () => releases++ }).process;
  await once(child, 'close');
  assert.equal(releases, 0); assert.equal(manager.getProcess(streamId), child);
  assert.throws(() => manager.executeCommand({ command: process.execPath, streamId }), /already registered/);
  assert.equal(await manager.killProcess(streamId), false);
  assert.equal(releases, 0);
  // Fixture never spawned descendants. Explicit verified test cleanup only.
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  manager.processes.delete(streamId);
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-supervised-build-'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('SDK reader release follows confirmed tree termination, not the parent close event', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-supervised-build-'));
  const manager = new CommandManager(), streamId = 'borrowed-reader';
  let descendant, released = false;
  const script = `require(process.argv[1]).acquireBuildWorkspace(process.argv[2],'compile');
    const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    console.log(c.pid);setInterval(()=>{},1000);`;
  const child = manager.executeCommand({ command: process.execPath, streamId, shellProfile: false, buildWorkspace: root,
    args: ['-e', script, path.resolve(__dirname, '../child/scripts/build-workspace-lease.js'), root] }, {
      release: () => { assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' }); released = true; },
    }).process;
  t.after(async () => {
    if (manager.getProcess(streamId)) await manager.killProcess(streamId);
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-supervised-build-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  descendant = Number(String((await once(child.stdout, 'data'))[0]).trim());
  assert.equal(released, false);
  assert.equal(await manager.killProcess(streamId), true); assert.equal(released, true);
});

for (const code of [0, 7]) test(`registered installer returns its writer on a completed exit (${code})`, async () => {
  const manager = new CommandManager(); let releases = 0;
  const child = manager.executeCommand({ command: process.execPath, args: ['-e', `process.exit(${code})`],
    streamId: 'installer', shellProfile: false }, { release: () => releases++ }).process;
  await once(child, 'close');
  assert.equal(releases, 1); assert.equal(manager.getProcess('installer'), undefined);
});

test('failed installer termination stays pinned after a later normal parent close', async () => {
  const manager = new CommandManager(); let releases = 0;
  const child = manager.executeCommand({ command: process.execPath,
    args: ['-e', 'console.log("ready");setTimeout(()=>process.exit(0),200)'],
    streamId: 'uncertain-installer', shellProfile: false }, { release: () => releases++ }).process;
  const closed = once(child, 'close');
  await once(child.stdout, 'data');
  // Deterministic failed-stop injection: never target a foreign PID. The real
  // fixture exits on its own; the manager must not infer descendant cleanup.
  const entry = manager.processes.get('uncertain-installer'); entry.process = { pid: 0 };
  assert.equal(await manager.killProcess('uncertain-installer'), false);
  entry.process = child;
  await closed;
  assert.equal(releases, 0); assert.equal(await manager.killProcess('uncertain-installer'), false);
  assert.equal(manager.getProcess('uncertain-installer'), child);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  manager.processes.delete('uncertain-installer'); // Owned fixture has no descendants.
});
