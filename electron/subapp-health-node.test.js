'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Observe actual OS children without replacing their ready/shutdown protocol.
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = (executable, args, options) => {
  const child = originalSpawn(executable, args, options);
  const record = { executable, args, child };
  record.closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  children.push(record);
  return child;
};
let health;
try { health = require('./subapp-manager'); }
finally { childProcess.spawn = originalSpawn; }

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'subapp-health-node-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^subapp-health-node-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const bundledNode = root => process.platform === 'win32'
  ? path.join(root, 'node', 'node.exe') : path.join(root, 'node', 'bin', 'node');
function executableDeclaration(root, directory = false) {
  const file = bundledNode(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (directory) fs.mkdirSync(file); else fs.writeFileSync(file, 'path-selection fixture, never executed');
  return file;
}
function fixture(t, fatal = false) {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'health-fixture', version: '1.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(root, 'main.cjs'), fatal ? `
process.stdout.write(JSON.stringify({ event: 'fatal', data: { message: 'fixture-fatal' } }) + '\\n');
process.exitCode = 1; if (process.connected) process.disconnect();
` : `
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
fs.writeFileSync(path.join(__dirname, 'identity.json'), JSON.stringify({ pid: process.pid, execPath: process.execPath,
  node: process.versions.node, electron: process.versions.electron || null, runAsNode: process.env.ELECTRON_RUN_AS_NODE || null }));
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/shutdown') { response.writeHead(404); response.end(); return; }
  fs.writeFileSync(path.join(__dirname, 'shutdown.json'), JSON.stringify({ method: request.method, origin: request.headers.origin }));
  response.writeHead(200, { Connection: 'close' }); response.end('ok');
  server.close(() => { if (process.connected) process.disconnect(); });
});
server.listen(0, '127.0.0.1', () => { const origin = 'http://127.0.0.1:' + server.address().port;
  process.stdout.write(JSON.stringify({ event: 'ready', data: { origin, shutdownUrl: origin + '/shutdown' } }) + '\\n'); });
`);
  return { root, input: { packagePath: root, entry: { id: 'health-fixture', package: 'health-fixture' }, phase: 'candidate',
    startupTimeoutMs: 3000, shutdownTimeoutMs: 3000,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: root, USERPROFILE: root } } };
}
async function actualClose(record) {
  let timer;
  try { return await Promise.race([record.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Actual health ChildProcess close missing')), 3000); })]); }
  finally { clearTimeout(timer); }
}

test('registered health selects the original bundled Node authority as an absolute regular file', t => {
  const root = temporary(t), file = executableDeclaration(root);
  assert.equal(health.resolveSubappHealthNodeExecutable(root), fs.realpathSync(file));
});
test('missing bundled Node fails closed instead of using ambient PATH node', t => {
  assert.throws(() => health.resolveSubappHealthNodeExecutable(temporary(t)), /Bundled Node is required/);
});
test('a directory cannot become the health executable', t => {
  const root = temporary(t); executableDeclaration(root, true);
  assert.throws(() => health.resolveSubappHealthNodeExecutable(root), /not a regular file/);
});
test('explicit Node identity runs the real ready and HTTP shutdown protocol and closes normally', async t => {
  const { root, input } = fixture(t), executable = process.execPath.replaceAll('\\', '/'), before = children.length;
  const result = await health.verifyInstalledSubappStartup({ ...input, execPath: executable });
  const record = children[before], identity = JSON.parse(fs.readFileSync(path.join(root, 'identity.json')));
  assert.equal(record.executable, executable); assert.equal(result.status, 'ready');
  assert.equal(identity.pid, record.child.pid); assert.equal(identity.electron, null); assert.equal(identity.runAsNode, null);
  assert.equal(fs.realpathSync(identity.execPath), fs.realpathSync(process.execPath));
  const shutdown = JSON.parse(fs.readFileSync(path.join(root, 'shutdown.json')));
  assert.equal(shutdown.method, 'POST'); assert.match(shutdown.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const close = await actualClose(record);
  t.diagnostic(JSON.stringify({ kind: 'explicit-health-node', identity, observedChildProcessClose: close, shutdown }));
  assert.deepEqual(close, { code: 0, signal: null });
});
test('standalone Node callers retain the original process.execPath default', async t => {
  const { input } = fixture(t), before = children.length;
  assert.equal((await health.verifyInstalledSubappStartup(input)).status, 'ready');
  assert.equal(children[before].executable, process.execPath);
  const close = await actualClose(children[before]);
  t.diagnostic(JSON.stringify({ kind: 'default-health-node', pid: children[before].child.pid, executable: children[before].executable, observedChildProcessClose: close }));
  assert.deepEqual(close, { code: 0, signal: null });
});
test('a real fatal startup is rejected and never becomes an admitted healthy package', async t => {
  const { input } = fixture(t, true), before = children.length;
  await assert.rejects(health.verifyInstalledSubappStartup({ ...input, execPath: process.execPath }), /fixture-fatal/);
  const close = await actualClose(children[before]);
  t.diagnostic(JSON.stringify({ kind: 'fatal-health-node', pid: children[before].child.pid, observedChildProcessClose: close }));
  assert.ok(close.code !== 0 || close.signal !== null);
});
