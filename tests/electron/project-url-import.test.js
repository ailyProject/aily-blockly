const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseProjectImportUrl, importProjectUrl } = require('../../electron/project-url-import');

const sevenZipPath = process.env.AILY_7ZA_PATH;
const needs7z = { skip: !sevenZipPath };
const packageUrl = 'https://downloads.example/project.7z?token=a%2Bb&name=A%20B&part=x%26y';
const hubShapedUrl = 'https://api.yiyu.pro/api/v1/hub/snapshots/12345678-1234-1234-1234-123456789abc/download';

function fixture(t, product = 'blockly') {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'project-url-import-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('project-url-import-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const manifest = JSON.stringify({ name: 'download-fixture', type: product, cloudId: 'source-cloud-project',
    ...(product === 'coder' ? { entry: 'main.cpp' } : {}) });
  fs.writeFileSync(path.join(source, 'package.json'), manifest);
  if (product === 'coder') {
    fs.mkdirSync(path.join(source, 'sketch'));
    fs.writeFileSync(path.join(source, 'sketch', 'main.cpp'), 'void setup() {}');
  } else fs.writeFileSync(path.join(source, 'project.abi'), '{"blocks":{"blocks":[]}}');
  const archivePath = path.join(root, 'source.7z');
  execFileSync(sevenZipPath, ['a', '-t7z', archivePath, '.'], { cwd: source, windowsHide: true, stdio: 'ignore' });
  const bytes = fs.readFileSync(archivePath);
  const projectRoot = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectRoot, 'existing'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'existing', 'keep'), 'existing project');
  return { root, source, manifest, archivePath, bytes,
    options: { url: packageUrl, product, sevenZipPath, projectRoot, tempRoot: root } };
}

function assertPreserved(f, installed = false) {
  assert.equal(fs.readFileSync(path.join(f.source, 'package.json'), 'utf8'), f.manifest);
  assert.deepEqual(fs.readFileSync(f.archivePath), f.bytes);
  assert.equal(fs.readFileSync(path.join(f.options.projectRoot, 'existing', 'keep'), 'utf8'), 'existing project');
  if (!installed) assert.deepEqual(fs.readdirSync(f.options.projectRoot), ['existing']);
  assert.deepEqual(fs.readdirSync(f.root).filter(name => /^aily-(url|project)-import-/.test(name)), []);
}

function assertAnonymous(options) {
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'manual');
  assert.equal(new Headers(options.headers).has('Authorization'), false);
  assert.equal(new Headers(options.headers).has('Cookie'), false);
}

test('both products and aliases accept one full URL and decode its query exactly once', () => {
  for (const [product, schemes] of [['blockly', ['abis', 'ailyblockly']], ['coder', ['acis', 'ailycoder']]]) {
    for (const scheme of schemes) {
      assert.equal(parseProjectImportUrl(`${scheme}://project/import?url=${encodeURIComponent(packageUrl)}`, product), packageUrl);
    }
  }
});

test('rejects unsupported URLs, credentials, duplicate parameters and snapshotId protocol input', () => {
  const entry = value => `abis://project/import?url=${encodeURIComponent(value)}`;
  for (const value of ['file:///project.7z', 'javascript:alert(1)', 'http://downloads.example/project.7z',
    'https://user:password@downloads.example/project.7z', 'https://downloads.example/project.7z#fragment']) {
    assert.throws(() => parseProjectImportUrl(entry(value), 'blockly'));
  }
  for (const value of [`${entry(packageUrl)}&url=${encodeURIComponent(packageUrl)}`, `${entry(packageUrl)}&snapshotId=id`,
    'abis://project/import', 'abis://hub/import?snapshotId=id', entry(packageUrl).replace('abis:', 'acis:')]) {
    assert.throws(() => parseProjectImportUrl(value, 'blockly'));
  }
});

test('HTTPS packages including Hub-shaped URLs import anonymously in either editor and detach source cloud ownership', needs7z, async t => {
  let current;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, current.options.url);
    assertAnonymous(options);
    return new Response(current.bytes);
  });
  for (const product of ['blockly', 'coder']) {
    current = fixture(t, product);
    if (product === 'coder') current.options.url = hubShapedUrl;
    const result = await importProjectUrl(current.options);
    assert.equal(path.dirname(result), current.options.projectRoot);
    assert.match(path.basename(result), /^Import_[a-f0-9]{8}$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(result, 'package.json'), 'utf8'));
    assert.equal(manifest.type, product);
    assert.equal(manifest.cloudId, undefined);
    assert.equal(manifest.hubSnapshotId, undefined);
    assert.equal(fs.existsSync(path.join(result, product === 'coder' ? 'sketch/main.cpp' : 'project.abi')), true);
    assertPreserved(current, true);
  }
});

test('short import names skip existing targets and repeated imports preserve local changes', needs7z, async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(f.bytes));
  const existsSync = fs.existsSync;
  let collision;
  t.mock.method(fs, 'existsSync', target => {
    if (!collision && path.dirname(target) === f.options.projectRoot && /^Import_[a-f0-9]{8}$/.test(path.basename(target))) {
      collision = target;
      fs.mkdirSync(collision);
      fs.writeFileSync(path.join(collision, 'keep'), 'existing short-name project');
    }
    return existsSync(target);
  });
  const first = await importProjectUrl(f.options);
  assert.ok(collision);
  fs.writeFileSync(path.join(first, 'project.abi'), '{"localChanges":true}');
  const second = await importProjectUrl(f.options);
  for (const result of [first, second]) assert.match(path.basename(result), /^Import_[a-f0-9]{8}$/);
  assert.notEqual(first, second);
  assert.notEqual(first, collision);
  assert.notEqual(second, collision);
  assert.equal(fs.readFileSync(path.join(first, 'project.abi'), 'utf8'), '{"localChanges":true}');
  assert.equal(fs.readFileSync(path.join(second, 'project.abi'), 'utf8'), '{"blocks":{"blocks":[]}}');
  assert.deepEqual(fs.readdirSync(collision), ['keep']);
  assert.equal(fs.readFileSync(path.join(collision, 'keep'), 'utf8'), 'existing short-name project');
  assertPreserved(f, true);
});

test('cross-origin redirects stay anonymous without metadata requests', needs7z, async t => {
  const f = fixture(t);
  const visited = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assertAnonymous(options);
    visited.push(url.href);
    if (visited.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/project.7z' } });
    if (visited.length === 2) return new Response(null, { status: 307, headers: { location: 'https://storage.example/project.7z' } });
    return new Response(f.bytes);
  });
  const result = await importProjectUrl(f.options);
  assert.deepEqual(visited, [packageUrl, 'https://cdn.example/project.7z', 'https://storage.example/project.7z']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result, 'package.json'), 'utf8')).hubSnapshotId, undefined);
  assertPreserved(f, true);
});

test('loopback HTTP downloads need no API configuration', needs7z, async t => {
  const f = fixture(t);
  const local = 'http://127.0.0.1:31879/project.7z';
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.href, local);
    assertAnonymous(options);
    return new Response(f.bytes);
  });
  await importProjectUrl({ ...f.options, url: local });
  assert.equal(fetchMock.mock.callCount(), 1);
  assertPreserved(f, true);
});

test('allows five redirects and rejects a sixth or HTTPS downgrade without installing', needs7z, async t => {
  const f = fixture(t);
  let calls = 0;
  let scenario = 'too-many';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assertAnonymous(options);
    calls++;
    if (scenario === 'downgrade') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:31879/project.7z' } });
    if (scenario === 'five' && calls === 6) return new Response(f.bytes);
    return new Response(null, { status: 302, headers: { location: `/redirect-${calls}.7z` } });
  });
  await assert.rejects(importProjectUrl(f.options), /重定向/);
  assert.equal(calls, 6);
  assertPreserved(f);
  scenario = 'downgrade'; calls = 0;
  await assert.rejects(importProjectUrl(f.options), /HTTPS/);
  assert.equal(calls, 1);
  assertPreserved(f);
  scenario = 'five'; calls = 0;
  await importProjectUrl(f.options);
  assert.equal(calls, 6);
  assertPreserved(f, true);
});

test('declared and streamed downloads over 100 MB never install or replace an existing project', needs7z, async t => {
  const f = fixture(t);
  let streaming = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assertAnonymous(options);
    if (!streaming) return new Response(f.bytes, { headers: { 'content-length': String(100 * 1024 * 1024 + 1) } });
    let chunks = 0;
    const chunk = new Uint8Array(1024 * 1024);
    return new Response(new ReadableStream({ pull(controller) {
      if (chunks++ < 101) controller.enqueue(chunk);
      else controller.close();
    } }));
  });
  await assert.rejects(importProjectUrl(f.options), /大小.*限制/);
  assertPreserved(f);
  streaming = true;
  await assert.rejects(importProjectUrl(f.options), /大小.*限制/);
  assertPreserved(f);
});

test('failed and non-7z responses leave all existing projects and original packages intact', needs7z, async t => {
  const f = fixture(t);
  let failed = true;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assertAnonymous(options);
    if (failed) return new Response('unauthorized', { status: 401 });
    return new Response('not a 7z project');
  });
  await assert.rejects(importProjectUrl(f.options), /下载失败/);
  assertPreserved(f);
  failed = false;
  await assert.rejects(importProjectUrl(f.options), /不是 7z/);
  assertPreserved(f);
});
