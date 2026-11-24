import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { nativeBuildObservation } from './native-build-observation.mjs';

// Qualifies the passive observer only. Replies are controlled unit-test facts;
// actual compilation, notice-button cancellation and fresh user intent require
// the independent desktop acceptance case.
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-build-observation-'));
  const project = path.join(directory, 'project'), token = randomUUID(), pid = 1234;
  const handled = [], responses = [];
  let observation, reply, rawReply, status = 200, chunked = false, callbacks = 0, failEvaluate = false;
  const original = options.original ?? function (request, response) {
    assert.equal(this, server, 'The original request listener keeps its receiver');
    const initial = { response, write: response.write, end: response.end };
    responses.push(initial);
    const chunks = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.once('end', () => {
      const bytes = Buffer.concat(chunks);
      handled.push(bytes);
      let command;
      try { command = JSON.parse(bytes.toString('utf8')); } catch { /* Controlled malformed request. */ }
      const body = rawReply ?? Buffer.from(' \n' + JSON.stringify(reply ?? {
        ok: true, operation: command?.operation,
        buildReceipt: { version: 1, requestId: command?.params?.buildRequest?.requestId,
          project, state: 'completed' },
        result: { ok: false, code: 'BUILD_CANCELLED', buildOutcome: 'cancelled',
          message: 'PRIVATE-COMPILER-TEXT', source: 'PRIVATE-SOURCE-TEXT' },
      }) + '\n');
      response.writeHead(status, { 'content-type': 'application/json', 'x-owned-original': 'unchanged' });
      if (chunked) {
        response.write(body.subarray(0, 3));
        response.write(body.subarray(3, 11));
        response.end(body.subarray(11), () => { callbacks++; });
      } else response.end(body, () => { callbacks++; });
    });
  };
  const server = http.createServer(original);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const descriptorFile = path.join(directory, 'descriptor.json');
  await fs.writeFile(descriptorFile, JSON.stringify({ pid, port: server.address().port, token }));
  const context = vm.createContext({ Buffer, ArrayBuffer, process: {
    pid: options.processPid ?? pid,
    getBuiltinModule: process.getBuiltinModule,
    _getActiveHandles: () => options.noOwnedServer ? [] : [server],
  } });
  const electron = { evaluate: async (callback, input) => {
    if (failEvaluate) { failEvaluate = false; throw Error('Controlled evaluation error'); }
    const value = vm.runInContext('(' + callback.toString() + ')(undefined, ' + JSON.stringify(input) + ')', context);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } };
  t.after(async () => {
    await observation?.close();
    assert.deepEqual(server.rawListeners('request'), [original]);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('native-build-observation-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const command = (operation = 'project_build', requestId = randomUUID(), compileOptions = {}) => ({
    token, action: 'blockly-live-operation', path: project, operation,
    params: { ...compileOptions, buildRequest: { version: 1, requestId, waitMs: 10000 } },
  });
  return {
    server, original, project, token, handled, responses, command,
    get observation() { return observation; },
    get callbacks() { return callbacks; },
    failSample: () => { failEvaluate = true; },
    install: async () => { observation = await nativeBuildObservation({ electron, descriptorFile, project }); },
    respond: (value, responseStatus = 200, useChunks = false) => {
      reply = value; rawReply = undefined; status = responseStatus; chunked = useChunks;
    },
    rawResponse: (value, responseStatus = 200, useChunks = false) => {
      rawReply = value; status = responseStatus; chunked = useChunks;
    },
    send: (body = command(), { method = 'POST', url = '/command', raw } = {}) => new Promise((resolve, reject) => {
      const encoded = raw ?? JSON.stringify(body);
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: url, method, headers: { 'content-length': Buffer.byteLength(encoded) }, timeout: 3000 }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
        response.once('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error('Owned HTTP response timed out')));
      request.once('error', reject);
      request.end(encoded);
    }),
  };
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('original request bytes, response bytes, status, headers and completion callback pass unchanged', async t => {
  const f = await fixture(t);
  await f.install();
  const command = f.command('project_build', randomUUID(), { preprocess_only: true, clear_cache: false });
  const expected = Buffer.from(' \n' + JSON.stringify({ ok: true, operation: command.operation,
    buildReceipt: { version: 1, requestId: command.params.buildRequest.requestId, project: f.project, state: 'running' },
    privateToken: f.token, source: 'PRIVATE-SOURCE-TEXT', result: { ok: true, message: 'PRIVATE-COMPILER-TEXT' },
  }) + '\n');
  f.rawResponse(expected, 207, true);
  const actual = await f.send(command), record = (await f.observation.sample()).requests[0];
  assert.equal(actual.status, 207);
  assert.equal(actual.headers['x-owned-original'], 'unchanged');
  assert.deepEqual(actual.bytes, expected);
  assert.deepEqual(f.handled, [Buffer.from(JSON.stringify(command))]);
  assert.equal(f.callbacks, 1);
  assert.equal(record.operation, 'project_build');
  assert.equal(record.requestId, command.params.buildRequest.requestId);
  assert.equal(record.requestVersion, 1);
  assert.equal(record.waitMs, 10000);
  assert.deepEqual(record.options, { preprocess_only: true, clear_cache: false });
  assert.equal(record.response.bytes, expected.length);
  assert.equal(record.response.sha256, sha(expected));
  assert.equal(record.response.receiptMatchesRequest, true);
  assert.equal(record.response.receipt.state, 'running');
  const serialized = JSON.stringify(await f.observation.sample());
  for (const secret of [f.token, 'PRIVATE-SOURCE-TEXT', 'PRIVATE-COMPILER-TEXT', 'targetPid']) assert.ok(!serialized.includes(secret));
});

test('two actual start IDs stay distinct while repeated old status responses keep their original identity', async t => {
  const f = await fixture(t);
  await f.install();
  const old = randomUUID(), current = randomUUID();
  const commands = [f.command('project_build', old), f.command('project_build_status', old),
    f.command('project_build', current), f.command('project_build_status', old), f.command('project_build_status', current)];
  for (const command of commands) await f.send(command);
  const { requests } = await f.observation.sample();
  assert.deepEqual(requests.map(({ operation, requestId }) => ({ operation, requestId })),
    commands.map(command => ({ operation: command.operation, requestId: command.params.buildRequest.requestId })));
  assert.equal(requests.filter(record => record.operation === 'project_build').length, 2);
  for (const record of requests) {
    assert.equal(record.response.receiptMatchesRequest, true);
    assert.equal(record.response.receipt.requestId, record.requestId);
    assert.equal(record.response.receipt.state, 'completed');
    assert.deepEqual(record.response.result, { ok: false, code: 'BUILD_CANCELLED', buildOutcome: 'cancelled' });
  }
  assert.equal(f.callbacks, commands.length);
  assert.deepEqual(f.handled, commands.map(command => Buffer.from(JSON.stringify(command))));
});

test('scope, authentication, exact route, operation and protocol shape qualify observation only', async t => {
  const f = await fixture(t);
  await f.install();
  const original = f.command();
  const ignored = [
    { ...original, token: 'foreign-token' }, { ...original, path: path.join(f.project, 'other') },
    { ...original, action: 'foreign-action' }, { ...original, operation: 'project_save' },
    { ...original, params: [] }, { ...original, params: { buildRequest: [] } },
    ...[{ version: 2 }, { requestId: 'not-a-uuid' }, { requestId: '-'.repeat(36) },
      { requestId: [original.params.buildRequest.requestId] }, { waitMs: -1 }, { waitMs: 10001 }, { waitMs: 0.5 }]
      .map(change => ({ ...original, params: { buildRequest: { ...original.params.buildRequest, ...change } } })),
    { ...original, params: { ...original.params, preprocess_only: 'true' } },
  ];
  const bytes = Buffer.from('original-unqualified-response\n');
  f.rawResponse(bytes);
  for (const command of ignored) assert.deepEqual((await f.send(command)).bytes, bytes);
  for (const routing of [{ method: 'GET' }, { url: '/another-command' }, { raw: 'not-json' }])
    assert.deepEqual((await f.send(original, routing)).bytes, bytes);
  assert.deepEqual((await f.observation.sample()).requests, []);
  assert.equal(f.handled.length, ignored.length + 3, 'The observer never rejects or swallows original traffic');
});

test('mismatched or malformed original replies retain exact bytes without acquiring matching receipt evidence', async t => {
  const f = await fixture(t);
  await f.install();
  const command = f.command(), base = { version: 1, requestId: command.params.buildRequest.requestId,
    project: f.project, state: 'completed' };
  for (const change of [{ version: 2 }, { requestId: randomUUID() }, { project: path.join(f.project, 'other') }, { state: 'pending' }]) {
    const bytes = Buffer.from(JSON.stringify({ ok: true, operation: command.operation, buildReceipt: { ...base, ...change } }));
    f.rawResponse(bytes, 400);
    assert.deepEqual((await f.send(command)).bytes, bytes);
  }
  for (const bytes of [Buffer.from('not-json\n'), Buffer.from(JSON.stringify({ ok: true, operation: 'project_build_status', buildReceipt: base }))]) {
    f.rawResponse(bytes);
    assert.deepEqual((await f.send(command)).bytes, bytes);
  }
  const { requests } = await f.observation.sample();
  assert.equal(requests.length, 6);
  for (const record of requests) {
    assert.equal(record.response.receiptMatchesRequest, false);
    assert.equal(record.response.receipt, undefined);
    assert.match(record.response.sha256, /^[a-f0-9]{64}$/);
  }
});

test('close restores the exact Main listener after sampling errors and remains idempotent', async t => {
  const f = await fixture(t);
  await f.install();
  await f.send();
  f.failSample();
  await assert.rejects(f.observation.sample(), /Controlled evaluation error/);
  await f.observation.close();
  assert.deepEqual(f.server.rawListeners('request'), [f.original]);
  const final = await f.observation.sample();
  await f.observation.close();
  await f.send();
  assert.equal(f.callbacks, 2, 'Each original end callback is called once, including after close');
  assert.equal((await f.observation.sample()).requests.length, 1);
  assert.deepEqual(await f.observation.sample(), final);
});

test('synchronous original listener errors restore response methods before close restores Main', async t => {
  const f = await fixture(t, { original() { throw Error('Controlled original listener error'); } });
  await f.install();
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/command' });
  const response = new EventEmitter();
  const write = response.write = function () { return true; }, end = response.end = function () { return this; };
  assert.throws(() => f.server.rawListeners('request')[0].call(f.server, request, response), /Controlled original listener error/);
  assert.equal(response.write, write);
  assert.equal(response.end, end);
  await f.observation.close();
  assert.deepEqual(f.server.rawListeners('request'), [f.original]);
});

test('installation requires exact descriptor Main PID, owned port and one original listener', async t => {
  for (const [options, expected] of [[{ processPid: 5678 }, /Owned Main identity changed/],
    [{ noOwnedServer: true }, /Owned bridge HTTP server was not found/]]) await t.test(expected.source, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.install(), expected);
    assert.deepEqual(f.server.rawListeners('request'), [f.original]);
  });
  await t.test('multiple original listeners', async t => {
    const f = await fixture(t), additional = () => {};
    f.server.on('request', additional);
    try { await assert.rejects(f.install(), /one original request listener/); }
    finally { f.server.removeListener('request', additional); }
  });
});
