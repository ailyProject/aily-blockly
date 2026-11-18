'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const owned = require('../../electron/owned-process');
const windows = { skip: process.platform !== 'win32', timeout: 20000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { const end = Date.now() + 8000;while (!fn()) { if (Date.now() > end) throw Error('Wait timed out');await sleep(5); } }
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-job-'));t.after(() => fs.rmSync(root, { recursive: true, force: true }));return root; }
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
