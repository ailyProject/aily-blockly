import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import vm from 'node:vm';
import { nativeObservationWindow } from './native-observation-window.mjs';

// Qualifies only the scheduling fixture. The local handler supplies controlled
// facts; native state publishing and desktop Stop require separate acceptance.
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-observation-window-'));
  const project = path.join(directory, 'project'), token = randomUUID(), pid = 1234;
  const requestId = randomUUID(), nativeRequestId = 'pub2-' + requestId;
  const handled = [];
  let reply = {}, responseStatus = 200, responseBytes, callbacks = 0, window;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handled.push(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(responseStatus, { 'content-type': 'application/json' });
    const bytes = responseBytes ?? Buffer.from(' ' + JSON.stringify(reply) + '\n');
    response.end(bytes, () => { callbacks++; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = server.rawListeners('request')[0];
  const descriptorFile = path.join(directory, 'descriptor.json');
  await fs.writeFile(descriptorFile, JSON.stringify({ pid, port: server.address().port, token }));
  const context = vm.createContext({ Buffer, process: {
    pid: options.processPid ?? pid,
    _getActiveHandles: () => options.noOwnedServer ? [] : [server],
  } });
  const electron = { evaluate: async (callback, input) => vm.runInContext(
    '(' + callback.toString() + ')(undefined, ' + JSON.stringify(input) + ')', context,
  ) };
  t.after(async () => {
    await window?.close();
    assert.deepEqual(server.rawListeners('request'), [original]);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('native-observation-window-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const command = (operation = 'blocks_set_state') => ({ token, action: 'blockly-live-operation',
    operation, path: project, params: operation === 'project_save'
      ? { saveRequest: { version: 2, requestId: nativeRequestId } }
      : { version: 2, requestId, action: 'update', expectedGeneration: 'g1', changes: [{ blockId: 'root', collapsed: true }] },
  });
  return {
    project, token, requestId, nativeRequestId, handled, command,
    get callbacks() { return callbacks; },
    get window() { return window; },
    install: async (input = { operation: 'blocks_set_state' }) => {
      window = await nativeObservationWindow({ electron, descriptorFile, project, initialPublication: true, ...input });
    },
    terminal: (operation = 'blocks_set_state', receipt = {}, status = 200) => {
      reply = { ok: true, saveReceipt: { version: 2, requestId: nativeRequestId, operation,
        project, state: 'completed', ...receipt }, targetPid: pid,
        result: { publication: { status: 'COMMITTED', generation: 'g2' } } };
      if (options.flatTerminal) { reply.publication = reply.result.publication; delete reply.result; }
      responseStatus = status;
      responseBytes = undefined;
      return Buffer.from(' ' + JSON.stringify(reply) + '\n');
    },
    rawResponse: bytes => { responseBytes = bytes; },
    send: (body = command()) => new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/command', method: 'POST', timeout: 3000 }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
        response.once('error', reject);
      });
      request.once('timeout', () => request.destroy(new Error('Owned HTTP response timed out')));
      request.once('error', reject);
      request.end(JSON.stringify(body));
    }),
  };
}

async function held(f) {
  const deadline = Date.now() + 1500;
  do {
    await f.window.sample();
    if (f.window.held) return f.window.held;
    await setTimeout(5);
  } while (Date.now() < deadline);
  assert.fail('The exact completed publication response was not held');
}

test('state initial response holds its native pub2 receipt and releases original bytes once', async t => {
  const f = await fixture(t, { flatTerminal: true });
  await f.install();
  const expected = f.terminal(), command = f.command();
  let settled = false;
  const response = f.send(command).then(value => { settled = true; return value; });
  response.catch(() => {});
  const value = await held(f);
  assert.equal(value.requestId, f.nativeRequestId);
  assert.equal(value.originalPublication.receipt.operation, 'blocks_set_state');
  assert.equal(value.originalPublication.receipt.requestId, f.nativeRequestId);
  assert.equal(value.originalPublication.publication.status, 'COMMITTED');
  assert.equal(value.bytes, expected.length);
  assert.equal(settled, false);
  assert.equal(f.callbacks, 0);
  assert.deepEqual(f.handled, [JSON.stringify(command)]);
  await f.window.release();
  assert.deepEqual((await response).bytes, expected);
  await f.window.release();
  assert.deepEqual((await f.send(command)).bytes, expected, 'Released windows never hold a second response');
  assert.equal(f.callbacks, 2);
});

test('state pending initial response passes, then matching observe_state is held until close', async t => {
  const f = await fixture(t);
  await f.install();
  const initial = f.terminal('blocks_set_state', { state: 'pending' });
  assert.deepEqual((await f.send()).bytes, initial);
  const command = { ...f.command(), operation: 'abs_recovery', params: {
    action: 'observe_state', state: f.command().params, originalTargetPid: 1234,
  } };
  const expected = f.terminal();
  const response = f.send(command);
  response.catch(() => {});
  assert.equal((await held(f)).requestId, f.nativeRequestId);
  await f.window.close();
  assert.deepEqual((await response).bytes, expected);
  assert.deepEqual(f.handled, [JSON.stringify(f.command()), JSON.stringify(command)]);
});

test('state inspect, unrelated operations, malformed requests and unowned traffic stay untouched', async t => {
  const f = await fixture(t);
  await f.install();
  const expected = f.terminal(), original = f.command();
  const ignored = [
    { ...original, params: { ...original.params, action: 'inspect' } },
    { ...original, operation: 'project_save' },
    { ...original, operation: 'abs_recovery', params: { action: 'history_inspect', state: original.params } },
    { ...original, operation: 'abs_recovery', params: { action: 'observe_state', state: original.params } },
    { ...original, params: { ...original.params, version: 1 } },
    { ...original, params: { ...original.params, requestId: 'not-a-uuid' } },
    { ...original, params: { ...original.params, requestId: '-'.repeat(36) } },
    { ...original, params: { ...original.params, requestId: [f.requestId] } },
    { ...original, action: 'unrelated-action' },
    { ...original, token: 'another-token' },
    { ...original, path: path.join(f.project, 'another-project') },
  ];
  for (const command of ignored) {
    assert.deepEqual((await f.send(command)).bytes, expected);
    await f.window.sample();
    assert.equal(f.window.held, undefined);
  }
  const response = f.send(original);
  response.catch(() => {});
  await held(f);
  await f.window.release();
  assert.deepEqual((await response).bytes, expected, 'Ignored traffic did not claim the tracked request');
});

test('nonterminal or mismatched state receipts and unrelated observations are never held', async t => {
  const f = await fixture(t);
  await f.install();
  for (const receipt of [
    { version: 1 }, { state: 'pending' }, { requestId: 'pub2-' + randomUUID() },
    { requestId: f.requestId }, { operation: 'project_save' }, { project: path.join(f.project, 'other') },
  ]) {
    const expected = f.terminal('blocks_set_state', receipt);
    assert.deepEqual((await f.send()).bytes, expected);
    await f.window.sample();
    assert.equal(f.window.held, undefined);
  }
  const expected = f.terminal(), original = f.command();
  for (const params of [
    { action: 'observe_state', state: { ...original.params, requestId: randomUUID() } },
    { action: 'observe_state', state: { ...original.params, action: 'inspect' } },
    { action: 'observe_state', state: { ...original.params, version: 1 } },
  ]) assert.deepEqual((await f.send({ ...original, operation: 'abs_recovery', params })).bytes, expected);
  const error = f.terminal('blocks_set_state', {}, 409), errorResponse = await f.send();
  assert.equal(errorResponse.status, 409);
  assert.deepEqual(errorResponse.bytes, error);
  f.terminal();
  f.rawResponse(Buffer.from('not-json\n'));
  assert.deepEqual((await f.send()).bytes, Buffer.from('not-json\n'));
  f.terminal();
  const response = f.send();
  response.catch(() => {});
  await held(f);
  await f.window.release();
  assert.deepEqual((await response).bytes, expected);
});

test('default project_save initial and status responses keep their existing native ID behavior', async t => {
  for (const throughStatus of [false, true]) await t.test(throughStatus ? 'status' : 'initial', async t => {
    const f = await fixture(t);
    await f.install({});
    const command = f.command('project_save');
    if (throughStatus) {
      const initial = f.terminal('project_save', { state: 'pending' });
      assert.deepEqual((await f.send(command)).bytes, initial);
      command.operation = 'project_publication_status';
    }
    const expected = f.terminal('project_save');
    const response = f.send(command);
    response.catch(() => {});
    assert.equal((await held(f)).requestId, f.nativeRequestId);
    await f.window.release();
    assert.deepEqual((await response).bytes, expected);
  });
});

test('fixture installation still requires the descriptor Main identity and exact active server', async t => {
  for (const [options, message] of [
    [{ processPid: 5678 }, /Owned Main identity changed/],
    [{ noOwnedServer: true }, /Owned bridge HTTP server was not found/],
  ]) await t.test(message.source, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.install(), message);
  });
});
