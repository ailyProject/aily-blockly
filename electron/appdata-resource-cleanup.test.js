'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function fixture(t, filesystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-resource-cleanup-'));
  t.after(() => {
    const actual = fs.realpathSync(root);
    assert.equal(path.dirname(actual), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('aily-resource-cleanup-'));
    fs.rmSync(actual, { recursive: true, force: true });
  });
  const handlers = new Map(), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'appdata-resource-cleanup.js'), 'utf8'), {
    module, exports: module.exports,
    process: { env: { AILY_APPDATA_PATH: root } },
    require: name => name === 'electron' ? {
      ipcMain: { handle: (channel, handler) => { assert.equal(handlers.has(channel), false); handlers.set(channel, handler); } },
      app: { getPath: () => root },
    } : name === 'node:fs' ? filesystem : require(name),
  });
  module.exports.registerAppDataResourceCleanupHandlers();
  module.exports.registerAppDataResourceCleanupHandlers();
  return { root, ...module.exports, remove: target => handlers.get('appdata-resource-remove')({}, { target }) };
}

test('managed SDK cleanup accepts a target without a resource token', async t => {
  const f = fixture(t), target = path.join(f.root, 'sdk/fixture');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'fixture.txt'), 'fixture');
  assert.equal((await f.remove(target)).ok, true);
  assert.equal(fs.existsSync(target), false);
});

test('managed cleanup rejects roots, escapes, nested paths and redirects', t => {
  const f = fixture(t);
  for (const target of [f.root, path.dirname(f.root), path.join(f.root, 'sdk'),
      path.join(f.root, 'node_modules/package'), path.join(f.root, 'sdk/a/b'), 'sdk/relative']) {
    assert.throws(() => f.resolveManagedResource(f.root, target), /PATH_UNSAFE/);
  }
  const outside = path.join(f.root, 'untouched'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.resolveManagedResource(f.root, path.join(f.root, 'sdk/resource')), /PATH_UNSAFE/);
  fs.unlinkSync(path.join(f.root, 'sdk')); fs.mkdirSync(path.join(f.root, 'sdk'));
  fs.symlinkSync(outside, path.join(f.root, 'sdk/resource'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.resolveManagedResource(f.root, path.join(f.root, 'sdk/resource')), /PATH_UNSAFE/);
  assert.equal(fs.existsSync(outside), true);
});

test('managed cleanup still reports filesystem failures', async t => {
  const f = fixture(t, { ...fs, promises: { rm: async () => { throw new Error('access denied'); } } });
  await assert.rejects(f.remove(path.join(f.root, 'sdk/missing')), /access denied/);
});
