const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const ts = require('typescript');
const rxjs = require('rxjs');
let protocol;
test.before(async () => {protocol = await import('@aily-project/simulator-protocol/entitlement');});

// Execute the actual product AccountService and CallbackAuthority. Only Angular
// construction, Auth/HTTP/browser event providers are controlled in this Node
// process. These are structural public-envelope fixtures, never verified grants;
// no actual login change, credential, network, signature verifier, MCU or UI.
const integration = path.resolve(__dirname, '../src/app/integrations/simulator');
function load(name, API) {
  const filename = path.join(integration, name + '.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {fileName: filename, reportDiagnostics: true,
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: false, useDefineForClassFields: false}});
  assert.equal((compiled.diagnostics ?? []).length, 0);
  const loaded = new Module(filename); loaded.filename = filename;
  loaded.require = dependency => {
    if (dependency === '@angular/core') return {Injectable: () => value => value};
    if (dependency === '@angular/common/http') return {};
    if (dependency === 'rxjs') return rxjs;
    if (dependency === '@aily-project/simulator-protocol/entitlement') return protocol;
    if (dependency === '../../configs/api.config') return {API};
    if (dependency === '@core/auth/public-api') return {};
    throw Error('Unbound account test dependency: ' + dependency);
  };
  loaded._compile(compiled.outputText, filename); return loaded.exports;
}
const leaseRequest = {requestId: 'controlled-account-request', product: 'aily-simulator', currentLeaseId: null, forceRefresh: true};
function publicResponse(name) {
  const envelope = kind => ({schemaVersion: 1, kind, algorithm: 'Ed25519', keyId: `fixture-${name}`,
    payloadBase64Url: 'a'.repeat(32), signatureBase64Url: 'b'.repeat(86)});
  return {status: 200, data: {lease: envelope('aily-simulator-entitlement-lease'), revocations: envelope('aily-simulator-entitlement-revocations')}};
}
function fixture(t) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowEvents = new EventTarget();
  Object.defineProperty(globalThis, 'window', {configurable: true, value: windowEvents});
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: true}});
  let state = 'authenticated', loggedIn = true, generation = 1;
  const auth = {authInitializationState$: new rxjs.BehaviorSubject(state), isLoggedIn$: new rxjs.BehaviorSubject(loggedIn),
    getAuthInitializationState: () => state, getAuthCredentialGeneration: () => generation,
    get isLoggedIn() {return loggedIn;}};
  const requests = [], API = {simulatorEntitlementLease: '/controlled-account-lease'};
  const http = {post(endpoint, body) {
    const response = new rxjs.Subject(); requests.push({endpoint, body, response}); return response.asObservable();
  }};
  const {SimulatorEntitlementAccountService} = load('simulator-entitlement-account.service', API);
  const {SimulatorEntitlementCallbackAuthority} = load('simulator-entitlement-callback-authority', API);
  const service = new SimulatorEntitlementAccountService(auth, http), authority = new SimulatorEntitlementCallbackAuthority({account: service, now: () => 1_800_000_000_000});
  t.after(() => {
    authority.close(); for (const request of requests) request.response.complete();
    auth.authInitializationState$.complete(); auth.isLoggedIn$.complete();
    for (const [key, descriptor] of [['window', oldWindow], ['navigator', oldNavigator]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return {service, authority, requests, API, auth,
    changeAccount({nextState = 'authenticated', nextLoggedIn = true} = {}) {
      generation++; state = nextState; loggedIn = nextLoggedIn;
      auth.authInitializationState$.next(state); auth.isLoggedIn$.next(loggedIn);
    },
    deliver(index, name) {requests[index].response.next(publicResponse(name)); requests[index].response.complete();},
    request(signal = new AbortController().signal) {return authority.callbacks.requestLease(leaseRequest, signal);}};
}
const denied = (decision, reason = 'sign-in-required') => {
  assert.equal(decision.disposition, 'unavailable'); assert.equal(decision.unavailableReason, reason);
  assert.equal(decision.lease, null); assert.equal(decision.revocations, null);
};

test('current account structural public delivery crosses the real account/authority path without credentials', async t => {
  const f = fixture(t), pending = f.request(); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].body, {product: 'aily-simulator', currentLeaseId: null});
  f.deliver(0, 'current'); const result = await pending;
  assert.equal(result.disposition, 'granted'); assert.equal(result.lease.keyId, 'fixture-current');
  assert.equal(Object.keys(result).sort().join(','), 'disposition,lease,revocations,unavailableReason');
});

test('authenticated account generation change rejects original late delivery even when state remains authenticated', async t => {
  const f = fixture(t), pending = f.request();
  f.changeAccount(); f.deliver(0, 'old-account'); denied(await pending);
  assert.equal(f.service.readSnapshot().state, 'authenticated');
});

test('a fresh account request can complete before the old late response without adopting the old subject delivery', async t => {
  const f = fixture(t), old = f.request(); f.changeAccount(); const fresh = f.request();
  f.deliver(1, 'new-account'); const result = await fresh;
  assert.equal(result.disposition, 'granted'); assert.equal(result.lease.keyId, 'fixture-new-account');
  f.deliver(0, 'old-account'); denied(await old);
  const next = f.request(); f.deliver(2, 'new-account-again');
  assert.equal((await next).lease.keyId, 'fixture-new-account-again');
});

test('sign-out and entitlement endpoint change fence their original pending responses', async t => {
  const f = fixture(t), original = f.request();
  f.changeAccount({nextState: 'signed_out', nextLoggedIn: false}); f.deliver(0, 'signed-out-late'); denied(await original);
  denied(await f.request()); assert.equal(f.requests.length, 1, 'Signed-out request never reaches HTTP.');
  f.changeAccount(); const changedEndpoint = f.request(); f.API.simulatorEntitlementLease = '/controlled-new-endpoint';
  f.deliver(1, 'old-endpoint'); denied(await changedEndpoint);
});

test('an aborted original account HTTP wait rejects and cannot deliver a later provider response', async t => {
  const f = fixture(t), controller = new AbortController(), pending = f.request(controller.signal);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  controller.abort(); await rejected; f.deliver(0, 'aborted-late');
  assert.equal(f.requests[0].response.observers.length, 0);
});

test('closing the real callback authority rejects an account result returned late without reissuing HTTP', async t => {
  const f = fixture(t), pending = f.request(); const rejected = assert.rejects(pending, /callback authority is closed/u);
  f.authority.close(); f.deliver(0, 'closed-late'); await rejected;
  assert.throws(() => f.request(), /callback authority is closed/u); assert.equal(f.requests.length, 1);
});

test('real product account subscriptions stop publishing after authority close and release their source listeners', async t => {
  const f = fixture(t), rows = [], controller = new AbortController();
  const subscription = f.authority.callbacks.subscribeStatus({afterSequence: 0}, row => rows.push(row), controller.signal);
  assert.equal(subscription.status.accountState, 'ready');
  f.changeAccount({nextState: 'signed_out', nextLoggedIn: false}); assert.equal(rows.length, 1);
  assert.equal(rows[0].accountState, 'sign-in-required');
  f.authority.close(); f.changeAccount(); assert.equal(rows.length, 1);
  assert.equal(f.auth.authInitializationState$.observers.length, 0); assert.equal(f.auth.isLoggedIn$.observers.length, 0);
  subscription.close(); controller.abort();
});
