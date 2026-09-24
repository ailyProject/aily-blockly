const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuthStore } = require('./auth-store');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-auth-store-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('aily-auth-store-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = relative => path.join(root, relative);
  const read = relative => JSON.parse(fs.readFileSync(file(relative), 'utf8'));
  const write = (relative, record) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(file(relative), JSON.stringify(record));
  };
  const store = product => createAuthStore(root, product, async operation => operation());
  return { file, read, write, store };
}

test('Blockly mirrors login and refresh while preserving unrelated legacy fields', async t => {
  const f = fixture(t), store = f.store('blockly');
  f.write('.aily', { setting: 'keep', refresh_token: 'obsolete' });
  await store.write({ access_token: 'login', refresh_token: 'refresh-1' });
  assert.deepEqual(f.read('.aily'), { setting: 'keep', ...f.read('auth/blockly.json') });

  assert.equal(await store.write({ access_token: 'rotated', refresh_token: 'refresh-2' }, 'refresh-1'), true);
  assert.deepEqual(f.read('.aily'), { setting: 'keep', ...f.read('auth/blockly.json') });

  await store.write({ access_token: 'next-login' });
  assert.deepEqual(f.read('.aily'), { setting: 'keep', ...f.read('auth/blockly.json') });
  assert.equal(Object.hasOwn(f.read('.aily'), 'refresh_token'), false);
});

test('startup and credential reads restore existing Blockly sessions without repeated mirror writes', async t => {
  const f = fixture(t), store = f.store('blockly');
  const record = { access_token: 'current', refresh_token: 'refresh', updated_at: '2026-09-24T00:00:00.000Z' };
  f.write('auth/blockly.json', record);
  f.write('auth/blockly-migration.json', { completed: true });
  await store.restoreLegacy();
  assert.deepEqual(f.read('.aily'), record);

  fs.rmSync(f.file('.aily'));
  assert.deepEqual(await store.read(), record);
  assert.deepEqual(f.read('.aily'), record);

  f.write('.aily', { access_token: 'stale', setting: 'keep' });
  assert.deepEqual(await store.read(), record);
  assert.deepEqual(f.read('.aily'), { setting: 'keep', ...record });

  const rename = t.mock.method(fs, 'renameSync');
  await store.read();
  assert.equal(rename.mock.callCount(), 0);
});

test('legacy migration still works and logout cannot resurrect the old login', async t => {
  const f = fixture(t), store = f.store('blockly');
  const legacy = { access_token: 'legacy', refresh_token: 'legacy-refresh' };
  f.write('.aily', legacy);
  assert.deepEqual(await store.read(), legacy);
  assert.deepEqual(f.read('auth/blockly.json'), legacy);
  await store.clear();
  assert.equal(fs.existsSync(f.file('.aily')), false);
  assert.equal(fs.existsSync(f.file('auth/blockly.json')), false);
  assert.deepEqual(f.read('auth/blockly-migration.json'), { completed: true });

  f.write('.aily', legacy);
  assert.deepEqual(await store.read(), {});
  assert.deepEqual(f.read('.aily'), legacy);
  await store.restoreLegacy();
  assert.equal(fs.existsSync(f.file('.aily')), false);
});

test('Coder never imports, mirrors or clears Blockly or legacy credentials', async t => {
  const f = fixture(t), store = f.store('coder');
  const legacy = { access_token: 'legacy', setting: 'keep' };
  const blockly = { access_token: 'blockly' };
  f.write('.aily', legacy);
  f.write('auth/blockly.json', blockly);
  await store.restoreLegacy();
  assert.deepEqual(await store.read(), {});
  await store.write({ access_token: 'coder', refresh_token: 'coder-refresh' });
  assert.equal((await store.read()).access_token, 'coder');
  assert.deepEqual(f.read('.aily'), legacy);
  await store.clear();
  assert.deepEqual(f.read('.aily'), legacy);
  assert.deepEqual(f.read('auth/blockly.json'), blockly);
  assert.equal(fs.existsSync(f.file('auth/blockly-migration.json')), false);
  assert.equal(fs.existsSync(f.file('auth/coder.json')), false);
});

test('rejected stale refresh leaves both credential files unchanged', async t => {
  const f = fixture(t), store = f.store('blockly');
  await store.write({ access_token: 'current', refresh_token: 'current-refresh' });
  const current = f.read('auth/blockly.json');
  assert.equal(await store.write({ access_token: 'stale', refresh_token: 'stale-refresh' }, 'old-refresh'), false);
  assert.deepEqual(f.read('auth/blockly.json'), current);
  assert.deepEqual(f.read('.aily'), current);
});

test('failed mirror writes never block reads of the rotated primary credentials', async t => {
  const f = fixture(t), store = f.store('blockly');
  await store.write({ access_token: 'before', refresh_token: 'refresh-1' });
  const renameSync = fs.renameSync;
  const failure = Object.assign(new Error('fixture mirror write denied'), { code: 'EACCES' });
  const warn = t.mock.method(console, 'warn', () => {});
  const rename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file('.aily')) throw failure;
    return renameSync(source, destination);
  });
  await assert.rejects(store.write({ access_token: 'after', refresh_token: 'refresh-2' }, 'refresh-1'), failure);
  assert.equal(f.read('auth/blockly.json').refresh_token, 'refresh-2');
  assert.equal(f.read('.aily').access_token, 'before');
  const current = await store.read();
  assert.equal(current.access_token, 'after');
  assert.equal(f.read('.aily').access_token, 'before');
  await assert.rejects(store.restoreLegacy(), failure);
  assert.deepEqual(await store.read(), current);
  assert.equal(warn.mock.callCount(), 2);
  assert.deepEqual(warn.mock.calls[0].arguments, ['[Auth] Failed to sync .aily compatibility file:', 'EACCES']);
  rename.mock.restore();

  assert.deepEqual(await store.read(), current);
  assert.deepEqual(f.read('.aily'), current);
});

for (const denied of ['.aily', 'auth/blockly.json']) test(`logout attempts both files even when deleting ${denied} fails`, async t => {
  const f = fixture(t), store = f.store('blockly');
  await store.write({ access_token: 'current' });
  const rmSync = fs.rmSync;
  const failure = Object.assign(new Error('fixture mirror cleanup denied'), { code: 'EACCES' });
  const remove = t.mock.method(fs, 'rmSync', (target, options) => {
    if (target === f.file(denied)) throw failure;
    return rmSync(target, options);
  });
  await assert.rejects(store.clear(), failure);
  for (const relative of ['.aily', 'auth/blockly.json']) {
    assert.equal(fs.existsSync(f.file(relative)), relative === denied);
  }
  if (denied === '.aily') assert.deepEqual(await store.read(), {});
  assert.deepEqual(f.read('auth/blockly-migration.json'), { completed: true });
  remove.mock.restore();

  await store.clear();
  assert.equal(fs.existsSync(f.file('.aily')), false);
  assert.deepEqual(await store.read(), {});
});
