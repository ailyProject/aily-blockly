'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { LibraryDependencies, runDependencyWorker } = require('../../electron/library-dependencies');
const { LibraryDependencySessions } = require('../../electron/library-dependency-sessions');
const { LibraryHistory } = require('../../electron/library-history');
const build = require('../../child/scripts/build-execution-workspace');
const oracle = require('./fixtures/r0-environment-oracle.cjs');

const runRoot = path.resolve(__dirname, '../test-results/r0-environment', randomUUID());
fs.mkdirSync(runRoot, { recursive: true });
const record = (name, value) => fs.writeFileSync(path.join(runRoot, `${name}.json`), JSON.stringify(value, null, 2));
const put = (root, relative, bytes) => {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes, null, 2));
};
const read = (root, relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const names = { board: '@aily-project/board-r0', lib: '@aily-project/lib-r0-local', core: '@aily-project/lib-core-r0',
  transitive: '@aily-project/lib-r0-transitive', extra: '@aily-project/lib-r0-extraneous' };

async function fixture(name) {
  const folder = path.join(runRoot, name), root = path.join(folder, 'project'), sources = path.join(folder, 'sources');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(sources, { recursive: true });
  const packageSource = (shortName, packageName, source = `// ${shortName} version A\n`) => {
    const target = path.join(sources, shortName);
    put(target, 'package.json', { name: packageName, version: '1.0.0' });
    put(target, 'src/original.h', source); put(target, 'block.json', { type: `${shortName}_fixture`, version: 'A' });
    put(target, 'generator.js', `// ${shortName} generator version A\n`);
    return target;
  };
  const board = packageSource('board', names.board); put(board, 'board.json', { compilerParam: '-b r0:r0:r0' });
  const core = packageSource('core', names.core), local = packageSource('local', names.lib);
  const transitive = packageSource('transitive', names.transitive);
  put(local, 'package.json', { name: names.lib, version: '1.0.0', dependencies: { [names.transitive]: `file:${transitive}` } });
  put(root, 'package.json', { name: `r0-${name}`, version: '1.0.0', type: 'blockly',
    dependencies: { [names.board]: `file:${board}`, [names.core]: `file:${core}` } });
  put(root, 'project.abi', '{"originalCompleteDocument":"A"}');
  put(root, 'project.abs', 'candidate A\n'); put(root, 'project.abs.map.json', '{"originalMap":"A"}');
  const options = { offline: true, ignoreScripts: true, audit: false, fund: false, installLinks: false,
    cache: path.join(folder, 'npm-cache'), registry: 'http://127.0.0.1:9', fetchRetries: 0 };
  put(root, '.npmrc', 'offline=true\nignore-scripts=true\naudit=false\nfund=false\nregistry=http://127.0.0.1:9\nfetch-retries=0\n');
  await runDependencyWorker(root, { save: true, options });
  await runDependencyWorker(root, { options });
  const libraries = new LibraryDependencies(), sessions = new LibraryDependencySessions(libraries);
  const install = (includeTransitive = true) => sessions.run('mutate', root, { action: 'install',
    packages: [`${names.lib}@file:${local}`, ...(includeTransitive ? [`${names.transitive}@file:${transitive}`] : [])], options });
  const config = { currentProjectPath: root, boardModule: names.board,
    code: '#include <original.h>\nvoid setup() {}\nvoid loop() {}', buildRequestId: `r0-${name}`,
    generatedArtifacts: [], projectMacros: [] };
  return { folder, root, sources, local, core, transitive, board, options, libraries, sessions, install, config };
}

test('R0: real dependency transaction persists effective manifest/lock without publishing or replacing candidate A', async () => {
  const f = await fixture('install-boundary');
  const native = ['project.abi', 'project.abs.map.json'].map(file => oracle.sha(read(f.root, file)));
  const status = await f.install();
  assert.equal(status.dirty, false);
  const manifest = JSON.parse(read(f.root, 'package.json')), lock = JSON.parse(read(f.root, 'package-lock.json'));
  assert.equal(fs.realpathSync(path.resolve(f.root, manifest.dependencies[names.lib].slice('file:'.length))), fs.realpathSync(f.local));
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(read(f.root, 'project.abs'), 'candidate A\n');
  assert.deepEqual(['project.abi', 'project.abs.map.json'].map(file => oracle.sha(read(f.root, file))), native);
  put(f.root, 'project.abs', read(f.root, 'project.abs') + 'candidate B\n');
  await new LibraryDependencies().discard(f.root, { reconcile: true });
  assert.equal(read(f.root, 'project.abs'), 'candidate A\ncandidate B\n');
  assert.ok(fs.existsSync(path.join(f.root, 'node_modules', names.lib, 'src/original.h')));
  record('install-boundary', { qualification: 'real dependency primitives; candidate bytes only, not ABS proof/native apply',
    manifest: manifest.dependencies, lockMatches: true, candidatePreserved: true, coldDependencyManagerPreserved: true });
});

test('R0: library history preserves intent/link topology but neither source bytes nor restartable undo authority', async () => {
  const f = await fixture('history-not-source'); await f.install();
  const history = new LibraryHistory(), { token } = await history.begin(f.root, [names.lib]);
  const original = await history.capture(f.root, [names.lib]);
  assert.ok(original.links.some(link => link.target === fs.realpathSync(f.local)));
  put(f.local, 'src/original.h', '// version B changed by local-library author\n');
  put(f.local, 'generator.js', '// generator version B\n');
  assert.deepEqual(await history.capture(f.root, [names.lib]), original);
  assert.equal((await history.commit(f.root, token)).changed, false);
  await history.restoreLinks(f.root, original);
  assert.match(read(path.join(f.root, 'node_modules', names.lib), 'src/original.h'), /version B/);
  assert.throws(() => new LibraryHistory().get(f.root, token), { code: 'LIBRARY_HISTORY_CONFLICT' });
  record('history-not-source', { intentUnchangedAfterSourceEdit: true, contentRestoredToA: false,
    restartedHistoryCanResolveToken: false, recordedFields: Object.keys(original),
    conclusion: 'existing history is not a durable library-byte archive' });
});

test('R0: detached build bytes survive source mutation and real npm prune; cold observer retains the exact original request', async () => {
  const f = await fixture('detached-prune'); await f.install();
  const prepared = build.prepareBuildExecution(f.config), copy = path.join(prepared.currentProjectPath, 'node_modules', names.lib);
  const before = read(copy, 'src/original.h');
  assert.equal(fs.lstatSync(copy).isSymbolicLink(), false);
  assert.notEqual(fs.statSync(path.join(copy, 'src/original.h')).ino, fs.statSync(path.join(f.local, 'src/original.h')).ino);
  put(f.local, 'src/original.h', '// external original now version B\n');
  assert.equal(read(copy, 'src/original.h'), before);
  assert.equal(build.canReuseBuildExecution(f.config), false);
  const manifest = JSON.parse(read(f.root, 'package.json'));
  delete manifest.dependencies[names.lib]; delete manifest.dependencies[names.transitive];
  put(f.root, 'package.json', manifest);
  const extra = path.join(f.root, 'node_modules', names.extra);
  put(extra, 'package.json', { name: names.extra, version: '1.0.0' });
  const bundledNode = path.resolve(__dirname, '../../child/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npm = path.resolve(__dirname, '../../child/node', process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
  const prune = execFileSync(bundledNode, [npm, 'prune', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=http://127.0.0.1:9', '--fetch-retries=0', `--cache=${f.options.cache}`],
  { cwd: f.root, windowsHide: true, timeout: 45000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules', names.lib)), false);
  assert.equal(fs.existsSync(extra), false);
  assert.equal(read(copy, 'src/original.h'), before);
  const script = `const fs=require('fs'),api=require(process.argv[1]),c=JSON.parse(fs.readFileSync(process.argv[2]));
    console.log(JSON.stringify({status:api.inspectBuildExecution(c.execution.logicalProjectPath,c.execution.buildRequestId).status,
      inputDigest:c.execution.inputDigest,body:fs.readFileSync(require('path').join(c.currentProjectPath,'node_modules',${JSON.stringify(names.lib)},'src/original.h'),'utf8')}));`;
  const cold = JSON.parse(execFileSync(process.execPath, ['-e', script, require.resolve('../../child/scripts/build-execution-workspace'),
    path.join(path.dirname(prepared.currentProjectPath), 'config.json')], { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
  assert.equal(cold.status, 'prepared'); assert.equal(cold.body, before); assert.equal(cold.inputDigest, prepared.execution.inputDigest);
  record('detached-prune', { realNpmPrune: true, pruneOutput: prune.trim(), junctionDetached: true,
    originalSourceChanged: true, rootPackagePruned: true, capturedBytesPreserved: true, cold,
    buildRequestId: prepared.execution.buildRequestId, inputDigest: prepared.execution.inputDigest });
});

test('R0: execution capture scope is compilation inputs, not a complete restorable project environment', async () => {
  const f = await fixture('capture-scope'); await f.install(false);
  const prepared = build.prepareBuildExecution(f.config), root = prepared.currentProjectPath;
  for (const name of [names.board, names.lib]) assert.ok(fs.existsSync(path.join(root, 'node_modules', name, 'package.json')), name);
  assert.equal(JSON.parse(read(f.local, 'package.json')).dependencies[names.transitive], `file:${f.transitive}`);
  for (const base of [f.root, root]) for (const relative of [path.join('node_modules', names.transitive),
    path.join('node_modules', names.lib, 'node_modules', names.transitive)]) assert.equal(fs.existsSync(path.join(base, relative)), false);
  for (const relative of ['package-lock.json', 'project.abs', 'project.abs.map.json', path.join('node_modules', names.core), 'local-libraries']) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  }
  const digest = prepared.execution.inputDigest;
  put(f.core, 'generator.js', '// core generator B not included by this compilation-tree collector\n');
  const next = build.prepareBuildExecution({ ...f.config, buildRequestId: 'r0-capture-core-changed' });
  assert.equal(next.execution.inputDigest, digest);
  record('capture-scope', { copied: ['project.abi', 'package.json', 'board', 'installed non-core library'],
    notCopied: ['root lockfile', 'ABS/map', 'core definitions/generator', 'canonical local source path', 'global SDK/compiler/tools'],
    externalFileLibraryDeclaredTransitiveAbsentAfterRealNpmTransaction: true,
    digestUnchangedByCoreGeneratorOnlyMutation: true,
    conclusion: 'reuse byte-detachment primitive; R1 environment record must explicitly pin missing definition/source/tool inputs' });
});

test('R0: original customer whole-document oracle detects truncated bodies and variable identity drift',
  { skip: !process.env.AILY_R0_ORACLE_WORKSPACE && 'set AILY_R0_ORACLE_WORKSPACE to the private extracted-evidence workspace' }, () => {
    const workspace = process.env.AILY_R0_ORACLE_WORKSPACE;
    const inputs = [
      { name: '787', root: path.join(workspace, 'work/customer787-20261106/project/evidence'), blocks: 2420, variables: 119 },
      { name: 'chiyao', root: path.join(workspace, 'work/chiyao-baseline-20261106/project/evidence/chiyao'), blocks: 1130, variables: 104 },
    ];
    for (const input of inputs) {
      const bytes = fs.readFileSync(path.join(input.root, 'project.abi'));
      const original = JSON.parse(bytes), expected = oracle.customerOracle(input.root);
      assert.equal(expected.document.blocks, input.blocks); assert.equal(expected.document.variables, input.variables);
      assert.equal(oracle.documentHash(JSON.parse(JSON.stringify(original))), expected.document.documentHash);
      const truncated = JSON.parse(bytes), roots = truncated.pages[0].content.blocks.blocks;
      roots.splice(roots.length - 1, 1);
      assert.notEqual(oracle.documentHash(truncated), expected.document.documentHash);
      const drift = JSON.parse(bytes); drift.sharedModel.variables[0].type = 'R0_INVALID_TYPE';
      assert.notEqual(oracle.inspectDocument(drift).variableHash, expected.document.variableHash);
      assert.equal(oracle.sha(fs.readFileSync(path.join(input.root, 'project.abi'))), expected.rawAbiSha256);
      record(`customer-oracle-${input.name}`, { ...expected, negativeControls: ['remove final top-level body', 'change stable-variable type'],
        originalUnchanged: true, qualification: 'complete structural and definition-byte oracle; no hardware/behavioral requirements inferred' });
    }
  });

process.on('exit', () => console.log(`R0 environment artifacts: ${runRoot}`));
