'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { CloudBuildBroker } = require('../../electron/cloud-build/broker');
const { registerCloudBuildHandlers } = require('../../electron/cloud-build/ipc');

const apiServer = 'https://api.aily.pro';
const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const token = (id = userId, label = 'initial', role = 'user') => `e30.${Buffer.from(JSON.stringify({ sub: JSON.stringify({ id, user_type: role }), jti: label })).toString('base64url')}.fixture`;
const account = (extra = {}) => ({ ok: true, authenticated: true, accessToken: token(), apiServer, generation: 1, ...extra });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

test('deployment follows the API region and keeps the signing key pinned', async t => {
  const names = ['AILY_API_SERVER', 'AILY_CLOUD_BUILD_GATEWAY_URL', 'AILY_CLOUD_BUILD_PUBLIC_KEY'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => saved[index] === undefined ? delete process.env[name] : process.env[name] = saved[index]));
  names.forEach(name => delete process.env[name]);
  const broker = new CloudBuildBroker();
  const initial = await broker.configuration();
  assert.equal(initial.gatewayUrl, apiServer);
  assert.match(initial.publicKey, /BEGIN PUBLIC KEY/);
  process.env.AILY_API_SERVER = 'https://api.yiyu.pro';
  assert.deepEqual(await broker.configuration(), { ...initial, gatewayUrl: 'https://api.yiyu.pro' });
  process.env.AILY_CLOUD_BUILD_GATEWAY_URL = 'http://127.0.0.1:4318';
  assert.equal((await broker.configuration()).publicKey, undefined);
});

test('JSON and artifact requests use the user credential and preserve artifact verification', async () => {
  const calls = [], bytes = Buffer.from('verified firmware');
  const broker = new CloudBuildBroker({ getAuth: async () => account(), fetch: async (url, options) => {
    calls.push({ url: String(url), ...options });
    return String(url).includes('/artifacts/') ? new Response(bytes) : json({ profiles: [] });
  } });
  const settings = { gatewayUrl: apiServer };
  await broker.request(settings, '/api/v1/build/targets');
  const artifact = { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const record = { settings, controller: new AbortController() };
  assert.deepEqual(await broker.downloadArtifact(record, artifact, new URL('/api/v1/build/artifacts/job/file', apiServer), new AbortController().signal), bytes);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, `Bearer ${token()}`);
    assert.equal(call.headers['X-User-Id'], undefined);
    assert.equal(call.redirect, 'error');
  }
  await assert.rejects(broker.downloadArtifact(record, { ...artifact, sha256: '0'.repeat(64) }, new URL('/api/v1/build/artifacts/job/file', apiServer), new AbortController().signal), { code: 'ARTIFACT_INVALID' });
});

test('401 refreshes through the host once for the same user even when the role changes', async () => {
  const authRequests = [], tokens = [];
  const broker = new CloudBuildBroker({ getAuth: async request => {
    authRequests.push(request);
    return account(request.operation === 'refresh-access-token' ? { accessToken: token(userId, 'refreshed', 'admin'), generation: 2 } : {});
  }, fetch: async (_url, options) => {
    tokens.push(options.headers.Authorization);
    return tokens.length === 1 ? json({ errorCode: 'AUTH_TOKEN_INVALID' }, 401) : json({ profiles: [] });
  } });
  await broker.request({ gatewayUrl: apiServer }, '/api/v1/build/targets');
  assert.deepEqual(tokens, [`Bearer ${token()}`, `Bearer ${token(userId, 'refreshed', 'admin')}`]);
  assert.deepEqual(authRequests, [{ operation: 'access-token' }, { operation: 'refresh-access-token', rejectedGeneration: 1 }]);
  broker.fetch = async () => json({ errorCode: 'AUTH_TOKEN_INVALID', errorMessage: 'Invalid session' }, 401);
  authRequests.length = 0;
  await assert.rejects(broker.request({ gatewayUrl: apiServer }, '/api/v1/build/targets'), { code: 'AUTH_TOKEN_INVALID', httpStatus: 401 });
  assert.equal(authRequests.length, 2);
});

test('explicit loopback builder override skips host credentials for JSON and artifacts without refreshing', async t => {
  const names = ['AILY_API_SERVER', 'AILY_CLOUD_BUILD_GATEWAY_URL'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => saved[index] === undefined ? delete process.env[name] : process.env[name] = saved[index]));
  process.env.AILY_API_SERVER = apiServer;
  process.env.AILY_CLOUD_BUILD_GATEWAY_URL = 'http://127.0.0.1:4318';
  const calls = [], bytes = Buffer.from('local firmware');
  const broker = new CloudBuildBroker({ getAuth: async () => { assert.fail('Local builder must not read host credentials.'); },
    fetch: async (url, options) => {
      calls.push(options);
      return String(url).includes('/artifacts/') ? new Response(bytes) : json({ profiles: [] });
    } });
  const settings = await broker.configuration();
  await broker.request(settings, '/api/v1/build/targets');
  const record = { settings, controller: new AbortController() };
  await broker.downloadArtifact(record, { sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    new URL('/api/v1/build/artifacts/job/file', settings.gatewayUrl), record.controller.signal);
  broker.fetch = async (_url, options) => { calls.push(options); return json({ error: { code: 'unauthorized', message: 'Rejected' } }, 401); };
  await assert.rejects(broker.request(settings, '/api/v1/build/targets'), { code: 'unauthorized', httpStatus: 401 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !call.headers.Authorization && !call.headers['X-User-Id']));
});

test('loopback Aily API keeps user authentication when it is the selected API origin', async t => {
  const names = ['AILY_API_SERVER', 'AILY_CLOUD_BUILD_GATEWAY_URL'];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => saved[index] === undefined ? delete process.env[name] : process.env[name] = saved[index]));
  const localApi = 'http://127.0.0.1:8080';
  process.env.AILY_API_SERVER = process.env.AILY_CLOUD_BUILD_GATEWAY_URL = localApi;
  let credentials = 0;
  const broker = new CloudBuildBroker({ getAuth: async () => { credentials++; return account({ apiServer: localApi }); },
    fetch: async (_url, options) => { assert.equal(options.headers.Authorization, `Bearer ${token()}`); return json({ profiles: [] }); } });
  await broker.request(await broker.configuration(), '/api/v1/build/targets');
  assert.equal(credentials, 1);
});

test('account switches, logout, and foreign origins never send a new user credential to an old task', async () => {
  let current = account(), calls = 0;
  const broker = new CloudBuildBroker({ getAuth: async () => current, fetch: async () => { calls++; return json({}); } });
  const settings = { gatewayUrl: apiServer };
  await broker.request(settings, '/api/v1/build/jobs/job');
  current = account({ userId, accessToken: token('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') });
  await assert.rejects(broker.request(settings, '/api/v1/build/jobs/job'), { code: 'AUTH_ACCOUNT_CHANGED' });
  await assert.rejects(broker.request({ gatewayUrl: 'https://untrusted.invalid' }, '/api/v1/build/targets'), { code: 'GATEWAY_UNTRUSTED' });
  current = { ok: false, errorCode: 'AUTH_SIGNED_OUT' };
  await assert.rejects(broker.request({ gatewayUrl: apiServer }, '/api/v1/build/targets'), { code: 'AUTH_SIGNED_OUT' });
  assert.equal(calls, 1);
});

test('Gateway Pro and availability errors retain their error envelopes without refreshing', async () => {
  let reads = 0;
  for (const [status, code] of [[403, 'AUTH_PRO_REQUIRED'], [503, 'AUTH_SERVICE_UNAVAILABLE']]) {
    const broker = new CloudBuildBroker({ getAuth: async () => { reads++; return account(); }, fetch: async () => json({ errorCode: code, errorMessage: 'Gateway rejected this request' }, status) });
    await assert.rejects(broker.request({ gatewayUrl: apiServer }, '/api/v1/build/targets'), { code, httpStatus: status, message: 'Gateway rejected this request' });
  }
  assert.equal(reads, 2);
});

test('IPC uses the current deployment instead of an old or renderer-supplied gateway', async t => {
  const previousFetch = global.fetch, calls = [], handlers = new Map(), frame = {};
  global.fetch = async url => { calls.push(String(url)); return json({ profiles: [] }); };
  t.after(() => { global.fetch = previousFetch; });
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const controller = registerCloudBuildHandlers({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getOwner: () => ({ generation: 1 }), getGatewaySettings: () => ({ gatewayUrl: 'http://127.0.0.1:4318' }) });
  t.after(() => controller.shutdown());
  const result = await handlers.get('cloud-build')({ sender, senderFrame: frame }, { action: 'targets', settings: { gatewayUrl: 'https://old-origin.invalid' } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['http://127.0.0.1:4318/api/v1/build/targets']);
});

function hostBridge() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/app/services/core/auth/bridges/aily-chat-host-auth-runtime-bridge.ts'), 'utf8');
  const record = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', compiled)(() => ({ getServerUrl: () => apiServer }), record.exports);
  return record.exports;
}

test('cloud IPC reuses the host credential handler and permits same-user credential refresh', async () => {
  const { registerAilyChatHostAuthRuntimeBridge, createAilyHostAuthRequestHandler } = hostBridge();
  const listeners = new Map(), replies = [];
  let generation = 1;
  const auth = { hasLocalAuthSession: true, isSessionInvalidating: false, currentUser: { id: userId },
    getToken2: async () => 'host-token', getAuthCredentialGeneration: () => generation, refreshAuthToken: async () => true };
  const cleanup = registerAilyChatHostAuthRuntimeBridge(auth, { on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); }, send: (channel, message) => replies.push({ channel, ...message }) });
  listeners.get('cloud-build-auth-query')({}, { operation: 'access-token', requestId: 'auth-request', rendererGeneration: 7 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].channel, 'cloud-build-auth-query:response');
  assert.equal(replies[0].requestId, 'auth-request');
  assert.equal(replies[0].rendererGeneration, 7);
  assert.equal(replies[0].result.accessToken, 'host-token');
  cleanup();
  assert.equal(listeners.size, 0);
  auth.getToken2 = async () => { generation++; return 'refreshed'; };
  const refreshed = await createAilyHostAuthRequestHandler(auth)({ operation: 'access-token' });
  assert.equal(refreshed.accessToken, 'refreshed');
  assert.equal(refreshed.generation, 2);
});
