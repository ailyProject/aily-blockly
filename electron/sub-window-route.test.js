'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveDevRendererUrl } = require('./dev-renderer-url');
const { buildSubWindowRouteUrl } = require('./sub-window-route');

test('inherits the Main-selected development origin for child window routes', () => {
  const calls = [];
  const resolveRendererUrl = hash => {
    calls.push(hash);
    return resolveDevRendererUrl(hash, 'http://localhost:4201');
  };

  assert.equal(
    buildSubWindowRouteUrl('/child-tool/fixture?view=detail', resolveRendererUrl),
    'http://localhost:4201/#/child-tool/fixture?view=detail',
  );
  assert.deepEqual(calls, ['#/child-tool/fixture?view=detail']);
});

test('keeps the existing default development origin as a Main resolver choice', () => {
  for (const route of ['settings', '/settings', '///settings', ' settings ']) {
    assert.equal(
      buildSubWindowRouteUrl(route, hash => resolveDevRendererUrl(hash)),
      'http://localhost:4200/#/settings',
    );
  }
});

test('uses the injected packaged renderer resolver without a development branch', () => {
  const calls = [];
  const resolveRendererUrl = hash => {
    calls.push(hash);
    return `http://127.0.0.1:31842/${hash}`;
  };

  assert.equal(
    buildSubWindowRouteUrl('/child-tool/fixture', resolveRendererUrl),
    'http://127.0.0.1:31842/#/child-tool/fixture',
  );
  assert.deepEqual(calls, ['#/child-tool/fixture']);
});

test('refuses a missing renderer resolver instead of guessing a fallback origin', () => {
  for (const resolver of [undefined, null, 42, {}, 'http://localhost:4200']) {
    assert.throws(
      () => buildSubWindowRouteUrl('/settings', resolver),
      /renderer URL resolver.*unavailable/i,
    );
  }
});

test('preserves the Main resolver hash and selected-origin validation', () => {
  const resolveRendererUrl = hash => resolveDevRendererUrl(hash, 'http://localhost:4201');
  const largestRoute = 'x'.repeat(16 * 1024 - 2);
  assert.equal(
    buildSubWindowRouteUrl(largestRoute, resolveRendererUrl),
    `http://localhost:4201/#/${largestRoute}`,
  );

  for (const route of ['child-tool/fix\nture', 'child-tool/fix\0ture', 'child-tool/fix\x7fture', 'x'.repeat(16 * 1024 - 1)]) {
    assert.throws(() => buildSubWindowRouteUrl(route, resolveRendererUrl), /Renderer hash is invalid/);
  }
  assert.throws(
    () => buildSubWindowRouteUrl('/settings', hash => resolveDevRendererUrl(hash, 'https://localhost:4201')),
    /HTTP loopback origin/,
  );
});

test('the actual window route delegates to the shared resolver without the old dev bypass', () => {
  const source = fs.readFileSync(path.join(__dirname, 'window.js'), 'utf8');
  assert.equal(
    /buildSubWindowRouteUrl\(routePath,\s*resolveRendererUrl\)/.test(source),
    true,
    'actual child window route must use the injected Main renderer resolver',
  );
  assert.equal(
    /\b(?:buildDevSubWindowRouteUrl|isDevServeSubWindow)\b/.test(source),
    false,
    'actual child window route must not retain the old dev-origin bypass',
  );
});
