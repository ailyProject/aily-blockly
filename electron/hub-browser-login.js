const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { getProductAuthConfig } = require('./build-product');
const { createHubConsentPresenter } = require('./hub-consent-window');

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
  if (url.username || url.password || url.port || url.hash || [...url.searchParams.keys()].length !== keys.length
    || keys.some(key => url.searchParams.getAll(key).length !== 1)
    || !opaque.test(url.searchParams.get('state')) || !opaque.test(url.searchParams.get('code_challenge'))) throw new Error('Invalid Hub login');
  const callback = new URL(url.searchParams.get('redirect_uri'));
  const production = callback.protocol === 'https:' && !callback.port && ['hub.aily.pro', 'projects.aily.pro'].includes(callback.hostname);
  const local = development && callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname);
  if ((!production && !local) || callback.username || callback.password || callback.pathname !== '/auth/callback'
    || callback.search || callback.hash) throw new Error('Untrusted Hub callback');
  return Object.fromEntries(keys.map(key => [key, url.searchParams.get(key)]));
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
  parseHubBrowserLogin(value, product, options.development);
  for (const owner of owners(product, options.directory).slice(0, 8)) {
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

function createHubBrowserBridge({ window, ipcMain, WebContentsView, consentPresenter, product, development = false, directory = registryDirectory() }) {
  const contents = window.webContents;
  const consent = consentPresenter || createHubConsentPresenter({ window, WebContentsView, ipcMain });
  const suffix = randomBytes(12).toString('hex');
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\aily-hub-${product}-${suffix}` : path.join(os.tmpdir(), `ahl-${suffix}`);
  const filename = path.join(directory, `${product}-${process.pid}-${suffix}.json`);
  const seen = new Map(); let active = null, rendererReady = false, delivering = false, confirming = false, closed = false;
  const ownFrame = event => !window.isDestroyed() && event.sender === contents && event.senderFrame === event.sender.mainFrame;
  const activate = () => {
    if (closed) return;
    try { fs.writeFileSync(filename, JSON.stringify({ product, pid: process.pid, pipe, focusedAt: Date.now() }), { mode: 0o600 }); } catch {}
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
      if (['light', 'dark'].includes(input.theme)) consent.setTheme?.(input.theme);
      const approved = await consent.confirm({ account: input.account,
        origin: new URL(current.redirect_uri).origin, expiresAt: current.expiresAt });
      return approved === true && active === current && current.expiresAt > Date.now() && ownFrame(event);
    } finally { confirming = false; }
  });
  ipcMain.handle('hub-client-finish', (event, state) => {
    if (!ownFrame(event) || active?.state !== state) return false;
    consent.cancel();
    active = null; delivering = false; return true;
  });
  return { ready, accept, close() {
    if (closed) return; closed = true;
    consent.cancel();
    window.removeListener('focus', activate); contents.removeListener('did-start-navigation', resetRenderer);
    for (const name of ['hub-client-ready', 'hub-client-theme', 'hub-client-confirm', 'hub-client-finish']) ipcMain.removeHandler(name);
    try { fs.unlinkSync(filename); } catch {}
    if (server.listening) server.close();
  } };
}

module.exports = { isHubBrowserLogin, parseHubBrowserLogin, forwardHubBrowserLogin, createHubBrowserBridge,
  hasHubBrowserOwner: (product, options = {}) => owners(product, options.directory).length > 0 };
