'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const { registerCloudBuildHandlers } = require('../../electron/cloud-build/ipc');
const protocol = require('../../electron/cloud-build/protocol');

const settings = { gatewayUrl: 'http://localhost:4318' };
const selector = { boardModule: '@aily-project/board-esp32s3dev', boardVersion: '3.2.1', boardDigest: 'a'.repeat(64) };
const buildSelector = { ...selector, forBuild: true };
const supported = { boardModule: selector.boardModule, boardVersion: selector.boardVersion, supported: true, available: true };

function fixture(response = supported, { capabilities = {}, profiles } = {}) {
  const calls = [];
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const broker = new CloudBuildBroker({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.pathname.endsWith('/board-support')) return Response.json(response);
    if (url.pathname.endsWith('/capabilities')) return Response.json({ protocolVersion: 1, publicKey: key, targetLookupByBoard: true, ...capabilities });
    if (url.pathname.endsWith('/targets')) return Response.json({ profiles: profiles ?? [
      { ...selector, profileDigest: 'b'.repeat(64), runner: 'aily-builder', capabilities: { compile: true, analysis: true } },
      { ...selector, boardDigest: 'c'.repeat(64) },
    ] });
    throw new Error(`Unexpected request: ${url}`);
  } });
  return { broker, calls };
}

test('exact build misses recover the board-specific reason, and legacy admission still requires module support', async () => {
  const offline = { ...supported, supported: false, available: false, reason: 'offline' };
  const owner = { sender: {}, generation: 1 };
  const modern = { targetSelection: { version: 1, policy: 'priority-idle-v1', maxCandidates: 64 } };
  for (const profiles of [[], [{ ...selector, profileDigest: 'b'.repeat(64), runner: 'aily-builder', capabilities: { analysis: true } }]]) {
    const { broker, calls } = fixture(offline, { capabilities: modern, profiles });
    await assert.rejects(broker.targets(settings, undefined, undefined, buildSelector, owner), { code: 'CLOUD_BOARD_OFFLINE' });
    assert.deepEqual(calls.map(call => call.url.pathname), ['/api/v1/build/capabilities', '/api/v1/build/targets', '/api/v1/build/board-support']);
    assert.equal(broker.buildCatalogs.size, 0);
  }
  const { broker, calls } = fixture(offline);
  await assert.rejects(broker.targets(settings, undefined, undefined, buildSelector, owner), { code: 'CLOUD_BOARD_OFFLINE' });
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api/v1/build/capabilities', '/api/v1/build/board-support']);
});

test('build catalog tickets are scoped to window generation, account, gateway, signing key and exact board', async t => {
  const { broker } = fixture();
  const sender = {}, owner = { sender, generation: 1 };
  const deployment = { gatewayUrl: 'https://api.aily.pro', publicKey: 'key-a' };
  let user = 'first';
  broker.getAuth = async () => ({
    ok: true, authenticated: true, apiServer: deployment.gatewayUrl,
    accessToken: 'e30.' + Buffer.from(JSON.stringify({ sub: { id: user } })).toString('base64url') + '.test',
  });
  const issue = async () => (await broker.targets({ ...deployment }, undefined, undefined, buildSelector, owner)).catalogTicket;
  const consume = async (ticket, overrides = {}, board = selector, targetSettings = deployment) => {
    const currentSettings = { ...targetSettings };
    await broker.authorization(currentSettings);
    return broker.consumeBuildCatalog(ticket, { ...owner, settings: currentSettings, ...overrides }, board);
  };
  t.after(() => broker.invalidateAll());
  const valid = await issue();
  assert.equal(typeof valid, 'string');
  assert.equal(await consume(valid, { sender: {} }), undefined);
  assert.equal(await consume(valid, { generation: 2 }), undefined);
  assert.equal((await consume(valid)).profiles.length, 1);
  assert.equal(await consume(valid), undefined);

  const otherUser = await issue();
  user = 'second';
  assert.equal(await consume(otherUser), undefined);
  assert.equal(await consume(await issue(), {}, { ...selector, boardDigest: 'c'.repeat(64) }), undefined);
  assert.equal(await consume(await issue(), {}, selector, { ...deployment, publicKey: 'key-b' }), undefined);
  assert.equal(await consume(await issue(), {}, selector, { ...deployment, gatewayUrl: deployment.gatewayUrl + '/other' }), undefined);
  const rotated = await issue();
  await broker.invalidateOwner(sender, 1);
  assert.equal(await consume(rotated), undefined);
});

test('only fresh complete bounded discoveries are reusable', async t => {
  const { broker } = fixture(), sender = {}, owner = { sender, generation: 1 };
  t.after(() => broker.invalidateAll());
  const issue = async () => (await broker.targets(settings, undefined, undefined, buildSelector, owner)).catalogTicket;
  assert.equal((await broker.targets(settings, undefined, undefined, selector)).catalogTicket, undefined);
  assert.equal((await broker.targets(settings, undefined, 'b'.repeat(64), selector, owner)).catalogTicket, undefined);
  assert.equal(broker.consumeBuildCatalog(await issue(), { ...owner, settings }, selector, 'analysis'), undefined);
  const first = await issue();
  for (let i = 0; i < 4; i++) await issue();
  const consume = ticket => broker.consumeBuildCatalog(ticket, { ...owner, settings }, selector);
  assert.equal(consume(first), undefined);
  assert.equal(broker.buildCatalogs.size, 4);
  const last = await issue();
  const expiresAt = broker.buildCatalogs.get(last).expiresAt;
  t.mock.method(Date, 'now', () => expiresAt);
  assert.equal(consume(last), undefined);
});

test('warm compile uses live candidate membership and priority, and fetches changed or incomplete directories once', async t => {
  const alpha = 'a'.repeat(64), beta = 'b'.repeat(64), gamma = 'c'.repeat(64);
  const profile = digest => ({ ...selector, profileDigest: digest, runner: 'aily-builder',
    capabilities: { compile: true, analysis: true }, metadata: { defaults: { label: digest[0] } } });
  const live = (profileDigest, priority) => ({ profileDigest, availability: { priority, idleNodes: 1, freeSlots: 1, onlineNodes: 1 } });
  const profiles = [profile(alpha), profile(beta)];
  const support = { ...supported, boardDigest: selector.boardDigest, profiles: [live(alpha, 0), live(beta, 50)] };
  const { broker, calls } = fixture(support, { profiles, capabilities: {
    targetSelection: { version: 1, policy: 'priority-idle-v1', maxCandidates: 64 },
  } });
  t.after(() => broker.invalidateAll());
  const owner = { sender: {}, generation: 1 };
  await broker.targets(settings, undefined, undefined, selector, owner); // Existing menu read warms the complete directory.
  const read = (action = 'compile') => {
    calls.length = 0;
    return broker.targets(settings, undefined, undefined, { ...buildSelector, compileAction: action }, owner);
  };
  const endpoints = () => calls.map(call => call.url.pathname.split('/').pop());
  support.profiles = [live(beta, 5)];
  const warm = await read();
  assert.deepEqual(endpoints(), ['board-support']);
  assert.equal(calls[0].url.searchParams.get('boardDigest'), selector.boardDigest);
  assert.deepEqual(warm.profiles.map(row => [row.profileDigest, row.availability.priority, row.metadata.defaults.label]), [[beta, 5, 'b']]);
  support.profiles = [live(alpha, 75), live(beta, 0)];
  assert.deepEqual((await read()).profiles.map(row => row.availability.priority), [75, 0]);
  assert.deepEqual(endpoints(), ['board-support']);
  profiles.push(profile(gamma));
  support.profiles.push(live(gamma, 0));
  assert.equal((await read()).profiles.length, 3);
  assert.deepEqual(endpoints(), ['board-support', 'targets']);
  delete support.profiles[0].availability.idleNodes;
  await read();
  assert.deepEqual(endpoints(), ['board-support', 'targets']);
  await read('analysis');
  assert.deepEqual(endpoints(), ['targets']);
  Object.assign(support, { supported: false, available: false, reason: 'identity_mismatch', profiles: [] });
  await assert.rejects(read(), { code: 'CLOUD_TARGET_UNAVAILABLE' });
  assert.deepEqual(endpoints(), ['board-support']);
  support.reason = 'offline';
  await assert.rejects(read(), { code: 'CLOUD_BOARD_OFFLINE' });
  assert.deepEqual(endpoints(), ['board-support']);
});

test('IPC hands one build its discovery and repeats live discovery on ticket replay', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-board-ticket-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: selector.boardModule, version: selector.boardVersion };
  const board = { ...selector, boardDigest: protocol.boardDigest(pkg, {}) };
  const boardRoot = path.join(root, 'node_modules', board.boardModule);
  fs.mkdirSync(boardRoot, { recursive: true });
  fs.writeFileSync(path.join(boardRoot, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(boardRoot, 'board.json'), '{}');
  const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(url.pathname);
    if (url.pathname.endsWith('/board-support')) return Response.json({ ...supported, boardDigest: url.searchParams.get('boardDigest'),
      profiles: [{ profileDigest: 'b'.repeat(64), availability: { onlineNodes: 1, freeSlots: 1, idleNodes: 1, priority: 25 } }] });
    if (url.pathname.endsWith('/capabilities')) return Response.json({ protocolVersion: 1, publicKey: key, targetLookupByBoard: true,
      targetSelection: { version: 1, policy: 'priority-idle-v1', maxCandidates: 64 } });
    if (url.pathname.endsWith('/targets')) return Response.json({ profiles: [{
      ...board, runner: 'aily-builder', profileDigest: 'b'.repeat(64), capabilities: { compile: true },
    }] });
    assert.fail('Unexpected endpoint ' + url.pathname);
  });
  const handlers = new Map(), sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} });
  const ipc = registerCloudBuildHandlers({ ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    getRegion: () => 'cn', buildFlavor: 'cn', backend: 'cloud', getOwner: () => ({ generation: 1 }),
    getGatewaySettings: () => settings, getRuntimeRoot: () => root });
  t.after(() => ipc.shutdown());
  const dispatch = data => handlers.get('cloud-build')({ sender, senderFrame: sender.mainFrame }, data);
  const menu = await dispatch({ action: 'targets', ...board });
  assert.equal(menu.ok, true);
  assert.equal(menu.result.catalogTicket, undefined);
  paths.length = 0;
  const prepared = await dispatch({ action: 'targets', ...board, forBuild: true });
  assert.equal(prepared.ok, true);
  assert.deepEqual(paths, ['/api/v1/build/board-support']);
  const catalogTicket = prepared.result.catalogTicket;
  assert.equal(typeof catalogTicket, 'string');
  const compile = requestId => dispatch({ action: 'compile', requestId, catalogTicket,
    // Discovery must succeed; deliberately invalid code stops these requests at source capture.
    config: { currentProjectPath: root, boardModule: board.boardModule }, profileDigest: 'b'.repeat(64) });
  paths.length = 0;
  assert.equal((await compile('compile-1')).error.message, 'Invalid project source.');
  assert.deepEqual(paths, ['/api/v1/build/capabilities']);
  paths.length = 0;
  assert.equal((await compile('compile-2')).error.message, 'Invalid project source.');
  assert.deepEqual(paths.sort(), ['/api/v1/build/board-support', '/api/v1/build/capabilities', '/api/v1/build/targets']);
});

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
