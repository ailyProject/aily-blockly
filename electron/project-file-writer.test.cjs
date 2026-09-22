const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { test, after } = require('node:test');
const { replaceProjectText } = require('./project-file-writer');
const roots = [];
const project = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-project-file-writer-')); roots.push(root); return root; };
after(() => { for (const root of roots) {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('aily-project-file-writer-'));
  fs.rmSync(root, { recursive: true, force: true });
} });
const hash = text => text === null ? null : `sha256:${createHash('sha256').update(text).digest('hex')}`;
const request = (root, content, before = 'before', fileName = 'project.abi') => ({ projectPath: root, fileName, content, expectedHash: hash(before) });
const guard = () => undefined;
const initialize = (root, text = 'before') => fs.writeFileSync(path.join(root, 'project.abi'), text);
const read = root => fs.readFileSync(path.join(root, 'project.abi'), 'utf8');
const assertClean = root => {
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
  assert.equal(fs.existsSync(path.join(root, '.aily', 'project-files.write.lock')), false);
};
test('publishes exact UTF-8 bytes, BOM and CRLF and cleans temporary files', async () => {
  const root = project(); initialize(root); const content = '\ufeff中文 😀\r\n{"saved":true}';
  assert.deepEqual(await replaceProjectText(request(root, content), guard), { status: 'COMMITTED', hash: hash(content) });
  assert.equal(read(root), content); assertClean(root);
});
test('legacy shadow migration retains a backup and requires an identity-free project', async () => {
  const root = project(); initialize(root);
  const result = await replaceProjectText({ ...request(root, 'migrated'), backup: 'project-data', migrateLegacyShadowIds: true }, guard);
  assert.equal(result.status, 'COMMITTED'); assert.equal(result.backupHash, hash('before'));
  assert.equal(fs.readFileSync(path.join(root, '.aily/project-data-backups', hash('before').slice(7) + '.abi'), 'utf8'), 'before');
  assert.equal(read(root), 'migrated'); assertClean(root);
});
for (const context of ['project.abs', 'project.abs.map.json', '.aily/abs-sync/committed.json', '.aily/abs-sync/prepared.json']) {
  test(`legacy shadow migration preserves existing ${context}`, async () => {
    const root = project(); initialize(root);
    const target = path.join(root, context); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'keep');
    const result = await replaceProjectText({ ...request(root, 'migrated'), backup: 'project-data', migrateLegacyShadowIds: true }, guard);
    assert.equal(result.status, 'NOT_COMMITTED'); assert.equal(result.code, 'BLOCKLY_IDENTITY_MIGRATION_BLOCKED');
    assert.equal(read(root), 'before'); assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assertClean(root);
  });
}
test('legacy shadow migration rechecks ABS context under the publication lock', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, writeFileSync(fd, ...args) {
    fs.writeFileSync(fd, ...args);
    if (typeof fd === 'number') fs.writeFileSync(path.join(root, 'project.abs'), 'concurrent draft');
  } };
  const result = await replaceProjectText({ ...request(root, 'migrated'), backup: 'project-data', migrateLegacyShadowIds: true }, guard, { files });
  assert.equal(result.status, 'NOT_COMMITTED'); assert.equal(result.code, 'BLOCKLY_IDENTITY_MIGRATION_BLOCKED');
  assert.equal(read(root), 'before'); assert.equal(fs.readFileSync(path.join(root, 'project.abs'), 'utf8'), 'concurrent draft'); assertClean(root);
});
test('creates missing mirrors and supports exact no-op commits', async () => {
  const root = project();
  for (const name of ['project.abi', 'project.abs', 'project.abs.map.json']) {
    assert.equal((await replaceProjectText(request(root, 'value', null, name), guard)).status, 'COMMITTED');
    assert.equal((await replaceProjectText(request(root, 'value', 'value', name), guard)).status, 'COMMITTED');
  } assertClean(root);
});

test('exact no-op validation takes the lock without creating or rewriting data files', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, promises: { ...fs.promises, open() { throw new Error('unexpected temp write'); } },
    renameSync() { throw new Error('unexpected rename'); } };
  assert.equal((await replaceProjectText(request(root, 'before'), guard, { files })).status, 'COMMITTED');
  assert.equal(read(root), 'before'); assertClean(root);
});
test('rejects a known conflict before creating directories or temp files', async () => {
  const root = project(); initialize(root, 'external');
  assert.equal((await replaceProjectText(request(root, 'after'), guard)).status, 'CONFLICT');
  assert.deepEqual(fs.readdirSync(root), ['project.abi']); assert.equal(read(root), 'external');
});
test('rechecks bytes inside the lock after temporary-file preparation', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, writeFileSync(fd, ...args) { fs.writeFileSync(fd, ...args); if (typeof fd === 'number') initialize(root, 'external'); } };
  assert.equal((await replaceProjectText(request(root, 'after'), guard, { files })).status, 'CONFLICT');
  assert.equal(read(root), 'external'); assertClean(root);
});
test('exactly one concurrent writer with the same expected hash commits', async () => {
  const root = project(); initialize(root);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => replaceProjectText(request(root, `after-${i}`), guard)));
  assert.equal(results.filter(r => r.status === 'COMMITTED').length, 1);
  assert.equal(results.filter(r => r.status === 'CONFLICT').length, 11); assertClean(root);
});
test('independent processes follow the same project lock and CAS', async () => {
  const root = project(); initialize(root);
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const code = `require(${JSON.stringify(require.resolve('./project-file-writer'))}).replaceProjectText(${JSON.stringify(request(root, `child-${i}`))},()=>{}).then(r=>process.stdout.write(JSON.stringify(r)));`;
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true }); let output = ''; let error = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  })));
  assert.equal(results.filter(r => r.status === 'COMMITTED').length, 1); assertClean(root);
});
test('never steals a lock, and a stale context aborts while waiting', async () => {
  const root = project(); initialize(root); fs.mkdirSync(path.join(root, '.aily'));
  const lock = path.join(root, '.aily', 'project-files.write.lock'); fs.writeFileSync(lock, 'unknown owner');
  assert.equal((await replaceProjectText(request(root, 'after'), guard, { timeoutMs: 5 })).code, 'PROJECT_FILE_BUSY');
  let count = 0; const result = await replaceProjectText(request(root, 'after'), () => { if (++count > 5) throw new Error('stale'); });
  assert.equal(result.status, 'NOT_COMMITTED'); assert.equal(result.error, 'stale');
  assert.equal(fs.readFileSync(lock, 'utf8'), 'unknown owner'); assert.equal(read(root), 'before');
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.tmp')).length, 0);
});
test('rejects stale, missing and asynchronous guards before target writes', async () => {
  const root = project(); initialize(root);
  for (const check of [() => { throw new Error('stale'); }, async () => { throw new Error('async'); }, undefined]) {
    assert.equal((await replaceProjectText(request(root, 'after'), check)).status, 'NOT_COMMITTED');
  } assert.deepEqual(fs.readdirSync(root), ['project.abi']);
});
test('cancels after async temp creation without deleting the target', async () => {
  const root = project(); initialize(root); let current = true;
  const files = { ...fs, promises: { ...fs.promises, async open(...args) { const handle = await fs.promises.open(...args); current = false; return handle; } } };
  assert.equal((await replaceProjectText(request(root, 'after'), () => { if (!current) throw new Error('stale'); }, { files })).status, 'NOT_COMMITTED');
  assert.equal(read(root), 'before'); assertClean(root);
});
test('cleans only its own temp file after pre-rename failure', async () => {
  const root = project(); initialize(root); const other = path.join(root, 'another.tmp'); fs.writeFileSync(other, 'other');
  const files = { ...fs, renameSync() { throw new Error('rename failed'); } };
  assert.equal((await replaceProjectText(request(root, 'after'), guard, { files })).status, 'NOT_COMMITTED');
  assert.equal(read(root), 'before'); assert.equal(fs.readFileSync(other, 'utf8'), 'other'); fs.unlinkSync(other); assertClean(root);
});
test('recognizes committed bytes after a rename callback failure', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, renameSync(...args) { fs.renameSync(...args); throw new Error('after rename'); } };
  assert.equal((await replaceProjectText(request(root, 'after'), guard, { files })).status, 'COMMITTED');
  assert.equal(read(root), 'after'); assertClean(root);
});
test('reports UNKNOWN when bytes cannot be inspected after rename', async () => {
  const root = project(); initialize(root); let renamed = false;
  const files = { ...fs, renameSync(...args) { fs.renameSync(...args); renamed = true; }, readFileSync(file, ...args) {
    if (renamed && file === path.join(root, 'project.abi')) throw new Error('inspection failed'); return fs.readFileSync(file, ...args);
  } };
  assert.equal((await replaceProjectText(request(root, 'after'), guard, { files })).status, 'UNKNOWN');
  assert.equal(read(root), 'after'); assertClean(root);
});
test('rejects traversal, extra files, nonabsolute roots and malformed hashes', async () => {
  const root = project(); initialize(root);
  for (const name of ['../outside', 'sub/project.abi', 'project.abi:stream', 'C:/outside', 'package.json']) {
    assert.equal((await replaceProjectText(request(root, 'after', 'before', name), guard)).code, 'PROJECT_FILE_INVALID');
  }
  for (const value of [{ ...request(root, 'after'), expectedHash: 'invalid' }, { ...request(root, 'after'), projectPath: 'relative' }]) {
    assert.equal((await replaceProjectText(value, guard)).code, 'PROJECT_FILE_INVALID');
  } assert.deepEqual(fs.readdirSync(root), ['project.abi']);
});
test('refuses hard-linked targets and linked internal storage directories', async () => {
  const root = project(); const outside = project(); initialize(outside);
  fs.linkSync(path.join(outside, 'project.abi'), path.join(root, 'project.abi'));
  assert.equal((await replaceProjectText(request(root, 'after'), guard)).code, 'PROJECT_FILE_UNSAFE_PATH');
  fs.unlinkSync(path.join(root, 'project.abi')); initialize(root); fs.symlinkSync(outside, path.join(root, '.aily'), 'junction');
  assert.equal((await replaceProjectText(request(root, 'after'), guard)).code, 'PROJECT_FILE_UNSAFE_PATH');
  assert.equal(read(root), 'before'); assert.equal(read(outside), 'before'); assert.deepEqual(fs.readdirSync(outside), ['project.abi']);
});
test('reports cleanup warnings without misreporting committed bytes as a failed save', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, closeSync(fd) { fs.closeSync(fd); throw new Error('close callback failed'); } };
  const result = await replaceProjectText(request(root, 'after'), guard, { files });
  assert.equal(result.status, 'COMMITTED'); assert.deepEqual(result.warnings, ['close callback failed']);
  assert.equal(read(root), 'after'); assertClean(root);
});
test('does not remove a lock whose ownership changed during publication', async () => {
  const root = project(); initialize(root);
  const lock = path.join(root, '.aily', 'project-files.write.lock');
  const files = { ...fs, renameSync(...args) { fs.renameSync(...args); fs.writeFileSync(lock, 'different owner'); } };
  const result = await replaceProjectText(request(root, 'after'), guard, { files });
  assert.equal(result.status, 'COMMITTED'); assert.equal(result.warnings.length, 1);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'different owner'); assert.equal(read(root), 'after');
});
test('detects replacement of the project directory and does not clean a new directory by old path', async () => {
  const root = project(); initialize(root); const moved = root + '-moved'; roots.push(moved);
  const files = { ...fs, promises: { ...fs.promises, async open(...args) {
    const handle = await fs.promises.open(...args);
    return { writeFile: (...values) => handle.writeFile(...values), sync: () => handle.sync(), close: async () => {
      await handle.close(); // Windows cannot rename a directory containing an open file handle.
      assert.equal(path.dirname(path.resolve(moved)), path.resolve(os.tmpdir()));
      fs.renameSync(root, moved); fs.mkdirSync(root); initialize(root, 'new project');
      fs.writeFileSync(args[0], 'new directory temporary file');
    } };
  } } };
  const result = await replaceProjectText(request(root, 'after'), guard, { files });
  assert.equal(result.status, 'NOT_COMMITTED'); assert.equal(result.code, 'PROJECT_FILE_UNSAFE_PATH');
  assert.equal(read(root), 'new project'); assert.equal(read(moved), 'before');
  const temp = fs.readdirSync(root).find(name => name.endsWith('.tmp'));
  assert.equal(fs.readFileSync(path.join(root, temp), 'utf8'), 'new directory temporary file');
});

const migrationRequest = (root, after = 'after', before = 'before') => ({ ...request(root, after, before), backup: 'project-data' });
const backupPath = (root, original = 'before') => path.join(root, '.aily', 'project-data-backups', hash(original).slice(7) + '.abi');

test('migration preserves the exact original before publishing and reuses only identical backups', async () => {
  const root = project(); const original = '\ufeff旧数据 😀\r\n'; initialize(root, original);
  const result = await replaceProjectText(migrationRequest(root, 'after', original), guard);
  assert.equal(result.status, 'COMMITTED'); assert.equal(result.backupHash, hash(original));
  assert.equal(fs.readFileSync(backupPath(root, original), 'utf8'), original);
  assert.equal(fs.statSync(backupPath(root, original)).nlink, 1);
  initialize(root, original);
  assert.equal((await replaceProjectText(migrationRequest(root, 'retry', original), guard)).status, 'COMMITTED');
  assert.equal(fs.readFileSync(backupPath(root, original), 'utf8'), original); assertClean(root);
});

test('different migration inputs have independent backups and leave the legacy backup untouched', async () => {
  const root = project(); initialize(root); const legacy = path.join(root, 'project.abi.pre-project-data.bak'); fs.writeFileSync(legacy, 'legacy');
  await replaceProjectText(migrationRequest(root), guard);
  assert.equal((await replaceProjectText(migrationRequest(root, 'latest', 'after'), guard)).status, 'COMMITTED');
  assert.equal(fs.readFileSync(backupPath(root), 'utf8'), 'before');
  assert.equal(fs.readFileSync(backupPath(root, 'after'), 'utf8'), 'after');
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy'); assertClean(root);
});

test('backup conflicts, unsafe links and failures stop ABI publication', async () => {
  for (const kind of ['different', 'hard-link', 'directory-link', 'link-failure']) {
    const root = project(); initialize(root); fs.mkdirSync(path.dirname(backupPath(root)), { recursive: true });
    let files = fs;
    if (kind === 'different') fs.writeFileSync(backupPath(root), 'corrupted');
    if (kind === 'hard-link') fs.linkSync(path.join(root, 'project.abi'), backupPath(root));
    if (kind === 'directory-link') {
      fs.rmdirSync(path.dirname(backupPath(root))); fs.symlinkSync(project(), path.dirname(backupPath(root)), 'junction');
    }
    if (kind === 'link-failure') files = { ...fs, linkSync() { throw new Error('backup failed'); } };
    const result = await replaceProjectText(migrationRequest(root), guard, { files });
    assert.equal(result.status, 'NOT_COMMITTED', kind); assert.equal(read(root), 'before', kind); assertClean(root);
  }
});

test('late external edits are retained and never become the wrong backup', async () => {
  const root = project(); initialize(root);
  const files = { ...fs, linkSync(...args) { fs.linkSync(...args); initialize(root, 'external'); } };
  const result = await replaceProjectText(migrationRequest(root), guard, { files });
  assert.equal(result.status, 'NOT_COMMITTED'); assert.equal(result.code, 'PROJECT_FILE_CONFLICT');
  assert.equal(read(root), 'external'); assert.equal(fs.readFileSync(backupPath(root), 'utf8'), 'before'); assertClean(root);
});

test('uncertain ABI commit keeps the verified recovery backup and does not roll back', async () => {
  const root = project(); initialize(root); let renamed = false;
  const files = { ...fs, renameSync(...args) { fs.renameSync(...args); renamed = true; }, readFileSync(file, ...args) {
    if (renamed && file === path.join(root, 'project.abi')) throw new Error('readback lost'); return fs.readFileSync(file, ...args);
  } };
  const result = await replaceProjectText(migrationRequest(root), guard, { files });
  assert.equal(result.status, 'UNKNOWN'); assert.equal(result.backupHash, hash('before'));
  assert.equal(read(root), 'after'); assert.equal(fs.readFileSync(backupPath(root), 'utf8'), 'before'); assertClean(root);
});

test('backup option cannot request other files or a missing original', async () => {
  const root = project(); initialize(root);
  for (const value of [{ ...migrationRequest(root), backup: '../outside' }, { ...migrationRequest(root), fileName: 'project.abs' },
    { ...migrationRequest(root), expectedHash: null }]) {
    assert.equal((await replaceProjectText(value, guard)).code, 'PROJECT_FILE_INVALID');
  }
  assert.deepEqual(fs.readdirSync(root), ['project.abi']);
});
