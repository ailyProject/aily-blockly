'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const protocol = require('../../electron/cloud-build/protocol');

const settings = { gatewayUrl: 'http://localhost:4318' };
const selector = { boardModule: '@aily-project/board-esp32s3dev', boardVersion: '3.2.1', boardDigest: 'a'.repeat(64) };
const supported = { boardModule: selector.boardModule, boardVersion: selector.boardVersion, supported: true, available: true };

function fixture(response = supported) {
  const calls = [];
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const broker = new CloudBuildBroker({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.pathname.endsWith('/board-support')) return Response.json(response);
    if (url.pathname.endsWith('/capabilities')) return Response.json({ protocolVersion: 1, publicKey: key, targetLookupByBoard: true });
    if (url.pathname.endsWith('/targets')) return Response.json({ profiles: [
      { ...selector, profileDigest: 'b'.repeat(64), runner: 'aily-builder', capabilities: { compile: true, analysis: true } },
      { ...selector, boardDigest: 'c'.repeat(64) },
    ] });
    throw new Error(`Unexpected request: ${url}`);
  } });
  return { broker, calls };
}

test('checks the exact module and installed version before querying content-matched targets', async () => {
  const { broker, calls } = fixture();
  const catalog = await broker.targets(settings, undefined, undefined, selector);
  assert.equal(catalog.profiles.length, 1);
  assert.deepEqual(calls.map(call => call.url.pathname), [
    '/api/v1/build/board-support', '/api/v1/build/capabilities', '/api/v1/build/targets',
  ]);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    boardModule: selector.boardModule, boardVersion: selector.boardVersion,
  });
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[2].url.searchParams.get('boardDigest'), selector.boardDigest);
});

for (const [reason, code] of [
  ['not_enabled', 'CLOUD_BOARD_NOT_ENABLED'], ['not_supported', 'CLOUD_BOARD_UNSUPPORTED'], ['offline', 'CLOUD_BOARD_OFFLINE'],
]) test(`${reason} blocks target discovery with a distinct error`, async () => {
  const { broker, calls } = fixture({ ...supported, supported: false, available: false, reason, profiles: [] });
  await assert.rejects(broker.targets(settings, undefined, undefined, selector), error =>
    error.code === code && error.message.includes(`${selector.boardModule}@${selector.boardVersion}`));
  assert.equal(calls.length, 1);
});

test('supported boards still use normal target selection and queuing when capacity is busy', async () => {
  const { broker } = fixture({ ...supported, available: false, reason: 'busy' });
  assert.equal((await broker.targets(settings, undefined, undefined, selector)).profiles.length, 1);
});

for (const response of [
  { ...supported, boardVersion: '3.2.0' }, { ...supported, boardModule: '@aily-project/board-other' },
  { ...supported, supported: 'true' }, { ...supported, available: undefined },
]) test(`rejects malformed or mismatched support response: ${JSON.stringify(response)}`, async () => {
  const { broker, calls } = fixture(response);
  await assert.rejects(broker.targets(settings, undefined, undefined, selector), { code: 'PROTOCOL_UNSUPPORTED' });
  assert.equal(calls.length, 1);
});

test('support is checked again on refresh, including when capabilities are cached', async () => {
  const response = { ...supported };
  const { broker, calls } = fixture(response);
  await broker.targets(settings, undefined, undefined, selector);
  Object.assign(response, { supported: false, available: false, reason: 'not_enabled' });
  await assert.rejects(broker.targets(settings, undefined, undefined, selector), { code: 'CLOUD_BOARD_NOT_ENABLED' });
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/board-support')).length, 2);
});

test('support HTTP failures are preserved instead of assuming board support', async () => {
  const broker = new CloudBuildBroker({ fetch: async () => Response.json(
    { error: { code: 'not_found', message: 'Endpoint not found' } }, { status: 404 }) });
  await assert.rejects(broker.targets(settings, undefined, undefined, selector), { code: 'not_found', httpStatus: 404 });
});

test('cancelling the support check prevents target lookup', async () => {
  const controller = new AbortController();
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const broker = new CloudBuildBroker({ fetch: async (_url, options) => {
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const result = assert.rejects(broker.targets(settings, controller.signal, undefined, selector), { code: 'CANCELLED' });
  await pending;
  controller.abort(protocol.error('CANCELLED', 'cancelled'));
  await result;
});

for (const action of ['compile', 'analysis']) test(`${action} checks disk board identity before capturing or uploading source`, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-board-support-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, 'node_modules', selector.boardModule);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify({ name: selector.boardModule, version: selector.boardVersion }));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), '{}');
  const { broker, calls } = fixture({ ...supported, supported: false, available: false, reason: 'not_enabled' });
  const events = [];
  await assert.rejects(broker.run({}, {
    requestId: action, action, settings, profileDigest: 'b'.repeat(64),
    config: { currentProjectPath: root, boardModule: selector.boardModule, boardVersion: 'stale-version' },
  }, event => events.push(event)), { code: 'CLOUD_BOARD_NOT_ENABLED' });
  assert.equal(calls.find(call => call.url.pathname.endsWith('/board-support')).url.searchParams.get('boardVersion'), '3.2.1');
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.ok(events.every(event => event.stage === 'preparing'));
  assert.equal(broker.requests.size, 0);
});
