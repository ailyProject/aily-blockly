'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const runtime = require('../scripts/build-windows-process-runtime.cjs');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-native-build-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = dll => { const bytes = Buffer.alloc(128);bytes.write('MZ');bytes.writeUInt32LE(64, 60);bytes.write('PE\0\0', 64);bytes.writeUInt16LE(0x8664, 68);bytes.writeUInt16LE(dll ? 0x2000 : 0, 86);bytes.writeUInt16LE(0x20b, 88);return bytes; };
  const files = { 'aily-job.node': binary(true), 'aily-job-launcher.exe': binary(false) };
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes);
  const manifest = { version: 2, platform: 'win32', arch: 'x64', napi: 8,
    source: hash(Buffer.concat(['job.cc', 'launcher.cc'].map(name => fs.readFileSync(path.join(root, 'electron/native/windows-process', name))))),
    recipe: hash(fs.readFileSync(path.join(root, 'scripts/build-windows-process-runtime.cjs'))),
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) };
  const save = () => fs.writeFileSync(path.join(directory, 'runtime.json'), JSON.stringify(manifest));save();
  return { directory, manifest, files, save };
}
test('verification rejects stale sources and a changed build recipe', t => {
  const f = fixture(t);assert.equal(runtime.verify('x64', f), f.directory);
  f.manifest.source = 'old-source';f.save();assert.throws(() => runtime.verify('x64', f), /rebuilt/);
  const g = fixture(t);g.manifest.recipe = 'old-recipe';g.save();assert.throws(() => runtime.verify('x64', g), /rebuilt/);
});
test('verification rejects corrupt bytes, wrong architecture and a DLL masquerading as a launcher', t => {
  const f = fixture(t), file = path.join(f.directory, 'aily-job-launcher.exe');
  fs.appendFileSync(file, 'changed');assert.throws(() => runtime.verify('x64', f), /checksum/);
  const bytes = f.files['aily-job-launcher.exe'];bytes.writeUInt16LE(0xaa64, 68);fs.writeFileSync(file, bytes);
  f.manifest.files['aily-job-launcher.exe'] = hash(bytes);f.save();assert.throws(() => runtime.verify('x64', f), /architecture/);
  bytes.writeUInt16LE(0x8664, 68);bytes.writeUInt16LE(0x2000, 86);fs.writeFileSync(file, bytes);
  f.manifest.files['aily-job-launcher.exe'] = hash(bytes);f.save();assert.throws(() => runtime.verify('x64', f), /binary type/);
});
test('unsupported target fails rather than shipping x64 bytes under another architecture', () => {
  assert.throws(() => runtime.build('arm64'), /supports x64/);
});
test('macOS packaging skips compilation and Windows runtime validation', async () => {
  await runtime.prepareForPack({ electronPlatformName: 'darwin' });
  runtime.verifyPackaged({ electronPlatformName: 'darwin' });
  runtime.smokePackaged({ electronPlatformName: 'darwin' });
});
for (const unpacked of [true, false]) test(`packaged verification checks actual ASAR flags and external bytes: unpacked=${unpacked}`, async t => {
  const { createPackageWithOptions } = require('@electron/asar');
  const f = fixture(t), resources = path.join(f.directory, 'resources'), source = path.join(f.directory, 'source');
  const relative = 'electron/native/windows-process/x64';
  const files = path.join(source, relative);fs.mkdirSync(files, { recursive: true });
  for (const name of ['aily-job.node', 'aily-job-launcher.exe', 'runtime.json']) fs.copyFileSync(path.join(f.directory, name), path.join(files, name));
  fs.mkdirSync(resources);
  await createPackageWithOptions(source, path.join(resources, 'app.asar'), unpacked ? { unpack: '**/*' } : {});
  const destination = path.join(resources, 'app.asar.unpacked', relative);
  // Physical files alone are insufficient if the archive still marks them packed.
  if (!unpacked) fs.cpSync(files, destination, { recursive: true });
  const context = { electronPlatformName: 'win32', arch: require('electron-builder').Arch.x64,
    appOutDir: f.directory, packager: { getResourcesDir: () => resources } };
  if (!unpacked) { assert.throws(() => runtime.verifyPackaged(context), /outside ASAR/);return; }
  runtime.verifyPackaged(context);
  fs.appendFileSync(path.join(destination, 'aily-job.node'), 'tampered');
  assert.throws(() => runtime.verifyPackaged(context), /checksum/);
});
test('Blockly and Coder both compile before collection, map only fresh Windows files and validate after packing', () => {
  const blockly = require('../package.json').build, coder = require('../build/electron-builder.coder');
  for (const config of [blockly, coder]) {
    assert.equal(config.beforePack, 'scripts/prepare-windows-process-runtime.cjs');
    assert.equal(config.afterPack, 'scripts/package-child-resources.js');
    assert(config.asarUnpack.includes('.aily/windows-process-runtime/**/*.{node,exe,json}'));
    assert(config.files.find(item => item?.from === 'electron').filter.includes('!native/windows-process/**'));
    assert.deepEqual(config.win.files, [{ from: '.aily/windows-process-runtime', to: 'electron/native/windows-process', filter: ['${arch}/*.{node,exe,json}'] }]);
    assert.equal(config.mac.files, undefined);
  }
});
test('Windows packaged smoke observes target readiness and joins native cleanup with a clean load environment', async () => {
  let invocation;
  const module = { exports: {} }, file = path.join(root, 'scripts/build-windows-process-runtime.cjs');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, __filename: file, __dirname: path.dirname(file), console: { info() {} },
    process: { platform: 'win32', env: { NODE_PATH: 'developer-modules', AILY_CHILD_PATH: 'developer-child' } },
    require: name => name === 'node:child_process' ? { execFileSync: (...args) => {
      invocation = args;return 'PACKAGED_WINDOWS_JOB_OK';
    } } : require(name),
  });
  const resources = path.join(os.tmpdir(), 'native-smoke/resources');
  module.exports.smokePackaged({ electronPlatformName: 'win32', appOutDir: path.dirname(resources),
    packager: { getResourcesDir: () => resources, appInfo: { productFilename: 'aily blockly' } } });
  assert.equal(invocation[2].env.NODE_PATH, undefined);
  assert.equal(invocation[2].env.AILY_CHILD_PATH, undefined);
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, '1');
  const child = new EventEmitter();child.stdout = new EventEmitter();child.stderr = { pipe() {} };
  const messages = [];let stopped = false;
  vm.runInNewContext(invocation[1][1], {
    process: { argv: ['electron', resources], execPath: 'electron.exe', env: {}, stderr: {}, exit: assert.fail },
    console: { log: message => messages.push(message), error: assert.fail },
    setTimeout: () => ({}), clearTimeout() {},
    require: name => name.includes('owned-process.js') ? {
      runtime: () => ({}), spawn: () => child,
      stopOwnedProcess: async target => { assert.equal(target, child);stopped = true;return true; },
      getOwnedProcessInfo: () => ({ active: 0 }),
    } : require(name),
  });
  child.stdout.emit('data', Buffer.from('ready:1234\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);assert.deepEqual(messages, ['PACKAGED_WINDOWS_JOB_OK']);
});
