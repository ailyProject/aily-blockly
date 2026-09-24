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
  const store = () => createAuthStore(root, async operation => operation());
  return { file, read, write, store };
}

test('both products share login, refresh and logout through .aily', async t => {
  const f = fixture(t), blockly = f.store(), coder = f.store();
  f.write('.aily', { setting: 'keep' });
  await blockly.write({ access_token: 'login', refresh_token: 'refresh-1' });
  assert.equal((await coder.read()).access_token, 'login');
  assert.equal(f.read('.aily').setting, 'keep');

  assert.equal(await coder.write({ access_token: 'rotated', refresh_token: 'refresh-2' }, 'refresh-1'), true);
  assert.equal((await blockly.read()).refresh_token, 'refresh-2');
  await coder.write({ access_token: 'next-account' });
  assert.equal((await blockly.read()).access_token, 'next-account');
  assert.equal(Object.hasOwn(f.read('.aily'), 'refresh_token'), false);
  assert.equal(fs.existsSync(f.file('auth/blockly.json')), false);
  assert.equal(fs.existsSync(f.file('auth/coder.json')), false);

  await blockly.clear();
  assert.deepEqual(await coder.read(), {});
  assert.equal(fs.existsSync(f.file('.aily')), false);
});

test('an existing .aily login is retained, and ordinary reads do not write it', async t => {
  const f = fixture(t), store = f.store();
  const record = { access_token: 'legacy', refresh_token: 'refresh', updated_at: '2026-09-24T00:00:00.000Z' };
  f.write('.aily', { ...record, setting: 'keep' });
  assert.deepEqual(await store.read(), record);
  assert.deepEqual(f.read('.aily'), { ...record, setting: 'keep' });
  const rename = t.mock.method(fs, 'renameSync');
  assert.deepEqual(await store.read(), record);
  assert.equal(rename.mock.callCount(), 0);
});

test('migration selects the latest login or refresh across the old credential files', async t => {
  const f = fixture(t);
  f.write('.aily', { access_token: 'legacy', updated_at: '2026-09-21T00:00:00Z', setting: 'keep' });
  const blockly = { access_token: 'blockly', updated_at: '2026-09-22T00:00:00Z' };
  const coder = { access_token: 'coder', refresh_token: 'coder-refresh', updated_at: '2026-09-23T00:00:00Z' };
  f.write('auth/blockly.json', blockly);
  f.write('auth/coder.json', coder);
  assert.deepEqual(await f.store().read(), coder);
  assert.deepEqual(f.read('.aily'), { setting: 'keep', ...coder });
  assert.deepEqual(f.read('auth/blockly.json'), blockly);
  assert.deepEqual(f.read('auth/coder.json'), coder);

  await f.store().clear();
  assert.deepEqual(await f.store().read(), {});
  assert.deepEqual(f.read('auth/shared-migration.json'), { completed: true });
});

test('equal or missing migration timestamps prefer the existing .aily account', async t => {
  const f = fixture(t);
  f.write('.aily', { access_token: 'legacy' });
  f.write('auth/blockly.json', { access_token: 'blockly', updated_at: 'invalid' });
  f.write('auth/coder.json', { access_token: 'coder' });
  assert.deepEqual(await f.store().read(), { access_token: 'legacy' });
});

test('old Blockly logout residue cannot restore a signed-out account', async t => {
  const f = fixture(t);
  f.write('.aily', { access_token: 'signed-out', updated_at: '2026-09-24T00:00:00Z' });
  f.write('auth/blockly-migration.json', { completed: true });
  assert.deepEqual(await f.store().read(), {});
  assert.equal(fs.existsSync(f.file('.aily')), false);
  f.write('auth/coder.json', { access_token: 'late-old-file' });
  assert.deepEqual(await f.store().read(), {});
});

test('a still-signed-in Coder account survives migration after old Blockly logout', async t => {
  const f = fixture(t);
  f.write('.aily', { access_token: 'signed-out', updated_at: '2026-09-24T00:00:00Z' });
  f.write('auth/blockly-migration.json', { completed: true });
  f.write('auth/coder.json', { access_token: 'coder', updated_at: '2026-09-23T00:00:00Z' });
  assert.equal((await f.store().read()).access_token, 'coder');
});

for (const denied of ['.aily', 'auth/shared-migration.json']) test(`migration retries after a failed ${denied} write`, async t => {
  const f = fixture(t), store = f.store();
  const record = { access_token: 'coder', updated_at: '2026-09-23T00:00:00Z' };
  f.write('auth/coder.json', record);
  const renameSync = fs.renameSync;
  const failure = Object.assign(new Error('fixture migration write denied'), { code: 'EACCES' });
  const rename = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file(denied)) throw failure;
    return renameSync(source, destination);
  });
  await assert.rejects(store.read(), failure);
  assert.equal(fs.existsSync(f.file('auth/shared-migration.json')), false);
  rename.mock.restore();
  assert.deepEqual(await store.read(), record);
});

test('late refreshes and invalidations cannot overwrite or clear the shared replacement session', async t => {
  const f = fixture(t), blockly = f.store(), coder = f.store();
  await blockly.write({ access_token: 'old', refresh_token: 'old-refresh' });
  await coder.write({ access_token: 'new', refresh_token: 'new-refresh' });
  const current = await coder.read();
  assert.equal(await blockly.write({ access_token: 'late', refresh_token: 'late-refresh' }, 'old-refresh'), false);
  assert.equal(await blockly.clear('old'), false);
  assert.equal(await blockly.clear(null), false);
  assert.deepEqual(await coder.read(), current);
  assert.equal(await blockly.clear('new'), true);
  assert.equal(await coder.clear('new'), true);
  assert.equal(await coder.clear(null), true);
  assert.equal(await coder.write({ access_token: 'late' }, 'new-refresh'), false);
  assert.deepEqual(await blockly.read(), {});
});
