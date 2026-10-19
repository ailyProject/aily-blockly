const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');
const { of, Subject, throwError } = require('rxjs');
const modules = loadModules();
const request = { requestId: 'lease-request', product: 'aily-simulator', currentLeaseId: null, forceRefresh: false };

function signedEnvelope(kind, context, claims) {
  const keys = generateKeyPairSync('ed25519');
  const payloadBase64Url = Buffer.from(JSON.stringify(claims)).toString('base64url');

  return { schemaVersion: 1, kind, algorithm: 'Ed25519', keyId: 'test-key', payloadBase64Url,
    signatureBase64Url: sign(null, Buffer.from(`${context}.${payloadBase64Url}`), keys.privateKey).toString('base64url') };
}

function response() {
  const now = Date.now();

  return { status: 200, data: {
    lease: signedEnvelope('aily-simulator-entitlement-lease', 'aily-simulator-entitlement-v1', {
      schemaVersion: 1, kind: 'aily-simulator-entitlement-lease-claims', product: 'aily-simulator',
      leaseId: 'server-lease', subjectHash: 'a'.repeat(64), issuedAtUnixMs: now, notBeforeUnixMs: now,
      expiresAtUnixMs: now + 900000, offlineGraceUntilUnixMs: now + 900000, capabilities: { 'simulation.basic': true },
    }),
    revocations: signedEnvelope('aily-simulator-entitlement-revocations', 'aily-simulator-entitlement-revocations-v1', {
      schemaVersion: 1, kind: 'aily-simulator-entitlement-revocation-claims', product: 'aily-simulator',
      revision: 1, issuedAtUnixMs: now, expiresAtUnixMs: now + 3600000, revokedKeyIds: [], revokedLeaseIds: [],
    }),
  } };
}

async function fixture() {
  const { SimulatorEntitlementAccountService, SimulatorEntitlementCallbackAuthority, setServerUrl } = await modules;

  setServerUrl('https://accounts.example.test');

  let generation = 1;
  let loggedIn = true;
  let reply = of(response());
  const calls = [];

  const auth = { getAuthInitializationState: () => loggedIn ? 'authenticated' : 'signed_out',
    get isLoggedIn() { return loggedIn; }, getAuthCredentialGeneration: () => generation };

  const service = new SimulatorEntitlementAccountService(auth, {
    post(url, body) { calls.push({ url, body }); return reply; },
  });

  return { service, calls, SimulatorEntitlementCallbackAuthority,
    reply(value) { reply = value; }, switchAccount() { generation++; },
    logout() { loggedIn = false; generation++; }, setServerUrl };
}

test('account client requests a signed lease from the current region without forwarding credentials', async () => {
  const f = await fixture();
  const wire = response();

  f.reply(of(wire));

  const result = await f.service.requestLease(request, new AbortController().signal);

  assert.equal(result.disposition, 'granted');
  assert.deepEqual(result.lease, wire.data.lease);
  assert.deepEqual(result.revocations, wire.data.revocations);
  assert.deepEqual(f.calls, [{ url: 'https://accounts.example.test/api/v1/entitlements/simulator/lease',
    body: { product: 'aily-simulator', currentLeaseId: null } }]);

  f.setServerUrl('https://another-region.example.test');
  await f.service.requestLease(request, new AbortController().signal);
  assert.ok(f.calls[1].url.startsWith('https://another-region.example.test/'));
});

test('account summaries and malformed signed responses cannot create an authorization', async () => {
  const f = await fixture();

  for (const value of [{ status: 200, data: { 'simulator.enabled': true } },
    { status: 200, data: { lease: { valid: true }, revocations: {} } },
    { status: 403, data: response().data }, { status: 200, data: { ...response().data, accessToken: 'forbidden' } }]) {
    f.reply(of(value));

    const result = await f.service.requestLease(request, new AbortController().signal);

    assert.equal(result.disposition, 'unavailable');
    assert.equal(result.lease, null);
  }
});

test('signed-out accounts never request a lease, and transient errors remain unavailable', async () => {
  const f = await fixture();

  f.reply(throwError(() => new Error('network unavailable')));
  assert.equal((await f.service.requestLease(request, new AbortController().signal)).unavailableReason, 'temporarily-unavailable');
  f.logout();
  assert.equal((await f.service.requestLease(request, new AbortController().signal)).unavailableReason, 'sign-in-required');
  assert.equal(f.calls.length, 1);
});

test('in-flight account or region changes reject old signed replies without permitting cache fallback', async () => {
  for (const change of ['switchAccount', 'logout', 'region']) {
    const f = await fixture();
    const pending = new Subject();

    f.reply(pending);

    const operation = f.service.requestLease(request, new AbortController().signal);

    if (change === 'region') f.setServerUrl('https://other.example.test');
    else f[change]();

    pending.next(response());
    pending.complete();

    const result = await operation;

    assert.equal(result.unavailableReason, 'sign-in-required');
    assert.equal(result.lease, null);
  }
});

test('a failed new-account request cannot fall back to the previously delivered account lease', async () => {
  const f = await fixture();

  assert.equal((await f.service.requestLease(request, new AbortController().signal)).disposition, 'granted');
  f.switchAccount();
  f.reply(throwError(() => new Error('new account service unavailable')));
  assert.equal((await f.service.requestLease(request, new AbortController().signal)).unavailableReason, 'sign-in-required');
});

test('cancellation unsubscribes the HTTP operation and a closed authority rejects late replies', async () => {
  const f = await fixture();
  const pending = new Subject();

  f.reply(pending);

  const controller = new AbortController();
  const operation = f.service.requestLease(request, controller.signal);

  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(pending.observed, false);
  f.reply(pending);

  const authority = new f.SimulatorEntitlementCallbackAuthority({ account: f.service });
  const late = authority.callbacks.requestLease(request, new AbortController().signal);

  authority.close();
  pending.next(response());
  pending.complete();
  await assert.rejects(late, /closed/i);
});

async function loadModules() {
  const root = path.resolve(__dirname, '..');

  const built = await esbuild.build({
    stdin: { contents: `
      export { SimulatorEntitlementAccountService } from './src/app/integrations/simulator/simulator-entitlement-account.service';
      export { SimulatorEntitlementCallbackAuthority } from './src/app/integrations/simulator/simulator-entitlement-callback-authority';
      export { setServerUrl } from './src/app/configs/api.config';
    `, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['rxjs'],
    alias: { '@aily-project/simulator-protocol/entitlement':
      path.resolve(root, '../aily-simulator/packages/simulator-protocol/dist/public/entitlement.js') },
    plugins: [{ name: 'angular-service-test-boundary', setup(build) {
      build.onResolve({ filter: /^(@angular\/|@core\/auth)/ }, args => ({ path: args.path, namespace: 'test-boundary' }));

      build.onLoad({ filter: /.*/, namespace: 'test-boundary' }, () => ({
        contents: 'export const Injectable = () => value => value; export class HttpClient {} export class AuthService {}', loader: 'js',
      }));
    } }],
  });

  const loaded = { exports: {} };

  new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, loaded, loaded.exports);

  return loaded.exports;
}
