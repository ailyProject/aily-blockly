const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { createSubappManager, packagePathFor } = require('./subapp-manager');

const id = 'aily-coder-editor';
const packageName = '@aily-project/subapp-aily-coder-editor';
const entry = {
  id, package: packageName, version: '0.1.6', only: 'aily coder',
  namespace: 'AILY_CODER_EDITOR', titleKey: 'AILY_CODER_EDITOR.TITLE',
  app: { enabled: true, extension: true },
};
let packageFixture;
let archive;

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeEditor(root, version = entry.version) {
  const destination = packagePathFor(root, packageName);
  writeJson(path.join(destination, 'package.json'), {
    name: packageName, version, main: 'index.js',
    aily: { uiIndex: 'ui/index.html' }, ailySubapp: { id },
  });
  fs.mkdirSync(path.join(destination, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'index.js'), 'require("./runtime/index.js");\n');
  fs.writeFileSync(path.join(destination, 'runtime/index.js'), 'console.log("bundled editor");\n');
  fs.writeFileSync(path.join(destination, 'ui/index.html'), '<!doctype html><title>Editor</title>');
  return destination;
}

before(() => {
  packageFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-coder-fixture-'));
  const source = writeEditor(packageFixture);
  const result = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', packageFixture,
  ], { cwd: source, encoding: 'utf8', shell: process.platform === 'win32' }));
  archive = fs.readFileSync(path.join(packageFixture, result[0].filename));
});

after(() => fs.rmSync(packageFixture, { recursive: true, force: true }));

function fixture(t, overrides = {}) {
  // 空格路径也覆盖 Windows 安装目录的参数传递。
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily coder fallback '));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const childPath = path.join(temporaryRoot, 'child');
  const appDataPath = path.join(temporaryRoot, 'appdata');
  const rootDir = path.join(appDataPath, 'npm-global', 'app');
  writeJson(path.join(childPath, `${id}.json`), {
    schemaVersion: 1, entry,
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
  });
  fs.writeFileSync(path.join(childPath, `${id}.tgz`), archive);
  const options = {
    env: {
      ...process.env,
      AILY_BUILD_PRODUCT: 'coder', AILY_CHILD_PATH: childPath, AILY_APPDATA_PATH: appDataPath,
      npm_config_cache: path.join(temporaryRoot, 'empty-npm-cache'),
      npm_config_registry: 'http://127.0.0.1:1',
    },
    fetchImpl: async () => { throw new Error('offline'); },
    ...overrides,
  };
  return { rootDir, childPath, options, manager: createSubappManager(options) };
}

test('discovers and installs the bundled editor offline in the global subapp environment', async t => {
  const progress = [];
  const f = fixture(t, {
    fetchImpl: async () => { assert.fail('startup must not request the remote catalog'); },
    onProgress: event => progress.push(event),
  });
  assert.equal(f.manager.rootDir, f.rootDir);
  const initial = await f.manager.list({ strategy: 'cache-first' });
  assert.equal(initial.apps[0].installed, false);
  const result = await f.manager.install({ id });
  const installed = result.apps.find(app => app.id === id);
  assert.equal(installed.installedVersion, entry.version);
  assert.equal(installed.config.packagePath, packagePathFor(f.rootDir, packageName));
  assert.equal(installed.config.entry, 'index.js');
  assert.equal(installed.config.uiIndex, 'ui/index.html');
  assert.ok(progress.some(event => event.phase === 'complete' && event.percent === 100));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.rootDir, 'package.json'))).dependencies[packageName], entry.version);
  assert.ok(!fs.readdirSync(f.rootDir).some(name => name.startsWith('.subapp-')));
});

test('does not resolve or prune other installed subapps during offline installation', async t => {
  const f = fixture(t);
  const unrelated = '@aily-project/subapp-other';
  const dependency = 'file:/missing/old-build/package.tgz';
  writeJson(path.join(f.rootDir, 'package.json'), {
    name: 'installed-subapps', private: true, dependencies: { [unrelated]: dependency },
  });
  const otherLock = { version: '1.2.3', resolved: dependency };
  writeJson(path.join(f.rootDir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [unrelated]: dependency } },
      [`node_modules/${unrelated}`]: otherLock,
    },
  });
  writeJson(path.join(packagePathFor(f.rootDir, unrelated), 'package.json'), { name: unrelated, version: '1.2.3' });
  await f.manager.install({ id });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'package.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'package-lock.json')));
  assert.equal(manifest.dependencies[unrelated], dependency);
  assert.deepEqual(lock.packages[`node_modules/${unrelated}`], otherLock);
  assert.ok(fs.existsSync(path.join(packagePathFor(f.rootDir, unrelated), 'package.json')));
  assert.equal(lock.packages[''].dependencies[packageName], entry.version);
  assert.equal(lock.packages[`node_modules/${packageName}`].resolved, undefined);
});

test('uses the bundled version for a missing editor while keeping remote updates visible', async t => {
  const f = fixture(t, {
    fetchImpl: async () => ({
      ok: true, text: async () => JSON.stringify({ [id]: { ...entry, version: '0.2.0' } }),
    }),
  });
  await f.manager.list({ refresh: true });
  const result = await f.manager.install({ id });
  assert.equal(result.apps[0].installedVersion, '0.1.6');
  assert.equal(result.apps[0].availableVersion, '0.2.0');
  assert.equal(result.apps[0].updateAvailable, true);
});

test('keeps newer installed editors and development links unchanged', async t => {
  const f = fixture(t, { runNpm: async () => assert.fail('installed editor must not be replaced') });
  const editor = writeEditor(f.rootDir, '0.3.0');
  assert.equal((await f.manager.install({ id })).apps[0].installedVersion, '0.3.0');
  const linkedSource = path.join(f.rootDir, 'linked-editor');
  fs.renameSync(editor, linkedSource);
  fs.symlinkSync(linkedSource, editor, process.platform === 'win32' ? 'junction' : 'dir');
  await f.manager.install({ id });
  assert.ok(fs.lstatSync(editor).isSymbolicLink());
});

test('preserves broken development links instead of deleting them', async t => {
  const f = fixture(t, { runNpm: async () => assert.fail('broken dev link must not be overwritten') });
  const editor = packagePathFor(f.rootDir, packageName);
  fs.mkdirSync(path.dirname(editor), { recursive: true });
  fs.symlinkSync(path.join(f.rootDir, 'missing-source'), editor, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.manager.install({ id }), /development-linked/);
  assert.ok(fs.lstatSync(editor).isSymbolicLink());
});

test('rejects corrupt archives, reports failure, and allows retry with a valid bundle', async t => {
  const progress = [];
  const f = fixture(t, { onProgress: event => progress.push(event) });
  const tarball = path.join(f.childPath, `${id}.tgz`);
  fs.writeFileSync(tarball, 'corrupt');
  await assert.rejects(f.manager.install({ id }), /integrity mismatch/);
  assert.ok(!fs.existsSync(packagePathFor(f.rootDir, packageName)));
  assert.ok(progress.some(event => event.phase === 'error'));
  fs.writeFileSync(tarball, archive);
  assert.equal((await f.manager.install({ id })).apps[0].installed, true);
});

test('restores incomplete packages and manifests after an offline install failure', async t => {
  const f = fixture(t, { runNpm: async () => { throw new Error('disk full'); } });
  const editor = writeEditor(f.rootDir, '0.1.5');
  fs.rmSync(path.join(editor, 'ui', 'index.html'));
  const manifestPath = path.join(f.rootDir, 'package.json');
  writeJson(manifestPath, { private: true, dependencies: { [packageName]: '0.1.5' } });
  const original = fs.readFileSync(manifestPath, 'utf8');
  await assert.rejects(f.manager.install({ id }), /disk full/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(editor, 'package.json'))).version, '0.1.5');
  assert.ok(!fs.readdirSync(f.rootDir).some(name => name.startsWith('.subapp-')));
});

test('does not expose the Coder fallback in Blockly or change missing-bundle behavior', async t => {
  const f = fixture(t, { buildProduct: 'blockly' });
  await assert.rejects(f.manager.list({ strategy: 'cache-first' }), /offline/);
  assert.ok(!fs.existsSync(packagePathFor(f.rootDir, packageName)));
  fs.rmSync(path.join(f.childPath, `${id}.tgz`));
  const coder = createSubappManager({ ...f.options, buildProduct: 'coder' });
  await assert.rejects(coder.list({ strategy: 'cache-first' }), /offline/);
});
