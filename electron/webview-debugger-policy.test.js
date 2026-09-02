'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isAllowedWebviewDebuggerUrl,
} = require('./webview-debugger-policy');

test('accepts only bounded debugger navigation targets', () => {
  assert.equal(isAllowedWebviewDebuggerUrl('about:blank'), true);
  assert.equal(isAllowedWebviewDebuggerUrl('https://example.com/path'), true);
  assert.equal(isAllowedWebviewDebuggerUrl('http://127.0.0.1:4200'), true);
  assert.equal(isAllowedWebviewDebuggerUrl('file:///tmp/private.txt'), false);
  assert.equal(isAllowedWebviewDebuggerUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedWebviewDebuggerUrl('https://user:secret@example.com'), false);
});
