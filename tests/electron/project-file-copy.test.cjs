const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { copyProjectDirectory, copyRecoveryProjectDirectory, importProjectDirectory } = require('../../electron/project-file-copy');
const roots = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-copy-')); roots.push(root); return root; };

test('recovery copies retain resources and source bytes but never inherit public ABS or its private authority', () => {
  const source = directory(), target = directory();
  const values = { 'package.json': '{"name":"source"}', 'project.abi': 'native snapshot',
    'project.abs': 'unapplied draft', 'project.abs.map.json': 'old map',
    '.aily/abs-sync/committed.json': 'old pointer', '.aily/abs-sync/pending.json': 'pending journal',
    '.aily/data/resource.txt': 'retained resource', 'node_modules/fixture/package.json': '{}',
    '.aily/project-files.write.lock': 'writer', '.build/aily-workspace.lock': 'owner' };
  for (const [file, text] of Object.entries(values)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  copyRecoveryProjectDirectory(source, target);
  for (const file of ['project.abs', 'project.abs.map.json', '.aily/abs-sync', '.aily/project-files.write.lock', '.build'])
    assert.equal(fs.existsSync(path.join(target, file)), false, file);
  for (const file of ['package.json', 'project.abi', '.aily/data/resource.txt', 'node_modules/fixture/package.json'])
    assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), values[file]);
  for (const [file, text] of Object.entries(values)) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), text);
});

test('copies retarget canonical local-library directory links to the destination without file-symlink privilege', () => {
  const source = directory(), target = directory();
  const local = 'local-libraries/@aily-project/lib-local-fixture';
  fs.mkdirSync(path.join(source, local), { recursive: true });
  fs.writeFileSync(path.join(source, local, 'package.json'), '{"name":"@aily-project/lib-local-fixture","version":"1.0.0"}');
  fs.writeFileSync(path.join(source, local, 'generator.js'), 'original generator');
  fs.mkdirSync(path.join(source, 'node_modules/@aily-project'), { recursive: true });
  const relative = 'node_modules/@aily-project/lib-local-fixture';
  fs.symlinkSync(path.join(source, local), path.join(source, relative), process.platform === 'win32' ? 'junction' : 'dir');
  copyRecoveryProjectDirectory(source, target);
  assert.equal(fs.realpathSync(path.join(target, relative)), fs.realpathSync(path.join(target, local)));
  fs.writeFileSync(path.join(target, relative, 'generator.js'), 'target-only edit');
  assert.equal(fs.readFileSync(path.join(source, local, 'generator.js'), 'utf8'), 'original generator');
});

test('materializes an external linked library without copying its repository or retaining the link', () => {
  const source = directory(), target = directory(), external = directory();
  fs.writeFileSync(path.join(external, 'package.json'), '{"name":"@aily-project/lib-external-fixture"}');
  fs.writeFileSync(path.join(external, 'generator.js'), 'external original');
  fs.mkdirSync(path.join(external, '.git')); fs.writeFileSync(path.join(external, '.git/config'), 'not copied');
  fs.mkdirSync(path.join(source, 'node_modules/@aily-project'), { recursive: true });
  const relative = 'node_modules/@aily-project/lib-external-fixture';
  fs.symlinkSync(external, path.join(source, relative), process.platform === 'win32' ? 'junction' : 'dir');
  copyRecoveryProjectDirectory(source, target);
  assert.equal(fs.lstatSync(path.join(target, relative)).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(target, relative, '.git')), false);
  fs.writeFileSync(path.join(target, relative, 'generator.js'), 'copied edit');
  assert.equal(fs.readFileSync(path.join(external, 'generator.js'), 'utf8'), 'external original');
});

test('rejects linked metadata directories before a copy can follow them outside the project', () => {
  const source = directory(), target = directory(), external = directory();
  fs.symlinkSync(external, path.join(source, '.aily'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyRecoveryProjectDirectory(source, target), /metadata/);
  assert.equal(fs.readdirSync(external).length, 0);
});
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-project-copy-'));
  fs.rmSync(root, { recursive: true, force: true });
} });

test('project copies exclude writer/lifecycle transient files and preserve recovery/resource data', () => {
  const source = directory(); const target = directory();
  const id = '12345678-1234-1234-1234-123456789abc';
  const excluded = ['.aily/project-files.write.lock', '.aily/project-open.lock', `.project.abi.${id}.tmp`, `.project.abs.${id}.tmp`,
    `.project.abs.map.json.${id}.tmp`, `.project-data-backup.${id}.tmp`, `.abs-sync-${id}.tmp`,
    `.aily/abs-sync/.abs-sync-${id}.tmp`, `.aily/abs-sync/baselines/.abs-sync-${id}.tmp`];
  const included = ['project.abi', 'project.abs', 'project.abs.map.json', 'project.abi.pre-project-data.bak', 'user.tmp',
    '.aily/abs-sync/recovery.json', '.aily/abs-sync/prepared.json', '.aily/abs-sync/baselines/g1.json',
    '.aily/abs-sync/user.tmp', `nested/.abs-sync-${id}.tmp`, '.aily/project-data-backups/original.abi', 'assets/project-data/ab/resource.bin',
    'src/user.lock', 'nested/.aily/project-files.write.lock', 'nested/.aily/project-open.lock', `.project.abi.${'a'.repeat(36)}.tmp`];
  for (const file of [...excluded, ...included]) {
    const full = path.join(source, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file);
  }
  copyProjectDirectory(source, target);
  for (const file of excluded) { assert.equal(fs.existsSync(path.join(target, file)), false); assert.ok(fs.existsSync(path.join(source, file))); }
  for (const file of included) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), file);
});

test('save-as copies exclude root runtime directories without filtering nested project content', () => {
  const source = directory(); const target = directory();
  const excluded = ['.workspace-history/snapshot.json', '.temp/sketch/sketch.ino', '.log/compile/latest-result.json', '.build/firmware.bin'];
  const included = ['sketch/src/main.cpp', 'sketch/libraries/Local/.temp/source.h', '.workspace-history-backup/keep.json', '.git/config'];
  for (const file of [...excluded, ...included]) {
    const full = path.join(source, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file);
  }
  copyProjectDirectory(source, target);
  for (const file of excluded) {
    assert.equal(fs.existsSync(path.join(target, file.split('/')[0])), false);
    assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), file);
  }
  for (const file of included) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), file);
});

test('save-as skips history junctions when Electron cannot create symbolic links', t => {
  const result = spawnSync(require('electron'), [path.join(__dirname, 'fixtures/project-copy-history-symlink.cjs'), directory()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  t.diagnostic(result.stdout.trim());
});

test('project copies reject self, descendant, linked or nonempty targets without merging', () => {
  const source = directory(); const child = path.join(source, 'child'); fs.mkdirSync(child);
  const occupied = directory(); fs.writeFileSync(path.join(occupied, 'keep'), 'keep');
  const links = directory(); const alias = path.join(links, 'alias'); fs.symlinkSync(source, alias, 'junction');
  for (const target of [source, child, alias, occupied]) assert.throws(() => copyProjectDirectory(source, target));
  assert.equal(fs.readFileSync(path.join(occupied, 'keep'), 'utf8'), 'keep');
  assert.throws(() => copyProjectDirectory('relative', directory()));
});

test('save-as preserves ordinary files named like runtime directories', () => {
  const source = directory(); const target = directory();
  fs.writeFileSync(path.join(source, '.workspace-history'), 'user file');
  copyProjectDirectory(source, target);
  assert.equal(fs.readFileSync(path.join(target, '.workspace-history'), 'utf8'), 'user file');
});

test('project copy filtering respects Windows path case equivalence', () => {
  const source = directory(); const target = directory();
  const name = '.AILY/PROJECT-FILES.WRITE.LOCK';
  fs.mkdirSync(path.dirname(path.join(source, name))); fs.writeFileSync(path.join(source, name), 'owner');
  fs.mkdirSync(path.join(source, '.TEMP')); fs.writeFileSync(path.join(source, '.TEMP/cache'), 'cache');
  copyProjectDirectory(source, target);
  assert.equal(fs.existsSync(path.join(target, name)), process.platform !== 'win32');
  assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), 'owner');
  assert.equal(fs.existsSync(path.join(target, '.TEMP/cache')), process.platform !== 'win32');
});

test('imports the actual project from a single archive wrapper and filters its lock before copying', () => {
  const source = directory(); const parent = directory(); const wrapped = path.join(source, 'wrapper');
  fs.mkdirSync(path.join(wrapped, '.aily'), { recursive: true });
  fs.writeFileSync(path.join(wrapped, 'package.json'), '{}'); fs.writeFileSync(path.join(wrapped, 'project.abi'), 'original');
  fs.writeFileSync(path.join(wrapped, '.aily/project-files.write.lock'), 'source owner');
  const runtimeFiles = ['.workspace-history/snapshot.json', '.temp/cache', '.log/output', '.build/firmware.bin'];
  for (const file of runtimeFiles) {
    const full = path.join(wrapped, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file);
  }
  const target = path.join(parent, 'copy with spaces');
  assert.equal(importProjectDirectory(source, target, true), target);
  assert.equal(fs.readFileSync(path.join(target, 'project.abi'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(target, '.aily/project-files.write.lock')), false);
  assert.equal(fs.readFileSync(path.join(wrapped, '.aily/project-files.write.lock'), 'utf8'), 'source owner');
  for (const file of runtimeFiles) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), file);
});

test('imports read-only archive metadata as writable copies without changing the source', () => {
  const source = directory(); const parent = directory(); const target = path.join(parent, 'imported');
  for (const name of ['package.json', 'project.abi']) {
    fs.writeFileSync(path.join(source, name), '{}'); fs.chmodSync(path.join(source, name), 0o444);
  }
  importProjectDirectory(source, target);
  for (const name of ['package.json', 'project.abi']) {
    assert.equal(fs.statSync(path.join(source, name)).mode & 0o200, 0);
    assert.notEqual(fs.statSync(path.join(target, name)).mode & 0o200, 0);
    fs.writeFileSync(path.join(target, name), '{"opened":true}');
  }
});

test('imports reject collisions, ambiguous archives, missing packages and descendants without deleting files', () => {
  const source = directory(); const parent = directory(); const target = path.join(parent, 'target');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'keep');
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  assert.throws(() => importProjectDirectory(source, target));
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'keep');
  assert.throws(() => importProjectDirectory(source, path.join(source, 'child')));
  assert.equal(fs.existsSync(path.join(source, 'child')), false);
  const archive = directory(); fs.mkdirSync(path.join(archive, 'a')); fs.mkdirSync(path.join(archive, 'b'));
  const missing = path.join(parent, 'missing');
  assert.throws(() => importProjectDirectory(archive, missing, true)); assert.equal(fs.existsSync(missing), false);
  assert.throws(() => importProjectDirectory(archive, missing)); assert.equal(fs.existsSync(missing), false);
});

test('imports create missing parents only after validating the source and resolved destination', () => {
  const source = directory(); const parent = directory();
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  const target = path.join(parent, 'new', 'nested', 'project');
  importProjectDirectory(source, target);
  assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), '{}');
  const alias = path.join(parent, 'alias'); fs.symlinkSync(source, alias, 'junction');
  assert.throws(() => importProjectDirectory(source, path.join(alias, 'new', 'project')));
  assert.equal(fs.existsSync(path.join(source, 'new')), false);
  const invalid = path.join(parent, 'not-created', 'project');
  assert.throws(() => importProjectDirectory(directory(), invalid));
  assert.equal(fs.existsSync(path.dirname(invalid)), false);
});
