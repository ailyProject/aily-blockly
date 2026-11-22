'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { once } = require('node:events');
const owned = require('../../electron/owned-process');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { const end = Date.now() + 8000;while (!fn()) { if (Date.now() > end) throw Error('Wait timed out');await sleep(5); } }
function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'aily-job-')));
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(actual, root);
    assert.equal(path.dirname(actual), temp);
    assert.match(path.basename(actual), /^aily-job-/);
    fs.rmSync(actual, { recursive: true, force: true });
  });
  return root;
}
const environment = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: '1' });
test('native Job binding is mandatory for this acceptance target', windows, () => { assert(owned.runtime()); });
test('immediate cancellation waits for an empty Job and the original gate exit', windows, async () => {
  for (let i = 0; i < 10; i++) {
    const child = owned.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: environment() });
    assert.equal(await owned.stopOwnedProcess(child), true);assert.equal(owned.getOwnedProcessInfo(child).active, 0);assert.notEqual(child.exitCode ?? child.signalCode, null);
  }
});
test('keeps detached descendants owned after the task root exits and isolates siblings', windows, async t => {
  const root = fixture(t), marker = path.join(root, 'leaf.json');
  const script = `const p=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`) }],{detached:true,stdio:'ignore',env:process.env});p.unref();`;
  const child = owned.spawn(process.execPath, ['-e', script], { windowsHide: true, env: environment() });
  const sibling = owned.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: environment() });
  t.after(async () => { await owned.stopOwnedProcess(child);await owned.stopOwnedProcess(sibling); });
  await waitFor(() => fs.existsSync(marker));const leaf = Number(fs.readFileSync(marker));
  await sleep(100);assert.equal(child.exitCode, null);assert(owned.getOwnedProcessInfo(child).pids.includes(leaf));
  assert.equal(await owned.stopOwnedProcess(child), true);assert.equal(owned.getOwnedProcessInfo(sibling).released, false);process.kill(sibling.pid, 0);
  assert.throws(() => process.kill(leaf, 0));assert.equal(await owned.stopOwnedProcess(child), true);
});
test('launch gate crash immediately terminates its target without waiting for pipe EOF', windows, async t => {
  const root = fixture(t), marker = path.join(root, 'ready');
  const child = owned.spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>console.log('alive'),20)`], { windowsHide: true, env: environment() });
  child.stdout.resume();child.stderr.resume();await waitFor(() => fs.existsSync(marker));const pid = Number(fs.readFileSync(marker));child.kill('SIGKILL');
  await waitFor(() => owned.getOwnedProcessInfo(child).released);assert.throws(() => process.kill(pid, 0));
});
test('rejected Job binding never runs the target or replays it outside ownership', windows, async t => {
  const root = fixture(t), marker = path.join(root, 'should-not-run');
  const child = cp.spawn(owned.runtime().launcher, ['Local\\AilyTask-missing', '2', process.execPath, process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`], { windowsHide: true, env: environment(), stdio: 'ignore' });
  const code = await new Promise(resolve => child.once('exit', resolve));assert.equal(code, 125);assert.equal(fs.existsSync(marker), false);
});
test('exclusive descriptor removal cannot delete a replacement publication', windows, t => {
  const root = fixture(t), file = path.join(root, '1.json');fs.writeFileSync(file, JSON.stringify({ instanceId: 'a'.repeat(32) }));
  assert.equal(owned.runtime().binding.removeDescriptor(file, 'instanceId', 'b'.repeat(32)), false);assert(fs.existsSync(file));
  assert.equal(owned.runtime().binding.removeDescriptor(file, 'instanceId', 'a'.repeat(32)), true);assert.equal(fs.existsSync(file), false);
});

const bootId = 'win32:71bf9050-4abc-4e2a-a2d5-350416fe4947';
test('managed build publishes before launch; an observation never stops its live Job', windows, async t => {
  const root = fixture(t), published = path.join(root, 'job.json'), receiptPath = path.join(root, 'drained');
  const ready = path.join(root, 'ready');
  const inline = "const fs=require('node:fs');fs.statSync(process.argv[1]);fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)";
  let proof;
  const child = owned.spawnManagedBuild(process.execPath, ['-e', inline, published, ready],
    { windowsHide: true, env: environment() }, {
      bootId, receiptPath, publish(record) { proof = record; fs.writeFileSync(published, JSON.stringify(record)); },
    });
  try {
    await waitFor(() => fs.existsSync(ready));
    const pid = Number(fs.readFileSync(ready));
    assert.equal(owned.runtime().binding.buildHostState(process.pid, proof.hostCreation + '1'), 'different');
    assert.equal(await owned.stopManagedBuild(proof, bootId, { observeOnly: true }), false);
    assert.equal(fs.existsSync(receiptPath + '.stop'), false);
    process.kill(pid, 0);
    assert.equal(await owned.stopManagedBuild(proof, bootId), true);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), proof.job);
  } finally { await owned.stopOwnedProcess(child); }
});

test('managed build retires only its exact original Job after the host crashes', windows, async t => {
  const root = fixture(t), published = path.join(root, 'job.json'), receiptPath = path.join(root, 'drained');
  const ready = path.join(root, 'descendant');
  const leaf = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
  const compiler = "const leaf=require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,stdio:'ignore'});leaf.unref();setInterval(()=>{},1000)";
  const host = "const [runtime,compiler,leaf,ready,bootId,receiptPath,published]=process.argv.slice(1);"
    + "require(runtime).spawnManagedBuild(process.execPath,['-e',compiler,leaf,ready],{stdio:'ignore',windowsHide:true},{bootId,receiptPath,publish(proof){require('node:fs').writeFileSync(published,JSON.stringify(proof))}});setInterval(()=>{},1000)";
  const owner = cp.spawn(process.execPath, ['-e', host, require.resolve('../../electron/owned-process'), compiler,
    leaf, ready, bootId, receiptPath, published], { windowsHide: true, stdio: 'ignore' });
  const exited = once(owner, 'exit');
  const sibling = owned.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, env: environment() });
  try {
    await waitFor(() => fs.existsSync(ready));
    const proof = JSON.parse(fs.readFileSync(published));
    const pid = Number(fs.readFileSync(ready));
    assert.equal(proof.hostPid, owner.pid);
    assert.equal(await owned.stopManagedBuild(proof, bootId), false);
    assert.equal(fs.existsSync(receiptPath + '.stop'), false);
    owner.kill();
    await exited;
    const stopped = await owned.stopManagedBuild(proof, bootId);
    assert.equal(stopped, true, JSON.stringify({
      hostState: owned.runtime().binding.buildHostState(proof.hostPid, proof.hostCreation),
      receipt: fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, 'utf8') : null,
      admitted: fs.existsSync(receiptPath + '.admitted'),
    }));
    await waitFor(() => fs.existsSync(receiptPath) && fs.readFileSync(receiptPath, 'utf8') === proof.job);
    assert.throws(() => process.kill(pid, 0));
    assert.equal(await owned.stopManagedBuild(proof, bootId, { observeOnly: true }), true);
    process.kill(sibling.pid, 0);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await exited; }
    await owned.stopOwnedProcess(sibling);
  }
});

test('a durable publication interrupted before launch can be settled without starting the target', windows, async t => {
  const root = fixture(t), published = path.join(root, 'job.json'), receiptPath = path.join(root, 'drained');
  const ready = path.join(root, 'ran');
  const target = "require('node:fs').writeFileSync(process.argv[1],'ran')";
  const host = "const [runtime,target,ready,bootId,receiptPath,published]=process.argv.slice(1);"
    + "require(runtime).spawnManagedBuild(process.execPath,['-e',target,ready],{stdio:'ignore',windowsHide:true},{bootId,receiptPath,publish(proof){require('node:fs').writeFileSync(published,JSON.stringify(proof));process.exit(93)}})";
  const owner = cp.spawn(process.execPath, ['-e', host, require.resolve('../../electron/owned-process'),
    target, ready, bootId, receiptPath, published], { windowsHide: true, stdio: 'ignore' });
  assert.equal((await once(owner, 'exit'))[0], 93);
  const proof = JSON.parse(fs.readFileSync(published));
  assert.equal(await owned.stopManagedBuild(proof, bootId), true);
  assert.equal(fs.existsSync(ready), false);
  assert.equal(fs.existsSync(receiptPath + '.admitted'), false);
});
