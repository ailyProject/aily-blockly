const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { downloadFileWithProgress, runNpm } = require('../../electron/subapp-manager');

async function serverFixture(t, handler) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-network-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, file: path.join(root, 'package.tgz'), url: `http://127.0.0.1:${server.address().port}/package` };
}

for (const phase of ['headers', 'body']) {
  test(`download times out on stalled ${phase}, closes the connection and removes partial output`, { timeout: 5000 }, async t => {
    let closed;
    const disconnected = new Promise(resolve => { closed = resolve; });
    const f = await serverFixture(t, (request, response) => {
      request.on('close', closed);
      if (phase === 'body') { response.writeHead(200, { 'content-length': 1000 }); response.write('partial'); }
    });
    await assert.rejects(downloadFileWithProgress(f.url, f.file, null, { downloadIdleTimeoutMs: 100, downloadTimeoutMs: 2000 }),
      { code: 'SUBAPP_DOWNLOAD_IDLE_TIMEOUT' });
    await disconnected;
    assert.equal(fs.existsSync(f.file), false);
  });
}

test('a slow trickle cannot evade the total download deadline', { timeout: 5000 }, async t => {
  const f = await serverFixture(t, (_request, response) => {
    response.writeHead(200);
    const timer = setInterval(() => response.write('x'), 20);
    response.on('close', () => clearInterval(timer));
  });
  await assert.rejects(downloadFileWithProgress(f.url, f.file, null, { downloadIdleTimeoutMs: 1000, downloadTimeoutMs: 120 }),
    { code: 'SUBAPP_DOWNLOAD_TIMEOUT' });
  assert.equal(fs.existsSync(f.file), false);
});

test('explicit cancellation closes a stalled transfer and retry downloads the complete package', { timeout: 5000 }, async t => {
  const controller = new AbortController();
  let retry = false;
  const f = await serverFixture(t, (_request, response) => {
    if (retry) return response.end('complete');
    response.writeHead(200); response.write('partial');
    controller.abort(Object.assign(new Error('cancel for uninstall'), { code: 'SUBAPP_CANCELLED' }));
  });
  await assert.rejects(downloadFileWithProgress(f.url, f.file, null, { signal: controller.signal }), { code: 'SUBAPP_CANCELLED' });
  assert.equal(fs.existsSync(f.file), false);
  retry = true;
  await downloadFileWithProgress(f.url, f.file);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'complete');
});

test('redirects share one deadline and HTTP failures never leave a package', { timeout: 5000 }, async t => {
  const f = await serverFixture(t, (request, response) => {
    if (request.url === '/error') { response.writeHead(503); return response.end(); }
    response.writeHead(302, { location: '/package' }); response.end();
  });
  await assert.rejects(downloadFileWithProgress(f.url, f.file, null, { maxRedirects: 2 }), /Too many redirects/);
  await assert.rejects(downloadFileWithProgress(f.url.replace('/package', '/error'), f.file), /HTTP 503/);
  assert.equal(fs.existsSync(f.file), false);
});

for (const cancel of [false, true]) {
  test(`npm ${cancel ? 'cancellation' : 'deadline'} terminates its real process before returning`, { timeout: 10000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily npm timeout '));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cli = path.join(root, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(path.join(root, 'node', 'npm.cmd'), '');
    const pidFile = path.join(root, 'pid');
    fs.writeFileSync(cli, `require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    // Exercise the shipped Windows direct npm-cli.js launch path on every OS.
    const promise = runNpm([pidFile], { platform: 'win32', env: { AILY_CHILD_PATH: root },
      npmTimeoutMs: cancel ? 5000 : 1000, signal: controller.signal });
    const assertion = assert.rejects(promise, { code: cancel ? 'SUBAPP_CANCELLED' : 'SUBAPP_NPM_TIMEOUT' });
    if (cancel) {
      const deadline = Date.now() + 4000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(fs.existsSync(pidFile));
      controller.abort(Object.assign(new Error('cancel'), { code: 'SUBAPP_CANCELLED' }));
    }
    await assertion;
    const pid = Number(fs.readFileSync(pidFile));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}
