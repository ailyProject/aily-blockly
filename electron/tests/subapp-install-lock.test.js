const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { acquireInstallLock } = require('../subapp-install-lock');

const MODULE_PATH = path.resolve(__dirname, '../subapp-install-lock.js');
const CHILD = String.raw`
const fs = require('fs');
const path = require('path');
const { acquireInstallLock } = require(process.argv[1]);
const config = JSON.parse(process.argv[2]);
function pause(gate) {
  const deadline = Date.now() + 12000;
  while (!fs.existsSync(gate)) {
    if (Date.now() > deadline) throw new Error('barrier timed out: ' + gate);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const options = { onPhase(phase, owner) {
  const barrier = config.barriers?.find(item => item.phase === phase);
  if (barrier) {
    fs.writeFileSync(barrier.marker, JSON.stringify(owner));
    pause(barrier.gate);
  }
  if (phase === config.pauseAt) {
    fs.writeFileSync(config.marker, JSON.stringify(owner));
    pause(config.gate);
  }
}};
(async () => {
  if (config.mode === 'once') {
    const release = acquireInstallLock(config.root, options);
    fs.writeFileSync(config.result, JSON.stringify({ acquired: !!release }));
    if (release && config.holdGate) pause(config.holdGate);
    release?.();
    return;
  }
  let completed = 0;
  const deadline = Date.now() + 15000;
  while (completed < config.iterations) {
    if (Date.now() > deadline) throw new Error('lock stress timed out');
    const release = acquireInstallLock(config.root);
    if (!release) {
      await new Promise(resolve => setTimeout(resolve, 1 + Math.floor(Math.random() * 5)));
      continue;
    }
    let guard;
    try {
      guard = fs.openSync(path.join(config.root, 'critical-section'), 'wx');
      await new Promise(resolve => setTimeout(resolve, 1 + Math.floor(Math.random() * 4)));
      fs.closeSync(guard);
      guard = undefined;
      fs.rmSync(path.join(config.root, 'critical-section'));
      completed++;
    } finally {
      if (guard !== undefined) fs.closeSync(guard);
      release();
    }
  }
  fs.writeFileSync(config.result, JSON.stringify({ completed }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily lock 版本-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async item => {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
      await item.exited;
    }));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    child(config) {
      const result = path.join(root, `result-${randomUUID()}.json`);
      const child = spawn(process.execPath, ['-e', CHILD, MODULE_PATH, JSON.stringify({ root, result, ...config })], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      const item = {
        child, result, exited,
        async success() {
          const status = await exited;
          assert.equal(status.code, 0, output);
          return JSON.parse(fs.readFileSync(result, 'utf8'));
        },
      };
      children.push(item);
      return item;
    },
  };
}

async function untilFile(file) {
  const deadline = Date.now() + 12000;
  while (true) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${file}`);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* writer has not closed yet */ }
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function releaseGate(file) {
  fs.writeFileSync(file, 'continue');
}

test('same-process contenders serialize, releases are idempotent, and only their own UUID is removed', t => {
  const { root } = fixture(t);
  let owner;
  const first = acquireInstallLock(root, { onPhase: (phase, value) => { if (phase === 'acquired') owner = value; } });
  assert.equal(typeof first, 'function');
  assert.equal(acquireInstallLock(root), null);
  assert.equal(fs.readdirSync(path.join(root, '.contenders')).length, 1);
  first();
  assert.equal(fs.existsSync(owner.directory), false);
  const second = acquireInstallLock(root);
  assert.equal(typeof second, 'function');
  first();
  assert.equal(acquireInstallLock(root), null);
  second();
  assert.deepEqual(fs.readdirSync(path.join(root, '.contenders')), []);
});

test('real processes cannot bypass a participant paused while choosing or an acquired owner', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'choosing.json');
  const gate = path.join(f.root, 'choose-gate');
  const holdGate = path.join(f.root, 'hold-gate');
  const first = f.child({ mode: 'once', pauseAt: 'choosing', marker, gate, holdGate });
  await untilFile(marker);
  assert.deepEqual(await f.child({ mode: 'once' }).success(), { acquired: false });
  releaseGate(gate);
  assert.deepEqual(await untilFile(first.result), { acquired: true });
  assert.deepEqual(await f.child({ mode: 'once' }).success(), { acquired: false });
  releaseGate(holdGate);
  await first.success();
  assert.deepEqual(await f.child({ mode: 'once' }).success(), { acquired: true });
});

test('six real processes repeatedly contend without overlapping critical sections', async t => {
  const f = fixture(t);
  const workers = Array.from({ length: 6 }, () => f.child({ mode: 'stress', iterations: 20 }));
  const results = await Promise.all(workers.map(worker => worker.success()));
  assert.deepEqual(results, Array.from({ length: 6 }, () => ({ completed: 20 })));
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.contenders')), []);
});

test('equal-ticket real process interleaving elects exactly the participant with the earlier UUID', async t => {
  const f = fixture(t);
  const participants = ['a', 'b'].map(name => {
    const barriers = ['numbered', 'ticket'].map(phase => ({
      phase, marker: path.join(f.root, `${name}-${phase}.json`), gate: path.join(f.root, `${name}-${phase}.gate`),
    }));
    return { barriers, process: f.child({ mode: 'once', barriers }) };
  });
  const numbered = await Promise.all(participants.map(item => untilFile(item.barriers[0].marker)));
  assert.deepEqual(numbered.map(item => item.ticket), [1, 1]);
  participants.forEach(item => releaseGate(item.barriers[0].gate));
  await Promise.all(participants.map(item => untilFile(item.barriers[1].marker)));
  const firstIndex = numbered[0].token < numbered[1].token ? 0 : 1;
  const later = participants[1 - firstIndex];
  releaseGate(later.barriers[1].gate);
  assert.deepEqual(await later.process.success(), { acquired: false });
  const first = participants[firstIndex];
  releaseGate(first.barriers[1].gate);
  assert.deepEqual(await first.process.success(), { acquired: true });
});

test('multiple real processes safely succeed a crashed owner without deleting its stale lock', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'crashed-owner.json');
  const crashed = f.child({ mode: 'once', pauseAt: 'acquired', marker, gate: path.join(f.root, 'never-open') });
  const owner = await untilFile(marker);
  crashed.child.kill('SIGKILL');
  await crashed.exited;
  const staleTicket = fs.readFileSync(path.join(owner.directory, 'ticket.json'), 'utf8');
  const workers = Array.from({ length: 4 }, () => f.child({ mode: 'stress', iterations: 15 }));
  await Promise.all(workers.map(worker => worker.success()));
  assert.equal(fs.readFileSync(path.join(owner.directory, 'ticket.json'), 'utf8'), staleTicket);
  assert.deepEqual(fs.readdirSync(path.join(f.root, '.contenders')), [path.basename(owner.directory)]);
});

test('a process killed before publishing its ticket cannot strand the lock', async t => {
  const f = fixture(t);
  const marker = path.join(f.root, 'crashed-choosing.json');
  const crashed = f.child({ mode: 'once', pauseAt: 'choosing', marker, gate: path.join(f.root, 'never-open') });
  const owner = await untilFile(marker);
  crashed.child.kill('SIGKILL');
  await crashed.exited;
  assert.equal(fs.existsSync(path.join(owner.directory, 'ticket.json')), false);
  assert.deepEqual(await f.child({ mode: 'once' }).success(), { acquired: true });
  assert.ok(fs.existsSync(owner.directory));
});

test('release refuses to remove a contender whose ownership token has changed', t => {
  const { root } = fixture(t);
  let owner;
  const release = acquireInstallLock(root, { onPhase: (phase, value) => { if (phase === 'acquired') owner = value; } });
  const ticketPath = path.join(owner.directory, 'ticket.json');
  const changed = { ...JSON.parse(fs.readFileSync(ticketPath, 'utf8')), token: randomUUID() };
  fs.writeFileSync(ticketPath, JSON.stringify(changed));
  release();
  assert.ok(fs.existsSync(owner.directory));
  assert.deepEqual(JSON.parse(fs.readFileSync(ticketPath, 'utf8')), changed);
  assert.throws(() => acquireInstallLock(root), /Invalid subapp lock ticket/);
});

test('PID permission failures fail closed while confirmed dead PIDs are ignored', t => {
  const { root } = fixture(t);
  const fakePid = 2147483647;
  const stale = path.join(root, '.contenders', `${fakePid}-${randomUUID()}`);
  fs.mkdirSync(stale, { recursive: true });
  const kill = t.mock.method(process, 'kill', pid => {
    assert.equal(pid, fakePid);
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  });
  assert.equal(acquireInstallLock(root), null);
  kill.mock.restore();
  const release = acquireInstallLock(root);
  assert.equal(typeof release, 'function');
  release();
  assert.ok(fs.existsSync(stale));
});

test('a failed ticket publication removes only the interrupted caller and allows retry', t => {
  const { root } = fixture(t);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated ticket write failure'); });
  assert.throws(() => acquireInstallLock(root), /simulated ticket write failure/);
  rename.mock.restore();
  assert.deepEqual(fs.readdirSync(path.join(root, '.contenders')), []);
  const release = acquireInstallLock(root);
  assert.equal(typeof release, 'function');
  release();
});
