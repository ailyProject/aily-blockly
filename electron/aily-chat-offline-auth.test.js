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

const {AuthService} = load('src/app/services/core/auth/auth.service.ts');
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
