const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { execFileSync, fork } = require('node:child_process');
const { createSubappManager, packagePathFor, readInstalledState } = require('../subapp-manager');

const packageName = '@aily-project/subapp-version-smoke';
const id = 'version-smoke';
const runtimeSource = `
const fs = require('node:fs');
const path = require('node:path');
process.on('message', () => {
  delete require.cache[require.resolve('./late.cjs')];
  process.send({
    version: require('./package.json').version,
    asset: fs.readFileSync(path.join(__dirname, 'asset.txt'), 'utf8'),
    lazy: require('./late.cjs'), dependency: require('version-smoke-dependency'),
    built: fs.existsSync(path.join(__dirname, 'built.txt')),
    root: __dirname, selectedVersion: process.env.AILY_SUBAPP_VERSION,
  });
});
process.send('ready');
`;
function writePackage(directory, version) {
  fs.mkdirSync(path.join(directory, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: packageName, version, main: 'index.js',
    dependencies: { 'version-smoke-dependency': '1.0.0' },
    bundledDependencies: ['version-smoke-dependency'],
    scripts: { postinstall: 'node build.cjs' },
  }));
  fs.writeFileSync(path.join(directory, 'index.js'), runtimeSource);
  fs.writeFileSync(path.join(directory, 'ui/index.html'), '<h1>Runtime smoke</h1>');
  fs.writeFileSync(path.join(directory, 'asset.txt'), version);
  fs.writeFileSync(path.join(directory, 'late.cjs'), `module.exports = '${version}';`);
  fs.writeFileSync(path.join(directory, 'build.cjs'), "require('node:fs').writeFileSync('built.txt','built')");
  const dep = path.join(directory, 'node_modules', 'version-smoke-dependency');
  fs.mkdirSync(dep, { recursive: true });
  fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'version-smoke-dependency', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(dep, 'index.js'), "module.exports = 'dependency-ok';");
}
async function startRuntime(config) {
  const child = fork(path.join(config.packagePath, config.entry), [], {
    cwd: config.packagePath, env: { ...process.env, ...config.env }, silent: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime startup timeout')), 10000);
    child.once('error', reject);
    child.once('message', () => { clearTimeout(timer); resolve(); });
  });
  return child;
}
function readRuntime(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime response timeout')), 10000);
    child.once('message', data => { clearTimeout(timer); resolve(data); });
    child.send('read');
  });
}
async function stopRuntime(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

test('real npm archive, bundled dependency and install script coexist with a running legacy process', { timeout: 60000 }, async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-version-real-'));
  const rootDir = path.join(temporary, '中文 app & (versions)', 'npm-global', 'app');
  const updateRootDir = path.join(temporary, 'updates');
  const source = path.join(temporary, 'source');
  const legacy = packagePathFor(rootDir, packageName);
  let oldRuntime;
  let newRuntime;
  let server;
  try {
    writePackage(legacy, '1.0.0');
    fs.writeFileSync(path.join(legacy, 'built.txt'), 'legacy-built');
    const manifest = `${JSON.stringify({ name: 'legacy-apps', private: true, dependencies: { [packageName]: '1.0.0' } })}\n`;
    const lock = `${JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { [packageName]: '1.0.0' } } } })}\n`;
    fs.writeFileSync(path.join(rootDir, 'package.json'), manifest);
    fs.writeFileSync(path.join(rootDir, 'package-lock.json'), lock);
    writePackage(source, '2.0.0');
    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--cache', path.join(temporary, 'pack-cache'),
    ], { cwd: source, encoding: 'utf8', timeout: 20000 }));
    const archive = fs.readFileSync(path.join(source, packed[0].filename));
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-length': archive.length });
      response.end(archive);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const entry = {
      id, package: packageName, version: '2.0.0', namespace: 'SMOKE', titleKey: 'SMOKE.TITLE',
      app: { name: 'Smoke', enabled: true },
      dist: { tarball: `http://127.0.0.1:${server.address().port}/package.tgz`, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
    };
    const manager = createSubappManager({
      rootDir, updateRootDir, indexUrl: 'https://example.test/subapp-index.json',
      env: { ...process.env, AILY_CHILD_PATH: '' },
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ [id]: entry }) }),
    });
    oldRuntime = await startRuntime(readInstalledState(rootDir, entry).config);
    // Loading a network catalog automatically starts background preparation; join it explicitly.
    await manager.downloadUpdate({ id });
    assert.equal(readInstalledState(rootDir, entry).installedVersion, '1.0.0');
    const launch = await manager.prepareLaunch({ id });
    try { newRuntime = await startRuntime(launch.config); } finally { launch.release(); }
    const oldRead = await readRuntime(oldRuntime);
    const newRead = await readRuntime(newRuntime);
    assert.deepEqual({ ...oldRead, root: undefined }, {
      version: '1.0.0', asset: '1.0.0', lazy: '1.0.0', dependency: 'dependency-ok', built: true,
      root: undefined, selectedVersion: '1.0.0',
    });
    assert.deepEqual({ ...newRead, root: undefined }, {
      version: '2.0.0', asset: '2.0.0', lazy: '2.0.0', dependency: 'dependency-ok', built: true,
      root: undefined, selectedVersion: '2.0.0',
    });
    assert.equal(newRead.root, fs.realpathSync(path.join(rootDir, 'store', 'subapp-version-smoke', '2.0.0', 'source')));
    assert.equal(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'), manifest);
    assert.equal(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'), lock);
    // Clearing the old temporary cache must not invalidate a fully prepared/selected version.
    fs.rmSync(updateRootDir, { recursive: true, force: true });
    assert.equal(readInstalledState(rootDir, entry).installedVersion, '2.0.0');
    assert.equal((await readRuntime(oldRuntime)).lazy, '1.0.0');
  } finally {
    await Promise.all([stopRuntime(oldRuntime), stopRuntime(newRuntime)]);
    if (server) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
