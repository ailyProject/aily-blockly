const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { transformSync } = require('esbuild');

// Execute the production methods, with actual isolated manifest bytes. This
// avoids importing Angular or simulating the method's publication decisions.
const source = fs.readFileSync('src/app/services/domains/project/project.service.ts', 'utf8');
const parsed = ts.createSourceFile('project.service.ts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ProjectService');
const names = ['getBoardConfigMenu', 'setPackageJson'];
const methods = names.map(name => {
  const member = declaration.members.find(node => node.name?.getText(parsed) === name);
  assert.ok(member, `Production method ${name} exists`);
  return member.getText(parsed);
});
const compiled = transformSync(`class Subject { ${methods.join('\n')} }; module.exports = Subject;`,
  { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

function fixture(t) {
  const parent = path.resolve('tests/test-results/r2-environment-boundaries');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'menu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestFile = path.join(root, 'package.json');
  const before = JSON.stringify({ name: 'r2-board-menu', dependencies: { '@aily-project/board-probe': '1.0.0' } }, null, 2);
  fs.writeFileSync(manifestFile, before);
  const writes = [], pins = [], module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, console, window: { fs: {
    writeFileSync: (file, text) => { writes.push(file); fs.writeFileSync(file, text); },
  } } });
  const subject = Object.assign(new module.exports(), {
    currentProjectPath: root, isCoderProjectContext: false, currentBoardConfig: {}, currentBoardPinConfig: {},
    libraryChanges: new Map(), isAilyCodeProject: () => false,
    captureCurrentProjectGuard: () => () => true, getCompileBackendKey: () => 'local', isCloudBuild: () => false,
    cloneCurrentBoardMenuConfig: () => [{ key: 'BoardVariant', extra: { selectFirstByDefault: true },
      children: [{ name: 'Original board', data: 'probe', extra: { syncPinConfig: true } }] }],
    getPackageJson: async () => JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    getBoardNameFromBoardJson: () => null, getBoardDependencies: async () => ({}),
    compareConfigs: (left, right) => left === right, normalizeProjectPath: value => value,
    syncBoardPinConfig: async value => { pins.push(value); },
  });
  return { subject, before, writes, pins, read: () => fs.readFileSync(manifestFile, 'utf8') };
}

test('opening the ordinary Blockly board menu is a read and retains exact manifest bytes', async t => {
  const f = fixture(t), menu = await f.subject.getBoardConfigMenu();
  assert.equal(menu[0].children[0].check, true, 'The effective default is still visible');
  assert.equal(f.read(), f.before, 'Opening the menu must not publish a default project configuration');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.pins, [], 'A read must not request the save/reload pin-mutation path');
});

test('the explicit read-only menu mode returns the same default without publishing or syncing pins', async t => {
  const f = fixture(t), menu = await f.subject.getBoardConfigMenu({ persistDefaults: false });
  assert.equal(menu[0].children[0].check, true);
  assert.equal(f.read(), f.before);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.pins, []);
});

const environmentModule = { exports: {} };
vm.runInNewContext(`(function(require,module,exports){${transformSync(fs.readFileSync(
  'src/app/integrations/blockly/history-environment.ts', 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code}\n})`,
  { TextEncoder })(() => ({ AbsSyncError: class extends Error { constructor(code, message) { super(message); this.code = code; } } }),
  environmentModule, environmentModule.exports);
const { readHistoryEnvironment } = environmentModule.exports;

test('History environment binding retains exact whitelisted file inputs and no supplied program authority', () => {
  assert.equal(readHistoryEnvironment(undefined), undefined);
  const input = { version: 1, requestId: 'pub2-00000000-0000-4000-8000-000000000001', files: {
    'package.json': { expectedHash: 'sha256:' + '1'.repeat(64), content: '{"name":"history-environment"}' },
    'package-lock.json': { expectedHash: null, content: null }, '.npmrc': { expectedHash: null, content: '@aily-project:registry=https://example.invalid' },
    'npm-shrinkwrap.json': { expectedHash: null, content: '{"lockfileVersion":3,"packages":{}}' },
    'yarn.lock': { expectedHash: null, content: '# yarn lockfile v1\n\n' },
  } };
  assert.equal(JSON.stringify(readHistoryEnvironment(input)), JSON.stringify(input));
  for (const invalid of [null, {}, { ...input, programRef: {} }, { ...input, candidateApplied: true },
    { ...input, files: { ...input.files, 'project.abs': { expectedHash: null, content: 'forged' } } },
    { ...input, files: { ...input.files, 'pnpm-lock.yaml': { expectedHash: null, content: 'lockfileVersion: 9' } } },
    { ...input, files: { ...input.files, 'npm-shrinkwrap.json': { expectedHash: null, content: 'not JSON' } } },
    { ...input, files: { 'package.json': { content: '{}', expectedHash: null, overwrite: true } } },
    { ...input, files: { 'package.json': { content: null, expectedHash: null } } }]) {
    assert.throws(() => readHistoryEnvironment(invalid), { code: 'ABS_HISTORY_ENVIRONMENT_INVALID' });
  }
});

test('derived publication metadata does not stale an environment receipt or get rolled back', t => {
  const { LibraryEnvironmentJournal } = require('../../electron/library-environment-journal');
  const { restoreEnvironmentManifest } = require('../../electron/library-manifest-input');
  const parent = path.resolve('tests/test-results/r2-environment-boundaries');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = JSON.stringify({ name: 'environment', dependencies: {}, projectConfig: { mode: 'old' }, note: 'original' });
  const target = JSON.stringify({ ...JSON.parse(before), projectConfig: { mode: 'new' } });
  fs.writeFileSync(path.join(root, 'package.json'), before);
  const journal = new LibraryEnvironmentJournal();
  journal.begin(root, { requestId: 'metadata-receipt', operation: 'board-config', files: { 'package.json': { content: target } } }, null, () => {});
  fs.writeFileSync(path.join(root, 'package.json'), target);
  journal.complete(root, () => {});
  const generated = { ...JSON.parse(target), codeHash: 'published-later', buildInfo: { platform: 'new' },
    MACROS: [['USER=2'], ['GENERATED=3']], ailyGeneratorMacros: { GENERATED: 'GENERATED=3' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(generated));
  assert.equal(journal.observe(root, 'metadata-receipt').current, false, 'A new user macro is an environment change');
  delete generated.MACROS[0]; generated.MACROS = generated.MACROS.filter(Boolean);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(generated));
  assert.equal(journal.observe(root, 'metadata-receipt').current, true, 'Generated-only fields remain owned by publication');
  const changedNote = { ...generated, note: 'independent-after-operation' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(changedNote));
  assert.equal(journal.observe(root, 'metadata-receipt').current, true, 'Unowned project metadata does not stale the installed environment');
  const restored = JSON.parse(restoreEnvironmentManifest(before, target, JSON.stringify(changedNote)));
  assert.equal(restored.projectConfig.mode, 'old');
  assert.equal(restored.note, changedNote.note, 'Rollback does not overwrite fields this operation never changed');
  assert.equal(restored.codeHash, generated.codeHash);
  assert.deepEqual(restored.buildInfo, generated.buildInfo);
  assert.deepEqual(restored.MACROS, generated.MACROS);
  assert.throws(() => restoreEnvironmentManifest(before, target, JSON.stringify({ ...generated, projectConfig: { mode: 'competing' } })),
    { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN' });
});

test('a retained executable symlink is restored as a link so its relative imports keep their original resolution', t => {
  const { LibraryEnvironmentJournal } = require('../../electron/library-environment-journal');
  const parent = path.resolve('tests/test-results/r2-environment-boundaries'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'bin-link-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/r2-bin/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"bin-owner"}');
  fs.writeFileSync(path.join(root, 'node_modules/r2-bin/bin/probe.js'), 'console.log(require("../data.json").value)');
  fs.writeFileSync(path.join(root, 'node_modules/r2-bin/data.json'), '{"value":"retained-original-bin"}');
  const bin = path.join(root, 'node_modules/.bin/r2-bin');
  try { fs.symlinkSync('../r2-bin/bin/probe.js', bin, 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('This Windows account cannot create real file symlinks. Actual npm Windows shims are covered separately.'); return; } throw error; }
  const journal = new LibraryEnvironmentJournal(), original = journal.begin(root, { operation: 'bin-removal' }, null, () => {});
  journal.preserve(root, ['node_modules/r2-bin', 'node_modules/.bin/r2-bin'], () => {});
  fs.unlinkSync(bin);
  fs.writeFileSync(path.join(root, 'node_modules/r2-bin/data.json'), '{"value":"newer"}');
  journal.restore(root, original, () => {});
  assert.equal(fs.lstatSync(bin).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(bin), '../r2-bin/bin/probe.js');
  assert.equal(require('node:child_process').execFileSync(process.execPath, [bin], { encoding: 'utf8' }).trim(), 'retained-original-bin');
});

test('only a verified same-operation canonical library archive permits restoring an installed junction', t => {
  const { LibraryEnvironmentJournal } = require('../../electron/library-environment-journal');
  const parent = path.resolve('tests/test-results/r2-environment-boundaries'); fs.mkdirSync(parent, { recursive: true });
  const suite = fs.mkdtempSync(path.join(parent, 'local-topology-')), root = path.join(suite, 'project');
  t.after(() => { assert.ok(suite.startsWith(parent + path.sep)); fs.rmSync(suite, { recursive: true, force: true }); });
  const canonical = 'local-libraries/@aily-project/lib-internal', installed = 'node_modules/@aily-project/lib-internal';
  const external = path.join(suite, 'external'), externalInstalled = 'node_modules/@aily-project/lib-external';
  fs.mkdirSync(path.join(root, canonical), { recursive: true }); fs.mkdirSync(path.dirname(path.join(root, installed)), { recursive: true }); fs.mkdirSync(external);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"topology-boundary"}');
  for (const folder of [path.join(root, canonical), external]) fs.writeFileSync(path.join(folder, 'old.txt'), 'original');
  fs.symlinkSync(path.join(root, canonical), path.join(root, installed), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(external, path.join(root, externalInstalled), process.platform === 'win32' ? 'junction' : 'dir');
  const journal = new LibraryEnvironmentJournal(), operation = journal.begin(root, { operation: 'local-topology' }, null, () => {});
  journal.preserve(root, [canonical, installed, externalInstalled], () => {});
  fs.writeFileSync(path.join(root, canonical, 'old.txt'), 'new canonical'); fs.writeFileSync(path.join(external, 'old.txt'), 'external new');
  journal.restore(root, operation, () => {});
  assert.equal(fs.readFileSync(path.join(root, canonical, 'old.txt'), 'utf8'), 'original');
  assert.equal(fs.lstatSync(path.join(root, installed)).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(path.join(root, installed)), fs.realpathSync(path.join(root, canonical)));
  assert.equal(fs.readFileSync(path.join(root, externalInstalled, 'old.txt'), 'utf8'), 'original');
  assert.equal(fs.lstatSync(path.join(root, externalInstalled)).isSymbolicLink(), false, 'External link restoration must keep retained bytes detached');
  assert.equal(fs.readFileSync(path.join(external, 'old.txt'), 'utf8'), 'external new', 'No external source may be compensated');
});

test('retaining and restoring an absent installed leaf never creates or removes its parent directories', t => {
  const { LibraryEnvironmentJournal } = require('../../electron/library-environment-journal');
  const parent = path.resolve('tests/test-results/r2-environment-boundaries'); fs.mkdirSync(parent, { recursive: true });
  for (const lateUserParent of [false, true]) {
    const root = fs.mkdtempSync(path.join(parent, 'absent-installed-'));
    t.after(() => { assert.ok(root.startsWith(parent + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"absent-installed"}');
    const journal = new LibraryEnvironmentJournal(), operation = journal.begin(root, { operation: 'local-import-before-npm' }, null, () => {});
    journal.preserve(root, ['node_modules/@aily-project/lib-not-yet-installed'], () => {});
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false, 'Archiving a missing leaf is not an npm write');
    if (lateUserParent) {
      fs.mkdirSync(path.join(root, 'node_modules/@aily-project'), { recursive: true });
      fs.writeFileSync(path.join(root, 'node_modules/@aily-project/user.txt'), 'later independent file');
    }
    journal.restore(root, operation, () => {});
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), lateUserParent);
    if (lateUserParent) assert.equal(fs.readFileSync(path.join(root, 'node_modules/@aily-project/user.txt'), 'utf8'), 'later independent file');
  }
});
