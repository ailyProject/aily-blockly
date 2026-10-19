'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const protocol = require('../../electron/cloud-build/protocol');

function fixture(t, respond) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-diagnostics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardModule = '@aily-project/board-test';
  const boardPackage = { name: boardModule, version: '1.0.0' }, board = {};
  const boardRoot = path.join(root, 'node_modules', boardModule);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(boardPackage));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), JSON.stringify(board));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test', dependencies: { [boardModule]: '1.0.0' } }));
  const profile = { profileDigest: 'a'.repeat(64), runner: 'aily-builder', boardModule, boardVersion: '1.0.0',
    boardDigest: protocol.boardDigest(boardPackage, board), capabilities: { compile: true } };
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const broker = new CloudBuildBroker({ pollIntervalMs: 1, initialPollIntervalMs: 0 });
  broker.capabilities = async () => ({ protocolVersion: 1, publicKey: key });
  broker.targets = async () => ({ profiles: [profile] });
  broker.uploadSnapshot = async record => ({ inputDigest: record.snapshot.inputDigest, snapshotId: 'input' });
  broker.request = async (_settings, endpoint, body, signal) => {
    if (endpoint === '/api/v1/build/jobs') return { jobId: 'job' };
    if (endpoint.endsWith('/cancel')) return {};
    return respond(endpoint, signal);
  };
  const events = [];
  const sender = {};
  const run = () => broker.run(sender, { requestId: 'test', profileDigest: profile.profileDigest,
    settings: { gatewayUrl: 'http://localhost:4318' },
    config: { currentProjectPath: root, boardModule, code: 'void setup() {}\nvoid loop() {}' } }, event => events.push(event));
  return { run, events, broker, sender };
}

const failed = { status: 'failed', lastSeq: 2, error: { code: 'COMPILE_ERROR', message: 'Compiler exited with code 1' } };

test('terminal failure drains delayed and paged logs before releasing the task', async t => {
  let calls = 0;
  const f = fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return failed;
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { logs: calls === 1 ? [{ seq: 1, message: 'compiling' }]
      : [{ seq: 2, message: "main.cpp:4:3: error: 'missing_symbol' was not declared in this scope" }] };
  });
  await assert.rejects(f.run(), { code: 'COMPILE_ERROR' });
  assert.equal(calls, 2);
  assert.match(f.events.filter(e => e.log).map(e => e.log).join('\n'), /main.cpp:4:3: error/);
});

test('log transport failure keeps the original compiler failure and does not retry indefinitely', async t => {
  let calls = 0;
  const f = fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return failed;
    calls++;
    throw new Error('logs unavailable');
  });
  await assert.rejects(f.run(), { code: 'COMPILE_ERROR', message: failed.error.message });
  assert.ok(calls <= 2);
});

test('cancellation interrupts a terminal log drain and releases request ownership', async t => {
  let started;
  const logsStarted = new Promise(resolve => { started = resolve; });
  const f = fixture(t, async (endpoint, signal) => {
    if (!endpoint.includes('/logs?')) return failed;
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const rejected = assert.rejects(f.run(), error => error.code === 'CANCELLED');
  await logsStarted;
  await f.broker.cancel(f.sender, 'test');
  await rejected;
  assert.equal(f.broker.requests.size, 0);
});
