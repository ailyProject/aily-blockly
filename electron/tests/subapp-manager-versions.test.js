const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const versions = require('../subapp-version-store');
const {
  createSubappManager,
  listProcessesUsingPath,
  packagePathFor,
  prepareNpmSpawn,
  readInstalledState,
} = require('../subapp-manager');
const { npmTarball, portableSubappTarball } = require('./npm-tarball-fixture');

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
    bin: { 'subapp-aily-chat': 'server/index.js' },
    aily: { uiIndex: 'ui/index.html' },
    ailySubapp: { id: ID },
    ...(options.portable === false ? {} : {
      ailyPortable: { version: 1, platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
    }),
  }));
  fs.writeFileSync(path.join(packageRoot, 'server/index.js'), `module.exports='${version}'`);
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
  });
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

test('auto mode uses a newer normal B, while a managed development link always wins', (t) => {
  const f = fixture(t, { version: '1.0.0' });
  const candidate = versions.createCandidate(f.rootDir, f.entry);
  writeRunnablePackage(candidate.source, '1.0.0');
  const prepared = versions.publishCandidate(f.rootDir, f.entry, candidate, { distribution: f.entry.dist });
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
  fs.symlinkSync(path.join(legacy, 'server/index.js'), path.join(f.rootDir, 'node_modules', '.bin', 'subapp-aily-chat'));
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
