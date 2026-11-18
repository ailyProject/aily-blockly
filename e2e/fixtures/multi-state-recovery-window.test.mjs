import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { multiStateRecoveryWindow } from './multi-state-recovery-window.mjs';

// Use the actual native response constructor. Raw Host HTTP has no targetPid;
// appCommand adds that transport-side field only after reading the response.
const resultFile = new URL('../../src/app/integrations/blockly/abs/abs-native-save-result.ts', import.meta.url);
const resultSource = ts.createSourceFile(resultFile.pathname, await fs.readFile(resultFile, 'utf8'), ts.ScriptTarget.Latest, true);
const constructors = ['nativeSaveResult', 'nativeSaveObservationResponse'].map(name => {
  const declaration = resultSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Locate the actual production ${name} constructor`);
  return declaration.getText(resultSource).replace(/^export\s+/, '');
}).join('\n');
const nativeResponse = new Function('absProjectionReceipt', ts.transpileModule(constructors, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn nativeSaveObservationResponse;')(() => assert.fail('Controlled fixture does not construct publication evidence'));

// Scheduling-fixture contracts only. The local HTTP handler supplies controlled
// replies; this does not claim native publication, recovery or desktop coverage.
async function fixture(t, options = {}) {
  const temporary = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporary, 'multi-state-window-'));
  const project = path.join(directory, 'project'), token = randomUUID(), pid = 1234;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const handled = [];
  let bytes = Buffer.from('{}\n'), status = 200, callbacks = 0, window;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    handled.push(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(bytes, () => { callbacks++; });
  });
  if (options.extraListener) server.on('request', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalListeners = server.rawListeners('request');
  const descriptorFile = path.join(directory, 'descriptor.json');
  await fs.writeFile(descriptorFile, JSON.stringify({ pid, port: server.address().port, token }));
  const context = vm.createContext({ Buffer, process: {
    pid: options.processPid ?? pid,
    _getActiveHandles: () => options.noOwnedServer ? [] : [server],
  } });
  const electron = { evaluate: async (callback, input) => {
    const value = vm.runInContext('(' + callback.toString() + ')(undefined, ' + JSON.stringify(input) + ')', context);
    return value === undefined ? undefined : structuredClone(value);
  } };
  t.after(async () => {
    await window?.close();
    assert.deepEqual(server.rawListeners('request'), originalListeners);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.equal(path.dirname(await fs.realpath(directory)), temporary);
    assert.ok(path.basename(directory).startsWith('multi-state-window-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const command = (id = ids[0]) => ({ token, action: 'blockly-live-operation', operation: 'blocks_set_state', path: project,
    params: { version: 2, requestId: id, action: 'update', expectedGeneration: 'g1', changes: [{ blockId: 'root', collapsed: true }] },
  });
  const observe = (id = ids[1]) => ({ ...command(id), operation: 'abs_recovery', params: {
    action: 'observe_state', state: command(id).params, originalTargetPid: pid,
  } });
  function terminal(id = ids[0], receipt = {}, responseStatus = 200, reply = {}, kind = 'state') {
    status = responseStatus;
    const response = nativeResponse(project, { version: 2, requestId: 'pub2-' + id, operation: 'blocks_set_state' }, {
      state: 'completed', current: true,
      result: { publication: { status: 'COMMITTED' }, projectSaved: true, requiresReload: false, partial: false },
      ref: { operationId: 'controlled-' + id, attachment: { root: project }, executor: { hostPid: pid } },
    }, { hostPid: pid });
    // setBlockState.withPublication forwards these exact constructor fields;
    // observe_state returns the full nativeSaveObservationResponse object.
    const raw = kind === 'observe' ? response : { ...response.result,
      saveReceipt: response.saveReceipt, publicationObservation: response.publicationObservation };
    bytes = Buffer.from(' \n' + JSON.stringify({ ...raw, saveReceipt: { ...raw.saveReceipt, ...receipt }, ...reply }) + '\n');
    return bytes;
  }
  return {
    project, token, pid, ids, handled, command, observe,
    get callbacks() { return callbacks; }, get window() { return window; },
    async install() { window = await multiStateRecoveryWindow({ electron, descriptorFile, project }); },
    terminal,
    observeTerminal: (id = ids[1], receipt = {}, responseStatus = 200, reply = {}) => terminal(id, receipt, responseStatus, reply, 'observe'),
    rawResponse(value, responseStatus = 200) { bytes = value; status = responseStatus; },
    send(body = command()) {
      let request;
      const response = new Promise((resolve, reject) => {
        request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/command', method: 'POST', timeout: 3000 }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.once('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
          response.once('error', reject);
        });
        request.once('timeout', () => request.destroy(new Error('Owned HTTP response timed out')));
        request.once('error', reject);
        request.end(typeof body === 'string' ? body : JSON.stringify(body));
      });
      response.catch(() => {});
      response.abort = () => request.destroy(new Error('Owned client stopped'));
      return response;
    },
  };
}

async function hold(f) {
  const deadline = Date.now() + 1500;
  do {
    const value = await f.window.sample();
    if (value?.held) return value.held;
    await setTimeout(5);
  } while (Date.now() < deadline);
  assert.fail('The second original completed observation was not held');
}

async function createTwo(f) {
  for (const id of f.ids.slice(0, 2)) {
    f.terminal(id);
    await assert.rejects(f.send(f.command(id)), { code: 'ECONNRESET' });
  }
}

for (const [name, options, error] of [
  ['Main PID', { processPid: 5678 }, /Owned Main identity changed/],
  ['active server', { noOwnedServer: true }, /Owned bridge HTTP server was not found/],
  ['single original listener', { extraListener: true }, /Expected one original bridge listener/],
]) test(`installation requires the exact owned ${name}`, async t => {
  const f = await fixture(t, options);
  await assert.rejects(f.install(), error);
});

test('create drops at most two distinct actual completed ACKs and forwards original commands unchanged', async t => {
  const f = await fixture(t);
  await f.install();
  await assert.rejects(f.window.arm(), /Need exactly two actual original completed setters/);
  for (const [index, status] of [200, 400].entries()) {
    const id = f.ids[index], expected = f.terminal(id, {}, status), command = f.command(id);
    await assert.rejects(f.send(command), { code: 'ECONNRESET' });
    const duplicate = await f.send(command);
    assert.equal(duplicate.status, status);
    assert.deepEqual(duplicate.bytes, expected, 'The same original is never dropped twice');
  }
  const expected = f.terminal(f.ids[2]);
  assert.deepEqual((await f.send(f.command(f.ids[2]))).bytes, expected, 'A third distinct completed setter is untouched');
  const value = await f.window.sample();
  assert.deepEqual(value.originals, f.ids.slice(0, 2).map(id => 'pub2-' + id));
  assert.equal(value.trace.filter(entry => entry.action === 'drop-completed-ack').length, 2);
  assert.deepEqual(f.handled, [f.command(), f.command(), f.command(f.ids[1]), f.command(f.ids[1]), f.command(f.ids[2])].map(value => JSON.stringify(value)));
  assert.equal(f.callbacks, 3);
  await f.window.arm();
  await assert.rejects(f.window.arm(), /Need exactly two actual original completed setters/);
});

test('nonterminal, mismatched and invalid response receipts never claim an original setter', async t => {
  const f = await fixture(t);
  await f.install();
  for (const receipt of [
    { version: 1 }, { state: 'pending' }, { state: 'failed' }, { requestId: 'pub2-' + randomUUID() },
    { requestId: f.ids[0] }, { operation: 'project_save' }, { project: path.join(f.project, 'other') },
  ]) {
    const expected = f.terminal(f.ids[0], receipt);
    assert.deepEqual((await f.send()).bytes, expected);
  }
  const error = f.terminal(f.ids[0], {}, 409), failed = await f.send();
  assert.equal(failed.status, 409);
  assert.deepEqual(failed.bytes, error);
  f.rawResponse(Buffer.from('not-json\n'));
  assert.deepEqual((await f.send()).bytes, Buffer.from('not-json\n'));
  assert.deepEqual((await f.window.sample()).originals, []);
});

test('native publication identity mismatch stays untouched even with an exact completed receipt', async t => {
  const f = await fixture(t);
  await f.install();
  const observation = JSON.parse(f.terminal()).publicationObservation;
  for (const identity of [
    undefined, { ...observation, version: 2 }, { ...observation, durable: false },
    { ...observation, requestId: 'pub2-' + f.ids[1] }, { ...observation, operation: 'project_save' },
    { ...observation, executor: { hostPid: f.pid + 1 } }, { ...observation, observer: { hostPid: f.pid + 1 } },
    { ...observation, executor: { hostPid: String(f.pid) } }, { ...observation, observer: { hostPid: null } },
  ]) {
    const expected = f.terminal(f.ids[0], {}, 200, { publicationObservation: identity });
    assert.deepEqual((await f.send()).bytes, expected);
  }
  assert.deepEqual((await f.window.sample()).originals, []);
});

test('actual raw native response constructors work without a transport-added targetPid', async t => {
  const f = await fixture(t);
  await f.install();
  for (const id of f.ids.slice(0, 2)) {
    const response = JSON.parse(f.terminal(id));
    assert.equal(Object.hasOwn(response, 'targetPid'), false);
    assert.equal(response.publicationObservation.executor.hostPid, f.pid);
    assert.equal(response.publicationObservation.observer.hostPid, f.pid);
    assert.equal(response.publicationObservation.requestId, response.saveReceipt.requestId);
    await assert.rejects(f.send(f.command(id)), { code: 'ECONNRESET' });
  }
  await f.window.arm();
  const expected = f.observeTerminal();
  assert.equal(Object.hasOwn(JSON.parse(expected), 'targetPid'), false);
  const response = f.send(f.observe());
  await hold(f);
  await f.window.close();
  assert.deepEqual((await response).bytes, expected);
});

test('unowned, unrelated and malformed requests cannot consume either original slot', async t => {
  const f = await fixture(t);
  await f.install();
  const expected = f.terminal(), original = f.command();
  const ignored = [
    { ...original, token: 'another-token' }, { ...original, path: path.join(f.project, 'other') },
    { ...original, action: 'unrelated-action' }, { ...original, operation: 'project_save' },
    { ...original, params: { ...original.params, action: 'inspect' } },
    { ...original, params: { ...original.params, version: 1 } },
    { ...original, params: { ...original.params, requestId: 'not-a-uuid' } },
    { ...original, params: { ...original.params, requestId: [f.ids[0]] } },
    { ...original, params: { ...original.params, requestId: '-'.repeat(36) } },
    'not-json',
    JSON.stringify({ ...original, padding: 'x'.repeat(1024 * 1024) }),
  ];
  for (const command of ignored) assert.deepEqual((await f.send(command)).bytes, expected);
  assert.deepEqual((await f.window.sample()).originals, []);
  f.terminal();
  await assert.rejects(f.send(), { code: 'ECONNRESET' });
  assert.deepEqual((await f.window.sample()).originals, ['pub2-' + f.ids[0]]);
});

test('arm holds only the second original matching completed observe_state response', async t => {
  const f = await fixture(t);
  await f.install();
  await createTwo(f);
  f.observeTerminal(f.ids[1]);
  assert.deepEqual((await f.send(f.observe())).bytes, f.observeTerminal(f.ids[1]), 'Observations before arm are untouched');
  await f.window.arm();
  for (const id of [f.ids[0], f.ids[2]]) {
    const expected = f.observeTerminal(id);
    assert.deepEqual((await f.send(f.observe(id))).bytes, expected);
  }
  const original = f.observe(), expected = f.observeTerminal(f.ids[1]);
  for (const command of [
    { ...original, token: 'other' }, { ...original, path: path.join(f.project, 'other') },
    { ...original, params: { ...original.params, originalTargetPid: f.pid + 1 } },
    { ...original, params: { ...original.params, originalTargetPid: undefined } },
    { ...original, params: { ...original.params, action: 'history_inspect' } },
    { ...original, params: { ...original.params, state: { ...original.params.state, requestId: [f.ids[1]] } } },
  ]) assert.deepEqual((await f.send(command)).bytes, expected);
  for (const receipt of [{ state: 'pending' }, { requestId: 'pub2-' + f.ids[0] }]) {
    const pending = f.observeTerminal(f.ids[1], receipt);
    assert.deepEqual((await f.send(original)).bytes, pending);
  }
  const observation = JSON.parse(f.observeTerminal()).publicationObservation;
  const wrongPid = f.observeTerminal(f.ids[1], {}, 200, { publicationObservation: { ...observation, observer: { hostPid: f.pid + 1 } } });
  assert.deepEqual((await f.send(original)).bytes, wrongPid);
  assert.equal((await f.window.sample()).held, undefined);
  const heldBytes = f.observeTerminal(f.ids[1], {}, 400, { ok: false, partial: true });
  let settled = false;
  const response = f.send(original).then(value => { settled = true; return value; });
  response.catch(() => {});
  const value = await hold(f);
  assert.equal(value.requestId, 'pub2-' + f.ids[1]);
  assert.equal(value.status, 400);
  assert.equal(value.bytes, heldBytes.length);
  assert.equal(value.receipt.state, 'completed');
  assert.equal(settled, false);
  const callbacks = f.callbacks;
  const duplicate = f.observeTerminal(f.ids[1]);
  assert.deepEqual((await f.send(original)).bytes, duplicate, 'A held window never captures a second response');
  await f.window.close();
  const released = await response;
  assert.equal(released.status, 400);
  assert.deepEqual(released.bytes, heldBytes);
  assert.equal(f.callbacks, callbacks + 2);
  await f.window.close();
  assert.equal(f.callbacks, callbacks + 2, 'Close releases original bytes and callback at most once');
  assert.equal(await f.window.sample(), undefined);
  assert.deepEqual((await f.send(original)).bytes, duplicate, 'Close restores the original request listener');
  assert.ok(f.handled.includes(JSON.stringify(original)));
});

test('close after client cancellation restores listener without replaying the held response', async t => {
  const f = await fixture(t);
  await f.install();
  await createTwo(f);
  f.observeTerminal(f.ids[1]);
  await f.window.arm();
  const response = f.send(f.observe());
  await hold(f);
  response.abort();
  await assert.rejects(response, /Owned client stopped/);
  const deadline = Date.now() + 1500;
  while (!(await f.window.sample()).held.clientClosed && Date.now() < deadline) await setTimeout(5);
  assert.equal((await f.window.sample()).held.clientClosed, true);
  const callbacks = f.callbacks;
  await f.window.close();
  await f.window.close();
  assert.equal(f.callbacks, callbacks);
  const expected = f.observeTerminal(f.ids[1]);
  assert.deepEqual((await f.send(f.observe())).bytes, expected);
});
