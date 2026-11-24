'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { CommandManager } = require('../../electron/cmd');
const owned = require('../../electron/owned-process');
const { getSystemBootId } = require('../../child/scripts/system-boot-id');

function fixture(t) {
  const stops = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-darwin-build-'));
  t.after(async () => {
    try {
      for (const stop of stops) await stop();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    directory,
    receiptPath: path.join(directory, 'drained'),
    binding: path.join(directory, 'binding.json'),
    ready: path.join(directory, 'ready'),
    bootId: getSystemBootId(),
    stop: operation => stops.push(operation),
  };
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('Managed build fixture did not become ready.');
    await sleep(25);
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const darwin = { skip: process.platform !== 'darwin', timeout: 15000 };
const builderPrefix = process.env.AILY_NPM_PREFIX || path.join(os.homedir(), 'Library', 'aily-project', 'npm-global');
const installedNinja = path.join(builderPrefix, 'lib', 'node_modules', '@aily-project', 'aily-builder', 'ninja', 'ninja');
const darwinWithNinja = { ...darwin, skip: darwin.skip || (!fs.existsSync(installedNinja) && 'Installed Builder Ninja is unavailable') };
const writer = `
const { spawn } = require('node:child_process');
const [ready, detached] = process.argv.slice(1);
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 6000)"],
  { stdio: 'ignore', detached: detached === 'true' });
require('node:fs').writeFileSync(ready, String(child.pid));
setTimeout(() => {}, 6000);
`;

test('macOS supervisor publishes its binding before running and preserves stdio, IPC and exit code', darwin, async t => {
  const f = fixture(t);
  let proof;
  assert.equal(owned.isDarwinManagedBuildAvailable(), true);
  const target = `
  const marker = process.argv[1];
  if (!require('node:fs').existsSync(marker)) process.exit(97);
  process.on('message', input => process.send({ echoed: input }, () => {
    console.log('from target');
    process.exit(23);
  }));
  `;
  const child = owned.spawnManagedBuild(process.execPath, ['-e', target, f.binding], {
    cwd: f.directory, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }, { ...f, publish(value) { proof = value; fs.writeFileSync(f.binding, JSON.stringify(value)); } });
  f.stop(() => owned.stopOwnedProcess(child));
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const echoed = once(child, 'message'), closed = once(child, 'close');
  child.send({ bytes: 'deliver original IPC' });
  assert.deepEqual((await echoed)[0], { echoed: { bytes: 'deliver original IPC' } });
  assert.deepEqual(await closed, [23, null]);
  assert.match(output, /from target/);
  assert.equal(fs.readFileSync(f.receiptPath, 'utf8'), proof.job);
  assert.equal(owned.getOwnedProcessInfo(child).released, true);
  assert.equal(await owned.stopManagedBuild(proof, f.bootId, { observeOnly: true }), true);
});

test('macOS supervisor drains an active compiler group by exact stop or host disconnect', darwin, async t => {
  const f = fixture(t);
  const launcher = `
const [modulePath, bootId, receiptPath, binding, ready, writer] = process.argv.slice(1);
const owned = require(modulePath);
owned.spawnManagedBuild(process.execPath, ['-e', writer, ready], { stdio: 'ignore' }, {
  bootId, receiptPath, publish(proof) { require('node:fs').writeFileSync(binding, JSON.stringify(proof)); },
});
setTimeout(() => {}, 7000);
`;
  const host = spawn(process.execPath, ['-e', launcher, require.resolve('../../electron/owned-process'),
    f.bootId, f.receiptPath, f.binding, f.ready, writer], { stdio: 'ignore' });
  const hostExit = once(host, 'exit');
  f.stop(async () => {
    if (host.exitCode === null && host.signalCode === null) {
      host.kill('SIGKILL');
      await hostExit;
    }
    if (fs.existsSync(f.binding)) {
      await owned.stopManagedBuild(JSON.parse(fs.readFileSync(f.binding, 'utf8')), f.bootId);
    }
  });
  await until(() => fs.existsSync(f.ready));
  const proof = JSON.parse(fs.readFileSync(f.binding, 'utf8'));
  const leafPid = Number(fs.readFileSync(f.ready, 'utf8'));
  assert.ok(alive(leafPid));
  assert.equal(await owned.stopManagedBuild(proof, f.bootId, { observeOnly: true }), false);
  host.kill('SIGKILL');
  await hostExit;
  assert.equal(await owned.stopManagedBuild(proof, f.bootId), true);
  assert.equal(alive(leafPid), false);
  assert.equal(fs.readFileSync(f.receiptPath, 'utf8'), proof.job);
});

test('macOS supervisor retries an EPERM while observing a group that has stopped', darwin, async t => {
  const f = fixture(t);
  const token = `AilyDarwinBuild-${randomUUID()}`;
  const runner = require.resolve('../../child/scripts/darwin-managed-build-runner');
  const inject = `
const kill = process.kill.bind(process);
let injected = false;
process.kill = (pid, signal) => {
  if (!injected && pid < 0 && signal === 0) {
    injected = true;
    require('node:fs').writeFileSync(process.argv[5], 'EPERM');
    throw Object.assign(new Error('Group state is temporarily unavailable'), { code: 'EPERM' });
  }
  return kill(pid, signal);
};
require(process.argv[1]);
`;
  const monitor = spawn(process.execPath, ['-e', inject, runner, 'monitor', token, f.receiptPath, f.ready], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  f.stop(() => { if (monitor.connected) monitor.disconnect(); });
  const closed = once(monitor, 'close');
  monitor.send({ file: process.execPath, args: ['-e', 'process.exit(23)'] });
  assert.deepEqual(await closed, [23, null]);
  assert.equal(fs.readFileSync(f.ready, 'utf8'), 'EPERM');
  assert.equal(fs.readFileSync(f.receiptPath, 'utf8'), token);
});

test('macOS command cancellation confirms the managed group before releasing the build workspace', darwin, async t => {
  const f = fixture(t);
  const project = fs.realpathSync(f.directory);
  const manager = new CommandManager();
  const streamId = 'shared-darwin-build';
  let proof;
  const admission = { project, bind: () => ({
    ...f, publish(value) { proof = value; },
  }) };
  const script = `
require(process.argv[1]).acquireBuildWorkspace(process.cwd(), 'compile').markDelegated();
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(child.pid);
setInterval(() => {}, 1000);
`;
  const { process: child } = manager.executeCommand({
    command: process.execPath, streamId, buildWorkspace: project, shellProfile: false,
    args: ['-e', script, require.resolve('../../child/scripts/build-workspace-lease')],
  }, undefined, { admission, config: { execution: {} } });
  const closed = once(child, 'close');
  f.stop(async () => { await owned.stopOwnedProcess(child); await closed; });
  const [line] = await once(child.stdout, 'data');
  const descendant = Number(String(line).trim());
  const lock = path.join(project, '.build', 'aily-workspace.lock');
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0 && alive(descendant));
  assert.equal(fs.existsSync(lock), true);
  assert.equal(await manager.killProcess(streamId), true);
  await closed;
  assert.equal(alive(descendant), false);
  assert.equal(fs.readFileSync(f.receiptPath, 'utf8'), proof.job);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(manager.getProcess(streamId), undefined);
});

test('macOS cancellation drains the installed Ninja and its separately grouped recipes', darwinWithNinja, async t => {
  const f = fixture(t);
  const previousPrefix = process.env.AILY_NPM_PREFIX;
  process.env.AILY_NPM_PREFIX = builderPrefix;
  t.after(() => {
    if (previousPrefix === undefined) delete process.env.AILY_NPM_PREFIX;
    else process.env.AILY_NPM_PREFIX = previousPrefix;
  });
  fs.writeFileSync(path.join(f.directory, 'build.ninja'), [
    'rule hold',
    '  command = echo $$$$ > $out.ready && exec /bin/sleep 6',
    'build first: hold',
    'build second: hold',
    '',
  ].join('\n'));
  let proof;
  const compile = `
const ninja = require('node:child_process').spawn(process.argv[1], ['-j', '2'], { stdio: 'inherit' });
ninja.once('close', code => process.exit(code ?? 1));
`;
  const child = owned.spawnManagedBuild(process.execPath, ['-e', compile, installedNinja], {
    cwd: f.directory, stdio: 'ignore',
  }, { ...f, publish(value) { proof = value; } });
  const closed = once(child, 'close');
  f.stop(async () => { await owned.stopOwnedProcess(child); await closed; });
  const readiness = ['first', 'second'].map(name => path.join(f.directory, name + '.ready'));
  await until(() => readiness.every(file => fs.existsSync(file) && fs.statSync(file).size > 0));
  const recipes = readiness.map(file => Number(fs.readFileSync(file, 'utf8')));
  assert.ok(recipes.every(pid => Number.isSafeInteger(pid) && pid > 0 && alive(pid)));
  assert.equal(await owned.stopOwnedProcess(child), true);
  assert.deepEqual(await closed, [1, null]);
  assert.ok(recipes.every(pid => !alive(pid)));
  assert.equal(fs.readFileSync(f.receiptPath, 'utf8'), proof.job);
});

test('macOS host crash during binding publication never starts the target', darwin, async t => {
  const f = fixture(t);
  const launcher = `
const [modulePath, bootId, receiptPath, binding, ready] = process.argv.slice(1);
require(modulePath).spawnManagedBuild(process.execPath, ['-e',
  "require('node:fs').writeFileSync(process.argv[1], 'started')", ready], { stdio: 'ignore' }, {
  bootId, receiptPath, publish(proof) {
    require('node:fs').writeFileSync(binding, JSON.stringify(proof));
    process.exit(93);
  },
});
`;
  const host = spawn(process.execPath, ['-e', launcher, require.resolve('../../electron/owned-process'),
    f.bootId, f.receiptPath, f.binding, f.ready], { stdio: 'ignore' });
  assert.deepEqual(await once(host, 'exit'), [93, null]);
  const proof = JSON.parse(fs.readFileSync(f.binding, 'utf8'));
  assert.equal(await owned.stopManagedBuild(proof, f.bootId), true);
  assert.equal(fs.existsSync(f.ready), false);
  assert.equal(fs.existsSync(f.receiptPath + '.admitted'), false);
});

for (const detached of [false, true]) {
  test(`macOS local cancellation ${detached ? 'refuses proof for a detached descendant' : 'drains normal descendants'}`, darwin, async t => {
    const f = fixture(t);
    let proof;
    const child = owned.spawnManagedBuild(process.execPath, ['-e', writer, f.ready, String(detached)], { stdio: 'ignore' },
      { ...f, publish(value) { proof = value; } });
    f.stop(() => owned.stopOwnedProcess(child));
    await until(() => fs.existsSync(f.ready));
    const leafPid = Number(fs.readFileSync(f.ready, 'utf8'));
    assert.ok(alive(leafPid));
    assert.equal(await owned.stopOwnedProcess(child), !detached);
    assert.equal(await owned.stopManagedBuild(proof, f.bootId, { observeOnly: true }), !detached);
    assert.equal(alive(leafPid), detached);
  });
}
