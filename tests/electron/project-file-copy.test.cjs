const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { copyProjectDirectory, copyCoderTemplateDirectory, copyRecoveryProjectDirectory, importProjectDirectory } = require('../../electron/project-file-copy');
const roots = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-copy-')); roots.push(root); return root; };

test('recovery copies retain resources and source bytes but never inherit public ABS or its private authority', () => {
  const source = directory(), target = directory();
  const values = { 'package.json': '{"name":"source"}', 'project.abi': 'native snapshot',
    'project.abs': 'unapplied draft', 'project.abs.map.json': 'old map',
    '.aily/abs-sync/committed.json': 'old pointer', '.aily/abs-sync/pending.json': 'pending journal',
    '.aily/data/resource.txt': 'retained resource', 'node_modules/fixture/package.json': '{}',
    '.aily/project-files.write.lock': 'writer', '.build/aily-workspace.lock': 'owner',
    '.aily/build-executions/run/project/node_modules/dependency.c': 'execution input' };
  for (const [file, text] of Object.entries(values)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), text);
  }
  copyRecoveryProjectDirectory(source, target);
  for (const file of ['project.abs', 'project.abs.map.json', '.aily/abs-sync', '.aily/project-files.write.lock', '.build', '.aily/build-executions'])
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
  const excluded = ['.aily/project-files.write.lock', '.aily/project-open.lock', '.aily/project-view.guard',
    `.aily/.project-open.lock.${id}.tmp`, `.project.abi.${id}.tmp`, `.project.abs.${id}.tmp`,
    `.project.abs.map.json.${id}.tmp`, `.project-data-backup.${id}.tmp`, `.abs-sync-${id}.tmp`,
    `.aily/abs-sync/.abs-sync-${id}.tmp`, `.aily/abs-sync/baselines/.abs-sync-${id}.tmp`,
    `.aily/.project-files.write.lock.${id}.tmp`, '.aily/build-executions/run/project/node_modules/dependency.c',
    '.aily/cloud-build/.build/cloud/job/firmware.bin'];
  const included = ['project.abi', 'project.abs', 'project.abs.map.json', 'project.abi.pre-project-data.bak', 'user.tmp',
    '.aily/abs-sync/recovery.json', '.aily/abs-sync/prepared.json', '.aily/abs-sync/baselines/g1.json',
    '.aily/abs-sync/user.tmp', `nested/.abs-sync-${id}.tmp`, '.aily/project-data-backups/original.abi', 'assets/project-data/ab/resource.bin',
    'src/user.lock', 'nested/.aily/project-files.write.lock', 'nested/.aily/project-open.lock',
    'nested/.aily/build-executions/data.txt', `.project.abi.${'a'.repeat(36)}.tmp`,
    `.aily/.project-files.write.lock.${'a'.repeat(36)}.tmp`, `nested/.aily/.project-files.write.lock.${id}.tmp`];
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

test('Coder template copies preserve the project skeleton and leave entry selection to the creator', () => {
  const source = directory(); const target = directory();
  const included = ['sketch/src/main.ino', 'sketch/src/helper.h', 'sketch/libraries/Extra/library.properties', 'assets/greeting.txt', 'README.md'];
  const excluded = ['package.json', 'project.aci', '.build/firmware.bin', '.aily/project-open.lock'];
  for (const file of [...included, ...excluded]) {
    const full = path.join(source, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file);
  }

  copyCoderTemplateDirectory(source, target);

  for (const file of included) assert.equal(fs.readFileSync(path.join(target, file), 'utf8'), file);
  for (const file of excluded) assert.equal(fs.existsSync(path.join(target, file)), false);
});

for (const method of ['save-as', 'folder-import', 'wrapped-archive-import']) {
  test(`Coder ${method} retains the old History and mode in an inactive archive`, () => {
    const origin = directory(), parent = directory(), target = path.join(parent, 'independent copy');
    const source = method === 'wrapped-archive-import' ? path.join(origin, 'project-wrapper') : origin;
    const inherited = {
      '.workspace-history/workspace.json': '{"executionMigration":{"phase":"prepared"}}\n',
      '.workspace-history/overlays/turn.json': 'copied writer',
      '.workspace-history/objects/source.bin': Buffer.from([0, 13, 255, 64]),
      ...(method === 'wrapped-archive-import' ? {} : { '.aily/workspace-mode.json': '{"version":1,"mode":"project-v1"}\n' }),
    };
    const ordinary = {
      'package.json': method === 'folder-import' ? '{"name":"legacy"}' : '{"type":"coder"}',
      'project.aci': '',
      'sketch/src/main.cpp': 'int value = 1;\n',
      '.aily/history-recovery/older/.workspace-history/workspace.json': 'older archive',
      '.aily/coder-embed-hints.json': '{}',
    };
    for (const [name, bytes] of Object.entries({ ...inherited, ...ordinary })) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), bytes);
    }
    if (method === 'save-as') {
      fs.mkdirSync(target);
      copyProjectDirectory(source, target);
    } else assert.equal(importProjectDirectory(origin, target, method === 'wrapped-archive-import'), target);

    const recovery = path.join(target, '.aily/history-recovery');
    const archives = fs.readdirSync(recovery).filter(name => name !== 'older');
    assert.equal(archives.length, 1);
    for (const [name, bytes] of Object.entries(inherited)) {
      const archivedName = name.startsWith('.aily/') ? path.basename(name) : name;
      assert.equal(fs.existsSync(path.join(target, name)), false, name);
      const expected = Buffer.from(bytes);
      assert.deepEqual(fs.readFileSync(path.join(recovery, archives[0], archivedName)), expected);
      assert.deepEqual(fs.readFileSync(path.join(source, name)), expected);
    }
    for (const [name, text] of Object.entries(ordinary)) {
      assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), text);
    }
  });
}

test('a clean Coder cloud import opens without synthesizing archived History', () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'clean import');
  fs.writeFileSync(path.join(source, 'package.json'), '{"type":"coder"}');
  fs.writeFileSync(path.join(source, 'project.aci'), '');
  fs.mkdirSync(path.join(source, 'sketch/src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'sketch/src/main.cpp'), 'int value = 1;');
  importProjectDirectory(source, target, true);
  assert.equal(fs.existsSync(path.join(target, '.workspace-history')), false);
  assert.equal(fs.existsSync(path.join(target, '.aily')), false);
  assert.equal(fs.readFileSync(path.join(target, 'sketch/src/main.cpp'), 'utf8'), 'int value = 1;');
});

for (const wrapped of [false, true]) {
  test(`Blockly ${wrapped ? 'wrapped cloud archive' : 'local directory'} import preserves drafts and drops source write authority`, () => {
    const origin = directory(), parent = directory(), target = path.join(parent, 'independent copy');
    const source = wrapped ? path.join(origin, 'project-wrapper') : origin;
    const inherited = {
      '.workspace-history/workspace.json': '{"executionMigration":{"phase":"prepared"}}\n',
      '.workspace-history/native-history/overlays/turn.json': 'copied active writer',
      '.aily/workspace-mode.json': '{"version":1,"mode":"project-v1"}\n',
      '.aily/abs-sync/committed.json': 'old accepted generation',
      '.aily/abs-sync/prepared.json': 'interrupted accepted generation',
      '.aily/abs-sync/operation.json': 'old native operation',
      'project.abs.map.json': 'old scope and identity map',
      'project.abs': Buffer.from([0x23, 0x20, 0x0d, 0x0a, 0xff, 0x0a]),
    };
    const ordinary = {
      'package.json': '{"name":"old-blockly"}',
      'project.abi': '{"blocks":{"blocks":[]}}',
      '.aily/history-recovery/older/project.abs': 'older archive',
      '.aily/project-data-backups/old.abi': 'existing recovery resource',
      'assets/project-data/ff/resource.bin': 'referenced project data',
    };
    for (const [name, contents] of Object.entries({ ...inherited, ...ordinary })) {
      const file = path.join(source, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    importProjectDirectory(origin, target, wrapped);
    const recovery = path.join(target, '.aily/history-recovery');
    const [archive] = fs.readdirSync(recovery).filter(name => name.startsWith('copy-'));
    assert.ok(archive);
    for (const [name, contents] of Object.entries(inherited)) {
      assert.ok(!fs.existsSync(path.join(target, name)), name);
      const archivedName = name.startsWith('.aily/') ? name.slice('.aily/'.length) : name;
      const expected = Buffer.from(contents);
      assert.deepEqual(fs.readFileSync(path.join(recovery, archive, archivedName)), expected);
      assert.deepEqual(fs.readFileSync(path.join(source, name)), expected);
    }
    for (const [name, contents] of Object.entries(ordinary)) {
      assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), contents);
      assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), contents);
    }
  });
}

test('an ABS-only Blockly import preserves its public source despite a leftover Coder launcher', () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'blockly import');
  fs.writeFileSync(path.join(source, 'package.json'), '{"name":"blockly"}');
  fs.writeFileSync(path.join(source, 'project.abs'), '\n# @project-state:{}\n');
  fs.writeFileSync(path.join(source, 'project.aci'), 'old launcher');
  fs.mkdirSync(path.join(source, '.workspace-history'));
  fs.writeFileSync(path.join(source, '.workspace-history/workspace.json'), 'old Blockly state');
  importProjectDirectory(source, target, true);
  const recovery = path.join(target, '.aily/history-recovery');
  const [archive] = fs.readdirSync(recovery);
  assert.ok(!fs.existsSync(path.join(target, '.workspace-history')));
  assert.equal(fs.readFileSync(path.join(target, 'project.abs'), 'utf8'), '\n# @project-state:{}\n');
  assert.equal(fs.readFileSync(path.join(recovery, archive, '.workspace-history/workspace.json'), 'utf8'), 'old Blockly state');
  assert.equal(fs.readFileSync(path.join(source, '.workspace-history/workspace.json'), 'utf8'), 'old Blockly state');
});

test('Blockly imports with complete ABS retain a damaged ABI and map outside active recovery paths', () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'blockly import');
  const projectAbs = '# ABS Schema: 2\n# @project-state:{"version":1}\n';
  for (const [name, contents] of Object.entries({
    'package.json': '{"name":"blockly"}', 'project.abs': projectAbs,
    'project.abi': 'damaged ABI', 'project.abs.map.json': 'old map',
    '.workspace-history/native-history.selected': '1\n',
  })) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  importProjectDirectory(source, target);
  const recovery = path.join(target, '.aily/history-recovery');
  const [archive] = fs.readdirSync(recovery);
  assert.equal(fs.readFileSync(path.join(target, 'project.abs'), 'utf8'), projectAbs);
  for (const [name, contents] of Object.entries({ 'project.abi': 'damaged ABI', 'project.abs.map.json': 'old map' })) {
    assert.equal(fs.existsSync(path.join(target, name)), false);
    assert.equal(fs.readFileSync(path.join(recovery, archive, name), 'utf8'), contents);
    assert.equal(fs.readFileSync(path.join(source, name), 'utf8'), contents);
  }
});

test('Blockly imports with no inherited History retain their existing ABS source and do not invent archives', () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'ordinary import');
  for (const [name, contents] of Object.entries({
    'package.json': '{"name":"blockly"}',
    'project.abi': '{"blocks":{}}',
    'project.abs': 'ordinary source',
    'project.abs.map.json': 'ordinary map',
  })) fs.writeFileSync(path.join(source, name), contents);
  importProjectDirectory(source, target);
  assert.equal(fs.existsSync(path.join(target, '.aily')), false);
  assert.equal(fs.readFileSync(path.join(target, 'project.abs'), 'utf8'), 'ordinary source');
  assert.equal(fs.readFileSync(path.join(target, 'project.abs.map.json'), 'utf8'), 'ordinary map');
});

test('read-only Blockly archive metadata can become writable in the fresh copy', { skip: process.platform === 'win32' }, () => {
  const source = directory(), parent = directory(), target = path.join(parent, 'fresh target');
  const legacy = path.join(source, '.aily/history-recovery');
  fs.mkdirSync(legacy, { recursive: true });
  fs.mkdirSync(path.join(source, '.workspace-history'));
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  fs.writeFileSync(path.join(source, 'project.abi'), '{"blocks":{}}');
  fs.writeFileSync(path.join(source, '.workspace-history/workspace.json'), 'old history');
  fs.chmodSync(legacy, 0o555);
  fs.chmodSync(path.dirname(legacy), 0o555);
  try {
    importProjectDirectory(source, target, true);
    const fresh = path.join(target, '.aily/history-recovery');
    const [archive] = fs.readdirSync(fresh);
    assert.equal(fs.readFileSync(path.join(fresh, archive, '.workspace-history/workspace.json'), 'utf8'), 'old history');
    for (const name of ['.aily', '.aily/history-recovery']) {
      assert.equal(fs.lstatSync(path.join(source, name)).mode & 0o777, 0o555);
      assert.equal(fs.lstatSync(path.join(target, name)).mode & 0o777, 0o755);
    }
  } finally {
    fs.chmodSync(path.dirname(legacy), 0o755);
    fs.chmodSync(legacy, 0o755);
  }
});

test('Coder import rejects a linked History root without touching its target', () => {
  const source = directory(), parent = directory(), external = directory();
  fs.writeFileSync(path.join(source, 'package.json'), '{"type":"coder"}');
  fs.writeFileSync(path.join(external, 'workspace.json'), 'untouched');
  fs.symlinkSync(external, path.join(source, '.workspace-history'), process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(parent, 'copy');
  assert.throws(() => importProjectDirectory(source, target), /History metadata.*symbolic link/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(external, 'workspace.json'), 'utf8'), 'untouched');
});

test('Coder template copies reject linked directories before following them for entry creation', () => {
  const source = directory(); const target = directory(); const external = directory();
  fs.writeFileSync(path.join(external, 'original.ino'), 'external source');
  fs.symlinkSync(external, path.join(source, 'sketch'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyCoderTemplateDirectory(source, target), /symbolic links/);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.readFileSync(path.join(external, 'original.ino'), 'utf8'), 'external source');
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
  const privateExecutionFile = '.aily/build-executions/run/project/node_modules/dependency.c';
  for (const file of [...runtimeFiles, privateExecutionFile]) {
    const full = path.join(wrapped, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file);
  }
  const target = path.join(parent, 'copy with spaces');
  assert.equal(importProjectDirectory(source, target, true), target);
  assert.equal(fs.readFileSync(path.join(target, 'project.abi'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(target, '.aily/project-files.write.lock')), false);
  assert.equal(fs.existsSync(path.join(target, '.aily/build-executions')), false);
  assert.equal(fs.readFileSync(path.join(wrapped, privateExecutionFile), 'utf8'), privateExecutionFile);
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

test('failed copies remove only the fresh import directory', () => {
  const source = directory(); const parent = directory(); const target = path.join(parent, 'target');
  const other = path.join(parent, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'keep'), 'keep');
  fs.writeFileSync(path.join(source, 'package.json'), '{}');
  fs.symlinkSync(other, path.join(source, '.aily'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => importProjectDirectory(source, target), /metadata/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(source, '.aily')).isSymbolicLink(), true);
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
