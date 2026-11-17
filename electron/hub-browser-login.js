const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { getProductAuthConfig } = require('./build-product');
const { createHubConsentPresenter } = require('./hub-consent-window');
const { createBrowserReturn } = require('./browser-return');

const opaque = /^[A-Za-z0-9_-]{43}$/;
const registryDirectory = () => path.join(os.tmpdir(), `aily-hub-login-${process.getuid?.() ?? os.userInfo().username}`);

function isHubBrowserLogin(value, product) {
  try {
    const url = new URL(value);
    return getProductAuthConfig(product).protocols.includes(url.protocol.slice(0, -1))
      && url.hostname === 'auth' && url.pathname === '/hub/login';
  } catch { return false; }
}

function parseHubBrowserLogin(value, product, development = false) {
  if (typeof value !== 'string' || value.length > 4096 || !isHubBrowserLogin(value, product)) throw new Error('Invalid Hub login');
  const url = new URL(value), keys = ['state', 'code_challenge', 'redirect_uri'];
  for (const key of ['region', 'authorization_redirect_uri']) if (url.searchParams.has(key)) keys.push(key);
  if (url.searchParams.has('receipt_uri') || url.searchParams.has('receipt_token')) keys.push('receipt_uri', 'receipt_token');
  if (url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].length !== keys.length
    || keys.some(key => url.searchParams.getAll(key).length !== 1)
    || !opaque.test(url.searchParams.get('state')) || !opaque.test(url.searchParams.get('code_challenge'))) throw new Error('Invalid Hub login');
  if (url.searchParams.has('region') && !['cn', 'intl'].includes(url.searchParams.get('region'))) throw new Error('Invalid Hub site');
  const validateCallback = value => {
    const callback = new URL(value);
    const production = callback.protocol === 'https:' && !callback.port && ['hub.aily.pro', 'projects.aily.pro'].includes(callback.hostname);
    const local = development && callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname);
    if ((!production && !local) || callback.username || callback.password || callback.pathname !== '/auth/callback'
      || callback.search || callback.hash) throw new Error('Untrusted Hub callback');
  };
  validateCallback(url.searchParams.get('redirect_uri'));
  if (url.searchParams.has('authorization_redirect_uri')) validateCallback(url.searchParams.get('authorization_redirect_uri'));
  if (url.searchParams.has('receipt_uri')) {
    const receipt = new URL(url.searchParams.get('receipt_uri'));
    const callback = new URL(url.searchParams.get('redirect_uri'));
    const trusted = receipt.protocol === 'https:' && !receipt.port
      && (['hubapi.aily.pro', 'hub.aily.pro', 'projects.aily.pro'].includes(receipt.hostname) || receipt.origin === callback.origin);
    const local = development && receipt.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(receipt.hostname);
    if ((!trusted && !local) || receipt.username || receipt.password || receipt.search || receipt.hash
      || receipt.pathname !== '/api/v1/hub/auth/desktop/browser/result' || !opaque.test(url.searchParams.get('receipt_token'))) throw new Error('Untrusted Hub receipt');
  }
  return Object.fromEntries(keys.map(key => [key, url.searchParams.get(key)]));
}

async function deliverHubBrowserResult(request, callbackUrl, fetcher = fetch) {
  if (!request.receipt_uri || !request.receipt_token) return false;
  const callback = new URL(callbackUrl);
  if (callback.origin !== new URL(request.redirect_uri).origin || callback.pathname !== '/auth/desktop'
    || callback.username || callback.password || callback.hash || callback.searchParams.get('state') !== request.state) return false;
  let failures = 0;
  while (Date.now() < request.expiresAt) {
    try {
      const response = await fetcher(request.receipt_uri, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(7000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: request.state,
          receiptToken: request.receipt_token, callbackUrl: callback.href }) });
      const result = await response.json();
      if (!response.ok || result?.status !== 200) throw new Error('Receipt service unavailable');
      if (result.data?.delivery === 'tab') return true;
      if (result.data?.delivery === 'fallback') return false;
      if (result.data?.delivery !== 'waiting') throw new Error('Invalid receipt response');
      failures = 0;
    } catch {
      // An acknowledgment may have succeeded before its response was lost.
      // Only an explicit fallback claim permits opening a second browser tab.
      if (++failures >= 3) return true;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return true;
}

function owners(product, directory = registryDirectory()) {
  try {
    return fs.readdirSync(directory).filter(name => name.startsWith(product + '-') && name.endsWith('.json')).flatMap(name => {
      try {
        const filename = path.join(directory, name), stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) return [];
        const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (record.product !== product || !Number.isInteger(record.pid) || typeof record.pipe !== 'string' || !Number.isFinite(record.focusedAt)) return [];
        process.kill(record.pid, 0);
        return [record];
      } catch { return []; }
    }).sort((a, b) => b.focusedAt - a.focusedAt);
  } catch { return []; }
}

async function forwardHubBrowserLogin(value, product, options = {}) {
  const request = parseHubBrowserLogin(value, product, options.development);
  const candidates = owners(product, options.directory).filter(owner => !request.receipt_uri || owner.protocolVersion >= 2);
  for (const owner of candidates.slice(0, 8)) {
    const accepted = await new Promise(resolve => {
      const socket = net.createConnection(owner.pipe); let reply = '', settled = false;
      const finish = result => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
      socket.on('error', () => finish('unavailable')); socket.setTimeout(1500, () => finish('unavailable'));
      socket.once('connect', () => socket.write(value + '\n'));
      socket.on('data', chunk => { reply += chunk.toString(); if (reply.length > 16) finish('invalid'); });
      socket.once('end', () => finish(reply.trim()));
    });
    if (accepted === 'ok') return;
    if (accepted !== 'unavailable') throw new Error('Hub client busy or request invalid');
  }
  throw new Error('Hub client unavailable');
}

function createHubBrowserBridge({ window, ipcMain, BrowserWindow, consentPresenter, browserReturn = createBrowserReturn(), product, development = false, directory = registryDirectory(), deliverResult = deliverHubBrowserResult }) {
  const contents = window.webContents;
  const consent = consentPresenter || createHubConsentPresenter({ window, BrowserWindow, ipcMain });
  const suffix = randomBytes(12).toString('hex');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\aily-hub-${product}-${suffix}` : path.join(os.tmpdir(), `ahl-${suffix}`);
  const filename = path.join(directory, `${product}-${process.pid}-${suffix}.json`);
  const seen = new Map(); let active = null, rendererReady = false, delivering = false, confirming = false, closed = false;
  let browserTarget = null;
  const ownFrame = event => !window.isDestroyed() && event.sender === contents && event.senderFrame === event.sender.mainFrame;
  const activate = () => {
    if (closed) return;
    try { fs.writeFileSync(filename, JSON.stringify({ product, protocolVersion: 2, pid: process.pid, pipe, focusedAt: Date.now() }), { mode: 0o600 }); } catch {}
  };
  const deliver = () => {
    if (!active || !rendererReady || delivering || window.isDestroyed()) return;
    delivering = true;
    contents.send('hub-client-authorize', active);
  };
  const accept = value => {
    const request = parseHubBrowserLogin(value, product, development), now = Date.now();
    for (const [state, expires] of seen) if (expires <= now) seen.delete(state);
    if (active?.expiresAt <= now) { consent.cancel(); active = null; delivering = false; }
    if (active || seen.has(request.state) || seen.size >= 128) return false;
    seen.set(request.state, now + 120000); active = { ...request, expiresAt: now + 120000 };
    // Capture before showing consent, and keep native handles out of renderer IPC.
    try { browserTarget = Promise.resolve(browserReturn.capture()).catch(() => null); } catch { browserTarget = Promise.resolve(null); }
    deliver(); return true;
  };
  const server = net.createServer(socket => {
    let input = '', handled = false;
    socket.on('error', () => {}); socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk.toString();
      if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      try { socket.end(accept(input.slice(0, input.indexOf('\n'))) ? 'ok\n' : 'busy\n'); }
      catch { socket.end('invalid\n'); }
    });
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) { reject(new Error('Invalid Hub registry')); return; }
    server.listen(pipe, () => {
      if (closed) { server.close(); resolve(); return; }
      if (process.platform !== 'win32') fs.chmodSync(pipe, 0o600);
      activate(); resolve();
    });
  });
  server.on('error', () => {});
  window.on('focus', activate);
  const resetRenderer = (_event, _url, isInPlace, isMainFrame) => {
    // Angular hash routing keeps the same initialized document and IPC listener.
    if (isMainFrame && !isInPlace) { rendererReady = false; if (delivering) { consent.cancel(); active = null; } delivering = false; }
  };
  contents.on('did-start-navigation', resetRenderer);
  ipcMain.handle('hub-client-ready', event => { if (!ownFrame(event)) return false; rendererReady = true; deliver(); return true; });
  ipcMain.handle('hub-client-theme', (event, theme) => {
    if (!ownFrame(event) || !['light', 'dark'].includes(theme)) return false;
    consent.setTheme?.(theme); return true;
  });
  ipcMain.handle('hub-client-confirm', async (event, input) => {
    if (!ownFrame(event) || !active || confirming || input?.state !== active.state
      || typeof input.account !== 'string' || !input.account.trim() || input.account.length > 512) return false;
    confirming = true; const current = active;
    try {
      await browserTarget;
      if (active !== current || closed) return false;
      if (['light', 'dark'].includes(input.theme)) consent.setTheme?.(input.theme);
      const approved = await consent.confirm({ account: input.account,
        origin: new URL(current.redirect_uri).origin, region: current.region, expiresAt: current.expiresAt });
      return approved === true && active === current && current.expiresAt > Date.now() && ownFrame(event);
    } finally { confirming = false; }
  });
  ipcMain.handle('hub-client-finish', (event, state) => {
    if (!ownFrame(event) || active?.state !== state) return false;
    consent.cancel();
    active = null; browserTarget = null; delivering = false; return true;
  });
  ipcMain.handle('hub-client-deliver', async (event, state, callbackUrl) => {
    if (!ownFrame(event) || active?.state !== state || typeof callbackUrl !== 'string' || callbackUrl.length > 4096) return false;
    const current = active, target = browserTarget;
    try {
      const delivered = await deliverResult(current, callbackUrl);
      if (delivered) {
        const captured = await target;
        if (active === current && !closed) {
          try { await browserReturn.restore(captured); } catch { /* Focus failure must not reopen a tab. */ }
        }
      }
      return delivered;
    } catch { return false; }
  });
  return { ready, accept, close() {
    if (closed) return; closed = true;
    consent.cancel();
    browserTarget = null;
    browserReturn.close();
    window.removeListener('focus', activate); contents.removeListener('did-start-navigation', resetRenderer);
    for (const name of ['hub-client-ready', 'hub-client-theme', 'hub-client-confirm', 'hub-client-finish', 'hub-client-deliver']) ipcMain.removeHandler(name);
    try { fs.unlinkSync(filename); } catch {}
    if (server.listening) server.close();
  } };
}

module.exports = { isHubBrowserLogin, parseHubBrowserLogin, forwardHubBrowserLogin, createHubBrowserBridge, deliverHubBrowserResult,
  hasHubBrowserOwner: (product, options = {}) => owners(product, options.directory)
    .some(owner => !options.receipts || owner.protocolVersion >= 2) };
