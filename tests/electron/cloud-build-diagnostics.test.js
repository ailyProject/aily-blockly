'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const protocol = require('../../electron/cloud-build/protocol');

function fixture(t, respond, options = {}) {
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
  const broker = new CloudBuildBroker({ pollIntervalMs: 1, initialPollIntervalMs: 0, ...options });
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
  const config = { currentProjectPath: root, boardModule, code: 'void setup() {}\nvoid loop() {}' };
  const run = (requestId = 'test', input = config) => broker.run(sender, { requestId, profileDigest: profile.profileDigest,
    settings: { gatewayUrl: 'http://localhost:4318' },
    config: input }, event => events.push(event));
  return { run, events, broker, sender, config };
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
  await assert.rejects(f.run(), { code: 'COMPILE_ERROR', logComplete: true });
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
  await assert.rejects(f.run(), { code: 'COMPILE_ERROR', message: failed.error.message, logComplete: false });
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
  const rejected = assert.rejects(f.run(), error => error.code === 'CANCELLED' && error.logComplete === false);
  await logsStarted;
  await f.broker.cancel(f.sender, 'test');
  await rejected;
  assert.equal(f.broker.requests.size, 0);
});

function success(f) {
  // Artifact signature/import behavior has its own real-byte suites. These
  // tests isolate the terminal log handoff before that unchanged publication.
  f.broker.fetchCompletedResult = async () => ({});
  f.broker.importResult = async () => {};
  return f;
}

test('terminal success drains delayed pages before returning or importing artifacts', async t => {
  let calls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 3 };
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { logs: calls === 1 ? [{ seq: 1, message: 'compiling' }]
      : [{ seq: 3, message: 'final output' }, { seq: 2, message: 'middle output' }] };
  }));
  f.broker.importResult = async () => {
    assert.deepEqual(f.events.filter(e => e.log).map(e => e.log), ['compiling', 'middle output', 'final output']);
  };
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, true);
  assert.equal(calls, 2);
  assert.equal(f.broker.requests.size, 0);
});

test('log transport failure leaves a successful build successful with partial log evidence', async t => {
  let calls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 1 };
    calls++;
    throw new Error('log transport unavailable');
  }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert.equal(calls, 2);
});

test('an in-flight log transport failure can recover from its unchanged cursor', async t => {
  let calls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 1 };
    if (++calls === 1) throw new Error('transient log failure');
    return { logs: [{ seq: 1, message: 'recovered complete output' }] };
  }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, true);
  assert.equal(calls, 2);
});

test('empty terminal pages cannot prove a known remaining tail is complete', async t => {
  let calls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 2 };
    return { logs: ++calls === 1 ? [{ seq: 1, message: 'beginning' }] : [] };
  }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert.equal(calls, 2);
});

test('a legacy terminal without a cursor is explicitly partial after a bounded drain', async t => {
  let calls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded' };
    return { logs: ++calls === 1 ? [{ seq: 1, message: 'legacy output' }] : [] };
  }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert.equal(calls, 2);
});

test('concurrent projects keep their log cursors, request ownership and completeness independent', async t => {
  const f = success(fixture(t, async () => {}));
  const other = fixture(t, async () => {});
  f.broker.request = async (_settings, endpoint, body) => {
    if (endpoint === '/api/v1/build/jobs') return { jobId: body.requestId };
    if (endpoint.endsWith('/cancel')) return {};
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 1 };
    const id = endpoint.includes('/first/') ? 'first' : 'second';
    await new Promise(resolve => setTimeout(resolve, id === 'first' ? 12 : 2));
    return { logs: [{ seq: 1, message: id + ' output' }] };
  };
  const results = await Promise.all([f.run('first'), f.run('second', other.config)]);
  assert(results.every(result => result.success && result.logComplete));
  for (const id of ['first', 'second'])
    assert.deepEqual(f.events.filter(event => event.requestId === id && event.log).map(event => event.log), [id + ' output']);
  assert.equal(f.broker.requests.size, 0);
});

test('a hung optional log request times out independently of the compiler result', async t => {
  // Keep the mocked transport alive like a real socket while its own log-only
  // AbortSignal timeout expires. No compiler/owner cancellation is requested.
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  const f = success(fixture(t, async (endpoint, signal) => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 1 };
    return new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, { deadlineMs: 5000, requestTimeoutMs: 500 }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert.equal(f.broker.requests.size, 0);
});

test('optional log reads leave an ordinary request budget for signed publication', async t => {
  let logCalls = 0;
  const f = success(fixture(t, async endpoint => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 1 };
    logCalls++;
    throw new Error('No optional log GET should consume the publication budget');
  }, { deadlineMs: 5000, requestTimeoutMs: 20_000 }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert.equal(logCalls, 0);
});

test('terminal pages share one drain budget instead of resetting it per page', async t => {
  let calls = 0;
  const f = success(fixture(t, async (endpoint, signal) => {
    if (!endpoint.includes('/logs?')) return { status: 'succeeded', lastSeq: 10 };
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 20);
      const stop = () => { clearTimeout(timer); reject(signal.reason); };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    return { logs: [{ seq: calls, message: 'page ' + calls }] };
  }, { deadlineMs: 5000, requestTimeoutMs: 50 }));
  const result = await f.run();
  assert.equal(result.success, true);
  assert.equal(result.logComplete, false);
  assert(calls >= 1 && calls < 10);
});
