const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const versions = require('../subapp-version-store');
const {
  compareSemver,
  ensureStableRouter,
  isStableRouterReady,
  resolveStableBin,
  stableRouterPath,
} = require('../subapp-bin-router');

const ID = 'aily-chat';
const PACKAGE = '@aily-project/subapp-aily-chat';
const BIN = 'aily-blockly-mcp';

function entry(version) {
  return { id: ID, package: PACKAGE, version };
}

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aily stable mcp '));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const rootDir = path.join(temporary, '用户 App & Data', 'npm-global', 'app');
  fs.mkdirSync(rootDir, { recursive: true });
  return { temporary, rootDir };
}

function writePackage(packageRoot, version, options = {}) {
  fs.mkdirSync(path.join(packageRoot, 'runtime', 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: options.name || PACKAGE,
    version,
    ...(options.developmentIdentity ? { ailySubapp: { package: PACKAGE } } : {}),
    bin: { [BIN]: options.binPath || 'runtime/mcp/cli.js' },
  }));
  if (options.writeBin !== false) {
    fs.writeFileSync(
      path.join(packageRoot, 'runtime', 'mcp', 'cli.js'),
      options.binSource || `// ${version}\n`,
    );
  }
}

function publish(rootDir, version, options = {}) {
  const targetEntry = entry(version);
  const candidate = versions.createCandidate(rootDir, targetEntry);
  writePackage(candidate.source, version, options);
  return versions.publishCandidate(rootDir, targetEntry, candidate);
}

test('installs one versionless router path and keeps it stable across refreshes', (t) => {
  const f = fixture(t);
  const first = ensureStableRouter(f.rootDir);
  const bytes = fs.readFileSync(first);
  const second = ensureStableRouter(f.rootDir);
  assert.equal(first, stableRouterPath(f.rootDir));
  assert.equal(second, first);
  assert.equal(isStableRouterReady(f.rootDir), true);
  assert.deepEqual(fs.readFileSync(second), bytes);
  assert.doesNotMatch(first, /\d+\.\d+\.\d+/);
});

test('resolves each new connection through active.json without changing the router path', (t) => {
  const f = fixture(t);
  const router = ensureStableRouter(f.rootDir);
  const first = publish(f.rootDir, '1.0.0');
  versions.activate(f.rootDir, entry('1.0.0'), first);
  const firstTarget = resolveStableBin(f.rootDir, PACKAGE, BIN);
  const second = publish(f.rootDir, '1.1.0');
  versions.activate(f.rootDir, entry('1.1.0'), second);
  const secondTarget = resolveStableBin(f.rootDir, PACKAGE, BIN);

  assert.equal(stableRouterPath(f.rootDir), router);
  assert.equal(firstTarget.version, '1.0.0');
  assert.equal(secondTarget.version, '1.1.0');
  assert.match(firstTarget.targetPath, /1\.0\.0[/\\]source[/\\]runtime[/\\]mcp[/\\]cli\.js$/);
  assert.match(secondTarget.targetPath, /1\.1\.0[/\\]source[/\\]runtime[/\\]mcp[/\\]cli\.js$/);
});

test('uses the verified previous MCP entry when the selected generation is damaged', (t) => {
  const f = fixture(t);
  const first = publish(f.rootDir, '1.0.0');
  versions.activate(f.rootDir, entry('1.0.0'), first);
  const second = publish(f.rootDir, '1.1.0');
  versions.activate(f.rootDir, entry('1.1.0'), second);
  fs.rmSync(path.join(second.packagePath, 'runtime', 'mcp', 'cli.js'));

  const resolved = resolveStableBin(f.rootDir, PACKAGE, BIN);
  assert.equal(resolved.version, '1.0.0');
  assert.equal(resolved.fallback, true);
});

test('the stable router delegates stdio without changing the client working directory', (t) => {
  const f = fixture(t);
  const expectedCwd = path.join(f.temporary, 'third-party workspace');
  fs.mkdirSync(expectedCwd);
  const selected = publish(f.rootDir, '1.2.3', {
    binSource: [
      "const payload = { cwd: process.cwd(), args: process.argv.slice(2), version: process.env.AILY_SUBAPP_VERSION, source: process.env.AILY_SUBAPP_SOURCE };",
      "process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    ].join('\n'),
  });
  versions.activate(f.rootDir, entry('1.2.3'), selected);
  const router = ensureStableRouter(f.rootDir);
  const result = spawnSync(process.execPath, [router, PACKAGE, BIN, '--probe'], {
    cwd: expectedCwd,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd: fs.realpathSync(expectedCwd),
    args: ['--probe'],
    version: '1.2.3',
    source: 'version-store',
  });
});

test('matches host selection rules for pinned, newer legacy and development packages', (t) => {
  const f = fixture(t);
  const selected = publish(f.rootDir, '1.0.0');
  versions.activate(f.rootDir, entry('1.0.0'), selected);
  const legacy = path.join(f.rootDir, 'node_modules', '@aily-project', 'subapp-aily-chat');
  writePackage(legacy, '2.0.0');
  assert.equal(resolveStableBin(f.rootDir, PACKAGE, BIN).version, '2.0.0');

  versions.activate(f.rootDir, entry('1.0.0'), selected, { mode: 'pinned' });
  assert.equal(resolveStableBin(f.rootDir, PACKAGE, BIN).version, '1.0.0');

  fs.rmSync(legacy, { recursive: true, force: true });
  const development = path.join(f.temporary, 'chat development');
  writePackage(development, '0.1.0', {
    name: 'aily-chat',
    developmentIdentity: true,
  });
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.symlinkSync(development, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  const resolved = resolveStableBin(f.rootDir, PACKAGE, BIN);
  assert.equal(resolved.version, '0.1.0');
  assert.equal(resolved.source, 'development');
});

test('blocks uninstalling packages and rejects escaped or undeclared bin targets', (t) => {
  const f = fixture(t);
  const selected = publish(f.rootDir, '1.0.0');
  versions.activate(f.rootDir, entry('1.0.0'), selected);
  versions.beginUninstall(f.rootDir, entry('1.0.0'));
  assert.throws(
    () => resolveStableBin(f.rootDir, PACKAGE, BIN),
    /uninstall is in progress/,
  );
  versions.finishUninstall(f.rootDir, entry('1.0.0'));

  const manifestPath = path.join(selected.packagePath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.bin[BIN] = '../../outside.js';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => resolveStableBin(f.rootDir, PACKAGE, BIN), /Unsafe subapp bin path/);
  assert.throws(() => resolveStableBin(f.rootDir, PACKAGE, 'missing-bin'), /not declared/);
});

test('implements SemVer precedence without a runtime package dependency', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
});
