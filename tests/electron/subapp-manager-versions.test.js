const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const versions = require('../../electron/subapp-version-store');
const {
  createSubappManager,
  listProcessesUsingPath,
  packagePathFor,
  prepareNpmSpawn,
  readInstalledState,
  runNpm,
  validateIndex,
} = require('../../electron/subapp-manager');
const { npmTarball, portableSubappTarball } = require('./fixtures/npm-tarball-fixture');
const http = require('node:http');
const { acquireInstallLock } = require('../../electron/subapp-install-lock');

const ID = 'aily-chat';
const PACKAGE = '@aily-project/subapp-aily-chat';

function integrity(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

function catalogEntry(version, archive, overrides = {}) {
  return {
    id: ID,
    package: PACKAGE,
    version,
    namespace: 'AILY_CHAT',
    titleKey: 'AILY_CHAT.NAME',
    app: { name: 'Aily Chat', enabled: true },
    update: { download: 'background', install: 'next-launch' },
    dist: { tarball: `https://packages.example.test/${version}.tgz`, integrity: integrity(archive) },
    ...overrides,
  };
}

function writeRunnablePackage(packageRoot, version, options = {}) {
  fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: options.name || PACKAGE,
    version,
    main: 'server/index.js',
    bin: {
      'subapp-aily-chat': 'server/index.js',
      'aily-blockly-mcp': 'runtime/mcp/cli.js',
    },
    aily: { uiIndex: 'ui/index.html' },
    ailySubapp: { id: ID },
    ...(options.portable === false ? {} : {
      ailyPortable: { version: 1, platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
    }),
  }));
  fs.writeFileSync(path.join(packageRoot, 'server/index.js'), `module.exports='${version}'`);
  fs.mkdirSync(path.join(packageRoot, 'runtime', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'runtime', 'mcp', 'cli.js'), `module.exports='mcp-${version}'`);
  fs.writeFileSync(path.join(packageRoot, 'ui/index.html'), version);
}

function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-manager-v2-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const rootDir = path.join(temporary, '用户 App & Data', 'npm-global', 'app');
  const updateRootDir = path.join(temporary, 'update cache');
  fs.mkdirSync(rootDir, { recursive: true });
  const version = options.version || '0.1.33';
  const archive = options.archive || portableSubappTarball({ packageName: PACKAGE, version, id: ID });
  const entry = catalogEntry(version, archive, options.entry || {});
  const calls = [];
  const downloads = [];
  const runNpm = async (args, runnerOptions = {}) => {
    calls.push({ args: [...args], options: runnerOptions });
    if (args[0] === 'view') {
      return { stdout: JSON.stringify({
        tarball: `https://packages.example.test/${version}.tgz`, integrity: integrity(archive),
      }) };
    }
    if (args[0] !== 'install') throw new Error(`Unexpected npm command: ${args.join(' ')}`);
    return { stdout: 'up to date' };
  };
  const managerOptions = {
    rootDir,
    updateRootDir,
    env: {},
    indexUrl: 'https://packages.example.test/subapp-index.json',
    runNpm,
    downloadFile: async (url, destination, onProgress) => {
      downloads.push(url);
      fs.writeFileSync(destination, archive);
      onProgress?.(100);
    },
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: entry }) }),
    hasProcessesUsingPath: async () => false,
    forceStopChildToolByCatalogId: async () => ({ success: true }),
    ...options.managerOptions,
  };
  return {
    temporary,
    rootDir,
    updateRootDir,
    archive,
    entry,
    calls,
    downloads,
    managerOptions,
    manager: createSubappManager(managerOptions),
  };
}

test('Agent repair keeps the installed version even when the catalog has a newer release', async t => {
  const oldVersion = '0.1.32';
  const archive = portableSubappTarball({ packageName: PACKAGE, version: oldVersion, id: ID });
  let stopped = 0;
  const f = fixture(t, { archive, managerOptions: {
    listBusyHolders: async () => [],
    forceStopChildToolByCatalogId: async () => { stopped++; throw new Error('must not stop'); },
  } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), oldVersion);
  const result = await f.manager.repair({ id: ID });
  assert.equal(result.version, oldVersion);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, oldVersion);
  assert.ok(f.calls.some(call => call.args[0] === 'view' && call.args[1] === `${PACKAGE}@${oldVersion}`));
  assert.equal(stopped, 0);
});

test('Agent repair rejects active holders before download without stopping anything', async t => {
  const f = fixture(t, { managerOptions: {
    listChildToolHolders: async () => [{ pid: 12345, toolId: ID }],
    listBusyHolders: async () => [],
    forceStopChildToolByCatalogId: async () => { throw new Error('must not stop'); },
  } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), f.entry.version);
  await assert.rejects(f.manager.repair({ id: ID }), { code: 'SUBAPP_REPAIR_BUSY' });
  assert.equal(f.downloads.length, 0);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
});

test('Agent repair validates declared skills before replacing the old same-version package', async t => {
  const version = '0.1.33';
  const archive = npmTarball({
    'package.json': JSON.stringify({ name: PACKAGE, version, main: 'server/index.js',
      aily: { uiIndex: 'ui/index.html' },
      ailySubapp: { id: ID, agent: { protocolVersion: 1, skills: ['skill/missing/SKILL.md'],
        tools: { transport: 'aily-child-rpc', manifest: 'agent/tools.json' } } },
      ailyPortable: { version: 1, platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] } }),
    'server/index.js': 'module.exports=1', 'ui/index.html': 'fixture',
    'agent/tools.json': JSON.stringify({ protocolVersion: 1, transport: 'aily-child-rpc', tools: [] }),
  });
  const f = fixture(t, { archive, managerOptions: { listBusyHolders: async () => [] } });
  await f.manager.install({ id: ID });
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  fs.writeFileSync(path.join(source, 'old-marker.txt'), 'preserve');
  await assert.rejects(f.manager.repair({ id: ID }), /skill.*not found/i);
  assert.equal(fs.readFileSync(path.join(source, 'old-marker.txt'), 'utf8'), 'preserve');
});

test('Agent repair replaces a damaged same-version generation only after validation and retains the old files', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  await f.manager.install({ id: ID });
  const old = readInstalledState(f.rootDir, f.entry);
  fs.writeFileSync(path.join(old.packagePath, 'old-marker.txt'), 'preserve');
  const result = await f.manager.repair({ id: ID });
  assert.equal(result.repaired, true);
  assert.equal(result.version, old.installedVersion);
  const parent = path.dirname(path.dirname(old.packagePath));
  const backup = fs.readdirSync(parent).find(name => name.startsWith(`.replaced-${old.installedVersion}-`));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(parent, backup, 'source/old-marker.txt'), 'utf8'), 'preserve');
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, old.installedVersion);
});

test('Agent repair rechecks newly busy holders after preparation and leaves the active package unchanged', async t => {
  let busy = false;
  const f = fixture(t, { managerOptions: {
    listBusyHolders: async () => busy ? [{ pid: 43210 }] : [],
  } });
  await f.manager.install({ id: ID });
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  fs.writeFileSync(path.join(source, 'old-marker.txt'), 'preserve');
  f.managerOptions.downloadFile = async (_url, destination) => { fs.writeFileSync(destination, f.archive); busy = true; };
  const manager = createSubappManager(f.managerOptions);
  await assert.rejects(manager.repair({ id: ID }), { code: 'SUBAPP_REPAIR_BUSY' });
  assert.equal(fs.readFileSync(path.join(source, 'old-marker.txt'), 'utf8'), 'preserve');
});

test('Agent repair download failure keeps the old active generation', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  await f.manager.install({ id: ID });
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  fs.writeFileSync(path.join(source, 'old-marker.txt'), 'preserve');
  const manager = createSubappManager({ ...f.managerOptions, downloadFile: async () => { throw new Error('offline fixture'); } });
  await assert.rejects(manager.repair({ id: ID }), /offline fixture/);
  assert.equal(fs.readFileSync(path.join(source, 'old-marker.txt'), 'utf8'), 'preserve');
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
});

test('Agent repair refuses managed development/next generations without downloading or replacing them', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  const candidate = versions.createCandidate(f.rootDir, f.entry);
  writeRunnablePackage(candidate.source, f.entry.version);
  const prepared = await versions.publishCandidate(f.rootDir, f.entry, candidate, { installMode: 'next' });
  versions.activate(f.rootDir, f.entry, prepared, { mode: 'pinned' });
  await assert.rejects(f.manager.repair({ id: ID }), { code: 'SUBAPP_REPAIR_DEVELOPMENT_LINK' });
  assert.equal(f.downloads.length, 0);
});

test('Agent repair cannot silently remove the original Agent/skill declaration', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), f.entry.version);
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  manifest.ailySubapp.agent = { skills: ['skill/existing/SKILL.md'], tools: { manifest: 'agent/tools.json' } };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(manifest));
  await assert.rejects(f.manager.repair({ id: ID }), { code: 'SUBAPP_REPAIR_CAPABILITY_CHANGED' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).ailySubapp.agent, manifest.ailySubapp.agent);
});

test('Agent repair preserves a pinned selector and restores its exact old package on activation failure', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  await f.manager.install({ id: ID });
  const originalPrepared = versions.readPrepared(f.rootDir, f.entry);
  versions.activate(f.rootDir, f.entry, originalPrepared, { mode: 'pinned' });
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  fs.writeFileSync(path.join(source, 'old-marker.txt'), 'preserve');
  const activePath = versions.activePath(f.rootDir, f.entry);
  const before = fs.readFileSync(activePath, 'utf8');
  const activate = versions.activate;
  versions.activate = (...args) => { activate(...args); throw new Error('activation receipt fixture'); };
  try { await assert.rejects(f.manager.repair({ id: ID }), /activation receipt fixture/); }
  finally { versions.activate = activate; }
  assert.equal(fs.readFileSync(activePath, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(source, 'old-marker.txt'), 'utf8'), 'preserve');
  assert.equal(versions.readActiveManifest(f.rootDir, f.entry).mode, 'pinned');
  const result = await f.manager.repair({ id: ID });
  assert.equal(result.ok, true);
  assert.equal(versions.readActiveManifest(f.rootDir, f.entry).mode, 'pinned');
});

test('Agent repair preserves a concurrent active-selection change rather than rolling it back', async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  await f.manager.install({ id: ID });
  const externalEntry = { ...f.entry, version: '0.1.34' };
  const candidate = versions.createCandidate(f.rootDir, externalEntry);
  writeRunnablePackage(candidate.source, externalEntry.version);
  const external = await versions.publishCandidate(f.rootDir, externalEntry, candidate);
  const manager = createSubappManager({ ...f.managerOptions, downloadFile: async (_url, target) => {
    fs.writeFileSync(target, f.archive);
    versions.activate(f.rootDir, externalEntry, external);
  } });
  await assert.rejects(manager.repair({ id: ID }), { code: 'SUBAPP_REPAIR_SOURCE_CHANGED' });
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, externalEntry.version);
});

async function transferServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/package.tgz`;
}

for (const anotherManager of [false, true]) {
  test(`uninstall cancels a stalled background transfer${anotherManager ? ' from another local manager' : ''} while the old version stays launchable`, { timeout: 10000 }, async t => {
    let started;
    const receiving = new Promise(resolve => { started = resolve; });
    const url = await transferServer(t, (_request, response) => {
      response.writeHead(200, { 'content-length': 1000000 }); response.write('partial'); started();
    });
    const f = fixture(t, { managerOptions: { downloadFile: undefined, listBusyHolders: async () => [] } });
    f.entry.dist.tarball = url;
    writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
    const download = assert.rejects(f.manager.downloadUpdate({ id: ID }), { code: 'SUBAPP_CANCELLED' });
    await receiving;
    const old = await f.manager.prepareLaunch({ id: ID });
    assert.equal(old.config.version, '0.1.32'); old.release();
    const uninstaller = anotherManager ? createSubappManager(f.managerOptions) : f.manager;
    await uninstaller.uninstall({ id: ID });
    await download;
    assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
    assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
    assert.equal(fs.existsSync(path.join(f.updateRootDir, ID)), false);
    assert.equal(fs.existsSync(path.join(f.rootDir, 'store', versions.storeKeyForPackage(PACKAGE))), false);
  });
}

test('download timeout preserves the old runtime and retry switches to the prepared version without deleting old files', { timeout: 10000 }, async t => {
  let archive, ready = false;
  const url = await transferServer(t, (_request, response) => { if (ready) response.end(archive); });
  const f = fixture(t, { managerOptions: { downloadFile: undefined, downloadIdleTimeoutMs: 100 } });
  f.entry.dist.tarball = url; archive = f.archive;
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await assert.rejects(f.manager.downloadUpdate({ id: ID }), { code: 'SUBAPP_DOWNLOAD_IDLE_TIMEOUT' });
  const old = await f.manager.prepareLaunch({ id: ID });
  assert.equal(old.config.version, '0.1.32'); old.release();
  ready = true;
  await f.manager.downloadUpdate({ id: ID });
  await f.manager.installUpdate({ id: ID });
  const next = await f.manager.prepareLaunch({ id: ID });
  assert.equal(next.config.version, f.entry.version); next.release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, 'package.json'))).version, '0.1.32');
});

test('a hung manual update cannot block another app installation and uninstall cancels it before entering the queue', { timeout: 10000 }, async t => {
  let started;
  const receiving = new Promise(resolve => { started = resolve; });
  const otherId = 'network-independent', otherPackage = '@aily-project/subapp-network-independent';
  const otherArchive = portableSubappTarball({ packageName: otherPackage, id: otherId, version: '1.0.0' });
  const url = await transferServer(t, (request, response) => {
    if (request.url === '/other') return response.end(otherArchive);
    started();
  });
  const f = fixture(t, { managerOptions: { downloadFile: undefined, listBusyHolders: async () => [] } });
  f.entry.dist.tarball = url;
  const other = catalogEntry('1.0.0', otherArchive, { id: otherId, package: otherPackage,
    dist: { tarball: url.replace('/package.tgz', '/other'), integrity: integrity(otherArchive) } });
  f.managerOptions.fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: f.entry, [otherId]: other }) });
  f.manager = createSubappManager(f.managerOptions);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const update = assert.rejects(f.manager.update({ id: ID }), { code: 'SUBAPP_CANCELLED' });
  await receiving;
  await f.manager.install({ id: otherId });
  assert.equal(readInstalledState(f.rootDir, other).installed, true);
  await f.manager.uninstall({ id: ID });
  await update;
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
  assert.equal(readInstalledState(f.rootDir, other).installed, true);
});

test('waiting for another process preparation lock never holds the global startup lock and uninstall returns a bounded error', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { lockTimeoutMs: 150 } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const release = acquireInstallLock(path.join(f.rootDir, 'store', '.locks', versions.storeKeyForPackage(PACKAGE)));
  try {
    const uninstall = assert.rejects(f.manager.uninstall({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
    const old = await f.manager.prepareLaunch({ id: ID });
    assert.equal(old.config.version, '0.1.32'); old.release();
    await uninstall;
    assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  } finally { release(); }
});

test('a prepared update survives selection contention and can activate on retry', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { lockTimeoutMs: 100 } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  await f.manager.downloadUpdate({ id: ID });
  const release = acquireInstallLock(path.join(f.rootDir, 'store', '.locks'));
  try {
    await assert.rejects(f.manager.installUpdate({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
    assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '0.1.32');
  } finally { release(); }
  await f.manager.installUpdate({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
});

test('unconfirmed npm termination retains only its package guard until the process closes', { timeout: 10000 }, async t => {
  const archive = npmTarball({
    'package.json': JSON.stringify({ name: PACKAGE, version: '0.1.33', main: 'index.js', scripts: { postinstall: 'node build.js' } }),
    'index.js': '', 'ui/index.html': '', 'build.js': '',
  });
  const f = fixture(t, { archive, managerOptions: { lockTimeoutMs: 100, listBusyHolders: async () => [] } });
  const cli = path.join(f.temporary, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(path.join(f.temporary, 'node', 'npm.cmd'), '');
  const pidFile = path.join(f.temporary, 'npm-pid');
  fs.writeFileSync(cli, `require('fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
  f.managerOptions.runNpm = (_args, options) => runNpm([pidFile], {
    ...options, platform: 'win32', env: { AILY_CHILD_PATH: f.temporary }, npmTimeoutMs: 1000,
    killProcessTree: async () => false,
  });
  f.manager = createSubappManager(f.managerOptions);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  try {
    await assert.rejects(f.manager.update({ id: ID }), { code: 'SUBAPP_NPM_TIMEOUT' });
    assert.ok(fs.existsSync(pidFile));
    const old = await f.manager.prepareLaunch({ id: ID });
    assert.equal(old.config.version, '0.1.32'); old.release();
    await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
  } finally {
    if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile)), 'SIGKILL'); } catch {} }
  }
  // The process close event releases the deferred guard after staging cleanup.
  const retry = createSubappManager({ ...f.managerOptions, lockTimeoutMs: 3000 });
  await retry.uninstall({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

test('a slow uninstall does not block another app and closes a registration that races preflight', { timeout: 5000 }, async t => {
  let unblock, reportMarked, calls = 0;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const marked = new Promise(resolve => { reportMarked = resolve; });
  const f = fixture(t, { managerOptions: {
    listBusyHolders: async () => [],
    forceStopChildToolByCatalogId: async () => {
      if (++calls === 2) { reportMarked(); await blocked; }
      return { success: true };
    },
  } });
  const other = { ...f.entry, id: 'other', package: '@aily-project/subapp-other' };
  f.managerOptions.fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: f.entry, other }) });
  f.manager = createSubappManager(f.managerOptions);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  writeRunnablePackage(packagePathFor(f.rootDir, other.package), other.version, { name: other.package });
  const uninstall = f.manager.uninstall({ id: ID });
  await marked;
  try {
    await assert.rejects(f.manager.prepareLaunch({ id: ID }), /Subapp is not installed/);
    const launch = await f.manager.prepareLaunch({ id: 'other' });
    assert.equal(launch.config.version, other.version); launch.release();
  } finally { unblock(); }
  await uninstall;
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

test('a Windows-style deletion failure remains retryable in a new manager and never strands the global lock', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { platform: 'win32', listBusyHolders: async () => [], sleep: async () => {} } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const rm = fs.promises.rm;
  const mock = t.mock.method(fs.promises, 'rm', async (target, options) => {
    if (target === legacy) throw Object.assign(new Error('EPERM unlink busy'), { code: 'EPERM' });
    return rm(target, options);
  });
  await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'EBUSY' });
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), true);
  const free = acquireInstallLock(path.join(f.rootDir, 'store', '.locks'));
  assert.equal(typeof free, 'function'); free();
  mock.mock.restore();
  await createSubappManager(f.managerOptions).uninstall({ id: ID });
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.equal(fs.existsSync(legacy), false);
});

test('headless portable packages install, select and rediscover without dummy UI or npm', async t => {
  const archive = npmTarball({
    'package.json': JSON.stringify({ name: PACKAGE, version: '0.1.33', main: 'index.js',
      ailySubapp: { runtime: { headless: true }, app: { enabled: true } }, ailyPortable: { version: 1 } }),
    'index.js': 'module.exports = {};',
  });
  const f = fixture(t, { archive });
  await f.manager.install({ id: ID });
  const installed = readInstalledState(f.rootDir, f.entry);
  assert.equal(installed.installed, true);
  assert.equal(installed.config.env.AILY_SUBAPP_SOURCE, 'version-store');
  assert.deepEqual(installed.config.runtime, { headless: true });
  assert.equal(installed.config.uiIndex, undefined);
  assert.equal(installed.config.routePath, undefined);
  assert.equal(installed.config.app.enabled, false);
  assert.equal(installed.config.app.available, false);
  assert.equal(fs.existsSync(path.join(installed.packagePath, 'ui')), false);
  assert.equal(f.calls.length, 0);
  assert.equal((await createSubappManager(f.managerOptions).list()).apps[0].installed, true);
});

test('installs a remote app while an unrelated local development catalog exists', async t => {
  const f = fixture(t);
  const localEntry = { ...f.entry, id: 'serial-debugger', package: '@aily-project/subapp-serial-debugger' };
  fs.writeFileSync(path.join(f.rootDir, 'subapp-index.json'), JSON.stringify({
    [localEntry.id]: localEntry,
    dev: true,
  }));

  const catalog = await f.manager.list({ refresh: true });
  assert.equal(catalog.source, 'network');
  await f.manager.install({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, true);
});

test('headless declaration is explicit and cannot mask invalid backend or contradictory UI', t => {
  const f = fixture(t), root = packagePathFor(f.rootDir, PACKAGE);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');
  const check = (runtime, overrides = {}) => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: PACKAGE, version: '0.1.33',
      main: 'index.js', ailySubapp: { runtime, app: { enabled: false } }, ...overrides }));
    return readInstalledState(f.rootDir, f.entry);
  };
  assert.equal(check({}).installed, false); // app.enabled:false does not mean headless.
  assert.equal(check({ headless: false }).installed, false);
  assert.equal(check({ headless: true }).installed, true);
  for (const headless of ['true', 1, null]) assert.match(check({ headless }).installError, /must be a boolean/);
  assert.match(check({ headless: true }, { aily: { uiIndex: 'ui/index.html' } }).installError, /cannot declare UI/);
  assert.equal(check({ headless: true }, { main: 'missing.js' }).installed, false);
  fs.mkdirSync(path.join(root, 'directory.js'));
  assert.equal(check({ headless: true }, { main: 'directory.js' }).installed, false);
  fs.writeFileSync(path.join(root, '../outside.js'), 'module.exports = {};');
  assert.match(check({ headless: true }, { main: '../outside.js' }).installError, /Unsafe Subapp entry/);
});

test('reads a legacy B installation and emits the version-selected environment contract', (t) => {
  const f = fixture(t);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const installed = readInstalledState(f.rootDir, f.entry);
  assert.equal(installed.installedVersion, '0.1.32');
  assert.equal(installed.packagePath, legacy);
  assert.deepEqual(installed.config.env, {
    AILY_SUBAPP_INSTALL_ROOT: f.rootDir,
    AILY_SUBAPP_PACKAGE_PATH: legacy,
    AILY_SUBAPP_VERSION: '0.1.32',
    AILY_SUBAPP_SOURCE: 'legacy-npm',
    AILY_SUBAPP_BIN_ROUTER: path.join(f.rootDir, 'bin', 'subapp-bin-router.cjs'),
  });
  assert.equal(fs.existsSync(installed.config.env.AILY_SUBAPP_BIN_ROUTER), true);
});

test('catalog app policies survive validation, installation, and runtime config projection', async (t) => {
  const f = fixture(t, { entry: {
    app: { enabled: true, autoInstall: true, defaultToolbar: true, customPolicy: { keep: true } },
  } });
  const before = await f.manager.list();
  assert.equal(before.apps[0].installed, false);
  assert.equal(before.apps[0].app.autoInstall, true);
  assert.equal(before.apps[0].app.defaultToolbar, true);
  await f.manager.install({ id: ID });
  const after = await f.manager.list();
  assert.equal(after.apps[0].installed, true);
  assert.equal(after.apps[0].config.app.autoInstall, true);
  assert.equal(after.apps[0].config.app.defaultToolbar, true);
  assert.deepEqual(after.apps[0].config.app.customPolicy, { keep: true });
});

test('Chat has no implicit install or toolbar policy and explicit false is honored', (t) => {
  const f = fixture(t);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.33');
  for (const app of [{ enabled: true }, { enabled: true, autoInstall: false, defaultToolbar: false }]) {
    const entry = validateIndex({ [ID]: { ...f.entry, app } })[ID];
    const installed = readInstalledState(f.rootDir, entry);
    assert.equal(entry.app.autoInstall, false);
    assert.equal(installed.config.app.defaultToolbar, false);
  }
});

test('catalog rejects non-boolean initialization flags', (t) => {
  const f = fixture(t);
  for (const flag of ['autoInstall', 'defaultToolbar']) {
    for (const value of ['true', 1, null, {}]) {
      assert.throws(() => validateIndex({ [ID]: {
        ...f.entry, app: { ...f.entry.app, [flag]: value },
      } }), new RegExp(`app\\.${flag} must be a boolean`));
    }
  }
});

test('portable install downloads and extracts directly to A without npm or changing root manifests', async (t) => {
  const f = fixture(t);
  const rootManifest = '{"private":true,"dependencies":{"other":"1.0.0"}}\n';
  fs.writeFileSync(path.join(f.rootDir, 'package.json'), rootManifest);
  await f.manager.install({ id: ID });
  const expected = path.join(f.rootDir, 'store', 'subapp-aily-chat', '0.1.33', 'source');
  const installed = readInstalledState(f.rootDir, f.entry);
  assert.equal(installed.packagePath, expected);
  assert.equal(installed.installedVersion, '0.1.33');
  assert.equal(installed.config.env.AILY_SUBAPP_SOURCE, 'version-store');
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloads.length, 1);
  assert.equal(fs.existsSync(path.join(f.rootDir, 'migration')), false);
  assert.ok(fs.existsSync(path.join(f.rootDir, 'store', '.locks')));
  assert.ok(fs.existsSync(path.join(f.rootDir, 'store', '.locks', 'subapp-aily-chat')));
  assert.equal(fs.readdirSync(path.join(f.rootDir, 'store', '.locks')).some(name => name.includes('@')), false);
  assert.equal(fs.readFileSync(path.join(f.rootDir, 'package.json'), 'utf8'), rootManifest);
});

test('background update preserves an old running process and activates A only after it closes', async (t) => {
  let oldProcessRunning = true;
  const f = fixture(t, {
    managerOptions: {
      getRunningSubappConfig: () => oldProcessRunning ? { version: '0.1.32' } : null,
    },
  });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const legacyBytes = fs.readFileSync(path.join(legacy, 'package.json'));
  await f.manager.downloadUpdate({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '0.1.32');
  const oldLaunch = await f.manager.prepareLaunch({ id: ID });
  try {
    assert.equal(oldLaunch.config.version, '0.1.32');
    assert.equal(oldLaunch.config.packagePath, legacy);
  } finally {
    oldLaunch.release();
  }

  oldProcessRunning = false;
  const latestLaunch = await f.manager.prepareLaunch({ id: ID });
  try {
    assert.equal(latestLaunch.config.version, '0.1.33');
    assert.equal(latestLaunch.config.packagePath, path.join(
      f.rootDir, 'store', 'subapp-aily-chat', '0.1.33', 'source',
    ));
  } finally {
    latestLaunch.release();
  }
  assert.deepEqual(fs.readFileSync(path.join(legacy, 'package.json')), legacyBytes);
});

test('an immediate UI launch keeps the old version when background preparation wins the race', async (t) => {
  const f = fixture(t);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await f.manager.downloadUpdate({ id: ID });

  const immediateLaunch = await f.manager.prepareLaunch({ id: ID, deferPreparedUpdate: true });
  try {
    assert.equal(immediateLaunch.config.version, '0.1.32');
    assert.equal(immediateLaunch.config.packagePath, legacy);
  } finally {
    immediateLaunch.release();
  }

  const nextClosedLaunch = await f.manager.prepareLaunch({ id: ID });
  try {
    assert.equal(nextClosedLaunch.config.version, '0.1.33');
    assert.equal(nextClosedLaunch.config.packagePath, path.join(
      f.rootDir, 'store', 'subapp-aily-chat', '0.1.33', 'source',
    ));
  } finally {
    nextClosedLaunch.release();
  }
});

test('background preparation reports separate download and extraction progress', async (t) => {
  const progress = [];
  const f = fixture(t, {
    managerOptions: {
      onProgress: event => progress.push(event),
    },
  });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');

  await f.manager.downloadUpdate({ id: ID });

  const events = progress.filter(event => event.action === 'download-update');
  assert.ok(events.some(event => event.phase === 'download' && event.percent === 100));
  assert.ok(events.some(event => event.phase === 'extract' && event.extractProgress > 0));
  assert.ok(events.some(event => event.phase === 'extract' && event.percent === event.extractProgress));
  assert.equal(events.at(-1).phase, 'complete');
  assert.equal(events.at(-1).percent, 100);
});

test('auto mode uses a newer normal B, while a managed development link always wins', async (t) => {
  const f = fixture(t, { version: '1.0.0' });
  const candidate = versions.createCandidate(f.rootDir, f.entry);
  writeRunnablePackage(candidate.source, '1.0.0');
  const prepared = await versions.publishCandidate(f.rootDir, f.entry, candidate, { distribution: f.entry.dist });
  versions.activate(f.rootDir, f.entry, prepared);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '2.0.0');
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '2.0.0');

  fs.rmSync(legacy, { recursive: true, force: true });
  const development = path.join(f.temporary, 'chat development');
  writeRunnablePackage(development, '0.0.1');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.symlinkSync(development, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = readInstalledState(f.rootDir, f.entry);
  assert.equal(selected.development, true);
  assert.equal(selected.installedVersion, '0.0.1');
  assert.equal(selected.config.env.AILY_SUBAPP_SOURCE, 'development');
});

test('uses a pinned version-dev generation as the active development package', async (t) => {
  const f = fixture(t, { version: '1.0.0' });
  const releaseCandidate = versions.createCandidate(f.rootDir, f.entry);
  writeRunnablePackage(releaseCandidate.source, '1.0.0');
  const release = await versions.publishCandidate(f.rootDir, f.entry, releaseCandidate, {
    distribution: f.entry.dist,
  });
  versions.activate(f.rootDir, f.entry, release);

  const devEntry = { ...f.entry, version: '1.0.0-dev' };
  const devCandidate = versions.createCandidate(f.rootDir, devEntry);
  writeRunnablePackage(devCandidate.source, '1.0.0-dev');
  const development = await versions.publishCandidate(f.rootDir, devEntry, devCandidate, {
    distribution: null,
    installMode: 'development',
  });
  versions.activate(f.rootDir, devEntry, development, { mode: 'pinned' });

  const selected = readInstalledState(f.rootDir, f.entry);
  assert.equal(selected.development, true);
  assert.equal(selected.installedVersion, '1.0.0-dev');
  assert.equal(selected.packagePath, path.join(
    f.rootDir, 'store', 'subapp-aily-chat', '1.0.0-dev', 'source',
  ));
  assert.equal(selected.config.env.AILY_SUBAPP_SOURCE, 'development');
});

test('keeps a pinned version-next package on the production runtime path and local catalog', async (t) => {
  const f = fixture(t, { version: '1.0.0' });
  const nextEntry = { ...f.entry, version: '1.0.0-next' };
  const nextCandidate = versions.createCandidate(f.rootDir, nextEntry);
  writeRunnablePackage(nextCandidate.source, nextEntry.version);
  const next = await versions.publishCandidate(f.rootDir, nextEntry, nextCandidate, {
    distribution: null,
    installMode: 'next',
  });
  versions.activate(f.rootDir, nextEntry, next, { mode: 'pinned' });
  fs.writeFileSync(path.join(f.rootDir, 'subapp-index.json'), JSON.stringify({
    [ID]: nextEntry,
    dev: true,
  }));

  const selected = readInstalledState(f.rootDir, f.entry);
  assert.equal(selected.localNext, true);
  assert.equal(selected.development, false);
  assert.equal(selected.installedVersion, '1.0.0-next');
  assert.equal(selected.config.env.AILY_SUBAPP_SOURCE, 'version-store');

  const state = await f.manager.list({ refresh: true });
  assert.equal(state.apps[0].availableVersion, '1.0.0-next');
  assert.equal(state.apps[0].installedVersion, '1.0.0-next');
  assert.equal(state.apps[0].updateAvailable, false);
});

test('a legacy package without a portable declaration runs npm only inside A/source', async (t) => {
  const version = '3.0.0';
  const archive = npmTarball({
    'package.json': JSON.stringify({
      name: PACKAGE, version, main: 'server/index.js', aily: { uiIndex: 'ui/index.html' }, ailySubapp: { id: ID },
    }),
    'server/index.js': 'module.exports=1',
    'ui/index.html': '<h1>legacy</h1>',
  });
  const f = fixture(t, { version, archive });
  await f.manager.install({ id: ID });
  const install = f.calls.find(call => call.args[0] === 'install');
  assert.ok(install);
  const prefix = install.args[install.args.indexOf('--prefix') + 1];
  assert.match(prefix, /store[/\\]subapp-aily-chat[/\\]\.staging-3\.0\.0-.*[/\\]source$/);
  assert.notEqual(prefix, f.rootDir);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, version);
});

test('published self-contained Aily Coder packages without the portable marker skip legacy npm', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-portable-compat-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const rootDir = path.join(temporary, 'app');
  const updateRootDir = path.join(temporary, 'updates');
  const id = 'aily-coder-editor';
  const packageName = '@aily-project/subapp-aily-coder-editor';
  const version = '0.1.7';
  const archive = npmTarball({
    'package.json': JSON.stringify({
      name: packageName,
      version,
      type: 'module',
      main: 'index.js',
      aily: { uiIndex: 'ui/index.html' },
      ailySubapp: { id },
      devDependencies: { typescript: '~5.9.3' },
    }),
    'index.js': "import './runtime/index.js';\n",
    'runtime/index.js': 'export const version = 1;\n',
    'ui/index.html': '<h1>Aily Coder</h1>',
  });
  const entry = {
    id,
    package: packageName,
    version,
    namespace: 'AILY_CODER_EDITOR',
    titleKey: 'AILY_CODER_EDITOR.TITLE',
    app: { name: 'Aily Coder Editor', enabled: true, extension: true },
    dist: { tarball: `https://packages.example.test/${version}.tgz`, integrity: integrity(archive) },
  };
  let npmCalls = 0;
  const manager = createSubappManager({
    rootDir,
    updateRootDir,
    indexUrl: 'https://packages.example.test/subapp-index.json',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [id]: entry }) }),
    downloadFile: async (_url, destination, onProgress) => {
      fs.writeFileSync(destination, archive);
      onProgress?.(100);
    },
    runNpm: async () => {
      npmCalls += 1;
      throw new Error('legacy npm must not run for the self-contained Coder package');
    },
    platform: process.platform,
  });

  await manager.install({ id });

  const installed = readInstalledState(rootDir, entry);
  assert.equal(installed.installedVersion, version);
  assert.equal(installed.config.env.AILY_SUBAPP_SOURCE, 'version-store');
  assert.equal(npmCalls, 0);
  assert.equal(
    fs.existsSync(path.join(rootDir, 'store', 'subapp-aily-coder-editor', version, 'source', 'runtime', 'index.js')),
    true,
  );
});

test('catalogs without dist metadata query the exact version and still use direct extraction', async (t) => {
  const f = fixture(t);
  delete f.entry.dist;
  await f.manager.install({ id: ID });
  const view = f.calls.find(call => call.args[0] === 'view');
  assert.deepEqual(view.args.slice(0, 4), ['view', `${PACKAGE}@0.1.33`, 'dist', '--json']);
  assert.equal(f.calls.some(call => call.args[0] === 'install'), false);
});

test('uninstall removes B, every A version, cache and only this root dependency', async (t) => {
  const f = fixture(t);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  fs.mkdirSync(path.join(f.rootDir, 'node_modules', '.bin'), { recursive: true });
  const bin = path.join(f.rootDir, 'node_modules', '.bin', 'subapp-aily-chat');
  if (process.platform === 'win32') fs.writeFileSync(bin, `node "${path.join(legacy, 'server/index.js')}"`);
  else fs.symlinkSync(path.join(legacy, 'server/index.js'), bin);
  fs.mkdirSync(path.join(f.rootDir, 'node_modules', 'other'), { recursive: true });
  fs.writeFileSync(path.join(f.rootDir, 'node_modules', 'other', 'keep'), 'keep');
  fs.writeFileSync(path.join(f.rootDir, 'package.json'), JSON.stringify({
    private: true, dependencies: { [PACKAGE]: '0.1.32', other: '1.0.0' },
  }));
  fs.writeFileSync(path.join(f.rootDir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [PACKAGE]: '0.1.32', other: '1.0.0' } },
      [`node_modules/${PACKAGE}`]: { version: '0.1.32' },
      'node_modules/other': { version: '1.0.0' },
    },
  }));
  await f.manager.install({ id: ID });
  writeRunnablePackage(
    path.join(f.rootDir, 'store', 'subapp-aily-chat', '0.1.30', 'source'),
    '0.1.30',
  );
  writeRunnablePackage(
    path.join(f.rootDir, 'store', 'subapp-aily-chat', '0.1.31', 'source'),
    '0.1.31',
  );
  fs.mkdirSync(path.join(f.updateRootDir, ID, '0.1.31'), { recursive: true });
  fs.writeFileSync(path.join(f.updateRootDir, ID, '0.1.31', 'package.tgz'), 'old');

  await f.manager.uninstall({ id: ID });
  assert.equal(fs.lstatSync(legacy, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.existsSync(path.join(f.rootDir, 'store', 'subapp-aily-chat')), false);
  assert.equal(fs.existsSync(path.join(f.updateRootDir, ID)), false);
  assert.equal(fs.existsSync(path.join(f.rootDir, 'node_modules', '.bin', 'subapp-aily-chat')), false);
  assert.equal(fs.readFileSync(path.join(f.rootDir, 'node_modules', 'other', 'keep'), 'utf8'), 'keep');
  const rootManifest = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'package.json')));
  const rootLock = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'package-lock.json')));
  assert.deepEqual(rootManifest.dependencies, { other: '1.0.0' });
  assert.deepEqual(rootLock.packages[''].dependencies, { other: '1.0.0' });
  assert.equal(rootLock.packages[`node_modules/${PACKAGE}`], undefined);
  assert.ok(rootLock.packages['node_modules/other']);
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

function coderUninstallFixture(t, managerOptions = {}) {
  const id = 'aily-coder-editor';
  const packageName = '@aily-project/subapp-aily-coder-editor';
  const archive = portableSubappTarball({ packageName, version: '0.1.33', id });
  const entry = catalogEntry('0.1.33', archive, { id, package: packageName });
  const f = fixture(t, {
    archive, entry,
    managerOptions: {
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [id]: entry }) }),
      ...managerOptions,
    },
  });
  return { ...f, id };
}

test('an open Coder project blocks normal and forced editor uninstall without stopping or deleting it', async t => {
  let projectOpen = true;
  let stops = 0;
  const f = coderUninstallFixture(t, {
    isCoderProjectOpen: () => projectOpen,
    forceStopChildToolByCatalogId: async () => { stops += 1; return { success: true }; },
  });
  // Installation and repair remain available while the editor is required.
  await f.manager.install({ id: f.id });
  const installed = readInstalledState(f.rootDir, f.entry);
  for (const forceClose of [false, true]) {
    await assert.rejects(f.manager.uninstall({ id: f.id, forceClose }), {
      code: 'SUBAPP_REQUIRED_BY_PROJECT',
    });
    assert.equal(readInstalledState(f.rootDir, f.entry).installed, true);
    assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
    assert.ok(fs.existsSync(path.join(installed.packagePath, 'package.json')));
  }
  assert.equal(stops, 0);

  projectOpen = false;
  await f.manager.uninstall({ id: f.id });
  assert.ok(stops >= 1);
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

test('editor uninstall rechecks project state after awaiting catalog access', async t => {
  let projectOpen = false;
  let stops = 0;
  let loadCatalog;
  const catalogLoaded = new Promise(resolve => { loadCatalog = resolve; });
  let releaseCatalog;
  const catalogGate = new Promise(resolve => { releaseCatalog = resolve; });
  const f = coderUninstallFixture(t, {
    isCoderProjectOpen: () => projectOpen,
    forceStopChildToolByCatalogId: async () => { stops += 1; return { success: true }; },
    fetchImpl: async () => {
      loadCatalog();
      await catalogGate;
      return { ok: true, text: async () => JSON.stringify({ [f.id]: f.entry }) };
    },
  });
  const legacy = packagePathFor(f.rootDir, f.entry.package);
  writeRunnablePackage(legacy, '0.1.32', { name: f.entry.package });
  const pending = f.manager.uninstall({ id: f.id, forceClose: true });
  const rejected = assert.rejects(pending, { code: 'SUBAPP_REQUIRED_BY_PROJECT' });
  await catalogLoaded;
  projectOpen = true;
  releaseCatalog();
  await rejected;
  assert.equal(stops, 0);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.ok(fs.existsSync(path.join(legacy, 'package.json')));
});

test('an open Coder project does not block uninstalling other subapps', async t => {
  const f = fixture(t, { managerOptions: { isCoderProjectOpen: () => true } });
  await f.manager.install({ id: ID });
  await f.manager.uninstall({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

test('a busy Windows preflight keeps the installation visible and a forced retry finishes cleanup', async (t) => {
  let killed = 0;
  const f = fixture(t, {
    managerOptions: {
      platform: 'win32',
      listBusyHolders: async () => [{ pid: 43210, name: 'node.exe' }],
      killProcessTree: async () => { killed += 1; },
    },
  });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await assert.rejects(f.manager.uninstall({ id: ID }), error => error.requiresForceClose === true);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, true);
  assert.ok(fs.existsSync(path.join(legacy, 'package.json')));
  await f.manager.uninstall({ id: ID, forceClose: true });
  assert.ok(killed >= 1);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.equal(fs.lstatSync(legacy, { throwIfNoEntry: false }), undefined);
});

test('Windows inventory never embeds the searched path or mistakes its scanner for a holder', async () => {
  const packagePath = path.resolve('subapp inventory test');
  const holders = await listProcessesUsingPath(packagePath, {
    platform: 'win32',
    execFileImpl: (command, args, options, callback) => {
      assert.equal(command, 'powershell.exe');
      assert.equal(args.join(' ').includes(packagePath), false);
      assert.equal(options.windowsHide, true);
      callback(null, JSON.stringify([
        { ProcessId: 43212, Name: 'node.exe', CommandLine: `node "${packagePath}/server/index.js"` },
        { ProcessId: 43213, Name: 'powershell.exe', CommandLine: args.join(' ') },
        { ProcessId: process.pid, Name: 'host.exe', CommandLine: packagePath },
      ]));
    },
  });
  assert.deepEqual(holders.map(holder => holder.pid), [43212]);
});

test('macOS process inventory returns the PIDs whose command line uses the package path', async () => {
  const packagePath = '/Users/test/Library/aily-project/npm-global/app/node_modules/@aily-project/subapp-aily-chat';
  const holders = await listProcessesUsingPath(packagePath, {
    platform: 'darwin',
    execFileImpl: (command, args, options, callback) => {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-ww', '-axo', 'pid=,command=']);
      assert.equal(options.windowsHide, true);
      callback(null, [
        ` 43212 /usr/local/bin/node ${packagePath}/server/index.js`,
        ` 43213 "/Applications/Node Runtime" ${packagePath}/runtime/mcp/cli.js`,
        ' 43214 /usr/local/bin/node /tmp/unrelated.js',
      ].join('\n'));
    },
  });

  assert.deepEqual(holders.map(holder => ({ pid: holder.pid, name: holder.name })), [
    { pid: 43212, name: 'node' },
    { pid: 43213, name: 'Node Runtime' },
  ]);
});

test('a forced macOS uninstall closes unregistered processes discovered from command lines', async (t) => {
  let legacy = '';
  const killed = [];
  const f = fixture(t, {
    managerOptions: {
      platform: 'darwin',
      execFileImpl: (_command, _args, _options, callback) => {
        callback(null, legacy ? ` 43215 /usr/local/bin/node ${legacy}/runtime/mcp/cli.js` : '');
      },
      killProcessTree: async (pid) => { killed.push(pid); },
    },
  });
  legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');

  await assert.rejects(
    f.manager.uninstall({ id: ID }),
    error => error.requiresForceClose === true,
  );
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, true);

  await f.manager.uninstall({ id: ID, forceClose: true });

  assert.deepEqual(killed, [43215]);
  assert.equal(fs.existsSync(legacy), false);
});

test('install requests cannot race an active uninstall and recreate the package', async (t) => {
  let releaseStop;
  let reportStopStarted;
  const stopStarted = new Promise(resolve => { reportStopStarted = resolve; });
  const waitForStop = new Promise(resolve => { releaseStop = resolve; });
  const f = fixture(t, {
    managerOptions: {
      forceStopChildToolByCatalogId: async () => {
        reportStopStarted();
        await waitForStop;
        return { success: true };
      },
    },
  });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');

  const uninstalling = f.manager.uninstall({ id: ID });
  await stopStarted;
  await assert.rejects(
    f.manager.install({ id: ID }),
    error => error.code === 'SUBAPP_UNINSTALLING',
  );
  await assert.rejects(
    f.manager.downloadUpdate({ id: ID }),
    error => error.code === 'SUBAPP_UNINSTALLING',
  );
  releaseStop();
  await uninstalling;

  assert.equal(fs.existsSync(path.join(legacy, 'package.json')), false);
  assert.equal(f.downloads.length, 0);
});

test('an interrupted uninstall is reported explicitly and cannot turn into install', async (t) => {
  const f = fixture(t);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  versions.beginUninstall(f.rootDir, f.entry);

  const state = await f.manager.list({ strategy: 'network-first' });
  const item = state.apps.find(app => app.id === ID);
  assert.equal(item.installed, false);
  assert.equal(item.uninstalling, true);
  await assert.rejects(
    f.manager.install({ id: ID }),
    error => error.code === 'SUBAPP_UNINSTALLING',
  );
  await assert.rejects(
    f.manager.downloadUpdate({ id: ID }),
    error => error.code === 'SUBAPP_UNINSTALLING',
  );
  assert.ok(fs.existsSync(path.join(legacy, 'package.json')));
});

test('same-version reinstall preserves the active generation until its holders are force-closed', async (t) => {
  let killed = 0;
  const f = fixture(t, {
    managerOptions: {
      platform: 'win32',
      listBusyHolders: async () => [{ pid: 43211, name: 'node.exe' }],
      killProcessTree: async () => { killed += 1; },
    },
  });
  await f.manager.install({ id: ID });
  const installed = readInstalledState(f.rootDir, f.entry);
  const sentinel = path.join(installed.packagePath, 'active-process-sentinel');
  fs.writeFileSync(sentinel, 'keep until replacement is authorized');

  await assert.rejects(
    f.manager.reinstall({ id: ID }),
    error => error.requiresForceClose === true,
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep until replacement is authorized');

  await f.manager.reinstall({ id: ID, forceClose: true });
  assert.ok(killed >= 1);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
});

test('Windows npm uses npm-cli.js without cmd expansion for paths containing spaces', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily npm path '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const npmDirectory = path.join(root, 'node');
  const cli = path.join(npmDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  fs.writeFileSync(path.join(npmDirectory, 'node.exe'), '');
  const prepared = prepareNpmSpawn(['install', 'C:\\Aily Data\\package.tgz'], {
    platform: 'win32', command: path.join(npmDirectory, 'npm.cmd'), env: { Path: npmDirectory },
  });
  assert.equal(prepared.shell, false);
  assert.equal(prepared.command, path.join(npmDirectory, 'node.exe'));
  assert.deepEqual(prepared.args, [cli, 'install', 'C:\\Aily Data\\package.tgz']);
});

test('the shipped Coder fallback installs from its verified bundle in a responsive worker', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-bundle-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const childPath = path.resolve(__dirname, '..', '..', 'child');
  const bundle = JSON.parse(fs.readFileSync(path.join(childPath, 'aily-coder-editor.json')));
  const rootDir = path.join(temporary, 'npm-global', 'app');
  const manager = createSubappManager({
    rootDir,
    updateRootDir: path.join(temporary, 'updates'),
    buildProduct: 'coder',
    childPath,
    indexUrl: 'https://packages.example.test/subapp-index.json',
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({ [bundle.entry.id]: bundle.entry }),
    }),
    runNpm: async () => { throw new Error('portable Coder fallback must not run npm'); },
    downloadFile: async () => { throw new Error('offline Coder fallback must not download'); },
    hasProcessesUsingPath: async () => false,
  });
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats += 1; }, 1);
  try {
    await manager.install({ id: bundle.entry.id });
  } finally {
    clearInterval(timer);
  }
  const installed = readInstalledState(rootDir, bundle.entry);
  assert.equal(installed.installedVersion, bundle.entry.version);
  assert.equal(installed.packagePath, path.join(
    rootDir, 'store', 'subapp-aily-coder-editor', bundle.entry.version, 'source',
  ));
  assert.ok(heartbeats > 2);
});

test('a transient Windows rename lock still publishes and activates the latest version', async (t) => {
  const f = fixture(t, { managerOptions: { sleep: async () => {}, renameAttempts: 4 } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const legacyBytes = fs.readFileSync(path.join(legacy, 'package.json'));
  const rename = fs.renameSync;
  let denied = 2;
  fs.renameSync = (from, to, ...args) => {
    if (denied > 0 && String(from).includes(`${path.sep}.staging-`) && path.basename(String(to)) === '0.1.33') {
      denied -= 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return rename.call(fs, from, to, ...args);
  };
  try {
    await f.manager.update({ id: ID });
  } finally {
    fs.renameSync = rename;
  }
  const installed = readInstalledState(f.rootDir, f.entry);
  assert.equal(denied, 0);
  assert.equal(installed.installedVersion, '0.1.33');
  assert.equal(installed.packagePath, path.join(f.rootDir, 'store', 'subapp-aily-chat', '0.1.33', 'source'));
  assert.deepEqual(fs.readFileSync(path.join(legacy, 'package.json')), legacyBytes);
});

test('a rename that cannot be recovered reports update failure and keeps the previous version', async (t) => {
  const f = fixture(t, { managerOptions: { sleep: async () => {}, renameAttempts: 1 } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (String(from).includes(`${path.sep}.staging-`) && path.basename(String(to)) === '0.1.33') {
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
    }
    return rename.call(fs, from, to, ...args);
  };
  try {
    await assert.rejects(f.manager.update({ id: ID }), (error) => {
      assert.equal(error.code, 'SUBAPP_VERSION_PUBLISH_BUSY');
      assert.match(error.message, /更新失败/);
      assert.match(error.message, /0\.1\.32/);
      assert.match(error.message, /仍可继续使用/);
      return true;
    });
  } finally {
    fs.renameSync = rename;
  }
  const installed = readInstalledState(f.rootDir, f.entry);
  assert.equal(installed.installedVersion, '0.1.32');
  assert.equal(installed.packagePath, legacy);
  assert.equal(fs.existsSync(path.join(f.rootDir, 'store', 'subapp-aily-chat', 'active.json')), false);
});
