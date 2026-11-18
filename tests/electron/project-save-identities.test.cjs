'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { createProjectSaveIdentities } = require('../../electron/project-save-identities');

const id = 'pub2-00000000-0000-4000-8000-000000000001';
const original = JSON.stringify(['/first/project', 'project_save', null]);
const other = JSON.stringify(['/second/project', 'blocks_tidy', null]);

function fixture(t) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-save-identities-'));
  t.after(() => fs.rmSync(appData, { recursive: true }));
  return appData;
}

test('the index is read only until a terminal binding is recorded and cannot change scope', t => {
  const appData = fixture(t);
  const index = createProjectSaveIdentities(appData);
  assert.equal(index.inspect(id, original), 'missing');
  assert.deepEqual(fs.readdirSync(appData), []);
  index.remember(id, original);
  index.remember(id, original);
  const restarted = createProjectSaveIdentities(appData);
  assert.equal(restarted.inspect(id, original), 'matching');
  assert.equal(restarted.inspect(id, other), 'different');
  assert.throws(() => restarted.remember(id, other));
  assert.equal(restarted.inspect(id, original), 'matching');
});

test('a malformed existing identity fails closed for the original ID', t => {
  const appData = fixture(t);
  const index = createProjectSaveIdentities(appData);
  assert.throws(() => index.remember('../other', original));
  index.remember(id, original);
  const hash = createHash('sha256').update(id).digest('hex');
  fs.writeFileSync(path.join(appData, 'settled-save-identities', hash.slice(0, 2), hash.slice(2)), 'corrupt');
  assert.throws(() => index.inspect(id, original));
  assert.throws(() => index.remember(id, original));
  const another = id.slice(0, -1) + '2';
  assert.equal(index.inspect(another, other), 'missing');
});

test('Windows Electron path stats may omit the device without changing the file identity', { skip: process.platform !== 'win32' }, t => {
  const appData = fixture(t);
  const index = createProjectSaveIdentities(appData);
  index.remember(id, original);
  const hash = createHash('sha256').update(id).digest('hex');
  const identityFile = path.join(appData, 'settled-save-identities', hash.slice(0, 2), hash.slice(2));
  const originalStat = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = originalStat(file, options);
    if (file === identityFile) {
      stat.dev = 0n;
      if (replaced) stat.ino += 1n;
    }
    return stat;
  });
  assert.equal(index.inspect(id, original), 'matching');
  replaced = true;
  assert.throws(() => index.inspect(id, original));
});
