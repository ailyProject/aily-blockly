const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

function load(source, imports = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', source), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true},
  }).outputText;
  const record = {exports:{}};
  new Function('require', 'exports', 'module', compiled)(name => {
    if (name in imports) return imports[name];
    if (name === '@angular/core') return {Injectable: () => target => target};
    return {};
  }, record.exports, record);
  return record.exports;
}

const {AuthService} = load('src/app/services/core/auth/auth.service.ts', {
  './policies/detached-aily-chat-auth': {isDetachedAilyChatRenderer: () => false},
});
const {createAilyHostAuthRequestHandler} = load('src/app/services/core/auth/bridges/aily-chat-host-auth-runtime-bridge.ts');
const {UiService} = load('src/app/services/core/app-shell/ui.service.ts', {
  '@core/auth/public-api': {isAuthRequiredTool: name => ['aily-chat','cloud-space','user-center'].includes(name)},
});

function auth(state, loggedIn = false, invalidating = false) {
  const value = Object.create(AuthService.prototype);
  value.isLoggedInSubject = {value: loggedIn};
  value.authInitializationStateSubject = {value: state};
  value.authSessionInvalidating = invalidating;
  return value;
}

test('local auth availability distinguishes offline from signed out and invalidating', () => {
  for (const state of ['idle','checking','signed_out']) assert.equal(auth(state).hasLocalAuthSession, false);
  assert.equal(auth('unavailable').hasLocalAuthSession, true);
  assert.equal(auth('authenticated', true).hasLocalAuthSession, true);
  assert.equal(auth('unavailable', false, true).hasLocalAuthSession, false);
});

test('only local chat can reopen with unavailable remote auth', () => {
  const service = Object.create(UiService.prototype);
  service.authService = auth('unavailable');
  const requested = [];
  service.authService.requestLogin = reason => requested.push(reason);
  assert.equal(service.requestLoginForProtectedTool('aily-chat'), false);
  assert.equal(service.requestLoginForProtectedTool('cloud-space'), true);
  assert.equal(service.requestLoginForProtectedTool('user-center'), true);
  service.authService.authInitializationStateSubject.value = 'signed_out';
  assert.equal(service.requestLoginForProtectedTool('aily-chat'), true);
  service.authService.authInitializationStateSubject.value = 'checking';
  assert.equal(service.requestLoginForProtectedTool('aily-chat'), false);
  service.authService.authSessionInvalidating = true;
  assert.equal(service.requestLoginForProtectedTool('aily-chat'), true);
  assert.deepEqual(requested, ['tool:cloud-space','tool:user-center','tool:aily-chat','tool:aily-chat']);
});

test('offline credential leases do not repeatedly probe remote auth', async () => {
  const service = auth('unavailable');
  service.getToken2 = async () => 'test-token';
  service.getAuthCredentialGeneration = () => 7;
  service.initializeAuth = async () => { throw new Error('must not revalidate each lease'); };
  const handler = createAilyHostAuthRequestHandler(service, () => 'http://127.0.0.1:18126');
  for (let i=0;i<2;i++) assert.deepEqual(await handler({operation:'access-token'}), {
    ok:true, authenticated:true, accessToken:'test-token', apiServer:'http://127.0.0.1:18126', generation:7,
  });
  service.getToken2 = async () => null;
  assert.equal((await handler({operation:'access-token'})).errorCode, 'AUTH_CREDENTIAL_UNAVAILABLE');
  service.authSessionInvalidating = true;
  assert.equal((await handler({operation:'access-token'})).errorCode, 'AUTH_SIGNED_OUT');
});

for (const scenario of [
  {name: 'the rejected session', sent: 'old', current: 'old', code: 'AUTH_TOKEN_INVALID', invalidated: ['old']},
  {name: 'an in-flight request after shared logout', sent: 'old', current: null, code: 'AUTH_TOKEN_INVALID', invalidated: ['old']},
  {name: 'a new request after shared logout', sent: null, current: null, code: 'AUTH_TOKEN_MISSING', cleared: [null], login: true},
  {name: 'a replacement shared session', sent: 'old', current: 'new', code: 'AUTH_TOKEN_INVALID'},
]) test(`401 handling protects ${scenario.name}`, async t => {
  const rx = require('rxjs');
  class HttpErrorResponse extends Error {
    status = 401;
    error = {errorCode: scenario.code};
  }
  let current = scenario.sent;
  const invalidated = [], cleared = [], login = [];
  const service = {
    getToken2: async () => current,
    refreshAuthToken: async () => false,
    requestSessionInvalidation: (_code, _source, token) => { invalidated.push(token); return true; },
    clearLocalAuthSession: async token => { cleared.push(token); },
    getAuthInitializationState: () => 'signed_out',
    requestLogin: reason => login.push(reason),
  };
  const previousWindow = global.window;
  global.window = {};
  t.after(() => { global.window = previousWindow; });
  const {authInterceptor} = load('src/app/interceptors/auth.interceptor.ts', {
    '@angular/core': {inject: () => service},
    '@angular/common/http': {HttpErrorResponse},
    '@core/auth/public-api': {isDetachedAilyChatRenderer: () => false},
    '../configs/api.config': {API: {me: '/me'}},
    rxjs: rx,
  });
  const request = {
    url: '/me', headers: {get: () => null},
    clone: ({setHeaders}) => ({url: '/me', headers: {get: name => setHeaders[name]}}),
  };
  const response = new rx.Subject();
  const result = rx.firstValueFrom(authInterceptor(request, () => response));
  await new Promise(resolve => setImmediate(resolve));
  current = scenario.current;
  response.error(new HttpErrorResponse());
  await assert.rejects(result);
  assert.deepEqual(invalidated, scenario.invalidated || []);
  assert.deepEqual(cleared, scenario.cleared || []);
  assert.equal(login.length, scenario.login ? 1 : 0);
});

test('a rejected clear preserves the replacement session; cleanup errors still clear local UI', async t => {
  const previousWindow = global.window, previousStorage = global.localStorage;
  t.after(() => { global.window = previousWindow; global.localStorage = previousStorage; });
  t.mock.method(console, 'error', () => {});
  const expectedTokens = [];
  global.window = {electronAPI: {auth: {clear: async token => { expectedTokens.push(token); return false; }}}};
  global.localStorage = {removeItem: () => {}};
  const service = auth('authenticated', true);
  service.electronService = {isElectron: true};
  service.authCredentialGeneration = 0;
  for (const subject of [service.isLoggedInSubject, service.authInitializationStateSubject]) {
    subject.next = value => { subject.value = value; };
  }
  service.clearPendingAuthQuotaInfoSnapshotRetry = service.clearPendingAuthHydrationRetry = () => {};
  service.setCurrentUserInfo = () => {};
  let initialized = 0;
  service.initializeAuth = () => { initialized++; return new Promise(() => {}); };
  await service.clearLocalAuthSession('old');
  assert.deepEqual(expectedTokens, ['old']);
  assert.equal(service.isLoggedIn, true);
  assert.equal(initialized, 1);

  global.window.electronAPI.auth.clear = async () => { throw Object.assign(new Error('fixture denied'), {code: 'EACCES'}); };
  await service.clearAuthData();
  assert.equal(service.isLoggedIn, false);
  assert.equal(service.getAuthInitializationState(), 'signed_out');
});
