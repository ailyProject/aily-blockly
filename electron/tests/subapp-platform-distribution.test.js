const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSubappManager, validateIndex } = require('../subapp-manager');
const { selectSubappPlatformEntry, assertPackagePlatform } = require('../subapp-platform-distribution');
const { npmTarball } = require('./npm-tarball-fixture');
const id = 'native-tool';
const packageName = '@aily-project/native-tool';
const targets = [{ platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }];

function release(version) {
  const archives = new Map();

  const platforms = Object.fromEntries(targets.map(({ platform, arch }) => {
    const key = `${platform}-${arch}`;
    const tarball = `https://packages.example.test/${key}/${version}.tgz`;

    const archive = npmTarball({
      'package.json': JSON.stringify({ name: packageName, version, main: 'index.js',
        ailySubapp: { id, runtime: { headless: true } }, os: [platform], cpu: [arch],
        ailyPortable: { version: 1, platforms: [platform], architectures: [arch] } }),
      'index.js': `module.exports = ${JSON.stringify({ key, version })};\n`,
    });

    archives.set(tarball, archive);

    return [key, { dist: { tarball, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` } }];
  }));

  return { archives, entry: { id, package: packageName, version, namespace: 'NATIVE_TOOL',
    titleKey: 'NATIVE_TOOL.NAME', app: { enabled: true }, platforms } };
}

function fixture(t, target) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-platform-install-'));

  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  let current = release('1.0.0');
  const archives = new Map(current.archives);
  const downloads = [];
  let rejectStartup = false;

  const options = { rootDir, updateRootDir: path.join(rootDir, 'updates'), ...target, indexUrl: 'https://packages.example.test/index.json',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [id]: current.entry }) }),
    downloadFile: async (url, destination) => {
      downloads.push(url);

      assert.ok(archives.has(url));
      fs.writeFileSync(destination, archives.get(url));
    },
    runNpm: async () => { throw new Error('A complete native package must not run npm'); },
    verifyInstalledPackage: async ({ packagePath }) => {
      const value = JSON.parse(fs.readFileSync(path.join(packagePath, 'package.json')));

      assertPackagePlatform(value, target);

      if (rejectStartup) throw new Error('Fixture runtime failed startup');
    },
  };

  return { rootDir, options, downloads, manager: createSubappManager(options),
    setRelease(version) {
      current = release(version);

      for (const [url, archive] of current.archives) archives.set(url, archive);
    },
    failStartup() { rejectStartup = true; },
  };
}

for (const target of targets) {
  test(`${target.platform}-${target.arch}: application install, cached launch and update select the same native platform`, async t => {
    const f = fixture(t, target);
    const installed = await f.manager.install({ id });

    assert.equal(installed.apps[0].installedVersion, '1.0.0');
    assert.equal(f.downloads.length, 1);
    assert.ok(f.downloads[0].includes(`/${target.platform}-${target.arch}/`));

    const first = await f.manager.prepareLaunch({ id });

    first.release();

    const offline = createSubappManager({ ...f.options,
      fetchImpl: async () => { throw new Error('offline'); } });

    const cached = await offline.prepareLaunch({ id });

    assert.equal(cached.config.path, first.config.path);
    cached.release();
    assert.equal(f.downloads.length, 1, 'Launch must not reinstall');
    f.setRelease('1.1.0');
    await f.manager.list({ refresh: true });

    const updated = await f.manager.update({ id });

    assert.equal(updated.apps[0].installedVersion, '1.1.0');
    assert.ok(f.downloads.every(url => url.includes(`/${target.platform}-${target.arch}/`)));
    f.setRelease('1.2.0');
    f.failStartup();
    await f.manager.list({ refresh: true });
    await assert.rejects(f.manager.update({ id }), /failed startup/);

    const afterFailure = await f.manager.list({ strategy: 'cache-only' });

    assert.equal(afterFailure.apps[0].installedVersion, '1.1.0', 'Failed candidate must preserve the active version');
  });
}

test('background updates expose a ready platform package and activate it on the next launch', async t => {
  const f = fixture(t, targets[0]);
  await f.manager.install({ id });
  f.setRelease('1.1.0');
  const fetchIndex = f.options.fetchImpl;
  const manager = createSubappManager({ ...f.options, fetchImpl: async () => {
    const original = await fetchIndex();
    const index = JSON.parse(await original.text());
    index[id].update = { download: 'background', install: 'next-launch' };
    return { ok: true, text: async () => JSON.stringify(index) };
  } });
  await manager.list({ refresh: true });
  const deadline = Date.now() + 5000;
  let state;

  do {
    state = await manager.list({ strategy: 'cache-only' });
    if (state.apps[0].updateStatus.state === 'ready') break;
    assert.ok(Date.now() < deadline, JSON.stringify(state.apps[0].updateStatus));
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (true);

  assert.equal(state.apps[0].installedVersion, '1.0.0');
  const launch = await manager.prepareLaunch({ id });
  launch.release();
  assert.equal((await manager.list({ strategy: 'cache-only' })).apps[0].installedVersion, '1.1.0');
});

test('a platform catalog never falls back to a top-level or npm distribution on unsupported hosts', async t => {
  const f = fixture(t, { platform: 'darwin', arch: 'x64' });
  const listed = await f.manager.list();

  assert.deepEqual(listed.apps, []);
  await assert.rejects(f.manager.install({ id }), /not present/);
  assert.equal(f.downloads.length, 0);

  const { entry } = release('1.0.0');

  assert.equal(selectSubappPlatformEntry({ ...entry, dist: entry.platforms['win32-x64'].dist },
    { platform: 'darwin', arch: 'x64' }), null);
});

test('catalog cache retains both platforms and selection does not mutate legacy entries', async t => {
  const f = fixture(t, targets[0]);

  await f.manager.list({ refresh: true });

  const cache = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'subapp-index.json')));

  assert.deepEqual(Object.keys(cache[id].platforms).sort(), ['darwin-arm64', 'win32-x64']);

  const legacy = { ...cache[id], platforms: undefined, dist: cache[id].platforms['win32-x64'].dist };

  assert.equal(selectSubappPlatformEntry(legacy, targets[0]), legacy);
});

test('rejects malformed platform overrides instead of allowing identity or app-policy overrides', () => {
  const { entry } = release('1.0.0');

  for (const platforms of [{}, [], { 'darwin-arm64': {} },
    { 'darwin-arm64': { ...entry.platforms['darwin-arm64'], package: '@other/tool' } },
    { 'darwin-arm64': { dist: { tarball: 'file:///tmp/tool.tgz', integrity: 'sha512-invalid' } } }]) {
    assert.throws(() => validateIndex({ [id]: { ...entry, platforms } }));
  }
});

test('launch refuses an installed native package copied from another platform', async t => {
  const f = fixture(t, targets[0]);

  await f.manager.install({ id });

  const wrongHost = createSubappManager({ ...f.options, ...targets[1] });

  await assert.rejects(wrongHost.prepareLaunch({ id }), /does not support win32-x64/);
});
