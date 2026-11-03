'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { holdPublication } = require('./subapp-publication-lock.cjs');
const repo = path.resolve(__dirname, '../../..');
const output = process.env.AILY_PUBLICATION_OUTPUT;
const resultRoot = path.join(repo, 'e2e/test-results/subapp-publication');
if (!output || !path.resolve(output).startsWith(resultRoot + path.sep)) throw new Error('Isolated acceptance output required');
app.setPath('userData', path.join(output, 'profile'));
const { portableSubappTarball } = require(path.join(repo, 'tests/electron/fixtures/npm-tarball-fixture'));
const { registerSubappManagerHandlers } = require(path.join(repo, 'electron/subapp-manager'));
const ID = 'aily-chat', PACKAGE = '@aily-project/subapp-aily-chat';
let version = '1.0.0', window, server, lock, offline = false, downloads = 0;
const archives = new Map();

app.whenReady().then(async () => {
  server = http.createServer((request, response) => {
    if (!archives.has(version)) archives.set(version, portableSubappTarball({ packageName: PACKAGE, version, id: ID }));
    const archive = archives.get(version);
    if (request.url.endsWith('.tgz')) {
      downloads++;
      if (offline) { response.writeHead(503); response.end('Fixture offline'); return; }
      response.writeHead(200, { 'content-length': archive.length, 'content-type': 'application/octet-stream' });
      response.end(archive); return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ [ID]: { id: ID, package: PACKAGE, version, namespace: 'AILY_CHAT',
      titleKey: 'AILY_CHAT.NAME', app: { name: 'Aily Chat', enabled: true },
      dist: { tarball: `http://127.0.0.1:${server.address().port}/package.tgz`,
        integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const indexUrl = () => `http://127.0.0.1:${server.address().port}/index-${version}.json`;
  registerSubappManagerHandlers(() => window, { getIndexUrl: indexUrl,
    listChildToolHoldersForCatalogId: async () => [], forceStopChildToolByCatalogId: async () => ({ success: true }) });
  globalThis.publicationAcceptance = {
    indexUrl,
    arm(next, mode = null) { lock?.stop(); lock = mode ? holdPublication(mode) : null; version = next; offline = false; },
    unlock() { lock?.release(); },
    stats: () => ({ version, offline, downloads, ...lock?.stats() }),
    offline() { offline = true; },
    async execute(config) {
      const entry = path.join(config.packagePath, config.entry);
      const result = await promisify(execFile)(process.execPath,
        ['-e', 'process.stdout.write(require(process.argv[1]))', entry],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000 });
      return result.stdout;
    },
  };
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(repo, 'electron/preload.js'),
    sandbox: false, contextIsolation: true, backgroundThrottling: false } });
  await window.loadFile(path.join(output, 'index.html'));
}).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => { lock?.stop(); server?.close(); });
app.on('window-all-closed', () => app.quit());
