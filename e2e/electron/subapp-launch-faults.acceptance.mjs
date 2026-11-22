import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const results = path.join(repo, 'e2e', 'test-results', 'subapp-launch-faults');
const fixture = fileURLToPath(new URL('./fixtures/subapp-launch-fault-host.cjs', import.meta.url));
await fs.mkdir(results, { recursive: true });
const root = await fs.mkdtemp(path.join(results, 'run-'));
const { ELECTRON_RUN_AS_NODE, AILY_CHILD_PATH, NODE_PATH, ...env } = process.env;
const processes = [];

async function launch(mode, store) {
  const directory = path.join(root, mode);
  await fs.mkdir(directory);
  const log = await fs.open(path.join(directory, 'electron.log'), 'w');
  const child = spawn(require('electron'), [fixture, mode], {
    cwd: repo,
    env: { ...env, AILY_LAUNCH_FAULT_DIRECTORY: directory, AILY_LAUNCH_FAULT_STORE: store },
    stdio: ['ignore', log.fd, log.fd],
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  processes.push({ child, exited });
  await log.close();
  return { child, directory, exited };
}

async function checkpoint(host, filename) {
  const marker = path.join(host.directory, filename);
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    try { return await fs.readFile(marker, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(host.child.exitCode, null, `Electron exited before ${filename}`);
    await delay(25);
  }
  throw new Error(`Missing ${marker}`);
}

let timeout;
try {
  console.log(`Evidence: ${root}`);
  const matrix = await launch('matrix', path.join(root, 'isolated-appdata'));
  const limit = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Native matrix timed out')), 135000); });
  const result = await Promise.race([matrix.exited, limit]);
  let scenarios;
  try { scenarios = JSON.parse(await fs.readFile(path.join(matrix.directory, 'scenarios.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const scenario of scenarios || []) console.log(`${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.name} (${scenario.ms} ms)`);
  assert.equal(result.code, 0, await fs.readFile(path.join(matrix.directory, 'electron.log'), 'utf8'));
  assert.ok(scenarios?.length && scenarios.every(scenario => scenario.ok));
  clearTimeout(timeout);

  const shared = path.join(root, 'shared-appdata');
  const holder = await launch('hold', shared);
  assert.equal(Number(await checkpoint(holder, 'holding')), holder.child.pid);
  const waiter = await launch('recover', shared);
  await checkpoint(waiter, 'waiting');
  await delay(300);
  await assert.rejects(fs.access(path.join(waiter.directory, 'recovered')), { code: 'ENOENT' });
  assert.ok(holder.child.kill('SIGKILL'));
  await holder.exited;
  await checkpoint(waiter, 'recovered');
  assert.equal((await waiter.exited).code, 0);
  console.log('PASS second Electron host recovers a shared install lock after the holder is killed');
} finally {
  clearTimeout(timeout);
  await Promise.all(processes.map(async ({ child, exited }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => {});
  }));
}
