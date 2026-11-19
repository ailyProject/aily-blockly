const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { seedPlatformManifests } = require('../../electron/project-repair-environment');
const output = path.resolve(__dirname, '../test-results/repair-platform-manifests');
const compiler = '@aily-project/compiler-esp-rv32', sdk = '@aily-project/sdk-esp32', board = '@aily-project/board-esp32c3';
function fixture(t) {
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(output, 'case-'));
  t.after(() => {
    assert.equal(path.dirname(root), output); fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'), parent = path.join(root, 'parent'), privateData = path.join(root, 'private');
  for (const directory of [project, parent]) fs.mkdirSync(directory);
  const write = (directory, value) => {
    const file = path.join(directory, 'package.json'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value)); return file;
  };
  const packageFile = (directory, name) => path.join(directory, 'node_modules', name, 'package.json');
  const put = (directory, name, version, extra) => write(path.dirname(packageFile(directory, name)), { name, version, ...extra });
  const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
  write(project, { name: 'fixture', dependencies: { [board]: '^3.3.0' } });
  put(project, board, '3.3.10', { boardDependencies: { [compiler]: '14.2.0', [sdk]: '~3.3.0' } });
  put(parent, compiler, '14.2.0', { scripts: { postinstall: 'never-executed' } }); put(parent, sdk, '3.3.10');
  return { root, project, parent, privateData, write, put, read, packageFile,
    run: () => seedPlatformManifests(privateData, project, parent) };
}
test('standard installed board supplies platform facts without root boardDependencies or copying package bodies', t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.project, 'package.json'));
  fs.writeFileSync(path.join(f.parent, 'node_modules', compiler, 'compiler.exe'), 'not-copied');
  const seeded = f.run();
  assert.deepEqual(seeded, { installed: { [compiler]: '14.2.0', [sdk]: '3.3.10' }, missing: [] });
  assert.deepEqual(f.read(f.packageFile(f.privateData, compiler)), f.read(f.packageFile(f.parent, compiler)));
  assert.deepEqual(f.read(path.join(f.privateData, 'package.json')).dependencies, seeded.installed);
  assert.deepEqual(fs.readdirSync(path.join(f.privateData, 'node_modules', compiler)), ['package.json']);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'package.json')), before);
  assert.equal(fs.lstatSync(path.join(f.privateData, 'node_modules', compiler)).isSymbolicLink(), false);
});
test('legacy root platform declarations merge with board requirements and valid installed ranges', t => {
  const f = fixture(t), tool = '@aily-project/tool-ctags';
  f.write(f.project, { dependencies: { [board]: '3.3.10' }, boardDependencies: { [compiler]: '^14.0.0', [tool]: '5.8.0' } });
  f.put(f.parent, tool, '5.8.0');
  assert.deepEqual(f.run().installed, { [compiler]: '14.2.0', [tool]: '5.8.0', [sdk]: '3.3.10' });
});
test('missing source metadata never fabricates readiness from compiler files or declarations', t => {
  const f = fixture(t); fs.unlinkSync(f.packageFile(f.parent, compiler));
  fs.writeFileSync(path.join(f.parent, 'node_modules', compiler, 'compiler.exe'), 'present');
  const seeded = f.run(); assert.equal(seeded.installed[compiler], undefined);
  assert.deepEqual(seeded.missing, [{ name: compiler, reason: 'manifest-missing' }]);
  assert.equal(fs.existsSync(f.packageFile(f.privateData, compiler)), false);
  assert.equal(f.read(path.join(f.privateData, 'package.json')).dependencies[compiler], undefined);
});
for (const kind of ['version', 'identity', 'conflicting-declaration']) test(`${kind} mismatch cannot seed a false platform installation`, t => {
  const f = fixture(t);
  if (kind === 'version') f.put(f.parent, compiler, '13.0.0');
  else if (kind === 'identity') f.write(path.dirname(f.packageFile(f.parent, compiler)), { name: '@aily-project/compiler-other', version: '14.2.0' });
  else f.write(f.project, { dependencies: { [board]: '^3.3.0' }, boardDependencies: { [compiler]: '13.0.0' } });
  assert.equal(f.run().installed[compiler], undefined); assert.equal(fs.existsSync(f.packageFile(f.privateData, compiler)), false);
});
for (const kind of ['missing', 'wrong-version']) test(`an explicit ${kind} installed board cannot supply invented declarations`, t => {
  const f = fixture(t);
  if (kind === 'missing') fs.unlinkSync(f.packageFile(f.project, board));
  else f.put(f.project, board, '2.0.0', { boardDependencies: { [compiler]: '14.2.0' } });
  const seeded = f.run(); assert.deepEqual(seeded.installed, {}); assert.equal(seeded.missing[0].name, board);
  assert.equal(fs.existsSync(f.packageFile(f.privateData, compiler)), false);
});
test('unrelated library platform declarations are not trusted as board installation metadata', t => {
  const f = fixture(t);
  f.write(f.project, { dependencies: { '@aily-project/lib-example': '1.0.0' } });
  f.put(f.project, '@aily-project/lib-example', '1.0.0', { boardDependencies: { [compiler]: '14.2.0' } });
  assert.deepEqual(f.run(), { installed: {}, missing: [] });
});
test('seeding is idempotent and never overwrites conflicting private metadata', t => {
  const f = fixture(t); f.run(); const file = f.packageFile(f.privateData, compiler);
  const before = fs.statSync(file).mtimeMs; f.run(); assert.equal(fs.statSync(file).mtimeMs, before);
  fs.writeFileSync(file, JSON.stringify({ name: compiler, version: '13.0.0' }));
  assert.throws(f.run, /conflicts/); assert.equal(f.read(file).version, '13.0.0');
});
test('existing private root metadata is preserved but conflicting dependency identity is rejected', t => {
  const f = fixture(t);
  f.write(f.privateData, { name: 'private-profile', custom: true, dependencies: { unrelated: '1.0.0' } });
  f.run(); assert.equal(f.read(path.join(f.privateData, 'package.json')).custom, true);
  assert.equal(f.read(path.join(f.privateData, 'package.json')).dependencies.unrelated, '1.0.0');
  const current = f.read(path.join(f.privateData, 'package.json')); current.dependencies[compiler] = '13.0.0'; f.write(f.privateData, current);
  assert.throws(f.run, /conflicts/);
});
test('platform and board package names cannot traverse or copy arbitrary installed packages', t => {
  const f = fixture(t);
  for (const name of ['../../outside', '@aily-project/lib-secret', '@other/compiler-esp']) {
    f.write(f.project, { boardDependencies: { [name]: '1.0.0' } }); assert.throws(f.run, /Invalid platform/);
  }
  f.write(f.project, { dependencies: { '@aily-project/board-../../outside': '1.0.0' } });
  assert.throws(f.run, /Invalid board/); assert.equal(fs.existsSync(f.privateData), false);
});
test('linked source and private destination escapes are refused without writing shared roots', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const compilerDirectory = path.dirname(f.packageFile(f.parent, compiler));
  fs.renameSync(compilerDirectory, path.join(outside, 'compiler'));
  fs.symlinkSync(path.join(outside, 'compiler'), compilerDirectory, 'junction');
  assert.throws(f.run, /escapes/); fs.unlinkSync(compilerDirectory);
  fs.renameSync(path.join(outside, 'compiler'), compilerDirectory);
  fs.mkdirSync(f.privateData); fs.symlinkSync(path.join(f.parent, 'node_modules'), path.join(f.privateData, 'node_modules'), 'junction');
  assert.throws(f.run, /linked outside/); assert.equal(fs.existsSync(path.join(f.privateData, 'package.json')), false);
});
test('project or shared destination aliases cannot be used as a private metadata directory', t => {
  const f = fixture(t);
  for (const destination of [f.project, path.join(f.project, 'private'), f.parent, f.root])
    assert.throws(() => seedPlatformManifests(destination, f.project, f.parent), /independent/);
  assert.throws(() => seedPlatformManifests('relative', f.project, f.parent), /absolute/);
});
