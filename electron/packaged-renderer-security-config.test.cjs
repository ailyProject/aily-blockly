'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createPackagedRendererServer } = require('./packaged-renderer-server');
const { CONFIG_FILENAME, MAX_CONFIG_BYTES, loadPackagedRendererSecurityOptions } = require('./packaged-renderer-security-config');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const base = isolated => ({ schemaVersion: 1, kind: 'aily-packaged-renderer-security', crossOriginIsolated: isolated });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-renderer-security-'));
  const moduleDirectory = path.join(directory, 'electron');
  const rootDirectory = path.join(directory, 'renderer');
  fs.mkdirSync(path.join(moduleDirectory, 'resources'), { recursive: true });
  fs.mkdirSync(rootDirectory);
  const bytes = Buffer.from('<!doctype html><title>Trusted Renderer</title>');
  fs.writeFileSync(path.join(rootDirectory, 'index.html'), bytes);
  const configPath = path.join(moduleDirectory, 'resources', CONFIG_FILENAME);
  t.after(() => {
    const relative = path.relative(os.tmpdir(), directory);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true });
  });
  return { moduleDirectory, rootDirectory, configPath, bytes,
    write: value => fs.writeFileSync(configPath, JSON.stringify(value)),
    isolated: { ...base(true), index: { bytes: bytes.length, sha256: digest(bytes) } },
  };
}

function get(origin) {
  return new Promise((resolve, reject) => {
    const request = http.get(origin, { agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ headers: response.headers, status: response.statusCode,
        body: Buffer.concat(chunks), reachedEOF: true }));
      response.once('error', reject);
    });
    request.setTimeout(1500, () => request.destroy(new Error('HTTP observation timed out.')));
    request.once('error', reject);
  });
}

async function observe(options, f) {
  const server = createPackagedRendererServer(options);
  try {
    const ready = await server.start({ rootDirectory: f.rootDirectory });
    return await get(ready.origin);
  } finally {
    await server.close();
    assert.equal(server.status().state, 'stopped');
  }
}

test('unconfigured and explicit false preserve normal Main HTTP security', { timeout: 5000 }, async t => {
  const f = fixture(t);
  for (const configured of [false, true]) {
    if (configured) f.write(base(false));
    const options = loadPackagedRendererSecurityOptions(f);
    assert.deepEqual(options, {}); assert.ok(Object.isFrozen(options));
    const response = await observe(options, f);
    assert.equal(response.status, 200); assert.equal(response.reachedEOF, true);
    assert.deepEqual(response.body, f.bytes);
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-embedder-policy'], undefined);
  }
});

test('bundled exact Renderer index selects original require-corp option and retains captured selection', { timeout: 5000 }, async t => {
  const f = fixture(t); f.write(f.isolated);
  const options = loadPackagedRendererSecurityOptions(f);
  assert.deepEqual(options, { crossOriginIsolated: true }); assert.ok(Object.isFrozen(options));
  f.write(base(false));
  const response = await observe(options, f);
  assert.equal(response.status, 200); assert.equal(response.reachedEOF, true);
  assert.deepEqual(response.body, f.bytes);
  assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
});

test('malformed bundled policy and changed or foreign index fail before Main server creation', { timeout: 5000 }, t => {
  const f = fixture(t);
  for (const config of [
    { ...base(false), index: f.isolated.index },
    { ...f.isolated, url: 'https://not-a-config-source.invalid' },
    { ...f.isolated, index: { ...f.isolated.index, path: '../other/index.html' } },
    { ...base(true) }, { ...base(true), index: { bytes: 0, sha256: '0'.repeat(64) } },
    { ...f.isolated, index: { ...f.isolated.index, sha256: '0'.repeat(64) } },
    { ...f.isolated, index: { ...f.isolated.index, bytes: f.bytes.length + 1 } },
  ]) {
    f.write(config); assert.throws(() => loadPackagedRendererSecurityOptions(f));
  }
  fs.writeFileSync(f.configPath, Buffer.alloc(MAX_CONFIG_BYTES + 1));
  assert.throws(() => loadPackagedRendererSecurityOptions(f));
  f.write(f.isolated);
  fs.writeFileSync(path.join(f.rootDirectory, 'index.html'), Buffer.alloc(f.bytes.length, 120));
  assert.throws(() => loadPackagedRendererSecurityOptions(f), /SHA-256/);
  assert.throws(() => loadPackagedRendererSecurityOptions({ moduleDirectory: 'relative' }));
  const source = fs.readFileSync(path.join(__dirname, 'packaged-renderer-security-config.js'), 'utf8');
  assert.doesNotMatch(source, /process\.env|ipcMain|localStorage|userData|URLSearchParams/);
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(main, /packagedRendererServer \?\?= createPackagedRendererServer\(loadPackagedRendererSecurityOptions\(\)\)/);
  assert.match(main, /packagedRendererServer\?\.close\(\)/);
});
