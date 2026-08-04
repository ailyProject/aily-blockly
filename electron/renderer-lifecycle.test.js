const assert = require('node:assert/strict');
const test = require('node:test');

const {
  shouldBeginRendererGeneration,
} = require('./renderer-lifecycle');

test('starts a renderer generation for a new main-frame document', () => {
  assert.equal(shouldBeginRendererGeneration({
    isMainFrame: true,
    isSameDocument: false,
  }), true);
});

test('keeps the renderer ready across same-document main-frame navigation', () => {
  assert.equal(shouldBeginRendererGeneration({
    isMainFrame: true,
    isSameDocument: true,
  }), false);
});

test('keeps the renderer ready while a child frame navigates', () => {
  assert.equal(shouldBeginRendererGeneration({
    isMainFrame: false,
    isSameDocument: false,
  }), false);
});

test('does not invalidate readiness for malformed navigation details', () => {
  assert.equal(shouldBeginRendererGeneration(), false);
  assert.equal(shouldBeginRendererGeneration({}), false);
});
