const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const versions = require('../subapp-version-store');
const { resolveSimulatorSubappRuntime } = require('../simulator-subapp-host');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-simulator-version-'));
  const originalEnv = process.env;
  const originalResources = process.resourcesPath;
  process.env = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AILY_SIMULATOR_') || key === 'AILY_PATCHED_QEMU') delete process.env[key];
  }
  process.env.AILY_APPDATA_PATH = path.join(root, 'data');
  process.env.AILY_NPM_PREFIX = path.join(root, 'custom npm prefix');
  process.resourcesPath = path.join(root, 'resources');
  t.after(() => {
    process.env = originalEnv;
    if (originalResources === undefined) delete process.resourcesPath;
    else process.resourcesPath = originalResources;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const installRoot = path.join(process.env.AILY_NPM_PREFIX, 'app');
  const entry = { id: 'aily-simulator', package: '@aily-project/subapp-aily-simulator', version: '1.1.0' };
  const legacyRoot = path.join(installRoot, 'node_modules', ...entry.package.split('/'));
  function writeRuntime(packageRoot, version) {
    writeJson(path.join(packageRoot, 'package.json'), { name: entry.package, version });
    writeJson(path.join(packageRoot, 'aily-simulator-runtime.json'), {
      schemaVersion: 1, platform: `${process.platform}-${process.arch}`,
      entrypoints: { subappService: 'service.js', entitlementConfig: 'entitlement.json', instrumentAssets: 'assets', qemu: 'qemu' },
    });
    for (const name of ['index.js', 'service.js', 'entitlement.json', 'qemu']) fs.writeFileSync(path.join(packageRoot, name), 'fixture');
    fs.mkdirSync(path.join(packageRoot, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'ui', 'index.html'), '<html>Fixture</html>');
    fs.mkdirSync(path.join(packageRoot, 'assets'), { recursive: true });
    return packageRoot;
  }
  function installVersion() {
    const candidate = versions.createCandidate(installRoot, entry);
    writeRuntime(candidate.source, entry.version);
    const prepared = versions.publishCandidate(installRoot, entry, candidate, { distribution: null });
    versions.activate(installRoot, entry, prepared);
    return prepared.packagePath;
  }
  function resolve() {
    return resolveSimulatorSubappRuntime({
      app: { isPackaged: true, getPath: () => path.join(root, 'userdata') },
      moduleDirectory: path.join(root, 'host', 'electron'),
    });
  }
  return { root, installRoot, entry, legacyRoot, writeRuntime, installVersion, resolve };
}

test('simulator resolves the selected immutable package under a custom npm prefix', t => {
  const f = fixture(t);
  f.writeRuntime(f.legacyRoot, '1.0.0');
  const selected = f.installVersion();
  const runtime = f.resolve();
  assert.equal(runtime.simulatorRoot, selected);
  assert.equal(runtime.productionEntry, path.join(selected, 'service.js'));
  assert.equal(runtime.source, 'installed-subapp');
});

test('simulator continues to resolve legacy npm installations', t => {
  const f = fixture(t);
  f.writeRuntime(f.legacyRoot, '1.0.0');
  assert.equal(f.resolve().simulatorRoot, f.legacyRoot);
});

test('simulator does not resurrect a legacy package after versioned uninstall', t => {
  const f = fixture(t);
  f.writeRuntime(f.legacyRoot, '1.0.0');
  f.installVersion();
  versions.beginUninstall(f.installRoot, f.entry);
  assert.throws(f.resolve, /Simulator Subapp is not installed/);
});

test('simulator retains explicit development runtime overrides', t => {
  const f = fixture(t);
  f.installVersion();
  const development = f.writeRuntime(path.join(f.root, 'dev runtime'), '2.0.0-dev.1');
  process.env.AILY_SIMULATOR_SUBAPP_ROOT = development;
  assert.equal(f.resolve().simulatorRoot, development);
});
