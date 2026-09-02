'use strict';

const WEBVIEW_DEBUGGER_PARTITION = 'persist:aily-webview-debugger';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isAllowedWebviewDebuggerUrl(value) {
  const text = String(value || '').trim();
  if (text === 'about:blank') return true;

  try {
    const parsed = new URL(text);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

module.exports = {
  WEBVIEW_DEBUGGER_PARTITION,
  isAllowedWebviewDebuggerUrl,
};
