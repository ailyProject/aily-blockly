'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { planChildNodeDependencies, materializeChildNodeDependencies } = require('./child-node-dependencies');

const sourceRoot = path.resolve(__dirname, '..');
// An explicit alternate tree is a test fixture source only. Product preparation
// always resolves the declared root node_modules without a fallback.
const installedRoot = process.env.AILY_CHILD_NODE_TEST_DEPENDENCIES || path.join(sourceRoot, 'node_modules');
const installed = path.isAbsolute(installedRoot) && fs.existsSync(path.join(installedRoot, 'fs-native-extensions/package.json'));
const options = { skip: installed ? false : 'Install the locked root dependencies or supply an existing test dependency tree.' };
const names = ['bare-addon-resolve', 'bare-module-resolve', 'bare-semver', 'fs-native-extensions', 'require-addon', 'which-runtime'];

function fixture(t, { dependencies = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily-child-node-deps-test-')));
  const workspaceRoot = path.join(root, 'workspace'), destination = path.join(root, 'external', 'child');
  fs.mkdirSync(workspaceRoot); fs.mkdirSync(path.join(root, 'outside'));
  for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(sourceRoot, name), path.join(workspaceRoot, name));
  if (dependencies) fs.symlinkSync(fs.realpathSync(installedRoot), path.join(workspaceRoot, 'node_modules'), 'junction');
  else fs.mkdirSync(path.join(workspaceRoot, 'node_modules'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^aily-child-node-deps-test-/);
    // Removing this verified test root unlinks its junction; it never removes
    // the existing source dependency tree.
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspaceRoot, destination, outside: path.join(root, 'outside') };
}

test('external child resolves the exact npm closure and native lock without NODE_PATH or source-root lookup', options, async t => {
  const f = fixture(t), plan = await planChildNodeDependencies({ workspaceRoot: f.workspaceRoot });
  assert.deepEqual(plan.packages.map(row => row.name).sort(), names);
  assert.equal(plan.files.filter(row => row.role === 'native-binding').length, 1);
  assert.equal(plan.files.filter(row => row.relative.endsWith('.node')).length, 1);
  assert(plan.packages.every(row => row.tarballIntegrityRecomputed === false && /^sha512-/.test(row.declaredTarballIntegrity)));
  const result = await materializeChildNodeDependencies(plan, { destination: f.destination });
  assert.equal(result.installationOrDownloadPerformed, false);
  assert.equal(result.SDKOrOtherChildPayloadCopiedByThisModule, false);
  assert.equal(result.NodePathOrAsarRequired, false);
  assert.equal(result.copiedFiles, plan.files.length);
  const reused = await materializeChildNodeDependencies(plan, { destination: f.destination });
  assert.equal(reused.copiedFiles, 0); assert.equal(reused.reusedFiles, plan.files.length);

  const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
  const script = String.raw`
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const destination = process.argv[1], expectedNames = JSON.parse(process.argv[2]);
    const request = createRequire(path.join(destination, 'package.json'));
    const prefix = path.join(destination, 'node_modules').toLowerCase() + path.sep;
    const entries = expectedNames.map(name => {
      const resolved = request.resolve(name); assert(resolved.toLowerCase().startsWith(prefix));
      return { name, resolved };
    });
    const native = request('fs-native-extensions'), filename = path.join(process.cwd(), 'owned-native-lock-test');
    fs.writeFileSync(filename, 'test'); const fd = fs.openSync(filename, 'r+'); let locked;
    try { locked = native.tryLock(fd); assert.equal(locked, true); }
    finally { fs.closeSync(fd); fs.unlinkSync(filename); }
    const loaded = Object.keys(require.cache).filter(name => name.endsWith('.node'));
    assert(loaded.some(name => name.toLowerCase().startsWith(prefix)));
    assert(loaded.every(name => name.toLowerCase().startsWith(prefix)));
    console.log(JSON.stringify({ entries, loaded, nativeTryLock: locked, NODE_PATH: process.env.NODE_PATH ?? null,
      cwdOutsideChild: !process.cwd().toLowerCase().startsWith(destination.toLowerCase()), node: process.version }));
  `;
  const child = spawnSync(process.execPath, ['-e', script, f.destination, JSON.stringify(names)], {
    cwd: f.outside, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(child.error); assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const proof = JSON.parse(child.stdout);
  assert.equal(proof.nativeTryLock, true); assert.equal(proof.NODE_PATH, null); assert.equal(proof.cwdOutsideChild, true);
  assert.equal(proof.entries.length, names.length);
  t.diagnostic('Independent Node loaded all six packages and the target native binding solely from external child/node_modules.');
});

test('planning rejects source declaration drift before materialization', options, async t => {
  const f = fixture(t), file = path.join(f.workspaceRoot, 'package.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.dependencies['fs-native-extensions'] = '^1.5.1'; fs.writeFileSync(file, JSON.stringify(manifest));
  await assert.rejects(planChildNodeDependencies({ workspaceRoot: f.workspaceRoot }), /Declare exact/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('planning rejects an unavailable target prebuild without changing installed dependencies', options, async t => {
  const f = fixture(t);
  await assert.rejects(planChildNodeDependencies({ workspaceRoot: f.workspaceRoot, platform: 'linux', arch: 'ia32' }), /native prebuild/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('planning rejects a missing installed package and requests normal npm ci', options, async t => {
  const f = fixture(t, { dependencies: false });
  await assert.rejects(planChildNodeDependencies({ workspaceRoot: f.workspaceRoot }), /run npm ci/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('materialization refuses changed source and incorrect hash before writing the child', options, async t => {
  const f = fixture(t), plan = await planChildNodeDependencies({ workspaceRoot: f.workspaceRoot });
  const changedHash = structuredClone(plan); changedHash.files[0].source.sha256 = '0'.repeat(64);
  await assert.rejects(materializeChildNodeDependencies(changedHash, { destination: f.destination }), /changed|inventory/i);
  assert.equal(fs.existsSync(f.destination), false);
  const manifestFile = path.join(f.workspaceRoot, 'package.json'); fs.appendFileSync(manifestFile, '\n');
  await assert.rejects(materializeChildNodeDependencies(plan, { destination: f.destination }), /changed/i);
  assert.equal(fs.existsSync(f.destination), false);
});

test('materialization refuses destination node_modules links without writing outside', options, async t => {
  const f = fixture(t), plan = await planChildNodeDependencies({ workspaceRoot: f.workspaceRoot });
  fs.mkdirSync(f.destination, { recursive: true });
  fs.symlinkSync(f.outside, path.join(f.destination, 'node_modules'), 'junction');
  await assert.rejects(materializeChildNodeDependencies(plan, { destination: f.destination }), /link/i);
  assert.deepEqual(fs.readdirSync(f.outside), []);
});

test('materialization rejects a linked success receipt before changing external child files', options, async t => {
  const f = fixture(t), plan = await planChildNodeDependencies({ workspaceRoot: f.workspaceRoot });
  fs.mkdirSync(f.destination, { recursive: true });
  const original = path.join(f.outside, 'keep.json'); fs.writeFileSync(original, 'original');
  fs.linkSync(original, path.join(f.destination, 'node-dependencies.receipt.json'));
  await assert.rejects(materializeChildNodeDependencies(plan, { destination: f.destination }), /receipt.*linked/i);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(f.destination, 'node_modules')), false);
});
