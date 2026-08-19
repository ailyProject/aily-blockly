'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyRegistration } = require('./child-tool-session-leases');

test('registers when no shared child Runtime exists', () => {
  assert.equal(classifyRegistration(null, 'candidate', false), 'register');
});

test('keeps the existing registration for the same process stream', () => {
  assert.equal(classifyRegistration({ streamId: 'current' }, 'current', true), 'same-stream');
});

test('reuses a healthy shared Runtime instead of killing it during a concurrent start', () => {
  assert.equal(classifyRegistration({ streamId: 'winner' }, 'candidate', true), 'reuse-existing');
});

test('replaces only a stale shared Runtime', () => {
  assert.equal(classifyRegistration({ streamId: 'stale' }, 'candidate', false), 'replace-stale');
});
