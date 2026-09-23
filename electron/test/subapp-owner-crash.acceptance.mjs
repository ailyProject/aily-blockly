import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const hostRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const serialRoot = path.resolve(process.env.SERIAL_SUBAPP_ROOT || path.join(hostRoot, '../aily-subapp/packages/serial-debugger'));
const requireHost = createRequire(path.join(hostRoot, 'package.json'));
const serial = createRequire(path.join(serialRoot, 'package.json'));
const { callSerialRuntime } = serial('./runtime/rpc-client');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'subapp-owner-crash-'));
const runtimeRoot = path.join(output, 'runtime');
const descriptorPath = path.join(runtimeRoot, 'runtime.json');
const report = { output, checks: [], hardware: 'simulated', hosts: [] };
const children = [];
const log = fs.createWriteStream(path.join(output, 'process.log'));
const { ELECTRON_RUN_AS_NODE, ...env } = process.env;
const run = (command, args, extraEnv = {}) => {
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, SERIAL_SUBAPP_ROOT: serialRoot, ...extraEnv } });
  children.push(child);
  child.stdout.on('data', data => log.write(data)); child.stderr.on('data', data => log.write(data));
  return child;
};
async function until(probe, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await probe(); if (result) return result; await delay(50); }
  throw new Error('Crash acceptance checkpoint timed out');
}
async function killOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL'); // Exact handle of a child spawned by this test; no PID discovery or process tree kill.
  await exited;
}
let descriptor;
try {
  const daemon = run(process.execPath, ['--require', path.join(hostRoot, 'electron/test/fixtures/subapp-crash-driver.cjs'),
    path.join(serialRoot, 'index.js'), 'daemon-run', '--runtime-dir', runtimeRoot, '--persist']);
  descriptor = await until(() => {
    assert.equal(daemon.exitCode, null, 'Test daemon exited before readiness');
    try { return JSON.parse(fs.readFileSync(descriptorPath)); } catch { return false; }
  });
  assert.equal(descriptor.pid, daemon.pid);
  const call = (method, params = {}, context = {}) => callSerialRuntime(descriptor, method, params, { ...context, timeoutMs: 35000 });
  const host = async marker => {
    const root = path.join(output, `host-${marker}`); fs.mkdirSync(root);
    const child = run(requireHost('electron'), [path.join(hostRoot, 'electron/test/fixtures/subapp-crash-host.cjs')], {
      SUBAPP_CRASH_FIXTURE_ROOT: root, SUBAPP_CRASH_DESCRIPTOR: descriptorPath, SUBAPP_CRASH_OWNER: `owner-${marker}`,
    });
    const ready = await until(() => {
      assert.equal(child.exitCode, null, 'Test host exited before readiness');
      try { return JSON.parse(fs.readFileSync(path.join(root, 'ready.json'))); } catch { return false; }
    });
    assert.equal(ready.pid, child.pid, 'Kill target must be the actual Electron main, not a launcher');
    report.hosts.push(ready.pid);
    return { child, context: { actor: 'agent', sessionId: ready.ownerSessionId, ...ready.context } };
  };
  const a = await host('a'), b = await host('b');
  const left = await call('serial.session.open', { portPath: 'CRASH_A', baudRate: 115200, dtrOnOpen: false }, a.context);
  const right = await call('serial.session.open', { portPath: 'CRASH_B', baudRate: 115200, dtrOnOpen: false }, b.context);
  // Also share B with A: losing A must drop just its reference, not close B.
  await call('serial.session.open', { channelId: right.channelId, portPath: 'CRASH_B' }, a.context);
  report.checks.push('actual-daemon-and-two-electron-main-processes', 'process-lease-bound-through-production-preload');
  const pending = call('serial.transact', { channelId: left.channelId, send: { mode: 'text', data: 'await-crash' },
    expect: { type: 'text', value: 'never-received' }, timeoutMs: 30000 }, a.context);
  const rejected = assert.rejects(pending, error => /CANCEL|RELEASE/.test(error.code));
  await until(async () => (await call('serial.session.status', { channelId: left.channelId })).txBytes > 0);
  const started = performance.now();
  await killOwned(a.child);
  assert.equal(fs.existsSync(a.context.leaseFile), true, 'Strong kill must leave the file, unlike normal release');
  await assert.rejects(call('serial.send', { channelId: left.channelId, data: 'stale' }, a.context), { code: 'SERIAL_RUNTIME_LEASE_EXPIRED' });
  await until(async () => !(await call('serial.session.status', { channelId: left.channelId })).connected, 10000);
  await rejected;
  report.crashReleaseMs = Math.round(performance.now() - started);
  const preserved = await call('serial.session.status', { channelId: right.channelId });
  assert.equal(preserved.ownerCount, 1); assert.equal(preserved.connectedAt, right.connectedAt);
  await call('serial.transact', { channelId: right.channelId, send: { mode: 'text', data: 'still-b' },
    expect: { type: 'text', value: 'CRASH_B:still-b' }, timeoutMs: 1000 }, b.context);
  report.checks.push('strong-kill-with-stale-file', 'late-command-fenced', 'in-flight-request-cancelled', 'other-host-and-shared-channel-uninterrupted');
  const next = await host('a-restarted');
  await call('serial.session.open', { channelId: left.channelId, portPath: 'CRASH_A' }, next.context);
  assert.notEqual(next.context.leaseFile, a.context.leaseFile);
  await assert.rejects(call('serial.send', { channelId: left.channelId, data: 'stale-again' }, a.context), { code: 'SERIAL_RUNTIME_LEASE_EXPIRED' });
  await killOwned(next.child); await killOwned(b.child);
  await until(async () => (await call('serial.session.list')).channels.every(channel => !channel.connected), 10000);
  assert.equal((await call('runtime.lease.status')).active, 0);
  assert.equal(daemon.exitCode, null, 'An explicitly persistent daemon must not be stopped by an owner');
  report.checks.push('restart-uses-new-owner-fence', 'final-owner-port-release-with-persistent-daemon');
  report.ok = true;
} catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; }
finally {
  for (const child of children.slice(1)) await killOwned(child);
  if (descriptor) await callSerialRuntime(descriptor, 'shutdown', {}, { timeoutMs: 5000 }).catch(error => {
    report.cleanupError = error.message; report.ok = false; process.exitCode = 1;
  });
  for (const child of children) await killOwned(child);
  await new Promise(resolve => log.end(resolve));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
