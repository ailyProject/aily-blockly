const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
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
const { createSubappLaunchReservations } = require('../../electron/subapp-launch-reservations');
const { isRetiredUninstallName, runSubappVersionCleanup } = require('../../electron/subapp-version-cleanup');
const { verifyBlocklyChatRuntime } = require('../../electron/blockly-chat-compatibility');

const ID = 'aily-chat';
const PACKAGE = '@aily-project/subapp-aily-chat';
const compatibility = {
  version: 1,
  blocklyAbs: { generation: 2, absSchema: 2, workingCandidateVersion: 1, publicMapSchemas: [1, 2], legacyDraftTakeover: 1 },
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

function compatibleChatArchive(version, { tampered = false, declaration = compatibility, ui = 'updated Chat' } = {}) {
  const files = {
    'package.json': JSON.stringify({
      name: PACKAGE, version, main: 'server/index.js',
      aily: { uiIndex: 'ui/index.html' },
      ailySubapp: { id: ID, compatibility: declaration },
      ailyPortable: { version: 1, format: 'js' },
    }),
    'server/index.js': 'module.exports=1', 'runtime/agent/index.js': 'module.exports=2',
    'ui/index.html': ui, 'i18n/en.json': '{}', 'vendor/runtime.js': 'module.exports=3',
  };
  const inputs = { 'index.js': sha256('source') };
  const outputs = Object.fromEntries(Object.entries(files).map(([file, content]) => [file, sha256(content)]));
  const fingerprint = { inputHash: sha256(JSON.stringify(inputs)), outputHash: sha256(JSON.stringify(outputs)) };
  files['runtime/build-evidence.json'] = JSON.stringify({ version: 1, ...fingerprint, inputs, outputs });
  if (tampered) files['runtime/agent/index.js'] = 'tampered';
  return { archive: npmTarball(files), fingerprint };
}

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
    app: { name: 'aily Chat', enabled: true },
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
    ailySubapp: { id: options.id || ID },
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

test('Blockly launch replaces an old same-version Chat with a verified artifact without switching the shared selection', async t => {
  const version = '0.1.53';
  const originalDeclaration = structuredClone(compatibility);
  delete originalDeclaration.blocklyAbs.legacyDraftTakeover;
  const original = compatibleChatArchive(version, { declaration: originalDeclaration });
  const f = fixture(t, { version, archive: original.archive });
  await f.manager.install({ id: ID });
  const selected = readInstalledState(f.rootDir, f.entry);
  const active = fs.readFileSync(versions.activePath(f.rootDir, f.entry), 'utf8');
  const compatible = compatibleChatArchive(version);
  const entry = catalogEntry(version, compatible.archive);
  let network = 0;
  let downloads = 0;
  const manager = createSubappManager({
    ...f.managerOptions,
    requireBlocklyChatCompatibility: true,
    fetchImpl: async () => {
      network++;
      return { ok: true, text: async () => JSON.stringify({ [ID]: entry }) };
    },
    downloadFile: async (_url, destination) => {
      downloads++;
      fs.writeFileSync(destination, compatible.archive);
    },
  });

  const replacement = await manager.prepareLaunch({ id: ID, deferPreparedUpdate: true });
  replacement.release();
  assert.equal(replacement.config.version, selected.installedVersion);
  assert.deepEqual(replacement.config.blocklyChatFingerprint, compatible.fingerprint);
  assert.notEqual(replacement.config.packagePath, selected.packagePath);
  assert.equal(replacement.config.env.AILY_SUBAPP_INSTALL_ROOT, f.rootDir);
  assert.equal(replacement.config.env.AILY_SUBAPP_SOURCE, 'blockly-compatibility');
  assert.equal(fs.readFileSync(versions.activePath(f.rootDir, f.entry), 'utf8'), active);
  assert.equal(readInstalledState(f.rootDir, f.entry).packagePath, selected.packagePath);
  assert.equal(downloads, 1);
  assert.equal(network, 1);

  const cached = await manager.prepareLaunch({ id: ID });
  cached.release();
  assert.equal(cached.config.packagePath, replacement.config.packagePath);
  assert.equal(network, 1);
  assert.equal(downloads, 1);
  assert.ok(f.calls.every(call => call.args[0] !== 'install'));
});

test('Blockly Chat must attest draft takeover and an unchanged portable payload', async t => {
  const noTakeover = { ...compatibility, blocklyAbs: { ...compatibility.blocklyAbs, legacyDraftTakeover: 0 } };
  for (const options of [{ declaration: noTakeover }, { tampered: true }]) {
    await t.test(JSON.stringify(options), async t => {
      const version = '0.1.53';
      const { archive } = compatibleChatArchive(version, options);
      const f = fixture(t, { version, archive, managerOptions: { requireBlocklyChatCompatibility: true } });
      writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), version);
      await assert.rejects(f.manager.prepareLaunch({ id: ID }), { code: 'BLOCKLY_CHAT_INCOMPATIBLE' });
      assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, version);
    });
  }
});

test('Blockly uses its verified fallback across restarts without rewriting a linked development catalog', async t => {
  const version = '0.1.53';
  const compatible = compatibleChatArchive(version);
  const f = fixture(t, { version, archive: compatible.archive });
  const link = packagePathFor(f.rootDir, PACKAGE);
  const oldSource = path.join(f.temporary, 'prior Chat');
  writeRunnablePackage(oldSource, version);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(oldSource, link, process.platform === 'win32' ? 'junction' : 'dir');
  const catalogPath = path.join(f.rootDir, 'subapp-index.json');
  const content = JSON.stringify({ [ID]: catalogEntry(version, Buffer.from('prior artifact')), dev: true });
  fs.writeFileSync(catalogPath, content);

  const options = { ...f.managerOptions, requireBlocklyChatCompatibility: true };
  const online = await createSubappManager(options).prepareLaunch({ id: ID });
  online.release();
  const offline = await createSubappManager({
    ...options,
    fetchImpl: async () => { throw new Error('offline'); },
  }).prepareLaunch({ id: ID });
  offline.release();
  assert.equal(offline.config.packagePath, online.config.packagePath);
  assert.deepEqual(offline.config.blocklyChatFingerprint, compatible.fingerprint);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), content);
  assert.equal(fs.realpathSync(link), fs.realpathSync(oldSource));
  assert.equal(f.downloads.length, 1);
});

test('a source development host launches the selected compatible Chat link without downloading a release', async t => {
  const f = fixture(t, { version: '0.1.53', managerOptions: {
    requireBlocklyChatCompatibility: true, allowBlocklyChatDevelopment: true,
  } });
  const entry = { ...f.entry, version: '0.1.53-dev' };
  const candidate = versions.createCandidate(f.rootDir, entry);
  writeRunnablePackage(candidate.source, entry.version);
  const manifestPath = path.join(candidate.source, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, ailySubapp: { compatibility } }));
  const development = await versions.publishCandidate(f.rootDir, entry, candidate, { installMode: 'development' });
  versions.activate(f.rootDir, entry, development, { mode: 'pinned' });

  const launch = await f.manager.prepareLaunch({ id: ID });
  launch.release();
  assert.equal(launch.config.version, entry.version);
  assert.deepEqual(launch.config.blocklyChatFingerprint, { development: true });
  assert.equal(f.downloads.length, 0);
  const releaseHost = createSubappManager({ ...f.managerOptions, allowBlocklyChatDevelopment: false });
  await assert.rejects(releaseHost.prepareLaunch({ id: ID }), { code: 'BLOCKLY_CHAT_INCOMPATIBLE' });
});

test('Blockly uses a verified newer prepared Chat only when idle and keeps it pinned across windows', async t => {
  const currentVersion = '0.1.53';
  const nextVersion = '0.1.54';
  const current = compatibleChatArchive(currentVersion);
  const next = compatibleChatArchive(nextVersion);
  const f = fixture(t, { version: currentVersion, archive: current.archive });
  await f.manager.install({ id: ID });
  const activePath = versions.activePath(f.rootDir, f.entry);
  const active = fs.readFileSync(activePath, 'utf8');
  const target = catalogEntry(nextVersion, next.archive);
  let running = null;
  const manager = createSubappManager({
    ...f.managerOptions,
    requireBlocklyChatCompatibility: true,
    getRunningSubappConfig: () => running,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: target }) }),
    downloadFile: async (_url, destination) => fs.writeFileSync(destination, next.archive),
  });
  await manager.list({ refresh: true });
  await manager.downloadUpdate({ id: ID });
  const selected = async (options = {}) => {
    const launch = await manager.prepareLaunch({ id: ID, ...options });
    launch.release();
    return launch.config;
  };

  const deferred = await selected({ deferPreparedUpdate: true });
  assert.equal(deferred.version, currentVersion);
  assert.deepEqual(deferred.blocklyChatFingerprint, current.fingerprint);
  running = deferred;
  assert.equal((await selected()).version, currentVersion);

  running = null;
  const upgraded = await selected();
  assert.equal(upgraded.version, nextVersion);
  assert.deepEqual(upgraded.blocklyChatFingerprint, next.fingerprint);
  assert.equal(upgraded.env.AILY_SUBAPP_SOURCE, 'blockly-compatibility');
  running = upgraded;
  assert.deepEqual(await selected({ deferPreparedUpdate: true }), upgraded);
  assert.equal(fs.readFileSync(activePath, 'utf8'), active);
});

test('Blockly advances a compatible fallback after ordinary background staging without touching the shared selector', async t => {
  const version = '0.1.53';
  const f = fixture(t, { version });
  await f.manager.install({ id: ID });
  const activePath = versions.activePath(f.rootDir, f.entry);
  const active = fs.readFileSync(activePath, 'utf8');
  const fallback = compatibleChatArchive(version);
  const upgrade = compatibleChatArchive('0.1.54');
  let target = catalogEntry(version, fallback.archive);
  let archive = fallback.archive;
  const manager = createSubappManager({
    ...f.managerOptions,
    requireBlocklyChatCompatibility: true,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: target }) }),
    downloadFile: async (_url, destination) => fs.writeFileSync(destination, archive),
  });
  const select = async options => {
    const launch = await manager.prepareLaunch({ id: ID, ...options });
    launch.release();
    return launch.config;
  };
  assert.deepEqual((await select()).blocklyChatFingerprint, fallback.fingerprint);

  target = catalogEntry('0.1.54', upgrade.archive);
  archive = upgrade.archive;
  await manager.list({ refresh: true });
  await manager.downloadUpdate({ id: ID });
  assert.deepEqual((await select({ deferPreparedUpdate: true })).blocklyChatFingerprint, fallback.fingerprint);
  assert.deepEqual((await select()).blocklyChatFingerprint, upgrade.fingerprint);
  assert.equal(fs.readFileSync(activePath, 'utf8'), active);
});

test('Blockly stages a changed same-version compatibility digest behind the verified fallback', async t => {
  const version = '0.1.53';
  const f = fixture(t, { version });
  await f.manager.install({ id: ID });
  const activePath = versions.activePath(f.rootDir, f.entry);
  const active = fs.readFileSync(activePath, 'utf8');
  const fallback = compatibleChatArchive(version);
  const rebuilt = compatibleChatArchive(version, { ui: 'second compatible Chat' });
  let target = catalogEntry(version, fallback.archive, { compatibility });
  let archive = fallback.archive;
  const manager = createSubappManager({
    ...f.managerOptions,
    requireBlocklyChatCompatibility: true,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: target }) }),
    downloadFile: async (_url, destination) => fs.writeFileSync(destination, archive),
  });
  const select = async () => {
    const launch = await manager.prepareLaunch({ id: ID });
    launch.release();
    return launch.config.blocklyChatFingerprint;
  };
  assert.deepEqual(await select(), fallback.fingerprint);

  target = catalogEntry(version, rebuilt.archive, { compatibility });
  archive = rebuilt.archive;
  await manager.list({ refresh: true });
  assert.deepEqual(await select(), fallback.fingerprint);
  const deadline = Date.now() + 5000;
  let selected;
  do {
    await new Promise(resolve => setTimeout(resolve, 40));
    selected = await select();
  } while (selected.outputHash !== rebuilt.fingerprint.outputHash && Date.now() < deadline);
  assert.deepEqual(selected, rebuilt.fingerprint);
  assert.equal(fs.readFileSync(activePath, 'utf8'), active);
});

for (const installedCompatible of [false, true]) {
  test(`Blockly refreshes a same-version Chat from a registry-backed catalog (compatible install: ${installedCompatible})`, async t => {
    const version = '0.1.53';
    const fallback = compatibleChatArchive(version);
    const rebuilt = compatibleChatArchive(version, { ui: 'rebuilt without a catalog tarball digest' });
    const f = fixture(t, { version, ...(installedCompatible ? { archive: fallback.archive } : {}) });
    await f.manager.install({ id: ID });
    const { dist: _distribution, ...entry } = catalogEntry(version, fallback.archive, { compatibility });
    const activePath = versions.activePath(f.rootDir, f.entry);
    const active = fs.readFileSync(activePath, 'utf8');
    let archive = fallback.archive;
    let running = null;
    let lookups = 0;
    let downloads = 0;
    const manager = createSubappManager({
      ...f.managerOptions,
      requireBlocklyChatCompatibility: true,
      getRunningSubappConfig: () => running,
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [ID]: entry }) }),
      runNpm: async args => {
        assert.deepEqual(args, ['view', `${PACKAGE}@${version}`, 'dist', '--json']);
        lookups++;
        return { stdout: JSON.stringify(catalogEntry(version, archive).dist) };
      },
      downloadFile: async (_url, destination) => {
        downloads++;
        fs.writeFileSync(destination, archive);
      },
    });
    const select = async () => {
      const launch = await manager.prepareLaunch({ id: ID });
      launch.release();
      return launch.config;
    };

    running = await select();
    assert.deepEqual(running.blocklyChatFingerprint, fallback.fingerprint);
    const initialLookups = lookups;
    const initialDownloads = downloads;
    await select();
    assert.equal(lookups, initialLookups);

    archive = rebuilt.archive;
    await manager.list({ refresh: true });
    assert.deepEqual(await select(), running);
    running = null;
    const deadline = Date.now() + 2500;
    let selected;
    do {
      selected = await select();
      if (selected.blocklyChatFingerprint.outputHash === rebuilt.fingerprint.outputHash) break;
      await new Promise(resolve => setTimeout(resolve, 35));
    } while (Date.now() < deadline);
    assert.deepEqual(selected.blocklyChatFingerprint, rebuilt.fingerprint);
    assert.equal(lookups, initialLookups + 1);
    assert.equal(downloads, initialDownloads + 1);
    assert.equal(fs.readFileSync(activePath, 'utf8'), active);

    // The private package stays available with the same on-disk catalog offline.
    const offline = createSubappManager({
      ...f.managerOptions,
      requireBlocklyChatCompatibility: true,
      fetchImpl: async () => { throw new Error('offline'); },
      runNpm: async () => { assert.fail('A cached catalog should not probe the registry'); },
    });
    const launch = await offline.prepareLaunch({ id: ID });
    launch.release();
    assert.deepEqual(launch.config.blocklyChatFingerprint, rebuilt.fingerprint);

    if (installedCompatible) {
      const installedLater = compatibleChatArchive(version, { ui: 'manually reinstalled shared Chat' });
      const installer = createSubappManager({
        ...f.managerOptions,
        fetchImpl: async () => ({
          ok: true,
          text: async () => JSON.stringify({ [ID]: catalogEntry(version, installedLater.archive) }),
        }),
        downloadFile: async (_url, destination) => fs.writeFileSync(destination, installedLater.archive),
      });
      await installer.list({ refresh: true });
      await installer.reinstall({ id: ID });
      const afterReinstall = await offline.prepareLaunch({ id: ID });
      afterReinstall.release();
      assert.deepEqual(afterReinstall.config.blocklyChatFingerprint, installedLater.fingerprint);
    }
  });
}

test('Blockly refreshes Chat without opening it and ignores late catalog or registry results', { timeout: 7000 }, async t => {
  const version = '0.1.53';
  const shared = compatibleChatArchive(version);
  const older = compatibleChatArchive(version, { ui: 'older background Chat' });
  const latest = compatibleChatArchive(version, { ui: 'latest background Chat' });
  const f = fixture(t, { version, archive: shared.archive });
  await f.manager.install({ id: ID });
  const activePath = versions.activePath(f.rootDir, f.entry);
  const active = fs.readFileSync(activePath, 'utf8');
  const index = name => {
    const { dist: _distribution, ...entry } = catalogEntry(version, shared.archive, {
      compatibility, app: { name, enabled: true },
    });
    return { ok: true, text: async () => JSON.stringify({ [ID]: entry }) };
  };
  const olderRegistry = Promise.withResolvers();
  const oldCatalog = Promise.withResolvers();
  const registryStarted = Promise.withResolvers();
  const oldCatalogStarted = Promise.withResolvers();
  t.after(() => {
    olderRegistry.resolve();
    oldCatalog.resolve();
  });
  let catalogCalls = 0;
  let registryCalls = 0;
  const downloads = [];
  const manager = createSubappManager({
    ...f.managerOptions,
    requireBlocklyChatCompatibility: true,
    fetchImpl: async () => {
      switch (++catalogCalls) {
        case 1: return index('First');
        case 2:
          oldCatalogStarted.resolve();
          await oldCatalog.promise;
          return index('Stale');
        default: return index('Latest');
      }
    },
    runNpm: async () => {
      let update = latest;
      if (++registryCalls === 1) {
        registryStarted.resolve();
        await olderRegistry.promise;
        update = older;
      }
      const { integrity } = catalogEntry(version, update.archive).dist;
      return { stdout: JSON.stringify({ tarball: `https://packages.example.test/${integrity}.tgz`, integrity }) };
    },
    downloadFile: async (url, file) => {
      downloads.push(url);
      fs.writeFileSync(file, latest.archive);
    },
  });
  const select = async () => {
    const launch = await manager.prepareLaunch({ id: ID });
    launch.release();
    return launch.config.blocklyChatFingerprint;
  };

  await manager.list({ refresh: true });
  await registryStarted.promise;
  assert.deepEqual(await select(), shared.fingerprint);
  const late = manager.list({ refresh: true });
  await oldCatalogStarted.promise;
  const fresh = await manager.list({ refresh: true });
  assert.equal(fresh.apps[0].name, 'Latest');
  const deadline = Date.now() + 2500;
  let selected;
  do {
    selected = await select();
    if (selected.outputHash === latest.fingerprint.outputHash) break;
    await new Promise(resolve => setTimeout(resolve, 35));
  } while (Date.now() < deadline);
  assert.deepEqual(selected, latest.fingerprint);
  oldCatalog.resolve();
  assert.equal((await late).apps[0].name, 'Latest');
  olderRegistry.resolve();
  assert.deepEqual(await select(), latest.fingerprint);
  assert.equal(registryCalls, 2);
  assert.equal(downloads.length, 1);
  assert.equal(fs.readFileSync(activePath, 'utf8'), active);
});

test('Blockly Chat distinguishes a live compatibility mismatch from unavailable evidence', async () => {
  const { fingerprint } = compatibleChatArchive('0.1.53');
  const health = { ok: true, state: 'ready', compatibility, buildEvidence: { version: 1, ...fingerprint } };
  const url = 'http://127.0.0.1:3234/';
  const response = body => async (target, options) => {
    assert.equal(target.href, `${url}health`);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => body };
  };
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, response(health)), 'verified');
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, response({ ...health, compatibility: undefined })), 'incompatible');
  const development = { development: true };
  const devHealth = { ...health, buildEvidence: null };
  assert.equal(await verifyBlocklyChatRuntime(url, development, response(devHealth)), 'unavailable');
  assert.equal(await verifyBlocklyChatRuntime(url, development, response(devHealth), { allowDevelopment: true }), 'verified');
  assert.equal(await verifyBlocklyChatRuntime(url, development, response({ ...devHealth, compatibility: undefined }),
    { allowDevelopment: true }), 'incompatible');
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, response({
    ...health, buildEvidence: { ...health.buildEvidence, outputHash: 'a'.repeat(64) },
  })), 'incompatible');
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, response({ ...health, state: 'starting' })), 'unavailable');
  assert.equal(await verifyBlocklyChatRuntime('http://192.0.2.5:3234/', fingerprint, response(health)), 'unavailable');
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, async () => { throw new Error('timed out'); }), 'unavailable');

  let attempts = 0;
  const intermittent = async (...args) => {
    if (++attempts === 1) throw new Error('timed out');
    return response(health)(...args);
  };
  assert.equal(await verifyBlocklyChatRuntime(url, fingerprint, intermittent, { retryUnavailable: true }), 'verified');
  assert.equal(attempts, 2);
  attempts = 0;
  const intermittentDevelopment = async (...args) => {
    if (++attempts === 1) return response({ ...devHealth, state: 'starting' })(...args);
    return response(devHealth)(...args);
  };
  assert.equal(await verifyBlocklyChatRuntime(url, development, intermittentDevelopment,
    { allowDevelopment: true, retryUnavailable: true }), 'verified');
  assert.equal(attempts, 2);
});

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
  const release = acquireInstallLock(versions.selectionLockPath(f.rootDir, f.entry));
  try {
    await assert.rejects(f.manager.installUpdate({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
    assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '0.1.32');
  } finally { release(); }
  await f.manager.installUpdate({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
});

test('wall clock adjustment does not expire a legitimate selection wait', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { lockTimeoutMs: 600 } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const release = acquireInstallLock(versions.selectionLockPath(f.rootDir, f.entry));
  const now = Date.now;
  let offset = 0;
  const clock = t.mock.method(Date, 'now', () => now() + offset);
  const jumping = setTimeout(() => { offset = 10 * 60 * 1000; }, 25);
  const releasing = setTimeout(release, 180);
  try {
    const started = await f.manager.prepareLaunch({ id: ID });
    started.release();
    assert.equal(started.config.version, '0.1.32');
  } finally {
    clearTimeout(jumping);
    clearTimeout(releasing);
    clock.mock.restore();
    release();
  }
});

function launchOwner() {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false });
}

function launchCommand(config) {
  return {
    command: 'node', cwd: config.packagePath,
    args: [path.join(config.packagePath, config.entry)],
    env: { AILY_CHILD_TOOL_ID: config.id },
  };
}

test('a live renderer which drops the launch handshake cannot strand the real selection lock', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { lockTimeoutMs: 400 } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const launches = createSubappLaunchReservations({ dispatchTimeoutMs: 25 });
  const owner = launchOwner();
  const retryOwner = launchOwner();
  const select = signal => f.manager.prepareLaunch({ id: ID }, signal);
  const abandoned = await launches.prepare(owner, ID, select);
  const selectionLock = versions.selectionLockPath(f.rootDir, f.entry);
  const free = acquireInstallLock(selectionLock);
  assert.equal(typeof free, 'function');
  free();

  const retry = await launches.prepare(retryOwner, ID, select);
  try {
    assert.equal(retry.config.version, '0.1.32');
    assert.throws(() => launches.bindCommand(abandoned.token, owner, 'late', launchCommand(abandoned.config)),
      { code: 'SUBAPP_LAUNCH_EXPIRED' });
    assert.equal(owner.listenerCount('destroyed'), 0);
    const binding = launches.bindCommand(retry.token, retryOwner, 'fresh', launchCommand(retry.config));
    await binding.waitForDispatch();
    assert.equal(acquireInstallLock(selectionLock), null);
    binding.spawned();
    const released = acquireInstallLock(selectionLock);
    assert.equal(typeof released, 'function');
    released();
  } finally { launches.finish(retry.token, retryOwner); }
});

test('a second host restores the verified active version after a process dies mid-replacement', { timeout: 10000 }, async t => {
  const f = fixture(t);
  await f.manager.install({ id: ID });
  const first = readInstalledState(f.rootDir, f.entry);
  const crashingHost = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const { randomUUID } = require('node:crypto');
    const { acquireInstallLock } = require(process.argv[1]);
    const [dir, selection, preparation] = process.argv.slice(2);
    const ownsPreparation = acquireInstallLock(preparation);
    const ownsSelection = acquireInstallLock(selection);
    if (!ownsPreparation || !ownsSelection) throw Error('test host could not acquire locks');
    fs.renameSync(dir, path.join(path.dirname(dir), '.replaced-' + path.basename(dir) + '-' + randomUUID()));
    process.stdout.write('moved\\n');
    setInterval(() => {}, 1000);
  `, require.resolve('../../electron/subapp-install-lock'), path.dirname(first.packagePath),
  versions.selectionLockPath(f.rootDir, f.entry), path.join(f.rootDir, 'store', '.locks', versions.storeKeyForPackage(PACKAGE))],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => crashingHost.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      crashingHost.once('error', reject);
      crashingHost.once('exit', code => reject(new Error(`Replacement host exited prematurely (${code})`)));
      crashingHost.stdout.once('data', () => resolve());
    });
    assert.equal(fs.existsSync(first.packagePath), false);
  } finally {
    crashingHost.kill('SIGKILL');
    await exited;
  }
  const newHost = createSubappManager(f.managerOptions);
  const selected = await newHost.prepareLaunch({ id: ID });
  assert.equal(selected.config.version, first.installedVersion);
  assert.equal(selected.config.packagePath, first.packagePath);
  assert.equal(typeof selected.lockForDispatch, 'function');
  const release = await selected.lockForDispatch();
  release();
  assert.equal(f.downloads.length, 1);
});

test('a spawned but unready runtime frees selection for another host and its update', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { lockTimeoutMs: 200 } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  await f.manager.downloadUpdate({ id: ID });
  const launches = createSubappLaunchReservations();
  const owner = launchOwner();
  const select = signal => f.manager.prepareLaunch({ id: ID, deferPreparedUpdate: true }, signal);
  const started = await launches.prepare(owner, ID, select);
  let stopped = 0;
  const command = launchCommand(started.config);
  assert.throws(() => launches.bindCommand(started.token, launchOwner(), 'unowned', command),
    { code: 'SUBAPP_LAUNCH_EXPIRED' });
  const binding = launches.bindCommand(started.token, owner, 'starting', command, () => { stopped++; });
  binding.spawned();
  // The renderer has sent neither ready registration nor finish. A separate
  // manager must still be able to switch the active locator to a new generation.
  const other = createSubappManager(f.managerOptions);
  await other.installUpdate({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
  assert.ok(fs.existsSync(command.args[0]));

  const nextOwner = launchOwner();
  let entered = false;
  const next = launches.prepare(nextOwner, ID, signal => { entered = true; return select(signal); });
  assert.equal(entered, false, 'windows still serialize startup of the same tool');
  owner.emit('render-process-gone');
  assert.equal(stopped, 1);
  const registration = { toolId: ID, streamId: 'starting', hostInfo: { packagePath: command.cwd } };
  assert.throws(() => launches.checkRegistration(started.token, owner, registration), { code: 'SUBAPP_LAUNCH_EXPIRED' });
  const replacement = await next;
  launches.finish(replacement.token, nextOwner);
});

test('navigation while requesting selection cannot leave a lock or return a launch token', { timeout: 5000 }, async t => {
  const f = fixture(t);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const launches = createSubappLaunchReservations();
  const owner = launchOwner();
  const abandoned = launches.prepare(owner, ID, async signal => {
    const selection = await f.manager.prepareLaunch({ id: ID }, signal);
    owner.emit('did-start-navigation', {}, 'file:///next', false, true);
    return selection;
  });
  await assert.rejects(abandoned, { code: 'SUBAPP_LAUNCH_OWNER_CLOSED' });
  const next = await f.manager.prepareLaunch({ id: ID });
  next.release();
});

test('a live renderer which abandons a spawned runtime cannot register it later', { timeout: 5000 }, async t => {
  const f = fixture(t);
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const launches = createSubappLaunchReservations({ runtimeGraceMs: 20 });
  const owner = launchOwner();
  const prepared = await launches.prepare(owner, ID, async signal => {
    const result = await f.manager.prepareLaunch({ id: ID }, signal);
    return { ...result, config: { ...result.config, startupTimeoutMs: 20 } };
  });
  let finishStop;
  const stopped = new Promise(resolve => { finishStop = resolve; });
  launches.bindCommand(prepared.token, owner, 'abandoned', launchCommand(prepared.config), finishStop).spawned();
  const retryOwner = launchOwner();
  const retry = launches.prepare(retryOwner, ID, signal => f.manager.prepareLaunch({ id: ID }, signal));
  await stopped;
  const registration = { toolId: ID, streamId: 'abandoned', hostInfo: { packagePath: prepared.config.packagePath } };
  assert.throws(() => launches.checkRegistration(prepared.token, owner, registration), { code: 'SUBAPP_LAUNCH_EXPIRED' });
  const next = await retry;
  launches.finish(next.token, retryOwner);
  assert.equal(next.config.version, '0.1.32');
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

test('a slow uninstall fences new launches without blocking another app', { timeout: 5000 }, async t => {
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

test('uninstall protects a starting process which appeared before the uninstall marker', async t => {
  let stops = 0;
  const f = fixture(t, { managerOptions: {
    forceStopChildToolByCatalogId: async () => { stops++; return { success: true }; },
    listChildToolHolders: () => stops >= 2 ? [{ pid: 43210, source: 'child-tool-startup' }] : [],
    listBusyHolders: async () => [],
  } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await assert.rejects(f.manager.uninstall({ id: ID }), error => error.requiresForceClose === true);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.ok(fs.existsSync(path.join(legacy, 'package.json')));
});

test('a Windows-style first detach failure preserves the installation and leaves the selection lock free', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { platform: 'win32', listBusyHolders: async () => [], sleep: async () => {} } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const rename = fs.promises.rename;
  const mock = t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (source === legacy) throw Object.assign(new Error('EPERM rename busy'), { code: 'EPERM' });
    return rename(source, destination);
  });
  await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'EBUSY' });
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '0.1.32');
  const free = acquireInstallLock(versions.selectionLockPath(f.rootDir, f.entry));
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

test('background cleanup waits for process inventory and releases obsolete versions silently', async t => {
  const id = 'fixture-tool';
  const entry = catalogEntry('0.1.33', Buffer.from('fixture-tool'), {
    id,
    package: '@aily-project/subapp-fixture-tool',
    namespace: 'FIXTURE_TOOL',
    titleKey: 'FIXTURE_TOOL.NAME',
  });
  const events = [];
  const probes = [];
  let otherHostRunning = true;
  let hostChecks = 0;
  let inventory = 'unavailable';
  const f = fixture(t, { managerOptions: {
    backgroundVersionCleanup: true,
    versionCleanupDelayMs: 0,
    versionCleanupRetryMs: 20,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [id]: entry }) }),
    onChanged: event => events.push(event),
    onProgress: event => events.push(event),
    canMutateSharedTree: () => {
      hostChecks += 1;
      return !otherHostRunning;
    },
    hasProcessesUsingPath: async directory => {
      probes.push(directory);
      if (inventory === 'unavailable') throw new Error('process inventory unavailable');
      return inventory === 'busy' && path.basename(directory) === '0.1.30';
    },
  } });
  const releases = new Map();
  for (const version of ['0.1.29', '0.1.30', '0.1.31', '0.1.32', entry.version]) {
    const release = { ...entry, version };
    const candidate = versions.createCandidate(f.rootDir, release);
    writeRunnablePackage(candidate.source, version, { name: entry.package, id });
    const ready = await versions.publishCandidate(f.rootDir, release, candidate);
    releases.set(version, ready.project);
    if (version === '0.1.32' || version === entry.version) versions.activate(f.rootDir, release, ready);
  }
  const parent = path.dirname(releases.get(entry.version));
  const activePath = versions.activePath(f.rootDir, entry);
  const active = fs.readFileSync(activePath);
  const waitFor = async (predicate, message) => {
    const deadline = performance.now() + 3000;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), message);
  };

  const catalog = await f.manager.list({ refresh: true });
  assert.equal(catalog.apps[0].installedVersion, entry.version);
  await waitFor(() => hostChecks > 0, 'background cleanup should check other hosts');
  assert.deepEqual(probes, []);
  otherHostRunning = false;
  await waitFor(() => probes.length > 0, 'background cleanup should check process inventory');
  for (const directory of releases.values()) assert.ok(fs.existsSync(directory));

  inventory = 'busy';
  await waitFor(() => !fs.existsSync(releases.get('0.1.29')), 'the unused version should be reclaimed');
  assert.ok(fs.existsSync(releases.get('0.1.30')), 'the occupied version should remain');

  inventory = 'idle';
  await waitFor(() => !fs.existsSync(releases.get('0.1.30'))
    && !fs.readdirSync(parent).some(name => name.startsWith('.retired-')), 'cleanup should finish after release');
  assert.deepEqual(fs.readdirSync(parent).sort(), ['0.1.31', '0.1.32', '0.1.33', 'active.json']);
  assert.deepEqual(fs.readFileSync(activePath), active);
  assert.deepEqual(events, []);
  assert.deepEqual(f.downloads, []);
  assert.deepEqual(f.calls, []);
});

test('stalled cleanup inventory times out without blocking either foreground session or update', { timeout: 10000 }, async t => {
  const otherId = 'fixture-tool';
  const otherPackage = '@aily-project/subapp-fixture-tool';
  const otherVersion = '0.1.33';
  const otherArchive = portableSubappTarball({ packageName: otherPackage, version: otherVersion, id: otherId });
  const other = catalogEntry(otherVersion, otherArchive, {
    id: otherId, package: otherPackage, namespace: 'FIXTURE_TOOL', titleKey: 'FIXTURE_TOOL.NAME',
  });
  const cleanupStarted = Promise.withResolvers();
  const cleanupRetried = Promise.withResolvers();
  const stalled = Promise.withResolvers();
  const progress = [];
  let checks = 0;
  const f = fixture(t, { version: '0.1.34', managerOptions: {
    backgroundVersionCleanup: true,
    versionCleanupDelayMs: 0,
    versionCleanupRetryMs: 20,
    versionCleanupTimeoutMs: 2500,
    lockTimeoutMs: 250,
    downloadFile: async (url, destination) => {
      fs.writeFileSync(destination, url === other.dist.tarball ? otherArchive : f.archive);
    },
    onProgress: event => progress.push(event),
    hasProcessesUsingPath: async directory => {
      if (path.basename(directory) !== '0.1.30') return true;
      checks += 1;
      if (checks === 1) {
        cleanupStarted.resolve(directory);
        return stalled.promise;
      }
      cleanupRetried.resolve();
      throw new Error('inventory is still unavailable');
    },
  } });
  const publish = async (entry, version) => {
    const release = { ...entry, version };
    const candidate = versions.createCandidate(f.rootDir, release);
    writeRunnablePackage(candidate.source, version, { name: entry.package, id: entry.id });
    return versions.publishCandidate(f.rootDir, release, candidate);
  };
  for (const version of ['0.1.30', '0.1.31', '0.1.32', '0.1.33']) {
    const ready = await publish(f.entry, version);
    if (version === '0.1.32' || version === '0.1.33') versions.activate(f.rootDir, f.entry, ready);
  }
  versions.activate(f.rootDir, other, await publish(other, '0.1.32'));
  fs.writeFileSync(path.join(f.rootDir, 'subapp-index.json'), JSON.stringify({ [ID]: f.entry, [otherId]: other }));

  const launches = createSubappLaunchReservations();
  const verifyLaunch = async (id, version) => {
    const owner = launchOwner();
    const selection = await launches.prepare(owner, id, signal => f.manager.prepareLaunch({ id }, signal));
    const { token, config } = selection;
    try {
      assert.equal(config.version, version);
      const command = launchCommand(config);
      assert.ok(fs.existsSync(command.args[0]));
      launches.bindCommand(token, owner, id, command).spawned();
      launches.checkRegistration(token, owner, {
        toolId: id, streamId: id, hostInfo: { packagePath: config.packagePath },
      })();
    } finally { launches.finish(token, owner); }
  };

  try {
    await f.manager.list({ strategy: 'cache-only' });
    const oldest = await cleanupStarted.promise;
    const lockRoot = path.join(f.rootDir, 'store', '.locks');
    for (const directory of [lockRoot, path.join(lockRoot, versions.storeKeyForPackage(PACKAGE))]) {
      const release = acquireInstallLock(directory);
      assert.ok(release, `cleanup must leave ${directory} free`);
      release();
    }
    await verifyLaunch(ID, '0.1.33');
    await verifyLaunch(otherId, '0.1.32');
    await f.manager.update({ id: ID });
    await f.manager.update({ id: otherId });
    await verifyLaunch(ID, f.entry.version);
    await verifyLaunch(otherId, otherVersion);
    assert.deepEqual(new Set(progress.filter(event => event.phase === 'complete').map(event => event.id)), new Set([ID, otherId]));
    assert.ok(progress.every(event => event.action === 'update' && event.phase !== 'error'));
    assert.equal(checks, 1, 'foreground operations should complete before cleanup retries');

    await cleanupRetried.promise;
    assert.ok(fs.existsSync(oldest), 'unverified inventory must leave the obsolete release intact');
  } finally {
    stalled.resolve(true);
  }
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
    'ui/index.html': '<h1>aily Coder</h1>',
  });
  const entry = {
    id,
    package: packageName,
    version,
    namespace: 'AILY_CODER_EDITOR',
    titleKey: 'AILY_CODER_EDITOR.TITLE',
    app: { name: 'aily Coder Editor', enabled: true, extension: true },
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

test('manual removal survives a manager restart and a failed reinstall; successful reinstall clears it', async t => {
  const f = fixture(t);
  assert.equal((await f.manager.list()).apps[0].manuallyUninstalled, false);
  await f.manager.install({ id: ID });
  const removed = await f.manager.uninstall({ id: ID });
  assert.equal(removed.apps[0].installed, false);
  assert.equal(removed.apps[0].manuallyUninstalled, true);
  const restarted = createSubappManager(f.managerOptions);
  assert.equal((await restarted.list()).apps[0].manuallyUninstalled, true);
  const offline = createSubappManager({ ...f.managerOptions,
    downloadFile: async () => { throw new Error('offline'); },
  });
  await assert.rejects(offline.install({ id: ID }), /offline/);
  assert.equal((await restarted.list()).apps[0].manuallyUninstalled, true);
  const installed = await restarted.install({ id: ID });
  assert.equal(installed.apps[0].installed, true);
  assert.equal(installed.apps[0].manuallyUninstalled, false);
  assert.equal(versions.isManuallyUninstalled(f.rootDir, f.entry), false);
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
  assert.equal(versions.isManuallyUninstalled(f.rootDir, f.entry), false);
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
      listBusyHolders: async () => killed ? [] : [{ pid: 43211, name: 'node.exe' }],
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

for (const persistent of [false, true]) {
  test(`reinstall keeps concurrent launches waiting until ${persistent ? 'rollback restores the old directory' : 'publication finishes'}`, { timeout: 5000 }, async t => {
    let entered, resume;
    const retrying = new Promise(resolve => { entered = resolve; });
    const resumed = new Promise(resolve => { resume = resolve; });
    const f = fixture(t, { managerOptions: { renameAttempts: 1, sleep: async () => { entered(); await resumed; } } });
    await f.manager.install({ id: ID });
    const originalState = readInstalledState(f.rootDir, f.entry);
    fs.writeFileSync(path.join(originalState.packagePath, 'old-marker.txt'), 'original');
    const rename = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (from, to, ...args) => {
      if (path.basename(String(from)).startsWith('.staging-') && path.basename(String(to)) === f.entry.version
        && (++attempts === 1 || persistent)) {
        throw Object.assign(new Error('EPERM rename staging fixture'), { code: 'EPERM' });
      }
      return rename(from, to, ...args);
    };
    const outcome = f.manager.reinstall({ id: ID }).then(() => null, error => error);
    let launch;
    try {
      await retrying;
      let settled = false;
      launch = createSubappManager(f.managerOptions).prepareLaunch({ id: ID }).then(
        value => { settled = true; return value; }, error => { settled = true; throw error; });
      // Attach immediately so a regression rejection is reported by the assertion, not as unhandled.
      launch.catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(settled, false, 'launch must wait for publication/rollback rather than see a missing installation');
    } finally {
      resume();
      const error = await outcome;
      fs.renameSync = rename;
      const started = await launch?.catch(() => null);
      if (launch) assert.ok(started, 'launch must succeed after the critical section ends');
      if (started) {
        assert.equal(started.config.version, f.entry.version);
        assert.ok(fs.existsSync(path.join(started.config.packagePath, started.config.entry)));
        started.release();
      }
      if (persistent) {
        assert.equal(error?.code, 'SUBAPP_VERSION_PUBLISH_BUSY');
        assert.equal(fs.readFileSync(path.join(originalState.packagePath, 'old-marker.txt'), 'utf8'), 'original');
      } else assert.equal(error, null);
    }
  });
}

test('reinstall rechecks holders after preparation before moving the selected directory', async t => {
  let busy = false;
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => busy ? [{ pid: 43210 }] : [] } });
  await f.manager.install({ id: ID });
  const source = readInstalledState(f.rootDir, f.entry).packagePath;
  fs.writeFileSync(path.join(source, 'old-marker.txt'), 'original');
  const manager = createSubappManager({ ...f.managerOptions, downloadFile: async (_url, file) => {
    fs.writeFileSync(file, f.archive); busy = true;
  } });
  await assert.rejects(manager.reinstall({ id: ID }), { code: 'EBUSY' });
  assert.equal(fs.readFileSync(path.join(source, 'old-marker.txt'), 'utf8'), 'original');
  const launch = await f.manager.prepareLaunch({ id: ID }); launch.release();
});

test('reinstall restores the original generation when a runnable entry disappears during publication', async t => {
  const f = fixture(t);
  await f.manager.install({ id: ID });
  const original = readInstalledState(f.rootDir, f.entry);
  fs.writeFileSync(path.join(original.packagePath, 'old-marker.txt'), 'preserve');
  const active = fs.readFileSync(versions.activePath(f.rootDir, f.entry), 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    const result = rename(from, to, ...args);
    if (path.basename(String(from)).startsWith('.staging-')) fs.rmSync(path.join(to, 'source/server/index.js'));
    return result;
  };
  try { await assert.rejects(f.manager.reinstall({ id: ID }), /runtime is incomplete/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(original.packagePath, 'old-marker.txt'), 'utf8'), 'preserve');
  assert.equal(fs.readFileSync(versions.activePath(f.rootDir, f.entry), 'utf8'), active);
  const launch = await f.manager.prepareLaunch({ id: ID });
  assert.ok(fs.existsSync(path.join(launch.config.packagePath, launch.config.entry))); launch.release();
});

for (const action of ['update', 'installUpdate']) {
  for (const missing of ['server/index.js', 'ui/index.html']) {
    test(`${action} rebuilds a downloaded generation missing ${missing} before reporting success`, async t => {
      const f = fixture(t);
      const previousEntry = { ...f.entry, version: '0.1.32' };
      const candidate = versions.createCandidate(f.rootDir, previousEntry);
      writeRunnablePackage(candidate.source, previousEntry.version);
      const previous = await versions.publishCandidate(f.rootDir, previousEntry, candidate);
      versions.activate(f.rootDir, previousEntry, previous);
      await f.manager.downloadUpdate({ id: ID });
      const target = path.join(f.rootDir, 'store/subapp-aily-chat', f.entry.version, 'source', missing);
      fs.rmSync(target);
      const downloadsBefore = f.downloads.length;
      const manager = action === 'installUpdate' ? createSubappManager({ ...f.managerOptions,
        downloadFile: async () => { throw new Error('Install downloaded updates must stay offline'); },
      }) : f.manager;
      try {
        await manager[action]({ id: ID });
        assert.ok(fs.existsSync(target), 'the runnable entry must be restored, not just its completion receipt');
        assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, f.entry.version);
        const launch = await manager.prepareLaunch({ id: ID });
        assert.equal(launch.config.version, f.entry.version); launch.release();
        if (action === 'installUpdate') assert.equal(f.downloads.length, downloadsBefore);
        assert.ok(fs.existsSync(path.join(previous.packagePath, 'server/index.js')));
      } finally {
        // Failed pre-fix assertions can schedule a background repair; drain it before fixture cleanup.
        await manager.downloadUpdate({ id: ID }).catch(() => {});
      }
    });
  }
}

test('offline activation rejects a damaged cached archive and preserves the selected runtime', async t => {
  const f = fixture(t);
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await f.manager.downloadUpdate({ id: ID });
  const project = path.join(f.rootDir, 'store/subapp-aily-chat', f.entry.version);
  fs.rmSync(path.join(project, 'source/server/index.js'));
  fs.writeFileSync(path.join(project, 'package.tgz'), 'corrupt archive');
  const manager = createSubappManager({ ...f.managerOptions,
    downloadFile: async () => { throw new Error('Offline activation must not download'); },
  });
  await assert.rejects(manager.installUpdate({ id: ID }), /integrity verification failed/);
  assert.equal(readInstalledState(f.rootDir, f.entry).installedVersion, '0.1.32');
  assert.equal(fs.existsSync(versions.activePath(f.rootDir, f.entry)), false);
  // Drain a catalog-triggered retry before deleting the fixture.
  await manager.downloadUpdate({ id: ID }).catch(() => {});
});


test('feedback diagnostics report missing Chat without network or background installation', t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.diagnostics(), { ailyChat: {
    installed: false, installedVersion: null, selectedVersion: null, selectedSource: null,
    running: false, runningVersion: null, runningSource: null,
  } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.downloads.length, 0);
});

test('feedback distinguishes selected installed Chat from an older running runtime', t => {
  const f = fixture(t, { managerOptions: { getRunningSubappConfig: () => ({ version: '0.1.30',
    env: { AILY_SUBAPP_SOURCE: 'portable' } }) } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.33');
  const chat = f.manager.diagnostics().ailyChat;
  assert.equal(chat.installed, true);
  assert.equal(chat.installedVersion, '0.1.33');
  assert.equal(chat.selectedVersion, '0.1.33');
  assert.equal(chat.selectedSource, 'legacy-npm');
  assert.equal(chat.runningVersion, '0.1.30');
  assert.equal(chat.runningSource, 'portable');
  assert.equal(f.calls.length, 0);
});

test('a stalled private staging cleanup leaves launch, update failure and uninstall independent', { timeout: 5000 }, async t => {
  const url = await transferServer(t, (_request, response) => { response.writeHead(503); response.end(); });
  const f = fixture(t, { managerOptions: { downloadFile: undefined, listBusyHolders: async () => [] } });
  f.entry.dist.tarball = url;
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');

  const cleanupStarted = Promise.withResolvers();
  const releaseCleanup = Promise.withResolvers();
  const cleanupEnded = Promise.withResolvers();
  const rm = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (target, options) => {
    if (!path.basename(target).startsWith('.staging-')) return rm(target, options);
    cleanupStarted.resolve();
    await releaseCleanup.promise;
    try { return await rm(target, options); } finally { cleanupEnded.resolve(); }
  });

  const failed = assert.rejects(f.manager.downloadUpdate({ id: ID }), /HTTP 503/);
  await cleanupStarted.promise;
  try {
    await failed;
    const launch = await f.manager.prepareLaunch({ id: ID });
    assert.equal(launch.config.version, '0.1.32'); launch.release();
    await f.manager.uninstall({ id: ID });
    assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
  } finally {
    releaseCleanup.resolve();
    await cleanupEnded.promise;
  }
});

test('uninstall bounds its join with a download that does not acknowledge cancellation', { timeout: 5000 }, async t => {
  const downloadStarted = Promise.withResolvers();
  const releaseDownload = Promise.withResolvers();
  const f = fixture(t, { managerOptions: {
    lockTimeoutMs: 60, listBusyHolders: async () => [],
    downloadFile: async (_url, _destination, _progress, { signal }) => {
      downloadStarted.resolve();
      await releaseDownload.promise;
      signal.throwIfAborted();
    },
  } });
  writeRunnablePackage(packagePathFor(f.rootDir, PACKAGE), '0.1.32');
  const cancelled = assert.rejects(f.manager.downloadUpdate({ id: ID }), { code: 'SUBAPP_CANCELLED' });
  await downloadStarted.promise;
  try {
    await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
    assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
    const launch = await f.manager.prepareLaunch({ id: ID });
    assert.equal(launch.config.version, '0.1.32'); launch.release();
  } finally {
    releaseDownload.resolve();
    await cancelled;
  }
  await f.manager.uninstall({ id: ID });
  assert.equal(readInstalledState(f.rootDir, f.entry).installed, false);
});

test('an interrupted uninstall can replace a malformed marker and finish explicitly', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  versions.beginUninstall(f.rootDir, f.entry);
  const marker = path.join(f.rootDir, 'store', '.uninstalling', `${versions.storeKeyForPackage(PACKAGE)}.json`);
  fs.writeFileSync(marker, '{interrupted');

  assert.equal(readInstalledState(f.rootDir, f.entry).uninstalling, true);
  await f.manager.uninstall({ id: ID });
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(versions.isManuallyUninstalled(f.rootDir, f.entry), true);
});

test('a timed-out uninstall keeps its write guard until the late detach has completed', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: {
    lockTimeoutMs: 60, uninstallCleanupTimeoutMs: 60, listBusyHolders: async () => [],
  } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  const finishRename = Promise.withResolvers();
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (source === legacy) await finishRename.promise;
    return rename(source, destination);
  });

  try {
    await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'SUBAPP_UNINSTALL_CLEANUP_TIMEOUT' });
    assert.equal(readInstalledState(f.rootDir, f.entry).uninstalling, true);
    await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'SUBAPP_LOCK_TIMEOUT' });
  } finally {
    finishRename.resolve();
  }
  const retry = createSubappManager({ ...f.managerOptions, lockTimeoutMs: 1000 });
  await retry.uninstall({ id: ID });
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
});

test('partial detach can resume and a new cleanup worker removes the detached trees independently', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  await f.manager.install({ id: ID });
  const store = path.join(f.rootDir, 'store', versions.storeKeyForPackage(PACKAGE));
  const update = path.join(f.updateRootDir, ID);
  fs.mkdirSync(update, { recursive: true });

  const rename = fs.promises.rename;
  const mock = t.mock.method(fs.promises, 'rename', async (source, destination) => {
    if (source === legacy) throw Object.assign(new Error('EPERM rename busy'), { code: 'EPERM' });
    return rename(source, destination);
  });
  await assert.rejects(f.manager.uninstall({ id: ID }), { code: 'EBUSY' });
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), true);
  assert.equal(fs.existsSync(store), false);
  assert.equal(fs.existsSync(legacy), true);
  mock.mock.restore();

  await createSubappManager(f.managerOptions).uninstall({ id: ID });
  const targets = [legacy, store, update];
  const findDetached = target => fs.readdirSync(path.dirname(target)).filter(name => isRetiredUninstallName(target, name));
  assert.ok(targets.every(target => !fs.existsSync(target) && findDetached(target).length === 1));
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  const retry = await runSubappVersionCleanup(f.rootDir, f.entry, { updateRootDir: f.updateRootDir, isBusy: () => false });
  assert.equal(retry, false);
  assert.ok(targets.every(target => findDetached(target).length === 0));
});

test('explicit reinstall completes an interrupted uninstall before selecting the replacement', { timeout: 5000 }, async t => {
  const f = fixture(t, { managerOptions: { listBusyHolders: async () => [] } });
  const legacy = packagePathFor(f.rootDir, PACKAGE);
  writeRunnablePackage(legacy, '0.1.32');
  versions.beginUninstall(f.rootDir, f.entry);

  await f.manager.reinstall({ id: ID });
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(versions.isUninstalling(f.rootDir, f.entry), false);
  assert.equal(versions.isManuallyUninstalled(f.rootDir, f.entry), false);
  const launch = await f.manager.prepareLaunch({ id: ID });
  assert.equal(launch.config.version, f.entry.version); launch.release();
});
