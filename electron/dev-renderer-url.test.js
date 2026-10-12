const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDevRendererUrl } = require('./dev-renderer-url');

test('defaults to the existing development renderer origin and hash routes', () => {
  for (const hash of [undefined, null, '']) {
    assert.equal(resolveDevRendererUrl(hash), 'http://localhost:4200');
  }
  assert.equal(resolveDevRendererUrl('#/main'), 'http://localhost:4200/#/main');
  assert.equal(resolveDevRendererUrl('/main?tab=simulator'), 'http://localhost:4200/#/main?tab=simulator');
});

test('accepts only explicit HTTP loopback origins with valid optional ports', () => {
  for (const origin of [
    'http://localhost:4201',
    'http://127.0.0.1:4201',
    'http://[::1]:4201',
    'http://localhost',
    'http://127.0.0.1:1',
    'http://[::1]:65535',
  ]) {
    assert.equal(resolveDevRendererUrl('', origin), origin);
    assert.equal(resolveDevRendererUrl('#/main', origin), `${origin}/#/main`);
  }
});

test('preserves the existing hash length and control-character validation', () => {
  assert.equal(resolveDevRendererUrl('x'.repeat(16 * 1024)).length, 'http://localhost:4200/#'.length + 16 * 1024);
  for (const hash of [42, {}, [], 'x'.repeat(16 * 1024 + 1), '#/main\n', '#/main\0', '#/main\x7f']) {
    assert.throws(() => resolveDevRendererUrl(hash), /Renderer hash is invalid/);
  }
});

test('rejects remote hosts, non-HTTP, credentials, paths, query, fragment and invalid ports', () => {
  for (const origin of [
    '', null, 4201, {},
    'http://example.com:4201',
    'http://192.168.1.2:4201',
    'http://localhost.example.com:4201',
    'http://127.0.0.2:4201',
    'https://localhost:4201',
    'file:///renderer/index.html',
    'http://user:password@localhost:4201',
    'http://@localhost:4201',
    'http://localhost:4201/',
    'http://localhost:4201/main',
    'http://localhost:4201/../',
    'http://localhost:4201?route=main',
    'http://localhost:4201#main',
    ' http://localhost:4201',
    'http://localhost:4201\n',
    'http://localhost:',
    'http://localhost:0',
    'http://localhost:-1',
    'http://localhost:65536',
    'http://localhost:4201.0',
  ]) {
    assert.throws(() => resolveDevRendererUrl('', origin), /HTTP loopback origin/);
  }
});
