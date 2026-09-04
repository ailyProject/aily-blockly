const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  activateStagedSubappUpdate,
  createSubappManager,
  packagePathFor,
  stageSubappUpdate,
  validateIndex,
} = require('./subapp-manager');

const packageBytes = Buffer.from('portable subapp test package');
const integrity = `sha512-${createHash('sha512').update(packageBytes).digest('base64')}`;

function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-update-test-'));
  const rootDir = path.join(temporaryRoot, 'install');
  const updateRootDir = path.join(temporaryRoot, 'updates');
  const packageName = '@aily-project/subapp-test';
  const entry = validateIndex({
    test: {
      id: 'test',
      package: packageName,
      version: '1.1.0',
      namespace: 'TEST',
      titleKey: 'TEST.TITLE',
      app: { name: 'Test', description: 'Test subapp', enabled: true },
      i18n: { defaultLocale: 'en', locales: { en: { TITLE: 'Test', DESCRIPTION: 'Test' } } },
      update: { download: 'background', install: 'next-launch' },
      dist: {
        tarball: 'https://updates.example.test/subapp-test-1.1.0.tgz',
        integrity,
      },
    },
  }).test;

  fs.mkdirSync(rootDir, { recursive: true });
  writeJson(path.join(rootDir, 'package.json'), {
    name: 'aily-installed-subapps',
    private: true,
    version: '1.0.0',
    dependencies: { [packageName]: '1.0.0' },
  });
  writeJson(path.join(rootDir, 'package-lock.json'), {
    name: 'aily-installed-subapps',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [packageName]: '1.0.0' } },
      [`node_modules/${packageName}`]: {
        version: '1.0.0',
        resolved: 'https://updates.example.test/subapp-test-1.0.0.tgz',
        integrity: 'sha512-b2xk',
      },
    },
  });
  writeInstalledPackage(rootDir, packageName, '1.0.0');

  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  return { entry, packageName, rootDir, updateRootDir };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeInstalledPackage(rootDir, packageName, version) {
  const packagePath = packagePathFor(rootDir, packageName);
  fs.mkdirSync(path.join(packagePath, 'ui'), { recursive: true });
  writeJson(path.join(packagePath, 'package.json'), {
    name: packageName,
    version,
    main: 'index.js',
    aily: { uiIndex: 'ui/index.html' },
    ailySubapp: { app: { enabled: true } },
    dependencies: {},
  });
  fs.writeFileSync(path.join(packagePath, 'index.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(packagePath, 'ui', 'index.html'), '<!doctype html>');
}

test('normalizes subapp-only visibility and defaults missing values to all', () => {
  const catalogEntry = (id, only) => ({
    id,
    package: `@aily-project/subapp-${id}`,
    version: '1.0.0',
    namespace: id.toUpperCase().replaceAll('-', '_'),
    titleKey: `${id.toUpperCase().replaceAll('-', '_')}.TITLE`,
    app: { name: id, description: id, enabled: true },
    i18n: { defaultLocale: 'en', locales: {} },
    ...(only === undefined ? {} : { only }),
  });
  const index = validateIndex({
    common: catalogEntry('common'),
    coder: catalogEntry('coder', ' AILY CODER '),
  });

  assert.equal(index.common.only, 'all');
  assert.equal(index.coder.only, 'aily coder');
  assert.throws(
    () => validateIndex({ invalid: catalogEntry('invalid', '') }),
    /invalid only must be a non-empty string/,
  );
});

async function stage(f) {
  const npmCalls = [];
  await stageSubappUpdate(f.rootDir, f.updateRootDir, f.entry, async (args) => {
    npmCalls.push(args);
    return { stdout: '' };
  }, {
    downloadFile: async (_url, destination, onProgress) => {
      fs.writeFileSync(destination, packageBytes);
      onProgress(100);
    },
  });
  return npmCalls;
}

test('stages and verifies an update without replacing the running package', async (t) => {
  const f = fixture(t);
  const npmCalls = await stage(f);

  assert.equal(readVersion(f.rootDir, f.packageName), '1.0.0');
  assert.ok(fs.existsSync(path.join(f.updateRootDir, 'test', '1.1.0', 'package.tgz')));
  const state = JSON.parse(fs.readFileSync(
    path.join(f.updateRootDir, 'test', '1.1.0', 'state.json'),
    'utf8',
  ));
  assert.equal(state.state, 'ready');
  assert.ok(npmCalls.some(args => args[0] === 'cache' && args[1] === 'add'));
  assert.ok(npmCalls.some(args => args.includes('--offline')));
});

test('activates only the canonical package spec from the prepared offline cache', async (t) => {
  const f = fixture(t);
  await stage(f);
  const npmCalls = [];

  await activateStagedSubappUpdate(f.rootDir, f.updateRootDir, f.entry, async (args) => {
    npmCalls.push(args);
    if (args[0] !== 'install') return { stdout: '' };
    writeInstalledPackage(f.rootDir, f.packageName, f.entry.version);
    writeJson(path.join(f.rootDir, 'package.json'), {
      name: 'aily-installed-subapps',
      private: true,
      version: '1.0.0',
      dependencies: { [f.packageName]: f.entry.version },
    });
    writeJson(path.join(f.rootDir, 'package-lock.json'), {
      name: 'aily-installed-subapps',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [f.packageName]: f.entry.version } },
        [`node_modules/${f.packageName}`]: {
          version: f.entry.version,
          resolved: f.entry.dist.tarball,
          integrity: f.entry.dist.integrity,
        },
      },
    });
    return { stdout: '' };
  });

  const installArgs = npmCalls.find(args => args[0] === 'install');
  assert.ok(installArgs.includes('--offline'));
  assert.equal(installArgs.at(-1), `${f.packageName}@${f.entry.version}`);
  assert.ok(!installArgs.some(argument => String(argument).endsWith('.tgz')));
  assert.equal(readVersion(f.rootDir, f.packageName), f.entry.version);
  assert.ok(!fs.existsSync(path.join(f.updateRootDir, 'test', '1.1.0')));
});

test('rolls back the package and root manifests when offline activation fails', async (t) => {
  const f = fixture(t);
  await stage(f);
  const originalPackageJson = fs.readFileSync(path.join(f.rootDir, 'package.json'), 'utf8');
  const originalPackageLock = fs.readFileSync(path.join(f.rootDir, 'package-lock.json'), 'utf8');

  await assert.rejects(
    activateStagedSubappUpdate(f.rootDir, f.updateRootDir, f.entry, async (args) => {
      if (args[0] === 'install') throw new Error('simulated offline install failure');
      return { stdout: '' };
    }),
    /simulated offline install failure/,
  );

  assert.equal(readVersion(f.rootDir, f.packageName), '1.0.0');
  assert.equal(fs.readFileSync(path.join(f.rootDir, 'package.json'), 'utf8'), originalPackageJson);
  assert.equal(fs.readFileSync(path.join(f.rootDir, 'package-lock.json'), 'utf8'), originalPackageLock);
  const state = JSON.parse(fs.readFileSync(
    path.join(f.updateRootDir, 'test', '1.1.0', 'state.json'),
    'utf8',
  ));
  assert.equal(state.state, 'failed');
  assert.equal(state.phase, 'install');
});

test('preserves the existing package when creating the rollback copy fails', async (t) => {
  const f = fixture(t);
  await stage(f);
  const installedPackagePath = packagePathFor(f.rootDir, f.packageName);
  const originalRenameSync = fs.renameSync;

  fs.renameSync = (source, destination) => {
    if (source === installedPackagePath) {
      const error = new Error('simulated backup rename failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRenameSync(source, destination);
  };

  try {
    await assert.rejects(
      activateStagedSubappUpdate(f.rootDir, f.updateRootDir, f.entry, async () => ({ stdout: '' })),
      /simulated backup rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(readVersion(f.rootDir, f.packageName), '1.0.0');
});

test('does not create ready state for a package with the wrong integrity', async (t) => {
  const f = fixture(t);
  f.entry.dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;

  await assert.rejects(stage(f), /integrity mismatch/);
  const state = JSON.parse(fs.readFileSync(
    path.join(f.updateRootDir, 'test', '1.1.0', 'state.json'),
    'utf8',
  ));
  assert.equal(state.state, 'failed');
  assert.equal(state.phase, 'download');
});

test('refreshes remote updates while preserving only linked development subapps', async (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-dev-index-test-'));
  const rootDir = path.join(temporaryRoot, 'install');
  const updateRootDir = path.join(temporaryRoot, 'updates');
  const developmentSource = path.join(temporaryRoot, 'development-source');
  const developmentPackage = '@aily-project/subapp-development';
  const stalePackage = '@aily-project/subapp-stale';
  let fetchCount = 0;

  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, 'node_modules', '@aily-project'), { recursive: true });
  writeInstalledPackage(temporaryRoot, developmentPackage, '1.0.0');
  fs.renameSync(packagePathFor(temporaryRoot, developmentPackage), developmentSource);
  fs.symlinkSync(
    developmentSource,
    packagePathFor(rootDir, developmentPackage),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const catalogEntry = (id, packageName, version) => ({
    id,
    package: packageName,
    version,
    namespace: id.toUpperCase().replaceAll('-', '_'),
    titleKey: `${id.toUpperCase().replaceAll('-', '_')}.TITLE`,
    app: { name: id, description: id, enabled: true },
    i18n: { defaultLocale: 'en', locales: {} },
  });
  writeJson(path.join(rootDir, 'subapp-index.json'), {
    development: catalogEntry('development', developmentPackage, '1.0.0'),
    stale: catalogEntry('stale', stalePackage, '1.0.0'),
    dev: true,
  });

  const remoteIndex = {
    test: {
      ...catalogEntry('test', '@aily-project/subapp-test', '1.1.0'),
      only: 'aily coder',
    },
  };
  const manager = createSubappManager({
    rootDir,
    updateRootDir,
    indexUrl: 'https://updates.example.test/subapp-index.json',
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        text: async () => JSON.stringify(remoteIndex),
      };
    },
  });

  const initial = await manager.list({ strategy: 'cache-first' });
  assert.deepEqual(initial.apps.map(app => app.id).sort(), ['development', 'stale']);

  const refreshed = await manager.list({ strategy: 'network-first' });
  assert.equal(fetchCount, 1);
  assert.equal(refreshed.source, 'network');
  assert.deepEqual(refreshed.apps.map(app => app.id).sort(), ['development', 'test']);
  assert.equal(refreshed.apps.find(app => app.id === 'development').only, 'all');
  assert.equal(refreshed.apps.find(app => app.id === 'test').only, 'aily coder');

  const cached = await manager.list({ strategy: 'cache-first' });
  assert.deepEqual(cached.apps.map(app => app.id).sort(), ['development', 'test']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'subapp-index.json'), 'utf8')).dev, true);
});

function readVersion(rootDir, packageName) {
  return JSON.parse(fs.readFileSync(
    path.join(packagePathFor(rootDir, packageName), 'package.json'),
    'utf8',
  )).version;
}
